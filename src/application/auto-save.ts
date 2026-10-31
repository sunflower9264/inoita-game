import type { SaveGame } from '../domain/save-game.ts';
import type { Session } from '../domain/session.ts';

export interface AutoSavePorts<World = unknown> {
  /** 世界还没就绪（换图、未进图）时返回 undefined，这一次就不写。 */
  capture(): SaveGame<World> | undefined;
  /** 写自动槽。失败只记日志——自动存档不该打断游戏。 */
  write(game: SaveGame<World>): void;
  /** 只在游戏进行中启用；标题页和职业选择页没有可存的世界。 */
  enabled(): boolean;
  /** 演出或菜单锁着时不抢写，等解锁后再写。 */
  locked?: () => boolean;
  now?: () => number;
}

const DEFAULT_DEBOUNCE_MS = 1200;
const DEFAULT_MIN_GAP_MS = 2000;
const DEFAULT_RETRY_MS = 2000;
const DEFAULT_INTERVAL_MS = 300_000;

/**
 * 自动存档：把「进图、剧情事件完成、任务变化、定时」四种触发合并成低频写入。
 *
 * 触发可能在同一秒里连着来（进图后立刻播剧情、剧情里接任务），所以 `request` 只记
 * 一次待写，去抖窗口结束后写一份；两次写入之间至少隔 `minGapMs`，避免写风暴。
 */
export class AutoSaver<World = unknown> {
  private readonly ports:AutoSavePorts<World>;
  private readonly debounceMs:number;
  private readonly minGapMs:number;
  private readonly retryMs:number;
  private debounce?:ReturnType<typeof setTimeout>;
  private interval?:ReturnType<typeof setInterval>;
  private lastWrite=-Infinity;
  private waiting=false;
  private suspended=false;

  constructor(ports:AutoSavePorts<World>, options:{debounceMs?:number;minGapMs?:number;retryMs?:number}={}) {
    this.ports=ports;
    this.debounceMs=options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.minGapMs=options.minGapMs ?? DEFAULT_MIN_GAP_MS;
    this.retryMs=options.retryMs ?? DEFAULT_RETRY_MS;
  }

  /** 调试现场期间暂停写入：清掉待写与重试，之后的触发也不再排队。 */
  suspend():void {
    this.suspended=true;
    if(this.debounce)clearTimeout(this.debounce);
    this.debounce=undefined;
    this.waiting=false;
  }

  /** 结束调试后恢复；不主动写，调用方按正常时机再触发一次。 */
  resume():void { this.suspended=false; }
  get isSuspended():boolean { return this.suspended; }

  /** 记一次待写；窗口内的重复触发合并。 */
  request():void {
    if(this.suspended||!this.ports.enabled()||this.debounce)return;
    this.debounce=setTimeout(()=>{ this.debounce=undefined; this.flush(); },this.debounceMs);
  }

  /** 立即尝试写入；条件不满足时安排重试。`stop()` 之后不再重试。 */
  flush():void {
    if(this.suspended||!this.ports.enabled())return;
    const now=this.ports.now?.() ?? Date.now();
    if((this.ports.locked?.() ?? false)||now-this.lastWrite<this.minGapMs){
      this.retry();
      return;
    }
    const game=this.ports.capture();
    if(!game){ this.retry(); return; }
    this.waiting=false;
    this.lastWrite=now;
    try { this.ports.write(game); }
    catch(error){ console.warn('自动存档写入失败',error); }
  }

  /**
   * 页面即将隐藏、进程可能被系统回收时同步写一次。
   * 跳过去抖与最小间隔，也不安排重试；调用方负责在进入挂起状态之前调用。
   */
  flushForBackground():void {
    if(this.suspended||!this.ports.enabled())return;
    if(this.debounce){clearTimeout(this.debounce);this.debounce=undefined;}
    this.waiting=false;
    if(this.ports.locked?.() ?? false)return;
    const game=this.ports.capture();
    if(!game)return;
    this.lastWrite=this.ports.now?.() ?? Date.now();
    try { this.ports.write(game); }
    catch(error){ console.warn('自动存档写入失败',error); }
  }

  /**
   * 任务接取/完成时触发自动存档。任务状态也可能由导演的交互路径直接改，
   * 不只走剧情提交，所以订阅会话；纯目标进度推进不触发。
   */
  watchQuests(session:Session):()=>void {
    let statuses=new Map<string,string>([...session.quests].map(([id,state])=>[id,state.status]));
    let version=session.questBook.version;
    return session.subscribe(()=>{
      if(session.questBook.version===version)return;
      version=session.questBook.version;
      let changed=false;
      const next=new Map<string,string>();
      for(const [id,state] of session.quests){
        next.set(id,state.status);
        if(statuses.get(id)!==state.status&&(state.status==='active'||state.status==='completed'))changed=true;
      }
      statuses=next;
      if(changed)this.request();
    });
  }

  /** 定时存档；重复调用会先停掉旧计时器。 */
  start(intervalMs=DEFAULT_INTERVAL_MS):void {
    this.stopTimer();
    this.interval=setInterval(()=>this.request(),intervalMs);
  }

  stop():void {
    this.stopTimer();
    if(this.debounce)clearTimeout(this.debounce);
    this.debounce=undefined;
    this.waiting=false;
  }

  private retry():void {
    if(this.suspended||this.waiting||this.debounce)return;
    this.waiting=true;
    this.debounce=setTimeout(()=>{ this.debounce=undefined; this.waiting=false; this.flush(); },this.retryMs);
  }

  private stopTimer():void {
    if(this.interval)clearInterval(this.interval);
    this.interval=undefined;
  }
}

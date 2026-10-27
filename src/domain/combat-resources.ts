import { LOGIC_FRAME_MS } from './battle.ts';

export const RESOURCE_RECOVERY_INTERVAL_MS=31*LOGIC_FRAME_MS;
const RESOURCE_RECOVERY_INTERVAL_TICKS=RESOURCE_RECOVERY_INTERVAL_MS/LOGIC_FRAME_MS;

interface ResourceAttributes {
  healthRecoveryPerPulse:number;
  manaRecoveryPerPulse:number;
  manaCostRate:number;
  manaCostReductionRate:number;
}

/** 装备、技能和 Buff 修饰前的基础值；恢复量以每次共用脉冲的点数表示。 */
export function defaultResourceAttributes(kind:'member'|'monster',level:number):ResourceAttributes {
  return {
    healthRecoveryPerPulse:kind==='member'?Math.trunc((960+36*level)/10):0,
    manaRecoveryPerPulse:8,
    manaCostRate:kind==='member'?1000:0,
    manaCostReductionRate:0,
  };
}

/** 两个修正均为千分率；整数除法向零截断，保留原版允许的负成本。 */
export function calculateManaCost(baseManaCost:number,manaCostRate:number,manaCostReductionRate:number):number {
  const cost=Math.trunc(baseManaCost*(manaCostRate-manaCostReductionRate)/1000);
  return cost===0?0:cost;
}

export interface ResourceRecoveryActor {
  actorId:string;
  alive:boolean;
  level:number;
  /** 角色自身完成属性与 Buff 计算后的每脉冲恢复点数。 */
  healthRecoveryPerPulse:number;
  manaRecoveryPerPulse:number;
  emergencyRecovery?:boolean;
}

interface ResourceRecoveryAmount {
  actorId:string;
  healthAmount:number;
  manaAmount:number;
}

export interface ResourceRecoveryPulse {
  /** 当前战斗时钟的毫秒位置。资源上限由调用者应用每次脉冲时处理。 */
  atMs:number;
  amounts:ResourceRecoveryAmount[];
}

export interface CombatResourceRecoveryState {
  elapsedMs:number;
  /** 原版在当前逻辑帧严格大于这个截止帧时恢复资源。 */
  deadlineTick:number;
}

/** 活跃游戏时间共用一个恢复时钟；地图和角色切换沿用同一实例或恢复快照。 */
export class CombatResourceRecovery {
  private elapsedMs=0;
  private deadlineTick=RESOURCE_RECOVERY_INTERVAL_TICKS-1;

  get currentTick():number { return Math.floor(this.elapsedMs/LOGIC_FRAME_MS); }

  get millisecondsUntilNextPulse():number {
    return (this.deadlineTick+1)*LOGIC_FRAME_MS-this.elapsedMs;
  }

  captureState():CombatResourceRecoveryState {
    return {elapsedMs:this.elapsedMs,deadlineTick:this.deadlineTick};
  }

  restoreState(state:CombatResourceRecoveryState):void {
    this.elapsedMs=state.elapsedMs;
    this.deadlineTick=state.deadlineTick;
  }

  /** 共有战斗时钟完成角色处理后，在当前帧结算恢复。 */
  advanceToFrame(frame:number,actors:readonly ResourceRecoveryActor[]):ResourceRecoveryPulse[] {
    if(!Number.isSafeInteger(frame)||frame<this.currentTick)throw new Error('资源恢复帧无效');
    return this.advance(frame*LOGIC_FRAME_MS-this.elapsedMs,actors);
  }

  /** 该逻辑帧是否会触发一次脉冲；调用方可在构建整队恢复属性前早退。 */
  pulseDueAtFrame(frame:number):boolean {
    if(!Number.isSafeInteger(frame)||frame<0)throw new Error('资源恢复帧无效');
    return this.deadlineTick<frame;
  }

  resetDeadline(frame:number):void {
    if(!Number.isSafeInteger(frame)||frame<0)throw new Error('资源恢复帧无效');
    this.deadlineTick=frame+RESOURCE_RECOVERY_INTERVAL_TICKS-1;
  }

  advance(deltaMs:number,actors:readonly ResourceRecoveryActor[]):ResourceRecoveryPulse[] {
    if(!Number.isFinite(deltaMs)||deltaMs<=0)return [];
    this.elapsedMs+=deltaMs;
    const currentTick=Math.floor(this.elapsedMs/LOGIC_FRAME_MS);
    const pulses:ResourceRecoveryPulse[]=[];
    while(this.deadlineTick<currentTick){
      pulses.push({atMs:(this.deadlineTick+1)*LOGIC_FRAME_MS,amounts:actors.filter(actor=>actor.alive).map(actor=>({
        actorId:actor.actorId,
        healthAmount:actor.healthRecoveryPerPulse+(actor.emergencyRecovery?3*actor.level:0),
        manaAmount:actor.manaRecoveryPerPulse,
      }))});
      // 沿用上一截止帧推进，跨过多个脉冲时保留原相位。
      this.deadlineTick+=RESOURCE_RECOVERY_INTERVAL_TICKS;
    }
    return pulses;
  }
}

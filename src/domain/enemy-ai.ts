import type { EnemyBehavior, EnemyPlayableSkill, EnemyReleaseCondition, ResolvedBasicAttack } from './battle.ts';
import { LOGIC_FRAME_MS } from './battle.ts';
import { attackDistance, targetDistance } from './basic-attack.ts';
import { CombatController, canTargetCombatant } from './combat.ts';
import { combatStateCapabilities } from './combat-state.ts';
import type { AttackContact, Combatant, CombatPort, CombatSnapshot, Cooldown } from './combat.ts';
import { needsTarget } from './skill-action.ts';
import type { GameRectangle, Point } from './navigation.ts';
import { canTraverse, createPathSearch, PATH_GRID_SIZE, type PathSearch } from './pathfinding.ts';
import { enemyAwarenessRangeUnits } from './enemy-engagement.ts';

export interface EnemyPort extends CombatPort {
  /** 物理系统每步读取下一个路径点；行为决策仍按原版逻辑帧执行。 */
  followPath(nextWaypoint: () => Point | undefined): void;
  home(): Point;
  followDistancePx?:number;
  focusTarget?():string|undefined;
  counterattack?():boolean;
  /** 当前生命与上限；用于原版释放条件的 HP 阈值判定。 */
  health?(id:string):{current:number;maximum:number}|undefined;
  navigationBounds(): GameRectangle;
  /** 每渲染帧共享的寻路扩展预算；缺省时按单次上限同步推进（测试与无场景调用）。 */
  pathBudget?:{take(limit:number):number};
  /** 冻结通行快照；有它时跨帧搜索读同一份地图。 */
  navigationSnapshot?():{bounds:GameRectangle;canStand(point:Point):boolean};
  threat?:{
    select(current:string|undefined):string|undefined;
    notice(source:string):void;
    has(source:string):boolean;
    clear():void;
  };
}
export interface EnemySnapshot {
  state: 'idle' | 'wandering' | 'chasing' | 'attacking' | 'returning';
  targetId?: string;
  cooldowns: Readonly<Record<string, Cooldown>>;
}
interface EnemyControllerState {
  state:EnemySnapshot['state'];
  targetId?:string;
  pendingReturn:boolean;
  threatCombatActive?:boolean;
  accumulator:number;
  clock:number;
  nextPathAt:number;
  path:Point[];
  destination?:Point;
  destinationRange?:number;
  progressPosition?:Point;
  lastProgressAt:number;
  idleElapsed:number;
  wanderDestination?:Point;
  combat?:CombatSnapshot;
  /** 已用掉「每场一次」的技能标识。 */
  spentOnce?:string[];
}

const REPATH_INTERVAL_MS=180;
/** 跨帧搜索每次推进的扩展上限；多个 AI 共享渲染帧预算。 */
const SEARCH_SLICE=128;
/** 施法前的同步可达性检查；不能沿用跨帧搜索，保持原判定的即时性。 */
const HOLD_SEARCH_CAP=1024;
/** 闲逛路径很短，一次同步算完。 */
const WANDER_SEARCH_CAP=512;
/** 目标不可达后的重试间隔（常见 RPG 做法：0.5–1 秒）。 */
const FAILED_PATH_MS=600;
const ARRIVAL_DISTANCE_PX=.5;
/** 原版释放条件的生命千分比上限；`always` 不设阈值，直接可放。 */
const RELEASE_HEALTH_RATE:Record<EnemyReleaseCondition,number|undefined>=
  {'hp-below-30':30,'hp-below-50':50,'hp-below-70':70,'hp-below-95':95,'always':undefined};

/** 只决定目标、路径和动作；位置推进及碰撞仍由场景物理系统负责。 */
export class EnemyController {
  private readonly id: string;
  private readonly behavior: EnemyBehavior;
  private readonly attack: ResolvedBasicAttack | null;
  private readonly port: EnemyPort;
  private readonly combat?: CombatController;
  get combatController():CombatController|undefined{return this.combat;}
  private readonly skills: readonly EnemyPlayableSkill[];
  private readonly random: () => number;
  private state: EnemySnapshot['state']='idle';
  private targetId?: string;
  private pendingReturn=false;
  private threatCombatActive=false;
  private accumulator=0;
  private clock=0;
  private nextPathAt=0;
  private path: Point[]=[];
  private destination?: Point;
  private destinationRange?: number;
  private progressPosition?: Point;
  private lastProgressAt=0;
  private disposed=false;
  private idleElapsed=0;
  private wanderDestination?:Point;
  /** 正在跨帧推进的搜索；目标变化或恢复检查点时会丢弃。 */
  private search?:{task:PathSearch;target?:Combatant;targetId?:string;destination:Point;range:number;isGoal:(point:Point)=>boolean};
  private readonly spentOnce=new Set<string>();
  private get mapWide():boolean{return this.behavior.engagement==='map-wide';}

  constructor(id:string,behavior:EnemyBehavior,basicAttack:ResolvedBasicAttack|null,port:EnemyPort,skills:readonly EnemyPlayableSkill[]=[],random:()=>number=Math.random,sharedCombat?:CombatController){
    this.id=id;this.behavior=behavior;this.attack=basicAttack;this.port=port;
    this.skills=skills;this.random=random;
    if(basicAttack||skills.length||sharedCombat)this.combat=sharedCombat??new CombatController(id,basicAttack,port.threat?{
      ...port,
      approachTarget:(target,range)=>{
        const actor=port.actor(id);
        if(actor&&behavior.canMove&&behavior.moveSpeedPxPerSecond>0){
          if(this.navigate(actor,target.position,target,range))return true;
          this.pendingReturn=true;
        }else port.stop();
        return false;
      },
      canFinishApproach:targetId=>port.threat!.has(targetId)&&(port.canFinishApproach?.(targetId)??true),
    }:port);
  }
  snapshot():EnemySnapshot{return {state:this.state,targetId:this.targetId,cooldowns:this.combat?.snapshot().cooldowns??{}};}
  captureState():EnemyControllerState {
    return structuredClone({state:this.state,targetId:this.targetId,pendingReturn:this.pendingReturn,threatCombatActive:this.threatCombatActive,
      accumulator:this.accumulator,clock:this.clock,nextPathAt:this.nextPathAt,path:this.path,destination:this.destination,
      destinationRange:this.destinationRange,progressPosition:this.progressPosition,lastProgressAt:this.lastProgressAt,
      idleElapsed:this.idleElapsed,wanderDestination:this.wanderDestination,combat:this.combat?.snapshot(),
      spentOnce:[...this.spentOnce]});
  }
  restoreState(state:EnemyControllerState):void {
    if(this.disposed)throw new Error('无法恢复已销毁的敌人行为');
    const saved=structuredClone(state);this.cancel();this.search=undefined;
    if(saved.combat)this.combat?.restoreState(saved.combat);
    this.state=saved.state;this.targetId=saved.targetId;this.pendingReturn=saved.pendingReturn;
    this.threatCombatActive=saved.threatCombatActive??!!saved.targetId;
    this.accumulator=saved.accumulator;this.clock=saved.clock;this.nextPathAt=this.mapWide&&!saved.path.length?saved.clock:saved.nextPathAt;this.path=saved.path;
    this.destination=saved.destination;this.destinationRange=saved.destinationRange;this.progressPosition=saved.progressPosition;
    this.lastProgressAt=saved.lastProgressAt;this.idleElapsed=saved.idleElapsed;this.wanderDestination=saved.wanderDestination;
    this.spentOnce.clear();for(const skillId of saved.spentOnce??[])this.spentOnce.add(skillId);
    if(this.path.length)this.port.followPath(this.nextWaypoint);
  }
  update(deltaMs:number):void{
    if(this.disposed||this.port.isPaused?.()||!Number.isFinite(deltaMs)||deltaMs<=0)return;
    this.accumulator+=deltaMs;
    while(this.accumulator>=LOGIC_FRAME_MS){this.accumulator-=LOGIC_FRAME_MS;this.step();}
  }
  /** 宿主在同一共有帧依次调用所有角色，再推进共有时间。 */
  step():void {
    if(this.disposed||this.port.isPaused?.())return;
    this.clock+=LOGIC_FRAME_MS;this.tick();
  }
  onContact(event:AttackContact):void{
    if(this.port.threat){
      if(!this.disposed&&event.targetId===this.id&&this.port.threat.has(event.casterId))this.onThreatAdded();
      return;
    }
    if(this.disposed||event.targetId!==this.id||this.state==='returning'||this.pendingReturn||this.behavior.aggression==='none'||!this.combat||this.port.counterattack?.()===false)return;
    const actor=this.port.actor(this.id),source=this.port.actor(event.casterId);
    if(!actor||!source||source.id===actor.id||source.team===actor.team||this.targetId||!canTargetCombatant(actor,source))return;
    this.targetId=source.id;this.state='chasing';
  }
  /** 仇恨增加只唤醒下一次行动决策，保留当前动作和路径。 */
  onThreatAdded():void {
    if(!this.disposed)this.threatCombatActive=true;
  }
  command(skill:EnemyPlayableSkill,targetId:string|undefined,level:number):boolean {
    if(this.disposed||!this.combat||this.state==='returning'||this.behavior.aggression==='none')return false;
    const started=this.combat.requestTriggeredAction({...skill,level},targetId,this.behavior.canTurn)==='started';
    // 命令可以没有目标（召唤物的范围动作在原地施放），这时保留它原来的目标不改成 undefined。
    if(started){if(targetId)this.targetId=targetId;this.pendingReturn=false;this.state=this.combat.snapshot().state==='attacking'?'attacking':'chasing';}
    return started;
  }
  targetRemoved(targetId:string,reason:'hidden'|'inactive'='hidden'):void {
    const current=this.port.threat?this.combat?.snapshot().targetId:this.targetId;
    this.combat?.targetRemoved(targetId);
    if(current!==targetId)return;
    if(reason==='inactive'&&!this.mapWide){this.port.threat?.clear();this.threatCombatActive=false;}
    this.targetId=undefined;this.pendingReturn=false;
    this.path=[];this.destination=undefined;this.search=undefined;this.progressPosition=undefined;this.nextPathAt=0;this.port.stop();
    this.state=this.combat?.snapshot().state==='attacking'?'attacking':'idle';
  }
  disable():void {
    this.combat?.cancel(true,!this.port.threat);
    this.path=[];this.destination=undefined;this.search=undefined;this.progressPosition=undefined;this.wanderDestination=undefined;this.idleElapsed=0;this.port.stop();
    if(this.state!=='returning')this.state=this.targetId?'chasing':'idle';
  }
  cancel():void{
    this.combat?.cancel(true);this.state='idle';this.targetId=undefined;this.pendingReturn=false;this.threatCombatActive=false;
    this.path=[];this.destination=undefined;this.search=undefined;this.progressPosition=undefined;this.accumulator=0;this.wanderDestination=undefined;this.idleElapsed=0;this.port.stop();
  }
  reset():void{this.cancel();this.combat?.reset();this.spentOnce.clear();}
  dispose():void{this.cancel();this.disposed=true;this.combat?.dispose();}

  private inAwareness(actor:Combatant,target:Combatant):boolean{
    return Math.floor(targetDistance(actor.position,target.position)/8)<=enemyAwarenessRangeUnits(this.behavior,this.mapWide?this.port.navigationBounds():undefined);
  }
  /** 全图交战只停止当前追近，保留已有仇恨及寻路重试截止时间。 */
  private awaitTarget():void {
    if(this.combat?.snapshot().state==='approaching')this.combat.cancel();
    else this.combat?.clearSelection();
    this.state='idle';this.targetId=undefined;this.pendingReturn=false;
    this.path=[];this.destination=undefined;this.search=undefined;this.progressPosition=undefined;this.wanderDestination=undefined;this.idleElapsed=0;this.port.stop();
  }
  private returnHome():void{
    if(this.mapWide){this.awaitTarget();return;}
    this.port.threat?.clear();this.threatCombatActive=false;
    this.combat?.cancel(true);this.state='returning';this.targetId=undefined;this.pendingReturn=false;
    this.path=[];this.destination=undefined;this.search=undefined;this.progressPosition=undefined;this.wanderDestination=undefined;this.idleElapsed=0;this.port.stop();
  }
  private tick():void{
    const actor=this.port.actor(this.id);
    if(!actor||!this.combat||this.behavior.aggression==='none'){this.port.stop();return;}
    const current=this.port.threat?this.combat.snapshot().targetId:this.targetId;
    if(current&&!this.port.actor(current))this.targetRemoved(current,'inactive');
    const previous=current?this.port.actor(current):undefined;
    if(previous&&!canTargetCombatant(actor,previous))this.targetRemoved(previous.id);
    const previousAction=this.combat.snapshot().state;
    this.combat.update();
    const capabilities=combatStateCapabilities(actor.states??[]);
    if(!capabilities.canAct){this.disable();return;}
    if(this.port.threat){
      const action=this.combat.snapshot().state;
      if(action==='approaching'||action==='attacking'){this.state=action==='attacking'?'attacking':'chasing';return;}
      if(previousAction==='approaching'){
        if(this.pendingReturn)this.returnHome();
        else{this.targetId=undefined;this.state='idle';}
        return;
      }
      if(this.threatCombatActive){
        this.pendingReturn=false;
        if(this.state==='returning'){
          this.state='idle';this.path=[];this.destination=undefined;this.search=undefined;this.nextPathAt=0;this.port.stop();
        }
      }
    }
    if(this.state==='returning'){
      const home=this.port.home();
      if(!this.behavior.canMove||Math.hypot(actor.position.x-home.x,actor.position.y-home.y)<=(this.port.followDistancePx??ARRIVAL_DISTANCE_PX)){
        this.state='idle';this.path=[];this.destination=undefined;this.search=undefined;this.idleElapsed=0;this.port.stop();return;
      }
      this.navigate(actor,home,undefined,this.port.followDistancePx??0);return;
    }
    if(this.port.threat){
      // 每个决策点扫描候选：接战后召唤物中途登场，也能在下一次决策点抢到仇恨。
      // `has` 保证同一来源只 notice 一次；被动敌人只在已经打到人时扫描，不主动开战。
      if(this.behavior.aggression==='active'||(this.threatCombatActive&&this.combat.snapshot().targetId!==undefined)){
        for(const candidate of this.port.candidates()){
          if(candidate.id===this.id||candidate.team===actor.team)continue;
          if(this.mapWide&&this.port.isAlive?.(candidate.id)===false)continue;
          if(!this.inAwareness(actor,candidate)||!canTargetCombatant(actor,candidate))continue;
          if(this.port.threat.has(candidate.id))continue;
          this.port.threat.notice(candidate.id);
        }
      }
      this.targetId=this.port.threat.select(this.combat.snapshot().targetId);
      if(this.targetId)this.threatCombatActive=true;
      else if(this.threatCombatActive){this.returnHome();return;}
    }
    if(!this.port.threat&&!this.targetId&&this.port.focusTarget){
      const focused=this.port.actor(this.port.focusTarget()??'');
      if(focused&&focused.team!==actor.team&&this.inAwareness(actor,focused)&&canTargetCombatant(actor,focused))this.targetId=focused.id;
    }
    if(!this.port.threat&&!this.targetId&&this.behavior.aggression==='active'){
      this.targetId=this.port.candidates().filter(target=>target.id!==this.id&&target.team!==actor.team&&this.inAwareness(actor,target)&&canTargetCombatant(actor,target))
        .sort((a,b)=>targetDistance(actor.position,a.position)-targetDistance(actor.position,b.position)||a.id.localeCompare(b.id))[0]?.id;
    }
    const target=this.targetId?this.port.actor(this.targetId):undefined;
    if(target&&this.wanderDestination){
      this.wanderDestination=undefined;this.path=[];this.destination=undefined;this.search=undefined;this.nextPathAt=0;this.port.stop();
    }
    const lost=this.targetId!==undefined&&(!target||target.team===actor.team||(!this.port.threat&&!this.inAwareness(actor,target)));
    if(this.combat.snapshot().state==='approaching'){this.state='chasing';return;}
    if(this.combat.snapshot().state==='attacking'){
      this.state='attacking';if(lost)this.pendingReturn=true;return;
    }
    if(lost||this.pendingReturn){this.returnHome();return;}
    if(!target){
      if(this.mapWide){this.awaitTarget();return;}
      if(this.port.followDistancePx){
        this.state='idle';const home=this.port.home();
        if(Math.hypot(actor.position.x-home.x,actor.position.y-home.y)>this.port.followDistancePx)this.navigate(actor,home,undefined,this.port.followDistancePx);
        else this.port.stop();
      }else this.wander(actor);
      return;
    }
    this.idleElapsed=0;
    const distance=attackDistance(actor.position,actor.bounds,target.position,target.bounds);
    const cooldowns=this.combat.snapshot().cooldowns;
    const ready=this.skills.filter(skill=>!cooldowns[skill.id]&&this.combat!.canSelectSkill(skill)&&this.releaseAllowed(skill));
    const available=this.port.threat?ready:ready.filter(skill=>!needsTarget(skill.action)||distance<=skill.action.approachDistanceUnits);
    if(available.length){
      // 原版 MONSTERAI_RunAIProc 遍历全部绑定、匹配项逐个覆盖输出，取最后一个。
      const skill=available[available.length-1];
      if(needsTarget(skill.action)&&this.holdImmobileAction(actor,target,skill.action.approachDistanceUnits,skill))return;
      this.path=[];this.destination=undefined;this.search=undefined;
      if(this.port.threat&&!this.mapWide)this.nextPathAt=0;
      const result=this.combat.request({...skill,level:skill.level,manaCost:skill.manaCost},target.id,this.behavior.canTurn);
      if(result==='started'&&skill.once)this.spentOnce.add(skill.id);
      if(this.port.threat&&(result!=='started'||this.combat.snapshot().state==='idle')){this.returnHome();return;}
      this.state=this.combat.snapshot().state==='attacking'?'attacking':'chasing';return;
    }
    if(this.attack&&(this.port.threat||distance<=this.attack.approachDistanceUnits)){
      if(this.holdImmobileAction(actor,target,this.attack.approachDistanceUnits))return;
      this.path=[];this.destination=undefined;this.search=undefined;
      if(this.port.threat&&!this.mapWide)this.nextPathAt=0;
      const result=this.combat.requestTarget(target.id,this.behavior.canTurn);
      if(this.port.threat&&(result!=='started'||this.combat.snapshot().state==='idle')){this.returnHome();return;}
      this.state=this.combat.snapshot().state==='attacking'?'attacking':'chasing';return;
    }
    this.state='chasing';
    const ranges=[...(this.attack?[this.attack.approachDistanceUnits]:[]),...ready.map(skill=>skill.action.approachDistanceUnits)];
    if(this.behavior.canMove&&this.behavior.moveSpeedPxPerSecond>0&&ranges.length)this.navigate(actor,target.position,target,Math.max(...ranges));
    else this.port.stop();
  }
  /** 原版释放条件：MONSKILLBASE 第 1 字节的 MONAIINFOBASE 行，以及每场只放一次的门。 */
  private releaseAllowed(skill:EnemyPlayableSkill):boolean {
    if(skill.once&&this.spentOnce.has(skill.id))return false;
    const rate=RELEASE_HEALTH_RATE[skill.releaseCondition??'always'];
    if(rate===undefined)return true;
    const health=this.port.health?.(this.id);
    if(!health||health.maximum<=0)return false;
    return health.current>0&&health.current*100<=health.maximum*rate;
  }

  private holdImmobileAction(actor:Combatant,target:Combatant,range:number,skill?:EnemyPlayableSkill):boolean {
    if(!this.port.threat||attackDistance(actor.position,actor.bounds,target.position,target.bounds)<=range||actor.states?.includes('ambush'))return false;
    if(this.behavior.canMove&&this.behavior.moveSpeedPxPerSecond>0&&combatStateCapabilities(actor.states??[]).canMove)return false;
    const manaCost=skill?(this.port.manaCost?.(skill)??skill.manaCost):undefined;
    if(manaCost&&this.port.canSpendMana?.(manaCost)===false)return false;
    this.path=[];this.destination=undefined;this.search=undefined;if(!this.mapWide)this.nextPathAt=0;
    const reachable=this.reachableNow(actor,target.position,target,range);
    this.path=[];this.destination=undefined;this.search=undefined;this.progressPosition=undefined;this.port.stop();
    if(reachable){this.state='idle';this.combat?.setReactionTarget(target.id);}
    else this.returnHome();
    return true;
  }
  private navigate(actor:Combatant,destination:Point,target:Combatant|undefined,range=0,follow=true):boolean{
    const capabilities=combatStateCapabilities(actor.states??[]);
    if(follow&&(!capabilities.canMove||(target&&!capabilities.canAutoApproach))){this.port.stop();return false;}
    while(this.path.length&&Math.hypot(actor.position.x-this.path[0].x,actor.position.y-this.path[0].y)<=ARRIVAL_DISTANCE_PX)this.path.shift();
    if(!this.progressPosition||Math.hypot(actor.position.x-this.progressPosition.x,actor.position.y-this.progressPosition.y)>=ARRIVAL_DISTANCE_PX){
      this.progressPosition={...actor.position};this.lastProgressAt=this.clock;
    }
    const stalled=this.path.length>0&&this.clock-this.lastProgressAt>=REPATH_INTERVAL_MS;
    const moved=!this.destination||targetDistance(this.destination,destination)>=PATH_GRID_SIZE||range!==this.destinationRange;
    const blocked=this.path.length>0&&!canTraverse(actor.position,this.path[0],point=>this.port.canStand(point));
    // 目标换了（或从追击切回回家）就丢弃旧搜索，避免把上一条路线接回来。
    if(this.search&&this.search.targetId!==target?.id)this.search=undefined;
    if(this.search)this.advanceSearch(actor);
    else if(this.clock>=this.nextPathAt&&(moved||blocked||stalled||!this.path.length))this.beginSearch(actor,destination,target,range,stalled);
    // 跨帧搜索还没出结果时先朝目标直走，别让敌人站着等路径算完。
    if(follow&&this.search&&!this.path.length){this.port.moveToward(destination);return true;}
    if(!follow)return this.path.length>0;
    if(this.nextWaypoint()){this.port.followPath(this.nextWaypoint);return true;}
    this.port.stop();return this.path.length>0;
  }
  private searchQuery(actor:Combatant,destination:Point,target:Combatant|undefined,range:number){
    const snapshot=this.port.navigationSnapshot?.();
    const canStand=snapshot?(point:Point)=>snapshot.canStand(point):(point:Point)=>this.port.canStand(point);
    const isGoal=target
      ?(point:Point)=>canStand(point)&&attackDistance(point,actor.bounds,target.position,target.bounds)<=range
      :(point:Point)=>Math.hypot(point.x-destination.x,point.y-destination.y)<=Math.max(PATH_GRID_SIZE,range)&&canStand(point);
    // 松的距离下界覆盖双方实体范围和量化余量，保证 A* 不高估剩余路程。
    const radius=target?Math.hypot(actor.bounds.width+target.bounds.width,actor.bounds.height+target.bounds.height)+range*8:PATH_GRID_SIZE;
    return {bounds:snapshot?.bounds??this.port.navigationBounds(),canStand,isGoal,
      heuristic:(point:Point)=>Math.max(0,Math.hypot(point.x-destination.x,point.y-destination.y)-radius)};
  }
  private beginSearch(actor:Combatant,destination:Point,target:Combatant|undefined,range:number,stalled:boolean):void{
    this.nextPathAt=this.clock+REPATH_INTERVAL_MS;this.destination={...destination};this.destinationRange=range;
    if(stalled)this.lastProgressAt=this.clock;
    const query=this.searchQuery(actor,destination,target,range);
    this.search={task:createPathSearch(actor.position,query),target,targetId:target?.id,destination:{...destination},range,isGoal:query.isGoal};
    this.advanceSearch(actor);
  }
  private advanceSearch(actor:Combatant):void{
    const search=this.search;if(!search)return;
    const requested=SEARCH_SLICE;
    const granted=this.port.pathBudget?.take(requested)??requested;
    if(granted<=0)return;
    const result=search.task.step(granted);
    if(result.status==='pending')return;
    this.search=undefined;
    if(result.status==='unreachable'){this.path=[];this.nextPathAt=this.clock+FAILED_PATH_MS;return;}
    // 搜索期间敌人可能已朝目标直走过一段；从离当前位置最近的点继续，别掉头走回起点。
    let start=0,nearest=Infinity;
    for(let index=0;index<result.path.length;index++){
      const point=result.path[index],distance=Math.hypot(point.x-actor.position.x,point.y-actor.position.y);
      if(distance>=nearest)break;
      start=index;nearest=distance;
    }
    this.path=result.path.slice(start);
    if(!search.target&&!search.range&&(this.path.length||search.isGoal(actor.position)))this.path.push({...search.destination});
  }
  /** 施法前的即时可达性：同步算完但带上限，不参与跨帧状态。 */
  private reachableNow(actor:Combatant,destination:Point,target:Combatant,range:number):boolean{
    const result=createPathSearch(actor.position,this.searchQuery(actor,destination,target,range)).step(HOLD_SEARCH_CAP);
    return result.status==='found'&&result.path.length>0;
  }
  private readonly nextWaypoint=():Point|undefined=>{
    const actor=this.port.actor(this.id);if(!actor||this.disposed)return;
    const capabilities=combatStateCapabilities(actor.states??[]);
    if(!capabilities.canMove||(this.targetId&&!capabilities.canAutoApproach))return;
    const target=this.targetId?this.port.actor(this.targetId):undefined;
    if(target&&!canTargetCombatant(actor,target))return;
    while(this.path.length&&Math.hypot(actor.position.x-this.path[0].x,actor.position.y-this.path[0].y)<=ARRIVAL_DISTANCE_PX)this.path.shift();
    const next=this.path[0];
    return next&&canTraverse(actor.position,next,point=>this.port.canStand(point))?next:undefined;
  };
  private wander(actor:Combatant):void{
    const config=this.behavior.wander;
    if(!config||!this.behavior.canMove||!this.behavior.canTurn||this.behavior.moveSpeedPxPerSecond<=0||!combatStateCapabilities(actor.states??[]).canMove){this.state='idle';this.port.stop();return;}
    if(this.wanderDestination){
      if(!this.progressPosition||Math.hypot(actor.position.x-this.progressPosition.x,actor.position.y-this.progressPosition.y)>=ARRIVAL_DISTANCE_PX){
        this.progressPosition={...actor.position};this.lastProgressAt=this.clock;
      }
      if(this.nextWaypoint()&&this.clock-this.lastProgressAt<REPATH_INTERVAL_MS){this.port.followPath(this.nextWaypoint);return;}
      this.wanderDestination=undefined;this.path=[];this.state='idle';this.idleElapsed=0;this.port.stop();return;
    }
    this.state='idle';this.port.stop();this.idleElapsed+=LOGIC_FRAME_MS;
    if(this.idleElapsed<config.idleDurationMs)return;
    this.idleElapsed=0;
    const move=Math.floor(this.random()*100),turn=Math.floor(this.random()*100);
    const directions=['south','west','north','east'] as const;
    let facing=this.port.facing();
    if(turn<(move<30?50:30)){
      facing=directions[(directions.indexOf(facing)+1)%directions.length];this.port.face?.(facing);
    }
    if(move>=30)return;
    // 闲逛步数取两次 1 至 4 抽样的平均值，向下取整。
    const distance=Math.floor((1+Math.floor(this.random()*4)+1+Math.floor(this.random()*4))/2)*PATH_GRID_SIZE;
    const destination={x:Math.trunc(actor.position.x),y:Math.trunc(actor.position.y)};
    if(facing==='west'||facing==='east')destination.x+=(facing==='west'?-1:1)*distance;
    else destination.y+=(facing==='north'?-1:1)*distance;
    const canStand=(point:Point)=>this.port.canStand(point);
    if(!canStand(destination))return;
    const granted=this.port.pathBudget?.take(WANDER_SEARCH_CAP)??WANDER_SEARCH_CAP;
    if(granted<=0)return;
    const result=createPathSearch(actor.position,{bounds:this.port.navigationBounds(),canStand,
      isGoal:point=>Math.hypot(point.x-destination.x,point.y-destination.y)<=PATH_GRID_SIZE&&canTraverse(point,destination,canStand),
      heuristic:point=>Math.max(0,Math.hypot(point.x-destination.x,point.y-destination.y)-PATH_GRID_SIZE)}).step(granted);
    if(result.status!=='found')return;
    const path=result.path;
    if(!path.length||Math.hypot(path.at(-1)!.x-destination.x,path.at(-1)!.y-destination.y)>ARRIVAL_DISTANCE_PX)path.push(destination);
    this.path=path;this.destination=undefined;this.wanderDestination=destination;this.state='wandering';
    this.progressPosition={...actor.position};this.lastProgressAt=this.clock;
    this.port.followPath(this.nextWaypoint);
  }
}

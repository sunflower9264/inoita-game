import { LOGIC_FRAME_MS, type EnemyBehavior, type EnemyPlayableSkill, type ResolvedBasicAttack } from './battle.ts';
import { attackDistance, targetDistance } from './basic-attack.ts';
import { enemyAwarenessRangeUnits } from './enemy-engagement.ts';
import { CombatController, canTargetCombatant, type AttackContact, type CombatSnapshot, type Combatant } from './combat.ts';
import { combatStateCapabilities } from './combat-state.ts';
import type { EnemyPort } from './enemy-ai.ts';
import type { GameRectangle, Point } from './navigation.ts';
import { canTraverse, createPathSearch, PATH_GRID_SIZE, type PathSearch } from './pathfinding.ts';

export type FriendlySummonRole = 'hell-soldier' | 'beast';
export interface FriendlySummonTactics {
  engagedTargetIds: readonly string[];
  ownerTargetId?: string;
  focusTargetId?: string;
  threats: readonly {enemyId:string;targetId:string}[];
  partyIds: readonly string[];
}
export interface FriendlySummonNavigationSnapshot {
  bounds: GameRectangle;
  start?: Point;
  canStand(point:Point):boolean;
  terrainFree?(point:Point):boolean;
}
export interface FriendlySummonPort extends EnemyPort {
  /** 世界只提供已经接战的敌人；点选和接近本身不构成接战。 */
  tactics():FriendlySummonTactics;
  navigationSnapshot():FriendlySummonNavigationSnapshot;
  /** 再次核对整队脱战、安全落点并移动实体，成功时返回 true。 */
  tryRecall():boolean;
  /** 自主索敌是否允许以该敌人为目标；展示型场景物件必须返回 false。 */
  autonomousTarget(id:string):boolean;
}
export const FRIENDLY_SUMMON_AI = {
  decisionMs:180,holdTargetMs:600,pathImprovementPx:32,failedPathMs:900,
  followStartPx:32,followStopPx:16,joinCombatPx:128,leashPx:192,returnStopPx:64,
  farRecallPx:320,recallDelayMs:5040,progressPx:4,destinationChangePx:16,
  searchNodesPerFrame:64,
} as const;
type SummonState = 'idle'|'following'|'chasing'|'attacking'|'returning';
interface RememberedTarget {id:string;until:number;position:Point}
export interface FriendlySummonState {
  ownerId:string;
  role:FriendlySummonRole;
  state:SummonState;
  targetId?:string;
  returning:boolean;
  clock:number;
  accumulator:number;
  nextDecisionAt:number;
  nextSearchAt:number;
  nextRecallAt:number;
  nextFollowSearchAt:number;
  targetSince:number;
  path:Point[];
  pathTargetId?:string;
  pathDestination?:Point;
  followActive:boolean;
  failedTargets:RememberedTarget[];
  checkedTargets:RememberedTarget[];
  fallbackTargets:RememberedTarget[];
  farElapsed:number;
  stuckElapsed:number;
  progressOrigin?:Point;
  followDestination?:Point;
  followUnreachable:boolean;
  followSlot:number;
  combat?:CombatSnapshot;
}

/** 存档以静止状态恢复；运行中的寻路任务和短期战术记忆不跨读档。 */
export function friendlySummonStationaryState(saved:FriendlySummonState):FriendlySummonState {
  return {ownerId:saved.ownerId,role:saved.role,state:'idle',returning:false,clock:0,accumulator:0,
    nextDecisionAt:0,nextSearchAt:0,nextRecallAt:0,nextFollowSearchAt:0,targetSince:0,path:[],followActive:false,
    failedTargets:[],checkedTargets:[],fallbackTargets:[],farElapsed:0,stuckElapsed:0,followUnreachable:false,followSlot:0,
    ...(saved.combat?{combat:{state:'idle',cooldowns:structuredClone(saved.combat.cooldowns)}}:{})};
}

interface Candidate {actor:Combatant;priority:number;distance:number}
interface SearchWork {
  task:PathSearch;
  targetId:string;
  destination:Point;
  range:number;
  kind:'follow'|'target';
  landing?:Point;
}
interface ReadyChoice {targetId:string;destination:Point;range:number;path:Point[]}
const distance=(a:Point,b:Point)=>Math.hypot(a.x-b.x,a.y-b.y);
function edgeGap(a:Point,actor:Combatant,b:Point,target:Combatant):number {
  const dx=Math.max(0,a.x+actor.bounds.x-b.x-target.bounds.x-target.bounds.width,b.x+target.bounds.x-a.x-actor.bounds.x-actor.bounds.width);
  const dy=Math.max(0,a.y+actor.bounds.y-b.y-target.bounds.y-target.bounds.height,b.y+target.bounds.y-a.y-actor.bounds.y-actor.bounds.height);
  return Math.hypot(dx,dy);
}
function routeLength(start:Point,path:readonly Point[]):number {
  let total=0,previous=start;
  for(const point of path){total+=distance(previous,point);previous=point;}
  return total;
}

/** 玩家侧召唤物只决定战术和路径，攻击周期仍由共用战斗控制器执行。 */
export class FriendlySummonController {
  readonly kind='friendly-summon' as const;
  readonly combatController:CombatController;
  private state:SummonState='idle';
  private targetId?:string;
  private returning=false;
  private clock=0;
  private accumulator=0;
  private nextDecisionAt=0;
  private nextSearchAt=0;
  private nextRecallAt=0;
  private nextFollowSearchAt=0;
  private targetSince=0;
  private path:Point[]=[];
  private pathTargetId?:string;
  private pathDestination?:Point;
  private followActive=false;
  private readonly failedTargets=new Map<string,RememberedTarget>();
  private readonly checkedTargets=new Map<string,RememberedTarget>();
  private readonly fallbackTargets=new Map<string,RememberedTarget>();
  private farElapsed=0;
  private stuckElapsed=0;
  private progressOrigin?:Point;
  private followDestination?:Point;
  private followUnreachable=false;
  private followSlot=0;
  private search?:SearchWork;
  private readyChoice?:ReadyChoice;
  private disposed=false;
  private searchedThisFrame=false;
  private expandedNodes=0;
  private readonly id:string;
  readonly ownerId:string;
  readonly role:FriendlySummonRole;
  private readonly behavior:EnemyBehavior;
  private readonly attack:ResolvedBasicAttack|null;
  private readonly port:FriendlySummonPort;

  constructor(id:string,ownerId:string,role:FriendlySummonRole,behavior:EnemyBehavior,attack:ResolvedBasicAttack|null,port:FriendlySummonPort,sharedCombat?:CombatController){
    this.id=id;this.ownerId=ownerId;this.role=role;this.behavior=behavior;this.attack=attack;this.port=port;
    this.combatController=sharedCombat??new CombatController(id,attack,{...port,
      // 普攻只在射程内起手；受命动作也不能绕过有预算的寻路走直线。
      approachTarget:()=>false,
    });
  }
  actionState():SummonState{return this.state;}
  currentTargetId():string|undefined{return this.targetId;}
  snapshot(){return {kind:this.kind,state:this.state,targetId:this.targetId,
    cooldowns:this.combatController.snapshot().cooldowns,searchPending:!!this.search,expandedNodes:this.expandedNodes};}
  captureState():FriendlySummonState {
    return structuredClone({ownerId:this.ownerId,role:this.role,state:this.state,targetId:this.targetId,returning:this.returning,
      clock:this.clock,accumulator:this.accumulator,nextDecisionAt:this.nextDecisionAt,nextSearchAt:this.nextSearchAt,nextRecallAt:this.nextRecallAt,nextFollowSearchAt:this.nextFollowSearchAt,
      targetSince:this.targetSince,path:this.path,pathTargetId:this.pathTargetId,pathDestination:this.pathDestination,
      followActive:this.followActive,failedTargets:[...this.failedTargets.values()],checkedTargets:[...this.checkedTargets.values()],fallbackTargets:[...this.fallbackTargets.values()],
      farElapsed:this.farElapsed,stuckElapsed:this.stuckElapsed,progressOrigin:this.progressOrigin,followDestination:this.followDestination,
      followUnreachable:this.followUnreachable,followSlot:this.followSlot,combat:this.combatController.snapshot()});
  }
  restoreState(saved:FriendlySummonState):void {
    if(this.disposed)throw new Error('无法恢复已销毁的召唤物行为');
    if(saved.ownerId!==this.ownerId||saved.role!==this.role)throw new Error('召唤物主人或行为类型不匹配');
    const state=structuredClone(saved);this.cancel();
    this.state=state.state;this.targetId=state.targetId;this.returning=state.returning;this.clock=state.clock;this.accumulator=state.accumulator;
    this.nextDecisionAt=Math.min(state.nextDecisionAt,state.clock);this.nextSearchAt=Math.min(state.nextSearchAt,state.clock);this.nextRecallAt=state.nextRecallAt;
    this.nextFollowSearchAt=state.nextFollowSearchAt;
    this.targetSince=state.targetSince;this.path=state.path;this.pathTargetId=state.pathTargetId;this.pathDestination=state.pathDestination;
    this.followActive=state.followActive;for(const entry of state.failedTargets)this.failedTargets.set(entry.id,entry);
    for(const entry of state.checkedTargets)this.checkedTargets.set(entry.id,entry);
    for(const entry of state.fallbackTargets)this.fallbackTargets.set(entry.id,entry);
    this.farElapsed=state.farElapsed;this.stuckElapsed=state.stuckElapsed;this.progressOrigin=state.progressOrigin;
    this.followDestination=state.followDestination;this.followUnreachable=state.followUnreachable;
    this.followSlot=state.followSlot;
    if(state.combat)this.combatController.restoreState(state.combat);
    if(this.path.length)this.port.followPath(this.nextWaypoint);
  }
  update(deltaMs:number):void {
    if(this.disposed||this.port.isPaused?.()||!Number.isFinite(deltaMs)||deltaMs<=0)return;
    this.accumulator+=deltaMs;
    while(this.accumulator>=LOGIC_FRAME_MS){this.accumulator-=LOGIC_FRAME_MS;this.step();}
  }
  step():void {
    if(this.disposed||this.port.isPaused?.())return;
    this.clock+=LOGIC_FRAME_MS;this.searchedThisFrame=false;this.expandedNodes=0;
    const actor=this.port.actor(this.id),owner=this.port.actor(this.ownerId);
    if(!actor||!owner||this.port.isAlive?.(this.id)===false||this.port.isAlive?.(this.ownerId)===false){this.cancel();return;}
    this.combatController.update();
    const capabilities=combatStateCapabilities(actor.states??[]);
    if(!capabilities.canAct){this.disable();return;}
    const ownerDistance=distance(actor.position,owner.position);
    if(ownerDistance>FRIENDLY_SUMMON_AI.leashPx&&!this.returning){
      this.returning=true;this.dropTarget();this.clearSearch();this.clearPath();
    }else if(this.returning&&ownerDistance<=FRIENDLY_SUMMON_AI.returnStopPx){
      this.returning=false;this.followActive=false;this.clearSearch();this.clearPath();this.nextDecisionAt=this.clock;
    }
    if(this.targetId&&!this.validTarget(actor,owner,this.targetId))this.targetRemoved(this.targetId);
    this.advanceSearch(actor,owner);
    this.applyReadyChoice(actor,owner);
    if(this.clock>=this.nextDecisionAt){
      this.nextDecisionAt=this.clock+FRIENDLY_SUMMON_AI.decisionMs;
      this.decide(actor,owner);
    }
    this.advanceSearch(actor,owner);
    this.applyReadyChoice(actor,owner);
    this.act(actor,owner);
    this.trackRecovery(actor,owner);
  }
  onContact(event:AttackContact):void {
    if(!this.disposed&&(event.targetId===this.id||event.targetId===this.ownerId||event.casterId===this.ownerId))this.nextDecisionAt=this.clock;
  }
  onThreatAdded():void {if(!this.disposed)this.nextDecisionAt=this.clock;}
  command(skill:EnemyPlayableSkill,targetId:string|undefined,level:number):boolean {
    if(this.disposed)return false;
    const result=this.combatController.requestTriggeredAction({...skill,level},targetId,this.behavior.canTurn);
    if(result==='started'){this.clearPath();this.state='attacking';return true;}
    return false;
  }
  targetRemoved(targetId:string,_reason:'hidden'|'inactive'='hidden'):void {
    this.combatController.targetRemoved(targetId);
    this.failedTargets.delete(targetId);this.checkedTargets.delete(targetId);this.fallbackTargets.delete(targetId);
    if(this.search?.targetId===targetId)this.search=undefined;
    if(this.readyChoice?.targetId===targetId)this.readyChoice=undefined;
    if(this.targetId===targetId){this.targetId=undefined;this.clearPath();this.nextDecisionAt=this.clock;}
    if(this.pathTargetId===targetId)this.clearPath();
  }
  disable():void {
    this.combatController.cancel(true,false);this.clearPath();this.clearSearch();this.port.stop();
    this.farElapsed=0;this.stuckElapsed=0;this.progressOrigin=undefined;this.followUnreachable=false;
    this.state=this.returning?'returning':'idle';
  }
  cancel():void {
    this.combatController.cancel(true);this.targetId=undefined;this.returning=false;this.state='idle';
    this.clearPath();this.clearSearch();this.failedTargets.clear();this.checkedTargets.clear();this.fallbackTargets.clear();this.followActive=false;
    this.farElapsed=0;this.stuckElapsed=0;this.progressOrigin=undefined;this.followDestination=undefined;this.followUnreachable=false;
    this.accumulator=0;this.nextDecisionAt=this.clock;this.nextSearchAt=this.clock;this.nextRecallAt=this.clock;this.nextFollowSearchAt=this.clock;this.port.stop();
  }
  reset():void {this.cancel();this.combatController.reset();}
  dispose():void {this.cancel();this.disposed=true;this.combatController.dispose();}

  private validTarget(actor:Combatant,owner:Combatant,id:string):Combatant|undefined {
    const target=this.port.actor(id);
    return target&&target.team!==actor.team&&this.port.isAlive?.(id)!==false&&canTargetCombatant(actor,target)
      &&distance(owner.position,target.position)<=FRIENDLY_SUMMON_AI.leashPx?target:undefined;
  }
  private priority(targetId:string,tactics:FriendlySummonTactics):number {
    const ownerHealth=this.port.health?.(this.ownerId);
    const threatens=(id:string)=>tactics.threats.some(threat=>threat.enemyId===targetId&&threat.targetId===id);
    const ownerThreat=threatens(this.ownerId);
    if(ownerThreat&&ownerHealth&&ownerHealth.maximum>0&&ownerHealth.current/ownerHealth.maximum<=.3)return 0;
    const lowAlly=tactics.partyIds.some(id=>{
      const health=this.port.health?.(id);
      return health&&health.current>0&&health.maximum>0&&health.current/health.maximum<=.35&&threatens(id);
    });
    const ownerTarget=tactics.ownerTargetId===targetId,focus=tactics.focusTargetId===targetId;
    if(this.role==='hell-soldier')return ownerTarget?1:focus?2:ownerThreat||lowAlly?3:4;
    return ownerThreat?1:threatens(this.id)?2:lowAlly?3:ownerTarget?4:focus?5:6;
  }
  /** 原版发现口径：八像素量化距离除以 8 后与警戒单位比较，不用欧氏圆。 */
  private inAwareness(actor:Combatant,target:Combatant):boolean {
    const bounds=this.behavior.engagement==='map-wide'?this.port.navigationBounds?.():undefined;
    return Math.floor(targetDistance(actor.position,target.position)/8)<=enemyAwarenessRangeUnits(this.behavior,bounds);
  }
  private candidates(actor:Combatant,owner:Combatant,tactics:FriendlySummonTactics):Candidate[] {
    const admitted=new Set(tactics.engagedTargetIds);
    const active=this.behavior.aggression==='active';
    return this.port.candidates().flatMap(target=>{
      const engaged=admitted.has(target.id);
      // 原版 CHAR_LookAroundEnemy：主动型角色按自身警戒范围发现敌人，不要求战斗已经发生。
      // 展示型场景物仍由世界侧 autonomousTarget 排除。
      const noticed=active&&!engaged&&this.port.autonomousTarget(target.id)&&this.inAwareness(actor,target);
      if((!engaged&&!noticed)||!this.validTarget(actor,owner,target.id))return [];
      const committed=target.id===tactics.ownerTargetId||target.id===tactics.focusTargetId||target.id===this.targetId;
      if(distance(owner.position,target.position)>(committed?FRIENDLY_SUMMON_AI.leashPx:FRIENDLY_SUMMON_AI.joinCombatPx))return [];
      if(this.remembered(this.failedTargets,target))return [];
      return [{actor:target,priority:this.priority(target.id,tactics),distance:distance(actor.position,target.position)}];
    }).sort((a,b)=>a.priority-b.priority||a.distance-b.distance||a.actor.id.localeCompare(b.actor.id));
  }
  private remembered(memory:Map<string,RememberedTarget>,target:Combatant):boolean {
    const entry=memory.get(target.id);
    if(!entry)return false;
    if(entry.until<=this.clock||distance(entry.position,target.position)>=FRIENDLY_SUMMON_AI.destinationChangePx){memory.delete(target.id);return false;}
    return true;
  }
  private decide(actor:Combatant,owner:Combatant):void {
    if(this.returning){this.followOwner(actor,owner);return;}
    const tactics=this.port.tactics(),candidates=this.candidates(actor,owner,tactics);
    const current=candidates.find(candidate=>candidate.actor.id===this.targetId);
    if(this.targetId&&!current)this.dropTarget();
    const best=candidates[0];
    if(!best){this.followOwner(actor,owner);return;}
    if(!current){this.planTarget(actor,best.actor);return;}
    const better=candidates.find(candidate=>candidate.priority<current.priority);
    if(better){this.planTarget(actor,better.actor);return;}
    if(this.inRange(actor,current.actor))return;
    const routeValid=this.pathTargetId===current.actor.id&&!!this.path.length&&this.nextWaypoint()!==undefined;
    if(!routeValid||!this.pathDestination||distance(this.pathDestination,current.actor.position)>=FRIENDLY_SUMMON_AI.destinationChangePx){
      this.planTarget(actor,current.actor);return;
    }
    if(this.clock-this.targetSince<FRIENDLY_SUMMON_AI.holdTargetMs)return;
    const alternative=candidates.find(candidate=>candidate.actor.id!==current.actor.id&&candidate.priority===current.priority&&!this.remembered(this.checkedTargets,candidate.actor));
    if(alternative)this.planTarget(actor,alternative.actor);
  }
  private followOwner(actor:Combatant,owner:Combatant):void {
    const gap=edgeGap(actor.position,actor,owner.position,owner);
    if(!this.returning){
      if(gap<=FRIENDLY_SUMMON_AI.followStopPx)this.followActive=false;
      else if(gap>FRIENDLY_SUMMON_AI.followStartPx)this.followActive=true;
    }
    if(!this.returning&&!this.followActive){this.clearPath();this.port.stop();this.resetStuck();return;}
    if(this.combatController.actionState()==='attacking')return;
    if(!this.canMove(actor)){this.clearPath();return;}
    if(this.followDestination&&distance(this.followDestination,owner.position)>=FRIENDLY_SUMMON_AI.destinationChangePx){
      this.followUnreachable=false;this.stuckElapsed=0;this.followDestination={...owner.position};this.nextFollowSearchAt=this.clock;
    }
    if(this.followUnreachable&&this.clock<this.nextFollowSearchAt)return;
    const range=this.returning?FRIENDLY_SUMMON_AI.returnStopPx:FRIENDLY_SUMMON_AI.followStopPx;
    if(this.pathTargetId!==owner.id||!this.path.length||!this.pathDestination||distance(this.pathDestination,owner.position)>=FRIENDLY_SUMMON_AI.destinationChangePx||!this.nextWaypoint()){
      this.beginSearch(actor,owner,range,'follow');
    }
  }
  private planTarget(actor:Combatant,target:Combatant):void {
    if(this.readyChoice?.targetId===target.id)return;
    if(this.inRange(actor,target)){
      this.readyChoice={targetId:target.id,destination:{...target.position},range:this.attackRange(),path:[]};return;
    }
    if(this.canMove(actor))this.beginSearch(actor,target,this.attackRange(),'target');
  }
  private beginSearch(actor:Combatant,target:Combatant,range:number,kind:SearchWork['kind']):void {
    if(this.search?.targetId===target.id&&this.search.kind===kind)return;
    if(this.clock<this.nextSearchAt)return;
    const frozen=this.port.navigationSnapshot(),destination={...target.position},bounds={...target.bounds};
    const actorBounds={...actor.bounds};
    const returning=this.returning;
    let landing:Point|undefined;
    if(kind==='follow'&&!returning||kind==='target'&&!this.remembered(this.fallbackTargets,target)){
      let hash=0;for(const character of this.id)hash=(hash*31+character.charCodeAt(0))>>>0;
      for(let attempt=0;attempt<8;attempt++){
        const angle=((hash+(kind==='follow'?this.followSlot:0)+attempt)%8)*Math.PI/4;
        const gap=kind==='follow'?FRIENDLY_SUMMON_AI.followStopPx:Math.max(0,(range-2)*8);
        const point={x:destination.x+bounds.x+bounds.width/2-actorBounds.x-actorBounds.width/2+Math.cos(angle)*((bounds.width+actorBounds.width)/2+gap),
          y:destination.y+bounds.y+bounds.height/2-actorBounds.y-actorBounds.height/2+Math.sin(angle)*((bounds.height+actorBounds.height)/2+gap)};
        if(frozen.canStand(point)&&(kind==='follow'||attackDistance(point,actorBounds,destination,bounds)<=range)){landing=point;break;}
      }
    }
    const isGoal=landing
      ?(point:Point)=>frozen.canStand(point)&&distance(point,landing!)<=PATH_GRID_SIZE&&canTraverse(point,landing!,frozen.canStand)
      :kind==='target'?(point:Point)=>frozen.canStand(point)&&attackDistance(point,actorBounds,destination,bounds)<=range
      :returning?(point:Point)=>frozen.canStand(point)&&distance(point,destination)<=range
      :(point:Point)=>frozen.canStand(point)&&edgeGap(point,{...actor,bounds:actorBounds},destination,{...target,bounds})<=range;
    const radius=kind==='target'?Math.hypot(actorBounds.width+bounds.width,actorBounds.height+bounds.height)+range*8
      :Math.hypot(actorBounds.width+bounds.width,actorBounds.height+bounds.height)+range;
    this.search={task:createPathSearch({...actor.position},{bounds:frozen.bounds,canStand:frozen.canStand,isGoal,
      heuristic:point=>Math.max(0,distance(point,landing??destination)-(landing?PATH_GRID_SIZE:radius))}),targetId:target.id,destination,range,kind,landing};
    this.nextSearchAt=this.clock+FRIENDLY_SUMMON_AI.decisionMs;
    if(kind==='follow')this.followDestination={...destination};
  }
  private advanceSearch(actor:Combatant,owner:Combatant):void {
    if(!this.search||this.searchedThisFrame||!this.canMove(actor))return;
    const work=this.search;this.searchedThisFrame=true;
    const result=work.task.step(FRIENDLY_SUMMON_AI.searchNodesPerFrame);this.expandedNodes=result.expanded;
    if(result.status==='pending')return;
    this.search=undefined;
    const target=this.port.actor(work.targetId);
    if(!target){this.nextDecisionAt=this.clock;return;}
    const moved=distance(work.destination,target.position)>=FRIENDLY_SUMMON_AI.destinationChangePx;
    if(result.status==='unreachable'){
      if(moved){this.nextDecisionAt=this.clock;return;}
      if(work.kind==='target'){
        const entry={id:work.targetId,until:this.clock+FRIENDLY_SUMMON_AI.failedPathMs,position:{...target.position}};
        if(work.landing)this.fallbackTargets.set(work.targetId,entry);
        else{
          this.failedTargets.set(work.targetId,entry);
          if(this.targetId===work.targetId)this.dropTarget();
        }
      }else{this.followUnreachable=true;this.followSlot=(this.followSlot+1)%8;this.nextFollowSearchAt=this.clock+FRIENDLY_SUMMON_AI.failedPathMs;}
      return;
    }
    const planned=work.landing?[...result.path,{...work.landing}]:result.path;
    const joined=this.joinPath(actor,planned);
    if(!joined){this.nextDecisionAt=this.clock;return;}
    if(work.kind==='follow'){
      if(this.targetId&&!this.returning)return;
      this.path=joined;this.pathTargetId=owner.id;this.pathDestination={...work.destination};
      if(this.followUnreachable){this.stuckElapsed=0;this.progressOrigin={...actor.position};}
      this.followUnreachable=false;
      return;
    }
    this.readyChoice={targetId:work.targetId,destination:{...work.destination},range:work.range,path:joined};
  }
  private joinPath(actor:Combatant,path:readonly Point[]):Point[]|undefined {
    if(!path.length)return [];
    let closest=0;
    for(let i=1;i<path.length;i++)if(distance(actor.position,path[i])<distance(actor.position,path[closest]))closest=i;
    if(!canTraverse(actor.position,path[closest],point=>this.port.canStand(point)))return;
    return path.slice(closest).map(point=>({...point}));
  }
  private applyReadyChoice(actor:Combatant,owner:Combatant):void {
    if(!this.readyChoice||this.returning||this.combatController.actionState()==='attacking')return;
    const choice=this.readyChoice;this.readyChoice=undefined;
    const tactics=this.port.tactics(),candidates=this.candidates(actor,owner,tactics),candidate=candidates.find(entry=>entry.actor.id===choice.targetId);
    if(!candidate)return;
    const current=candidates.find(entry=>entry.actor.id===this.targetId);
    const joined=this.joinPath(actor,choice.path);if(!joined)return;
    if(current&&current.actor.id!==candidate.actor.id){
      if(candidate.priority>current.priority)return;
      if(candidate.priority===current.priority){
        const end=joined.at(-1)??actor.position;
        const reachesCurrentTarget=attackDistance(end,actor.bounds,candidate.actor.position,candidate.actor.bounds)<=choice.range;
        const currentCost=this.inRange(actor,current.actor)?0:this.pathTargetId===current.actor.id&&this.nextWaypoint()?routeLength(actor.position,this.path):undefined;
        if(!reachesCurrentTarget||this.clock-this.targetSince<FRIENDLY_SUMMON_AI.holdTargetMs||currentCost===undefined||currentCost-routeLength(actor.position,joined)<FRIENDLY_SUMMON_AI.pathImprovementPx){
          this.checkedTargets.set(candidate.actor.id,{id:candidate.actor.id,until:this.clock+FRIENDLY_SUMMON_AI.failedPathMs,position:{...candidate.actor.position}});return;
        }
      }
    }
    if(this.targetId!==candidate.actor.id){this.targetId=candidate.actor.id;this.targetSince=this.clock;this.combatController.clearSelection();}
    this.path=joined;this.pathTargetId=candidate.actor.id;this.pathDestination={...choice.destination};
    this.followActive=false;this.resetStuck();
  }
  private act(actor:Combatant,owner:Combatant):void {
    if(this.combatController.actionState()==='attacking'){this.state='attacking';return;}
    if(this.returning){this.state='returning';this.walk(actor);return;}
    const target=this.targetId?this.validTarget(actor,owner,this.targetId):undefined;
    if(target){
      if(this.attack&&this.inRange(actor,target)){
        this.clearPath();this.combatController.requestTarget(target.id,this.behavior.canTurn);
        this.state=this.combatController.actionState()==='attacking'?'attacking':'chasing';
      }else{this.state='chasing';this.walk(actor);}
    }else if(this.followActive){this.state='following';this.walk(actor);}
    else{this.state='idle';this.port.stop();}
  }
  private canMove(actor:Combatant):boolean {
    const state=combatStateCapabilities(actor.states??[]);
    return this.behavior.canMove&&this.behavior.moveSpeedPxPerSecond>0&&state.canMove&&state.canAutoApproach;
  }
  private attackRange():number {return (this.attack?.approachDistanceUnits??0)+(this.port.rangeBonusUnits?.(this.id)??0);}
  private inRange(actor:Combatant,target:Combatant):boolean {return !!this.attack&&attackDistance(actor.position,actor.bounds,target.position,target.bounds)<=this.attackRange();}
  private walk(actor:Combatant):void {
    if(this.canMove(actor)&&this.nextWaypoint())this.port.followPath(this.nextWaypoint);else this.port.stop();
  }
  private readonly nextWaypoint=():Point|undefined=>{
    const actor=this.port.actor(this.id);if(!actor||this.disposed||!this.canMove(actor))return;
    if(this.pathTargetId&&this.pathTargetId!==this.ownerId){
      const target=this.port.actor(this.pathTargetId);if(!target||!canTargetCombatant(actor,target))return;
    }
    while(this.path.length&&distance(actor.position,this.path[0])<=.5)this.path.shift();
    const next=this.path[0];
    if(next&&!canTraverse(actor.position,next,point=>this.port.canStand(point))){this.path=[];this.nextDecisionAt=this.clock;return;}
    return next;
  };
  private trackRecovery(actor:Combatant,owner:Combatant):void {
    if(!this.canMove(actor)){this.farElapsed=0;this.resetStuck();return;}
    const ownerDistance=distance(actor.position,owner.position);
    this.farElapsed=ownerDistance>FRIENDLY_SUMMON_AI.farRecallPx?this.farElapsed+LOGIC_FRAME_MS:0;
    const following=this.returning||(!this.targetId&&this.followActive);
    // 贴身的正常待机不该反复清零计时；但主人就在 64px 内、召唤物却被地形隔开时，
    // 它同样需要走一次召回，否则会一直停在墙的另一侧。
    const blockedPath=this.followUnreachable||(this.pathTargetId===owner.id&&this.path.length>0);
    if(!following||this.combatController.actionState()!=='idle'||(ownerDistance<=FRIENDLY_SUMMON_AI.returnStopPx&&!blockedPath)){this.resetStuck();return;}
    if(!this.progressOrigin)this.progressOrigin={...actor.position};
    if(this.followDestination&&distance(this.followDestination,owner.position)>=FRIENDLY_SUMMON_AI.destinationChangePx){
      this.resetStuck();this.followDestination={...owner.position};this.nextFollowSearchAt=this.clock;
    }
    if(this.progressOrigin&&distance(this.progressOrigin,actor.position)>=FRIENDLY_SUMMON_AI.progressPx){
      this.stuckElapsed=0;this.progressOrigin={...actor.position};this.followUnreachable=false;this.nextFollowSearchAt=this.clock;
    }else if(this.followUnreachable||this.pathTargetId===owner.id&&this.path.length>0)this.stuckElapsed+=LOGIC_FRAME_MS;
    if(this.search&&!this.path.length)return;
    if(this.farElapsed<FRIENDLY_SUMMON_AI.recallDelayMs&&this.stuckElapsed<FRIENDLY_SUMMON_AI.recallDelayMs)return;
    if(this.clock<this.nextRecallAt)return;
    this.nextRecallAt=this.clock+FRIENDLY_SUMMON_AI.decisionMs;
    if(this.port.tryRecall()){
      this.dropTarget();this.clearSearch();this.clearPath();this.returning=false;this.followActive=false;this.state='idle';
      this.farElapsed=0;this.resetStuck();this.nextDecisionAt=this.clock;
    }
  }
  private resetStuck():void {this.stuckElapsed=0;this.progressOrigin=undefined;this.followUnreachable=false;}
  private dropTarget():void {
    this.targetId=undefined;this.clearPath();
    if(this.combatController.actionState()==='approaching')this.combatController.cancel(false);
    else this.combatController.clearSelection();
  }
  private clearPath():void {this.path=[];this.pathTargetId=undefined;this.pathDestination=undefined;this.port.stop();}
  private clearSearch():void {this.search=undefined;this.readyChoice=undefined;}
}

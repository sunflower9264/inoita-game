import { rectDistance } from './rect-distance.ts';
import { PartyFollow } from './party-follow.ts';
import { LOGIC_FRAME_MS } from './battle.ts';
import { attackDistance, targetDistance } from './basic-attack.ts';
import { CombatController, canTargetCombatant, type Combatant } from './combat.ts';
import { combatStateCapabilities } from './combat-state.ts';
import { choosePartyAction } from './party-tactics.ts';
import type { PartyPort } from './party-port.ts';
import { type CompanionStance } from './party-placement.ts';
import { canTraverse, createPathSearch, PATH_GRID_SIZE } from './pathfinding.ts';
import { attackRangeQueryRadius, quantizedDistanceQueryRadius, type CombatQueryCircle } from './combat-spatial-index.ts';
import type { GameRectangle, Point } from './navigation.ts';

export type { PartyPort } from './party-port.ts';
interface PartyControllerState {
  accumulator:number;
  clock:number;
  nextPathAt:number;
  path:Point[];
  destination?:Point;
  destinationTarget?:string;
  destinationRange?:number;
}

/** 目标点走出 3 格才重算；贴脸 8px 会让跟随者每逻辑帧重开搜索。 */
const PARTY_REPATH_DISTANCE_PX = PATH_GRID_SIZE * 3;
/** 两次重算之间的最短间隔。 */
const PARTY_REPATH_INTERVAL_MS = 180;
/** 场景中的每名队友每次只推进一小段搜索，独立运行时沿用原有的单次上限。 */
const PARTY_SEARCH_SLICE = 48;
const STANDALONE_SEARCH_CAP = 384;
/** 不可达后的重试间隔。 */
const PARTY_FAILED_PATH_MS = 600;
/** 追击目标被卡住后，先停一段时间，避免立刻重选同一目标。 */
const PARTY_CHASE_RECOVERY_MS = 1500;
/** 位移超过这个距离才算“还在走”；碰撞抖动不算进展。 */
const PARTY_FOLLOW_PROGRESS_PX = 4;
/** 目标离队长超过这个距离就放弃追击。 */
const PARTY_CHASE_LEASH_PX = 200;
/** 同一目标至少保持这么久，避免来回跳。 */
const PARTY_TARGET_STICKY_MS = 2000;
/** 追击这么久没有位移，就放弃当前目标。 */
const PARTY_CHASE_STUCK_MS = 2000;
/** 两名伙伴的中心距小于这个值就算叠在一起，需要按槽位让开。 */
const PARTY_ALLY_CLEAR_PX = 12;
/** 已经站到目标对应一侧这么远，才算让开到位。 */
const PARTY_FLANK_SIDE_PX = 4;
/** 侧翼锚点走不过去时，先按普通接敌打一阵，避免反复重算。 */
const PARTY_FLANK_RETRY_MS = 2000;
/** 近战/远程分界：攻击距离超过这个值的伙伴站后排。 */
const PARTY_RANGED_RANGE_UNITS = 6;
const TACTIC_INTERVAL_MS = 2 * LOGIC_FRAME_MS;
const RANGE_UNIT_PX = 8;

/** 搜索只能停在起点或地图网格上。侧翼附近没有合法终点时，直接走普通接敌路线。 */
function hasFlankLanding(goal: Point, start: Point, bounds: GameRectangle, canStand: (point: Point) => boolean): boolean {
  if (targetDistance(start, goal) <= PATH_GRID_SIZE && canStand(start)) return true;
  const column = Math.floor((goal.x - bounds.x) / PATH_GRID_SIZE);
  const row = Math.floor((goal.y - bounds.y) / PATH_GRID_SIZE);
  for (let y = row - 1; y <= row + 2; y++) {
    for (let x = column - 1; x <= column + 2; x++) {
      const point = { x: bounds.x + x * PATH_GRID_SIZE, y: bounds.y + y * PATH_GRID_SIZE };
      if (targetDistance(point, goal) <= PATH_GRID_SIZE && canStand(point)) return true;
    }
  }
  return false;
}

/** Party intent is independent of monster awareness and wandering. */
export class PartyController {
  private readonly id:string;
  private readonly port:PartyPort;
  readonly combatController:CombatController;
  private nextTacticsAt=0;
  private tacticsTarget?:string;
  private criticalAlly=false;
  private nextCriticalScanAt=0;
  private accumulator=0;
  private clock=0;
  private nextPathAt=0;
  private path:Point[]=[];
  /** 跨帧推进的寻路搜索；每帧只领一段预算，不能在预算用完时丢掉重来。 */
  private search?:ReturnType<typeof createPathSearch>;
  /** 当前搜索是否在找战斗侧翼锚点；找不到时退回普通的攻击范围目标。 */
  private flanking=false;
  /** 侧翼锚点不可达后的冷静期，期间只按普通攻击范围接敌。 */
  private flankFailedUntil=0;
  /** 追击敌人时的最近一次真实位移；和队长跟随分开记录。 */
  private chaseProgress?:{targetId:string;position:Point;since:number};
  private chaseRecoveryUntil=0;
  /** 当前目标；只来自软集火或正在打队友的敌人。 */
  private targetId?:string;
  private targetSince=0;
  private destination?:Point;
  private destinationTarget?:string;
  private destinationRange?:number;
  /** 同一逻辑帧内候选者数组身份不变，队伍 ID 集合可以复用。 */
  private partyIdsCache?:{source:readonly Combatant[];team:string;value:ReadonlySet<string>};
  private disposed=false;
  readonly follower:PartyFollow;
  constructor(id:string,port:PartyPort,combat:CombatController){
    this.id=id;this.port=port;this.combatController=combat;this.follower=new PartyFollow(id,port);
  }
  /** 只读动作阶段；不需要冷却快照时用这个。 */
  actionState(){return this.combatController.actionState();}
  selectedTargetId(){return this.combatController.selectedTargetId();}
  captureState():PartyControllerState {
    return {accumulator:this.accumulator,clock:this.clock,nextPathAt:this.nextPathAt,
      path:this.path.map(point=>({...point})),destination:this.destination?{...this.destination}:this.follower.destination,
      destinationTarget:this.destinationTarget??this.follower.leader,destinationRange:this.destinationRange};
  }
  restoreState(state:PartyControllerState):void {
    this.accumulator=state.accumulator;this.clock=state.clock;this.nextPathAt=state.nextPathAt;
    this.path=state.path.map(point=>({...point}));this.destination=state.destination?{...state.destination}:undefined;
    this.destinationTarget=state.destinationTarget;this.destinationRange=state.destinationRange;
    // 搜索持有的是旧场地的闭包，读档后必须重新开始。
    this.search=undefined;this.follower.reset();
    this.chaseProgress=undefined;this.chaseRecoveryUntil=0;this.targetId=undefined;this.targetSince=0;
    this.flankFailedUntil=0;this.resetTactics();
  }
  targetRemoved(targetId:string):void {
    this.combatController.targetRemoved(targetId);
    if(this.targetId===targetId){this.targetId=undefined;this.chaseProgress=undefined;}
    if(this.destinationTarget!==targetId)return;
    this.clearRoute();
  }
  private resetTactics():void {
    this.nextTacticsAt=0;this.tacticsTarget=undefined;this.criticalAlly=false;this.nextCriticalScanAt=0;
    this.nextRetreatAt=0;this.retreatTarget=undefined;this.failedRescue=undefined;
  }
  cancel():void {this.resetTactics();this.follower.reset();this.combatController.cancel(true);this.clearRoute();this.targetId=undefined;this.chaseProgress=undefined;
    this.chaseRecoveryUntil=0;this.flankFailedUntil=0;this.accumulator=0;}
  disable():void {this.cancel();}
  reset():void {this.cancel();this.combatController.reset();}
  dispose():void {this.cancel();this.disposed=true;this.combatController.dispose();}
  update(deltaMs:number):void {
    if(this.disposed||!Number.isFinite(deltaMs)||deltaMs<=0)return;
    this.accumulator+=deltaMs;
    while(this.accumulator>=LOGIC_FRAME_MS){this.accumulator-=LOGIC_FRAME_MS;this.step();}
  }
  /** 宿主按共有逻辑帧派发，寻路时间每次只推进一步。 */
  step():void {
    if(this.disposed)return;
    this.clock+=LOGIC_FRAME_MS;this.tick();
  }
  private tick():void {
    const actor=this.port.actor(this.id);
    if(!actor){this.port.stop();return;}
    const leader=this.port.leader();
    const returning=leader?this.follower.tick(actor,leader,LOGIC_FRAME_MS):false;
    const critical=this.port.hasCriticalAlly?.()??false;
    const becameCritical=critical&&!this.criticalAlly;
    this.criticalAlly=critical;
    if(becameCritical)this.nextCriticalScanAt=0;
    if(returning&&this.combatController.actionState()==='approaching')this.combatController.cancel(true);
    this.combatController.update();
    if(!combatStateCapabilities(actor.states??[]).canAct){
      this.clearRoute();this.follower.suspend();return;
    }
    const actionState=this.combatController.actionState();
    if(actionState==='approaching'){
      this.trackChaseProgress(actor,this.combatController.selectedTargetId()??'approach');
      return;
    }
    if(actionState!=='idle'){this.follower.suspend();return;}
    if(returning){this.targetId=undefined;this.clearRoute();this.follow(actor);return;}
    const target=this.selectTarget(actor);
    if(this.port.inCombat()){
      const rescuing=this.destinationTarget && this.port.actor(this.destinationTarget)?.team===actor.team;
      if(this.clock>=this.nextTacticsAt || target?.id!==this.tacticsTarget || rescuing || becameCritical){
        this.nextTacticsAt=this.clock+TACTIC_INTERVAL_MS;
        this.tacticsTarget=target?.id;
        const action=choosePartyAction(actor,target,this.port,this.combatController);
        if(action && 'rescue' in action && this.approachForRescue(actor,action.rescue,action.range))return;
        if(action && 'skill' in action){
          if(!action.urgent && this.retreatFromThreat(actor,target))return;
          if(this.combatController.request(action.skill,action.targetId)==='started'){
            this.clearRoute(false);this.nextTacticsAt=0;return;
          }
        }
      }else if(target && attackDistance(actor.position,actor.bounds,target.position,target.bounds)<=this.port.attackRange()){
        // 下一次战术判断前保留当前移动，避免普攻抢占刚进入射程的技能。
        return;
      }
      if(this.retreatFromThreat(actor,target))return;
    }
    if(target){this.chase(actor,target);return;}
    this.chaseProgress=undefined;
    this.follow(actor);
  }
  /** 软集火优先；否则保留黏性目标，再看正在打队友的敌人。附近没交战的敌人不主动接。 */
  private selectTarget(actor:Combatant):Combatant|undefined {
    const leader=this.port.leader();
    const focused=this.focusedTarget(actor,leader);
    if(focused)return focused;
    if(this.clock<this.chaseRecoveryUntil){this.targetId=undefined;return undefined;}
    const current=this.targetId?this.port.actor(this.targetId):undefined;
    const retained=current&&this.validTarget(actor,current)&&this.withinLeash(actor,current,leader)?current:undefined;
    if(this.criticalAlly){
      if(this.clock<this.nextCriticalScanAt){
        if(!retained)this.targetId=undefined;
        return retained;
      }
      this.nextCriticalScanAt=this.clock+TACTIC_INTERVAL_MS;
    }else if(retained&&this.clock-this.targetSince<PARTY_TARGET_STICKY_MS)return retained;
    const threat=this.nearestThreatTarget(actor,leader);
    if(threat)return this.rememberTarget(threat);
    if(this.criticalAlly&&retained)return retained;
    this.targetId=undefined;return undefined;
  }
  private focusedTarget(actor:Combatant,leader:Combatant|undefined):Combatant|undefined {
    for(const id of [this.port.focusTarget(),this.port.partyTarget?.()]){
      const target=id?this.port.actor(id):undefined;
      if(target&&this.validTarget(actor,target)&&this.withinLeash(actor,target,leader))return this.rememberTarget(target);
    }
    return undefined;
  }
  private validTarget(actor:Combatant,target:Combatant):boolean {
    return target.team!==actor.team&&canTargetCombatant(actor,target);
  }
  private withinLeash(actor:Combatant,target:Combatant,leader:Combatant|undefined):boolean {
    if(!leader)return true;
    if(attackDistance(actor.position,actor.bounds,target.position,target.bounds)<=this.port.attackRange())return true;
    return targetDistance(target.position,leader.position)<=PARTY_CHASE_LEASH_PX;
  }
  /**
   * withinLeash 的两种接受方式各对应一个圆：自身攻击距离、队长周围追击范围。
   * 两圆的并集覆盖全部可接受敌人；没有队长时 withinLeash 不做距离限制，必须回退全量。
   */
  private threatCandidates(actor:Combatant,leader:Combatant|undefined,full:readonly Combatant[]):readonly Combatant[] {
    const nearby=this.port.nearbyCandidates;
    if(!leader||!nearby)return full;
    const circles:CombatQueryCircle[]=[
      {x:actor.position.x,y:actor.position.y,radius:attackRangeQueryRadius(this.port.attackRange(),actor.bounds)},
      {x:leader.position.x,y:leader.position.y,radius:quantizedDistanceQueryRadius(PARTY_CHASE_LEASH_PX)},
    ];
    return nearby(circles);
  }
  private rememberTarget(target:Combatant):Combatant {
    if(this.targetId!==target.id){this.targetId=target.id;this.chaseProgress=undefined;}
    this.targetSince=this.clock;return target;
  }
  /** 正在攻击玩家或队友的敌人；没有 targetOf 数据时退回最近敌人。 */
  private nearestThreatTarget(actor:Combatant,leader:Combatant|undefined):Combatant|undefined {
    const targetOf=this.port.targetOf;
    if(!targetOf)return undefined;
    // 队伍 ID 必须从完整候选收集：远处队友也可能正被这名敌人攻击。
    // 敌人本身按 withinLeash 的联合圆预筛，随后仍走原来的阵营、可选中和 leash 过滤。
    const candidates=this.port.candidates(),partyIds=this.partyIds(candidates,actor.team);
    let best:Combatant|undefined,bestDistance=Infinity,protecting=false;
    for(const candidate of this.threatCandidates(actor,leader,candidates)){
      if(candidate.team===actor.team||!canTargetCombatant(actor,candidate))continue;
      const targetId=targetOf(candidate.id);
      if(!targetId||!partyIds.has(targetId))continue;
      if(!this.withinLeash(actor,candidate,leader))continue;
      const distance=targetDistance(actor.position,candidate.position);
      const victim=this.port.vitals(targetId);
      const urgent=!!victim&&victim.health>0&&victim.health<=victim.maxHealth*0.35;
      if((urgent&&!protecting)||(urgent===protecting&&distance<bestDistance)){
        best=candidate;bestDistance=distance;protecting=urgent;
      }
    }
    return best;
  }
  /** 同一逻辑帧的候选者数组身份不变；队伍 ID 集合只随成员变化重建。 */
  private partyIds(candidates:readonly Combatant[],team:string):ReadonlySet<string> {
    const cached=this.partyIdsCache;
    if(cached?.source===candidates&&cached.team===team)return cached.value;
    const value=new Set<string>();
    for(const candidate of candidates)if(candidate.team===team)value.add(candidate.id);
    this.partyIdsCache={source:candidates,team,value};
    return value;
  }

  private failedRescue?:{ally:string;until:number};
  private retreatTarget?:string;
  private nextRetreatAt=0;
  /** 走到治疗边界即可施放；绕墙时沿用同一份分帧寻路预算。 */
  private approachForRescue(actor:Combatant,ally:Combatant,range:number):boolean {
    const leader=this.port.leader();
    if(!combatStateCapabilities(actor.states??[]).canMove || rectDistance(actor,ally)+2<=range
      || (leader && targetDistance(ally.position,leader.position)>PARTY_CHASE_LEASH_PX)
      || (this.failedRescue?.ally===ally.id && this.clock<this.failedRescue.until))return false;
    this.followToTarget(actor,ally,range);
    return this.failedRescue?.ally!==ally.id || this.clock>=this.failedRescue.until;
  }
  /** 后排只尝试能立即走通的短撤步。走廊无安全落点时可在这一帧还击。 */
  private retreatFromThreat(actor:Combatant,target:Combatant|undefined):boolean {
    const range=this.port.attackRange();
    if(!target||range<=PARTY_RANGED_RANGE_UNITS||!combatStateCapabilities(actor.states??[]).canAutoApproach)return false;
    if(this.retreatTarget){
      const next=this.nextWaypoint();
      if(this.retreatTarget===target.id&&next&&attackDistance(next,actor.bounds,target.position,target.bounds)<=range){
        this.port.followPath(this.nextWaypoint);return true;
      }
      this.clearRoute();
      return false;
    }
    if(this.clock<this.nextRetreatAt)return false;
    const candidates=this.port.nearbyCandidates?.([{...actor.position,radius:attackRangeQueryRadius(4,actor.bounds)}])??this.port.candidates();
    const threats=candidates.filter(enemy=>enemy.team!==actor.team && this.port.targetOf?.(enemy.id)===actor.id
      && canTargetCombatant(actor,enemy) && attackDistance(actor.position,actor.bounds,enemy.position,enemy.bounds)<=4);
    if(!threats.length)return false;
    this.nextRetreatAt=this.clock+PARTY_FAILED_PATH_MS;
    const leader=this.port.leader();
    let goal:Point|undefined,best=Infinity;
    // 两到六个地形格内寻找仍能射击且离队长较近的一步。每段都检查墙角和实际占位。
    for(const distance of [24,40,48]){
      for(let direction=0;direction<8;direction++){
        const angle=direction*Math.PI/4;
        const dx=Math.round(distance*Math.cos(angle)),dy=Math.round(distance*Math.sin(angle));
        const point={x:actor.position.x+dx,y:actor.position.y+dy};
        if(attackDistance(point,actor.bounds,target.position,target.bounds)>range)continue;
        if(threats.some(enemy=>attackDistance(point,actor.bounds,enemy.position,enemy.bounds)<=4
          || dx*(actor.position.x-enemy.position.x)+dy*(actor.position.y-enemy.position.y)<0))continue;
        const leaderDistance=leader?targetDistance(point,leader.position):0;
        if(leaderDistance>PARTY_CHASE_LEASH_PX)continue;
        const score=leaderDistance+distance/4;
        if(score>=best||!canTraverse(actor.position,point,p=>this.port.canStand(p)))continue;
        best=score;goal=point;
      }
    }
    if(!goal)return false;
    this.clearRoute();
    this.path=[goal];this.destination=goal;this.destinationTarget=target.id;this.retreatTarget=target.id;
    this.port.followPath(this.nextWaypoint);return true;
  }
  private chase(actor:Combatant,target:Combatant):void {
    const range=this.port.attackRange();
    if(attackDistance(actor.position,actor.bounds,target.position,target.bounds)<=range&&!this.needsFlank(actor,target)){
      this.chaseProgress=undefined;this.clearRoute();
      this.combatController.requestTarget(target.id);return;
    }
    const leader=this.port.leader();
    if(!this.withinLeash(actor,target,leader)){
      this.targetId=undefined;this.clearRoute();this.follow(actor);return;
    }
    if(this.trackChaseProgress(actor,target.id))return;
    this.followToTarget(actor,target,range);
  }
  /**
   * 追击已有目标时还没到自己的一侧；两名伙伴挤在同一点就按槽位绕开。
   * 只有真的叠在一起才让位，单独一名佣兵不会为了站位绕圈。
   */
  private needsFlank(actor:Combatant,target:Combatant):boolean {
    if(this.clock<this.flankFailedUntil)return false;
    const leaderId=this.port.leader()?.id;
    // 判断是否和队友挤在一起属于协同扫描，保留完整队伍，避免附近查询改变让位结果。
    const crowded=this.port.candidates().some(other=>other.id!==actor.id&&other.id!==leaderId
      &&other.team===actor.team&&targetDistance(other.position,actor.position)<PARTY_ALLY_CLEAR_PX);
    if(!crowded)return false;
    const anchor=this.combatAnchor(actor,target);
    return !!anchor&&!this.onAssignedSide(actor,target,anchor);
  }
  /**
   * 战斗侧翼锚点：以队长到目标的连线为轴，上阵槽位 0 站一侧、槽位 1 站另一侧。
   * 同时包住目标和队员后，两名伙伴的落点会分开，不会在攻击距离边缘挤成一点。
   */
  private combatAnchor(actor:Combatant,target:Combatant):{point:Point;side:1|-1;normal:Point}|undefined {
    const slot=this.port.followSlot?.();
    if(slot===undefined)return undefined;
    const origin=this.port.leader()??actor;
    let dx=target.position.x-origin.position.x,dy=target.position.y-origin.position.y;
    if(Math.hypot(dx,dy)<8){
      dx=target.position.x-actor.position.x;dy=target.position.y-actor.position.y;
    }
    const length=Math.hypot(dx,dy);
    if(length<.5)return undefined;
    const normal={x:-dy/length,y:dx/length};
    const side:1|-1=slot===1?1:-1;
    // 锚点必须落在攻击距离内，否则走到锚点也打不到，会在目标外侧停住。
    // 从偏外的位置往回收，取仍能攻击的最远点，两名伙伴的间距因此尽量大。
    const range=this.port.attackRange();
    const pointAt=(radius:number)=>({x:target.position.x+normal.x*radius*side,
      y:target.position.y+normal.y*radius*side});
    let radius=Math.max(24,range*RANGE_UNIT_PX+8);
    while(radius>16&&attackDistance(pointAt(radius),actor.bounds,target.position,target.bounds)>range)radius-=4;
    if(attackDistance(pointAt(radius),actor.bounds,target.position,target.bounds)>range)return undefined;
    return {side,normal,point:pointAt(radius)};
  }
  private onAssignedSide(actor:Combatant,target:Combatant,
    anchor:{side:1|-1;normal:Point}):boolean {
    const dx=actor.position.x-target.position.x,dy=actor.position.y-target.position.y;
    return (dx*anchor.normal.x+dy*anchor.normal.y)*anchor.side>PARTY_FLANK_SIDE_PX;
  }
  /** 追击或自动接近时，连续一段时间没有真实位移就放弃当前目标。 */
  private trackChaseProgress(actor:Combatant,targetId:string):boolean {
    if(!this.port.regroup||this.clock<this.chaseRecoveryUntil)return false;
    if(this.search)return false;
    const previous=this.chaseProgress;
    if(!previous||previous.targetId!==targetId){
      this.chaseProgress={targetId,position:{...actor.position},since:this.clock};
      return false;
    }
    if(Math.hypot(actor.position.x-previous.position.x,actor.position.y-previous.position.y)>=PARTY_FOLLOW_PROGRESS_PX){
      previous.position={...actor.position};previous.since=this.clock;return false;
    }
    if(this.clock-previous.since<PARTY_CHASE_STUCK_MS)return false;
    this.chaseProgress=undefined;this.targetId=undefined;this.clearRoute();
    this.combatController.cancel(true);this.port.stop();
    this.chaseRecoveryUntil=this.clock+PARTY_CHASE_RECOVERY_MS;
    return true;
  }
  /** 没目标时回到职责站位：前排侧前，后排后方，辅助更靠后。 */
  private follow(actor:Combatant):void {
    const leader=this.port.leader();
    if(!leader||leader.id===actor.id){this.clearRoute();return;}
    if(!combatStateCapabilities(actor.states??[]).canMove){this.follower.suspend();this.port.stop();return;}
    if(this.destinationTarget)this.clearRoute(false);
    this.follower.move(actor,leader,this.stance(),LOGIC_FRAME_MS);
  }
  private hasHealingSkill():boolean {
    return this.port.skills().some(skill=>skill.frequency!==0 && this.port.skillUses(skill.id).includes('heal'));
  }
  private stance():CompanionStance {
    if(this.hasHealingSkill())return 'support';
    return this.port.attackRange()>PARTY_RANGED_RANGE_UNITS?'back':'front';
  }
  private followToTarget(actor:Combatant,target:Combatant,range:number):void {
    if(this.destinationTarget!==target.id||this.destinationRange!==range){
      this.clearRoute();this.destinationTarget=target.id;this.destinationRange=range;
    }
    this.followDestination(actor,target.position,range,target);
  }
  private followDestination(actor:Combatant,destination:Point,range:number,target?:Combatant):void {
    if(this.search)this.advanceSearch(actor);
    else if(this.clock>=this.nextPathAt&&(!this.destination
      ||targetDistance(this.destination,destination)>=PARTY_REPATH_DISTANCE_PX
      ||!this.path.length||!this.nextWaypoint())){
      if(!this.directPursuit(actor,destination,target)){
        const granted=this.port.pathBudget?.take(this.id,PARTY_SEARCH_SLICE)??STANDALONE_SEARCH_CAP;
        if(granted>0)this.beginSearch(actor,destination,range,granted,target);
        else this.nextPathAt=this.clock+LOGIC_FRAME_MS;
      }
    }
    const next=this.nextWaypoint();
    if(next)this.port.followPath(this.nextWaypoint);else this.port.stop();
  }
  /** 直线能到落点时不领寻路预算；需要绕到侧翼或前方有墙时仍走 A*。 */
  private directPursuit(actor:Combatant,destination:Point,target?:Combatant):boolean {
    if(target&&target.team!==actor.team&&this.combatAnchor(actor,target))return false;
    const goal=this.directGoal(actor,destination,target);
    if(!canTraverse(actor.position,goal,point=>this.port.canStand(point)))return false;
    // 路径终点停在目标身体前；destination 仍记完整目标位置，用于下一次重算距离。
    this.path=[{...goal}];this.destination={...destination};this.flanking=false;
    this.nextPathAt=this.clock+PARTY_REPATH_INTERVAL_MS;
    return true;
  }
  /** 直线检查停在目标身体前，避免把目标自己的占位当成墙。 */
  private directGoal(actor:Combatant,destination:Point,target?:Combatant):Point {
    if(!target)return destination;
    const dx=destination.x-actor.position.x,dy=destination.y-actor.position.y,length=Math.hypot(dx,dy);
    if(target.team===actor.team && this.destinationRange!==undefined){
      // 沿直线找到第一个正式治疗能够命中的位置，避免走进队友的碰撞体。
      const steps=Math.max(1,Math.ceil(length/4));
      for(let i=1;i<=steps;i++){
        const point={x:actor.position.x+dx*i/steps,y:actor.position.y+dy*i/steps};
        if(rectDistance({position:point,bounds:actor.bounds},target)+2<=this.destinationRange)return point;
      }
    }
    const stop=Math.max(8,Math.hypot(target.bounds.width,target.bounds.height)/2+8);
    const remaining=length-stop;
    return remaining<=0?{...actor.position}:{x:actor.position.x+dx/length*remaining,y:actor.position.y+dy/length*remaining};
  }
  private beginSearch(actor:Combatant,destination:Point,range:number,granted:number,
    target?:Combatant,flank=true):void {
    this.nextPathAt=this.clock+PARTY_REPATH_INTERVAL_MS;this.destination={...destination};
    const snapshot=this.port.navigationSnapshot?.();
    const canStand=snapshot?(point:Point)=>snapshot.canStand(point):(point:Point)=>this.port.canStand(point);
    const bounds=snapshot?.bounds??this.port.navigationBounds();
    let anchor=target&&target.team!==actor.team&&flank&&this.clock>=this.flankFailedUntil?this.combatAnchor(actor,target):undefined;
    if(anchor&&!hasFlankLanding(anchor.point,actor.position,bounds,canStand)){
      this.flankFailedUntil=this.clock+PARTY_FLANK_RETRY_MS;
      anchor=undefined;
    }
    this.flanking=!!anchor;
    // 绕侧时搜索的是具体站位。朝敌人中心搜索并减去整个攻击半径，会白查身体另一侧的格子。
    const goal=anchor?.point??destination;
    const inRange=target&&!anchor;
    const radius=inRange?Math.hypot(actor.bounds.width+target.bounds.width,actor.bounds.height+target.bounds.height)+range*RANGE_UNIT_PX
      :PATH_GRID_SIZE;
    this.search=createPathSearch(actor.position,{bounds,canStand,canStandXY:snapshot?.canStandXY,
      isGoal:point=>(inRange?(target.team===actor.team?rectDistance({position:point,bounds:actor.bounds},target)+2
        :attackDistance(point,actor.bounds,target.position,target.bounds))<=range
        :targetDistance(point,goal)<=PATH_GRID_SIZE)&&canStand(point),
      heuristic:point=>Math.max(0,targetDistance(point,goal)-radius)});
    this.stepSearch(actor,granted);
  }
  private advanceSearch(actor:Combatant):void {
    const granted=this.port.pathBudget?.take(this.id,PARTY_SEARCH_SLICE)??STANDALONE_SEARCH_CAP;
    if(granted>0)this.stepSearch(actor,granted);
  }
  private stepSearch(actor:Combatant,granted:number):void {
    const search=this.search;if(!search)return;
    const result=search.step(granted);
    if(result.status==='pending')return;
    this.search=undefined;
    if(result.status==='unreachable'){
      this.path=[];
      // 侧翼锚点可能落在墙里或目标背后过不去：退回普通攻击范围目标，不能因此站着不动。
      const target=this.destinationTarget?this.port.actor(this.destinationTarget):undefined;
      const destination=this.destination,range=this.destinationRange;
      if(target?.team===actor.team)this.failedRescue={ally:target.id,until:this.clock+PARTY_FAILED_PATH_MS};
      if(this.flanking&&target&&destination&&range!==undefined){
        this.flanking=false;
        this.flankFailedUntil=this.clock+PARTY_FLANK_RETRY_MS;
        // 这一帧的预算已经花在失败的侧翼搜索上；普通退路从下一帧继续领预算。
        this.beginSearch(actor,destination,range,0,target,false);
        return;
      }
      this.flanking=false;
      this.nextPathAt=this.clock+PARTY_FAILED_PATH_MS;return;
    }
    // 搜索跨了几帧，角色可能被其他系统挪过；从离当前位置最近的点继续。
    let start=0,nearest=Infinity;
    for(let index=0;index<result.path.length;index++){
      const point=result.path[index]!,distance=Math.hypot(point.x-actor.position.x,point.y-actor.position.y);
      if(distance>=nearest)break;
      start=index;nearest=distance;
    }
    this.path=result.path.slice(start);
  }
  private readonly nextWaypoint=():Point|undefined => {
    const actor=this.port.actor(this.id);if(!actor||this.disposed)return;
    const target=this.destinationTarget?this.port.actor(this.destinationTarget):undefined;
    const capabilities=combatStateCapabilities(actor.states??[]);
    if(!capabilities.canMove||(target&&actor.team!==target.team&&(!capabilities.canAutoApproach||!canTargetCombatant(actor,target))))return;
    while(this.path.length){
      const point=this.path[0];
      if(Math.hypot(actor.position.x-point.x,actor.position.y-point.y)>.5)break;
      const following=this.path[1];
      if(following&&!canTraverse(actor.position,following,point=>this.port.canStand(point)))break;
      this.path.shift();
    }
    const next=this.path[0];return next&&canTraverse(actor.position,next,point=>this.port.canStand(point))?next:undefined;
  };
  private clearRoute(stop=true):void {
    this.retreatTarget=undefined;
    this.path=[];this.search=undefined;this.flanking=false;this.destination=undefined;
    this.destinationTarget=undefined;this.destinationRange=undefined;this.nextPathAt=0;
    if(stop)this.port.stop();
  }
}

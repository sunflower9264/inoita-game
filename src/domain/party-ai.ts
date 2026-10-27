import { LOGIC_FRAME_MS, type EnemyPlayableSkill } from './battle.ts';
import { attackDistance, targetDistance } from './basic-attack.ts';
import { CombatController, canTargetCombatant, type AttackContact, type Combatant, type CombatPort } from './combat.ts';
import { combatStateCapabilities } from './combat-state.ts';
import { needsTarget } from './skill-action.ts';
import { canTraverse, createPathSearch, PATH_GRID_SIZE } from './pathfinding.ts';
import type { GameRectangle, Point } from './navigation.ts';

export type PartySkillKind = 'chance' | 'combat-chance' | 'heal' | 'ally-combat' | 'emergency-heal';
export interface PartyPort extends CombatPort {
  leader(): Combatant | undefined;
  focusTarget(): string | undefined;
  /** 主操作角色当前的战斗目标；队伍联动时让佣兵攻击同一个敌人。 */
  partyTarget?(): string | undefined;
  /** 整个队伍是否已进入战斗：有指派目标，或最近和敌人真实交战过。 */
  inCombat(): boolean;
  counterattack(): CounterattackMode;
  /** 该成员当前承受的连续受击次数，供延迟档判定。 */
  damageCount(): number;
  navigationBounds(): GameRectangle;
  /** 每渲染帧共享的寻路扩展预算；缺省时按单次上限同步搜索（测试与无场景调用）。 */
  pathBudget?:{take(limit:number):number};
  followPath(next: () => Point | undefined): void;
  /** 跟随队长时长时间没有位移，让宿主把佣兵收拢到队长身边；无场景调用可省略。 */
  regroup?(): void;
  skills(): readonly EnemyPlayableSkill[];
  skillKind(id:string): PartySkillKind | undefined;
  vitals(id:string): {health:number;maxHealth:number} | undefined;
  attacking(id:string): boolean;
  attackRange():number;
}
interface PartyControllerState {
  retaliation?:string;
  accumulator:number;
  clock:number;
  nextPathAt:number;
  path:Point[];
  destination?:Point;
  destinationTarget?:string;
  destinationRange?:number;
}

/** 跟随距离按双方碰撞矩形之间的间隔计算，每个距离单位为八个地图像素。
 *  同队单位之间不碰撞，这个间隔负责让他们不贴脸、也不和玩家挤在同一点上。 */
const PARTY_FOLLOW_DISTANCE_UNITS = 4;
/** 队长走出 3 格才重算；贴脸 8px 会让跟随者每逻辑帧重开搜索。 */
const PARTY_REPATH_DISTANCE_PX = PATH_GRID_SIZE * 3;
/** 两次重算之间的最短间隔。 */
const PARTY_REPATH_INTERVAL_MS = 180;
/** 跟随是一次性同步搜索的上限；预算不足时下一帧再试。 */
const PARTY_SEARCH_CAP = 384;
/** 不可达后的重试间隔。 */
const PARTY_FAILED_PATH_MS = 600;
/** 跟随这么久没有任何位移，就当作被地形或人群卡住，不再干等寻路。 */
const PARTY_FOLLOW_STUCK_MS = 1500;
/** 位移超过这个距离才算“还在走”；碰撞抖动不算进展。 */
const PARTY_FOLLOW_PROGRESS_PX = 4;
/** 离队长还有这么远才值得收拢；贴身的轻微卡顿继续走寻路恢复。 */
const PARTY_REGROUP_DISTANCE_PX = 48;

/** 原版自动反击档位：0 未启用、1 延迟、2 启用。 */
export type CounterattackMode = 0 | 1 | 2;
export const COUNTERATTACK_MODES: readonly CounterattackMode[] = [0, 1, 2];

/** 延迟档在原版里要等到连续受击满三次才转入战斗。 */
export const DELAYED_COUNTERATTACK_HITS = 3;

/** 反击只按进入战斗的那一刻判定；进入后不因计数变化退出。 */
export function counterattackReady(mode: CounterattackMode, damageCount: number): boolean {
  return mode === 2 || (mode === 1 && damageCount >= DELAYED_COUNTERATTACK_HITS);
}

/** 自动施法抽取 1 至 99 的整数，严格小于阈值时通过。 */
export function partySkillThreshold(kind:PartySkillKind,frequency:number,following:boolean):number {
  const high=frequency===2;
  if(kind==='chance')return high?100:30;
  if(kind==='combat-chance')return following?(high?100:50):(high?50:30);
  if(kind==='heal')return high?70:50;
  if(kind==='emergency-heal')return high?40:20;
  return high?80:60;
}

/** Party intent is independent of monster awareness and wandering. */
export class PartyController {
  private readonly id:string;
  private readonly port:PartyPort;
  readonly combatController:CombatController;
  private readonly random:()=>number;
  private retaliation?:string;
  private accumulator=0;
  private clock=0;
  private nextPathAt=0;
  private path:Point[]=[];
  /** 跨帧推进的寻路搜索；每帧只领一段预算，不能在预算用完时丢掉重来。 */
  private search?:ReturnType<typeof createPathSearch>;
  /** 旧路线第一步失效时立刻重算，但别每个逻辑帧都重开搜索。 */
  private pathRetryAt=0;
  /** 跟随队长时的最近一次真实位移，用来判断是不是一直站着。 */
  private followProgress?:Point;
  private followProgressAt=0;
  private destination?:Point;
  private destinationTarget?:string;
  private destinationRange?:number;
  private disposed=false;
  constructor(id:string,port:PartyPort,combat:CombatController,random= Math.random){
    this.id=id;this.port=port;this.combatController=combat;this.random=random;
  }
  snapshot(){return this.combatController.snapshot();}
  /** 只读动作阶段；不需要冷却快照时用这个。 */
  actionState(){return this.combatController.actionState();}
  selectedTargetId(){return this.combatController.selectedTargetId();}
  captureState():PartyControllerState {
    return {retaliation:this.retaliation,accumulator:this.accumulator,clock:this.clock,nextPathAt:this.nextPathAt,
      path:this.path.map(point=>({...point})),destination:this.destination?{...this.destination}:undefined,
      destinationTarget:this.destinationTarget,destinationRange:this.destinationRange};
  }
  restoreState(state:PartyControllerState):void {
    this.retaliation=state.retaliation;this.accumulator=state.accumulator;this.clock=state.clock;this.nextPathAt=state.nextPathAt;
    this.path=state.path.map(point=>({...point}));this.destination=state.destination?{...state.destination}:undefined;
    this.destinationTarget=state.destinationTarget;this.destinationRange=state.destinationRange;
    // 搜索持有的是旧场地的闭包，读档后必须重新开始。
    this.search=undefined;this.pathRetryAt=0;this.followProgress=undefined;this.followProgressAt=0;
  }
  onContact(event:AttackContact):void {
    if(this.disposed||event.targetId!==this.id||!counterattackReady(this.port.counterattack(),this.port.damageCount()))return;
    const actor=this.port.actor(this.id),source=this.port.actor(event.casterId);
    if(actor&&source&&actor.team!==source.team&&canTargetCombatant(actor,source))this.retaliation=source.id;
  }
  targetRemoved(targetId:string):void {
    this.combatController.targetRemoved(targetId);
    if(this.retaliation===targetId)this.retaliation=undefined;
    if(this.destinationTarget!==targetId)return;
    this.path=[];this.search=undefined;this.pathRetryAt=0;this.followProgress=undefined;this.followProgressAt=0;
    this.destination=undefined;this.destinationTarget=undefined;this.destinationRange=undefined;this.nextPathAt=0;this.port.stop();
  }
  cancel():void {this.combatController.cancel(true);this.retaliation=undefined;this.path=[];this.search=undefined;this.pathRetryAt=0;
    this.followProgress=undefined;this.followProgressAt=0;this.destination=undefined;this.destinationTarget=undefined;this.destinationRange=undefined;
    this.nextPathAt=0;this.accumulator=0;this.port.stop();}
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
    const retaliating=this.retaliation?this.port.actor(this.retaliation):undefined;
    if(retaliating&&!canTargetCombatant(actor,retaliating))this.retaliation=undefined;
    if(this.port.counterattack()===0&&this.retaliation){
      this.retaliation=undefined;
      if(!this.port.focusTarget()){
        this.combatController.cancel(true);this.path=[];this.destination=undefined;this.nextPathAt=0;this.port.stop();
      }
    }
    this.combatController.update();
    if(!combatStateCapabilities(actor.states??[]).canAct){this.path=[];this.port.stop();this.followProgress=undefined;this.followProgressAt=0;return;}
    if(this.combatController.actionState()!=='idle')return;
    if(this.port.counterattack()===0)this.retaliation=undefined;
    const inCombat=this.port.inCombat();
    // 优先级：显式集火 > 自己被谁打 > 主操作角色正在打的目标 > 自己上一轮选中的目标。
    const target=this.hostileTarget(actor,[
      this.port.focusTarget(),
      this.retaliation,
      inCombat?this.port.partyTarget?.():undefined,
      inCombat?this.combatController.selectedTargetId():undefined
    ]);
    if(!target)this.retaliation=undefined;
    // 追赶目标或交战时重新计时，脱战后回到队长身边从当前状态重新判断是否卡住。
    if(target||inCombat){this.followProgress=undefined;this.followProgressAt=0;}
    // 队伍未进入战斗时只跟随，不放任何主动技能；召唤物之类的无目标技能也不例外。
    if(inCombat){
      const cooldowns=this.combatController.snapshot().cooldowns;
      for(const skill of this.port.skills()){
        const frequency=skill.frequency??1,kind=this.port.skillKind(skill.id);
        if(!frequency||!kind||cooldowns[skill.id]||!this.combatController.canSelectSkill(skill)||this.port.canSpendMana?.(skill.manaCost??0)===false)continue;
        if(needsTarget(skill.action)&&(!target||attackDistance(actor.position,actor.bounds,target.position,target.bounds)>skill.action.approachDistanceUnits))continue;
        const threshold=partySkillThreshold(kind,frequency,!target);
        let ready=false;
        if(kind==='heal'||kind==='emergency-heal'){
          ready=this.port.candidates().some(ally=>{
            const hp=this.port.vitals(ally.id);
            return ally.team===actor.team&&!!hp&&hp.health>0&&hp.health<Math.trunc(hp.maxHealth*threshold/100)
              &&targetDistance(actor.position,ally.position)<=skill.action.searchRadiusPx;
          });
        }else if(kind==='ally-combat'){
          ready=this.port.candidates().some(ally=>ally.id!==actor.id&&ally.team===actor.team&&this.port.attacking(ally.id)&&this.roll(threshold));
        }else ready=this.roll(threshold);
        if(ready&&this.combatController.request(skill,target?.id)==='started'){this.path=[];return;}
      }
    }
    // 队伍已开战但没有可攻击目标：走和玩家攻击键相同的默认普攻请求，
    // 由 CombatController 自行索敌并接近；下一帧再从 snapshot 取选中的目标。
    if(!target&&inCombat){this.combatController.request(undefined,undefined);return;}
    if(target){
      const range=this.port.attackRange();
      if(attackDistance(actor.position,actor.bounds,target.position,target.bounds)<=range){
        this.path=[];this.combatController.requestTarget(target.id);
      }else this.follow(actor,target,range);
      return;
    }
    const leader=this.port.leader();
    if(!leader||leader.id===actor.id||attackDistance(actor.position,actor.bounds,leader.position,leader.bounds)<PARTY_FOLLOW_DISTANCE_UNITS){
      this.path=[];this.port.stop();this.followProgress=undefined;this.followProgressAt=0;return;
    }
    this.follow(actor,leader,PARTY_FOLLOW_DISTANCE_UNITS-1,true);
  }
  /** 按优先级取第一个仍可攻击的敌对目标；共享目标只在队伍已战斗时参与。 */
  private hostileTarget(actor:Combatant,ids:readonly (string|undefined)[]):Combatant|undefined {
    for(const id of ids){
      const candidate=id?this.port.actor(id):undefined;
      if(candidate&&candidate.team!==actor.team&&canTargetCombatant(actor,candidate))return candidate;
    }
    return undefined;
  }
  private roll(threshold:number):boolean{return 1+Math.floor(this.random()*99)<threshold;}
  private follow(actor:Combatant,leader:Combatant,range:number,regroup=false):void {
    const capabilities=combatStateCapabilities(actor.states??[]);
    if(!capabilities.canMove||(actor.team!==leader.team&&!capabilities.canAutoApproach)){
      this.port.stop();this.followProgress=undefined;this.followProgressAt=0;return;
    }
    if(this.destinationTarget!==leader.id||this.destinationRange!==range){
      this.path=[];this.search=undefined;this.pathRetryAt=0;this.followProgress=undefined;this.followProgressAt=0;
      this.destination=undefined;this.nextPathAt=0;
      this.destinationTarget=leader.id;this.destinationRange=range;
    }
    if(regroup){
      if(this.trackFollowProgress(actor,leader))return;
      // 第一步已经走不通（通常是角色被碰撞挤偏，路线起点对不上了）。
      // 不要等下次固定重算：立刻丢掉旧路线，从当前真实位置重新找路。
      if(!this.search&&this.path.length&&this.clock>=this.pathRetryAt&&!this.nextWaypoint()){
        this.path=[];this.search=undefined;this.nextPathAt=this.clock;
        this.pathRetryAt=this.clock+PARTY_REPATH_INTERVAL_MS;
      }
    } else {this.followProgress=undefined;this.followProgressAt=0;}
    // 搜索跨帧推进：寻路一次算不完时保留现场、下一帧接着算。以前每次重开搜索，
    // 超过单帧预算的长路（远距离或要绕墙）永远算不出来，佣兵就停在原地不跟随。
    if(this.search)this.advanceSearch(actor);
    else if(this.clock>=this.nextPathAt&&(!this.destination
      ||targetDistance(this.destination,leader.position)>=PARTY_REPATH_DISTANCE_PX
      ||!this.path.length||!this.nextWaypoint())){
      // 先领预算再建查询：没有预算的帧连地图边界都不该读。
      const granted=this.port.pathBudget?.take(PARTY_SEARCH_CAP)??PARTY_SEARCH_CAP;
      if(granted>0)this.beginSearch(actor,leader,range,granted);
      else this.nextPathAt=this.clock+LOGIC_FRAME_MS;
    }
    if(this.nextWaypoint())this.port.followPath(this.nextWaypoint);else this.port.stop();
  }
  /**
   * 跟随队长时的掉队保护：连续一段时间一步没挪，就不再继续等寻路结果，
   * 让宿主把佣兵放到队长旁边的合法落点。走不通的路线可以重算，但人不能永远留在原地。
   */
  private trackFollowProgress(actor:Combatant,leader:Combatant):boolean {
    if(!this.port.regroup)return false;
    const previous=this.followProgress;
    if(!previous||Math.hypot(actor.position.x-previous.x,actor.position.y-previous.y)>=PARTY_FOLLOW_PROGRESS_PX){
      this.followProgress={...actor.position};this.followProgressAt=this.clock;return false;
    }
    if(this.clock-this.followProgressAt<PARTY_FOLLOW_STUCK_MS)return false;
    if(Math.hypot(actor.position.x-leader.position.x,actor.position.y-leader.position.y)<PARTY_REGROUP_DISTANCE_PX){
      // 已经在队长身边，只是被挤了一下；继续用正常寻路微调，不打断队形。
      this.followProgressAt=this.clock;return false;
    }
    this.followProgress={...actor.position};this.followProgressAt=this.clock;
    this.path=[];this.search=undefined;this.pathRetryAt=0;this.destination=undefined;this.nextPathAt=0;
    this.port.stop();this.port.regroup?.();
    return true;
  }
  private beginSearch(actor:Combatant,leader:Combatant,range:number,granted:number):void {
    this.nextPathAt=this.clock+PARTY_REPATH_INTERVAL_MS;this.destination={...leader.position};
    const canStand=(point:Point)=>this.port.canStand(point);
    const radius=Math.hypot(actor.bounds.width+leader.bounds.width,actor.bounds.height+leader.bounds.height)+range*8;
    this.search=createPathSearch(actor.position,{bounds:this.port.navigationBounds(),canStand,
      isGoal:point=>canStand(point)&&attackDistance(point,actor.bounds,leader.position,leader.bounds)<=range,
      heuristic:point=>Math.max(0,Math.hypot(point.x-leader.position.x,point.y-leader.position.y)-radius)});
    this.stepSearch(actor,granted);
  }
  private advanceSearch(actor:Combatant):void {
    const granted=this.port.pathBudget?.take(PARTY_SEARCH_CAP)??PARTY_SEARCH_CAP;
    if(granted>0)this.stepSearch(actor,granted);
  }
  private stepSearch(actor:Combatant,granted:number):void {
    const search=this.search;if(!search)return;
    const result=search.step(granted);
    if(result.status==='pending')return;
    this.search=undefined;
    if(result.status==='unreachable'){this.path=[];this.nextPathAt=this.clock+PARTY_FAILED_PATH_MS;return;}
    // 搜索跨了几帧，角色可能被其他系统挪过；从离当前位置最近的点继续，别掉头走回起点。
    let start=0,nearest=Infinity;
    for(let index=0;index<result.path.length;index++){
      const point=result.path[index]!,distance=Math.hypot(point.x-actor.position.x,point.y-actor.position.y);
      if(distance>=nearest)break;
      start=index;nearest=distance;
    }
    this.path=result.path.slice(start);
  }
  private readonly nextWaypoint=():Point|undefined=>{
    const actor=this.port.actor(this.id);if(!actor||this.disposed)return;
    const target=this.destinationTarget?this.port.actor(this.destinationTarget):undefined;
    const capabilities=combatStateCapabilities(actor.states??[]);
    if(!capabilities.canMove||(target&&actor.team!==target.team&&(!capabilities.canAutoApproach||!canTargetCombatant(actor,target))))return;
    while(this.path.length){
      const point=this.path[0];
      if(Math.hypot(actor.position.x-point.x,actor.position.y-point.y)>.5)break;
      // 脚点离网格点很近，但还没真正对齐。若从当前位置走不到下一个点，
      // 这个点就是用来把身体拉回网格的，不能提前丢掉，否则会永远卡在障碍边缘。
      const following=this.path[1];
      if(following&&!canTraverse(actor.position,following,point=>this.port.canStand(point)))break;
      this.path.shift();
    }
    const next=this.path[0];return next&&canTraverse(actor.position,next,point=>this.port.canStand(point))?next:undefined;
  };
}

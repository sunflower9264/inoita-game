import { LOGIC_FRAME_MS, type EnemyPlayableSkill } from './battle.ts';
import { attackDistance, targetDistance } from './basic-attack.ts';
import { CombatController, canTargetCombatant, type AttackContact, type Combatant, type CombatPort } from './combat.ts';
import { combatStateCapabilities } from './combat-state.ts';
import { needsTarget } from './skill-action.ts';
import { canTraverse, findPath, PATH_GRID_SIZE } from './pathfinding.ts';
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
  followPath(next: () => Point | undefined): void;
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
  private destination?:Point;
  private destinationTarget?:string;
  private destinationRange?:number;
  private disposed=false;
  constructor(id:string,port:PartyPort,combat:CombatController,random= Math.random){
    this.id=id;this.port=port;this.combatController=combat;this.random=random;
  }
  snapshot(){return this.combatController.snapshot();}
  captureState():PartyControllerState {
    return {retaliation:this.retaliation,accumulator:this.accumulator,clock:this.clock,nextPathAt:this.nextPathAt,
      path:this.path.map(point=>({...point})),destination:this.destination?{...this.destination}:undefined,
      destinationTarget:this.destinationTarget,destinationRange:this.destinationRange};
  }
  restoreState(state:PartyControllerState):void {
    this.retaliation=state.retaliation;this.accumulator=state.accumulator;this.clock=state.clock;this.nextPathAt=state.nextPathAt;
    this.path=state.path.map(point=>({...point}));this.destination=state.destination?{...state.destination}:undefined;
    this.destinationTarget=state.destinationTarget;this.destinationRange=state.destinationRange;
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
    this.path=[];this.destination=undefined;this.destinationTarget=undefined;this.destinationRange=undefined;this.nextPathAt=0;this.port.stop();
  }
  cancel():void {this.combatController.cancel(true);this.retaliation=undefined;this.path=[];this.destination=undefined;this.destinationTarget=undefined;this.destinationRange=undefined;this.nextPathAt=0;this.accumulator=0;this.port.stop();}
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
    if(!combatStateCapabilities(actor.states??[]).canAct){this.path=[];this.port.stop();return;}
    if(this.combatController.snapshot().state!=='idle')return;
    if(this.port.counterattack()===0)this.retaliation=undefined;
    const inCombat=this.port.inCombat();
    // 优先级：显式集火 > 自己被谁打 > 主操作角色正在打的目标 > 自己上一轮选中的目标。
    const target=this.hostileTarget(actor,[
      this.port.focusTarget(),
      this.retaliation,
      inCombat?this.port.partyTarget?.():undefined,
      inCombat?this.combatController.snapshot().targetId:undefined
    ]);
    if(!target)this.retaliation=undefined;
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
      this.path=[];this.port.stop();return;
    }
    this.follow(actor,leader,PARTY_FOLLOW_DISTANCE_UNITS-1);
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
  private follow(actor:Combatant,leader:Combatant,range:number):void {
    const capabilities=combatStateCapabilities(actor.states??[]);
    if(!capabilities.canMove||(actor.team!==leader.team&&!capabilities.canAutoApproach)){this.port.stop();return;}
    if(this.destinationTarget!==leader.id||this.destinationRange!==range){
      this.path=[];this.destination=undefined;this.nextPathAt=0;
      this.destinationTarget=leader.id;this.destinationRange=range;
    }
    const moved=!this.destination||targetDistance(this.destination,leader.position)>=PATH_GRID_SIZE;
    if(this.clock>=this.nextPathAt&&(moved||!this.path.length||!this.nextWaypoint())){
      this.nextPathAt=this.clock+LOGIC_FRAME_MS;this.destination={...leader.position};
      const canStand=(point:Point)=>this.port.canStand(point);
      const radius=Math.hypot(actor.bounds.width+leader.bounds.width,actor.bounds.height+leader.bounds.height)+range*8;
      this.path=findPath(actor.position,{bounds:this.port.navigationBounds(),canStand,
        isGoal:point=>canStand(point)&&attackDistance(point,actor.bounds,leader.position,leader.bounds)<=range,
        heuristic:point=>Math.max(0,Math.hypot(point.x-leader.position.x,point.y-leader.position.y)-radius)},1024)??[];
      if(!this.path.length)this.nextPathAt=this.clock+180;
    }
    if(this.nextWaypoint())this.port.followPath(this.nextWaypoint);else this.port.stop();
  }
  private readonly nextWaypoint=():Point|undefined=>{
    const actor=this.port.actor(this.id);if(!actor||this.disposed)return;
    const target=this.destinationTarget?this.port.actor(this.destinationTarget):undefined;
    const capabilities=combatStateCapabilities(actor.states??[]);
    if(!capabilities.canMove||(target&&actor.team!==target.team&&(!capabilities.canAutoApproach||!canTargetCombatant(actor,target))))return;
    while(this.path.length&&Math.hypot(actor.position.x-this.path[0].x,actor.position.y-this.path[0].y)<=.5)this.path.shift();
    const next=this.path[0];return next&&canTraverse(actor.position,next,point=>this.port.canStand(point))?next:undefined;
  };
}

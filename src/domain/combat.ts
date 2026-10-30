import {executeSkillUnits} from './combat-unit-execution.ts';
import type { BasicAttackSelection, BasicAttackWait, ResolvedBasicAttack, SkillAction, SkillEffectCue, SkillEvent } from './battle.ts';
import type { ClipName, CollisionBox, Facing } from './content.ts';
import type { GameRectangle, Point } from './navigation.ts';
import { attackDistance, faceTarget, targetDistance, targetScore,type BasicAttackHand } from './basic-attack.ts';
import { attackSplashTargets,selectAttackSplashCenter } from './attack-splash.ts';
import { needsTarget, settleSkillRepeat, skillPlaybackEvents, type SkillRepeatState } from './skill-action.ts';
import { planCharge } from './target-charge.ts';
import { planRearTeleport } from './rear-teleport.ts';
import { basicSelectionFrames } from './combat-tempo.ts';
import type { ChargePlan } from './target-charge.ts';
import type { BattleStateKey } from './battle-semantics.ts';
import { combatStateCapabilities } from './combat-state.ts';
import type { ResolvedSkillUnit, SkillUnitOutcome } from './skill-unit-sequence.ts';
import type { PreparedActionDamage } from './action-damage.ts';
import { partyBuffTargets,type PartyBuffSlot } from './party-buff-targets.ts';
import { selectHealTarget,type HealSlot } from './heal-target.ts';
import type { ActorCooldownPort,Cooldown } from './combat-cooldowns.ts';
export type { Cooldown } from './combat-cooldowns.ts';
export type { BasicAttackSelection } from './battle.ts';

export interface Combatant { id: string; team: string; position: Point; bounds: CollisionBox; facing?: Facing; states?:readonly BattleStateKey[] }

/** 隐身只影响敌对选取，盟友和自身仍可获得治疗及增益。 */
export function canTargetCombatant(source:Combatant,target:Combatant):boolean {
  return combatStateCapabilities(target.states??[],source.team!==target.team).canTarget;
}
export interface AttackContact {
  casterId:string;targetId:string;skillId?:string;
  hand?:BasicAttackHand;
  basicAttack?:ResolvedBasicAttack;
}
export interface BasicAreaContact {casterId:string;basicAttack:ResolvedBasicAttack}
export interface SkillUnitStart { casterId:string; skill:NonNullable<ActionPlayback['skill']>; cueIndex:number }
export interface SkillUnitHit extends SkillUnitStart { targetId:string; preparedDamage?:PreparedActionDamage }
/** One direct event or one emitted transition owns this arrival object. */
export interface SkillUnitsArrival {
  event: Extract<SkillEvent, {kind:'units'}>;
  impactCenter?: Point;
  selectedTargetId?: string;
}
export type SkillUnitsReady = (arrival:SkillUnitsArrival)=>readonly ResolvedSkillUnit[];
export interface CombatSnapshot {
  readonly targetId?:string;
  readonly state: 'idle' | 'approaching' | 'attacking';
  readonly cooldowns: Readonly<Record<string, Cooldown>>;
}
/** 已接受的当前动作；目标来自动作本身，而不是界面上保留的选中对象。 */
export interface ActiveCombatAction {
  readonly state:'approaching'|'attacking';
  readonly targetId?:string;
  readonly skill?:ActionPlayback['skill'];
}
export interface ActionPlayback {
  repeatState?: SkillRepeatState;
  capturedTargets?: { id: string; position: Point }[];
  charge?: ChargePlan;
  caster: Combatant;
  target?: Combatant;
  facing: Facing;
  skill?: { id: string; action: SkillAction; level?: number; manaCost?: number; clips?: Record<Facing, ClipName> };
  basicAttack: ResolvedBasicAttack | null;
  basicAttackWait?:BasicAttackWait;
  /** 普通普攻每个逻辑帧读取当前攻速；1000 为基础值，固定动画及主动技能不消费。 */
  getAttackSpeedRate?:()=>number;
}
/** 游戏规则只依赖实体查询、移动和动作表现；场景提供具体实现。 */
export interface CombatPort {
  cooldowns:ActorCooldownPort;
  isPaused?():boolean;
  canSelectSkill?(skill:NonNullable<ActionPlayback['skill']>):boolean;
  actor(id: string): Combatant | undefined;
  candidates(): Combatant[];
  /** 即时生命值仍为正；伤害链尚未清理的零生命角色也返回 false。 */
  isAlive?(id:string):boolean;
  partySlots?():readonly (PartyBuffSlot<Combatant>|undefined)[];
  /** 该角色当前的原版距离单位射程加成（狙击）；不提供表示没有加成。 */
  rangeBonusUnits?(id:string):number;
  /** 治疗选人的原版评分，越低越优先；省略表示该角色不参与治疗候选。 */
  healScore?(id:string):number|undefined;
  /** 原版角色池候选（三队伍槽与同阵营召唤物），按原版枚举顺序给出；省略时只用三队伍槽。 */
  healCandidates?():readonly HealSlot<Combatant>[];
  facing(): Facing;
  moveToward(position: Point): void;
  approachTarget?(target:Combatant,range:number):boolean|void;
  canFinishApproach?(targetId:string):boolean;
  selectBasicAttack?(normal:ResolvedBasicAttack):BasicAttackSelection;
  stop(): void;
  canStand(position: Point, clearanceActorId?: string): boolean;
  /** 强制位移的整盒判定；省略时退回 `canStand` 的窄足底口径。 */
  canPlaceBody?(position: Point, clearanceActorId?: string): boolean;
  canReach?(position: Point): boolean;
  navigationBounds?(): GameRectangle;
  /** 强制位移落位；`clearanceActorId` 指定的角色不参与占位（背后瞬移要贴着目标）。 */
  relocate(position: Point, clearanceActorId?: string): void;
  face?(direction: Facing): void;
  play(action: ActionPlayback, frame: (index: number) => void, complete: () => void): () => void;
  /** 单目标普攻调用 contact，范围普攻调用 areaContact，技能派发调用 unitsReady。 */
  frame(action: ActionPlayback, index: number, contact: (targetId: string,hand?:BasicAttackHand) => void, unitsReady:SkillUnitsReady,areaContact?:()=>void): void;
  contact?(event: AttackContact): void;
  areaContact?(event:BasicAreaContact):void;
  unit?(event:SkillUnitHit):SkillUnitOutcome;
  prepareUnit?(event:SkillUnitStart):PreparedActionDamage|undefined;
  runUnitSequence?(work:()=>void):void;
  unitFeedback?(event:SkillUnitHit,outcome:SkillUnitOutcome,cue:SkillEffectCue):void;
  manaCost?(skill:NonNullable<ActionPlayback['skill']>):number|undefined;
  canSpendMana?(cost: number): boolean;
  spendMana?(cost: number): boolean;
  clearEffects(): void;
}

function resolveTargetArea(caster:Combatant,current:Combatant|undefined,candidates:Combatant[],rangeUnits:number,
  fallbackCenter:Point=caster.position):{
  targets:Combatant[];selectedTargetId?:string;
} {
  // A current target remains usable even when it is outside the candidate query.
  const selection=selectAttackSplashCenter(caster,current?[current]:candidates,rangeUnits,{currentTargetId:current?.id});
  const center=selection.targetId?selection.center:fallbackCenter;
  return {targets:attackSplashTargets(caster,center,candidates,rangeUnits),selectedTargetId:selection.targetId};
}

export function resolveCueTargets(cue: Pick<SkillEffectCue, 'target' | 'targetRangePx' | 'targetRangeMetric'>, caster: Combatant, selected: Combatant | undefined, candidates: Combatant[],
  partySlots:readonly (PartyBuffSlot<Combatant>|undefined)[]=[],rangeBonusUnits=0,
  healScore?:(actorId:string)=>number|undefined,healCandidates?:readonly HealSlot<Combatant>[]): Combatant[] {
  // 射程加成按原版距离单位给，一个单位 8 像素；只放宽搜索范围，不改变已选定的目标。
  if(rangeBonusUnits>0)cue={...cue,targetRangePx:cue.targetRangePx+rangeBonusUnits*8};
  if (cue.target === 'self') return [caster];
  if (cue.target === 'none') return [];
  if (cue.target === 'party') return partyBuffTargets(caster,partySlots,Math.floor(cue.targetRangePx/8));
  // 三队伍槽但排除施法者自己：圣徒之牺牲只能保护别的队友。
  if (cue.target === 'party-ally') return partyBuffTargets(caster,partySlots,Math.floor(cue.targetRangePx/8))
    .filter(actor=>actor.id!==caster.id);
  // 治疗只落一个人：按原版评分取最低，取不到就落回施法者自己。
  if (cue.target === 'ally-heal') {
    const pool=healCandidates??partySlots.map(slot=>{
      const score=slot&&healScore?healScore(slot.actor.id):undefined;
      return slot&&score!==undefined?{...slot,score}:undefined;
    });
    return [selectHealTarget(caster,pool,Math.floor(cue.targetRangePx/8))];
  }
  if (cue.target === 'target-area') return resolveTargetArea(caster,selected,candidates,Math.floor(cue.targetRangePx/8)).targets;
  if(selected&&!canTargetCombatant(caster,selected))selected=undefined;
  const center=caster.position;
  const withinRange = (actor: Combatant) => cue.targetRangeMetric==='octagonal-grid'
    ? Math.floor(targetDistance(center,actor.position)/8)<=Math.floor(cue.targetRangePx/8)
    : Math.hypot(center.x - actor.position.x, center.y - actor.position.y) <= cue.targetRangePx;
  if (cue.target === 'current' || cue.target === 'enemy') return selected ? [selected] : [];
  const allies = cue.target === 'ally';
  return candidates.filter(actor => (allies ? actor.team === caster.team : actor.team !== caster.team) && canTargetCombatant(caster,actor) && withinRange(actor));
}

export class CombatController {
  private readonly port: CombatPort;
  private readonly casterId: string;
  private basic: ResolvedBasicAttack | null;
  private state: CombatSnapshot['state'] = 'idle';
  private active?: { skill?: ActionPlayback['skill']; basicAttack?:ResolvedBasicAttack|null; basicAttackWait?:BasicAttackWait; targetId?: string; turnToTarget: boolean; approached?:boolean };
  private selectedId?: string;
  private cancelPlayback?: () => void;
  private generation = 0;
  private listeners = new Set<(state: CombatSnapshot) => void>();
  /**
   * 普攻节奏锁：到这个逻辑帧之前不再接受普攻。动作播放可以取消，节奏不能取消。
   * 时钟由 `CombatRuntime` 注册角色时注入；没有时钟的纯单元测试不启用。
   */
  private basicReadyAt = 0;
  private clock?: () => number;

  constructor(casterId: string, basic: ResolvedBasicAttack | null, port: CombatPort) {
    this.casterId = casterId; this.basic = basic; this.port = port;
  }
  /** 运行时注册角色时注入逻辑帧时钟；之后普攻节奏锁才生效。 */
  useClock(clock:()=>number):void {this.clock=clock;}
  /** 动作推进时刷新预计结束帧；攻速变化后锁仍然覆盖这一轮完整周期。 */
  setBasicReadyAt(frame:number):void {if(this.clock)this.basicReadyAt=frame;}
  private basicLocked():boolean {return !!this.clock&&this.clock()<this.basicReadyAt;}
  setBasicAttack(basic:ResolvedBasicAttack):void {this.cancel();this.basic=basic;}
  snapshot(): CombatSnapshot {
    return { ...(this.selectedId?{targetId:this.selectedId}:{}), state: this.state, cooldowns: this.port.cooldowns.snapshot() };
  }
  /** 只读动作阶段；不构造冷却快照，供每帧只判断状态的调用方使用。 */
  actionState():CombatSnapshot['state']{return this.state;}
  /** 只读当前选中的目标；语义与 `snapshot().targetId` 相同。 */
  selectedTargetId():string|undefined{return this.selectedId;}
  activeAction():ActiveCombatAction|undefined {
    return this.active&&this.state!=='idle'?{state:this.state,targetId:this.active.targetId,skill:this.active.skill}:undefined;
  }
  /** 动作恢复只还原目标；冷却截止帧由会话中的冷却存储恢复。 */
  restoreState(snapshot:CombatSnapshot):void {
    this.cancel(true);
    this.selectedId=snapshot.targetId;
    this.basicReadyAt=0;
    this.publish();
  }
  subscribe(listener: (state: CombatSnapshot) => void): () => void {
    this.listeners.add(listener); listener(this.snapshot());
    return () => { this.listeners.delete(listener); };
  }
  private publish(): void { const value = this.snapshot(); for (const listener of this.listeners) listener(value); }
  /** 只选择目标；不会走近或出手。 */
  selectTarget(targetId:string):boolean {
    const caster=this.port.actor(this.casterId),target=this.port.actor(targetId);
    if(!caster||!target||caster.team===target.team||!canTargetCombatant(caster,target))return false;
    this.cancel();this.selectedId=targetId;this.publish();return true;
  }
  /** A successful reaction changes the current target without interrupting playback. */
  setReactionTarget(targetId:string):void {
    this.selectedId=targetId;this.publish();
  }
  /**
   * 方向键移动会清掉当前目标（原版 `CHAR_SetTarget(ch,0)`）：顶部面板随之消失，
   * 下一次普攻在攻击范围内重新选敌，而不是追回原目标。自动接近不清目标。
   */
  clearSelection():void {
    if(this.selectedId===undefined)return;
    this.selectedId=undefined;this.publish();
  }
  requestTarget(targetId: string, turnToTarget = true): 'started' | 'busy' | 'cooldown' | 'no-target' | 'no-mana' | 'unavailable' {
    return this.request(undefined, targetId, turnToTarget);
  }
  request(skill?: ActionPlayback['skill'], targetId?: string, turnToTarget = true): 'started' | 'busy' | 'cooldown' | 'no-target' | 'no-mana' | 'unavailable' {
    return this.requestAction(skill, targetId, turnToTarget);
  }
  /** 手动技能可以接管普攻；主动技能之间仍按当前动作完成后再接受输入。 */
  canSelectSkill(skill:NonNullable<ActionPlayback['skill']>):boolean {
    return this.port.canSelectSkill?.(skill)??!skill.action.requiredOffhand;
  }
  requestManualSkill(skill: NonNullable<ActionPlayback['skill']>, targetId?: string, turnToTarget = true): 'started' | 'busy' | 'cooldown' | 'no-target' | 'no-mana' | 'unavailable' {
    return this.requestAction(skill, targetId, turnToTarget, true);
  }
  /** 已经由规则触发的受命动作，沿用其起手资格。 */
  requestTriggeredAction(skill:NonNullable<ActionPlayback['skill']>,targetId?:string,turnToTarget=true) {
    return this.requestAction(skill,targetId,turnToTarget,false,true);
  }
  private requestAction(skill: ActionPlayback['skill'], targetId: string | undefined, turnToTarget: boolean, interruptBasic = false, triggered=false): 'started' | 'busy' | 'cooldown' | 'no-target' | 'no-mana' | 'unavailable' {
    if(this.port.isPaused?.())return 'busy';
    // 主动技能可以中途接管，但普攻必须等上一轮节奏走完；取消动作不会提前放行。
    if(!skill&&this.basicLocked())return 'busy';
    if(skill&&!triggered&&!this.canSelectSkill(skill))return 'unavailable';
    const replaceBasic = interruptBasic && !!this.active && !this.active.skill;
    if (this.state !== 'idle' && !replaceBasic) return 'busy';
    const manaCost=skill?(this.port.manaCost?.(skill)??skill.manaCost):undefined;
    if(manaCost && this.port.canSpendMana && !this.port.canSpendMana(manaCost))return 'no-mana';
    if (skill && !this.port.cooldowns.isReady(skill.id)) return 'cooldown';
    const caster = this.port.actor(this.casterId);
    if (!caster||!combatStateCapabilities(caster.states??[]).canAct) return 'busy';
    const profile = skill?.action ?? this.basic;
    if (!profile) return 'no-target';
    const wanted = !skill || needsTarget(skill.action);
    const previousId = targetId ?? this.selectedId;
    const previous = previousId ? this.port.actor(previousId) : undefined;
    const enemies = this.port.candidates().filter(actor => actor.team !== caster.team&&canTargetCombatant(caster,actor));
    // 狙击这类被动的射程加成同时放宽起手搜索与追近距离；单元范围另由 cue 自己的加成处理。
    const rangeBonus=this.port.rangeBonusUnits?.(this.casterId)??0;
    const target = wanted ? (previous&&previous.team !== caster.team&&canTargetCombatant(caster,previous) ? previous : undefined) ?? (targetId ? undefined : enemies.map(actor => ({ actor, score: targetScore(caster.position, actor.position, this.port.facing(), profile.searchRadiusPx+rangeBonus*8) }))
      .filter(item => item.score > 0).sort((a,b) => b.score-a.score)[0]?.actor) : undefined;
    if(target&&attackDistance(caster.position,caster.bounds,target.position,target.bounds)>profile.approachDistanceUnits+rangeBonus&&!combatStateCapabilities(caster.states??[]).canAutoApproach)return 'busy';
    if (replaceBasic) this.cancel(false, false);
    if (wanted && !target) return 'no-target';
    this.active = { skill, targetId: target?.id, turnToTarget }; if(target)this.selectedId = target.id;
    this.state = 'approaching'; this.publish(); return this.approach()??'started';
  }
  /** 目标离场先清引用；连射在下次发箭时结束，其他技能按自身动作继续。 */
  targetRemoved(targetId:string):void {
    const selected=this.selectedId===targetId,active=this.active?.targetId===targetId;
    if(!selected&&!active)return;
    if(active&&this.state==='attacking'&&(this.active?.skill||this.active?.basicAttack?.targeting||this.active?.basicAttackWait)){
      this.active.targetId=undefined;
      if(selected)this.selectedId=undefined;
      this.publish();
      return;
    }
    if(active){this.cancel(true);return;}
    this.selectedId=undefined;this.publish();
  }
  update(): void {
    if(this.port.isPaused?.())return;
    const caster=this.port.actor(this.casterId);
    const selected=this.selectedId?this.port.actor(this.selectedId):undefined;
    if(this.selectedId&&(!selected||!caster||!canTargetCombatant(caster,selected)))this.targetRemoved(this.selectedId);
    if(caster&&!combatStateCapabilities(caster.states??[]).canAct){this.cancel(false,false);return;}
    if (this.state === 'attacking' && this.active?.skill && this.active.targetId && !this.port.actor(this.active.targetId)) {
      this.targetRemoved(this.active.targetId);
    }
    this.approach();
  }
  /**
   * 技能强制位移按身体整盒落位。没有整盒查询时**拒绝位移**，不退回窄足底——
   * 脚点可站但身体压墙的落点会把角色放进墙里。
   */
  private canRelocateTo(position:Point,clearanceActorId?:string):boolean {
    return this.port.canPlaceBody?.(position,clearanceActorId)??false;
  }
  private approach(): 'no-target'|'no-mana'|undefined {
    if (this.state !== 'approaching' || !this.active) return;
    const caster = this.port.actor(this.casterId), target = this.active.targetId ? this.port.actor(this.active.targetId) : undefined;
    if (!caster || !combatStateCapabilities(caster.states??[]).canAct || (this.active.targetId && (!target||!canTargetCombatant(caster,target)))) { this.cancel(); return; }
    const { skill } = this.active, profile = skill?.action ?? this.basic;
    if (!profile) { this.cancel(); return; }
    if (target && attackDistance(caster.position, caster.bounds, target.position, target.bounds) > profile.approachDistanceUnits + (this.port.rangeBonusUnits?.(this.casterId) ?? 0)) {
      if(!combatStateCapabilities(caster.states??[]).canAutoApproach){this.cancel(false,false);return;}
      this.active.approached=true;
      if(this.port.approachTarget){
        if(this.port.approachTarget(target,profile.approachDistanceUnits)===false)this.cancel();
      }
      else this.port.moveToward(target.position);
      return;
    }
    if(target&&this.active.approached&&this.port.canFinishApproach?.(target.id)===false){this.cancel();return;}
    const charge=skill?.action.charge&&target?planCharge(caster,target,skill.action.charge,position=>this.canRelocateTo(position)):undefined;
    if(skill?.action.charge&&!charge){this.cancel();return 'no-target';}
    const manaCost=skill?(this.port.manaCost?.(skill)??skill.manaCost):undefined;
    if(manaCost && this.port.spendMana && !this.port.spendMana(manaCost)) {this.cancel();return 'no-mana';}
    this.port.stop(); this.state = 'attacking';
    if (skill) this.port.cooldowns.start(skill.id,skill.action.cooldownFrames);
    this.publish();
    const selection=!skill&&this.basic?(this.port.selectBasicAttack?.(this.basic)??this.basic):this.basic;
    const basicAttackWait=selection&&'kind'in selection?selection:undefined;
    const basicAttack=selection&&'kind'in selection?null:selection;
    this.active.basicAttack=basicAttack;
    this.active.basicAttackWait=basicAttackWait;
    const action: ActionPlayback = { caster, target, skill, charge, basicAttack, ...(basicAttackWait?{basicAttackWait}:{}), facing: target && this.active.turnToTarget ? faceTarget(charge?.destination??caster.position,target.position) : this.port.facing() };
    if(skill?.action.repeat?.requiresLivingTarget)action.repeatState={};
    const generation = ++this.generation;
    let lastFrame = -1;
    let areaContacted=false;
    const frame = (index: number) => {
      if (generation !== this.generation || this.state !== 'attacking'||this.port.isPaused?.()) return;
      // Catch up skipped animation notifications while firing each logical frame once.
      for (let next=lastFrame+1; next<=index; next++) {
        if(generation!==this.generation)return;
        {
          let live=this.port.actor(this.casterId);
          if(!live||!combatStateCapabilities(live.states??[]).canAct){this.cancel(false,false);return;}
          if(action.charge&&skill?.action.charge){
            if(next===0&&action.charge.close){
              // 贴身冲锋沿着面向冲刺；终点被墙或其他人挡住时，退到这一段里
              // 最远的可站点，而不是整段跳过——冲刺应停在障碍/地图边界前。
              const distance=Math.max(0,Math.round(skill.action.charge.lungeDistancePx));
              const dx=action.facing==='east'?1:action.facing==='west'?-1:0;
              const dy=action.facing==='south'?1:action.facing==='north'?-1:0;
              for(let step=distance;step>=1;step--){
                const lunge={x:action.charge.destination.x+dx*step,y:action.charge.destination.y+dy*step};
                if(this.canRelocateTo(lunge)){this.port.relocate(lunge);break;}
              }
            }else if(next===skill.action.charge.arrivalFrame)this.port.relocate(action.charge.destination);
            live=this.port.actor(this.casterId)??live;
          }
          action.caster=live;
          action.target=this.active?.targetId?this.port.actor(this.active.targetId):undefined;
          if(action.target&&!canTargetCombatant(live,action.target)){
            this.targetRemoved(action.target.id);action.target=undefined;
            if(generation!==this.generation)return;
          }
          if (skill && this.active?.targetId && !action.target) this.targetRemoved(this.active.targetId);
        }
        if(skill?.action.repeat&&skillPlaybackEvents(skill.action,next,skill.level,action.repeatState).some(event=>event.kind==='units')){
          if(skill.action.repeat.endsWithoutTarget&&!action.target){this.cancel(false,false);return;}
          if(skill.action.repeat.facesTargetOnRelease&&action.target){
            action.facing=faceTarget(action.caster.position,action.target.position);
            this.port.face?.(action.facing);
          }
        }
        if(skill?.action.rearTeleport?.frame===next){
          const target=action.target;
          const destination=target&&planRearTeleport(action.caster,target,point=>this.canRelocateTo(point,target.id),
            point=>this.port.canReach?.(point)??true,this.port.navigationBounds?.());
          if(destination){
            this.port.relocate(destination,target.id);
            action.caster=this.port.actor(this.casterId)!;
            action.facing=faceTarget(destination,target!.position);
            this.port.face?.(action.facing);
          }else{
            // 找位失败跳过本次动作分发，动画挥击与余帧继续播放。
            action.skill={...skill,action:{...skill.action,events:skill.action.events.filter(event=>event.kind!=='units')}};
          }
        }
        if(skill)for(const event of skillPlaybackEvents(skill.action,next,skill.level,action.repeatState))if(event.kind==='capture-targets'){
          action.capturedTargets=resolveCueTargets(event,action.caster,action.target,this.port.candidates(),event.target==='party'||event.target==='party-ally'?this.port.partySlots?.():undefined,
            this.port.rangeBonusUnits?.(this.casterId),id=>this.port.healScore?.(id))
            .slice(0,event.limit).map(target=>({id:target.id,position:{...target.position}}));
        }
        const contacted = new Set<string>();
        const contact = (targetId: string,hand?:BasicAttackHand) => {
          const contactKey=JSON.stringify([targetId,hand??'main-hand']);
          if (action.basicAttack?.strikes&&generation!==this.generation || skill || action.basicAttackWait || action.basicAttack?.targeting || contacted.has(contactKey)) return;
          const source = this.port.actor(this.casterId), recipient = this.port.actor(targetId);
          if (!source || !recipient || !canTargetCombatant(source,recipient)) return;
          contacted.add(contactKey);
          if(source.id===recipient.id||source.team===recipient.team)return;
          this.port.contact?.({casterId:source.id,targetId:recipient.id,
            ...(action.basicAttack?.strikes?{hand:hand??'main-hand',basicAttack:action.basicAttack}:{})});
        };
        const areaContact=()=>{
          if(generation!==this.generation||skill||areaContacted||!action.basicAttack?.targeting||!this.port.actor(this.casterId))return;
          areaContacted=true;
          this.port.areaContact?.({casterId:this.casterId,basicAttack:action.basicAttack});
        };
        const arrivals = new WeakMap<SkillUnitsArrival,readonly ResolvedSkillUnit[]>();
        const settleRepeat=()=>{
          if(!skill||!action.repeatState||generation!==this.generation)return;
          const current=this.active?.targetId?this.port.actor(this.active.targetId):undefined;
          settleSkillRepeat(skill.action,next,skill.level??1,!!current&&this.port.isAlive?.(current.id)!==false,action.repeatState);
        };
        const unitsReady:SkillUnitsReady = arrival => {
          if(!skill)return [];
          const previous=arrivals.get(arrival);if(previous)return previous;
          let results:ResolvedSkillUnit[]=[];
          arrivals.set(arrival,results);
          results=executeSkillUnits({casterId:this.casterId,skill,cues:arrival.event.cues,
            origin:arrival.impactCenter,selectedTargetId:arrival.selectedTargetId},{...this.port,
            currentTargetId:()=>this.selectedId,
            selectTarget:id=>{if(id!==this.selectedId)this.setReactionTarget(id);},
            resolved:hit=>{
              const source=this.port.actor(this.casterId),recipient=this.port.actor(hit.targetId);
              if(source&&recipient&&source.team!==recipient.team)
                this.port.contact?.({casterId:source.id,targetId:recipient.id,skillId:skill.id});
            },
          });
          arrivals.set(arrival,results);
          settleRepeat();
          return results;
        };
        this.port.frame(action, next, contact, unitsReady,areaContact);
        settleRepeat();

      }
      lastFrame = Math.max(lastFrame,index);
    };
    this.cancelPlayback = this.port.play(action, frame, () => {
      if (generation !== this.generation) return;
      this.cancelPlayback?.(); this.cancelPlayback = undefined;
      this.state = 'idle'; this.active = undefined; this.port.stop(); this.publish();
    });
    // 节奏锁从真正开始播放时计，经过接近阶段不算；取消这个动作也不会缩短它。
    if(!skill&&selection&&this.clock)this.setBasicReadyAt(this.clock()+basicSelectionFrames(selection,action.getAttackSpeedRate?.()??1000));
    frame(0);
  }
  cancel(clearEffects = false, clearTarget = true): void {
    if(this.state === 'idle' && (!clearTarget||!this.selectedId) && !clearEffects)return;
    this.generation++; this.cancelPlayback?.(); this.cancelPlayback = undefined;
    this.state = 'idle'; this.active = undefined; if(clearTarget)this.selectedId = undefined;
    this.port.stop(); if (clearEffects) this.port.clearEffects(); this.publish();
  }
  reset():void {this.cancel(true);this.basicReadyAt=0;this.port.cooldowns.reset();this.publish();}

  /** 清空技能冷却，当前动作和目标继续保持。 */
  resetSkillCooldowns():void {this.port.cooldowns.reset();this.publish();}
  dispose(): void { this.cancel(true); this.listeners.clear(); }
}

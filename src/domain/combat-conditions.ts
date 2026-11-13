import { applyAttributeModifiers, applyCombatOperation } from './combat-operation.ts';
import { LOGIC_FRAME_MS,type CombatOperation,type BattleBuffEffect } from './battle.ts';
import { calculateEffectiveDefense,calculateMagicResistance,eligibleShieldBlock,type PhysicalFighter } from './physical-hit.ts';
import type { PassiveModifier } from './passive-skills.ts';
import type { BattleBuffKey, BattleStateKey, BattleStatKey } from './battle-semantics.ts';
import { combatStateCapabilities } from './combat-state.ts';
import type { BuffReaction } from './buff-reactions.ts';

export interface ActiveCondition {
  kind:'buff'|'state';id:BattleBuffKey|BattleStateKey;remainingMs:number;strength:number;
  sourceId:string;stackCount:number;ownerBuff?:BattleBuffKey;
}
type BuffEffect=BattleBuffEffect;
const NO_BUFF_LOOPS:readonly BuffLoopFrame[]=[];
const NO_STATES:readonly BattleStateKey[]=[];
const NO_BUFF_REACTIONS:readonly BuffReaction[]=[];
export interface ConditionAppearance {states:readonly BattleStateKey[];colors:Readonly<BuffEffect['appearanceColors']>;loops:boolean}
export interface BuffLoopFrame {buff:BattleBuffKey;effect:string;frameAge:number}
export interface PeriodicTick { sourceId:string;targetId:string;buffId:BattleBuffKey;stackCount:number;effect:BuffEffect['periodic'][number] }
type InitializeBuffState=(state:BattleStateKey)=>{lastActiveFrame:number}|false;
/** 结算角色当前装备对属性的影响；缺省表示不检查副手，敌人与召唤物沿自身数据。 */
interface FighterEquipment { offhandShield?:boolean }
export type ResourceCapacityKey='maxHealth'|'maxMana';
export interface ResourceCapacities {maxHealth:number;maxMana:number}
/**
 * 无敌开关的宿主。调试开关存在会话上，`CombatConditions` 只读取它；没有宿主时退化为类内集合。
 * 开关刻意不进入 `captureState`，因此不写存档、也不随剧情标记回退。
 */
interface InvincibilityPort {has(actorId:string):boolean;add(actorId:string):void;delete(actorId:string):void}
interface BuffResourcePort {
  captureResourceCapacities(actorId:string):ResourceCapacities;
  onApply(actorId:string,effect:BattleBuffEffect,entry:Readonly<ResourceCapacities>):void;
}
interface StoredBuff { id:BattleBuffKey;sourceId:string;remainingMs:number;elapsedMs:number;nextTickMs:number;nextFrameAge?:number;strength:number;stackCount:number;effect:BuffEffect }
interface StoredState { id:BattleStateKey;sourceId:string;ownerBuff?:BattleBuffKey;remainingMs:number;
  simulationFrames?:{lastActiveFrame:number};nextFrameAge?:number }
const MAX_STATE_NODES=128;
/** 物理减伤率与角色面板同一公式：1000×防御 / (防御 + 20×(等级 + 3))。 */
const PER_MILLE=1000;
const PHYSICAL_DEFENSE_WEIGHT_PER_LEVEL=20;
const PHYSICAL_DEFENSE_LEVEL_OFFSET=3;
export interface CombatConditionsState {
  buffs:[string,StoredBuff[]][];
  states:[string,StoredState[]][];
  temporary:[string,[BattleStatKey,number|{operation:CombatOperation}][]][];
  resourceCapacities?:[string,[ResourceCapacityKey,number][]][];
  resourceCapacityInputs?:[string,[ResourceCapacityKey,number][]][];
  simulationFrameRemainderMs?:number;
}

/** 逐段斜坡已经叠过的段数：年龄 0 就叠第一段，之后每过一个间隔再叠一段。 */
function attributeRampSteps(buff:StoredBuff,ramp:{intervalFrames:number}):number {
  const frameAge=buff.nextFrameAge??Math.floor(buff.elapsedMs/LOGIC_FRAME_MS);
  return Math.floor(frameAge/ramp.intervalFrames)+1;
}

/** 同一种 buff 只保留最强的一份；重新施加较弱效果不会缩短原有效期。 */
export class CombatConditions {
  private buffs=new Map<string,Map<BattleBuffKey,StoredBuff>>();
  private states=new Map<string,Map<BattleStateKey,StoredState>>();
  /** 状态节点总数；避免每次施加状态都全量遍历所有角色。 */
  private stateCount=0;
  private temporary=new Map<string,Map<BattleStatKey,number|{operation:CombatOperation}>>();
  private resourceCapacities=new Map<string,Map<ResourceCapacityKey,number>>();
  private resourceCapacityInputs=new Map<string,Map<ResourceCapacityKey,number>>();
  private readonly resources:BuffResourcePort|undefined;
  private readonly invincibility:InvincibilityPort|undefined;
  private readonly invincible=new Set<string>();
  private simulationFrameRemainderMs=0;
  private revisionValue=0;
  private readonly stateLists=new Map<string,readonly BattleStateKey[]>();
  private readonly reactionLists=new Map<string,readonly BuffReaction[]>();
  private readonly appearanceChanges=new Set<string>();
  private readonly appearances=new Map<string,ConditionAppearance>();
  private clockRevision=0;
  private readonly loopFrames=new Map<string,{clock:number;frames:readonly BuffLoopFrame[]}>();
  private changed(actorId:string):void {
    this.revisionValue++;this.stateLists.delete(actorId);this.reactionLists.delete(actorId);this.loopFrames.delete(actorId);this.appearanceChanges.add(actorId);
  }
  private resetAppearances():void {
    this.revisionValue++;this.stateLists.clear();this.reactionLists.clear();this.loopFrames.clear();this.appearances.clear();this.appearanceChanges.clear();
    for(const id of this.states.keys())this.appearanceChanges.add(id);
    for(const id of this.buffs.keys())this.appearanceChanges.add(id);
  }
  /** 只有需要表现的角色进入名单；数值增益和无状态角色不会参与逐帧绘制查询。 */
  activeAppearances():ReadonlyMap<string,ConditionAppearance> {
    for(const id of this.appearanceChanges){
      const states=this.activeStates(id),colors=this.appearanceColors(id);
      let loops=false;
      for(const buff of this.buffs.get(id)?.values()??[])if(buff.effect.loopEffects?.length){loops=true;break;}
      if(loops||colors?.length||states.some(state=>state==='stealthed'||state==='stun'||state==='sleep'))
        this.appearances.set(id,{states,colors,loops});
      else this.appearances.delete(id);
    }
    this.appearanceChanges.clear();return this.appearances;
  }
  /**
   * Buff/状态集合的修订号。只在集合真正增删时推进：施加或替换 buff、施加或替换 state、
   * 显式移除、自然到期删除、`clear`、`remove(actorId)`、`restoreState`。
   * 计时推进、只读快照和属性临时缓存不改变它。
   */
  get revision():number{return this.revisionValue;}
  constructor(resources?:BuffResourcePort,invincibility?:InvincibilityPort){
    this.resources=resources;this.invincibility=invincibility;
  }
  setInvincible(actorId:string,enabled:boolean):void {
    if(this.invincibility){if(enabled)this.invincibility.add(actorId);else this.invincibility.delete(actorId);return;}
    if(enabled)this.invincible.add(actorId);else this.invincible.delete(actorId);
  }
  isInvincible(actorId:string):boolean {
    return this.invincibility?this.invincibility.has(actorId):this.invincible.has(actorId);
  }
  captureState():CombatConditionsState {
    return structuredClone({buffs:[...this.buffs].map(([id,own])=>[id,[...own.values()]]),
      states:[...this.states].map(([id,own])=>[id,[...own.values()]]),
      temporary:[...this.temporary].map(([id,own])=>[id,[...own]]),
      resourceCapacities:[...this.resourceCapacities].map(([id,own])=>[id,[...own]]),
      resourceCapacityInputs:[...this.resourceCapacityInputs].map(([id,own])=>[id,[...own]]),
      simulationFrameRemainderMs:this.simulationFrameRemainderMs});
  }
  restoreState(state:CombatConditionsState):void {
    // 整份集合被替换：即使内容相同，按版本复用的读取结果也要失效。
    const copy=structuredClone(state);
    this.buffs=new Map(copy.buffs.map(([id,buffs])=>[id,new Map(buffs.map(buff=>[buff.id,buff]))]));
    this.states=new Map(copy.states.map(([id,states])=>[id,new Map(states.map(value=>[value.id,value]))]));
    this.stateCount=[...this.states.values()].reduce((count,states)=>count+states.size,0);
    this.temporary=new Map(copy.temporary.map(([id,values])=>[id,new Map(values)]));
    this.resourceCapacities=new Map((copy.resourceCapacities??[]).map(([id,values])=>[id,new Map(values)]));
    this.resourceCapacityInputs=new Map((copy.resourceCapacityInputs??[]).map(([id,values])=>[id,new Map(values)]));
    this.simulationFrameRemainderMs=copy.simulationFrameRemainderMs??0;
    this.resetAppearances();
  }
  cachedAttribute(actorId:string,id:BattleStatKey):number|undefined {
    const value=this.temporary.get(actorId)?.get(id);
    return typeof value==='number'?value:undefined;
  }
  /**
   * 是否有增益会按时间改变蓝耗修正。
   * 属性增长不进 `revision`，所以调用方不能把蓝耗结果长期缓存；命中时改为每次现算。
   */
  hasManaCostAttributeRamp(actorId:string):boolean {
    for(const buff of this.buffs.get(actorId)?.values()??[])
      for(const ramp of buff.effect.attributeRamps??[])
        if(ramp.attribute==='manaCostRate'||ramp.attribute==='manaCostReductionRate')return true;
    return false;
  }
  readResourceCapacity(actorId:string,key:ResourceCapacityKey,compute:()=>number):number {
    const temporary=this.cachedAttribute(actorId,key);if(temporary!==undefined)return temporary;
    const cached=this.resourceCapacities.get(actorId)?.get(key);if(cached!==undefined)return cached;
    const value=compute(),own=this.resourceCapacities.get(actorId)??new Map<ResourceCapacityKey,number>();
    own.set(key,value);this.resourceCapacities.set(actorId,own);return value;
  }
  invalidateResourceCapacities(actorId:string,key?:ResourceCapacityKey):void {
    if(key){this.resourceCapacities.get(actorId)?.delete(key);this.temporary.get(actorId)?.delete(key);}
    else{
      this.resourceCapacities.delete(actorId);
      this.temporary.get(actorId)?.delete('maxHealth');this.temporary.get(actorId)?.delete('maxMana');
    }
  }
  setResourceCapacityInputs(actorId:string,key:ResourceCapacityKey,input:number):void {
    const own=this.resourceCapacityInputs.get(actorId)??new Map<ResourceCapacityKey,number>();
    const previous=own.get(key);
    if(previous!==undefined&&previous!==input)this.invalidateResourceCapacities(actorId,key);
    own.set(key,input);this.resourceCapacityInputs.set(actorId,own);
  }
  setTemporaryAttribute(actorId:string,id:BattleStatKey,value:number):void {
    const own=this.temporary.get(actorId)??new Map();
    own.set(id,value);this.temporary.set(actorId,own);
  }
  clearTemporaryAttribute(actorId:string,id:BattleStatKey):void {
    this.temporary.get(actorId)?.delete(id);
    if(id==='maxHealth'||id==='maxMana')this.invalidateResourceCapacities(actorId,id);
  }
  clearTemporary(actorId:string):void {
    const own=this.temporary.get(actorId);
    for(const key of ['maxHealth','maxMana'] as const)if(own?.has(key))this.invalidateResourceCapacities(actorId,key);
    this.temporary.delete(actorId);
  }
  private invalidateBuffAttributes(actorId:string,effect:BuffEffect):void {
    const attributes=new Set([...effect.modifiers.map(modifier=>modifier.attribute),...effect.invalidatesAttributes??[]]);
    for(const attribute of attributes){
      this.clearTemporaryAttribute(actorId,attribute);
      if(['physicalAttack','physicalDamageRate','magicAttack','magicDamageRate'].includes(attribute))
        this.clearTemporaryAttribute(actorId,'bestNormalDamage');
    }
  }
  private invalidateStateAttributes(actorId:string,state:BattleStateKey):void {
    if(state!=='stealthed')return;
    for(const attribute of ['physicalDamageRate','criticalRate','stunImmunity','manaRecoveryPerPulse','bestNormalDamage'] as const)
      this.clearTemporaryAttribute(actorId,attribute);
  }
  applyBuff(actorId:string,id:BattleBuffKey,strength:number,effect:BuffEffect,sourceId=actorId,initializeState?:InitializeBuffState):boolean {
    const own=this.buffs.get(actorId)??new Map<BattleBuffKey,StoredBuff>();
    const previous=own.get(id);
    if(previous&&previous.strength>strength)return false;
    const stackCount=Math.min((previous?.stackCount??0)+1,effect.maxStacks??1);
    this.removeBuff(actorId,id);
    const buff:StoredBuff={id,sourceId,strength,stackCount,effect,remainingMs:effect.durationMs,elapsedMs:0,nextTickMs:0,
      ...(effect.simulationFrames?{nextFrameAge:0}:{})};
    buff.remainingMs=this.buffRemainingMs(buff);
    own.set(id,buff);this.buffs.set(actorId,own);this.changed(actorId);
    const resourceEntry=this.resources?.captureResourceCapacities(actorId);
    this.invalidateBuffAttributes(actorId,effect);
    for(const state of effect.states){
      if(initializeState){
        const timing=initializeState(state);
        if(timing)this.applyStateFrames(actorId,state,timing.lastActiveFrame,sourceId);
      }else if(effect.stateDurationProfiles?.[state]){
        this.applyStateFrames(actorId,state,effect.stateDurationProfiles[state]!.normal.lastActiveFrame,sourceId);
      }else if(effect.simulationFrames){
        this.applyStateFrames(actorId,state,effect.simulationFrames.lastActiveFrame,sourceId);
      }else this.applyState(actorId,state,effect.durationMs,sourceId);
      // 初始化拒绝仍会将已有同名节点关联给当前Buff，保留它的来源和年龄。
      const current=this.states.get(actorId)?.get(state);
      if(current)current.ownerBuff=id;
    }
    if(resourceEntry)this.resources!.onApply(actorId,effect,resourceEntry);
    return true;
  }
  applyState(actorId:string,id:BattleStateKey,durationMs:number,sourceId=actorId):boolean {
    return this.storeState(actorId,{id,sourceId,remainingMs:durationMs});
  }
  applyStateFrames(actorId:string,id:BattleStateKey,lastActiveFrame:number,sourceId=actorId):boolean {
    if(!Number.isSafeInteger(lastActiveFrame)||lastActiveFrame<0)throw new Error('状态最后保留帧必须为非负整数');
    const state:StoredState={id,sourceId,remainingMs:0,simulationFrames:{lastActiveFrame},nextFrameAge:0};
    state.remainingMs=this.stateRemainingMs(state);
    return this.storeState(actorId,state);
  }
  private storeState(actorId:string,state:StoredState):boolean {
    const own=this.states.get(actorId)??new Map<BattleStateKey,StoredState>();
    const removed=own.delete(state.id);
    if(removed)this.stateCount--;
    if(this.stateCount>=MAX_STATE_NODES){
      // 容量不足时旧节点已经被删掉，这也是一次真实变化。
      if(removed)this.changed(actorId);
      return false;
    }
    this.invalidateStateAttributes(actorId,state.id);
    own.set(state.id,state);this.states.set(actorId,own);this.stateCount++;this.changed(actorId);return true;
  }
  /** 显式解除当前节点时一并移除它的母Buff；自然到期只删节点。 */
  removeState(actorId:string,id:BattleStateKey,sourceId?:string):void {
    const state=this.states.get(actorId)?.get(id);
    if(!state||(sourceId!==undefined&&state.sourceId!==sourceId))return;
    if(state.ownerBuff)this.removeBuff(actorId,state.ownerBuff);
    else {
      const own=this.states.get(actorId);
      if(own?.delete(id)){
        this.stateCount--;this.changed(actorId);
        if(!own.size)this.states.delete(actorId);
      }
      this.invalidateStateAttributes(actorId,id);
    }
  }
  update(deltaMs:number,onTick?:(tick:PeriodicTick)=>void):void {
    if(!Number.isFinite(deltaMs)||deltaMs<=0)return;
    this.clockRevision++;
    // 没有任何状态或增益时，下面只会扫空表；直接返回，不建快照、不推进帧计时。
    if(!this.states.size&&!this.buffs.size)return;
    const statesAtStart:{actorId:string;own:Map<BattleStateKey,StoredState>;state:StoredState}[]=[];
    for(const [actorId,own] of this.states)for(const state of own.values())if(!state.simulationFrames)statesAtStart.push({actorId,own,state});
    const buffsAtStart:{actorId:string;own:Map<BattleBuffKey,StoredBuff>;buff:StoredBuff}[]=[];
    for(const [actorId,own] of this.buffs)for(const buff of own.values())if(!buff.effect.simulationFrames)buffsAtStart.push({actorId,own,buff});
    // 帧计时先按每个边界推进；毫秒计时仍只推进本次调用开始时存在的节点。
    this.advanceSimulationFrames(deltaMs,onTick);
    for(const {actorId,own,buff} of buffsAtStart){
      const id=buff.id;
      const isCurrent=()=>this.buffs.get(actorId)===own&&own.get(id)===buff;
      if(!isCurrent())continue;
      const ending=Math.min(buff.effect.durationMs,buff.elapsedMs+deltaMs);
      if(buff.effect.tickMs>0&&buff.effect.periodic.length)while(buff.nextTickMs<=ending&&isCurrent()){
        for(const effect of buff.effect.periodic){
          if(!isCurrent())break;
          onTick?.({sourceId:buff.sourceId,targetId:actorId,buffId:id,stackCount:buff.stackCount,effect});
        }
        buff.nextTickMs+=buff.effect.tickMs;
      }
      buff.elapsedMs+=deltaMs;buff.remainingMs=Math.max(0,buff.effect.durationMs-buff.elapsedMs);
      if(buff.remainingMs<=0&&isCurrent())this.removeBuff(actorId,id);
    }
    for(const {actorId,own,state} of statesAtStart){
      if(this.states.get(actorId)!==own||own.get(state.id)!==state)continue;
      state.remainingMs=Math.max(0,state.remainingMs-deltaMs);
      if(state.remainingMs<=0){
        if(own.delete(state.id)){
          this.stateCount--;this.changed(actorId);
          if(!own.size)this.states.delete(actorId);
        }
        this.invalidateStateAttributes(actorId,state.id);
      }
    }
    this.clockRevision++;
    this.refreshFrameRemainingTimes();
  }
  private advanceSimulationFrames(deltaMs:number,onTick?:((tick:PeriodicTick)=>void)):void {
    let remaining=deltaMs;
    while(remaining>=LOGIC_FRAME_MS-this.simulationFrameRemainderMs){
      const entries:{actorId:string;own:Map<BattleBuffKey,StoredBuff>;buff:StoredBuff}[]=[];
      for(const [actorId,own] of this.buffs)for(const buff of own.values())if(buff.effect.simulationFrames)entries.push({actorId,own,buff});
      const stateEntries:{actorId:string;own:Map<BattleStateKey,StoredState>;state:StoredState}[]=[];
      for(const [actorId,own] of this.states)for(const state of own.values())if(state.simulationFrames)stateEntries.push({actorId,own,state});
      if(!entries.length&&!stateEntries.length)break;
      remaining-=LOGIC_FRAME_MS-this.simulationFrameRemainderMs;
      this.simulationFrameRemainderMs=0;
      for(const {actorId,own,state} of stateEntries){
        if(this.states.get(actorId)!==own||own.get(state.id)!==state)continue;
        const age=state.nextFrameAge??0;
        if(age>state.simulationFrames!.lastActiveFrame){if(own.delete(state.id)){this.stateCount--;this.changed(actorId);}this.invalidateStateAttributes(actorId,state.id);}
        else state.nextFrameAge=age+1;
      }
      for(const {actorId,own,buff} of entries){
        const isCurrent=()=>this.buffs.get(actorId)===own&&own.get(buff.id)===buff;
        if(!isCurrent())continue;
        const timing=buff.effect.simulationFrames!,age=buff.nextFrameAge??0;
        const afterAgeIncrement=timing.pulseAfterAgeIncrement===true;
        if(afterAgeIncrement){
          if(age>timing.lastActiveFrame){this.removeBuff(actorId,buff.id);continue;}
          buff.nextFrameAge=age+1;
        }
        const pulseAge=afterAgeIncrement?age+1:age;
        if(timing.pulseIntervalFrames&&pulseAge%timing.pulseIntervalFrames===0){
          for(const effect of buff.effect.periodic){
            if(!isCurrent())break;
            onTick?.({sourceId:buff.sourceId,targetId:actorId,buffId:buff.id,stackCount:buff.stackCount,effect});
          }
        }
        if(!isCurrent()||afterAgeIncrement)continue;
        if(age>timing.lastActiveFrame)this.removeBuff(actorId,buff.id);
        else buff.nextFrameAge=age+1;
      }
    }
    this.simulationFrameRemainderMs=(this.simulationFrameRemainderMs+remaining)%LOGIC_FRAME_MS;
  }
  private buffRemainingMs(buff:StoredBuff):number {
    const timing=buff.effect.simulationFrames;
    return timing?(timing.lastActiveFrame+1-(buff.nextFrameAge??0))*LOGIC_FRAME_MS+
      LOGIC_FRAME_MS-this.simulationFrameRemainderMs:buff.remainingMs;
  }
  private stateRemainingMs(state:StoredState):number {
    const timing=state.simulationFrames;
    return timing?(timing.lastActiveFrame+1-(state.nextFrameAge??0))*LOGIC_FRAME_MS+
      LOGIC_FRAME_MS-this.simulationFrameRemainderMs:state.remainingMs;
  }
  private refreshFrameRemainingTimes():void {
    for(const own of this.buffs.values())for(const buff of own.values())
      if(buff.effect.simulationFrames)buff.remainingMs=this.buffRemainingMs(buff);
    for(const own of this.states.values())for(const state of own.values())
      if(state.simulationFrames)state.remainingMs=this.stateRemainingMs(state);
  }
  remove(actorId:string):void {
    const states=this.states.get(actorId),hadBuffs=this.buffs.delete(actorId),hadStates=this.states.delete(actorId);
    if(states)this.stateCount-=states.size;
    if(hadBuffs||hadStates)this.changed(actorId);
    this.temporary.delete(actorId);this.resourceCapacities.delete(actorId);this.resourceCapacityInputs.delete(actorId);
  }
  removeBuff(actorId:string,id:BattleBuffKey):void {
    const buff=this.buffs.get(actorId)?.get(id);if(!buff)return;
    this.resources?.captureResourceCapacities(actorId);
    this.invalidateBuffAttributes(actorId,buff.effect);
    const ownBuffs=this.buffs.get(actorId);
    if(ownBuffs?.delete(id)){
      this.changed(actorId);
      if(!ownBuffs.size)this.buffs.delete(actorId);
    }
    const own=this.states.get(actorId);
    for(const state of buff.effect.states){if(own?.delete(state))this.stateCount--;this.invalidateStateAttributes(actorId,state);}
    if(own&&!own.size)this.states.delete(actorId);
  }
  clear():void {
    if(this.buffs.size||this.states.size)this.revisionValue++;
    this.stateLists.clear();this.reactionLists.clear();this.loopFrames.clear();this.appearances.clear();this.appearanceChanges.clear();
    this.buffs.clear();this.states.clear();this.stateCount=0;this.temporary.clear();this.resourceCapacities.clear();this.resourceCapacityInputs.clear();
  }
  hasState(actorId:string,id:BattleStateKey):boolean{return this.states.get(actorId)?.has(id)??false;}
  activeStates(actorId:string):readonly BattleStateKey[]{
    const own=this.states.get(actorId);if(!own?.size)return NO_STATES;
    let states=this.stateLists.get(actorId);
    if(!states){states=[...own.keys()];this.stateLists.set(actorId,states);}
    return states;
  }
  hasBuff(actorId:string,id:BattleBuffKey):boolean{return this.buffs.get(actorId)?.has(id)??false;}
  /** 结算内部复用只读定义；计时和叠层保存在 StoredBuff，不修改反应描述。 */
  activeBuffReactions(actorId:string):readonly BuffReaction[] {
    const buffs=this.buffs.get(actorId);
    if(!buffs?.size)return NO_BUFF_REACTIONS;
    const cached=this.reactionLists.get(actorId);if(cached)return cached;
    const reactions=[...buffs.values()].reverse().flatMap(buff=>buff.effect.reactions??[]);
    this.reactionLists.set(actorId,reactions);
    return reactions;
  }

  /** 只读取当前生效的来源，副本与内部 Buff 的属性及寿命互不影响。 */
  buffReactions(actorId:string):readonly BuffReaction[] {
    return structuredClone(this.activeBuffReactions(actorId));
  }
  buffLoopFrames(actorId:string):readonly BuffLoopFrame[] {
    // 绝大多数角色没有持续特效；别为每帧的每个角色分配临时数组。
    if(!this.buffs.get(actorId)?.size)return NO_BUFF_LOOPS;
    const cached=this.loopFrames.get(actorId);if(cached?.clock===this.clockRevision)return cached.frames;
    const frames=[...this.buffs.get(actorId)!.values()].reverse().flatMap(buff=>{
      const frameAge=buff.nextFrameAge??Math.floor(buff.elapsedMs/LOGIC_FRAME_MS);
      return (buff.effect.loopEffects??[]).filter(loop=>frameAge>=loop.firstFrameAge)
        .map(loop=>({buff:buff.id,effect:loop.effect,frameAge}));
    });
    this.loopFrames.set(actorId,{clock:this.clockRevision,frames});return frames;
  }
  private capabilities(actorId:string,hostile=true){
    return combatStateCapabilities(this.activeStates(actorId),hostile);
  }
  canMove(actorId:string):boolean{return this.capabilities(actorId).canMove;}
  canAct(actorId:string):boolean{return this.capabilities(actorId).canAct;}
  canTarget(actorId:string,{hostile=true}:{hostile?:boolean}={}):boolean{return this.capabilities(actorId,hostile).canTarget;}
  /** 原版状态 14（damage-immune）的整单元门槛：敌对单元在 `ProcessActUnit` 入口直接失败。 */
  canReceiveDamage(actorId:string):boolean{return this.capabilities(actorId).canReceiveDamage;}
  /** HP 伤害门：GM 调试无敌与状态 14 都挡伤害；状态、增益等非伤害效果不受 GM 无敌影响。 */
  canLoseHealth(actorId:string):boolean{return !this.isInvincible(actorId)&&this.canReceiveDamage(actorId);}
  /** MP 扣除门：GM 调试无敌期间技能费用与吸蓝都不扣 MP。 */
  losesMana(actorId:string):boolean{return !this.isInvincible(actorId);}
  canAutoApproach(actorId:string):boolean{return this.capabilities(actorId).canAutoApproach;}
  /** 药水病禁药：只挡一次性恢复物品，再生药水不受影响。 */
  canUseRecoveryItems(actorId:string):boolean{return this.capabilities(actorId).canUseRecoveryItems;}
  /** 药水病禁技能：原版只拦快捷栏输入，AI 直接起手不经过这里。 */
  canUseSkillShortcuts(actorId:string):boolean{return this.capabilities(actorId).canUseSkillShortcuts;}
  /** 睡眠和眩晕都阻止主动动作。 */
  cannotAct(actorId:string):boolean{return !this.canAct(actorId);}
  snapshot(actorId:string):readonly ActiveCondition[] {
    return [
      ...[...this.buffs.get(actorId)?.values()??[]].map(buff=>({kind:'buff' as const,id:buff.id,strength:buff.strength,remainingMs:buff.remainingMs,sourceId:buff.sourceId,stackCount:buff.stackCount})),
      ...[...this.states.get(actorId)?.values()??[]].map(state=>({kind:'state' as const,id:state.id,strength:0,remainingMs:state.remainingMs,sourceId:state.sourceId,stackCount:1,...(state.ownerBuff?{ownerBuff:state.ownerBuff}:{})}))
    ];
  }
  /** 该角色身上某条增益的总寿命上限（帧）。没挂这条增益、或它不走帧计时时返回 undefined。 */
  buffLifetimeFrames(actorId:string,id:BattleBuffKey):number|undefined {
    return this.buffs.get(actorId)?.get(id)?.effect.simulationFrames?.lastActiveFrame;
  }
  appearanceColors(actorId:string):readonly {red:number;green:number;blue:number}[]|undefined {
    const buffs=this.buffs.get(actorId);
    if(!buffs?.size)return undefined;
    // 等价于 reverse().find：后加上的 buff 优先。
    let found:readonly {red:number;green:number;blue:number}[]|undefined;
    for(const buff of buffs.values())if(buff.effect.appearanceColors?.length)found=buff.effect.appearanceColors;
    return found;
  }
  attribute(actorId:string,id:BattleStatKey,base:number,passives:readonly PassiveModifier[]=[]):number {
    const temporary=this.temporary.get(actorId)?.get(id);
    if(typeof temporary==='number')return temporary;
    let value=applyAttributeModifiers(id,base,passives);
    const buffs=this.buffs.get(actorId);
    if(buffs?.size)for(const buff of [...buffs.values()].reverse()){
      for(const modifier of buff.effect.modifiers)if(modifier.attribute===id)
        value=applyCombatOperation(value,stackOperation(modifier.operation,buff.stackCount));
      for(const ramp of buff.effect.attributeRamps??[])if(ramp.attribute===id)
        value=applyCombatOperation(value,stackOperation(ramp.operation,attributeRampSteps(buff,ramp)));
    }
    if(id==='stealthAttackEnabled'||id==='stealthDamageRate')value=Math.max(0,value);
    if(temporary){
      if(id==='magicResistance')value=calculateMagicResistance(value);
      value=applyCombatOperation(value,temporary.operation);
      this.setTemporaryAttribute(actorId,id,value);
    }
    return value;
  }
  fighter(actorId:string,base:PhysicalFighter,passives:readonly PassiveModifier[]=[],equipment:FighterEquipment={}):PhysicalFighter {
    const value=(id:BattleStatKey,original:number)=>this.attribute(actorId,id,original,passives);
    const physicalAttack=value('physicalAttack',base.physicalAttack);
    const physicalBonus=value('physicalDamageRate',0);
    const stealthAttackEnabled=value('stealthAttackEnabled',base.stealthAttackEnabled?1:0)>0;
    const stealthDamageRate=value('stealthDamageRate',base.stealthDamageRate??0);
    const defense=Math.max(0,value('defense',base.defense??0));
    const defenseRate=Math.max(0,value('defenseRate',base.defenseRate??0));
    const effectiveDefense=calculateEffectiveDefense(defense,defenseRate);
    const rawPhysicalResistance=base.defense===undefined?value('physicalResistanceBonus',base.physicalResistance):
      Math.trunc(PER_MILLE*effectiveDefense/(effectiveDefense+PHYSICAL_DEFENSE_WEIGHT_PER_LEVEL*(base.level+PHYSICAL_DEFENSE_LEVEL_OFFSET)))+value('physicalResistanceBonus',base.physicalResistanceBonus??0);
    // 狂战士防御侧：只对非负减伤率扣自身比例，装备者因此承受更多物理伤害。
    const zealotRate=Math.max(0,value('zealotRate',base.zealotRate??0));
    const physicalResistance=rawPhysicalResistance-Math.trunc(Math.max(0,rawPhysicalResistance)*zealotRate/PER_MILLE);
    const magicResistance=value('magicResistance',base.magicResistance??0);
    return {...base,defense:base.defense===undefined?undefined:defense,defenseRate,physicalAttack:Math.trunc(physicalAttack*(PER_MILLE+physicalBonus+(stealthAttackEnabled?stealthDamageRate:0))/PER_MILLE),physicalDamageRate:physicalBonus,
      zealotRate,stealthAttackEnabled,stealthDamageRate,
      magicDamageRate:value('magicDamageRate',0),conditionalMagicDamageRate:value('conditionalMagicDamageRate',0),
      magicAttack:value('magicAttack',base.magicAttack??0),criticalRate:value('criticalRate',base.criticalRate),
      criticalResistance:value('criticalResistance',base.criticalResistance),criticalDamageResistance:value('criticalDamageResistance',base.criticalDamageResistance),
      criticalDamage:value('criticalDamage',base.criticalDamage),physicalResistance:physicalResistance,
      magicResistance:this.cachedAttribute(actorId,'magicResistance')===undefined?calculateMagicResistance(magicResistance):magicResistance,
      evasionBonus:value('evasionBonus',base.evasionBonus),
      hitBonus:value('hitBonus',base.hitBonus),hitBase:value('hitBase',base.hitBase),evasionBase:value('evasionBase',base.evasionBase),
      weaponBlock:value('weaponBlock',base.weaponBlock),maxHealth:value('maxHealth',base.maxHealth??0),
      // 原版 GetAttr20 在实际副手不是盾时把盾挡直接清零：技能与增益都加不出虚拟盾。
      shieldBlock:eligibleShieldBlock(value('shieldBlock',base.shieldBlock),equipment.offhandShield!==false)};
  }
}

/** 原版先放大公式操作数，再执行一次运算，百分比不会逐层连乘。 */
function stackOperation(operation:CombatOperation,stackCount:number):CombatOperation {
  switch(operation.kind){
    case 'keep':return operation;
    case 'set':case 'add':case 'subtract':return {...operation,amount:operation.amount*stackCount};
    case 'multiply':return {...operation,factor:operation.factor*stackCount};
    case 'divide':return {...operation,divisor:operation.divisor*stackCount};
    case 'multiply-thousandth':case 'increase-thousandth':case 'decrease-thousandth':
      return {...operation,ratePerThousand:operation.ratePerThousand*stackCount};
  }
}

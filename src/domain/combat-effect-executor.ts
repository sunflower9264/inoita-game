import type {SkillUnitHit} from './combat.ts';
import type {CombatUnit} from './battle.ts';
import type {BattleStatKey} from './battle-semantics.ts';
import type {SkillUnitOutcome} from './skill-unit-sequence.ts';
import type {PreparedActionDamage} from './action-damage.ts';
import {resolvePreparedActionDamage} from './action-damage.ts';
import {applyCombatOperation} from './combat-operation.ts';
import {passesChanceThreshold} from './action-state.ts';
import {actionHealing} from './action-healing.ts';
import {drainMana} from './mana-drain.ts';
import {rollMagicHit,rollPhysicalHit,type PhysicalFighter,type PhysicalHit} from './physical-hit.ts';
import type {CombatConditions} from './combat-conditions.ts';
import {resolveStateApplication,selectStateDurationProfile,type StateApplicationRequest} from './state-application.ts';
import type {CombatThreatSystem} from './combat-threat-system.ts';
import type {Point} from './navigation.ts';
import type {HitEffectStyle} from './combat-feedback.ts';
import type {SkillReactionBuff,LearnedReactionSkill} from './skill-reactions.ts';

export interface CombatEffectPort {
  conditions:CombatConditions;threat?:CombatThreatSystem;
  random():number;
  run<T>(work:()=>T):T;
  available(id:string):boolean;
  partySide(id:string):boolean;
  fighter(id:string):PhysicalFighter|undefined;
  position(id:string):Point|undefined;
  vitals(id:string):{health:number;mana:number;maxMana:number}|undefined;
  attribute(id:string,key:BattleStatKey):number;
  valueSourceId(id:string,unit:CombatUnit):string;
  prepare(event:SkillUnitHit):PreparedActionDamage|undefined;
  applyBuff(id:string,key:Extract<CombatUnit,{effect:'buff'}>['buff'],strength:number,effect:Extract<CombatUnit,{effect:'buff'}>['ranks'][number]['effect'],sourceId:string):boolean;
  stateRequest(sourceId:string,targetId:string,state:Extract<CombatUnit,{effect:'state'}>['state']):Omit<StateApplicationRequest,'kind'|'chanceThreshold'>;
  stateAccepted(targetId:string,state:Extract<CombatUnit,{effect:'state'}>['state']):void;
  commandSummons(event:SkillUnitHit):SkillUnitOutcome;
  summon(event:SkillUnitHit,unit:Extract<CombatUnit,{effect:'summon'}>,rank:number):SkillUnitOutcome;
  restoreHealth(id:string,amount:number):void;
  setMana(id:string,value:number):void;
  healAccepted(sourceId:string,targetId:string):void;
  learnedBuff(id:string,key:LearnedReactionSkill):SkillReactionBuff|undefined;
  rearBonus(sourceId:string,targetId:string):number;
  reactions(event:SkillUnitHit,hit:PhysicalHit,kind:'physical'|'magic',position?:Point):void;
  hit(event:SkillUnitHit,hit:PhysicalHit,presentation:{style:HitEffectStyle;sound:boolean}):void;
  dropMana(id:string,damage:number,position:Point|undefined,kind:'skill'|'weapon'|undefined):void;
  showHit(event:SkillUnitHit,hit:PhysicalHit,presentation:{style:HitEffectStyle;sound:boolean}):void;
}

/** 单元效果解释器。资源与世界生命周期经语义接口提交，公式独立于场景。 */
export class CombatEffectExecutor {
  private readonly port:CombatEffectPort;
  constructor(port:CombatEffectPort){this.port=port;}
  execute(event:SkillUnitHit):SkillUnitOutcome {
    const p=this.port;
    return p.run(()=>{
      if(!p.available(event.targetId))return 'skipped';
      if(!p.available(event.casterId))return 'failure';
      const unit=event.skill.action.combatUnits?.[event.cueIndex];if(!unit)return 'skipped';
      const source=p.fighter(event.casterId);if(!source)return 'failure';
      const presentation={style:event.skill.action.hitEffectStyle??'weapon',sound:true} as const;
      // 原版状态 14 的整单元门槛：敌对单元在进入效果分支前全部失败。
      const hostile=p.partySide(event.casterId)!==p.partySide(event.targetId);
      const damaging=unit.effect==='physical'||unit.effect==='magic';
      if(hostile&&!p.conditions.canReceiveDamage(event.targetId)){
        if(damaging)p.showHit(event,{kind:'hit',damage:0},presentation);
        return 'failure';
      }
      // GM 调试无敌只挡 HP 伤害；吸蓝、状态、增益等非伤害效果照常结算，
      // 否则「无敌」会被误解成「所有效果免疫」，连敌人的 MP 消耗也一并免掉。
      if(damaging&&hostile&&!p.conditions.canLoseHealth(event.targetId)){
        p.showHit(event,{kind:'hit',damage:0},presentation);
        return 'failure';
      }
      const rank='ranks' in unit?Math.min(unit.ranks.length-1,Math.max(0,(event.skill.level??1)-1)):0;
      let amount=0;
      if('source' in unit){const prepared=event.preparedDamage??p.prepare(event);if(!prepared)return 'failure';
        amount=resolvePreparedActionDamage(prepared,prepared.source==='none'?0:p.attribute(p.valueSourceId(event.casterId,unit),prepared.source));}
      switch(unit.effect){
      case 'action':return p.commandSummons(event);
      case 'set-attribute':p.conditions.setTemporaryAttribute(event.casterId,unit.attribute,applyCombatOperation(p.attribute(event.casterId,unit.attribute),unit.ranks[rank]));return 'success';
      case 'clear-attribute':p.conditions.clearTemporaryAttribute(event.casterId,unit.attribute);return 'success';
      case 'taunt':p.threat?.taunt(event.casterId,event.targetId);return 'success';
      case 'summon':return p.summon(event,unit,rank);
      case 'buff':{
        const formula=unit.ranks[rank];if(!passesChanceThreshold(formula.chanceThreshold,p.random))return 'failure';
        p.applyBuff(event.targetId,unit.buff,formula.strength,formula.effect,event.casterId);return 'success';
      }
      case 'state':{
        const values=unit.ranks[rank];
        const decision=resolveStateApplication({...p.stateRequest(event.casterId,event.targetId,unit.state),kind:'action',chanceThreshold:values.chanceThreshold},p.random);
        if(!decision.allowed)return 'failure';
        const applied=values.stateDurationProfile
          ?p.conditions.applyStateFrames(event.targetId,unit.state,selectStateDurationProfile(values.stateDurationProfile,decision).lastActiveFrame,event.casterId)
          :p.conditions.applyState(event.targetId,unit.state,values.durationMs,event.casterId);
        if(!applied)return 'failure';p.stateAccepted(event.targetId,unit.state);p.threat?.state(event.casterId,event.targetId);return 'success';
      }
      case 'heal':{
        const before=p.vitals(event.targetId);if(!before||before.health<1)return 'success';
        const health=before.health;p.restoreHealth(event.targetId,actionHealing(amount,p.attribute(event.casterId,'healingPowerRate')));
        p.threat?.heal(event.casterId,event.targetId,(p.vitals(event.targetId)?.health??health)-health);
        p.healAccepted(event.casterId,event.targetId);return 'success';
      }
      case 'drain':{
        // GM 调试无限蓝期间目标 MP 不被吸走，施法者也不因此获得 MP。
        if(!p.conditions.losesMana(event.targetId))return 'success';
        const caster=p.vitals(event.casterId);if(caster){const result=drainMana(amount,p.vitals(event.targetId)?.mana??0,caster.mana,caster.maxMana);
          p.setMana(event.targetId,result.targetMana);p.setMana(event.casterId,result.casterMana);}return 'success';
      }
      case 'self-damage':{
        if(amount>0)p.hit({...event,targetId:event.casterId},{kind:'hit',damage:amount},{style:'weapon',sound:true});
        if(unit.alsoAppliesLearnedBuff){const buff=p.learnedBuff(event.casterId,unit.alsoAppliesLearnedBuff);
          if(buff)p.applyBuff(event.casterId,buff.key,buff.rankPriority,buff.effect,event.casterId);}return 'success';
      }
      case 'physical':case 'magic':{
        const target=p.fighter(event.targetId);if(!target)return 'skipped';
        const position=p.position(event.targetId);
        const bonus=event.skill.action.usesSkillDamageBuff?p.attribute(event.casterId,'skillDamageBonus'):0;
        const hit=unit.effect==='magic'
          ?rollMagicHit(source,target,amount,p.random,bonus+(event.skill.action.usesSkillDamageBuff?source.conditionalMagicDamageRate??0:0))
          :rollPhysicalHit(source,target,p.random,amount,bonus+p.rearBonus(event.casterId,event.targetId),
            event.skill.id==='assassin-s-sword'?p.attribute(event.casterId,'assassinSwordHitAdjustment'):0,
            event.skill.action.usesSkillDamageBuff?()=>p.attribute(event.casterId,'physicalAttack'):undefined);
        if(bonus>0&&hit.kind!=='miss')p.conditions.removeBuff(event.casterId,'dark-strike');
        p.reactions(event,hit,unit.effect,position);p.hit(event,hit,presentation);
        p.dropMana(event.casterId,hit.damage,position,event.skill.action.manaGemDrop);
        return hit.damage>0?'success':'failure';
      }
      case 'visual':return 'success';
      }
    });
  }
}

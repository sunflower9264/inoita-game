import type {AttackContact} from './combat.ts';
import type {PhysicalHit} from './physical-hit.ts';
import type {Point} from './navigation.ts';
import type {BattleStatKey} from './battle-semantics.ts';
import type {CombatConditions} from './combat-conditions.ts';
import type {SkillReactionEvent} from './skill-reactions.ts';
import type {BuffReactionEvent} from './buff-reactions.ts';

export interface HitReactionPort {
  conditions:CombatConditions;
  actorAttribute(id:string,key:BattleStatKey):number;
  react(event:SkillReactionEvent):void;
  reactToBuff(event:BuffReactionEvent):void;
  lightningOfHellReaction(casterId:string,targetId:string):void;
  godOfJusticeReaction(casterId:string,targetId:string):void;
  summonOwnerReactions(event:AttackContact,hit:PhysicalHit,kind:'physical'|'magic'):void;
  disturbanceReaction(casterId:string,targetId:string):void;
  partySide(id:string):boolean;
  activePartySlots():string[];
  partyRevengeReactions(casterId:string,kind:'physical'|'magic',outcome:PhysicalHit['kind']):void;
  equipmentRecovery(id:string):{lifeDrainPerThousand:number};
  /** 物理成功链上的重力摆、冰霜、治愈气息；在元素附伤之前，零伤和格挡也触发。 */
  physicalSuccessEquipmentProcs(event:AttackContact,hit:PhysicalHit,random?:()=>number):void;
  /** 物理或魔法 MISS 时的瞬间恢复；不抽随机数，魔法盾挡不触发。 */
  instantRecoveryOnMiss(event:AttackContact):void;
  isTwoHanded(id:string):boolean;
  moltenReflection(event:AttackContact,rate:number):void;
  holySacrificeTransfer(event:AttackContact,hit:PhysicalHit,kind:'physical'|'magic'):void;
  attackProc(event:AttackContact,hit:PhysicalHit,position?:Point):void;
}

/** 保持原版的有序反应链；外层命中事务在整条链结束后才提交死亡检查。 */
export function resolveHitReactionPipeline(event:AttackContact,hit:PhysicalHit,damageKind:'physical'|'magic',actionId:string,
  port:HitReactionPort,targetPosition?:Point):void {

    port.reactToBuff({kind:'physical-avoidance',ownerId:event.targetId,damageKind,outcome:hit.kind});
    if(damageKind==='physical'&&(hit.kind==='miss'||hit.kind==='weapon-block')){
      const fortitudeChance=port.actorAttribute(event.targetId,'defenseCooldownResetChance');
      if(fortitudeChance>0)port.react({kind:'physical-defense-instinct',ownerId:event.targetId,opponentId:event.casterId,
        damageKind,outcome:hit.kind,chanceThreshold:fortitudeChance});
    }
    if(hit.kind==='miss'){
      port.instantRecoveryOnMiss(event);
      return;
    }
    if(damageKind==='magic'&&hit.kind==='shield-block')return;
    // 地狱之落雷：魔法暴击的落雷判定在成功链最前，落雷自己的暴击也会再进来。
    if(damageKind==='magic'&&hit.kind==='critical')port.lightningOfHellReaction(event.casterId,event.targetId);
    // 神之定义：神圣一击与天罚之锤的暴击也在这里判，两类伤害都算。
    if(hit.kind==='critical'&&(actionId==='divine-strike'||actionId==='hammer-of-wrath'))
      port.godOfJusticeReaction(event.casterId,event.targetId);
    // 召唤物命中的主人链在原版成功函数里，位于受击方扰乱之前；主伤害在整条链之后才提交。
    port.summonOwnerReactions(event,hit,damageKind);
    // 扰乱：成功命中之后由受击方抽一次，抽中交给候选去嘲讽攻击者。
    port.disturbanceReaction(event.casterId,event.targetId);
    // 血之复仇：同阵营（含队伍召唤物）挨打后，三个活动队伍槽里学过的人各自给自己叠一层。
    if(port.partySide(event.targetId))port.partyRevengeReactions(event.casterId,damageKind,hit.kind);
    if(damageKind==='physical'&&hit.kind==='weapon-block'){
      // 原版先处理生存本能的眩晕，再处理绝命格挡的反制减益。
      port.reactToBuff({kind:'weapon-block-stun',ownerId:event.targetId,opponentId:event.casterId,damageKind,outcome:hit.kind});
      port.reactToBuff({kind:'weapon-block-counter',ownerId:event.targetId,opponentId:event.casterId,damageKind,outcome:hit.kind});
    }
    if(damageKind==='physical'&&(hit.kind==='weapon-block'||hit.kind==='shield-block'))
      port.react({kind:'physical-block',ownerId:event.targetId});
    // 技能（不是普攻）的成功命中：魔法之眼在这一步判定，与伤害是否为正无关。
    if(actionId!=='basic-attack')
      port.react({kind:'skill-attack-success',ownerId:event.casterId,opponentId:event.targetId,damageKind,outcome:hit.kind});
    // 原版把剑之灵魂与吸血之剑的恢复放在残影之前（17c804..17c98c 先于 17c98c..17ca58），
    // 所以残影的骰子在这里才消耗。
    port.react({kind:'attack-success',ownerId:event.casterId,opponentId:event.targetId,damageKind,
      outcome:hit.kind,hitDamage:hit.damage,otherLifeDrainPerThousand:port.equipmentRecovery(event.casterId).lifeDrainPerThousand});
    if(damageKind==='physical')
      port.physicalSuccessEquipmentProcs(event,hit);
    if(damageKind==='physical')
      port.react({kind:'physical-flare',ownerId:event.casterId,opponentId:event.targetId,damageKind,outcome:hit.kind,hand:event.hand});
    if(damageKind==='physical'){
      const armorBreakChance=port.actorAttribute(event.casterId,'armorBreakChance');
      if(armorBreakChance>0)port.react({kind:'physical-attack-effects',ownerId:event.casterId,opponentId:event.targetId,damageKind,
        outcome:hit.kind,armorBreakChance});
      const bloodThirstChance=port.actorAttribute(event.casterId,'bloodThirstChance');
      if(bloodThirstChance>=200)port.react({kind:'blood-thirst',ownerId:event.casterId,opponentId:event.targetId,damageKind,
        outcome:hit.kind,hitDamage:hit.damage,chanceThreshold:bloodThirstChance});
      if(port.conditions.buffReactions(event.casterId).some(reaction=>reaction.kind==='physical-success-party'))
        port.reactToBuff({kind:'physical-success-party',ownerId:event.casterId,damageKind,outcome:hit.kind,
          partyIds:port.activePartySlots()});
      const revengeChance=port.actorAttribute(event.targetId,'revengeChance');
      if(revengeChance>0)port.react({kind:'physical-revenge',ownerId:event.targetId,opponentId:event.casterId,
        damageKind,outcome:hit.kind,chanceThreshold:revengeChance});
      const cooldownResetChance=port.actorAttribute(event.casterId,'cooldownResetChance');
      if(cooldownResetChance>0){
        const mainHandTwoHanded=port.isTwoHanded(event.casterId);
        port.react({kind:'physical-instinct',ownerId:event.casterId,opponentId:event.targetId,
          damageKind,outcome:hit.kind,chanceThreshold:cooldownResetChance,mainHandTwoHanded});
      }
      const reflectionRate=port.actorAttribute(event.targetId,'moltenReflectionPerThousand');
      if(reflectionRate>0)port.moltenReflection(event,reflectionRate);
      port.reactToBuff({kind:'physical-success-threat',ownerId:event.casterId,opponentId:event.targetId,
        damageKind,outcome:hit.kind,hitDamage:hit.damage});
    }
    port.react({kind:'attack-effects',ownerId:event.casterId,opponentId:event.targetId,damageKind,
      outcome:hit.kind,actionId,hasMoltenArmor:port.actorAttribute(event.casterId,'moltenReflectionPerThousand')>0});
    // 圣徒之牺牲：原版在灼热反伤之后、黑暗之怒与灵魂之刃回蓝之前切走转移量。
    port.holySacrificeTransfer(event,hit,damageKind);
    if(damageKind==='physical')port.react({kind:'physical-hit-received',ownerId:event.targetId});
    // 灵魂之刃的 attr112 回蓝在原版位于黑暗之怒之后、正伤门与属性攻击之前（17da80..17db28）。
    port.reactToBuff({kind:'physical-success',ownerId:event.casterId,damageKind,outcome:hit.kind});
    if(hit.damage>0)port.conditions.removeState(event.targetId,'sleep');
    port.attackProc(event,hit,targetPosition);
  
}

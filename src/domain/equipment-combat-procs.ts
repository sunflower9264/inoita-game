import type {ItemInstance} from './items.ts';
import {equipmentAttackProcs} from './equipment-attack-procs.ts';
import {equipmentRecoveryModifiers} from './equipment-recovery.ts';
import {equipmentThreatReduction} from './equipment-threat.ts';
import {equipmentModifierTotals,type EquipmentModifierSource} from './equipment-modifiers.ts';

/** 使用已生成的实例和宝石词条；有符号阈值由宿主合并其它来源后钳位。 */
export function equipmentCombatProcs(source:EquipmentModifierSource) {
  const totals=equipmentModifierTotals(source),get=(stat:string)=>totals.get(stat)??0;
  return {pendulumStunChance:get('pendulum'),frostRetaliationChance:get('frost'),healingEnergyChance:get('healingEnergy'),
    zealotRate:get('zealot'),instantRecoveryPerThousand:get('instantRecovery')};
}

export function combatEquipmentEffects(equipped:readonly ItemInstance[]) {
  const totals=equipmentModifierTotals(equipped);
  return {totals,attack:equipmentAttackProcs(totals),combat:equipmentCombatProcs(totals),
    recovery:equipmentRecoveryModifiers(totals),threat:equipmentThreatReduction(totals)};
}

import {equipmentModifierTotals,type EquipmentModifierSource} from './equipment-modifiers.ts';

/** 使用已生成的实例和宝石词条；有符号阈值由宿主合并其它来源后钳位。 */
export function equipmentAttackProcs(source:EquipmentModifierSource) {
  const totals=equipmentModifierTotals(source),get=(stat:string)=>totals.get(stat)??0;
  return {fireSplashChance:get('fire'),windStrikeChance:get('wind'),frostStrikeChance:get('freeze'),
    divineStrikeChance:get('divine'),darknessStrikeChance:get('darkness'),poisonStrikeChance:get('poison')};
}

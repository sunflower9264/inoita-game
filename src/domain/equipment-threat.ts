import {equipmentModifierTotals,type EquipmentModifierSource} from './equipment-modifiers.ts';

/** 保留装备和宝石的有符号千分率，交由角色属性合并后统一钳位。 */
export function equipmentThreatReduction(source:EquipmentModifierSource):number {
  return equipmentModifierTotals(source).get('aggroReduction')??0;
}

import {equipmentModifierTotals,type EquipmentModifierSource} from './equipment-modifiers.ts';

/** 装备词条和镶嵌词条已经在导入层转换成游戏含义；只累计当前装备的实例。 */
export function equipmentRecoveryModifiers(source:EquipmentModifierSource) {
  const totals=equipmentModifierTotals(source),get=(stat:string)=>totals.get(stat)??0;
  return {lifeDrainPerThousand:Math.max(0,get('lifeSteal')),manaRecoveryPerPulse:get('manaRegen'),
    manaCostReductionRate:Math.max(0,get('spellExpert'))};
}

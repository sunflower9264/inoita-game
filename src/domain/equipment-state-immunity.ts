import type {BattleStateKey} from './battle-semantics.ts';
import {equipmentModifierTotals,type EquipmentModifierSource} from './equipment-modifiers.ts';

/** 装备上的状态抗性正值表示免疫；只汇总目标自己的装备和镶嵌。 */
export function equipmentStateImmunity(source:EquipmentModifierSource,state:BattleStateKey):number {
  const option=state==='sleep'?'sleepResistance':state==='stun'?'stunResistance':undefined;
  return option?(equipmentModifierTotals(source).get(option)??0):0;
}

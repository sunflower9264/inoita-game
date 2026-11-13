import type { CombatOperation, NumericCombatUnit } from './battle.ts';
import type { ActionDamageSource } from './combat-damage-source.ts';
import { PRIMARY_STATS } from './character-stats.ts';
import { applyCombatOperation } from './combat-operation.ts';

/** 内容里的属性权重以 0.1 为单位：权重 12 表示该属性贡献 1.2 倍。 */
const ATTRIBUTE_WEIGHT_TENTHS_PER_UNIT = 10;

export interface PreparedActionDamage {
  readonly source:NumericCombatUnit['source'];
  readonly weightedAddition:number;
  readonly fixedAddition:number;
  readonly operation:Readonly<CombatOperation>;
}

/** 每个单元固定公式与五维贡献；伤害来源保留为逐目标读取的名字。 */
export function prepareActionDamage(unit:NumericCombatUnit,rank:number,
  primaryAttributes:Readonly<ActionDamageSource['primaryAttributes']>):PreparedActionDamage|undefined {
  const formula=unit.ranks[Math.min(unit.ranks.length-1,Math.max(0,rank-1))];
  if(!formula)return undefined;
  return {
    source:unit.source,
    weightedAddition:Math.trunc(PRIMARY_STATS.reduce((sum,stat)=>sum+unit.attributeWeights[stat]*primaryAttributes[stat],0)/ATTRIBUTE_WEIGHT_TENTHS_PER_UNIT),
    fixedAddition:unit.effect==='heal'?0:formula.fixedAddition,
    operation:{...formula.operation},
  };
}

export function resolvePreparedActionDamage(prepared:PreparedActionDamage,currentSourceValue:number):number {
  const base=prepared.source==='none'?0:currentSourceValue;
  return applyCombatOperation(base+prepared.weightedAddition+prepared.fixedAddition,prepared.operation);
}

/** 只有一个目标的入口可直接准备并结算。 */
export function actionDamage(unit:NumericCombatUnit,rank:number,caster:ActionDamageSource):number {
  const prepared=prepareActionDamage(unit,rank,caster.primaryAttributes);
  if(!prepared)return 0;
  return resolvePreparedActionDamage(prepared,prepared.source==='none'?0:caster[prepared.source]);
}

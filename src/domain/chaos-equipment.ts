import type { ItemDefinition, ItemInstance } from './items.ts';

export type ChaosTier='chaos'|'epic-chaos';
export interface EquipmentChaos { tier:ChaosTier;valuePercent:number;levelOffset:number }
export interface ChaosRule { valueDelta:[number,number];valueBounds:[number,number];levelDiceDivisor:number;levelClampDivisor:number }

/** 普通装备的等级需求上限；高于 100 级的混沌装备允许到 105 级。 */
const NORMAL_EQUIPMENT_LEVEL_CEILING = 100;
const CHAOS_EQUIPMENT_LEVEL_CEILING = 105;

/** 装备等级条件受混沌偏移影响，结果夹在 0 到对应品质的上限之间。 */
export function equipmentLevel(item:Pick<ItemDefinition,'level'>,entry:ItemInstance):number {
  const ceiling=item.level<=NORMAL_EQUIPMENT_LEVEL_CEILING?NORMAL_EQUIPMENT_LEVEL_CEILING:CHAOS_EQUIPMENT_LEVEL_CEILING;
  return Math.max(0,Math.min(ceiling,item.level+(entry.numbers?.chaos?.levelOffset??0)));
}

/** 原版两次包含端点的掷骰取平均，负数向零截断。 */
export function rollChaos(item:Pick<ItemDefinition,'level'>,entry:ItemInstance,tier:ChaosTier,rule:ChaosRule,random:()=>number):EquipmentChaos {
  const die=(min:number,max:number)=>{
    const value=random();
    if(!Number.isFinite(value)||value<0||value>=1)throw new Error('随机结果无效');
    return min+Math.floor(value*(max-min+1));
  };
  const average=(min:number,max:number)=>Math.trunc((die(min,max)+die(min,max))/2)||0;
  const delta=average(...rule.valueDelta),radius=Math.trunc(item.level/rule.levelDiceDivisor),limit=Math.trunc(item.level/rule.levelClampDivisor);
  return {tier,valuePercent:Math.max(rule.valueBounds[0],Math.min(rule.valueBounds[1],(entry.numbers?.chaos?.valuePercent??100)+delta)),
    levelOffset:Math.max(-limit,Math.min(limit,average(-radius,radius)))};
}

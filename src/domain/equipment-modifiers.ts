import type {ItemInstance} from './items.ts';

export type EquipmentModifierSource=readonly (ItemInstance|undefined)[]|ReadonlyMap<string,number>;

/** 装备自身和已镶嵌宝石的词条按属性相加，保留负数。 */
export function equipmentModifierTotals(source:EquipmentModifierSource):ReadonlyMap<string,number> {
  if('get' in source)return source;
  const totals=new Map<string,number>();
  for(const entry of source){
    if(!entry?.numbers)continue;
    for(const list of [entry.numbers.modifiers,entry.numbers.gemModifiers]){
      for(const {stat,value} of list??[])totals.set(stat,(totals.get(stat)??0)+value);
    }
  }
  return totals;
}

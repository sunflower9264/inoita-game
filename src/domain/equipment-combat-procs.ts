import type {ItemInstance} from './items.ts';

const optionAttributes={
  pendulum:'pendulumStunChance',frost:'frostRetaliationChance',healingEnergy:'healingEnergyChance',
  zealot:'zealotRate',instantRecovery:'instantRecoveryPerThousand',
} as const;
type EquipmentCombatProcRates=Record<typeof optionAttributes[keyof typeof optionAttributes],number>;

/** 使用已生成的实例和宝石词条；有符号阈值由宿主合并其它来源后钳位。 */
export function equipmentCombatProcs(equipped:readonly ItemInstance[]):EquipmentCombatProcRates {
  const rates:EquipmentCombatProcRates={pendulumStunChance:0,frostRetaliationChance:0,healingEnergyChance:0,
    zealotRate:0,instantRecoveryPerThousand:0};
  for(const item of equipped)for(const modifier of [...item.numbers?.modifiers??[],...item.numbers?.gemModifiers??[]]){
    if(!Object.hasOwn(optionAttributes,modifier.stat))continue;
    rates[optionAttributes[modifier.stat as keyof typeof optionAttributes]]+=modifier.value;
  }
  return rates;
}

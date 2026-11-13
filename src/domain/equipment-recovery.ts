import type {ItemInstance} from './items.ts';

/** 装备词条和镶嵌词条已经在导入层转换成游戏含义；只累计当前装备的实例。 */
export function equipmentRecoveryModifiers(equipped:readonly ItemInstance[]):{lifeDrainPerThousand:number;manaRecoveryPerPulse:number;manaCostReductionRate:number} {
  let lifeDrainPerThousand=0,manaRecoveryPerPulse=0,manaCostReductionRate=0;
  for(const item of equipped)for(const modifier of [...item.numbers?.modifiers??[],...item.numbers?.gemModifiers??[]]){
    if(modifier.stat==='lifeSteal')lifeDrainPerThousand+=modifier.value;
    if(modifier.stat==='manaRegen')manaRecoveryPerPulse+=modifier.value;
    if(modifier.stat==='spellExpert')manaCostReductionRate+=modifier.value;
  }
  return {lifeDrainPerThousand:Math.max(0,lifeDrainPerThousand),manaRecoveryPerPulse:manaRecoveryPerPulse,manaCostReductionRate:Math.max(0,manaCostReductionRate)};
}

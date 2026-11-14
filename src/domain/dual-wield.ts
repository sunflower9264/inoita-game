/** 副手普攻基础概率按千分比累加：匕首 140‰、长剑 100‰、斧/锤 90‰，皮甲再加 50‰。 */
const OFFHAND_WEAPON_CHANCE_PER_MILLE=new Map<string,number>([['dagger',140],['longsword',100],['axe',90],['mace',90]]);
const LEATHER_OFFHAND_CHANCE_PER_MILLE=50;
/** 原版副手判定掷点范围是 1..999。 */
const NATIVE_CHANCE_ROLL_MAX=999;

/** 双持资格以内容表的 `dualWieldClasses` 为准，与背包允许的副手槽位共用同一份名单。 */
export function baseOffhandAttackChance(classId:string,offhandKind:string,armorKind:string,dualWieldClasses:readonly string[]):number {
  if(!dualWieldClasses.includes(classId))return 0;
  const weapon=OFFHAND_WEAPON_CHANCE_PER_MILLE.get(offhandKind)??0;
  return weapon+(armorKind==='leather'?LEATHER_OFFHAND_CHANCE_PER_MILLE:0);
}

/** Eligible attacks draw before reading the current chance, even when that chance is zero. */
export function chooseDualWield(classId:string,hasOffhandWeapon:boolean,ports:{random:()=>number;chance:()=>number},dualWieldClasses:readonly string[]):boolean {
  if(!dualWieldClasses.includes(classId)||!hasOffhandWeapon)return false;
  const roll=Math.min(NATIVE_CHANCE_ROLL_MAX,Math.floor(ports.random()*NATIVE_CHANCE_ROLL_MAX)+1);
  return roll<Math.max(0,ports.chance());
}

/** The offhand replaces the main weapon contribution and halves the remaining raw attack. */
export function offhandPhysicalAttack(physicalAttack:number,mainHandPower:number,offhandPower:number):number {
  return Math.floor((physicalAttack-mainHandPower)/2)+offhandPower;
}

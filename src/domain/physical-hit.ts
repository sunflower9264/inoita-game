/** 原版战斗概率与伤害比例均使用千分数，整数除法向零取整。 */
export interface PhysicalFighter {
  level: number;
  physicalAttack: number;
  /** 尚未乘防御率的原始防御。 */
  defense?:number;
  defenseRate?:number;
  physicalResistanceBonus?:number;
  magicAttack?:number;
  maxHealth?:number;
  hitBase: number;
  hitBonus: number;
  evasionBase: number;
  evasionBonus: number;
  criticalRate: number;
  criticalResistance: number;
  criticalDamage: number;
  criticalDamageResistance: number;
  weaponBlock: number;
  shieldBlock: number;
  physicalResistance: number;
  magicResistance?:number;
  physicalDamageRate?:number;
  /** 狂战士：攻击侧按千分比增伤，防御侧同时降低自身物理减伤率。 */
  zealotRate?:number;
  stealthAttackEnabled?:boolean;
  stealthDamageRate?:number;
  magicDamageRate?:number;
  conditionalMagicDamageRate?:number;
}
export interface PhysicalHit { kind: 'miss' | 'weapon-block' | 'shield-block' | 'hit' | 'critical'; damage: number }

/** 盾牌格挡只在副手真的装着盾时存在：装备词条、被动和增益都加不出虚拟盾。 */
export function eligibleShieldBlock(value:number,offhandShield:boolean):number {
  return offhandShield?Math.max(0,value):0;
}
const div = (a: number, b: number) => Math.trunc(a / b);
const clampRoll = (random: () => number, minimum: number, maximum: number) =>
  minimum + Math.min(maximum - minimum, Math.max(0, Math.floor(random() * (maximum - minimum + 1))));

/** 原版把概率、伤害比例和抗性都写成千分数（1000 = 100%）。 */
const PER_MILLE = 1000;
/** 原版单次判定掷点范围是 0..999。 */
const NATIVE_ROLL_MAX = 999;
/** 魔法抗性上限 750‰。 */
const MAX_MAGIC_RESISTANCE_PER_MILLE = 750;
/** 闪避加成上限 750‰。 */
const MAX_EVASION_BONUS_PER_MILLE = 750;
/** 武器格挡成功时只承受 70% 伤害。 */
const WEAPON_BLOCK_DAMAGE_PER_MILLE = 700;
/** 原版命中基础式的固定偏置：命中基数放大千倍后再加 20000。 */
const HIT_RATE_BIAS = 20_000;
/** 原版命中基础式分母里的闪避基数修正。 */
const EVASION_BASE_OFFSET = 25;
/** 命中基础式最后追加的 100‰ 基础命中。 */
const BASE_HIT_RATE_PER_MILLE = 100;
/** 等级优势按 `等级差×1000/(100+等级差)` 折算成命中/格挡千分比。 */
const LEVEL_ADVANTAGE_DIVISOR = 100;

/** 原始防御和总防御率分别钳零，再做一次千分率乘法。 */
export function calculateEffectiveDefense(defense:number,defenseRate:number):number {
  return div(Math.max(0,defense)*(PER_MILLE+Math.max(0,defenseRate)),PER_MILLE);
}

/** 普通魔抗重算合并全部来源后只限制上界，负抗性仍会增加所受伤害。 */
export function calculateMagicResistance(resistance:number):number {
  return Math.min(MAX_MAGIC_RESISTANCE_PER_MILLE,resistance);
}

function criticalDamage(damage:number,attacker:PhysicalFighter,target:PhysicalFighter):number {
  return div(div(damage*(PER_MILLE+attacker.criticalDamage),PER_MILLE)*(PER_MILLE-target.criticalDamageResistance),PER_MILLE);
}
/** 原版盾挡把格挡值按 `20×等级+60` 折算成防御，再按 `防御/(防御+20×(等级+3))` 减伤。 */
function shieldDamage(damage:number,target:PhysicalFighter):number {
  damage-=div(target.shieldBlock,target.shieldBlock+target.level*20+60);
  const defense=div(target.shieldBlock*2*(PER_MILLE+(target.defenseRate??0)),PER_MILLE);
  const reduction=div(PER_MILLE*defense,defense+20*(target.level+3));
  const product=damage*(PER_MILLE-reduction);
  // 负数乘积还没超过 -1000‰ 时取整为 0；压得更低才保底 1 点伤害。
  return product>=-999?div(product,PER_MILLE):1;
}

/** 物理命中依次判定闪避、盾牌格挡、武器格挡和暴击，再应用伤害加成与目标减伤。
 * 技能传入 skillPhysicalAttack，命中后才读取施法者未乘伤害倍率的当前物攻。
 */
export function rollPhysicalHit(attacker: PhysicalFighter, target: PhysicalFighter, random: () => number = Math.random, baseDamage=attacker.physicalAttack,extraDamageRate=0,hitRateAdjustment=0,skillPhysicalAttack?:()=>number): PhysicalHit {
  const hitRate = div(attacker.hitBase * PER_MILLE + HIT_RATE_BIAS, attacker.hitBase + target.evasionBase + EVASION_BASE_OFFSET)
    + Math.max(0, attacker.hitBonus) + BASE_HIT_RATE_PER_MILLE;
  const missChance = Math.max(0, PER_MILLE - hitRate + Math.min(MAX_EVASION_BONUS_PER_MILLE, target.evasionBonus) - hitRateAdjustment);
  const roll = clampRoll(random, 0, NATIVE_ROLL_MAX);
  if (roll < missChance) return { kind: 'miss', damage: 0 };

  const difference = attacker.level - target.level;
  const levelAdvantage = Math.sign(difference) * div(Math.abs(difference) * PER_MILLE, LEVEL_ADVANTAGE_DIVISOR + Math.abs(difference));
  let kind: PhysicalHit['kind'] = 'hit';
  let threshold=missChance;
  const shield=target.shieldBlock>0?Math.max(0,target.shieldBlock-levelAdvantage):0;
  const weapon=target.weaponBlock>0?Math.max(0,target.weaponBlock-levelAdvantage):0;
  if (roll < (threshold+=shield))
    kind = 'shield-block';
  else if (roll < (threshold+=weapon))
    kind = 'weapon-block';
  else if (attacker.criticalRate + levelAdvantage - target.criticalResistance > 0
    && roll < threshold + attacker.criticalRate + levelAdvantage - target.criticalResistance)
    kind = 'critical';

  const stealthRate=attacker.stealthAttackEnabled?attacker.stealthDamageRate??0:0;
  let damage = div(baseDamage*(PER_MILLE+(attacker.physicalDamageRate??0)+stealthRate+extraDamageRate+(attacker.zealotRate??0)),PER_MILLE);
  if(attacker.stealthAttackEnabled&&skillPhysicalAttack)
    damage+=div(skillPhysicalAttack()*(PER_MILLE+stealthRate),PER_MILLE);
  if (kind === 'weapon-block') damage = div(damage * WEAPON_BLOCK_DAMAGE_PER_MILLE, PER_MILLE);
  damage = div(damage * (PER_MILLE - target.physicalResistance), PER_MILLE);
  if (kind === 'shield-block') damage = shieldDamage(damage,target);
  if (kind === 'critical') damage = criticalDamage(damage,attacker,target);
  return { kind, damage: Math.max(0, damage) };
}

/** 魔法命中判定闪避、盾牌格挡和暴击；伤害读取施法者的魔法加成与目标的魔法减伤。 */
export function rollMagicHit(attacker:PhysicalFighter,target:PhysicalFighter,baseDamage:number,random:()=>number=Math.random,extraDamageRate=0):PhysicalHit {
  const hitRate=div(attacker.hitBase*PER_MILLE+HIT_RATE_BIAS,attacker.hitBase+target.evasionBase+EVASION_BASE_OFFSET)+Math.max(0,attacker.hitBonus)+BASE_HIT_RATE_PER_MILLE;
  const missChance=Math.max(0,PER_MILLE-hitRate+Math.min(MAX_EVASION_BONUS_PER_MILLE,target.evasionBonus));
  const roll=clampRoll(random,0,NATIVE_ROLL_MAX);
  if(roll<missChance)return {kind:'miss',damage:0};
  const difference=attacker.level-target.level;
  const advantage=10*div(Math.abs(difference),LEVEL_ADVANTAGE_DIVISOR+Math.abs(difference));
  let kind:PhysicalHit['kind']='hit';
  const shield=target.shieldBlock>0?Math.max(0,target.shieldBlock-advantage):0;
  if(roll<missChance+shield)kind='shield-block';
  else if(attacker.criticalRate+advantage-target.criticalResistance>0&&roll<missChance+shield+attacker.criticalRate+advantage-target.criticalResistance)kind='critical';
  let damage=div(baseDamage*(PER_MILLE+(attacker.magicDamageRate??0)+extraDamageRate),PER_MILLE);
  damage=div(damage*(PER_MILLE-(target.magicResistance??0)),PER_MILLE);
  if(kind==='shield-block')damage=shieldDamage(damage,target);
  if(kind==='critical')damage=criticalDamage(damage,attacker,target);
  return {kind,damage:Math.max(0,damage)};
}

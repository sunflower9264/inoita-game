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
const div = (a: number, b: number) => Math.trunc(a / b);
const clampRoll = (random: () => number, minimum: number, maximum: number) =>
  minimum + Math.min(maximum - minimum, Math.max(0, Math.floor(random() * (maximum - minimum + 1))));

/** 原始防御和总防御率分别钳零，再做一次千分率乘法。 */
export function calculateEffectiveDefense(defense:number,defenseRate:number):number {
  return div(Math.max(0,defense)*(1000+Math.max(0,defenseRate)),1000);
}

/** 普通魔抗重算合并全部来源后只限制上界，负抗性仍会增加所受伤害。 */
export function calculateMagicResistance(resistance:number):number {
  return Math.min(750,resistance);
}

function criticalDamage(damage:number,attacker:PhysicalFighter,target:PhysicalFighter):number {
  return div(div(damage*(1000+attacker.criticalDamage),1000)*(1000-target.criticalDamageResistance),1000);
}
function shieldDamage(damage:number,target:PhysicalFighter):number {
  damage-=div(target.shieldBlock,target.shieldBlock+target.level*20+60);
  const defense=div(target.shieldBlock*2*(1000+(target.defenseRate??0)),1000);
  const reduction=div(1000*defense,defense+20*(target.level+3));
  const product=damage*(1000-reduction);
  return product>=-999?div(product,1000):1;
}

/** 物理命中依次判定闪避、盾牌格挡、武器格挡和暴击，再应用伤害加成与目标减伤。
 * 技能传入 skillPhysicalAttack，命中后才读取施法者未乘伤害倍率的当前物攻。
 */
export function rollPhysicalHit(attacker: PhysicalFighter, target: PhysicalFighter, random: () => number = Math.random, baseDamage=attacker.physicalAttack,extraDamageRate=0,hitRateAdjustment=0,skillPhysicalAttack?:()=>number): PhysicalHit {
  const hitRate = div(attacker.hitBase * 1000 + 20000, attacker.hitBase + target.evasionBase + 25)
    + Math.max(0, attacker.hitBonus) + 100;
  const missChance = Math.max(0, 1000 - hitRate + Math.min(750, target.evasionBonus) - hitRateAdjustment);
  const roll = clampRoll(random, 0, 999);
  if (roll < missChance) return { kind: 'miss', damage: 0 };

  const difference = attacker.level - target.level;
  const levelAdvantage = Math.sign(difference) * div(Math.abs(difference) * 1000, 100 + Math.abs(difference));
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
  let damage = div(baseDamage*(1000+(attacker.physicalDamageRate??0)+stealthRate+extraDamageRate+(attacker.zealotRate??0)),1000);
  if(attacker.stealthAttackEnabled&&skillPhysicalAttack)
    damage+=div(skillPhysicalAttack()*(1000+stealthRate),1000);
  if (kind === 'weapon-block') damage = div(damage * 700, 1000);
  damage = div(damage * (1000 - target.physicalResistance), 1000);
  if (kind === 'shield-block') damage = shieldDamage(damage,target);
  if (kind === 'critical') damage = criticalDamage(damage,attacker,target);
  return { kind, damage: Math.max(0, damage) };
}

/** 魔法命中判定闪避、盾牌格挡和暴击；伤害读取施法者的魔法加成与目标的魔法减伤。 */
export function rollMagicHit(attacker:PhysicalFighter,target:PhysicalFighter,baseDamage:number,random:()=>number=Math.random,extraDamageRate=0):PhysicalHit {
  const hitRate=div(attacker.hitBase*1000+20000,attacker.hitBase+target.evasionBase+25)+Math.max(0,attacker.hitBonus)+100;
  const missChance=Math.max(0,1000-hitRate+Math.min(750,target.evasionBonus));
  const roll=clampRoll(random,0,999);
  if(roll<missChance)return {kind:'miss',damage:0};
  const difference=attacker.level-target.level;
  const advantage=10*div(Math.abs(difference),100+Math.abs(difference));
  let kind:PhysicalHit['kind']='hit';
  const shield=target.shieldBlock>0?Math.max(0,target.shieldBlock-advantage):0;
  if(roll<missChance+shield)kind='shield-block';
  else if(attacker.criticalRate+advantage-target.criticalResistance>0&&roll<missChance+shield+attacker.criticalRate+advantage-target.criticalResistance)kind='critical';
  let damage=div(baseDamage*(1000+(attacker.magicDamageRate??0)+extraDamageRate),1000);
  damage=div(damage*(1000-(target.magicResistance??0)),1000);
  if(kind==='shield-block')damage=shieldDamage(damage,target);
  if(kind==='critical')damage=criticalDamage(damage,attacker,target);
  return {kind,damage:Math.max(0,damage)};
}

import {LOGIC_FRAME_MS,type BattleBuffEffect,type SummonOwnerDerivation} from './battle.ts';
import type {PrimaryAttributes} from './character-stats.ts';

/** 配置倍率以千分数存放（1000 = 原值 / 100%）。 */
const PER_THOUSAND = 1000;

/** 召唤物按主人等级派生的属性；未列出的属性沿用召唤物自身的数据。 */
export interface SummonStats {
  maxHealth:number;
  physicalAttack?:number;
  magicAttack?:number;
  physicalResistanceBonus:number;
  magicResistance:number;
  /** 五维取主人：原版私有动作的公式角色列与五维都按主人算，召唤物自己的五维是 0。 */
  primaryAttributes?:PrimaryAttributes;
}

/**
 * 原版 CHAR_GetAttrFromSummonMonster：召唤物攻击取「每级×主人等级＋基础」再乘本等级倍率，
 * 生命上限取「每级×主人等级＋基础」，两项抗性直接取固定值。倍率本身不含 +1000。
 */
export function summonOwnerStats(derivation:SummonOwnerDerivation,
  rank:{attackRatePerThousand?:number;healthRatePerThousand?:number},ownerLevel:number,
  ownerAttributes?:PrimaryAttributes):SummonStats {
  const attack=Math.trunc((derivation.attack.perLevel*ownerLevel+derivation.attack.flat)*(rank.attackRatePerThousand??PER_THOUSAND)/PER_THOUSAND);
  return {
    [derivation.attack.attribute]:attack,
    maxHealth:Math.trunc((derivation.health.perLevel*ownerLevel+derivation.health.flat)*(PER_THOUSAND+(rank.healthRatePerThousand??0))/PER_THOUSAND),
    physicalResistanceBonus:derivation.physicalResistanceBonus,
    magicResistance:derivation.magicResistance,
    ...(ownerAttributes?{primaryAttributes:{...ownerAttributes}}:{}),
  };
}

/** 原版 CHAR_Act_Summon 的寿命输入：按主人属性线性换算，再乘 15/10 截断成帧。 */
export function summonLifetimeFrames(rule:{perPoint:number;base:number},ownerValue:number):number {
  return Math.trunc(Math.trunc((ownerValue*rule.perPoint+rule.base)/PER_THOUSAND)*15/10);
}

/**
 * 自然之精灵那一条链的换算：直接在上限帧上乘 (1000+主人比例)/1000，只取整一次。
 * 与兽的两次取整顺序不同，所以两者不能共用一个函数。
 */
export function ownerRateFrames(baseFrames:number,ownerRate:number):number {
  return Math.trunc(baseFrames*(PER_THOUSAND+ownerRate)/PER_THOUSAND);
}

/** 施放时按施法者的召唤持续加成定下这份 Buff 的寿命上限；脉冲间隔是 Buff 自身的节奏，不跟着放大。 */
export function scaledBuffEffect(effect:BattleBuffEffect,ownerRate:number):BattleBuffEffect {
  const rule=effect.durationRateFromOwner;
  if(!rule)return effect;
  return withLifetimeFrames(effect,ownerRateFrames(rule.baseFrames,ownerRate));
}

/** 把寿命上限改写成给定帧数，时长跟着换算，其余字段照抄。 */
export function withLifetimeFrames(effect:BattleBuffEffect,frames:number):BattleBuffEffect {
  return {...effect,durationMs:(frames+1)*LOGIC_FRAME_MS,simulationFrames:{...effect.simulationFrames!,lastActiveFrame:frames}};
}

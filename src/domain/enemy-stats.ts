import type { EnemyDefinition } from './battle.ts';

export const MAX_ENEMY_LEVEL = 107;
/** 主角等级上限，与原版成长表一致。 */
const MAX_PLAYER_LEVEL = 105;
/** 模拟队伍人数上限。 */
const MAX_PARTY_SIZE = 3;
/** 百分比换算基数。 */
const PERCENT = 100;
/** 概率和比率统一用千分数：1000 表示 100%。 */
const PER_MILLE = 1000;
/** 命中基础式最后追加的 100‰ 基础命中。 */
const BASE_HIT_RATE_PER_MILLE = 100;
/** 精英怪生命为基础值的 360%，物理和魔法攻击为 120%。 */
const ELITE_HEALTH_PERCENT = 360;
const ELITE_ATTACK_PERCENT = 120;
/** 队伍每多一名成员，生命和攻击再加 20%；经验则相应减少 20%。 */
const PARTY_SCALING_PERCENT_PER_MEMBER = 20;
/** 等级差经验修正：最多低 8 级、高 5 级，每差一级加减 10%。 */
const EXPERIENCE_LEVEL_ADVANTAGE_MIN = -8;
const EXPERIENCE_LEVEL_ADVANTAGE_MAX = 5;
const EXPERIENCE_LEVEL_STEP_PERCENT = 10;
/** 闪避加成和魔法抗性上限 750‰。 */
const MAX_RESISTANCE_PER_MILLE = 750;
/** 比率统一用千分数：100 表示 10%。 */
export interface EnemyAttributes {
  maxMana:number;
  physicalAttack:number; magicAttack:number;
  defense:number; defenseRate:number;
  physicalResistanceBonus:number; magicResistance:number;
  hitBonus:number; evasionBonus:number;
  criticalRate:number; criticalResistance:number; criticalDamageResistance:number; criticalDamage:number;
  weaponBlock:number; shieldBlock:number;
}
interface EnemyStats extends EnemyAttributes {
  level:number; sceneLevel:boolean; elite:boolean; partySize:number;
  maxHealth:number; hitBase:number; evasionBase:number;
  hitRate:number; evasionRate:number; physicalResistance:number;
  /** 原版基础经验，以及按存活人数和主角等级差修正后的预览。 */
  baseExperience:number; experience:number;
}
export interface EnemySnapshot extends EnemyStats { id:string; name:string; health:number; mana:number }
interface EnemyStatsOptions { level?:number; sceneLevel?:number; elite?:boolean; partySize?:number; playerLevel?:number }

function enemyLevel(value:number):number {
  if(!Number.isInteger(value)||value<1||value>MAX_ENEMY_LEVEL)throw new Error(`怪物等级需要是 1–${MAX_ENEMY_LEVEL} 的整数`);
  return value;
}
export function enemyPartySize(value:number):number {
  if(!Number.isInteger(value)||value<1||value>MAX_PARTY_SIZE)throw new Error('模拟队伍人数需要是 1–3 的整数');
  return value;
}
/** 读取原版基础值后依次应用精英、队伍和显示公式；不修改内容定义。 */
export function calculateEnemy(definition:EnemyDefinition,options:EnemyStatsOptions={}):Readonly<EnemyStats> {
  const level=enemyLevel(options.level??definition.level??options.sceneLevel??1);
  const partySize=enemyPartySize(options.partySize??1),elite=options.elite??false;
  const playerLevel=options.playerLevel??1;
  if(!Number.isInteger(playerLevel)||playerLevel<1||playerLevel>MAX_PLAYER_LEVEL)throw new Error('主角等级需要是 1–105 的整数');
  const attrs=definition.attributes,trunc=Math.trunc;
  const eliteHealth=elite?trunc(definition.maxHealth*ELITE_HEALTH_PERCENT/PERCENT):definition.maxHealth;
  const elitePhysical=elite?trunc(attrs.physicalAttack*ELITE_ATTACK_PERCENT/PERCENT):attrs.physicalAttack;
  const magicAttack=elite?trunc(attrs.magicAttack*ELITE_ATTACK_PERCENT/PERCENT):attrs.magicAttack;
  const partyPercent=PERCENT+PARTY_SCALING_PERCENT_PER_MEMBER*(partySize-1);
  const maxHealth=trunc(eliteHealth*partyPercent/PERCENT),physicalAttack=trunc(elitePhysical*partyPercent/PERCENT);
  const hitBase=level*4+40,evasionBase=level+10;
  const hitRate=trunc((hitBase*PER_MILLE+20000)/(hitBase+level+35))+Math.max(0,attrs.hitBonus)+BASE_HIT_RATE_PER_MILLE;
  const evasionBonus=Math.min(MAX_RESISTANCE_PER_MILLE,attrs.evasionBonus);
  const evasionRate=Math.min(MAX_RESISTANCE_PER_MILLE,PER_MILLE+evasionBonus-trunc((5000*level+1000000)/(5*level+evasionBase+1200)));
  const defense=trunc(attrs.defense*(PER_MILLE+attrs.defenseRate)/PER_MILLE);
  const physicalResistance=trunc(PER_MILLE*defense/(defense+20*(level+3)))+attrs.physicalResistanceBonus;
  const baseExperience=attrs.physicalAttack*10+definition.maxHealth;
  const partyExperience=trunc(baseExperience*(PERCENT-PARTY_SCALING_PERCENT_PER_MEMBER*(partySize-1))/PERCENT);
  const levelDifference=Math.max(EXPERIENCE_LEVEL_ADVANTAGE_MIN,Math.min(EXPERIENCE_LEVEL_ADVANTAGE_MAX,level-playerLevel));
  const experience=partyExperience<1?0:trunc(partyExperience*(PERCENT+levelDifference*EXPERIENCE_LEVEL_STEP_PERCENT)/PERCENT);
  return Object.freeze({...attrs,level,sceneLevel:options.level===undefined&&definition.level===null,elite,partySize,
    maxHealth,physicalAttack,magicAttack,defense,hitBase,evasionBase,hitRate,evasionBonus,evasionRate,
    physicalResistance,magicResistance:Math.min(MAX_RESISTANCE_PER_MILLE,attrs.magicResistance),baseExperience,experience});
}

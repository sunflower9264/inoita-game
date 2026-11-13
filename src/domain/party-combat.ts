import type { BattleCatalog, SkillGrowthProfile, SkillLoadout } from './battle.ts';
import type { CompanionGroupEffect } from './companion-progression.ts';
import { passiveModifiers, type PassiveModifier } from './passive-skills.ts';

/** 百分比换算基数。 */
const PERCENT_SCALE = 100;
/** 生命低于上限 30% 时触发佣兵团低血量抗性。 */
const LOW_HEALTH_THRESHOLD_PERCENT = 30;
/** 佣兵团概率效果沿用原版 1..999 掷点，严格小于千分比阈值才成功。 */
const NATIVE_CHANCE_ROLL_MAX = 999;

interface MemberCombatModifierInput {
  catalog:BattleCatalog;
  classId:string;
  loadout:SkillLoadout;
  weaponKind:string;
  armorKind:string;
  health:number;
  maxHealth:number;
  groupEffects:Partial<Record<CompanionGroupEffect,number>>;
  stealthed?:boolean;
  growth?:SkillGrowthProfile;
}

/** 角色常驻修正的唯一组装入口：职业被动在前，佣兵团技能在后。 */
export function memberCombatModifiers(input:MemberCombatModifierInput):PassiveModifier[]{
  return [
    ...passiveModifiers(input.catalog,input.classId,input.loadout,input.weaponKind,input.stealthed??false,input.growth??'hero'),
    ...partyCombatModifiers(input.groupEffects,input.weaponKind,input.armorKind,input.health,input.maxHealth)
  ];
}

export function partyCombatModifiers(effects:Partial<Record<CompanionGroupEffect,number>>,weapon:string,armor:string,health:number,maxHealth:number):PassiveModifier[]{
  const result:PassiveModifier[]=[];
  const add=(attribute:PassiveModifier['attribute'],value:number|undefined)=>{if(value)result.push({attribute,operation:{kind:'add',amount:value}});};
  if(health<=Math.floor(maxHealth*LOW_HEALTH_THRESHOLD_PERCENT/PERCENT_SCALE)){
    add('physicalResistanceBonus',effects['low-health-resistance']);add('magicResistance',effects['low-health-resistance']);
  }
  if(weapon==='longsword'){add('physicalDamageRate',effects['sword-damage']);add('magicDamageRate',effects['sword-damage']);}
  if(armor==='plate')add('defenseRate',effects['plate-defense']);
  if(armor==='leather')add('physicalDamageRate',effects['leather-physical-damage']);
  if(armor==='cloth')add('magicDamageRate',effects['cloth-magic-damage']);
  if(weapon==='bow'||weapon==='crossbow')add('physicalDamageRate',effects['bow-damage']);
  if(weapon==='two-handed')add('physicalDamageRate',effects['two-hand-damage']);
  add('magicDamageRate',effects['magic-damage']);add('magicResistance',effects['magic-resistance']);
  add('criticalDamage',effects['critical-damage']);return result;
}
export function partyProcSucceeds(chance:number,random:()=>number=Math.random):boolean{
  return chance>0&&1+Math.floor(random()*NATIVE_CHANCE_ROLL_MAX)<chance;
}

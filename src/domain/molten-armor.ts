import {attackSplashTargets} from './attack-splash.ts';
import type {Combatant} from './combat.ts';
import {calculateEffectiveDefense} from './physical-hit.ts';
import type {Point} from './navigation.ts';

/** 原版触发掷点是 1..999。 */
const NATIVE_ROLL_MAX = 999;
/** 熔岩护甲反击以受击点为中心，波及 4 格内的敌人。 */
const MOLTEN_SPLASH_RANGE_UNITS = 4;
/** 反射伤害按触发比例的一半结算。 */
const REFLECTION_HALF_DIVISOR = 2;

type MoltenDefenseSource=
  | {kind:'character';defense:number;defenseRate:number}
  | {kind:'monster';physicalAttack:number};

export function moltenReflectionDamage(source:MoltenDefenseSource,ratePerThousand:number):number {
  const basis=source.kind==='monster'?Math.max(0,source.physicalAttack):calculateEffectiveDefense(source.defense,source.defenseRate);
  return Math.trunc(basis*Math.max(0,ratePerThousand)/1000);
}

/** Zero thresholds still consume the native 1..999 roll; zero damage can succeed. */
export function rollMoltenSplash(reflection:number,chanceThreshold:number,random:()=>number=Math.random):number|undefined {
  return 1+Math.floor(random()*NATIVE_ROLL_MAX)<chanceThreshold?Math.trunc(reflection/REFLECTION_HALF_DIVISOR):undefined;
}

/** Candidate order is actor registration order. The original attacker can occupy one of 16 slots. */
export function moltenSplashTargets(source:Combatant,center:Point,candidates:readonly Combatant[],attackerId:string):Combatant[] {
  return attackSplashTargets(source,center,candidates,MOLTEN_SPLASH_RANGE_UNITS).filter(target=>target.id!==attackerId);
}

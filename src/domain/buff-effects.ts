import type { BattleBuffEffect } from './battle-buff-types.ts';

/** Collect assets from the buff and every child it can create during combat. */
export function buffEffectNames(effect:BattleBuffEffect):string[] {
  return [
    ...(effect.loopEffects??[]).map(loop=>loop.effect),
    ...effect.applicationEffect?[effect.applicationEffect]:[],
    ...effect.periodic.flatMap(tick=>tick.kind==='visual'?[tick.effect]:
      tick.kind==='magic-curse'&&tick.healEffect?[tick.healEffect]:[]),
    ...(effect.reactions??[]).flatMap(reaction=>'buff' in reaction?buffEffectNames(reaction.buff.effect):[]),
  ];
}

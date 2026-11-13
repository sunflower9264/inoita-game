import type { CharacterPanel } from '../domain/character-stats.ts';

/** 原版比率按千分之一存：1000 表示 100.0%，显示百分比时除以 10。 */
const THOUSANDTHS_PER_PERCENT = 10;

/** Native character-menu order; rates are stored in thousandths. */
export function characterCombatValues(panel: CharacterPanel): string[] {
  const percent = (value: number) => `${(value / THOUSANDTHS_PER_PERCENT).toFixed(1)}%`;
  return [String(panel.physicalAttack), String(panel.magicAttack), percent(panel.criticalRate),
    percent(panel.hitRate), percent(panel.criticalDamage), String(panel.defense),
    percent(panel.physicalResistance), percent(panel.magicResistance), percent(panel.evasionRate),
    percent(panel.weaponBlock), percent(panel.shieldBlock)];
}

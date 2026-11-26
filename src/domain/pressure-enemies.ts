import type { EnemyDefinition } from './battle.ts';

export const PRESSURE_DEFAULT_MAX_ENEMIES = 40;
export const PRESSURE_MIN_ENEMIES = 0;
export const PRESSURE_MAX_ENEMIES_LIMIT = 100;
export const PRESSURE_MIN_HEALTH = 1;
export const PRESSURE_MAX_HEALTH_LIMIT = 99_999_999;

export interface PressureSettings {
  /** 同屏普通怪数量上限（0–100，默认 40）。 */
  maxEnemies: number;
  /** 固定最大血量；undefined 表示按原版等级公式计算。 */
  enemyMaxHealth?: number;
}

export function defaultPressureSettings(): PressureSettings {
  return { maxEnemies: PRESSURE_DEFAULT_MAX_ENEMIES, enemyMaxHealth: undefined };
}

export function normalizePressureMaxEnemies(value: number): number {
  if (!Number.isFinite(value)) return PRESSURE_DEFAULT_MAX_ENEMIES;
  return Math.max(PRESSURE_MIN_ENEMIES, Math.min(PRESSURE_MAX_ENEMIES_LIMIT, Math.trunc(value)));
}

export function normalizePressureEnemyHealth(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.max(PRESSURE_MIN_HEALTH, Math.min(PRESSURE_MAX_HEALTH_LIMIT, Math.trunc(value)));
}

/** 按主角等级选择挑战模式可战斗的普通怪。 */
export function pressureEnemy(enemies: readonly EnemyDefinition[], level: number, random = Math.random): EnemyDefinition | undefined {
  const eligible = enemies.filter(enemy => enemy.level !== null && !enemy.specialRank && !enemy.displayOnlyReason
    && enemy.basicAttack && enemy.actor.collision && enemy.behavior.canMove && enemy.behavior.aggression !== 'none');
  if (!eligible.length) return undefined;
  let candidates = eligible.filter(enemy => Math.abs(enemy.level! - level) <= 2);
  if (!candidates.length) {
    const nearest = Math.min(...eligible.map(enemy => Math.abs(enemy.level! - level)));
    candidates = eligible.filter(enemy => Math.abs(enemy.level! - level) === nearest);
  }
  return candidates[Math.floor(random() * candidates.length)];
}

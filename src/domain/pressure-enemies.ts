import type { EnemyDefinition } from './battle.ts';

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

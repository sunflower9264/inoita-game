import type { CombatUnit } from './battle.ts';

/** 一次技能结算最多处理的目标数，包含重复命中的目标。 */
export const MAX_SKILL_TARGETS = 16;

export type SkillUnitOutcome = 'success' | 'failure' | 'skipped';

export interface ResolvedSkillUnit {
  cueIndex: number;
  targetId: string;
  outcome: SkillUnitOutcome;
}

interface SkillUnitSequencePort {
  /** Query when this cue starts; the caller owns target selection and reuse. */
  targets(cueIndex: number): readonly string[];
  /** Prepare after target selection, including an empty or reused list, and before any target attempt. */
  prepare?(cueIndex: number): void;
  /** Skipped means no attempt, such as a target that has left the battle. */
  unit(cueIndex: number, targetId: string): SkillUnitOutcome;
  /** Runs before the next target or cue, including when this sequence skips one. */
  resolved?(result: ResolvedSkillUnit): void;
}

/** One direct execution or one transition arrival has its own failure history. */
export function resolveSkillUnitSequence(
  units: readonly Pick<CombatUnit, 'effect'>[],
  port: SkillUnitSequencePort,
): ResolvedSkillUnit[] {
  const failedTargets: string[] = [];
  const results: ResolvedSkillUnit[] = [];
  for (const [cueIndex, unit] of units.entries()) {
    const bypassFailure = unit.effect === 'set-attribute' || unit.effect === 'clear-attribute';
    const targets = port.targets(cueIndex).slice(0, MAX_SKILL_TARGETS);
    port.prepare?.(cueIndex);
    for (const targetId of targets) {
      const outcome = !bypassFailure && failedTargets.includes(targetId)
        ? 'skipped' : port.unit(cueIndex, targetId);
      // 无视失败状态的单位可以再次失败；重复的目标同样占用名额。
      if (outcome === 'failure' && failedTargets.length < MAX_SKILL_TARGETS) failedTargets.push(targetId);
      const result = { cueIndex, targetId, outcome };
      results.push(result);
      port.resolved?.(result);
    }
  }
  return results;
}

import type { AreaShape, SkillEffectCue } from './battle.ts';
import { targetDistance } from './basic-attack.ts';
import { attackSplashTargets, selectAttackSplashCenter } from './attack-splash.ts';
import { canTargetCombatant, type Combatant } from './combatant.ts';
import type { Facing } from './content.ts';
import { selectHealTarget, type HealSlot } from './heal-target.ts';
import type { Point } from './navigation.ts';
import { partyBuffTargets, type PartyBuffSlot } from './party-buff-targets.ts';

function resolveTargetArea(
  caster: Combatant,
  current: Combatant | undefined,
  candidates: Combatant[],
  rangeUnits: number,
  fallbackCenter: Point = caster.position,
): { targets: Combatant[]; selectedTargetId?: string } {
  const selection = selectAttackSplashCenter(caster, current ? [current] : candidates, rangeUnits, { currentTargetId: current?.id });
  const center = selection.targetId ? selection.center : fallbackCenter;
  return { targets: attackSplashTargets(caster, center, candidates, rangeUnits), selectedTargetId: selection.targetId };
}

export function areaShapeMaxReachPx(shape: AreaShape | undefined, fallbackPx: number): number {
  if (!shape) return fallbackPx;
  if (shape.kind === 'line') return Math.max(fallbackPx, shape.lengthPx);
  if (shape.kind === 'sector') return Math.max(fallbackPx, shape.radiusPx);
  if (shape.kind === 'cross') return Math.max(fallbackPx, shape.lengthPx, shape.verticalLengthPx ?? shape.lengthPx);
  return Math.max(fallbackPx, shape.forwardOffsetPx + shape.radiusPx);
}

function facingVector(facing: Facing = 'south'): Point {
  if (facing === 'east') return { x: 1, y: 0 };
  if (facing === 'west') return { x: -1, y: 0 };
  if (facing === 'north') return { x: 0, y: -1 };
  return { x: 0, y: 1 };
}

function resolveShapedAreaTargets(
  shape: AreaShape,
  caster: Combatant,
  selected: Combatant | undefined,
  pool: readonly Combatant[],
  bonusPx: number,
): { actor: Combatant; distance: number }[] {
  const center = caster.position;
  const cardinal = facingVector(caster.facing);
  let axis = cardinal;
  if (selected && selected.team !== caster.team && (shape.kind === 'line' || shape.kind === 'front-circle')) {
    const sx = selected.position.x - center.x;
    const sy = selected.position.y - center.y;
    const sDist = Math.hypot(sx, sy);
    const sForward = sx * cardinal.x + sy * cardinal.y;
    const maxAim = (shape.kind === 'line' ? shape.lengthPx : shape.forwardOffsetPx + shape.radiusPx) + bonusPx;
    if (sDist > 1 && sDist <= maxAim && sForward >= 0) {
      axis = { x: sx / sDist, y: sy / sDist };
    }
  }
  const hits: { actor: Combatant; distance: number }[] = [];
  if (shape.kind === 'line') {
    const length = shape.lengthPx + bonusPx;
    const backSlack = shape.backSlackPx ?? 6;
    for (const actor of pool) {
      const dx = actor.position.x - center.x;
      const dy = actor.position.y - center.y;
      const forward = dx * axis.x + dy * axis.y;
      const perp = Math.abs(dx * axis.y - dy * axis.x);
      if (forward >= -backSlack && forward <= length && perp <= shape.halfWidthPx) {
        hits.push({ actor, distance: Math.max(0, forward) + perp * 0.25 });
      }
    }
    return hits;
  }
  if (shape.kind === 'sector') {
    const radius = shape.radiusPx + bonusPx;
    const backSlack = shape.backSlackPx ?? 6;
    const halfRad = (Math.min(360, Math.max(1, shape.angleDeg)) * 0.5 * Math.PI) / 180;
    for (const actor of pool) {
      const dx = actor.position.x - center.x;
      const dy = actor.position.y - center.y;
      const dist = Math.hypot(dx, dy);
      if (dist > radius) continue;
      const forward = dx * cardinal.x + dy * cardinal.y;
      const perp = Math.abs(dx * cardinal.y - dy * cardinal.x);
      const inCone = dist <= backSlack
        || Math.atan2(perp, forward) <= halfRad + 1e-6
        || (shape.angleDeg >= 180 && forward >= -backSlack);
      if (inCone) hits.push({ actor, distance: dist });
    }
    return hits;
  }
  if (shape.kind === 'cross') {
    const horizLen = shape.lengthPx + bonusPx;
    const vertLen = (shape.verticalLengthPx ?? shape.lengthPx) + bonusPx;
    for (const actor of pool) {
      const dx = actor.position.x - center.x;
      const dy = actor.position.y - center.y;
      const ax = Math.abs(dx);
      const ay = Math.abs(dy);
      if ((ax <= horizLen && ay <= shape.halfWidthPx) || (ay <= vertLen && ax <= shape.halfWidthPx)) {
        hits.push({ actor, distance: Math.hypot(dx, dy) });
      }
    }
    return hits;
  }
  const impactX = center.x + axis.x * shape.forwardOffsetPx;
  const impactY = center.y + axis.y * shape.forwardOffsetPx;
  const radius = shape.radiusPx + bonusPx;
  for (const actor of pool) {
    const dist = Math.hypot(actor.position.x - impactX, actor.position.y - impactY);
    if (dist <= radius) hits.push({ actor, distance: dist });
  }
  return hits;
}

export function resolveCueTargets(
  cue: Pick<SkillEffectCue, 'target' | 'targetRangePx' | 'targetRangeMetric' | 'areaShape' | 'maxTargets'>,
  caster: Combatant,
  selected: Combatant | undefined,
  candidates: Combatant[],
  partySlots: readonly (PartyBuffSlot<Combatant> | undefined)[] = [],
  rangeBonusUnits = 0,
  healScore?: (actorId: string) => number | undefined,
  healCandidates?: readonly HealSlot<Combatant>[],
): Combatant[] {
  const bonusPx = rangeBonusUnits > 0 ? rangeBonusUnits * 8 : 0;
  if (bonusPx > 0) cue = { ...cue, targetRangePx: cue.targetRangePx + bonusPx };
  if (cue.target === 'self') return [caster];
  if (cue.target === 'none') return [];
  if (cue.target === 'party') return partyBuffTargets(caster, partySlots, Math.floor(cue.targetRangePx / 8));
  if (cue.target === 'party-ally') {
    return partyBuffTargets(caster, partySlots, Math.floor(cue.targetRangePx / 8))
      .filter(actor => actor.id !== caster.id);
  }
  if (cue.target === 'ally-heal') {
    const pool = healCandidates ?? partySlots.map(slot => {
      const score = slot && healScore ? healScore(slot.actor.id) : undefined;
      return slot && score !== undefined ? { ...slot, score } : undefined;
    });
    return [selectHealTarget(caster, pool, Math.floor(cue.targetRangePx / 8))];
  }
  if (cue.target === 'target-area') {
    const splashed = resolveTargetArea(caster, selected, candidates, Math.floor(cue.targetRangePx / 8)).targets;
    return cue.maxTargets !== undefined ? splashed.slice(0, cue.maxTargets) : splashed;
  }
  if (selected && !canTargetCombatant(caster, selected)) selected = undefined;
  const center = caster.position;
  if (cue.target === 'current' || cue.target === 'enemy') return selected ? [selected] : [];
  const allies = cue.target === 'ally';
  const eligible = candidates.filter(actor => (allies ? actor.team === caster.team : actor.team !== caster.team) && canTargetCombatant(caster, actor));
  if (cue.areaShape && !allies) {
    const shaped = resolveShapedAreaTargets(cue.areaShape, caster, selected, eligible, bonusPx)
      .sort((a, b) => a.distance - b.distance);
    const list = shaped.map(item => item.actor);
    return cue.maxTargets !== undefined ? list.slice(0, cue.maxTargets) : list;
  }
  const withinRange = (actor: Combatant) => cue.targetRangeMetric === 'octagonal-grid'
    ? Math.floor(targetDistance(center, actor.position) / 8) <= Math.floor(cue.targetRangePx / 8)
    : Math.hypot(center.x - actor.position.x, center.y - actor.position.y) <= cue.targetRangePx;
  const matched = eligible.filter(withinRange);
  if (cue.maxTargets === undefined) return matched;
  return [...matched]
    .sort((a, b) => Math.hypot(a.position.x - center.x, a.position.y - center.y) - Math.hypot(b.position.x - center.x, b.position.y - center.y))
    .slice(0, cue.maxTargets);
}

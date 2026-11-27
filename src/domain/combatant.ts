import type { ResolvedBasicAttack, SkillAction, SkillEffectCue } from './battle.ts';
import type { BattleStateKey } from './battle-semantics.ts';
import type { BasicAttackHand } from './basic-attack.ts';
import { combatStateCapabilities } from './combat-state.ts';
import type { ClipName, CollisionBox, Facing } from './content.ts';
import type { Point } from './navigation.ts';
import type { PreparedActionDamage } from './action-damage.ts';
import type { HealSlot } from './heal-target.ts';
import type { PartyBuffSlot } from './party-buff-targets.ts';
import type { SkillUnitOutcome } from './skill-unit-sequence.ts';

export interface Combatant {
  id: string;
  team: string;
  position: Point;
  bounds: CollisionBox;
  facing?: Facing;
  states?: readonly BattleStateKey[];
}

/** 隐身只影响敌对选取，盟友和自身仍可获得治疗及增益。 */
export function canTargetCombatant(source: Combatant, target: Combatant): boolean {
  return combatStateCapabilities(target.states ?? [], source.team !== target.team).canTarget;
}

export interface AttackContact {
  casterId: string;
  targetId: string;
  skillId?: string;
  hand?: BasicAttackHand;
  basicAttack?: ResolvedBasicAttack;
}

export interface BasicAreaContact {
  casterId: string;
  basicAttack: ResolvedBasicAttack;
  facing?: Facing;
}

export interface PlaybackSkillSelection {
  id: string;
  action: SkillAction;
  level?: number;
  manaCost?: number;
  clips?: Record<Facing, ClipName>;
}

export interface SkillUnitStart {
  casterId: string;
  skill: PlaybackSkillSelection;
  cueIndex: number;
}

export interface SkillUnitHit extends SkillUnitStart {
  targetId: string;
  preparedDamage?: PreparedActionDamage;
}

export interface SkillExecutionHost {
  actor(id: string): Combatant | undefined;
  candidates(): Combatant[];
  partySlots?(): readonly (PartyBuffSlot<Combatant> | undefined)[];
  rangeBonusUnits?(id: string): number;
  healScore?(id: string): number | undefined;
  healCandidates?(): readonly HealSlot<Combatant>[];
  prepareUnit?(event: SkillUnitStart): PreparedActionDamage | undefined;
  unit?(event: SkillUnitHit): SkillUnitOutcome;
  unitFeedback?(event: SkillUnitHit, outcome: SkillUnitOutcome, cue: SkillEffectCue): void;
  runUnitSequence?(work: () => void): void;
}

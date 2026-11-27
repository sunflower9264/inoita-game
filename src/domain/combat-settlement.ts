import { actionDamage, prepareActionDamage, type PreparedActionDamage } from './action-damage.ts';
import { runActionDispatch as executeActionDispatch } from './action-dispatch.ts';
import { passesChanceThreshold } from './action-state.ts';
import { attackSplashTargets, selectAttackSplashCenter } from './attack-splash.ts';
import { AttackProcExecutor } from './attack-proc.ts';
import {
  memberSkillGrowth,
  skillForMember,
  type ActionDispatchDefinition,
  type BattleBuffEffect,
  type BattleCatalog,
  type EnemyDefinition,
  type EnemyPlayableSkill,
  type SkillAction,
  type SkillEffectCue,
  type SkillVisualEffect,
  type SummonPlacement,
} from './battle.ts';
import type { BattleBuffKey, BattleStatKey, BattleStateKey } from './battle-semantics.ts';
import type { BattleCharacter } from './character-stats.ts';
import type { CombatActorStats } from './combat-actor-stats.ts';
import { actionDamageSource, magicNormalDamage, normalDamageForClass, physicalNormalDamage } from './combat-damage-source.ts';
import type { HitEffectStyle } from './combat-feedback.ts';
import type { CombatHitResolution } from './combat-hit-resolution.ts';
import { applyCombatOperation } from './combat-operation.ts';
import { resolvePeriodicEffect } from './combat-periodic.ts';
import { resolveHitReactionPipeline, resolveHolySacrifice } from './combat-reaction-pipeline.ts';
import {
  CombatConditions,
  type PeriodicTick,
  type ResourceCapacities,
} from './combat-conditions.ts';
import { CombatEffectExecutor } from './combat-effect-executor.ts';
import {
  canTargetCombatant,
  type AttackContact,
  type BasicAreaContact,
  type Combatant,
  type PlaybackSkillSelection,
  type SkillUnitHit,
  type SkillUnitStart,
} from './combatant.ts';
import { resolveCueTargets } from './combat-targeting.ts';
import { CombatThreatSystem, type CombatThreatActor, type CombatThreatRole } from './combat-threat-system.ts';
import { executeSkillUnits } from './combat-unit-execution.ts';
import type { ActorDefinition, CollisionBox, Facing } from './content.ts';
import { disturbanceCandidate } from './disturbance.ts';
import { enemyAwarenessRangeUnits } from './enemy-engagement.ts';
import type { EnemySnapshot } from './enemy-stats.ts';
import { equipmentStateImmunity } from './equipment-state-immunity.ts';
import { healTargetScore, type HealSlot } from './heal-target.ts';
import type { ItemCatalog } from './items.ts';
import { moltenReflectionDamage, moltenSplashTargets, rollMoltenSplash } from './molten-armor.ts';
import type { GameRectangle, Point } from './navigation.ts';
import type { CompanionMember } from './party.ts';
import type { PartyBuffSlot } from './party-buff-targets.ts';
import { partyProcSucceeds } from './party-combat.ts';
import { calculateEffectiveDefense, rollMagicHit, rollPhysicalHit, type PhysicalHit } from './physical-hit.ts';
import type { ResourceRecoveryActor, ResourceRecoveryPulse } from './combat-resources.ts';
import type { RecoveryItems } from './recovery-items.ts';
import { summonDurationMs } from './summon-lifecycle.ts';
import {
  executeBloodThirstReaction,
  resolveSkillReactions,
  type SkillReaction,
  type SkillReactionCommand,
  type SkillReactionEvent,
} from './skill-reactions.ts';
import { MAX_SKILL_TARGETS, type SkillUnitOutcome } from './skill-unit-sequence.ts';
import type { SpringBuffScope } from './springs.ts';
import {
  frameStateDurationProfile,
  resolveStateApplication,
  selectStateDurationProfile,
  type StateApplicationRequest,
} from './state-application.ts';
import {
  scaledBuffEffect,
  summonLifetimeFrames,
  summonOwnerStats,
  withLifetimeFrames,
  type SummonStats,
} from './summon-stats.ts';
import { resolveBuffReactions, type BuffReactionEvent } from './buff-reactions.ts';
import type { CombatUnit } from './battle.ts';

/** 嘲讽状态持续 30 帧；对已锁定目标缩短到 15 帧。 */
const TAUNT_FRAMES = 30;
const TAUNT_SHORTENED_FRAMES = 15;
/** 重力摆附加的眩晕固定 30 帧。 */
const PENDULUM_STUN_FRAMES = 30;
/** 治愈气息每次回复最大生命的 1/50（2%）。 */
const HEALING_ENERGY_MAX_HEALTH_DIVISOR = 50;
/** 必定命中的概率阈值；1000 表示不抽随机数。 */
const CERTAIN_CHANCE_THRESHOLD = 1000;
const ACTIVE_PARTY_SLOT_COUNT = 3;

export interface CombatArenaEnemy {
  readonly key: string;
  readonly definition: EnemyDefinition;
  readonly summonedBy?: string;
  summonRemainingMs?: number;
  summonTauntChance?: number;
  readonly summonedBySkill?: string;
  readonly bounds?: CollisionBox;
}

export interface SummonUnitSpawnRequest {
  casterId: string;
  enemyId: string;
  bounds: CollisionBox;
  casterPosition: Point;
  casterCollision: CollisionBox;
  casterFacing: Facing;
  placement: SummonPlacement;
  derivedStats?: SummonStats;
  tauntChanceThreshold?: number;
  skillId: string;
  appearanceEffects?: readonly SkillVisualEffect[];
  lifetimeMs?: number;
}

export interface CombatActionPlaybackContext {
  caster: Combatant;
  skill?: PlaybackSkillSelection;
}

export interface CombatSettlementPort {
  readonly stats: CombatActorStats;
  readonly battleCatalog: BattleCatalog;
  readonly items: ItemCatalog;
  readonly conditions: CombatConditions;
  readonly hitResolution: CombatHitResolution;
  threat?: CombatThreatSystem;
  readonly hero?: BattleCharacter;
  controlledId(): string;
  activeParty(): readonly string[];
  isClosed(): boolean;
  isDefeated(): boolean;
  enemiesRunning(): boolean;
  memberOf(id: string): BattleCharacter | CompanionMember | undefined;
  memberActorDefinition?(id: string): ActorDefinition | undefined;
  groupModifiers?(): Partial<Record<string, number>>;
  enemyOf(id: string): CombatArenaEnemy | undefined;
  allEnemies(): readonly CombatArenaEnemy[];
  enemySnapshot(id: string, definition: EnemyDefinition, heroLevel: number): Readonly<EnemySnapshot> | undefined;
  setEnemyHealth(id: string, health: number, definition: EnemyDefinition): void;
  setEnemyMana(id: string, mana: number, definition: EnemyDefinition): void;
  isEnemyPresent(id: string, enemyId?: string): boolean;
  isPendingDefeat(id: string): boolean;
  isFallen(id: string): boolean;
  hasDisplay(id: string): boolean;
  displayPosition?(id: string): Point | undefined;
  displayBounds?(id: string): CollisionBox | undefined;
  combatant(id: string): Combatant | undefined;
  combatants(): Combatant[];
  currentTargetOf(id: string): string | undefined;
  enemyTarget(id: string): string | undefined;
  setReactionTarget(actorId: string, targetId: string): void;
  resetActorCooldowns(id: string): void;
  recordSummonContact?(sourceId: string, targetId: string): void;
  navigationBounds(): GameRectangle | undefined;
  combatTick(): number;
  isOneHitKill(casterId: string): boolean;
  recoveryPulseDue(): boolean;
  advanceRecoveryClock(): void;
  activeRegeneration(): RecoveryItems['activeRegeneration'];
  recoverCombatResources(actors: readonly ResourceRecoveryActor[]): readonly ResourceRecoveryPulse[];
  onStateConsequences?(id: string, states: readonly BattleStateKey[]): void;
  onStealthBroken?(actorId: string): void;
  onActionShake?(): void;
  onActionSound?(casterId: string, sound: string): void;
  onBuffApplication?(sourceId: string, targetId: string, effect: string): void;
  onShowEffects?(actorId: string, targetId: string, effects: readonly SkillVisualEffect[]): void;
  onUnitFeedback?(hit: SkillUnitHit, outcome: SkillUnitOutcome, cue: SkillEffectCue): void;
  onShowHit?(
    event: AttackContact,
    hit: PhysicalHit,
    presentation: { style?: HitEffectStyle; periodic?: boolean; sound?: boolean },
  ): void;
  onDropMana?(casterId: string, damage: number, target: Point | undefined, rule?: 'skill' | 'weapon'): void;
  onHitRecorded?(stats: { damageDealt: number; damageTaken: number }): void;
  onInvalidateCombatants?(): void;
  onMemberDefeated?(id: string): void;
  onEnemyDamaged?(enemy: CombatArenaEnemy, before: Readonly<EnemySnapshot>, proposed: number): { interrupted: boolean; captured: boolean };
  onEnemyZeroHealth?(enemy: CombatArenaEnemy, before: Readonly<EnemySnapshot>, casterId: string): void;
  onEnemyContact?(enemy: CombatArenaEnemy, event: AttackContact): void;
  onThreatCombatStarted?(enemyKey: string): void;
  removeEnemy?(key: string): void;
  commandSummon?(summonKey: string, command: EnemyPlayableSkill, targetKey: string | undefined, level: number): void;
  spawnSummonFromUnit?(request: SummonUnitSpawnRequest): boolean;
  followUp?(kind: 'lightning-of-hell' | 'god-of-justice', casterId: string, targetId: string): void;
  isSkillPrepared?(ownerId: string, skillId: string): boolean;
  requiresPreparedSkills?(): boolean;
  random?(): number;
}

/** 创建接入资源上限同步与会话无敌/无限蓝开关的 `CombatConditions` 实例。 */
export function createCombatConditions(hooks: {
  captureResourceCapacities(id: string): ResourceCapacities;
  onApply(id: string, effect: BattleBuffEffect, entry: Readonly<ResourceCapacities>): void;
  isInvincible(id: string): boolean;
  setInvincible(id: string, enabled: boolean): void;
  isInfiniteMana(id: string): boolean;
  setInfiniteMana(id: string, enabled: boolean): void;
}): CombatConditions {
  return new CombatConditions(
    {
      captureResourceCapacities: hooks.captureResourceCapacities,
      onApply: hooks.onApply,
    },
    {
      has: hooks.isInvincible,
      add: id => hooks.setInvincible(id, true),
      delete: id => hooks.setInvincible(id, false),
    },
    {
      has: hooks.isInfiniteMana,
      add: id => hooks.setInfiniteMana(id, true),
      delete: id => hooks.setInfiniteMana(id, false),
    },
  );
}

export function summonCommandAction(owner: string, command: EnemyPlayableSkill): SkillAction {
  return memberSkillGrowth(owner) === 'companion' ? (command.companionAction ?? command.action) : command.action;
}

/**
 * 纯领域战斗结算引擎（零 Phaser 依赖）：
 * 承载普攻/范围命中、受击反应链、技能单元、状态/增益施加、治疗评分、仇恨与周期恢复结算。
 */
export class CombatSettlementEngine {
  private readonly port: CombatSettlementPort;
  /** 原版角色位 +0xc 的 bit2：打出过伤害后置位、初始化时清零，治疗选人据此降低优先级。 */
  private readonly dealtDamage = new Set<string>();
  private readonly attackProcs = new AttackProcExecutor();
  private effectExecutor?: CombatEffectExecutor;

  constructor(port: CombatSettlementPort) {
    this.port = port;
  }

  private get stats(): CombatActorStats {
    return this.port.stats;
  }

  private get heroLevel(): number {
    return this.port.hero?.level ?? 1;
  }

  private random(): number {
    return (this.port.random ?? Math.random)();
  }

  hasDealtDamage(id: string): boolean {
    return this.dealtDamage.has(id);
  }

  forgetDealtDamage(id: string): void {
    this.dealtDamage.delete(id);
  }

  clear(): void {
    this.dealtDamage.clear();
  }

  setThreatSystem(threat: CombatThreatSystem): void {
    this.port.threat = threat;
  }

  applyBuffResources(id: string, effect: BattleBuffEffect, entry: Readonly<ResourceCapacities>): void {
    for (const application of effect.onApply ?? []) {
      if (application.kind === 'restore-health-from-max-health') {
        const amount = applyCombatOperation(entry.maxHealth, application.operation) - entry.maxHealth;
        if (amount > 0) this.restoreHealth(id, amount);
      } else {
        // 立即给当前 MP 加这份定值；满蓝时按上限夹取，不改变结果的成功与否。
        const amount = Math.max(0, application.value);
        if (amount > 0) this.restoreMana(id, amount);
      }
    }
  }

  createThreatSystem(): CombatThreatSystem {
    return new CombatThreatSystem({
      actor: id => this.threatActor(id),
      actors: () =>
        [...this.port.activeParty(), ...this.port.allEnemies().map(enemy => enemy.key)].flatMap(id => {
          const actor = this.threatActor(id);
          return actor ? [actor] : [];
        }),
      currentTarget: id => this.port.enemyTarget(id),
      logicTick: () => this.port.combatTick(),
      generationRate: id => this.stats.actorAttribute(id, 'threatGenerationRate'),
      reductionRate: id => this.stats.actorAttribute(id, 'threatReductionRate'),
      normalDamage: id => {
        const attributes = this.stats.actorAttributes(id);
        return attributes
          ? { physical: physicalNormalDamage(attributes), magic: magicNormalDamage(attributes) }
          : { physical: 0, magic: 0 };
      },
      tauntSource: id => this.port.conditions.snapshot(id).find(state => state.kind === 'state' && state.id === 'taunted')?.sourceId,
      applyTaunt: (source, target) => this.applyTaunt(source, target),
      combatStarted: id => this.port.onThreatCombatStarted?.(id),
    });
  }

  threatActor(id: string): CombatThreatActor | undefined {
    if (!this.port.hasDisplay(id)) return;
    const member = this.port.memberOf(id);
    const enemy = this.port.enemyOf(id);
    if (!member && !enemy) return;
    const active = this.port.combatant(id);
    const state = member?.player ?? (enemy && this.port.enemySnapshot(id, enemy.definition, this.heroLevel));
    if (!state) return;
    const bounds =
      active?.bounds ??
      this.port.displayBounds?.(id) ??
      this.port.memberActorDefinition?.(id)?.collision ??
      enemy?.bounds ??
      enemy?.definition.actor.collision;
    const position = active?.position ?? this.port.displayPosition?.(id) ?? { x: 0, y: 0 };
    if (!bounds) return;
    const friendly = !!(member || this.port.memberOf(enemy?.summonedBy ?? ''));
    // `player` 必须先判：`memberOf('player')` 也成立。
    const role: CombatThreatRole = id === 'player' ? 'player' : member ? 'member' : friendly ? 'summon' : 'enemy';
    return {
      id,
      team: friendly ? 'party' : 'hostile',
      position,
      bounds,
      states: this.port.conditions.activeStates(id),
      active: !!active,
      level: state.level,
      role,
      tracksThreat: !friendly,
      sightRangeUnits: enemy
        ? enemyAwarenessRangeUnits(
            enemy.definition.behavior,
            enemy.definition.behavior.engagement === 'map-wide' ? this.port.navigationBounds() : undefined,
            this.stats.actorAttribute(id, 'sightBonusUnits'),
          )
        : this.stats.actorAttribute(id, 'sightBonusUnits'),
    };
  }

  applyTaunt(sourceId: string, targetId: string): void {
    const decision = resolveStateApplication({ ...this.stateApplicationRequest(sourceId, targetId, 'taunted'), kind: 'buff' });
    if (!decision.allowed) return;
    const lifetime = selectStateDurationProfile(
      { normal: { lastActiveFrame: TAUNT_FRAMES }, targetShortened: { lastActiveFrame: TAUNT_SHORTENED_FRAMES } },
      decision,
    );
    this.port.conditions.applyStateFrames(targetId, 'taunted', lifetime.lastActiveFrame, sourceId);
  }

  activePartySlots(): string[] {
    return this.port.activeParty().slice(0, ACTIVE_PARTY_SLOT_COUNT).filter(id => {
      const member = this.port.memberOf(id);
      return (
        !!member &&
        !this.port.isFallen(id) &&
        !this.port.isPendingDefeat(id) &&
        (member.player.health > 0 || this.port.hitResolution.isAwaitingDefeat(id))
      );
    });
  }

  partyBuffSlots(): readonly (PartyBuffSlot<Combatant> | undefined)[] {
    return this.port.activeParty().slice(0, ACTIVE_PARTY_SLOT_COUNT).map(id => {
      const actor = this.port.combatant(id);
      if (!actor) return undefined;
      return {
        actor,
        active:
          !this.port.isFallen(id) &&
          ((this.port.memberOf(id)?.player.health ?? 0) > 0 || this.port.hitResolution.isAwaitingDefeat(id)),
        hasDisplay: this.port.hasDisplay(id),
      };
    });
  }

  healScoreFor(id: string): number | undefined {
    const member = this.port.memberOf(id);
    const enemy = member ? undefined : this.port.enemyOf(id);
    const health = member?.player.health ?? (enemy ? this.port.enemySnapshot(id, enemy.definition, this.heroLevel)?.health : undefined);
    if (health === undefined) return undefined;
    return healTargetScore(health, this.stats.readResourceCapacity(id, 'maxHealth'), this.dealtDamage.has(id));
  }

  healCandidates(): readonly HealSlot<Combatant>[] {
    const slots: HealSlot<Combatant>[] = [];
    for (const slot of this.partyBuffSlots()) {
      if (!slot) continue;
      slots.push({ ...slot, score: this.healScoreFor(slot.actor.id) });
    }
    for (const enemy of this.port.allEnemies()) {
      if (!enemy.summonedBy || !this.port.memberOf(enemy.summonedBy)) continue;
      const actor = this.port.combatant(enemy.key);
      if (!actor) continue;
      const health = this.port.enemySnapshot(enemy.key, enemy.definition, this.heroLevel)?.health ?? 0;
      slots.push({
        actor,
        active: !this.port.isPendingDefeat(enemy.key) && (health > 0 || this.port.hitResolution.isAwaitingDefeat(enemy.key)),
        hasDisplay: this.port.hasDisplay(enemy.key),
        score: this.healScoreFor(enemy.key),
      });
    }
    return slots;
  }

  partySide(id: string): boolean {
    return !!this.port.memberOf(id) || !!this.port.memberOf(this.port.enemyOf(id)?.summonedBy ?? '');
  }

  runActionDispatch(
    action: CombatActionPlaybackContext,
    definition: ActionDispatchDefinition,
    work: () => void,
    afterDispatch?: () => void,
  ): void {
    this.port.hitResolution.run(() => {
      executeActionDispatch(definition.breaksStealth, {
        isStealthed: () => this.port.conditions.hasState(action.caster.id, 'stealthed'),
        work: () => {
          work();
          if (definition.shake) this.port.onActionShake?.();
        },
        removeStealth: () => {
          this.port.conditions.removeState(action.caster.id, 'stealthed');
          this.port.onStealthBroken?.(action.caster.id);
        },
        afterStealthBreak: () => this.react({ kind: 'action-stealth-break', ownerId: action.caster.id }),
        sound: () => {
          if (definition.sound && this.port.memberOf(action.caster.id)) {
            this.port.onActionSound?.(action.caster.id, definition.sound);
          }
        },
      });
      afterDispatch?.();
    });
  }

  /** 数值单元的主人来源：私有命令动作读主人，其余读施法者自己。 */
  unitValueSourceId(casterId: string, unit: CombatUnit): string {
    if (!('ownerValues' in unit) || !unit.ownerValues) return casterId;
    return this.port.enemyOf(casterId)?.summonedBy ?? casterId;
  }

  prepareSkillUnit(event: SkillUnitStart): PreparedActionDamage | undefined {
    const unit = event.skill.action.combatUnits?.[event.cueIndex];
    if (!unit || !('source' in unit)) return;
    const sourceId = this.unitValueSourceId(event.casterId, unit);
    const member = this.port.memberOf(sourceId);
    if (!member && !this.port.enemyOf(event.casterId)) return;
    const attributes = member?.panel.attributes ?? { strength: 0, dexterity: 0, vitality: 0, intelligence: 0, mentality: 0 };
    return prepareActionDamage(unit, event.skill.level ?? 1, attributes);
  }

  commandOwnedSummons(event: SkillUnitHit): SkillUnitOutcome {
    if (!this.port.memberOf(event.casterId)) return 'success';
    const caster = this.port.combatant(event.casterId);
    if (!caster) return 'failure';
    const summons = this.port.allEnemies().filter(
      enemy => !this.port.isPendingDefeat(enemy.key) && enemy.summonedBy === event.casterId && !!enemy.definition.commandAction,
    );
    let commanded = false;
    for (const summon of summons) {
      const definition = summon.definition.commandAction;
      if (!definition) continue;
      const command = { ...definition, action: summonCommandAction(event.casterId, definition) };
      const current = this.port.enemyTarget(summon.key);
      const target =
        current &&
        this.port.allEnemies().some(enemy => {
          if (enemy.key !== current) return false;
          const targetCombatant = this.port.combatant(current);
          return !!targetCombatant && canTargetCombatant(caster, targetCombatant);
        })
          ? this.port.enemyOf(current)
          : undefined;
      this.port.commandSummon?.(summon.key, command, target?.key, event.skill.level ?? 1);
      commanded = true;
    }
    return commanded ? 'success' : 'failure';
  }

  summonFromUnit(event: SkillUnitHit, unit: Extract<CombatUnit, { effect: 'summon' }>, rank: number): SkillUnitOutcome {
    if (!unit.creature || !this.port.memberOf(event.casterId)) return 'success';
    const creature = this.port.battleCatalog.enemies.find(enemy => enemy.id === unit.creature);
    const caster = this.port.combatant(event.casterId);
    if (!creature?.actor.collision || !caster) return 'success';
    const ownerLevel = this.port.memberOf(event.casterId)?.level ?? 1;
    const rankValues = unit.ranks[rank];
    const derived = unit.ownerDerived
      ? summonOwnerStats(unit.ownerDerived, rankValues, ownerLevel, this.port.memberOf(event.casterId)?.panel.attributes)
      : undefined;
    const frames =
      unit.lifetimeFromOwner === undefined
        ? undefined
        : summonLifetimeFrames(unit.lifetimeFromOwner, this.stats.actorAttribute(event.casterId, unit.lifetimeFromOwner.attribute));
    const lifetimeMs = summonDurationMs(rankValues.durationMs, frames);
    const ok = this.port.spawnSummonFromUnit?.({
      casterId: event.casterId,
      enemyId: unit.creature,
      bounds: creature.actor.collision,
      casterPosition: caster.position,
      casterCollision: caster.bounds,
      casterFacing: caster.facing ?? 'south',
      placement: { searchGapPx: 32, searchExtentPx: 48, offsetChoices: [{ x: 0, y: 0 }], jitterPx: 0 },
      derivedStats: derived,
      tauntChanceThreshold: rankValues.tauntChanceThreshold,
      skillId: event.skill.id,
      appearanceEffects: unit.appearanceEffects,
      lifetimeMs,
    });
    return ok ? 'success' : 'failure';
  }

  skillUnit(event: SkillUnitHit): SkillUnitOutcome {
    this.port.recordSummonContact?.(event.casterId, event.targetId);
    return (this.effectExecutor ??= new CombatEffectExecutor({
      conditions: this.port.conditions,
      threat: this.port.threat,
      random: () => this.random(),
      run: work => this.port.hitResolution.run(work),
      available: id =>
        !this.port.isClosed() &&
        !this.port.isDefeated() &&
        !this.port.isPendingDefeat(id) &&
        !this.port.isFallen(id) &&
        this.isActorPresent(id),
      partySide: id => this.partySide(id),
      fighter: id => this.stats.fighterOf(id),
      position: id => this.port.combatant(id)?.position,
      vitals: id => {
        const member = this.port.memberOf(id);
        const enemy = this.port.enemyOf(id);
        return member?.player ?? (enemy && this.port.enemySnapshot(id, enemy.definition, this.heroLevel));
      },
      attribute: (id, key) => this.stats.actorAttribute(id, key),
      valueSourceId: (id, unit) => this.unitValueSourceId(id, unit),
      prepare: hit => this.prepareSkillUnit(hit),
      applyBuff: (id, key, strength, effect, source) => this.applyActorBuff(id, key, strength, effect, source),
      stateRequest: (source, target, state) => this.stateApplicationRequest(source, target, state),
      stateAccepted: (id, state) => this.port.onStateConsequences?.(id, [state]),
      commandSummons: hit => this.commandOwnedSummons(hit),
      summon: (hit, unit, rank) => this.summonFromUnit(hit, unit, rank),
      restoreHealth: (id, amount) => this.restoreHealth(id, amount),
      setMana: (id, value) => {
        const member = this.port.memberOf(id);
        const enemy = this.port.enemyOf(id);
        if (member) member.setMana(value);
        else if (enemy) this.port.setEnemyMana(id, value, enemy.definition);
      },
      healAccepted: (ownerId, targetId) => this.react({ kind: 'direct-heal-accepted', ownerId, targetId }),
      learnedBuff: (id, key) => this.stats.learnedReactionBuff(id, key),
      rearBonus: (source, target) => this.rearPenetrationBonus(source, target),
      reactions: (hit, result, kind, position) => this.resolveHitReactions(hit, result, kind, hit.skill.id, position),
      hit: (hit, result, presentation) => this.settleHit(hit, result, this.port.enemyOf(hit.targetId), presentation),
      dropMana: (id, damage, position, kind) => this.port.onDropMana?.(id, damage, position, kind),
      showHit: (hit, result, presentation) => this.port.onShowHit?.(hit, result, presentation),
    })).execute(event);
  }

  runSkillUnitSequence(request: {
    casterId: string;
    skillId: string;
    level: number;
    action: SkillAction;
    origin?: Point;
    selectedTargetId?: string;
  }): void {
    const { casterId, skillId, level, action } = request;
    const event = action.events.find(entry => entry.kind === 'units');
    executeSkillUnits(
      {
        casterId,
        skill: { id: skillId, level, action },
        cues: event?.kind === 'units' ? event.cues : [],
        origin: request.origin,
        selectedTargetId: request.selectedTargetId,
      },
      {
        actor: id => this.port.combatant(id),
        candidates: () => this.port.combatants(),
        partySlots: () => this.partyBuffSlots(),
        rangeBonusUnits: id => this.stats.actorAttribute(id, 'attackRangeBonusUnits'),
        healScore: id => this.healScoreFor(id),
        healCandidates: () => this.healCandidates(),
        currentTargetId: () => this.currentTargetOf(casterId),
        prepareUnit: start => this.prepareSkillUnit(start),
        unit: hit => this.skillUnit(hit),
        runUnitSequence: work => this.port.hitResolution.run(work),
        unitFeedback: (hit, outcome, cue) => this.port.onUnitFeedback?.(hit, outcome, cue),
      },
    );
  }

  basicAreaContact(event: BasicAreaContact): void {
    this.port.hitResolution.run(() => {
      const caster = this.port.combatant(event.casterId);
      const targeting = event.basicAttack.targeting;
      if (!caster || !targeting) return;
      const source = event.facing ? { ...caster, facing: event.facing } : caster;
      const targets = resolveCueTargets(
        targeting,
        source,
        undefined,
        this.port.combatants(),
        [],
        this.stats.actorAttribute(event.casterId, 'attackRangeBonusUnits'),
      ).slice(0, MAX_SKILL_TARGETS);
      for (const target of targets) {
        this.attackContact({ casterId: event.casterId, targetId: target.id, basicAttack: event.basicAttack });
      }
    });
  }

  attackContact(event: AttackContact): void {
    this.port.hitResolution.run(() => {
      if (
        this.port.isDefeated() ||
        this.port.isClosed() ||
        this.port.isFallen(event.casterId) ||
        this.port.isFallen(event.targetId) ||
        this.port.isPendingDefeat(event.casterId) ||
        this.port.isPendingDefeat(event.targetId)
      ) {
        return;
      }
      if (!this.isActorPresent(event.casterId) || !this.isActorPresent(event.targetId)) return;
      this.port.recordSummonContact?.(event.casterId, event.targetId);
      if (event.skillId) {
        const targetEnemy = this.port.enemyOf(event.targetId);
        if (this.port.enemiesRunning() && targetEnemy && !this.port.isPendingDefeat(event.targetId)) {
          this.port.onEnemyContact?.(targetEnemy, event);
        }
        return;
      }
      if (!this.port.conditions.canLoseHealth(event.targetId)) {
        this.port.onShowHit?.(event, { kind: 'hit', damage: 0 }, { style: event.basicAttack?.hitEffectStyle ?? 'weapon', sound: true });
        return;
      }
      const targetEnemy = this.port.enemyOf(event.targetId);
      const sourceEnemy = this.port.enemyOf(event.casterId);
      const source = this.port.memberOf(event.casterId)
        ? this.stats.partyFighter(event.casterId)
        : sourceEnemy && this.stats.enemyFighter(sourceEnemy.key, sourceEnemy.definition, this.heroLevel);
      const target = this.port.memberOf(event.targetId)
        ? this.stats.partyFighter(event.targetId)
        : targetEnemy && this.stats.enemyFighter(targetEnemy.key, targetEnemy.definition, this.heroLevel);
      if (!source || !target) return;
      const targetPosition = this.port.combatant(event.targetId)?.position;
      const sourceActor = this.port.memberOf(event.casterId)
        ? this.port.memberActorDefinition?.(event.casterId)
        : sourceEnemy?.definition.actor;
      const profile =
        event.basicAttack ??
        (this.port.memberOf(event.casterId) && sourceActor
          ? this.stats.equipmentAttack(sourceActor, event.casterId)
          : sourceEnemy?.definition.basicAttack
            ? this.port.battleCatalog.basicAttacks[sourceEnemy.definition.basicAttack.profileId]
            : undefined);
      const attributes = this.stats.actorAttributes(event.casterId);
      if (!profile || !attributes) return;
      const damageSource = actionDamageSource(attributes);
      // 背后渗透走物理伤害率那一项，先看目标当前在打谁；魔法不加。
      const rear = profile.damage.effect === 'physical' ? this.rearPenetrationBonus(event.casterId, event.targetId) : 0;
      if (event.hand === 'offhand' && profile.damage.effect === 'physical') {
        const offhandAttack = this.stats.offhandPhysicalAttackFor(event.casterId, damageSource.physicalAttack);
        if (offhandAttack === undefined) return;
        damageSource.physicalAttack = offhandAttack;
      }
      const amount = actionDamage(profile.damage, 1, damageSource);
      const hit =
        profile.damage.effect === 'magic'
          ? rollMagicHit(source, target, amount)
          : rollPhysicalHit(source, target, () => this.random(), amount, rear);
      this.resolveHitReactions(event, hit, profile.damage.effect, 'basic-attack', targetPosition);
      this.settleHit(event, hit, targetEnemy, { style: profile?.hitEffectStyle ?? 'weapon', sound: true });
      this.port.onDropMana?.(event.casterId, hit.damage, targetPosition);
      if (this.port.enemiesRunning() && targetEnemy && !this.port.isPendingDefeat(targetEnemy.key) && this.port.enemyOf(targetEnemy.key)) {
        this.port.onEnemyContact?.(targetEnemy, event);
      }
    });
  }

  isActorPresent(id: string): boolean {
    if (this.port.memberOf(id)) return true;
    const enemy = this.port.enemyOf(id);
    return !!enemy && this.port.isEnemyPresent(id, enemy.definition.id);
  }

  settleHit(
    event: AttackContact,
    hit: PhysicalHit,
    targetEnemy?: CombatArenaEnemy,
    presentation: { style?: HitEffectStyle; periodic?: boolean; sound?: boolean } = {},
  ): void {
    if (
      this.port.isPendingDefeat(event.targetId) ||
      !this.port.conditions.canLoseHealth(event.targetId) ||
      (targetEnemy && !this.port.isEnemyPresent(targetEnemy.key, targetEnemy.definition.id))
    ) {
      return;
    }
    let damageDealt = 0;
    let damageTaken = 0;
    this.port.recordSummonContact?.(event.casterId, event.targetId);
    if (hit.damage) {
      if (hit.damage > 0) this.port.conditions.removeState(event.targetId, 'sleep');
      const recipient = this.port.memberOf(event.targetId);
      if (recipient) {
        const wasAlive = recipient.player.health > 0;
        if (hit.damage > 0) this.stats.readResourceCapacity(event.targetId, 'maxHealth');
        // 读取上限可能把超过上限的生命夹回上限；伤害必须从夹紧后的生命扣除。
        const before = recipient.player.health;
        recipient.setHealth(before - hit.damage);
        const dropped = Math.max(0, Math.min(hit.damage, before));
        if (dropped > 0) damageTaken += dropped;
        if (wasAlive && recipient.player.health === 0) {
          this.port.hitResolution.deferDefeat(event.targetId, () => {
            if (recipient.player.health === 0) this.port.onMemberDefeated?.(event.targetId);
          });
        }
      } else if (targetEnemy) {
        const before = this.port.enemySnapshot(targetEnemy.key, targetEnemy.definition, this.heroLevel)!;
        // GM 一击必杀：命中后按目标当前生命结算，跳过防御与减伤；未命中的攻击仍然落空。
        if (this.port.isOneHitKill(event.casterId)) hit.damage = Math.max(hit.damage, before.health);
        const proposed = Math.max(0, before.health - hit.damage);
        const outcome =
          hit.damage > 0
            ? (this.port.onEnemyDamaged?.(targetEnemy, before, proposed) ?? { interrupted: false, captured: false })
            : { interrupted: false, captured: false };
        if (outcome.captured) {
          this.port.onHitRecorded?.({ damageDealt, damageTaken });
          this.port.removeEnemy?.(targetEnemy.key);
          return;
        }
        const remaining = outcome.interrupted ? Math.max(1, proposed) : proposed;
        this.port.setEnemyHealth(targetEnemy.key, remaining, targetEnemy.definition);
        const dropped = Math.max(0, before.health - remaining);
        if (dropped > 0) damageDealt += dropped;
        if (before.health > 0 && remaining === 0) {
          this.port.onInvalidateCombatants?.();
          this.port.hitResolution.deferDefeat(targetEnemy.key, () => {
            if (
              this.port.isClosed() ||
              this.port.isPendingDefeat(targetEnemy.key) ||
              (this.port.enemySnapshot(targetEnemy.key, targetEnemy.definition, this.heroLevel)?.health ?? 0) > 0
            ) {
              this.port.onInvalidateCombatants?.();
              return;
            }
            this.port.onEnemyZeroHealth?.(targetEnemy, before, event.casterId);
          });
        }
      }
      if (hit.damage > 0) {
        this.dealtDamage.add(event.casterId);
        this.port.threat?.damage(event.casterId, event.targetId, hit.damage);
      }
    }
    this.port.onHitRecorded?.({ damageDealt, damageTaken });
    this.port.onShowHit?.(event, hit, presentation);
  }

  resolveHitReactions(
    event: AttackContact,
    hit: PhysicalHit,
    damageKind: 'physical' | 'magic',
    actionId: string,
    targetPosition?: Point,
  ): void {
    resolveHitReactionPipeline(
      event,
      hit,
      damageKind,
      actionId,
      {
        conditions: this.port.conditions,
        actorAttribute: (id, key) => this.stats.actorAttribute(id, key),
        react: reaction => this.react(reaction),
        reactToBuff: reaction => this.reactToBuff(reaction),
        lightningOfHellReaction: (caster, target) => this.lightningOfHellReaction(caster, target),
        godOfJusticeReaction: (caster, target) => this.godOfJusticeReaction(caster, target),
        summonOwnerReactions: (contact, result, kind) => this.summonOwnerReactions(contact, result, kind),
        disturbanceReaction: (caster, target) => this.disturbanceReaction(caster, target),
        activePartySlots: () => this.activePartySlots(),
        partySide: id => this.partySide(id),
        partyRevengeReactions: (caster, kind, outcome) => this.partyRevengeReactions(caster, kind, outcome),
        equipmentRecovery: id => this.stats.equipmentRecovery(id),
        isTwoHanded: id => this.stats.isTwoHanded(id),
        moltenReflection: (contact, rate) => this.moltenReflection(contact, rate),
        holySacrificeTransfer: (contact, result, kind) => this.holySacrificeTransfer(contact, result, kind),
        physicalSuccessEquipmentProcs: (contact, result, random) => this.physicalSuccessEquipmentProcs(contact, result, random),
        instantRecoveryOnMiss: contact => this.instantRecoveryOnMiss(contact),
        attackProc: (contact, result) => this.attackProc(contact, result),
      },
      targetPosition,
    );
  }

  react(event: SkillReactionEvent): void {
    const apply = (command: SkillReactionCommand) => {
      if (command.kind === 'restore-health') this.restoreHealth(command.targetId, command.amount);
      else if (command.kind === 'restore-mana') this.restoreMana(command.targetId, command.amount);
      else if (command.kind === 'play-effect') {
        this.port.onShowEffects?.(event.ownerId, command.targetId, [
          { effect: command.effect, recipient: 'target', placement: 'attached' },
        ]);
      } else if (command.kind === 'reset-skill-cooldowns') this.port.resetActorCooldowns(command.targetId);
      else if (command.kind === 'apply-party-buff') {
        for (const id of this.activePartySlots()) {
          this.applyActorBuff(id, command.buff.key, command.buff.rankPriority, command.buff.effect, command.sourceId);
        }
      } else {
        this.applyActorBuff(command.targetId, command.buff.key, command.buff.rankPriority, command.buff.effect, command.sourceId);
      }
    };
    if (event.kind === 'blood-thirst') {
      if (this.port.requiresPreparedSkills?.() && !this.port.isSkillPrepared?.(event.ownerId, 'blood-thirst')) return;
      executeBloodThirstReaction(event, {
        random: () => this.random(),
        lifeDrainPerThousand: () => this.stats.actorAttribute(event.ownerId, 'bloodThirstLifeDrainPerThousand'),
        manaRecovery: () => this.stats.actorAttribute(event.ownerId, 'bloodThirstManaRecovery'),
        apply,
      });
      return;
    }
    let reactions: readonly SkillReaction[] = [];
    if (
      event.kind !== 'physical-attack-effects' &&
      event.kind !== 'physical-revenge' &&
      event.kind !== 'physical-instinct' &&
      event.kind !== 'physical-defense-instinct'
    ) {
      const skills = this.stats.reactionSkills(event.ownerId);
      if (!skills) return;
      reactions = skills.reactions;
    }
    const commands = resolveSkillReactions(reactions, event, {
      random: () => this.random(),
      learnedBuff: (id, skill) => this.stats.learnedReactionBuff(id, skill),
    });
    for (const command of commands) apply(command);
  }

  reactToBuff(event: BuffReactionEvent): void {
    const commands = resolveBuffReactions(this.port.conditions.activeBuffReactions(event.ownerId), event);
    for (const command of commands) {
      if (command.kind === 'apply-buff') {
        this.applyActorBuff(command.targetId, command.buff.key, command.buff.rankPriority, command.buff.effect, command.sourceId);
      } else if (command.kind === 'restore-mana') this.restoreMana(command.targetId, command.amount);
      else if (command.kind === 'play-effect') {
        this.port.onShowEffects?.(event.ownerId, command.targetId, [
          { effect: command.effect, recipient: 'target', placement: 'attached' },
        ]);
      } else if (command.kind === 'apply-state') this.applyReactionState(command);
      else this.port.threat?.redistributeAfterPhysicalHit(command.sourceId, command.targetId, command.damage);
    }
  }

  lightningOfHellReaction(casterId: string, targetId: string): void {
    if (!this.port.memberOf(casterId)) return;
    this.port.followUp?.('lightning-of-hell', casterId, targetId);
  }

  godOfJusticeReaction(casterId: string, targetId: string): void {
    if (!this.port.memberOf(casterId)) return;
    this.port.followUp?.('god-of-justice', casterId, targetId);
  }

  summonOwnerReactions(event: AttackContact, hit: PhysicalHit, damageKind: 'physical' | 'magic'): void {
    if (hit.kind === 'miss') return;
    const summon = this.port.enemyOf(event.casterId);
    const ownerId = summon?.summonedBy;
    if (!summon || !ownerId) return;
    if (this.port.memberOf(ownerId)) {
      this.react({
        kind: 'summon-attack-success',
        ownerId,
        opponentId: event.targetId,
        damageKind,
        outcome: hit.kind,
      });
    }
    const chance = this.summonTauntChanceFor(summon, ownerId);
    if (this.port.threat && chance > 0 && this.port.enemyTarget(event.targetId) !== event.casterId && passesChanceThreshold(chance, () => this.random())) {
      this.port.threat.taunt(event.casterId, event.targetId);
    }
    if (this.port.memberOf(ownerId)) {
      this.react({
        kind: 'summon-physical-success',
        ownerId,
        opponentId: event.targetId,
        damageKind,
        outcome: hit.kind,
      });
    }
  }

  private summonTauntChanceFor(summon: CombatArenaEnemy, ownerId: string): number {
    const skillId = summon.summonedBySkill;
    if (!skillId) return summon.summonTauntChance ?? 0;
    const level = this.stats.skillLevel(ownerId, skillId);
    if (!level) return 0;
    const unit = skillForMember(this.port.battleCatalog, ownerId, skillId)?.action?.combatUnits?.find(entry => entry.effect === 'summon');
    if (unit?.effect !== 'summon') return summon.summonTauntChance ?? 0;
    return unit.ranks[Math.min(unit.ranks.length - 1, level - 1)]?.tauntChanceThreshold ?? 0;
  }

  currentTargetOf(id: string): string | undefined {
    const enemy = this.port.enemyOf(id);
    if (enemy) return this.port.enemyTarget(id);
    return this.port.currentTargetOf(id);
  }

  rearPenetrationBonus(attackerId: string, targetId: string): number {
    const rate = this.stats.actorAttribute(attackerId, 'rearPenetrationRate');
    if (rate <= 0) return 0;
    return this.currentTargetOf(targetId) === attackerId ? 0 : rate;
  }

  disturbanceReaction(attackerId: string, defenderId: string): void {
    const member = this.port.memberOf(defenderId);
    if (!member) return;
    const skills = this.stats.reactionSkills(defenderId);
    if (!skills) return;
    const threshold = skills.reactions.find(reaction => reaction.kind === 'disturbance')?.chanceThreshold ?? 0;
    // 未学扰乱时阈值是 0：这里连随机数都不抽，后面的反应链掷点顺序才不会偏移。
    if (!(threshold > 0) || Math.floor(this.random() * 999) + 1 >= threshold) return;
    const self = this.port.combatant(defenderId);
    if (!self) return;
    const actors = this.port.combatants().flatMap(candidate => {
      const actor = this.port.combatant(candidate.id);
      if (!actor) return [];
      const summon = this.port.enemyOf(candidate.id)?.summonedBy;
      return [
        {
          id: candidate.id,
          sameCamp: actor.team === self.team,
          ownSummon: summon === defenderId,
          position: actor.position,
          bounds: actor.bounds,
          effectiveDefense: calculateEffectiveDefense(
            this.stats.actorAttribute(candidate.id, 'defense'),
            this.stats.actorAttribute(candidate.id, 'defenseRate'),
          ),
        },
      ];
    });
    const candidateId = disturbanceCandidate(
      {
        id: defenderId,
        sameCamp: true,
        ownSummon: false,
        position: self.position,
        bounds: self.bounds,
        effectiveDefense: calculateEffectiveDefense(
          this.stats.actorAttribute(defenderId, 'defense'),
          this.stats.actorAttribute(defenderId, 'defenseRate'),
        ),
      },
      actors,
    );
    if (!candidateId || candidateId === this.currentTargetOf(attackerId)) return;
    this.port.threat?.taunt(candidateId, attackerId);
  }

  partyRevengeReactions(attackerId: string, damageKind: 'physical' | 'magic', outcome: PhysicalHit['kind']): void {
    for (const id of this.activePartySlots()) {
      this.react({ kind: 'blood-revenge', ownerId: id, opponentId: attackerId, damageKind, outcome });
    }
  }

  physicalSuccessEquipmentProcs(event: AttackContact, _hit: PhysicalHit, random: () => number = () => this.random()): void {
    const caster = this.stats.combatProcs(event.casterId);
    const target = this.stats.combatProcs(event.targetId);
    if (caster.pendulumStunChance > 0) {
      const decision = resolveStateApplication(
        { ...this.stateApplicationRequest(event.casterId, event.targetId, 'stun'), kind: 'action', chanceThreshold: caster.pendulumStunChance },
        random,
      );
      if (decision.allowed) {
        const timing = selectStateDurationProfile(frameStateDurationProfile(PENDULUM_STUN_FRAMES), decision);
        this.port.conditions.applyStateFrames(event.targetId, 'stun', timing.lastActiveFrame, event.casterId);
        this.port.recordSummonContact?.(event.casterId, event.targetId);
        this.port.onStateConsequences?.(event.targetId, ['stun']);
      }
    }
    if (target.frostRetaliationChance > 0 && passesChanceThreshold(target.frostRetaliationChance, random)) {
      const effect = this.port.battleCatalog.statusAttackBuffs?.['attack-slow'];
      if (effect) this.applyActorBuff(event.casterId, 'attack-slow', 0, effect, event.targetId);
    }
    if (caster.healingEnergyChance > 0 && passesChanceThreshold(caster.healingEnergyChance, random)) {
      this.restoreHealth(event.casterId, Math.trunc(this.stats.readResourceCapacity(event.casterId, 'maxHealth') / HEALING_ENERGY_MAX_HEALTH_DIVISOR));
    }
  }

  instantRecoveryOnMiss(event: AttackContact): void {
    const rate = this.stats.combatProcs(event.targetId).instantRecoveryPerThousand;
    if (rate < 1) return;
    this.restoreHealth(event.targetId, Math.trunc((this.stats.readResourceCapacity(event.targetId, 'maxHealth') * rate) / 1000));
  }

  moltenReflection(event: AttackContact, ratePerThousand: number): void {
    const defenderId = event.targetId;
    const attackerId = event.casterId;
    const monster = !!this.port.enemyOf(defenderId);
    const damage = moltenReflectionDamage(
      monster
        ? { kind: 'monster', physicalAttack: this.stats.actorAttribute(defenderId, 'physicalAttack') }
        : {
            kind: 'character',
            defense: this.stats.actorAttribute(defenderId, 'defense'),
            defenseRate: this.stats.actorAttribute(defenderId, 'defenseRate'),
          },
      ratePerThousand,
    );
    this.moltenDirectDamage({ casterId: defenderId, targetId: attackerId }, damage);
    const splash = rollMoltenSplash(damage, this.stats.actorAttribute(defenderId, 'fireSplashChance'), () => this.random());
    if (splash !== undefined) {
      const source = this.port.combatant(defenderId);
      if (source) {
        const targets = this.port.combatants();
        const center = this.attackSplashCenter(source, targets, 4);
        for (const target of moltenSplashTargets(source, center, targets, attackerId)) {
          if (splash <= 0 || !this.port.combatant(target.id)) continue;
          this.moltenDirectDamage({ casterId: defenderId, targetId: target.id }, splash);
        }
      }
    }
    this.react({ kind: 'molten-reflection-completed', ownerId: defenderId, opponentId: attackerId });
  }

  moltenDirectDamage(event: AttackContact, damage: number): void {
    if (damage <= 0 || this.port.isPendingDefeat(event.targetId) || !this.port.conditions.canLoseHealth(event.targetId)) return;
    const enemy = this.port.enemyOf(event.targetId);
    this.settleHit(event, { kind: 'hit', damage }, enemy, { style: 'weapon', sound: true });
    if (!this.port.enemiesRunning()) return;
    if (enemy && !this.port.isPendingDefeat(enemy.key) && this.port.enemyOf(enemy.key)) {
      this.port.onEnemyContact?.(enemy, event);
    }
  }

  attackSplashCenter(source: Combatant, targets: readonly Combatant[], rangeUnits: number): Point {
    const selection = selectAttackSplashCenter(source, targets, rangeUnits, {
      currentTargetId: this.port.currentTargetOf(source.id),
    });
    if (selection.targetId && selection.targetId !== this.port.currentTargetOf(source.id)) {
      this.port.setReactionTarget(source.id, selection.targetId);
    }
    return selection.center;
  }

  attackProc(event: AttackContact, hit: PhysicalHit): void {
    if (hit.kind === 'miss') return;
    this.partyAttackProc(event, hit);
    if (hit.damage <= 0) return;
    const attributes = this.stats.actorAttributes(event.casterId);
    if (!attributes) return;
    const baseDamage = normalDamageForClass(attributes, this.port.memberOf(event.casterId)?.classId ?? null);
    this.attackProcs.execute(baseDamage, {
      readChance: key => this.stats.actorAttribute(event.casterId, key),
      applyDamage: amount => this.attackProcDamage(event, amount),
      applyBuff: key => {
        const effect = this.port.battleCatalog.statusAttackBuffs?.[key];
        if (effect) this.applyActorBuff(event.targetId, key, 0, effect, event.casterId);
      },
      fireSplash: amount => {
        const source = this.port.combatant(event.casterId);
        if (!source) return 0;
        const candidates = this.port.combatants();
        const center = this.attackSplashCenter(source, candidates, 3);
        const targets = attackSplashTargets(source, center, candidates, 3);
        for (const target of targets) this.attackProcDamage({ casterId: event.casterId, targetId: target.id }, amount);
        return targets.length;
      },
    });
  }

  private attackProcDamage(event: AttackContact, amount: number): void {
    if (amount <= 0 || !this.port.combatant(event.targetId) || !this.port.conditions.canLoseHealth(event.targetId)) return;
    const enemy = this.port.enemyOf(event.targetId);
    this.settleHit(event, { kind: 'hit', damage: amount }, enemy);
  }

  private partyAttackProc(event: AttackContact, hit: PhysicalHit): void {
    const member = this.port.memberOf(event.casterId);
    if (!member || !this.port.combatant(event.targetId)) return;
    const groupEffects = this.groupModifiers();
    const main = member.bag.equipmentItems(member.bag.equipmentFor(event.casterId))['main-hand'];
    const weapon = main ? this.port.items.items[main].kind : '';
    for (const [buff, chance] of [
      ['critical-hit-stun', hit.kind === 'critical' ? (groupEffects['critical-stun-chance'] ?? 0) : 0],
      ['blunt-hit-stun', weapon === 'mace' ? (groupEffects['blunt-stun-chance'] ?? 0) : 0],
    ] as const) {
      if (partyProcSucceeds(chance, () => this.random())) {
        const effect = this.port.battleCatalog.statusAttackBuffs?.[buff];
        if (effect) this.applyActorBuff(event.targetId, buff, 0, effect, event.casterId);
      }
    }
  }

  private groupModifiers(): Partial<Record<string, number>> {
    return this.port.groupModifiers?.() ?? this.stats.groupModifiers();
  }

  holySacrificeTransfer(event: AttackContact, hit: PhysicalHit, damageKind: 'physical' | 'magic'): void {
    const rate = this.stats.actorAttribute(event.targetId, 'damageTransferPerThousand');
    const result = resolveHolySacrifice(hit.damage, damageKind, rate, () => {
      const id = this.port.conditions.snapshot(event.targetId).find(condition => condition.kind === 'buff' && condition.id === 'holy-sacrifice')?.sourceId;
      const fighter = id ? this.stats.fighterOf(id) : undefined;
      if (!id || !fighter) return;
      return {
        id,
        fallen: this.port.isFallen(id),
        pendingDefeat: this.port.isPendingDefeat(id),
        canLoseHealth: this.port.conditions.canLoseHealth(id),
        physicalResistance: fighter.physicalResistance,
        magicResistance: fighter.magicResistance,
      };
    });
    if (!result) return;
    hit.damage = result.victimDamage;
    if (result.protectorDamage > 0) {
      const enemy = this.port.enemyOf(result.protectorId);
      this.settleHit({ casterId: event.casterId, targetId: result.protectorId }, { kind: 'hit', damage: result.protectorDamage }, enemy, {
        style: 'weapon',
        sound: true,
      });
    }
  }

  stateApplicationRequest(
    casterId: string,
    targetId: string,
    state: BattleStateKey,
  ): Omit<Extract<StateApplicationRequest, { kind: 'buff' }>, 'kind'> {
    const member = this.port.memberOf(targetId);
    const enemy = this.port.enemyOf(targetId);
    const sourceEnemy = this.port.enemyOf(casterId);
    const sourceMember = this.port.memberOf(casterId);
    const sourceParty = !!(sourceMember || this.port.memberOf(sourceEnemy?.summonedBy ?? ''));
    const targetParty = !!(member || this.port.memberOf(enemy?.summonedBy ?? ''));
    const immunity = equipmentStateImmunity(this.stats.equipmentEffects(targetId).totals, state);
    const immunityAttribute = state === 'sleep' ? 'sleepImmunity' : state === 'stun' ? 'stunImmunity' : undefined;
    const passives = member ? this.stats.partyPassives(targetId) : [];
    const groupModifiers = this.groupModifiers();
    return {
      state,
      sourceRelation: !sourceMember && !sourceEnemy ? 'none' : sourceParty === targetParty ? 'friendly' : 'hostile',
      rules: enemy?.definition.stateRules,
      specificImmunityValue: immunityAttribute ? this.port.conditions.attribute(targetId, immunityAttribute, immunity, passives) : 0,
      resistanceThreshold: this.port.conditions.attribute(
        targetId,
        'stateResistance',
        member ? (groupModifiers['status-resistance'] ?? 0) : 0,
        passives,
      ),
    };
  }

  applyReactionState(command: { attributeOwner: string; targetId: string; state: BattleStateKey; durationAttribute: BattleStatKey }): void {
    const duration = this.stats.actorAttribute(command.attributeOwner, command.durationAttribute);
    if (duration <= 0) return;
    const decision = resolveStateApplication(
      { ...this.stateApplicationRequest(command.attributeOwner, command.targetId, command.state), kind: 'action', chanceThreshold: CERTAIN_CHANCE_THRESHOLD },
      () => this.random(),
    );
    if (!decision.allowed) return;
    const timing = selectStateDurationProfile(frameStateDurationProfile(duration), decision);
    this.port.conditions.applyStateFrames(command.targetId, command.state, timing.lastActiveFrame, command.attributeOwner);
    this.port.recordSummonContact?.(command.attributeOwner, command.targetId);
    this.port.onStateConsequences?.(command.targetId, [command.state]);
  }

  applyActorBuff(targetId: string, key: BattleBuffKey, priority: number, effect: BattleBuffEffect, sourceId: string): boolean {
    if (this.port.enemyOf(targetId)?.definition.acceptsBuffs === false) return false;
    const rule = effect.durationRateFromOwner;
    let applied = rule === undefined ? effect : scaledBuffEffect(effect, this.stats.actorAttribute(sourceId, rule.attribute));
    const bonus = applied.durationFramesFromOwner;
    if (bonus) {
      const frames = Math.trunc((this.stats.actorAttribute(sourceId, bonus.attribute) * 15) / 10);
      applied = withLifetimeFrames(applied, applied.simulationFrames!.lastActiveFrame + frames);
    }
    const initialized: BattleStateKey[] = [];
    const accepted = this.port.conditions.applyBuff(targetId, key, priority, applied, sourceId, state => {
      const decision = resolveStateApplication({ ...this.stateApplicationRequest(sourceId, targetId, state), kind: 'buff' }, () => this.random());
      if (!decision.allowed) return false;
      const profile = applied.stateDurationProfiles?.[state];
      if (!profile) throw new Error(`Missing state lifetime for ${key}/${state}`);
      initialized.push(state);
      return selectStateDurationProfile(profile, decision);
    });
    if (!accepted) return false;
    this.applyAcceptedEffects(sourceId, targetId, applied);
    if (applied.applicationEffect) this.port.onBuffApplication?.(sourceId, targetId, applied.applicationEffect);
    if (this.port.memberOf(targetId)) this.stats.syncCombatResourceLimits(targetId);
    const activeStates = initialized.filter(state => this.port.conditions.hasState(targetId, state));
    this.port.onStateConsequences?.(targetId, activeStates);
    return true;
  }

  applyAcceptedEffects(sourceId: string, targetId: string, effect: BattleBuffEffect): void {
    for (const accepted of effect.onAccepted ?? []) {
      const child = this.stats.learnedReactionBuff(sourceId, accepted.skill);
      if (!child) continue;
      const parent: Partial<Record<typeof accepted.skill, BattleBuffKey>> = {
        'bard-of-destruction': 'summon-bard',
        'deep-breath': 'energy-bodhi',
      };
      const parentKey = parent[accepted.skill];
      const parentCap = parentKey === undefined ? undefined : this.port.conditions.buffLifetimeFrames(sourceId, parentKey);
      const inherited = parentCap === undefined ? child.effect : withLifetimeFrames(child.effect, parentCap);
      const recipient = accepted.target === 'source' ? sourceId : targetId;
      this.applyActorBuff(recipient, child.key, child.rankPriority, inherited, sourceId);
    }
  }

  cancelAmbushOnDirection(): void {
    const id = this.port.controlledId();
    if (!this.port.conditions.hasBuff(id, 'ambush')) return;
    this.port.conditions.removeBuff(id, 'ambush');
    this.port.conditions.removeBuff(id, 'sniping');
    const recovery = this.port.battleCatalog.statusAttackBuffs?.['ambush-recovery'];
    if (recovery) this.applyActorBuff(id, 'ambush-recovery', 0, recovery, id);
  }

  applySpringBuff(key: BattleBuffKey, scope: SpringBuffScope): boolean {
    const effect = this.port.battleCatalog.statusAttackBuffs?.[key];
    if (!effect) return false;
    const controlled = this.port.controlledId();
    if (scope === 'single') return this.applyActorBuff(controlled, key, 0, effect, controlled);
    let applied = false;
    for (const id of this.port.activeParty()) {
      if ((this.port.memberOf(id)?.player.health ?? 0) <= 0) continue;
      applied = this.applyActorBuff(id, key, 0, effect, id) || applied;
    }
    return applied;
  }

  periodicTick(tick: PeriodicTick): void {
    if (this.port.isDefeated() || this.port.isClosed() || this.port.isPendingDefeat(tick.targetId)) return;
    const attributes = this.stats.actorAttributes(tick.sourceId);
    const effect = tick.effect;
    if (!attributes && !['normal-damage', 'visual', 'fixed-damage'].includes(effect.kind)) return;
    const commands = resolvePeriodicEffect(effect, {
      buffId: tick.buffId,
      stackCount: tick.stackCount,
      targetHealingRate: this.stats.actorAttribute(tick.targetId, 'healingPowerRate'),
      source: attributes
        ? {
            classId: this.port.memberOf(tick.sourceId)?.classId ?? null,
            attributes,
            lifeFeastRate: this.stats.actorAttribute(tick.sourceId, 'lifeFeastRate'),
            attributeValue: key => this.stats.actorAttribute(tick.sourceId, key),
          }
        : null,
    });
    const heal = (recipientId: string, amount: number, visual?: string) => {
      this.restoreHealth(recipientId, amount);
      if (visual) {
        this.port.onShowEffects?.(recipientId, recipientId, [{ effect: visual, recipient: 'target', placement: 'attached' }]);
      }
    };
    for (const command of commands) {
      if (command.kind === 'visual') {
        this.port.onShowEffects?.('player', tick.targetId, [{ effect: command.effect, recipient: 'target', placement: 'attached' }]);
      } else if (command.amount > 0) {
        if (command.kind === 'heal-target') heal(tick.targetId, command.amount, command.effect);
        else if (command.kind === 'heal-source') heal(tick.sourceId, command.amount, command.effect);
        else if (command.kind === 'heal-party') {
          for (const id of this.activePartySlots()) heal(id, command.amount, command.effect);
        } else {
          const enemy = this.port.enemyOf(tick.targetId);
          this.settleHit({ casterId: tick.sourceId, targetId: tick.targetId }, { kind: 'hit', damage: command.amount }, enemy, {
            periodic: true,
          });
        }
      }
    }
  }

  recoverResources(): void {
    if (!this.port.recoveryPulseDue()) {
      this.port.advanceRecoveryClock();
      return;
    }
    const actors = [...this.port.activeParty(), ...this.port.allEnemies().map(enemy => enemy.key)].flatMap(id => {
      const member = this.port.memberOf(id);
      const enemy = this.port.enemyOf(id);
      const state = member?.player ?? (enemy && this.port.enemySnapshot(id, enemy.definition, this.heroLevel));
      if (!state) return [];
      const regeneration = this.port.activeRegeneration();
      const bonus = (key: 'healthRecoveryPerPulse' | 'manaRecoveryPerPulse'): number => (member && regeneration ? regeneration[key] : 0);
      return [
        {
          actorId: id,
          alive: state.health > 0 && !this.port.isPendingDefeat(id),
          level: state.level,
          healthRecoveryPerPulse: this.stats.actorAttribute(id, 'healthRecoveryPerPulse') + bonus('healthRecoveryPerPulse'),
          manaRecoveryPerPulse: this.stats.actorAttribute(id, 'manaRecoveryPerPulse') + bonus('manaRecoveryPerPulse'),
          emergencyRecovery: this.port.conditions.hasBuff(id, 'monster-emergency-recovery'),
        },
      ];
    });
    for (const pulse of this.port.recoverCombatResources(actors)) {
      for (const amount of pulse.amounts) {
        this.restoreHealth(amount.actorId, amount.healthAmount);
        this.restoreMana(amount.actorId, amount.manaAmount);
      }
      this.port.threat?.decay();
    }
  }

  restoreHealth(id: string, amount: number): void {
    const member = this.port.memberOf(id);
    if (member) {
      if (!this.port.isFallen(id) && (member.player.health > 0 || this.port.hitResolution.isAwaitingDefeat(id))) {
        const capacity = this.stats.readResourceCapacity(id, 'maxHealth');
        member.setHealth(Math.min(capacity, member.player.health + amount));
      }
      return;
    }
    const enemy = this.port.enemyOf(id);
    if (!enemy || this.port.isPendingDefeat(id)) return;
    const state = this.port.enemySnapshot(id, enemy.definition, this.heroLevel);
    if (state && (state.health > 0 || this.port.hitResolution.isAwaitingDefeat(id))) {
      this.port.setEnemyHealth(id, state.health + amount, enemy.definition);
    }
  }

  restoreMana(id: string, amount: number): void {
    const member = this.port.memberOf(id);
    if (member) {
      if (!this.port.isFallen(id) && (member.player.health > 0 || this.port.hitResolution.isAwaitingDefeat(id))) {
        const value = member.player.mana + amount;
        member.setMana(value < 0 ? 0 : Math.min(this.stats.readResourceCapacity(id, 'maxMana'), value));
      }
      return;
    }
    const enemy = this.port.enemyOf(id);
    if (!enemy || this.port.isPendingDefeat(id)) return;
    const state = this.port.enemySnapshot(id, enemy.definition, this.heroLevel);
    if (state && (state.health > 0 || this.port.hitResolution.isAwaitingDefeat(id))) {
      this.port.setEnemyMana(id, state.mana + amount, enemy.definition);
    }
  }
}

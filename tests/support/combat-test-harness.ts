import { readFileSync } from 'node:fs';
import {
  type BattleBuffEffect,
  type BattleCatalog,
  type EnemyDefinition,
  type SkillEffectCue,
  type SkillVisualEffect,
} from '../../src/domain/battle.ts';
import type { BattleStatKey, BattleStateKey } from '../../src/domain/battle-semantics.ts';
import type { Campaign } from '../../src/domain/campaign.ts';
import {
  type BattleCharacter,
  type CharacterPanel,
  type CharacterStatsCatalog,
  type PrimaryAttributes,
} from '../../src/domain/character-stats.ts';
import { CombatActorStats, type CombatActorStatsPort } from '../../src/domain/combat-actor-stats.ts';
import { type CombatConditions } from '../../src/domain/combat-conditions.ts';
import { CombatHitResolution } from '../../src/domain/combat-hit-resolution.ts';
import { type HitEffectStyle } from '../../src/domain/combat-feedback.ts';
import {
  CombatSettlementEngine,
  createCombatConditions,
  type CombatArenaEnemy,
  type CombatSettlementPort,
  type SummonUnitSpawnRequest,
} from '../../src/domain/combat-settlement.ts';
import { type CombatThreatSystem } from '../../src/domain/combat-threat-system.ts';
import { type AttackContact, type Combatant, type SkillUnitHit } from '../../src/domain/combatant.ts';
import { type CompanionCatalog, type CompanionMember, type PartyRoster } from '../../src/domain/party.ts';
import { type ActorDefinition } from '../../src/domain/content.ts';
import { type DropCatalog } from '../../src/domain/drops.ts';
import { type EnemySnapshot } from '../../src/domain/enemy-stats.ts';
import { FrenzyAnimationMemory } from '../../src/domain/frenzy-animation.ts';
import { type ItemCatalog, type ItemInstance } from '../../src/domain/items.ts';
import { type Point } from '../../src/domain/navigation.ts';
import { type PhysicalHit } from '../../src/domain/physical-hit.ts';
import { type RecoveryItems } from '../../src/domain/recovery-items.ts';
import { type ResourceRecoveryActor, type ResourceRecoveryPulse } from '../../src/domain/combat-resources.ts';
import { type SkillUnitOutcome } from '../../src/domain/skill-unit-sequence.ts';
import { type StorySkillProgression } from '../../src/domain/story-skills.ts';
import { type CompanionSkillProgression } from '../../src/domain/companion-progression.ts';
import { type WardrobeCatalog } from '../../src/domain/wardrobe.ts';

const contentCache = new Map<string, unknown>();

/** 读取并缓存 `public/content/*.json` 测试目录（单进程内只解析一次）。 */
export function loadContentCatalog<T>(name: string): T {
  const existing = contentCache.get(name);
  if (existing !== undefined) return existing as T;
  const parsed = JSON.parse(readFileSync(new URL(`../../public/content/${name}.json`, import.meta.url), 'utf8')) as T;
  contentCache.set(name, parsed);
  return parsed;
}

export const loadBattleCatalog = () => loadContentCatalog<BattleCatalog>('battle');
export const loadItemCatalog = () => loadContentCatalog<ItemCatalog>('items');
export const loadWardrobeCatalog = () => loadContentCatalog<WardrobeCatalog>('wardrobe');
export const loadCharacterStatsCatalog = () => loadContentCatalog<CharacterStatsCatalog>('character-stats');
export const loadCampaignCatalog = () => loadContentCatalog<Campaign>('campaign');
export const loadCompanionCatalog = () => loadContentCatalog<CompanionCatalog>('companions');
export const loadDropCatalog = () => loadContentCatalog<DropCatalog>('drops');

export const ZERO_PRIMARY_ATTRIBUTES: PrimaryAttributes = {
  strength: 0,
  dexterity: 0,
  vitality: 0,
  intelligence: 0,
  mentality: 0,
};

export function defaultTestPanel(overrides: Partial<CharacterPanel> = {}): CharacterPanel {
  return {
    attributes: { ...ZERO_PRIMARY_ATTRIBUTES, ...(overrides.attributes ?? {}) },
    maxHealth: 1000,
    maxMana: 100,
    physicalAttack: 100,
    magicAttack: 0,
    criticalRate: 0,
    hitRate: 100,
    baseDefense: 0,
    baseMagicResistance: 0,
    criticalDamage: 0,
    defense: 0,
    defenseRate: 1000,
    physicalResistance: 0,
    magicResistance: 0,
    evasionRate: 0,
    weaponBlock: 0,
    shieldBlock: 0,
    offhandShield: false,
    hitBase: 100,
    hitBonus: 1000,
    evasionBase: 0,
    evasionBonus: 0,
    criticalResistance: 0,
    criticalDamageResistance: 0,
    ...overrides,
  };
}

export interface TestSkillConfiguration {
  version: number;
  resetVersion: number;
  draft(catalog: BattleCatalog, classId: string): { levels: Record<string, number> };
}

export interface TestMemberBag {
  revision: number;
  equipmentFor(id: string): Record<string, string | undefined>;
  equipmentItems(equipment: Record<string, string | undefined>): Record<string, string | undefined>;
  get(key: string): ItemInstance | undefined;
}

export interface TestMemberFixture {
  id: string;
  classId: string;
  level: number;
  alive: boolean;
  player: { health: number; maxHealth: number; mana: number; maxMana: number; level: number };
  panel: CharacterPanel;
  bag: TestMemberBag;
  skills: TestSkillConfiguration;
  definition?: { actor: string; defaultShield?: string };
  setHealth(value: number): void;
  setMana(value: number): void;
  setCombatResourceCapacity(key: 'maxHealth' | 'maxMana', value: number): void;
  setCombatResourceLimits(maxHealth: number, maxMana: number): void;
  clearCombatResourceLimits(): void;
}

export function createTestMember(options: {
  id?: string;
  classId?: string;
  level?: number;
  health?: number;
  maxHealth?: number;
  mana?: number;
  maxMana?: number;
  panel?: Partial<CharacterPanel>;
  skillLevels?: Record<string, number>;
  equipmentItems?: Record<string, string | undefined>;
  bag?: TestMemberBag;
  actorId?: string;
  defaultShield?: string;
} = {}): TestMemberFixture {
  const id = options.id ?? 'player';
  const maxHealth = options.panel?.maxHealth ?? options.maxHealth ?? 1000;
  const maxMana = options.panel?.maxMana ?? options.maxMana ?? 100;
  const level = options.level ?? 1;
  const panel = defaultTestPanel({ maxHealth, maxMana, ...options.panel });
  const player = {
    health: options.health ?? maxHealth,
    maxHealth,
    mana: options.mana ?? maxMana,
    maxMana,
    level,
  };
  let healthLimit = maxHealth;
  let manaLimit = maxMana;
  const bag: TestMemberBag = options.bag ?? {
    revision: 0,
    equipmentFor: () => options.equipmentItems ?? {},
    equipmentItems: eq => eq,
    get: () => undefined,
  };
  const levels = { ...(options.skillLevels ?? {}) };
  const member: TestMemberFixture = {
    id,
    classId: options.classId ?? 'dark-knight',
    level,
    get alive() {
      return player.health > 0;
    },
    player,
    panel,
    bag,
    skills: {
      version: 1,
      resetVersion: 0,
      draft: () => ({ levels: { ...levels } }),
    },
    definition: options.actorId || options.defaultShield ? { actor: options.actorId ?? id, defaultShield: options.defaultShield } : undefined,
    setHealth(value: number) {
      player.health = Math.max(0, Math.min(healthLimit, Math.trunc(value)));
    },
    setMana(value: number) {
      player.mana = Math.max(0, Math.min(manaLimit, Math.trunc(value)));
    },
    setCombatResourceCapacity(key, value) {
      if (key === 'maxHealth') {
        healthLimit = value;
        player.maxHealth = value;
        if (player.health > value) player.health = value;
      } else {
        manaLimit = value;
        player.maxMana = value;
        if (player.mana > value) player.mana = value;
      }
    },
    setCombatResourceLimits(nextHealth, nextMana) {
      this.setCombatResourceCapacity('maxHealth', nextHealth);
      this.setCombatResourceCapacity('maxMana', nextMana);
    },
    clearCombatResourceLimits() {
      healthLimit = panel.maxHealth;
      manaLimit = panel.maxMana;
      player.maxHealth = panel.maxHealth;
      player.maxMana = panel.maxMana;
    },
  };
  return member;
}

export interface TestEnemyState extends CombatArenaEnemy {
  health: number;
  maxHealth: number;
  mana: number;
  maxMana: number;
  level: number;
  elite: boolean;
  present: boolean;
  pendingDefeat: boolean;
  hasDisplay: boolean;
  targetId?: string;
}

export function createTestEnemy(options: {
  key: string;
  definition: EnemyDefinition;
  health?: number;
  maxHealth?: number;
  mana?: number;
  maxMana?: number;
  level?: number;
  elite?: boolean;
  summonedBy?: string;
  summonRemainingMs?: number;
  summonTauntChance?: number;
  summonedBySkill?: string;
  hasDisplay?: boolean;
  present?: boolean;
  targetId?: string;
}): TestEnemyState {
  const maxHealth = options.maxHealth ?? 500;
  const maxMana = options.maxMana ?? 100;
  return {
    key: options.key,
    definition: options.definition,
    summonedBy: options.summonedBy,
    summonRemainingMs: options.summonRemainingMs,
    summonTauntChance: options.summonTauntChance,
    summonedBySkill: options.summonedBySkill,
    bounds: options.definition.actor.collision,
    health: options.health ?? maxHealth,
    maxHealth,
    mana: options.mana ?? maxMana,
    maxMana,
    level: options.level ?? options.definition.level ?? 1,
    elite: options.elite ?? false,
    present: options.present ?? true,
    pendingDefeat: false,
    hasDisplay: options.hasDisplay ?? true,
    targetId: options.targetId,
  };
}

export interface CombatTestHarnessLog {
  hits: Array<{ event: AttackContact; hit: PhysicalHit; style?: HitEffectStyle; periodic?: boolean; sound?: boolean }>;
  effects: Array<{ actorId: string; targetId: string; effects: readonly SkillVisualEffect[] }>;
  unitFeedback: Array<{ hit: SkillUnitHit; outcome: SkillUnitOutcome; cue: SkillEffectCue }>;
  buffApplications: Array<{ sourceId: string; targetId: string; effect: string }>;
  droppedMana: Array<{ casterId: string; damage: number; target?: Point; rule?: 'skill' | 'weapon' }>;
  stateConsequences: Array<{ id: string; states: readonly BattleStateKey[] }>;
  defeatedMembers: string[];
  zeroHealthEnemies: Array<{ key: string; before: Readonly<EnemySnapshot>; casterId: string }>;
  removedEnemies: string[];
  enemyContacts: Array<{ enemyKey: string; event: AttackContact }>;
  summonSpawns: SummonUnitSpawnRequest[];
  followUps: Array<{ kind: 'lightning-of-hell' | 'god-of-justice'; casterId: string; targetId: string }>;
  actionSounds: Array<{ casterId: string; sound: string }>;
  stealthBroken: string[];
  reactionTargets: Array<{ actorId: string; targetId: string }>;
  missingPreparedSkills: Array<{ id: string; skillId: string }>;
  shakes: number;
}

export interface CombatTestHarnessOptions {
  battleCatalog?: BattleCatalog;
  items?: ItemCatalog;
  wardrobe?: WardrobeCatalog;
  characterStats?: CharacterStatsCatalog;
  hero?: BattleCharacter | TestMemberFixture;
  members?: Map<string, BattleCharacter | CompanionMember | TestMemberFixture>;
  enemies?: Map<string, TestEnemyState>;
  activeParty?: () => readonly string[];
  controlledId?: () => string;
  sessionSkills?: () => StorySkillProgression | undefined;
  skillConfiguration?: CombatActorStatsPort['skillConfiguration'];
  party?: () => PartyRoster | undefined;
  groupModifiers?: () => Partial<Record<string, number>>;
  frenzyAnimations?: FrenzyAnimationMemory;
  combatants?: () => Combatant[];
  combatant?: (id: string) => Combatant | undefined;
  currentTargetOf?: (id: string) => string | undefined;
  memberActorDefinition?: (id: string) => ActorDefinition | undefined;
  preparedSkills?: Map<string, ReadonlySet<string>> | ((id: string) => ReadonlySet<string> | undefined);
  requiresPreparedSkills?: boolean | (() => boolean);
  random?: () => number;
  withThreat?: boolean;
  conditions?: CombatConditions;
  hitResolution?: CombatHitResolution;
  statsOverrides?: Partial<CombatActorStatsPort>;
  settlementOverrides?: Partial<CombatSettlementPort>;
}

/**
 * 构建零 Phaser 依赖的纯领域战斗测试底座：
 * 串联真实 `CombatConditions`、`CombatHitResolution`、`CombatActorStats`、`CombatSettlementEngine` 与 `CombatThreatSystem`。
 */
export function createCombatTestHarness(options: CombatTestHarnessOptions = {}) {
  const battleCatalog = options.battleCatalog ?? loadBattleCatalog();
  const items = options.items ?? loadItemCatalog();
  const wardrobe = options.wardrobe ?? loadWardrobeCatalog();
  const characterStats = options.characterStats ?? loadCharacterStatsCatalog();
  const members = options.members ?? new Map<string, BattleCharacter | CompanionMember | TestMemberFixture>();
  const enemies = options.enemies ?? new Map<string, TestEnemyState>();
  const fallen = new Set<string>();
  const invincible = new Set<string>();
  const infiniteMana = new Set<string>();
  const currentTargets = new Map<string, string>();
  const hitResolution = options.hitResolution ?? new CombatHitResolution();
  const frenzyAnimations = options.frenzyAnimations ?? new FrenzyAnimationMemory();

  const log: CombatTestHarnessLog = {
    hits: [],
    effects: [],
    unitFeedback: [],
    buffApplications: [],
    droppedMana: [],
    stateConsequences: [],
    defeatedMembers: [],
    zeroHealthEnemies: [],
    removedEnemies: [],
    enemyContacts: [],
    summonSpawns: [],
    followUps: [],
    actionSounds: [],
    stealthBroken: [],
    reactionTargets: [],
    missingPreparedSkills: [],
    shakes: 0,
  };

  let closed = false;
  let defeated = false;
  let enemiesRunning = false;
  let combatTick = 0;

  const resolvePrepared = (id: string): ReadonlySet<string> | undefined => {
    if (!options.preparedSkills) return undefined;
    return typeof options.preparedSkills === 'function' ? options.preparedSkills(id) : options.preparedSkills.get(id);
  };
  const resolveRequiresPrepared = (): boolean => {
    if (typeof options.requiresPreparedSkills === 'function') return options.requiresPreparedSkills();
    if (options.requiresPreparedSkills !== undefined) return options.requiresPreparedSkills;
    return options.preparedSkills !== undefined;
  };

  const memberLookup = (id: string): BattleCharacter | CompanionMember | undefined => {
    const found = members.get(id) ?? (id === 'player' ? options.hero : undefined);
    return found as BattleCharacter | CompanionMember | undefined;
  };

  const buildSnapshot = (enemy: TestEnemyState): EnemySnapshot => ({
    id: enemy.definition.id,
    name: enemy.definition.name,
    level: enemy.level,
    sceneLevel: false,
    elite: enemy.elite,
    partySize: 1,
    health: enemy.health,
    maxHealth: enemy.maxHealth,
    mana: enemy.mana,
    maxMana: enemy.maxMana,
    physicalAttack: 100,
    magicAttack: 0,
    defense: 0,
    defenseRate: 1000,
    physicalResistanceBonus: 0,
    hitBase: 100,
    hitBonus: 1000,
    hitRate: 100,
    evasionBase: 0,
    evasionBonus: 0,
    evasionRate: 0,
    criticalRate: 0,
    criticalResistance: 0,
    criticalDamage: 0,
    criticalDamageResistance: 0,
    weaponBlock: 0,
    shieldBlock: 0,
    physicalResistance: 0,
    magicResistance: 0,
    baseExperience: 0,
    experience: 0,
  });

  // eslint-disable-next-line prefer-const
  let stats!: CombatActorStats;
  // eslint-disable-next-line prefer-const
  let settlement!: CombatSettlementEngine;

  const conditions =
    options.conditions ??
    createCombatConditions({
      captureResourceCapacities: id => stats.readResourceCapacities(id),
      onApply: (id, effect: BattleBuffEffect, entry) => settlement.applyBuffResources(id, effect, entry),
      isInvincible: id => invincible.has(id),
      setInvincible: (id, enabled) => {
        if (enabled) invincible.add(id);
        else invincible.delete(id);
      },
      isInfiniteMana: id => infiniteMana.has(id),
      setInfiniteMana: (id, enabled) => {
        if (enabled) infiniteMana.add(id);
        else infiniteMana.delete(id);
      },
    });

  const statsPort: CombatActorStatsPort = {
    battleCatalog,
    characterStats,
    items,
    wardrobe,
    conditions,
    hero: options.hero as BattleCharacter | undefined,
    sessionSkills: options.sessionSkills,
    party: options.party,
    frenzyAnimations,
    hitResolution: () => hitResolution,
    memberOf: id => memberLookup(id),
    skillConfiguration:
      options.skillConfiguration ??
      ((id, member) => {
        if (id === 'player') {
          const fromSession = options.sessionSkills?.();
          if (fromSession) return fromSession;
        }
        return (member as unknown as { skills?: StorySkillProgression | CompanionSkillProgression }).skills;
      }),
    enemyOf: id => enemies.get(id),
    enemySnapshot: id => {
      const enemy = enemies.get(id);
      return enemy ? buildSnapshot(enemy) : undefined;
    },
    isEnemyPresent: id => enemies.get(id)?.present ?? false,
    isPendingDefeat: id => enemies.get(id)?.pendingDefeat ?? false,
    activeSummonCount: ownerId =>
      [...enemies.values()].filter(enemy => !enemy.pendingDefeat && enemy.summonedBy === ownerId && !!enemy.definition.commandAction).length,
    preparedSkills: resolvePrepared,
    requiresPreparedSkills: resolveRequiresPrepared,
    onMissingPreparedSkill: (id, skillId) => {
      log.missingPreparedSkills.push({ id, skillId });
    },
    random: options.random,
    ...options.statsOverrides,
  };
  stats = new CombatActorStats(statsPort);

  const defaultCombatants = (): Combatant[] => {
    const partyIds = options.activeParty?.() ?? [...members.keys()];
    const result: Combatant[] = [];
    for (const id of partyIds) {
      if (fallen.has(id)) continue;
      result.push({
        id,
        team: 'party',
        position: { x: 0, y: 0 },
        bounds: { x: -8, y: -8, width: 16, height: 16 },
        states: conditions.activeStates(id),
        facing: 'south',
      });
    }
    for (const enemy of enemies.values()) {
      if (!enemy.present || enemy.pendingDefeat) continue;
      result.push({
        id: enemy.key,
        team: enemy.summonedBy && memberLookup(enemy.summonedBy) ? 'party' : 'hostile',
        position: { x: 0, y: 0 },
        bounds: enemy.bounds ?? { x: -8, y: -8, width: 16, height: 16 },
        states: conditions.activeStates(enemy.key),
        facing: 'south',
      });
    }
    return result;
  };

  const settlementPort: CombatSettlementPort = {
    stats,
    battleCatalog,
    items,
    conditions,
    hitResolution,
    hero: options.hero as BattleCharacter | undefined,
    controlledId: options.controlledId ?? (() => 'player'),
    activeParty: options.activeParty ?? (() => (members.size ? [...members.keys()] : ['player'])),
    isClosed: () => closed,
    isDefeated: () => defeated,
    enemiesRunning: () => enemiesRunning,
    memberOf: id => memberLookup(id),
    memberActorDefinition: options.memberActorDefinition,
    groupModifiers: options.groupModifiers,
    enemyOf: id => enemies.get(id),
    allEnemies: () => [...enemies.values()],
    enemySnapshot: id => {
      const enemy = enemies.get(id);
      return enemy ? buildSnapshot(enemy) : undefined;
    },
    setEnemyHealth: (id, health) => {
      const enemy = enemies.get(id);
      if (enemy) enemy.health = Math.max(0, Math.min(enemy.maxHealth, Math.trunc(health)));
    },
    setEnemyMana: (id, mana) => {
      const enemy = enemies.get(id);
      if (enemy) enemy.mana = Math.max(0, Math.min(enemy.maxMana, Math.trunc(mana)));
    },
    isEnemyPresent: id => enemies.get(id)?.present ?? false,
    isPendingDefeat: id => enemies.get(id)?.pendingDefeat ?? false,
    isFallen: id => fallen.has(id),
    hasDisplay: id => {
      const enemy = enemies.get(id);
      if (enemy) return enemy.hasDisplay;
      return !!memberLookup(id);
    },
    combatant: options.combatant ?? (id => (options.combatants ? options.combatants() : defaultCombatants()).find(c => c.id === id)),
    combatants: options.combatants ?? defaultCombatants,
    currentTargetOf: options.currentTargetOf ?? (id => currentTargets.get(id)),
    enemyTarget: id => enemies.get(id)?.targetId,
    setReactionTarget: (actorId, targetId) => {
      currentTargets.set(actorId, targetId);
      log.reactionTargets.push({ actorId, targetId });
    },
    resetActorCooldowns: () => {},
    navigationBounds: () => undefined,
    combatTick: () => combatTick,
    isOneHitKill: () => false,
    recoveryPulseDue: () => false,
    advanceRecoveryClock: () => {},
    activeRegeneration: () => undefined as RecoveryItems['activeRegeneration'],
    recoverCombatResources: (_actors: readonly ResourceRecoveryActor[]): readonly ResourceRecoveryPulse[] => [],
    onStateConsequences: (id, states) => {
      log.stateConsequences.push({ id, states });
    },
    onStealthBroken: actorId => {
      log.stealthBroken.push(actorId);
    },
    onActionShake: () => {
      log.shakes += 1;
    },
    onActionSound: (casterId, sound) => {
      log.actionSounds.push({ casterId, sound });
    },
    onBuffApplication: (sourceId, targetId, effect) => {
      log.buffApplications.push({ sourceId, targetId, effect });
    },
    onShowEffects: (actorId, targetId, effects) => {
      log.effects.push({ actorId, targetId, effects });
    },
    onUnitFeedback: (hit, outcome, cue) => {
      log.unitFeedback.push({ hit, outcome, cue });
    },
    onShowHit: (event, hit, presentation) => {
      log.hits.push({ event, hit, ...presentation });
    },
    onDropMana: (casterId, damage, target, rule) => {
      log.droppedMana.push({ casterId, damage, target, rule });
    },
    onMemberDefeated: id => {
      log.defeatedMembers.push(id);
    },
    onEnemyZeroHealth: (enemy, before, casterId) => {
      log.zeroHealthEnemies.push({ key: enemy.key, before, casterId });
    },
    onEnemyContact: (enemy, event) => {
      log.enemyContacts.push({ enemyKey: enemy.key, event });
    },
    removeEnemy: key => {
      log.removedEnemies.push(key);
      enemies.delete(key);
    },
    spawnSummonFromUnit: request => {
      log.summonSpawns.push(request);
      return true;
    },
    followUp: (kind, casterId, targetId) => {
      log.followUps.push({ kind, casterId, targetId });
    },
    isSkillPrepared: (ownerId, skillId) => !!resolvePrepared(ownerId)?.has(skillId),
    requiresPreparedSkills: resolveRequiresPrepared,
    random: options.random,
    ...options.settlementOverrides,
  };
  settlement = new CombatSettlementEngine(settlementPort);

  let threat: CombatThreatSystem | undefined;
  if (options.withThreat !== false && !options.settlementOverrides?.threat) {
    threat = settlement.createThreatSystem();
    settlement.setThreatSystem(threat);
  } else {
    threat = options.settlementOverrides?.threat;
  }

  return {
    battleCatalog,
    items,
    wardrobe,
    characterStats,
    members,
    enemies,
    fallen,
    invincible,
    infiniteMana,
    currentTargets,
    conditions,
    hitResolution,
    frenzyAnimations,
    stats,
    settlement,
    threat,
    log,
    setClosed: (value: boolean) => {
      closed = value;
    },
    setDefeated: (value: boolean) => {
      defeated = value;
    },
    setEnemiesRunning: (value: boolean) => {
      enemiesRunning = value;
    },
    setCombatTick: (tick: number) => {
      combatTick = tick;
    },
  };
}

export function createTestGameUi(): { showInstant(): void } {
  return {
    showInstant() {},
  };
}

export function createSimpleStatsPort(overrides: Partial<CombatActorStatsPort>): CombatActorStats {
  return new CombatActorStats({
    battleCatalog: loadBattleCatalog(),
    characterStats: loadCharacterStatsCatalog(),
    items: loadItemCatalog(),
    wardrobe: loadWardrobeCatalog(),
    conditions: createCombatConditions({
      captureResourceCapacities: () => ({ maxHealth: 1000, maxMana: 100 }),
      onApply: () => {},
      isInvincible: () => false,
      setInvincible: () => {},
      isInfiniteMana: () => false,
      setInfiniteMana: () => {},
    }),
    memberOf: () => undefined,
    enemyOf: () => undefined,
    enemySnapshot: () => undefined,
    isEnemyPresent: () => false,
    ...overrides,
  });
}

export type { BattleStatKey };

import {
  skillForMember,
  skillManaCost,
  type BattleCatalog,
  type BasicAttackSelection,
  type EnemyDefinition,
  type EnemyPlayableSkill,
  type ResolvedBasicAttack,
  type SkillAction,
  type SkillDefinition,
  type SkillLoadout,
} from './battle.ts';
import type { BattleStatKey } from './battle-semantics.ts';
import { resolveBasicAttack } from './basic-attack.ts';
import type { Bag } from './bag.ts';
import {
  equipmentPower,
  fighterBaseFromPanel,
  type BattleCharacter,
  type CharacterStatsCatalog,
} from './character-stats.ts';
import {
  CombatConditions,
  type ResourceCapacities,
  type ResourceCapacityKey,
} from './combat-conditions.ts';
import {
  bestNormalDamage,
  type CombatActorAttributes,
} from './combat-damage-source.ts';
import type { CombatHitResolution } from './combat-hit-resolution.ts';
import { calculateManaCost, defaultResourceAttributes } from './combat-resources.ts';
import type { CompanionSkillProgression } from './companion-progression.ts';
import type { ActorDefinition } from './content.ts';
import { baseOffhandAttackChance, chooseDualWield, offhandPhysicalAttack } from './dual-wield.ts';
import type { EnemySnapshot } from './enemy-stats.ts';
import { combatEquipmentEffects } from './equipment-combat-procs.ts';
import type { FrenzyAnimationMemory } from './frenzy-animation.ts';
import type { ItemCatalog } from './items.ts';
import type { CompanionMember, PartyRoster } from './party.ts';
import { memberCombatModifiers } from './party-combat.ts';
import type { PassiveModifier } from './passive-skills.ts';
import { calculateMagicResistance, type PhysicalFighter } from './physical-hit.ts';
import { skillClips } from './skill-action.ts';
import {
  learnedSkillReactions,
  type LearnedReactionSkill,
  type SkillReaction,
  type SkillReactionBuff,
} from './skill-reactions.ts';
import type { StorySkillProgression } from './story-skills.ts';
import { costumeRecipe, equipmentAttackFor, hasOffhandShield, type WardrobeCatalog } from './wardrobe.ts';
import { memberSkillGrowth } from './battle.ts';
import type { PlaybackSkillSelection } from './combatant.ts';

const UNEQUIPPED_EFFECTS = combatEquipmentEffects([]);
/** 组队被动与 AI 蓝耗缓存共用的低血量阈值：30%。 */
export const LOW_HEALTH_THRESHOLD_PERCENT = 30;

export interface ReactionSkillEntry {
  configuration: StorySkillProgression | CompanionSkillProgression;
  version: number;
  catalog: BattleCatalog;
  classId: string;
  growth: ReturnType<typeof memberSkillGrowth>;
  prepared: ReadonlySet<string> | undefined;
  requiresAssets: boolean;
  loadout: SkillLoadout;
  reactions: readonly SkillReaction[];
}

export interface CombatActorStatsPort {
  readonly battleCatalog: BattleCatalog;
  readonly characterStats?: CharacterStatsCatalog;
  readonly items: ItemCatalog;
  readonly wardrobe: WardrobeCatalog;
  readonly conditions: CombatConditions;
  readonly hero?: BattleCharacter;
  readonly sessionSkills?: () => StorySkillProgression | undefined;
  readonly party?: () => PartyRoster | undefined;
  readonly frenzyAnimations?: FrenzyAnimationMemory;
  readonly hitResolution?: () => CombatHitResolution | undefined;
  memberOf(id: string): BattleCharacter | CompanionMember | undefined;
  skillConfiguration?(id: string, member: BattleCharacter | CompanionMember): StorySkillProgression | CompanionSkillProgression | undefined;
  enemyOf(id: string): { key: string; definition: EnemyDefinition; summonedBy?: string } | undefined;
  enemySnapshot(id: string, definition: EnemyDefinition, heroLevel: number): Readonly<EnemySnapshot> | undefined;
  isEnemyPresent(id: string, enemyId: string): boolean;
  isPendingDefeat?(id: string): boolean;
  activeSummonCount?(ownerId: string): number;
  preparedSkills?(id: string): ReadonlySet<string> | undefined;
  requiresPreparedSkills?(): boolean;
  onMissingPreparedSkill?(id: string, skillId: string): void;
  random?(): number;
}

/**
 * 纯领域战斗属性、被动修正、技能表与基础攻击装配求值器（零 Phaser 依赖）。
 * 统一管理每名参战角色的装备词条、被动、反应定义与 AI 蓝耗缓存。
 */
export class CombatActorStats {
  private readonly port: CombatActorStatsPort;
  private readonly passivesCache = new Map<string, { key: string; value: PassiveModifier[] }>();
  private readonly skillTableCache = new Map<string, { key: string; value: EnemyPlayableSkill[] }>();
  private readonly reactionSkillCache = new Map<string, ReactionSkillEntry>();
  private readonly equipmentEffectsCache = new Map<string, { bag: Bag; revision: number; value: ReturnType<typeof combatEquipmentEffects> }>();
  private readonly aiSkillCostCache = new Map<string, { key: string; costs: Map<string, number | undefined> }>();

  constructor(port: CombatActorStatsPort) {
    this.port = port;
  }

  private get heroLevel(): number {
    return this.port.hero?.level ?? 1;
  }

  private skillConfiguration(id: string, member: BattleCharacter | CompanionMember): StorySkillProgression | CompanionSkillProgression | undefined {
    if (this.port.skillConfiguration) return this.port.skillConfiguration(id, member);
    return id === 'player' ? this.port.sessionSkills?.() : (member as CompanionMember).skills;
  }

  equipmentEffects(id: string): ReturnType<typeof combatEquipmentEffects> {
    const bag = this.port.memberOf(id)?.bag;
    if (!bag) return UNEQUIPPED_EFFECTS;
    const cached = this.equipmentEffectsCache.get(id);
    if (cached?.bag === bag && cached.revision === bag.revision) return cached.value;
    const equipped = Object.values(bag.equipmentFor(id)).flatMap(item => {
      const entry = bag.get(item!);
      return entry ? [entry] : [];
    });
    const value = combatEquipmentEffects(equipped);
    this.equipmentEffectsCache.set(id, { bag, revision: bag.revision, value });
    return value;
  }

  equipmentRecovery(id: string) {
    return this.equipmentEffects(id).recovery;
  }

  combatProcs(id: string) {
    return this.equipmentEffects(id).combat;
  }

  partyPassives(id: string): PassiveModifier[] {
    const member = this.port.memberOf(id);
    if (!member) return [];
    const configuration = this.skillConfiguration(id, member);
    if (!configuration) return [];
    const growth = memberSkillGrowth(id);
    // 血量只在跨过 30% 阈值时影响组队被动；用布尔值做键，避免每次受击都重建。
    const lowHealth = member.player.health <= Math.floor(member.player.maxHealth * LOW_HEALTH_THRESHOLD_PERCENT / 100) ? 1 : 0;
    const stealthed = this.port.conditions.hasState(id, 'stealthed') ? 1 : 0;
    const party = this.port.party?.();
    const groupVersion = party?.groupModifierVersion ?? 0;
    const key = `${id}|${member.classId}|${configuration.version}|${member.bag.revision}|${lowHealth}|${stealthed}|${groupVersion}|${growth}`;
    const cached = this.passivesCache.get(id);
    if (cached?.key === key) return cached.value;
    const equipped = member.bag.equipmentItems(member.bag.equipmentFor(id));
    const main = equipped['main-hand'];
    const weapon = main ? this.port.items.items[main]?.kind ?? 'unarmed' : 'unarmed';
    const armor = equipped.body ? this.port.items.items[equipped.body].kind : '';
    const value = memberCombatModifiers({
      catalog: this.port.battleCatalog,
      classId: member.classId,
      loadout: configuration.draft(this.port.battleCatalog, member.classId),
      weaponKind: weapon,
      armorKind: armor,
      health: member.player.health,
      maxHealth: member.player.maxHealth,
      groupEffects: party?.groupModifiers() ?? {},
      stealthed: stealthed === 1,
      growth,
    });
    this.passivesCache.set(id, { key, value });
    return value;
  }

  /** 读取角色所属队伍的光环/组队修饰符。 */
  groupModifiers(): Partial<Record<string, number>> {
    return this.port.party?.()?.groupModifiers() ?? {};
  }

  /** 读取角色技能配置中未经过资源裁切的原始技能等级（供召唤物嘲讽等规则使用）。 */
  skillLevel(id: string, skillId: string): number | undefined {
    const member = this.port.memberOf(id);
    if (!member) return undefined;
    return this.skillConfiguration(id, member)?.draft(this.port.battleCatalog, member.classId).levels[skillId];
  }

  /** 技能定义只在配置或资源准备范围变化时重建；事件与随机结果仍在各次命中时结算。 */
  reactionSkills(id: string): ReactionSkillEntry | undefined {
    const member = this.port.memberOf(id);
    if (!member) return;
    const configuration = this.skillConfiguration(id, member);
    if (!configuration) return;
    const catalog = this.port.battleCatalog;
    const classId = member.classId;
    const growth = memberSkillGrowth(id);
    const prepared = this.port.preparedSkills?.(id);
    const requiresAssets = this.port.requiresPreparedSkills?.() === true;
    const cached = this.reactionSkillCache.get(id);
    if (
      cached &&
      cached.configuration === configuration &&
      cached.version === configuration.version &&
      cached.catalog === catalog &&
      cached.classId === classId &&
      cached.growth === growth &&
      cached.prepared === prepared &&
      cached.requiresAssets === requiresAssets
    ) {
      return cached;
    }
    const loadout = configuration.draft(catalog, classId);
    if (requiresAssets) {
      for (const skillId of Object.keys(loadout.levels)) {
        if (!prepared?.has(skillId)) loadout.levels[skillId] = 0;
      }
    }
    const value: ReactionSkillEntry = {
      configuration,
      version: configuration.version,
      catalog,
      classId,
      growth,
      prepared,
      requiresAssets,
      loadout,
      reactions: learnedSkillReactions(catalog, classId, loadout, growth),
    };
    this.reactionSkillCache.set(id, value);
    return value;
  }

  learnedReactionBuff(id: string, skillId: LearnedReactionSkill): SkillReactionBuff | undefined {
    const member = this.port.memberOf(id);
    if (!member) return;
    const skills = this.reactionSkills(id);
    if (!skills) return;
    const level = skills.loadout.levels[skillId];
    if (!level || level < 1) {
      // 破甲类被动（如龙枪武士「穿甲枪劲」）共享 armor-penetration 反应类型，已按 preparedSkills 过滤。
      if (skillId === 'armor-penetration') {
        const fallback = skills.reactions.find(reaction => reaction.kind === 'armor-penetration');
        return fallback && 'buff' in fallback ? fallback.buff : undefined;
      }
      return;
    }
    if (this.port.requiresPreparedSkills?.() && !this.port.preparedSkills?.(id)?.has(skillId)) return;
    if (skillId === 'whist') {
      const unit = skillForMember(this.port.battleCatalog, id, 'whist')?.action?.combatUnits?.find(value => value.effect === 'buff');
      if (unit?.effect !== 'buff') return;
      const rank = unit.ranks[Math.min(level, unit.ranks.length) - 1];
      return { key: unit.buff, rankPriority: rank.strength, effect: rank.effect };
    }
    if (
      skillId === 'armor-penetration' ||
      skillId === 'revenge-incarnate' ||
      skillId === 'bard-of-destruction' ||
      skillId === 'deep-breath' ||
      skillId === 'sniping' ||
      skillId === 'blood-revenge'
    ) {
      const ranks = skillForMember(this.port.battleCatalog, id, skillId)?.reactionsByRank;
      const reaction = ranks?.[Math.min(level, ranks.length) - 1]?.find(item => item.kind === skillId);
      return reaction && 'buff' in reaction ? reaction.buff : undefined;
    }
    const unit = skillForMember(this.port.battleCatalog, id, skillId)?.action?.combatUnits?.find(entry => entry.effect === 'buff' && entry.buff === 'dark-strike');
    if (unit?.effect !== 'buff') return;
    const rank = unit.ranks[Math.min(level, unit.ranks.length) - 1];
    return { key: unit.buff, rankPriority: rank.strength, effect: rank.effect };
  }

  resourceCapacityInputs(id: string): { base: { maxHealth: number; maxMana: number } } | undefined {
    const member = this.port.memberOf(id);
    const enemy = this.port.enemyOf(id);
    const base = member?.panel ?? (enemy && this.port.enemySnapshot(id, enemy.definition, this.heroLevel));
    if (!base) return;
    for (const key of ['maxHealth', 'maxMana'] as const) {
      this.port.conditions.setResourceCapacityInputs(id, key, base[key]);
    }
    return { base };
  }

  readResourceCapacity(id: string, key: ResourceCapacityKey, inputs = this.resourceCapacityInputs(id)): number {
    if (!inputs) return 0;
    return this.port.conditions.readResourceCapacity(id, key, () => {
      const capacity = Math.max(0, this.port.conditions.attribute(id, key, inputs.base[key]));
      this.port.memberOf(id)?.setCombatResourceCapacity(key, capacity);
      return capacity;
    });
  }

  readResourceCapacities(id: string): ResourceCapacities {
    const inputs = this.resourceCapacityInputs(id);
    if (!inputs) return { maxHealth: 0, maxMana: 0 };
    return {
      maxHealth: this.readResourceCapacity(id, 'maxHealth', inputs),
      maxMana: this.readResourceCapacity(id, 'maxMana', inputs),
    };
  }

  syncCombatResourceLimits(id: string): void {
    const member = this.port.memberOf(id);
    const inputs = this.resourceCapacityInputs(id);
    if (!member || !inputs) return;
    member.setCombatResourceLimits(
      this.readResourceCapacity(id, 'maxHealth', inputs),
      this.readResourceCapacity(id, 'maxMana', inputs),
    );
  }

  actorAttribute(id: string, key: BattleStatKey): number {
    if (key === 'maxHealth' || key === 'maxMana') return this.readResourceCapacity(id, key);
    const cached = this.port.conditions.cachedAttribute(id, key);
    if (cached !== undefined) return cached;
    if (key === 'bestNormalDamage') {
      const attributes = this.actorAttributes(id);
      return attributes ? bestNormalDamage(attributes) : 0;
    }
    const member = this.port.memberOf(id);
    const enemy = this.port.enemyOf(id);
    const enemyState = enemy && this.port.enemySnapshot(id, enemy.definition, this.heroLevel);
    const defaults = defaultResourceAttributes(member ? 'member' : 'monster', member?.level ?? enemyState?.level ?? 0);
    let original: number;
    const attackProcAttribute = [
      'windStrikeChance',
      'fireSplashChance',
      'frostStrikeChance',
      'divineStrikeChance',
      'darknessStrikeChance',
      'poisonStrikeChance',
    ].includes(key);
    const equipmentCombatAttribute = [
      'pendulumStunChance',
      'frostRetaliationChance',
      'healingEnergyChance',
      'zealotRate',
      'instantRecoveryPerThousand',
    ].includes(key);
    if (attackProcAttribute) {
      const rates = this.equipmentEffects(id).attack;
      original = rates[key as keyof typeof rates];
    } else if (equipmentCombatAttribute) {
      const rates = this.combatProcs(id);
      original = rates[key as keyof typeof rates];
    } else if (key === 'threatReductionRate') {
      original = this.equipmentEffects(id).threat;
    } else if (key === 'offhandAttackChance') {
      const equipped = member?.bag.equipmentItems(member.bag.equipmentFor(id));
      const offhand = equipped?.['off-hand'];
      const armor = equipped?.body;
      original = baseOffhandAttackChance(
        member?.classId ?? '',
        offhand ? this.port.items.items[offhand].kind : 'empty',
        armor ? this.port.items.items[armor].kind : '',
        this.port.items.dualWieldClasses,
      );
    } else if (key === 'threatGenerationRate') {
      original = 1000;
    } else if (key in defaults) {
      original =
        defaults[key as keyof typeof defaults] +
        (key === 'manaRecoveryPerPulse'
          ? this.equipmentRecovery(id).manaRecoveryPerPulse
          : key === 'manaCostReductionRate'
            ? this.equipmentRecovery(id).manaCostReductionRate
            : 0);
    } else {
      const base = member?.panel ?? enemyState;
      original =
        key === 'defense' && member
          ? member.panel.baseDefense
          : key === 'magicResistance' && member
            ? member.panel.baseMagicResistance
            : base && key in base
              ? Number(base[key as keyof typeof base])
              : key === 'healingPowerRate' || key === 'moveSpeed'
                ? 1000
                : 0;
    }
    const value = this.port.conditions.attribute(id, key, original, member ? this.partyPassives(id) : []);
    if (key === 'magicResistance') return this.port.conditions.cachedAttribute(id, key) ?? calculateMagicResistance(value);
    return attackProcAttribute ||
      equipmentCombatAttribute ||
      key in defaults ||
      key === 'physicalAttack' ||
      key === 'magicAttack' ||
      key === 'defense' ||
      key === 'defenseRate' ||
      key === 'healingPowerRate' ||
      key === 'threatGenerationRate' ||
      key === 'threatReductionRate' ||
      key === 'sightBonusUnits' ||
      key === 'bloodThirstChance' ||
      key === 'bloodThirstLifeDrainPerThousand' ||
      key === 'bloodThirstManaRecovery' ||
      key === 'revengeChance' ||
      key === 'cooldownResetChance' ||
      key === 'defenseCooldownResetChance' ||
      key === 'offhandAttackChance' ||
      key === 'frenzyAttackChance'
      ? Math.max(0, value)
      : value;
  }

  actorAttributes(id: string): CombatActorAttributes | undefined {
    const member = this.port.memberOf(id);
    const enemy = this.port.enemyOf(id);
    const base = member?.panel ?? (enemy && this.port.enemySnapshot(id, enemy.definition, this.heroLevel));
    if (!base) return;
    const passives = member ? this.partyPassives(id) : [];
    const attribute = (key: 'physicalAttack' | 'magicAttack' | 'maxHealth' | 'physicalDamageRate' | 'magicDamageRate', original: number) =>
      Math.max(0, this.port.conditions.attribute(id, key, original, passives));
    return {
      physicalAttack: attribute('physicalAttack', base.physicalAttack),
      magicAttack: attribute('magicAttack', base.magicAttack),
      maxHealth: attribute('maxHealth', base.maxHealth),
      physicalDamageRate: attribute('physicalDamageRate', 0),
      magicDamageRate: attribute('magicDamageRate', 0),
      stealthDamageRate:
        this.port.conditions.attribute(id, 'stealthAttackEnabled', 0, passives) > 0
          ? this.port.conditions.attribute(id, 'stealthDamageRate', 0, passives)
          : 0,
      primaryAttributes: member?.panel.attributes ?? { strength: 0, dexterity: 0, vitality: 0, intelligence: 0, mentality: 0 },
    };
  }

  partyFighter(id: string): PhysicalFighter | undefined {
    const member = this.port.memberOf(id);
    if (!member || (member.player.health <= 0 && !this.port.hitResolution?.()?.isAwaitingDefeat(id))) return;
    const panel = member.panel;
    const passives = this.partyPassives(id);
    return this.port.conditions.fighter(
      id,
      fighterBaseFromPanel(panel, member.level, this.combatProcs(id).zealotRate),
      passives,
      { offhandShield: panel.offhandShield },
    );
  }

  enemyFighter(key: string, definition: EnemyDefinition, playerLevel: number): PhysicalFighter | undefined {
    if (this.port.isPendingDefeat?.(key) || !this.port.isEnemyPresent(key, definition.id)) return;
    const stats = this.port.enemySnapshot(key, definition, playerLevel);
    if (!stats || stats.health <= 0) return;
    return this.port.conditions.fighter(key, {
      level: stats.level,
      physicalAttack: stats.physicalAttack,
      defense: stats.defense,
      defenseRate: stats.defenseRate,
      physicalResistanceBonus: stats.physicalResistanceBonus,
      magicAttack: stats.magicAttack,
      maxHealth: stats.maxHealth,
      hitBase: stats.hitBase,
      hitBonus: stats.hitBonus,
      evasionBase: stats.evasionBase,
      evasionBonus: stats.evasionBonus,
      criticalRate: stats.criticalRate,
      criticalResistance: stats.criticalResistance,
      criticalDamage: stats.criticalDamage,
      criticalDamageResistance: stats.criticalDamageResistance,
      weaponBlock: stats.weaponBlock,
      shieldBlock: stats.shieldBlock,
      physicalResistance: stats.physicalResistance,
      magicResistance: stats.magicResistance,
    });
  }

  fighterOf(id: string): PhysicalFighter | undefined {
    if (this.port.memberOf(id)) return this.partyFighter(id);
    const enemy = this.port.enemyOf(id);
    return enemy ? this.enemyFighter(enemy.key, enemy.definition, this.heroLevel) : undefined;
  }

  skillManaCost(id: string, skillId: string, level: number | undefined): number | undefined {
    const base = skillManaCost(skillForMember(this.port.battleCatalog, id, skillId), level);
    return base === undefined
      ? undefined
      : calculateManaCost(base, this.actorAttribute(id, 'manaCostRate'), this.actorAttribute(id, 'manaCostReductionRate'));
  }

  manaCostOf(skill: SkillDefinition | undefined, id: string, level: number | undefined): number | undefined {
    const base = skillManaCost(skill, level);
    return base === undefined
      ? undefined
      : calculateManaCost(base, this.actorAttribute(id, 'manaCostRate'), this.actorAttribute(id, 'manaCostReductionRate'));
  }

  canSelectSkill(id: string, skill: PlaybackSkillSelection, resolvedAction?: SkillAction | null): boolean {
    if (this.port.requiresPreparedSkills?.() && !this.port.preparedSkills?.(id)?.has(skill.id)) {
      this.port.onMissingPreparedSkill?.(id, skill.id);
      return false;
    }
    const action =
      resolvedAction === undefined
        ? (skillForMember(this.port.battleCatalog, id, skill.id)?.action ?? null)
        : resolvedAction;
    const gate = action?.minHealthRatePerThousand ?? skill.action.minHealthRatePerThousand;
    if (gate !== undefined) {
      // 严格大于：等于门槛不可起手。也要求自己的生命上限缓存有效。
      const member = this.port.memberOf(id);
      const maxHealth = member ? this.readResourceCapacity(id, 'maxHealth') : 0;
      const health = member?.player.health ?? 0;
      if (!(maxHealth > 0) || health <= Math.trunc((maxHealth * gate) / 1000)) return false;
    }
    // 原版条件 37：没有自己的活动召唤就不能起手，判定放在扣蓝与冷却之前。
    if ((action?.requiresActiveSummon ?? skill.action.requiresActiveSummon) && !(this.port.activeSummonCount?.(id) ?? 0)) {
      return false;
    }
    const requirement = action?.requiredOffhand ?? skill.action.requiredOffhand;
    if (requirement !== 'shield') return true;
    const member = this.port.memberOf(id);
    if (!member) return false;
    const bag = this.port.hero?.bag ?? member.bag;
    const equipment = bag.equipmentItems(bag.equipmentFor(id));
    const defaultShield =
      member === this.port.hero ? this.port.wardrobe.defaultShield : (member as CompanionMember).definition?.defaultShield;
    return hasOffhandShield(this.port.items, equipment, defaultShield);
  }

  skillSlotAvailable(controlledId: string, skillId: string): boolean {
    const skill = skillForMember(this.port.battleCatalog, controlledId, skillId);
    return (
      !!skill?.action &&
      this.port.conditions.canUseSkillShortcuts(controlledId) &&
      this.canSelectSkill(controlledId, { id: skillId, action: skill.action }, skill.action)
    );
  }

  skillShortcutState(controlledId: string, skillId: string, level: number | undefined): { cost: number; enabled: boolean } {
    const skill = skillForMember(this.port.battleCatalog, controlledId, skillId);
    const available =
      !!skill?.action &&
      this.port.conditions.canUseSkillShortcuts(controlledId) &&
      this.canSelectSkill(controlledId, { id: skillId, action: skill.action }, skill.action);
    return { cost: this.manaCostOf(skill, controlledId, level) ?? 0, enabled: available };
  }

  partySkillsFor(id: string): EnemyPlayableSkill[] {
    const member = this.port.memberOf(id)!;
    const character = this.port.battleCatalog.classes.find(value => value.id === member.classId)!;
    const configuration = this.skillConfiguration(id, member)!;
    const growth = memberSkillGrowth(id);
    const key = `${id}|${member.classId}|${configuration.version}|${member.bag.revision}|${growth}`;
    const cached = this.skillTableCache.get(id);
    if (cached?.key === key) return cached.value;
    const draft = configuration.draft(this.port.battleCatalog, member.classId);
    const actions = costumeRecipe(
      this.port.wardrobe,
      this.port.items,
      member.bag.equipmentItems(member.bag.equipmentFor(id)),
      member.classId,
    ).actions;
    const value = character.skills.flatMap(skillId => {
      const skill = skillForMember(this.port.battleCatalog, id, skillId)!;
      const level = draft.levels[skillId];
      const action = skillId in actions ? actions[skillId] : skill.action;
      if (!action || !level) return [];
      return [
        {
          id: skillId,
          name: skill.name,
          action: skill.action
            ? {
                ...action,
                hitEffectStyle: skill.action.hitEffectStyle,
                usesSkillDamageBuff: skill.action.usesSkillDamageBuff,
                combatUnits: skill.action.combatUnits,
                repeat: skill.action.repeat
                  ? {
                      ...skill.action.repeat,
                      restartAfterFrame: action.repeat?.restartAfterFrame ?? skill.action.repeat.restartAfterFrame,
                    }
                  : undefined,
              }
            : action,
          level,
          manaCost: this.skillManaCost(id, skillId, level),
          frequency: 0,
          clips: skillClips(skillId),
        } as EnemyPlayableSkill,
      ];
    });
    this.skillTableCache.set(id, { key, value });
    return value;
  }

  /**
   * 队友 AI 的蓝耗缓存。临时属性或按时间增长的蓝耗修正会让结果随时变化，
   * 这两种情况直接返回 undefined，调用方改为每次现算，避免拿旧值。
   */
  aiSkillCosts(
    id: string,
    member: BattleCharacter | CompanionMember,
    skills: readonly EnemyPlayableSkill[],
  ): Map<string, number | undefined> | undefined {
    if (
      this.port.conditions.cachedAttribute(id, 'manaCostRate') !== undefined ||
      this.port.conditions.cachedAttribute(id, 'manaCostReductionRate') !== undefined ||
      this.port.conditions.hasManaCostAttributeRamp(id)
    ) {
      return undefined;
    }
    const configuration = this.skillConfiguration(id, member);
    if (!configuration) return undefined;
    const lowHealth = member.player.health <= Math.floor((member.player.maxHealth * LOW_HEALTH_THRESHOLD_PERCENT) / 100) ? 1 : 0;
    const stealthed = this.port.conditions.hasState(id, 'stealthed') ? 1 : 0;
    const groupVersion = this.port.party?.()?.groupModifierVersion ?? 0;
    const levels = skills.map(skill => `${skill.id}:${skill.level}`).join(',');
    const key = `${member.classId}|${configuration.version}|${member.bag.revision}|${this.port.conditions.revision}|${lowHealth}|${stealthed}|${groupVersion}|${levels}`;
    const cached = this.aiSkillCostCache.get(id);
    if (cached?.key === key) return cached.costs;
    const costs = new Map<string, number | undefined>();
    this.aiSkillCostCache.set(id, { key, costs });
    return costs;
  }

  cachedAiSkillCost(costs: Map<string, number | undefined>, id: string, skill: EnemyPlayableSkill): number | undefined {
    if (costs.has(skill.id)) return costs.get(skill.id);
    const value = this.skillManaCost(id, skill.id, skill.level);
    costs.set(skill.id, value);
    return value;
  }

  syncAiSkills(id: string): EnemyPlayableSkill[] {
    const party = this.port.party?.();
    const frequencies = party?.aiFrequency(id);
    const latest = this.partySkillsFor(id);
    const member = this.port.memberOf(id);
    const costs = member ? this.aiSkillCosts(id, member, latest) : undefined;
    for (const skill of latest) {
      // 蓝耗按当前属性更新；频率保留玩家设置，施法和留蓝判断共用这个费用。
      skill.manaCost = costs ? this.cachedAiSkillCost(costs, id, skill) : this.skillManaCost(id, skill.id, skill.level);
      skill.frequency = frequencies?.get(skill.id) ?? 1;
    }
    return latest;
  }

  equipmentAttack(actor: ActorDefinition, id = 'player', step = 0): ResolvedBasicAttack {
    const bag = this.port.hero?.bag ?? this.port.memberOf(id)!.bag;
    return equipmentAttackFor(this.port.wardrobe, this.port.items, bag, actor, id, step);
  }

  selectBasicAttack(id: string, actor: ActorDefinition, normal: ResolvedBasicAttack, step = 0): BasicAttackSelection {
    const member = this.port.memberOf(id);
    if (!member) return normal;
    const equipment = member.bag.equipmentItems(member.bag.equipmentFor(id));
    const offhand = equipment['off-hand'];
    const normalStep = () => (step === 0 ? normal : this.equipmentAttack(actor, id, step));
    const random = this.port.random ?? Math.random;
    if (
      chooseDualWield(
        member.classId,
        !!offhand && this.port.items.items[offhand].equipment?.slot === 'main-hand',
        { random, chance: () => this.actorAttribute(id, 'offhandAttackChance') },
        this.port.items.dualWieldClasses,
      )
    ) {
      const profile = costumeRecipe(this.port.wardrobe, this.port.items, equipment).dualWieldAttack;
      if (!profile) return normalStep();
      return resolveBasicAttack(
        { basicAttacks: { 'dual-wield': profile } },
        { actor, basicAttack: { profileId: 'dual-wield', clips: profile.clips } },
      );
    }
    if (this.actorAttribute(id, 'frenzyAttackChance') <= 0) return normalStep();
    // 先掷点再读属性：原生读取顺序被战斗测试固定，不能为了复用判定函数调换。
    const roll = Math.floor(random() * 999) + 1;
    if (roll >= this.actorAttribute(id, 'frenzyAttackChance')) return normalStep();
    const recipe = costumeRecipe(this.port.wardrobe, this.port.items, member.bag.equipmentItems(member.bag.equipmentFor(id)));
    if (!recipe.frenzyAttack && recipe.frenzyWaitFrames === undefined) {
      throw new Error('当前装备缺少战栗的狂气动作定义');
    }
    if (!this.port.frenzyAnimations) throw new Error('狂气动作记忆未装配');
    const durationFrames = this.port.frenzyAnimations.select(
      id,
      recipe.frenzyAttack?.cycleFrames,
      recipe.frenzyWaitFrames ?? recipe.frenzyAttack!.cycleFrames,
    );
    return recipe.frenzyAttack
      ? resolveBasicAttack(
          { basicAttacks: { frenzy: recipe.frenzyAttack } },
          { actor, basicAttack: { profileId: 'frenzy', clips: recipe.frenzyAttack.clips } },
        )
      : { kind: 'animation-unavailable', durationFrames };
  }

  /** 双手主武器判定：供命中反应链读取。 */
  isTwoHanded(id: string): boolean {
    const member = this.port.memberOf(id);
    const main = member?.bag.equipmentItems(member.bag.equipmentFor(id))['main-hand'];
    return !!(main && this.port.items.items[main]?.equipment?.twoHanded);
  }

  /** 副手物理攻击力重算：保留主手与副手装备实例读数。 */
  offhandPhysicalAttackFor(id: string, basePhysicalAttack: number): number | undefined {
    const member = this.port.memberOf(id);
    if (!member) return undefined;
    const equipped = member.bag.equipmentFor(id);
    const power = (slot: 'main-hand' | 'off-hand') => {
      const key = equipped[slot];
      const entry = key ? member.bag.get(key) : undefined;
      const definition = (this.port.characterStats ?? this.port.hero?.catalog)?.equipment[entry?.item ?? ''];
      return entry && definition ? equipmentPower(definition, entry).attack : 0;
    };
    return offhandPhysicalAttack(basePhysicalAttack, power('main-hand'), power('off-hand'));
  }

  forgetMemberCaches(id: string): void {
    this.passivesCache.delete(id);
    this.skillTableCache.delete(id);
    this.reactionSkillCache.delete(id);
    this.equipmentEffectsCache.delete(id);
    this.aiSkillCostCache.delete(id);
  }

  clearAiSkillCosts(): void {
    this.aiSkillCostCache.clear();
  }

  clear(): void {
    this.passivesCache.clear();
    this.skillTableCache.clear();
    this.reactionSkillCache.clear();
    this.equipmentEffectsCache.clear();
    this.aiSkillCostCache.clear();
  }
}

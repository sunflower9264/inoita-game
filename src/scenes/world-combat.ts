import Phaser from 'phaser';
import type { AssetLease } from '../application/assets.ts';
import { displaySettings } from '../application/display-settings.ts';
import type { StoryContext } from '../application/ports.ts';
import { faceTarget, resolveBasicAttack } from '../domain/basic-attack.ts';
import type { BattleBuffKey, BattleStatKey, BattleStateKey } from '../domain/battle-semantics.ts';
import {
  LOGIC_FRAME_MS,
  enemySkills,
  skillForMember,
  type EnemyDefinition,
  type EnemyPlayableSkill,
  type PlacedEnemy,
  type SkillAction,
  type SkillFeedbackEvent,
} from '../domain/battle.ts';
import { combatMovementSpeed } from '../domain/combat-tempo.ts';
import type { BattleCharacter } from '../domain/character-stats.ts';
import { combatActor, refreshCombatActors } from '../domain/combat-actor-lookup.ts';
import { CombatActionDispatcher } from '../domain/combat-action-dispatcher.ts';
import { CombatActorStats } from '../domain/combat-actor-stats.ts';
import type { CombatConditions } from '../domain/combat-conditions.ts';
import { feedbackPlan, selectFeedbackAssets, type HitEffectStyle } from '../domain/combat-feedback.ts';
import { combatFollowUp, type CombatFollowUpPort } from '../domain/combat-follow-ups.ts';
import { CombatHitResolution } from '../domain/combat-hit-resolution.ts';
import { ENEMY_DEFEAT_SETTLE_FRAMES, PendingEnemyDefeats } from '../domain/combat-outcomes.ts';
import { CombatRuntime } from '../domain/combat-runtime.ts';
import {
  CombatSettlementEngine,
  createCombatConditions,
  summonCommandAction,
  type SummonUnitSpawnRequest,
} from '../domain/combat-settlement.ts';
import { prepareCombatRestore, type WorldCombatState } from '../domain/combat-snapshot.ts';
import { CombatSpatialIndex, type CombatQueryCircle } from '../domain/combat-spatial-index.ts';
import type { CombatThreatSystem } from '../domain/combat-threat-system.ts';
import {
  CombatController,
  canTargetCombatant,
  type ActionPlayback,
  type AttackContact,
  type Combatant,
} from '../domain/combat.ts';
import type { CompanionSkillProgression } from '../domain/companion-progression.ts';
import type { ActorDefinition, ClipName, Facing } from '../domain/content.ts';
import { type DropCatalog } from '../domain/drops.ts';
import { ENEMY_IDLE_THINK_FRAMES, EnemyController, type EnemyPort } from '../domain/enemy-ai.ts';
import type { EnemySnapshot } from '../domain/enemy-stats.ts';
import { FlowFieldStore } from '../domain/flow-field.ts';
import { FriendlySummonController } from '../domain/friendly-summon-ai.ts';
import { groundLootFor } from '../domain/ground-loot.ts';
import type { ItemResult, ManaPickup } from '../domain/items.ts';
import { recoverManaPickup, rollManaGem } from '../domain/mana-gems.ts';
import type { Point } from '../domain/navigation.ts';
import { overlapsFootRect } from '../domain/navigation.ts';
import type { NavigationActor, NavigationShape } from '../domain/navigation-world.ts';
import { adjacentLivingMember, type CompanionMember, type PartyRoster } from '../domain/party.ts';
import { PartyController, type PartyPort } from '../domain/party-ai.ts';
import { choosePartyLanding, followOffset, partyBodyOverlaps } from '../domain/party-placement.ts';
import { reviveAtHealer } from '../domain/party-revival.ts';
import type { PassiveModifier } from '../domain/passive-skills.ts';
import { PathBudget } from '../domain/path-budget.ts';
import { canTraverse } from '../domain/pathfinding.ts';
import type { PhysicalHit } from '../domain/physical-hit.ts';
import {
  PRESSURE_DEFAULT_MAX_ENEMIES,
  normalizePressureEnemyHealth,
  normalizePressureMaxEnemies,
} from '../domain/pressure-enemies.ts';
import type { RecoveryResult } from '../domain/recovery-items.ts';
import type { PreparedSceneVisit, SceneActorState } from '../domain/scene-snapshot.ts';
import {
  skillClipName,
  skillClips,
  skillPlaybackEvents,
  skillSoundNames,
  skillSummonNames,
  targetsEnemies,
} from '../domain/skill-action.ts';
import { learnedSkillIds } from '../domain/skill-configuration.ts';
import { planSummonSpot } from '../domain/skill-geometry.ts';
import type { SpringBuffScope } from '../domain/springs.ts';
import { stableSeed } from '../domain/stable-seed.ts';
import type { StorySkillProgression } from '../domain/story-skills.ts';
import {
  SummonLifecycle,
  advanceSummonLifetime,
  releasesSummonVitals,
  summonLifetimeExpired,
  summonedChildren,
} from '../domain/summon-lifecycle.ts';
import type { SummonStats } from '../domain/summon-stats.ts';
import { SummonCombatAwareness, type SummonCombatObservation } from '../domain/summon-tactics.ts';
import { costumeRecipe } from '../domain/wardrobe.ts';
import { WorldEnemyRoster, applyStoryEnemyRemovals } from '../domain/world-enemies.ts';
import { isBodyWalking } from '../rendering/arcade-movement.ts';
import { setCharacterStealth } from '../rendering/character-visibility.ts';
import {
  PLAYER_MOVE_SPEED,
  characterAnimationState,
  createCharacter,
  setCharacterClip,
  type CharacterVisual,
} from '../rendering/characters.ts';
import {
  classSummonEnemyIds,
  enemyCombatAssets,
  partyMemberCombatAssets,
  sharedCombatAssets,
} from '../rendering/combat-assets.ts';
import { CombatEffects } from '../rendering/combat-effects.ts';
import { CombatFeedback } from '../rendering/combat-feedback.ts';
import { CombatOutcomes } from '../rendering/combat-outcomes.ts';
import { CombatPresenter } from '../rendering/combat-presenter.ts';
import { CombatStatusVisuals, enemyTapRect } from '../rendering/combat-status-visuals.ts';
import { effectAssets } from '../rendering/effects.ts';
import { OverheadStatus } from '../rendering/overhead-status.ts';
import { loadSceneAssets, retainLoadedSceneAssets } from '../rendering/scene-assets.ts';
import { CombatSkillAssetManager } from './combat-skill-assets.ts';
import type { CombatWorldHost } from './world-combat-host.ts';

export type { WorldCombatState } from '../domain/combat-snapshot.ts';
export { enemyTapRect };

/** 本次战斗使用的固定会话和共享服务；控制状态由调用方提供实时查询。 */
type CombatServices = Readonly<
  Pick<
    StoryContext,
    | 'session'
    | 'director'
    | 'audio'
    | 'battleCatalog'
    | 'characterStats'
    | 'items'
    | 'wardrobe'
    | 'world'
    | 'statusHud'
    | 'ui'
    | 'locked'
    | 'suspended'
    | 'pressureMode'
    | 'pressureSettings'
    | 'gmSpeedMultiplier'
  >
>;

interface MapAlly {
  id: string;
  member: CompanionMember;
  visual: CharacterVisual;
  body: Phaser.Physics.Arcade.Body;
  facing: Facing;
  controller: CombatController;
  ai: PartyController;
  presenter: CombatPresenter;
  overhead: OverheadStatus;
  assets?: AssetLease;
}

interface MapEnemy {
  key: string;
  definition: EnemyDefinition;
  visual: CharacterVisual;
  body: Phaser.Physics.Arcade.Body;
  facing: Facing;
  controller?: EnemyController | FriendlySummonController;
  presenter: CombatPresenter;
  assets?: AssetLease;
  summonedBy?: string;
  summonRemainingMs?: number;
  summonTauntChance?: number;
  /** 召唤它的技能 id；命中时按主人当前等级重读阈值。 */
  summonedBySkill?: string;
}

/** 观察名单只是兜底；真正的接战由 engaged 事件即时上报。 */
const AWARENESS_SWEEP_FRAMES = 16;

/** 所有 AI 每渲染帧共享的寻路扩展预算；一次扩展约几微秒，512 约 2–4 ms。 */
const PATH_BUDGET_PER_RENDER_FRAME = 512;

/** 压测模式：刷一个会主动放技能、无召唤/全屏技能的普通怪。 */
const PRESSURE_ENEMY_ID = 'enemy-red-snake-1';
const PRESSURE_SPAWN_MIN_DISTANCE = 96;
const PRESSURE_SPAWN_MAX_DISTANCE = 240;
const PRESSURE_REVIVE_FRAME_INTERVAL = 10;
/** 压测刷怪每次最多尝试的随机落点数。 */
const PRESSURE_SPAWN_ATTEMPTS = 16;
/** 召唤物脱战这么久后才允许收回主人身边，避免刚脱战就瞬移。 */
const SUMMON_RECALL_QUIET_MS = 3000;
/** 收回召唤物时由近到远尝试的落点半径，单位像素。 */
const SUMMON_RECALL_RADII_PX = [24, 32, 40, 48] as const;
/** 每个半径尝试 8 个方向。 */
const SUMMON_RECALL_DIRECTIONS = 8;
/** 收回落点与地图实体至少隔开这么多像素。 */
const SUMMON_RECALL_ENTITY_CLEARANCE_PX = 16;
/** 剧情收尾时，离主角超过 200px 的单位拉回身边。 */
const FRIENDLY_SETTLE_MAX_DISTANCE_PX = 200;
/** 同一名队友两次被动归队的间隔。 */
const REGROUP_COOLDOWN_MS = 5000;
/** 流场目标按 16px 分桶共享，身体半径至少按 16px 留余量，另加 8px 贴边缓冲。 */
const FLOW_FIELD_BUCKET_PX = 16;
const FLOW_FIELD_MIN_BODY_RADIUS_PX = 16;
const FLOW_FIELD_BODY_PADDING_PX = 8;

/** 正式地图的战斗装配、AI/物理/渲染协调与战斗会话门面。 */
export class WorldCombat {
  private readonly manualOffensiveSkills = new WeakMap<NonNullable<ActionPlayback['skill']>, number>();
  private controlRevision = 0;
  private readonly actionDispatchers = new WeakMap<CombatPresenter, CombatActionDispatcher>();
  private readonly partyDefeatWork = new Map<string, () => void>();
  readonly scene: CombatWorldHost;
  readonly app: CombatServices;
  readonly roster: WorldEnemyRoster;
  readonly hero: BattleCharacter;
  readonly drops: DropCatalog;
  private combatRuntime?: CombatRuntime;
  private get runtime(): CombatRuntime {
    return (this.combatRuntime ??= new CombatRuntime(() => this.app.session.combatTick ?? 0));
  }
  private arena: MapEnemy[] = [];
  private allies: MapAlly[] = [];
  private heroAi?: PartyController;
  private readonly fallen = new Set<string>();
  private readonly deathTweens = new Map<string, Phaser.Tweens.Tween>();
  /** 死亡表现当前是否被暂停；只在状态变化时逐角色应用。 */
  private deathVisualsPaused?: boolean;
  private readonly partyControllers = new Map<string, CombatController>();
  private readonly partySkills = new Map<string, EnemyPlayableSkill[]>();
  private readonly pendingAllies = new Set<string>();
  private readonly allyWaiters = new Set<() => void>();
  private allyLoadFailure?: unknown;
  /** 已同步到的上阵 ID/顺序版本；版本未变时不再逐帧拼接成员名单。 */
  private syncedPartyRevision = -1;
  /** 素材失败或准备期间队伍变化时置位；即使版本没变也要再同步一轮。 */
  private partySyncPending = false;
  /** 正在进行的异步同步数量；完成前不能让版本判断重复拉起同一轮。 */
  private partySyncInFlight = 0;
  private nextPartySyncAt = 0;
  private syncedControlledId = 'player';
  private focusTargetId?: string;
  private readonly summons = new SummonLifecycle();
  private readonly summonObservations: SummonCombatObservation[] = [];
  private summonAwareness?: SummonCombatAwareness;
  private get awareness(): SummonCombatAwareness {
    return (this.summonAwareness ??= new SummonCombatAwareness((this.app.session.combatTick ?? 0) * LOGIC_FRAME_MS));
  }
  private readonly conditions: CombatConditions;
  private readonly stats: CombatActorStats;
  private readonly settlement: CombatSettlementEngine;
  private readonly threat: CombatThreatSystem;
  private readonly pendingDefeats = new PendingEnemyDefeats();
  private readonly hitResolution = new CombatHitResolution();
  private readonly outcomes: CombatOutcomes;
  private readonly feedback: CombatFeedback;
  private readonly statusVisuals: CombatStatusVisuals;
  private readonly skillAssets: CombatSkillAssetManager;
  /** 命中音效去重用的帧号与「出手者:种类」名单，每帧清空。 */
  private hitFeedbackFrame = -1;
  private readonly hitFeedbackClaims = new Set<string>();
  private combat?: CombatController;
  private presenter?: CombatPresenter;
  private readonly combatEffects: CombatEffects;
  private enemiesRunning = false;
  /** 上一次应用的暂停状态；同值时跳过逐角色动画/特效暂停。 */
  private pausedValue?: boolean;
  /** 敌人、队伍与召唤共享的寻路预算，在每个渲染帧开头重置。 */
  private readonly pathBudget = new PathBudget(PATH_BUDGET_PER_RENDER_FRAME);
  /** 同一目标多个敌人共享的流场，使用独立预算，避免和单位寻路互相饿死。 */
  private readonly flowFields = new FlowFieldStore();
  private partyActionsSuspended = false;
  private closed = false;
  /** 读档/回滚跨 await 期间暂停战斗推进，旧死亡单不会落到已经替换的会话上。 */
  private restoring = false;
  /** 战斗诊断计数器：区间值给每 5 秒摘要，累计值给收战摘要。 */
  private diagnosticHits = 0;
  private diagnosticDamageDealt = 0;
  private diagnosticDamageTaken = 0;
  private diagnosticTotalHits = 0;
  private diagnosticTotalDamageDealt = 0;
  private diagnosticTotalDamageTaken = 0;
  private diagnosticStartedAt = 0;
  /** 用每帧 delta 累加，避免额外定时器；只在可战斗状态推进。 */
  private diagnosticElapsedMs = 0;
  private defeated = false;
  /** 全队已经确认阵亡，但结算界面还没弹出；暂停或重建战斗后用它补触发。 */
  private wipeoutPending = false;
  private wipeoutPosition?: Point;
  private generation = 0;
  private playerAssets?: AssetLease;
  private restoredAssets?: AssetLease;
  private storyAssets?: AssetLease;
  /** 压测敌人的角色图集与技能特效；只加载一次，保留到战斗销毁。 */
  private pressureAssets?: AssetLease;
  private combatantsCache?: { tick: number; revision: number; presenceRevision: number; value: Combatant[] };
  /** 与 combatants 快照同一批对象；数组身份变化时重建，AI 只查附近的桶。 */
  private combatantsSpatialCache?: { source: Combatant[]; index: CombatSpatialIndex };
  private readonly soundedSkills = new WeakSet<object>();
  private unsubscribeHero?: () => void;
  private unsubscribeSession?: () => void;
  private readonly lastSkillResets = new Map<
    string,
    { configuration: StorySkillProgression | CompanionSkillProgression; revision: number }
  >();
  /** 整盒校验拒绝的强制位移落点；正常应为空，出现时说明技能落点被挡。 */
  private relocationFailures: { id: string; position: Point }[] = [];
  /** 跟随长时间没有进展、被传送到队长身边的次数；用于上报排查。 */
  private followerCatchUps = 0;
  private readonly regroupCooldowns = new Map<string, number>();

  constructor(scene: CombatWorldHost, app: CombatServices, roster: WorldEnemyRoster, hero: BattleCharacter, drops: DropCatalog) {
    this.scene = scene;
    const session = app.session;
    const director = app.director;
    this.app = {
      session,
      director,
      audio: app.audio,
      battleCatalog: app.battleCatalog,
      characterStats: app.characterStats,
      items: app.items,
      wardrobe: app.wardrobe,
      world: app.world,
      statusHud: app.statusHud,
      ui: app.ui,
      get locked() {
        return app.locked;
      },
      get suspended() {
        return app.suspended;
      },
      get pressureMode() {
        return app.pressureMode;
      },
      get pressureSettings() {
        return app.pressureSettings;
      },
      get gmSpeedMultiplier() {
        return app.gmSpeedMultiplier;
      },
    };
    this.roster = roster;
    this.hero = hero;
    this.drops = drops;

    this.conditions = createCombatConditions({
      captureResourceCapacities: id => this.stats.readResourceCapacities(id),
      onApply: (id, effect, entry) => this.settlement.applyBuffResources(id, effect, entry),
      isInvincible: id => this.app.session.isInvincible(id),
      setInvincible: (id, enabled) => this.app.session.setInvincible(id, enabled),
      isInfiniteMana: id => this.app.session.isInfiniteMana(id),
      setInfiniteMana: (id, enabled) => this.app.session.setInfiniteMana(id, enabled),
    });

    this.skillAssets = new CombatSkillAssetManager({
      phaserScene: scene.phaserScene,
      get now() {
        return scene.time.now;
      },
      battleCatalog: app.battleCatalog,
      wardrobe: app.wardrobe,
      items: app.items,
      hero,
      get skills() {
        return session.skills;
      },
      party: () => this.app.session?.party,
      activeParty: () => this.activeParty,
      playerActor: () => this.scene.player?.actor,
      actorForMember: (id, member) => this.visualOf(id)?.actor ?? this.app.world.actors[member.definition.actor],
      isClosed: () => this.closed,
      preparePlayerAppearance: async () => {
        await this.scene.preparePlayerAppearance?.();
      },
      preparePartyMember: (id, signal, options) => this.scene.preparePartyMember(id, signal, options),
      onBeforeRefresh: () => this.prepareCombatSounds(),
      onReleaseAllyVisualLease: owner => {
        const ally = this.allies.find(value => value.id === owner);
        if (ally) {
          ally.assets?.release();
          ally.assets = undefined;
        }
      },
      scheduleDelayed: (delayMs, callback) => this.scene.time.delayedCall(delayMs, callback),
    });

    this.stats = new CombatActorStats({
      battleCatalog: app.battleCatalog,
      characterStats: app.characterStats,
      items: app.items,
      wardrobe: app.wardrobe,
      conditions: this.conditions,
      hero,
      sessionSkills: () => this.app.session?.skills,
      party: () => this.app.session?.party,
      frenzyAnimations: session?.frenzyAnimations,
      hitResolution: () => this.hitResolution,
      memberOf: id => this.memberOf(id),
      enemyOf: id => combatActor(this.arena, id, actor => actor.key),
      enemySnapshot: (id, definition, heroLevel) => this.roster.enemySnapshot(id, definition, heroLevel),
      isEnemyPresent: (id, enemyId) => this.roster.isPresent(id, enemyId),
      isPendingDefeat: id => this.pendingDefeats.has(id),
      activeSummonCount: ownerId => this.activeSummonsOf(ownerId).length,
      preparedSkills: id => this.skillAssets.preparedSkillsFor(id),
      requiresPreparedSkills: () => true,
      onMissingPreparedSkill: id => {
        this.skillAssets.clearFailureForMissingSkill(id);
        this.skillAssets.scheduleRefresh();
      },
    });

    this.settlement = new CombatSettlementEngine({
      stats: this.stats,
      battleCatalog: app.battleCatalog,
      items: app.items,
      conditions: this.conditions,
      hitResolution: this.hitResolution,
      hero,
      controlledId: () => this.controlledId,
      activeParty: () => this.activeParty,
      isClosed: () => this.closed,
      isDefeated: () => this.defeated,
      enemiesRunning: () => this.enemiesRunning,
      memberOf: id => this.memberOf(id),
      memberActorDefinition: id => this.visualOf(id)?.actor,
      groupModifiers: () => this.app.session?.party?.groupModifiers() ?? {},
      enemyOf: id => combatActor(this.arena, id, actor => actor.key),
      allEnemies: () => this.arena,
      enemySnapshot: (id, definition, heroLevel) => this.roster.enemySnapshot(id, definition, heroLevel),
      setEnemyHealth: (id, health, definition) => this.roster.setEnemyHealth(id, health, definition),
      setEnemyMana: (id, mana, definition) => this.roster.setEnemyMana(id, mana, definition),
      isEnemyPresent: (id, enemyId) => this.roster.isPresent(id, enemyId),
      isPendingDefeat: id => this.pendingDefeats.has(id),
      isFallen: id => this.fallen.has(id),
      hasDisplay: id => {
        const visual = this.visualOf(id);
        return !!visual?.container.active && !!visual.actor.collision;
      },
      displayPosition: id => {
        const visual = this.visualOf(id);
        return visual && this.movement ? this.movement.position(visual) : undefined;
      },
      displayBounds: id => {
        const visual = this.visualOf(id);
        return visual ? (this.movement?.actor(visual).shape().collision ?? visual.actor.collision) : undefined;
      },
      combatant: id => this.combatant(id),
      combatants: () => this.combatants(),
      currentTargetOf: id => this.partyControllers.get(id)?.selectedTargetId(),
      enemyTarget: id => this.enemyTarget(id),
      setReactionTarget: (actorId, targetId) => {
        const controller =
          this.partyControllers.get(actorId) ?? combatActor(this.arena, actorId, actor => actor.key)?.controller?.combatController;
        if (controller && controller.selectedTargetId() !== targetId) controller.setReactionTarget(targetId);
      },
      resetActorCooldowns: id => this.resetActorCooldowns(id),
      recordSummonContact: (sourceId, targetId) => this.recordSummonContact(sourceId, targetId),
      navigationBounds: () => this.movement?.navigation.bounds,
      combatTick: () => this.app.session.combatTick ?? 0,
      isOneHitKill: casterId => this.app.session.isOneHitKill(casterId),
      recoveryPulseDue: () => this.app.session.recoveryPulseDue,
      advanceRecoveryClock: () => this.app.session.advanceRecoveryClock(),
      activeRegeneration: () => this.app.session.recovery.activeRegeneration,
      recoverCombatResources: actors => this.app.session.recoverCombatResources(actors),
      onStateConsequences: (id, states) => this.applyStateConsequences(id, states),
      onStealthBroken: actorId => {
        const visual = this.visualOf(actorId);
        if (visual) setCharacterStealth(visual, false);
      },
      onActionShake: () => this.feedback.startShake(),
      onActionSound: (casterId, sound) => {
        if (this.memberOf(casterId)) this.app.audio?.effect(sound);
      },
      onBuffApplication: (sourceId, targetId, effect) => this.showBuffApplication(sourceId, targetId, effect),
      onShowEffects: (actorId, targetId, effects) => this.presenterFor(actorId)?.showEffects(targetId, effects),
      onUnitFeedback: (hit, outcome, cue) => {
        this.presenterFor(hit.casterId)?.showUnitFeedback(hit, outcome, cue);
      },
      onShowHit: (event, hit, presentation) => this.showHit(event, hit, presentation),
      onDropMana: (casterId, damage, target, rule) => this.dropMana(casterId, damage, target, rule),
      onHitRecorded: ({ damageDealt, damageTaken }) => {
        this.diagnosticHits += 1;
        this.diagnosticTotalHits += 1;
        this.diagnosticDamageDealt += damageDealt;
        this.diagnosticTotalDamageDealt += damageDealt;
        this.diagnosticDamageTaken += damageTaken;
        this.diagnosticTotalDamageTaken += damageTaken;
      },
      onInvalidateCombatants: () => {
        this.combatantsCache = undefined;
      },
      onMemberDefeated: id => this.memberDefeated(id),
      onEnemyDamaged: (enemy, before, proposed) => {
        const mapEnemy = enemy as MapEnemy;
        const interrupted =
          this.app.director?.healthChanged?.(mapEnemy.definition.id, before.health, proposed, before.maxHealth, {
            id: mapEnemy.key,
            map: this.scene.map!.id,
            x: mapEnemy.visual.container.x,
            y: mapEnemy.visual.container.y,
          }) ?? false;
        return {
          interrupted: !!interrupted,
          captured: !!interrupted && !!this.app.session.enemyVitals(mapEnemy.key).capture,
        };
      },
      onEnemyZeroHealth: (enemy, before, casterId) => this.beginEnemyDefeat(enemy as MapEnemy, 'hit', before, casterId),
      onEnemyContact: (enemy, event) => (enemy as MapEnemy).controller?.onContact(event),
      onThreatCombatStarted: id => combatActor(this.arena, id, actor => actor.key)?.controller?.onThreatAdded(),
      removeEnemy: key => this.removeEnemy(key),
      commandSummon: (summonKey, command, targetKey, level) =>
        combatActor(this.arena, summonKey, actor => actor.key)?.controller?.command(command, targetKey, level),
      spawnSummonFromUnit: request => this.spawnSummonFromUnit(request),
      followUp: (kind, casterId, targetId) => {
        if (this.memberOf(casterId)) combatFollowUp(kind, casterId, targetId, this.followUpPort(casterId));
      },
      isSkillPrepared: (ownerId, skillId) => !!this.skillAssets.preparedSkillsFor(ownerId)?.has(skillId),
      requiresPreparedSkills: () => true,
    });

    this.threat = this.settlement.createThreatSystem();
    this.settlement.setThreatSystem(this.threat);
    this.outcomes = new CombatOutcomes(scene.phaserScene, app.battleCatalog);
    this.statusVisuals = new CombatStatusVisuals(scene.phaserScene, app.battleCatalog);
    this.feedback = new CombatFeedback(scene.phaserScene, app.battleCatalog);
    this.combatEffects = new CombatEffects(scene.phaserScene);
  }

  readonly useRecoveryItem = (entry: string, userId = this.controlledId): RecoveryResult => {
    if (this.closed || this.defeated || this.app.suspended || !this.player?.container.active) {
      return { used: false, reason: 'unavailable' };
    }
    const members = this.activeParty.map(id => {
      const member = this.memberOf(id)!;
      return {
        id,
        player: member.player,
        setHealth: (value: number) => member.setHealth(value),
        setMana: (value: number) => member.setMana(value),
      };
    });
    const result = this.app.session.recovery.use(this.hero.bag, entry, members, userId, {
      sleeping: this.conditions.hasState(userId, 'sleep'),
      potionSickness: !this.conditions.canUseRecoveryItems(userId),
      weakened: this.conditions.hasState(userId, 'potion-recovery-halved'),
      recoveryBonus: !!this.app.session.party?.groupModifiers()['potion-recovery'],
      cooldownReductionMs: this.app.session.party?.groupModifiers()['potion-cooldown-ms'],
    });
    if (result.used) {
      this.outcomes.setPaused(this.app.locked);
      for (const id of result.effects) {
        const visual = this.visualOf(id);
        if (visual) this.outcomes.recover(visual);
      }
      this.app.audio?.ui('heal');
    }
    return result;
  };

  collectMana(pickup: ManaPickup): boolean {
    const members = this.activeParty.map(id => {
      const member = this.memberOf(id)!;
      return { id, player: member.player, setMana: (value: number) => member.setMana(value) };
    });
    // 操控者倒下的那一帧仍可能走到宝石上：改由第一个存活队员结算；全灭时把宝石留在原地。
    const collectorId = [this.controlledId, ...this.activeParty].find(id => (this.memberOf(id)?.player.health ?? 0) > 0);
    if (!collectorId) return false;
    const result = recoverManaPickup(pickup, members, collectorId);
    if (!result) return false;
    for (const id of result.effects) {
      const visual = this.visualOf(id);
      if (visual) this.outcomes.recover(visual);
    }
    this.app.audio?.ui('heal');
    return true;
  }

  private dropMana(casterId: string, damage: number, target: Point | undefined, rule: 'skill' | 'weapon' = 'weapon'): void {
    const map = this.scene.map;
    if (!map || !target) return;
    const item = 'mana-gem';
    const pickup = this.app.items.items[item].pickup!;
    const member = this.memberOf(casterId);
    const bag = this.hero.bag;
    const equipment = member ? bag.equipmentItems(bag.equipmentFor(casterId)) : {};
    const weapon = equipment['main-hand'] ?? equipment['off-hand'];
    const actor = this.movement.actor(this.controlledVisual);
    const landing = rollManaGem(
      pickup,
      damage,
      rule,
      weapon ? this.app.items.items[weapon].kind : undefined,
      target,
      point => this.movement.navigation.canStand(actor, point) && this.movement.navigation.sameTerrainRegion(actor.position(), point),
    );
    if (!landing) return;
    const clip = pickup.hitDrop.directions[landing.direction].clip;
    groundLootFor(this.app.session).addFlying(map.id, target, landing, item, (clip.frames * 1000) / clip.frameRate);
  }

  get player(): CharacterVisual {
    return this.scene.player!;
  }
  get controlledId(): string {
    return this.app.session.party?.controlledId ?? 'player';
  }
  get controlledMember(): BattleCharacter | CompanionMember {
    return this.memberOf(this.controlledId)!;
  }
  get controlledVisual(): CharacterVisual {
    return this.visualOf(this.controlledId) ?? this.player;
  }
  get controlledState() {
    return this.controlledMember.player;
  }
  /** 状态面板读取的角色状态：增益与异常都在里面，用于图标行。 */
  activeConditions(id: string) {
    return this.conditions.snapshot(id);
  }
  /** 属性页只读当前属性；不推进 Buff、不写临时缓存之外的战斗状态。 */
  effectiveAttribute(id: string, attribute: BattleStatKey, base: number, passives: readonly PassiveModifier[]): number {
    return this.conditions.attribute(id, attribute, base, passives);
  }
  stealthed(id: string): boolean {
    return this.conditions.hasState(id, 'stealthed');
  }
  get activeParty() {
    return this.app.session?.party?.activeIds ?? ['player'];
  }
  get movement() {
    return this.scene.movement!;
  }
  get facing(): Facing {
    return this.controlledId === 'player'
      ? this.scene.facing
      : (combatActor(this.allies, this.controlledId, actor => actor.id)?.facing ?? 'south');
  }
  set facing(value: Facing) {
    if (this.controlledId === 'player') this.scene.facing = value;
    else {
      const ally = combatActor(this.allies, this.controlledId, actor => actor.id);
      if (ally) ally.facing = value;
    }
  }
  get attackState() {
    return this.combat?.actionState() ?? 'idle';
  }
  /** 受控角色正在释放主动技能（含自动接近目标）。 */
  get castingSkill(): boolean {
    return !!this.combat?.activeAction()?.skill;
  }
  get targetId() {
    return this.combat?.selectedTargetId();
  }
  get cooldowns() {
    return this.combat?.snapshot().cooldowns ?? {};
  }

  /** 每 5 秒一条轻量战斗摘要；没有敌人也没有新命中时跳过，不写空记录。 */
  private reportCombatTick(): void {
    if (this.closed) return;
    const enemies = this.arena.filter(enemy => !this.pendingDefeats.has(enemy.key)).length;
    if (!enemies && !this.diagnosticHits && !this.diagnosticDamageDealt && !this.diagnosticDamageTaken) return;
    const tick = {
      map: this.scene.map?.id,
      controlled: this.controlledId,
      target: this.targetId ?? null,
      action: this.attackState,
      skill: this.combat?.activeAction()?.skill?.id ?? null,
      enemies,
      aliveParty: this.activeParty.filter(id => (this.memberOf(id)?.player.health ?? 0) > 0).length,
      hits: this.diagnosticHits,
      damageDealt: this.diagnosticDamageDealt,
      damageTaken: this.diagnosticDamageTaken,
    };
    this.diagnosticHits = 0;
    this.diagnosticDamageDealt = 0;
    this.diagnosticDamageTaken = 0;
    globalThis.storyDiagnostics?.record('combat-tick', tick, false);
  }

  /**
   * 全量现场快照：每个出战队员的控制器、AI 寻路、移动体和状态，以及敌人和交战判定。
   * 「佣兵不动」「卡墙」「技能收不了尾」可能落在不同层，这里一次给全。
   */
  diagnostics() {
    // 关闭中的战斗不再读现场：场景 shutdown 时显示对象先被销毁、移动世界也注销了它们，
    // 这里再取位置会抛异常，而调用方是同步的界面刷新，异常会一路抛回游戏循环并卡住帧。
    if (this.closed) return { closed: true };
    const now = (this.app.session.combatTick ?? 0) * LOGIC_FRAME_MS;
    const conditions = this.conditions.captureState();
    const own = <T>(pairs: [string, T[]][], id: string): T[] => pairs.find(([actor]) => actor === id)?.[1] ?? [];
    const summarizePath = (path: readonly { x: number; y: number }[]) =>
      path.length ? { length: path.length, first: path[0], last: path.at(-1) } : { length: 0 };
    const aiOf = (id: string) => (id === 'player' ? this.heroAi : combatActor(this.allies, id, actor => actor.id)?.ai);
    const member = (id: string) => {
      const visual = this.visualOf(id);
      const memberState = this.memberOf(id);
      const aiState = aiOf(id)?.captureState();
      return {
        id,
        alive: (memberState?.player.health ?? 0) > 0,
        health: memberState?.player.health ?? null,
        mana: memberState?.player.mana ?? null,
        position: visual ? this.movement.position(visual) : null,
        facing: id === 'player' ? this.scene.facing : (combatActor(this.allies, id, actor => actor.id)?.facing ?? null),
        visible: visual?.container.visible ?? false,
        controller: this.partyControllers.get(id)?.snapshot() ?? null,
        ai: aiState ? { ...aiState, path: summarizePath(aiState.path) } : null,
        move: visual ? (this.movement.state(visual) ?? null) : null,
        conditions: {
          buffs: own(conditions.buffs, id).map(buff => ({ id: buff.id, remainingMs: buff.remainingMs })),
          states: own(conditions.states, id).map(state => ({ id: state.id, remainingMs: state.remainingMs })),
          temporary: own(conditions.temporary, id).map(([key, value]) => ({ key, value })),
        },
        fallen: this.fallen.has(id),
        pendingLoad: this.pendingAllies.has(id),
      };
    };
    return {
      controlled: this.controlledId,
      attack: this.attackState,
      skill: this.combat?.activeAction()?.skill?.id ?? null,
      target: this.targetId ?? null,
      focusTarget: this.focusTargetId ?? null,
      inCombat: !!this.focusTargetId || this.awareness.inCombat(now),
      cannotMove: this.playerCannotMove(),
      cannotAct: this.playerCannotAct(),
      defeated: this.defeated,
      actionsSuspended: this.partyActionsSuspended,
      runtime: {
        paused: this.runtime.paused,
        pauseOwners: this.runtime.pauseOwners,
        idle: this.runtime.idle,
        pending: this.runtime.pendingCount,
      },
      awareness: {
        quietForMs: this.awareness.quietFor(now),
        ...this.awareness.tactics(this.controlledId, this.activeParty, this.focusTargetId),
      },
      party: this.activeParty.map(member),
      enemies: this.arena.map(enemy => ({
        id: enemy.key,
        enemy: enemy.definition.id,
        // 与 `enemy` 不相等说明场上实例和名册身份已经错开，伤害与目标血条会一起失效。
        rosterEnemy: this.roster.enemy(enemy.key)?.enemyId ?? null,
        state: enemy.controller?.actionState() ?? null,
        position: this.movement.position(enemy.visual),
        health: this.roster.enemySnapshot(enemy.key, enemy.definition, this.hero.level)?.health ?? null,
        pendingDefeat: this.pendingDefeats.has(enemy.key),
        summonedBy: enemy.summonedBy ?? null,
        visible: enemy.visual.container.visible,
      })),
      relocationFailures: [...this.relocationFailures],
      followerCatchUps: this.followerCatchUps,
      partyFollow: this.activeParty.map(id => ({
        id,
        ...(id === 'player' ? this.heroAi : combatActor(this.allies, id, a => a.id)?.ai)?.follower?.diagnostics,
      })),
    };
  }

  get canCheckpoint(): boolean {
    return (
      !this.restoring &&
      this.runtime.idle &&
      !this.closed &&
      !this.defeated &&
      !this.deathTweens.size &&
      !this.pendingAllies.size &&
      this.activeParty.some(id => this.memberOf(id)?.player.health) &&
      this.activeParty.every(id => this.partyControllers.has(id) && !!this.visualOf(id)) &&
      [...this.partyControllers.values()].every(controller => controller.actionState() === 'idle') &&
      this.arena.every(
        enemy =>
          !this.pendingDefeats.has(enemy.key) &&
          (!enemy.controller || enemy.controller.actionState() === 'idle' || enemy.controller.actionState() === 'wandering'),
      )
    );
  }

  adoptStoryPositions(actors: readonly SceneActorState[]): void {
    const placements: { visual: CharacterVisual; position: { x: number; y: number }; enabled: boolean }[] = [];
    for (const actor of actors) {
      // 舞台只是为了不画重复敌人而临时隐藏的演员，不代表正式战斗里的显隐/停用。
      if (actor.removed || actor.unpositioned || actor.stageHidden) continue;
      const ally = actor.memberId && this.allies.find(entry => entry.id === actor.memberId);
      const enemy = actor.enemyKey && this.arena.find(entry => entry.key === actor.enemyKey);
      const visual = ally ? ally.visual : enemy ? enemy.visual : undefined;
      if (!visual) continue;
      if ((ally && !ally.member.alive) || (enemy && (!this.isActorAlive(enemy.key) || this.pendingDefeats.has(enemy.key)))) continue;
      if (ally) ally.facing = actor.facing;
      if (enemy) enemy.facing = actor.facing;
      setCharacterClip(this.scene.phaserScene, visual, `idle-${actor.facing}`);
      placements.push({ visual, position: { x: actor.x, y: actor.y }, enabled: actor.visible });
    }
    this.movement.placeAll(placements, { evictOccupied: true, displaceable: [this.player] });
  }

  captureStoryVisit(): Pick<PreparedSceneVisit, 'roster' | 'breakableRolls'> {
    const state = this.roster.capturePreparedState();
    for (const enemy of state.roster.enemies) {
      const visual = this.visualOf(enemy.key);
      if (visual) Object.assign(enemy, this.movement.position(visual));
    }
    return state;
  }

  captureStoryActors(includeEnemyAppearance = true): SceneActorState[] {
    const allies: SceneActorState[] = this.allies.map(ally => {
      const animation = characterAnimationState(ally.visual);
      return {
        id: `member:${ally.id}`,
        actor: ally.member.definition.actor,
        memberId: ally.id,
        followsPlayer: true,
        ...this.movement.position(ally.visual),
        facing: ally.facing,
        visible: ally.member.alive,
        flip: ally.visual.entity.flip,
        appearance: structuredClone(ally.visual.actor),
        clip: ally.visual.clipName ?? undefined,
        alpha: ally.visual.container.alpha,
        animationProgress: animation.progress,
        animationPlaying: animation.playing,
      };
    });
    const enemies: SceneActorState[] = this.arena.map(enemy => {
      const animation = characterAnimationState(enemy.visual);
      return {
        id: `enemy:${enemy.key}`,
        actor: enemy.definition.actor.id,
        enemyKey: enemy.key,
        enemyId: enemy.definition.id,
        summonedBy: enemy.summonedBy,
        ...this.movement.position(enemy.visual),
        facing: enemy.facing,
        visible: this.isActorAlive(enemy.key) && !this.pendingDefeats.has(enemy.key),
        flip: enemy.visual.entity.flip,
        ...(includeEnemyAppearance ? { appearance: structuredClone(enemy.visual.actor) } : {}),
        clip: enemy.visual.clipName ?? undefined,
        alpha: enemy.visual.container.alpha,
        animationProgress: animation.progress,
        animationPlaying: animation.playing,
      };
    });
    return [...allies, ...enemies];
  }

  /** 小地图特殊怪标记：原版按怪物记录分类非零，精英和 Boss 共用同一个图标。 */
  specialEnemyMarkers(): { id: string; x: number; y: number }[] {
    const markers: { id: string; x: number; y: number }[] = [];
    for (const enemy of this.arena) {
      if (!enemy.definition.specialRank) continue;
      if (enemy.summonedBy && this.memberOf(enemy.summonedBy)) continue;
      if (!this.isActorAlive(enemy.key) || this.pendingDefeats.has(enemy.key) || !enemy.visual.container.active || !enemy.visual.container.visible) continue;
      markers.push({ id: enemy.key, ...this.movement.position(enemy.visual) });
    }
    return markers;
  }

  captureState(): WorldCombatState {
    const roster = this.roster.captureState();
    for (const enemy of roster.enemies) {
      const visual = this.visualOf(enemy.key);
      if (visual) Object.assign(enemy, this.movement.position(visual));
    }
    return {
      roster,
      conditions: this.conditions.captureState(),
      threat: this.threat.captureState(),
      party: this.activeParty.flatMap(id => {
        const visual = this.visualOf(id);
        const controller = this.partyControllers.get(id);
        const ai = id === 'player' ? this.heroAi : combatActor(this.allies, id, actor => actor.id)?.ai;
        return visual && controller
          ? [
              {
                id,
                position: this.movement.position(visual),
                facing: id === 'player' ? this.scene.facing : combatActor(this.allies, id, actor => actor.id)!.facing,
                combat: controller.snapshot(),
                ai: ai?.captureState(),
              },
            ]
          : [];
      }),
      enemies: this.arena.map(enemy => ({
        id: enemy.key,
        facing: enemy.facing,
        ai:
          enemy.controller instanceof FriendlySummonController
            ? { kind: 'friendly-summon' as const, state: enemy.controller.captureState() }
            : enemy.controller
              ? { kind: 'enemy' as const, state: enemy.controller.captureState() }
              : undefined,
        summonRemainingMs: enemy.summonRemainingMs,
        summonTauntChance: enemy.summonTauntChance,
      })),
      summonGroups: this.summons.capture(),
      focusTargetId: this.focusTargetId,
    };
  }

  async restoreState(state: WorldCombatState, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    // 恢复跨多个 await；期间暂停战斗推进，旧的截止帧就不能结算到已经替换的会话上。
    // 成功时才清空旧死亡单和运行时；无论成功、取消还是异常，finally 都会恢复推进。
    this.restoring = true;
    try {
      state = prepareCombatRestore(state, this.app.battleCatalog, this.app.session.party?.activeIds ?? []);
      await this.skillAssets.prepareRestoredSkills(signal);
      const definitions = [...new Set(state.roster.enemies.map(enemy => enemy.enemyId))].map(
        id => this.app.battleCatalog.enemies.find(enemy => enemy.id === id)!,
      );
      const lease = await loadSceneAssets(
        this.scene.phaserScene,
        definitions.flatMap(definition => this.enemyAssets(definition)),
        {},
      );
      if (this.closed || signal?.aborted) {
        lease.release();
        signal?.throwIfAborted();
        return;
      }
      this.restoredAssets?.release();
      this.restoredAssets = lease;
      // 旧现场可能还有正在消散的死亡单；先取消对应的 tween，再清空队列。
      for (const key of this.pendingDefeats.keys()) this.outcomes.cancelDeath(key);
      this.runtime.reset();
      this.pendingDefeats.clear();
      this.partyDefeatWork.clear();
      this.summonAwareness = new SummonCombatAwareness(this.app.session.combatTick * LOGIC_FRAME_MS);
      this.combatEffects.clear();
      this.statusVisuals.clearBuffLoops();
      for (const id of this.activeParty) this.presenterFor(id)?.reset();
      for (const tween of this.deathTweens.values()) tween.stop();
      this.deathTweens.clear();
      this.fallen.clear();
      this.defeated = false;
      this.wipeoutPending = false;
      // 恢复会按 roster 重建同一批召唤物；它们的会话状态来自存档，不能在这里清掉。
      this.clearEnemies(true, true);
      this.roster.restoreState(state.roster);
      this.conditions.restoreState(state.conditions);
      // 菜单里改队伍后立即保存时，名册人数可能还是旧值；读档以当前上阵人数为准重新缩放敌人。
      const party = this.app.session.party;
      if (party) {
        this.roster.setPartySize(party.activeSize, this.app.battleCatalog.enemies);
        this.syncedPartyRevision = party.activeRevision;
        this.partySyncPending = false;
      }
      // 恢复会换掉状态和增益；蓝耗缓存必须按新现场重算。
      this.stats.clearAiSkillCosts();
      this.syncControlled();
      this.focusTargetId = state.focusTargetId;
      for (const saved of state.party) {
        const visual = this.visualOf(saved.id);
        if (!visual) continue;
        const alive = !!this.memberOf(saved.id)?.player.health;
        visual.container.setAlpha(1).setVisible(alive);
        this.movement.setEnabled(visual, alive);
        this.relocateVisual(visual, saved.position);
        this.partyControllers.get(saved.id)?.restoreState(saved.combat);
        if (saved.ai) (saved.id === 'player' ? this.heroAi : combatActor(this.allies, saved.id, actor => actor.id)?.ai)?.restoreState(saved.ai);
        if (saved.id === 'player') this.scene.facing = saved.facing;
        else combatActor(this.allies, saved.id, actor => actor.id)!.facing = saved.facing;
        if (this.memberOf(saved.id)?.player.health) setCharacterClip(this.scene.phaserScene, visual, `idle-${saved.facing}`, true);
        else this.markAlreadyFallen(saved.id);
      }
      for (const placed of this.roster.enemies) this.spawnEnemy(placed);
      for (const saved of state.enemies) {
        const enemy = combatActor(this.arena, saved.id, actor => actor.key);
        if (!enemy) continue;
        enemy.facing = saved.facing;
        enemy.summonRemainingMs = saved.summonRemainingMs;
        enemy.summonTauntChance = saved.summonTauntChance;
        if (saved.ai?.kind === 'friendly-summon' && enemy.controller instanceof FriendlySummonController) {
          enemy.controller.restoreState(saved.ai.state);
        } else if (saved.ai?.kind === 'enemy' && enemy.controller instanceof EnemyController) {
          enemy.controller.restoreState(saved.ai.state);
        }
      }
      this.threat.restoreState(state.threat);
      this.summons.restore(state.summonGroups);
      // 读档可能带进 0 血、又没有死亡记录的敌人；在恢复边界补开一次死亡单。
      this.reconcileZeroHealthEnemies('restored');
    } finally {
      this.restoring = false;
    }
  }

  private enemyAssets(definition: EnemyDefinition) {
    return enemyCombatAssets(this.app.battleCatalog, definition);
  }

  /** 整支上阵队伍与当前地图的完整声音清单，更新时替换上一份范围。 */
  private prepareCombatSounds(): void {
    if (!this.app.audio) return;
    const catalog = this.app.battleCatalog;
    const skillIds = new Set<string>();
    const actionSounds = new Set<string>();
    const weaponKinds = new Set<string>();
    const enemyIds = new Set(this.scene.combatEnemyIds?.() ?? []);
    for (const spawn of this.roster.spawns) enemyIds.add(spawn.enemyId);
    const action = (value: SkillAction | null | undefined) => {
      if (!value) return;
      for (const name of skillSoundNames(value)) actionSounds.add(name);
      for (const id of skillSummonNames(value)) enemyIds.add(id);
      for (const unit of value.combatUnits ?? []) if (unit.effect === 'summon' && unit.creature) enemyIds.add(unit.creature);
    };
    for (const id of this.activeParty) {
      const member = this.memberOf(id);
      if (!member) continue;
      const equipped = member.bag.equipmentItems(member.bag.equipmentFor(id));
      for (const hand of ['main-hand', 'off-hand'] as const) {
        const item = equipped[hand];
        weaponKinds.add(item ? (this.app.items.items[item]?.kind ?? 'unarmed') : 'unarmed');
      }
      const learned = learnedSkillIds(catalog, member.classId, this.skillConfiguration(id, member));
      const recipe = costumeRecipe(this.app.wardrobe, this.app.items, equipped, member.classId);
      for (const skillId of learned) {
        skillIds.add(skillId);
        const skill = skillForMember(catalog, id, skillId);
        action(skill?.action);
        action(skill?.followUpAction);
        action(recipe.actions[skillId]);
      }
      for (const summoned of classSummonEnemyIds(catalog, member.classId, learned)) enemyIds.add(summoned);
    }
    for (const id of enemyIds) {
      const enemy = catalog.enemies.find(value => value.id === id);
      if (!enemy) continue;
      for (const skill of enemySkills(enemy)) action(skill.action);
      action(enemy.commandAction?.action);
    }
    const prepared = this.app.audio?.prepareCombat(skillIds, actionSounds, { weaponKinds, enemyIds });
    void prepared?.catch(error => console.warn('战斗音效准备失败', error));
  }

  private enemyHome(placed: PlacedEnemy, position: Point, shape: NavigationShape): Point {
    const origin = this.roster.source(placed.key);
    if (!origin) return position;
    return this.movement.navigation.nearestBody(shape, origin) ?? this.movement.navigation.nearest(shape, origin);
  }

  private buildEnemy(placed: PlacedEnemy, definition: EnemyDefinition): MapEnemy {
    const actor = definition.actor;
    const box = actor.collision!;
    // 出生优先整盒：地图自带的生成点若只满足窄足底，身体会压进相邻阻挡格。
    const position =
      this.movement.navigation.nearestBody({ collision: box }, placed) ?? this.movement.navigation.nearest({ collision: box }, placed);
    const home = this.enemyHome(placed, position, { collision: box });
    const visual = createCharacter(this.scene.phaserScene, actor, { id: placed.key, actor: actor.id, ...position });
    // 友方召唤物与队伍同属 party，彼此不占位；可移动的召唤物和主角、佣兵一样允许地形自愈，
    // 避免被物理分离推进墙里后只能等召回。
    const friendly = !!placed.summonedBy && !!this.memberOf(placed.summonedBy);
    const faction = friendly ? 'party' : 'hostile';
    const body = this.movement.register(visual, definition.behavior.canMove, friendly && definition.behavior.canMove, faction);
    const presenter = new CombatPresenter(
      this.scene.phaserScene,
      this.app.battleCatalog,
      id => this.visualOf(id),
      () => this.combatants(),
      this.combatEffects,
    );
    // 生成前就锁定这只敌人用到的全部纹理；缺任何一项都在这里失败，而不是等到播放动画时。
    const assets = retainLoadedSceneAssets(this.scene.phaserScene, this.enemyAssets(definition));
    const enemy: MapEnemy = {
      key: placed.key,
      definition,
      visual,
      body,
      facing: 'south',
      presenter,
      assets,
      summonedBy: placed.summonedBy,
      summonTauntChance: placed.summonTauntChance,
      summonedBySkill: placed.summonedBySkill,
    };
    if (position.x !== placed.x || position.y !== placed.y) this.roster.moveEnemy(placed.key, position.x, position.y);
    const skills = enemySkills(definition);
    if (definition.basicAttack || skills.length) {
      const attack = definition.basicAttack ? resolveBasicAttack(this.app.battleCatalog, { actor, basicAttack: definition.basicAttack }) : null;
      const behavior = placed.summonedBy ? { ...definition.behavior, wander: undefined } : definition.behavior;
      const port: EnemyPort = {
        isPaused: () => this.runtime.paused,
        cooldowns: this.app.session.cooldowns.forActor(enemy.key),
        threat:
          placed.summonedBy && this.memberOf(placed.summonedBy)
            ? undefined
            : {
                select: current => this.threat.select(enemy.key, current),
                notice: source => this.threat.notice(enemy.key, source),
                has: source => this.threat.has(enemy.key, source),
                clear: () => this.threat.clearOwner(enemy.key),
              },
        canFinishApproach: target => (!!placed.summonedBy && !!this.memberOf(placed.summonedBy)) || this.threat.has(enemy.key, target),
        engaged: targetId => {
          const source = this.combatant(enemy.key);
          const target = this.combatant(targetId);
          if (source && target) this.awareness.contact(source, target, (this.app.session.combatTick ?? 0) * LOGIC_FRAME_MS);
        },
        actor: id => this.combatant(id),
        candidates: () => this.combatants(),
        nearbyCandidates: circles => this.nearbyCandidates(circles),
        partySlots: () => this.settlement.partyBuffSlots(),
        isAlive: id => this.isActorAlive(id),
        health: id => this.actorHealth(id),
        rangeBonusUnits: key => this.stats.actorAttribute(key, 'attackRangeBonusUnits'),
        facing: () => enemy.facing,
        home: () => home,
        navigationBounds: () => this.movement.navigation.bounds,
        pathBudget: this.pathBudget,
        navigationSnapshot: () => this.movement.navigation.captureStandability(this.movement.actor(visual)),
        flowField: (targetId, target) => {
          const mover = this.movement.actor(visual);
          const shape = mover.shape();
          const shapeBox = shape.collision;
          const shapeKey = shapeBox ? `${shapeBox.width}x${shapeBox.height}` : 'none';
          const goalBucket = `${Math.floor(target.position.x / FLOW_FIELD_BUCKET_PX)},${Math.floor(target.position.y / FLOW_FIELD_BUCKET_PX)}`;
          const navigation = this.movement.navigation;
          return this.flowFields.request(
            `${targetId}@${goalBucket}@${shapeKey}`,
            target.position,
            () => ({
              bounds: navigation.bounds,
              canStand: point => navigation.terrainFree(point) && !navigation.blockedByContent(shape, point, mover),
            }),
            Math.max(
              FLOW_FIELD_MIN_BODY_RADIUS_PX,
              Math.hypot(target.bounds.width, target.bounds.height) / 2 + FLOW_FIELD_BODY_PADDING_PX,
            ),
            (this.app.session.combatTick ?? 0) * LOGIC_FRAME_MS,
          );
        },
        moveToward: pos => {
          if (!this.conditions.canAutoApproach(enemy.key)) {
            this.movement.stop(visual);
            return;
          }
          this.movement.toward(visual, pos, this.movementSpeed(enemy.key, definition.behavior.moveSpeedPxPerSecond));
          if (definition.behavior.canTurn) enemy.facing = faceTarget(this.movement.position(visual), pos);
        },
        followPath: nextWaypoint =>
          this.movement.followPath(
            visual,
            () => {
              if (!this.conditions.canMove(enemy.key)) return undefined;
              const next = nextWaypoint();
              if (next && definition.behavior.canTurn) enemy.facing = faceTarget(this.movement.position(visual), next);
              return next;
            },
            this.movementSpeed(enemy.key, definition.behavior.moveSpeedPxPerSecond),
          ),
        stop: () => this.movement.stop(visual),
        canStand: (pos, clearanceActorId) => {
          const clearanceVisual = clearanceActorId ? this.visualOf(clearanceActorId) : visual;
          return !!clearanceVisual && this.movement.canStand(clearanceVisual, pos);
        },
        canPlaceBody: (pos, clearanceActorId) => this.canPlaceBodyAt(visual, pos, clearanceActorId),
        canRelocateReach: pos => {
          const mover = this.movement.actor(visual);
          return this.movement.navigation.sameTerrainRegion(mover.position(), pos);
        },
        canRelocateVerify: pos => {
          const mover = this.movement.actor(visual);
          const shape = mover.shape();
          return (
            this.movement.navigation.sameTerrainRegion(mover.position(), pos) &&
            canTraverse(
              mover.position(),
              pos,
              point => this.movement.navigation.terrainFree(point) && !this.movement.navigation.blockedByContent(shape, point, mover),
            )
          );
        },
        relocate: (pos, clearance) => this.relocateVisual(enemy.visual, pos, clearance),
        face: direction => {
          enemy.facing = direction;
        },
        play: (action, frame, complete) => {
          enemy.facing = action.facing;
          action.getAttackSpeedRate = () => this.conditions.attribute(enemy.key, 'attackSpeedRate', 1000);
          return this.playAction(presenter, action, frame, complete);
        },
        frame: (action, index, contact, unitsReady, areaContact) =>
          this.presentActionFrame(
            presenter,
            action,
            index,
            contact,
            unitsReady,
            event => this.skillFeedback(action, event),
            (dispatchDef, work, afterDispatch) => this.settlement.runActionDispatch(action, dispatchDef, work, afterDispatch),
            areaContact,
          ),
        contact: event => this.settlement.attackContact(event),
        areaContact: event => this.settlement.basicAreaContact(event),
        prepareUnit: event => this.settlement.prepareSkillUnit(event),
        unit: event => this.settlement.skillUnit(event),
        runUnitSequence: work => this.hitResolution.run(work),
        unitFeedback: (hit, outcome, cue) => {
          presenter.showUnitFeedback(hit, outcome, cue);
          if (outcome === 'success' && hit.casterId === this.controlledId && cue.sound) this.app.audio?.effect(cue.sound);
        },
        clearEffects: () => {
          this.runtime.cancel(enemy.key);
          presenter.clear();
        },
      };
      enemy.controller =
        placed.summonedBy && this.memberOf(placed.summonedBy)
          ? new FriendlySummonController(
              enemy.key,
              placed.summonedBy,
              placed.summonedBySkill === 'beast-companion' || definition.id === 'enemy-beast-companion-1' ? 'beast' : 'hell-soldier',
              behavior,
              attack,
              {
                ...port,
                tactics: () => this.awareness.tactics(placed.summonedBy!, this.activeParty, this.focusTargetId),
                navigationSnapshot: () => this.movement.navigation.captureStandability(this.movement.actor(visual)),
                tryRecall: () => this.tryRecallSummon(enemy),
                autonomousTarget: id => {
                  const target = combatActor(this.arena, id, entry => entry.key);
                  return !!target && !target.definition.displayOnlyReason && target.definition.behavior.aggression !== 'none';
                },
              },
            )
          : new EnemyController(enemy.key, behavior, attack, port, skills);
    }
    if (enemy.controller?.combatController) this.runtime.registerActor(enemy.key, enemy.controller.combatController);
    this.makeSelectable(enemy);
    return enemy;
  }

  private summonFactory() {
    return {
      // 原版清掉的是同一主人的全部活动召唤，不区分是哪一个召唤技能。
      begin: (casterId: string) => {
        for (const key of this.summons.beginSummon(casterId)) this.removeEnemy(key);
      },
      create: (
        casterId: string,
        enemyId: string,
        spot: Point,
        summonedStats?: SummonStats,
        summonTauntChance?: number,
        summonedBySkill?: string,
      ): CharacterVisual | undefined => {
        if (this.closed || this.defeated || !this.movement) return;
        const definition = this.app.battleCatalog.enemies.find(enemy => enemy.id === enemyId);
        if (!definition?.actor.collision) return;
        // 召唤落点一律按整个碰撞盒校验；不复刻原版「找位失败就复制主人坐标、允许重叠」那条分支。
        if (!this.movement.navigation.canPlaceBody({ collision: definition.actor.collision }, spot)) return;
        const placed = this.roster.placeEnemy(enemyId, spot.x, spot.y);
        placed.summonedBy = casterId;
        placed.summonedStats = summonedStats;
        placed.summonTauntChance = summonTauntChance;
        placed.summonedBySkill = summonedBySkill;
        if (this.memberOf(casterId)) placed.level = this.memberOf(casterId)!.level;
        const enemy = this.buildEnemy(placed, definition);
        this.arena.push(enemy);
        refreshCombatActors(this.arena);
        this.summons.register(casterId, enemy.key);
        return enemy.visual;
      },
    };
  }

  private spawnSummonFromUnit(request: SummonUnitSpawnRequest): boolean {
    if (!this.movement) return true;
    const factory = this.summonFactory();
    factory.begin(request.casterId);
    const casterVisual = this.visualOf(request.casterId);
    if (!casterVisual) return false;
    const navigation = this.movement.navigation;
    const preferred = planSummonSpot(
      request.casterPosition,
      casterVisual.actor.collision!,
      request.casterFacing,
      request.placement,
      point => navigation.canPlaceBody({ collision: request.bounds }, point),
    );
    const spot = navigation.nearestReachableBody({ collision: request.bounds }, request.casterPosition, preferred);
    if (!spot) return false;
    const visual = factory.create(
      request.casterId,
      request.enemyId,
      spot,
      request.derivedStats,
      request.tauntChanceThreshold,
      request.skillId,
    );
    if (visual) {
      const summon = this.arena.find(enemy => enemy.visual === visual)!;
      this.presenterFor(request.casterId)?.showEffects(summon.key, request.appearanceEffects ?? []);
      summon.summonRemainingMs = request.lifetimeMs;
    }
    return true;
  }

  private destroyEnemy(enemy: MapEnemy, preserveCooldown = false, keepSummonState = false): void {
    if (!this.closed) this.releaseEnemyState(enemy, preserveCooldown, keepSummonState);
    this.settlement.forgetDealtDamage(enemy.key);
    this.threat.removeActor(enemy.key);
    for (const actor of this.arena) actor.controller?.targetRemoved(enemy.key);
    this.combatRuntime?.removeActor(enemy.key);
    enemy.controller?.dispose();
    enemy.presenter.clear();
    this.movement.remove(enemy.visual);
    enemy.visual.container.destroy();
    enemy.assets?.release();
  }

  private releaseEnemyState(enemy: MapEnemy, preserveCooldown = false, keepSummonState = false): void {
    if ((this.app.pressureMode && !enemy.summonedBy) || releasesSummonVitals(enemy.summonedBy, keepSummonState)) {
      this.app.session.forgetEnemyVitals(enemy.key);
    }
    if (!preserveCooldown) this.app.session.cooldowns.removeActor(enemy.key);
  }

  /** 正常结束本次地图访问时清理临时领域状态；恢复快照不走这个入口。 */
  finishMapVisit(): void {
    this.hero.clearCombatResourceLimits();
    for (const ally of this.allies) ally.member.clearCombatResourceLimits();
    for (const enemy of this.arena) this.releaseEnemyState(enemy);
  }

  private clearEnemies(preserveCooldown = false, keepSummonStates = false): void {
    for (const enemy of this.arena) this.destroyEnemy(enemy, preserveCooldown, keepSummonStates);
    this.arena = [];
    this.threat.clear();
    this.combatantsCache = undefined;
    this.combatantsSpatialCache = undefined;
  }

  /**
   * 技能强制位移的整盒落点。位移是瞬时的，不能像走路那样只检查脚点：
   * 身体压进墙里会让角色看起来卡在墙内。`clearanceActorId` 指定的角色不参与占位。
   */
  private canPlaceBodyAt(visual: CharacterVisual, position: Point, clearanceActorId?: string): boolean {
    if (!this.movement) return false;
    const actor = this.movement.actor(visual);
    const clearance = clearanceActorId ? this.visualOf(clearanceActorId) : undefined;
    const clearanceActor = clearance ? this.movement.actor(clearance) : undefined;
    const placements = clearanceActor ? [{ actor: clearanceActor, position: clearanceActor.position(), enabled: false }] : [];
    return this.movement.navigation.canPlaceBody(actor.shape(), position, actor, placements);
  }

  /**
   * 技能强制位移：落点按整个碰撞盒判定。失败时保持原位并记录，不迁就到别处——
   * 用目标点附近的 `nearestBody` 兜底可能跨墙瞬移，反而制造新的异常落点。
   * `movement.place` 的严格检查会抛错；它从战斗帧回调里冒出会停掉主循环，所以先自己复核。
   */
  private relocateVisual(visual: CharacterVisual, position: Point, clearanceActorId?: string): boolean {
    if (!this.movement) return false;
    if (this.canPlaceBodyAt(visual, position, clearanceActorId)) {
      this.movement.place(visual, position);
      return true;
    }
    this.relocationFailures.push({ id: visual.entity.id, position: { ...position } });
    if (this.relocationFailures.length > 8) this.relocationFailures.shift();
    return false;
  }

  private recordSummonContact(sourceId: string, targetId: string): void {
    if (!this.summonAwareness) return;
    const source = this.combatant(sourceId);
    const target = this.combatant(targetId);
    if (source && target && source.team !== target.team) {
      this.summonAwareness.contact(source, target, (this.app.session.combatTick ?? 0) * LOGIC_FRAME_MS);
    }
  }

  private observeSummonCombat(): void {
    // 名单复用同一个数组；只装队员和醒着的敌人，睡着的等交战时由 contact 事件补上。
    const observations = this.summonObservations;
    observations.length = 0;
    for (const id of this.activeParty) {
      if (!this.isActorAlive(id)) continue;
      const actor = this.combatant(id);
      if (!actor) continue;
      observations.push({ actor, action: this.partyControllers.get(id)?.activeAction() });
    }
    for (const enemy of this.arena) {
      if (!this.isActorAlive(enemy.key)) continue;
      const actor = this.combatant(enemy.key);
      if (!actor) continue;
      const controller = enemy.controller;
      if (actor.team !== 'party' && !(controller instanceof EnemyController && controller.needsFrame())) continue;
      observations.push({
        actor,
        action: controller?.combatController?.activeAction(),
        chasingTargetId: actor.team !== 'party' && controller?.actionState() === 'chasing' ? controller.currentTargetId() : undefined,
      });
    }
    this.awareness.observe((this.app.session.combatTick ?? 0) * LOGIC_FRAME_MS, observations);
  }

  private tryRecallSummon(enemy: MapEnemy): boolean {
    const owner = enemy.summonedBy && this.combatant(enemy.summonedBy);
    const actor = this.combatant(enemy.key);
    if (
      !owner ||
      !actor ||
      !this.isActorAlive(owner.id) ||
      !this.isActorAlive(actor.id) ||
      this.runtime.paused ||
      !this.runtime.idle ||
      !this.conditions.canAct(enemy.key) ||
      !this.conditions.canMove(enemy.key) ||
      this.partyActionsSuspended
    ) {
      return false;
    }
    const now = (this.app.session.combatTick ?? 0) * LOGIC_FRAME_MS;
    if (this.awareness.quietFor(now) < SUMMON_RECALL_QUIET_MS) return false;
    // 警戒覆盖还要检查隐身敌人；旧仇恨记录本身不代表仍在追击。
    const hostile = this.arena.filter(value => this.combatant(value.key)?.team === 'hostile' && this.isActorAlive(value.key));
    if (
      hostile.some(value => {
        const snapshot = value.controller?.snapshot();
        const action = value.controller?.combatController?.activeAction();
        const target = snapshot?.state === 'chasing' ? snapshot.targetId : action?.state === 'attacking' ? action.targetId : undefined;
        return target && this.combatant(target)?.team === 'party';
      })
    ) {
      return false;
    }
    const safe = (point: Point) =>
      !hostile.some(value => {
        const position = this.movement.position(value.visual);
        return Math.floor(Math.max(Math.abs(position.x - point.x), Math.abs(position.y - point.y)) / 8) <= value.definition.behavior.awarenessRangeUnits;
      });
    if (!safe(owner.position) || !safe(actor.position)) return false;
    const navigation = this.movement.navigation;
    const body = this.movement.actor(enemy.visual);
    const ownerVisual = this.visualOf(owner.id);
    if (!ownerVisual) return false;
    const ownerBody = this.movement.actor(ownerVisual);
    const localFree = (point: Point) =>
      navigation.terrainFree(point) && navigation.canPlace(body.shape(), point, body, [{ actor: ownerBody, position: owner.position, enabled: false }]);
    const seed = stableSeed(enemy.key);
    for (const radius of SUMMON_RECALL_RADII_PX) {
      for (let index = 0; index < SUMMON_RECALL_DIRECTIONS; index++) {
        const angle = (((index + (seed % 8)) % 8) * Math.PI) / 4;
        const point = { x: owner.position.x + Math.cos(angle) * radius, y: owner.position.y + Math.sin(angle) * radius };
        if (
          !this.canPlaceBodyAt(enemy.visual, point) ||
          !safe(point) ||
          this.scene.map?.exits.some(exit => overlapsFootRect(point, exit)) ||
          this.scene.map?.entities.some(entity => Math.hypot(point.x - entity.x, point.y - entity.y) < SUMMON_RECALL_ENTITY_CLEARANCE_PX) ||
          !canTraverse(owner.position, point, localFree)
        ) {
          continue;
        }
        this.relocateVisual(enemy.visual, point);
        return true;
      }
    }
    return false;
  }

  private combatants(): Combatant[] {
    // 同一逻辑帧内的 AI/技能查询共用一份候选快照；帧开始和结束时清空，避免跨帧读到旧位置。
    const tick = this.app.session.combatTick;
    const revision = this.conditions.revision;
    const presenceRevision = this.roster.presenceRevision;
    if (
      this.combatantsCache?.tick === tick &&
      this.combatantsCache.revision === revision &&
      this.combatantsCache.presenceRevision === presenceRevision
    ) {
      return this.combatantsCache.value;
    }
    const value = [...this.activeParty.map(id => this.combatant(id)), ...this.arena.map(enemy => this.combatant(enemy.key))]
      // 敌对单位正在等死亡单或已经 0 血时不再进入候选；友方召唤物保留给治疗救援。
      .filter((actor): actor is Combatant => !!actor && (actor.team === 'party' || !this.isUnavailableEnemyTarget(actor.id)));
    this.combatantsCache = { tick, revision, presenceRevision, value };
    return value;
  }

  /** 与 combatants 同源的空间查询；索引按快照数组身份复用，结果保持原候选顺序。 */
  private nearbyCandidates(circles: readonly CombatQueryCircle[]): Combatant[] {
    const candidates = this.combatants();
    let cached = this.combatantsSpatialCache;
    if (cached?.source !== candidates) {
      cached = { source: candidates, index: new CombatSpatialIndex(candidates) };
      this.combatantsSpatialCache = cached;
    }
    return cached.index.within(circles);
  }

  private memberOf(id: string): BattleCharacter | CompanionMember | undefined {
    return id === 'player' ? this.hero : this.app.session.party?.get(id);
  }

  /** 主角的技能配置存放在会话里，佣兵自己持有。 */
  private skillConfiguration(id: string, member: BattleCharacter | CompanionMember): StorySkillProgression | CompanionSkillProgression {
    return id === 'player' ? this.app.session.skills : (member as CompanionMember).skills;
  }

  private isActorAlive(id: string): boolean {
    const member = this.memberOf(id);
    const enemy = combatActor(this.arena, id, actor => actor.key);
    if (enemy && !this.roster.isPresent(id, enemy.definition.id)) return false;
    return (member?.player.health ?? (enemy ? this.roster.enemySnapshot(id, enemy.definition, this.hero.level)?.health : 0) ?? 0) > 0;
  }

  /** 怪物释放条件用的当前生命与上限；生命按敌方快照读，上限走共用资源面板。 */
  private actorHealth(id: string): { current: number; maximum: number } | undefined {
    const member = this.memberOf(id);
    const enemy = member ? undefined : combatActor(this.arena, id, actor => actor.key);
    const current = member?.player.health ?? (enemy ? this.roster.enemySnapshot(id, enemy.definition, this.hero.level)?.health : undefined);
    return current === undefined ? undefined : { current, maximum: this.stats.readResourceCapacity(id, 'maxHealth') };
  }

  private presenterFor(id: string): CombatPresenter | undefined {
    return id === 'player'
      ? this.presenter
      : (combatActor(this.allies, id, actor => actor.id)?.presenter ?? combatActor(this.arena, id, actor => actor.key)?.presenter);
  }

  private skillFeedback(action: ActionPlayback, event: SkillFeedbackEvent): void {
    if (event.shake) this.feedback.startShake();
    // 佣兵和主角一样是玩家阵营；音效不能只给当前操控者，否则切到佣兵前他们出手全静音。
    if (event.sound && this.memberOf(action.caster.id)) this.app.audio?.effect(event.sound);
  }

  private dispatcherFor(presenter: CombatPresenter): CombatActionDispatcher {
    const existing = this.actionDispatchers.get(presenter);
    if (existing) return existing;
    const dispatcher = new CombatActionDispatcher({
      runtime: this.runtime,
      catalog: this.app.battleCatalog,
      actor: id => this.combatant(id),
      candidates: () => this.combatants(),
      random: () => Math.random(),
      viewport: () => {
        const camera = this.scene.cameras.main;
        return { width: camera.width / camera.zoomX, height: camera.height / camera.zoomY };
      },
      pose: (action, index) => presenter.projectFrame(action, index),
      effect: (name, variant, position, placement, id) => presenter.renderEffect(name, variant, position, placement, id),
      flight: event => presenter.renderFlight(event),
      screen: value => presenter.screenFill(value),
      notify: (name, data) => this.scene.events.emit(name, data),
      canSummonAt: (position, bounds) => this.movement.navigation.canPlaceBody({ collision: bounds }, position),
      nearestSummonSpot: (position, bounds, preferred) => this.movement.navigation.nearestReachableBody({ collision: bounds }, position, preferred),
      beginSummons: id => this.summonFactory().begin(id),
      summon: (ownerId, enemyId, position) => this.summonFactory().create(ownerId, enemyId, position)?.entity.id,
    });
    this.actionDispatchers.set(presenter, dispatcher);
    return dispatcher;
  }

  private playAction(presenter: CombatPresenter, action: ActionPlayback, frame: (index: number) => void, complete: () => void): () => void {
    this.awareness.action(action.caster, { state: 'attacking', targetId: action.target?.id, skill: action.skill }, action.target, (this.app.session.combatTick ?? 0) * LOGIC_FRAME_MS);
    const visual = this.visualOf(action.caster.id)!;
    const name = action.skill ? (action.skill.clips?.[action.facing] ?? skillClipName(action.skill.id, action.facing)) : action.basicAttack?.clips[action.facing];
    const clip = name ? visual.actor.clips[name as keyof typeof visual.actor.clips] : undefined;
    const clear = presenter.play(action);
    const layers = visual.layers;
    const manualRevision = action.skill ? this.manualOffensiveSkills.get(action.skill) : undefined;
    const cancel = this.runtime.play(action, { sourceFrames: clip?.frames ?? 1, frameDurationMs: action.basicAttack?.frameDurationMs ?? LOGIC_FRAME_MS }, frame, () => {
      complete();
      if (manualRevision !== undefined && manualRevision === this.controlRevision && this.controlledId === action.caster.id) {
        this.scene.offensiveSkillCompleted(action.caster.id);
      }
    });
    return () => {
      cancel();
      clear();
      // 取消或收尾时直接接回待机，不再依赖后续帧的 afterMovement；
      // 动作已经被别的表现接手时让接手者继续画。
      const idle = `idle-${action.facing}` as ClipName;
      if (visual.container.active && visual.layers === layers && visual.actor.clips[idle]) {
        setCharacterClip(this.scene.phaserScene, visual, idle, true);
      }
    };
  }

  private presentActionFrame(presenter: CombatPresenter, ...args: Parameters<CombatActionDispatcher['frame']>): void {
    this.hitResolution.run(() => this.dispatcherFor(presenter).frame(...args));
  }

  private enemyTarget(id: string): string | undefined {
    const controller = combatActor(this.arena, id, actor => actor.key)?.controller;
    return controller?.combatController ? controller.combatController.selectedTargetId() : controller?.currentTargetId();
  }

  /**
   * 开一张死亡单，并立刻把这个敌人退出战斗。
   *
   * 死亡单是唯一的结算入口：命中把活着的敌人打到 0 时开单，消散到期后结算一次；
   * 读档、检查点或刷怪把 0 血敌人带回场上时也开单，避免它绕过伤害路径永远留在场上。
   * 同一敌人只会有一张单；没有单子的敌人不会被每帧检查。
   */
  private beginEnemyDefeat(
    targetEnemy: MapEnemy,
    cause: 'hit' | 'restored' | 'spawned',
    before?: Readonly<EnemySnapshot>,
    casterId?: string,
  ): boolean {
    const key = targetEnemy.key;
    if (this.closed || this.pendingDefeats.has(key)) return false;
    const snapshot = before ?? this.roster.enemySnapshot(key, targetEnemy.definition, this.hero.level);
    // 名册身份对不上时没法正常结算；边界恢复至少把画面清掉，不能留一个打不死的空血敌人。
    if (!snapshot) {
      if (cause !== 'hit') this.removeEnemy(key);
      return false;
    }
    const session = this.app.session;
    const map = this.scene.map!.id;
    const spawn = this.roster.source(key);
    // 正常击杀时 enemyDefeated 还没写过死亡记录，不需要查 session；边界修复才检查旧记录。
    const deadUntil = cause === 'hit' ? undefined : session.enemyVitals(key).deadUntil;
    // 边界修复只记在真正补开单的时候；正常击杀不需要每个都写一条诊断。
    if (cause !== 'hit') {
      globalThis.storyDiagnostics?.record(
        'enemy-defeat-repaired',
        { enemy: targetEnemy.definition.id, key, map, cause, health: snapshot.health, deadUntil: deadUntil ?? null },
        false,
      );
    }
    // 已经记过死亡（读档时可能只剩一个没清掉的画面）：只清场，不再发第二次奖励。
    if (deadUntil !== undefined) {
      this.removeEnemy(key);
      return false;
    }
    const { x, y } = targetEnemy.visual.container;
    // 正常击杀保留原本的消散时间；边界修复和没有消散表现的敌人立刻结算。
    const delayFrames = cause === 'hit' && targetEnemy.definition.defeatPresentation === 'vanish' ? ENEMY_DEFEAT_SETTLE_FRAMES : 0;
    // 友方召唤物倒下不是玩家击杀，读档补结算时不能给它发击杀经验。
    const friendlySummon = !!targetEnemy.summonedBy && !!this.memberOf(targetEnemy.summonedBy);
    const earnsExperience =
      cause === 'hit'
        ? !!(this.memberOf(casterId ?? '') || this.arena.some(enemy => enemy.key === casterId && this.memberOf(enemy.summonedBy ?? '')))
        : !friendlySummon;
    let result: ReturnType<CombatServices['session']['settleEnemyDefeat']>;
    if (
      !this.pendingDefeats.add(
        key,
        () => {
          result = session.settleEnemyDefeat({
            key,
            spawn,
            enemy: targetEnemy.definition,
            map,
            x,
            y,
            lootLevel: this.scene.map?.lootLevel,
            enemyLevel: snapshot.level,
            elite: snapshot.elite,
            earnsExperience,
            pressureMode: this.app.pressureMode,
            drops: this.drops,
            stats: this.app.characterStats,
            random: Math.random,
            landing: (lx, ly) => this.scene.lootLanding(map, lx, ly),
          });
        },
        render => {
          this.runtime.cancel(`defeat:${key}`);
          this.outcomes.cancelDeath(key);
          // 死亡单已结束，通知剧情时不会再次冲刷同一笔奖励。
          result?.notify();
          this.removeEnemy(key);
          if (!result) return;
          const { settlement, levelledIds } = result;
          if (settlement.isBreakable) this.syncChestEnemies();
          if (render && !this.closed) {
            this.scene.refreshGroundLoot();
            this.app.audio?.monsterDeath(targetEnemy.definition.id);
            for (const id of levelledIds) {
              const visual = this.visualOf(id);
              if (visual?.container.active) {
                this.outcomes.levelUp(visual);
                this.app.audio?.playerLevelUp();
              }
            }
          }
        },
        (error, render, phase) => {
          // 结算或表现失败时也要清掉死亡单和 0 血敌人，保存/检查点/换图入口不能再抛。
          globalThis.storyDiagnostics?.record(
            phase === 'settle' ? 'enemy-defeat-settlement-error' : 'enemy-defeat-presentation-error',
            { enemy: targetEnemy.definition.id, key, map, render, message: error instanceof Error ? error.message : String(error) },
            false,
          );
          try {
            this.runtime.cancel(`defeat:${key}`);
          } catch {}
          try {
            this.outcomes.cancelDeath(key);
          } catch {}
          try {
            result?.notify();
          } catch {}
          // 结算已经回滚。恢复生成点的血量，让名册重新生成敌人，保留再次取得任务物品和战果的机会。
          if (phase === 'settle' && spawn) {
            try {
              session.setEnemyVitals(spawn.id, Math.max(1, snapshot.health), snapshot.mana);
            } catch {}
          }
          try {
            this.removeEnemy(key);
          } catch {}
        },
      )
    ) {
      return false;
    }
    this.combatantsCache = undefined;
    let scheduled = false;
    try {
      this.summonAwareness?.forget(key);
      this.threat.removeActor(key);
      for (const enemy of this.arena) enemy.controller?.targetRemoved(key);
      targetEnemy.controller?.dispose();
      targetEnemy.presenter.clear();
      this.conditions.remove(key);
      this.movement.stop(targetEnemy.visual);
      this.movement.setEnabled(targetEnemy.visual, false);
      targetEnemy.visual.container.disableInteractive();
      for (const controller of this.partyControllers.values()) controller.targetRemoved(key);
      if (this.focusTargetId === key) this.focusTargetId = undefined;
      this.scene.refreshCombatTarget();
      if (delayFrames > 0) {
        this.outcomes.vanish(key, targetEnemy.visual, () => {});
        this.runtime.schedule(`defeat:${key}`, delayFrames, () => this.pendingDefeats.complete(key));
        scheduled = true;
      }
    } catch (error) {
      // 退场表现失败也不能让死亡单一直挂着；立即静默结算，敌人照常消失。
      globalThis.storyDiagnostics?.record(
        'enemy-defeat-presentation-error',
        { enemy: targetEnemy.definition.id, key, map, message: error instanceof Error ? error.message : String(error) },
        false,
      );
    }
    if (!scheduled) this.pendingDefeats.complete(key, cause === 'hit');
    return true;
  }

  /**
   * 把这次读档或刷怪带进来的 0 血敌人补开死亡单。
   * 只遍历本次新增/恢复出来的敌人，不做每帧全场扫描。
   */
  private reconcileZeroHealthEnemies(cause: 'restored' | 'spawned', keys?: readonly string[]): void {
    for (const key of keys ?? this.roster.enemies.map(enemy => enemy.key)) {
      const placed = this.roster.enemy(key);
      if (placed?.health !== 0) continue;
      const enemy = combatActor(this.arena, key, actor => actor.key);
      if (enemy) this.beginEnemyDefeat(enemy, cause);
    }
  }

  private showBuffApplication(sourceId: string, targetId: string, effect: string): void {
    const member = this.memberOf(targetId);
    const enemy = combatActor(this.arena, targetId, actor => actor.key);
    const health = member?.player.health ?? (enemy ? this.roster.enemySnapshot(targetId, enemy.definition, this.hero.level)?.health : 0) ?? 0;
    const follows = health > 0 && !this.pendingDefeats.has(targetId) && !this.fallen.has(targetId);
    this.presenterFor(sourceId)?.showBuffApplication(targetId, effect, follows);
  }

  /** 清空一名角色的技能冷却；有控制器的走控制器，其余走冷却表。 */
  private resetActorCooldowns(id: string): void {
    const controller = this.partyControllers.get(id) ?? combatActor(this.arena, id, actor => actor.key)?.controller?.combatController;
    if (controller) controller.resetSkillCooldowns();
    else this.app.session.cooldowns.resetActor(id);
  }

  private followUpPort(casterId: string): CombatFollowUpPort {
    const view = () => this.presenterFor(casterId);
    return {
      catalog: this.app.battleCatalog,
      runtime: this.runtime,
      random: () => Math.random(),
      active: () => !this.closed && !this.defeated,
      actor: id => this.combatant(id),
      loadout: id => {
        const current = this.stats.reactionSkills(id);
        return current ? { classId: current.classId, skills: current.loadout } : undefined;
      },
      casterStrikes: (id, strikes) => {
        const presenter = view();
        if (presenter) this.dispatcherFor(presenter).casterStrikes(id, strikes);
      },
      flight: {
        actor: id => this.combatant(id),
        emit: event => view()?.renderFlight(event),
        effect: (name, position) => view()?.renderEffect(name, 'default', position),
      },
      execute: (owner, target, skillId, level, action, origin) =>
        this.settlement.runSkillUnitSequence({ casterId: owner, skillId, level, action, origin, selectedTargetId: target }),
    };
  }

  skillManaCost(id: string, skillId: string, level: number | undefined): number | undefined {
    return this.stats.skillManaCost(id, skillId, level);
  }

  private movementSpeed(actorId: string, baseSpeed: number): number {
    const gmSpeedMultiplier =
      actorId === this.controlledId || this.activeParty.includes(actorId) ? (this.app.gmSpeedMultiplier ?? 1) : 1;
    const visual = this.visualOf(actorId);
    const enemy = combatActor(this.arena, actorId, actor => actor.key);
    const onWater = !!visual && this.movement.navigation.isWater(this.movement.position(visual));
    return combatMovementSpeed(baseSpeed, this.conditions.attribute(actorId, 'moveSpeed', 1000), {
      gmSpeedMultiplier,
      onWater,
      waterImmune: enemy?.definition.waterImmune,
    });
  }

  private applyStateConsequences(id: string, states: readonly BattleStateKey[]): void {
    if (!states.some(state => state === 'immobilized' || state === 'stealthed')) {
      this.interruptDisabled(id);
      return;
    }
    this.conditions.clearTemporary(id);
    this.partyControllers.get(id)?.cancel(true);
    const visual = this.visualOf(id);
    if (visual) this.movement.stop(visual);
    if (id === 'player') this.heroAi?.disable();
    else combatActor(this.allies, id, actor => actor.id)?.ai.disable();
    combatActor(this.arena, id, actor => actor.key)?.controller?.disable();
    if (states.includes('stealthed')) {
      if (visual) setCharacterStealth(visual, true);
      const target = this.combatant(id);
      for (const actor of this.combatants()) {
        if (target && actor.team !== target.team) {
          this.partyControllers.get(actor.id)?.targetRemoved(id);
          if (actor.id === 'player') this.heroAi?.targetRemoved(id);
          else combatActor(this.allies, actor.id, entry => entry.id)?.ai.targetRemoved(id);
          combatActor(this.arena, actor.id, entry => entry.key)?.controller?.targetRemoved(id);
        }
      }
      if (this.focusTargetId === id) {
        this.focusTargetId = undefined;
        this.scene.refreshCombatTarget();
      }
    }
  }

  private interruptDisabled(actorId: string): void {
    if (!this.conditions.cannotAct(actorId)) return;
    this.conditions.clearTemporary(actorId);
    if (this.memberOf(actorId)) {
      this.partyControllers.get(actorId)?.cancel(true);
      const visual = this.visualOf(actorId);
      if (visual) this.movement.stop(visual);
      if (actorId === 'player') this.heroAi?.disable();
      else combatActor(this.allies, actorId, actor => actor.id)?.ai.disable();
    } else {
      combatActor(this.arena, actorId, actor => actor.key)?.controller?.disable();
    }
  }

  /**
   * 同一次结算（同一帧、同一出手者）里，同一类命中反馈只发一次。
   * 范围技能一发打中多个目标时，暴击、格挡、命中、未命中各响一声，不随目标数量叠加。
   */
  private claimHitFeedback(casterId: string, kind: string): boolean {
    const frame = this.scene.game?.loop?.frame;
    if (frame === undefined) return true;
    if (frame !== this.hitFeedbackFrame) {
      this.hitFeedbackFrame = frame;
      this.hitFeedbackClaims.clear();
    }
    const key = `${casterId}:${kind}`;
    if (this.hitFeedbackClaims.has(key)) return false;
    this.hitFeedbackClaims.add(key);
    return true;
  }

  private showHit(event: AttackContact, hit: PhysicalHit, options: { style?: HitEffectStyle; periodic?: boolean; sound?: boolean }): void {
    const caster = combatActor(this.arena, event.casterId, actor => actor.key);
    const target = combatActor(this.arena, event.targetId, actor => actor.key);
    const belongsToControlled = (id: string) =>
      id === this.controlledId || this.arena.some(enemy => enemy.key === id && enemy.summonedBy === this.controlledId);
    const feedback = {
      hit,
      style: options.style ?? ('weapon' as const),
      periodic: !!options.periodic,
      casterControlled: event.casterId === this.controlledId,
      targetParty: !!this.memberOf(event.targetId),
      targetFriendly: !!this.memberOf(event.targetId) || !!this.memberOf(target?.summonedBy ?? ''),
      involvesControlled: belongsToControlled(event.casterId) || belongsToControlled(event.targetId),
    };
    const plan = feedbackPlan(feedback);
    const selection = selectFeedbackAssets(feedback, this.app.battleCatalog.feedback, Math.random, displaySettings.criticalDecorations, plan);
    const visual = this.visualOf(event.targetId);
    if (!visual?.container.active) return;
    this.feedback.show(feedback, visual, selection, plan, { decorationGroup: event.casterId });
    if (plan.flash) this.statusVisuals.flash(visual, this.scene.phaserScene);
    if (options.sound) {
      // 普攻命中音效对所有玩家阵营成员生效；武器类型按出手者自己的装备取。
      if (this.memberOf(event.casterId) && this.claimHitFeedback(event.casterId, `weapon:${hit.kind}`)) {
        const equipment = this.hero.bag.equipmentItems(this.hero.bag.equipmentFor(event.casterId));
        const item = equipment['main-hand'];
        this.app.audio?.playerHit(item ? this.app.items.items[item].kind : 'unarmed', hit.kind, target?.definition.id);
      }
      if (hit.kind === 'shield-block' && this.memberOf(event.targetId) && this.claimHitFeedback(event.casterId, 'shield')) {
        this.app.audio?.shieldBlock();
      }
    }
    if (hit.damage > 0) {
      // 持续伤害只是跳伤，不是怪物挥击；挥击声只在真正的攻击命中时响。
      if (!options.periodic && caster && this.claimHitFeedback(event.casterId, 'attack')) this.app.audio?.monsterAttack(caster.definition.id);
      if (options.periodic && target && this.claimHitFeedback(event.casterId, 'periodic')) this.app.audio?.periodicDamage();
    }
  }

  private stopEnemies(): void {
    this.enemiesRunning = false;
    for (const enemy of this.arena) {
      if (this.pendingDefeats.has(enemy.key)) continue;
      this.conditions.clearTemporary(enemy.key);
      enemy.controller?.cancel();
      enemy.presenter.clear();
      this.movement.stop(enemy.visual);
    }
  }

  private updateEnemies(frame: number): void {
    this.enemiesRunning = true;
    const nowMs = frame * LOGIC_FRAME_MS;
    const idleThink = frame % ENEMY_IDLE_THINK_FRAMES === 0;
    for (const enemy of this.arena) {
      if (this.pendingDefeats.has(enemy.key)) continue;
      const controller = enemy.controller;
      if (!controller || controller instanceof FriendlySummonController) continue;
      if (!idleThink && !controller.needsFrame()) continue;
      controller.step(nowMs);
    }
    if (frame % AWARENESS_SWEEP_FRAMES === 0) this.observeSummonCombat();
    for (const enemy of this.arena) {
      if (!this.pendingDefeats.has(enemy.key) && enemy.controller instanceof FriendlySummonController) enemy.controller.step();
    }
  }

  /** 游戏行为驱动的移除：场景实例和名册条目一起删。 */
  removeEnemy(key: string): void {
    if (this.pendingDefeats.has(key)) {
      this.pendingDefeats.complete(key, false);
      return;
    }
    for (const child of summonedChildren(this.arena, key)) this.removeEnemy(child);
    if (!this.removeEnemyVisual(key)) return;
    this.roster.removeEnemy(key);
  }

  /**
   * 只销毁场上的场景实例，不动名册。
   *
   * `WorldEnemyRoster.refresh()` 返回的 diff 表示名册已经改完；消费端只能把场景
   * 投影同步过去。若这里再调 `roster.removeEnemy`，会把 refresh 刚换好的新条目删掉，
   * 下一帧名册和实例的 `key + enemyId` 就永久对不上。
   */
  private removeEnemyVisual(key: string): boolean {
    if (this.pendingDefeats.has(key)) {
      this.pendingDefeats.complete(key, false);
      return false;
    }
    const index = this.arena.findIndex(enemy => enemy.key === key);
    if (index < 0) return false;
    const [enemy] = this.arena.splice(index, 1);
    refreshCombatActors(this.arena);
    this.combatantsCache = undefined;
    this.summonAwareness?.forget(key);
    this.destroyEnemy(enemy);
    this.conditions.remove(key);
    this.summons.remove(key);
    for (const controller of this.partyControllers.values()) controller.targetRemoved(key);
    if (this.focusTargetId === key) this.focusTargetId = undefined;
    this.scene.refreshCombatTarget();
    return true;
  }

  private consumeRosterChanges(changes: { added: PlacedEnemy[]; removed: string[] }): void {
    for (const key of changes.removed) this.removeEnemyVisual(key);
    for (const placed of changes.added) this.spawnEnemy(placed);
    // 刷怪入口也可能带进 0 血敌人；只核对这一批新增条目。
    if (changes.added.length) this.reconcileZeroHealthEnemies('spawned', changes.added.map(placed => placed.key));
  }

  /** 施法者自己的活动召唤（有受命动作的才算）。 */
  private activeSummonsOf(ownerId: string): MapEnemy[] {
    return this.arena.filter(enemy => !this.pendingDefeats.has(enemy.key) && enemy.summonedBy === ownerId && !!enemy.definition.commandAction);
  }

  /** 快捷栏状态：起手资格对玩家入口与实际起手是同一判定，原版把失败结果显示成不可用。 */
  skillSlotAvailable(skillId: string): boolean {
    return this.stats.skillSlotAvailable(this.controlledId, skillId);
  }

  /** 快捷栏一次拿到耗蓝与起手资格，省得同一格重复解析技能定义。 */
  skillShortcutState(skillId: string, level: number | undefined): { cost: number; enabled: boolean } {
    return this.stats.skillShortcutState(this.controlledId, skillId, level);
  }

  private createPartyController(
    id: string,
    visual: CharacterVisual,
    presenter: CombatPresenter,
    attack: ReturnType<CombatActorStats['equipmentAttack']>,
  ): { controller: CombatController; port: PartyPort } {
    const facing = () =>
      id === 'player' ? this.scene.facing : (combatActor(this.allies, id, actor => actor.id)?.facing ?? 'south');
    const setFacing = (value: Facing) => {
      if (id === 'player') this.scene.facing = value;
      else {
        const ally = combatActor(this.allies, id, actor => actor.id);
        if (ally) ally.facing = value;
      }
    };
    const port: PartyPort = {
      isPaused: () => this.runtime.paused,
      cooldowns: this.app.session.cooldowns.forActor(id),
      selectBasicAttack: (normal, step) => this.stats.selectBasicAttack(id, visual.actor, normal, step),
      actor: key => this.combatant(key),
      candidates: () => this.combatants(),
      nearbyCandidates: circles => this.nearbyCandidates(circles),
      partySlots: () => this.settlement.partyBuffSlots(),
      isAlive: key => this.isActorAlive(key),
      rangeBonusUnits: key => this.stats.actorAttribute(key, 'attackRangeBonusUnits'),
      healScore: key => this.settlement.healScoreFor(key),
      healCandidates: () => this.settlement.healCandidates(),
      facing,
      followCanStand: point => this.movement.canStand(visual, point),
      followNavigationSnapshot: () => this.movement.navigation.captureStandability(this.movement.actor(visual), true),
      leader: () => this.combatant(this.controlledId),
      leaderFacing: () => this.facingOfControlled(),
      followSlot: () => this.app.session.party?.followSlotOf(this.controlledId, id),
      focusTarget: () => this.focusTargetId,
      partyTarget: () => this.settlement.currentTargetOf(this.controlledId),
      targetOf: actorId => this.settlement.currentTargetOf(actorId),
      // 玩家指派了目标，或队伍最近与敌人真实交战过，都算整个队伍已进入战斗。
      inCombat: () => !!this.focusTargetId || this.awareness.inCombat((this.app.session.combatTick ?? 0) * LOGIC_FRAME_MS),
      skills: () => this.partySkills.get(id) ?? [],
      skillUses: skill => this.app.session.party?.catalog.autoSkills[skill]?.uses ?? [],
      isBoss: key => (combatActor(this.arena, key, enemy => enemy.key)?.definition.specialRank ?? 0) >= 2,
      hasBuff: (key, buff) => this.conditions.hasBuff(key, buff),
      ownedSummons: key =>
        this.arena.flatMap(enemy => {
          if (enemy.summonedBy !== key || this.pendingDefeats.has(enemy.key)) return [];
          const actor = this.combatant(enemy.key);
          const command = enemy.definition.commandAction;
          return actor ? [{ ...actor, commandAction: command && summonCommandAction(key, command) }] : [];
        }),
      hasCriticalAlly: () =>
        this.activeParty.some(key => {
          const hp = this.memberOf(key)?.player;
          return !!hp && hp.health > 0 && hp.health <= hp.maxHealth * 0.35;
        }),
      vitals: key => {
        const member = this.memberOf(key);
        if (member) return member.player;
        const hp = this.actorHealth(key);
        return hp && { health: hp.current, maxHealth: hp.maximum };
      },
      attacking: key => this.partyControllers.get(key)?.actionState() === 'attacking',
      attackRange: (key = id) =>
        (this.partyControllers.get(key)?.basicAttackRange ?? controller.basicAttackRange) +
        this.stats.actorAttribute(key, 'attackRangeBonusUnits'),
      navigationBounds: () => this.movement.navigation.bounds,
      pathBudget: this.pathBudget,
      navigationSnapshot: () => this.movement.navigation.captureStandability(this.movement.actor(visual)),
      moveToward: position => {
        if (!this.conditions.canAutoApproach(id)) {
          this.movement.stop(visual);
          return;
        }
        setFacing(faceTarget(this.movement.position(visual), position));
        this.movement.toward(visual, position, this.movementSpeed(id, PLAYER_MOVE_SPEED));
      },
      followPath: (nextWaypoint, speedScale = 1) =>
        this.movement.followPath(
          visual,
          () => {
            if (!this.conditions.canMove(id)) return undefined;
            const next = nextWaypoint();
            if (next) setFacing(faceTarget(this.movement.position(visual), next));
            return next;
          },
          this.movementSpeed(id, PLAYER_MOVE_SPEED) * speedScale,
        ),
      stop: () => this.movement.stop(visual),
      canStand: (position, clearanceActorId) => {
        const clearanceVisual = clearanceActorId ? this.visualOf(clearanceActorId) : visual;
        return !!clearanceVisual && this.movement.canStand(clearanceVisual, position);
      },
      regroup: () => this.catchUpFollower(id),
      canPlaceBody: (position, clearanceActorId) => this.canPlaceBodyAt(visual, position, clearanceActorId),
      canRelocateReach: position => {
        const actor = this.movement.actor(visual);
        return this.movement.navigation.sameTerrainRegion(actor.position(), position);
      },
      canRelocateVerify: position => {
        const actor = this.movement.actor(visual);
        const shape = actor.shape();
        return (
          this.movement.navigation.sameTerrainRegion(actor.position(), position) &&
          canTraverse(
            actor.position(),
            position,
            point => this.movement.navigation.terrainFree(point) && !this.movement.navigation.blockedByContent(shape, point, actor),
          )
        );
      },
      relocate: (position, clearance) => this.relocateVisual(visual, position, clearance),
      face: setFacing,
      play: (action, frame, complete) => {
        setFacing(action.facing);
        action.getAttackSpeedRate = () => this.conditions.attribute(id, 'attackSpeedRate', 1000, this.stats.partyPassives(id));
        return this.playAction(presenter, action, frame, complete);
      },
      frame: (action, index, contact, unitsReady, areaContact) => {
        if (
          this.memberOf(action.caster.id) &&
          action.skill &&
          !this.soundedSkills.has(action) &&
          !action.skill.action.events.some(
            event => (event.kind === 'feedback' && event.sound) || ((event.kind === 'units' || event.kind === 'summon') && event.dispatch),
          ) &&
          skillPlaybackEvents(action.skill.action, index, action.skill.level).some(event => event.kind === 'units')
        ) {
          this.soundedSkills.add(action);
          this.app.audio?.playerSkill(action.skill.id);
        }
        this.presentActionFrame(
          presenter,
          action,
          index,
          contact,
          unitsReady,
          event => this.skillFeedback(action, event),
          (definition, work, afterDispatch) => this.settlement.runActionDispatch(action, definition, work, afterDispatch),
          areaContact,
        );
      },
      canSelectSkill: skill => this.stats.canSelectSkill(id, skill),
      manaCost: skill => this.stats.skillManaCost(id, skill.id, skill.level),
      canSpendMana: cost => this.conditions.isInfiniteMana(id) || (this.memberOf(id)?.player.mana ?? 0) >= cost,
      spendMana: cost => {
        const member = this.memberOf(id);
        if (!member) return false;
        // GM 调试无限蓝期间技能免费：返回成功但不扣 MP。
        return this.conditions.isInfiniteMana(id) ? true : member.spendMana(cost);
      },
      contact: event => this.settlement.attackContact(event),
      areaContact: event => this.settlement.basicAreaContact(event),
      prepareUnit: event => this.settlement.prepareSkillUnit(event),
      unit: event => this.settlement.skillUnit(event),
      runUnitSequence: work => this.hitResolution.run(work),
      unitFeedback: (hit, outcome, cue) => {
        presenter.showUnitFeedback(hit, outcome, cue);
        // 佣兵自己的技能单元命中也要出声；敌方单元保持原来的静音。
        if (outcome === 'success' && this.memberOf(hit.casterId) && cue.sound) this.app.audio?.effect(cue.sound);
      },
      clearEffects: () => {
        this.runtime.cancel(id);
        presenter.clear();
      },
    };
    const controller = new CombatController(id, attack, port);
    controller.subscribe(snapshot => {
      if (this.controlledId === id) {
        this.scene.refreshCombatTarget();
        this.scene.refreshCombatHud(snapshot.cooldowns);
      }
    });
    this.partyControllers.set(id, controller);
    this.runtime.registerActor(id, controller);
    return { controller, port };
  }

  private async syncAllies(): Promise<void> {
    const party = this.app.session.party;
    if (!party || this.closed) return;
    this.partySyncInFlight++;
    try {
      await this.syncPartyAllies(party);
    } finally {
      this.partySyncInFlight--;
    }
  }

  private async syncPartyAllies(party: PartyRoster): Promise<void> {
    const revision = party.activeRevision;
    let retry = false;
    // 新加入的队友需要重新应用当前暂停状态。
    this.pausedValue = undefined;
    const active = new Set(party.activeIds.slice(1));
    for (const ally of [...this.allies]) {
      if (!active.has(ally.id) || !this.partyControllers.has(ally.id)) {
        this.deathTweens.get(ally.id)?.stop();
        this.deathTweens.delete(ally.id);
        this.fallen.delete(ally.id);
        ally.ai.dispose();
        ally.presenter.clear();
        ally.overhead.destroy();
        this.movement.remove(ally.visual);
        ally.visual.container.destroy();
        ally.assets?.release();
        this.combatRuntime?.removeActor(ally.id);
        this.partyControllers.delete(ally.id);
        this.partySkills.delete(ally.id);
        this.conditions.remove(ally.id);
        this.threat.removeActor(ally.id);
        this.skillAssets.forgetAlly(ally.id);
        this.stats.forgetMemberCaches(ally.id);
        for (const enemy of this.arena) enemy.controller?.targetRemoved(ally.id);
        this.allies.splice(this.allies.indexOf(ally), 1);
        refreshCombatActors(this.allies);
      }
    }
    this.roster.setPartySize(party.activeSize, this.app.battleCatalog.enemies);
    for (const id of active) {
      if (this.allies.some(ally => ally.id === id) || this.pendingAllies.has(id)) continue;
      const member = party.get(id);
      let actor = member && this.app.world.actors[member.definition.actor];
      if (!member || !actor?.collision) continue;
      this.prepareCombatSounds();
      this.pendingAllies.add(id);
      this.allyLoadFailure = undefined;
      let lease: AssetLease | undefined;
      try {
        const learned = learnedSkillIds(this.app.battleCatalog, member.classId, member.skills);
        const signature = this.skillAssets.allySkillSignatureNow(member);
        const gate = this.skillAssets.allySkillGateNow(member);
        lease = await loadSceneAssets(
          this.scene.phaserScene,
          partyMemberCombatAssets(this.app.battleCatalog, this.app.wardrobe, member.classId, actor, learned, {
            items: this.app.items,
            equipment: this.hero.bag.equipmentItems(this.hero.bag.equipmentFor(id)),
          }),
          {},
        );
        if (this.closed || party.get(id) !== member || !party.activeIds.includes(id)) {
          lease.release();
          continue;
        }
        if (this.skillAssets.allySkillSignatureNow(member) !== signature) {
          lease.release();
          this.partySyncPending = true;
          this.nextPartySyncAt = this.scene.time.now + 100;
          retry = true;
          continue;
        }
        await this.scene.preparePartyMember(id, undefined, { full: true });
        if (this.closed || party.get(id) !== member || !party.activeIds.includes(id)) {
          lease.release();
          continue;
        }
        if (this.skillAssets.allySkillSignatureNow(member) !== signature) {
          lease.release();
          this.partySyncPending = true;
          this.nextPartySyncAt = this.scene.time.now + 100;
          retry = true;
          continue;
        }
        actor = this.scene.equipmentAppearance(id) ?? actor;
        // 上阵落点以主角为锚点，与当前操控者是谁无关；整盒判定避免身体压进地形。
        // 整张图都没有整盒空位时退到主角脚点：队友之间不占位，移动体会在下一步自愈，
        // 不因为一个队员的落点中断剧情或战斗。
        const landing = this.partyLanding({ collision: actor.collision });
        if (!landing) globalThis.storyDiagnostics?.record('party-landing-fallback', { map: this.scene.map?.id, id });
        const position = landing ?? this.movement.position(this.player);
        const visual = createCharacter(this.scene.phaserScene, actor, { id, actor: actor.id, ...position });
        const body = this.movement.register(visual, true, true, 'party');
        const presenter = new CombatPresenter(
          this.scene.phaserScene,
          this.app.battleCatalog,
          key => this.visualOf(key),
          () => this.combatants(),
          this.combatEffects,
        );
        const overhead = new OverheadStatus(
          this.scene.phaserScene,
          visual,
          this.app.statusHud,
          () => member.player,
          listener => this.app.session.subscribe(listener),
        );
        overhead.setVisible(true);
        const attack = this.stats.equipmentAttack(actor, id);
        const ally = {} as MapAlly;
        ally.id = id;
        ally.member = member;
        ally.visual = visual;
        ally.body = body;
        ally.facing = 'south';
        ally.presenter = presenter;
        ally.overhead = overhead;
        ally.assets = lease;
        this.allies.push(ally);
        refreshCombatActors(this.allies);
        const shared = this.createPartyController(id, visual, presenter, attack);
        ally.controller = shared.controller;
        this.partySkills.set(id, this.stats.partySkillsFor(id));
        ally.ai = new PartyController(id, shared.port, shared.controller);
        this.skillAssets.recordPreparedAlly(id, learned, signature, gate);
        if (!member.alive) this.markAlreadyFallen(id);
      } catch (error) {
        lease?.release();
        this.allyLoadFailure = error;
        this.partySyncPending = true;
        this.nextPartySyncAt = this.scene.time.now + 1000;
        if (!this.closed) throw error;
      } finally {
        this.pendingAllies.delete(id);
        if (!this.pendingAllies.size) for (const notify of [...this.allyWaiters]) notify();
      }
    }
    this.combatantsCache = undefined;
    this.syncControlled();
    this.prepareCombatSounds();
    // 同步期间队伍又变过就保留待同步状态，下一帧再补一轮，不能把新版本吞掉。
    if (!retry && party.activeRevision === revision) {
      this.syncedPartyRevision = revision;
      this.partySyncPending = false;
    } else {
      this.partySyncPending = true;
    }
  }

  /** 队伍版本变化或显式待同步时重新同步；失败重试仍由 `nextPartySyncAt` 延后。 */
  private shouldSyncParty(now: number): boolean {
    if (this.partySyncInFlight > 0 || now < this.nextPartySyncAt) return false;
    if (this.partySyncPending) return true;
    const party = this.app.session.party;
    return !!party && party.activeRevision !== this.syncedPartyRevision;
  }

  /** 以队长脚点为锚，按相对当前队长的跟随侧位偏到后排附近。 */
  private partyLanding(
    shape: NavigationShape,
    ignore?: NavigationActor,
    id?: string,
    leader: CharacterVisual | undefined = this.scene.player,
  ): Point | undefined {
    if (!this.movement || !leader) return undefined;
    const anchor = this.movement.position(leader);
    // 补位偏移也要按实际队长重新排左右，不能沿用固定名册槽位。
    const leaderId = leader === this.player ? 'player' : this.controlledId;
    const slot = id ? this.app.session.party?.followSlotOf(leaderId, id) : undefined;
    const offset = slot === undefined ? undefined : followOffset(this.facingOfControlled(), 'back', slot);
    const origin = offset ? { x: anchor.x + offset.x, y: anchor.y + offset.y } : anchor;
    // 主角不是 `allies` 的一员；操控佣兵时补位必须把主角也列为避让点，否则会瞬移叠到主角身上。
    const avoid = [
      anchor,
      ...(leader === this.player ? [] : [this.movement.position(this.player)]),
      ...this.allies.filter(ally => this.movement.actor(ally.visual) !== ignore).map(ally => this.movement.position(ally.visual)),
    ];
    return choosePartyLanding(this.movement.navigation, shape, origin, ignore, avoid);
  }

  private facingOfControlled(): Facing {
    return this.controlledId === 'player'
      ? this.scene.facing
      : (combatActor(this.allies, this.controlledId, actor => actor.id)?.facing ?? 'south');
  }

  /**
   * 剧情把主角送到新位置后，把其余上阵队员收拢到主角身边。
   * 只移动队员视觉体，不改变操控者；倒下或找不到合法落点的队员保持原位。
   */
  regroupPartyAroundHero(): void {
    if (this.closed || !this.movement || !this.scene.player) return;
    for (const id of this.activeParty) {
      if (id === 'player') continue;
      const ally = combatActor(this.allies, id, actor => actor.id);
      if (!ally || !ally.member.player.health || this.fallen.has(id) || !ally.visual.container.active) continue;
      ally.ai.cancel();
      const actor = this.movement.actor(ally.visual);
      const landing = this.partyLanding(actor.shape(), actor, id);
      if (!landing) continue;
      this.movement.place(ally.visual, landing);
      setCharacterClip(this.scene.phaserScene, ally.visual, `idle-${ally.facing}`, true);
    }
  }

  /** 是否该在剧情收尾时把单位拉回主角身边：太远、整盒不合法，或已经和队友叠在一起。 */
  private shouldSettleFriendly(visual: CharacterVisual, actor: NavigationActor, id?: string): boolean {
    const position = this.movement.position(visual);
    const hero = this.movement.position(this.player);
    // 与普通跟随的收拢阈值一致，避免剧情收尾时在玩家眼前做小幅瞬移。
    if (Math.hypot(position.x - hero.x, position.y - hero.y) > FRIENDLY_SETTLE_MAX_DISTANCE_PX) return true;
    const navigation = this.movement.navigation;
    if (!navigation.terrainFree(position) || !navigation.canPlaceBody(actor.shape(), position, actor)) return true;
    if (!id) return false;
    // 读档可能带进旧重叠；已经和主角或另一名存活队员站在同一个盒子里时也重新落位。
    const shape = actor.shape();
    return [
      this.player,
      ...this.allies.filter(other => other.id !== id && other.member.player.health > 0 && !this.fallen.has(other.id)).map(other => other.visual),
    ].some(other => partyBodyOverlaps(position, this.movement.position(other), shape));
  }

  /**
   * 剧情正常结束后，把掉队或被剧情障碍困住的佣兵、友方召唤物收拢到主角身边。
   * 只处理远离或位置非法的单位；已经站好的队形和正在攻击/施法的单位不动。
   */
  settleFriendlyUnitsAroundHero(): void {
    if (this.closed || !this.movement || !this.scene.player) return;
    // 剧情末节点 waitEncounter 会先把遭遇置为 active；这表示战斗即将开始，
    // 不表示佣兵已经交战。因此这里只挡玩家已指派的战斗目标，真正的追击、
    // 施法单位由下面的逐单位状态检查跳过。
    if (this.focusTargetId) return;
    for (const id of this.activeParty) {
      if (id === 'player') continue;
      const ally = combatActor(this.allies, id, actor => actor.id);
      if (!ally || !ally.member.player.health || this.fallen.has(id) || !ally.visual.container.active) continue;
      const actor = this.movement.actor(ally.visual);
      if (ally.ai.actionState() !== 'idle' || ally.ai.selectedTargetId() || !this.shouldSettleFriendly(ally.visual, actor, id)) continue;
      const landing = this.partyLanding(actor.shape(), actor, id);
      if (!landing) continue;
      ally.ai.cancel();
      this.movement.place(ally.visual, landing);
      setCharacterClip(this.scene.phaserScene, ally.visual, `idle-${ally.facing}`, true);
    }
    for (const enemy of this.arena) {
      if (!enemy.summonedBy || !this.memberOf(enemy.summonedBy) || this.pendingDefeats.has(enemy.key) || !this.isActorAlive(enemy.key) || !enemy.visual.container.active) {
        continue;
      }
      if (summonLifetimeExpired(enemy.summonRemainingMs)) continue;
      if (enemy.controller && 'actionState' in enemy.controller && enemy.controller.actionState() !== 'idle') continue;
      const actor = this.movement.actor(enemy.visual);
      if (!this.shouldSettleFriendly(enemy.visual, actor)) continue;
      const landing = this.partyLanding(actor.shape(), actor);
      if (!landing) continue;
      enemy.controller?.cancel();
      this.movement.place(enemy.visual, landing);
      setCharacterClip(this.scene.phaserScene, enemy.visual, `idle-${enemy.facing}`, true);
    }
  }

  /**
   * 单个佣兵跟随队长长时间没有进展时，把他收拢到队长旁边的合法落点。
   * 与剧情转场后的整队收拢共用落点规则，但只动这一名队员。
   */
  private catchUpFollower(id: string): boolean {
    if (this.closed || !this.movement || id === this.controlledId) return false;
    const ally = combatActor(this.allies, id, actor => actor.id);
    const visual = id === 'player' ? this.scene.player : ally?.visual;
    const ai = id === 'player' ? this.heroAi : ally?.ai;
    if (!visual || !ai || !(id === 'player' ? this.hero : ally?.member)?.player.health || this.fallen.has(id) || !visual.container.active) {
      return false;
    }
    if (ai.actionState() !== 'idle' || !this.conditions.canMove(id)) return false;
    const leader = this.controlledVisual;
    if (!leader) return false;
    const now = this.app.session.nowMs ?? 0;
    if ((this.regroupCooldowns.get(id) ?? 0) > now) return false;
    const actor = this.movement.actor(visual);
    const landing = this.partyLanding(actor.shape(), actor, id, leader);
    if (!landing) return false;
    ai.cancel();
    this.movement.place(visual, landing);
    this.regroupCooldowns.set(id, now + REGROUP_COOLDOWN_MS);
    setCharacterClip(this.scene.phaserScene, visual, `idle-${id === 'player' ? this.scene.facing : ally!.facing}`, true);
    this.followerCatchUps++;
    return true;
  }

  /**
   * 绑定当前操控者。`cancelActions=false` 只交接触发、相机和 HUD，不碰任何人的动作；
   * 玩家主动切人走这条，正在进行的普攻或技能由原角色自己收尾。
   */
  private syncControlled(cancelActions = true): void {
    const id = this.controlledId;
    this.feedback.cancelShake();
    this.combat = this.partyControllers.get(id);
    if (!this.combat && id !== 'player') return;
    if (id !== this.syncedControlledId) this.controlRevision++;
    this.syncedControlledId = id;
    if (cancelActions) {
      for (const ally of this.allies) ally.ai.cancel();
      this.heroAi?.cancel();
    }
    this.scene.syncControlledCharacter();
  }

  switchControl(id: string): boolean {
    if (id === this.controlledId) return false;
    if (!this.partyControllers.has(id)) return false;
    const previous = this.controlledVisual;
    if (!this.app.session.party?.switchControl(id)) return false;
    this.movement.stop(previous);
    this.syncControlled(false);
    return true;
  }

  /**
   * Q/E 切人：只在存活、已出战且有战斗控制器的成员之间循环。
   * 目标不可用时静默返回 false；单人队伍、全灭或资源未加载完都不会有动作。
   */
  switchMember(direction: -1 | 1): boolean {
    const party = this.app.session.party;
    if (!party) return false;
    const candidates = party.livingIds.filter(id => this.partyControllers.has(id));
    if (candidates.length < 2) return false;
    const target = adjacentLivingMember(candidates, this.controlledId, direction);
    if (!target || target === this.controlledId) return false;
    return this.switchControl(target);
  }

  focusTarget(key: string | undefined): void {
    if (key && this.isUnavailableEnemyTarget(key)) return;
    this.focusTargetId = key;
  }

  focusSelected(): void {
    if (this.targetId) this.focusTarget(this.targetId);
    else this.followControlled();
  }

  followControlled(): void {
    this.focusTarget(undefined);
    this.combat?.cancel(false);
  }

  async start(options: { restore?: boolean } = {}): Promise<void> {
    const catalog = this.app.battleCatalog;
    const attack = this.stats.equipmentAttack(this.player.actor);
    // 玩家侧素材已由入口常驻包持有，这里再取同一批是幂等的；敌人按进图预取的同一份超集加载，
    // 包含可破坏物掉落怪、剧情遭遇、泉水与宝箱怪，运行时刷怪不会再遇到未加载的纹理。
    const enemyIds = new Set([
      ...this.scene.combatEnemyIds(),
      ...this.roster.spawns.map(spawn => spawn.enemyId),
      ...this.scene.entities.flatMap(entity => {
        const kind = this.app.world.actors[entity.actor]?.chest;
        const spawn = kind ? this.drops.chests[kind]?.spawn : undefined;
        return spawn ? [spawn.enemyId] : [];
      }),
    ]);
    const needed = [
      ...sharedCombatAssets(catalog, this.app.wardrobe),
      ...[...enemyIds].flatMap(id => {
        const definition = catalog.enemies.find(enemy => enemy.id === id);
        if (!definition) throw new Error(`敌人定义缺失：${id}`);
        return this.enemyAssets(definition);
      }),
    ];
    // 音效与画面并行准备，不参与战斗入口的等待：音频加载失败不该挡住战斗。
    this.prepareCombatSounds();
    const generation = ++this.generation;
    const lease = await loadSceneAssets(this.scene.phaserScene, needed, {});
    if (this.closed || generation !== this.generation) {
      lease.release();
      return;
    }
    this.playerAssets = lease;
    this.statusVisuals.initFocusRings(this.scene.phaserScene);
    // 结算特效素材已在共享包里；这里先把容器、精灵和动画建好，升级时只重播。
    this.outcomes.warm();
    this.feedback.warm();
    await this.skillAssets.prepareInitialPlayer();
    if (this.closed || generation !== this.generation) return;
    if (!this.skillAssets.hasLease('player')) throw new Error('主角战斗素材准备失败，请重试');
    this.presenter = new CombatPresenter(
      this.scene.phaserScene,
      catalog,
      id => this.visualOf(id),
      () => this.combatants(),
      this.combatEffects,
    );
    const heroController = this.createPartyController('player', this.player, this.presenter, attack);
    this.combat = heroController.controller;
    this.partySkills.set('player', this.stats.partySkillsFor('player'));
    this.heroAi = new PartyController('player', heroController.port, heroController.controller);
    if (!this.hero.player.health) this.markAlreadyFallen('player');
    this.lastSkillResets.clear();
    for (const id of this.activeParty) {
      const configuration = id === 'player' ? this.app.session.skills : this.app.session.party?.get(id)?.skills;
      if (configuration) this.lastSkillResets.set(id, { configuration, revision: configuration.resetVersion });
    }
    this.unsubscribeHero = this.hero.subscribe(() => this.onHeroChanged());
    this.unsubscribeSession = this.app.session.subscribe(() => this.onPartyChanged());
    await this.syncAllies();
    if (!options.restore) {
      for (const placed of [...this.roster.enemies]) this.spawnEnemy(placed);
      this.reconcileZeroHealthEnemies('restored');
    }
    this.scene.refreshCombatTarget();
    this.diagnosticStartedAt = performance.now();
    this.diagnosticElapsedMs = 0;
    globalThis.storyDiagnostics?.record(
      'combat-start',
      { map: this.scene.map?.id, controlled: this.controlledId, party: this.activeParty, heroLevel: this.hero.level, enemies: this.arena.length },
      false,
    );
  }

  updateMemberAppearance(id: string, actor: ActorDefinition): void {
    const ally = combatActor(this.allies, id, entry => entry.id);
    if (!ally) return;
    ally.controller.cancel(true);
    ally.visual.actor = actor;
    this.movement.refreshShape(ally.visual);
    setCharacterClip(this.scene.phaserScene, ally.visual, `idle-${ally.facing}`, true);
  }

  updateEquipment(id = 'player'): void {
    const member = this.memberOf(id);
    if (member) {
      const recipe = costumeRecipe(this.app.wardrobe, this.app.items, member.bag.equipmentItems(member.bag.equipmentFor(id)));
      this.app.session.frenzyAnimations.updateEquipment(id, recipe.frenzyAttack?.cycleFrames);
    }
    const controller = this.partyControllers.get(id);
    if (!controller) return;
    controller.cancel(true);
    if (id === 'player') controller.setBasicAttack(this.stats.equipmentAttack(this.player.actor));
    else {
      const ally = combatActor(this.allies, id, actor => actor.id);
      const character = this.app.battleCatalog.classes.find(value => value.id === ally?.member.classId);
      if (ally && character) controller.setBasicAttack(this.stats.equipmentAttack(ally.visual.actor, id));
    }
  }

  private spawnEnemy(placed: PlacedEnemy): void {
    if (this.closed || this.arena.some(enemy => enemy.key === placed.key)) return;
    // 新刷出的敌人/召唤物需要重新应用当前暂停状态。
    this.pausedValue = undefined;
    const definition = this.app.battleCatalog.enemies.find(enemy => enemy.id === placed.enemyId);
    if (!definition?.actor.collision) throw new Error(`敌人外观缺少碰撞范围：${placed.enemyId}`);
    this.arena.push(this.buildEnemy(placed, definition));
    refreshCombatActors(this.arena);
    this.combatantsCache = undefined;
  }

  syncChestEnemies(): void {
    this.consumeRosterChanges(this.roster.refresh());
  }

  /** Load encounter resources before creating physical enemies in the formal map. */
  async projectStoryEnemies(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const definitions = [...new Set(this.roster.spawns.map(spawn => spawn.enemyId))].map(id => {
      const definition = this.app.battleCatalog.enemies.find(enemy => enemy.id === id);
      if (!definition) throw new Error(`剧情敌人缺少定义：${id}`);
      return definition;
    });
    const buffs = this.app.session.storyWorld.pendingPartyBuffs;
    const effects = Object.fromEntries(
      buffs.flatMap(value => {
        const effect = this.app.battleCatalog.statusAttackBuffs?.[value.buff]?.applicationEffect;
        return effect ? [[effect, this.app.battleCatalog.attackEffects[effect]]] : [];
      }),
    );
    const lease = await loadSceneAssets(
      this.scene.phaserScene,
      [...definitions.flatMap(definition => this.enemyAssets(definition)), ...effectAssets(effects)],
      {},
    );
    if (this.closed || signal.aborted) {
      lease.release();
      signal.throwIfAborted();
      return;
    }
    this.storyAssets?.release();
    this.storyAssets = lease;
    applyStoryEnemyRemovals(
      this.app.session,
      this.scene.map!.id,
      this.arena.map(enemy => ({ key: enemy.key, enemyId: enemy.definition.id })),
      key => {
        this.conditions.remove(key);
        this.removeEnemy(key);
      },
    );
    this.syncChestEnemies();
    await this.syncAllies();
    signal.throwIfAborted();
    for (const value of buffs) {
      const effect = this.app.battleCatalog.statusAttackBuffs?.[value.buff];
      if (!effect) throw new Error('剧情状态缺少定义：' + value.buff);
      for (const id of this.settlement.activePartySlots()) this.settlement.applyActorBuff(id, value.buff, value.strength, effect, id);
    }
    this.app.session.storyWorld.consumePartyBuffs(buffs.length);
    for (const id of [...this.fallen]) if (this.memberOf(id)?.player.health) this.reviveMember(id);
    const party = this.app.session.party;
    if (this.defeated && (party?.livingIds.length ?? this.hero.player.health) > 0) {
      this.defeated = false;
      this.wipeoutPending = false;
      this.wipeoutPosition = undefined;
      this.focusTargetId = undefined;
      if (party && !party.alive(party.controlledId)) party.switchControl(party.livingIds[0]);
      this.syncControlled();
    }
  }

  async normalizeForStory(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    for (const finish of [...this.partyDefeatWork.values()]) finish();
    this.runtime.reset();
    this.suspendPartyActions();
    for (const enemy of this.arena) {
      enemy.controller?.combatController?.cancel(true, false);
      enemy.controller?.targetRemoved(this.controlledId);
      this.movement.stop(enemy.visual);
    }
    // A death already confirmed by combat must settle before the story checkpoint.
    this.pendingDefeats.flush();
    if (this.pendingAllies.size) {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          this.allyWaiters.delete(done);
          signal.removeEventListener('abort', abort);
        };
        const done = () => {
          if (this.pendingAllies.size && !this.closed) return;
          cleanup();
          if (this.closed) reject(new DOMException('正式战斗已关闭', 'AbortError'));
          else resolve();
        };
        const abort = () => {
          cleanup();
          reject(signal.reason ?? new DOMException('剧情已取消', 'AbortError'));
        };
        this.allyWaiters.add(done);
        signal.addEventListener('abort', abort, { once: true });
      });
      signal.throwIfAborted();
      if (this.allyLoadFailure) throw this.allyLoadFailure;
      this.partyActionsSuspended = false;
      this.suspendPartyActions();
    }
  }

  get completedStoryEncounters() {
    return this.roster.completedEncounters();
  }

  private makeSelectable(enemy: MapEnemy): void {
    if (enemy.summonedBy && this.memberOf(enemy.summonedBy)) return;
    const rect = enemyTapRect(enemy.definition.actor);
    // `enemy` 标记给世界级左键用：点到敌人时直接普攻，不会被旁边的交互物抢走。
    enemy.visual.container
      .setInteractive(new Phaser.Geom.Rectangle(rect.x, rect.y, rect.width, rect.height), Phaser.Geom.Rectangle.Contains)
      .setData('enemy', true);
    enemy.visual.container.on('pointerdown', () => {
      if (this.scene.canCombatControl) this.selectEnemy(enemy.key);
    });
  }

  private visualOf(id: string): CharacterVisual | undefined {
    return id === 'player'
      ? this.scene.player
      : (combatActor(this.allies, id, actor => actor.id)?.visual ?? combatActor(this.arena, id, actor => actor.key)?.visual);
  }

  /** 选敌同时遵守名册在场状态、死亡单与当前血量。 */
  private isUnavailableEnemyTarget(id: string): boolean {
    return !this.roster.isPresent(id) || this.pendingDefeats.has(id) || this.hitResolution.isAwaitingDefeat(id) || this.roster.hasZeroHealth(id);
  }

  private combatant(id: string): Combatant | undefined {
    if (this.pendingDefeats.has(id) || (this.memberOf(id) && !this.activeParty.includes(id))) return;
    const visual = this.visualOf(id);
    if (!visual?.container.active || !visual.actor.collision) return;
    const enemy = combatActor(this.arena, id, actor => actor.key);
    if (enemy && !this.roster.isPresent(id, enemy.definition.id)) return;
    const ally = combatActor(this.allies, id, actor => actor.id);
    if ((id === 'player' || ally) && !this.memberOf(id)?.player.health && !this.hitResolution.isAwaitingDefeat(id)) return;
    return {
      id,
      team: id === 'player' || ally || (enemy?.summonedBy && this.memberOf(enemy.summonedBy)) ? 'party' : 'hostile',
      position: this.movement.position(visual),
      bounds: this.movement.actor(visual).shape().collision!,
      states: this.conditions.activeStates(id),
      facing: id === 'player' ? this.scene.facing : (ally?.facing ?? enemy?.facing),
    };
  }

  selectEnemy(key: string): void {
    if (this.isUnavailableEnemyTarget(key) || !this.combat?.selectTarget(key)) return;
    this.focusTarget(key);
    this.scene.refreshCombatTarget();
  }

  targetStatus() {
    // 操作人有目标时用操作人的；操作人没动手时，队友正在打或正在交战的敌人也要显示在顶部。
    const enemy =
      this.targetOnMap(this.combat?.selectedTargetId()) ??
      this.targetOnMap(this.partyTarget()) ??
      this.targetOnMap(this.engagedTarget());
    return enemy ? this.roster.enemyStatus(enemy.key, enemy.definition) : undefined;
  }

  private targetOnMap(id: string | undefined) {
    return id && !this.isUnavailableEnemyTarget(id) ? this.arena.find(item => item.key === id) : undefined;
  }

  /** 队友控制器当前盯着的敌人；操作人的控制器不在这里重复算。 */
  private partyTarget(): string | undefined {
    for (const [id, controller] of this.partyControllers) {
      if (id === this.controlledId) continue;
      const target = controller.selectedTargetId();
      if (target) return target;
    }
    return undefined;
  }

  /** 最近交战的敌人：佣兵被攻击但没有还手时，控制器里还没有目标。 */
  private engagedTarget(): string | undefined {
    return this.awareness.tactics(this.controlledId, this.activeParty, this.focusTargetId).engagedTargetIds[0];
  }

  /** 战斗待命时转身朝向：最近仍在交战、且当前可攻击的敌人。 */
  hasHostileTarget(): boolean {
    const source = this.combatant(this.controlledId);
    return !!source && this.combatants().some(target => source.team !== target.team && canTargetCombatant(source, target));
  }

  attack(key?: string): void {
    if (!this.scene.canCombatControl || this.closed || this.defeated) return;
    // 主动技能动作期间不接受第二个技能；普攻输入仍由控制器按原规则处理。
    if (key && this.castingSkill) return;
    // 药水病状态 17 只封快捷栏技能，普攻和 AI 直接起手不受影响。
    if (key && !this.conditions.canUseSkillShortcuts(this.controlledId)) return;
    if (this.conditions.cannotAct(this.controlledId)) return;
    const skill = key ? skillForMember(this.app.battleCatalog, this.controlledId, key) : undefined;
    if (key && !skill?.action) return;
    const member = this.controlledMember;
    if (key && this.controlledId === 'player' && !this.app.session.skills.isEquipped(key)) return;
    const overrides = costumeRecipe(
      this.app.wardrobe,
      this.app.items,
      this.hero.bag.equipmentItems(this.hero.bag.equipmentFor(this.controlledId)),
      member.classId,
      member === this.hero ? undefined : (member as CompanionMember).definition.actor,
    ).actions;
    const selected = key && key in overrides ? overrides[key] : skill?.action;
    const action =
      selected && skill?.action
        ? {
            ...selected,
            hitEffectStyle: skill.action.hitEffectStyle,
            usesSkillDamageBuff: skill.action.usesSkillDamageBuff,
            combatUnits: skill.action.combatUnits,
            repeat: skill.action.repeat
              ? { ...skill.action.repeat, restartAfterFrame: selected.repeat?.restartAfterFrame ?? skill.action.repeat.restartAfterFrame }
              : undefined,
          }
        : selected;
    if (key && !action) {
      this.app.ui.showInstant('该技能需要装备对应武器');
      return;
    }
    const configuration = this.skillConfiguration(this.controlledId, member);
    const level = key ? configuration.draft(this.app.battleCatalog, member.classId).levels[key] : undefined;
    if (key && !level) return;
    const manaCost = key ? this.stats.skillManaCost(this.controlledId, key, level) : undefined;
    const clips = this.controlledId === 'player' || !key ? undefined : skillClips(key);
    const requested = action ? { id: key!, action, level, manaCost, clips } : undefined;
    if (requested && targetsEnemies(action!)) this.manualOffensiveSkills.set(requested, this.controlRevision);
    this.runtime.request({ actorId: this.controlledId, mode: action ? 'manual' : 'normal', skill: requested });
  }

  cancelAttack(): void {
    if (this.combatRuntime?.hasPendingBasicStrike(this.controlledId)) return;
    this.combat?.cancel(false, false);
    this.conditions.clearTemporary(this.controlledId);
  }

  /** 摇杆真的移动时调用：原版移动会清当前目标，面板随之隐藏。 */
  clearTarget(): void {
    if (this.combatRuntime?.hasPendingBasicStrike(this.controlledId)) return;
    this.combat?.clearSelection();
  }

  get paused(): boolean {
    return this.runtime.paused;
  }

  /** 快照前把死亡单立刻结算：快照里不能出现 0 血又没有死亡记录的敌人。 */
  settleForSnapshot(): void {
    this.pendingDefeats.flush();
    // 正常情况下不会剩 0 血无单的敌人；快照边界再自查一次，异常现场也不会写进存档/检查点。
    this.reconcileZeroHealthEnemies('restored');
  }

  /**
   * 回滚或还原会话前放弃还没结算的死亡单：只清场，不写经验、掉落或死亡记录。
   * 否则旧场景销毁时的结算会写进已经替换的会话。
   */
  discardPendingDefeats(): void {
    for (const key of this.pendingDefeats.keys()) {
      this.runtime.cancel(`defeat:${key}`);
      this.outcomes.cancelDeath(key);
    }
    this.pendingDefeats.clear();
    this.partyDefeatWork.clear();
    this.combatantsCache = undefined;
  }

  settleForSave(): void {
    this.settleForSnapshot();
    for (const finish of [...this.partyDefeatWork.values()]) finish();
  }

  setPaused(paused: boolean): void {
    if (this.pausedValue === paused) return;
    this.pausedValue = paused;
    this.runtime.setPaused('control', paused);
    for (const id of [...this.activeParty, ...this.arena.map(enemy => enemy.key)]) {
      const visual = this.visualOf(id);
      if (!visual) continue;
      this.movement.setPaused(visual, paused);
      for (const layer of visual.layers) {
        if (paused) layer.anims.pause();
        else layer.anims.resume();
      }
      this.presenterFor(id)?.setPaused(paused);
    }
    this.combatEffects.setPaused(paused);
  }

  suspendPartyActions(): void {
    if (this.partyActionsSuspended) return;
    this.partyActionsSuspended = true;
    for (const id of this.activeParty) {
      if (id === this.controlledId) this.partyControllers.get(id)?.cancel(true, false);
      else if (id === 'player') this.heroAi?.cancel();
      else combatActor(this.allies, id, actor => actor.id)?.ai.cancel();
      this.conditions.clearTemporary(id);
      const visual = this.visualOf(id);
      if (visual) this.movement.stop(visual);
    }
  }

  stopMoving(): void {
    this.movement.stop(this.controlledVisual);
    if (this.controlledMember.player.health && this.attackState !== 'attacking') {
      setCharacterClip(this.scene.phaserScene, this.controlledVisual, `idle-${this.facing}`);
    }
  }

  movementSpeedForPlayer(): number {
    return this.movementSpeed(this.controlledId, PLAYER_MOVE_SPEED);
  }

  playerCannotMove(): boolean {
    return !this.conditions.canMove(this.controlledId) || this.defeated || !this.controlledMember.player.health;
  }

  /** 玩家真正给出方向输入：先解除埋伏与狙击，再挂上逐段恢复的移动斜坡。 */
  cancelAmbushOnDirection(): void {
    this.settlement.cancelAmbushOnDirection();
  }

  /**
   * 喝泉水给的状态：原版 `CHAR_DrinkSpring` 的效果类型 4 直接建 buff，不经过技能或命中。
   * 正面状态给每名存活的上阵队员；负面或攻防混合的状态只给喝下泉水的人。
   */
  applySpringBuff(key: BattleBuffKey, scope: SpringBuffScope): boolean {
    return this.settlement.applySpringBuff(key, scope);
  }

  playerCannotAct(): boolean {
    return this.conditions.cannotAct(this.controlledId) || this.defeated || !this.controlledMember.player.health;
  }

  private markAlreadyFallen(id: string): void {
    const visual = this.visualOf(id);
    if (!visual) return;
    this.fallen.add(id);
    this.movement.setEnabled(visual, false);
    visual.container.setVisible(false);
  }

  private onPartyChanged(): void {
    if (this.closed) return;
    const active = new Set(this.activeParty);
    for (const id of active) {
      const configuration = id === 'player' ? this.app.session.skills : this.app.session.party?.get(id)?.skills;
      if (!configuration) continue;
      const previous = this.lastSkillResets.get(id);
      const revision = configuration.resetVersion;
      if (previous?.configuration === configuration) {
        if (previous.revision === revision) continue;
        previous.revision = revision;
        this.partyControllers.get(id)?.cancel(true);
        this.runtime.cancel(id);
        this.conditions.clearTemporary(id);
      } else {
        this.lastSkillResets.set(id, { configuration, revision });
      }
    }
    for (const id of this.lastSkillResets.keys()) if (!active.has(id)) this.lastSkillResets.delete(id);
    for (const [id, controller] of this.partyControllers) {
      if (!active.has(id)) {
        this.partySyncPending = true;
        controller.cancel(true);
        this.runtime.removeActor(id);
        this.partyControllers.delete(id);
        this.conditions.remove(id);
        this.threat.removeActor(id);
        this.skillAssets.forgetAllySignature(id);
        this.stats.forgetMemberCaches(id);
        for (const key of this.summons.removeOwner(id)) this.removeEnemy(key);
        const visual = this.visualOf(id);
        if (visual) {
          this.movement.setEnabled(visual, false);
          visual.container.setVisible(false);
        }
      }
    }
    this.skillAssets.scheduleRefresh();
  }

  private onHeroChanged(): void {
    this.scene.refreshCombatTarget();
    if (this.hero.player.health === 0) {
      this.hitResolution.deferDefeat('player', () => {
        if (this.hero.player.health === 0) this.memberDefeated('player');
      });
    }
    this.skillAssets.scheduleRefresh();
  }

  private memberDefeated(id: string): void {
    if (this.closed || this.fallen.has(id)) return;
    const visual = this.visualOf(id);
    if (!visual) return;
    this.fallen.add(id);
    if (!this.activeParty.some(member => this.memberOf(member)?.player.health)) {
      this.wipeoutPosition = this.movement.position(visual);
    }
    this.partyControllers.get(id)?.cancel(true);
    this.conditions.remove(id);
    this.memberOf(id)?.clearCombatResourceLimits();
    if (id === 'player') this.heroAi?.disable();
    else combatActor(this.allies, id, actor => actor.id)?.ai.disable();
    for (const controller of this.partyControllers.values()) controller.targetRemoved(id);
    for (const enemy of [...this.arena]) {
      enemy.controller?.targetRemoved(id, 'inactive');
      if (enemy.summonedBy === id) this.removeEnemy(enemy.key);
    }
    this.movement.stop(visual);
    this.movement.setEnabled(visual, false);
    const finish = () => {
      this.partyDefeatWork.delete(id);
      this.runtime.cancel(`party-defeat:${id}`);
      this.deathTweens.get(id)?.stop();
      this.deathTweens.delete(id);
      if (this.closed || this.memberOf(id)?.player.health) return;
      visual.container.setVisible(false);
      // 全灭以队伍存活数为准，不等最后一条死亡演出：演出可能被暂停或重建清掉。
      if (this.app.session.party?.onDefeat(id) ?? !this.hero.player.health) {
        this.wipeoutPending = true;
        this.playerDefeated();
      } else {
        this.syncControlled();
      }
    };
    const facing = id === 'player' ? this.scene.facing : combatActor(this.allies, id, actor => actor.id)!.facing;
    const deathClip = `die-${facing}` as const;
    const clip = id === 'player' ? undefined : visual.actor.clips[deathClip];
    if (clip) setCharacterClip(this.scene.phaserScene, visual, deathClip, true);
    else for (const sprite of visual.layers) sprite.anims.stop();
    const deathTween = this.scene.tweens.add({
      targets: visual.container,
      alpha: 0,
      delay: clip ? (clip.frames * 1000) / clip.frameRate : 0,
      duration: 10 * LOGIC_FRAME_MS,
    });
    this.deathTweens.set(id, deathTween);
    // 暂停期间新倒下的角色也要立刻停在首帧，不能等下一次暂停状态切换。
    if (this.deathVisualsPaused) {
      deathTween.pause();
      for (const sprite of visual.layers) sprite.anims.pause();
    }
    this.partyDefeatWork.set(id, finish);
    this.runtime.schedule(`party-defeat:${id}`, 10 + (clip ? Math.ceil((clip.frames * 1000) / clip.frameRate / LOGIC_FRAME_MS) : 0), finish);
  }

  private isPartyWiped(): boolean {
    const party = this.app.session.party;
    return party ? party.livingIds.length === 0 : this.hero.player.health <= 0;
  }

  private playerDefeated(): void {
    if (this.defeated || this.closed) return;
    // 压测模式不打开阵亡面板：全灭后立即补满，继续刷怪。
    if (this.app.pressureMode) {
      this.reviveFallenForPressure();
      return;
    }
    this.defeated = true;
    this.wipeoutPending = false;
    // 全灭已确认：不再等剩余死亡演出，一次收尾，避免暂停后留下半截角色。
    for (const [id, tween] of this.deathTweens) {
      tween.stop();
      this.visualOf(id)?.container.setVisible(false);
      this.partyDefeatWork.delete(id);
      this.runtime.cancel(`party-defeat:${id}`);
    }
    this.deathTweens.clear();
    this.outcomes.setPaused(true);
    this.runtime.setPaused('control', true);
    for (const controller of this.partyControllers.values()) controller.cancel(true);
    this.stopEnemies();
    this.movement.stop(this.controlledVisual);
    this.scene.handleCombatDefeat();
  }

  /** 压测开始前加载刷怪用的敌人资源；缺图时直接失败，不启动刷怪。 */
  async preparePressureEnemy(enemyId = PRESSURE_ENEMY_ID, signal?: AbortSignal): Promise<boolean> {
    if (this.closed) return false;
    const definition = this.app.battleCatalog.enemies.find(enemy => enemy.id === enemyId);
    if (!definition) return false;
    const lease = await loadSceneAssets(this.scene.phaserScene, this.enemyAssets(definition), { lifetime: 'manual', signal });
    if (this.closed || signal?.aborted) {
      lease.release();
      return false;
    }
    this.pressureAssets?.release();
    this.pressureAssets = lease;
    // 音效不参与等待；缺声音不影响刷怪。
    void this.app.audio?.prepareCombat([], [], { enemyIds: [enemyId] }).catch(() => {});
    return true;
  }

  /**
   * 压测刷怪：在玩家周围找一个整个碰撞盒都站得下的随机点，按正式实例路径生成敌人。
   * 找不到合法点时返回 false，让下一次刷怪再试，不把敌人塞进墙里或人堆里。
   */
  private pressureMaxEnemies(): number {
    return normalizePressureMaxEnemies(this.app.pressureSettings?.maxEnemies ?? PRESSURE_DEFAULT_MAX_ENEMIES);
  }

  private pressureEnemyMaxHealth(): number | undefined {
    return normalizePressureEnemyHealth(this.app.pressureSettings?.enemyMaxHealth);
  }

  canSpawnPressureEnemy(): boolean {
    return !this.closed && !this.defeated && !!this.movement && this.pressureEnemyCount() < this.pressureMaxEnemies();
  }

  spawnPressureEnemy(enemyId = PRESSURE_ENEMY_ID, initialPoint?: { x: number; y: number }): boolean {
    if (this.closed || this.defeated || !this.movement) return false;
    if (this.pressureEnemyCount() >= this.pressureMaxEnemies()) return false;
    const definition = this.app.battleCatalog.enemies.find(enemy => enemy.id === enemyId);
    const collision = definition?.actor.collision;
    if (!definition || !collision) return false;
    const center = this.movement.position(this.controlledVisual);
    const overrideHealth = this.pressureEnemyMaxHealth();
    for (let attempt = 0; attempt < PRESSURE_SPAWN_ATTEMPTS; attempt++) {
      const angle = Math.random() * Math.PI * 2;
      const distance = PRESSURE_SPAWN_MIN_DISTANCE + Math.random() * (PRESSURE_SPAWN_MAX_DISTANCE - PRESSURE_SPAWN_MIN_DISTANCE);
      const point =
        attempt === 0 && initialPoint ? initialPoint : { x: center.x + Math.cos(angle) * distance, y: center.y + Math.sin(angle) * distance };
      if (!this.movement.navigation.canPlaceBody({ collision }, point)) continue;
      const placed = this.roster.placeEnemy(enemyId, point.x, point.y);
      if (overrideHealth !== undefined) this.roster.setEnemyMaxHealthOverride(placed.key, overrideHealth, definition);
      const enemy = this.buildEnemy(placed, definition);
      this.arena.push(enemy);
      refreshCombatActors(this.arena);
      return true;
    }
    return false;
  }

  /** 场上当前活着的挑战普通怪数量（不含召唤物和待死亡结算怪）。 */
  pressureEnemyCount(): number {
    return this.arena.filter(enemy => !enemy.summonedBy && !this.pendingDefeats.has(enemy.key)).length;
  }

  /** 挑战调试修改数量上限或血量后立即同步到当前战场：超量裁减，改血量时覆写所有活着的普通怪。 */
  applyPressureSettings(options: { applyHealth?: boolean } = {}): void {
    if (this.closed) return;
    const limit = this.pressureMaxEnemies();
    const live = this.arena.filter(enemy => !enemy.summonedBy && !this.pendingDefeats.has(enemy.key));
    if (live.length > limit) {
      for (const enemy of live.slice(limit)) this.removeEnemy(enemy.key);
    }
    if (options.applyHealth) {
      const overrideHealth = this.pressureEnemyMaxHealth();
      for (const enemy of this.arena) {
        if (enemy.summonedBy || this.pendingDefeats.has(enemy.key)) continue;
        this.roster.setEnemyMaxHealthOverride(enemy.key, overrideHealth, enemy.definition);
        this.stats.resourceCapacityInputs(enemy.key);
      }
      this.scene.refreshCombatTarget();
    }
  }

  /** 压测阵亡不结束：把倒下的上阵成员补满生命和法力，继续留在场上。 */
  reviveFallenForPressure(): void {
    const ids = this.app.session.party?.activeIds ?? ['player'];
    for (const id of ids) {
      if ((this.memberOf(id)?.player.health ?? 0) > 0) continue;
      this.scene.reviveMember(id);
    }
  }

  reviveMember(id: string, origin = this.movement.position(this.controlledVisual)): void {
    const visual = this.visualOf(id);
    const member = this.memberOf(id);
    if (!member?.player.health) return;
    this.app.session.reviveCombatActor(id);
    this.runtime.cancel(`party-defeat:${id}`);
    this.partyDefeatWork.delete(id);
    if (!visual) return;
    this.deathTweens.get(id)?.stop();
    this.deathTweens.delete(id);
    this.fallen.delete(id);
    this.settlement.forgetDealtDamage(id);
    this.conditions.remove(id);
    member.clearCombatResourceLimits();
    this.partyControllers.get(id)?.reset();
    if (id === 'player') this.heroAi?.reset();
    else combatActor(this.allies, id, actor => actor.id)?.ai.reset();
    const actor = this.movement.actor(visual);
    // 一次复活两名队员时不能让两人落在同一个 origin 上：避开复活点、主角和其余队员。
    const avoid = [origin, ...this.allies.filter(other => other.id !== id).map(other => this.movement.position(other.visual))];
    if (this.scene.player) avoid.push(this.movement.position(this.player));
    const landing =
      choosePartyLanding(this.movement.navigation, actor.shape(), origin, actor, avoid) ??
      this.movement.navigation.nearestBody(actor.shape(), origin, actor) ??
      this.movement.navigation.nearest(actor.shape(), origin, actor);
    this.relocateVisual(visual, landing);
    this.movement.setEnabled(visual, true);
    visual.container.setAlpha(1).setVisible(true);
    setCharacterClip(this.scene.phaserScene, visual, 'idle-south', true);
    this.outcomes.recover(visual);
  }

  revive(id: string, item: string): ItemResult {
    if (this.closed) throw new Error('当前无法复活');
    const party = this.app.session.party;
    if (!party) throw new Error('队伍不可用');
    const dead = party.activeIds.filter(member => !party.alive(member));
    const origin = this.wipeoutPosition ?? this.movement.position(this.controlledVisual);
    const result = party.revive(id, item);
    for (const member of dead) if (party.alive(member)) this.reviveMember(member, origin);
    this.wipeoutPosition = undefined;
    this.defeated = false;
    this.wipeoutPending = false;
    this.focusTargetId = undefined;
    if (!party.alive(party.controlledId)) party.switchControl(party.livingIds[0]);
    this.syncControlled();
    this.app.audio?.ui('heal');
    return result;
  }

  /** GM 复活：跳过复活道具与「全队阵亡」限制，其余表现收尾与正常复活一致。 */
  reviveForDebug(id: string): void {
    const party = this.app.session.party;
    if (!party) return;
    const origin = this.wipeoutPosition ?? this.movement.position(this.controlledVisual);
    this.reviveMember(id, origin);
    this.wipeoutPosition = undefined;
    this.defeated = false;
    this.wipeoutPending = false;
    this.focusTargetId = undefined;
    if (!party.alive(party.controlledId)) party.switchControl(party.livingIds[0]);
    this.syncControlled();
    this.app.audio?.ui('heal');
  }

  reviveAtHealer(): void {
    const origin = this.movement.position(this.controlledVisual);
    const result = reviveAtHealer(this.app.session);
    for (const id of result.memberIds) this.reviveMember(id, origin);
    this.syncControlled();
    this.app.audio?.ui('heal');
  }

  update(delta: number, enabled: boolean): void {
    if (this.closed || !this.player?.container.active) return;
    // 恢复期间不推进战斗时钟和截止帧；失败时旧现场保持原样，成功时再统一替换。
    if (this.restoring) return;
    this.pathBudget.reset();
    this.flowFields.reset();
    this.outcomes.setPaused(!enabled || this.defeated);
    const deathPaused = !enabled || this.defeated;
    if (deathPaused !== this.deathVisualsPaused) {
      this.deathVisualsPaused = deathPaused;
      for (const [id, tween] of this.deathTweens) {
        if (deathPaused) tween.pause();
        else tween.resume();
        for (const sprite of this.visualOf(id)?.layers ?? []) {
          if (deathPaused) sprite.anims.pause();
          else sprite.anims.resume();
        }
      }
    }
    this.feedback.setPaused(!enabled || this.defeated);
    this.syncStateMarkers(enabled && !this.defeated);
    this.setPaused(!enabled || this.defeated);
    this.syncFocusRings(enabled && !this.defeated, delta);
    if (!enabled || this.defeated) {
      this.syncBuffLoops();
      // 队伍已全灭但死亡演出被暂停或重建清掉时，结算不能一直等下去。
      if (!this.defeated && (this.wipeoutPending || this.isPartyWiped())) this.playerDefeated();
      if (!this.defeated) for (const id of this.activeParty) this.stats.syncCombatResourceLimits(id);
      return;
    }
    this.partyActionsSuspended = false;
    this.diagnosticElapsedMs += delta;
    if (this.diagnosticElapsedMs >= 5000) {
      this.diagnosticElapsedMs = 0;
      this.reportCombatTick();
    }
    this.app.session.advanceGameTime(delta);
    if (this.shouldSyncParty(this.scene.time.now)) {
      void this.syncAllies().catch(error => this.app.ui.toast((error as Error).message));
    }
    if (this.controlledId !== this.syncedControlledId && this.partyControllers.has(this.controlledId)) this.syncControlled(false);
    // 一个渲染帧里的全部战斗逻辑帧共用一次会话通知：每次命中、回复、扣蓝都会改血蓝，
    // 逐次通知会让快捷栏、状态栏、剧情观察和自动存档在同一帧里重复跑很多遍。帧末统一发一次。
    this.app.session.batchNotifications(() =>
      this.app.session.advanceCombatFrames(delta, frame => {
        this.combatantsCache = undefined;
        // 名册按逻辑帧刷新；最多晚一帧（约 60ms）出现，不再每渲染帧全量扫描生成点。
        this.consumeRosterChanges(this.roster.refresh(this.scene.cameras?.main?.worldView));
        this.conditions.update(LOGIC_FRAME_MS, tick => this.settlement.periodicTick(tick));
        if (this.focusTargetId && !this.conditions.canTarget(this.focusTargetId)) {
          this.focusTargetId = undefined;
          this.scene.refreshCombatTarget();
        }
        for (const id of this.activeParty) {
          if (this.memberOf(id)?.player.health) {
            if (this.fallen.has(id)) this.reviveMember(id);
          } else {
            this.memberDefeated(id);
          }
        }
        // 压测低频补满倒下的成员，不进入阵亡流程。
        if (this.app.pressureMode && this.app.session.combatTick % PRESSURE_REVIVE_FRAME_INTERVAL === 0) {
          this.reviveFallenForPressure();
        }
        for (const id of this.activeParty) this.stats.syncCombatResourceLimits(id);
        this.combat?.update();
        for (const id of this.activeParty) {
          if (id === this.controlledId || !this.memberOf(id)?.player.health) continue;
          this.partySkills.set(id, this.stats.syncAiSkills(id));
          if (id === 'player') this.heroAi?.step();
          else combatActor(this.allies, id, actor => actor.id)?.ai.step();
        }
        for (const enemy of [...this.arena]) {
          if (!this.pendingDefeats.has(enemy.key) && enemy.summonRemainingMs !== undefined) {
            enemy.summonRemainingMs = advanceSummonLifetime(enemy.summonRemainingMs);
            if (summonLifetimeExpired(enemy.summonRemainingMs)) this.removeEnemy(enemy.key);
          }
        }
        this.updateEnemies(frame);
        this.runtime.step(this.app.session.combatTick);
        if (this.defeated || this.closed || !this.scene.canCombatControl) {
          this.combatantsCache = undefined;
          return false;
        }
        this.settlement.recoverResources();
        this.combatantsCache = undefined;
      }),
    );
    // 快捷栏和冷却由 WorldScene 在每个逻辑帧变化后统一绘制；这里不再重复取快照。
    this.syncBuffLoops();
  }

  private syncFocusRings(shown: boolean, delta: number): void {
    const controlled = this.controlledVisual;
    const alive = (this.memberOf(this.controlledId)?.player.health ?? 0) > 0;
    const player = shown && alive ? this.movement.displayPosition(controlled) : undefined;
    const controller = this.partyControllers.get(this.controlledId);
    // 摇杆移动会清掉受控角色的选中目标，但正在进行的动作和队友的攻击目标可能还在。
    // 红圈优先跟着实际动作目标，其次跟队友正在打的目标，避免佣兵还在打却看不到圈。
    const targetId = controller?.activeAction()?.targetId ?? controller?.selectedTargetId() ?? this.partyTarget() ?? this.focusTargetId;
    const target = targetId && !this.pendingDefeats.has(targetId) ? this.visualOf(targetId) : undefined;
    const targetPoint = shown && target?.container.active ? this.movement.displayPosition(target) : undefined;
    this.statusVisuals.syncFocusRings(player, targetPoint, targetPoint ? targetId : undefined, shown, delta);
  }

  /** 规则状态统一在这里变成只读表现：眩晕用金色星星，睡眠用 Zzz；都不参与结算。 */
  private syncStateMarkers(shown: boolean): void {
    this.statusVisuals.syncStateMarkers(
      shown,
      this.app.session.combatTick,
      this.conditions.activeAppearances(),
      id => this.visualOf(id),
      id => this.pendingDefeats.has(id),
    );
  }

  private syncBuffLoops(): void {
    this.statusVisuals.syncBuffLoops(
      this.conditions.activeAppearances(),
      id => this.visualOf(id),
      id => this.conditions.buffLoopFrames(id),
      id => {
        const member = this.memberOf(id);
        return member ? member.player.health > 0 || this.hitResolution.isAwaitingDefeat(id) : !this.pendingDefeats.has(id);
      },
    );
  }

  afterMovement(): void {
    if (this.hero.player.health > 0 && this.controlledId !== 'player' && this.partyControllers.get('player')?.actionState() !== 'attacking') {
      const moving = isBodyWalking(this.movement.body(this.player));
      setCharacterClip(this.scene.phaserScene, this.player, `${moving ? 'walk' : 'idle'}-${this.scene.facing}`);
    }
    for (const ally of this.allies) {
      if (!ally.member.alive || ally.id === this.controlledId || ally.controller.actionState() === 'attacking') continue;
      const moving = isBodyWalking(ally.body);
      setCharacterClip(this.scene.phaserScene, ally.visual, `${moving ? 'walk' : 'idle'}-${ally.facing}`);
    }
    for (const enemy of this.arena) {
      if (this.pendingDefeats.has(enemy.key)) continue;
      if (enemy.controller?.actionState() === 'attacking') continue;
      const moving = isBodyWalking(enemy.body);
      const clip = `${moving ? 'walk' : 'idle'}-${enemy.facing}` as const;
      setCharacterClip(this.scene.phaserScene, enemy.visual, enemy.definition.actor.clips[clip] ? clip : 'idle-south');
    }
  }

  destroy(): void {
    if (this.closed) return;
    if (this.diagnosticStartedAt) {
      globalThis.storyDiagnostics?.record(
        'combat-end',
        {
          map: this.scene.map?.id,
          durationMs: Math.round(performance.now() - this.diagnosticStartedAt),
          hits: this.diagnosticTotalHits,
          damageDealt: this.diagnosticTotalDamageDealt,
          damageTaken: this.diagnosticTotalDamageTaken,
          enemies: this.arena.length,
          defeated: this.defeated,
        },
        false,
      );
    }
    this.closed = true;
    this.generation++;
    this.combatRuntime?.dispose();
    this.partyDefeatWork.clear();
    for (const notify of [...this.allyWaiters]) notify();
    for (const tween of this.deathTweens.values()) tween.stop();
    this.deathTweens.clear();
    this.fallen.clear();
    this.pendingDefeats.clear();
    this.outcomes.destroy();
    this.feedback.destroy();
    this.heroAi?.dispose();
    this.heroAi = undefined;
    for (const ally of [...this.allies]) {
      ally.ai.dispose();
      ally.overhead.destroy();
      this.movement.remove(ally.visual);
      ally.visual.container.destroy();
      ally.assets?.release();
    }
    this.allies = [];
    this.partyControllers.clear();
    this.partySkills.clear();
    this.lastSkillResets.clear();
    this.stats.clear();
    this.settlement.clear();
    this.combatantsCache = undefined;
    this.combatantsSpatialCache = undefined;
    this.combat = undefined;
    this.presenter?.clear();
    this.presenter = undefined;
    this.combatEffects.clear();
    this.unsubscribeHero?.();
    this.unsubscribeHero = undefined;
    this.unsubscribeSession?.();
    this.unsubscribeSession = undefined;
    this.statusVisuals.destroy();
    this.clearEnemies();
    this.conditions.clear();
    this.summons.clear();
    this.playerAssets?.release();
    this.playerAssets = undefined;
    this.skillAssets.dispose();
    this.restoredAssets?.release();
    this.restoredAssets = undefined;
    this.storyAssets?.release();
    this.storyAssets = undefined;
    this.pressureAssets?.release();
    this.pressureAssets = undefined;
  }
}

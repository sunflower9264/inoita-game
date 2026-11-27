import { CombatClock, type CombatClockState } from './combat-clock.ts';
import { CombatCooldownStore, type CombatCooldownState } from './combat-cooldowns.ts';
import { FrenzyAnimationMemory } from './frenzy-animation.ts';
import { RecoveryItems, type RecoveryItemsState } from './recovery-items.ts';
import { CombatResourceRecovery, type CombatResourceRecoveryState, type ResourceRecoveryActor, type ResourceRecoveryPulse } from './combat-resources.ts';
import { ShopVisits, type ShopVisitsState } from './shop.ts';
import { ChestVisits, type ChestVisitsState } from './chests.ts';
import { SpringVisits, type SpringVisitsState } from './springs.ts';
import { LegendaryWeapons, type LegendaryWeaponsState } from './legendary-weapon.ts';
import { groundLootFor, GroundLootStore, type GroundLootState } from './ground-loot.ts';
import { QuestItemGenerators, type QuestItemGenerationState } from './quest-item-spawns.ts';
import { boundedHealth } from './status-hud.ts';
import { StorySkillProgression } from './story-skills.ts';
import { Bag, type BagState } from './bag.ts';
import type { SkillConfigurationState } from './skill-configuration.ts';
import type { ItemCatalog } from './items.ts';
import type { DropCatalog, DropReward, QuestDropRequirement, ReservedDropState } from './drops.ts';
import type { ActorDefinition, CampaignEnemyPlacement, ChestKind, EnemySpawn, QuestItemSpawn, QuestRewardReceipt, QuestStatus, TravelDestination, VisibilityRules, WorldMap } from './content.ts';
import type { Campaign, CampaignQuest } from './campaign.ts';
import { QuestBook, sideQuestIds, type QuestBookState, type QuestCommand, type QuestProgress, type QuestFact, type QuestSettlement } from './quest-book.ts';
import { evaluateStoryCondition, type StoryCondition, type StoryConditionContext, type StoryWorldValue } from './story-condition.ts';
import { StoryWorldState, type StoryWorldSnapshot } from './story-world.ts';
import type { StoryCommand } from './story-graph.ts';
import { StoryRuntime, type StoryRuntimeSnapshot } from './story-runtime.ts';
import { toPlaybackCheckpoint } from './playback-checkpoint.ts';
import type { StoryPlayerState } from './story-interface.ts';
import { LOGIC_FRAME_MS, type BattleCatalog } from './battle.ts';
import { BattleCharacter, type BattleCharacterState, type CharacterStatsCatalog } from './character-stats.ts';
import { PartyRoster, type CompanionCatalog } from './party.ts';
import { LootPity, type LootPityState } from './loot-pity.ts';
import {
  DEFAULT_ENEMY_RESPAWN_MS,
  OFFSCREEN_ENEMY_RESPAWN_MS,
  SessionEnemyStore,
  type EnemyState,
} from './session-enemies.ts';
import { SessionQuestCoordinator } from './session-quests.ts';
import {
  validateSessionInventoryState,
  validateSessionRestoreScalars,
  validateSessionSkillState,
  validateSessionStoryLinks,
} from './session-state-validation.ts';
import {
  applyActorStoryCommand,
  leaveStoryCompanionWithBaseline,
  storyCommandSubsystems,
  type AtomicFrame,
  type AtomicSubsystem,
  type StoryCommandBaseline,
  type StoryCommitReceipt,
  type StorySubsystem,
} from './session-story-commands.ts';
import {
  openSessionChest,
  placeSessionGroundRewards,
  reviseOutOfBoundsLocation,
  settleSessionEnemyDefeat,
  type EnemyDefeatInput,
  type EnemyDefeatResult,
  type MapBoundary,
} from './session-settlement.ts';

export { DEFAULT_ENEMY_RESPAWN_MS, OFFSCREEN_ENEMY_RESPAWN_MS };
export type { EnemyDefeatInput, EnemyDefeatResult, MapBoundary, StoryCommitReceipt };

type SessionListener = (session: Session) => void;
type SnapshotSlot = 'questBook' | 'storyWorld' | 'bag' | 'enemies' | 'receipts' | 'chests' | 'groundLoot';

/** 会话拥有的游戏状态；渲染对象与订阅由运行现场持有。 */
export interface SessionState {
  classId?: string;
  questBook: QuestBookState;
  storyWorld: StoryWorldSnapshot;
  runtime: StoryRuntimeSnapshot;
  receipts: QuestSettlement[];
  factSequences: [string, number][];
  trackedQuest?: string;
  player?: StoryPlayerState;
  money: number;
  gameTimeMs: number;
  enemies: [string, EnemyState][];
  bag: BagState;
  hero?: BattleCharacterState;
  skills: SkillConfigurationState;
  party?: ReturnType<PartyRoster['captureState']>;
  recovery: RecoveryItemsState;
  resourceRecovery: CombatResourceRecoveryState;
  combatClock?: CombatClockState;
  cooldowns?: CombatCooldownState;
  frenzyAnimations?: [string, number][];
  chests: ChestVisitsState;
  springs: SpringVisitsState;
  legendaryWeapons?: LegendaryWeaponsState;
  shops: ShopVisitsState;
  groundLoot: GroundLootState;
  questItemGeneration: QuestItemGenerationState;
  /** 温和保底的连续未命中计数与 Boss 首杀记录。 */
  lootPity?: LootPityState;
  /** 付费道具独立掉落的解锁保底与一次性领取记录。 */
  reservedDrops?: ReservedDropState;
  /** 队伍物品掉率乘数（千分比）；当前内容没有已验证来源，默认 0。 */
  partyItemChance?: number;
}

/** 本次运行的故事状态。这个模块不依赖 Phaser，也不认识源格式。 */
export class Session {
  readonly chests = new ChestVisits();
  readonly springs = new SpringVisits();
  readonly legendaryWeapons = new LegendaryWeapons();
  readonly shops = new ShopVisits();
  readonly questItemGenerators = new QuestItemGenerators();
  /** 掉落保底：按成员记录连续未出装备/稀有，命中后清零。 */
  readonly lootPity = new LootPity();
  /** 付费道具的解锁保底计数与已经获得的一次性道具。 */
  reservedDropMisses = 0;
  readonly claimedReservedDrops = new Set<string>();
  partyItemChance = 0;

  readonly recovery = new RecoveryItems();
  private readonly resourceRecovery = new CombatResourceRecovery();
  private readonly combatClock = new CombatClock();
  readonly cooldowns = new CombatCooldownStore(() => this.combatClock.currentFrame);
  /** GM 调试开关：免疫战斗伤害、无限法力、一击必杀与升级技能点覆写。均不写存档，不随剧情回退。 */
  private readonly invincible = new Set<string>();
  private readonly infiniteMana = new Set<string>();
  private readonly oneHitKill = new Set<string>();
  private levelUpSkillPointsOverride?: number;

  readonly frenzyAnimations = new FrenzyAnimationMemory();
  readonly skills: StorySkillProgression;
  readonly campaign: Campaign;
  readonly questBook: QuestBook;
  readonly storyWorld = new StoryWorldState();
  readonly bag: Bag;
  readonly hero?: BattleCharacter;
  readonly party?: PartyRoster;
  readonly character?: Readonly<{ classId: string; appearance: ActorDefinition }>;

  private readonly enemyStore = new SessionEnemyStore();
  private readonly questCoordinator: SessionQuestCoordinator;
  private runtimeSnapshot: StoryRuntimeSnapshot = { version: 2, sequence: 0, runs: [], completedEvents: [], handledOccurrences: [], encounterResults: [], pendingOccurrences: [], occurrenceSequences: [] };
  private runtimeValidator?: StoryRuntime;
  /** 每个选择标识被写入的次数，值相同也加一。剧情选择事件靠它判断“玩家又选了一次”。 */
  private readonly choiceWrites = new Map<string, number>();
  private choiceWriteRevisionValue = 0;
  private worldContext: () => Record<string, StoryWorldValue> = () => ({});
  private storyConditionContext?: StoryConditionContext;
  private completedEventsProjection?: { events: readonly string[]; set: ReadonlySet<string> };
  private readonly battle?: BattleCatalog;
  private readonly stats?: CharacterStatsCatalog;
  private readonly companions?: CompanionCatalog;
  private readonly listeners: Set<SessionListener>;
  private readonly defeatListeners = new Set<(enemy: string) => void>();
  private deferredDefeats?: string[];
  private gameTimeMs = 0;
  private restoreRevision = 0;
  private snapshotCache: Partial<Record<SnapshotSlot, { version: number; value: unknown }>> = {};
  private notificationBatchDepth = 0;
  private pendingNotification = false;
  /** 正在执行的 `atomic`；只有最外层持有自己的帧，嵌套调用把触碰面并进来。 */
  private readonly atomicFrames: AtomicFrame[] = [];
  /** 演出期间的按子系统懒回滚日志：第一次碰到某个子系统时才抓旧值。 */
  private performanceLogging = false;
  /** 正在执行导演自己的延迟提交：这些改动由命令回执负责，不进演出日志。 */
  private storyCommandDepth = 0;
  private performanceTouched = new Set<StorySubsystem>();
  private performanceBaseline: StoryCommandBaseline = {};
  private coins = 0;
  private playerState?: Readonly<StoryPlayerState>;

  /** 战斗目录只读访问：GM 拉满佣兵技能需要职业技能表与伙伴成长表的最高等级。 */
  get battleCatalog(): BattleCatalog | undefined { return this.battle; }
  get choiceWriteRevision(): number { return this.choiceWriteRevisionValue; }
  get receiptRevision(): number { return this.questCoordinator.receiptRevision; }
  get enemyRevision(): number { return this.enemyStore.revision; }
  get enemySpawnRevision(): number { return this.enemyStore.spawnRevision; }
  get restorationVersion(): number { return this.restoreRevision; }
  get visitorReleaseRevision(): number { return this.questCoordinator.visitorReleaseRevision; }
  get money(): number { return this.coins; }
  get player(): Readonly<StoryPlayerState> | undefined { return this.hero?.player ?? this.playerState; }
  /** 上阵队伍是否至少还有一人活着；没有队伍时看主角。存档和检查点用它挡住全灭状态。 */
  get hasLivingMember(): boolean { return this.party ? this.party.livingIds.length > 0 : (this.player?.health ?? 0) > 0; }
  get flags(): ReadonlySet<string> { return this.storyWorld.flagIds; }
  /** 任务列表的只读投影；同一任务簿版本内返回同一份，调用方不得改写。 */
  get quests(): ReadonlyMap<string, Readonly<QuestProgress & { count: number }>> { return this.questCoordinator.quests(this.questBook); }
  get nowMs(): number { return this.gameTimeMs; }
  get resourceRecoveryDelayMs(): number { return this.resourceRecovery.millisecondsUntilNextPulse - this.combatClock.fractionalMs; }
  /** 当前战斗帧是否会触发资源恢复脉冲。 */
  get recoveryPulseDue(): boolean { return this.resourceRecovery.pulseDueAtFrame(this.combatTick); }
  get combatTick(): number { return this.combatClock.currentFrame; }
  get levelUpSkillPoints(): number { return this.levelUpSkillPointsOverride ?? this.stats?.skillPointsPerLevel ?? 1; }
  /** 运行时快照不可变，按引用返回；需要修改时由调用方先复制。 */
  get runtimeState(): StoryRuntimeSnapshot { return this.runtimeSnapshot; }
  /** 当前是否有剧情 run 在等待战斗结果；检查点据此避开战斗开局。 */
  get hasWaitingStoryRun(): boolean { return this.runtimeSnapshot.runs.some(run => run.status === 'waiting'); }
  set runtimeState(value: StoryRuntimeSnapshot) {
    const next = this.prepareRuntime(value);
    validateSessionStoryLinks(this.campaign, this.storyWorld.captureState(), next);
    this.runtimeSnapshot = next;
  }

  constructor(
    campaign: Campaign,
    player?: StoryPlayerState,
    character?: { classId: string; appearance: ActorDefinition },
    items?: ItemCatalog,
    hero?: BattleCharacter,
    battle?: BattleCatalog,
    stats?: CharacterStatsCatalog,
    companions?: CompanionCatalog,
  ) {
    this.campaign = campaign;
    this.questCoordinator = new SessionQuestCoordinator(campaign);
    this.playerState = player ? Object.freeze({ ...player }) : undefined;
    this.character = character ? Object.freeze({ ...character }) : undefined;
    this.listeners = new Set();
    this.battle = battle;
    this.stats = stats;
    this.companions = companions;
    this.hero = hero;
    this.skills = new StorySkillProgression(hero, battle);
    hero?.setSkillUseHandler((item, skill, memberId) => {
      const definition = items?.items[item];
      if (!memberId || memberId === 'player') return this.skills.applyItem(item, skill);
      const member = this.party?.get(memberId);
      if (!member || member.source !== 'mercenary' || definition?.use?.kind !== 'learn' || !skill || !battle) throw new Error('无法为该成员使用技能书');
      const rank = member.skills.book(skill, battle);
      return `${battle.skills[skill].name}提升至 ${rank} 级`;
    });
    hero?.setBonusSkillPointsPerLevel(() => this.levelUpBonusSkillPoints());
    this.party = hero && items && stats && companions
      ? new PartyRoster(
        hero, stats, items, companions,
        () => { this.recordPerformance(['party', 'bag']); this.emit(); },
        id => { this.cooldowns.removeActor(id); this.frenzyAnimations.removeActor(id); this.lootPity.removeMember(id); },
        sourceItem => this.recordQuestFact('recruit', sourceItem, 'recruit'),
        operation => this.atomic(operation, ['bag', 'party', 'questBook']),
        battle,
        () => this.levelUpBonusSkillPoints(),
      )
      : undefined;
    this.bag = hero?.bag ?? new Bag(() => { this.recordPerformance(['bag']); this.emit(); }, items, character?.classId, items ? 'game' : 'none');
    if (this.party && battle) {
      this.bag.setSkillUnlockRules({
        has: skill => this.party!.hasSharedSkill(skill),
        unlock: skill => { this.party!.unlockSharedSkill(skill); return `${battle.skills[skill].name}已永久解锁`; },
        atomic: operation => this.atomic(operation, ['party', 'bag']),
      });
    }
    this.questBook = new QuestBook(this.campaign.quests, () => this.questContext(), sideQuestIds(this.campaign.questGroups));
    hero?.subscribe(() => { this.recordPerformance(['hero', 'bag']); this.emit(); });
    this.refresh();
  }

  enterMap(map: string, questItemSpawns?: readonly QuestItemSpawn[], boundary?: MapBoundary, mapSpawns?: readonly EnemySpawn[]): void {
    const entering = this.chests.mapId !== map;
    this.enemyStore.transitionMap(map, this.chests.mapId, this.chests.spawns, this.storyWorld.visit, mapSpawns);
    this.chests.enterMap(map);
    this.springs.enterMap(map);
    this.shops.enterMap(map);
    if (entering) groundLootFor(this).clearOtherMaps(map);
    if (entering) {
      for (const { condition, ...entity } of this.campaign.mapEntryPlacements ?? []) {
        if (entity.map === map && this.evaluateCondition(condition)) {
          this.storyWorld.apply({ kind: 'place', scope: 'visit', entity: { ...entity, visible: true } });
        }
      }
    }
    if (questItemSpawns) this.questItemGenerators.enter(map, this.storyWorld.visit, questItemSpawns, groundLootFor(this));
    if (boundary) reviseOutOfBoundsLocation(this.storyWorld, map, boundary);
  }

  setInvincible(actorId: string, enabled: boolean): void {
    if (enabled) this.invincible.add(actorId);
    else this.invincible.delete(actorId);
  }
  isInvincible(actorId: string): boolean { return this.invincible.has(actorId); }

  setInfiniteMana(actorId: string, enabled: boolean): void {
    if (enabled) this.infiniteMana.add(actorId);
    else this.infiniteMana.delete(actorId);
  }
  isInfiniteMana(actorId: string): boolean { return this.infiniteMana.has(actorId); }

  setOneHitKill(actorId: string, enabled: boolean): void {
    if (enabled) this.oneHitKill.add(actorId);
    else this.oneHitKill.delete(actorId);
  }
  isOneHitKill(actorId: string): boolean { return this.oneHitKill.has(actorId); }

  setLevelUpSkillPoints(points: number | undefined): void { this.levelUpSkillPointsOverride = points; }
  private levelUpBonusSkillPoints(): number {
    const base = this.stats?.skillPointsPerLevel ?? 1;
    return this.levelUpSkillPointsOverride === undefined ? 0 : Math.max(0, this.levelUpSkillPointsOverride - base);
  }

  /** 演出开始：打开懒日志，不抓任何状态。 */
  beginPerformanceLog(): void { this.performanceLogging = true; this.performanceTouched.clear(); this.performanceBaseline = {}; }
  /** 演出正常提交：丢掉旧值。 */
  commitPerformanceLog(): void { this.performanceLogging = false; this.performanceTouched.clear(); this.performanceBaseline = {}; }
  /** 取消演出：只恢复演出期间第一次碰到的子系统。 */
  rollbackPerformanceLog(): void {
    if (!this.performanceLogging) return;
    const touched = this.performanceTouched, baseline = this.performanceBaseline;
    this.performanceLogging = false;
    this.performanceTouched = new Set();
    this.performanceBaseline = {};
    if (!touched.size) return;
    this.restoreStoryCommandBaseline(touched, baseline);
    this.emit();
  }
  private recordPerformance(subsystems: Iterable<StorySubsystem>): void {
    if (!this.performanceLogging || this.storyCommandDepth > 0) return;
    const fresh = new Set<StorySubsystem>();
    for (const subsystem of subsystems) if (!this.performanceTouched.has(subsystem)) { this.performanceTouched.add(subsystem); fresh.add(subsystem); }
    if (fresh.size) Object.assign(this.performanceBaseline, this.captureStoryCommandBaseline(fresh));
  }

  gainMoney(amount: number): void {
    if (!Number.isSafeInteger(amount) || amount < 0 || !Number.isSafeInteger(this.coins + amount)) throw new Error('金币数量无效');
    this.recordPerformance(['coins']);
    this.coins += amount;
    this.emit();
  }
  spendMoney(amount: number): void {
    if (!Number.isSafeInteger(amount) || amount < 0 || amount > this.coins) throw new Error('金币不足');
    this.recordPerformance(['coins']);
    this.coins -= amount;
    this.emit();
  }

  setHealth(value: number): void {
    this.recordPerformance(['hero', 'party', 'playerState']);
    if (this.hero) { this.hero.setHealth(value); return; }
    if (!this.playerState) return;
    this.playerState = Object.freeze({ ...this.playerState, health: boundedHealth(value, this.playerState.maxHealth) });
    this.emit();
  }

  itemCount(id: string): number { return this.bag.count(id); }

  questDropRequirements(pending: ReadonlyMap<string, number> = groundLootFor(this).pendingItemCounts()): readonly (readonly QuestDropRequirement[])[] {
    this.refresh();
    return this.questCoordinator.questDropRequirements(this.questBook, id => this.itemCount(id), pending);
  }
  questItemRemaining(quest: string, item: string): number {
    this.refresh();
    const pending = groundLootFor(this).pendingItemCounts().get(item) ?? 0;
    return this.questCoordinator.questItemRemaining(this.questBook, quest, item, id => this.itemCount(id), pending);
  }
  questItemPickupRemaining(item: string): number | undefined {
    this.refresh();
    return this.questCoordinator.questItemPickupRemaining(this.questBook, item, this.itemCount(item));
  }

  /** 每个选择标识被选中过多少次；导演用次数变化派发选择剧情，值相同也算一次。 */
  choiceWriteCounts(): ReadonlyMap<string, number> { return this.choiceWrites; }

  private questContext() {
    return {
      ...this.conditionContext(),
      classId: this.hero?.classId ?? this.character?.classId,
      itemCount: (id: string) => this.itemCount(id),
      equippedItemCount: (item: string) => Object.values(this.bag.equipmentItems(this.bag.equipmentFor(this.party?.controlledId ?? 'player'))).filter(id => id === item).length,
    };
  }

  conditionContext(): StoryConditionContext {
    return this.storyConditionContext ??= {
      questStatus: id => this.status(id),
      questCompletedCycles: id => this.questBook?.completedCycles(id) ?? 0,
      eventStatus: id => {
        const runs = this.runtimeSnapshot.runs;
        for (let index = runs.length - 1; index >= 0; index--) {
          const run = runs[index]!;
          if (run.eventId !== id) continue;
          if (run.status === 'running') return 'running';
          if (run.status === 'waiting') return 'waiting';
        }
        return this.completedEventSet().has(id) ? 'completed' : 'idle';
      },
      choice: id => this.storyWorld.choice(id),
      flag: id => this.storyWorld.hasFlag(id),
      world: key => this.worldValue(this.storyWorld, key),
    };
  }

  private completedEventSet(): ReadonlySet<string> {
    const events = this.runtimeSnapshot.completedEvents, cached = this.completedEventsProjection;
    if (cached?.events === events) return cached.set;
    const set = new Set(events);
    this.completedEventsProjection = { events, set };
    return set;
  }

  private worldValue(world: StoryWorldState, key: string): StoryWorldValue | undefined {
    return key === 'map' ? world.currentLocation?.map ?? this.worldContext()[key] : this.worldContext()[key];
  }

  setStoryWorldContext(context: () => Record<string, StoryWorldValue>): void {
    this.worldContext = context;
    this.questCoordinator.invalidateQuestProjection();
    this.refresh();
  }

  private createRuntimeValidator(): StoryRuntime {
    return new StoryRuntime(this.campaign, {
      prepare: async () => {}, capture: () => undefined, present: async () => ({}), finish: async () => {},
      apply: () => {}, commit: () => {}, rollback: () => {}, evaluate: condition => this.evaluateCondition(condition),
    });
  }
  private prepareRuntime(snapshot: StoryRuntimeSnapshot): StoryRuntimeSnapshot {
    const runtime = this.runtimeValidator ??= this.createRuntimeValidator();
    return runtime.prepareRestore(snapshot);
  }
  evaluateCondition(condition: StoryCondition): boolean { return evaluateStoryCondition(condition, this.conditionContext()); }
  /** 预演在独立会话中执行，安装之前不会通知正式导演。 */
  createStorySandbox(): Session {
    const hero = this.hero && this.stats ? new BattleCharacter(this.hero.classId, this.stats, this.bag.catalog) : undefined;
    return new Session(this.campaign, this.playerState, this.character, this.bag.catalog, hero, this.battle, this.stats, this.companions);
  }

  captureState(): SessionState { return this.captureStateWith(this.questBook.captureState()); }
  /** 存档用：舞台演员外观不是持久数据，写档前剥离。 */
  capturePersistentState(): SessionState {
    const state = this.captureStateWith(undefined, true);
    state.runtime = toPlaybackCheckpoint(state.runtime);
    return state;
  }

  /** 拾取一次性解锁道具：记录后把解锁保底清零。 */
  claimReservedDrop(item: string): void { this.claimedReservedDrops.add(item); this.reservedDropMisses = 0; }
  /** 读取时补齐已经拥有的解锁道具领取记录，不改动物品，也不清掉当前保底。 */
  seedReservedClaims(items: Iterable<string>): void { for (const item of items) this.claimedReservedDrops.add(item); }
  private noteReservedGrant(item: string): void {
    const definition = this.bag.catalog.items[item];
    if (definition?.use?.kind === 'recipe' || definition?.use?.kind === 'box' || item.startsWith('sealed-skillbook')) {
      this.seedReservedClaims([item]);
    }
  }
  private restoreReservedDrops(state?: ReservedDropState): void {
    const value = state ?? { unlockMisses: 0, claimed: [] };
    if (!Number.isSafeInteger(value.unlockMisses) || value.unlockMisses < 0 || !Array.isArray(value.claimed) || value.claimed.some(item => typeof item !== 'string')) {
      throw new Error('保留掉落状态无效');
    }
    this.reservedDropMisses = value.unlockMisses;
    this.claimedReservedDrops.clear();
    for (const item of value.claimed) this.claimedReservedDrops.add(item);
  }

  private cachedSnapshot<T>(slot: SnapshotSlot, version: number, capture: () => T): T {
    const cached = this.snapshotCache[slot];
    if (cached?.version === version) return cached.value as T;
    const value = capture();
    this.snapshotCache[slot] = { version, value };
    return value;
  }

  private captureStateWith(questBook: QuestBookState | undefined, reuse = false): SessionState {
    const captureEnemies = (): SessionState['enemies'] => this.enemyStore.captureEntries();
    const captureReceipts = (): SessionState['receipts'] => this.questCoordinator.captureReceipts();
    const questBookState = reuse
      ? this.cachedSnapshot('questBook', this.questBook.stateVersion, () => this.questBook.captureState())
      : (questBook ?? this.questBook.captureState());
    const storyWorld = reuse ? this.cachedSnapshot('storyWorld', this.storyWorld.revision, () => this.storyWorld.captureState()) : this.storyWorld.captureState();
    const bag = reuse ? this.cachedSnapshot('bag', this.bag.revision, () => this.bag.captureState()) : this.bag.captureState();
    const enemies = reuse ? this.cachedSnapshot('enemies', this.enemyRevision, captureEnemies) : captureEnemies();
    const receipts = reuse ? this.cachedSnapshot('receipts', this.receiptRevision, captureReceipts) : captureReceipts();
    const chests = reuse ? this.cachedSnapshot('chests', this.chests.revision, () => this.chests.captureState()) : this.chests.captureState();
    const ground = groundLootFor(this);
    const groundLoot = reuse ? this.cachedSnapshot('groundLoot', ground.revision, () => ground.captureState()) : ground.captureState();
    return {
      classId: this.hero?.classId ?? this.character?.classId,
      questBook: questBookState,
      storyWorld,
      runtime: this.runtimeSnapshot,
      receipts,
      factSequences: questBookState.factSequences.map(([source, value]) => [source, value]),
      trackedQuest: this.questCoordinator.trackedQuestId,
      player: this.playerState,
      money: this.coins,
      gameTimeMs: this.gameTimeMs,
      enemies,
      bag,
      hero: this.hero?.captureState(),
      skills: this.skills.captureState(),
      party: this.party?.captureState(),
      recovery: this.recovery.captureState(),
      resourceRecovery: this.resourceRecovery.captureState(),
      combatClock: this.combatClock.captureState(),
      cooldowns: this.cooldowns.captureState(),
      frenzyAnimations: this.frenzyAnimations.captureState(),
      chests,
      springs: this.springs.captureState(),
      legendaryWeapons: this.legendaryWeapons.captureState(),
      shops: this.shops.captureState(),
      questItemGeneration: this.questItemGenerators.captureState(),
      groundLoot,
      lootPity: this.lootPity.captureState(),
      reservedDrops: { unlockMisses: this.reservedDropMisses, claimed: [...this.claimedReservedDrops].sort() },
      partyItemChance: this.partyItemChance,
    };
  }

  private restoreUnchecked(restored: SessionState): void {
    this.snapshotCache = {};
    this.questCoordinator.invalidateProjections();
    this.bag.restoreUnchecked(restored.bag);
    if (restored.hero) this.hero!.restoreState(restored.hero);
    this.skills.restoreState(restored.skills);
    if (restored.party) this.party!.restoreState(restored.party);
    this.questBook.restoreState(restored.questBook);
    this.storyWorld.restoreState(restored.storyWorld);
    this.choiceWrites.clear();
    this.choiceWriteRevisionValue++;
    this.runtimeSnapshot = restored.runtime;
    this.questCoordinator.restoreReceipts(restored.receipts);
    this.enemyStore.restoreEntries(restored.enemies);
    this.questCoordinator.setTrackedQuestId(restored.trackedQuest);
    this.playerState = restored.player ? Object.freeze({ ...restored.player }) : undefined;
    this.coins = restored.money;
    this.gameTimeMs = restored.gameTimeMs;
    this.recovery.restoreState(restored.recovery);
    this.chests.restoreState(restored.chests);
    this.springs.restoreState(restored.springs);
    this.legendaryWeapons.restoreState(restored.legendaryWeapons);
    this.shops.restoreState(restored.shops);
    const clock = restored.combatClock ?? { frame: Math.floor(restored.resourceRecovery.elapsedMs / LOGIC_FRAME_MS), remainderMs: restored.resourceRecovery.elapsedMs % LOGIC_FRAME_MS };
    this.combatClock.restoreState(clock);
    this.cooldowns.restoreState(restored.cooldowns ?? { actors: [] });
    this.frenzyAnimations.restoreState(restored.frenzyAnimations ?? []);
    this.resourceRecovery.restoreState({ ...restored.resourceRecovery, elapsedMs: clock.frame * LOGIC_FRAME_MS });
    groundLootFor(this).restoreState(restored.groundLoot);
    this.questItemGenerators.restoreState(restored.questItemGeneration, groundLootFor(this));
    this.lootPity.restoreState(restored.lootPity ?? { version: 2, members: [], chests: [], bossDefeats: [] });
    this.restoreReservedDrops(restored.reservedDrops);
    this.partyItemChance = restored.partyItemChance ?? 0;
  }

  restoreState(state: SessionState): void {
    this.performanceLogging = false;
    this.performanceTouched = new Set();
    this.performanceBaseline = {};
    const restored = structuredClone(state);
    if (restored.classId !== (this.hero?.classId ?? this.character?.classId) || !!restored.hero !== !!this.hero || !!restored.party !== !!this.party) {
      throw new Error('检查点与当前游戏角色不一致');
    }
    if (!Array.isArray(restored.factSequences)) throw new Error('检查点任务事实序号无效');
    restored.questBook = this.questBook.prepareRestore(restored.questBook, restored.factSequences).nextState;
    this.storyWorld.prepareRestore(restored.storyWorld);
    this.prepareRuntime(restored.runtime);
    validateSessionInventoryState(restored, this.bag.catalog, this.battle);
    validateSessionSkillState(restored, {
      catalog: this.bag.catalog,
      battle: this.battle,
      stats: this.stats,
      companions: this.companions,
      partyDefinitions: this.party?.catalog.definitions,
    });
    const ground = new GroundLootStore();
    ground.restoreState(restored.groundLoot);
    new QuestItemGenerators().restoreState(restored.questItemGeneration, ground);
    validateSessionStoryLinks(this.campaign, restored.storyWorld, restored.runtime);
    validateSessionRestoreScalars(restored, { definition: id => this.definition(id), catalog: this.bag.catalog });
    const before = this.captureState(), pending = this.pendingNotification;
    this.batchNotifications(() => {
      try {
        this.restoreUnchecked(restored);
        this.refresh();
        this.releaseReadyQuestActors();
        this.restoreRevision++;
        this.emit();
      } catch (error) {
        this.restoreUnchecked(before);
        this.pendingNotification = pending;
        throw error;
      }
    });
  }

  advanceGameTime(deltaMs: number): void { if (deltaMs > 0) { this.gameTimeMs += deltaMs; this.recovery.advance(deltaMs); } }
  /** 没有脉冲的帧只推进恢复时钟，保证“距下一脉冲”的读数与逐帧结算一致。 */
  advanceRecoveryClock(): void { this.resourceRecovery.advanceToFrame(this.combatTick, []); }
  advanceCombatFrames(deltaMs: number, step: (frame: number) => unknown): void {
    this.combatClock.advance(deltaMs, frame => {
      this.questItemGenerators.advance(frame, definition => this.questItemRemaining(definition.quest, definition.item) > 0, groundLootFor(this));
      return step(frame);
    });
  }
  recoverCombatResources(actors: readonly ResourceRecoveryActor[]): ResourceRecoveryPulse[] { return this.resourceRecovery.advanceToFrame(this.combatTick, actors); }
  reviveCombatActor(id: string): void { this.cooldowns.resetActor(id); this.resourceRecovery.resetDeadline(this.combatTick); }

  enemyVitals(id: string): Readonly<EnemyState> { return this.enemyStore.vitals(id); }
  /** 召唤物离场时丢弃它的战斗状态；召唤实例的 key 不会被地图生成点复用。 */
  forgetEnemyVitals(id: string): void { this.enemyStore.forget(id); }
  forgetEnemyVitalsByPrefix(prefix: string): number { return this.enemyStore.forgetByPrefix(prefix); }
  removeStoryEnemy(id: string): void {
    this.storyWorld.apply({ kind: 'remove', id });
    this.enemyStore.markStoryRemoved(id);
    this.emit();
  }
  clearEnemyDefeat(id: string, offscreen = false): boolean { return this.enemyStore.clearDefeat(id, this.gameTimeMs, offscreen); }
  setEnemyVitals(id: string, health: number, mana: number): void { this.enemyStore.setVitals(id, health, mana); }
  canRespawnEnemy(spawn: EnemySpawn | CampaignEnemyPlacement, offscreen = false): boolean { return this.enemyStore.canRespawn(spawn, this.gameTimeMs, offscreen); }

  /** 类型 3 任务把低血量的怪物变成同格可交互角色，交互之后才记目标次数。 */
  weakenQuestTarget(enemyId: string, source: { id: string; map: string; x: number; y: number }): boolean {
    const match = this.questCoordinator.findWeakenTarget(this.questBook, enemyId);
    const state = this.enemyStore.raw(source.id);
    if (!match || state?.capture || state?.deadUntil !== undefined) return false;
    this.batchNotifications(() => {
      this.applyStoryCommands([
        {
          type: 'world',
          command: {
            kind: 'place',
            scope: 'visit',
            entity: {
              id: 'quest-target:' + source.id,
              map: source.map,
              actor: match.change.actor,
              characterId: match.quest.goals.find(goal => goal.id === match.change.goal)?.characterId,
              authority: 'story',
              x: source.x,
              y: source.y,
              visible: true,
              hint: match.change.interactText || match.change.changedText,
            },
          },
        },
      ]);
      this.enemyStore.markCaptured(source.id, source.map, this.storyWorld.visit);
      this.emit();
    });
    return true;
  }

  enemyDefeated(spawn: EnemySpawn | CampaignEnemyPlacement, respawnMs = DEFAULT_ENEMY_RESPAWN_MS): boolean {
    if (this.enemyStore.raw(spawn.id)?.deadUntil !== undefined) return false;
    if ('activeQuest' in spawn && this.status(spawn.activeQuest) !== 'active') return false;
    this.batchNotifications(() => {
      const commands: StoryCommand[] = [{ type: 'quest', command: { type: 'fact', fact: this.nextQuestFact('defeat', spawn.enemyId, 'combat') } }];
      if ('activeQuest' in spawn) commands.push({ type: 'item-give', item: spawn.rewardItem, quantity: 1 });
      this.applyStoryCommands(commands);
      this.enemyStore.markDefeated(spawn, this.gameTimeMs, respawnMs);
      this.emit();
    });
    if (this.deferredDefeats) this.deferredDefeats.push(spawn.enemyId);
    else for (const listener of this.defeatListeners) listener(spawn.enemyId);
    return 'activeQuest' in spawn;
  }

  settleEnemyDefeat(input: EnemyDefeatInput): EnemyDefeatResult | undefined {
    return settleSessionEnemyDefeat({
      enemies: this.enemyStore,
      chests: this.chests,
      bag: this.bag,
      groundLoot: groundLootFor(this),
      hero: this.hero,
      party: this.party,
      lootPity: this.lootPity,
      partyItemChance: this.partyItemChance,
      getReservedDropMisses: () => this.reservedDropMisses,
      setReservedDropMisses: value => { this.reservedDropMisses = value; },
      claimedReservedDrops: this.claimedReservedDrops,
      questDropRequirements: () => this.questDropRequirements(),
      enemyDefeated: spawn => this.enemyDefeated(spawn),
      placeGroundRewards: (map, x, y, rewards) => this.placeGroundRewards(map, x, y, rewards),
      atomic: (operation, touched) => this.atomic(operation, touched),
      runDeferredDefeatBatch: (defeats, operation) => {
        const pending = this.pendingNotification, previousDefeats = this.deferredDefeats;
        this.deferredDefeats = defeats;
        this.notificationBatchDepth++;
        try { return operation(); } finally {
          this.notificationBatchDepth--;
          this.pendingNotification = pending;
          this.deferredDefeats = previousDefeats;
        }
      },
      emit: () => this.emit(),
      refresh: () => this.refresh(),
      notifySessionListeners: report => { for (const listener of this.listeners) report(() => listener(this)); },
      notifyDefeatListeners: (enemyId, report) => { for (const listener of this.defeatListeners) report(() => listener(enemyId)); },
    }, input);
  }

  placeGroundRewards(map: string, x: number, y: number, rewards: readonly DropReward[]): void {
    const frames = this.atomicFrames;
    placeSessionGroundRewards({
      bag: this.bag,
      groundLoot: groundLootFor(this),
      atomic: (operation, touched) => this.atomic(operation, touched),
      get currentAtomicFrame() { return frames[0]; },
    }, map, x, y, rewards);
  }

  openChest(input: {
    map: Pick<WorldMap, 'id' | 'lootLevel' | 'chestLevel'>;
    entity: string;
    kind: ChestKind;
    position: { x: number; y: number };
    catalog: DropCatalog;
    stats: CharacterStatsCatalog;
    landing: () => { x: number; y: number };
  }): boolean {
    return openSessionChest({
      chests: this.chests,
      lootPity: this.lootPity,
      hero: this.hero,
      party: this.party,
      storyWorld: this.storyWorld,
      atomic: (operation, touched) => this.atomic(operation, touched),
      placeGroundRewards: (map, x, y, rewards) => this.placeGroundRewards(map, x, y, rewards),
    }, input);
  }

  subscribeDefeats(listener: (enemy: string) => void): () => void {
    this.defeatListeners.add(listener);
    return () => { this.defeatListeners.delete(listener); };
  }
  subscribe(listener: SessionListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  batchNotifications<T>(operation: () => T): T {
    this.notificationBatchDepth++;
    try { return operation(); } finally {
      this.notificationBatchDepth--;
      if (!this.notificationBatchDepth && this.pendingNotification) {
        this.pendingNotification = false;
        this.emit();
      }
    }
  }

  atomic<T>(operation: () => T, touched: readonly AtomicSubsystem[]): T {
    const outer = this.atomicFrames.length === 0;
    const frame: AtomicFrame = outer ? { touched: new Set(), baseline: {} } : this.atomicFrames[0]!;
    if (outer) this.atomicFrames.push(frame);
    const pending = this.pendingNotification;
    try {
      this.touchAtomic(frame, touched);
      return this.batchNotifications(() => {
        try { return operation(); } catch (error) {
          if (outer) {
            this.restoreStoryCommandBaseline(frame.touched, frame.baseline);
            if (frame.groundMaps) for (const restore of [...frame.groundMaps.values()].reverse()) restore();
            this.pendingNotification = pending;
          }
          throw error;
        }
      });
    } finally {
      if (outer) this.atomicFrames.pop();
    }
  }

  private touchAtomic(frame: AtomicFrame, subsystems: Iterable<AtomicSubsystem>): void {
    const fresh = new Set<AtomicSubsystem>();
    for (const subsystem of subsystems) if (!frame.touched.has(subsystem)) fresh.add(subsystem);
    if (!fresh.size) return;
    const baseline = this.captureStoryCommandBaseline(fresh);
    for (const subsystem of fresh) frame.touched.add(subsystem);
    Object.assign(frame.baseline, baseline);
  }

  emit(): void {
    if (this.notificationBatchDepth) { this.pendingNotification = true; return; }
    this.refresh();
    for (const listener of this.listeners) listener(this);
  }

  private releaseReadyQuestActors(): void {
    this.questCoordinator.releaseReadyActors(this.questBook, this.storyWorld, () => {
      this.recordPerformance(['storyWorld']);
      const frame = this.atomicFrames[0];
      if (frame) this.touchAtomic(frame, ['storyWorld']);
    });
  }

  refresh(): void {
    this.questCoordinator.refresh(
      this.questBook,
      this.bag.revision,
      this.party?.controlledId ?? 'player',
      () => this.questContext(),
      {
        onMutateQuestBook: () => this.recordPerformance(['questBook']),
        storyWorld: this.storyWorld,
        onBeforeReleaseVisitors: () => {
          this.recordPerformance(['storyWorld']);
          const frame = this.atomicFrames[0];
          if (frame) this.touchAtomic(frame, ['storyWorld']);
        },
      },
    );
  }

  definition(id: string): CampaignQuest | undefined { return this.questCoordinator.definition(id); }
  status(id: string): QuestStatus { return this.questCoordinator.status(this.questBook, id); }
  rewardReceiptFor(id: string): QuestRewardReceipt | undefined { return this.questCoordinator.rewardReceiptFor(id); }
  retainQuestSettlements(delivered: ReadonlySet<string>): void { this.questCoordinator.retainSettlements(delivered); }

  accept(id: string): boolean {
    this.refresh();
    if (this.status(id) !== 'available') return false;
    this.applyStoryCommands([{ type: 'quest', command: { type: 'accept', quest: id, cycle: this.questBook.state(id)!.cycle } }]);
    return true;
  }

  canInteract(target: string, _instance: string, characterId?: string): boolean {
    return this.questCoordinator.canInteract(this.questBook, target, characterId);
  }

  interactWithFeedback(target: string, instance: string, characterId?: string): { advanced: boolean; feedback: string[] } {
    if (instance.startsWith('quest-target:')) {
      const source = this.enemyStore.raw(instance.slice('quest-target:'.length))?.capture, entity = this.storyWorld.entity(instance);
      if (!source || source.visit !== this.storyWorld.visit || !entity || !this.storyWorld.visible(instance)) return { advanced: false, feedback: [] };
    }
    const entries = this.questCoordinator.waitingGoalEntries(this.questBook, target, characterId);
    if (!entries.length) return { advanced: false, feedback: [] };
    const progressKey = (quest: CampaignQuest, goal: { id: string }) => quest.id + '\0' + goal.id;
    const before = new Map(entries.map(entry => [progressKey(entry.quest, entry.goal), this.questBook.state(entry.quest.id)?.goals[entry.goal.id] ?? 0]));
    const kinds = [...new Set(entries.map(entry => entry.kind))];
    const remove = instance.startsWith('quest-target:') && this.questCoordinator.shouldRemoveCapturedAfterInteract(this.questBook, target);
    const commands: StoryCommand[] = kinds.map(kind => ({
      type: 'quest' as const,
      command: { type: 'fact' as const, fact: { ...this.nextQuestFact(kind, target, kind === 'interact' ? 'interaction' : 'talk'), ...(characterId ? { characterId } : {}) } },
    }));
    if (remove) commands.push({ type: 'world', command: { kind: 'remove', id: instance } });
    this.batchNotifications(() => { this.applyStoryCommands(commands); });
    const feedback: string[] = [];
    let advanced = false;
    for (const entry of entries) {
      const after = this.questBook.state(entry.quest.id)?.goals[entry.goal.id] ?? 0;
      if (after <= (before.get(progressKey(entry.quest, entry.goal)) ?? 0)) continue;
      advanced = true;
      if (entry.quest.journal === false || !entry.goal.feedbackText || feedback.includes(entry.goal.feedbackText)) continue;
      feedback.push(entry.goal.feedbackText);
    }
    return { advanced, feedback };
  }

  interact(target: string, instance: string, characterId?: string): boolean { return this.interactWithFeedback(target, instance, characterId).advanced; }
  nextQuestFact(kind: QuestFact['kind'], target: string, source: string = kind): QuestFact { return this.questCoordinator.nextQuestFact(this.questBook, kind, target, source); }
  recordQuestFact(kind: QuestFact['kind'], target: string, source: string = kind): void {
    this.applyStoryCommands([{ type: 'quest', command: { type: 'fact', fact: this.nextQuestFact(kind, target, source) } }]);
  }
  recordStoryDefeat(enemyId: string): void {
    if (this.questCoordinator.shouldRecordStoryDefeat(this.questBook, enemyId)) this.recordQuestFact('defeat', enemyId, 'story-removal');
  }
  complete(id: string): boolean {
    if (this.definition(id)?.interactionEvent) return false;
    this.refresh();
    if (this.status(id) !== 'ready') return false;
    this.applyStoryCommands([{ type: 'quest', command: { type: 'complete', quest: id, cycle: this.questBook.state(id)!.cycle } }]);
    return true;
  }
  mark(flag: string): void { this.applyStoryCommands([{ type: 'flag', flag }]); }
  visible(entity: VisibilityRules & { condition?: StoryCondition }): boolean {
    if (!this.storyWorld.visible(entity.id)) return false;
    return entity.condition === undefined || evaluateStoryCondition(entity.condition, this.conditionContext());
  }
  forActor(actor: string, characterId?: string): CampaignQuest[] { this.refresh(); return this.questCoordinator.forActor(this.questBook, actor, characterId); }
  npcQuestSlot(actor: string, characterId?: string): CampaignQuest | undefined { this.refresh(); return this.questCoordinator.npcQuestSlot(this.questBook, actor, characterId); }
  deliverablesFor(actor: string): CampaignQuest[] { this.refresh(); return this.questCoordinator.deliverablesFor(this.questBook, actor); }
  marker(actor: string, characterId?: string): QuestStatus | null { this.refresh(); return this.questCoordinator.marker(this.questBook, actor, characterId); }
  markerActor(actor: string, characterId?: string): boolean { return this.questCoordinator.markerActor(this.questBook, actor, characterId); }
  currentQuest(): CampaignQuest | undefined { return this.questCoordinator.currentQuest(this.questBook); }
  trackQuest(id: string): boolean {
    if (!this.questCoordinator.trackQuest(this.questBook, id)) return false;
    this.emit();
    return true;
  }

  private captureStoryCommandBaseline(touched: ReadonlySet<AtomicSubsystem>): StoryCommandBaseline {
    const baseline: StoryCommandBaseline = {};
    if (touched.has('bag')) baseline.bag = this.bag.captureState();
    if (touched.has('hero') && this.hero) baseline.hero = this.hero.captureState();
    if (touched.has('skills')) baseline.skills = this.skills.captureState();
    if (touched.has('party') && this.party) baseline.restoreParty = this.party.checkpoint();
    if (touched.has('questBook')) baseline.quests = this.questBook.checkpoint();
    if (touched.has('storyWorld')) {
      baseline.world = this.storyWorld.captureState();
      baseline.choiceWrites = [...this.choiceWrites];
      baseline.visitorReleaseRevision = this.questCoordinator.visitorReleaseRevision;
    }
    if (touched.has('enemies')) baseline.enemies = this.enemyStore.captureEntries();
    if (touched.has('groundLoot')) baseline.loot = groundLootFor(this).captureState();
    if (touched.has('coins')) baseline.coins = this.coins;
    if (touched.has('receipts')) baseline.receipts = this.questCoordinator.captureBaselineReceipts();
    if (touched.has('reservedDrops')) baseline.reservedDrops = { unlockMisses: this.reservedDropMisses, claimed: [...this.claimedReservedDrops] };
    if (touched.has('lootPity')) baseline.lootPity = this.lootPity.captureState();
    if (touched.has('playerState')) baseline.playerState = this.playerState;
    if (touched.has('runtimeSnapshot')) baseline.runtime = this.runtimeSnapshot;
    if (touched.has('shops')) baseline.shops = this.shops.captureState();
    if (touched.has('chests')) baseline.chests = this.chests.captureState();
    return baseline;
  }

  private restoreStoryCommandBaseline(touched: ReadonlySet<AtomicSubsystem>, baseline: StoryCommandBaseline): void {
    if (touched.has('bag')) this.bag.restoreUnchecked(baseline.bag!);
    if (touched.has('hero') && baseline.hero) this.hero!.restoreState(baseline.hero);
    if (touched.has('skills')) this.skills.restoreState(baseline.skills!);
    if (touched.has('party')) baseline.restoreParty?.();
    if (baseline.departures) for (const restore of baseline.departures.values()) restore();
    if (touched.has('questBook')) { this.questBook.rollbackTo(baseline.quests!); this.questCoordinator.invalidateProjections(); }
    if (touched.has('storyWorld')) {
      this.storyWorld.restoreState(baseline.world!);
      this.choiceWrites.clear();
      for (const [id, count] of baseline.choiceWrites ?? []) this.choiceWrites.set(id, count);
      this.choiceWriteRevisionValue++;
      if (baseline.visitorReleaseRevision !== undefined) this.questCoordinator.setVisitorReleaseRevision(baseline.visitorReleaseRevision);
    }
    if (touched.has('enemies')) this.enemyStore.restoreEntries(baseline.enemies!);
    if (touched.has('groundLoot')) groundLootFor(this).restoreState(baseline.loot!);
    if (touched.has('coins')) this.coins = baseline.coins!;
    if (touched.has('receipts')) this.questCoordinator.restoreReceipts(baseline.receipts!.map(([, receipt]) => receipt));
    if (touched.has('reservedDrops')) {
      this.reservedDropMisses = baseline.reservedDrops!.unlockMisses;
      this.claimedReservedDrops.clear();
      for (const item of baseline.reservedDrops!.claimed) this.claimedReservedDrops.add(item);
    }
    if (touched.has('lootPity')) this.lootPity.restoreState(baseline.lootPity!);
    if (touched.has('playerState')) this.playerState = baseline.playerState;
    if (touched.has('runtimeSnapshot')) this.runtimeSnapshot = baseline.runtime!;
    if (touched.has('shops')) this.shops.restoreState(baseline.shops!);
    if (touched.has('chests')) this.chests.restoreState(baseline.chests!);
  }

  adoptRuntime(snapshot: StoryRuntimeSnapshot): void {
    const runtime = this.runtimeValidator ??= this.createRuntimeValidator();
    this.runtimeSnapshot = runtime.adoptTrusted(snapshot);
  }

  private applyQuestCommand(command: QuestCommand): void {
    const plan = this.questBook.plan(command, { stateIsCurrent: true });
    for (const item of plan.itemRemovals) if (!this.bag.remove(item.item, item.quantity)) throw new Error('剧情物品不足');
    for (const item of plan.itemGrants) { this.bag.add(item.item, item.quantity); this.noteReservedGrant(item.item); }
    for (const receipt of plan.rewards) {
      this.questCoordinator.recordReceipt(receipt, {
        addExperience: amount => this.hero?.addExperience(amount),
        gainMoney: amount => this.gainMoney(amount),
      });
    }
    this.questBook.commit(plan);
    this.questCoordinator.recordProjection(this.questBook, this.bag.revision, this.party?.controlledId ?? 'player', () => this.questContext());
  }

  applyStoryCommands(
    commands: readonly StoryCommand[],
    checkpoint?: StoryRuntimeSnapshot,
    options: { deferFinalize?: boolean } = {},
  ): StoryCommitReceipt {
    if (!commands.length) {
      if (checkpoint) this.adoptRuntime(checkpoint);
      return { finalize() {}, rollback() {} };
    }
    this.refresh();
    const touched = new Set<StorySubsystem>();
    for (const command of commands) for (const subsystem of storyCommandSubsystems(command)) touched.add(subsystem);
    touched.add('questBook');
    if (this.storyWorld.hasVisitAbsences) touched.add('storyWorld');
    if (checkpoint) touched.add('runtimeSnapshot');
    if (!options.deferFinalize) this.recordPerformance(touched);
    const baseline = this.captureStoryCommandBaseline(touched), pending = this.pendingNotification;
    let active = true;
    const receipt: StoryCommitReceipt = {
      finalize: () => { active = false; },
      rollback: () => {
        if (!active) return;
        active = false;
        this.restoreStoryCommandBaseline(touched, baseline);
        this.pendingNotification = pending;
        this.emit();
      },
    };
    if (options.deferFinalize) this.storyCommandDepth++;
    try {
      this.batchNotifications(() => {
        try {
          const playerState = this.playerState ? { ...this.playerState } : undefined;
          for (const command of commands) {
            if (command.type === 'quest' || command.type === 'interaction' || command.type === 'talk') this.refresh();
            switch (command.type) {
              case 'quest': this.applyQuestCommand(command.command); break;
              case 'interaction':
                if (!command.target || !command.instance) throw new Error('剧情交互目标无效');
                this.applyQuestCommand({ type: 'fact', fact: { kind: 'interact', target: command.target, occurrence: { source: 'interaction', sequence: this.questBook.factSequence('interaction') + 1 } } });
                break;
              case 'talk':
                if (!command.target) throw new Error('剧情对话目标无效');
                this.applyQuestCommand({ type: 'fact', fact: { kind: 'talk', target: command.target, occurrence: { source: 'talk', sequence: this.questBook.factSequence('talk') + 1 } } });
                break;
              case 'item-give': case 'item-take':
                if (!Number.isSafeInteger(command.quantity) || command.quantity <= 0) throw new Error('剧情物品数量无效');
                if (command.type === 'item-give') { this.bag.add(command.item, command.quantity); this.noteReservedGrant(command.item); }
                else if (!(command.allowPartial && this.bag.count(command.item) === 0) && !this.bag.remove(command.item, command.allowPartial ? Math.min(command.quantity, this.bag.count(command.item)) : command.quantity)) {
                  throw new Error('剧情物品不足');
                }
                break;
              case 'money-give': case 'money-take':
                if (!Number.isSafeInteger(command.amount) || command.amount <= 0) throw new Error('剧情金币数量无效');
                if (command.type === 'money-take') {
                  if (command.amount > this.coins && !command.allowPartial) throw new Error('剧情金币不足');
                  this.spendMoney(Math.min(command.amount, this.coins));
                } else this.gainMoney(command.amount);
                break;
              case 'item-drop':
                if (!this.bag.catalog.items[command.item] || !Number.isSafeInteger(command.quantity) || command.quantity <= 0 || !Number.isFinite(command.x) || !Number.isFinite(command.y)) {
                  throw new Error('剧情地面物品无效');
                }
                groundLootFor(this).add(command.map ?? this.storyWorld.currentLocation?.map ?? this.campaign.start.map, command.x, command.y, [{ kind: 'item', item: command.item, quantity: command.quantity }]);
                break;
              case 'flag': this.storyWorld.apply({ kind: 'flag', id: command.flag, value: command.value ?? true }); break;
              case 'choice':
                this.storyWorld.apply({ kind: 'choice', id: command.choice, value: command.value });
                this.choiceWrites.set(command.choice, (this.choiceWrites.get(command.choice) ?? 0) + 1);
                this.choiceWriteRevisionValue++;
                break;
              case 'world':
                this.storyWorld.apply(command.command);
                if (command.command.kind === 'encounter-result') this.enemyStore.forgetEncounters(this.storyWorld.consumePrunedEncounters());
                break;
              case 'travel': this.storyWorld.apply({ kind: 'travel', destination: command.destination }); break;
              case 'encounter': this.storyWorld.apply({ kind: 'encounter', encounter: command.encounter }); break;
              case 'party-leave':
                leaveStoryCompanionWithBaseline(command.companion, baseline, {
                  party: this.party, cooldowns: this.cooldowns, frenzyAnimations: this.frenzyAnimations,
                  lootPity: this.lootPity, performanceLogging: this.performanceLogging, storyCommandDepth: this.storyCommandDepth,
                  performanceBaseline: this.performanceBaseline,
                });
                break;
              case 'party-join': case 'party-control': case 'health': case 'mana': case 'equip': case 'unequip-destroy':
                applyActorStoryCommand(command, {
                  bag: this.bag, hero: this.hero, party: this.party, fallback: playerState,
                  fallbackClassId: this.character?.classId, lootPity: this.lootPity,
                });
                break;
              default: throw new Error('未知剧情游戏命令');
            }
          }
          if (touched.has('playerState')) this.playerState = playerState ? Object.freeze(playerState) : undefined;
          if (checkpoint) this.adoptRuntime(checkpoint);
          if (this.runtimeSnapshot.runs.some(run => run.waiting) || commands.some(command => command.type === 'encounter')) {
            validateSessionStoryLinks(this.campaign, this.storyWorld.captureState(), this.runtimeSnapshot);
          }
          this.refresh();
          this.releaseReadyQuestActors();
          this.questCoordinator.recordProjection(this.questBook, this.bag.revision, this.party?.controlledId ?? 'player', () => this.questContext());
          this.emit();
        } catch (error) {
          this.restoreStoryCommandBaseline(touched, baseline);
          this.pendingNotification = pending;
          throw error;
        }
      });
    } finally {
      if (options.deferFinalize) this.storyCommandDepth--;
    }
    if (!options.deferFinalize) active = false;
    return receipt;
  }

  movePlayer(destination: TravelDestination): boolean {
    const current = this.storyWorld.currentLocation;
    if (current && destination.map !== current.map) throw new Error('换图要走剧情转场命令');
    if (current && current.x === destination.x && current.y === destination.y && current.facing === destination.facing) return false;
    this.storyWorld.apply({ kind: 'travel', destination });
    this.emit();
    return true;
  }
}

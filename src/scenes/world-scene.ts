import { StoryExecutionBudgetError } from '../domain/story-runtime.ts';
import { pressureEnemy } from '../domain/pressure-enemies.ts';
import { summonLampMerchant } from '../domain/lamp-merchant.ts';
import { prepareCombatRestore } from '../domain/combat-snapshot.ts';
import type { SceneActorState, SceneSnapshot } from '../domain/scene-snapshot.ts';
import { generateMapEntities } from '../domain/scene-visit.ts';
import { placementMayBeInactive, resolveMapActors } from '../domain/map-placement.ts';
import { SCENE_KEYS } from '../application/scene-keys.ts';
import { worldZoom } from '../ui/viewport.ts';
import { OverheadStatus } from '../rendering/overhead-status.ts';
import { QuestMarker } from '../rendering/quest-marker.ts';
import { questNotices, type QuestNoticeState } from '../ui/quest-progress.ts';
import Phaser from 'phaser';
import { NavigationWorld, collisionAt } from '../domain/navigation-world.ts';
import { MovementWorld } from '../rendering/movement-world.ts';
import { isBodyWalking } from '../rendering/arcade-movement.ts';
import type { ActorDefinition, ClipName, EntityPlacement, ExitFacing, Facing, MapExit, QuestStatus, WorldMap } from '../domain/content.ts';
import type { AssetLease } from '../application/assets.ts';
import { Wardrobe } from '../rendering/wardrobe.ts';
import type { EquipmentSlot, ItemResult } from '../domain/items.ts';
import type { BattleStatKey } from '../domain/battle-semantics.ts';
import type { PassiveModifier } from '../domain/passive-skills.ts';
import type { StoryStageSnapshot } from '../domain/story-performance.ts';
import { createEffect } from '../rendering/effects.ts';
import type { StoryContext } from '../application/ports.ts';
import { WorldEnemyRoster } from '../domain/world-enemies.ts';
import { WorldCombat, type WorldCombatState } from './world-combat.ts';
import { InteractionTargetIndex } from './interaction-index.ts';
import { QuestEnemyWatch } from '../domain/quest-enemies.ts';
import { cachedDropCatalog, type DropCatalog, type DropReward } from '../domain/drops.ts';
import { pickNearestInteractionTarget, resolveInteraction } from '../domain/interaction.ts';
import { faceTarget } from '../domain/basic-attack.ts';
import { canReachChest, CHEST_OPEN_MS } from '../domain/chests.ts';
import { applySpringRecovery, grantSpringSkillPoint, parseSprings, rollSpringEffect, springBuffScope, type SpringCatalog, type SpringPartyResources } from '../domain/springs.ts';
import { innRestQuote, payForInnRest } from '../domain/inns.ts';
import { pullLegendaryWeapon } from '../domain/legendary-weapon.ts';
import { GroundLootView } from '../rendering/ground-loot.ts';
import { PickupMessages } from '../rendering/pickup-messages.ts';
import { BasicAttackRepeat } from '../domain/basic-attack-repeat.ts';
import { buildEntryPlan } from '../application/entry-plan.ts';
import { loadEntryPlan } from '../application/entry-loading.ts';
import { hasLivingParty } from '../domain/session-checkpoint.ts';
import { freezeSnapshot, storyDevMode } from '../domain/dev-mode.ts';
import type { TravelDestination } from '../domain/content.ts';
import type { StoryWorldViewSnapshot, SaveWorldResult } from '../application/world-snapshot.ts';
import type { CombatWorldHost } from './world-combat-host.ts';
import type { RecoveryResult } from '../domain/recovery-items.ts';

import { characterAssets, characterSceneClips } from '../rendering/combat-asset-descriptors.ts';
import { characterAnimationState, createCharacter, PLAYER_MOVE_SPEED, setCharacterClip } from '../rendering/characters.ts';
import { drawMapLayers, type MapLayerHandles } from '../rendering/map-layers.ts';
import type { CharacterVisual } from '../rendering/characters.ts';
import { loadSceneAssets, missingSceneAssets, retainLoadedSceneAssets } from '../rendering/scene-assets.ts';
import type { ShortcutSlot } from '../ui/hud/action-controls.ts';
import { WorldHud } from '../ui/world-hud.ts';
import type { MinimapInteraction, MinimapTask } from '../ui/hud/story-minimap.ts';
import type { Cooldown } from '../domain/combat.ts';
import type { PendingAsset } from '../rendering/scene-assets.ts';
import { WorldLootCoordinator } from './world-loot.ts';
import { WorldOutfits } from './world-outfits.ts';
import { WorldPrefetcher } from './world-prefetch.ts';
import { WorldReadiness } from './world-readiness.ts';
import { WorldShortcutController } from './world-shortcuts.ts';
import { WorldTriggerCoordinator } from './world-triggers.ts';

/** 卡顿时最多补 2 个逻辑帧；补 3 帧会把 AI、寻路和状态的尖峰叠成三倍。 */
const MAX_FRAME_DELTA_MS = 120;
/** 压测模式每 0.9 秒尝试补一只怪。 */
const PRESSURE_SPAWN_INTERVAL_MS = 900;
/** 小地图敌人标记最多每 100 毫秒刷新一次。 */
const MINIMAP_ENEMY_REFRESH_MS = 100;

/** 角色头顶和小地图都会显示的任务图标；锁定与已完成不显示。 */
function hasQuestIcon(status: QuestStatus | null, marked: boolean): status is 'available' | 'active' | 'ready' {
  return marked && (status === 'available' || status === 'active' || status === 'ready');
}

/** 进图参数：去哪张地图、落在哪里、朝哪边。 */
export interface SceneOptions {
  initialEntry?: boolean;
  checkpoint?: WorldCombatState;
  suppressEntry?: boolean;
  /** 演出中的世界重建：舞台画面还在演，加载过程不再盖加载界面。 */
  silentEntry?: boolean;
  /** 读档进场：不跑开场，恢复完接着走存档里的剧情游标。 */
  resumeStory?: boolean;
  onReady?: () => void;
  onError?: (error: unknown) => void;
  signal?: AbortSignal;
  generatedEntities?: EntityPlacement[];
  preparedScene?: SceneSnapshot;
  triggerContacts?: StoryWorldViewSnapshot['triggerContacts'];
  map: string;
  x: number;
  y: number;
  facing?: ExitFacing;
}

/** 场景里的一个人物：一个容器装着若干张动作图层。 */
interface Character extends CharacterVisual {
  marker: QuestMarker | null;
}

export class WorldScene extends Phaser.Scene implements CombatWorldHost {
  /** 战斗渲染组件需要完整场景；世界协作仍走 `CombatWorldHost` 的其余成员。 */
  get phaserScene(): Phaser.Scene { return this; }
  readonly chestFades = new Map<string, Phaser.Tweens.Tween>();
  readonly app: StoryContext;
  readonly readiness: WorldReadiness<SceneOptions>;
  readonly outfits: WorldOutfits;
  readonly shortcuts: WorldShortcutController;
  readonly loot: WorldLootCoordinator<CharacterVisual>;
  readonly triggers: WorldTriggerCoordinator;
  readonly prefetch: WorldPrefetcher;
  get exitTrigger() { return this.triggers.exitTrigger; }
  set exitTrigger(value) { this.triggers.exitTrigger = value; }

  /** 本次进图的参数。 */
  options!: SceneOptions;
  characters: Character[] = [];
  /** 有头顶任务图标的角色；每帧只更新这一小组，不扫全图。 */
  readonly questMarkerCharacters = new Set<Character>();
  /** 最近的交互对象，脚底离得最近且在有效距离内的那个。 */
  near: Character | null = null;
  /** 上一次 HUD 调和写入时的状态摘要；逐帧兜底调用时用它跳过无变化的重复写入。 */
  private hudSignature = '';
  /** 目标状态按战斗帧缓存；同一逻辑帧内的多个渲染帧不必重复计算敌人数值。 */
  private targetStatusCache?: { tick: number; actor: string; status: ReturnType<WorldCombat['targetStatus']>; hostile: boolean };
  /** 切图或首次加载期间为 true，此时不接受输入。 */
  loadingWorld = true;
  destroyed = false;
  /** 演出舞台已经铺满画面；正式世界这帧不更新、不渲染、物理也不步进。 */
  stageOccluded = false;
  readonly storyEntityAssets: AssetLease[] = [];
  readonly projectedActorIds = new Set<string>();
  private lastProjectedLocation?: string;
  baseEntities: EntityPlacement[] = [];
  private refreshStateSignatureValue?: string;
  /** 上一次交互扫描的输入；逐字段比较，静止帧不拼名单。 */
  private lastInteractionScan?: {
    x: number; y: number; revision: number; quest: number; story: number; chests: number;
    legendary: number; restore: number; runtime: number;
    bag: number; money: number; level: number; map: string; owner: string;
  };
  /** 交互候选的空间索引；只收当前地图角色，查询后再逐项判定。 */
  private interactionIndex?: InteractionTargetIndex<Character>;
  private interactionIndexRevision?: number;
  private interactionIndexCharactersRevision?: number;
  /** 地图角色只在投影、恢复或显隐改变时使交互结果失效。 */
  interactionRevision = 0;
  /** 地图角色集合的修订号；整图刷新摘要用它代替逐角色拼名单。 */
  charactersRevision = 0;
  worldHud?: WorldHud;
  overheadStatus?: OverheadStatus;
  private nextMinimapEnemyUpdate = 0;
  request = new AbortController();
  private mapAssets?: AssetLease;
  map?: WorldMap;
  entities: EntityPlacement[] = [];
  player?: Character;
  /** 当前被 GM 穿墙接管的人物；切换操控者时用它关掉旧角色。 */
  private noclipVisual?: CharacterVisual;
  facing: Facing = 'south';
  movement?: MovementWorld;
  private lastPlayerPosition?: { x: number; y: number };
  /** 进图后先等方向输入回中，避免切图前按住的方向把人直接送回门口。 */
  private entryInputGate = false;
  /** 当前地图的静态层；离开或重建时连图带合成纹理一起释放。 */
  private mapLayers?: MapLayerHandles;
  private unsubscribe?: () => void;
  combat?: WorldCombat;
  dropCatalog?: DropCatalog;
  springCatalog?: SpringCatalog;
  groundLootView?: GroundLootView;
  pickupMessages?: PickupMessages;
  /** 压测刷怪计时器；离开场景时停掉，避免退出后继续生成。 */
  private pressureSpawner?: Phaser.Time.TimerEvent;
  pressureStartPoints: { x: number; y: number }[] = [];
  /** 任务完成/进度提示的上次状态；按任务簿版本对比，不在每次会话通知里扫全部任务。 */
  private questStatuses = new Map<string, QuestNoticeState>();
  private questStatusVersion?: number;
  /** 首次刷新只建基线，避免进图时把已有进度当成刚变化。 */
  private questNoticesReady = false;
  /** 普攻连打门控：发起过一次普攻后，站定就自动接下一击，摇杆一动即停。 */
  readonly autoAttack = new BasicAttackRepeat();
  checkpointPending = false;
  /** 同一段等待遭遇只记一条诊断；条件解除后重新允许记录。 */
  private checkpointWaitLogged = false;

  constructor(app: StoryContext) {
    super({ key: SCENE_KEYS.world, physics: { default: 'arcade', arcade: { gravity: { x: 0, y: 0 }, debug: false } } });
    this.app = app;
    const world = this;
    this.readiness = new WorldReadiness<SceneOptions>({
      worldReady: () => this.worldReady(),
      isDestroyed: () => this.destroyed,
      currentOptions: () => this.options,
      setLoadingWorld: loading => { this.loadingWorld = loading; },
      restartScene: options => this.scene.restart(options),
    });
    this.outfits = new WorldOutfits({
      get app() { return world.app; },
      get destroyed() { return world.destroyed; },
      get loadingWorld() { return world.loadingWorld; },
      get map() { return world.map; },
      get player() { return world.player; },
      get requestToken() { return world.request.signal; },
      createWardrobe: () =>
        new Wardrobe(this, this.app.wardrobe, this.app.items, (ids, signal) => this.app.content.wardrobePoses(ids, signal), this.app.outfits),
      loadManualAssets: assets => this.loadAssets(assets),
      setPlayerClipIdle: restart => {
        if (!this.player) return;
        const clip: ClipName = `idle-${this.facing}`;
        if (restart) setCharacterClip(this, this.player, clip, true);
        else this.setClip(this.player, clip);
      },
      refreshPlayerShape: () => {
        if (this.player) this.movement?.refreshShape(this.player);
      },
      onMemberAppearance: (memberId, actor) => this.combat?.updateMemberAppearance(memberId, actor),
      onEquipmentUpdated: memberId => this.combat?.updateEquipment(memberId),
      syncControlledCharacter: () => this.syncControlledCharacter(),
    });
    this.shortcuts = new WorldShortcutController({
      get app() { return world.app; },
      get canControl() { return world.canControl; },
      get hudReady() { return !!world.worldHud?.ready; },
      setShortcutPage: slots => this.worldHud?.setShortcutPage(slots),
      combat: () => this.combat,
      revivePartyMember: (id, item) => this.revivePartyMember(id, item),
    });
    this.loot = new WorldLootCoordinator<CharacterVisual>({
      get app() { return world.app; },
      get destroyed() { return world.destroyed; },
      get loadingWorld() { return world.loadingWorld; },
      get map() { return world.map; },
      get dropCatalog() { return world.dropCatalog; },
      get navigation() { return world.movement?.navigation; },
      get combat() { return world.combat; },
      get player() { return world.player; },
      syncView: drops => { this.groundLootView?.sync(drops); },
      enqueuePickup: (rewards, recipientId) => { this.pickupMessages?.enqueue(rewards, recipientId); },
    });
    this.triggers = new WorldTriggerCoordinator();
    this.prefetch = new WorldPrefetcher({
      get app() { return world.app; },
      get destroyed() { return world.destroyed; },
      get loadingWorld() { return world.loadingWorld; },
      get map() { return world.map; },
      get entities() { return world.entities; },
      get dropCatalog() { return world.dropCatalog; },
      get springCatalog() { return world.springCatalog; },
      get requestSignal() { return world.request.signal; },
      get now() { return world.time.now; },
      get worldView() { return world.cameras?.main?.worldView; },
      exitAvailable: exit => this.exitAvailable(exit),
      loadAssets: (assets, options) => loadSceneAssets(this, assets, options),
      loadStoryEntryAssets: async (assets, signal) => {
        const loader = this.scene.get(SCENE_KEYS.formalUi);
        const missing = missingSceneAssets(loader, assets).length;
        const lease = await loadSceneAssets(loader, assets, { lifetime: 'manual', signal });
        return { missing, lease };
      },
    });
  }

  init(options: SceneOptions): void {
    this.outfits.reset();
    this.request.abort();
    this.request = new AbortController();
    this.mapLayers?.destroy();
    this.mapLayers = undefined;
    this.player = undefined;
    this.noclipVisual = undefined;
    this.map = undefined;
    this.options = options;
    this.characters = [];
    this.questMarkerCharacters.clear();
    this.near = null;
    this.loadingWorld = true;
    this.destroyed = false;
    this.readiness.claimInit(options);
    this.stageOccluded = false;
    // 正常进图/换图先排一次“恢复控制后的安全基线”；从检查点恢复时保留原检查点，不重抓。
    this.movement = undefined;
    this.lastPlayerPosition = undefined;
    this.combat = undefined;
    this.checkpointPending = !options.checkpoint;
    this.checkpointWaitLogged = false;
    this.shortcuts.reset();
    this.dropCatalog = undefined;
    this.springCatalog = undefined;
    this.groundLootView = undefined;
    this.pickupMessages = undefined;
    this.loot.reset();
    this.questStatuses.clear();
    this.questStatusVersion = undefined;
    this.questNoticesReady = false;
    this.prefetch.reset();
    this.triggers.reset(options.triggerContacts);
    this.baseEntities = [];
    this.refreshStateSignatureValue = undefined;
    this.lastInteractionScan = undefined;
    this.interactionRevision = 0;
    this.charactersRevision = 0;
    this.interactionIndex = undefined;
    this.interactionIndexRevision = undefined;
    this.interactionIndexCharactersRevision = undefined;
    this.projectedActorIds.clear();
  }

  create(): void {
    this.readiness.settleCreateStarted();
    globalThis.storyDiagnostics?.record('start-phase', { phase: 'world-create' });
    if (this.options.signal?.aborted) {
      this.destroyed = true;
      this.readiness.abortCreate(this.options.signal.reason);
      this.options.onError?.(this.options.signal.reason);
      this.scene.stop();
      return;
    }
    const externalSignal = this.options.signal;
    const cancelLoad = () => this.request.abort(externalSignal?.reason);
    externalSignal?.addEventListener('abort', cancelLoad, { once: true });
    this.events.once('shutdown', () => externalSignal?.removeEventListener('abort', cancelLoad));
    this.cameras.main.setBackgroundColor('#000000');
    this.events.once('shutdown', () => {
      globalThis.storyDiagnostics?.record('map-exit', { map: this.map?.id, loading: this.loadingWorld }, false);
      this.destroyed = true;
      this.readiness.handleShutdown();
      for (const tween of this.chestFades.values()) tween.stop();
      this.chestFades.clear();
      this.app.ui.closeDefeat();
      this.request.abort();
      this.unsubscribe?.();
      this.scale.off('resize', this.resizeView, this);
      this.events.off(Phaser.Scenes.Events.POST_UPDATE, this.afterMovement, this);
      this.pressureSpawner?.remove(false);
      this.pressureSpawner = undefined;
      this.pressureStartPoints = [];
      this.combat?.destroy();
      this.combat = undefined;
      for (const character of this.characters) this.removeQuestMarker(character);
      this.questMarkerCharacters.clear();
      this.mapAssets?.release();
      this.mapAssets = undefined;
      for (const lease of this.storyEntityAssets) lease.release();
      this.storyEntityAssets.length = 0;
      this.groundLootView?.destroy();
      this.groundLootView = undefined;
      this.pickupMessages?.destroy();
      this.pickupMessages = undefined;
      this.loot.reset();
      this.shortcuts.reset();
      this.triggers.reset();
      this.prefetch.reset();
      this.movement?.destroy();
      this.movement = undefined;
      this.mapLayers?.destroy();
      this.mapLayers = undefined;
      this.worldHud?.destroy();
      this.worldHud = undefined;
      this.input.off(Phaser.Input.Events.POINTER_DOWN, this.onPointerDown, this);
      this.overheadStatus?.destroy();
      this.overheadStatus = undefined;
      this.app.domUi?.setLayerVisible('world', false);
      this.outfits.destroy();
      this.projectedActorIds.clear();
      this.characters = [];
      this.entities = [];
      this.baseEntities = [];
      this.player = undefined;
      this.map = undefined;
      this.interactionIndex = undefined;
      this.interactionIndexRevision = undefined;
      this.interactionIndexCharactersRevision = undefined;
      this.near = null;
      this.noclipVisual = undefined;
      this.targetStatusCache = undefined;
      this.unsubscribe = undefined;
      this.questStatuses.clear();
      this.questStatusVersion = undefined;
      this.questNoticesReady = false;
      Reflect.deleteProperty(this, 'options');
    });
    this.worldHud = new WorldHud(this, this.app.domUi);
    this.layoutHud();
    this.scale.on('resize', this.resizeView, this);
    this.events.on(Phaser.Scenes.Events.POST_UPDATE, this.afterMovement, this);
    // 世界级左键挂在场景输入上：点敌人、地面和界面控件的区别在这里统一判断。
    this.input.on(Phaser.Input.Events.POINTER_DOWN, this.onPointerDown, this);
    const wake = () => {
      this.app.ui.setMode('game');
      this.refreshState();
      this.resizeView();
      this.app.ui.loaded();
      this.app.syncLifecycle?.();
    };
    this.events.on('wake', wake);
    this.events.once('shutdown', () => this.events.off('wake', wake));
    const options = this.options;
    const signal = this.request.signal;
    this.readiness.trackOpen(
      options,
      this.open(options),
      signal,
      () => this.options === options,
      error => this.failure(error),
    );
  }

  /** 地图、主角和移动层是否都已创建；不包含加载状态。 */
  private get worldObjectsReady(): boolean { return !!this.map && !!this.player && !!this.movement; }

  /** 正式世界完整可读：地图、主角、移动层都在，且不在加载或关闭中。 */
  worldReady(): boolean { return this.worldObjectsReady && !this.loadingWorld && !this.destroyed; }

  beginWorldSwitch(): void { this.readiness.beginSwitch(); }
  waitWorldReady(signal?: AbortSignal): Promise<void> { return this.readiness.waitWorldReady(signal); }
  recoverWorld(signal?: AbortSignal): Promise<void> { return this.readiness.recoverWorld(signal); }

  /**
   * 演出舞台铺满画面后，正式世界继续留在 RUNNING（Loader、scene.restart 和跨场景调用都要用），
   * 但不再更新、渲染或步进物理。舞台恢复透明前必须解除。
   */
  setStageOccluded(occluded: boolean): void {
    if (this.destroyed || this.stageOccluded === occluded) return;
    this.stageOccluded = occluded;
    const camera = this.cameras?.main;
    if (camera) {
      if (occluded) camera.preRender?.();
      camera.setVisible(!occluded);
    }
    if (this.physics?.world) {
      if (occluded) this.physics.pause(); else this.physics.resume();
    }
    const paused = occluded || !this.canCombatControl;
    this.pickupMessages?.setPaused(paused);
    this.groundLootView?.setPaused(paused);
    this.updateQuestMarkerPositions();
  }

  /** 以舞台自己的遮罩状态为准；舞台关闭或重建后这里会把遮挡解除。 */
  private syncStageOcclusion(): void {
    const stage = this.scene?.get?.(SCENE_KEYS.storyStage) as { worldCovered?: boolean } | undefined;
    this.setStageOccluded(stage?.worldCovered === true);
  }

  async open(options: SceneOptions): Promise<void> {
    const { ui, world, campaign } = this.app;
    const signal = this.request.signal;
    globalThis.storyDiagnostics?.record('start-phase', { phase: 'world-open', map: options.map });
    const silentRequested = options.silentEntry === true;
    this.outfits.warmPlayerPoses(this.app.outfits, signal);
    if (silentRequested) ui.resetInput();
    else ui.loading('正在前往新的地方…', options.initialEntry ? 0.5 : 0);
    const reference = world.maps.find(map => map.id === options.map);
    if (!reference) throw new Error('这片区域的资源尚未准备好');
    const [loadedMap, rawDrops, rawSprings] = await Promise.all([
      this.app.content.map(reference.file, signal),
      this.app.content.drops(signal),
      this.app.content.springs(signal),
    ]);
    this.pressureStartPoints = this.app.pressureMode ? (loadedMap.enemySpawns ?? []).map(({ x, y }) => ({ x, y })) : [];
    const map = this.app.pressureMode ? { ...loadedMap, enemySpawns: [] } : loadedMap;
    signal.throwIfAborted();
    globalThis.storyDiagnostics?.record('start-phase', { phase: 'map-data-ready', map: map.id });
    this.map = map;
    this.outfits.playerTownPose = options.preparedScene?.actors.find(actor => actor.id === 'player')?.townPose;
    globalThis.storyDiagnostics?.record('map-enter', {
      map: map.id,
      x: options.x,
      y: options.y,
      initialEntry: !!options.initialEntry,
      resumeStory: !!options.resumeStory,
    }, false);
    this.app.session.enterMap(map.id, map.questItemSpawns ?? [], map, map.enemySpawns);
    this.dropCatalog = cachedDropCatalog(rawDrops, this.app.items, this.app.battleCatalog.enemies);
    this.springCatalog = parseSprings(rawSprings);
    const generated = options.preparedScene?.visit?.generatedEntities ?? options.generatedEntities;
    this.baseEntities = generated
      ? structuredClone(generated)
      : generateMapEntities(map, campaign, this.springCatalog, this.app.session.hero?.level ?? 1, Math.random, entity => !placementMayBeInactive(entity));
    this.entities = this.app.session.storyWorld.projectEntities(
      map.id,
      resolveMapActors({ base: this.baseEntities, map, campaign, active: entity => this.app.session.visible(entity) }),
      this.app.campaign.placements,
    );
    const residentClassId = this.app.session.hero?.classId ?? this.app.session.character?.classId;
    if (this.app.residentCombatReady && this.app.residentCombatClassId !== residentClassId) {
      if (this.app.releaseResidentCombat) this.app.releaseResidentCombat();
      else {
        this.app.residentCombatAssets?.release();
        this.app.residentCombatAssets = undefined;
        this.app.residentCombatClassId = undefined;
        this.app.residentCombatReady = false;
      }
    }
    const includeResidentCombat = !this.app.residentCombatReady;
    const plan = buildEntryPlan({
      currentMap: map,
      currentEntities: this.entities,
      inputs: this.prefetch.assetInputs(),
      completedEvents: this.app.session.runtimeState.completedEvents,
      questStatus: id => this.app.session.status(id),
      activeScripts: this.prefetch.activeStoryScripts(),
      checkpoint: options.checkpoint,
      includeResidentCombat,
    });
    globalThis.storyDiagnostics?.record('start-phase', {
      phase: 'entry-plan-ready',
      map: map.id,
      assets: plan.shared.length + plan.current.assets.length + (plan.residentCombat?.length ?? 0),
    });
    const planned = [...plan.shared, ...plan.current.assets, ...(plan.residentCombat ?? [])];
    const mapProgressEnd = plan.scripts.length ? 0.9 : 1;
    const missing = missingSceneAssets(this, planned).length;
    const silent = silentRequested;
    if (silentRequested) globalThis.storyDiagnostics?.record('story-silent-entry-missing', { map: map.id, missing });
    if (silent) ui.resetInput();
    this.app.director.onSkipProgress?.('assets-start');
    if (silent) await this.app.storyAssetPreparation?.wait(map.id);
    signal.throwIfAborted();
    const loaded = await loadEntryPlan(
      plan,
      {
        load: (assets, progress) => loadSceneAssets(this, assets, { progress, lifetime: 'manual', signal }),
        report: silent ? () => {} : (label, value) => ui.loading(label, value),
        preloadPortraits: (files, portraitSignal, progress) => ui.preloadPortraits(files, portraitSignal, progress),
        prepareSounds: (names, soundSignal) => {
          soundSignal.throwIfAborted();
          return this.app.audio?.prepareStoryEffects(names, soundSignal) ?? Promise.resolve();
        },
      },
      {
        signal,
        start: options.initialEntry ? 0.5 : 0,
        end: mapProgressEnd,
        preparePresentation: !silent,
        onPhase: phase => this.app.director.onSkipProgress?.(phase),
      },
    );
    if (signal.aborted) {
      loaded.currentLease.release();
      signal.throwIfAborted();
    }
    this.mapAssets = loaded.currentLease;
    globalThis.storyDiagnostics?.record('start-phase', { phase: 'scene-assets-ready', map: map.id });
    if (includeResidentCombat) {
      this.app.residentCombatAssets = retainLoadedSceneAssets(this, plan.residentCombat ?? []);
      this.app.residentCombatClassId = residentClassId;
      this.app.residentCombatReady = true;
    }
    this.app.releaseStoryPrefetch(map.id);
    for (const id of plan.current.visuals.actorIds) this.projectedActorIds.add(id);
    this.app.clearMapPrefetch();
    const equippedActor = await this.outfits.prepareEntryOutfit(signal);
    globalThis.storyDiagnostics?.record('start-phase', { phase: 'wardrobe-ready', map: map.id });
    this.app.director.onSkipProgress?.('outfit-ready');
    const hudSession = this.app.session;
    const hudSignal = signal;
    this.worldHud!.mount(
      this.app,
      map,
      {
        active: () => !hudSignal.aborted && this.app.session === hudSession,
        player: () => this.combat?.controlledState,
        conditions: id => this.combat?.activeConditions(id) ?? [],
      },
      {
        attack: () => this.attackKey(),
        skill: key => { if (this.canControl) this.combat?.attack(key); },
        item: id => this.useShortcutItem(id),
        cycle: () => this.shortcuts.cyclePage(),
        slot: slot => this.shortcuts.triggerSlot(slot),
        member: direction => this.switchMember(direction),
        select: id => this.switchControlled(id),
        focus: () => { if (this.canControl) this.combat?.focusSelected(); },
      },
    );
    this.shortcuts.refreshLoadout();
    this.layoutHud();
    this.mapLayers = drawMapLayers(this, map, { keyPrefix: `${map.id}-dodge` });
    this.groundLootView = new GroundLootView(this, this.app.items, (clip, x, y) => createEffect(this, clip, x, y, true));
    this.loot.refresh();
    this.pickupMessages = new PickupMessages(this, this.app.items, {
      anchor: id => {
        const character = this.loot.recipient(id);
        if (!character?.container.active) return undefined;
        return { ...this.movement!.displayPosition(character), headAnchor: character.actor.headAnchor ?? { x: 0, y: 0 } };
      },
      domUi: this.app.domUi,
      visible: () => this.canCombatControl && !this.stageOccluded && !this.app.ui.loadingState,
    });
    const mapNavigation = new NavigationWorld(map);
    mapNavigation.prepareTerrainRouting();
    this.movement = new MovementWorld(this, mapNavigation);
    for (const entity of this.entities) this.characters.push(this.createActor(entity));
    this.charactersRevision++;
    this.rebuildTriggerIndex();
    this.restoreDrainedSprings();
    this.refreshState();
    const appearance = equippedActor ?? this.app.session.character?.appearance ?? world.actors[campaign.start.actor];
    const revised = this.app.session.storyWorld.currentLocation;
    const requested =
      options.x >= 0 && options.y >= 0 && options.x < map.width && options.y < map.height
        ? { x: options.x, y: options.y }
        : revised && revised.map === map.id ? { x: revised.x, y: revised.y } : { x: options.x, y: options.y };
    const spawn =
      this.movement.navigation.nearestBody({ collision: appearance.collision }, requested) ??
      this.movement.navigation.nearest(appearance, requested);
    this.triggers.setExitTrigger(map.exits, spawn);
    this.entryInputGate = true;
    this.player = this.createActor({ id: 'player', actor: campaign.start.actor, ...spawn });
    this.applyNoclip(this.player);
    this.lastPlayerPosition = { ...spawn };
    this.facing = options.facing === 'any' ? 'south' : options.facing || 'south';
    const currentLocation = this.app.session.storyWorld.currentLocation;
    if (currentLocation?.map === map.id && (currentLocation.x !== spawn.x || currentLocation.y !== spawn.y)) {
      this.app.session.movePlayer({ map: map.id, ...spawn, facing: this.facing });
    }
    this.setClip(this.player, `idle-${this.facing}`);
    this.cameras.main.startFollow(this.player.container, true, 1, 1);
    const hero = this.app.session.hero;
    if (!hero) throw new Error('正式游戏缺少主角战斗数值');
    const drops = this.dropCatalog;
    if (!drops) throw new Error('掉落目录尚未就绪');
    const roster = new WorldEnemyRoster(
      this.app.session,
      map,
      (campaign.enemyPlacements ?? []).filter(enemy => enemy.map === map.id),
      hero.level,
      new QuestEnemyWatch(this.app.session, drops.questItems),
      Math.random,
    );
    if (options.preparedScene?.visit) {
      const prepared = structuredClone(options.preparedScene.visit);
      for (const enemy of prepared.roster.enemies) {
        const actor = options.preparedScene.actors.find(candidate => candidate.enemyKey === enemy.key);
        if (actor) Object.assign(enemy, { x: actor.x, y: actor.y });
      }
      roster.adoptPreparedState(prepared);
    }
    this.combat = new WorldCombat(this, this.app, roster, hero, drops);
    await this.combat.start({ restore: !!options.checkpoint });
    if (options.preparedScene) {
      this.restoreScenePositions(options.preparedScene);
      this.combat.adoptStoryPositions(options.preparedScene.actors);
    }
    signal.throwIfAborted();
    if (options.checkpoint) await this.combat.restoreState(options.checkpoint, signal);
    this.worldHud!.mountMinimap(map, this.app.storyInterface);
    this.resizeView();
    this.refreshState();
    this.unsubscribe = this.app.session.subscribe(() => this.refreshState());
    ui.drawPortrait = (actor, portrait, portraitSignal) => {
      const key = portrait === undefined ? (actor ? world.actors[actor]?.portrait : undefined) : portrait;
      return ui.portrait(key ? this.app.storyInterface.portraits[key] : undefined, portraitSignal);
    };
    this.loadingWorld = false;
    globalThis.storyDiagnostics?.record('start-phase', { phase: 'world-ready', map: map.id });
    this.app.director.onSkipProgress?.('objects-ready');
    this.syncStageOcclusion();
    this.app.audio?.enterMap(map.id);
    this.trimTextures();
    this.app.syncLifecycle?.();
    if (!this.app.checkpoint.available) this.captureEntryCheckpoint();
    options.onReady?.();
    if (!options.resumeStory) this.app.autoSave?.();
    this.lastProjectedLocation = JSON.stringify(this.app.session.storyWorld.currentLocation);
    this.app.session.setStoryWorldContext(() =>
      this.triggers.storyWorldContext(this.map, (this.combat?.controlledVisual ?? this.player)?.container, this.near, this.app.campaign));
    if (!options.silentEntry && !options.suppressEntry && plan.scripts.length) {
      try {
        await this.ensureStoryAssets(plan.scripts, signal);
      } catch (error) {
        signal.throwIfAborted();
        console.error(error);
        globalThis.storyDiagnostics?.record('story-entry-prefetch-failed', { map: map.id });
      }
    }
    const director = this.app.director;
    let entryStory: (() => Promise<boolean>) | undefined;
    if (!options.suppressEntry && !director.busy && this.openingPending()) {
      entryStory = () => director.start();
    } else if (!options.suppressEntry && !director.busy) {
      entryStory = () => director.enterMap(map.id);
    } else if (options.resumeStory && !director.busy) {
      entryStory = () => director.retry();
    }
    await this.readiness.holdEntryLoading(entryStory, ui, this.app.director, work => this.playStory(work));
    if (silentRequested) {
      this.app.ui.setWorldRebuildCover(false);
      globalThis.storyDiagnostics?.record('story-rebuild-cover-end', { map: map.id });
    }
  }

  /** 开场是否还没播完：以 start 事件的完成记录为准，不依赖内容里不存在的 flag。 */
  private openingPending(): boolean {
    const completed = this.app.session.runtimeState.completedEvents;
    return this.app.campaign.events.some(event => event.source === 'start' && !completed.includes(event.id));
  }

  loadAssets(needed: PendingAsset[]): Promise<AssetLease> {
    return loadSceneAssets(this, needed, { lifetime: 'manual' });
  }

  combatEnemyIds(): string[] { return this.prefetch.combatEnemyIds(); }
  ensureStoryAssets(scripts: readonly string[], signal: AbortSignal): Promise<void> { return this.prefetch.ensureStoryAssets(scripts, signal); }
  prefetchStoryEntry(mapId: string, script: string | undefined, signal: AbortSignal): Promise<void> { return this.prefetch.prefetchStoryEntry(mapId, script, signal); }
  prefetchMap(destination: string): void { this.prefetch.prefetchMap(destination); }
  prefetchVisibleExit(position: { x: number; y: number }, previous: { x: number; y: number }): void { this.prefetch.prefetchVisibleExit(position, previous); }

  changeEquipment(entry: string | undefined, slot: EquipmentSlot, signal?: AbortSignal, memberId = 'player'): Promise<void> {
    return this.outfits.changeEquipment(entry, slot, signal, memberId);
  }
  releasePartyPreview(): void { this.outfits.releasePartyPreview(); }
  previewAppearance(id: string): ActorDefinition | undefined { return this.outfits.previewAppearance(id); }
  preparePartyMember(id: string, signal?: AbortSignal, options?: { full?: boolean; pin?: boolean }): Promise<void> {
    return this.outfits.preparePartyMember(id, signal, options);
  }
  equipmentAppearance(id: string): ActorDefinition | undefined { return this.outfits.equipmentAppearance(id); }
  preparePlayerAppearance(): Promise<void> { return this.outfits.preparePlayerAppearance(); }
  projectEquipment(signal: AbortSignal): Promise<void> { return this.outfits.projectEquipment(signal); }

  async summonLampMerchant(entry: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const map = this.map;
    const movement = this.movement;
    const session = this.app.session;
    if (!map || !movement || !this.player || this.destroyed) throw new Error('当前地图无法召唤商人');
    const actor = this.app.world.actors[this.app.shops.lampShop];
    if (!actor) throw new Error('神灯商人素材缺失');
    const lease = await this.loadAssets(characterAssets(actor, characterSceneClips(actor)));
    let character: Character | undefined;
    try {
      signal.throwIfAborted();
      if (this.destroyed || this.map !== map || this.app.session !== session) throw new Error('当前地图已变化');
      const origin = this.controlledPosition();
      const navigation = movement.navigation;
      const point = navigation.nearestReachableBody(
        actor,
        origin,
        undefined,
        undefined,
        [],
        candidate => navigation.terrainFree(candidate) && Math.hypot(candidate.x - origin.x, candidate.y - origin.y) <= 64,
      );
      if (!point) throw new Error('附近没有可以召唤商人的空位');
      let serial = 1;
      while (session.storyWorld.entity(`lamp-merchant-${serial}`)) serial++;
      const entity: EntityPlacement & { map: string } = { id: `lamp-merchant-${serial}`, actor: actor.id, map: map.id, ...point };
      character = this.createActor(entity);
      movement.place(character, point);
      summonLampMerchant(session, entry, entity);
    } catch (error) {
      if (character) {
        movement.remove(character);
        character.container.destroy();
      }
      lease.release();
      throw error;
    }
    this.storyEntityAssets.push(lease);
    this.projectedActorIds.add(actor.id);
    this.characters.push(character);
    this.entities.push(character.entity);
    this.charactersRevision++;
    this.interactionRevision++;
    this.rebuildTriggerIndex();
    this.refreshState();
    this.syncHud();
  }

  createActor(entity: EntityPlacement): Character {
    const appearanceId = this.app.session.storyWorld.actorAppearance(entity.actor);
    const actor =
      entity.id === 'player'
        ? this.outfits.equippedActor ?? this.app.session.character?.appearance ?? this.app.world.actors[appearanceId]
        : this.app.world.actors[appearanceId];
    const character: Character = { ...createCharacter(this, actor, entity), marker: null };
    const facing =
      this.app.session.storyWorld.entity(entity.id)?.facing ??
      (entity.flip && actor.clips['idle-east'] ? 'east' : undefined);
    if (facing) this.setClip(character, `idle-${facing}`);
    const container = character.container;
    const player = entity.id === 'player';
    this.movement!.register(character, player, player, player ? 'party' : 'neutral');
    if (actor.chest) {
      const clip = actor.clips['idle-south']!;
      const left = -clip.frameWidth * (character.flipped ? 1 - clip.originX : clip.originX);
      container.setInteractive(
        new Phaser.Geom.Rectangle(left, -clip.frameHeight * clip.originY, clip.frameWidth, clip.frameHeight),
        Phaser.Geom.Rectangle.Contains,
      );
      container.on('pointerdown', (_pointer: Phaser.Input.Pointer, _x: number, _y: number, event: Phaser.Types.Input.EventData) => {
        event.stopPropagation();
        this.openChest(character);
      });
    }
    if (entity.id === 'player') {
      this.overheadStatus?.destroy();
      this.overheadStatus = new OverheadStatus(this, character, this.app.statusHud, () => this.app.session.player, listener =>
        this.app.session.subscribe(listener),
      );
      this.overheadStatus.setVisible(false);
    }
    return character;
  }

  /** 任务标记按需创建：任务可能在进图后才变为可接取，不能只在建角色时判断一次。 */
  createQuestMarker(character: Character): void {
    if (character.marker) return;
    character.marker = new QuestMarker(this);
    this.questMarkerCharacters.add(character);
    this.syncQuestMarker(character);
  }
  removeQuestMarker(character: Character): void {
    this.questMarkerCharacters.delete(character);
    character.marker?.destroy();
    character.marker = null;
  }
  /** 只同步有标记的角色：位置、透明度和显隐都跟着角色走，图标本身在世界高深度层。 */
  private syncQuestMarker(character: Character): void {
    const marker = character.marker;
    if (!marker) return;
    marker.retryTexture();
    marker.position(character.container.x, character.container.y);
    marker.setAlpha(character.container.alpha);
    marker.setVisible(character.container.visible && !this.stageOccluded);
  }
  updateQuestMarkerPositions(): void {
    if (!this.questMarkerCharacters.size) return;
    for (const character of this.questMarkerCharacters) this.syncQuestMarker(character);
  }
  setClip(character: Character, name: ClipName): void {
    setCharacterClip(this, character, name);
  }
  setPlayerIdleClip(): void {
    if (this.player) this.setClip(this.player, `idle-${this.facing}`);
  }

  refreshCombatHud(cooldowns?: Readonly<Record<string, Cooldown>>): void { this.shortcuts.refreshCombatHud(cooldowns); }
  refreshCombatHudIfTickChanged(): void { this.shortcuts.refreshIfTickChanged(); }
  refreshLoadout(): void { this.shortcuts.refreshLoadout(); }
  switchControlled(id: string): boolean {
    if (!this.canControl) return false;
    if (!this.combat?.switchControl(id)) return false;
    this.autoAttack.release();
    return true;
  }
  switchMember(direction: -1 | 1): void {
    if (!this.canControl) return;
    if (this.combat?.switchMember(direction)) this.autoAttack.release();
  }
  getControlLayoutPreview(): readonly ShortcutSlot[] { return this.worldHud?.snapshot() ?? []; }
  useShortcutItem(itemId: string): void { this.shortcuts.useItem(itemId); }

  /** 剧情摆放的宝箱是一次性奖励：开启后跨地图访问都保持已开启。 */
  private chestOpened(character: Character): boolean {
    if (!this.map || !character.actor.chest) return false;
    return this.app.session.chests.isOpened(
      this.map.id,
      character.entity.id,
      this.app.session.storyWorld.isPlaced(character.entity.id),
    );
  }
  private minimapInteractable(character: Character): boolean {
    const actor = character.actor;
    const entity = character.entity;
    return !!(
      actor.chest ||
      actor.service ||
      entity.spring ||
      this.app.shops?.shops[entity.actor] ||
      this.app.session.hasNearEvent?.(entity, this.map?.id)
    );
  }
  private showsInteractionMarker(
    character: Character,
    status: QuestStatus | null,
    marked: boolean,
    opened = this.chestOpened(character),
    consumed = this.legendarySwordConsumed(character),
  ): boolean {
    if (!character.container.visible || opened || consumed) return false;
    if (character.entity.spring && this.map && this.app.session.springs.isEmpty(this.map.id, character.entity.id)) return false;
    if (!this.minimapInteractable(character)) return false;
    return !hasQuestIcon(status, marked);
  }
  /** 宝箱开启、泉水喝空这类状态变化不触发整图刷新，单独更新小地图圆环。 */
  refreshMinimapInteractions(): void {
    const map = this.map;
    if (!map || !this.worldHud?.minimap) return;
    const session = this.app.session;
    const markers: MinimapInteraction[] = [];
    for (const character of this.characters) {
      const status = session.marker(character.entity.actor, character.entity.characterId);
      const marked = session.markerActor(character.entity.actor, character.entity.characterId);
      if (this.showsInteractionMarker(character, status, marked)) {
        markers.push({ id: character.entity.id, x: character.container.x, y: character.container.y });
      }
    }
    this.worldHud.minimap.updateInteractions(markers);
  }

  /** 任务完成和进度只在任务簿版本变化时对比；完成优先，同一轮不再发进度。 */
  noticeQuestChanges(): void {
    const version = this.app.session.questBook.version;
    if (version === this.questStatusVersion) return;
    const { snapshot, completions, progress } = questNotices(
      this.questStatuses,
      this.app.session.quests,
      id => this.app.session.definition(id),
    );
    this.questStatuses = snapshot;
    this.questStatusVersion = version;
    if (!this.questNoticesReady) {
      this.questNoticesReady = true;
      return;
    }
    for (const message of completions) this.app.ui.showInstant(message);
    if (!completions.length && progress) this.app.ui.showInstant(progress);
  }

  private rebuildTriggerIndex(): void {
    this.interactionRevision++;
    this.triggers.rebuildIndex(this.app.campaign, this.map?.id, this.characters);
    this.rebuildInteractionIndex();
  }
  private rebuildInteractionIndex(): void {
    const index = this.interactionIndex ?? (this.interactionIndex = new InteractionTargetIndex<Character>());
    index.rebuild(this.characters);
    this.interactionIndexRevision = this.interactionRevision;
    this.interactionIndexCharactersRevision = this.charactersRevision;
  }

  refreshStateSignature(): string {
    const session = this.app.session;
    return [
      this.map?.id ?? '',
      this.combat?.controlledId ?? 'player',
      this.charactersRevision,
      session.questBook?.version ?? 0,
      session.storyWorld?.revision ?? 0,
      session.chests?.revision ?? 0,
      session.legendaryWeapons?.revision ?? 0,
      session.runtimeRevision ?? (session.runtimeState?.sequence ?? 0) + (session.runtimeState?.completedEvents?.length ?? 0),
      session.bag?.revision ?? 0,
      session.money ?? 0,
      session.player?.level ?? 0,
      session.restorationVersion ?? 0,
    ].join('|');
  }

  refreshState(): void {
    this.refreshLoadout();
    const { session } = this.app;
    this.noticeQuestChanges();
    const stateSignature = this.refreshStateSignature() + (this.worldHud?.minimap ? '|minimap' : '');
    if (stateSignature === this.refreshStateSignatureValue) return;
    this.refreshStateSignatureValue = stateSignature;
    this.interactionRevision++;
    const taskMarkers: MinimapTask[] = [];
    const interactionMarkers: MinimapInteraction[] = [];
    for (const character of this.characters) {
      const opened = this.chestOpened(character);
      const consumed = this.legendarySwordConsumed(character);
      const present = !this.map || session.storyWorld.actorVisible(this.map.id, character.entity.actor, character.entity.characterId);
      const visible = present && session.visible(character.entity) && (!opened || this.chestFades.has(character.entity.id)) && !consumed;
      character.container.setVisible(visible);
      this.movement?.setEnabled(character, visible && !opened && !consumed);
      const status = session.marker(character.entity.actor, character.entity.characterId);
      const marked = session.markerActor(character.entity.actor, character.entity.characterId);
      const nearTalk =
        character.entity.id !== 'player' &&
        visible &&
        !opened &&
        !consumed &&
        !hasQuestIcon(status, marked) &&
        !!session.hasNearEvent?.(character.entity, this.map?.id);
      const markerFile =
        marked && status
          ? this.app.storyInterface.assets[`minimap-${status}`]
          : nearTalk
            ? this.app.storyInterface.assets['minimap-talk']
            : undefined;
      if (character.entity.id !== 'player' && !character.marker && markerFile) {
        this.createQuestMarker(character);
      }
      if (character.marker) {
        character.marker.setFile(markerFile);
        this.syncQuestMarker(character);
      }
      if (character.entity.id !== 'player' && visible && hasQuestIcon(status, marked)) {
        taskMarkers.push({ id: character.entity.id, x: character.container.x, y: character.container.y, status });
      }
      if (this.worldHud?.minimap && this.showsInteractionMarker(character, status, marked, opened, consumed)) {
        interactionMarkers.push({ id: character.entity.id, x: character.container.x, y: character.container.y });
      }
    }
    const map = this.map;
    if (!map) return;
    if (this.worldHud?.minimap) {
      if (this.player) this.worldHud.minimap.updatePlayer((this.combat?.controlledVisual ?? this.player).container);
      this.worldHud.minimap.updateTasks(taskMarkers);
      this.worldHud.minimap.updateInteractions(interactionMarkers);
    }
  }

  resizeView(): void {
    this.layoutHud();
    if (!this.map) return;
    const camera = this.cameras.main;
    const zoom = worldZoom(this);
    camera.setZoom(zoom).setRoundPixels(true);
    const width = Math.max(this.map.width, this.scale.width / zoom);
    const height = Math.max(this.map.height, this.scale.height / zoom);
    camera.setBounds((this.map.width - width) / 2, (this.map.height - height) / 2, width, height);
  }
  private layoutHud(): void { this.worldHud?.layout(this.scale.width, this.scale.height); }
  resetInput(): void {
    const controlled = this.combat?.controlledVisual ?? this.player;
    if (controlled && this.movement) this.movement.stop(controlled);
    this.combat?.setPaused(!this.canCombatControl);
    this.worldHud?.resetInput();
    this.syncHud();
  }
  trimTextures(): void {
    if (!this.mapAssets) return;
    this.app.retainMapAssets(this.mapAssets);
    this.mapAssets = undefined;
  }
  private recordFailure(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    const snapshot = this.diagnosticSnapshot();
    globalThis.storyDiagnostics?.record('world-failure', {
      message,
      stack: error instanceof Error ? error.stack : undefined,
      map: snapshot.map,
      player: snapshot.player,
      corrections: snapshot.corrections,
      storyExecution: error instanceof StoryExecutionBudgetError ? error.details : undefined,
    });
    return message;
  }
  failure(error: unknown): void {
    if (this.destroyed) return;
    console.error(error);
    this.app.ui.setWorldRebuildCover(false);
    this.app.ui.error(this.recordFailure(error), () => {
      const options = this.readiness.baseOptions ?? this.options;
      if (options) void this.readiness.restartWorld(options).catch(next => this.failure(next));
    });
  }

  attackKey(): void {
    if (!this.canControl) return;
    this.updateInteractionTarget();
    if (this.near && this.interact()) return;
    this.startBasicAttack();
  }
  private onPointerDown(pointer: Phaser.Input.Pointer, objects: Phaser.GameObjects.GameObject[]): void {
    if (pointer.button !== 0 || pointer.wasTouch || this.stageOccluded || !this.canControl) return;
    if (objects.some(object => object.getData('uiAction'))) return;
    if (objects.some(object => object.getData('enemy'))) {
      this.startBasicAttack();
      return;
    }
    this.attackKey();
  }
  startBasicAttack(): void {
    this.autoAttack.engage();
    this.combat?.attack();
  }
  offensiveSkillCompleted(actorId: string): void {
    if (this.canControl && this.combat?.controlledId === actorId) this.autoAttack.engageAfterSkill();
  }

  interact(): boolean {
    if (!this.canControl) return false;
    this.updateInteractionTarget();
    if (!this.near) return false;
    const target = this.near;
    const chest = !!target.actor.chest;
    const spring = !!target.entity.spring;
    const service = target.actor.service;
    const shop = !chest && !spring && !service ? !!this.app.shops.shops[target.entity.actor] : false;
    const nearEvent = !!this.app.session.hasNearEvent?.(target.entity, this.map?.id);
    const questSlot = service
      ? (this.takesQuestSlot(target.entity) || nearEvent)
      : shop && !target.entity.objective
        ? (this.takesQuestSlot(target.entity) || nearEvent)
        : false;
    const action = resolveInteraction({
      chest,
      spring,
      service,
      objective: !!target.entity.objective,
      questSlot,
      shop,
    });
    globalThis.storyDiagnostics?.record('interact', {
      action: action.kind,
      target: target.entity.id,
      actor: target.entity.actor ?? null,
      map: this.map?.id ?? null,
    }, false);
    this.turnToInteractionTarget(target);
    switch (action.kind) {
      case 'chest': this.openChest(target); return true;
      case 'spring': this.drinkSpring(target); return true;
      case 'crafting': this.app.openCrafting?.(target.actor.id); return true;
      case 'soul-healer':
        this.playStory(() => this.app.director.visitHealer(target.actor, () => this.combat?.reviveAtHealer()));
        return true;
      case 'legendary-sword': this.pullLegendarySword(target); return true;
      case 'innkeeper': this.restAtInnkeeper(target); return true;
      case 'shop': this.app.openShop(target.entity.actor, this.map?.id ?? ''); return true;
      case 'story': this.playStory(() => this.app.director.interact(target.entity, target.actor)); return true;
    }
  }
  private pullLegendarySword(target: Character): void {
    const map = this.map;
    const drops = this.dropCatalog;
    if (!map || !drops || this.app.session.legendaryWeapons.isPulled(map.id, target.entity.id)) return;
    this.playStory(async () => {
      const uniqueBonus = this.app.session.party?.groupModifiers()['ancient-legendary-chance'] ?? 0;
      const result = pullLegendaryWeapon(
        this.app.session,
        this.app.characterStats,
        drops,
        map.id,
        target.entity.id,
        map.lootLevel ?? 0,
        Math.random,
        { x: target.entity.x, y: target.entity.y },
        uniqueBonus,
      );
      if (result.success) this.app.audio?.effect('UI_Ground_sword');
      this.app.ui.showInstant(result.message);
      this.app.autoSave?.();
      this.checkpointStoryWorld();
      this.refreshState();
      this.updateInteractionTarget();
      this.syncHud();
      return true;
    });
  }
  private restAtInnkeeper(target: Character): void {
    const quote = innRestQuote(this.app.session);
    this.playStory(() =>
      this.app.director.visitInnkeeper(target.actor, quote, () => {
        payForInnRest(this.app.session, quote);
        this.app.autoSave?.();
        this.checkpointStoryWorld();
        this.app.ui.showInstant('已恢复全部的生命和魔法。');
        this.syncHud();
      }),
    );
  }
  private legendarySwordConsumed(character: Character): boolean {
    return character.actor.service === 'legendary-sword' && !!this.map && this.app.session.legendaryWeapons.isPulled(this.map.id, character.entity.id);
  }
  private takesQuestSlot(entity: EntityPlacement): boolean {
    const quest = this.app.session.npcQuestSlot(entity.actor, entity.characterId);
    return !!quest && ['available', 'ready'].includes(this.app.session.status(quest.id));
  }
  controlledPosition(): { x: number; y: number } {
    return this.combat?.controlledVisual?.container ?? this.player?.container ?? { x: 0, y: 0 };
  }
  private turnToInteractionTarget(target: Character): void {
    const facing = faceTarget(this.controlledPosition(), target.container);
    if (this.combat) this.combat.facing = facing;
    else this.facing = facing;
  }
  drainSpring(character: Character): void {
    const empty = this.springCatalog?.empty;
    const actor = empty ? this.app.world.actors[empty] : undefined;
    if (!actor) throw new Error('泉水缺少喝空后的外观');
    character.actor = actor;
    this.movement?.refreshShape(character);
    this.interactionRevision++;
    setCharacterClip(this, character, 'idle-south', true);
  }
  private restoreDrainedSprings(): void {
    if (!this.map) return;
    const empty = this.springCatalog?.empty;
    if (!empty) return;
    for (const character of this.characters) {
      if (character.entity.spring && character.actor.id !== empty && this.app.session.springs.isEmpty(this.map.id, character.entity.id)) {
        this.drainSpring(character);
      }
    }
  }
  private springPartyMembers(): SpringPartyResources[] {
    const party = this.app.session.party;
    if (party) return party.activeMembers;
    const hero = this.app.session.hero;
    if (!hero) return [];
    return [{
      id: 'player',
      get player() { return hero.player; },
      setHealth: (value: number) => hero.setHealth(value),
      setMana: (value: number) => hero.setMana(value),
      grantSkillPoint: () => hero.grantSkillPoint(),
    }];
  }
  private drinkSpring(spring: Character): void {
    const catalog = this.springCatalog;
    const map = this.map;
    const controlled = this.combat?.controlledVisual ?? this.player;
    if (!catalog || !map || !controlled || !spring.container.visible) return;
    if (!canReachChest(controlled.container, spring.container)) return;
    const effect = rollSpringEffect(catalog, spring.entity.actor, Math.random);
    if (effect.kind === 'buff') {
      if (effect.buff) this.combat?.applySpringBuff(effect.buff, springBuffScope(effect.buff));
    } else if (effect.kind === 'heal' || effect.kind === 'heal-mana') {
      applySpringRecovery(effect, this.springPartyMembers());
    } else if (effect.kind === 'skill-point') {
      grantSpringSkillPoint(this.springPartyMembers());
    }
    if (effect.kind === 'spawn' && effect.enemy) {
      this.app.session.chests.spawnEnemy(map.id, spring.entity.id, effect.enemy, spring.container);
    }
    this.app.audio?.ui('heal');
    this.app.ui.showInstant(effect.text);
    this.app.session.springs.drain(map.id, spring.entity.id);
    this.drainSpring(spring);
    this.refreshMinimapInteractions();
    this.updateInteractionTarget();
    this.syncHud();
  }
  openChest(character: Character): void {
    const controlled = this.combat?.controlledVisual ?? this.player;
    const kind = character.actor.chest;
    const map = this.map;
    if (
      !this.canCombatControl ||
      this.combat?.playerCannotAct() ||
      !controlled ||
      !kind ||
      !map ||
      !character.container.visible ||
      !canReachChest(controlled.container, character.container)
    ) {
      return;
    }
    if (!this.dropCatalog) throw new Error('宝箱缺少地图掉落数据');
    const position = character.container;
    const opened = this.app.session.openChest({
      map,
      entity: character.entity.id,
      kind,
      position,
      catalog: this.dropCatalog,
      stats: this.app.characterStats,
      landing: () => this.lootLanding(map.id, position.x, position.y),
    });
    if (!opened) return;
    character.container.disableInteractive();
    this.movement!.setEnabled(character, false);
    this.app.audio?.ui('chestOpen');
    this.refreshGroundLoot();
    this.combat?.syncChestEnemies();
    const tween = this.tweens.add({
      targets: character.container,
      alpha: 0,
      duration: CHEST_OPEN_MS,
      ease: (value: number) => Math.floor(value * 10) / 10,
      onComplete: () => {
        this.chestFades.delete(character.entity.id);
        character.container.setVisible(false);
        this.interactionRevision++;
      },
    });
    this.chestFades.set(character.entity.id, tween);
    this.refreshMinimapInteractions();
    this.updateInteractionTarget();
    this.syncHud();
  }

  private playStory(work: () => Promise<boolean>): Promise<boolean> {
    return work().catch(error => {
      console.error(error);
      this.app.ui.error(this.recordFailure(error), () => {
        this.app.ui.loaded();
        void this.recoverWorld()
          .then(() => {
            if (!this.destroyed) return this.playStory(() => this.app.director.retry());
            return false;
          })
          .catch(next => this.failure(next));
      });
      return false;
    });
  }

  prepareToLeaveWorld(): void { this.combat?.settleForSave(); this.combat?.finishMapVisit(); }
  discardWorldWork(): void { this.combat?.discardPendingDefeats(); }
  useRecoveryItem(entry: string, memberId?: string): RecoveryResult {
    return this.combat?.useRecoveryItem(entry, memberId) ?? { used: false, reason: 'unavailable' };
  }
  changeMap(exit: MapExit): void {
    if (this.loadingWorld || !this.exitAvailable(exit)) return;
    this.prepareToLeaveWorld();
    this.app.session.applyStoryCommands([
      { type: 'travel', destination: { map: exit.destination, ...exit.spawn, facing: exit.facing === 'any' ? 'south' : exit.facing } },
    ]);
    this.loadingWorld = true;
    this.near = null;
    this.app.ui.loading('正在前往新的地方…');
    this.beginWorldSwitch();
    this.scene.restart({ map: exit.destination, x: exit.spawn.x, y: exit.spawn.y, facing: exit.facing });
  }
  get canControl(): boolean {
    return (
      this.sys.isActive() &&
      !this.loadingWorld &&
      this.app.ui.ready &&
      !this.app.ui.controlLayoutEditing &&
      !this.app.ui.keyBindingEditing &&
      !this.app.locked &&
      !this.app.suspended &&
      !this.app.director?.busy
    );
  }
  get canCombatControl(): boolean { return this.canControl; }
  combatAttribute(id: string, attribute: BattleStatKey, base: number, passives: readonly PassiveModifier[]): number {
    return this.combat?.effectiveAttribute(id, attribute, base, passives) ?? base;
  }
  combatStealthed(id: string): boolean { return this.combat?.stealthed(id) ?? false; }

  diagnosticSnapshot() {
    const player = this.player;
    const movement = this.movement;
    let placement: Record<string, unknown> | null = null;
    const moveState = player && movement ? movement.state(player) : undefined;
    if (player && movement && moveState) {
      const foot = movement.position(player);
      const actor = movement.actor(player);
      const shape = actor.shape();
      const navigation = movement.navigation;
      const box = collisionAt(shape, foot) ?? null;
      const terrainFree = navigation.terrainFree(foot);
      const bodyTerrainFree = navigation.bodyTerrainFree(shape, foot);
      const inWall = !terrainFree || !bodyTerrainFree;
      placement = {
        foot,
        box,
        terrainFree,
        bodyTerrainFree,
        blockedByActors: bodyTerrainFree && !navigation.canPlaceBody(shape, foot, actor),
        nearestBody: inWall && shape.collision ? navigation.nearestBody(shape, foot, actor) ?? null : null,
        inWall,
        move: moveState,
      };
    }
    return {
      map: this.map?.id,
      loading: this.loadingWorld,
      scene: { time: this.time.now, active: this.sys.isActive(), paused: this.sys.isPaused() },
      suspended: this.app.suspended,
      locked: this.app.locked,
      directorBusy: !!this.app.director?.busy,
      canControl: this.canControl,
      canCombatControl: this.canCombatControl,
      mapBounds: movement?.navigation.bounds ?? null,
      target: this.combat?.targetId,
      near: this.near?.entity.id ?? null,
      player: player ? { x: player.container.x, y: player.container.y, clip: player.clipName, facing: this.facing, ...placement } : null,
      corrections: movement?.terrainCorrections ?? [],
      combat: this.combat?.diagnostics() ?? null,
    };
  }

  refreshGroundLoot(): void { this.loot.refresh(); }
  lootLanding(map: string, x: number, y: number): { x: number; y: number } { return this.loot.landing(map, x, y); }
  receiveGroundReward(reward: DropReward): boolean { return this.loot.receiveReward(reward); }
  collectGroundLoot(position: { x: number; y: number }): void {
    this.loot.collectNearby(position, reward => this.receiveGroundReward(reward));
  }
  collectMapGroundLoot(): void { this.loot.collectAllOnMap(reward => this.receiveGroundReward(reward)); }

  refreshCombatTarget(): void { this.worldHud?.setTarget(this.combat?.targetStatus()); }
  revivePartyMember(id: string, item: string): ItemResult {
    if (!this.combat) throw new Error('请等待地图加载');
    return this.combat.revive(id, item);
  }
  syncControlledCharacter(resetExitTrigger = false): void {
    const actor = this.combat?.controlledVisual ?? this.player;
    this.applyNoclip(actor);
    if (actor?.container.active) this.cameras.main.startFollow(actor.container, true, 1, 1);
    this.lastPlayerPosition = actor ? this.movement?.position(actor) : undefined;
    if (resetExitTrigger && this.map && this.lastPlayerPosition) {
      this.triggers.setExitTrigger(this.map.exits, this.lastPlayerPosition);
    }
    this.shortcuts.refreshLoadout();
    this.refreshCombatTarget();
    this.syncHud();
  }

  rescuePlayer(): { ok: boolean; reason?: string; from?: { x: number; y: number }; to?: { x: number; y: number }; moved?: boolean } {
    const visual = this.combat?.controlledVisual ?? this.player;
    if (!visual || !this.movement || !this.map) return { ok: false, reason: '地图尚未加载' };
    const actor = this.movement.actor(visual);
    const shape = actor.shape();
    const navigation = this.movement.navigation;
    const from = this.movement.position(visual);
    const exit = this.map.exits[0];
    const anchor = exit ? { x: exit.x + exit.width / 2, y: exit.y + exit.height / 2 } : undefined;
    const inMain = !anchor || navigation.sameTerrainRegion(from, anchor);
    if (navigation.terrainFree(from) && navigation.bodyTerrainFree(shape, from) && navigation.canStand(actor, from) && inMain) {
      return { ok: true, moved: false, from };
    }
    const recovered = this.movement.recoverContent(visual);
    if (recovered && (!anchor || navigation.sameTerrainRegion(recovered.to, anchor))) {
      this.combat?.stopMoving();
      this.syncControlledCharacter(true);
      return { ok: true, moved: true, from: recovered.from, to: recovered.to };
    }
    const landing = anchor
      ? navigation.nearestSettledBody(shape, anchor, actor, [], point => navigation.sameTerrainRegion(anchor, point))
      : navigation.nearestBody(shape, from, actor) ?? navigation.nearestReachableBody(shape, from, undefined, actor);
    if (!landing) return { ok: false, reason: '附近没有可站的整盒落点', from };
    try {
      this.movement.place(visual, landing);
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error), from };
    }
    this.combat?.stopMoving();
    this.syncControlledCharacter(true);
    return { ok: true, moved: true, from, to: landing };
  }

  private applyNoclip(actor: CharacterVisual | undefined): void {
    if (!this.movement) return;
    const previous = this.noclipVisual;
    if (previous && (previous !== actor || !this.app.gmNoclip)) this.movement.setNoclip(previous, false);
    this.noclipVisual = this.app.gmNoclip && actor ? actor : undefined;
    if (this.noclipVisual) this.movement.setNoclip(this.noclipVisual, true);
  }
  setNoclip(enabled: boolean): { ok: boolean } {
    this.app.gmNoclip = enabled;
    this.applyNoclip(this.combat?.controlledVisual ?? this.player);
    return { ok: true };
  }
  setSpeedMultiplier(multiplier: number): { ok: boolean } {
    this.app.gmSpeedMultiplier = multiplier;
    return { ok: true };
  }
  setInvincible(actorId: string, enabled: boolean): { ok: boolean; reason?: string } {
    if (!this.app.session.hero) return { ok: false, reason: '当前会话没有角色系统' };
    this.app.session.setInvincible(actorId, enabled);
    return { ok: true };
  }
  setInfiniteMana(actorId: string, enabled: boolean): { ok: boolean; reason?: string } {
    if (!this.app.session.hero) return { ok: false, reason: '当前会话没有角色系统' };
    this.app.session.setInfiniteMana(actorId, enabled);
    return { ok: true };
  }
  setOneHitKill(actorId: string, enabled: boolean): { ok: boolean; reason?: string } {
    if (!this.app.session.hero) return { ok: false, reason: '当前会话没有角色系统' };
    this.app.session.setOneHitKill(actorId, enabled);
    return { ok: true };
  }
  reviveMember(id: string): { ok: boolean; reason?: string } {
    const session = this.app.session;
    const member = id === 'player' ? session.hero : session.party?.get(id);
    if (!member) return { ok: false, reason: `没有上阵角色：${id}` };
    member.clearCombatResourceLimits();
    member.setHealth(member.player.maxHealth);
    member.setMana(member.player.maxMana);
    this.combat?.reviveForDebug(id);
    return { ok: true };
  }

  async startPressureSpawner(): Promise<void> {
    if (!this.app.pressureMode || this.pressureSpawner || !this.combat) return;
    const combat = this.combat;
    const signal = this.request.signal;
    let pending = false;
    const spawn = async (point?: { x: number; y: number }) => {
      if (pending || signal.aborted || this.destroyed || !this.app.pressureMode || !combat.canSpawnPressureEnemy()) return;
      const enemy = pressureEnemy(this.app.battleCatalog.enemies, this.app.session.hero?.level ?? 1);
      if (!enemy) return;
      pending = true;
      try {
        if ((await combat.preparePressureEnemy(enemy.id, signal)) && !signal.aborted && !this.destroyed && !this.scene?.isPaused()) {
          combat.spawnPressureEnemy(enemy.id, point);
        }
      } catch (error) {
        if (!signal.aborted) console.error('挑战怪物加载失败', error);
      } finally {
        pending = false;
      }
    };
    for (const point of this.pressureStartPoints) {
      if (signal.aborted) break;
      await spawn(point);
    }
    if (signal.aborted || this.destroyed || !this.app.pressureMode) return;
    this.pressureSpawner = this.time.addEvent({ delay: PRESSURE_SPAWN_INTERVAL_MS, loop: true, callback: () => { void spawn(); } });
  }
  applyPressureSettings(options?: { applyHealth?: boolean }): void {
    if (!this.app.pressureMode || this.destroyed) return;
    this.combat?.applyPressureSettings(options);
  }
  pressureEnemyCount(): number {
    return this.app.pressureMode && !this.destroyed ? (this.combat?.pressureEnemyCount() ?? 0) : 0;
  }

  captureCheckpoint(): boolean {
    if (this.app.pressureMode) return false;
    const waitingOnMap = this.map
      ? (this.app.session.hasWaitingEncounterOnMap?.(this.map.id) ?? this.app.session.hasWaitingStoryRun)
      : this.app.session.hasWaitingStoryRun;
    if (this.app.checkpoint.available && waitingOnMap) {
      if (!this.checkpointWaitLogged) {
        this.checkpointWaitLogged = true;
        globalThis.storyDiagnostics?.record('checkpoint-kept-waiting-encounter', { map: this.map?.id });
      }
      return false;
    }
    this.checkpointWaitLogged = false;
    if (!this.worldReady() || !this.combat) return false;
    if (!this.app.session.hasLivingMember) {
      globalThis.storyDiagnostics?.record('checkpoint-skipped-no-survivor', { map: this.map!.id });
      return false;
    }
    this.combat.settleForSnapshot();
    if (!this.app.checkpoint.capture(this.app.session, { map: this.map!.id, ...this.movement!.position(this.player!) }, this.captureStoryWorld())) {
      return false;
    }
    this.checkpointPending = false;
    return true;
  }
  captureEntryCheckpoint(): void { this.checkpointPending = !this.captureCheckpoint(); }
  checkpointStoryWorld(): void { this.captureCheckpoint(); }

  async normalizeForStory(signal: AbortSignal): Promise<void> {
    this.resetInput();
    await this.combat?.normalizeForStory(signal);
    signal.throwIfAborted();
    this.collectMapGroundLoot();
  }

  captureStoryScene(includeActorAppearance = true): SceneSnapshot {
    if (!this.worldReady()) throw new Error('正式地图尚未就绪');
    const map = this.map!;
    const movement = this.movement!;
    const { session } = this.app;
    const actors: SceneActorState[] = [this.player!, ...this.characters.filter(character => character !== this.player)].map(character => {
      const player = character === this.player;
      const visible =
        session.storyWorld.actorVisible(map.id, character.entity.actor, character.entity.characterId) &&
        session.visible(character.entity) &&
        !this.chestOpened(character) &&
        !this.legendarySwordConsumed(character);
      const facing = player ? this.facing : character.facing ?? undefined;
      const animation = characterAnimationState(character);
      return {
        id: player ? 'player' : `entity:${character.entity.id}`,
        actor: character.entity.actor,
        characterId: character.entity.characterId,
        worldEntityId: player ? undefined : character.entity.id,
        authority: player ? undefined : character.entity.authority,
        memberId: player ? 'player' : undefined,
        townPose: player ? this.outfits.playerTownPose : undefined,
        ...movement.position(character),
        facing: facing ?? 'south',
        visible,
        flip: character.entity.flip,
        ...(includeActorAppearance ? { appearance: storyDevMode() ? freezeSnapshot(character.actor) : character.actor } : {}),
        clip: character.clipName ?? undefined,
        alpha: character.container.alpha,
        animationProgress: animation.progress,
        animationPlaying: animation.playing,
      };
    });
    const visit = this.combat?.captureStoryVisit();
    return {
      map: map.id,
      actors: [...actors, ...(this.combat?.captureStoryActors(includeActorAppearance) ?? [])],
      ...(visit ? { visit: { generatedEntities: structuredClone(this.baseEntities), ...visit } } : {}),
    };
  }

  restoreTriggerContacts(contacts: StoryWorldViewSnapshot['triggerContacts']): void {
    this.triggers.restoreContacts(contacts);
  }

  captureStoryWorld(includeActorAppearance = true): StoryWorldViewSnapshot {
    if (!this.worldReady()) throw new Error('正式地图尚未就绪');
    return {
      location: { map: this.map!.id, ...this.movement!.position(this.player!), facing: this.facing },
      world: this.combat?.captureState(),
      generatedEntities: structuredClone(this.baseEntities),
      triggerContacts: this.triggers.captureContacts(),
      scene: this.captureStoryScene(includeActorAppearance),
      audio: this.app.audio?.captureStoryAudio(),
    };
  }

  captureSaveWorld(): SaveWorldResult {
    if (this.app.pressureMode) return { ok: false, reason: 'pressure' };
    if (!this.worldObjectsReady || this.destroyed) return { ok: false, reason: 'not-ready' };
    if (this.loadingWorld || this.app.ui.loadingState) return { ok: false, reason: 'loading' };
    if (!this.app.session.hasLivingMember) {
      globalThis.storyDiagnostics?.record('save-refused-no-survivor', { map: this.map!.id });
      return { ok: false, reason: 'no-survivors' };
    }
    this.combat?.settleForSave();
    return { ok: true, map: { id: this.map!.id, name: this.map!.name }, world: this.captureStoryWorld(false) };
  }

  restartStoryWorld(
    location: TravelDestination,
    signal: AbortSignal,
    options: Pick<SceneOptions, 'checkpoint' | 'generatedEntities' | 'silentEntry' | 'preparedScene' | 'triggerContacts'>,
  ): Promise<void> {
    return this.readiness.restartStoryWorld({ ...location, ...options, suppressEntry: true }, signal);
  }

  restoreScenePositions(snapshot: SceneSnapshot): void {
    if (snapshot.map !== this.map?.id || !this.movement) return;
    const pose = snapshot.actors.find(actor => actor.id === 'player')?.townPose;
    this.outfits.adoptSceneTownPose(pose);
    const placements: { visual: CharacterVisual; position: { x: number; y: number }; enabled: boolean }[] = [];
    for (const actor of snapshot.actors) {
      if (!actor.worldEntityId || actor.removed || actor.unpositioned) continue;
      const character = this.characters.find(entry => entry.entity.id === actor.worldEntityId);
      if (!character) continue;
      if (actor.appearance) {
        character.actor = structuredClone(actor.appearance);
        this.movement.refreshShape(character);
      }
      this.setClip(character, `idle-${actor.facing}`);
      character.container.setAlpha(actor.alpha ?? 1).setVisible(actor.visible);
      placements.push({ visual: character, position: { x: actor.x, y: actor.y }, enabled: actor.visible });
    }
    this.movement.placeAll(placements, { evictOccupied: true, displaceable: this.player ? [this.player] : [] });
    this.interactionRevision++;
    this.rebuildInteractionIndex();
    this.refreshMinimapInteractions();
  }

  async restoreStoryWorld(snapshot: unknown, signal: AbortSignal): Promise<void> {
    const state = snapshot as StoryWorldViewSnapshot;
    if (!state?.location?.map) throw new Error('正式剧情世界快照无效');
    signal.throwIfAborted();
    this.discardWorldWork();
    this.triggers.encounterResults.clear();
    if (this.map?.id === state.location.map && !this.loadingWorld) {
      this.baseEntities = structuredClone(state.generatedEntities);
      await this.projectStoryWorld(undefined, signal, state.location);
      if (state.world) await this.combat?.restoreState(state.world, signal);
      if (state.scene) {
        this.restoreScenePositions(state.scene);
        await this.projectEquipment(signal);
      }
      this.restoreTriggerContacts(state.triggerContacts);
      signal.throwIfAborted();
      if (state.audio) this.app.audio?.restoreStoryAudio(state.audio);
      this.syncControlledCharacter(true);
      return;
    }
    await this.restartStoryWorld(state.location, signal, {
      checkpoint: state.world,
      generatedEntities: state.generatedEntities,
      preparedScene: state.scene,
      triggerContacts: state.triggerContacts,
    });
    signal.throwIfAborted();
    if (state.audio) this.app.audio?.restoreStoryAudio(state.audio);
  }

  settleStoryPlayback(): void {
    if (!this.worldReady() || this.stageOccluded || !this.combat) return;
    if (this.app.ui?.mode !== 'game' || this.app.suspended) return;
    if (this.app.director?.busy) return;
    this.combat.settleFriendlyUnitsAroundHero();
  }

  async projectStoryWorld(stage: StoryStageSnapshot | undefined, signal: AbortSignal, restoredLocation?: TravelDestination): Promise<void> {
    signal.throwIfAborted();
    const location = this.app.session.storyWorld.currentLocation;
    const signature = JSON.stringify(location);
    if (location && location.map !== this.map?.id) {
      signal.throwIfAborted();
      const stageScene = this.scene.get?.(SCENE_KEYS.storyStage) as { worldCovered?: boolean } | undefined;
      const covered = stageScene?.worldCovered === true;
      if (!covered) {
        this.app.ui.setWorldRebuildCover(true);
        globalThis.storyDiagnostics?.record('story-rebuild-cover', { map: location.map });
      }
      const prepared = stage?.scene.map === location.map ? stage.scene : undefined;
      try {
        this.combat?.finishMapVisit();
        await this.restartStoryWorld(location, signal, { silentEntry: true, preparedScene: prepared });
      } catch (error) {
        if (!covered) this.app.ui.setWorldRebuildCover(false);
        throw error;
      }
      return;
    }
    if (location && !this.worldReady()) await this.recoverWorld(signal);
    if (!this.worldReady()) throw new Error('正式地图尚未就绪');
    this.app.director.onSkipProgress?.('assets-start');
    const projected = this.app.session.storyWorld.projectEntities(
      this.map!.id,
      resolveMapActors({ base: this.baseEntities, map: this.map!, campaign: this.app.campaign, active: entity => this.app.session.visible(entity) }),
      this.app.campaign.placements,
    );
    const projectedActors = projected.map(entity => this.app.session.storyWorld.actorAppearance(entity.actor));
    if (projected.some(entity => entity.spring) && this.springCatalog) projectedActors.push(this.springCatalog.empty);
    const needed = [...new Set(projectedActors)].filter(id => !this.projectedActorIds.has(id));
    if (needed.length) {
      const lease = await this.loadAssets(
        needed.flatMap(id => {
          const actor = this.app.world.actors[id];
          if (!actor) throw new Error(`剧情角色资源缺失：${id}`);
          return characterAssets(actor, characterSceneClips(actor));
        }),
      );
      if (signal.aborted || this.destroyed) {
        lease.release();
        signal.throwIfAborted();
        throw new Error('正式地图已经关闭');
      }
      this.storyEntityAssets.push(lease);
      for (const id of needed) this.projectedActorIds.add(id);
    }
    const projectedIds = new Set(projected.map(entity => entity.id));
    for (const character of [...this.characters]) {
      if (!projectedIds.has(character.entity.id)) {
        this.movement!.remove(character);
        this.removeQuestMarker(character);
        character.container.destroy();
        this.characters.splice(this.characters.indexOf(character), 1);
      }
    }
    for (const entity of projected) {
      const old = this.characters.find(character => character.entity.id === entity.id);
      if (old && old.actor.id !== this.app.session.storyWorld.actorAppearance(entity.actor)) {
        this.movement!.remove(old);
        this.removeQuestMarker(old);
        old.container.destroy();
        this.characters.splice(this.characters.indexOf(old), 1);
      }
      const character = this.characters.find(entry => entry.entity.id === entity.id) ?? this.createActor(entity);
      if (!this.characters.includes(character)) this.characters.push(character);
      character.entity = { ...entity };
      const facing = this.app.session.storyWorld.entity(entity.id)?.facing;
      if (facing) this.setClip(character, `idle-${facing}`);
    }
    this.charactersRevision++;
    this.restoreDrainedSprings();
    const positions = this.characters.map(character => ({
      visual: character,
      position: { x: character.entity.x, y: character.entity.y },
      enabled: this.app.session.visible(character.entity),
    }));
    const playerLocation = restoredLocation ?? (location && signature !== this.lastProjectedLocation ? location : undefined);
    if (playerLocation) positions.push({ visual: this.player!, position: playerLocation, enabled: true });
    this.movement!.placeAll(positions, { evictOccupied: true, displaceable: [this.player!] });
    if (playerLocation) {
      this.facing = playerLocation.facing;
      this.setClip(this.player!, `idle-${this.facing}`);
      this.lastProjectedLocation = signature;
    }
    this.entities = projected;
    await this.combat?.projectStoryEnemies(signal);
    this.app.director.onSkipProgress?.('assets-ready');
    const nextTownPose =
      stage && stage.scene.map === this.map?.id
        ? stage.scene.actors.find(actor => actor.id === 'player')?.townPose
        : this.outfits.playerTownPose;
    this.outfits.adoptSceneTownPose(nextTownPose);
    await this.projectEquipment(signal);
    this.app.director.onSkipProgress?.('outfit-ready');
    signal.throwIfAborted();
    if (playerLocation) {
      if (!restoredLocation) this.combat?.regroupPartyAroundHero();
      this.syncControlledCharacter(true);
    }
    if (stage?.scene.map === this.map!.id) this.combat?.adoptStoryPositions(stage.scene.actors);
    this.rebuildTriggerIndex();
    this.refreshState();
    this.syncHud();
  }

  exitAvailable(exit: MapExit): boolean {
    return this.triggers.exitAvailable(this.map, exit, this.app.session, this.app.campaign);
  }

  handleCombatDefeat(): void { this.showCombatDefeat(); }
  private showCombatDefeat(): void {
    this.app.ui.showDefeat({
      load: () => this.app.openDefeatLoad?.() ?? false,
      restore: async () => {
        const checkpoint = this.app.checkpoint.peek();
        if (!checkpoint) throw new Error('没有可恢复的检查点');
        if (!hasLivingParty(checkpoint.session)) throw new Error('检查点里没有可战斗的队员');
        const signal = this.app.storySignal ?? this.request.signal;
        signal.throwIfAborted();
        this.resetInput();
        this.app.director.cancel();
        this.discardWorldWork();
        const world = checkpoint.world.world
          ? {
              ...checkpoint.world,
              world: prepareCombatRestore(
                checkpoint.world.world,
                this.app.battleCatalog,
                checkpoint.session.party?.slots.filter((id): id is string => !!id) ?? [],
              ),
            }
          : checkpoint.world;
        this.app.session.restoreState(checkpoint.session);
        await this.restoreStoryWorld(world, signal);
        signal.throwIfAborted();
        this.app.ui.closeDefeat();
        this.playStory(() => this.app.director.retry());
      },
    });
  }

  syncHud(): void {
    const enabled = this.canControl;
    const backgroundVisible =
      enabled || (this.sys.isActive() && !this.loadingWorld && this.app.ui.ready && this.app.ui.controlLayoutEditing && !this.app.suspended);
    this.overheadStatus?.setVisible(backgroundVisible);
    this.app.domUi?.setLayerVisible('world', backgroundVisible && !this.stageOccluded);
    const target = this.near?.container.visible ? this.near : null;
    const tick = this.app.session?.combatTick;
    const actorId = target?.entity.id ?? '';
    let targetStatus: ReturnType<WorldCombat['targetStatus']>;
    let hostile: boolean;
    if (tick === undefined) {
      targetStatus = this.combat?.targetStatus?.();
      hostile = !!this.combat?.hasHostileTarget?.();
    } else {
      let targetCache = this.targetStatusCache;
      if (!targetCache || targetCache.tick !== tick || targetCache.actor !== actorId) {
        targetCache = { tick, actor: actorId, status: this.combat?.targetStatus?.(), hostile: !!this.combat?.hasHostileTarget?.() };
        this.targetStatusCache = targetCache;
      }
      targetStatus = targetCache.status;
      hostile = targetCache.hostile;
    }
    this.worldHud?.sync({
      enabled,
      backgroundVisible,
      targetName: target ? target.entity.name || target.actor.name : null,
      hasTarget: !!target,
      hostile,
      targetStatus,
    });
    const signature = `${enabled}|${target?.entity.id ?? ''}|${hostile}|${targetStatus ? `${targetStatus.id}|${targetStatus.name}|${targetStatus.level}|${targetStatus.health}/${targetStatus.maxHealth}|${targetStatus.sceneLevel}` : ''}`;
    if (signature === this.hudSignature) return;
    this.hudSignature = signature;
    for (const tween of this.chestFades.values()) {
      if (enabled) tween.resume(); else tween.pause();
    }
  }

  updateInteractionTarget(): void {
    const controlled = this.combat?.controlledVisual ?? this.player;
    if (!controlled) {
      this.near = null;
      this.lastInteractionScan = undefined;
      return;
    }
    const session = this.app.session;
    const x = controlled.container.x;
    const y = controlled.container.y;
    const revision = this.interactionRevision;
    const quest = session.questBook?.version ?? 0;
    const story = session.storyWorld?.revision ?? 0;
    const chests = session.chests?.revision ?? 0;
    const legendary = session.legendaryWeapons?.revision ?? 0;
    const restore = session.restorationVersion ?? 0;
    const runtime =
      session.runtimeRevision ??
      (session.runtimeState?.sequence ?? 0) + (session.runtimeState?.completedEvents?.length ?? 0);
    const bag = session.bag?.revision ?? 0;
    const money = session.money ?? 0;
    const level = session.player?.level ?? 0;
    const map = this.map?.id ?? '';
    const owner = this.combat?.controlledId ?? 'player';
    const scan =
      this.lastInteractionScan ??
      (this.lastInteractionScan = {
        x: Number.NaN,
        y: Number.NaN,
        revision: -1,
        quest: -1,
        story: -1,
        chests: -1,
        legendary: -1,
        restore: -1,
        runtime: -1,
        bag: -1,
        money: -1,
        level: -1,
        map: '',
        owner: '',
      });
    if (
      x === scan.x &&
      y === scan.y &&
      revision === scan.revision &&
      quest === scan.quest &&
      story === scan.story &&
      chests === scan.chests &&
      legendary === scan.legendary &&
      restore === scan.restore &&
      runtime === scan.runtime &&
      bag === scan.bag &&
      money === scan.money &&
      level === scan.level &&
      map === scan.map &&
      owner === scan.owner
    ) {
      return;
    }
    scan.x = x;
    scan.y = y;
    scan.revision = revision;
    quest === scan.quest || (scan.quest = quest);
    scan.story = story;
    scan.chests = chests;
    scan.legendary = legendary;
    scan.restore = restore;
    scan.runtime = runtime;
    scan.bag = bag;
    scan.money = money;
    scan.level = level;
    scan.map = map;
    scan.owner = owner;
    let index = this.interactionIndex;
    if (!index || this.interactionIndexRevision !== revision || this.interactionIndexCharactersRevision !== this.charactersRevision) {
      index = this.interactionIndex = new InteractionTargetIndex<Character>();
      index.rebuild(this.characters);
      this.interactionIndexRevision = revision;
      this.interactionIndexCharactersRevision = this.charactersRevision;
    }
    this.near = pickNearestInteractionTarget(controlled.container, index.near(x, y), session, {
      mapId: map || undefined,
      hasShop: actorId => !!this.app.shops?.shops[actorId],
      isUnavailable: character =>
        this.chestOpened(character) ||
        this.legendarySwordConsumed(character) ||
        !!(character.entity.spring && this.map && session.springs.isEmpty(this.map.id, character.entity.id)),
    });
  }

  override update(_time: number, delta: number): void {
    this.app.domUi?.setLayerVisible('world', this.canControl && !this.stageOccluded);
    if (this.stageOccluded) {
      this.syncStageOcclusion();
      if (this.stageOccluded) return;
    }
    const stepDelta = Math.min(delta, MAX_FRAME_DELTA_MS);
    this.worldHud?.updateFps();
    if (!this.canControl) this.syncHud();
    if (!this.player || !this.movement) return;
    const controlled = this.combat?.controlledVisual ?? this.player;
    this.pickupMessages?.setPaused(!this.canCombatControl);
    if (this.checkpointPending && this.canControl && !this.app.director.busy && this.combat?.canCheckpoint) this.captureCheckpoint();
    this.combat?.update(stepDelta, this.canCombatControl);
    this.triggers.settleCompletedEncounters(
      this.canCombatControl,
      this.app.director,
      this.combat?.completedStoryEncounters,
      work => this.playStory(work),
    );
    this.worldHud?.updateStatus();
    this.groundLootView?.setPaused(!this.canCombatControl);
    if (this.canCombatControl) this.loot.advance(stepDelta);
    this.refreshCombatHudIfTickChanged();
    if (!this.canControl) {
      this.movement.stop(controlled);
      return;
    }
    if (this.combat?.playerCannotMove()) {
      this.movement.stop(controlled);
      return;
    }
    if (this.combat?.castingSkill) return;
    const axis = this.worldHud?.axis ?? { x: 0, y: 0 };
    const length = Math.hypot(axis.x, axis.y);
    if (this.entryInputGate) {
      if (length === 0) this.entryInputGate = false;
      else {
        this.movement.stop(controlled);
        return;
      }
    }
    if (length > 0) {
      this.combat?.cancelAttack();
      this.combat?.clearTarget();
      this.combat?.cancelAmbushOnDirection();
      this.autoAttack.release();
    }
    if (this.combat?.attackState !== 'idle') return;
    if (length === 0 && this.autoAttack.next({ targetId: this.combat?.targetId, attackState: this.combat?.attackState ?? 'idle' })) {
      this.combat?.attack();
    }
    this.movement.drive(controlled, axis, this.combat?.movementSpeedForPlayer() ?? PLAYER_MOVE_SPEED);
    if (length > 0 && this.combat) {
      this.combat.facing = Math.abs(axis.x) > Math.abs(axis.y) ? (axis.x < 0 ? 'west' : 'east') : axis.y < 0 ? 'north' : 'south';
    }
  }

  afterMovement(): void {
    this.updateQuestMarkerPositions();
    if (!this.player || !this.movement) return;
    const controlled = this.combat?.controlledVisual ?? this.player;
    const pos = this.movement.position(controlled);
    const previous = this.lastPlayerPosition ?? pos;
    const moving = Math.hypot(pos.x - previous.x, pos.y - previous.y) > 0.01;
    this.lastPlayerPosition = pos;
    if (!this.canControl) return;
    this.worldHud?.minimap?.updatePlayer(pos);
    const body = this.movement.body(controlled);
    const walking = isBodyWalking(body);
    if (!this.combat?.playerCannotAct() && this.combat?.attackState !== 'attacking') {
      setCharacterClip(this, controlled, `${walking ? 'walk' : 'idle'}-${this.combat?.facing ?? this.facing}`);
    }
    this.combat?.afterMovement();
    if (this.worldHud?.minimap && this.combat && this.time.now >= this.nextMinimapEnemyUpdate) {
      this.nextMinimapEnemyUpdate = this.time.now + MINIMAP_ENEMY_REFRESH_MS;
      this.worldHud.minimap.updateEnemies(this.combat.specialEnemyMarkers());
    }
    this.collectGroundLoot(pos);
    this.updateInteractionTarget();
    this.syncHud();
    const triggerResult = this.triggers.stepAfterMovement({
      map: this.map!,
      campaign: this.app.campaign,
      session: this.app.session,
      director: this.app.director,
      characters: this.characters,
      pos,
      moving,
      playStory: work => this.playStory(work),
      onExit: exit => this.changeMap(exit),
    });
    if (triggerResult === 'none' && moving) this.prefetchVisibleExit(pos, previous);
  }
}

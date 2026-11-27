import type { StoryApp } from './app.ts';
import type { AutoSaver } from './application/auto-save.ts';
import { installStorySkipDiagnostics, startLoadResourceMeter } from './application/game-diagnostics.ts';
import {
  attachGmSessionBridge,
  detachGmSessionBridge,
  type GmWorldScenePort,
} from './application/gm-session-bridge.ts';
import { SavedGameLoader } from './application/saved-game-loader.ts';
import { prepareSavedGame } from './application/saved-game.ts';
import { SCENE_KEYS } from './application/scene-keys.ts';
import type { StoryWorldViewSnapshot } from './application/world-snapshot.ts';
import type { BattleStatKey } from './domain/battle-semantics.ts';
import type { EquipmentSlot, ItemResult } from './domain/items.ts';
import type { PassiveModifier } from './domain/passive-skills.ts';
import {
  defaultPressureSettings,
  normalizePressureEnemyHealth,
  normalizePressureMaxEnemies,
  type PressureSettings,
} from './domain/pressure-enemies.ts';
import type { RecoveryResult } from './domain/recovery-items.ts';
import { AUTO_SAVE_SLOT, type SaveGame, type SaveSlotRef } from './domain/save-game.ts';
import type { Session } from './domain/session.ts';
import { newStorySession, visibleStoryClasses } from './domain/story-class.ts';
import { StoryDirector } from './domain/story-director.ts';
import type { StoryPresentationPort } from './domain/story-performance.ts';
import { nextStoryMap } from './domain/story-preparation.ts';
import { StoryExecutionBudgetError } from './domain/story-runtime.ts';

const SCENE_SHUTDOWN_EVENT = 'shutdown';
const AUDIO_READY_DIAGNOSTIC_DELAY_MS = 4000;
/** 压测场地：全图可站、无实体、无出口、无剧情引用的竞技场。 */
export const PRESSURE_MAP = 'arena-map2-aa7923cc';
export const PRESSURE_START = { x: 280, y: 200 } as const;

export interface SessionSceneHandle {
  readonly sys: {
    isActive(): boolean;
    isPaused(): boolean;
    isSleeping?(): boolean;
    readonly settings?: { readonly key: string };
  };
  readonly events: {
    once(event: string, listener: () => void): unknown;
  };
  readonly scene: {
    start(key: string, data?: object): unknown;
    pause?(): unknown;
    resume?(): unknown;
  };
}

export interface LifecycleWorldScene extends GmWorldScenePort {
  readonly loadingWorld?: boolean;
  readonly events?: SessionSceneHandle['events'];
  readonly scene?: Pick<SessionSceneHandle['scene'], 'pause' | 'resume'>;
  setPlayerIdleClip?(): void;
  discardWorldWork(): void;
  summonLampMerchant(entry: string, signal: AbortSignal): Promise<void>;
  changeEquipment(
    entry: string | undefined,
    slot: EquipmentSlot,
    signal?: AbortSignal,
    memberId?: string,
  ): Promise<void>;
  equipmentAppearance(memberId: string): ReturnType<NonNullable<StoryApp['equipmentAppearance']>>;
  previewAppearance(memberId: string): ReturnType<NonNullable<StoryApp['previewAppearance']>>;
  useRecoveryItem(entry: string, memberId?: string): RecoveryResult;
  preparePartyMember(id: string, signal?: AbortSignal, options?: { full?: boolean; pin?: boolean }): Promise<void>;
  releasePartyPreview(): void;
  combatAttribute(
    actorId: string,
    attribute: BattleStatKey,
    base: number,
    passives: readonly PassiveModifier[],
  ): number;
  combatStealthed(actorId: string): boolean;
  revivePartyMember(id: string, item: string): ItemResult;
  waitWorldReady(signal?: AbortSignal): Promise<void>;
  normalizeForStory(signal?: AbortSignal): Promise<void>;
  settleStoryPlayback(): void;
  prefetchStoryEntry(mapId: string, script: string | undefined, signal: AbortSignal): Promise<void>;
  ensureStoryAssets(scripts: readonly string[], signal: AbortSignal): Promise<void>;
  diagnosticSnapshot(): { readonly map?: unknown; readonly player?: unknown } | Record<string, unknown>;
  recoverWorld(signal?: AbortSignal): Promise<void>;
  startPressureSpawner?(): Promise<void>;
  applyPressureSettings?(options?: { applyHealth?: boolean }): void;
  pressureEnemyCount?(): number;
}

export interface SessionLifecycleHooks {
  lifetime: { current: AbortController };
  worldScene(): LifecycleWorldScene | undefined;
  currentScene(): SessionSceneHandle | undefined;
  gmOn(): boolean;
  runtimeDiagnostics(): Record<string, unknown>;
  prepareStory(signal: AbortSignal): Promise<void>;
  prepareMenuCore(signal: AbortSignal, progress?: (value: number) => void): Promise<void>;
  refreshMenuWhenReady(signal: AbortSignal): void;
  cancelCommonPreload(): void;
  clearMenuPreparations(): void;
  recordSceneChange(scene: string, details: Record<string, unknown>): void;
  remeasureRefreshAfterStart(): void;
  startAutoSave(session: Session): void;
  stopAutoSave(): void;
  autoSaver(): AutoSaver<StoryWorldViewSnapshot> | undefined;
  createOutfits?: () => StoryApp['outfits'];
  createStoryPresentation?: (isWorldActive: () => boolean) => StoryPresentationPort | undefined;
  recordStartPhase?: (phase: string, details?: Record<string, unknown>) => void;
}

/** 本局的装配、入口切换、压测重启、读档交接和退出顺序共用同一入口。 */
export function createSessionLifecycle(app: StoryApp, hooks: SessionLifecycleHooks) {
  const ui = app.ui;
  const {
    lifetime,
    worldScene: rawWorldScene,
    currentScene,
    gmOn,
    runtimeDiagnostics,
    prepareStory,
    prepareMenuCore,
    refreshMenuWhenReady,
    cancelCommonPreload,
    clearMenuPreparations,
    recordSceneChange,
    remeasureRefreshAfterStart,
    startAutoSave,
    stopAutoSave,
    createOutfits,
    createStoryPresentation,
    recordStartPhase,
  } = hooks;
  const savedGameLoader = new SavedGameLoader();

  /** 开始一次新的入口流程：旧代次立即失效，后续内容加载绑定到新信号。 */
  function beginEntry(): AbortSignal {
    lifetime.current.abort();
    lifetime.current = new AbortController();
    return lifetime.current.signal;
  }

  function stopCurrentWork(): void {
    rawWorldScene()?.discardWorldWork();
    stopAutoSave();
    detachGmSessionBridge(app);
    lifetime.current.abort();
    app.director?.dispose();
    app.clearMapPrefetch();
    app.clearStoryPrefetch();
    ui.resetInput();
  }

  async function prepareCandidate(game: SaveGame<StoryWorldViewSnapshot>, request: AbortSignal, slot?: SaveSlotRef) {
    request.throwIfAborted();
    app.storyClasses = await app.content.storyClasses(request);
    request.throwIfAborted();
    await prepareStory(request);
    request.throwIfAborted();
    let candidate: ReturnType<typeof prepareSavedGame>;
    try {
      candidate = prepareSavedGame(game, app);
      await app.content.map(candidate.map.file, request);
    } catch (error) {
      // 取消不是存档损坏；保留原错误让读档入口记录取消，不弹存档出错。
      if (slot === undefined || request.aborted) throw error;
      globalThis.storyDiagnostics?.record('load-validation-failed', {
        slot,
        reason: error instanceof Error ? error.message : String(error),
      }, false);
      throw new Error('游戏存档出错。无法正常进行游戏。');
    }
    request.throwIfAborted();
    return candidate;
  }

  async function resumeSlot(slot: SaveSlotRef, signal?: AbortSignal): Promise<void> {
    // 压测不读写存档；要读档先返回标题，避免把压测会话和存档会话混在一起。
    if (app.pressureMode) return;
    const game = app.game;
    const sourceMode = app.mode;
    const sourceScene = currentScene();
    const sourceSession = app.session;
    const sourceLifetime = lifetime.current;
    if (
      !game ||
      (sourceMode !== 'menu' && sourceMode !== 'game') ||
      app.suspended ||
      !ui.ready ||
      savedGameLoader.busy ||
      !sourceScene?.sys.isActive() ||
      (sourceMode === 'game' && rawWorldScene()?.loadingWorld)
    ) {
      return;
    }
    const isCurrent = () =>
      lifetime.current === sourceLifetime &&
      app.mode === sourceMode &&
      currentScene() === sourceScene &&
      app.session === sourceSession &&
      (sourceScene.sys.isActive() || sourceScene.sys.isPaused());
    const loadStarted = performance.now();
    // 从点读档到地图可操作，统计下载了多少字节、主线程被长任务占了多久；`load-ready` 记录带上它。
    const stopResourceMeter = startLoadResourceMeter();
    globalThis.storyDiagnostics?.record('load-start', { slot, from: sourceMode }, false);
    try {
      await savedGameLoader.load(slot, {
        isCurrent,
        prepare: async (selectedSlot, request) => {
          const reading = app.saves.inspect(selectedSlot);
          if (reading.kind !== 'ok') {
            throw new Error(reading.kind === 'empty' ? '没有可以载入的存档。' : '游戏存档出错。无法正常进行游戏。');
          }
          ui.loading('正在读取存档…');
          const candidate = await prepareCandidate(reading.game, request, selectedSlot);
          ui.loading('正在准备游戏菜单…', 0.15);
          await prepareMenuCore(request, value => ui.loading('正在准备游戏菜单…', 0.15 + 0.35 * value));
          refreshMenuWhenReady(request);
          request.throwIfAborted();
          return candidate;
        },
        stopCurrent: async () => {
          cancelCommonPreload();
          stopCurrentWork();
          const stopped = new Promise<void>(resolve => sourceScene.events.once(SCENE_SHUTDOWN_EVENT, () => resolve()));
          game.scene.stop(sourceScene.sys.settings?.key ?? SCENE_KEYS.world);
          await stopped;
          app.releaseResidentCombat();
        },
        install: (candidate, request) => {
          lifetime.current = request;
          const { session, world } = candidate;
          const location = world.location;
          request.signal.addEventListener('abort', () => stopResourceMeter(), { once: true });
          app.mode = 'game';
          ui.setMode('game');
          ui.loading('正在读取存档…');
          // 自动槽不是玩家手动选择的槽，所以这里留空。
          app.saveSlot = slot === AUTO_SAVE_SLOT ? undefined : slot;
          installSession(session, candidate.map.file);
          recordSceneChange(SCENE_KEYS.world, { map: location.map, source: 'load' });
          game.scene.start(SCENE_KEYS.world, {
            map: location.map,
            x: location.x,
            y: location.y,
            facing: location.facing,
            initialEntry: true,
            suppressEntry: true,
            resumeStory: true,
            signal: request.signal,
            checkpoint: world.world,
            generatedEntities: world.generatedEntities,
            preparedScene: world.scene,
            triggerContacts: world.triggerContacts,
            onReady: () => {
              if (request.signal.aborted) return;
              globalThis.storyDiagnostics?.record('load-ready', {
                slot,
                map: location.map,
                readyMs: Math.round((performance.now() - loadStarted) * 10) / 10,
                ...stopResourceMeter(),
              }, false);
              remeasureRefreshAfterStart?.();
              if (world.audio) app.audio?.restoreStoryAudio(world.audio);
              globalThis.setTimeout(() => {
                if (!request.signal.aborted) globalThis.storyDiagnostics?.record('load-audio-ready', { map: location.map });
              }, AUDIO_READY_DIAGNOSTIC_DELAY_MS);
            },
          });
        },
      }, signal);
      globalThis.storyDiagnostics?.record('load', {
        slot,
        elapsedMs: Math.round((performance.now() - loadStarted) * 10) / 10,
      }, false);
    } catch (error) {
      // 玩家返回、切槽或换会话会让 loader 抛 AbortError；取消不是读档失败，不能写进错误流。
      const cancelled = !!signal?.aborted || (typeof error === 'object' && error !== null
        && (error as { name?: string }).name === 'AbortError');
      stopResourceMeter();
      if (cancelled) {
        globalThis.storyDiagnostics?.record('load-cancel', { slot }, false);
      } else {
        globalThis.storyDiagnostics?.record('load-error', {
          slot,
          elapsedMs: Math.round((performance.now() - loadStarted) * 10) / 10,
          error,
        });
      }
      if (isCurrent()) ui.loaded();
      throw error;
    }
  }

  function installSession(session: Session, keepMapFile?: string): void {
    stopAutoSave();
    detachGmSessionBridge(app);
    app.director?.dispose();
    // 会话可能换了职业；旧常驻包、历史地图纹理和会话级内容解析结果都不再复用。
    app.releaseResidentCombat();
    app.clearMapHistory();
    app.clearStoryPrefetch();
    app.content.clearSessionCaches(keepMapFile);
    app.outfits?.destroy();
    app.outfits = createOutfits?.();
    const campaign = app.campaign;
    const presentation = app.storyInterface;
    app.session = session;
    globalThis.storyDiagnostics?.record('session-install', {
      slot: app.saveSlot ?? null,
      map: session.storyWorld.currentLocation?.map ?? null,
      pressure: app.pressureMode,
      party: session.party?.activeIds ?? null,
      classId: session.hero?.classId ?? null,
      level: session.hero?.level ?? null,
    }, false);
    const signal = lifetime.current.signal;
    app.storySignal = signal;
    const worldScene = (): LifecycleWorldScene | undefined =>
      app.session === session && !signal.aborted ? rawWorldScene() : undefined;
    const requireWorldScene = (): LifecycleWorldScene => {
      const scene = worldScene();
      if (!scene) throw new Error('请等待地图加载');
      return scene;
    };
    app.checkpoint.clear();
    app.summonLampMerchant = (entry, entrySignal) => requireWorldScene().summonLampMerchant(entry, entrySignal);
    app.changeEquipment = async (entry, slot, entrySignal, memberId) =>
      requireWorldScene().changeEquipment(entry, slot, entrySignal, memberId);
    app.equipmentAppearance = memberId => worldScene()?.equipmentAppearance(memberId);
    app.previewAppearance = memberId => worldScene()?.previewAppearance(memberId);
    app.useRecoveryItem = (entry, memberId) => requireWorldScene().useRecoveryItem(entry, memberId);
    app.preparePartyMember = async (id, entrySignal, options) => {
      const scene = worldScene();
      if (scene) await scene.preparePartyMember(id, entrySignal, options);
    };
    app.releasePartyPreview = () => worldScene()?.releasePartyPreview();
    // 属性页只在菜单重绘时读一次；菜单打开期间战斗已暂停，Buff 不会继续走。
    app.combatAttribute = (id, attribute, base, passives) =>
      worldScene()?.combatAttribute(id, attribute, base, passives) ?? base;
    app.combatStealthed = id => worldScene()?.combatStealthed(id) ?? false;
    app.revivePartyMember = (id, item) => requireWorldScene().revivePartyMember(id, item);
    ui.playerActor = campaign.start.actor;
    app.storyUI.bind(session, app.world, presentation);
    ui.questItemName = id => app.items.items[id]?.name ?? id;
    const storyPresentation = createStoryPresentation?.(() => app.session === session && !signal.aborted);
    const director = new StoryDirector(campaign, session, ui, locked => {
      if (app.director !== director || signal.aborted) return;
      ui.lock(locked, 'game');
      if (!locked) app.storyAssetPreparation.clear();
      if (locked) worldScene()?.setPlayerIdleClip?.();
    }, storyPresentation, {
      normalize: async stepSignal => {
        const scene = worldScene();
        await scene?.waitWorldReady(stepSignal);
        stepSignal.throwIfAborted();
        await scene?.normalizeForStory(stepSignal);
      },
      capture: () => worldScene()?.captureStoryWorld(),
      restore: async (snapshot, stepSignal) => { await worldScene()?.restoreStoryWorld(snapshot, stepSignal); },
      project: async (stage, stepSignal) => { await worldScene()?.projectStoryWorld(stage, stepSignal); },
      checkpoint: () => worldScene()?.checkpointStoryWorld(),
      settle: () => worldScene()?.settleStoryPlayback(),
      prepare: (_commands, stepSignal, stage, script, cursor) => {
        const scene = worldScene();
        stepSignal.throwIfAborted();
        if (scene?.map) {
          const target = cursor ? nextStoryMap(campaign, cursor, scene.map.id)
            : stage && !stage.mapFromWorld ? stage.map : undefined;
          void scene.prefetchStoryEntry(target ?? scene.map.id, script, stepSignal);
        }
      },
      prefetch: async (scripts, stepSignal) => { await worldScene()?.ensureStoryAssets(scripts, stepSignal); },
    });
    app.director = director;
    if (globalThis.storyDiagnostics) {
      installStorySkipDiagnostics(
        director,
        (kind, details) => globalThis.storyDiagnostics?.record(kind, details, false),
      );
    }
    // 事件播完（世界投影已经结束）写入自动存档；节点中途不写。
    director.onEventCompleted = () => { if (worldScene()) hooks.autoSaver()?.request(); };
    director.onError = (error, retry) => {
      if (app.director !== director || signal.aborted || app.mode !== 'game') return;
      console.error(error);
      const message = error instanceof Error ? error.message : String(error);
      const snapshot = worldScene()?.diagnosticSnapshot();
      globalThis.storyDiagnostics?.record('story-error', {
        message,
        stack: error instanceof Error ? error.stack : undefined,
        map: snapshot?.map,
        player: snapshot?.player,
        storyExecution: error instanceof StoryExecutionBudgetError ? error.details : undefined,
      });
      ui.error(message, () => {
        if (signal.aborted || app.session !== session) return;
        ui.loaded();
        void (async () => {
          try {
            // 世界只建了一半时先重建，成功后再接着走剧情游标。
            await worldScene()?.recoverWorld();
            await retry();
          } catch (next) {
            director.onError?.(next, retry);
          }
        })();
      });
    };

    attachGmSessionBridge({
      app,
      session,
      campaign,
      director,
      signal,
      gmOn,
      worldScene,
      runtimeDiagnostics,
    });
    app.audio?.enterStory();
    // 会话装好之后再开自动存档：它要绑定这一份会话的任务状态。
    startAutoSave(session);
  }

  async function enterGame(slot?: number): Promise<void> {
    if (app.mode !== 'menu' || app.suspended || !app.game?.scene.isActive(SCENE_KEYS.menu)) return;
    app.saveSlot = slot;
    const signal = beginEntry();
    app.mode = 'class-select';
    ui.setMode('class-select');
    ui.loading('正在加载资源…');
    recordSceneChange(SCENE_KEYS.classSelect, { source: 'menu' });
    try {
      app.storyClasses = await app.content.storyClasses(signal);
      signal.throwIfAborted();
      const menu = app.game!.scene.getScene(SCENE_KEYS.menu);
      menu.scene.start(SCENE_KEYS.classSelect);
    } catch (error) {
      if (signal.aborted) return;
      console.error(error);
      globalThis.storyDiagnostics?.record('content-load-error', { stage: 'story-classes', error });
      ui.error(error instanceof Error ? error.message : String(error), () => {
        app.mode = 'menu';
        void enterGame(slot);
      });
    }
  }

  async function finishStoryStart(classId: string): Promise<void> {
    if (app.mode !== 'class-select' || !app.game?.scene.isActive(SCENE_KEYS.classSelect)) return;
    const signal = lifetime.current.signal;
    recordStartPhase?.('class-start', { classId, gm: gmOn(), trusted: app.content.trusted });
    ui.loading('正在开始游戏…');
    try {
      await prepareStory(signal);
      signal.throwIfAborted();
      recordStartPhase?.('story-ready');
      ui.loading('正在准备游戏菜单…', 0.15);
      await prepareMenuCore(signal, value => ui.loading('正在准备游戏菜单…', 0.15 + 0.35 * value));
      refreshMenuWhenReady(signal);
      signal.throwIfAborted();
      recordStartPhase?.('menu-ready');
    } catch (error) {
      if (signal.aborted) return;
      console.error(error);
      globalThis.storyDiagnostics?.record('content-load-error', { stage: 'story-start', error });
      ui.error(error instanceof Error ? error.message : String(error), () => { void finishStoryStart(classId); });
      return;
    }
    const selected = app.storyClasses.classes.find(entry => entry.id === classId);
    if (!selected) return;
    const selection = currentScene()!;
    cancelCommonPreload();
    app.mode = 'game';
    ui.setMode('game');
    ui.loading('正在开始游戏…');
    const campaign = app.campaign;
    recordStartPhase?.('session-install-start');
    installSession(newStorySession(
      campaign,
      app.world.actors[campaign.start.actor],
      selected,
      app.items,
      app.characterStats,
      app.battleCatalog,
      app.companions,
    ));
    recordStartPhase?.('session-installed');
    recordSceneChange(SCENE_KEYS.world, { map: app.campaign.start.map, source: 'new-game' });
    selection.scene.start(SCENE_KEYS.world, {
      ...app.campaign.start,
      initialEntry: true,
      onReady: () => {
        app.storyUI?.prewarmBag();
        remeasureRefreshAfterStart();
      },
    });
    recordStartPhase?.('world-scene-start');
  }

  function startStory(classId: string): void {
    if (
      app.mode !== 'class-select' ||
      !ui.ready ||
      app.suspended ||
      !app.game?.scene.isActive(SCENE_KEYS.classSelect)
    ) {
      return;
    }
    const selected = visibleStoryClasses(app.storyClasses, gmOn()).find(entry => entry.id === classId);
    if (!selected) return;
    void finishStoryStart(classId);
  }

  /**
   * 挑战模式连点 5 次的隐藏入口：新建 1 级角色进竞技场，之后由世界场景持续刷怪。
   * 压测不读也不写任何存档槽；退出后正式存档保持原样。
   */
  async function startPressureTest(): Promise<void> {
    if (app.pressureMode) return;
    if (
      app.mode !== 'menu' ||
      app.suspended ||
      !ui.ready ||
      !app.game?.scene.isActive(SCENE_KEYS.menu) ||
      savedGameLoader.busy
    ) {
      return;
    }
    const signal = beginEntry();
    app.pressureMode = true;
    app.pressureSettings = defaultPressureSettings();
    ui.loading('正在准备压测…');
    const fail = (error: unknown): void => {
      // 取消或失败都要清掉压测标记，否则自动存档会一直停着，入口也进不去。
      app.pressureMode = false;
      if (signal.aborted) return;
      console.error(error);
      globalThis.storyDiagnostics?.record('content-load-error', { stage: 'pressure-start', error });
      app.mode = 'menu';
      ui.error(error instanceof Error ? error.message : String(error), () => { void startPressureTest(); });
    };
    try {
      app.storyClasses = await app.content.storyClasses(signal);
      signal.throwIfAborted();
      await prepareStory(signal);
      signal.throwIfAborted();
      await prepareMenuCore(signal);
      signal.throwIfAborted();
    } catch (error) {
      fail(error);
      return;
    }
    const selected = app.storyClasses.classes.find(entry => entry.id === app.storyClasses.defaultClass);
    if (!selected) {
      fail(new Error('压测缺少默认职业'));
      return;
    }
    cancelCommonPreload();
    app.mode = 'game';
    ui.setMode('game');
    ui.loading('正在进入压测战场…');
    app.saveSlot = undefined;
    installSession(newStorySession(
      app.campaign,
      app.world.actors[app.campaign.start.actor],
      selected,
      app.items,
      app.characterStats,
      app.battleCatalog,
      app.companions,
    ));
    const menu = app.game!.scene.getScene(SCENE_KEYS.menu);
    recordSceneChange(SCENE_KEYS.world, { map: PRESSURE_MAP, source: 'pressure' });
    menu.scene.start(SCENE_KEYS.world, {
      map: PRESSURE_MAP,
      x: PRESSURE_START.x,
      y: PRESSURE_START.y,
      facing: 'south',
      initialEntry: true,
      suppressEntry: true,
      onReady: () => {
        app.storyUI?.prewarmBag();
        void rawWorldScene()?.startPressureSpawner?.();
      },
    });
  }

  async function changePressureClass(classId: string): Promise<void> {
    const selected = app.storyClasses.classes.find(entry => entry.id === classId);
    const scene = rawWorldScene();
    const game = app.game;
    if (!app.pressureMode || !selected || !scene || !game || scene.loadingWorld) return;
    const oldSession = app.session;
    ui.loading('正在进入压测战场…');
    stopCurrentWork();
    beginEntry();
    const stopped = scene.events
      ? new Promise<void>(resolve => scene.events!.once(SCENE_SHUTDOWN_EVENT, () => resolve()))
      : Promise.resolve();
    game.scene.stop(SCENE_KEYS.world);
    await stopped;
    app.releaseSession(oldSession);
    if (!app.pressureMode) return;
    app.saveSlot = undefined;
    installSession(newStorySession(
      app.campaign,
      app.world.actors[app.campaign.start.actor],
      selected,
      app.items,
      app.characterStats,
      app.battleCatalog,
      app.companions,
    ));
    recordSceneChange(SCENE_KEYS.world, { map: PRESSURE_MAP, source: 'pressure-class' });
    game.scene.start(SCENE_KEYS.world, {
      map: PRESSURE_MAP,
      x: PRESSURE_START.x,
      y: PRESSURE_START.y,
      facing: 'south',
      initialEntry: true,
      suppressEntry: true,
      onReady: () => {
        app.storyUI?.prewarmBag();
        void rawWorldScene()?.startPressureSpawner?.();
      },
    });
  }

  function updatePressureSettings(patch: Partial<PressureSettings>): void {
    if (!app.pressureMode) return;
    const next: PressureSettings = { ...app.pressureSettings };
    const applyHealth = Object.prototype.hasOwnProperty.call(patch, 'enemyMaxHealth');
    if (patch.maxEnemies !== undefined) next.maxEnemies = normalizePressureMaxEnemies(patch.maxEnemies);
    if (applyHealth) next.enemyMaxHealth = normalizePressureEnemyHealth(patch.enemyMaxHealth);
    app.pressureSettings = next;
    rawWorldScene()?.applyPressureSettings?.({ applyHealth });
  }

  function pausePressure(paused: boolean): void {
    const scene = rawWorldScene();
    if (!scene?.scene) return;
    if (paused) scene.scene.pause?.();
    else if (!app.suspended) scene.scene.resume?.();
  }

  function returnToMenu(): void {
    if (!ui.canReturn) return;
    if (app.mode === 'game' && rawWorldScene()?.loadingWorld && !ui.failed) return;
    app.pressureMode = false;
    app.pressureSettings = defaultPressureSettings();
    const returnPage = app.mode === 'class-select' ? 'slots' : 'home';
    const departedSession = app.session;
    savedGameLoader.cancel();
    stopCurrentWork();
    lifetime.current = new AbortController();
    clearMenuPreparations();
    // 会话已经销毁：把动作层一起摘掉，免得 agent 拿到一个指向已 dispose 导演的句柄。
    detachGmSessionBridge(app);
    const scene = currentScene();
    const releaseSessionAssets = () => { app.releaseSession(departedSession); };
    const stage = app.game?.scene.getScene(SCENE_KEYS.storyStage);
    if (stage && (stage.sys.isActive() || stage.sys.isPaused() || stage.sys.isSleeping())) {
      app.game!.scene.stop(SCENE_KEYS.storyStage);
    }
    if (scene?.sys.isActive() || scene?.sys.isPaused()) {
      // 场景还活着时不能提前删纹理；等 WorldScene/当前场景真正 shutdown 后再释放。
      scene.events.once(SCENE_SHUTDOWN_EVENT, releaseSessionAssets);
      scene.scene.start(SCENE_KEYS.menu, { page: returnPage });
    } else {
      releaseSessionAssets();
    }
    // 初始内容请求失败时菜单场景仍在运行。
    app.mode = 'menu';
    ui.lock(false, 'game');
    ui.setMode('menu');
    recordSceneChange(SCENE_KEYS.menu, { source: 'return' });
    app.audio?.enterMenu();
  }

  return {
    install: installSession,
    load: resumeSlot,
    prepareCandidate,
    beginEntry,
    enterGame,
    startStory,
    startPressureTest,
    changePressureClass,
    updatePressureSettings,
    pausePressure,
    exit: returnToMenu,
    stopCurrentWork,
    get busy() {
      return savedGameLoader.busy;
    },
  };
}

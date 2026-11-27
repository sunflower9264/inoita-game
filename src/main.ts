// 必须最先执行：补齐旧版 Android WebView 缺少的浏览器 API，后面的模块才能正常加载。
import './application/browser-compat.ts';
import Phaser from 'phaser';
import { StoryApp } from './app.ts';
import {
  afterFirstPaint,
  editingText,
  installDisplayFramePacing,
  installPageSuspensionLifecycle,
  installViewportLayoutScheduler,
  installWebAudioRecovery,
} from './application/browser-lifecycle.ts';
import { StoryContentBootstrap, recordStartPhase } from './application/content-bootstrap.ts';
import { trustedContentNow } from './application/content-trust.ts';
import type { GameMode } from './application/control-state.ts';
import { displaySettings, parallelTextureUnits } from './application/display-settings.ts';
import { currentRefreshRate, resolveFrameLimit } from './application/frame-pacing.ts';
import { GAME_FRAME_TIMING, installFrameLimitClock } from './application/game-timing.ts';
import { installPageInteractionGuard } from './application/page-interaction-guard.ts';
import { RuntimeDiagnosticsController } from './application/runtime-diagnostics.ts';
import { SCENE_KEYS } from './application/scene-keys.ts';
import { SessionAutoSaveController } from './application/session-auto-save.ts';
import { UI_EVENTS } from './application/ui-events.ts';
import type { GmActions } from './debug/gm-actions.ts';
import { loadSceneAssets } from './rendering/scene-assets.ts';
import { OutfitPool } from './rendering/outfit-pool.ts';
import { StoryPresenter } from './rendering/story-presenter.ts';
import { AudioScene } from './scenes/audio-scene.ts';
import { FormalUiScene } from './scenes/formal-ui-scene.ts';
import { MenuScene } from './scenes/menu-scene.ts';
import { StoryClassScene } from './scenes/story-class-scene.ts';
import { StoryStageScene } from './scenes/story-stage-scene.ts';
import { TextureLoaderScene } from './scenes/texture-loader-scene.ts';
import { WorldScene } from './scenes/world-scene.ts';
import { createSessionLifecycle } from './session-lifecycle.ts';
import { DomUi } from './ui/dom/dom-ui.ts';
import { GameUI, uiOcclusion } from './ui/game-ui.ts';
import { SaveThumbnails } from './ui/phaser/game-thumbnail.ts';
import { StoryUI } from './ui/story-ui.ts';
import { configureCanvas, fitViewport, GAME_HEIGHT, GAME_WIDTH } from './ui/viewport.ts';

declare global {
  /** GM 入口暴露出来的运行实例，浏览器测试用它检查状态。 */
  var storyApp: StoryApp | undefined;
  var render_game_to_text: (() => string) | undefined;
  /** GM 打开时才挂上的调试动作层，agent 经 CDP 驱动它（与游戏内面板同一份实现）。 */
  var gm: GmActions | undefined;
}

/** 当前模式对应的场景键。写成 `Record<GameMode, …>`：新增模式时必须在这里表态。 */
const MODE_SCENES: Record<GameMode, string> = {
  menu: SCENE_KEYS.menu,
  'class-select': SCENE_KEYS.classSelect,
  game: SCENE_KEYS.world,
};

// 在创建画布前拦住整页缩放和长按菜单，避免第一次触摸就改掉视口。
installPageInteractionGuard();
fitViewport();

const ui = new GameUI();
const app = new StoryApp(ui);
const domUi = new DomUi();
const saveThumbnails = new SaveThumbnails();
ui.onQuestPopup = kind => app.audio?.ui(kind === 'start' ? 'questStart' : 'questComplete');

const addressParams = new URLSearchParams(location.search);
/**
 * GM（调试）开关：持久值来自本地存储（标题页点击右下角版本号切换）。
 * `?gm` 只在**本次会话**打开，不写存储——否则谁试一次地址参数，就悄悄改了用户的机器。
 * GM 入口会暴露运行实例与控制台钩子：agent 用 `?gm` 一个参数就能读状态。
 */
const gmFromAddress = addressParams.has('gm');
const gmOn = (): boolean => gmFromAddress || app.gmMode.on;
app.isDebugMode = gmOn;
// 生产构建信任构建期校验；?gm 或持久 GM 强制走完整校验。
app.content.trusted = trustedContentNow() && !gmOn();

function worldScene(): WorldScene | undefined {
  return app.game?.scene.getScene(SCENE_KEYS.world) as WorldScene | undefined;
}

function currentScene(): Phaser.Scene | undefined {
  return app.game?.scene.getScene(MODE_SCENES[app.mode]);
}

/** 进图/读档完成后的刷新率补测；由 boot() 装配，场景就绪时调用。 */
let remeasureRefreshAfterStart: (() => void) | undefined;
let modeRequest = new AbortController();

const diagnostics = new RuntimeDiagnosticsController({
  app: {
    get mode() { return app.mode; },
    get ready() { return ui.ready; },
    get locked() { return ui.locked; },
    get lockOwners() { return ui.lockOwners; },
    get suspended() { return ui.suspended; },
    get defeatOpen() { return ui.defeatOpen; },
    get dialogueOpen() { return !!ui.dialogueState; },
    get choiceOpen() { return !!ui.choices; },
    get questPopupOpen() { return !!ui.quest; },
    get controlLayoutEditing() { return ui.controlLayoutEditing; },
    get keyBindingEditing() { return ui.keyBindingEditing; },
    get loadingLabel() { return ui.loadingState?.label; },
    get saveSlot() { return app.saveSlot; },
    get pressureMode() { return app.pressureMode; },
    get pressureSettings() { return app.pressureSettings; },
    get trustedContent() { return app.content.trusted; },
    get menuOpen() { return app.storyUI?.menuOpen ?? false; },
    get session() { return app.session; },
    get director() { return app.director; },
    get audio() { return app.audio; },
  },
  game: () => app.game as Phaser.Game | undefined,
  worldScene,
  gmOn,
  editingText,
});

const autoSave = new SessionAutoSaveController({
  app,
  thumbnails: {
    latest: () => saveThumbnails.latest,
    capture: () => saveThumbnails.capture(app.game),
    reset: () => saveThumbnails.reset(),
  },
});

const bootstrap = new StoryContentBootstrap({
  app,
  gmOn,
  audioCatalog: () => app.audio?.catalog,
  canLoadCommon: () => {
    const scene = app.game?.scene.getScene(SCENE_KEYS.formalUi) as Phaser.Scene | undefined;
    return !!scene?.sys.isActive();
  },
  loadCommonBatch: async (batch, signal) => {
    const scene = app.game?.scene.getScene(SCENE_KEYS.formalUi) as Phaser.Scene | undefined;
    if (!scene?.sys.isActive()) return undefined;
    return loadSceneAssets(scene, [...batch], { lifetime: 'manual', signal });
  },
});

const sessionLifecycle = createSessionLifecycle(app, {
  lifetime: {
    get current() { return modeRequest; },
    set current(value) { modeRequest = value; },
  },
  worldScene,
  currentScene,
  gmOn,
  runtimeDiagnostics: diagnostics.snapshot,
  prepareStory: bootstrap.prepareStory,
  prepareMenuCore: bootstrap.prepareMenuCore,
  refreshMenuWhenReady: bootstrap.refreshMenuWhenReady,
  cancelCommonPreload: bootstrap.cancelCommonPreload,
  clearMenuPreparations: bootstrap.clearMenuPreparations,
  recordSceneChange: diagnostics.recordSceneChange,
  remeasureRefreshAfterStart: () => remeasureRefreshAfterStart?.(),
  startAutoSave: session => autoSave.start(session),
  stopAutoSave: () => autoSave.stop(),
  autoSaver: () => autoSave.current,
  createOutfits: () => new OutfitPool(
    { textures: app.game!.textures, anims: app.game!.anims, game: app.game! },
    app.wardrobe,
    app.items,
    (ids, signal) => app.content.wardrobePoses(ids, signal),
  ),
  createStoryPresentation: isWorldActive => new StoryPresenter(
    app,
    () => (isWorldActive() ? worldScene() : undefined),
    () => app.game!.scene.getScene(SCENE_KEYS.storyStage) as StoryStageScene,
  ),
  recordStartPhase,
});

const disposeViewportLayout = installViewportLayoutScheduler(({ keepSize }) => {
  // 键盘弹出时可视区变矮：画布保持尺寸、只跟随位置偏移，菜单不会被重排。
  // 键盘收起（输入框已经失焦）后的下一次布局再按恢复后的可视区重算尺寸。
  fitViewport({ keepSize });
  if (app.game) configureCanvas(app.game, displaySettings.renderScale);
  app.game?.scale.getParentBounds();
  app.game?.scale.refresh();
  ui.resetInput();
  ui.reflowDialogue();
  domUi.layout();
});

function boot(): void {
  app.domUi = domUi;
  domUi.attach();
  domUi.setOccluded(uiOcclusion(ui));
  document.fonts?.ready.then(() => domUi.layout()).catch(() => {});

  app.enterGame = sessionLifecycle.enterGame;
  app.returnToMenu = sessionLifecycle.exit;
  app.startStory = sessionLifecycle.startStory;
  app.startPressureTest = sessionLifecycle.startPressureTest;
  app.changePressureClass = sessionLifecycle.changePressureClass;
  app.updatePressureSettings = sessionLifecycle.updatePressureSettings;
  app.pressureEnemyCount = () => worldScene()?.pressureEnemyCount() ?? 0;
  app.pausePressure = sessionLifecycle.pausePressure;
  app.resumeSlot = sessionLifecycle.load;
  app.validateCloudSave = async (game, signal, slot) => { await sessionLifecycle.prepareCandidate(game, signal, slot); };
  app.prefetchCommon = bootstrap.prefetchCommon;
  app.captureSaveWorld = () => app.pressureMode
    ? { ok: false, reason: 'pressure' }
    : worldScene()?.captureSaveWorld() ?? { ok: false, reason: 'not-ready' };
  // 只读 Phaser 画布，存档页和其他 DOM 界面不在快照里。
  app.captureSaveThumbnail = () => saveThumbnails.capture(app.game);
  app.autoSave = () => autoSave.request();
  app.captureControlPreview = () => worldScene()?.getControlLayoutPreview() ?? [];
  app.prefetchStory = () => afterFirstPaint(() => {
    if (modeRequest.signal.aborted || app.mode !== 'class-select') return;
    const signal = modeRequest.signal;
    void bootstrap.prepareStory(signal).then(() => bootstrap.prepareMenuCore(signal)).catch(() => {});
  });
  app.rescuePlayer = () => {
    const scene = worldScene();
    return scene ? scene.rescuePlayer() : { ok: false, reason: '不在游戏场景里' };
  };

  app.storyUI = new StoryUI(app);
  app.openCrafting = actorId => app.storyUI.openCrafting(actorId);
  app.openShop = (shopId, mapId) => app.storyUI.openShop(shopId, mapId);
  ui.onStateChange = () => {
    if (app.game) configureCanvas(app.game, displaySettings.renderScale);
    app.storyUI.sync();
    worldScene()?.syncHud();
    domUi.setOccluded(uiOcclusion(ui));
  };
  ui.onMenu = sessionLifecycle.exit;
  ui.onResetInput = () => { worldScene()?.resetInput(); };

  const game = new Phaser.Game({
    type: Phaser.WEBGL,
    parent: 'game',
    backgroundColor: '#101d24',
    pixelArt: true,
    roundPixels: true,
    fps: { ...GAME_FRAME_TIMING, limit: resolveFrameLimit(displaySettings.frameRateLimit, currentRefreshRate()) },
    callbacks: {
      postBoot: booted => {
        const restoreClock = installFrameLimitClock(booted.loop);
        booted.events.once(Phaser.Core.Events.DESTROY, restoreClock);
        // 启动配置固定为多纹理，再按玩家偏好应用：自动时安卓单纹理，iOS 和桌面多纹理。
        const applyTextureBatching = (): void => {
          const renderer = booted.renderer as Phaser.Renderer.WebGL.WebGLRenderer;
          if (!renderer?.renderNodes) return;
          renderer.renderNodes.setMaxParallelTextureUnits(
            parallelTextureUnits(displaySettings.textureBatching, booted.device.os.android, renderer.maxTextures),
          );
        };
        applyTextureBatching();
        booted.events.once(Phaser.Core.Events.DESTROY, displaySettings.subscribeTextureBatching(applyTextureBatching));
      },
    },
    scale: { mode: Phaser.Scale.NONE, autoCenter: Phaser.Scale.NO_CENTER, width: GAME_WIDTH, height: GAME_HEIGHT },
    render: { powerPreference: 'high-performance', batchSize: 16384, autoMobileTextures: false },
    input: { activePointers: 3, keyboard: true },
    loader: { maxParallelDownloads: 6, timeout: 15000, maxRetries: 1 },
    scene: [],
    banner: false,
    audio: { disableWebAudio: false },
  });
  app.game = game;

  // 每交付一帧只做一次整数加减；统计器不分配对象，也不读场景状态。
  game.events.on(Phaser.Core.Events.POST_STEP, () => diagnostics.frame(performance.now()));
  game.events.once(Phaser.Core.Events.DESTROY, () => {
    disposeViewportLayout();
    bootstrap.dispose();
  });

  const displayPacing = installDisplayFramePacing({
    setFpsLimit: limit => game.loop.setFPSLimit(limit),
    applyRenderScale: () => { if (app.game) configureCanvas(app.game, displaySettings.renderScale); },
  });
  remeasureRefreshAfterStart = displayPacing.remeasureAfterStart;
  game.events.once(Phaser.Core.Events.DESTROY, () => {
    displayPacing.dispose();
    remeasureRefreshAfterStart = undefined;
  });

  game.events.once(Phaser.Core.Events.DESTROY, diagnostics.install());

  game.events.once('ready', () => {
    configureCanvas(game, displaySettings.renderScale);
    // iOS 弹出系统键盘会让窗口短暂失焦，键盘收起后不一定恢复；ready 先于 Phaser 注册 window.onblur，
    // 等启动流程走完再由 installWebAudioRecovery 接管。
    let audioRecoveryDisposed = false;
    let disposeAudioRecovery: (() => void) | undefined;
    const audioRecoveryTimer = window.setTimeout(() => {
      if (audioRecoveryDisposed) return;
      disposeAudioRecovery = installWebAudioRecovery({
        isIOS: game.device.os.iOS,
        sound: game.sound as Phaser.Sound.WebAudioSoundManager,
        emitBlur: () => game.events.emit(Phaser.Core.Events.BLUR),
        emitFocus: () => game.events.emit(Phaser.Core.Events.FOCUS),
        removeDefaultVisibleListener: listener => game.events.off(Phaser.Core.Events.VISIBLE, listener, game.sound),
      });
    }, 0);
    game.events.once(Phaser.Core.Events.DESTROY, () => {
      audioRecoveryDisposed = true;
      window.clearTimeout(audioRecoveryTimer);
      disposeAudioRecovery?.();
      disposeAudioRecovery = undefined;
    });

    game.events.on(UI_EVENTS.select, () => app.audio?.ui('select'));
    game.scene.add(SCENE_KEYS.textureLoader, new TextureLoaderScene(), true);
    game.scene.add(SCENE_KEYS.audio, new AudioScene(app), true);
    game.scene.add(SCENE_KEYS.world, new WorldScene(app), false);
    game.scene.add(SCENE_KEYS.storyStage, new StoryStageScene(app), false);
    game.scene.add(SCENE_KEYS.classSelect, new StoryClassScene(app), false);
    game.scene.add(SCENE_KEYS.menu, new MenuScene(app), true);
    game.scene.add(SCENE_KEYS.formalUi, new FormalUiScene(app), true);

    const toSuspendable = (scene: Phaser.Scene | undefined) => scene ? ({
      isActive: () => scene.sys.isActive(),
      isPaused: () => scene.sys.isPaused(),
      pause: () => scene.scene.pause(),
      resume: () => scene.scene.resume(),
    }) : undefined;

    const suspension = installPageSuspensionLifecycle({
      isAlreadySuspended: () => app.suspended,
      flushForBackground: () => autoSave.flushForBackground(),
      setUiSuspended: suspended => ui.suspend(suspended),
      hasLockOwner: owner => ui.lockOwners.includes(owner),
      currentScene: () => toSuspendable(currentScene()),
      storyStageScene: () => toSuspendable(app.game?.scene.getScene(SCENE_KEYS.storyStage)),
      pauseAllSound: () => app.game?.sound.pauseAll(),
      resumeAllSound: () => app.game?.sound.resumeAll(),
      unlockSound: () => app.game?.sound.unlock?.(),
      resetInput: () => ui.resetInput(),
    });
    app.syncLifecycle = suspension.sync;
    game.events.once(Phaser.Core.Events.DESTROY, () => {
      suspension.dispose();
      if (app.syncLifecycle === suspension.sync) app.syncLifecycle = undefined;
    });
  });

  if (gmFromAddress) {
    globalThis.storyApp = app;
    globalThis.render_game_to_text = () => {
      // GM 打开时返回与面板、上报同一份摘要：agent 读到的就是人看到的。
      if (app.gm) return JSON.stringify({ ...app.gm.digest(), coordinates: 'map pixels; x right, y down; player position is foot anchor' });
      const scene = app.mode === 'game' ? worldScene() : undefined;
      return JSON.stringify({
        mode: app.mode,
        ready: ui.ready,
        suspended: app.suspended,
        coordinates: 'map pixels; x right, y down; player position is foot anchor',
        player: scene?.player ? { x: scene.player.container.x, y: scene.player.container.y, clip: scene.player.clipName } : null,
      });
    };
  }
}

boot();

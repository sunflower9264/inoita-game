// 必须最先执行：补齐旧版 Android WebView 缺少的浏览器 API，后面的模块才能正常加载。
import './application/browser-compat.ts';
import {installPageInteractionGuard} from './application/page-interaction-guard.ts';
import {prepareSavedGame} from './application/saved-game.ts';
import {SavedGameLoader} from './application/saved-game-loader.ts';
import {AutoSaver} from './application/auto-save.ts';
import {AUTO_SAVE_SLOT, SAVE_FORMAT, type SaveSlotRef} from './domain/save-game.ts';
import { SCENE_KEYS } from './application/scene-keys.ts';
import { UI_EVENTS } from './application/ui-events.ts';
import {validateCrafting} from './domain/crafting.ts';
import type { GameMode } from './application/control-state.ts';
import { validateStoryPerformance } from './application/story-performance-validation.ts';
import { storyReferenceMaps, validateStoryReferences } from './application/story-reference-validation.ts';
import { ControlsScene } from './scenes/controls-scene.ts';
import Phaser from 'phaser';
import { StoryApp } from './app.ts';
import { nextStoryMap } from './domain/story-preparation.ts';
import { commonAssetBatches } from './application/entry-plan.ts';
import { loadSceneAssets } from './rendering/scene-assets.ts';
import { trustedContentNow } from './application/content-trust.ts';
import type { Session } from './domain/session.ts';
import { newStorySession } from './domain/story-class.ts';
import { StoryClassScene } from './scenes/story-class-scene.ts';
import { StoryPresenter } from './rendering/story-presenter.ts';
import { OutfitPool } from './rendering/outfit-pool.ts';
import { StoryStageScene } from './scenes/story-stage-scene.ts';
import type { StoryWorldViewSnapshot } from './scenes/world-scene.ts';
import { StoryDirector } from './domain/story-director.ts';
import { FormalUiScene } from './scenes/formal-ui-scene.ts';
import { MenuScene } from './scenes/menu-scene.ts';
import { AudioScene } from './scenes/audio-scene.ts';

import { WorldScene } from './scenes/world-scene.ts';
import { GameUI, uiOcclusion } from './ui/game-ui.ts';
import { StoryUI } from './ui/story-ui.ts';
import { captureSaveThumbnail } from './ui/phaser/game-thumbnail.ts';
import { validateCharacterStats, validateMenuClasses, validateItemSkills, validateStoryItems, validateStoryPortraits, validateWardrobe, validateShops, validateCompanions } from './application/content-validation.ts';

import { GAME_HEIGHT, GAME_WIDTH, fitViewport, configureCanvas } from './ui/viewport.ts';
import { gameMenuImageGroups } from './application/menu-images.ts';
import { UI_ICON_ATLAS_FILE } from './generated/icon-atlas.ts';
import { MINIMAP_ASSETS } from './domain/story-interface.ts';
import { GAME_FRAME_TIMING, installFrameLimitClock } from './application/game-timing.ts';
import { displaySettings, parallelTextureUnits } from './application/display-settings.ts';
import { currentRefreshRate, detectRefreshRate, refreshRateKnown, resolveFrameLimit, setRefreshRate } from './application/frame-pacing.ts';
import { requestNativeFrameRate } from './application/native-frame-rate.ts';
import { installDiagnosticMetrics, installDiagnosticSnapshot, installStorySkipDiagnostics, FrameStats } from './application/game-diagnostics.ts';
import { createGmActions, consoleGmActions, type ConsoleGmActions } from './debug/gm-actions.ts';
import { IndexedDbDebugMarkStore } from './application/debug-mark-store.ts';
import { prepareDebugMark } from './application/debug-mark-preparation.ts';
import { persistentDebugWorld, prepareDebugWorld } from './application/debug-world.ts';
import { DomUi } from './ui/dom/dom-ui.ts';

declare global {
  /** GM 入口暴露出来的运行实例，浏览器测试用它检查状态。 */
  var storyApp: StoryApp | undefined;
  var render_game_to_text: (() => string) | undefined;
  /** GM 打开时才挂上的调试动作层，agent 经 CDP 驱动它（与游戏内面板同一份实现）。 */
  var gm: ConsoleGmActions | undefined;
}

/** 读档完成后，等音频缓存稳定再写一条诊断；不阻塞加载。 */
const AUDIO_READY_DIAGNOSTIC_DELAY_MS = 4000;
/** 启动后第一次补测刷新率的延迟；启动初期 rAF 可能还没按高刷回调。 */
const REFRESH_RECHECK_AFTER_BOOT_MS = 3000;
/** 进图/读档加载结束后补测刷新率的延迟；此时加载压力已经结束。 */
const REFRESH_RECHECK_AFTER_START_MS = 1200;

/** 场景实例，浏览器测试和流程代码都按 `world` 这个键取它。 */
function worldScene(): WorldScene | undefined {
  return app.game?.scene.getScene(SCENE_KEYS.world) as WorldScene | undefined;
}
/**
 * 世界场景在启动切换与场景重启的空窗里不存在。下面两组接线的期望不同，用名字区分：
 *
 * - `requireWorldScene` 用于**玩家发起的操作**。静默丢掉会表现成「点了没反应」，
 *   而玩家已经把这次操作当成生效了，所以这里抛错。
 * - `worldScene()?.…` 用于**查询与可选表现**（预览、外观、镜头焦点）。没有世界场景时
 *   返回 undefined 是合法结果，静默跳过不算丢信息。
 */
function requireWorldScene(): WorldScene {
  const scene = worldScene();
  if (!scene) throw new Error('请等待地图加载');
  return scene;
}

// 在创建画布前拦住整页缩放和长按菜单，避免第一次触摸就改掉视口。
installPageInteractionGuard();
fitViewport();
let layoutFrame = 0;
/**
 * 手机键盘弹出/收起会改变 visualViewport 的尺寸和偏移，但这不是游戏画布尺寸变化。
 * 文本输入框聚焦期间保持当前画布、面板和固定输入框的位置；失焦后的键盘收起事件
 * 会再次触发布局，届时才按恢复后的可视区重排。否则整个菜单会跟着输入框被顶上去。
 */
function editingText(): boolean {
  const active=document.activeElement;
  return active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
    || (active instanceof HTMLElement && active.isContentEditable);
}
const scheduleLayout = () => {
  cancelAnimationFrame(layoutFrame);
  layoutFrame = requestAnimationFrame(() => {
    // 键盘弹出时可视区变矮：画布保持尺寸、只跟随位置偏移，菜单不会被重排。
    // 键盘收起（输入框已经失焦）后的下一次布局再按恢复后的可视区重算尺寸。
    fitViewport({ keepSize: editingText() });
    if(app.game)configureCanvas(app.game,displaySettings.renderScale);
    app.game?.scale.getParentBounds();
    app.game?.scale.refresh();
    ui.resetInput();
    ui.reflowDialogue();
    domUi.layout();
  });
};
for (const event of ['resize', 'orientationchange', 'pageshow']) window.addEventListener(event, scheduleLayout);
window.visualViewport?.addEventListener('resize', scheduleLayout);
window.visualViewport?.addEventListener('scroll', scheduleLayout);
const ui = new GameUI();
const app = new StoryApp(ui);
const domUi = new DomUi();
ui.onQuestPopup = kind => app.audio?.ui(kind === 'start' ? 'questStart' : 'questComplete');

const addressParams = new URLSearchParams(location.search);
/**
 * GM（调试）开关：持久值来自本地存储（标题页点击右下角版本号切换）。
 * `?gm` 只在**本次会话**打开，不写存储——否则谁试一次地址参数，就悄悄改了用户的机器。
 * GM 入口会暴露运行实例与控制台钩子：agent 用 `?gm` 一个参数就能读状态。
 */
const gmFromAddress = addressParams.has('gm');
const gmOn = (): boolean => gmFromAddress || app.gmMode.on;
// 生产构建信任构建期校验；?gm 或持久 GM 强制走完整校验。
app.content.trusted = trustedContentNow() && !gmOn();

const inspect = gmFromAddress;

/** 进图/读档完成后的刷新率补测；由 boot() 装配，场景就绪时调用。 */
let remeasureRefreshAfterStart: (() => void) | undefined;

let modeRequest = new AbortController();
/** 内容目录与存档无关：标题页开始预载后，职业选择、读档和进图都复用同一份。 */
const contentRequest = new AbortController();
/** 启动阶段上报：卡住时诊断日志里的最后一条就是现场。 */
function recordStartPhase(phase:string,details?:Record<string,unknown>):void{
  try{globalThis.storyDiagnostics?.record('start-phase',{phase,...details});}
  catch{/* 诊断不能影响启动 */}
}
const savedGameLoader=new SavedGameLoader();
/**
 * 自动存档：进图、剧情事件完成、任务接取/完成、定时四种时机合并写入唯一的自动槽。
 * 会话装上之后才创建，回到主菜单时停掉。
 */
let autoSaver:AutoSaver<StoryWorldViewSnapshot>|undefined;
/** 最近一张成功截下的存档缩略图；背景写出或截图失败时沿用上一张。 */
let lastSaveThumbnail:string|undefined;
/** 自动存档代次：停止后旧的异步写入即使截图才落地也不能再写。 */
let autoSaveGeneration=0;
let unsubscribeAutoSaveQuests:(()=>void)|undefined;
function stopAutoSave():void {
  autoSaveGeneration++;
  unsubscribeAutoSaveQuests?.();unsubscribeAutoSaveQuests=undefined;
  autoSaver?.stop();autoSaver=undefined;
  // 上一局的截图不能跟着新的自动存档写进新会话。
  lastSaveThumbnail=undefined;
}
function startAutoSave(session:Session):void {
  stopAutoSave();
  const generation=autoSaveGeneration;
  const saver=new AutoSaver<StoryWorldViewSnapshot>({
    // 调试现场不写玩家存档：focus 存在时自动存档整个停掉，结束调试后由 GM 动作恢复。
    enabled:()=>app.mode==='game'&&!app.suspended&&!!app.session&&!app.pressureMode&&!app.session.debugFocusQuest&&!app.gm?.storyDebug().autoSavePaused,
    // 演出与菜单锁着时不抢写：等解锁后再写，免得存到一半的状态。
    locked:()=>app.locked||!!app.director?.busy,
    capture:()=>{const captured=app.storyUI.captureSaveRecord(lastSaveThumbnail);return captured.ok?captured.record:undefined;},
    write:game=>{
      if(generation===autoSaveGeneration&&app.session===session&&app.mode==='game'){
        const started=performance.now();
        try {
          app.saves.write(AUTO_SAVE_SLOT,game);
          globalThis.storyDiagnostics?.record('save',{slot:'auto',mode:'sync',
            elapsedMs:Math.round((performance.now()-started)*10)/10},false);
        } catch(error) {
          globalThis.storyDiagnostics?.record('save-error',{slot:'auto',mode:'sync',error});
          throw error;
        }
      }
    },
    // 常规自动存档先截一张当前画面；页面即将隐藏时仍走同步 write，保留上一张截图。
    writeAsync:async (game,isLatest)=>{
      const started=performance.now();
      const screenshot=await app.captureSaveThumbnail?.();
      // 等截图期间回标题、读档或换了会话时，不能把旧快照写进新的自动槽。
      if(!isLatest()||generation!==autoSaveGeneration||app.session!==session||app.mode!=='game')return;
      if(screenshot)game.summary.screenshot=screenshot;
      try {
        app.saves.write(AUTO_SAVE_SLOT,game);
        globalThis.storyDiagnostics?.record('save',{slot:'auto',mode:'async',
          elapsedMs:Math.round((performance.now()-started)*10)/10},false);
      } catch(error) {
        globalThis.storyDiagnostics?.record('save-error',{slot:'auto',mode:'async',error});
        throw error;
      }
    },
  });
  autoSaver=saver;
  unsubscribeAutoSaveQuests=saver.watchQuests(session);
  saver.start();
}
let storyPreparation: Promise<void> | undefined;
interface MenuPreparation {
  signal: AbortSignal;
  progress: number;
  listeners: Set<(value: number) => void>;
  /** 菜单框架与立绘：开局前必须就绪。 */
  core: Promise<void>;
  /** 物品/技能图标：开局后后台补，不挡世界加载。 */
  all: Promise<void>;
}
let menuPreparation: MenuPreparation | undefined;
/** 当前模式对应的场景键。写成 `Record<GameMode, …>`：新增模式时必须在这里表态。 */
const MODE_SCENES:Record<GameMode,string>={menu:SCENE_KEYS.menu,'class-select':SCENE_KEYS.classSelect,game:SCENE_KEYS.world};
function currentScene(): Phaser.Scene | undefined {
  return app.game?.scene.getScene(MODE_SCENES[app.mode]);
}

function afterFirstPaint(work: () => void): void {
  requestAnimationFrame(() => setTimeout(work, 0));
}

function menuPreparationFor(signal: AbortSignal): MenuPreparation | undefined {
  let state = menuPreparation;
  if (!state || state.signal !== signal) {
    const host = app.uiAssets;
    if (!host) return undefined;
    const groups = gameMenuImageGroups(app.menuPanels, app.items, app.battleCatalog, app.storyInterface, app.shops);
    const extra = [...new Set([...groups.extra,
      ...Object.values(app.companions.groupSkills??{}).map(skill=>skill.icon)])];
    const next: MenuPreparation = { signal, progress: 0, listeners: new Set(), core: Promise.resolve(), all: Promise.resolve() };
    menuPreparation = next;
    recordStartPhase('menu-prepare-start',{core:groups.core.length,extra:extra.length});
    const report = (value: number, base: number, span: number) => {
      next.progress = base + value * span;
      for (const listener of next.listeners) listener(next.progress);
    };
    const fail = (error: unknown) => { if (menuPreparation === next) menuPreparation = undefined; throw error; };
    // 图标图集一次加载：物品/技能图标在世界 HUD 上就要用，不能被后台补图拖成空白。
    const coreFiles = [...groups.core, ...Object.values(app.controlSkin), UI_ICON_ATLAS_FILE];
    next.core = host.preloadResident([...coreFiles,
      ...Object.values(app.statusHud.assets), ...Object.values(app.statusHud.buffIcons.catalog),
      ...MINIMAP_ASSETS.map(key => app.storyInterface.assets[key])], signal, value => report(value, 0, 0.6))
      .then(() => recordStartPhase('menu-core-loaded')).catch(fail);
    next.all = next.core.then(() => extra.length
      ? host.preloadResident(extra, signal, value => report(value, 0.6, 0.4)).then(() => recordStartPhase('menu-extra-loaded'))
      : undefined).catch(fail);
    // 只等 core 的调用方不会观察 all；挂一个空处理，避免后台失败变成未处理拒绝。
    void next.all.catch(() => {});
    state = next;
  }
  return state;
}
function prepareMenuCore(signal: AbortSignal, onProgress?: (value: number) => void): Promise<void> {
  const state = menuPreparationFor(signal);
  if (!state) return Promise.reject(new Error('界面场景尚未就绪'));
  if (onProgress) {
    state.listeners.add(onProgress);
    onProgress(state.progress);
    const current = state;
    void current.core.finally(() => current.listeners.delete(onProgress)).catch(() => {});
  }
  return state.core;
}
/** 后台图标加载完时，已经打开的菜单要重画一次，否则首次打开会保留缺图占位。 */
function refreshMenuWhenReady(signal: AbortSignal): void {
  const state = menuPreparationFor(signal);
  if (!state) return;
  void state.all.then(() => app.storyUI?.refreshMenuAssets()).catch(error => {
    if (!signal.aborted) globalThis.storyDiagnostics?.record('menu-asset-error', { error });
  });
}

function clearMenuPreparations(): void {
  menuPreparation = undefined;
  app.uiAssets?.releaseContent();
}

function prepareStory(_signal: AbortSignal): Promise<void> {
  if (app.campaign) return Promise.resolve();
  if (storyPreparation) return storyPreparation;
  // 内容目录是公共资源，不随某个入口的取消信号中止；调用方拿到结果后再检查自己的信号。
  const signal = contentRequest.signal;
  const task = (async () => {
    recordStartPhase('story-fetch-start',{trusted:app.content.trusted,gm:gmOn()});
    const [world, campaign, presentation, battle, panels, items, wardrobe, statusHud, controlSkin, stats, shops, companions, crafting] = await Promise.all([
      app.content.world(signal), app.content.campaign(signal), app.content.storyInterface(signal), app.content.battle(signal),
      app.content.menuPanels(signal), app.content.items(signal), app.content.wardrobe(signal),
      app.content.statusHud(signal), app.content.controlSkin(signal), app.content.characterStats(signal), app.content.shops(signal), app.content.companions(signal), app.content.crafting(signal)
    ]).catch(error => {
      globalThis.storyDiagnostics?.record('content-load-error', { stage: 'story-fetch', error });
      throw error;
    });
    signal.throwIfAborted();
    recordStartPhase('story-fetched');
    // 调试现场表是独立产物：只有 GM 会话加载，普通游玩不请求 1.35MB 的调试数据。
    if (gmOn()) campaign.debugStory = await app.content.storyDebug(signal);
    signal.throwIfAborted();
    recordStartPhase('story-debug-ready');
    // 生产构建信任构建期校验：不重复跑语义校验，也不为校验 fetch 281 张剧情地图。
    // dev/测试/?gm 仍走完整路径。
    if (!app.content.trusted) {
      validateMenuClasses(panels, battle);
      validateWardrobe(wardrobe, items, battle);
      validateItemSkills(items, battle);
      validateCharacterStats(stats, items, battle);
      validateStoryItems(campaign, items);
      validateShops(shops, items, world);
      validateCrafting(crafting, items);
      validateCompanions(companions,world,battle,stats,campaign);
      const storyMaps = new Map(await Promise.all([...storyReferenceMaps(campaign)].map(async id => {
        const reference = world.maps.find(map => map.id === id);
        if (!reference) throw new Error(`剧情地图不存在：${id}`);
        return [id, await app.content.map(reference.file, signal)] as const;
      })));
      signal.throwIfAborted();
      validateStoryReferences(campaign, world, battle, storyMaps, items);
      validateStoryPerformance(world, campaign, storyMaps, app.audio?.catalog);
      validateStoryPortraits(world, presentation);
      app.content.releaseValidationCaches(wardrobe);
    }
    recordStartPhase('story-validated',{trusted:app.content.trusted});
    Object.assign(app, { world, campaign, storyInterface: presentation, battleCatalog: battle, characterStats: stats,
      menuPanels: panels, items, wardrobe, statusHud, controlSkin, shops, companions, crafting });
    recordStartPhase('story-assigned');
    // 商店装备表在进游戏前就开始取，走路到商人时通常已经就绪；首次打开不再等这一下。
    if(!Object.keys(app.shops.equipment).length){
      void app.content.shopEquipment(signal).then(equipment => { app.shops.equipment = equipment; }).catch(error => {
        if(!signal.aborted)globalThis.storyDiagnostics?.record('shop-equipment-warm-error',{error});
      });
    }
  })();
  storyPreparation = task;
  void task.catch(() => { if (storyPreparation === task) storyPreparation = undefined; });
  return task;
}

let commonPreloadTask: Promise<void> | undefined;
let commonPreloadRequest = new AbortController();
let commonPreloadBatches: ReturnType<typeof commonAssetBatches> | undefined;
let commonPreloadIndex = 0;
let commonPreloadResume = false;

/** 进图前停掉后台预载；已经载完的批次保留，进图计划会直接复用。 */
function cancelCommonPreload(): void {
  commonPreloadResume = false;
  commonPreloadRequest.abort();
}

/** 标题页后台预载公共素材；按小批推进，开始游戏时最多等当前一批。 */
function prefetchCommon(): void {
  if (commonPreloadTask) { commonPreloadResume = true; return; }
  const request = commonPreloadRequest = new AbortController();
  const task = preloadCommon(request.signal);
  commonPreloadTask = task;
  void task.finally(() => {
    if (commonPreloadTask !== task) return;
    commonPreloadTask = undefined;
    if (commonPreloadResume) { commonPreloadResume = false; prefetchCommon(); }
  });
}

async function preloadCommon(signal: AbortSignal): Promise<void> {
  try {
    await prepareStory(signal);
    signal.throwIfAborted();
    const { world, battleCatalog, wardrobe, companions, items, statusHud, controlSkin, storyInterface } = app;
    if (!world || !battleCatalog || !wardrobe || !companions || !items || !statusHud || !controlSkin || !storyInterface) return;
    const scene = app.game?.scene.getScene(SCENE_KEYS.formalUi) as Phaser.Scene | undefined;
    if (!scene?.sys.isActive()) return;
    commonPreloadBatches ??= commonAssetBatches({
      world, battle: battleCatalog, wardrobe, companions, items, statusHud, controlSkin, storyInterface
    });
    while (commonPreloadIndex < commonPreloadBatches.length) {
      signal.throwIfAborted();
      const lease = await loadSceneAssets(scene, commonPreloadBatches[commonPreloadIndex]!, () => {}, true, signal);
      if (signal.aborted) { lease.release(); signal.throwIfAborted(); }
      app.commonAssetLeases.push(lease);
      commonPreloadIndex += 1;
      // 让出一拍，菜单输入和动画不被连续下载占满。
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
  } catch (error) {
    if (!signal.aborted) globalThis.storyDiagnostics?.record('common-preload-error', { error });
  }
}

async function enterGame(slot?:number): Promise<void> {
  if (app.mode !== 'menu' || app.suspended || !app.game?.scene.isActive('menu')) return;
  app.saveSlot=slot;
  modeRequest.abort(); modeRequest = new AbortController();
  const signal = modeRequest.signal;
  app.mode = 'class-select'; ui.setMode('class-select'); ui.loading('正在加载资源…');
  recordSceneChange(SCENE_KEYS.classSelect, { source: 'menu' });
  try {
    app.storyClasses = await app.content.storyClasses(signal);
    signal.throwIfAborted();
    const menu = app.game!.scene.getScene(SCENE_KEYS.menu);
    menu.scene.start(SCENE_KEYS.classSelect);
  } catch (error) {
    if(signal.aborted)return;
    console.error(error);
    globalThis.storyDiagnostics?.record('content-load-error', { stage: 'story-classes', error });
    ui.error(error instanceof Error ? error.message : String(error), () => {
      app.mode = 'menu'; void enterGame(slot);
    });
  }
}
function startStory(classId: string): void {
  if (app.mode !== 'class-select' || !ui.ready || app.suspended || !app.game?.scene.isActive('story-class-select')) return;
  const selected = app.storyClasses.classes.find(entry => entry.id === classId);
  if (!selected) return;
  void finishStoryStart(classId);
}
/** 压测场地：全图可站、无实体、无出口、无剧情引用的竞技场。 */
const PRESSURE_MAP = 'arena-map2-aa7923cc';
const PRESSURE_START = { x: 280, y: 200 } as const;

/**
 * 挑战模式连点 5 次的隐藏入口：新建 1 级角色进竞技场，之后由世界场景持续刷怪。
 * 压测不读也不写任何存档槽；退出后正式存档保持原样。
 */
async function startPressureTest(): Promise<void> {
  if (app.pressureMode) return;
  if (app.mode !== 'menu' || app.suspended || !ui.ready || !app.game?.scene.isActive(SCENE_KEYS.menu)
    || savedGameLoader.busy) return;
  modeRequest.abort(); modeRequest = new AbortController();
  const signal = modeRequest.signal;
  app.pressureMode = true;
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
  } catch (error) { fail(error); return; }
  const selected = app.storyClasses.classes.find(entry => entry.id === app.storyClasses.defaultClass);
  if (!selected) { fail(new Error('压测缺少默认职业')); return; }
  cancelCommonPreload();
  app.mode = 'game'; ui.setMode('game'); ui.loading('正在进入压测战场…');
  app.saveSlot = undefined;
  installSession(newStorySession(app.campaign, app.world.actors[app.campaign.start.actor], selected,
    app.items, app.characterStats, app.battleCatalog, app.companions));
  const menu = app.game!.scene.getScene(SCENE_KEYS.menu);
  recordSceneChange(SCENE_KEYS.world, { map: PRESSURE_MAP, source: 'pressure' });
  menu.scene.start(SCENE_KEYS.world, { map: PRESSURE_MAP, x: PRESSURE_START.x, y: PRESSURE_START.y,
    facing: 'south', initialEntry: true, suppressEntry: true,
    onReady: () => { app.storyUI?.prewarmBag(); void worldScene()?.startPressureSpawner(); } });
}

async function finishStoryStart(classId: string): Promise<void> {
  if (app.mode !== 'class-select' || !app.game?.scene.isActive('story-class-select')) return;
  const signal = modeRequest.signal;
  recordStartPhase('class-start',{classId,gm:gmOn(),trusted:app.content.trusted});
  ui.loading('正在开始游戏…');
  try {
    await prepareStory(signal);
    signal.throwIfAborted();
    recordStartPhase('story-ready');
    ui.loading('正在准备游戏菜单…', 0.15);
    await prepareMenuCore(signal, value => ui.loading('正在准备游戏菜单…', 0.15 + 0.35 * value));
    refreshMenuWhenReady(signal);
    signal.throwIfAborted();
    recordStartPhase('menu-ready');
  }
  catch (error) {
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
  app.mode = 'game'; ui.setMode('game'); ui.loading('正在开始游戏…');
  const campaign = app.campaign;
  recordStartPhase('session-install-start');
  installSession(newStorySession(campaign, app.world.actors[campaign.start.actor], selected, app.items,app.characterStats,app.battleCatalog,app.companions));
  recordStartPhase('session-installed');
  recordSceneChange(SCENE_KEYS.world, { map: app.campaign.start.map, source: 'new-game' });
  selection.scene.start(SCENE_KEYS.world, { ...app.campaign.start, initialEntry: true,
    onReady: () => { app.storyUI?.prewarmBag(); remeasureRefreshAfterStart?.(); } });
  recordStartPhase('world-scene-start');
}

/** 标题与游戏内设置共用读档：准备失败保留入口，旧场景关闭后才替换会话。 */
async function resumeSlot(slot:SaveSlotRef,signal?:AbortSignal):Promise<void> {
  // 压测不读写存档；要读档先返回标题，避免把压测会话和存档会话混在一起。
  if(app.pressureMode)return;
  const game=app.game,sourceMode=app.mode,sourceScene=currentScene(),sourceSession=app.session,sourceLifetime=modeRequest;
  if(!game||(sourceMode!=='menu'&&sourceMode!=='game')||app.suspended||!ui.ready||savedGameLoader.busy||
    !sourceScene?.sys.isActive()||sourceMode==='game'&&worldScene()?.loadingWorld)return;
  const isCurrent=()=>modeRequest===sourceLifetime&&app.mode===sourceMode&&currentScene()===sourceScene&&app.session===sourceSession&&
    (sourceScene.sys.isActive()||sourceScene.sys.isPaused());
  const loadStarted=performance.now();
  globalThis.storyDiagnostics?.record('load-start',{slot,from:sourceMode},false);
  try{
    await savedGameLoader.load(slot,{
      isCurrent,
      prepare:async(selectedSlot,request)=>{
        const reading=app.saves.inspect(selectedSlot);
        if(reading.kind!=='ok')throw new Error(reading.kind==='empty'?'没有可以载入的存档。':'游戏存档出错。无法正常进行游戏。');
        ui.loading('正在读取存档…');
        app.storyClasses=await app.content.storyClasses(request);request.throwIfAborted();
        await prepareStory(request);request.throwIfAborted();
        const candidate=prepareSavedGame(reading.game,app);
        await app.content.map(candidate.map.file,request);request.throwIfAborted();
        ui.loading('正在准备游戏菜单…',0.15);
        await prepareMenuCore(request,value=>ui.loading('正在准备游戏菜单…',0.15+0.35*value));
        refreshMenuWhenReady(request);
        request.throwIfAborted();return candidate;
      },
      stopCurrent:async()=>{
        cancelCommonPreload();
        stopAutoSave();app.gm?.dispose();modeRequest.abort();app.director?.dispose();app.clearMapPrefetch();app.clearStoryPrefetch();ui.resetInput();
        const stopped=new Promise<void>(resolve=>sourceScene.events.once(Phaser.Scenes.Events.SHUTDOWN,()=>resolve()));
        game.scene.stop(sourceScene.sys.settings.key);await stopped;
        app.releaseResidentCombat();
      },
      install:(candidate,lifetime)=>{
        modeRequest=lifetime;const {session,world}=candidate,location=world.location;
        app.mode='game';ui.setMode('game');ui.loading('正在读取存档…');
        // 自动槽不是玩家手动选择的槽，所以这里留空。
        app.saveSlot=slot===AUTO_SAVE_SLOT?undefined:slot;
        installSession(session, candidate.map.file);
        recordSceneChange(SCENE_KEYS.world, { map: location.map, source: 'load' });
        game.scene.start(SCENE_KEYS.world,{map:location.map,x:location.x,y:location.y,facing:location.facing,
          initialEntry:true,suppressEntry:true,resumeStory:true,signal:lifetime.signal,checkpoint:world.world,generatedEntities:world.generatedEntities,preparedScene:world.scene,
          onReady:()=>{
            if(lifetime.signal.aborted)return;
            remeasureRefreshAfterStart?.();
            if(world.audio)app.audio?.restoreStoryAudio(world.audio);
            window.setTimeout(()=>{if(!lifetime.signal.aborted)globalThis.storyDiagnostics?.record('load-audio-ready',{map:location.map});},AUDIO_READY_DIAGNOSTIC_DELAY_MS);
          }});
      },
    },signal);
    globalThis.storyDiagnostics?.record('load',{slot,
      elapsedMs:Math.round((performance.now()-loadStarted)*10)/10},false);
  }catch(error){
    // 玩家返回、切槽或换会话会让 loader 抛 AbortError；取消不是读档失败，不能写进错误流。
    const cancelled=!!signal?.aborted||(typeof error==='object'&&error!==null
      &&(error as {name?:string}).name==='AbortError');
    if(cancelled){
      globalThis.storyDiagnostics?.record('load-cancel',{slot},false);
    }else{
      globalThis.storyDiagnostics?.record('load-error',{slot,
        elapsedMs:Math.round((performance.now()-loadStarted)*10)/10,error});
    }
    if(isCurrent())ui.loaded();throw error;
  }
}

async function changePressureClass(classId:string):Promise<void> {
  const selected=app.storyClasses.classes.find(entry=>entry.id===classId);
  const scene=worldScene(), game=app.game;
  if(!app.pressureMode||!selected||!scene||!game||scene.loadingWorld)return;
  const oldSession=app.session;
  ui.loading('正在进入压测战场…');
  stopAutoSave();app.gm?.dispose();app.director?.dispose();modeRequest.abort();modeRequest=new AbortController();
  app.clearMapPrefetch();app.clearStoryPrefetch();ui.resetInput();
  const stopped=new Promise<void>(resolve=>scene.events.once(Phaser.Scenes.Events.SHUTDOWN,()=>resolve()));
  game.scene.stop(SCENE_KEYS.world);await stopped;
  app.releaseSession(oldSession);
  if(!app.pressureMode)return;
  app.saveSlot=undefined;
  installSession(newStorySession(app.campaign,app.world.actors[app.campaign.start.actor],selected,
    app.items,app.characterStats,app.battleCatalog,app.companions));
  recordSceneChange(SCENE_KEYS.world, { map: PRESSURE_MAP, source: 'pressure-class' });
  game.scene.start(SCENE_KEYS.world,{map:PRESSURE_MAP,x:PRESSURE_START.x,y:PRESSURE_START.y,
    facing:'south',initialEntry:true,suppressEntry:true,
    onReady:()=>{app.storyUI?.prewarmBag();void worldScene()?.startPressureSpawner();}});
}

/** 新开与读档共用的会话装配：世界场景、菜单、剧情播放器与界面都接到这份会话上。 */
function installSession(session: Session, keepMapFile?: string): void {
  stopAutoSave();app.gm?.dispose();app.director?.dispose();
  // 会话可能换了职业；旧常驻包、历史地图纹理和会话级内容解析结果都不再复用。
  app.releaseResidentCombat();
  app.clearMapHistory();
  app.clearStoryPrefetch();
  app.content.clearSessionCaches(keepMapFile);
  app.outfits?.destroy();
  app.outfits = new OutfitPool({ textures: app.game!.textures, anims: app.game!.anims, game: app.game! },
    app.wardrobe, app.items, (ids, signal) => app.content.wardrobePoses(ids, signal));
  const campaign = app.campaign, presentation = app.storyInterface;
  app.session = session;
  globalThis.storyDiagnostics?.record('session-install', {
    slot: app.saveSlot ?? null, map: session.storyWorld.currentLocation?.map ?? null,
    pressure: app.pressureMode, party: session.party?.activeIds ?? null,
    classId: session.hero?.classId ?? null, level: session.hero?.level ?? null,
  }, false);
  app.storySignal = modeRequest.signal;
  app.checkpoint.clear();
  app.summonLampMerchant=(entry,signal)=>requireWorldScene().summonLampMerchant(entry,signal);
  app.changeEquipment=async(entry,slot,signal,memberId)=>requireWorldScene().changeEquipment(entry,slot,signal,memberId);
  app.equipmentAppearance=memberId=>worldScene()?.equipmentAppearance(memberId);
  app.preparePartyMember=async(id,signal,options)=>{const scene=worldScene();if(scene)await scene.preparePartyMember(id,signal,options);};
  app.releasePartyPreview=()=>worldScene()?.releasePartyPreview();
  // 属性页只在菜单重绘时读一次；菜单打开期间战斗已暂停，Buff 不会继续走。
  app.combatAttribute=(id,attribute,base,passives)=>worldScene()?.combatAttribute(id,attribute,base,passives)??base;
  app.combatStealthed=id=>worldScene()?.combatStealthed(id)??false;
  app.revivePartyMember=(id,item)=>requireWorldScene().revivePartyMember(id,item);
  ui.playerActor = campaign.start.actor;
  app.storyUI.bind(session, app.world, presentation);
  ui.questItemName = id => app.items.items[id]?.name ?? id;
  const presenter = new StoryPresenter(app, () => worldScene()!, () => app.game!.scene.getScene(SCENE_KEYS.storyStage) as StoryStageScene);
  const director = new StoryDirector(campaign, session, ui, locked => {
    if (app.director !== director) return;
    ui.lock(locked,'game');
    if (!locked) app.storyAssetPreparation.clear();
    const scene = worldScene();
    if (locked && scene?.player) scene.setClip(scene.player, `idle-${scene.facing}`);
  }, presenter, {
    normalize: signal => worldScene()?.normalizeForStory(signal),
    capture: () => worldScene()?.captureStoryWorld(),
    restore: async (snapshot, signal) => { await worldScene()?.restoreStoryWorld(snapshot, signal); },
    project: async (stage, signal) => { await worldScene()?.projectStoryWorld(stage, signal); },
    checkpoint: () => worldScene()?.checkpointStoryWorld(),
    settle: () => worldScene()?.settleStoryPlayback(),
    prepare: async (_commands, signal, stage, script, cursor) => {
      const scene = worldScene();
      // 剧情开演前先等在途进图；世界不完整时把真实错误交给错误页和重试路径恢复。
      await scene?.waitWorldReady(signal);
      if (scene?.map) {
        const target = cursor ? nextStoryMap(campaign, cursor, scene.map.id)
          : stage && !stage.mapFromWorld ? stage.map : undefined;
        void scene.prefetchStoryEntry(target ?? scene.map.id, script, signal);
      }
      signal.throwIfAborted();
    },
    prefetch: async (scripts, signal) => { await worldScene()?.ensureStoryAssets(scripts, signal); },
  });
  app.director = director;
  if (globalThis.storyDiagnostics) installStorySkipDiagnostics(director,
    (kind, details) => globalThis.storyDiagnostics?.record(kind, details, false));
  // 事件播完（世界投影已经结束）写入自动存档；节点中途不写。
  director.onEventCompleted = () => autoSaver?.request();
  director.onError = (error, retry) => {
    if (app.director !== director || app.mode !== 'game') return;
    console.error(error);
    const message = error instanceof Error ? error.message : String(error);
    const snapshot = worldScene()?.diagnosticSnapshot();
    globalThis.storyDiagnostics?.record('story-error', { message, stack: error instanceof Error ? error.stack : undefined,
      map: snapshot?.map, player: snapshot?.player });
    ui.error(message, () => {
      ui.loaded(); void (async () => {
        try {
          // 世界只建了一半时先重建，成功后再接着走剧情游标。
          await worldScene()?.recoverWorld();
          await retry();
        } catch (next) { director.onError?.(next, retry); }
      })();
    });
  };
  // GM 动作层在会话装配好之后才建（它要 session 与 director）；开关关闭时**不建也不挂**，
  // 这样「默认关闭」是结构上的保证，而不是靠调用方自觉。
  app.gm = gmOn() ? createGmActions({
    session, campaign, director, markStore: new IndexedDbDebugMarkStore(),
    acquireStoryCatalog:()=>app.acquireDebugCatalog(),
    prepareMark: async (mark, signal) => { signal.throwIfAborted(); const prepared = prepareDebugMark(mark, app); signal.throwIfAborted(); return prepared; },
    status: () => runtimeDiagnostics(),
    onStoryPreparation: preparing => { if(preparing)app.ui.loading('正在准备剧情…');else app.ui.loaded(); },
    rescue: () => {
      const scene = worldScene();
      if (!scene) return { ok: false, reason: '不在游戏场景里' };
      return scene.rescuePlayer();
    },
    travel: async (map, position) => {
      const scene = worldScene();
      return scene ? scene.gmTravel(map, position) : { ok: false, reason: '不在游戏场景里' };
    },
    setNoclip: enabled => {
      app.gmNoclip = enabled;
      const scene = worldScene();
      if (scene) scene.setNoclip(enabled);
      return { ok: true };
    },
    isNoclip: () => app.gmNoclip,
    setSpeedMultiplier: multiplier => {
      app.gmSpeedMultiplier = multiplier;
      const scene = worldScene();
      if (scene) scene.setSpeedMultiplier(multiplier);
      return { ok: true };
    },
    getSpeedMultiplier: () => app.gmSpeedMultiplier ?? 1,
    persistence: {
      // 调试现场不写玩家存档：停掉待写与重试。
      suspend: () => autoSaver?.suspend(),
      // 结束调试：恢复自动存档、把当前现场记成检查点，再按正常节奏请求一次存档。
      resume: () => {
        autoSaver?.resume();
        worldScene()?.checkpointStoryWorld();
        autoSaver?.request();
      },
      // 回滚流程（死亡回检查点）接管调试现场：此刻画面还停在调试现场，只能恢复写入，不能记检查点。
      resumeAfterRollback: () => autoSaver?.resume(),
    },
    debugWorld: {
      capture: () => {
        try { return worldScene()?.captureStoryWorld(); }
        catch { return undefined; }
      },
      capturePersistent: () => {
        try { const scene = worldScene(); return scene ? persistentDebugWorld(scene.captureStoryWorld()) : undefined; }
        catch { return undefined; }
      },
      restore: async (snapshot, signal = modeRequest.signal) => {
        const scene = worldScene();
        if (!scene) return { ok: false, reason: '不在游戏场景里' };
        try {
          await scene.restoreStoryWorld(prepareDebugWorld(snapshot, app), signal);
          return { ok: true };
        } catch (error) {
          return { ok: false, reason: error instanceof Error ? error.message : String(error) };
        }
      },
    },
    onDebugStory: () => app.storyUI.openDebugStory(),
    ui: () => app.storyUI.diagnosticState(),
    combat: {
      setInvincible: (id, enabled) => {
        const scene = worldScene();
        return scene ? scene.setInvincible(id, enabled) : { ok: false, reason: '不在游戏场景里' };
      },
      // 开关存在会话上，换图重建战斗后仍然有效，所以读取不必经过场景。
      isInvincible: id => session.isInvincible(id),
      setOneHitKill: (id, enabled) => {
        const scene = worldScene();
        return scene ? scene.setOneHitKill(id, enabled) : { ok: false, reason: '不在游戏场景里' };
      },
      isOneHitKill: id => session.isOneHitKill(id),
      revive: id => {
        const scene = worldScene();
        return scene ? scene.reviveMember(id) : { ok: false, reason: '不在游戏场景里' };
      },
    },
  }) : undefined;
  if (app.gm) globalThis.gm = consoleGmActions(app.gm); else delete globalThis.gm;
  app.audio?.enterStory();
  // 会话装好之后再开自动存档：它要绑定这一份会话的任务状态。
  startAutoSave(session);
}

function returnToMenu(): void {
  if (!ui.canReturn) return;
  if (app.mode === 'game' && worldScene()?.loadingWorld && !ui.failed) return;
  app.pressureMode = false;
  const returnPage=app.mode==='class-select'?'slots':'home';
  const departedSession = app.session;
  savedGameLoader.cancel();stopAutoSave();app.gm?.dispose();modeRequest.abort();modeRequest=new AbortController();clearMenuPreparations(); app.director?.dispose(); app.clearMapPrefetch(); app.clearStoryPrefetch(); ui.resetInput();
  // 会话已经销毁：把动作层一起摘掉，免得 agent 拿到一个指向已 dispose 导演的句柄。
  app.gm = undefined; delete globalThis.gm;
  const scene = currentScene();
  const releaseSessionAssets = () => { app.releaseSession(departedSession); };
  const stage = app.game?.scene.getScene(SCENE_KEYS.storyStage);
  if (stage && (stage.sys.isActive() || stage.sys.isPaused() || stage.sys.isSleeping())) app.game!.scene.stop(SCENE_KEYS.storyStage);
  if (scene?.sys.isActive() || scene?.sys.isPaused()) {
    // 场景还活着时不能提前删纹理；等 WorldScene/当前场景真正 shutdown 后再释放。
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, releaseSessionAssets);
    scene.scene.start(SCENE_KEYS.menu,{page:returnPage});
  } else releaseSessionAssets();
  // 初始内容请求失败时菜单场景仍在运行。
  app.mode = 'menu'; ui.lock(false,'game'); ui.setMode('menu');
  recordSceneChange(SCENE_KEYS.menu, { source: 'return' });
  app.audio?.enterMenu();
}
/**
 * 人、面板、上报与 CDP 共用的一份运行态。卡住时按「锁 → 场景 → 战斗 → 移动体」的顺序看：
 * `lockOwners` 说明谁按住了操作，`world.player.inWall` 说明身体是否嵌进墙，
 * `world.combat` 说明技能/暂停/状态是否还挂着。
 */
const frameStats = new FrameStats();
let diagnosticFrames = 0;
let diagnosticLongFrames = 0;
// 用 -Infinity 而不是 0：判断基于 performance.now()，初始 0 会让启动后前 5 分钟的掉帧无法上报。
let lastLowFpsAt = Number.NEGATIVE_INFINITY;
let heartbeatIndex = 0;
let cachedRenderer: Record<string, unknown> | null = null;
let cachedStorage: Record<string, unknown> | null = null;
let cachedStorageAt = 0;
let cachedTextureBytes = -1;
let cachedTextureBytesAt = 0;
let cachedTextureCount = -1;
let cachedTextureCountAt = 0;

function recordSceneChange(scene: string, details: Record<string, unknown> = {}): void {
  globalThis.storyDiagnostics?.record('scene-change', { scene, mode: app.mode, ...details }, false);
}

function rendererDiagnostics(): Record<string, unknown> | null {
  if (cachedRenderer) return cachedRenderer;
  const renderer = app.game?.renderer as unknown as { gl?: WebGL2RenderingContext | WebGLRenderingContext } | undefined;
  const gl = renderer?.gl;
  if (!gl) return null;
  try {
    const debug = gl.getExtension('WEBGL_debug_renderer_info') as
      { UNMASKED_VENDOR_WEBGL: number; UNMASKED_RENDERER_WEBGL: number } | null;
    cachedRenderer = {
      version: gl.getParameter(gl.VERSION) as string,
      vendor: gl.getParameter(gl.VENDOR) as string,
      renderer: gl.getParameter(gl.RENDERER) as string,
      unmaskedVendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) as string : null,
      unmaskedRenderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) as string : null,
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    };
  } catch { cachedRenderer = { unavailable: true }; }
  return cachedRenderer;
}

function textureDiagnostics(): Record<string, unknown> {
  const game = app.game;
  if (!game) return { count: 0, estimatedBytes: null };
  try {
    const now = performance.now();
    // 事件记录可能每秒多条；纹理名单一秒最多取一次，避免每条记录都分配一个键数组。
    if (cachedTextureCount < 0 || now - cachedTextureCountAt > 1000) {
      const keys = game.textures.getTextureKeys();
      cachedTextureCount = keys.length;
      cachedTextureCountAt = now;
      if (cachedTextureBytes < 0 || now - cachedTextureBytesAt > 60_000) {
        let bytes = 0;
        for (const key of keys) {
          const texture = game.textures.get(key) as unknown as
            { source?: { width?: number; height?: number } | Array<{ width?: number; height?: number }> };
          const source = Array.isArray(texture?.source) ? texture.source[0] : texture?.source;
          if (source?.width && source?.height) bytes += source.width * source.height * 4;
        }
        cachedTextureBytes = bytes;
        cachedTextureBytesAt = now;
      }
    }
    return { count: cachedTextureCount, estimatedBytes: cachedTextureBytes };
  } catch { return { count: 0, estimatedBytes: null }; }
}

function storageDiagnostics(): Record<string, unknown> | null {
  const now = performance.now();
  if (cachedStorage && now - cachedStorageAt < 300_000) return cachedStorage;
  cachedStorageAt = now;
  try {
    const storage = navigator.storage;
    if (!storage?.estimate) return null;
    void storage.estimate().then(estimate => {
      cachedStorage = { quota: estimate.quota ?? null, usage: estimate.usage ?? null };
    }).catch(() => {
      // 失败也记下结果：否则缓存一直是 null，每条诊断都会重新发起一次估算。
      cachedStorage = { unavailable: true };
    });
  } catch { return null; }
  return cachedStorage;
}

function memoryUsage(): Record<string, number> | null {
  const memory = (performance as Performance & { memory?: {
    usedJSHeapSize?: number; totalJSHeapSize?: number; jsHeapSizeLimit?: number } }).memory;
  if (!memory) return null;
  return { usedBytes: memory.usedJSHeapSize ?? 0, totalBytes: memory.totalJSHeapSize ?? 0,
    limitBytes: memory.jsHeapSizeLimit ?? 0 };
}

function navigatorMetrics(): Record<string, unknown> {
  const nav = navigator as Navigator & { deviceMemory?: number; connection?: {
    effectiveType?: string; downlink?: number; rtt?: number; saveData?: boolean } };
  const connection = nav.connection;
  return {
    hardwareConcurrency: nav.hardwareConcurrency || null,
    deviceMemory: nav.deviceMemory ?? null,
    online: nav.onLine,
    connection: connection ? { effectiveType: connection.effectiveType ?? null,
      downlink: connection.downlink ?? null, rtt: connection.rtt ?? null,
      saveData: connection.saveData ?? null } : null,
    maxTouchPoints: nav.maxTouchPoints,
    language: nav.language,
  };
}

/** 每条诊断记录都附带的轻量指标；只做整数统计和缓存读取，不遍历纹理之外的集合。 */
function diagnosticMetrics(): Record<string, unknown> {
  return {
    frames: frameStats.snapshot(),
    heap: memoryUsage(),
    textures: textureDiagnostics(),
    renderer: rendererDiagnostics(),
    screen: { width: innerWidth, height: innerHeight, pixelRatio: devicePixelRatio,
      refreshHz: currentRefreshRate(), orientation: screen.orientation?.type ?? null,
      visualScale: visualViewport?.scale ?? null },
    settings: { frameRateLimit: displaySettings.frameRateLimit, renderScale: displaySettings.renderScale,
      fpsReadout: displaySettings.fps, textureBatching: displaySettings.textureBatching },
    document: { hidden: document.hidden, focused: document.hasFocus() },
    storage: storageDiagnostics(),
    ...navigatorMetrics(),
  };
}

/** 心跳只带少量状态，避免每分钟复制一份完整战斗现场。 */
function compactDiagnostics(): Record<string, unknown> {
  const session = app.session;
  const scene = worldScene();
  const location = session?.storyWorld.currentLocation;
  return {
    mode: app.mode, map: scene?.map?.id ?? location?.map ?? null,
    location: location ? { x: Math.round(location.x), y: Math.round(location.y), facing: location.facing } : null,
    player: session?.player ? { health: session.player.health, mana: session.player.mana } : null,
    quest: session?.currentQuest()?.id ?? null,
    locked: ui.locked, lockOwners: ui.lockOwners,
    menuOpen: app.storyUI?.menuOpen ?? false, storyBusy: app.director?.busy ?? false,
    saveSlot: app.saveSlot ?? null,
  };
}

/** 每分钟检查一次：明显掉帧才上报；在游戏世界内每分钟发一条心跳。 */
function diagnosticTick(): void {
  const framesNow = frameStats.snapshot();
  const longDelta = framesNow.longFrames - diagnosticLongFrames;
  const frameDelta = framesNow.frames - diagnosticFrames;
  diagnosticLongFrames = framesNow.longFrames;
  diagnosticFrames = framesNow.frames;
  const target = displaySettings.frameRateLimit;
  const now = performance.now();
  // 切后台或长停顿后窗口里可能只有帧间隔、还没有每秒帧率样本；此时 avg/min 都是 0，
  // 不能当成明显掉帧，否则会写一条假记录并占掉接下来 5 分钟的上报额度。
  const degraded = framesNow.samples >= 30 && framesNow.secondSamples > 0 && frameDelta > 0
    && (framesNow.avgFps < target * 0.8 || framesNow.minFps < target * 0.5 || longDelta >= 5);
  if (degraded && now - lastLowFpsAt > 5 * 60_000) {
    lastLowFpsAt = now;
    const location = app.session?.storyWorld.currentLocation;
    globalThis.storyDiagnostics?.record('performance-low-fps', {
      target, fps: framesNow.fps, avgFps: framesNow.avgFps, minFps: framesNow.minFps,
      longFrames: longDelta, frames: frameDelta,
      maxFrameMs: framesNow.maxFrameMs, p95FrameMs: framesNow.p95FrameMs,
      map: location?.map ?? null, mode: app.mode,
    }, false);
  }
  heartbeatIndex += 1;
  const inWorld = app.mode === 'game' && !!worldScene();
  if (!inWorld && heartbeatIndex % 5 !== 0) return;
  if (document.visibilityState !== 'visible') return;
  globalThis.storyDiagnostics?.record('heartbeat', compactDiagnostics(), false);
}

function runtimeDiagnostics(): Record<string, unknown> {
  const session = app.session, party = session?.party;
  const sound=app.game?.sound, context=(sound as Phaser.Sound.WebAudioSoundManager | undefined)?.context;
  const sounds=sound?.getAll('')??[]; // NoAudioSoundManager 的类型声明要求传入 key。
  return {
    mode: app.mode, ready: ui.ready, locked: ui.locked, lockOwners: ui.lockOwners,
    saveSlot: app.saveSlot ?? null, saveFormat: SAVE_FORMAT,
    pressureMode: app.pressureMode, gm: gmOn(), trustedContent: app.content.trusted,
    input: { editingText: editingText(),
      visualViewport: visualViewport ? { width: visualViewport.width, height: visualViewport.height,
        scale: visualViewport.scale, offsetTop: visualViewport.offsetTop } : null },
    suspended: ui.suspended, defeatOpen: ui.defeatOpen, menuOpen: app.storyUI?.menuOpen ?? false,
    dialogue: !!ui.dialogueState, choice: !!ui.choices, questPopup: !!ui.quest,
    editingControls: ui.controlLayoutEditing, editingKeys: ui.keyBindingEditing, loading: ui.loadingState?.label,
    location: session?.storyWorld.currentLocation,
    player: session?.player, combatTick: session?.combatTick,
    session: session ? {
      nowMs: session.nowMs, combatTick: session.combatTick, money: session.money,
      partyItemChance: session.partyItemChance, currentQuest: session.currentQuest()?.id ?? null,
      debugFocusQuest: session.debugFocusQuest ?? null, bagEntries: session.bag.entries.length,
      party: party ? { controlled: party.controlledId, active: party.activeIds,
        reserves: party.snapshot().reserves, rosterSlots: party.snapshot().rosterSlots } : null,
    } : null,
    audio: app.audio ? { ...app.audio.captureStoryAudio(), settings: app.audio.settings,
      contextState:context?.state??null, managerLocked:sound?.locked??null, managerMuted:sound?.mute??null,
      playing:sounds.filter(item=>item.isPlaying).map(item=>item.key),
      paused:sounds.filter(item=>item.isPaused).map(item=>item.key) } : null,
    world: worldScene()?.diagnosticSnapshot(),
    story: app.director ? { busy: app.director.busy,
      runs: app.director.runtime.snapshot().runs.filter(run => run.status !== 'completed')
        .map(run => ({ event: run.eventId, cursor: run.cursor, status: run.status, encounter: run.waiting?.encounter })) } : null,
  };
}
function boot(): void {
  app.domUi = domUi;
  domUi.attach();
  domUi.setOccluded(uiOcclusion(ui));
  document.fonts?.ready.then(() => domUi.layout()).catch(() => {});
  app.enterGame = enterGame; app.returnToMenu = returnToMenu; app.startStory = startStory;
  app.startPressureTest = startPressureTest;
  app.changePressureClass = changePressureClass;
  app.pausePressure = paused => { const scene=worldScene(); if(!scene)return; if(paused)scene.scene.pause(); else if(!app.suspended)scene.scene.resume(); };
  app.resumeSlot = resumeSlot;
  app.prefetchCommon = prefetchCommon;
  app.captureSaveWorld = () => app.pressureMode ? {ok:false,reason:'pressure'}
    : app.gm?.storyDebug().autoSavePaused ? {ok:false,reason:'debug'} : worldScene()?.captureSaveWorld() ?? {ok:false,reason:'not-ready'};
  // 只读 Phaser 画布，存档页和其他 DOM 界面不在快照里。
  app.captureSaveThumbnail = () => captureSaveThumbnail(app.game)
    .then(screenshot => { if (screenshot) lastSaveThumbnail = screenshot; return screenshot; });
  app.autoSave = () => autoSaver?.request();
  app.captureControlPreview = () => worldScene()?.getControlLayoutPreview()??[];
  app.prefetchStory = () => afterFirstPaint(() => {
    if (modeRequest.signal.aborted || app.mode !== 'class-select') return;
    const signal = modeRequest.signal;
    void prepareStory(signal).then(() => prepareMenuCore(signal)).catch(() => {});
  });
  app.rescuePlayer = () => {
    const scene = worldScene();
    return scene ? scene.rescuePlayer() : { ok: false, reason: '不在游戏场景里' };
  };
  app.storyUI = new StoryUI(app);
  app.openCrafting=actorId=>app.storyUI.openCrafting(actorId);
  app.openShop=(shopId,mapId)=>app.storyUI.openShop(shopId,mapId);
  ui.onStateChange = () => { if(app.game)configureCanvas(app.game,displaySettings.renderScale); app.storyUI.sync(); worldScene()?.syncHud(); domUi.setOccluded(uiOcclusion(ui)); };
  ui.onMenu = returnToMenu;
  ui.onResetInput = () => { worldScene()?.resetInput(); };
  const game = new Phaser.Game({
    type: Phaser.WEBGL, parent: 'game', backgroundColor: '#101d24',
    pixelArt: true, roundPixels: true,
    fps: { ...GAME_FRAME_TIMING, limit: resolveFrameLimit(displaySettings.frameRateLimit, currentRefreshRate()) },
    callbacks: { postBoot: game => {
      const restoreClock = installFrameLimitClock(game.loop);
      game.events.once(Phaser.Core.Events.DESTROY, restoreClock);
      // 启动配置固定为多纹理，再按玩家偏好应用：自动时安卓单纹理，iOS 和桌面多纹理。
      const applyTextureBatching = (): void => {
        const renderer = game.renderer as Phaser.Renderer.WebGL.WebGLRenderer;
        if (!renderer?.renderNodes) return;
        renderer.renderNodes.setMaxParallelTextureUnits(
          parallelTextureUnits(displaySettings.textureBatching, game.device.os.android, renderer.maxTextures));
      };
      applyTextureBatching();
      game.events.once(Phaser.Core.Events.DESTROY, displaySettings.subscribeTextureBatching(applyTextureBatching));
    } },
    scale: { mode: Phaser.Scale.NONE, autoCenter: Phaser.Scale.NO_CENTER, width: GAME_WIDTH, height: GAME_HEIGHT },
    render: { powerPreference: 'high-performance', batchSize: 16384, autoMobileTextures: false },
    input: { activePointers: 3, keyboard: true }, loader: { maxParallelDownloads: 6, timeout: 15000, maxRetries: 1 },
    scene: [], banner: false, audio: { disableWebAudio: false }
  });
  app.game = game;
  // 每交付一帧只做一次整数加减；统计器不分配对象，也不读场景状态。
  game.events.on(Phaser.Core.Events.POST_STEP, () => frameStats.frame(performance.now()));
  game.events.once(Phaser.Core.Events.DESTROY, () => {
    contentRequest.abort();cancelCommonPreload();app.releaseCommonAssets();
  });
  const unsubscribeRenderScale = displaySettings.subscribeRenderScale(() => {
    if (app.game) configureCanvas(app.game, displaySettings.renderScale);
  });
  game.events.once(Phaser.Core.Events.DESTROY, unsubscribeRenderScale);
  let frameLimitDisposed = false;
  const applyFrameLimit = (): void => {
    if (frameLimitDisposed) return;
    game.loop.setFPSLimit(resolveFrameLimit(displaySettings.frameRateLimit, currentRefreshRate()));
  };
  const unsubscribeFrameRate = displaySettings.subscribeFrameRateLimit(applyFrameLimit);
  const remeasureNow = (): void => {
    if (document.visibilityState === 'visible') void detectRefreshRate().then(applyFrameLimit);
  };
  // 玩家选的帧率也告诉安卓壳：壳会选一个刷新率能整除它的屏幕模式，
  // 避免 60 帧在 90Hz 屏上反复在 1 个和 2 个屏幕节拍之间跳。
  let nativeFrameRate = 0;
  const syncNativeFrameRate = (): void => {
    const rate = displaySettings.frameRateLimit;
    if (rate === nativeFrameRate) return;
    nativeFrameRate = rate;
    requestNativeFrameRate(rate);
  };
  syncNativeFrameRate();
  const unsubscribeNativeFrameRate = displaySettings.subscribeFrameRateLimit(syncNativeFrameRate);
  // 壳选好显示模式后把真实刷新率写进页面；直接采用，不再靠 rAF 重测。
  const applyNativeDisplayRate = (): void => {
    const hz = (globalThis as { __inoitaDisplayHz?: number }).__inoitaDisplayHz;
    if (typeof hz !== 'number' || !(hz > 0)) return;
    setRefreshRate(hz);
    applyFrameLimit();
  };
  applyNativeDisplayRate();
  window.addEventListener('inoita-display-rate', applyNativeDisplayRate);
  // 刷新率要等页面跑起来才量得到；量到之前按 60Hz 处理，60 档先按 90 的上限跑。
  void detectRefreshRate().then(applyFrameLimit);
  // 启动初期浏览器可能还没按高刷回调，量到的值会偏低；3 秒后补测一次。
  const settleRefreshTimer = window.setTimeout(remeasureNow, REFRESH_RECHECK_AFTER_BOOT_MS);
  // 进图/读档完成时加载压力已经结束，此时再量一次，拿到的才是屏幕真实节奏。
  let startRefreshTimer = 0;
  remeasureRefreshAfterStart = () => {
    window.clearTimeout(startRefreshTimer);
    startRefreshTimer = window.setTimeout(remeasureNow, REFRESH_RECHECK_AFTER_START_MS);
  };
  // 页面在后台启动时 rAF 不跑，第一次会量不到；恢复可见后补测一次再换算限帧。
  const remeasureWhenVisible = (): void => {
    if (refreshRateKnown() || document.visibilityState !== 'visible') return;
    void detectRefreshRate().then(applyFrameLimit);
  };
  document.addEventListener('visibilitychange', remeasureWhenVisible);
  window.addEventListener('pageshow', remeasureWhenVisible);
  game.events.once(Phaser.Core.Events.DESTROY, () => {
    frameLimitDisposed = true; unsubscribeFrameRate(); unsubscribeNativeFrameRate();
    window.removeEventListener('inoita-display-rate', applyNativeDisplayRate);
    window.clearTimeout(settleRefreshTimer);
    window.clearTimeout(startRefreshTimer);
    remeasureRefreshAfterStart = undefined;
    document.removeEventListener('visibilitychange', remeasureWhenVisible);
    window.removeEventListener('pageshow', remeasureWhenVisible);
  });
  const clearDiagnosticSnapshot = installDiagnosticSnapshot(runtimeDiagnostics);
  game.events.once(Phaser.Core.Events.DESTROY, clearDiagnosticSnapshot);
  const clearDiagnosticMetrics = installDiagnosticMetrics(diagnosticMetrics);
  game.events.once(Phaser.Core.Events.DESTROY, clearDiagnosticMetrics);
  const diagnosticTimer = window.setInterval(diagnosticTick, 60_000);
  game.events.once(Phaser.Core.Events.DESTROY, () => window.clearInterval(diagnosticTimer));
  game.events.once('ready', () => {
    configureCanvas(game,displaySettings.renderScale);
    // iOS 弹出系统键盘会让窗口短暂失焦。Phaser 把这次失焦当成页面切走：暂停游戏
    // 循环并挂起音频，键盘收起后不一定恢复。输入框聚焦期间的失焦交给输入框自己
    // 处理；真正的页面切走仍由 lifecycle 的 visibilitychange 驱动。ready 先于
    // Phaser 注册 window.onblur，等启动流程走完再接管。
    window.setTimeout(() => {
      game.sound.pauseOnBlur = false;
      window.onblur = () => { if (!editingText()) game.events.emit(Phaser.Core.Events.BLUR); };
      window.onfocus = () => game.events.emit(Phaser.Core.Events.FOCUS);
      const sound = game.sound as Phaser.Sound.WebAudioSoundManager;
      // 系统键盘或来电可能让音频上下文停住；用户下一次触摸或页面回焦时补一次恢复。
      const resumeAudio = () => {
        if (sound.context && !sound.locked && sound.context.state !== 'running') void sound.context.resume();
      };
      window.addEventListener('pointerdown', resumeAudio, { capture: true });
      window.addEventListener('focus', resumeAudio);
    }, 0);
    game.events.on(UI_EVENTS.select,()=>app.audio?.ui('select'));
    game.scene.add(SCENE_KEYS.audio, new AudioScene(app), true);
    game.scene.add(SCENE_KEYS.controlsUi, new ControlsScene(), true);
    game.scene.add(SCENE_KEYS.world, new WorldScene(app), false);
    game.scene.add(SCENE_KEYS.storyStage, new StoryStageScene(app), false);
    game.scene.add(SCENE_KEYS.classSelect, new StoryClassScene(app), false);
    game.scene.add(SCENE_KEYS.menu, new MenuScene(app), true);
    game.scene.add(SCENE_KEYS.formalUi,new FormalUiScene(app),true);
    lifecycle();
  });
  if (inspect) {
    globalThis.storyApp = app;
    globalThis.render_game_to_text = () => {
      // GM 打开时返回与面板、上报同一份摘要：agent 读到的就是人看到的。
      if (app.gm) return JSON.stringify({ ...app.gm.digest(), coordinates: 'map pixels; x right, y down; player position is foot anchor' });
      const scene = app.mode === 'game' ? worldScene() : undefined;
      return JSON.stringify({ mode: app.mode, ready: ui.ready, suspended: app.suspended,
        coordinates: 'map pixels; x right, y down; player position is foot anchor',
        player: scene?.player ? { x: scene.player.container.x, y: scene.player.container.y, clip: scene.player.clipName } : null });
    };
  }
}
function lifecycle(): void {
  const portrait = window.matchMedia('(orientation: portrait)');
  const setSuspended = (suspended: boolean): void => {
    ui.suspend(suspended);
    const scene = currentScene();
    // 同一帧内的 pagehide/pageshow 也按事件顺序排队，避免漏掉恢复。
    if (scene?.sys?.isActive() || scene?.sys?.isPaused()) {
      if (suspended) scene.scene.pause(); else if(!ui.lockOwners.includes('pressure-class')) scene.scene.resume();
    }
    const stage = app.game?.scene.getScene(SCENE_KEYS.storyStage);
    if (stage?.sys.isActive() || stage?.sys.isPaused()) {
      if (suspended) stage.scene.pause(); else stage.scene.resume();
    }
    if (suspended) app.game?.sound.pauseAll(); else app.game?.sound.resumeAll();
  };
  const sync = (): void => {
    // WebKit 可能在保留的 MediaQueryList 之前就更新了视口尺寸。
    const suspended = document.hidden || window.innerHeight > window.innerWidth;
    // 进入后台或竖屏前先同步落一次自动存档，避免进程被系统回收时丢掉最近的进度。
    if(suspended&&!app.suspended)autoSaver?.flushForBackground();
    setSuspended(suspended);
  };
  app.syncLifecycle = sync;
  document.addEventListener('visibilitychange', sync);
  window.addEventListener('resize', sync);
  window.addEventListener('orientationchange', () => { sync(); requestAnimationFrame(sync); });
  window.visualViewport?.addEventListener('resize', sync);
  portrait.addEventListener('change', sync);
  window.addEventListener('blur', () => ui.resetInput());
  window.addEventListener('pagehide', () => setSuspended(true));
  window.addEventListener('pageshow', sync);
  document.addEventListener('pointerdown', () => { app.game?.sound.unlock?.(); }, { once: true });
  sync();
}
boot();

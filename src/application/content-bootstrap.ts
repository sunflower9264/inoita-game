import type { BattleCatalog } from '../domain/battle.ts';
import type { Campaign } from '../domain/campaign.ts';
import type { CharacterStatsCatalog } from '../domain/character-stats.ts';
import type { WorldIndex } from '../domain/content.ts';
import type { ControlSkin } from '../domain/control-skin.ts';
import { validateCrafting, type CraftingCatalog } from '../domain/crafting.ts';
import type { ItemCatalog } from '../domain/items.ts';
import type { MenuPanels } from '../domain/menu-panels.ts';
import type { CompanionCatalog } from '../domain/party.ts';
import type { ShopCatalog } from '../domain/shop.ts';
import type { StatusHudSkin } from '../domain/status-hud.ts';
import { MINIMAP_ASSETS, type StoryInterface } from '../domain/story-interface.ts';
import type { WardrobeCatalog } from '../domain/wardrobe.ts';
import { UI_ICON_ATLAS_FILE } from '../generated/icon-atlas.ts';
import type { PendingAsset } from '../rendering/scene-assets.ts';
import type { AssetLease } from './assets.ts';
import type { ContentLoader } from './content-loader.ts';
import {
  validateCharacterStats,
  validateCompanions,
  validateItemSkills,
  validateMenuClasses,
  validateShops,
  validateStoryItems,
  validateStoryPortraits,
  validateWardrobe,
} from './content-validation.ts';
import { commonAssetBatches } from './entry-plan.ts';
import { gameMenuImageGroups } from './menu-images.ts';
import { validateStoryPerformance } from './story-performance-validation.ts';
import { storyReferenceMaps, validateStoryReferences } from './story-reference-validation.ts';

interface MenuPreparation {
  signal: AbortSignal;
  progress: number;
  listeners: Set<(value: number) => void>;
  /** 菜单框架与立绘：开局前必须就绪。 */
  core: Promise<void>;
  /** 物品/技能图标：开局后后台补，不挡世界加载。 */
  all: Promise<void>;
}

export interface BootstrapUiAssetHost {
  preloadResident(files: string[], signal: AbortSignal, progress: (value: number) => void): Promise<void>;
  releaseContent(): void;
}

export interface StoryContentBootstrapApp {
  readonly content: ContentLoader;
  world?: WorldIndex;
  campaign?: Campaign;
  storyInterface?: StoryInterface;
  battleCatalog?: BattleCatalog;
  characterStats?: CharacterStatsCatalog;
  menuPanels?: MenuPanels;
  items?: ItemCatalog;
  wardrobe?: WardrobeCatalog;
  statusHud?: StatusHudSkin;
  controlSkin?: ControlSkin;
  shops?: ShopCatalog;
  companions?: CompanionCatalog;
  crafting?: CraftingCatalog;
  commonAssetLeases: AssetLease[];
  uiAssets?: BootstrapUiAssetHost;
  storyUI?: { refreshMenuAssets(): void };
  releaseCommonAssets(): void;
}

export interface StoryContentBootstrapHost {
  readonly app: StoryContentBootstrapApp;
  readonly gmOn: () => boolean;
  readonly audioCatalog?: () => { music: Record<string, string>; effects: Record<string, string> } | undefined;
  readonly canLoadCommon: () => boolean;
  readonly loadCommonBatch: (batch: PendingAsset[], signal: AbortSignal) => Promise<AssetLease | undefined>;
}

/** 启动阶段上报：卡住时诊断日志里的最后一条就是现场。 */
export function recordStartPhase(phase: string, details?: Record<string, unknown>): void {
  try {
    globalThis.storyDiagnostics?.record('start-phase', { phase, ...details });
  } catch {
    /* 诊断不能影响启动 */
  }
}

/**
 * 统筹内容目录加载与校验、菜单图片分批预载，以及标题页公共素材预载。
 * 内容请求生命周期独立于单次进图/读档的取消信号，直到整局宿主销毁才中止。
 */
export class StoryContentBootstrap {
  private readonly host: StoryContentBootstrapHost;
  /** 内容目录与存档无关：标题页开始预载后，职业选择、读档和进图都复用同一份。 */
  private readonly contentRequest = new AbortController();
  private storyPreparation?: Promise<void>;
  private menuPreparation?: MenuPreparation;
  private commonPreloadTask?: Promise<void>;
  private commonPreloadRequest = new AbortController();
  private commonPreloadBatches?: PendingAsset[][];
  private commonPreloadIndex = 0;
  private commonPreloadResume = false;

  constructor(host: StoryContentBootstrapHost) {
    this.host = host;
  }

  get contentSignal(): AbortSignal {
    return this.contentRequest.signal;
  }

  readonly prepareStory = (_signal: AbortSignal): Promise<void> => {
    const { app, gmOn, audioCatalog } = this.host;
    if (app.campaign) return Promise.resolve();
    if (this.storyPreparation) return this.storyPreparation;
    // 内容目录是公共资源，不随某个入口的取消信号中止；调用方拿到结果后再检查自己的信号。
    const signal = this.contentRequest.signal;
    const task = (async () => {
      recordStartPhase('story-fetch-start', { trusted: app.content.trusted, gm: gmOn() });
      const [
        world,
        campaign,
        presentation,
        battle,
        panels,
        items,
        wardrobe,
        statusHud,
        controlSkin,
        stats,
        shops,
        companions,
        crafting,
      ] = await Promise.all([
        app.content.world(signal),
        app.content.campaign(signal),
        app.content.storyInterface(signal),
        app.content.battle(signal),
        app.content.menuPanels(signal),
        app.content.items(signal),
        app.content.wardrobe(signal),
        app.content.statusHud(signal),
        app.content.controlSkin(signal),
        app.content.characterStats(signal),
        app.content.shops(signal),
        app.content.companions(signal),
        app.content.crafting(signal),
      ]).catch(error => {
        globalThis.storyDiagnostics?.record('content-load-error', { stage: 'story-fetch', error });
        throw error;
      });
      signal.throwIfAborted();
      recordStartPhase('story-fetched');
      signal.throwIfAborted();
      await app.content.prepareTownPoses(wardrobe, signal);
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
        validateCompanions(companions, world, battle, stats, campaign);
        const storyMaps = new Map(await Promise.all([...storyReferenceMaps(campaign)].map(async id => {
          const reference = world.maps.find(map => map.id === id);
          if (!reference) throw new Error(`剧情地图不存在：${id}`);
          return [id, await app.content.map(reference.file, signal)] as const;
        })));
        signal.throwIfAborted();
        validateStoryReferences(campaign, world, battle, storyMaps, items);
        validateStoryPerformance(world, campaign, storyMaps, audioCatalog?.());
        validateStoryPortraits(world, presentation);
        app.content.releaseValidationCaches(wardrobe);
      }
      recordStartPhase('story-validated', { trusted: app.content.trusted });
      Object.assign(app, {
        world,
        campaign,
        storyInterface: presentation,
        battleCatalog: battle,
        characterStats: stats,
        menuPanels: panels,
        items,
        wardrobe,
        statusHud,
        controlSkin,
        shops,
        companions,
        crafting,
      });
      recordStartPhase('story-assigned');
      // 商店装备表在进游戏前就开始取，走路到商人时通常已经就绪；首次打开不再等这一下。
      if (!Object.keys(shops.equipment).length) {
        void app.content.shopEquipment(signal).then(equipment => {
          shops.equipment = equipment;
        }).catch(error => {
          if (!signal.aborted) globalThis.storyDiagnostics?.record('shop-equipment-warm-error', { error });
        });
      }
    })();
    this.storyPreparation = task;
    void task.catch(() => {
      if (this.storyPreparation === task) this.storyPreparation = undefined;
    });
    return task;
  };

  private menuPreparationFor(signal: AbortSignal): MenuPreparation | undefined {
    let state = this.menuPreparation;
    const { app } = this.host;
    if (!state || state.signal !== signal) {
      const uiAssets = app.uiAssets;
      if (!uiAssets) return undefined;
      const menuPanels = app.menuPanels!;
      const items = app.items!;
      const battleCatalog = app.battleCatalog!;
      const storyInterface = app.storyInterface!;
      const shops = app.shops!;
      const statusHud = app.statusHud!;
      const controlSkin = app.controlSkin!;
      const companions = app.companions!;
      const groups = gameMenuImageGroups(menuPanels, items, battleCatalog, storyInterface, shops);
      const extra = [...new Set([
        ...groups.extra,
        ...Object.values(companions.groupSkills ?? {}).map(skill => skill.icon),
      ])];
      const next: MenuPreparation = {
        signal,
        progress: 0,
        listeners: new Set(),
        core: Promise.resolve(),
        all: Promise.resolve(),
      };
      this.menuPreparation = next;
      recordStartPhase('menu-prepare-start', { core: groups.core.length, extra: extra.length });
      const report = (value: number, base: number, span: number) => {
        next.progress = base + value * span;
        for (const listener of next.listeners) listener(next.progress);
      };
      const fail = (error: unknown) => {
        if (this.menuPreparation === next) this.menuPreparation = undefined;
        throw error;
      };
      // 图标图集一次加载：物品/技能图标在世界 HUD 上就要用，不能被后台补图拖成空白。
      const coreFiles = [...groups.core, ...Object.values(controlSkin), UI_ICON_ATLAS_FILE];
      next.core = uiAssets.preloadResident([
        ...coreFiles,
        ...Object.values(statusHud.assets),
        ...Object.values(statusHud.buffIcons.catalog),
        ...MINIMAP_ASSETS.map(key => storyInterface.assets[key]),
      ], signal, value => report(value, 0, 0.6))
        .then(() => recordStartPhase('menu-core-loaded'))
        .catch(fail);
      next.all = next.core.then(() => extra.length
        ? uiAssets.preloadResident(extra, signal, value => report(value, 0.6, 0.4))
          .then(() => recordStartPhase('menu-extra-loaded'))
        : undefined).catch(fail);
      // 只等 core 的调用方不会观察 all；挂一个空处理，避免后台失败变成未处理拒绝。
      void next.all.catch(() => {});
      state = next;
    }
    return state;
  }

  readonly prepareMenuCore = (signal: AbortSignal, onProgress?: (value: number) => void): Promise<void> => {
    const state = this.menuPreparationFor(signal);
    if (!state) return Promise.reject(new Error('界面场景尚未就绪'));
    if (onProgress) {
      state.listeners.add(onProgress);
      onProgress(state.progress);
      const current = state;
      void current.core.finally(() => current.listeners.delete(onProgress)).catch(() => {});
    }
    return state.core;
  };

  /** 后台图标加载完时，已经打开的菜单要重画一次，否则首次打开会保留缺图占位。 */
  readonly refreshMenuWhenReady = (signal: AbortSignal): void => {
    const state = this.menuPreparationFor(signal);
    if (!state) return;
    void state.all.then(() => this.host.app.storyUI?.refreshMenuAssets()).catch(error => {
      if (!signal.aborted) globalThis.storyDiagnostics?.record('menu-asset-error', { error });
    });
  };

  readonly clearMenuPreparations = (): void => {
    this.menuPreparation = undefined;
    this.host.app.uiAssets?.releaseContent();
  };

  /** 进图前停掉后台预载；已经载完的批次保留，进图计划会直接复用。 */
  readonly cancelCommonPreload = (): void => {
    this.commonPreloadResume = false;
    this.commonPreloadRequest.abort();
  };

  /** 标题页后台预载公共素材；按小批推进，开始游戏时最多等当前一批。 */
  readonly prefetchCommon = (): void => {
    if (this.commonPreloadTask) {
      this.commonPreloadResume = true;
      return;
    }
    const request = this.commonPreloadRequest = new AbortController();
    const task = this.preloadCommon(request.signal);
    this.commonPreloadTask = task;
    void task.finally(() => {
      if (this.commonPreloadTask !== task) return;
      this.commonPreloadTask = undefined;
      if (this.commonPreloadResume) {
        this.commonPreloadResume = false;
        this.prefetchCommon();
      }
    });
  };

  private async preloadCommon(signal: AbortSignal): Promise<void> {
    const { app, canLoadCommon, loadCommonBatch } = this.host;
    try {
      await this.prepareStory(signal);
      signal.throwIfAborted();
      const { world, battleCatalog, wardrobe, companions, items, statusHud, controlSkin, storyInterface } = app;
      if (!world || !battleCatalog || !wardrobe || !companions || !items || !statusHud || !controlSkin || !storyInterface) return;
      if (!canLoadCommon()) return;
      this.commonPreloadBatches ??= commonAssetBatches({
        world,
        battle: battleCatalog,
        wardrobe,
        companions,
        items,
        statusHud,
        controlSkin,
        storyInterface,
      });
      while (this.commonPreloadIndex < this.commonPreloadBatches.length) {
        signal.throwIfAborted();
        const lease = await loadCommonBatch(this.commonPreloadBatches[this.commonPreloadIndex]!, signal);
        if (!lease) return;
        if (signal.aborted) {
          lease.release();
          signal.throwIfAborted();
        }
        app.commonAssetLeases.push(lease);
        this.commonPreloadIndex += 1;
        // 让出一拍，菜单输入和动画不被连续下载占满。
        await new Promise<void>(resolve => setTimeout(resolve, 0));
      }
    } catch (error) {
      if (!signal.aborted) globalThis.storyDiagnostics?.record('common-preload-error', { error });
    }
  }

  /** 游戏销毁时终止公共内容请求并释放预载租约。 */
  dispose(): void {
    this.contentRequest.abort();
    this.cancelCommonPreload();
    this.host.app.releaseCommonAssets();
  }
}

import type {CraftingCatalog} from './domain/crafting.ts';
import { type RecoveryResult } from './domain/recovery-items.ts';
import type { StatusHudSkin } from './domain/status-hud.ts';
import type { CharacterStatsCatalog } from './domain/character-stats.ts';
import type { MenuPanels } from './domain/menu-panels.ts';
import type { ControlSkin } from './domain/control-skin.ts';
import type Phaser from 'phaser';
import type { WorldIndex } from './domain/content.ts';
import type { Campaign } from './domain/campaign.ts';
import type { Session } from './domain/session.ts';
import type { StoryDirector } from './domain/story-director.ts';
import type { GmActions } from './debug/gm-actions.ts';
import { GmMode } from './debug/gm-mode.ts';
import type { GameUI } from './ui/game-ui.ts';
import type { BattleCatalog } from './domain/battle.ts';
import type { StoryUI } from './ui/story-ui.ts';
import type { StoryInterface } from './domain/story-interface.ts';
import type { StoryClassCatalog } from './domain/story-class.ts';
import type { ItemCatalog, EquipmentSlot, ItemResult } from './domain/items.ts';
import { SessionCheckpoint } from './domain/session-checkpoint.ts';
import { SaveSlots } from './domain/save-game.ts';
import type { StoryWorldViewSnapshot } from './scenes/world-scene.ts';
import type { WardrobeCatalog } from './domain/wardrobe.ts';
import type { GameAudio } from './application/game-audio.ts';
import type { ShopCatalog } from './domain/shop.ts';
import type { CompanionCatalog } from './domain/party.ts';

export type { GameMode } from './application/control-state.ts';
import type { GameMode } from './application/control-state.ts';
import { ContentLoader } from './application/content-loader.ts';
import type { AssetLease } from './application/assets.ts';
import { ControlLayoutPreferences } from './ui/control-layout.ts';

/**
 * 运行上下文：启动时先建界面，资源取回来之后再补上内容、状态和 Phaser 实例。
 * 场景和界面通过各自的能力接口访问已装配的依赖。
 *
 * **成员不是同时有值的**，按装配时机分六组。排查「这个能力为什么是空的」时先看这里：
 * 可选成员在 `?.` 下会静默跳过，不问一句是哪个阶段，很容易往错的方向查。
 *
 * 1. 构造时就有：`ui`（构造参数）、`content`、`checkpoint`、`saves`。
 * 2. `prepareStory()` 完成后一次 `Object.assign` 写入 13 个内容目录：`world`、`campaign`、
 *    `storyInterface`、`battleCatalog`、`characterStats`、`menuPanels`、`items`、`wardrobe`、
 *    `statusHud`、`controlSkin`、`shops`、`companions`、`crafting`。
 *    `storyClasses` 早一步，在 `enterGame()` 里选职业之前单独加载。
 * 3. `boot()`（Phaser 就绪）里接线：`game`、`enterGame`、`returnToMenu`、`startStory`、
 *    `prepareStory`、`prepareMenu`、`prefetchStory`、`storyUI`、`syncLifecycle`。
 * 4. `finishStoryStart()`（选定职业、进入世界）里接线：`session`、`storySignal`、`director`、
 *    `changeEquipment`、`equipmentPreview`、`equipmentAppearance`、`preparePartyMember`、
 *    `focusPartyTarget`、`revivePartyMember`、`openCrafting`、`openShop`。
 * 5. **由场景填、不由 main.ts 填**：`audio` 由音效场景启动时写入；`uiAssets` 由正式界面场景
 *    或 UI 调试场景各登记一份；`useRecoveryItem` 由 `WorldCombat` 进入战斗时写入，
 *    **战斗结束时清回 `undefined`**——有值与否不是单调的。
 * 6. `?ui-debug` 走另一条装配路径（`ui-debug-scene.ts`），自己写 `storyClasses`、`session`、
 *    `changeEquipment`、`useRecoveryItem`、`uiAssets`、`returnToMenu`，不经过第 2~4 组。
 */
export class StoryApp {
  readonly controlLayout = new ControlLayoutPreferences();
  gmNoclip = false;
  gmSpeedMultiplier = 1;
  captureControlPreview?:()=>readonly import('./ui/phaser/action-controls.ts').ShortcutSlot[];
  readonly checkpoint = new SessionCheckpoint<StoryWorldViewSnapshot>();
  /** 三个存档槽的持久化。标题页与游戏内菜单读的是同一份，键在 `domain/save-game.ts`。 */
  readonly saves = new SaveSlots<StoryWorldViewSnapshot>();
  /** 本次游戏从标题选择或成功读写的手动存档槽序号。 */
  saveSlot?:number;
  /** 自动存档触发口：世界侧把时机交给装配好的 `AutoSaver`。 */
  autoSave?: (reason: import('./application/auto-save.ts').AutoSaveReason) => void;
  storySignal?:AbortSignal;
  revivePartyMember?: (id:string,item:string)=>ItemResult;
  preparePartyMember?: (id:string,signal?:AbortSignal)=>Promise<void>;
  audio?: GameAudio;
  useRecoveryItem?: (entry:string,memberId?:string)=>RecoveryResult;
  items!: ItemCatalog;
  shops!: ShopCatalog;
  crafting!: CraftingCatalog;
  companions!: CompanionCatalog;
  /** 玩家侧全部战斗视觉资源在首次进游戏时加载并常驻，避免战斗与入队时现场加载。 */
  residentCombatReady=false;
  residentCombatAssets?: AssetLease;
  wardrobe!: WardrobeCatalog;
  changeEquipment?: (entry: string | undefined, slot: EquipmentSlot, signal?: AbortSignal, memberId?:string) => Promise<string>;
  equipmentPreview?: () => string | undefined;
  equipmentAppearance?:(memberId:string)=>import('./domain/content.ts').ActorDefinition|undefined;
  focusPartyTarget?:()=>void;
  menuPanels!: MenuPanels;
  storyClasses!: StoryClassCatalog;
  /** 当前界面场景持有的菜单图片租约账；正式 UI 场景与 UI 调试场景各登记一份。 */
  uiAssets?: import('./ui/phaser/ui-asset-host.ts').UiAssetHost;
  /** 载入并校验全部正式内容；正常流程由职业选择触发，UI 调试场景直接调用。 */
  prepareStory?: (signal: AbortSignal) => Promise<void>;
  /** 预载菜单图片；调试场景与正式界面共用同一份清单。 */
  prepareMenu?: (signal: AbortSignal, onProgress?: (value: number) => void) => Promise<void>;
  startStory?: (classId: string) => void;
  prefetchStory?: () => void;
  /**
   * 这两个能力在装配完成前**抛错而不是静默什么都不做**：它们只由玩家在世界里点融合器／
   * 商人触发，没反应会被当成游戏坏了，留不下任何线索。装配点在 `main.ts` 的启动收尾。
   */
  openCrafting:(actorId:string)=>void = () => { throw new Error('合成面板尚未装配'); };
  openShop:(shopId:string,mapId:string)=>void = () => { throw new Error('商店尚未装配'); };
  readonly content = new ContentLoader();
  /** 标题页临时打开 GM 时补载现场表；普通游玩不会调用。 */
  async loadDebugCatalog(): Promise<void> {
    if (!this.campaign || this.campaign.debugStory) return;
    this.campaign.debugStory = await this.content.storyDebug();
  }
  get mode() { return this.ui.mode; }
  set mode(value: GameMode) { this.ui.mode=value; }
  battleCatalog!: BattleCatalog;
  characterStats!: CharacterStatsCatalog;
  storyUI!: StoryUI;
  statusHud!:StatusHudSkin;
  controlSkin!: ControlSkin;
  storyInterface!: StoryInterface;
  enterGame?: (slot?:number) => Promise<void>;
  returnToMenu?: () => void;
  syncLifecycle?: () => void;
  /** 标题页与游戏内设置共用的读档入口，装配点在 `main.ts`。 */
  resumeSlot?: (slot:import('./domain/save-game.ts').SaveSlotRef,signal?:AbortSignal) => Promise<void>;
  /** 取当前地图与世界的存档快照；地图、战斗还没就绪时返回 undefined。 */
  captureSaveWorld?: () => { map:{ id:string; name:string }; world:StoryWorldViewSnapshot } | undefined;
  /** 游戏世界目录，进入剧情时加载。 */
  world!: WorldIndex;
  /** 本次体验版的剧情编排。 */
  campaign!: Campaign;
  /** 本次运行的故事状态。 */
  session!: Session;
  /** 剧情播放器。 */
  director!: StoryDirector;
  /** GM（调试）开关本身：一直存在，标题页手势与 `?gm` 都作用在它上面。 */
  readonly gmMode = new GmMode();
  /** GM（调试）动作层。**只在开关打开时装配**：关闭时它是 undefined，任何调试路径都跑不起来。 */
  gm?: GmActions;
  /** Phaser 实例，启动完成后才有。 */
  game?: Phaser.Game;
  /** 播放剧情时锁住场景输入。 */
  get locked() { return this.ui.locked; }
  /** 竖屏或切到后台时暂停。 */
  get suspended() { return this.ui.suspended; }
  /** 最近几张地图用到的纹理键，用来释放旧地图占的显存。 */
  private mapAssetHistory: AssetLease[] = [];
  private mapPrefetch?: { id: string; lease: AssetLease };
  /** 运行时兜底预取过的剧情地图；进图释放落脚图，返回菜单/读档时整体清空。 */
  private readonly storyPrefetches = new Map<string, AssetLease>();
  retainMapAssets(lease: AssetLease): void {
    this.mapAssetHistory.push(lease);
    while(this.mapAssetHistory.length+(this.mapPrefetch ? 1 : 0)>3)this.mapAssetHistory.shift()!.release();
  }
  retainMapPrefetch(id: string, lease: AssetLease): void {
    this.clearMapPrefetch();
    this.mapPrefetch = { id, lease };
    while(this.mapAssetHistory.length+1>3)this.mapAssetHistory.shift()!.release();
  }
  clearMapPrefetch(): void {
    this.mapPrefetch?.lease.release();
    this.mapPrefetch=undefined;
  }
  retainStoryPrefetch(id: string, lease: AssetLease): void {
    this.storyPrefetches.get(id)?.release();
    this.storyPrefetches.set(id, lease);
    // 运行时兜底与进图预取共用这个池；审计过单图并集上限 19 张，留到 20。
    while (this.storyPrefetches.size > 20) {
      const oldest = this.storyPrefetches.keys().next().value!;
      this.storyPrefetches.get(oldest)!.release();
      this.storyPrefetches.delete(oldest);
    }
  }
  releaseStoryPrefetch(id: string): void {
    const lease = this.storyPrefetches.get(id);
    if (lease) { this.storyPrefetches.delete(id); lease.release(); }
  }
  clearStoryPrefetch(): void {
    for (const lease of this.storyPrefetches.values()) lease.release();
    this.storyPrefetches.clear();
  }
  /** 覆盖层界面。 */
  readonly ui: GameUI;

  constructor(ui: GameUI) { this.ui = ui; }
}

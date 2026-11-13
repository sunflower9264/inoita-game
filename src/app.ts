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
import { CloudSaveClient } from './application/cloud-save.ts';
import { cloudBaseUrl } from './application/endpoints.ts';
import type { SaveWorldResult, StoryWorldViewSnapshot } from './scenes/world-scene.ts';
import type { WardrobeCatalog } from './domain/wardrobe.ts';
import type { GameAudio } from './application/game-audio.ts';
import type { ShopCatalog } from './domain/shop.ts';
import type { CompanionCatalog } from './domain/party.ts';
import type { DomUi } from './ui/dom/dom-ui.ts';
import type { OutfitPool } from './rendering/outfit-pool.ts';

import type { GameMode } from './application/control-state.ts';
import { ContentLoader } from './application/content-loader.ts';
import type { AssetLease } from './application/assets.ts';
import { StoryAssetPreparation } from './application/story-asset-preparation.ts';
import { ControlLayoutPreferences } from './ui/control-layout.ts';
import { keyBindings as defaultKeyBindings } from './application/key-bindings.ts';
import { InputRouter } from './application/input-router.ts';

/**
 * 运行上下文：启动时先建界面，资源取回来之后再补上内容、状态和 Phaser 实例。
 * 场景和界面通过各自的能力接口访问已装配的依赖。
 *
 * **成员不是同时有值的**，按装配时机分六组。排查「这个能力为什么是空的」时先看这里：
 * 可选成员在 `?.` 下会静默跳过，不问一句是哪个阶段，很容易往错的方向查。
 *
 * 1. 构造时就有：`ui`（构造参数）、`content`、`checkpoint`、`saves`、`cloud`。
 * 2. `prepareStory()` 完成后一次 `Object.assign` 写入 13 个内容目录：`world`、`campaign`、
 *    `storyInterface`、`battleCatalog`、`characterStats`、`menuPanels`、`items`、`wardrobe`、
 *    `statusHud`、`controlSkin`、`shops`、`companions`、`crafting`。
 *    `storyClasses` 早一步，在 `enterGame()` 里选职业之前单独加载。
 * 3. `boot()`（Phaser 就绪）里接线：`game`、`enterGame`、`returnToMenu`、`startStory`、
 *    `prefetchStory`、`prefetchCommon`、`storyUI`、`syncLifecycle`。
 * 4. `finishStoryStart()`（选定职业、进入世界）里接线：`session`、`storySignal`、`director`、
 *    `changeEquipment`、`equipmentAppearance`、`preparePartyMember`、`releasePartyPreview`、
 *    `revivePartyMember`、`openCrafting`、`openShop`。
 * 5. **由场景填、不由 main.ts 填**：`audio` 由音效场景启动时写入；`uiAssets` 由正式界面场景
 *    登记；`useRecoveryItem` 由 `WorldCombat` 进入战斗时写入，
 *    **战斗结束时清回 `undefined`**——有值与否不是单调的。
 */
export class StoryApp {
  /** 全局键盘路由。场景只在启动时桥接一次原始事件，按键按作用域只交给一层。 */
  readonly inputRouter = new InputRouter();
  readonly controlLayout = new ControlLayoutPreferences();
  /** 键位是本机设置，和布局一样不进存档。 */
  readonly keyBindings = defaultKeyBindings;
  gmNoclip = false;
  gmSpeedMultiplier = 1;
  captureControlPreview?:()=>readonly import('./ui/phaser/action-controls.ts').ShortcutSlot[];
  readonly checkpoint = new SessionCheckpoint<StoryWorldViewSnapshot>();
  /** 三个存档槽的持久化。标题页与游戏内菜单读的是同一份，键在 `domain/save-game.ts`。 */
  readonly saves = new SaveSlots<StoryWorldViewSnapshot>();
  /** 云存档客户端：构造只读本地 token，不联网；地址由 application/endpoints.ts 统一解析。 */
  readonly cloud = new CloudSaveClient({ baseUrl: cloudBaseUrl });
  /** 本次游戏从标题选择或成功读写的手动存档槽序号。 */
  saveSlot?:number;
  /** 自动存档触发口：世界侧把时机交给装配好的 `AutoSaver`。 */
  autoSave?: () => void;
  storySignal?:AbortSignal;
  revivePartyMember?: (id:string,item:string)=>ItemResult;
  summonLampMerchant?: (entry:string,signal:AbortSignal)=>Promise<void>;
  preparePartyMember?: (id:string,signal?:AbortSignal,options?:{full?:boolean;pin?:boolean})=>Promise<void>;
  /** 菜单关闭或离开队伍页：释放非上阵成员的合成外观。 */
  releasePartyPreview?: () => void;
  audio?: GameAudio;
  useRecoveryItem?: (entry:string,memberId?:string)=>RecoveryResult;
  items!: ItemCatalog;
  shops!: ShopCatalog;
  crafting!: CraftingCatalog;
  companions!: CompanionCatalog;
  /** 玩家侧全部战斗视觉资源在首次进游戏时加载并常驻，避免战斗与入队时现场加载。 */
  residentCombatReady=false;
  residentCombatAssets?: AssetLease;
  residentCombatClassId?: string;
  /** 阵亡界面的读档入口；世界场景通过 `StoryContext` 调用。 */
  openDefeatLoad():boolean { return this.storyUI?.openDefeatLoad()??false; }
  /** 释放常驻包并重置会话标记；重复调用幂等。 */
  releaseResidentCombat(): void {
    this.residentCombatAssets?.release();
    this.residentCombatAssets = undefined;
    this.residentCombatClassId = undefined;
    this.residentCombatReady = false;
  }
  /** 标题页后台预载的公共素材租约；与存档无关，换会话不释放。 */
  commonAssetLeases: AssetLease[] = [];
  /** 释放公共素材租约；页面销毁时调用。 */
  releaseCommonAssets(): void {
    for (const lease of this.commonAssetLeases.splice(0)) lease.release();
  }
  wardrobe!: WardrobeCatalog;
  /** 同一局游戏的合成外观，换地图和剧情舞台共用。 */
  outfits?: OutfitPool;
  changeEquipment?: (entry: string | undefined, slot: EquipmentSlot, signal?: AbortSignal, memberId?:string) => Promise<void>;
  equipmentAppearance?:(memberId:string)=>import('./domain/content.ts').ActorDefinition|undefined;
  menuPanels!: MenuPanels;
  storyClasses!: StoryClassCatalog;
  /** 当前界面场景持有的菜单图片租约账。 */
  uiAssets?: import('./ui/phaser/ui-asset-host.ts').UiAssetHost;
  startStory?: (classId: string) => void;
  prefetchStory?: () => void;
  /** 标题页后台预载与存档无关的公共素材；不阻塞菜单。 */
  prefetchCommon?: () => void;
  /**
   * 这两个能力在装配完成前**抛错而不是静默什么都不做**：它们只由玩家在世界里点融合器／
   * 商人触发，没反应会被当成游戏坏了，留不下任何线索。装配点在 `main.ts` 的启动收尾。
   */
  openCrafting:(actorId:string)=>void = () => { throw new Error('合成面板尚未装配'); };
  openShop:(shopId:string,mapId:string)=>void = () => { throw new Error('商店尚未装配'); };
  readonly content = new ContentLoader();
  private debugCatalogUsers=0;
  private debugCatalogReleaseRequested=false;
  private debugCatalogRevision=0;
  /** 标题页临时打开 GM 时补载现场表；普通游玩不会调用。 */
  async loadDebugCatalog(): Promise<void> {
    if (!this.campaign || this.campaign.debugStory) return;
    const campaign=this.campaign,revision=this.debugCatalogRevision;
    const catalog=await this.content.storyDebug();
    if(this.campaign===campaign&&revision===this.debugCatalogRevision)campaign.debugStory=catalog;
  }
  async acquireDebugCatalog():Promise<()=>void>{
    this.debugCatalogUsers++;
    let released=false;
    const release=()=>{if(released)return;released=true;if(--this.debugCatalogUsers===0&&this.debugCatalogReleaseRequested)this.clearDebugCatalog();};
    try{await this.loadDebugCatalog();return release;}catch(error){release();throw error;}
  }
  releaseDebugCatalog():void{
    this.debugCatalogReleaseRequested=true;
    if(this.debugCatalogUsers===0)this.clearDebugCatalog();
  }
  private clearDebugCatalog():void{
    this.debugCatalogRevision++;
    if(this.campaign)delete this.campaign.debugStory;
    this.content.releaseStoryDebug();
  }
  /** 标题页更新日志只在点按钮时加载，关闭弹窗后释放请求缓存。 */
  loadChangelog(signal?:AbortSignal):Promise<import('./domain/changelog.ts').ChangelogCatalog>{
    return this.content.changelog(signal);
  }
  releaseChangelog():void{this.content.releaseChangelog();}
  get mode() { return this.ui.mode; }
  set mode(value: GameMode) { this.ui.mode=value; }
  battleCatalog!: BattleCatalog;
  characterStats!: CharacterStatsCatalog;
  /** 属性页读取当前战斗属性；由世界场景在装配时接到战斗条件上。 */
  combatAttribute?: (actorId:string, attribute:import('./domain/battle-semantics.ts').BattleStatKey,
    base:number, passives:readonly import('./domain/passive-skills.ts').PassiveModifier[])=>number;
  /** 属性页判断成员当前是否潜行。 */
  combatStealthed?: (actorId:string)=>boolean;
  storyUI!: StoryUI;
  statusHud!:StatusHudSkin;
  controlSkin!: ControlSkin;
  storyInterface!: StoryInterface;
  enterGame?: (slot?:number) => Promise<void>;
  /** 压测模式：不写自动存档/检查点/手动存档，退出时清掉。 */
  pressureMode?: boolean;
  startPressureTest?: () => Promise<void>;
  changePressureClass?: (classId:string)=>Promise<void>;
  pausePressure?: (paused:boolean)=>void;
  returnToMenu?: () => void;
  syncLifecycle?: () => void;
  /** 标题页与游戏内设置共用的读档入口，装配点在 `main.ts`。 */
  resumeSlot?: (slot:import('./domain/save-game.ts').SaveSlotRef,signal?:AbortSignal) => Promise<void>;
  /** 取当前地图与世界的存档快照；地图、战斗还没就绪时返回 undefined。 */
  captureSaveWorld?: () => SaveWorldResult;
  /** 保存时截当前游戏画面作为存档缩略图。 */
  captureSaveThumbnail?: () => Promise<string | undefined>;
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
  /** 系统菜单的「脱离卡死」；由 main.ts 接到当前世界场景。 */
  rescuePlayer?: () => { ok: boolean; reason?: string; moved?: boolean };
  /** Phaser 实例，启动完成后才有。 */
  game?: Phaser.Game;
  /** 画布上方的 DOM 文字层；启动时创建，场景和界面通过它写文字。 */
  domUi?: DomUi;
  /** 播放剧情时锁住场景输入。 */
  get locked() { return this.ui.locked; }
  /** 竖屏或切到后台时暂停。 */
  get suspended() { return this.ui.suspended; }
  /** 最近几张地图用到的纹理键，用来释放旧地图占的显存。 */
  private mapAssetHistory: AssetLease[] = [];
  private mapPrefetch?: AssetLease;
  /** 当前剧情预取的目标资源，交接或退出时释放。 */
  readonly storyAssetPreparation = new StoryAssetPreparation();
  retainMapAssets(lease: AssetLease): void {
    this.mapAssetHistory.push(lease);
    // 只留最近两张历史地图；预取额度另算。
    while(this.mapAssetHistory.length>2)this.mapAssetHistory.shift()!.release();
  }
  /** 丢弃全部历史地图租约，供会话边界使用；调用方要先确认这些地图已不再被场景使用。 */
  clearMapHistory(): void {
    for(const lease of this.mapAssetHistory)lease.release();
    this.mapAssetHistory.length = 0;
  }
  retainMapPrefetch(lease: AssetLease): void {
    this.clearMapPrefetch();
    this.mapPrefetch = lease;
    while(this.mapAssetHistory.length+1>3)this.mapAssetHistory.shift()!.release();
  }
  clearMapPrefetch(): void {
    this.mapPrefetch?.release();
    this.mapPrefetch=undefined;
  }
  releaseStoryPrefetch(id: string): void { this.storyAssetPreparation.release(id); }
  clearStoryPrefetch(): void { this.storyAssetPreparation.clear(); }
  /** 场景退出后才解除旧局；迟到的退出回调不能清掉新会话。 */
  releaseSession(expected: Session | undefined): boolean {
    if (this.session !== expected) return false;
    this.storyUI?.releaseSession(expected);
    this.gm?.dispose(); this.gm = undefined;
    this.releaseDebugCatalog();
    this.director?.dispose();
    this.checkpoint.clear();
    this.releaseResidentCombat(); this.clearMapPrefetch(); this.clearStoryPrefetch(); this.clearMapHistory();
    this.content.clearSessionCaches();
    this.outfits?.destroy(); this.outfits = undefined;
    this.saveSlot = undefined;
    Reflect.deleteProperty(this, 'session'); Reflect.deleteProperty(this, 'director');
    return true;
  }
  /** 覆盖层界面。 */
  readonly ui: GameUI;

  constructor(ui: GameUI) { this.ui = ui; }
}

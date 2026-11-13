import type {CraftingCatalog} from '../domain/crafting.ts';
import type { RecoveryResult } from '../domain/recovery-items.ts';
import type { StatusHudSkin } from '../domain/status-hud.ts';
import type { MenuPanels } from '../domain/menu-panels.ts';
import type { ControlSkin } from '../domain/control-skin.ts';
import type { WorldIndex } from '../domain/content.ts';
import type { Campaign } from '../domain/campaign.ts';
import type { BattleCatalog } from '../domain/battle.ts';
import type { Session } from '../domain/session.ts';
import type { StoryDirector } from '../domain/story-director.ts';
import type { GameUI } from '../ui/game-ui.ts';
import type { ContentLoader } from './content-loader.ts';
import type { AssetLease } from './assets.ts';
import type { StoryInterface } from '../domain/story-interface.ts';
import type { StoryClassCatalog } from '../domain/story-class.ts';
import type { ItemCatalog, EquipmentSlot } from '../domain/items.ts';
import type { WardrobeCatalog } from '../domain/wardrobe.ts';
import type { GameAudio } from './game-audio.ts';
import type { ShopCatalog } from '../domain/shop.ts';
import type { ControlLayoutPreferences } from '../ui/control-layout.ts';
import type { KeyBindingPreferences } from './key-bindings.ts';
import type { InputRouter } from './input-router.ts';
import type { SaveWorldResult } from '../scenes/world-scene.ts';
import type { DomUi } from '../ui/dom/dom-ui.ts';

export interface StoryClassContext {
  readonly inputRouter: InputRouter;
  readonly storyClasses: StoryClassCatalog;
  readonly ui: Pick<GameUI,'ready'|'loading'|'loaded'|'error'>;
  readonly suspended: boolean;
  startStory?: (classId: string) => void;
  prefetchStory?: () => void;
  returnToMenu?: () => void;
  syncLifecycle?: () => void;
}

type SceneUI = Pick<GameUI,'ready'|'locked'|'mode'|'loading'|'loaded'|'error'|'toast'|'showInstant'|'resetInput'|'setMode'|'showDefeat'|'closeDefeat'|'controlLayoutEditing'|'keyBindingEditing'|'preloadPortraits'|'setWorldRebuildCover'>;
export interface StoryContext {
  readonly gm?: Pick<import('../debug/gm-actions.ts').GmActions, 'storyDebug'>;
  /** 压测模式：不写存档/检查点，世界持续刷怪并自动复活队伍。 */
  readonly pressureMode?: boolean;
  readonly inputRouter: InputRouter;
  readonly domUi?: DomUi;
  readonly controlLayout:ControlLayoutPreferences;
  readonly keyBindings:KeyBindingPreferences;
  gmNoclip?: boolean;
  gmSpeedMultiplier?: number;
  readonly checkpoint:import('../domain/session-checkpoint.ts').SessionCheckpoint<import('../scenes/world-scene.ts').StoryWorldViewSnapshot>;
  readonly storySignal?:AbortSignal;
  useRecoveryItem?: (entry:string,memberId?:string)=>RecoveryResult;
  readonly audio?: GameAudio;
  readonly items: ItemCatalog;
  readonly characterStats: import('../domain/character-stats.ts').CharacterStatsCatalog;
  readonly shops: ShopCatalog;
  readonly crafting?: CraftingCatalog;
  openShop(shopId:string,mapId:string):void;
  openCrafting?(actorId:string):void;
  /** 阵亡界面打开读档页；返回 false 表示当前打不开，阵亡面板留在原地。 */
  openDefeatLoad?:()=>boolean;
  readonly wardrobe: WardrobeCatalog;
  readonly outfits?: import('../rendering/outfit-pool.ts').OutfitPool;
  readonly battleCatalog: BattleCatalog;
  readonly statusHud:StatusHudSkin;
  readonly menuPanels:MenuPanels;
  readonly controlSkin: ControlSkin;
  readonly storyInterface: StoryInterface;
  readonly world: WorldIndex;
  readonly campaign: Campaign;
  readonly session: Session;
  readonly director: StoryDirector;
  readonly content: Pick<ContentLoader,'map'|'drops'|'springs'|'shopEquipment'|'wardrobePoses'>;
  readonly companions: import('../domain/party.ts').CompanionCatalog;
  /** 玩家侧全部战斗视觉资源在首次进游戏时加载并常驻，避免战斗与入队时现场加载。 */
  residentCombatReady?: boolean;
  residentCombatAssets?: import('./assets.ts').AssetLease;
  residentCombatClassId?: string;
  releaseResidentCombat?: () => void;
  readonly ui: SceneUI & Pick<GameUI,'drawPortrait'|'portrait'|'canSkip'|'loadingState'|'failed'>;
  readonly locked: boolean;
  readonly suspended: boolean;
  readonly storyAssetPreparation?: import('./story-asset-preparation.ts').StoryAssetPreparation;
  retainMapAssets(lease:AssetLease):void;
  retainMapPrefetch(lease:AssetLease):void;
  clearMapPrefetch():void;
  releaseStoryPrefetch(id:string):void;
  clearStoryPrefetch():void;
  syncLifecycle?:()=>void;
  /** 自动存档触发：世界侧（进图等）交给装配好的 `AutoSaver`。 */
  autoSave?: () => void;
}
export interface StoryUIContext {
  readonly inputRouter: InputRouter;
  readonly domUi?: DomUi;
  /** 商店装备表按需加载（生产内容包与 shops.json 分开）。 */
  readonly content: Pick<ContentLoader,'shopEquipment'>;
  readonly controlLayout:ControlLayoutPreferences;
  readonly keyBindings:KeyBindingPreferences;
  captureControlPreview?:()=>readonly import('../ui/phaser/action-controls.ts').ShortcutSlot[];
  resumeSlot?:(slot:import('../domain/save-game.ts').SaveSlotRef,signal?:AbortSignal)=>Promise<void>;
  /** 文本输入：默认弹系统键盘输入框；测试注入一个直接返回内容的实现。 */
  promptText?: (initial:string)=>Promise<string|undefined>;
  revivePartyMember?: (id:string,item:string)=>import('../domain/items.ts').ItemResult;
  preparePartyMember?: (id:string,signal?:AbortSignal,options?:{full?:boolean;pin?:boolean})=>Promise<void>;
  /** 菜单关闭或离开队伍页：释放非上阵成员的合成外观。 */
  releasePartyPreview?: () => void;
  useRecoveryItem?: (entry:string,memberId?:string)=>RecoveryResult;
  readonly audio?: GameAudio;
  /** 存档槽读写；三个槽的本地持久化由它独占。 */
  readonly saves: import('../domain/save-game.ts').SaveSlots<import('../scenes/world-scene.ts').StoryWorldViewSnapshot>;
  saveSlot?:number;
  /** 当前地图与世界的存档快照；地图或战斗还没就绪时没有可存的东西。摘要由界面按菜单内容补上。 */
  captureSaveWorld?: () => SaveWorldResult;
  /** 保存时截当前游戏画面作为存档缩略图；失败或环境不支持时返回 undefined。 */
  captureSaveThumbnail?: () => Promise<string | undefined>;
  changeEquipment?: (entry: string | undefined, slot: EquipmentSlot, signal?: AbortSignal, memberId?:string) => Promise<void>;
  equipmentAppearance?:(memberId:string)=>import('../domain/content.ts').ActorDefinition|undefined;
  readonly battleCatalog: BattleCatalog;
  /**
   * 属性页读取当前战斗属性：把常驻被动、Buff 和临时属性一起叠到基础值上。
   * 菜单打开时战斗暂停，页面重绘时调用一次即可，不要挂到每帧循环。
   */
  combatAttribute?: (actorId:string, attribute:import('../domain/battle-semantics.ts').BattleStatKey,
    base:number, passives:readonly import('../domain/passive-skills.ts').PassiveModifier[])=>number;
  /** 属性页判断成员当前是否潜行，用来把潜行条件的被动算进去。 */
  combatStealthed?: (actorId:string)=>boolean;
  readonly storyClasses: StoryClassCatalog;
  readonly menuPanels: MenuPanels;
  /** 世界地图的目的地表（原版硬编码表的导出）。 */
  /** 登记快捷键那一屏与 HUD 共用同一套圆槽素材。 */
  readonly controlSkin: ControlSkin;
  readonly shops: ShopCatalog;
  readonly crafting?: CraftingCatalog;
  readonly characterStats: import('../domain/character-stats.ts').CharacterStatsCatalog;
  /** `portrait` 是界面场景按需取图的那个入口。 */
  readonly ui: Pick<GameUI,'ready'|'locked'|'suspended'|'mode'|'lock'|'resetInput'|'toast'|'showInstant'|'controlLayoutEditing'|'setControlLayoutEditing'|'keyBindingEditing'|'setKeyBindingEditing'|'portrait'|'defeated'|'revealDefeat'>;
  returnToMenu?: () => void;
  /** GM（调试）动作层。**只在开关打开时存在**：关闭时没有它，系统页也就没有「调试」入口。 */
  readonly gm?: import('../debug/gm-actions.ts').GmActions;
  acquireDebugCatalog?:()=>Promise<()=>void>;
  releaseDebugCatalog?:()=>void;
  /** 当前操控角色卡死时搬回主可行走区域；由 main.ts 接到世界场景。 */
  rescuePlayer?: () => { ok: boolean; reason?: string; moved?: boolean };
}
export interface MenuContext {
  readonly inputRouter: InputRouter;
  readonly ui: Pick<GameUI,'setMode'|'loading'|'menuLoaded'|'error'|'ready'|'suspended'>;
  /** GM（调试）开关：标题页的隐藏手势与角落指示读它，见 `docs/debugging.md`。 */
  readonly gmMode?: { readonly on: boolean; toggle(): boolean };
  /** GM 在菜单里临时打开时补载调试现场表；普通启动不请求。 */
  loadDebugCatalog?: () => Promise<void>;
  /** 标题页更新日志：点开弹窗才请求，关闭后释放缓存。 */
  loadChangelog?: (signal?: AbortSignal) => Promise<import('../domain/changelog.ts').ChangelogCatalog>;
  releaseChangelog?: () => void;
  readonly audio?:GameAudio;
  enterGame?:(slot?:number)=>Promise<void>;
  /** 标题页后台预载与存档无关的公共素材；不阻塞菜单。 */
  prefetchCommon?:()=>void;
  /** 挑战模式连点 5 次后进入压测战斗。 */
  startPressureTest?:()=>Promise<void>;
  /** 标题页的「开始游戏」使用同一份存档槽。 */
  readonly saves: import('../domain/save-game.ts').SaveSlots<import('../scenes/world-scene.ts').StoryWorldViewSnapshot>;
  /** 云存档能力；缺失时云存档页只显示不可用，本机存档照常。 */
  readonly cloud?: import('./cloud-save.ts').CloudSavePort;
  /** 从某个有效存档槽恢复；空槽通过 enterGame 进入职业选择。 */
  resumeSlot?:(slot:import('../domain/save-game.ts').SaveSlotRef,signal?:AbortSignal)=>Promise<void>;
  /** 文本输入：默认弹系统键盘输入框；测试注入一个直接返回内容的实现。 */
  promptText?: (initial:string)=>Promise<string|undefined>;
  /** 修改密码：默认弹三项密码表单；测试注入一个直接返回当前/新密码的实现。 */
  promptPasswordChange?: ()=>Promise<{currentPassword:string;newPassword:string}|undefined>;
  syncLifecycle?:()=>void;
}

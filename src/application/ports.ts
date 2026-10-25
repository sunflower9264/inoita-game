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

export interface StoryClassContext {
  readonly storyClasses: StoryClassCatalog;
  readonly ui: Pick<GameUI,'ready'|'loading'|'loaded'|'error'>;
  readonly suspended: boolean;
  startStory?: (classId: string) => void;
  prefetchStory?: () => void;
  returnToMenu?: () => void;
  syncLifecycle?: () => void;
}

type SceneUI = Pick<GameUI,'ready'|'locked'|'mode'|'loading'|'loaded'|'error'|'location'|'toast'|'showInstant'|'resetInput'|'setMode'|'showDefeat'|'closeDefeat'|'controlLayoutEditing'|'preloadPortraits'>;
export interface StoryContext {
  readonly controlLayout:ControlLayoutPreferences;
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
  readonly wardrobe: WardrobeCatalog;
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
  retainMapAssets(lease:AssetLease):void;
  retainMapPrefetch(id:string,lease:AssetLease):void;
  clearMapPrefetch():void;
  retainStoryPrefetch(id:string,lease:AssetLease):void;
  releaseStoryPrefetch(id:string):void;
  clearStoryPrefetch():void;
  syncLifecycle?:()=>void;
  /** 自动存档触发：世界侧（进图等）把原因交给装配好的 `AutoSaver`。 */
  autoSave?: (reason: import('./auto-save.ts').AutoSaveReason) => void;
}
export interface StoryUIContext {
  /** 商店装备表按需加载（生产内容包与 shops.json 分开）。 */
  readonly content: Pick<ContentLoader,'shopEquipment'>;
  readonly controlLayout:ControlLayoutPreferences;
  captureControlPreview?:()=>readonly import('../ui/phaser/action-controls.ts').ShortcutSlot[];
  resumeSlot?:(slot:import('../domain/save-game.ts').SaveSlotRef,signal?:AbortSignal)=>Promise<void>;
  /** 改名输入：默认弹系统键盘输入框；测试注入一个直接返回名字的实现。 */
  promptText?: (initial:string)=>Promise<string|undefined>;
  revivePartyMember?: (id:string,item:string)=>import('../domain/items.ts').ItemResult;
  preparePartyMember?: (id:string,signal?:AbortSignal)=>Promise<void>;
  useRecoveryItem?: (entry:string,memberId?:string)=>RecoveryResult;
  readonly audio?: GameAudio;
  /** 存档槽读写；三个槽的本地持久化由它独占。 */
  readonly saves: import('../domain/save-game.ts').SaveSlots<import('../scenes/world-scene.ts').StoryWorldViewSnapshot>;
  saveSlot?:number;
  /** 当前地图与世界的存档快照；地图或战斗还没就绪时没有可存的东西。摘要由界面按菜单内容补上。 */
  captureSaveWorld?: () => { map:{ id:string; name:string }; world:import('../scenes/world-scene.ts').StoryWorldViewSnapshot } | undefined;
  changeEquipment?: (entry: string | undefined, slot: EquipmentSlot, signal?: AbortSignal, memberId?:string) => Promise<string>;
  equipmentPreview?: () => string | undefined;
  equipmentAppearance?:(memberId:string)=>import('../domain/content.ts').ActorDefinition|undefined;
  focusPartyTarget?:()=>void;
  readonly battleCatalog: BattleCatalog;
  readonly storyClasses: StoryClassCatalog;
  readonly menuPanels: MenuPanels;
  /** 世界地图的目的地表（原版硬编码表的导出）。 */
  /** 登记快捷键那一屏与 HUD 共用同一套圆槽素材。 */
  readonly controlSkin: ControlSkin;
  readonly shops: ShopCatalog;
  readonly crafting?: CraftingCatalog;
  readonly characterStats: import('../domain/character-stats.ts').CharacterStatsCatalog;
  /** `portrait` 是界面场景按需取图的那个入口。 */
  readonly ui: Pick<GameUI,'ready'|'locked'|'suspended'|'mode'|'lock'|'resetInput'|'toast'|'controlLayoutEditing'|'setControlLayoutEditing'|'portrait'>;
  returnToMenu?: () => void;
  /** GM（调试）动作层。**只在开关打开时存在**：关闭时没有它，系统页也就没有「调试」入口。 */
  readonly gm?: import('../debug/gm-actions.ts').GmActions;
}
export interface MenuContext {
  readonly ui: Pick<GameUI,'setMode'|'loading'|'menuLoaded'|'error'|'ready'|'suspended'>;
  /** GM（调试）开关：标题页的隐藏手势与角落指示读它，见 `docs/debugging.md`。 */
  readonly gmMode?: { readonly on: boolean; toggle(): boolean };
  /** GM 在菜单里临时打开时补载调试现场表；普通启动不请求。 */
  loadDebugCatalog?: () => Promise<void>;
  readonly audio?:GameAudio;
  enterGame?:(slot?:number)=>Promise<void>;
  /** 标题页的「开始游戏」使用同一份存档槽。 */
  readonly saves: import('../domain/save-game.ts').SaveSlots<import('../scenes/world-scene.ts').StoryWorldViewSnapshot>;
  /** 从某个有效存档槽恢复；空槽通过 enterGame 进入职业选择。 */
  resumeSlot?:(slot:import('../domain/save-game.ts').SaveSlotRef,signal?:AbortSignal)=>Promise<void>;
  /** 改名输入：默认弹系统键盘输入框；测试注入一个直接返回名字的实现。 */
  promptText?: (initial:string)=>Promise<string|undefined>;
  syncLifecycle?:()=>void;
}

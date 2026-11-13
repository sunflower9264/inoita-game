import { pressureEnemy } from '../domain/pressure-enemies.ts';
import { summonLampMerchant } from '../domain/lamp-merchant.ts';
import { domAssets } from '../ui/dom/assets.ts';
import {prepareCombatRestore} from '../domain/combat-snapshot.ts';
import type {SceneActorState,SceneSnapshot} from '../domain/scene-snapshot.ts';
import {generateMapEntities} from '../domain/scene-visit.ts';
import {placementMayBeInactive, resolveMapActors} from '../domain/map-placement.ts';
import { SCENE_KEYS } from '../application/scene-keys.ts';
import { StatusHud } from '../ui/phaser/status-hud.ts';
import { worldZoom } from '../ui/viewport.ts';
import { OverheadStatus } from '../rendering/overhead-status.ts';
import { QuestMarker } from '../rendering/quest-marker.ts';
import { questNotices, type QuestNoticeState } from '../ui/quest-progress.ts';
import Phaser from 'phaser';
import { ExitTrigger, overlapsFootRect } from '../domain/navigation.ts';
import { claimNearTrigger } from '../domain/story-trigger-occupancy.ts';
import { buildStoryTriggerIndex, type StoryTriggerIndex } from '../domain/story-trigger-index.ts';
import { NavigationWorld, collisionAt } from '../domain/navigation-world.ts';
import { MovementWorld } from '../rendering/movement-world.ts';
import { isBodyWalking } from '../rendering/arcade-movement.ts';
import type { ClipName, EntityPlacement, ExitFacing, Facing, MapExit, WorldMap } from '../domain/content.ts';
import type { AssetLease } from '../application/assets.ts';
import { Wardrobe } from '../rendering/wardrobe.ts';
import { acquireCompanionWardrobe, pruneCompanionWardrobes } from '../rendering/wardrobe-cache.ts';
import { costumeRecipe } from '../domain/wardrobe.ts';
import { memberArt } from '../domain/menu-panels.ts';
import type { EquipmentSlot } from '../domain/items.ts';
import type { BattleStatKey } from '../domain/battle-semantics.ts';
import type { PassiveModifier } from '../domain/passive-skills.ts';
import type { ActorDefinition } from '../domain/content.ts';
import type { StoryStageSnapshot } from '../domain/story-performance.ts';
import { createEffect } from '../rendering/effects.ts';
import type { StoryContext } from '../application/ports.ts';
import { WorldEnemyRoster } from '../domain/world-enemies.ts';
import { WorldCombat, type WorldCombatState } from './world-combat.ts';
import { QuestEnemyWatch } from '../domain/quest-enemies.ts';
import { cachedDropCatalog, rollChestLoot, type DropCatalog, type DropReward } from '../domain/drops.ts';
import { resolveInteraction } from '../domain/interaction.ts';
import { faceTarget } from '../domain/basic-attack.ts';
import { BODY_ADJACENT_GAP, canReachChest, CHEST_OPEN_MS, nearInteractable, nearInteractive, SHOP_COUNTER_GAP } from '../domain/chests.ts';
import { applySpringRecovery, grantSpringSkillPoint, parseSprings, rollSpringEffect, springBuffScope, type SpringCatalog, type SpringPartyResources } from '../domain/springs.ts';
import { groundLootFor } from '../domain/ground-loot.ts';
import { innRestQuote, payForInnRest } from '../domain/inns.ts';
import { pullLegendaryWeapon } from '../domain/legendary-weapon.ts';
import { GroundLootView } from '../rendering/ground-loot.ts';
import { PickupMessages } from '../rendering/pickup-messages.ts';
import { BasicAttackRepeat } from '../domain/basic-attack-repeat.ts';
import { storyReachableScripts } from '../domain/story-entry.ts';
import { buildEntryPlan, entryPlanAssets } from '../application/entry-plan.ts';
import { loadEntryPlan } from '../application/entry-loading.ts';
import { potentialMapEnemyIds, storyPresentationAssets, type WorldAssetInputs } from '../rendering/map-assets.ts';
import { storyExitId } from '../domain/story-world.ts';
import { hasLivingParty } from '../domain/session-checkpoint.ts';
import { freezeSnapshot, storyDevMode } from '../domain/dev-mode.ts';
import type { TravelDestination } from '../domain/content.ts';
import type {StoryAudioState} from '../application/game-audio.ts';

import { characterSceneClips} from '../rendering/combat-asset-descriptors.ts';
import { partyMemberCombatAssets } from '../rendering/combat-assets.ts';
import { PLAYER_MOVE_SPEED, characterAnimationState, characterAssets, createCharacter, setCharacterClip } from '../rendering/characters.ts';
import { drawMapLayers, type MapLayerHandles } from '../rendering/map-layers.ts';
import type { CharacterVisual } from '../rendering/characters.ts';
import { loadSceneAssets, missingSceneAssets, retainLoadedSceneAssets } from '../rendering/scene-assets.ts';
import { Hud } from '../rendering/hud.ts';
import type { DomLabel } from '../ui/dom/dom-ui.ts';
import { ActionControls, type ShortcutSlot } from '../ui/phaser/action-controls.ts';
import { ShortcutBar, type ShortcutEntry } from '../domain/shortcut-bar.ts';
import { learnedSkillIds, type SkillConfiguration } from '../domain/skill-configuration.ts';
import { NameBanner } from '../rendering/name-banner.ts';
import { StoryMinimap, type MinimapTask } from '../rendering/story-minimap.ts';
import { displaySettings } from '../application/display-settings.ts';
import { controlSettings } from '../application/control-settings.ts';
import { ComputerSkillHud } from '../ui/phaser/computer-skill-hud.ts';
import type { Cooldown } from '../domain/combat.ts';
import { MoveStick } from '../ui/phaser/move-stick.ts';
import { KeyboardActions } from '../ui/phaser/keyboard-actions.ts';
import type { PendingAsset } from '../rendering/scene-assets.ts';

/** 帧率显示每秒结算一次；长时间挂起后先重新开窗，避免把停顿算成一次超低值。 */
const FPS_WINDOW_MS = 1000;
const FPS_RESET_AFTER_IDLE_MS = 2000;
/** 卡顿时最多补 2 个逻辑帧；补 3 帧会把 AI、寻路和状态的尖峰叠成三倍。 */
const MAX_FRAME_DELTA_MS = 120;
/** GM 等场景重建的等待上限；既没报错也没就绪时不能让调用方永远等下去。 */
const DEBUG_MAP_WAIT_TIMEOUT_MS = 20_000;
/** 剧情世界静默重建的等待上限；超时同时中止新场景的加载。 */
const STORY_WORLD_SWITCH_TIMEOUT_MS = 30_000;
/** 压测模式每 0.9 秒尝试补一只怪。 */
const PRESSURE_SPAWN_INTERVAL_MS = 900;
/** 小地图敌人标记最多每 100 毫秒刷新一次。 */
const MINIMAP_ENEMY_REFRESH_MS = 100;

/** 进图参数：去哪张地图、落在哪里、朝哪边。 */
export interface SceneOptions {
  initialEntry?: boolean;
  checkpoint?:WorldCombatState;
  suppressEntry?: boolean;
  /** 演出中的世界重建：舞台画面还在演，加载过程不再盖加载界面。 */
  silentEntry?: boolean;
  /** 读档进场：不跑开场，恢复完接着走存档里的剧情游标。 */
  resumeStory?: boolean;
  onReady?: () => void;
  onError?: (error: unknown) => void;
  signal?:AbortSignal;
  generatedEntities?:EntityPlacement[];
  preparedScene?:SceneSnapshot;
  map: string;
  x: number;
  y: number;
  facing?: ExitFacing;
}
/** 旧存档没有 `scene`，读档时按 `location` 与剧情世界状态重新投影；新存档始终写入。 */
export interface StoryWorldViewSnapshot {location:TravelDestination;world?:WorldCombatState;generatedEntities:EntityPlacement[];scene?:SceneSnapshot;audio?:StoryAudioState}
/** 存档捕获失败的原因；界面据此给出具体提示，而不是一律说“当前地图不能存档”。 */
export type SaveWorldReason = 'debug' | 'pressure' | 'loading' | 'not-ready' | 'no-survivors';
export type SaveWorldResult =
  | { ok: true; map: { id: string; name: string }; world: StoryWorldViewSnapshot }
  | { ok: false; reason: SaveWorldReason };

/** 场景里的一个人物：一个容器装着若干张动作图层。 */
interface Character extends CharacterVisual {
  marker: QuestMarker | null;
}

export class WorldScene extends Phaser.Scene {
  private readonly chestFades = new Map<string, Phaser.Tweens.Tween>();
  private wardrobe?: Wardrobe;
  private readonly companionWardrobes=new Map<string,Wardrobe>();
  private readonly companionAssets=new Map<string,AssetLease>();
  private readonly companionOutfits=new Map<string,{actor:ActorDefinition}>();
  private readonly companionPreparations=new Map<string,{equipment:string;learned:string;full:boolean;promise:Promise<void>}>();
  /** 已经合成了整套动作的伙伴；预览用的单动作外观不能覆盖它。 */
  private readonly companionFull=new Set<string>();
  /** 招募时预拼、准备上阵前也要保留的外观；最多留最近两套。 */
  private readonly companionPinned=new Set<string>();
  private readonly companionLearned=new Map<string,string>();
  /** 最近一次为菜单预览准备的成员；LRU 淘汰时要保留它的外观纹理。 */
  private companionPreviewId?:string;
  private readonly projectedMemberEquipment=new Map<string,string>();
  private projectedPlayerEquipment='';
  private equippedActor?: ActorDefinition;
  private outfitRequest=0;
  readonly app: StoryContext;
  /** 本次进图的参数。 */
  options!: SceneOptions;
  characters: Character[] = [];
  /** 有头顶任务图标的角色；每帧只更新这一小组，不扫全图。 */
  private readonly questMarkerCharacters = new Set<Character>();
  /** 最近的交互对象，脚底离得最近且在有效距离内的那个。 */
  near: Character | null = null;
  /** 上一次 HUD 调和写入时的状态摘要；逐帧兜底调用时用它跳过无变化的重复写入。 */
  private hudSignature='';
  /** 目标状态按战斗帧缓存；同一逻辑帧内的多个渲染帧不必重复计算敌人数值。 */
  private targetStatusCache?:{tick:number;actor:string;status:ReturnType<WorldCombat['targetStatus']>;hostile:boolean};
  /** 切图或首次加载期间为 true，此时不接受输入。 */
  loadingWorld = true;
  destroyed = false;
  performing = false;
  /** 演出舞台已经铺满画面；正式世界这帧不更新、不渲染、物理也不步进。 */
  private stageOccluded = false;
  private readonly storyEntityAssets:AssetLease[]=[];
  private readonly projectedActorIds=new Set<string>();
  private lastProjectedLocation?:string;
  /** 进图加载页还在等这条剧情的第一幕；等待期间的素材补载不另开加载页。 */
  private entryStoryStarted?:() => void;
  private readonly encounterResults=new Set<string>();
  private baseEntities:EntityPlacement[]=[];
  private readonly occupiedRegions=new Set<string>();
  /** 本图的区域/近身事件与角色分组；进图和剧情投影后各建一次。 */
  private triggerIndex?:StoryTriggerIndex<Character>;
  private refreshStateSignatureValue?:string;
  /** 上一次交互扫描的输入；逐字段比较，静止帧不拼名单。 */
  private lastInteractionScan?:{x:number;y:number;revision:number;quest:number;story:number;chests:number;
    legendary:number;restore:number;performing:boolean;map:string;owner:string};
  /** 地图角色只在投影、恢复或显隐改变时使交互结果失效。 */
  private interactionRevision=0;
  /** 地图角色集合的修订号；整图刷新摘要用它代替逐角色拼名单。 */
  private charactersRevision=0;
  /** 屏幕固定的界面层与它上面的移动摇杆。 */
  private hud?: Hud;
  private statusHud?:StatusHud;
  private overheadStatus?:OverheadStatus;
  private stick?: MoveStick;
  private controls?: ActionControls;
  private keyboardActions?: KeyboardActions;
  /** 电脑模式专用的只读技能状态行。 */
  private skillHud?: ComputerSkillHud;
  private unsubscribeControlMode?: () => void;
  private shortcutPageCache?:{configuration:SkillConfiguration;version:number;bagRevision:number;owner:string;classId:string;page:number;
    entries:(ShortcutEntry|null)[];levels:Record<string,number>;slotsSignature?:string};
  private shortcutTick?:number;
  private nameBanner?: NameBanner;
  private minimap?: StoryMinimap;
  private nextMinimapEnemyUpdate = 0;
  private fpsReadout?: { dom?: DomLabel; lastRaf?: number; lastActual?: number; lastVisible?: boolean };
  /** rAF 累计帧数的上次读数；用它算每秒浏览器叫了几次。 */
  private fpsFrameBase = 0;
  private fpsWindowStart = 0;
  /** 当前统计窗口里真正交付到画面的游戏帧数。 */
  private fpsActualFrames = 0;
  private request = new AbortController();
  private mapAssets?: AssetLease;
  private prefetchTarget?: string;
  private prefetchFailedTarget?: string;
  private prefetchRetryAt = 0;
  private prefetchTask?: Promise<void>;
  private prefetchRequest?: AbortController;
  map?: WorldMap;
  entities: EntityPlacement[] = [];
  exitTrigger?: ExitTrigger<MapExit>;
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
  private combat?: WorldCombat;
  private dropCatalog?:DropCatalog;
  private springCatalog?:SpringCatalog;
  private groundLootView?:GroundLootView;
  /** 上次同步给掉落视图的 store revision。 */
  private groundLootRevision=-1;
  private pickupMessages?:PickupMessages;
  /** 压测刷怪计时器；离开场景时停掉，避免退出后继续生成。 */
  private pressureSpawner?:Phaser.Time.TimerEvent;
  private pressureStartPoints: {x:number;y:number}[]=[];
  private readonly pickupRecipients=new Map<string,CharacterVisual>();
  /** 任务完成/进度提示的上次状态；按任务簿版本对比，不在每次会话通知里扫全部任务。 */
  private questStatuses=new Map<string,QuestNoticeState>();
  private questStatusVersion?:number;
  /** 首次刷新只建基线，避免进图时把已有进度当成刚变化。 */
  private questNoticesReady=false;
  /** 普攻连打门控：发起过一次普攻后，站定就自动接下一击，摇杆一动即停。 */
  private readonly autoAttack=new BasicAttackRepeat();
  private checkpointPending=false;
  /** 同一段等待遭遇只记一条诊断；条件解除后重新允许记录。 */
  private checkpointWaitLogged=false;

  constructor(app: StoryContext) { super({ key: SCENE_KEYS.world, physics: { default: 'arcade', arcade: { gravity: { x: 0, y: 0 }, debug: false } } }); this.app = app; }
  init(options: SceneOptions): void {
    this.companionWardrobes.clear();this.companionOutfits.clear();this.companionPreparations.clear();
    this.companionFull.clear();this.companionPinned.clear();this.companionLearned.clear();
    for(const lease of this.companionAssets.values())lease.release();
    this.companionAssets.clear();
    this.companionPreviewId=undefined;
    this.projectedMemberEquipment.clear();this.projectedPlayerEquipment='';
    this.wardrobe=undefined;this.equippedActor=undefined;this.outfitRequest++;
    this.request.abort(); this.request = new AbortController();
    this.mapLayers?.destroy(); this.mapLayers = undefined;
    this.performing = false; this.player = undefined; this.noclipVisual = undefined; this.map = undefined;
    this.options = options; this.characters = []; this.questMarkerCharacters?.clear(); this.near = null; this.loadingWorld = true; this.destroyed = false;
    this.stageOccluded = false;
    this.movement = undefined; this.lastPlayerPosition = undefined;this.combat=undefined;this.checkpointPending=!options.checkpoint;this.checkpointWaitLogged=false;
    this.shortcutPageCache=undefined;this.shortcutTick=undefined;
    this.dropCatalog=undefined;this.springCatalog=undefined;this.groundLootView=undefined;this.pickupMessages=undefined;this.pickupRecipients.clear();
    this.questStatuses.clear();this.questStatusVersion=undefined;this.questNoticesReady=false;
    this.prefetchTarget = undefined; this.prefetchTask = undefined;
    this.prefetchFailedTarget = undefined; this.prefetchRetryAt = 0;
    this.baseEntities=[];this.occupiedRegions.clear();this.encounterResults.clear();this.triggerIndex=undefined;this.refreshStateSignatureValue=undefined;this.lastInteractionScan=undefined;this.interactionRevision=0;this.charactersRevision=0;
    this.projectedActorIds.clear();
  }
  create(): void {
    globalThis.storyDiagnostics?.record('start-phase',{phase:'world-create'});
    if(this.options.signal?.aborted){this.options.onError?.(this.options.signal.reason);this.scene.stop();return;}
    const externalSignal=this.options.signal;
    const cancelLoad=()=>this.request.abort(externalSignal?.reason);
    externalSignal?.addEventListener('abort',cancelLoad,{once:true});
    this.events.once('shutdown',()=>externalSignal?.removeEventListener('abort',cancelLoad));
    this.cameras.main.setBackgroundColor('#000000');
    this.events.once('shutdown', () => {
      for (const tween of this.chestFades.values()) tween.stop();
      this.chestFades.clear();
      this.app.ui.closeDefeat();
      this.request.abort();
      this.destroyed = true; this.unsubscribe?.(); this.scale.off('resize', this.resizeView, this);
      this.events.off(Phaser.Scenes.Events.POST_UPDATE, this.afterMovement, this);
      this.pressureSpawner?.remove(false);this.pressureSpawner=undefined;this.pressureStartPoints=[];
      this.combat?.destroy();this.combat=undefined;
      for(const character of this.characters)this.removeQuestMarker(character);
      this.questMarkerCharacters?.clear();
      this.mapAssets?.release();this.mapAssets=undefined;
      for(const lease of this.storyEntityAssets)lease.release();this.storyEntityAssets.length=0;
      this.groundLootView?.destroy();this.groundLootView=undefined;
      this.pickupMessages?.destroy();this.pickupMessages=undefined;this.pickupRecipients.clear();
      this.movement?.destroy(); this.movement = undefined;
      this.mapLayers?.destroy(); this.mapLayers = undefined;
      this.stick?.destroy(); this.stick = undefined;
      this.controls?.destroy(); this.controls = undefined;
      this.keyboardActions?.destroy(); this.keyboardActions = undefined;
      this.skillHud?.destroy(); this.skillHud = undefined;
      this.unsubscribeControlMode?.(); this.unsubscribeControlMode = undefined;
      this.input.off(Phaser.Input.Events.POINTER_DOWN, this.onPointerDown, this);
      this.nameBanner?.destroy(); this.nameBanner = undefined;
      this.minimap?.destroy(); this.minimap = undefined;
      this.fpsReadout?.dom?.remove(); this.fpsReadout = undefined;
      this.statusHud?.destroy();this.statusHud=undefined;
      this.overheadStatus?.destroy();this.overheadStatus=undefined;
      this.hud?.destroy(); this.hud = undefined;
      this.app.domUi?.setLayerVisible('world', false);
      this.app.domUi?.setLayerVisible('hud', false);
      this.wardrobe?.destroy(); this.wardrobe = undefined;
      for (const wardrobe of this.companionWardrobes.values()) wardrobe.destroy();
      this.companionWardrobes.clear(); this.companionOutfits.clear(); this.companionPreparations.clear(); this.companionFull.clear();
      this.companionPinned.clear(); this.companionLearned.clear();
      for(const lease of this.companionAssets.values())lease.release();
      this.companionAssets.clear();
      this.projectedMemberEquipment.clear(); this.projectedActorIds.clear();
      this.characters = []; this.entities = []; this.baseEntities = []; this.player = undefined; this.map = undefined;
      this.near = null; this.noclipVisual = undefined; this.equippedActor = undefined; this.triggerIndex = undefined;
      this.targetStatusCache = undefined; this.shortcutPageCache = undefined; this.unsubscribe = undefined;
      this.entryStoryStarted = undefined; this.prefetchTask = undefined; this.questStatuses.clear(); this.questStatusVersion=undefined; this.questNoticesReady=false; this.encounterResults.clear();
      Reflect.deleteProperty(this, 'options');
    });
    this.hud = new Hud(this);
    this.layoutHud();
    this.scale.on('resize', this.resizeView, this);
    this.events.on(Phaser.Scenes.Events.POST_UPDATE, this.afterMovement, this);
    // 世界级左键挂在场景输入上：点敌人、地面和界面控件的区别在这里统一判断。
    this.input.on(Phaser.Input.Events.POINTER_DOWN, this.onPointerDown, this);
    const wake = () => {
      this.app.ui.setMode('game');
      this.refreshState(); this.resizeView(); this.app.ui.loaded(); this.app.syncLifecycle?.();
    };
    this.events.on('wake', wake);
    this.events.once('shutdown', () => this.events.off('wake', wake));
    const options=this.options, signal=this.request.signal;
    this.open(options).catch(error => {
      // 取消也要把结果交给等待者：`restartStoryWorld` 靠 onError 结算 Promise，
      // 只在非取消时调用会让反复读图/切图时留下永远挂起的旧请求。结算必须用发起本次
      // 加载的 options——`this.options` 可能已被下一次 init 换掉，旧请求取消时会把
      // 错误算到新场景头上（GM 播放剧情时表现为演出中途退出）。
      options.onError?.(error);
      if (!signal.aborted && this.options === options) this.failure(error);
    });
  }
  /** 先把当前武器/职业那套人物动作请求发出去；失败不挡进图，Wardrobe 会重试。 */
  private warmPlayerPoses(signal: AbortSignal): void {
    const character = this.app.session.character;
    if (!character) return;
    try {
      const recipe = costumeRecipe(this.app.wardrobe, this.app.items, this.app.session.bag.equipmentItems(),
        character.classId, character.appearance.id, learnedSkillIds(this.app.battleCatalog,character.classId,this.app.session.skills));
      const missing = [...new Set(Object.values(recipe.poses))]
        .filter((id): id is string => typeof id === 'string' && !this.app.wardrobe.poses[id]);
      if (!missing.length) return;
      void this.app.outfits?.warmPoses(missing).catch(error => {
        if (!signal.aborted) globalThis.storyDiagnostics?.record('wardrobe-pose-warm-error', { error });
      });
    } catch (error) {
      globalThis.storyDiagnostics?.record('wardrobe-pose-warm-error', { error });
    }
  }
  /**
   * 演出舞台铺满画面后，正式世界继续留在 RUNNING（Loader、scene.restart 和跨场景调用都要用），
   * 但不再更新、渲染或步进物理。舞台恢复透明前必须解除。
   */
  setStageOccluded(occluded: boolean): void {
    if (this.destroyed || this.stageOccluded === occluded) return;
    this.stageOccluded = occluded;
    const camera = this.cameras?.main;
    if (camera) {
      // 相机不可见后不再走 preRender，follow 也不会推进；隐藏前先结算一次，
      // 下一段演出读取 scrollX/scrollY 时才是当前镜头，而不是重建后的初值。
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
    globalThis.storyDiagnostics?.record('start-phase',{phase:'world-open',map:options.map});
    const silentRequested = options.silentEntry === true;
    // 人物动作按需取。第一套外观在地图加载之后就要用，先和地图资源并行发请求，
    // 等 Wardrobe.prepare() 时通常已经到齐，不把首次进图的等待堆在加载条末尾。
    this.warmPlayerPoses(signal);
    // 演出中的世界重建先保持舞台画面；素材不齐时会在计划生成后回退到可见加载。
    if (silentRequested) ui.resetInput();
    else ui.loading('正在前往新的地方…', options.initialEntry ? 0.5 : 0);
    const reference = world.maps.find(map => map.id === options.map);
    if (!reference) throw new Error('这片区域的资源尚未准备好');
    const [loadedMap,rawDrops,rawSprings] = await Promise.all([this.app.content.map(reference.file, signal),this.app.content.drops(signal),this.app.content.springs(signal)]);
    this.pressureStartPoints = this.app.pressureMode ? (loadedMap.enemySpawns??[]).map(({x,y})=>({x,y})) : [];
    const map = this.app.pressureMode ? {...loadedMap, enemySpawns: []} : loadedMap;
    signal.throwIfAborted();
    globalThis.storyDiagnostics?.record('start-phase',{phase:'map-data-ready',map:map.id});
    this.map = map;
    this.app.session.enterMap(map.id,map.questItemSpawns??[],map,map.enemySpawns);
    this.dropCatalog=cachedDropCatalog(rawDrops,this.app.items,this.app.battleCatalog.enemies);
    this.springCatalog=parseSprings(rawSprings);
    const generated=options.preparedScene?.visit?.generatedEntities??options.generatedEntities;
    // 正式地图保留“条件可能变化”的静态候选，投影时再按当前剧情条件决定谁顶掉
    // 静态副本；否则条件在本次访问中变化时，进图时删掉的静态人物不会回来，
    // 或者会与剧情人物同时出现。
    this.baseEntities=generated?structuredClone(generated):generateMapEntities(map,campaign,this.springCatalog,this.app.session.hero?.level??1,Math.random,
      entity=>!placementMayBeInactive(entity));
    this.entities=this.app.session.storyWorld.projectEntities(map.id,
      resolveMapActors({base:this.baseEntities,map,campaign,active:entity=>this.app.session.visible(entity)}),
      this.app.campaign.placements);
    // 入口只保证「落脚图」可玩；后续剧情地图交给 ensureStoryAssets 在开演前按需加载。
    // 玩家侧战斗资源只在首次进入世界时并入主批次，之后由常驻租约保持。
    // class stamp 防止某条遗漏的重置路径继续复用旧职业包。
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
    const includeResidentCombat=!this.app.residentCombatReady;
    const plan = buildEntryPlan({
      currentMap: map,
      currentEntities: this.entities,
      inputs: this.assetInputs(),
      completedEvents: this.app.session.runtimeState.completedEvents,
      questStatus: id => this.app.session.status(id),
      activeScripts: this.activeStoryScripts(),
      checkpoint: options.checkpoint,
      includeResidentCombat
    });
    globalThis.storyDiagnostics?.record('start-phase',{phase:'entry-plan-ready',map:map.id,
      assets:plan.shared.length+plan.current.assets.length+(plan.residentCombat?.length??0)});
    const planned=[...plan.shared,...plan.current.assets,...(plan.residentCombat??[])];
    // 有进图剧情时把加载页的最后一段留给剧情链预取：同一条进度条继续走完，
    // 不再先填满、再归零重来一次（那看起来就是第二个进度条）。
    const mapProgressEnd=plan.scripts.length?0.9:1;
    const missing=missingSceneAssets(this,planned).length;
    // 剧情驱动的跨图一律静默：目标图素材在 prepare 阶段已经发起预取，进图时仍缺的
    // 也会在黑幕或舞台后面补完，不再回退成可见加载页。
    const silent = silentRequested;
    if(silentRequested)globalThis.storyDiagnostics?.record('story-silent-entry-missing', { map: map.id, missing });
    if (silent) ui.resetInput();
    this.app.director.onSkipProgress?.('assets-start');
    if (silent) await this.app.storyAssetPreparation?.wait(map.id);
    signal.throwIfAborted();
    const loaded = await loadEntryPlan(plan, {
      load: (assets, progress) => loadSceneAssets(this, assets, progress, true, signal),
      report: silent ? () => {} : (label, value) => ui.loading(label, value),
      preloadPortraits: (files, portraitSignal, progress) => ui.preloadPortraits(files, portraitSignal, progress),
      prepareSounds: (names, soundSignal) => { soundSignal.throwIfAborted(); return this.app.audio?.prepareStoryEffects(names, soundSignal) ?? Promise.resolve(); }
    }, { signal, start: options.initialEntry ? 0.5 : 0, end: mapProgressEnd, preparePresentation: !silent, onPhase: phase => this.app.director.onSkipProgress?.(phase) });
    if(signal.aborted){loaded.currentLease.release();signal.throwIfAborted();}
    this.mapAssets = loaded.currentLease;
    globalThis.storyDiagnostics?.record('start-phase',{phase:'scene-assets-ready',map:map.id});
    // 玩家侧战斗资源已经随主批次加载；再取一份只覆盖这些贴图的常驻租约，
    // 地图租约被历史淘汰或场景关闭时不会把战斗纹理一起删掉。
    if(includeResidentCombat){
      this.app.residentCombatAssets=retainLoadedSceneAssets(this,plan.residentCombat??[]);
      this.app.residentCombatClassId=residentClassId;
      this.app.residentCombatReady=true;
    }
    // 这张图已经由场景持有资源；运行时预取租约可以释放。
    this.app.releaseStoryPrefetch(map.id);
    for(const id of plan.current.visuals.actorIds)this.projectedActorIds.add(id);
    this.app.clearMapPrefetch();
    this.wardrobe=new Wardrobe(this,this.app.wardrobe,this.app.items,(ids,signal)=>this.app.content.wardrobePoses(ids,signal),this.app.outfits);
    const outfit=await this.wardrobe.prepare(this.app.session.character!.appearance,this.app.session.bag.equipmentItems(),this.app.session.character!.classId,{learnedSkills:learnedSkillIds(this.app.battleCatalog,this.app.session.character!.classId,this.app.session.skills),signal});
    signal.throwIfAborted();this.wardrobe.activate(outfit);this.equippedActor=outfit.actor;
    globalThis.storyDiagnostics?.record('start-phase',{phase:'wardrobe-ready',map:map.id});
    this.app.director.onSkipProgress?.('outfit-ready');
    this.projectedPlayerEquipment=JSON.stringify(this.app.session.bag.equipmentItems());
    this.statusHud=new StatusHud(this.hud!,this.app.statusHud,()=>this.combat?.controlledState??this.app.session.player,listener=>this.app.session.subscribe(listener),
      ()=>this.app.session.party?.activeSnapshot(),id=>{this.switchControlled(id);},id=>{
        if(id==='player')return this.app.statusHud.assets['player-portrait'];
        const member=this.app.session.party?.get(id);if(!member)return undefined;
        const actor=this.app.world.actors[member.definition.actor];
        return memberArt(this.app.menuPanels,actor,member.classId,member.source).partyIcon;
      },()=>{if(this.canControl)this.combat?.focusSelected();},id=>this.combat?.activeConditions(id)??[],()=>this.app.session.player,this.app.domUi);
    this.stick = new MoveStick(this, this.hud!, this.app.controlSkin, this.app.controlLayout, this.app.keyBindings, this.app.inputRouter, this.app.domUi);
    this.controls = new ActionControls(this, this.hud!, {
      attack: () => this.attackKey(), skill: key => {if(this.canControl)this.combat?.attack(key);},
      item: itemId => this.useShortcutItem(itemId), swap: () => this.cycleShortcutPage()
    }, this.app.controlSkin, this.app.controlLayout, this.app.domUi);
    this.keyboardActions = new KeyboardActions(this, this.app.keyBindings, {
      skill: slot => this.triggerShortcutSlot(slot),
      cycle: () => this.cycleShortcutPage(),
      previousMember: () => this.switchMember(-1),
      nextMember: () => this.switchMember(1)
    }, this.app.inputRouter);
    this.skillHud = new ComputerSkillHud(this, this.hud!, this.app.controlSkin, this.app.domUi);
    // 操作方式切换后立刻按新 HUD 显隐，不等下一帧兜底。
    this.unsubscribeControlMode = controlSettings.subscribeMode(() => this.syncHud());
    this.refreshLoadout();
    this.nameBanner = new NameBanner(this, this.hud!, map.name, this.app.domUi);
    this.layoutHud();
    this.mapLayers = drawMapLayers(this, map, { keyPrefix: `${map.id}-dodge` });
    this.groundLootView=new GroundLootView(this,this.app.items,(clip,x,y)=>createEffect(this,clip,x,y,true));
    const groundLoot=groundLootFor(this.app.session);
    this.groundLootView.sync(groundLoot.dropsOnMap(map.id));this.groundLootRevision=groundLoot.revision;
    this.pickupMessages=new PickupMessages(this,this.app.items,{anchor:id=>{
      const character=this.pickupRecipients.get(id);
      if(!character?.container.active)return undefined;
      return {...this.movement!.displayPosition(character),headAnchor:character.actor.headAnchor??{x:0,y:0}};
    },domUi:this.app.domUi,visible:()=>this.canCombatControl&&!this.performing&&!this.stageOccluded
      &&!this.app.ui.loadingState});
    const mapNavigation = new NavigationWorld(map);
    mapNavigation.prepareTerrainRouting();
    this.movement = new MovementWorld(this, mapNavigation);
    for (const entity of this.entities) this.characters.push(this.createActor(entity));
    this.charactersRevision=(this.charactersRevision??0)+1;
    this.rebuildTriggerIndex();
    // 同图场景重建（检查点恢复、剧情演出）沿用本次地图访问的喝空记录。
    this.restoreDrainedSprings();
    this.refreshState();
    const appearance = this.equippedActor ?? this.app.session.character?.appearance ?? world.actors[campaign.start.actor];
    // 越界请求已经被 enterMap 修正（findings 175）；落位跟随会话记录，
    // 免得场景吸附到最近的边缘、逻辑位置却在出口格上，两边对不上。
    const revised=this.app.session.storyWorld.currentLocation;
    const requested=options.x>=0&&options.y>=0&&options.x<map.width&&options.y<map.height
      ?{x:options.x,y:options.y}
      :revised&&revised.map===map.id?{x:revised.x,y:revised.y}:{x:options.x,y:options.y};
    // 出生点优先按整个碰撞盒落位：窄足底只保证鞋底不压墙，身体仍可能探进相邻阻挡格。
    const spawn = this.movement.navigation.nearestBody({ collision: appearance.collision }, requested)
      ?? this.movement.navigation.nearest(appearance, requested);
    // 落点可以正压在回程出口上；出口在玩家走出到达缓冲区前保持锁定，走回来才触发。
    this.exitTrigger = new ExitTrigger(map.exits, spawn);
    this.entryInputGate = true;
    this.player = this.createActor({ id: 'player', actor: campaign.start.actor, ...spawn });
    this.applyNoclip(this.player);
    this.lastPlayerPosition = { ...spawn };
    this.facing = options.facing === 'any' ? 'south' : options.facing || 'south';
    // 落点被碰撞盒吸附后，会话里的逻辑位置也要跟着走，否则物理位置和剧情/触发读到的位置会分叉。
    const currentLocation = this.app.session.storyWorld.currentLocation;
    if (currentLocation?.map === map.id && (currentLocation.x !== spawn.x || currentLocation.y !== spawn.y))
      this.app.session.movePlayer({ map: map.id, ...spawn, facing: this.facing });
    this.setClip(this.player, `idle-${this.facing}`);
    this.cameras.main.startFollow(this.player.container, true, 1, 1);
    const hero=this.app.session.hero;
    if(!hero)throw new Error('正式游戏缺少主角战斗数值');
    const drops=this.dropCatalog;
    if(!drops)throw new Error('掉落目录尚未就绪');
    const roster=new WorldEnemyRoster(this.app.session,map,(campaign.enemyPlacements??[]).filter(enemy=>enemy.map===map.id),hero.level,
      new QuestEnemyWatch(this.app.session,drops.questItems),Math.random);
    if(options.preparedScene?.visit){
      const prepared=structuredClone(options.preparedScene.visit);
      for(const enemy of prepared.roster.enemies){
        const actor=options.preparedScene.actors.find(actor=>actor.enemyKey===enemy.key);
        if(actor)Object.assign(enemy,{x:actor.x,y:actor.y});
      }
      roster.adoptPreparedState(prepared);
    }
    this.combat=new WorldCombat(this,this.app,roster,hero,drops);
    await this.combat.start({ restore: !!options.checkpoint });
    if(options.preparedScene){this.restoreScenePositions(options.preparedScene);this.combat.adoptStoryPositions(options.preparedScene.actors);}
    signal.throwIfAborted();
    if(options.checkpoint)await this.combat.restoreState(options.checkpoint,signal);
    this.minimap = new StoryMinimap(this, this.hud!, map, this.app.storyInterface, this.app.domUi!);
    this.fpsReadout = this.createFpsReadout();
    this.resizeView(); this.refreshState();
    this.unsubscribe = this.app.session.subscribe(() => this.refreshState());
    ui.drawPortrait = (actor, portrait, portraitSignal) => {
      const key = portrait === undefined ? (actor ? world.actors[actor]?.portrait : undefined) : portrait;
      return ui.portrait(key ? this.app.storyInterface.portraits[key] : undefined, portraitSignal);
    };
    this.loadingWorld = false;
    globalThis.storyDiagnostics?.record('start-phase',{phase:'world-ready',map:map.id});
    this.app.director.onSkipProgress?.('objects-ready');
    // 剧情内换图会重建本场景；新实例的相机和物理都是新的，必须按舞台当前状态重新遮挡。
    this.syncStageOcclusion();
    this.app.audio?.enterMap(map.id);
    this.trimTextures(); this.app.syncLifecycle?.();
    if(!this.app.checkpoint.available){this.captureCheckpoint();this.checkpointPending=true;}
    options.onReady?.();
    // 进图后写自动存档。读档进场只是把刚存下的状态装回来，不必再写一遍。
    if(!options.resumeStory)this.app.autoSave?.();
    this.lastProjectedLocation=JSON.stringify(this.app.session.storyWorld.currentLocation);
    this.app.session.setStoryWorldContext(()=>this.storyWorldContext());
    // 进图时补齐本图这段演出要用的立绘与音效。地图素材不在这里预取：
    // 换图时由目标图自己的入口加载，进图只对落脚图负责。
    // `suppressEntry` 的入口（GM 传送、读档恢复）由调用方接管后续演出，不在这里抢跑。
    if (!options.silentEntry && !options.suppressEntry && plan.scripts.length) {
      try { await this.ensureStoryAssets(plan.scripts, signal); }
      catch (error) {
        signal.throwIfAborted();
        // 补素材失败不该挡住进图：开演前还会再查一次，错误在那里按正常路径上报。
        console.error(error);
        globalThis.storyDiagnostics?.record('story-entry-prefetch-failed', { map: map.id });
      }
    }
    const director=this.app.director;
    let entryStory:(() => Promise<boolean>)|undefined;
    if (!options.suppressEntry&&!director.busy && this.openingPending()) {
      entryStory=() => director.start();
    } else if (!options.suppressEntry && !director.busy) {
      entryStory=() => director.enterMap(map.id);
    } else if (options.resumeStory && !director.busy) {
      // 读档进场：存档里那个运行中的剧情游标接着走，与「返回检查点」是同一条恢复路径。
      entryStory=() => director.retry();
    }
    await this.holdEntryLoading(entryStory, ui);
    if(silentRequested){
      this.app.ui.setWorldRebuildCover(false);
      globalThis.storyDiagnostics?.record('story-rebuild-cover-end', { map: map.id });
    }
  }
  /**
   * 进图即触发的剧情：加载页留到第一幕画出来再收。
   *
   * 世界已经建好但还没露给玩家；开演前缺的立绘与音效补在这张加载页后面，不另起一屏。
   * 没有剧情时按原样立即收起。
   */
  private async holdEntryLoading(entryStory:(() => Promise<boolean>)|undefined, ui:StoryContext['ui']):Promise<void> {
    if (!entryStory) { ui.loaded(); return; }
    const started=new Promise<void>(resolve=>{this.entryStoryStarted=resolve;});
    this.app.director.onPresentationStarted=()=>this.finishEntryStory();
    const story=this.playStory(entryStory);
    void story.then(()=>this.finishEntryStory());
    await started;
    if (!ui.failed) ui.loaded();
  }
  /** 第一幕出现、或这段剧情没有演出直接结束：都算加载完成。重复调用无副作用。 */
  private finishEntryStory():void {
    const resolve=this.entryStoryStarted;
    this.entryStoryStarted=undefined;
    this.app.director.onPresentationStarted=undefined;
    resolve?.();
  }
  /** 开场是否还没播完：以 start 事件的完成记录为准，不依赖内容里不存在的 flag。 */
  private openingPending(): boolean {
    const completed=this.app.session.runtimeState.completedEvents;
    return this.app.campaign.events.some(event=>event.source==='start'&&!completed.includes(event.id));
  }
  /** @param silent 演出中的世界重建：不显示加载进度，舞台画面保持可见。 */
  loadAssets(needed: PendingAsset[], label: string, initialEntry=false, silent=false): Promise<AssetLease> {
    return loadSceneAssets(this, needed, value => {
      if (!silent) this.app.ui.loading(`正在加载 · ${label}`, initialEntry ? 0.5 + value * 0.5 : value);
    }, true);
  }
  /** 正式世界、入口计划和运行时兜底共用的素材输入。 */
  private assetInputs(): WorldAssetInputs {
    const app = this.app, session = app.session;
    if (!session.character) throw new Error('正式游戏缺少主角外观');
    if (!session.hero) throw new Error('正式游戏缺少主角战斗数值');
    if (!this.dropCatalog || !this.springCatalog) throw new Error('掉落与泉水目录尚未就绪');
    return {
      world: app.world, campaign: app.campaign, battle: app.battleCatalog, items: app.items,
      wardrobe: app.wardrobe, drops: this.dropCatalog, springs: this.springCatalog,
      statusHud: app.statusHud, controlSkin: app.controlSkin, storyInterface: app.storyInterface,
      storyWorld: session.storyWorld, companions: app.companions, party: session.party,
      hero: session.hero, heroSkills: session.skills, playerBase: session.character.appearance
    };
  }
  /**
   * 这张图战斗可能出现的全部敌人；进图预取和战斗开场共用同一份超集。
   * 可破坏物掉落怪、剧情遭遇、泉水、宝箱怪与检查点敌人都包含在内。
   */
  combatEnemyIds(): string[] {
    if (!this.map) return [];
    return potentialMapEnemyIds(this.map, this.assetInputs(), {
      scripts: this.activeStoryScripts(),
      entities: this.entities
    });
  }
  /** 读档/失败恢复时运行中的剧情游标，入口计划要一起预热。 */
  private activeStoryScripts(): string[] {
    return this.app.session.runtimeState.runs
      .filter(run => run.status === 'running' || run.status === 'waiting')
      .map(run => run.cursor.script);
  }
  /**
   * 开演前只补说话人的立绘和这一段用到的音效。地图素材不预取：
   * 演出真要换图时，由目标图自己的入口加载。
   */
  async ensureStoryAssets(scripts: readonly string[], signal: AbortSignal): Promise<void> {
    if (this.loadingWorld || !this.map || this.destroyed) return;
    signal.throwIfAborted();
    const reachable = storyReachableScripts(this.app.campaign, scripts);
    const presentation = storyPresentationAssets(this.app.campaign, reachable, this.assetInputs());
    const portraits = presentation.portraits.filter(file => !domAssets.peek(file));
    if (portraits.length) await this.app.ui.preloadPortraits(portraits, signal, () => {});
    await this.app.audio?.prepareStoryEffects(presentation.sounds, signal);
    signal.throwIfAborted();
  }
  /** 提前准备当前剧情的世界资源，由会话持有到正式世界接管。 */
  prefetchStoryEntry(mapId: string, script: string | undefined, signal: AbortSignal): Promise<void> {
    if (this.loadingWorld || this.destroyed || !this.map || !this.app.storyAssetPreparation) return Promise.resolve();
    return this.app.storyAssetPreparation.prepare(mapId, JSON.stringify([mapId, script]), signal,
      request => this.loadStoryEntry(mapId, script, request)).catch(error => {
        if (!signal.aborted && !(error instanceof DOMException && error.name === 'AbortError'))
          globalThis.storyDiagnostics?.record('story-entry-prefetch-failed', { map: mapId, error });
      });
  }
  private async loadStoryEntry(mapId: string, script: string | undefined, signal: AbortSignal): Promise<AssetLease> {
    const reference = this.app.world.maps.find(entry => entry.id === mapId);
    if (!reference) throw new Error('剧情预取地图不存在：' + mapId);
    // 在任何等待之前捕获本局输入，换图后不再读取旧场景。
    const inputs = this.assetInputs(), session = this.app.session;
    const active = [...new Set([...this.activeStoryScripts(), ...(script ? [script] : [])])];
    const loader = this.scene.get(SCENE_KEYS.formalUi);
    const map = await this.app.content.map(reference.file, signal);
    signal.throwIfAborted();
    const plan = buildEntryPlan({
      currentMap: map, inputs,
      completedEvents: session.runtimeState.completedEvents,
      questStatus: questId => session.status(questId),
      activeScripts: active, includeResidentCombat: !this.app.residentCombatReady,
    });
    const assets = entryPlanAssets(plan);
    const missing = missingSceneAssets(loader, assets).length;
    const lease = await loadSceneAssets(loader, assets, () => {}, true, signal);
    if (signal.aborted) { lease.release(); signal.throwIfAborted(); }
    globalThis.storyDiagnostics?.record('story-entry-prefetch', { map: mapId, missing });
    return lease;
  }
  /** 仅提前准备目标地图两层大图；人物和物件由正式进图按需装配。 */
  prefetchMap(destination: string): void {
    if (!this.map || destination === this.map.id || this.loadingWorld || this.destroyed) return;
    if (this.prefetchTarget === destination) return;
    if (this.prefetchFailedTarget === destination && this.time.now < this.prefetchRetryAt) return;
    this.prefetchTarget = destination;
    this.prefetchRequest?.abort();
    const controller = this.prefetchRequest = new AbortController();
    const parent = this.request.signal;
    const cancel = () => controller.abort(parent.reason);
    parent.addEventListener('abort', cancel, { once: true });
    if (parent.aborted) cancel();
    const signal = controller.signal;
    const run = async () => {
      while (!signal.aborted && this.prefetchTarget) {
        const target = this.prefetchTarget;
        try {
          const reference = this.app.world.maps.find(entry => entry.id === target);
          if (!reference) throw new Error(`地图不存在：${target}`);
          const map = await this.app.content.map(reference.file, signal);
          signal.throwIfAborted();
          const lease = await loadSceneAssets(this, [
            { kind: 'image', key: map.id + '-ground', file: map.ground },
            { kind: 'image', key: map.id + '-canopy', file: map.canopy }
          ], () => {}, true, signal);
          if (signal.aborted || this.prefetchTarget !== target) lease.release();
          else this.app.retainMapPrefetch(lease);
        } catch {
          if (signal.aborted) return;
          if (this.prefetchTarget === target) {
            this.prefetchFailedTarget = target;
            this.prefetchRetryAt = this.time.now + 1000;
            this.prefetchTarget = undefined;
            return;
          }
        }
        if (this.prefetchTarget === target) return;
      }
    };
    const task = run();
    this.prefetchTask = task;
    void task.finally(() => {
      parent.removeEventListener('abort', cancel);
      if (this.prefetchTask === task) this.prefetchTask = undefined;
      if (this.prefetchRequest === controller) this.prefetchRequest = undefined;
    });
  }
  private prefetchVisibleExit(position: { x: number; y: number }, previous: { x: number; y: number }): void {
    if (!this.map) return;
    const vx = position.x - previous.x, vy = position.y - previous.y;
    let destination: string | undefined, nearest = Infinity;
    for (const exit of this.map.exits) {
      if (exit.destination === this.map.id||!this.exitAvailable(exit)) continue;
      const x = exit.x + exit.width / 2, y = exit.y + exit.height / 2;
      if (!this.cameras.main.worldView.contains(x, y)) continue;
      const dx = x - position.x, dy = y - position.y;
      if (dx * vx + dy * vy <= 0) continue;
      const distance = dx * dx + dy * dy;
      if (distance < nearest) { nearest = distance; destination = exit.destination; }
    }
    if (destination) this.prefetchMap(destination);
  }
  async changeEquipment(entry: string | undefined, slot: EquipmentSlot, signal?: AbortSignal, memberId='player'): Promise<void> {
    if(!this.wardrobe||!this.player||this.loadingWorld||this.destroyed)throw new Error('请等待地图加载');
    if(memberId!=='player'){
      const member=this.app.session.party?.get(memberId);if(!member)throw new Error('伙伴不存在');
      const bag=this.app.session.bag,revision=bag.revision;
      const next=entry?bag.planEquip(entry,slot,memberId,member.classId,member.level):bag.planUnequip(slot,memberId);
      const wardrobe=this.companionWardrobe(memberId),base=this.app.world.actors[member.definition.actor];
      const learned=learnedSkillIds(this.app.battleCatalog,member.classId,member.skills);
      const learnedSignature=[...learned].sort().join('|');
      const outfit=await wardrobe.prepare(base,bag.equipmentItems(next),member.classId,{learnedSkills:learned,signal});
      signal?.throwIfAborted();
      if(this.destroyed||this.app.session.party?.get(memberId)!==member||revision!==bag.revision||learnedSignature!==[...learnedSkillIds(this.app.battleCatalog,member.classId,member.skills)].sort().join('|'))throw new Error('装备状态已改变，请重新选择');
      if(entry)this.app.session.bag.equip(entry,slot,memberId,member.classId,member.level);
      else this.app.session.bag.unequip(slot,memberId);
      const wardrobeChanged=this.companionOutfits.get(memberId)?.actor!==outfit.actor;
      wardrobe.activate(outfit);this.companionOutfits.set(memberId,outfit);
      this.projectedMemberEquipment.set(memberId,JSON.stringify(bag.equipmentItems(bag.equipmentFor(memberId))));
      this.companionLearned.set(memberId,learnedSignature);
      this.companionFull.add(memberId);if(wardrobeChanged)this.combat?.updateMemberAppearance(memberId,outfit.actor);
      if(wardrobeChanged||slot==='main-hand'||slot==='off-hand')this.combat?.updateEquipment(memberId);
      return;
    }
    const bag=this.app.session.bag,revision=bag.revision,request=++this.outfitRequest;
    const skillsVersion=this.app.session.skills.version,skillsReset=this.app.session.skills.resetVersion;
    const next=entry?bag.planEquip(entry,slot):bag.planUnequip(slot);
    const outfit=await this.wardrobe.prepare(this.app.session.character!.appearance,bag.equipmentItems(next),this.app.session.character!.classId,{learnedSkills:learnedSkillIds(this.app.battleCatalog,this.app.session.character!.classId,this.app.session.skills),signal});
    signal?.throwIfAborted();
    if(this.destroyed||request!==this.outfitRequest||revision!==bag.revision||skillsVersion!==this.app.session.skills.version||skillsReset!==this.app.session.skills.resetVersion)throw new Error('装备状态已改变，请重新选择');
    this.wardrobe.activate(outfit);this.equippedActor=outfit.actor;
    const wardrobeChanged=this.player.actor!==outfit.actor;
    if(wardrobeChanged){
      this.player.actor=outfit.actor;setCharacterClip(this,this.player,`idle-${this.facing}`,true);
      this.movement?.refreshShape(this.player);
    }
    if(entry)bag.equip(entry,slot);else bag.unequip(slot);
    this.projectedPlayerEquipment=JSON.stringify(bag.equipmentItems());
    if(wardrobeChanged||slot==='main-hand'||slot==='off-hand')this.combat?.updateEquipment();
  }
  private companionWardrobe(id:string):Wardrobe {
    return acquireCompanionWardrobe(this.companionWardrobes,id,
      ()=>new Wardrobe(this,this.app.wardrobe,this.app.items,(ids,signal)=>this.app.content.wardrobePoses(ids,signal),this.app.outfits),
      {keep:candidate=>this.companionWardrobeInUse(candidate),
        limit:this.activeCompanionCount()+1,
        onEvict:candidate=>this.forgetCompanionWardrobe(candidate)});
  }
  /** 上阵佣兵数；缓存上限只留他们和当前正在看的那一个。 */
  private activeCompanionCount():number {
    return (this.app.session.party?.activeIds??[]).filter(id=>id!=='player').length;
  }
  private forgetCompanionWardrobe(id:string):void {
    this.companionOutfits.delete(id);this.companionPreparations.delete(id);
    this.projectedMemberEquipment.delete(id);this.companionFull.delete(id);
    this.companionPinned.delete(id);this.companionLearned.delete(id);
    this.companionAssets.get(id)?.release();this.companionAssets.delete(id);
    if(this.companionPreviewId===id)this.companionPreviewId=undefined;
  }
  private releaseCompanionWardrobe(id:string):void {
    const wardrobe=this.companionWardrobes.get(id);
    if(wardrobe){wardrobe.destroy();this.companionWardrobes.delete(id);}
    this.forgetCompanionWardrobe(id);
  }
  /**
   * 菜单关闭或离开队伍页时调用：清掉预览标记，只留下上阵队员的衣柜。
   * 下次再点开候补佣兵时按当前装备重新合成外观。
   */
  releasePartyPreview():void {
    this.companionPreviewId=undefined;
    pruneCompanionWardrobes(this.companionWardrobes,
      id=>this.companionWardrobeInUse(id),
      id=>this.forgetCompanionWardrobe(id));
  }
  /** 菜单刚选中的成员、上阵队员和正在准备的衣柜不参与 LRU 淘汰。 */
  private companionWardrobeInUse(id:string):boolean {
    if(!this.app.session.party?.get(id))return false;
    return id===this.companionPreviewId||this.companionPreparations.has(id)
      ||this.companionPinned.has(id)||this.app.session.party?.activeIds.includes(id)===true;
  }
  /**
   * 准备伙伴外观。菜单预览只合成 `idle-south`；`full` 用于进战斗等需要整套动作的路径。
   */
  async preparePartyMember(id:string,signal?:AbortSignal,options?:{full?:boolean;pin?:boolean}):Promise<void> {
    if(id==='player')return;
    const member=this.app.session.party?.get(id);if(!member||this.destroyed)throw new Error('伙伴不存在');
    const full=options?.full===true,pin=full&&options?.pin===true;
    if(!full)this.companionPreviewId=id;
    const bag=this.app.session.bag,equipment=bag.equipmentItems(bag.equipmentFor(id)),signature=JSON.stringify(equipment);
    const learned=learnedSkillIds(this.app.battleCatalog,member.classId,member.skills);
    const signatureOf=(ids:ReadonlySet<string>)=>[...ids].sort().join('|');
    const learnedSignature=signatureOf(learned);
    // 装备或技能变化都会让整套外观失效；不能只比装备。
    if(this.projectedMemberEquipment.get(id)!==signature||this.companionLearned.get(id)!==learnedSignature)this.companionFull.delete(id);
    const ready=this.companionOutfits.has(id)&&this.projectedMemberEquipment.get(id)===signature
      &&(full?this.companionFull.has(id)&&this.companionLearned.get(id)===learnedSignature:true);
    if(ready){if(pin)this.pinCompanion(id);return;}
    const wardrobe=this.companionWardrobe(id);
    let preparation=this.companionPreparations.get(id);
    if(!preparation||preparation.equipment!==signature||preparation.learned!==learnedSignature||(full&&!preparation.full)){
      const owner=this.request;
      const changed=()=>this.destroyed||owner!==this.request||owner.signal.aborted
        ||signature!==JSON.stringify(bag.equipmentItems(bag.equipmentFor(id)))||this.app.session.party?.get(id)!==member;
      const promise=(async()=>{
        if(full){
          const actor=this.app.world.actors[member.definition.actor];
          if(actor){
            const assets=partyMemberCombatAssets(this.app.battleCatalog,this.app.wardrobe,member.classId,actor,learned,{items:this.app.items,equipment});
            const lease=await loadSceneAssets(this,assets,()=>{},true);
            try{
              signal?.throwIfAborted();
              if(changed())throw new Error('伙伴状态已改变');
              const previous=this.companionAssets.get(id);
              this.companionAssets.set(id,lease);previous?.release();
            }catch(error){lease.release();throw error;}
          }
        }
        return wardrobe.prepare(this.app.world.actors[member.definition.actor],equipment,member.classId,
          full?{learnedSkills:learned}:{clipNames:['idle-south']});
      })().then(outfit=>{
        signal?.throwIfAborted();
        if(changed())throw new Error('伙伴状态已改变');
        // 准备期间又学了技能时，这套外观只覆盖了旧技能；留给下一次重拼。
        if(signatureOf(learnedSkillIds(this.app.battleCatalog,member.classId,member.skills))!==learnedSignature)throw new Error('伙伴技能已改变');
        // 已经准备好整套外观时，晚到的预览结果不能把它降级成单动作外观。
        if(!full&&this.companionFull.has(id))return;
        wardrobe.activate(outfit);this.companionOutfits.set(id,outfit);
        if(full)this.companionFull.add(id);
        this.combat?.updateMemberAppearance(id,outfit.actor);
        this.projectedMemberEquipment.set(id,signature);this.companionLearned.set(id,learnedSignature);
        this.combat?.updateEquipment(id);
        if(pin)this.pinCompanion(id);
      });
      preparation={equipment:signature,learned:learnedSignature,full,promise};this.companionPreparations.set(id,preparation);
    }
    try{await preparation.promise;signal?.throwIfAborted();}
    finally{
      if(this.companionPreparations.get(id)===preparation)this.companionPreparations.delete(id);
      // 菜单在准备期间关闭时，预览标记已经清掉；准备完成后立即释放，不必等下次取用再淘汰。
      if(!this.companionWardrobeInUse(id))this.releaseCompanionWardrobe(id);
    }
  }

  /** 招募时预拼的外观在正式上阵前不能被预览淘汰；最多留最近两套。 */
  private pinCompanion(id:string):void {
    this.companionPinned.delete(id);this.companionPinned.add(id);
    while(this.companionPinned.size>2){
      const oldest=this.companionPinned.values().next().value;
      if(oldest===undefined)break;
      this.companionPinned.delete(oldest);
      if(!this.companionWardrobeInUse(oldest))this.releaseCompanionWardrobe(oldest);
    }
  }
  equipmentAppearance(id:string):ActorDefinition|undefined{return id==='player'?this.player?.actor:this.companionOutfits.get(id)?.actor;}
  async summonLampMerchant(entry:string,signal:AbortSignal):Promise<void>{
    signal.throwIfAborted();
    const map=this.map,movement=this.movement,session=this.app.session;
    if(!map||!movement||!this.player||this.destroyed)throw new Error('当前地图无法召唤商人');
    const actor=this.app.world.actors[this.app.shops.lampShop];
    if(!actor)throw new Error('神灯商人素材缺失');
    const lease=await this.loadAssets(characterAssets(actor,characterSceneClips(actor)),map.name,false,true);
    let character:Character|undefined;
    try{
      signal.throwIfAborted();
      if(this.destroyed||this.map!==map||this.app.session!==session)throw new Error('当前地图已变化');
      const origin=this.controlledPosition(),navigation=movement.navigation;
      const point=navigation.nearestReachableBody(actor,origin,undefined,undefined,[],
        p=>navigation.terrainFree(p)&&Math.hypot(p.x-origin.x,p.y-origin.y)<=64);
      if(!point)throw new Error('附近没有可以召唤商人的空位');
      let serial=1;while(session.storyWorld.entity(`lamp-merchant-${serial}`))serial++;
      const entity:EntityPlacement & {map:string}={id:`lamp-merchant-${serial}`,actor:actor.id,map:map.id,...point};
      character=this.createActor(entity);
      movement.place(character,point);
      summonLampMerchant(session,entry,entity);
    }catch(error){
      if(character){movement.remove(character);character.container.destroy();}
      lease.release();throw error;
    }
    this.storyEntityAssets.push(lease);this.projectedActorIds.add(actor.id);
    this.characters.push(character!);this.entities.push(character!.entity);
    this.charactersRevision++;this.interactionRevision++;
    this.rebuildTriggerIndex();this.refreshState();this.syncHud();
  }

  createActor(entity: EntityPlacement): Character {
    const actor = entity.id === 'player' ? this.equippedActor ?? this.app.session.character?.appearance ?? this.app.world.actors[this.app.session.storyWorld.actorAppearance(entity.actor)] : this.app.world.actors[this.app.session.storyWorld.actorAppearance(entity.actor)];
    const character: Character = { ...createCharacter(this, actor, entity), marker: null };
    const facing=this.app.session.storyWorld.entity(entity.id)?.facing
      ?? (entity.flip && actor.clips['idle-east'] ? 'east' : undefined);
    if(facing)this.setClip(character,`idle-${facing}`);
    const container = character.container;
    const player = entity.id === 'player';
    this.movement!.register(character, player, player, player ? 'party' : 'neutral');
    if (actor.chest) {
      const clip = actor.clips['idle-south']!;
      const left = -clip.frameWidth * (character.flipped ? 1 - clip.originX : clip.originX);
      container.setInteractive(new Phaser.Geom.Rectangle(left, -clip.frameHeight * clip.originY,
        clip.frameWidth, clip.frameHeight), Phaser.Geom.Rectangle.Contains);
      container.on('pointerdown', (_pointer: Phaser.Input.Pointer, _x: number, _y: number, event: Phaser.Types.Input.EventData) => {
        event.stopPropagation(); this.openChest(character);
      });
    }
    if(entity.id==='player'){
      this.overheadStatus?.destroy();
      this.overheadStatus=new OverheadStatus(this,character,this.app.statusHud,()=>this.app.session.player,
        listener=>this.app.session.subscribe(listener));
      this.overheadStatus.setVisible(false);
    }
    return character;
  }

  /** 任务标记按需创建：任务可能在进图后才变为可接取，不能只在建角色时判断一次。 */
  private createQuestMarker(character: Character): void {
    if (character.marker) return;
    character.marker = new QuestMarker(this);
    this.questMarkerCharacters?.add(character);
    this.syncQuestMarker(character);
  }
  private removeQuestMarker(character: Character): void {
    this.questMarkerCharacters?.delete(character);
    character.marker?.destroy();
    character.marker = null;
  }
  /** 只同步有标记的角色：位置、透明度和显隐都跟着角色走，图标本身在世界高深度层。 */
  private syncQuestMarker(character: Character): void {
    const marker = character.marker; if (!marker) return;
    marker.retryTexture();
    marker.position(character.container.x, character.container.y);
    marker.setAlpha(character.container.alpha);
    marker.setVisible(character.container.visible && !this.stageOccluded);
  }
  private updateQuestMarkerPositions(): void {
    if (!this.questMarkerCharacters?.size) return;
    for (const character of this.questMarkerCharacters) this.syncQuestMarker(character);
  }
  setClip(character: Character, name: ClipName): void {
    setCharacterClip(this, character, name);
  }
  /** 当前操控者、它的技能配置与当前技能组。快捷栏与 HUD 都按这一份读。 */
  private controlledContext(){
    const {session}=this.app,member=this.combat?.controlledMember??session.hero!,owner=this.combat?.controlledId??'player';
    const configuration=owner==='player'?session.skills:(member as import('../domain/party.ts').CompanionMember).skills;
    return {member,owner,configuration,page:configuration.shortcutPage(member.classId)};
  }
  /** 某位成员的十二格快捷栏。技能与物品共用同一排槽，见 `domain/shortcut-bar.ts`。 */
  private shortcutBar(owner:string,classId:string,configuration:ReturnType<WorldScene['controlledContext']>['configuration']):ShortcutBar {
    const bag=this.app.session.bag;
    return ShortcutBar.for(bag,owner,configuration.activeSkills(this.app.battleCatalog,classId),
      owner==='player'?bag.catalog.startingShortcut:undefined);
  }
  /** 一格快捷位要画什么：技能看图标与起手条件，物品看图标、数量与恢复冷却。 */
  private shortcutSlot(entry:ShortcutEntry|null,mana:number,level:number):ShortcutSlot {
    if(!entry)return {entry:null,quantity:0,enabled:false};
    const combat=this.combat;
    if(entry.kind==='skill'){
      const state=combat?.skillShortcutState(entry.id,level);
      return {entry,icon:this.app.battleCatalog.skills[entry.id]?.icon,quantity:0,
        enabled:!!state?.enabled&&mana>=(state?.cost??0)};
    }
    const item=this.app.items.items[entry.id],quantity=this.app.session.bag.count(entry.id);
    return {entry,icon:item?.icon,quantity,enabled:quantity>0,
      cooldown:item?.use?.kind==='recover-health'?this.app.session.recovery.cooldown:undefined};
  }
  /** 按当前组重画六格。战斗帧也会调它，所以每步只算状态、不重建资源。 */
  refreshShortcutPage():void {
    if(!this.controls)return;
    const {battleCatalog,session}=this.app;
    const {member,owner,configuration,page}=this.controlledContext();
    let cache=this.shortcutPageCache;
    if(!cache||cache.configuration!==configuration||cache.version!==configuration.version||cache.bagRevision!==session.bag.revision||
      cache.owner!==owner||cache.classId!==member.classId||cache.page!==page){
      const entries=this.shortcutBar(owner,member.classId,configuration).page(page);
      const levels=configuration.draft(battleCatalog,member.classId).levels;
      cache={configuration,version:configuration.version,bagRevision:session.bag.revision,owner,classId:member.classId,page,entries,levels};
      this.shortcutPageCache=cache;
    }
    const slots=cache.entries.map(entry=>this.shortcutSlot(entry,member.player.mana,cache.levels[entry?.id??'']??0));
    const slotsSignature=slots.map(s=>s.entry?`${s.entry.kind}:${s.entry.id}:${s.quantity}:${s.enabled?1:0}:${s.cooldown?.remainingMs??0}/${s.cooldown?.durationMs??0}`:'_').join('|');
    // 签名没变时连 HUD 喂数据都省掉；切组、切人和冷却读数变化才重绘。
    if(cache.slotsSignature===slotsSignature)return;
    cache.slotsSignature=slotsSignature;
    this.skillHud?.setPage(slots);
    this.controls.setShortcutPage(slots);
  }

  /** 战斗钟走一格才重算快捷栏；切人、翻页、背包变化等事件路径仍会立即刷新。 */
  private refreshShortcutPageIfTickChanged():void {
    const tick=this.app.session.combatTick;
    if(this.shortcutTick===tick)return;
    this.shortcutTick=tick;
    this.refreshShortcutPage();
  }
  private refreshLoadout(): void {
    this.refreshShortcutPage();
    // 同时喂操作按钮和电脑模式技能行；切人后两边都不会漏掉当前操控者的冷却。
    this.refreshSkillCooldowns(this.combat?.cooldowns??{});
  }

  /** 数字键放当前轮组的快捷位；格子里是物品就用物品，是技能就放技能。 */
  private triggerShortcutSlot(slot:number):void {
    if(!this.canControl)return;
    const {member,owner,configuration,page}=this.controlledContext();
    const entry=this.shortcutBar(owner,member.classId,configuration).page(page)[slot-1];
    if(!entry)return;
    if(entry.kind==='item')this.useShortcutItem(entry.id);
    else this.combat?.attack(entry.id);
  }

  /** 切组按钮与 Q 键共用同一条路径。 */
  private cycleShortcutPage():void {
    if(!this.canControl)return;
    const {member,configuration}=this.controlledContext();
    configuration.nextShortcutPage(member.classId);
    this.refreshLoadout();
  }

  /** 头像点击与 Q/E 共用：真的换了人才释放连打，避免新角色自动替上一人出手。 */
  private switchControlled(id:string):boolean {
    if(!this.canControl)return false;
    if(!this.combat?.switchControl(id))return false;
    this.autoAttack.release();
    return true;
  }
  /** Q/E 切上一个/下一个操作人物；具体目标由战斗层按存活和控制器筛选。 */
  private switchMember(direction:-1|1):void {
    if(!this.canControl)return;
    if(this.combat?.switchMember(direction))this.autoAttack.release();
  }
  /** 键位编辑读取实际操控者当前组六格，不另选角色或快捷页。 */
  getControlLayoutPreview():readonly ShortcutSlot[]{return this.controls?.snapshot()??[];}
  /** 点消耗品格：恢复药水走整队恢复，复活卷轴按上阵顺序复活，其它物品走普通的「使用」。 */
  private useShortcutItem(itemId:string):void {
    if(!this.canControl)return;
    const bag=this.app.session.bag,entry=bag.entries.find(value=>value.item===itemId);
    if(!entry)return;
    const kind=this.app.items.items[entry.item].use?.kind;
    if(kind==='revive'){
      const party=this.app.session.party;
      if(!party)return;
      if(!party.livingIds.length){this.app.ui.showInstant('全队阵亡时无法使用复活卷轴，请返回检查点或读取存档。');return;}
      const target=party.activeIds.find(id=>!party.alive(id));
      if(!target){this.app.ui.showInstant('当前没有阵亡的出战队员');return;}
      try{this.revivePartyMember(target,entry.id);}catch(error){this.app.ui.showInstant((error as Error).message);}
      return;
    }
    if(['recover-health','regenerate'].includes(kind??''))this.combat?.useRecoveryItem(entry.id);
    else try{bag.use(entry.id);}catch(error){this.app.ui.showInstant((error as Error).message);}
  }
  /** 剧情摆放的宝箱是一次性奖励：开启后跨地图访问都保持已开启。 */
  private chestOpened(character:Character):boolean {
    if(!this.map||!character.actor.chest)return false;
    return this.app.session.chests.isOpened(this.map.id,character.entity.id,
      this.app.session.storyWorld.isPlaced(character.entity.id));
  }
  /**
   * 任务完成和进度只在任务簿版本变化时对比；完成优先，同一轮不再发进度。
   * 日志外和对话/剧情任务不提示：它们本来就不进任务日志，或已有任务窗。
   */
  private noticeQuestChanges(): void {
    const version=this.app.session.questBook.version;
    if(version===this.questStatusVersion)return;
    const {snapshot,completions,progress}=questNotices(
      this.questStatuses,
      this.app.session.quests,
      id=>this.app.session.definition(id)
    );
    this.questStatuses=snapshot;
    this.questStatusVersion=version;
    if(!this.questNoticesReady){this.questNoticesReady=true;return;}
    for(const message of completions)this.app.ui.showInstant(message);
    if(!completions.length&&progress)this.app.ui.showInstant(progress);
  }

  /** 地图与角色集合变化后重建触发索引；内容不可变，查询侧只读。 */
  private rebuildTriggerIndex():void {
    this.interactionRevision=(this.interactionRevision??0)+1;
    this.triggerIndex=this.map?buildStoryTriggerIndex(this.app.campaign,this.map.id,this.characters):undefined;
  }
  /** 整图角色显隐、任务标记和小地图重建只在这些输入变化时执行。 */
  private refreshStateSignature():string {
    const session=this.app.session;
    return [this.map?.id??'',this.performing?1:0,this.combat?.controlledId??'player',this.charactersRevision,
      session.questBook?.version??0,session.storyWorld?.revision??0,session.chests?.revision??0,
      session.legendaryWeapons?.revision??0,session.runtimeState?.sequence??0,session.restorationVersion??0,
      session.debugFocusQuest??''].join('|');
  }
  refreshState(): void {
    this.refreshLoadout();
    this.combat?.setPerformanceActive(this.performing);
    const { session } = this.app;
    this.noticeQuestChanges();
    // 小地图创建前的那次刷新也会写签名；把「小地图是否已就绪」算进签名，
    // 保证创建后的第一次刷新一定执行，把本图任务人物交给小地图。
    const stateSignature=this.refreshStateSignature()+(this.minimap?'|minimap':'');
    if(stateSignature===this.refreshStateSignatureValue)return;
    this.refreshStateSignatureValue=stateSignature;
    this.interactionRevision=(this.interactionRevision??0)+1;
    const taskMarkers: MinimapTask[] = [];
    for (const character of this.characters) {
      const opened = this.chestOpened(character), consumed = this.legendarySwordConsumed(character);
      // `actor-visibility` / `remove-character` 记在本图角色状态里；静态摆放也要立即隐藏并停碰撞。
      const present = !this.map || session.storyWorld.actorVisible(this.map.id, character.entity.actor, character.entity.characterId);
      character.container.setVisible(!this.performing && present && session.visible(character.entity) &&
        (!opened || this.chestFades.has(character.entity.id)) && !consumed);
      this.movement?.setEnabled(character, character.container.visible && !opened && !consumed);
      const status = session.marker(character.entity.actor,character.entity.characterId);
      // 头顶和小地图共用 `markerActor` 这一个判断，避免同一任务在两处显示不同标记。
      // 日志外任务不进任务日志，但可接、进行中、待交付照常挂场景标记。
      const marked = session.markerActor(character.entity.actor,character.entity.characterId);
      // 任务可能在进图后才变为可接取：标记缺失时按当前任务状态补建，而不是只在建角色时判断一次。
      if (character.entity.id !== 'player' && !character.marker && status && marked)
        this.createQuestMarker(character);
      // 只换图和同步可见性；位置由 afterMovement 只对有标记的角色更新。
      if (character.marker) {
        character.marker.setFile(marked && status ? this.app.storyInterface.assets[`minimap-${status}`] : undefined);
        this.syncQuestMarker(character);
      }
      if (character.entity.id !== 'player' && character.container.visible && marked
        && status && status !== 'locked' && status !== 'completed')
        taskMarkers.push({id: character.entity.id, x: character.container.x, y: character.container.y, status});
    }
    const map = this.map;
    if (!map) return;
    if (this.minimap) {
      if (this.player) this.minimap.updatePlayer((this.combat?.controlledVisual??this.player).container);
      this.minimap.updateTasks(taskMarkers);
    }
  }
  resizeView(): void {
    this.layoutHud();
    if (!this.map) return;
    const camera = this.cameras.main, zoom = worldZoom(this);
    camera.setZoom(zoom).setRoundPixels(true);
    // 小地图铺不满宽屏手机时，镜头边界向两侧对称展开。
    const width = Math.max(this.map.width, this.scale.width / zoom), height = Math.max(this.map.height, this.scale.height / zoom);
    camera.setBounds((this.map.width - width) / 2, (this.map.height - height) / 2, width, height);
  }
  /** 界面层与摇杆随视口摆放，和地图是否就绪无关。 */
  /** 帧率显示：左上角小地图右边，设置里可关，默认开（application/display-settings）。 */
  private createFpsReadout(): { dom?: DomLabel } {
    const dom=this.app.domUi?.label('hud','dom-fps');
    if(dom)dom.setStyle({fontSize:'22px',color:'#fff4dc',textShadow:'0 1px 2px rgba(0,0,0,.7)'});
    return { dom };
  }
  private layoutFps(): void {
    const extent = this.minimap?.extent(), readout = this.fpsReadout;
    if (!extent || !readout?.dom) return;
    readout.dom.setPosition(extent.x + extent.width + 8, extent.y);
  }
  private updateFps(): void {
    const readout = this.fpsReadout;
    if (!readout?.dom) return;
    const visible = displaySettings.fps;
    if (readout.lastVisible !== visible) {
      readout.lastVisible = visible;
      this.fpsFrameBase = this.game.loop.frame; this.fpsWindowStart = 0; this.fpsActualFrames = 0;
      readout.dom.setVisible(visible);
    }
    if (!visible) return;
    // 数浏览器的 requestAnimationFrame 调用次数，不是游戏更新次数：
    // 限帧后游戏每秒只更新 60 次，浏览器仍可能按屏幕刷新率叫 120 次。
    const now = performance.now();
    if (!this.fpsWindowStart) {
      this.fpsWindowStart = now;
      this.fpsFrameBase = this.game.loop.frame;
      this.fpsActualFrames = 0;
    }
    // updateFps 每个真正交付到画面的游戏帧调用一次，所以直接数调用次数。
    this.fpsActualFrames++;
    const elapsed = now - this.fpsWindowStart;
    // 挂起、演出遮挡等长时间不更新后，先以当前帧重新开窗，避免把停顿算成一次超低值。
    if (elapsed > FPS_RESET_AFTER_IDLE_MS) {
      this.fpsWindowStart = now; this.fpsFrameBase = this.game.loop.frame; this.fpsActualFrames = 0; return;
    }
    if (elapsed < FPS_WINDOW_MS) return;
    const raf = Math.round(Math.max(0, this.game.loop.frame - this.fpsFrameBase) * 1000 / elapsed);
    const actual = Math.round(this.fpsActualFrames * 1000 / elapsed);
    this.fpsFrameBase = this.game.loop.frame; this.fpsWindowStart = now; this.fpsActualFrames = 0;
    if (readout.lastRaf !== raf || readout.lastActual !== actual) {
      readout.lastRaf = raf;
      readout.lastActual = actual;
      readout.dom.setText(`rAF ${raf} / 实际 ${actual} 帧`);
    }
  }
  private layoutHud(): void {
    this.hud?.layout(this.scale.width, this.scale.height);
    this.stick?.layout();
    this.controls?.layout();
    this.skillHud?.layout();
    this.nameBanner?.layout();
    this.minimap?.layout();
    this.layoutFps();
    this.statusHud?.layout();
  }
  /** 流程接管输入时把摇杆放回中位。 */
  resetInput(): void {
    const controlled=this.combat?.controlledVisual??this.player;
    if (controlled && this.movement) {
      if (this.performing) this.movement.body(controlled).stop();
      else this.movement.stop(controlled);
    }
    if(this.performing)this.combat?.suspendPartyActions();
    else this.combat?.setPaused(!this.canCombatControl);
    this.controls?.resetInput(); this.stick?.reset(); this.syncHud();
  }
  trimTextures(): void {
    if(!this.mapAssets)return;
    this.app.retainMapAssets(this.mapAssets);this.mapAssets=undefined;
  }
  /** 把失败现场写进现有诊断收集（public/diagnostics.js），返回给界面显示的文案。 */
  private recordFailure(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    const snapshot=this.diagnosticSnapshot();
    globalThis.storyDiagnostics?.record('world-failure', { message, stack: error instanceof Error ? error.stack : undefined,
      map: snapshot.map, player: snapshot.player, corrections: snapshot.corrections });
    return message;
  }
  failure(error: unknown): void {
    if (this.destroyed) return;
    console.error(error);
    // 错误页在背景之上；先撤掉跨图黑幕，保证重试按钮可见。
    this.app.ui.setWorldRebuildCover(false);
    this.app.ui.error(this.recordFailure(error), () => this.scene.restart(this.options));
  }
  /**
   * 攻击键这一帧做什么。先查身边有没有可交互对象，命中就走交互，落空才发起普攻；
   * 所以选中敌人时也能开箱、喝泉水、找 NPC 说话。`interact` 返回假（身边没有可交互对象）时落回普攻。
   */
  private attackKey(): void {
    if (!this.canControl) return;
    this.updateInteractionTarget();
    if (this.near && this.interact()) return;
    this.startBasicAttack();
  }

  /**
   * 电脑鼠标左键：点界面控件不动手，点敌人直接普攻，其余地面点击沿用
   * `attackKey`（身边有可交互对象就先交互）。触屏和手写笔仍走对象自己的事件。
   */
  private onPointerDown(pointer:Phaser.Input.Pointer,objects:Phaser.GameObjects.GameObject[]):void {
    if(pointer.button!==0||pointer.wasTouch||this.stageOccluded||!this.canControl)return;
    if(objects.some(object=>object.getData('uiAction')))return;
    if(objects.some(object=>object.getData('enemy'))){this.startBasicAttack();return;}
    this.attackKey();
  }
  /** 玩家发起一次普攻：记下连打，之后站定就自动接下一击（原版出手后站着会接下一下）。 */
  private startBasicAttack(): void {
    this.autoAttack.engage();
    this.combat?.attack();
  }
  /** 玩家主动施放的攻击技能结束后，站定时尝试接一次普攻。 */
  offensiveSkillCompleted(actorId:string):void {
    if(this.canControl&&this.combat?.controlledId===actorId)this.autoAttack.engageAfterSkill();
  }
  /** 交互一次。返回假表示这一下没有命中任何可交互对象，调用方（攻击键）应改为普攻。 */
  interact(): boolean {
    if (!this.canControl) return false;
    this.updateInteractionTarget();
    if (!this.near) return false;
    const target = this.near;
    const chest = !!target.actor.chest, spring = !!target.entity.spring, service = target.actor.service;
    // 只按原版的分支顺序查询：宝箱/泉水/服务 NPC 不读商店，非服务 NPC 才占任务槽。
    const shop = !chest && !spring && !service ? !!this.app.shops.shops[target.entity.actor] : false;
    const questSlot = service ? this.takesQuestSlot(target.entity)
      : shop && !target.entity.objective ? this.takesQuestSlot(target.entity) : false;
    const action = resolveInteraction({
      chest,
      spring,
      service,
      objective: !!target.entity.objective,
      questSlot,
      shop,
    });
    // 朝向只决定交互时的表演方向，不再参与“能不能交互”的判定。
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
  private pullLegendarySword(target:Character):void {
    const map=this.map, drops=this.dropCatalog;
    if(!map||!drops||this.app.session.legendaryWeapons.isPulled(map.id,target.entity.id))return;
    this.playStory(async()=>{
      const uniqueBonus=this.app.session.party?.groupModifiers()['ancient-legendary-chance']??0;
      const result=pullLegendaryWeapon(this.app.session,this.app.characterStats,drops,map.id,target.entity.id,map.lootLevel??0,Math.random,
        {x:target.entity.x,y:target.entity.y},uniqueBonus);
      if(result.success)this.app.audio?.effect('UI_Ground_sword');
      this.app.ui.showInstant(result.message);
      this.app.autoSave?.();
      this.checkpointStoryWorld();
      this.refreshState();
      this.updateInteractionTarget();
      this.syncHud();
      return true;
    });
  }
  private restAtInnkeeper(target:Character):void {
    const quote=innRestQuote(this.app.session);
    this.playStory(()=>this.app.director.visitInnkeeper(target.actor,quote,()=>{
      payForInnRest(this.app.session,quote);
      this.app.autoSave?.();
      this.checkpointStoryWorld();
      this.app.ui.showInstant('已恢复全部的生命和魔法。');
      this.syncHud();
    }));
  }
  private legendarySwordConsumed(character:Character):boolean {
    return character.actor.service==='legendary-sword'&&!!this.map&&this.app.session.legendaryWeapons.isPulled(this.map.id,character.entity.id);
  }
  /** 这个 NPC 的原版任务槽当前是否压过商店/合成等功能（待交付或可接）。 */
  private takesQuestSlot(entity:EntityPlacement):boolean {
    const quest=this.app.session.npcQuestSlot(entity.actor,entity.characterId);
    return !!quest&&['available','ready'].includes(this.app.session.status(quest.id));
  }
  /** 当前受控角色的脚底坐标——交互距离与朝向都以它为锚点。 */
  private controlledPosition():{x:number;y:number}{
    return this.combat?.controlledVisual?.container ?? this.player?.container ?? {x:0,y:0};
  }
  /** 交互前把操控者转向目标：朝向只影响表现和剧情快照，不再是交互门槛。 */
  private turnToInteractionTarget(target: Character): void {
    const facing = faceTarget(this.controlledPosition(), target.container);
    if (this.combat) this.combat.facing = facing;
    else this.facing = facing;
  }
  /**
   * 泉水喝过一次就空了。原版 `CHAR_DrinkSpring` 的公共尾把泉水对象的 id 字段写成水井（npc 38）
   * 再重算外观——水井用的是没有液体的那张图，而且它没有 NPC 功能，所以再交互不会有效果也不提示。
   */
  private drainSpring(character: Character): void {
    const empty = this.springCatalog?.empty, actor = empty ? this.app.world.actors[empty] : undefined;
    if (!actor) throw new Error('泉水缺少喝空后的外观');
    character.actor = actor;
    this.interactionRevision=(this.interactionRevision??0)+1;
    setCharacterClip(this, character, 'idle-south', true);
  }
  /** 同图重建或剧情投影后，把本次地图访问里喝空的泉水重新换成水井外观。 */
  private restoreDrainedSprings(): void {
    if(!this.map)return;
    const empty=this.springCatalog?.empty;if(!empty)return;
    for(const character of this.characters)
      if(character.entity.spring&&character.actor.id!==empty&&this.app.session.springs.isEmpty(this.map.id,character.entity.id))this.drainSpring(character);
  }
  /** 泉水结算读取的上阵成员资源；没有队伍对象时退回只有主角的一人列表。 */
  private springPartyMembers(): SpringPartyResources[] {
    const party=this.app.session.party;
    if(party)return party.activeMembers;
    const hero=this.app.session.hero;
    if(!hero)return [];
    return [{id:'player',get player(){return hero.player;},
      setHealth:(value:number)=>hero.setHealth(value),setMana:(value:number)=>hero.setMana(value),
      grantSkillPoint:()=>hero.grantSkillPoint()}];
  }
  /** 原版 `CHAR_DrinkSpring`：按这一档的效果表随机给一种奖励，再显示同一条原版提示。 */
  private drinkSpring(spring: Character): void {
    const catalog=this.springCatalog,map=this.map;
    const controlled=this.combat?.controlledVisual??this.player;
    if(!catalog||!map||!controlled||!spring.container.visible) return;
    if(!canReachChest(controlled.container,spring.container)) return;
    const effect=rollSpringEffect(catalog,spring.entity.actor,Math.random);
    if(effect.kind==='buff'){
      if(effect.buff)this.combat?.applySpringBuff(effect.buff,springBuffScope(effect.buff));
    }else if(effect.kind==='heal'||effect.kind==='heal-mana'){
      applySpringRecovery(effect,this.springPartyMembers());
    }else if(effect.kind==='skill-point'){
      grantSpringSkillPoint(this.springPartyMembers());
    }
    if(effect.kind==='spawn'&&effect.enemy) this.app.session.chests.spawnEnemy(map.id,spring.entity.id,effect.enemy,spring.container);
    this.app.audio?.ui('heal');
    // 原版在这里调 INSTANTMSGSYSTEM_Add：屏幕中间的瞬时消息，不再走深色提示框。
    this.app.ui.showInstant(effect.text);
    // 喝空：换外观并记进本次地图访问，之后靠近不再是可交互物。
    this.app.session.springs.drain(map.id, spring.entity.id);
    this.drainSpring(spring);
    this.updateInteractionTarget(); this.syncHud();
  }
  /**
   * 开箱。攻击键选中宝箱后与直接点击共用这条可动作距离检查；直接点箱子是复刻追加的
   * 点击交互（原版没有这个输入），两条路径都不要求朝向。
   */
  private openChest(character: Character): void {
    const controlled = this.combat?.controlledVisual ?? this.player;
    const kind = character.actor.chest, map = this.map;
    if (!this.canCombatControl || this.combat?.playerCannotAct() || !controlled || !kind || !map ||
      !character.container.visible || !canReachChest(controlled.container, character.container)) return;
    if (map.lootLevel === undefined || !this.dropCatalog) throw new Error('宝箱缺少地图掉落数据');
    const chestLevel = map.chestLevel ?? (map.lootLevel > 0 ? map.lootLevel : 1);
    const session=this.app.session,pity=this.dropCatalog!.pity;
    const chestKey=kind;
    const oneTime=session.storyWorld.isPlaced(character.entity.id);
    const equipmentBonus=pity?session.lootPity.chestEquipmentBonus(chestKey,pity):0;
    const result = session.chests.open(map.id, character.entity.id, character.container,
      () => {
        const rolled=rollChestLoot(this.dropCatalog!, this.app.characterStats, kind, chestLevel, session.hero!.level, Math.random, session.party?.groupModifiers(),{equipmentBonus});
        session.lootPity.recordChest(chestKey,{equipment:rolled.rewards.some(reward=>reward.kind==='item'&&!!reward.roll)});
        return rolled;
      }, oneTime);
    if (!result) return;
    character.container.disableInteractive();
    this.movement!.setEnabled(character, false);
    this.app.audio?.ui('chestOpen');
    this.spawnLoot(character.container.x, character.container.y, result.rewards);
    this.combat?.syncChestEnemies();
    const tween = this.tweens.add({ targets: character.container, alpha: 0, duration: CHEST_OPEN_MS,
      ease: (value: number) => Math.floor(value * 10) / 10,
      onComplete: () => { this.chestFades.delete(character.entity.id); character.container.setVisible(false); this.interactionRevision=(this.interactionRevision??0)+1; }
    });
    this.chestFades.set(character.entity.id, tween);
    this.updateInteractionTarget(); this.syncHud();
  }
  private playStory(work: () => Promise<boolean>): Promise<boolean> {
    return work().catch(error => {
      console.error(error);
      this.app.ui.error(this.recordFailure(error), () => { this.app.ui.loaded(); this.playStory(()=>this.app.director.retry()); });
      return false;
    });
  }
  changeMap(exit: MapExit): void {
    if (this.loadingWorld||!this.exitAvailable(exit)) return;
    this.app.session.applyStoryCommands([{type:'travel',destination:{map:exit.destination,...exit.spawn,facing:exit.facing==='any'?'south':exit.facing}}]);
    this.loadingWorld = true; this.near = null; this.app.ui.loading('正在前往新的地方…');
    this.scene.restart({ map: exit.destination, x: exit.spawn.x, y: exit.spawn.y, facing: exit.facing });
  }
  /**
   * GM 调试传送：切到目标地图并等场景就绪，让后续剧情在该图的地形和实体上开演。
   * 落点优先用调用方给的剧情坐标，没给就在地图中心找最近可站点；两种情况都按玩家体积
   * 吸附一次——内容里的坐标可能落在墙里，直接交出去等于把人放到地图角落。
   */
  async gmTravel(destination: string, spawn?: { x: number; y: number }): Promise<{ ok: boolean; reason?: string }> {
    if (this.loadingWorld || this.destroyed) return { ok: false, reason: '正在切换地图' };
    const reference = this.app.world.maps.find(entry => entry.id === destination);
    if (!reference) return { ok: false, reason: `地图不存在：${destination}` };
    let point: { x: number; y: number };
    try {
      const data = await this.app.content.map(reference.file);
      if (this.destroyed) return { ok: false, reason: '场景已关闭' };
      const appearance = this.equippedActor ?? this.app.session.character?.appearance ?? this.app.world.actors[this.app.campaign.start.actor];
      const navigation = new NavigationWorld(data), shape = { collision: appearance.collision };
      const requested = spawn ?? { x: data.width / 2, y: data.height / 2 };
      point = navigation.nearestBody(shape, requested) ?? navigation.nearest(shape, requested);
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
    this.app.session.applyStoryCommands([{ type: 'travel', destination: { map: destination, ...point, facing: 'south' } }]);
    this.loadingWorld = true; this.near = null; this.app.ui.loading('正在前往新的地方…');
    // 用场景回调结算，而不是轮询 `loadingWorld`：加载失败时那个标志不会回落，
    // 轮询只能白等超时，也说不清失败原因。GM 播放自己启动指定剧情，所以这里
    // 抑制自动入场触发——否则进图剧情先占住运行时队列，点了节点先看到别的事件。
    return new Promise(resolve => {
      let finished = false;
      const done = (result: { ok: boolean; reason?: string }) => {
        if (finished) return;
        finished = true; clearTimeout(timer); resolve(result);
      };
      const timer = setTimeout(() => done({ ok: false, reason: '切图等待超时' }), DEBUG_MAP_WAIT_TIMEOUT_MS);
      this.scene.restart({ map: destination, x: point.x, y: point.y, facing: 'south', suppressEntry: true,
        onReady: () => done({ ok: true }),
        onError: (error: unknown) => done({ ok: false, reason: error instanceof Error ? error.message : String(error) }) } satisfies SceneOptions);
    });
  }
  private get canControl(): boolean {
    // 剧情导演在接管期间即使锁的记账还没落地，玩家也不该拿到操作权：
    // 摇杆、技能键和移动都以导演的忙碌状态为准。
    return this.sys.isActive() && !this.loadingWorld && this.app.ui.ready && !this.app.ui.controlLayoutEditing
      && !this.app.ui.keyBindingEditing
      && !this.app.locked && !this.app.suspended && !this.app.director?.busy;
  }
  get canCombatControl():boolean{return this.canControl&&!this.performing;}
  /** 属性页读取当前战斗属性；战斗尚未建立时返回基础值。 */
  combatAttribute(id:string,attribute:BattleStatKey,base:number,passives:readonly PassiveModifier[]):number {
    return this.combat?.effectiveAttribute(id,attribute,base,passives)??base;
  }
  /** 属性页判断成员当前是否潜行。 */
  combatStealthed(id:string):boolean { return this.combat?.stealthed(id)??false; }
  diagnosticSnapshot() {
    const player = this.player, movement = this.movement;
    let placement: Record<string, unknown> | null = null;
    const moveState = player && movement ? movement.state(player) : undefined;
    if (player && movement && moveState) {
      const foot = movement.position(player), actor = movement.actor(player), shape = actor.shape();
      const navigation = movement.navigation, box = collisionAt(shape, foot) ?? null;
      const terrainFree = navigation.terrainFree(foot), bodyTerrainFree = navigation.bodyTerrainFree(shape, foot);
      const inWall = !terrainFree || !bodyTerrainFree;
      placement = {
        foot, box, terrainFree, bodyTerrainFree,
        // 整盒地形没问题却站不下，说明是别的角色占住了位置，不是嵌墙。
        blockedByActors: bodyTerrainFree && !navigation.canPlaceBody(shape, foot, actor),
        // 只在真的嵌墙时扫描全图找最近落点，正常上报不付这个代价。
        nearestBody: inWall && shape.collision ? navigation.nearestBody(shape, foot, actor) ?? null : null,
        inWall,
        move: moveState,
      };
    }
    return { map: this.map?.id, loading: this.loadingWorld, performing: this.performing,
      scene: { time: this.time.now, active: this.sys.isActive(), paused: this.sys.isPaused() },
      suspended: this.app.suspended, locked: this.app.locked, directorBusy: !!this.app.director?.busy,
      canControl: this.canControl, canCombatControl: this.canCombatControl,
      mapBounds: movement?.navigation.bounds ?? null,
      target: this.combat?.targetId, near: this.near?.entity.id ?? null,
      player: player ? { x: player.container.x, y: player.container.y, clip: player.clipName, facing: this.facing, ...placement } : null,
      corrections: movement?.terrainCorrections ?? [],
      combat: this.combat?.diagnostics() ?? null };
  }
  spawnLoot(x:number,y:number,rewards:readonly DropReward[]):void {
    if(this.map)this.spawnLootOnMap(this.map.id,x,y,rewards);
  }
  spawnLootOnMap(map:string,x:number,y:number,rewards:readonly DropReward[],render=true):void {
    if(!rewards.length)return;
    const landing=this.lootLanding(map,x,y);
    const store=groundLootFor(this.app.session);
    store.add(map,landing.x,landing.y,rewards.map(reward=>reward.kind==='item'&&!reward.instance&&
      (!this.app.items.items[reward.item].stackable||reward.lootLevel!==undefined)
      ?{...reward,instance:this.app.session.bag.prepareDrop(reward.item,{...(reward.roll?{grade:reward.roll,sockets:reward.roll.sockets}:{}),lootLevel:reward.lootLevel})}
      :reward),{nowMs:this.app.session.nowMs});
    if(render&&!this.destroyed&&this.map?.id===map){this.groundLootView?.sync(store.dropsOnMap(map));this.groundLootRevision=store.revision;}
  }
  /** 掉落物只落在能走过去、且不压住地图进出口的位置。 */
  private lootLanding(map:string,x:number,y:number):{x:number;y:number} {
    const navigation=this.movement?.navigation;
    if(!navigation||this.map?.id!==map)return {x,y};
    const point={x,y},exits=this.map.exits;
    // 掉落物不是角色：按 8×8 的贴图盒判断，别让装备图标盖在门洞上。
    const clear=(candidate:{x:number;y:number})=>!exits.some(exit=>
      candidate.x+4>exit.x&&candidate.x-4<exit.x+exit.width
      &&candidate.y+4>exit.y&&candidate.y-4<exit.y+exit.height);
    if(navigation.terrainFree(point)&&clear(point))return point;
    const shape={collision:{x:-4,y:-4,width:8,height:8}};
    try{return navigation.nearest(shape,point,undefined,[],clear);}
    catch{return navigation.nearest(shape,point);}
  }
  /** 一份地面奖励入账；无法结算的（例如没有战斗资源接收魔法宝石）返回 false 让掉落留在地上。 */
  private receiveGroundReward(reward:DropReward):boolean {
    const session=this.app.session;
    if(reward.kind==='money'){session.gainMoney(reward.amount);return true;}
    const item=this.app.items.items[reward.item];
    // 任务道具按当前需求封顶：有任务还需要它就正常捡，背包够了才留在地上。
    const questRemaining=item?.category==='quest'?session.questItemPickupRemaining(reward.item):undefined;
    if(questRemaining!==undefined&&questRemaining<=0){
      this.app.ui.showInstant('任务道具已经够了，不能再捡。');
      return false;
    }
    if(item?.pickup){if(!this.combat)return false;return this.combat.collectMana(item.pickup);}
    if(reward.instance)session.bag.receiveDrop(reward.instance);
    else session.bag.add(reward.item,reward.quantity);
    if(this.dropCatalog?.reservedDrops?.entries.some(entry=>entry.item===reward.item&&entry.once))
      session.claimReservedDrop(reward.item);
    return true;
  }
  /** 拾取只有一张共享背包：谁被操控，谁走到掉落上就捡进同一份背包。 */
  private collectGroundLoot(position:{x:number;y:number}):void {
    if(!this.map)return;
    const collectorId=this.combat?.controlledId??'player';
    const visual=this.combat?.controlledVisual??this.player;
    const session=this.app.session,store=groundLootFor(session);
    // 宝石只要求存在存活接收者；满蓝也会收取。任务需求、背包和读档变化再重试原地掉落。
    const availability=`${session.bag.revision}|${session.questBook.version}|${session.storyWorld.revision}|${session.restorationVersion}|${session.debugFocusQuest??''}|${!!this.combat}|${session.hasLivingMember}`;
    const picked=store.collectNearby(this.map.id,position.x,position.y,reward=>this.receiveGroundReward(reward),availability);
    if(!picked.length)return;
    session.questItemGenerators.collected(picked.map(drop=>drop.id),session.combatTick);
    // 原版在批量拾取结束时播放音效 6，与捡到的是物品还是钱无关；魔法宝石另外在恢复时播音效 5。
    if(picked.length)this.app.audio?.ui('loot');
    if(picked.some(drop=>drop.reward.kind==='item'))session.emit();
    this.groundLootView?.sync(store.dropsOnMap(this.map.id));this.groundLootRevision=store.revision;
    if(visual){
      this.pickupRecipients.set(collectorId,visual);
      this.pickupMessages?.enqueue(picked.map(drop=>drop.reward).filter(reward=>reward.kind==='money'||!this.app.items.items[reward.item].pickup),collectorId);
    }
  }
  /**
   * 剧情接管前的自动拾取：只收当前地图，飞行中的魔法宝石也一并结算。
   * 放在 `combat.normalizeForStory` 之后，先让 `pendingDefeats.flush()` 把最后一杀的掉落落进 store。
   */
  private collectMapGroundLoot():void {
    if(!this.map||this.loadingWorld||this.destroyed||this.app.session.debugFocusQuest)return;
    const session=this.app.session,mapId=this.map.id,store=groundLootFor(session);
    let picked:import('../domain/ground-loot.ts').GroundDrop[]=[];
    session.batchNotifications(()=>{
      picked=store.collectAll(mapId,reward=>this.receiveGroundReward(reward));
      if(!picked.length)return;
      session.questItemGenerators.collected(picked.map(drop=>drop.id),session.combatTick);
      session.emit();
    });
    if(picked.length){this.groundLootView?.sync(store.dropsOnMap(mapId));this.groundLootRevision=store.revision;}
  }
  refreshCombatTarget():void{this.statusHud?.setTarget(this.combat?.targetStatus());}
  revivePartyMember(id:string,item:string):import('../domain/items.ts').ItemResult{
    if(!this.combat)throw new Error('请等待地图加载');return this.combat.revive(id,item);
  }
  syncControlledCharacter(resetExitTrigger=false):void{
    const actor=this.combat?.controlledVisual??this.player;
    this.applyNoclip(actor);
    if(actor?.container.active)this.cameras.main.startFollow(actor.container,true,1,1);
    this.lastPlayerPosition=actor?this.movement?.position(actor):undefined;
    if(resetExitTrigger&&this.map&&this.lastPlayerPosition)this.exitTrigger=new ExitTrigger(this.map.exits,this.lastPlayerPosition);
    this.refreshLoadout();this.refreshCombatTarget();this.syncHud();
  }
  /**
   * GM 脱困：把当前操控者搬到最近的、整个碰撞盒都站得住的点。
   * 技能位移或人物分离把身体挤进墙格后，玩家自己走不出来；这个动作让人和 agent 都能就地恢复。
   */
  rescuePlayer():{ok:boolean;reason?:string;from?:{x:number;y:number};to?:{x:number;y:number};moved?:boolean}{
    const visual=this.combat?.controlledVisual??this.player;
    if(!visual||!this.movement||!this.map)return {ok:false,reason:'地图尚未加载'};
    const actor=this.movement.actor(visual),shape=actor.shape(),navigation=this.movement.navigation;
    const from=this.movement.position(visual);
    // 主区域以地图出口为锚点；出口本身一定在可行走区域内。
    const exit=this.map.exits[0];
    const anchor=exit?{x:exit.x+exit.width/2,y:exit.y+exit.height/2}:undefined;
    const inMain=!anchor||navigation.sameTerrainRegion(from,anchor);
    // 地形合法还不够：火焰、路障这类内容机关会把身体压住，也属于需要脱困的状态。
    if(navigation.terrainFree(from)&&navigation.bodyTerrainFree(shape,from)&&navigation.canStand(actor,from)&&inMain)
      return {ok:true,moved:false,from};
    const recovered=this.movement.recoverContent(visual);
    if(recovered&&(!anchor||navigation.sameTerrainRegion(recovered.to,anchor))){
      this.combat?.stopMoving();this.syncControlledCharacter(true);
      return {ok:true,moved:true,from:recovered.from,to:recovered.to};
    }
    const landing=anchor
      ? navigation.nearestSettledBody(shape,anchor,actor,[],point=>navigation.sameTerrainRegion(anchor,point))
      : navigation.nearestBody(shape,from,actor)??navigation.nearestReachableBody(shape,from,undefined,actor);
    if(!landing)return {ok:false,reason:'附近没有可站的整盒落点',from};
    try{this.movement.place(visual,landing);}catch(error){return {ok:false,reason:error instanceof Error?error.message:String(error),from};}
    this.combat?.stopMoving();this.syncControlledCharacter(true);
    return {ok:true,moved:true,from,to:landing};
  }
  /**
   * 穿墙始终只作用于当前操控者：换人时先关掉旧角色，关闭时也清掉记录。
   * 只按当前受控角色开关会留下旧角色仍能穿墙的残留。
   */
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
  /** GM 无敌开关：写到会话级集合，换图重建战斗后仍然有效。 */
  setInvincible(actorId:string,enabled:boolean):{ok:boolean;reason?:string}{
    if(!this.app.session.hero)return {ok:false,reason:'当前会话没有角色系统'};
    this.app.session.setInvincible(actorId,enabled);
    return {ok:true};
  }
  /** GM 一击必杀开关：同样写到会话级集合，换图重建战斗后仍然有效。 */
  setOneHitKill(actorId:string,enabled:boolean):{ok:boolean;reason?:string}{
    if(!this.app.session.hero)return {ok:false,reason:'当前会话没有角色系统'};
    this.app.session.setOneHitKill(actorId,enabled);
    return {ok:true};
  }
  /** GM 复活：先补满 HP/MP，再交给战斗侧做表现收尾（`reviveMember` 要求生命值大于 0）。 */
  reviveMember(id:string):{ok:boolean;reason?:string}{
    const session=this.app.session,member=id==='player'?session.hero:session.party?.get(id);
    if(!member)return {ok:false,reason:`没有上阵角色：${id}`};
    member.clearCombatResourceLimits();
    member.setHealth(member.player.maxHealth);member.setMana(member.player.maxMana);
    this.combat?.reviveForDebug(id);
    return {ok:true};
  }
  refreshSkillCooldowns(cooldowns:Readonly<Record<string,Cooldown>>):void{
    this.controls?.setCooldowns(cooldowns);
    this.skillHud?.setCooldowns(cooldowns);
  }
  /** 压测入口：先补载刷怪用的敌人资源，再每 0.9 秒尝试生成一只。 */
  async startPressureSpawner():Promise<void> {
    if(!this.app.pressureMode||this.pressureSpawner||!this.combat)return;
    const combat=this.combat, signal=this.request.signal;
    let pending=false;
    const spawn=async(point?:{x:number;y:number})=>{
      if(pending||signal.aborted||this.destroyed||!this.app.pressureMode||!combat.canSpawnPressureEnemy())return;
      const enemy=pressureEnemy(this.app.battleCatalog.enemies,this.app.session.hero?.level??1);
      if(!enemy)return;
      pending=true;
      try {
        if(await combat.preparePressureEnemy(enemy.id,signal) && !signal.aborted)combat.spawnPressureEnemy(enemy.id,point);
      } catch(error) { if(!signal.aborted)console.error('挑战怪物加载失败',error); }
      finally { pending=false; }
    };
    for(const point of this.pressureStartPoints){if(signal.aborted)break;await spawn(point);}
    if(signal.aborted||this.destroyed||!this.app.pressureMode)return;
    this.pressureSpawner=this.time.addEvent({delay:PRESSURE_SPAWN_INTERVAL_MS,loop:true,callback:()=>{void spawn();}});
  }
  private captureCheckpoint():boolean {
    // 调试现场和压测现场都不是玩家进度：不覆盖检查点。
    if(this.app.pressureMode||this.app.session.debugFocusQuest||this.app.gm?.storyDebug().autoSavePaused)return false;
    // 遭遇正在等待战斗结果时，已有检查点就保留：死亡回滚才不会直接落回同一场战斗。
    // 没有检查点时必须记一次兜底：读档会清空内存检查点，而读档可能正落在等待战斗的现场，
    // 这时再拒绝就会让整场战斗没有可回退的检查点。
    if(this.app.checkpoint.available&&this.app.session.hasWaitingStoryRun){
      if(!this.checkpointWaitLogged){
        this.checkpointWaitLogged=true;
        globalThis.storyDiagnostics?.record('checkpoint-kept-waiting-encounter',{map:this.map?.id});
      }
      return false;
    }
    this.checkpointWaitLogged=false;
    if(!this.map||!this.combat||!this.player||!this.movement)return false;
    if(!this.app.session.hasLivingMember){
      globalThis.storyDiagnostics?.record('checkpoint-skipped-no-survivor',{map:this.map.id});
      return false;
    }
    if(!this.app.checkpoint.capture(this.app.session,{map:this.map.id,...this.movement.position(this.player)},this.captureStoryWorld()))return false;
    this.checkpointPending=false;
    return true;
  }
  checkpointStoryWorld():void{
    this.captureCheckpoint();
  }
  async normalizeForStory(signal:AbortSignal):Promise<void>{
    this.resetInput();
    await this.combat?.normalizeForStory(signal);
    signal.throwIfAborted();
    // 演出期间玩家不能操作；先把本图地面掉落收进背包，BOSS 战后演出切图不会丢奖励。
    this.collectMapGroundLoot();
  }
captureStoryScene(includeEnemyAppearance=true):SceneSnapshot {
    if(!this.map||!this.player||!this.movement)throw new Error('正式地图尚未就绪');
    const {session}=this.app;
    const actors:SceneActorState[]=[this.player,...this.characters.filter(character=>character!==this.player)].map(character=>{
      const player=character===this.player;
      const visible=session.storyWorld.actorVisible(this.map!.id,character.entity.actor,character.entity.characterId)
        &&session.visible(character.entity)&&!this.chestOpened(character)&&!this.legendarySwordConsumed(character);
      const facing=player?this.facing:character.facing??undefined;
      const animation=characterAnimationState(character);
      return {id:player?'player':`entity:${character.entity.id}`,actor:character.entity.actor,
        characterId:character.entity.characterId,worldEntityId:player?undefined:character.entity.id,
        authority:player?undefined:character.entity.authority,
        memberId:player?'player':undefined,...this.movement!.position(character),facing:facing??'south',visible,
        flip:character.entity.flip,appearance:storyDevMode()?freezeSnapshot(character.actor):character.actor,clip:character.clipName??undefined,
        alpha:character.container.alpha,animationProgress:animation.progress,
        animationPlaying:animation.playing};
    });
    const visit=this.combat?.captureStoryVisit();
    return {map:this.map.id,actors:[...actors,...this.combat?.captureStoryActors(includeEnemyAppearance)??[]],
      ...(visit?{visit:{generatedEntities:structuredClone(this.baseEntities),...visit}}:{})};
  }

  captureStoryWorld(includeEnemyAppearance=true):StoryWorldViewSnapshot {
    if(!this.map||!this.player||!this.movement)throw new Error('正式地图尚未就绪');
    return {location:{map:this.map.id,...this.movement.position(this.player),facing:this.facing},world:this.combat?.captureState(),generatedEntities:structuredClone(this.baseEntities),scene:this.captureStoryScene(includeEnemyAppearance),audio:this.app.audio?.captureStoryAudio()};
  }
  /**
   * 存档要连世界一起带走。换图途中（`loadingWorld`）与还没进图时没有完整的落点，
   * 返回带原因的失败结果让界面给出准确提示；调试现场也走同一条失败分支。
   */
  captureSaveWorld(): SaveWorldResult {
    // 调试现场和压测现场禁手动存档，返回失败由界面给具体提示。
    if(this.app.pressureMode)return {ok:false,reason:'pressure'};
    if(this.app.session.debugFocusQuest||this.app.gm?.storyDebug().autoSavePaused)return {ok:false,reason:'debug'};
    if(!this.map||!this.player||!this.movement)return {ok:false,reason:'not-ready'};
    if(this.loadingWorld)return {ok:false,reason:'loading'};
    if(!this.app.session.hasLivingMember){
      globalThis.storyDiagnostics?.record('save-refused-no-survivor',{map:this.map.id});
      return {ok:false,reason:'no-survivors'};
    }
    this.combat?.settleForSave();
    return {ok:true,map:{id:this.map.id,name:this.map.name},world:this.captureStoryWorld(false)};
  }
  private restartStoryWorld(location:TravelDestination,signal:AbortSignal,world?:WorldCombatState,generatedEntities?:EntityPlacement[],silent=false,preparedScene?:SceneSnapshot):Promise<void>{
    signal.throwIfAborted();
    return new Promise((resolve,reject)=>{
      let finished=false,timer:ReturnType<typeof setTimeout>|undefined;
      // 子控制器：取消/超时真正中止新场景的加载。只 reject 的话，晚到的 open() 仍会跑完，
      // 用 ui.loaded() 盖掉已经显示的错误页。
      const controller=new AbortController();
      const forwardAbort=()=>controller.abort(signal.reason);
      if(signal.aborted)controller.abort(signal.reason);else signal.addEventListener('abort',forwardAbort,{once:true});
      const done=(error?:unknown)=>{if(finished)return;finished=true;if(timer)clearTimeout(timer);signal.removeEventListener('abort',abort);signal.removeEventListener('abort',forwardAbort);if(error)reject(error);else resolve();};
      const abort=()=>done(signal.reason??new Error('剧情世界切换已取消'));
      signal.addEventListener('abort',abort,{once:true});
      // 场景重建既没报错也没就绪时（例如加载卡住），不能让调用方永远等下去。
      timer=setTimeout(()=>{const error=new Error('剧情世界切换超时');controller.abort(error);done(error);},STORY_WORLD_SWITCH_TIMEOUT_MS);
      this.loadingWorld=true;
      this.scene.restart({...location,checkpoint:world,generatedEntities,preparedScene,suppressEntry:true,silentEntry:silent,signal:controller.signal,onReady:()=>done(),onError:(error:unknown)=>done(error)} satisfies SceneOptions);
    });
  }
private restoreScenePositions(snapshot:SceneSnapshot):void {
    if(snapshot.map!==this.map?.id||!this.movement)return;
    const placements:{visual:CharacterVisual;position:{x:number;y:number};enabled:boolean}[]=[];
    for(const actor of snapshot.actors){
      if(!actor.worldEntityId||actor.removed||actor.unpositioned)continue;
      const character=this.characters.find(character=>character.entity.id===actor.worldEntityId);
      if(!character)continue;
      // 人物装备由正式世界的 Wardrobe 重建；地图实体外观是可重新加载的静态资源。
      if(actor.appearance){character.actor=structuredClone(actor.appearance);this.movement.refreshShape(character);}
      this.setClip(character,`idle-${actor.facing}`);
      character.container.setAlpha(actor.alpha??1).setVisible(actor.visible&&!this.performing);
      placements.push({visual:character,position:{x:actor.x,y:actor.y},enabled:actor.visible&&!this.performing});
    }
    this.movement.placeAll(placements,{evictOccupied:true,displaceable:this.player?[this.player]:[]});
    this.interactionRevision=(this.interactionRevision??0)+1;
  }

  async restoreStoryWorld(snapshot:unknown,signal:AbortSignal):Promise<void>{
    const state=snapshot as StoryWorldViewSnapshot;
    if(!state?.location?.map)throw new Error('正式剧情世界快照无效');
    signal.throwIfAborted();
    // 回滚后这一场景观察到的胜负记录不再作数：同一场遭遇可能重新变成可打、可结算。
    this.encounterResults.clear();
    if(this.map?.id===state.location.map&&!this.loadingWorld){
      this.baseEntities=structuredClone(state.generatedEntities);
      await this.projectStoryWorld(undefined,signal,state.location);
      if(state.world)await this.combat?.restoreState(state.world,signal);
      if(state.scene)this.restoreScenePositions(state.scene);
      signal.throwIfAborted();if(state.audio)this.app.audio?.restoreStoryAudio(state.audio);this.syncControlledCharacter(true);return;
    }
    await this.restartStoryWorld(state.location,signal,state.world,state.generatedEntities,false,state.scene);
    signal.throwIfAborted();if(state.audio)this.app.audio?.restoreStoryAudio(state.audio);
  }
  /**
   * 剧情正常交还操作权后，把被剧情障碍或战斗留在远处的友方单位收拢到主角身边。
   * 取消、换图、回滚和菜单仍然走各自的快照/落位路径，不在这里重复移动。
   */
  settleStoryPlayback():void {
    if(this.destroyed||this.loadingWorld||this.stageOccluded||!this.map||!this.player||!this.movement||!this.combat)return;
    if(this.app.ui?.mode!=='game'||this.app.suspended)return;
    if(this.app.director?.busy)return;
    this.combat.settleFriendlyUnitsAroundHero();
  }
  async projectStoryWorld(stage:StoryStageSnapshot|undefined,signal:AbortSignal,restoredLocation?:TravelDestination):Promise<void>{
    signal.throwIfAborted();
    const location=this.app.session.storyWorld.currentLocation;
    const signature=JSON.stringify(location);
    if(location&&location.map!==this.map?.id){
      signal.throwIfAborted();
      // 舞台真的遮住世界（worldCovered）时直接沿用；舞台未启动或仍透明时，
      // 用常驻 UI 层的黑幕盖住重建过程。不能用 isActive 判断，首幕透明时世界仍可见。
      const stageScene=this.scene.get?.(SCENE_KEYS.storyStage) as {worldCovered?:boolean}|undefined;
      const covered=stageScene?.worldCovered===true;
      if(!covered){
        this.app.ui.setWorldRebuildCover(true);
        globalThis.storyDiagnostics?.record('story-rebuild-cover', { map: location.map });
      }
      const prepared=stage?.scene.map===location.map?stage.scene:undefined;
      try{
        // 剧情驱动的跨图一律静默；素材由这次静默重建自己加载，不退回加载页。
        await this.restartStoryWorld(location,signal,undefined,undefined,true,prepared);
      }catch(error){
        if(!covered)this.app.ui.setWorldRebuildCover(false);
        throw error;
      }
      return;
    }
    if(!this.map||!this.player||!this.movement)throw new Error('正式地图尚未就绪');
    this.app.director.onSkipProgress?.('assets-start');
    const projected=this.app.session.storyWorld.projectEntities(this.map.id,
      resolveMapActors({base:this.baseEntities,map:this.map,campaign:this.app.campaign,active:entity=>this.app.session.visible(entity)}),
      this.app.campaign.placements);
    const projectedActors=projected.map(entity=>this.app.session.storyWorld.actorAppearance(entity.actor));
    if(projected.some(entity=>entity.spring)&&this.springCatalog)projectedActors.push(this.springCatalog.empty);
    const needed=[...new Set(projectedActors)].filter(id=>!this.projectedActorIds.has(id));
    if(needed.length){
      const lease=await this.loadAssets(needed.flatMap(id=>{
        const actor=this.app.world.actors[id];if(!actor)throw new Error(`剧情角色资源缺失：${id}`);return characterAssets(actor,characterSceneClips(actor));
      }),this.map.name,false,true);
      if(signal.aborted||this.destroyed){lease.release();signal.throwIfAborted();throw new Error('正式地图已经关闭');}
      this.storyEntityAssets.push(lease);for(const id of needed)this.projectedActorIds.add(id);
    }
    const projectedIds=new Set(projected.map(entity=>entity.id));
    for(const character of [...this.characters])if(!projectedIds.has(character.entity.id)){
      this.movement.remove(character);this.removeQuestMarker(character);character.container.destroy();this.characters.splice(this.characters.indexOf(character),1);
    }
    for(const entity of projected){
      const old=this.characters.find(character=>character.entity.id===entity.id);
      if(old&&old.actor.id!==this.app.session.storyWorld.actorAppearance(entity.actor)){this.movement.remove(old);this.removeQuestMarker(old);old.container.destroy();this.characters.splice(this.characters.indexOf(old),1);}
      const character=this.characters.find(character=>character.entity.id===entity.id)??this.createActor(entity);
      if(!this.characters.includes(character))this.characters.push(character);
      character.entity={...entity};
      const facing=this.app.session.storyWorld.entity(entity.id)?.facing;if(facing)this.setClip(character,`idle-${facing}`);
    }
    this.charactersRevision=(this.charactersRevision??0)+1;
    // 投影可能按 entity.actor 重建角色；喝空的泉水要重新落回水井外观。
    this.restoreDrainedSprings();
    const positions=this.characters.map(character=>({visual:character,position:{x:character.entity.x,y:character.entity.y},enabled:this.app.session.visible(character.entity)}));
    const playerLocation=restoredLocation??(location&&signature!==this.lastProjectedLocation?location:undefined);
    if(playerLocation)positions.push({visual:this.player,position:playerLocation,enabled:true});
    // 剧情实体的位置来自内容，压住主角或其他人时就近让位，不让整组落位失败。
    this.movement.placeAll(positions,{evictOccupied:true,displaceable:[this.player]});
    if(playerLocation){this.facing=playerLocation.facing;this.setClip(this.player,`idle-${this.facing}`);this.lastProjectedLocation=signature;}
    this.entities=projected;
    await this.combat?.projectStoryEnemies(signal);
    this.app.director.onSkipProgress?.('assets-ready');
    await this.projectEquipment(signal);
    this.app.director.onSkipProgress?.('outfit-ready');
    signal.throwIfAborted();
    // 新队员生成与换装（碰撞盒可能刷新）之后再收拢队伍；回滚路径由 restoreState 逐名恢复。
    if(playerLocation){if(!restoredLocation)this.combat?.regroupPartyAroundHero();this.syncControlledCharacter(true);}
    if(stage?.scene.map===this.map.id)this.combat?.adoptStoryPositions(stage.scene.actors);
    this.rebuildTriggerIndex();
    this.refreshState();this.syncHud();
  }
  async preparePlayerAppearance(signal:AbortSignal=this.request.signal):Promise<void>{
    const session=this.app.session,character=session.character;
    if(!character||!this.wardrobe||!this.player)return;
    const revision=session.bag.revision,skills=session.skills.version,reset=session.skills.resetVersion,request=++this.outfitRequest;
    const outfit=await this.wardrobe.prepare(character.appearance,session.bag.equipmentItems(),character.classId,
      {learnedSkills:learnedSkillIds(this.app.battleCatalog,character.classId,session.skills),signal});
    signal.throwIfAborted();
    if(this.destroyed||this.app.session!==session||request!==this.outfitRequest||revision!==session.bag.revision||skills!==session.skills.version||reset!==session.skills.resetVersion)throw new Error('人物状态已改变');
    this.wardrobe.activate(outfit);this.equippedActor=outfit.actor;
    if(this.player.actor!==outfit.actor){this.player.actor=outfit.actor;this.setClip(this.player,`idle-${this.facing}`);this.movement?.refreshShape(this.player);this.combat?.updateEquipment();}
  }
  private async projectEquipment(signal:AbortSignal):Promise<void>{
    if(!this.wardrobe||!this.player)return;
    const session=this.app.session,character=session.character;if(!character)return;
    const equipment=session.bag.equipmentItems(),signature=JSON.stringify(equipment);
    if(signature!==this.projectedPlayerEquipment){
      const request=++this.outfitRequest;
      const outfit=await this.wardrobe.prepare(character.appearance,equipment,character.classId,{learnedSkills:learnedSkillIds(this.app.battleCatalog,character.classId,session.skills),signal});
      signal.throwIfAborted();
      if(this.destroyed||request!==this.outfitRequest||signature!==JSON.stringify(session.bag.equipmentItems()))throw new Error('剧情装备状态已改变');
      this.wardrobe.activate(outfit);this.equippedActor=outfit.actor;
      this.player.actor=outfit.actor;this.setClip(this.player,`idle-${this.facing}`);this.movement?.refreshShape(this.player);
      this.combat?.updateEquipment();this.projectedPlayerEquipment=signature;
    }
    for(const id of session.party?.activeIds??[])if(id!=='player')await this.preparePartyMember(id,signal,{full:true});
    signal.throwIfAborted();this.syncControlledCharacter();
  }
  private exitAvailable(exit:MapExit):boolean{
    const map=this.map;if(!map||!this.app.session.storyWorld.exitEnabled(map.id,exit))return false;
    const rule=this.app.campaign.exitRules?.find(rule=>rule.map===map.id&&rule.id===storyExitId(map.id,exit));
    return !rule||this.app.session.evaluateCondition(rule.condition);
  }
  private storyWorldContext():Record<string,string|boolean|number>{
    const values:Record<string,string|boolean|number>={map:this.map?.id??'', 'near-actor':this.near?.entity.actor??'', 'near-entity':this.near?.entity.id??'',interaction:this.near?.entity.objective??''};
    const player=this.combat?.controlledVisual??this.player;
    if(player){values['player-x']=player.container.x;values['player-y']=player.container.y;}
    for(const event of this.app.campaign.events)if(event.source==='region')values[`region:${event.id}`]=!!player&&event.map===this.map?.id&&!!event.region&&overlapsFootRect(player.container,event.region);
    return values;
  }
  /**
   * 全队阵亡只暂停当前战斗，不结算剧情遭遇。
   *
   * 返回检查点或读取存档会整份回滚。
   * 两条路都不需要把遭遇判成 `lost`；真正打赢时再由 `completedStoryEncounters` 上报 `won`。
   */
  handleCombatDefeat():void{
    this.showCombatDefeat();
  }
  private showCombatDefeat():void{
    this.app.ui.showDefeat({
      load:()=>this.app.openDefeatLoad?.()??false,
      restore:async()=>{
        const checkpoint=this.app.checkpoint.peek();if(!checkpoint)throw new Error('没有可恢复的检查点');
        if(!hasLivingParty(checkpoint.session))throw new Error('检查点里没有可战斗的队员');
        const signal=this.app.storySignal??this.request.signal;
        signal.throwIfAborted();this.resetInput();this.app.director.cancel();
        const world=checkpoint.world.world?{...checkpoint.world,world:prepareCombatRestore(checkpoint.world.world,this.app.battleCatalog,checkpoint.session.party?.slots.filter((id):id is string=>!!id)??[])}:checkpoint.world;
        this.app.session.restoreState(checkpoint.session);
        await this.restoreStoryWorld(world,signal);
        signal.throwIfAborted();this.app.ui.closeDefeat();this.playStory(()=>this.app.director.retry());
      }
    });
  }
  syncHud(): void {
    const enabled = this.canControl;
    const backgroundVisible=enabled||(this.sys.isActive()&&!this.loadingWorld&&this.app.ui.ready&&this.app.ui.controlLayoutEditing&&!this.app.suspended);
    // 可见性每帧都写：切图会重建摇杆、控件和小地图，新对象默认可见；
    // 如果把它塞进下面的状态摘要，摘要没变就会漏掉这次收起（开场独白时摇杆就是这么露出来的）。
    // 摇杆只由 enabled 控制输入，电脑模式的外观隐藏在 MoveStick 内部处理。
    this.stick?.setVisible(enabled);
    const keyboardMode = controlSettings.mode === 'keyboard';
    this.controls?.setVisible(enabled && !keyboardMode);
    this.skillHud?.setVisible(enabled && keyboardMode);
    this.minimap?.setVisible(backgroundVisible);
    this.statusHud?.setVisible(backgroundVisible);
    this.overheadStatus?.setVisible(backgroundVisible);
    this.app.domUi?.setLayerVisible('hud', backgroundVisible);
    this.app.domUi?.setLayerVisible('world', backgroundVisible && !this.performing && !this.stageOccluded);
    const target = this.near?.container.visible ? this.near : null;
    // 敌人数值只在逻辑帧里变化；同一战斗帧的多个渲染帧复用同一份目标状态。
    const tick=this.app.session?.combatTick,actorId=target?.entity.id??'';
    let targetStatus:ReturnType<WorldCombat['targetStatus']>,hostile:boolean;
    if(tick===undefined){
      // 菜单启动阶段还没有会话：直接取当前战斗状态，不做按帧缓存。
      targetStatus=this.combat?.targetStatus?.();hostile=!!this.combat?.hasHostileTarget?.();
    }else{
      let targetCache=this.targetStatusCache;
      if(!targetCache||targetCache.tick!==tick||targetCache.actor!==actorId){
        targetCache={tick,actor:actorId,status:this.combat?.targetStatus?.(),hostile:!!this.combat?.hasHostileTarget?.()};
        this.targetStatusCache=targetCache;
      }
      targetStatus=targetCache.status;hostile=targetCache.hostile;
    }
    // 名称条同样每帧同步：新对象默认隐藏，等摘要变化才显示会把换图后的提示吞掉。
    this.nameBanner?.sync(backgroundVisible, target ? target.entity.name || target.actor.name : null);
    // 方法同时承担「状态变化后立即同步」和「逐帧兜底」两种调用；决定文字与按钮的状态
    // 归一成摘要，摘要在变才写这些较贵的对象，逐帧调用就只剩几次只读检查。
    const signature=`${enabled}|${this.performing}|${target?.entity.id??''}|${hostile}|${targetStatus?`${targetStatus.id}|${targetStatus.name}|${targetStatus.level}|${targetStatus.health}/${targetStatus.maxHealth}|${targetStatus.sceneLevel}`:''}`;
    if(signature===this.hudSignature)return;
    this.hudSignature=signature;
    for (const tween of this.chestFades.values()) {
      if (enabled && !this.performing) tween.resume(); else tween.pause();
    }
    this.controls?.setAttack(enabled && (!!target||hostile), false);
    this.statusHud?.setTarget(targetStatus);
  }
  /**
   * 一个对象能不能被选中交互：有功能（商店、宝箱、泉水、玩法服务），或者有话可说
   * （描述、闲话、摆放点声明的目标、任务发布者，以及某条进行中任务指着它）。
   * 返回值兼作同坐标优先级：0 = 进行中任务的目标或待交付，1 = 头顶有任务标记，
   * 2 = 其它可交互对象。
   * 原版任务目标与交付人可能摆在同一点（quest-103/106 的 npc-76 与 npc-364），
   * 目标没记满前必须选得中目标，记满后才轮到交付人。
   */
  private interactionCandidate(character: Character): 0 | 1 | 2 | null {
    const actor=character.actor, entity=character.entity;
    const slot=this.app.session.npcQuestSlot(entity.actor,entity.characterId);
    // 0 表示这次交互会推进任务或交付；1 表示头顶有任务标记；2 表示普通可交互对象。
    // 距离仍然优先，只有同距离时才比较这一档，避免同格的普通 NPC 抢走任务 NPC。
    if(this.app.session.canInteract(entity.actor,entity.id,entity.characterId)
      ||(slot&&this.app.session.status(slot.id)==='ready'))return 0;
    if(this.app.session.markerActor(entity.actor,entity.characterId))return 1;
    if(actor.service||actor.chest||entity.spring||actor.description||entity.hint||entity.objective
      ||this.app.shops?.shops[entity.actor])return 2;
    return null;
  }
  /** 挑出「身边的可交互对象」：原版 `PLAYER_DoCheckNearNPC` 用曼哈顿距离 24 px，最近的一个胜出。 */
  private updateInteractionTarget(): void {
    const controlled=this.combat?.controlledVisual??this.player;
    if (!controlled) { this.near = null;this.lastInteractionScan=undefined;return; }
    const session=this.app.session;
    const x=controlled.container.x, y=controlled.container.y;
    const revision=this.interactionRevision??0;
    const quest=session.questBook?.version??0;
    const story=session.storyWorld?.revision??0;
    const chests=session.chests?.revision??0;
    const legendary=session.legendaryWeapons?.revision??0;
    const restore=session.restorationVersion??0;
    const performing=!!this.performing;
    const map=this.map?.id??'';
    const owner=this.combat?.controlledId??'player';
    const scan=this.lastInteractionScan??(this.lastInteractionScan={x:Number.NaN,y:Number.NaN,revision:-1,quest:-1,
      story:-1,chests:-1,legendary:-1,restore:-1,performing:false,map:'',owner:''});
    if(x===scan.x&&y===scan.y&&revision===scan.revision&&quest===scan.quest&&story===scan.story
      &&chests===scan.chests&&legendary===scan.legendary&&restore===scan.restore
      &&performing===scan.performing&&map===scan.map&&owner===scan.owner)return;
    scan.x=x;scan.y=y;scan.revision=revision;scan.quest=quest;scan.story=story;
    scan.chests=chests;scan.legendary=legendary;scan.restore=restore;
    scan.performing=performing;scan.map=map;scan.owner=owner;
    let nearest: Character | null = null, distance = Number.POSITIVE_INFINITY, rank = 3;
    for (const character of this.characters) {
      if (!character.container.visible) continue;
      if (this.chestOpened(character)) continue;
      if (this.legendarySwordConsumed(character)) continue;
      if (character.entity.spring && this.map && this.app.session.springs.isEmpty(this.map.id, character.entity.id)) continue;
      // 宝箱和古剑按原版「身边 24 px」选目标；机关按真实碰撞盒贴边兜底。商店和
      // 旅店能隔着柜台说话，普通剧情/NPC 只放宽到贴身一格，避免隔两三格选中净化石这类目标。
      const shop = !!this.app.shops?.shops[character.entity.actor], inn = character.actor.service === 'innkeeper', sword = character.actor.service === 'legendary-sword';
      if (!(character.actor.chest || sword
        ? nearInteractable(controlled.container, character.container)
        : nearInteractive(controlled.container, character.container, character.actor.collision, !!character.entity.flip, shop || inn ? SHOP_COUNTER_GAP : BODY_ADJACENT_GAP))) continue;
      const candidate = this.interactionCandidate(character);
      if (candidate === null) continue;
      const d = Math.abs(character.container.x - controlled.container.x) + Math.abs(character.container.y - controlled.container.y);
      if (d < distance || (d === distance && candidate < rank)) { distance = d; nearest = character; rank = candidate; }
    }
    this.near = nearest;
  }
  override update(_time:number,delta:number): void {
    // 舞台已经铺满画面时，正式世界这帧不跑战斗、HUD、掉落和移动；
    // 自愈检查保证舞台被关闭或重建后不会永远停在这里。
    this.app.domUi?.setLayerVisible('world', this.canControl && !this.performing && !this.stageOccluded);
    if (this.stageOccluded) {
      this.syncStageOcclusion();
      if (this.stageOccluded) return;
    }
    // 卡顿时最多补 2 个逻辑帧；补 3 帧会把 AI/寻路/状态的尖峰叠成三倍。
    const stepDelta=Math.min(delta,MAX_FRAME_DELTA_MS);
    this.updateFps();
    if (!this.canControl) this.syncHud();
    if (!this.player || !this.movement) return;
    const controlled=this.combat?.controlledVisual??this.player;
    this.pickupMessages?.setPaused(!this.canCombatControl);
    this.combat?.setPerformanceActive(this.performing);
    if(this.checkpointPending&&this.canControl&&!this.performing&&!this.app.director.busy&&this.combat?.canCheckpoint)this.captureCheckpoint();
    this.combat?.update(stepDelta,this.canCombatControl);
    if(this.canCombatControl&&!this.app.director.busy)for(const encounter of this.combat?.completedStoryEncounters??[]){
      if(this.encounterResults.has(encounter.id))continue;
      this.encounterResults.add(encounter.id);
      this.playStory(()=>this.app.director.encounterResult(encounter.id,'won',`result:${encounter.id}:won`));break;
    }
    this.statusHud?.update(this.app.session.combatTick);
    this.groundLootView?.setPaused(!this.canCombatControl);
    if(this.canCombatControl&&this.map){const store=groundLootFor(this.app.session);store.advance(this.map.id,stepDelta);
      if(store.revision!==this.groundLootRevision){this.groundLootRevision=store.revision;this.groundLootView?.sync(store.dropsOnMap(this.map.id));}}
    this.refreshShortcutPageIfTickChanged();
    if (!this.canControl) { if (!this.performing) this.movement.stop(controlled); return; }
    if(this.combat?.playerCannotMove()){this.movement.stop(controlled);return;}
    // 原版 GAMESTATE_PressKeyPlay：CHAR_IsSkillOn 时整段跳过方向输入。
    if(this.combat?.castingSkill)return;
    const axis = this.stick?.axis ?? { x: 0, y: 0 };
    const length = Math.hypot(axis.x, axis.y);
    // 进图时如果方向还按着，先停住，等松手回中一次再接受移动。
    if (this.entryInputGate) {
      if (length === 0) this.entryInputGate = false;
      else { this.movement.stop(controlled); return; }
    }
    // 原版按方向键移动会清当前目标（CHAR_SetTarget(ch,0)）：面板随之隐藏，普攻改在范围内重新选敌。
    if(length>0){this.combat?.cancelAttack();this.combat?.clearTarget();this.combat?.cancelAmbushOnDirection();this.autoAttack.release();}
    if(this.combat?.attackState!=='idle')return;
    // 开始攻击之后站定自动接下一击；摇杆一动（已清目标）或目标消失就停。
    if(length===0&&this.autoAttack.next({targetId:this.combat?.targetId,attackState:this.combat?.attackState??'idle'}))this.combat?.attack();
    // 摇杆已处理死区。非零方向使用固定速度，推杆幅度不影响速度。
    this.movement.drive(controlled, axis, this.combat?.movementSpeedForPlayer()??PLAYER_MOVE_SPEED);
    if (length > 0 && this.combat)this.combat.facing = Math.abs(axis.x) > Math.abs(axis.y) ? axis.x < 0 ? 'west' : 'east' : axis.y < 0 ? 'north' : 'south';
  }
  private afterMovement(): void {
    this.updateQuestMarkerPositions();
    if (!this.player || !this.movement) return;
    const controlled=this.combat?.controlledVisual??this.player;
    const pos = this.movement.position(controlled), previous = this.lastPlayerPosition ?? pos;
    const moving = Math.hypot(pos.x - previous.x, pos.y - previous.y) > .01;
    this.lastPlayerPosition = pos;
    if (!this.canControl || this.performing) return;
    this.minimap?.updatePlayer(pos);
    const body = this.movement.body(controlled);
    const walking = isBodyWalking(body);
    if(!this.combat?.playerCannotAct()&&this.combat?.attackState!=='attacking')setCharacterClip(this,controlled, `${walking ? 'walk' : 'idle'}-${this.combat?.facing??this.facing}`);
    this.combat?.afterMovement();
    if (this.minimap && this.combat && this.time.now >= this.nextMinimapEnemyUpdate) {
      this.nextMinimapEnemyUpdate = this.time.now + MINIMAP_ENEMY_REFRESH_MS;
      this.minimap.updateEnemies(this.combat.specialEnemyMarkers());
    }
    this.collectGroundLoot(pos);
    this.updateInteractionTarget(); this.syncHud();
    const triggerIndex=this.triggerIndex;
    for (const event of triggerIndex?.regionEvents ?? this.app.campaign.events)if(event.source==='region'&&event.map===this.map?.id&&event.region){
      const inside=overlapsFootRect(pos,event.region);
      if(!inside){this.occupiedRegions.delete(event.id);continue;}
      if(this.occupiedRegions.has(event.id)||(event.condition&&!this.app.session.evaluateCondition(event.condition)))continue;
      this.occupiedRegions.add(event.id);
      this.playStory(()=>this.app.director.enterRegion(event.id,event.map!).then(played=>{
        // 没播成、且事件还没结束（导演这一刻不收、或运行时不认这次触发）就放下这块占用，
        // 让还站在区域里的玩家下一帧能再试一次。已经播完的事件保持占用，不再反复触发。
        if(!played&&!this.app.director.runtime.snapshot().completedEvents.includes(event.id))this.occupiedRegions.delete(event.id);
        return played;
      }));return;
    }
    // 近身触发（原版 `near_npc_field`）：走到那个角色旁边就起演。相邻判定与原版
    // `PLAYER_DoCheckNearNPC` 同口径（曼哈顿 24 px，见 findings 94），占用表与区域触发共用，
    // 避免同一段戏每帧重复上报。
    const nearEvents = triggerIndex?.nearEvents
      ?? this.app.campaign.events.filter(event => event.source === 'near' && event.near && (!event.map || event.map === this.map?.id));
    const near = claimNearTrigger(
      nearEvents,
      this.occupiedRegions,
      event => {
        const candidates = event.near ? triggerIndex?.charactersByActor.get(event.near) : undefined;
        return (candidates ?? this.characters).find(character => character.entity.actor === event.near
          && (!event.nearCharacterId || character.entity.characterId === event.nearCharacterId)
          && character.container.visible
          && nearInteractive(pos, character.container, character.actor.collision, !!character.entity.flip)) ?? null;
      },
      event => !event.condition || this.app.session.evaluateCondition(event.condition));
    if (near) {
      const { event, beside } = near;
      this.playStory(() => this.app.director.approach(event.near!, this.map?.id, beside.entity.characterId).then(played => {
        if (!played && !this.app.director.runtime.snapshot().completedEvents.includes(event.id)) this.occupiedRegions.delete(event.id);
        return played;
      }));
      return;
    }
    const exit = this.exitTrigger?.update(pos, moving,exit=>this.exitAvailable(exit));
    if (exit&&this.exitAvailable(exit)) { this.changeMap(exit); return; }
    if (moving) this.prefetchVisibleExit(pos, previous);
  }
}

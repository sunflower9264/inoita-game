import {CombatClock,type CombatClockState} from './combat-clock.ts';
import {CombatCooldownStore,type CombatCooldownState} from './combat-cooldowns.ts';
import {FrenzyAnimationMemory} from './frenzy-animation.ts';
import { RecoveryItems, type RecoveryItemsState } from './recovery-items.ts';
import { CombatResourceRecovery, type CombatResourceRecoveryState, type ResourceRecoveryActor, type ResourceRecoveryPulse } from './combat-resources.ts';
import { ShopVisits, type ShopVisitsState } from './shop.ts';
import { ChestVisits, type ChestVisitsState } from './chests.ts';
import { SpringVisits, type SpringVisitsState } from './springs.ts';
import { LegendaryWeapons, type LegendaryWeaponsState } from './legendary-weapon.ts';
import { groundLootFor, GroundLootStore, type GroundLootState } from './ground-loot.ts';
import { QuestItemGenerators, type QuestItemGenerationState } from './quest-item-spawns.ts';
import { boundedHealth } from './status-hud.ts';
import { StorySkillProgression } from './story-skills.ts';
import { Bag, verifyBagState, type BagState } from './bag.ts';
import type { SkillConfigurationState } from './skill-configuration.ts';
import type { ItemCatalog } from './items.ts';
import type { QuestDropRequirement, ReservedDropState } from './drops.ts';
import type { ActorDefinition, CampaignEnemyPlacement, EnemySpawn, MapExit, QuestItemSpawn, QuestRewardReceipt, QuestStatus, TravelDestination, VisibilityRules, WorldMap } from './content.ts';
/** 落位修正需要的边界信息；调用方持有完整地图时直接传地图对象。 */
export type MapBoundary=Pick<WorldMap,'width'|'height'> & {exits?:readonly MapExit[]};
import type { Campaign, CampaignQuest } from './campaign.ts';
import { QuestBook, sideQuestIds, type QuestBookCheckpoint, type QuestBookState, type QuestCommand, type QuestGoal, type QuestProgress, type QuestFact, type QuestSettlement } from './quest-book.ts';
import { evaluateStoryCondition, storyConditionReferences, type StoryCondition, type StoryConditionContext, type StoryWorldValue } from './story-condition.ts';
import { StoryWorldState, type StoryWorldSnapshot } from './story-world.ts';
import { encounterSpawnId } from './world-enemies.ts';
import type { StoryCommand } from './story-graph.ts';
import { StoryRuntime, type StoryRuntimeSnapshot } from './story-runtime.ts';
import { toPlaybackCheckpoint } from './playback-checkpoint.ts';
import type { StoryPlayerState } from './story-interface.ts';
import { LOGIC_FRAME_MS, type BattleCatalog } from './battle.ts';
import { BattleCharacter, type BattleCharacterState, type CharacterStatsCatalog } from './character-stats.ts';
import { PartyRoster, type CompanionCatalog } from './party.ts';
import { LootPity, type LootPityState } from './loot-pity.ts';

interface EnemyState { health?:number; mana?:number; deadUntil?:number|'permanent'; capture?:{map:string;visit:number} }
export const DEFAULT_ENEMY_RESPAWN_MS = 60_000;

type SessionListener = (session: Session) => void;
type SnapshotSlot = 'questBook'|'storyWorld'|'bag'|'enemies'|'receipts'|'chests'|'groundLoot';

/** Data owned by a story session; render objects and subscriptions stay outside checkpoints. */
export interface SessionState {
  classId?:string;
  questBook:QuestBookState;
  storyWorld:StoryWorldSnapshot;
  runtime:StoryRuntimeSnapshot;
  receipts:QuestSettlement[];
  factSequences:[string,number][];
  trackedQuest?:string;
  /** GM 任务调试的焦点：任务日志只显示这一条；不写进玩家存档。 */
  debugFocusQuest?:string;
  player?:StoryPlayerState;
  money:number;
  gameTimeMs:number;
  enemies:[string,EnemyState][];
  bag:BagState;
  hero?:BattleCharacterState;
  skills:SkillConfigurationState;
  party?:ReturnType<PartyRoster['captureState']>;
  recovery:RecoveryItemsState;
  resourceRecovery:CombatResourceRecoveryState;
  combatClock?:CombatClockState;
  cooldowns?:CombatCooldownState;
  frenzyAnimations?:[string,number][];
  chests:ChestVisitsState;
  springs:SpringVisitsState;
  legendaryWeapons?:LegendaryWeaponsState;
  shops:ShopVisitsState;
  groundLoot:GroundLootState;
  questItemGeneration:QuestItemGenerationState;
  /** 温和保底的连续未命中计数与 Boss 首杀记录。 */
  lootPity?:LootPityState;
  /** 付费道具独立掉落的解锁保底与一次性领取记录。 */
  reservedDrops?:ReservedDropState;
  /** 队伍物品掉率乘数（千分比）；当前内容没有已验证来源，默认 0。 */
  partyItemChance?:number;
}

/** 剧情命令会改到的会话子系统；批次开始时只抓这些的旧值。 */
type StorySubsystem = 'bag'|'hero'|'skills'|'party'|'lootPity'|'storyWorld'|'enemies'|'groundLoot'
  |'questBook'|'coins'|'receipts'|'playerState'|'runtimeSnapshot';
/** 一次剧情命令提交的回执：`StoryDirector` 在分支求值失败时用它恢复到提交前。 */
export interface StoryCommitReceipt {
  /** 丢掉旧值；普通调用方在返回前已经调用。 */
  finalize(): void;
  /** 恢复这次碰到的子系统；已 finalize 后为空操作。 */
  rollback(): void;
}
interface StoryCommandBaseline {
  bag?:BagState;
  hero?:BattleCharacterState;
  skills?:SkillConfigurationState;
  party?:ReturnType<PartyRoster['captureState']>;
  quests?:{checkpoint:QuestBookCheckpoint;factSequences:[string,number][]};
  world?:StoryWorldSnapshot;
  /** 完成遭遇被历史上限裁掉时，同一批次会删除它的一次性敌人状态；回滚必须一起恢复。 */
  enemies?:[string,EnemyState][];
  /** 选择标识的写入次数；和世界快照一起回滚，避免取消演出后留下假的“又选了一次”。 */
  choiceWrites?:[string,number][];
  loot?:GroundLootState;
  coins?:number;
  /** 任务 id → 捕获时的最新一张收据。 */
  receipts?:[string,QuestSettlement][];
  lootPity?:LootPityState;
  playerState?:Readonly<StoryPlayerState>;
  runtime?:StoryRuntimeSnapshot;
  shops?:ShopVisitsState;
}
/** `atomic` 能回滚的子系统：剧情命令会碰到的全集，再加上商店货架。 */
type AtomicSubsystem = StorySubsystem | 'shops';
interface AtomicFrame { touched:Set<AtomicSubsystem>; baseline:StoryCommandBaseline }
/** 命令静态会碰到的子系统；比运行时实际改动多抓是安全的，少抓会漏回滚。 */
function storyCommandSubsystems(command:StoryCommand):readonly StorySubsystem[]{
  switch(command.type){
    case 'interaction':case 'talk':return ['questBook'];
    case 'quest':{
      switch(command.command.type){
        case 'fact':case 'pin-active':case 'unpin-active':case 'refresh':case 'reset':case 'script-ready':
          return ['questBook'];
        case 'accept':return ['questBook','bag'];
        case 'complete':case 'script-complete':return ['questBook','bag','hero','skills','coins','receipts'];
        case 'reset-side-quests':return ['questBook','bag'];
      }
      return ['questBook'];
    }
    case 'item-give':case 'item-take':return ['bag'];
    case 'money-give':case 'money-take':return ['coins'];
    case 'item-drop':return ['groundLoot'];
    case 'flag':case 'choice':case 'travel':case 'encounter':return ['storyWorld'];
    case 'world':return command.command.kind==='encounter-result'?['storyWorld','enemies']:['storyWorld'];
    case 'party-join':case 'party-leave':return ['party','bag','lootPity'];
    case 'party-control':return ['party'];
    case 'health':case 'mana':return ['hero','party','playerState'];
    case 'equip':case 'unequip-destroy':return ['bag'];
  }
}

/** 本次运行的故事状态。这个模块不依赖 Phaser，也不认识源格式。 */
export class Session {
  readonly chests = new ChestVisits();
  readonly springs = new SpringVisits();
  readonly legendaryWeapons = new LegendaryWeapons();
  readonly shops = new ShopVisits();
  readonly questItemGenerators = new QuestItemGenerators();
  /** 掉落保底：按成员记录连续未出装备/稀有，命中后清零。 */
  readonly lootPity = new LootPity();
  /** 付费道具的解锁保底计数与已经获得的一次性道具。 */
  reservedDropMisses = 0;
  readonly claimedReservedDrops = new Set<string>();
  partyItemChance = 0;
  enterMap(map: string, questItemSpawns?:readonly QuestItemSpawn[], boundary?:MapBoundary,
    mapSpawns?:readonly EnemySpawn[]): void {
    const entering=this.chests.mapId!==map;
    // 进入另一张地图视为一次新访问：普通地图怪恢复满血，和原版地图刷新一致。
    // 永久死亡、任务捕捉、宝箱/遭遇怪不在这份名单里，仍按各自规则保留。
    if(entering&&mapSpawns)this.resetMapEnemies(mapSpawns);
    for(const [id,enemy] of this.enemyStates)if(enemy.capture&&
      (enemy.capture.map!==map||enemy.capture.visit!==this.storyWorld.visit))this.deleteEnemyState(id);
    if (this.chests.mapId !== map) {
      for (const spawn of this.chests.spawns) this.deleteEnemyState(spawn.id);
      if (this.chests.mapId !== undefined) {
        for (const [id, enemy] of this.enemyStates) if (enemy.deadUntil !== 'permanent') this.deleteEnemyState(id);
      }
    }
    this.chests.enterMap(map);
    this.springs.enterMap(map);
    this.shops.enterMap(map);
    // 普通地面掉落不跨图：换图后别的地图只留任务/剧情物品，任务物品仍由生成点和剧情命令管理。
    if(entering)groundLootFor(this).clearOtherMaps(map,
      drop=>drop.reward.kind==='item'&&this.bag.catalog.items[drop.reward.item]?.category==='quest');
    if(entering)for(const {condition,...entity} of this.campaign.mapEntryPlacements??[]){
      if(entity.map===map&&this.evaluateCondition(condition))this.storyWorld.apply({kind:'place',scope:'visit',entity:{...entity,visible:true}});
    }
    if(questItemSpawns)this.questItemGenerators.enter(map,this.storyWorld.visit,questItemSpawns,groundLootFor(this));
    if(boundary)this.reviseOutOfBoundsLocation(map,boundary);
  }
  /** 新访问重置普通地图怪；永久死亡、任务捕捉和一次性生成点保持不变。 */
  private resetMapEnemies(spawns:readonly EnemySpawn[]):void{
    for(const spawn of spawns){
      if(spawn.respawn===false)continue;
      const state=this.enemyStates.get(spawn.id);
      if(!state||state.deadUntil==='permanent'||state.capture)continue;
      this.deleteEnemyState(spawn.id);
    }
  }
  /** 越界坐标落到出口格或地图中心：原版 SAVE_ReviseCharacterLocation 的判据与兜底（findings 175）。 */
  private reviseOutOfBoundsLocation(map:string,boundary:MapBoundary): void {
    const location=this.storyWorld.currentLocation;
    if(!location||location.map!==map)return;
    if(location.x>=1&&location.y>=1&&location.x<boundary.width&&location.y<boundary.height)return;
    // 原版随机取一条出口记录；这里固定取第一条，保证验收可复现（偏离记在 findings 175）。
    const exit=(boundary.exits??[])[0];
    // 出口记录给的是格子左上角，角色的脚点应落在格子中心（tileSize 16 的一半）。
    const exitTileCenterOffsetPx=8;
    const fixed=exit?{x:exit.x+exitTileCenterOffsetPx,y:exit.y+exitTileCenterOffsetPx}
      :{x:Math.floor(boundary.width/2),y:Math.floor(boundary.height/2)};
    this.storyWorld.apply({kind:'travel',destination:{...location,...fixed}});
  }
  readonly recovery = new RecoveryItems();
  private readonly resourceRecovery = new CombatResourceRecovery();
  private readonly combatClock = new CombatClock();
  readonly cooldowns = new CombatCooldownStore(()=>this.combatClock.currentFrame);
  /** GM 调试开关：这些角色免疫战斗伤害。刻意不进 `captureState`，所以不写存档、也不随剧情标记回退。 */
  private readonly invincible = new Set<string>();
  setInvincible(actorId:string,enabled:boolean):void {
    if(enabled)this.invincible.add(actorId);else this.invincible.delete(actorId);
  }
  isInvincible(actorId:string):boolean { return this.invincible.has(actorId); }
  /** GM 调试开关：这些角色命中敌人时直接击杀。和无敌一样不写存档、不随剧情回退。 */
  private readonly oneHitKill = new Set<string>();
  setOneHitKill(actorId:string,enabled:boolean):void {
    if(enabled)this.oneHitKill.add(actorId);else this.oneHitKill.delete(actorId);
  }
  isOneHitKill(actorId:string):boolean { return this.oneHitKill.has(actorId); }
  readonly frenzyAnimations = new FrenzyAnimationMemory();
  readonly skills: StorySkillProgression;
  /** 战斗目录只读访问：GM 拉满佣兵技能需要职业技能表与伙伴成长表的最高等级。 */
  get battleCatalog():BattleCatalog|undefined {return this.battle;}
  readonly campaign: Campaign;
  readonly questBook:QuestBook;
  readonly storyWorld = new StoryWorldState();
  private runtimeSnapshot:StoryRuntimeSnapshot = {version:2,sequence:0,runs:[],completedEvents:[],handledOccurrences:[],encounterResults:[],pendingOccurrences:[],occurrenceSequences:[]};
  private runtimeValidator?:StoryRuntime;
  /** 任务 id → 最新一张奖励收据；可重复任务跨周期只保留当前轮。 */
  private readonly receipts = new Map<string,QuestSettlement>();
  private readonly factSequences = new Map<string,number>();
  /**
   * 每个选择标识被写入的次数，值相同也加一。剧情选择事件靠它判断“玩家又选了一次”，
   * 不能只看选择值有没有变化，否则重复选同一个选项会被当成没发生。
   */
  private readonly choiceWrites = new Map<string,number>();
  private choiceWriteRevisionValue = 0;
  private receiptRevisionValue = 0;
  private enemyRevisionValue = 0;
  private enemySpawnRevisionValue = 0;
  /**
   * 选择写入次数的修订号：`choiceWrites` 每次写入和在恢复/回滚中重建时推进。
   * 只用于让按次数增量观察的缓存失效，不写存档。
   */
  get choiceWriteRevision():number { return this.choiceWriteRevisionValue; }
  /**
   * 任务奖励收据的修订号：可重复任务写入收据、以及恢复/回滚时重建收据表都会推进。
   * 只用于让存档快照缓存失效，不写存档。
   */
  get receiptRevision():number { return this.receiptRevisionValue; }
  /**
   * 敌人状态的修订号：`enemyStates` 每次 set/delete 和恢复时重建都会推进。
   * 只用于让存档快照缓存失效，不写存档。
   */
  get enemyRevision():number { return this.enemyRevisionValue; }
  /** 仅生成资格变化时递增，受伤和回蓝不使地图生成名单失效。 */
  get enemySpawnRevision():number { return this.enemySpawnRevisionValue; }
  private worldContext:()=>Record<string,StoryWorldValue> = ()=>({});
  /** 任务可用性读的条件输入；带条件键，刷新时只找引用变化键的任务。 */
  private readonly questConditionInputs:{key:string;read:(context:StoryConditionContext)=>StoryWorldValue|undefined}[]=[];
  private questProjection?:{questVersion:number;bagVersion:number;owner:string;conditions:(StoryWorldValue|undefined)[]};
  /** `quests` 投影的缓存；只用任务簿版本做键，因为 `commit` 在没有真实变化时不推进版本。 */
  private questsProjection?:{questVersion:number;value:ReadonlyMap<string,Readonly<QuestProgress&{count:number}>>};
  private readonly battle?:BattleCatalog;
  private readonly stats?:CharacterStatsCatalog;
  private readonly companions?:CompanionCatalog;
  private readonly listeners: Set<SessionListener>;
  readonly bag: Bag;
  readonly hero?: BattleCharacter;
  readonly party?: PartyRoster;
  private gameTimeMs = 0;
  private restoreRevision = 0;
  /**
   * 存档快照的子系统缓存：版本没变时复用上一次的深拷贝，避免每次自动存档都把
   * 随进度变大的背包、世界、敌人和收据整份重克隆。读档/回滚时整体清空。
   */
  private snapshotCache:Partial<Record<SnapshotSlot,{version:number;value:unknown}>>={};
  private notificationBatchDepth = 0;
  private pendingNotification = false;
  /** 正在执行的 `atomic`；只有最外层持有自己的帧，嵌套调用把触碰面并进来。 */
  private readonly atomicFrames:AtomicFrame[] = [];
  /** 演出期间的按子系统懒回滚日志：第一次碰到某个子系统时才抓旧值。 */
  private performanceLogging = false;
  /** 正在执行导演自己的延迟提交：这些改动由命令回执负责，不进演出日志。 */
  private storyCommandDepth = 0;
  private performanceTouched = new Set<StorySubsystem>();
  private performanceBaseline:StoryCommandBaseline = {};
  get restorationVersion():number { return this.restoreRevision; }
  /** 演出开始：打开懒日志，不抓任何状态。 */
  beginPerformanceLog():void {
    this.performanceLogging=true;this.performanceTouched.clear();this.performanceBaseline={};
  }
  /** 演出正常提交：丢掉旧值。 */
  commitPerformanceLog():void {
    this.performanceLogging=false;this.performanceTouched.clear();this.performanceBaseline={};
  }
  /** 取消演出：只恢复演出期间第一次碰到的子系统。 */
  rollbackPerformanceLog():void {
    if(!this.performanceLogging)return;
    const touched=this.performanceTouched,baseline=this.performanceBaseline;
    this.performanceLogging=false;this.performanceTouched=new Set();this.performanceBaseline={};
    if(!touched.size)return;
    this.restoreStoryCommandBaseline(touched,baseline);
    this.emit();
  }
  /** 第一次碰到某个子系统时记下旧值；导演自己的延迟提交由命令回执负责，不重复记录。 */
  private recordPerformance(subsystems:Iterable<StorySubsystem>):void {
    if(!this.performanceLogging||this.storyCommandDepth>0)return;
    const fresh=new Set<StorySubsystem>();
    for(const subsystem of subsystems)if(!this.performanceTouched.has(subsystem)){this.performanceTouched.add(subsystem);fresh.add(subsystem);}
    if(fresh.size)Object.assign(this.performanceBaseline,this.captureStoryCommandBaseline(fresh));
  }
  private coins = 0;
  get money():number { return this.coins; }
  gainMoney(amount:number):void {
    if(!Number.isSafeInteger(amount)||amount<0||!Number.isSafeInteger(this.coins+amount))throw new Error('金币数量无效');
    this.recordPerformance(['coins']);this.coins+=amount;this.emit();
  }
  spendMoney(amount:number):void {
    if(!Number.isSafeInteger(amount)||amount<0||amount>this.coins)throw new Error('金币不足');
    this.recordPerformance(['coins']);this.coins-=amount;this.emit();
  }
  private readonly enemyStates = new Map<string, EnemyState>();
  private setEnemyState(id:string,state:EnemyState):void {
    if(this.enemyStates.get(id)?.deadUntil!==state.deadUntil)this.enemySpawnRevisionValue++;
    // 存档快照按 `enemyRevision` 复用；每次 set 都视为一次新写入。
    this.enemyStates.set(id,state);this.enemyRevisionValue++;
  }
  private deleteEnemyState(id:string):void {
    if(this.enemyStates.get(id)?.deadUntil!==undefined)this.enemySpawnRevisionValue++;
    if(this.enemyStates.delete(id))this.enemyRevisionValue++;
  }
  private trackedQuest?: string;
  private debugFocusQuestValue?: string;
  /** 任务组的主线／支线归属；NPC 任务槽按原版先主线后支线的顺序取。 */
  private readonly questGroupKinds: ReadonlyMap<string, 'main' | 'side'>;
  private questSlotProjection?: { version: number; focus?: string; values: Map<string, CampaignQuest | undefined> };
  /** 角色头顶的任务标记按任务簿版本缓存；版本不变时交互候选不必重扫全部任务。 */
  private markerActorProjection?: { version: number; focus?: string; values: Map<string, boolean> };
  /** 进行中任务的 talk/interact 目标标记；任务目标完成后失效。 */
  private goalMarkerProjection?: { version: number; focus?: string; values: Map<string, boolean> };
  /** GM 任务调试的焦点；任务面板据此只列出当前任务。 */
  get debugFocusQuest():string|undefined { return this.debugFocusQuestValue; }
  focusDebugQuest(id:string|undefined):void { this.debugFocusQuestValue=id; this.emit(); }
  private playerState?: Readonly<StoryPlayerState>;
  get player():Readonly<StoryPlayerState>|undefined { return this.hero?.player ?? this.playerState; }
  /** 上阵队伍是否至少还有一人活着；没有队伍时看主角。存档和检查点用它挡住全灭状态。 */
  get hasLivingMember():boolean {
    if(this.party)return this.party.livingIds.length>0;
    return (this.player?.health??0)>0;
  }
  setHealth(value:number):void {
    this.recordPerformance(['hero','party','playerState']);
    if(this.hero){this.hero.setHealth(value);return;}
    if(!this.playerState)return;
    this.playerState=Object.freeze({...this.playerState,health:boundedHealth(value,this.playerState.maxHealth)});this.emit();
  }
  readonly character?: Readonly<{ classId: string; appearance: ActorDefinition }>;
  itemCount(id: string): number { return this.bag.count(id); }
  /**
   * `pending` 是已经产出但还没被捡起的同类物品数量。
   * 任务掉落必须按「背包 + 地面」计算有效持有量，否则连续击杀时每一只都会再产一件，
   * 一次性捡起后就会超过任务需求。
   */
  questDropRequirements(pending:ReadonlyMap<string,number>=groundLootFor(this).pendingItemCounts()):readonly (readonly QuestDropRequirement[])[] {
    this.refresh();
    const focus=this.debugFocusQuestValue;
    return this.questBook.runningQuestIds.filter(id=>!focus||id===focus).flatMap(id=>{
      const quest=this.definition(id)!;
      if(this.questBook.status(id)!=='active'||quest.completion!=='all')return [];
      const goals=quest.goals.filter(goal=>goal.kind==='item')
        .map(goal=>({item:goal.target,quantity:goal.quantity,
          owned:this.itemCount(goal.target)+(pending.get(goal.target)??0)}));
      return goals.length?[goals]:[];
    });
  }
  /** 进行中任务里，这件物品对应的目标；任务没进行或物品不属于它时返回 undefined。 */
  private questItemGoal(quest:string,item:string):QuestGoal|undefined {
    const definition=this.definition(quest);
    if(!definition||this.status(quest)!=='active')return undefined;
    return definition.goals.find(goal=>goal.kind==='item'&&goal.target===item);
  }
  /**
   * 任务道具还差多少件：需求减去背包数量和地上还没捡的同类物品。
   * 返回正数表示还能产出；任务没进行、物品不属于它，或数量已经够了时返回 0。
   */
  questItemRemaining(quest:string,item:string):number {
    this.refresh();
    const goal=this.questItemGoal(quest,item);
    if(!goal)return 0;
    const pending=groundLootFor(this).pendingItemCounts().get(item)??0;
    return Math.max(0,goal.quantity-this.itemCount(item)-pending);
  }
  /**
   * 拾取任务道具前的余量。只算背包：正要捡的这一件本身就在地上，
   * 若把地面存货也计进去，同类道具会互相挡住，谁也捡不起来。
   * 没有进行中的任务需要它时返回 undefined（可以正常拾取）；
   * 返回 0 表示有任务需要，但背包里已经够了。
   */
  questItemPickupRemaining(item:string):number|undefined {
    this.refresh();
    let needed=false,remaining=0;
    const held=this.itemCount(item);
    for(const quest of this.questBook.runningQuestIds){
      const goal=this.questItemGoal(quest,item);
      if(!goal)continue;
      needed=true;remaining=Math.max(remaining,goal.quantity-held);
    }
    return needed?remaining:undefined;
  }

  /** 任务列表的只读投影；同一任务簿版本内返回同一份，调用方不得改写。 */
  get quests():ReadonlyMap<string,Readonly<QuestProgress & {count:number}>> {
    const questVersion=this.questBook.version,cached=this.questsProjection;
    if(cached?.questVersion===questVersion)return cached.value;
    const value=new Map(this.questBook.captureState().quests.map(([id,state])=>[id,Object.freeze({...state,count:Object.values(state.goals).reduce((sum,count)=>sum+count,0)})]));
    this.questsProjection={questVersion,value};
    return value;
  }
  get flags():ReadonlySet<string> { return this.storyWorld.flagIds; }
  /** 每个选择标识被选中过多少次；导演用次数变化派发选择剧情，值相同也算一次。 */
  choiceWriteCounts():ReadonlyMap<string,number> { return this.choiceWrites; }
  constructor(campaign:Campaign, player?:StoryPlayerState, character?:{classId:string;appearance:ActorDefinition}, items?:ItemCatalog, hero?:BattleCharacter, battle?:BattleCatalog, stats?:CharacterStatsCatalog, companions?:CompanionCatalog) {
    this.campaign = campaign;
    this.questGroupKinds = new Map(campaign.questGroups.flatMap(group =>
      group.questIds.map(id => [id, group.kind] as const)));
    this.playerState = player ? Object.freeze({...player}) : undefined;
    this.character = character ? Object.freeze({...character}) : undefined;
    this.listeners = new Set();
    this.battle=battle;this.stats=stats;this.companions=companions;
    this.hero = hero;
    this.skills = new StorySkillProgression(hero,battle);
    hero?.setSkillUseHandler((item,skill,memberId)=>{
      const definition=items?.items[item];
      if(definition?.use?.kind==='unlock-skill'){
        if(!memberId||memberId==='player')throw new Error('解锁书只能给佣兵使用');
        const member=this.party?.get(memberId);
        if(!member||member.source!=='mercenary'||!skill||!battle)throw new Error('无法为该成员使用解锁书');
        const classSkills=items?.classSkills[member.classId]??battle.classes.find(entry=>entry.id===member.classId)?.skills??[];
        if(!classSkills.includes(skill))throw new Error('该佣兵职业不符');
        member.skills.unlockSkill(skill,battle);
        this.recordPerformance(['party','bag']);this.emit();
        return `${battle.skills[skill].name}已解锁（1 级）`;
      }
      if(!memberId||memberId==='player')return this.skills.applyItem(item,skill);
      const member=this.party?.get(memberId);
      if(!member||member.source!=='mercenary'||definition?.use?.kind!=='learn'||!skill||!battle)throw new Error('无法为该成员使用技能书');
      const rank=member.skills.book(skill,battle);
      return `${battle.skills[skill].name}提升至 ${rank} 级`;
    });
    this.party=hero&&items&&stats&&companions?new PartyRoster(hero,stats,items,companions,()=>{this.recordPerformance(['party','bag']);this.emit();},id=>{this.cooldowns.removeActor(id);this.frenzyAnimations.removeActor(id);this.lootPity.removeMember(id);},
      sourceItem=>this.recordQuestFact('recruit',sourceItem,'recruit'),operation=>this.atomic(operation,['bag','party','questBook'])):undefined;
    this.bag = hero?.bag ?? new Bag(()=>{this.recordPerformance(['bag']);this.emit();},items,character?.classId,items?'game':'none');
    const inputs={events:new Set<string>(),choices:new Set<string>(),flags:new Set<string>(),world:new Set<string>()};
    for(const quest of campaign.quests){
      const references=storyConditionReferences(quest.availableWhen);
      for(const key of Object.keys(inputs) as (keyof typeof inputs)[])for(const id of references[key])inputs[key].add(id);
    }
    for(const id of inputs.events)this.questConditionInputs.push({key:`event:${id}`,read:context=>context.eventStatus(id)});
    for(const id of inputs.choices)this.questConditionInputs.push({key:`choice:${id}`,read:context=>context.choice(id)});
    for(const id of inputs.flags)this.questConditionInputs.push({key:`flag:${id}`,read:context=>context.flag(id)});
    for(const key of inputs.world)this.questConditionInputs.push({key:`world:${key}`,read:context=>context.world(key)});
    this.questBook=new QuestBook(this.campaign.quests,()=>this.questContext(),sideQuestIds(this.campaign.questGroups));
    hero?.subscribe(()=>{this.recordPerformance(['hero','bag']);this.emit();});
    this.refresh();
  }
  private questContext() {
    return {...this.conditionContext(),classId:this.hero?.classId??this.character?.classId,itemCount:(id:string)=>this.itemCount(id),
      equippedItemCount:(item:string)=>Object.values(this.bag.equipmentItems(this.bag.equipmentFor(this.party?.controlledId??'player'))).filter(id=>id===item).length};
  }
  conditionContext():StoryConditionContext {
    return {questStatus:id=>this.status(id),questCompletedCycles:id=>this.questBook?.completedCycles(id)??0,
      eventStatus:id=>{
        const run=[...this.runtimeSnapshot.runs].reverse().find(run=>run.eventId===id&&['running','waiting'].includes(run.status));
        return run?.status==='running'?'running':run?.status==='waiting'?'waiting':this.runtimeSnapshot.completedEvents.includes(id)?'completed':'idle';
      },choice:id=>this.storyWorld.choice(id),flag:id=>this.storyWorld.hasFlag(id),world:key=>this.worldValue(this.storyWorld,key)};
  }
  private worldValue(world:StoryWorldState,key:string):StoryWorldValue|undefined {
    return key==='map'?world.currentLocation?.map??this.worldContext()[key]:this.worldContext()[key];
  }
  setStoryWorldContext(context:()=>Record<string,StoryWorldValue>):void { this.worldContext=context;this.questProjection=undefined;this.refresh(); }
  /** 运行时快照不可变，按引用返回；需要修改时由调用方先复制。 */
  get runtimeState():StoryRuntimeSnapshot {return this.runtimeSnapshot;}
  /** 当前是否有剧情 run 在等待战斗结果；检查点据此避开战斗开局。 */
  get hasWaitingStoryRun():boolean { return this.runtimeSnapshot.runs.some(run=>run.status==='waiting'); }
  set runtimeState(value:StoryRuntimeSnapshot) {
    const next=this.prepareRuntime(value);this.validateStoryLinks(this.storyWorld.captureState(),next);this.runtimeSnapshot=next;
  }
  private createRuntimeValidator():StoryRuntime {
    return new StoryRuntime(this.campaign,{prepare:async()=>{},capture:()=>undefined,present:async()=>({}),finish:async()=>{},
      apply:()=>{},commit:()=>{},rollback:()=>{},evaluate:condition=>this.evaluateCondition(condition)});
  }
  private prepareRuntime(snapshot:StoryRuntimeSnapshot):StoryRuntimeSnapshot {
    const runtime=this.runtimeValidator??=this.createRuntimeValidator();
    return runtime.prepareRestore(snapshot);
  }
  evaluateCondition(condition:StoryCondition):boolean {
    return evaluateStoryCondition(condition,this.conditionContext());
  }
  /** 调试准备在独立会话中执行，安装之前不会通知正式导演。 */
  createStorySandbox():Session {
    const hero=this.hero&&this.stats?new BattleCharacter(this.hero.classId,this.stats,this.bag.catalog):undefined;
    return new Session(this.campaign,this.playerState,this.character,this.bag.catalog,hero,this.battle,this.stats,this.companions);
  }

  captureState():SessionState { return this.captureStateWith(this.questBook.captureState()); }
  /** 存档用：GM 调试钉住只是现场状态；舞台演员外观也不是持久数据，写档前剥离。 */
  capturePersistentState():SessionState {
    const state=this.captureStateWith(undefined,true);
    if(state.questBook.debugPins?.length){
      const questBook={...state.questBook};delete questBook.debugPins;state.questBook=questBook;
    }
    delete state.debugFocusQuest;
    state.runtime=toPlaybackCheckpoint(state.runtime);
    return state;
  }
  /** 拾取一次性解锁道具：记录后把解锁保底清零。 */
  claimReservedDrop(item:string):void {
    this.claimedReservedDrops.add(item);
    this.reservedDropMisses=0;
  }
  /** 旧档里已经拥有的解锁道具只补领取记录，不改动物品，也不清掉当前保底。 */
  seedReservedClaims(items:Iterable<string>):void {
    for(const item of items)this.claimedReservedDrops.add(item);
  }
  private restoreReservedDrops(state?:ReservedDropState):void {
    const value=state??{unlockMisses:0,claimed:[]};
    if(!Number.isSafeInteger(value.unlockMisses)||value.unlockMisses<0||
      !Array.isArray(value.claimed)||value.claimed.some(item=>typeof item!=='string'))
      throw new Error('保留掉落状态无效');
    this.reservedDropMisses=value.unlockMisses;
    this.claimedReservedDrops.clear();
    for(const item of value.claimed)this.claimedReservedDrops.add(item);
  }
  private cachedSnapshot<T>(slot:SnapshotSlot,version:number,capture:()=>T):T {
    const cached=this.snapshotCache[slot];
    if(cached?.version===version)return cached.value as T;
    const value=capture();this.snapshotCache[slot]={version,value};return value;
  }
  private captureStateWith(questBook:QuestBookState|undefined,reuse=false):SessionState {
    const captureEnemies=():SessionState['enemies']=>[...this.enemyStates].map(([id,enemy])=>[id,structuredClone(enemy)]);
    const captureReceipts=():SessionState['receipts']=>[...this.receipts.values()].map(receipt=>structuredClone(receipt));
    const questBookState=reuse
      ?this.cachedSnapshot('questBook',this.questBook.version,()=>this.questBook.captureState())
      :(questBook??this.questBook.captureState());
    const storyWorld=reuse
      ?this.cachedSnapshot('storyWorld',this.storyWorld.revision,()=>this.storyWorld.captureState())
      :this.storyWorld.captureState();
    const bag=reuse?this.cachedSnapshot('bag',this.bag.revision,()=>this.bag.captureState()):this.bag.captureState();
    const enemies=reuse?this.cachedSnapshot('enemies',this.enemyRevision,captureEnemies):captureEnemies();
    const receipts=reuse?this.cachedSnapshot('receipts',this.receiptRevision,captureReceipts):captureReceipts();
    const chests=reuse?this.cachedSnapshot('chests',this.chests.revision,()=>this.chests.captureState()):this.chests.captureState();
    const ground=groundLootFor(this);
    const groundLoot=reuse?this.cachedSnapshot('groundLoot',ground.revision,()=>ground.captureState()):ground.captureState();
    return {classId:this.hero?.classId??this.character?.classId,
      questBook:questBookState,storyWorld,runtime:this.runtimeSnapshot,
      receipts,
      factSequences:[...this.factSequences],trackedQuest:this.trackedQuest,debugFocusQuest:this.debugFocusQuestValue,player:this.playerState,money:this.coins,gameTimeMs:this.gameTimeMs,
      enemies,bag,hero:this.hero?.captureState(),skills:this.skills.captureState(),
      party:this.party?.captureState(),recovery:this.recovery.captureState(),resourceRecovery:this.resourceRecovery.captureState(),
      combatClock:this.combatClock.captureState(),cooldowns:this.cooldowns.captureState(),frenzyAnimations:this.frenzyAnimations.captureState(),chests,springs:this.springs.captureState(),legendaryWeapons:this.legendaryWeapons.captureState(),shops:this.shops.captureState(),
      questItemGeneration:this.questItemGenerators.captureState(),groundLoot,
      lootPity:this.lootPity.captureState(),reservedDrops:{unlockMisses:this.reservedDropMisses,claimed:[...this.claimedReservedDrops].sort()},
      partyItemChance:this.partyItemChance};
  }
  private restoreUnchecked(restored:SessionState,quests?:QuestBookCheckpoint):void {
    this.snapshotCache={};this.questProjection=undefined;this.questsProjection=undefined;
    // 回滚与校验后的恢复都走这里：状态已经过 validateInventoryState，重验只会让错误处理
    // 自己抛错、把真正的异常盖掉。
    this.bag.restoreUnchecked(restored.bag);
    if(restored.hero)this.hero!.restoreState(restored.hero);
    this.skills.restoreState(restored.skills);
    if(restored.party)this.party!.restoreState(restored.party);
    // 批次回滚走 O(1) 检查点；存档/检查点恢复仍走带校验的 `restoreState`。
    if(quests)this.questBook.rollbackTo(quests);else this.questBook.restoreState(restored.questBook);
    this.storyWorld.restoreState(restored.storyWorld);
    // 选择写入次数是当前时间线的运行时计数，读档/检查点恢复后从零开始。
    // 修订号仍要推进，避免按旧次数复用的观察结果把恢复后的空表当成“没变化”。
    this.choiceWrites.clear();this.choiceWriteRevisionValue++;
    // 外部恢复已在 `prepareRuntime` 校验过；回滚拿到的是本项目刚产出的不可变快照。
    this.runtimeSnapshot=restored.runtime;
    this.restoreReceipts(restored.receipts);
    this.factSequences.clear();for(const [source,sequence]of restored.factSequences)this.factSequences.set(source,sequence);
    this.enemyStates.clear();for(const [id,enemy] of restored.enemies)this.enemyStates.set(id,enemy);this.enemyRevisionValue++;this.enemySpawnRevisionValue++;
    this.trackedQuest=restored.trackedQuest;this.debugFocusQuestValue=restored.debugFocusQuest;this.playerState=restored.player?Object.freeze({...restored.player}):undefined;
    this.coins=restored.money;this.gameTimeMs=restored.gameTimeMs;
    this.recovery.restoreState(restored.recovery);this.chests.restoreState(restored.chests);this.springs.restoreState(restored.springs);this.legendaryWeapons.restoreState(restored.legendaryWeapons);this.shops.restoreState(restored.shops);
    this.pruneBreakableEnemyStates();
    this.forgetPrunedEncounterEnemies();
    const clock=restored.combatClock??{frame:Math.floor(restored.resourceRecovery.elapsedMs/LOGIC_FRAME_MS),remainderMs:restored.resourceRecovery.elapsedMs%LOGIC_FRAME_MS};
    this.combatClock.restoreState(clock);this.cooldowns.restoreState(restored.cooldowns??{actors:[]});
    this.frenzyAnimations.restoreState(restored.frenzyAnimations??[]);
    this.resourceRecovery.restoreState({...restored.resourceRecovery,elapsedMs:clock.frame*LOGIC_FRAME_MS});groundLootFor(this).restoreState(restored.groundLoot);
    this.questItemGenerators.restoreState(restored.questItemGeneration,groundLootFor(this));
    this.lootPity.restoreState(restored.lootPity??{version:2,members:[],chests:[],bossDefeats:[]});
    for(const [id] of restored.lootPity?.members??[])if(id!=='player'&&!this.party?.get(id))this.lootPity.removeMember(id);
    this.restoreReservedDrops(restored.reservedDrops);
    this.partyItemChance=restored.partyItemChance??0;
  }
  /**
   * 收据表按任务只保留周期最新的一张：正式消费者只读某任务的最新奖励，
   * 旧存档里同一任务的多个历史轮次在恢复时丢弃。
   */
  private restoreReceipts(receipts:Iterable<QuestSettlement>):void {
    this.receipts.clear();
    for(const receipt of receipts){
      const kept=this.receipts.get(receipt.quest);
      if(!kept||receipt.cycle>kept.cycle)this.receipts.set(receipt.quest,structuredClone(receipt));
    }
    this.receiptRevisionValue++;
  }
  /**
   * 背包自身的不变量交给 `verifyBagState`；这里只补它判不了的两条——装备与快捷栏的拥有者
   * 必须是真实队员（要队伍名单），快捷栏引用的技能必须存在（要战斗技能表）。
   */
  private validateInventoryState(state:SessionState):void {
    const bag=state.bag;verifyBagState(bag,this.bag.catalog);
    const knownItems=Object.keys(this.bag.catalog.items).length>0;
    const owners=new Set(['player',...state.party?.members.map(member=>member.id)??[]]);
    for(const [owner]of bag.companionEquipment)if(!owners.has(owner))throw new Error('背包装备的拥有者不存在');
    for(const [owner,row]of bag.shortcuts){
      if(!owners.has(owner))throw new Error('快捷栏的拥有者不存在');
      for(const slot of row)if(slot){
        if(slot.kind==='item'&&knownItems&&!this.bag.catalog.items[slot.id]||slot.kind==='skill'&&this.battle&&!this.battle.skills[slot.id])throw new Error('快捷栏引用不存在');
      }
    }
    if(state.legendaryWeapons&&(!Array.isArray(state.legendaryWeapons.used)||state.legendaryWeapons.used.some(key=>typeof key!=='string'||!key.includes(':'))))throw new Error('已拔古剑记录无效');
  }
  private validateSkillState(state:SessionState):void {
    const validate=(skills:SkillConfigurationState)=>{
      if(new Set(skills.loadouts.map(([id])=>id)).size!==skills.loadouts.length||new Set(skills.pages.map(([id])=>id)).size!==skills.pages.length)throw new Error('检查点技能配置重复');
      for(const [classId,loadout]of skills.loadouts){
        const character=this.battle?.classes.find(value=>value.id===classId);
        if(this.battle&&!character)throw new Error('检查点技能职业不存在');
        for(const [id,level]of Object.entries(loadout.levels)){
          const skill=this.battle?.skills[id];
          if(!Number.isSafeInteger(level)||level<0||character&&!character.skills.includes(id)||this.battle&&(!skill||level>0&&![...skill.ranks,...skill.companion?.ranks??[]].some(rank=>rank.level===level)))throw new Error('检查点技能引用或等级无效');
        }
      }
      for(const [classId,page]of skills.pages)if(!Number.isSafeInteger(page)||page<0||page>1||this.battle&&!this.battle.classes.some(value=>value.id===classId))throw new Error('检查点技能组页码无效');
    };
    validate(state.skills);
    if(state.hero&&this.stats&&(!Number.isSafeInteger(state.hero.level)||state.hero.level<1||state.hero.level>this.stats.maxLevel))throw new Error('检查点角色等级无效');
    if(state.party){
      const ids=new Set<string>();
      for(const member of state.party.members){
        if(!member.id||ids.has(member.id)||!this.party?.catalog.definitions[member.definitionId])throw new Error('检查点伙伴引用无效');
        ids.add(member.id);validate(member.skills);
      }
      for(const id of [...state.party.slots,...state.party.rosterSlots])if(id&&!ids.has(id))throw new Error('检查点队伍格位引用无效');
      if(state.party.selected!=='player'&&!ids.has(state.party.selected))throw new Error('检查点操控伙伴不存在');
    }
  }
  private validateStoryLinks(world:StoryWorldSnapshot,runtime:StoryRuntimeSnapshot):void {
    const encounters=new Map(world.encounters.map(encounter=>[encounter.id,encounter])),waiting=new Set<string>();
    for(const run of runtime.runs)if(run.waiting){
      const encounter=encounters.get(run.waiting.encounter);
      if(!encounter||encounter.status!=='active')throw new Error('检查点等待遭遇不存在或未处于战斗中');
      if(waiting.has(encounter.id))throw new Error('检查点重复等待同一遭遇');waiting.add(encounter.id);
      const node=this.campaign.scripts[run.cursor.script]?.nodes.find(node=>node.id===run.cursor.node);
      if(node?.exit.type!=='waitEncounter'||encounter.id!==`${run.id}:${node.id}:${node.exit.encounter.id}`)throw new Error('检查点等待遭遇与剧情节点不一致');
      const declared=node.exit.outcomes;
      if(Object.keys(declared).length!==Object.keys(run.waiting.outcomes).length||Object.entries(declared).some(([key,ref])=>{
        const saved=run.waiting!.outcomes[key];return !saved||saved.script!==ref.script||saved.node!==ref.node;
      }))throw new Error('检查点遭遇结果与剧情出口不一致');
    }
  }
  restoreState(state:SessionState):void {
    // 整份状态被外部快照替换，演出日志里的旧值已经失去意义。
    this.performanceLogging=false;this.performanceTouched=new Set();this.performanceBaseline={};
    const restored=structuredClone(state);
    if(restored.classId!==(this.hero?.classId??this.character?.classId)||!!restored.hero!==!!this.hero||!!restored.party!==!!this.party)throw new Error('检查点与当前游戏角色不一致');
    this.questBook.prepareRestore(restored.questBook);this.storyWorld.prepareRestore(restored.storyWorld);this.prepareRuntime(restored.runtime);
    this.validateInventoryState(restored);this.validateSkillState(restored);
    const ground=new GroundLootStore();ground.restoreState(restored.groundLoot);
    new QuestItemGenerators().restoreState(restored.questItemGeneration,ground);
    this.validateStoryLinks(restored.storyWorld,restored.runtime);
    if(restored.trackedQuest&&!this.definition(restored.trackedQuest))throw new Error('检查点追踪未知任务');
    if(restored.debugFocusQuest&&!this.definition(restored.debugFocusQuest))throw new Error('检查点焦点未知任务');
    const rewardKeys=new Set<string>();
    const questProgress=new Map(restored.questBook.quests);
    for(const receipt of restored.receipts){
      const key=JSON.stringify([receipt.quest,receipt.cycle]);
      if(!this.definition(receipt.quest)||rewardKeys.has(key)||!Number.isSafeInteger(receipt.cycle)||receipt.cycle<0)throw new Error('检查点奖励记录无效');
      const progress=questProgress.get(receipt.quest);
      if(!progress||!progress.completedCycles||receipt.cycle>progress.cycle)throw new Error('检查点奖励与任务周期不一致');
      if(!Number.isSafeInteger(receipt.reward.money)||receipt.reward.money<0||!Number.isSafeInteger(receipt.reward.experience)||receipt.reward.experience<0||receipt.reward.items.some(item=>!item.item||!Number.isSafeInteger(item.quantity)||item.quantity<=0||Object.keys(this.bag.catalog.items).length&&!this.bag.catalog.items[item.item]))throw new Error('检查点奖励内容无效');
      rewardKeys.add(key);
    }
    if(!Number.isSafeInteger(restored.money)||restored.money<0||!Number.isFinite(restored.gameTimeMs)||restored.gameTimeMs<0)throw new Error('检查点金币或时间无效');
    if(!Number.isFinite(restored.resourceRecovery.elapsedMs)||restored.resourceRecovery.elapsedMs<0||!Number.isSafeInteger(restored.resourceRecovery.deadlineTick)||restored.resourceRecovery.deadlineTick<0)throw new Error('检查点恢复时钟无效');
    if(new Set(restored.enemies.map(([id])=>id)).size!==restored.enemies.length||restored.enemies.some(([id,enemy])=>!id||[enemy.health,enemy.mana].some(value=>value!==undefined&&(!Number.isFinite(value)||value<0))||enemy.deadUntil!==undefined&&enemy.deadUntil!=='permanent'&&(!Number.isFinite(enemy.deadUntil)||enemy.deadUntil<0)))throw new Error('检查点敌人状态无效');
    if(restored.enemies.some(([,enemy])=>enemy.capture!==undefined&&(!enemy.capture||typeof enemy.capture.map!=='string'||!enemy.capture.map||
      !Number.isSafeInteger(enemy.capture.visit)||enemy.capture.visit<0||enemy.capture.visit>restored.storyWorld.mapVisit||enemy.deadUntil!=='permanent')))throw new Error('检查点捕捉来源无效');
    if(new Set(restored.factSequences.map(([id])=>id)).size!==restored.factSequences.length||restored.factSequences.some(([id,value])=>!id||!Number.isSafeInteger(value)||value<0))throw new Error('检查点任务事实序号无效');
    const before=this.captureState(),pending=this.pendingNotification;
    this.batchNotifications(()=>{
      try{this.restoreUnchecked(restored);this.refresh();this.restoreRevision++;this.emit();}
      catch(error){this.restoreUnchecked(before);this.pendingNotification=pending;throw error;}
    });
  }
  /** 会话时钟（毫秒）：地面掉落的创建时间与最旧淘汰按它记录。 */
  get nowMs():number { return this.gameTimeMs; }
  advanceGameTime(deltaMs:number):void { if(deltaMs>0){this.gameTimeMs+=deltaMs;this.recovery.advance(deltaMs);} }
  get resourceRecoveryDelayMs():number { return this.resourceRecovery.millisecondsUntilNextPulse-this.combatClock.fractionalMs; }
  /** 当前战斗帧是否会触发资源恢复脉冲。 */
  get recoveryPulseDue():boolean { return this.resourceRecovery.pulseDueAtFrame(this.combatTick); }
  /** 没有脉冲的帧只推进恢复时钟，保证“距下一脉冲”的读数与逐帧结算一致。 */
  advanceRecoveryClock():void { this.resourceRecovery.advanceToFrame(this.combatTick,[]); }
  get combatTick():number { return this.combatClock.currentFrame; }
  advanceCombatFrames(deltaMs:number,step:(frame:number)=>unknown):void {
    this.combatClock.advance(deltaMs,frame=>{
      this.questItemGenerators.advance(frame,definition=>this.questItemRemaining(definition.quest,definition.item)>0,groundLootFor(this));
      return step(frame);
    });
  }
  recoverCombatResources(actors:readonly ResourceRecoveryActor[]):ResourceRecoveryPulse[] {
    return this.resourceRecovery.advanceToFrame(this.combatTick,actors);
  }
  reviveCombatActor(id:string):void {
    this.cooldowns.resetActor(id);
    this.resourceRecovery.resetDeadline(this.combatTick);
  }
  enemyVitals(id:string):Readonly<EnemyState> {
    const state=this.enemyStates.get(id);
    return {...state,...(state?.capture?{capture:{...state.capture}}:{})};
  }
  /** 召唤物离场时丢弃它的战斗状态；召唤实例的 key 不会被地图生成点复用。 */
  forgetEnemyVitals(id:string):void {
    this.deleteEnemyState(id);
  }
  /** 旧档里已永久死亡的可破坏物记录不会再生成，读档时连记录和会话状态一起清掉。 */
  private pruneBreakableEnemyStates():void {
    for(const [id,state] of [...this.enemyStates]) {
      if(!id.startsWith('breakable:')||state.deadUntil!=='permanent')continue;
      this.deleteEnemyState(id);
      this.chests.removeSpawn(id);
    }
  }
  /**
   * 一次性剧情遭遇被有界历史淘汰后，它的怪物死亡记录也不会再被任何名册或结算读到。
   * key 必须和生成时一致，统一走 `encounterSpawnId`，不要在这里另拼格式。
   */
  private forgetPrunedEncounterEnemies():void {
    for(const encounter of this.storyWorld.consumePrunedEncounters())
      for(const spawn of encounter.spawns)this.deleteEnemyState(encounterSpawnId(encounter.id,spawn.id));
  }
  removeStoryEnemy(id:string):void {
    this.storyWorld.apply({kind:'remove',id});
    this.setEnemyState(id,{...this.enemyStates.get(id),health:0,deadUntil:'permanent'});
    this.emit();
  }
  setEnemyVitals(id:string,health:number,mana:number):void {
    this.setEnemyState(id,{...this.enemyStates.get(id),health,mana});
  }
  canSpawnEnemy(spawn:EnemySpawn|CampaignEnemyPlacement):boolean {
    if('activeQuest' in spawn&&this.status(spawn.activeQuest)!=='active')return false;
    if(!this.storyWorld.visible(spawn.id))return false;
    const state=this.enemyStates.get(spawn.id);
    if(state?.deadUntil===undefined)return true;
    if(state.deadUntil==='permanent'||this.gameTimeMs<state.deadUntil)return false;
    this.deleteEnemyState(spawn.id);return true;
  }
  /** 类型 3 任务把低血量的怪物变成同格可交互角色，交互之后才记目标次数。 */
  weakenQuestTarget(enemyId:string,source:{id:string;map:string;x:number;y:number}):boolean {
    const match=this.campaign.quests.flatMap(quest=>this.status(quest.id)==='active'
      ?(quest.targetChanges??[]).filter(change=>change.enemyId===enemyId&&
        (this.questBook.state(quest.id)?.goals[change.goal]??0)<(quest.goals.find(goal=>goal.id===change.goal)?.quantity??0))
        .map(change=>({quest,change})):[])[0];
    if(!match||!this.canSpawnEnemy({...source,enemyId}))return false;
    this.batchNotifications(()=>{
      this.applyStoryCommands([
        // 捕捉目标只在这次进图有效：`place` 按 `scope` 决定访问寿命，传进命令里的 `mapVisit`
        // 会被它覆盖；不带 scope 的话，离图后 NPC 还留在世界里，可捕捉状态却已随进图清掉。
        {type:'world',command:{kind:'place',scope:'visit',entity:{id:'quest-target:'+source.id,map:source.map,actor:match.change.actor,
          characterId:match.quest.goals.find(goal=>goal.id===match.change.goal)?.characterId,authority:'story',
          x:source.x,y:source.y,visible:true,hint:match.change.interactText||match.change.changedText}}},
      ]);
      // 转换不会调用原版死亡重置；本次地图仍占用源槽，离图后重新登记。
      this.setEnemyState(source.id,{health:1,deadUntil:'permanent',capture:{map:source.map,visit:this.storyWorld.visit}});
      this.emit();
    });
    return true;
  }
  enemyDefeated(spawn:EnemySpawn|CampaignEnemyPlacement,respawnMs=DEFAULT_ENEMY_RESPAWN_MS):boolean {
    if(this.enemyStates.get(spawn.id)?.deadUntil!==undefined)return false;
    if('activeQuest' in spawn&&this.status(spawn.activeQuest)!=='active')return false;
    this.batchNotifications(()=>{
      const commands:StoryCommand[]=[{type:'quest',command:{type:'fact',fact:this.nextQuestFact('defeat',spawn.enemyId,'combat')}}];
      if('activeQuest' in spawn)commands.push({type:'item-give',item:spawn.rewardItem,quantity:1});
      this.applyStoryCommands(commands);
      this.setEnemyState(spawn.id,{deadUntil:spawn.respawn===false?'permanent':this.gameTimeMs+respawnMs});
      this.emit();
    });
    for (const listener of this.defeatListeners) listener(spawn.enemyId);
    return 'activeQuest' in spawn;
  }
  private readonly defeatListeners = new Set<(enemy: string) => void>();
  subscribeDefeats(listener: (enemy: string) => void): () => void {
    this.defeatListeners.add(listener); return () => { this.defeatListeners.delete(listener); };
  }
  subscribe(listener: SessionListener): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  /**
   * 只把批次内多次修改的通知合并成一次；失败不回滚已写入的状态。
   * 需要“全成或全退”的入口用 `atomic`，这里不要当成事务使用。
   */
  batchNotifications<T>(operation:()=>T):T {
    this.notificationBatchDepth++;
    try{return operation();}
    finally{this.notificationBatchDepth--;if(!this.notificationBatchDepth&&this.pendingNotification){this.pendingNotification=false;this.emit();}}
  }
  /**
   * 要么全成、要么全退的入口：失败时只恢复这次声明过的子系统，丢弃批次内待发的通知，
   * 再把原错误抛给调用方。
   *
   * `touched` 是这次操作可能改到的子系统。快照按需抓：第一次碰到某个子系统时才复制它的状态；
   * 嵌套调用只把 `touched` 并进外层帧，由外层统一回滚一次。剧情提交不使用它，
   * 继续走 `StoryCommitReceipt` 的检查点回执，避免整份会话快照回来。
   */
  atomic<T>(operation:()=>T,touched:readonly AtomicSubsystem[]):T {
    const outer=this.atomicFrames.length===0;
    const frame:AtomicFrame=outer?{touched:new Set(),baseline:{}}:this.atomicFrames[0]!;
    if(outer)this.atomicFrames.push(frame);
    const pending=this.pendingNotification;
    try{
      this.touchAtomic(frame,touched);
      return this.batchNotifications(()=>{
        try{return operation();}
        catch(error){
          if(outer){this.restoreStoryCommandBaseline(frame.touched,frame.baseline);this.pendingNotification=pending;}
          throw error;
        }
      });
    }finally{if(outer)this.atomicFrames.pop();}
  }
  /** 第一次碰到某个子系统时才抓旧值；同一个子系统只抓一次。 */
  private touchAtomic(frame:AtomicFrame,subsystems:Iterable<AtomicSubsystem>):void {
    const fresh=new Set<AtomicSubsystem>();
    for(const subsystem of subsystems)if(!frame.touched.has(subsystem))fresh.add(subsystem);
    if(!fresh.size)return;
    // 先抓快照、成功后再记触碰面：抓取失败时不能留下“声明过、却没有基线”的子系统，
    // 否则外层稍后回滚会解引用 undefined 基线，盖住原始错误并中断其余子系统的恢复。
    const baseline=this.captureStoryCommandBaseline(fresh);
    for(const subsystem of fresh)frame.touched.add(subsystem);
    Object.assign(frame.baseline,baseline);
  }
  emit(): void {
    if(this.notificationBatchDepth){this.pendingNotification=true;return;}
    this.refresh(); for (const listener of this.listeners) listener(this);
  }
  refresh():void {
    if(!this.questBook)return;
    const questVersion=this.questBook.version,bagVersion=this.bag.revision,owner=this.party?.controlledId??'player';
    const context=this.questConditionInputs.length?this.conditionContext():undefined;
    const conditions=this.questConditionInputs.map(input=>input.read(context!)),previous=this.questProjection;
    if(previous&&previous.questVersion===questVersion&&previous.bagVersion===bagVersion&&previous.owner===owner&&
      conditions.every((value,index)=>Object.is(value,previous.conditions[index])))return;
    // 没有上一份投影（启动、读档/检查点恢复、调试改写了世界上下文）时做一次全量刷新，
    // 把新装进来的任务和当前条件对齐；常规刷新只找这次变化会影响的任务。
    if(!previous){this.recordPerformance(['questBook']);this.questBook.commit(this.questBook.plan({type:'refresh'}));this.recordQuestProjection();return;}
    const keys:string[]=[];
    for(const [index,input] of this.questConditionInputs.entries())
      if(!Object.is(conditions[index],previous.conditions[index]))keys.push(input.key);
    const bagChanged=previous.bagVersion!==bagVersion,ownerChanged=previous.owner!==owner;
    if(keys.length||bagChanged||ownerChanged){
      this.recordPerformance(['questBook']);
      this.questBook.refreshChanges({keys,bagChanged,ownerChanged});
    }
    this.recordQuestProjection();
  }
  /** 记下这次任务投影的输入，供 `refresh` 判断结果能不能复用。 */
  private recordQuestProjection():void {
    const context=this.questConditionInputs.length?this.conditionContext():undefined;
    this.questProjection={questVersion:this.questBook.version,bagVersion:this.bag.revision,
      owner:this.party?.controlledId??'player',conditions:this.questConditionInputs.map(input=>input.read(context!))};
  }
  definition(id:string):CampaignQuest|undefined{return this.campaign.quests.find(quest=>quest.id===id);}
  status(id:string):QuestStatus{return this.questBook?.status(id)??'locked';}
  rewardReceiptFor(id:string,cycle?:number):QuestRewardReceipt|undefined {
    const receipt=this.receipts.get(id);
    if(!receipt||cycle!==undefined&&receipt.cycle!==cycle)return undefined;
    return structuredClone(receipt.reward);
  }
  accept(id:string):boolean {
    this.refresh();if(this.status(id)!=='available')return false;
    this.applyStoryCommands([{type:'quest',command:{type:'accept',quest:id,cycle:this.questBook.state(id)!.cycle}}]);return true;
  }
  /**
   * 进行中的任务里指到这个目标、且还没记满的目标。
   * `talk` 与 `interact` 两类目标导出后都落在 NPC 的 `actor` 上（与摆放点 `objective` 的写法同一口径），
   * 对玩家是同一件事：走过去跟它交互。
   */
  private waitingGoalEntries(target:string,characterId?:string):{kind:'talk'|'interact';target:string;quest:CampaignQuest;goal:QuestGoal}[] {
    const goals:{kind:'talk'|'interact';target:string;quest:CampaignQuest;goal:QuestGoal}[]=[];
    for(const quest of this.campaign.quests){
      if(this.status(quest.id)!=='active')continue;
      const progress=this.questBook.state(quest.id)?.goals;
      for(const goal of quest.goals){
        if(goal.kind!=='talk'&&goal.kind!=='interact')continue;
        if(!(characterId!==undefined&&goal.characterId!==undefined?goal.characterId===characterId:goal.target===target))continue;
        // 已记满的目标不再进入候选：同一根号角不能重复触发，多数量目标则一直可交互到记满为止。
        if((progress?.[goal.id]??0)>=goal.quantity)continue;
        goals.push({kind:goal.kind,target:goal.target,quest,goal});
      }
    }
    return goals;
  }
  private waitingGoals(target:string,characterId?:string):{kind:'talk'|'interact';target:string}[] {
    return this.waitingGoalEntries(target,characterId).map(({kind,target})=>({kind,target}));
  }
  /**
   * 摆放点这次交互能不能推进任务：`objective` 声明的目标或 NPC 自己的 `actor`，
   * 只要有一条进行中的任务指着它、且目标还没记满就算。场景用它把没有别的用途的摆放点也算成可交互对象。
   */
  canInteract(target:string,_instance:string,characterId?:string):boolean {
    return this.waitingGoals(target,characterId).length>0;
  }
  /**
   * 玩家跟一个目标交互一次。原版里「去跟某人说话」「去对某个东西用一次」本身就是任务目标：
   * 进行中任务里指到这个目标、还没记满的按类型各记一次事实，任务日志与头顶标记随之更新。
   * 已经记满的目标不再是候选，重复交互既不计数也不再产生任务事实。
   * 剧情事件接管这次交互时由剧情脚本自己推进目标，这里不记账（见 `StoryDirector.interact`）。
   *
   * `advanced` 表示这次交互有没有真的增加目标计数；`feedback` 是这些目标带的提示文本。
   */
  interactWithFeedback(target:string,instance:string,characterId?:string):{advanced:boolean;feedback:string[]} {
    if(instance.startsWith('quest-target:')){
      const source=this.enemyStates.get(instance.slice('quest-target:'.length))?.capture,entity=this.storyWorld.entity(instance);
      if(!source||source.visit!==this.storyWorld.visit||!entity||!this.storyWorld.visible(instance))return {advanced:false,feedback:[]};
    }
    const entries=this.waitingGoalEntries(target,characterId);
    if(!entries.length)return {advanced:false,feedback:[]};
    const progressKey=(quest:CampaignQuest,goal:QuestGoal)=>quest.id+'\0'+goal.id;
    const before=new Map(entries.map(entry=>[progressKey(entry.quest,entry.goal),this.questBook.state(entry.quest.id)?.goals[entry.goal.id]??0]));
    const kinds=[...new Set(entries.map(entry=>entry.kind))];
    const remove=instance.startsWith('quest-target:')&&this.campaign.quests.some(quest=>this.status(quest.id)==='active'
      &&quest.targetChanges?.some(change=>change.actor===target&&change.removeAfterInteraction));
    const commands:StoryCommand[]=[
      ...kinds.map(kind=>({type:'quest' as const,
        command:{type:'fact' as const,fact:{...this.nextQuestFact(kind,target,kind==='interact'?'interaction':'talk'),...(characterId?{characterId}:{})}}})),
    ];
    if(remove)commands.push({type:'world',command:{kind:'remove',id:instance}});
    this.batchNotifications(()=>{
      this.applyStoryCommands(commands);
    });
    const feedback:string[]=[];
    let advanced=false;
    for(const entry of entries){
      const after=this.questBook.state(entry.quest.id)?.goals[entry.goal.id]??0;
      if(after<=(before.get(progressKey(entry.quest,entry.goal))??0))continue;
      advanced=true;
      // 日志外任务照常计数，但不在玩家交互时弹出目标提示。
      if(entry.quest.journal===false||!entry.goal.feedbackText||feedback.includes(entry.goal.feedbackText))continue;
      feedback.push(entry.goal.feedbackText);
    }
    return {advanced,feedback};
  }
  interact(target:string,instance:string,characterId?:string):boolean {
    return this.interactWithFeedback(target,instance,characterId).advanced;
  }
  nextQuestFact(kind:QuestFact['kind'],target:string,source:string=kind):QuestFact {
    // 两个来源都要看：会话级 `factSequences` 是提交时同步的镜像，任务簿里那份才是权威。
    const prior=Math.max(this.factSequences.get(source)??0,this.questBook.factSequence(source));
    return {kind,target,occurrence:{source,sequence:prior+1}};
  }
  recordQuestFact(kind:QuestFact['kind'],target:string,source:string=kind):void {
    this.applyStoryCommands([{type:'quest',command:{type:'fact',fact:this.nextQuestFact(kind,target,source)}}]);
  }
  complete(id:string):boolean {
    if(this.questBook.pinned(id))this.unpinDebugQuest(id);
    this.refresh();if(this.status(id)!=='ready')return false;
    this.applyStoryCommands([{type:'quest',command:{type:'complete',quest:id,cycle:this.questBook.state(id)!.cycle}}]);return true;
  }
  /** GM 调试：把已接取任务钉在进行中，refresh 不再把它提升为待交付。 */
  pinDebugQuest(id:string):void { this.recordPerformance(['questBook']);this.questBook.pinDebug(id); this.refresh(); }
  unpinDebugQuest(id:string):void { this.recordPerformance(['questBook']);this.questBook.unpinDebug(id); this.refresh(); }
  mark(flag:string):void {this.applyStoryCommands([{type:'flag',flag}]);}
  visible(entity:VisibilityRules & {condition?:StoryCondition}):boolean {
    if(!this.storyWorld.visible(entity.id))return false;
    // 没有条件时不要构造整套条件上下文；大多数静态角色走这条快路径。
    return entity.condition===undefined||evaluateStoryCondition(entity.condition,this.conditionContext());
  }
  private matchesQuestActor(quest:CampaignQuest,actor:string,characterId:string|undefined,delivery:boolean):boolean {
    const expectedActor=delivery?(quest.delivery??quest.giver):quest.giver;
    const expectedCharacter=delivery?(quest.deliveryCharacterId??quest.giverCharacterId):quest.giverCharacterId;
    return characterId!==undefined&&expectedCharacter!==undefined?characterId===expectedCharacter:actor===expectedActor;
  }
  forActor(actor:string,characterId?:string):CampaignQuest[] {
    this.refresh();
    const focus=this.debugFocusQuestValue,priority:Record<QuestStatus,number>={ready:0,available:1,active:2,locked:3,completed:4};
    return this.campaign.quests.filter(quest=>(!focus||quest.id===focus)
      &&this.matchesQuestActor(quest,actor,characterId,this.status(quest.id)!=='available')
      &&(!!focus||this.questBook.journalVisible(quest.id))&&['ready','available','active'].includes(this.status(quest.id)))
      .sort((a,b)=>priority[this.status(a.id)]-priority[this.status(b.id)]);
  }
  /**
   * 原版 NPC 交互实际执行的那一条任务槽（`NPCSYSTEM_MakeFunctionList`）。
   *
   * 分层与顺序不能合并成「按状态排序的完整列表」：
   * 1. 待交付（状态 2 + 交付人）按运行池顺序取第一条，命中即独占；
   * 2. 否则可接主线按任务行序取第一条，命中即独占；
   * 3. 否则可接支线按任务行序取第一条；
   * 4. 否则进行中（状态 1 + 交付人）按运行池顺序取第一条。
   *
   * 原版 `UINpc_ExeCurrentNpcTask` 执行槽 0，没有选择步骤；`forActor` 仍保留为完整关联列表，
   * 供 GM、标记和测试使用。
   */
  npcQuestSlot(actor:string,characterId?:string):CampaignQuest|undefined {
    this.refresh();
    const version=this.questBook.version,focus=this.debugFocusQuestValue,cached=this.questSlotProjection;
    if(!cached||cached.version!==version||cached.focus!==focus)this.questSlotProjection={version,focus,values:new Map()};
    const values=this.questSlotProjection!.values,key=actor+'\0'+(characterId??'');
    if(!values.has(key))values.set(key,this.computeQuestSlot(actor,characterId));
    return values.get(key);
  }
  private computeQuestSlot(actor:string,characterId?:string):CampaignQuest|undefined {
    const focus=this.debugFocusQuestValue;
    if(focus)return this.forActor(actor,characterId)[0];
    // 待交付包含日志外任务：它们同样在运行池里，原版第一段循环不会因为日志不可见而跳过。
    for(const id of this.questBook.runningQuestIds){
      if(this.status(id)!=='ready')continue;
      const quest=this.definition(id);
      if(quest&&this.matchesQuestActor(quest,actor,characterId,true))return quest;
    }
    // 日志外只表示不进任务日志：可接状态同样参与任务槽。
    const available=this.campaign.quests.filter(quest=>this.status(quest.id)==='available'
      &&this.matchesQuestActor(quest,actor,characterId,false));
    const main=available.find(quest=>this.questGroupKinds.get(quest.id)==='main');
    if(main)return main;
    if(available.length)return available[0];
    for(const id of this.questBook.runningQuestIds){
      if(this.status(id)!=='active')continue;
      const quest=this.definition(id);
      if(quest&&this.matchesQuestActor(quest,actor,characterId,true))return quest;
    }
    return undefined;
  }
  /**
   * `forActor` 看不到、但仍然可以在这个角色／物件上交付的任务。
   *
   * 两种：**日志外任务**不进任务日志（`forActor` 因此看不到），但它由剧情事件接取后，原版同样要在
   * 指定对象上交付——任务 #50「打开地下矿山之门」的目标就是矿洞里的路障（NPC 341，景物），接取后
   * 拿到钥匙、跟路障交互即开门；把「日志可见」当成「可交付」会让这类任务永远停在待交付。
   * 另一种是**事件授予的任务**：接取没有发布者菜单，但原版仍按 `npc_index` 指向的角色交付
   * （见 findings 109）。缺省时交付回落到 `giver`。
   */
  deliverablesFor(actor:string,characterId?:string):CampaignQuest[] {
    this.refresh();
    const focus=this.debugFocusQuestValue;
    return this.campaign.quests.filter(quest=>(!focus||quest.id===focus)
      &&this.status(quest.id)==='ready'&&this.matchesQuestActor(quest,actor,characterId,true)
      &&!this.questBook.journalVisible(quest.id));
  }
  marker(actor:string,characterId?:string):QuestStatus|null {
    const quest=this.npcQuestSlot(actor,characterId);
    return quest?this.status(quest.id):(this.activeGoalMarker(actor,characterId)?'active':null);
  }
  /**
   * 头顶和小地图该不该给这个角色／物件挂标记。
   *
   * 日志外任务只表示不进任务日志；它们和日志内任务共用同一套场景标记，
   * 可接、进行中、待交付都要提示；进行中任务的 `talk` / `interact` 目标也算。
   * 不要再用 `questBook.journalVisible()` 过滤一次。调试焦点只看焦点任务：前置任务的人物不挂标记。
   */
  markerActor(actor:string,characterId?:string):boolean {
    const version=this.questBook.version,focus=this.debugFocusQuestValue,cached=this.markerActorProjection;
    if(!cached||cached.version!==version||cached.focus!==focus)this.markerActorProjection={version,focus,values:new Map()};
    const values=this.markerActorProjection!.values,key=actor+'\0'+(characterId??'');
    if(!values.has(key)){
      values.set(key,this.campaign.quests.some(quest=>{
        const status=this.status(quest.id);
        if(!['available','active','ready'].includes(status))return false;
        return (!focus||quest.id===focus)
          &&this.matchesQuestActor(quest,actor,characterId,status!=='available');
      }));
    }
    return values.get(key)!||this.activeGoalMarker(actor,characterId);
  }
  /**
   * 进行中任务的 `talk` / `interact` 目标也要在场景里提示。
   * 只标记还没记满的目标；目标完成后图标消失。日志外任务同样参与，不按任务日志可见性过滤。
   */
  private activeGoalMarker(actor:string,characterId?:string):boolean {
    const version=this.questBook.version,focus=this.debugFocusQuestValue,cached=this.goalMarkerProjection;
    if(!cached||cached.version!==version||cached.focus!==focus)this.goalMarkerProjection={version,focus,values:new Map()};
    const values=this.goalMarkerProjection!.values,key=actor+'\0'+(characterId??'');
    if(!values.has(key)){
      values.set(key,this.campaign.quests.some(quest=>{
        if(this.status(quest.id)!=='active'||(focus&&quest.id!==focus))return false;
        const progress=this.questBook.state(quest.id)?.goals;
        return quest.goals.some(goal=>(goal.kind==='talk'||goal.kind==='interact')
          &&(characterId!==undefined&&goal.characterId!==undefined?goal.characterId===characterId:goal.target===actor)
          &&(progress?.[goal.id]??0)<goal.quantity);
      }));
    }
    return values.get(key)!;
  }

  currentQuest():CampaignQuest|undefined {
    const focus=this.debugFocusQuestValue;
    if(focus){
      const quest=this.definition(focus);
      return quest&&['active','ready','available'].includes(this.status(focus))?quest:undefined;
    }
    if(this.trackedQuest&&this.questBook.journalVisible(this.trackedQuest)&&['active','ready'].includes(this.status(this.trackedQuest)))return this.definition(this.trackedQuest);
    return this.campaign.quests.find(quest=>this.questBook.journalVisible(quest.id)&&['active','ready'].includes(this.status(quest.id)))??
      this.campaign.quests.find(quest=>this.questBook.journalVisible(quest.id)&&this.status(quest.id)==='available');
  }
  trackQuest(id:string):boolean {
    const focus=this.debugFocusQuestValue;
    if(focus&&id!==focus)return false;
    if((!focus&&!this.questBook.journalVisible(id))||!['active','ready'].includes(this.status(id)))return false;
    this.trackedQuest=id;this.emit();return true;
  }
  private applyActorCommand(command:StoryCommand,bag:Bag,hero:BattleCharacter|undefined,party:PartyRoster|undefined,fallback:StoryPlayerState|undefined):void {
    if(command.type==='party-join'){if(!party)throw new Error('剧情队伍能力尚未装配');party.joinStory(command.companion);this.lootPity.counters(`story-${command.companion}`);return;}
    if(command.type==='party-leave'){if(!party)throw new Error('剧情队伍能力尚未装配');party.leaveStory(command.companion);this.lootPity.removeMember(`story-${command.companion}`);return;}
    if(command.type==='health'||command.type==='mana'){
      const actor=command.member==='player'?hero:party?.get(command.member);
      const player=actor?.player??(command.member==='player'?fallback:undefined);
      if(!player)throw new Error('剧情人物状态对象不存在');
      if(command.value!=='full'&&(!Number.isSafeInteger(command.value)||command.value<0))throw new Error('剧情人物状态数值无效');
      if(command.type==='health'){
        const value=command.value==='full'?player.maxHealth:command.value;
        if(actor)actor.setHealth(value);else fallback!.health=boundedHealth(value,player.maxHealth);
      }else{
        const value=command.value==='full'?player.maxMana:command.value;
        if(actor)actor.setMana(value);else fallback!.mana=Math.min(value,player.maxMana);
      }
      return;
    }
    if(command.type==='party-control'){
      if(party){if(!party.switchControl(command.member))throw new Error('剧情不能切换到未上阵或已倒下的成员');}
      else if(command.member!=='player'||(hero?.player.health??fallback?.health??0)<=0)throw new Error('剧情操控角色不存在或已倒下');
      return;
    }
    if(command.type==='unequip-destroy'){
      if(command.member!=='player'&&!party?.get(command.member)){if(command.ifPresent)return;throw new Error('剧情装备拥有者不存在');}
      for(const [slot,item]of Object.entries(bag.equipmentItems(bag.equipmentFor(command.member))))if(item===command.item){
        const entry=bag.equipmentFor(command.member)[slot as import('./items.ts').EquipmentSlot]!;
        bag.unequip(slot as import('./items.ts').EquipmentSlot,command.member);bag.take(entry,1);
      }
      return;
    }
    if(command.type==='equip'){
      if(command.member!=='player'&&!party?.get(command.member)&&command.ifPresent)return;
      const actor=command.member==='player'?hero:party?.get(command.member);
      const classId=actor?.classId??(command.member==='player'?this.character?.classId:undefined),level=actor?.player.level??fallback?.level;
      if(!classId)throw new Error('剧情装备拥有者不存在');
      if(command.create){
        if(bag.equipmentFor(command.member)[command.slot])bag.unequip(command.slot,command.member);
        bag.addEquipped(command.item,command.slot,command.member);return;
      }
      const entry=bag.entries.find(entry=>entry.item===command.item);
      if(!entry)throw new Error('剧情指定装备不在背包中');
      bag.equip(entry.id,command.slot,command.member,classId,level);
    }
  }
  private captureStoryCommandBaseline(touched:ReadonlySet<AtomicSubsystem>):StoryCommandBaseline {
    const baseline:StoryCommandBaseline={};
    if(touched.has('bag'))baseline.bag=this.bag.captureState();
    if(touched.has('hero')&&this.hero)baseline.hero=this.hero.captureState();
    if(touched.has('skills'))baseline.skills=this.skills.captureState();
    if(touched.has('party')&&this.party)baseline.party=this.party.captureState();
    if(touched.has('questBook'))baseline.quests={checkpoint:this.questBook.checkpoint(),factSequences:[...this.factSequences]};
    if(touched.has('storyWorld')){
      baseline.world=this.storyWorld.captureState();
      baseline.choiceWrites=[...this.choiceWrites];
    }
    if(touched.has('enemies'))baseline.enemies=[...this.enemyStates].map(([id,state])=>[id,structuredClone(state)]);
    if(touched.has('groundLoot'))baseline.loot=groundLootFor(this).captureState();
    if(touched.has('coins'))baseline.coins=this.coins;
    if(touched.has('receipts'))baseline.receipts=[...this.receipts].map(([key,receipt])=>[key,structuredClone(receipt)]);
    if(touched.has('lootPity'))baseline.lootPity=this.lootPity.captureState();
    if(touched.has('playerState'))baseline.playerState=this.playerState;
    if(touched.has('runtimeSnapshot'))baseline.runtime=this.runtimeSnapshot;
    if(touched.has('shops'))baseline.shops=this.shops.captureState();
    return baseline;
  }
  /** 只恢复这次真的碰过的子系统；没碰过的不读也不写。 */
  private restoreStoryCommandBaseline(touched:ReadonlySet<AtomicSubsystem>,baseline:StoryCommandBaseline):void {
    if(touched.has('bag'))this.bag.restoreUnchecked(baseline.bag!);
    if(touched.has('hero')&&baseline.hero)this.hero!.restoreState(baseline.hero);
    if(touched.has('skills'))this.skills.restoreState(baseline.skills!);
    if(touched.has('party')&&baseline.party)this.party!.restoreState(baseline.party);
    if(touched.has('questBook')){
      this.questBook.rollbackTo(baseline.quests!.checkpoint);
      this.factSequences.clear();for(const[source,sequence]of baseline.quests!.factSequences)this.factSequences.set(source,sequence);
      this.questProjection=undefined;this.questsProjection=undefined;
    }
    if(touched.has('storyWorld')){
      this.storyWorld.restoreState(baseline.world!);
      this.choiceWrites.clear();for(const[id,count]of baseline.choiceWrites??[])this.choiceWrites.set(id,count);
      this.choiceWriteRevisionValue++;
    }
    if(touched.has('enemies')){
      this.enemyStates.clear();for(const [id,state] of baseline.enemies!)this.enemyStates.set(id,state);
      this.enemyRevisionValue++;this.enemySpawnRevisionValue++;
    }
    if(touched.has('groundLoot'))groundLootFor(this).restoreState(baseline.loot!);
    if(touched.has('coins'))this.coins=baseline.coins!;
    if(touched.has('receipts'))this.restoreReceipts(baseline.receipts!.map(([,receipt])=>receipt));
    if(touched.has('lootPity'))this.lootPity.restoreState(baseline.lootPity!);
    if(touched.has('playerState'))this.playerState=baseline.playerState;
    if(touched.has('runtimeSnapshot'))this.runtimeSnapshot=baseline.runtime!;
    if(touched.has('shops'))this.shops.restoreState(baseline.shops!);
  }
  /**
   * 内部剧情检查点：由 `StoryRuntime` 自己产出，只接收引用并做廉价检查；开发/测试模式再全量校验。
   * 读档、检查点恢复和调试跳转仍走 `prepareRuntime`。
   */
  adoptRuntime(snapshot:StoryRuntimeSnapshot):void {
    const runtime=this.runtimeValidator??=this.createRuntimeValidator();
    this.runtimeSnapshot=runtime.adoptTrusted(snapshot);
  }
  private applyQuestCommand(command:QuestCommand):void {
    const plan=this.questBook.plan(command,{stateIsCurrent:true});
    for(const item of plan.itemRemovals)if(!this.bag.remove(item.item,item.quantity))throw new Error('剧情物品不足');
    for(const item of plan.itemGrants)this.bag.add(item.item,item.quantity);
    for(const receipt of plan.rewards){
      // 收据按任务只留最新一轮；周期没有前进，说明这一轮已经结算过。
      const existing=this.receipts.get(receipt.quest);
      if(existing&&receipt.cycle<=existing.cycle)throw new Error('任务奖励已结算');
      if(receipt.reward.experience)this.hero?.addExperience(receipt.reward.experience);
      if(receipt.reward.money)this.gainMoney(receipt.reward.money);
      this.receipts.set(receipt.quest,structuredClone(receipt));this.receiptRevisionValue++;
    }
    this.questBook.commit(plan);
    // `fact` 也走任务命令；会话级事实序号是提交侧的镜像。
    if(command.type==='fact')this.factSequences.set(command.fact.occurrence.source,this.questBook.factSequence(command.fact.occurrence.source));
    this.recordQuestProjection();
  }
  /**
   * 按顺序把剧情命令直接落到真实状态。
   *
   * 空命令只认领运行时检查点；非空批次在开改前只抓会碰到的子系统，失败只恢复这些子系统。
   * 返回回执给 `StoryDirector` 在分支求值失败时回滚；普通调用方在返回前已经 finalize。
   */
  applyStoryCommands(commands:readonly StoryCommand[],checkpoint?:StoryRuntimeSnapshot,
    options:{deferFinalize?:boolean}={}):StoryCommitReceipt {
    if(!commands.length){
      if(checkpoint)this.adoptRuntime(checkpoint);
      return {finalize(){},rollback(){}};
    }
    // 先把外部改动造成的任务差异补齐；通常命中投影缓存，不做全量。
    this.refresh();
    const touched=new Set<StorySubsystem>();
    for(const command of commands)for(const subsystem of storyCommandSubsystems(command))touched.add(subsystem);
    // 任务簿检查点是 O(1) 的状态根引用；背包/世界/操控角色变化都可能经由 `refresh` 间接刷新
    // 任务状态，所以每个非空批次都把它纳入回滚集。
    touched.add('questBook');
    if(checkpoint)touched.add('runtimeSnapshot');
    // 外部交互触发的提交也要能在取消演出时回滚；导演自己的延迟提交由回执负责，不重复记录。
    if(!options.deferFinalize)this.recordPerformance(touched);
    const baseline=this.captureStoryCommandBaseline(touched),pending=this.pendingNotification;
    let active=true;
    const receipt:StoryCommitReceipt={
      finalize:()=>{active=false;},
      rollback:()=>{
        if(!active)return;active=false;
        this.restoreStoryCommandBaseline(touched,baseline);this.pendingNotification=pending;this.emit();
      },
    };
    if(options.deferFinalize)this.storyCommandDepth++;
    try{
      this.batchNotifications(()=>{
        try{
          let playerState=this.playerState?{...this.playerState}:undefined;
        for(const command of commands){
          // 任务命令按前一条命令留下的背包/世界校验；其余命令直接改真实状态。
          if(command.type==='quest'||command.type==='interaction'||command.type==='talk')this.refresh();
          switch(command.type){
            case 'quest':this.applyQuestCommand(command.command);break;
            case 'interaction':
              if(!command.target||!command.instance)throw new Error('剧情交互目标无效');
              this.applyQuestCommand({type:'fact',fact:{kind:'interact',target:command.target,
                occurrence:{source:'interaction',sequence:this.questBook.factSequence('interaction')+1}}});break;
            case 'talk':
              if(!command.target)throw new Error('剧情对话目标无效');
              this.applyQuestCommand({type:'fact',fact:{kind:'talk',target:command.target,
                occurrence:{source:'talk',sequence:this.questBook.factSequence('talk')+1}}});break;
            case 'item-give':case 'item-take':
              if(!Number.isSafeInteger(command.quantity)||command.quantity<=0)throw new Error('剧情物品数量无效');
              if(command.type==='item-give')this.bag.add(command.item,command.quantity);
              else if(!(command.allowPartial&&this.bag.count(command.item)===0)&&!this.bag.remove(command.item,command.allowPartial?Math.min(command.quantity,this.bag.count(command.item)):command.quantity))throw new Error('剧情物品不足');
              break;
            case 'money-give':case 'money-take':
              if(!Number.isSafeInteger(command.amount)||command.amount<=0)throw new Error('剧情金币数量无效');
              if(command.type==='money-take'){
                if(command.amount>this.coins&&!command.allowPartial)throw new Error('剧情金币不足');
                this.spendMoney(Math.min(command.amount,this.coins));
              }else this.gainMoney(command.amount);
              break;
            case 'item-drop':
              if(!this.bag.catalog.items[command.item]||!Number.isSafeInteger(command.quantity)||command.quantity<=0||!Number.isFinite(command.x)||!Number.isFinite(command.y))throw new Error('剧情地面物品无效');
              groundLootFor(this).add(command.map??this.storyWorld.currentLocation?.map??this.campaign.start.map,command.x,command.y,[{kind:'item',item:command.item,quantity:command.quantity}]);
              break;
            case 'flag':this.storyWorld.apply({kind:'flag',id:command.flag,value:command.value??true});break;
            case 'choice':
              this.storyWorld.apply({kind:'choice',id:command.choice,value:command.value});
              this.choiceWrites.set(command.choice,(this.choiceWrites.get(command.choice)??0)+1);this.choiceWriteRevisionValue++;break;
            case 'world':{
              this.storyWorld.apply(command.command);
              // 已完成遭遇超出有界历史时，同一同步步骤删掉它们的一次性敌人状态；
              // `storyCommandSubsystems` 已把 `enemies` 纳入回滚集，回执或批次失败都能恢复。
              if(command.command.kind==='encounter-result')this.forgetPrunedEncounterEnemies();
              break;
            }
            case 'travel':this.storyWorld.apply({kind:'travel',destination:command.destination});break;
            case 'encounter':this.storyWorld.apply({kind:'encounter',encounter:command.encounter});break;
            case 'party-join':case 'party-leave':case 'party-control':case 'health':case 'mana':case 'equip':case 'unequip-destroy':
              this.applyActorCommand(command,this.bag,this.hero,this.party,playerState);break;
            default:throw new Error('未知剧情游戏命令');
          }
        }
        if(touched.has('playerState'))this.playerState=playerState?Object.freeze(playerState):undefined;
        if(checkpoint)this.adoptRuntime(checkpoint);
        // 没有等待中的运行、也没有本批创建的遭遇时，不复制剧情世界做链接校验。
        if(this.runtimeSnapshot.runs.some(run=>run.waiting)||commands.some(command=>command.type==='encounter'))
          this.validateStoryLinks(this.storyWorld.captureState(),this.runtimeSnapshot);
        // 收尾补齐最后一条命令造成的任务差异，再认领投影，避免随后的 emit 再算一遍。
        this.refresh();this.recordQuestProjection();this.emit();
      }catch(error){
        this.restoreStoryCommandBaseline(touched,baseline);this.pendingNotification=pending;throw error;
      }
      });
    }finally{
      if(options.deferFinalize)this.storyCommandDepth--;
    }
    if(!options.deferFinalize)active=false;
    return receipt;
  }
  /**
   * 只把玩家挪到同一张图上的新位置，不预演、不整批快照。
   *
   * 真实运行时玩家的位置由 Arcade 物理推进（`world-scene` 每帧 `movement.drive`），根本不经过
   * `applyStoryCommands`；这条通路给没有物理的调用方（测试助手逐步走位、调试传送）用同一段
   * `StoryWorldState` 簿记写位置，随后照常 `emit`，所以触发层仍按真实帧序跑。
   * 换图要改地图级的世界状态（任务可用性读 `worldValue('map')`），必须走剧情转场命令。
   */
  movePlayer(destination:TravelDestination):boolean {
    const current=this.storyWorld.currentLocation;
    if(current&&destination.map!==current.map)throw new Error('换图要走剧情转场命令');
    if(current&&current.x===destination.x&&current.y===destination.y&&current.facing===destination.facing)return false;
    this.storyWorld.apply({kind:'travel',destination});
    this.emit();
    return true;
  }
}

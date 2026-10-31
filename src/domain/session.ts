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
import type { QuestDropRequirement } from './drops.ts';
import type { ActorDefinition, CampaignEnemyPlacement, EnemySpawn, MapExit, QuestItemSpawn, QuestRewardReceipt, QuestStatus, TravelDestination, VisibilityRules, WorldMap } from './content.ts';
/** 落位修正需要的边界信息；调用方持有完整地图时直接传地图对象。 */
export type MapBoundary=Pick<WorldMap,'width'|'height'> & {exits?:readonly MapExit[]};
import type { Campaign, CampaignQuest } from './campaign.ts';
import { QuestBook, sideQuestIds, type QuestBookCheckpoint, type QuestBookState, type QuestProgress, type QuestFact, type QuestSettlement } from './quest-book.ts';
import { evaluateStoryCondition, storyConditionReferences, type StoryCondition, type StoryConditionContext, type StoryWorldValue } from './story-condition.ts';
import { StoryWorldState, type StoryWorldSnapshot } from './story-world.ts';
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
  /** 队伍物品掉率乘数（千分比）；当前内容没有已验证来源，默认 0。 */
  partyItemChance?:number;
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
  partyItemChance = 0;
  enterMap(map: string, questItemSpawns?:readonly QuestItemSpawn[], boundary?:MapBoundary,
    mapSpawns?:readonly EnemySpawn[]): void {
    const entering=this.chests.mapId!==map;
    // 进入另一张地图视为一次新访问：普通地图怪恢复满血，和原版地图刷新一致。
    // 永久死亡、任务捕捉、宝箱/遭遇怪不在这份名单里，仍按各自规则保留。
    if(entering&&mapSpawns)this.resetMapEnemies(mapSpawns);
    for(const [id,enemy] of this.enemyStates)if(enemy.capture&&
      (enemy.capture.map!==map||enemy.capture.visit!==this.storyWorld.visit))this.enemyStates.delete(id);
    if (this.chests.mapId !== map) {
      for (const spawn of this.chests.spawns) this.enemyStates.delete(spawn.id);
      if (this.chests.mapId !== undefined) {
        for (const [id, enemy] of this.enemyStates) if (enemy.deadUntil !== 'permanent') this.enemyStates.delete(id);
      }
    }
    this.chests.enterMap(map);
    this.springs.enterMap(map);
    this.shops.enterMap(map);
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
      this.enemyStates.delete(spawn.id);
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
  readonly campaign: Campaign;
  readonly questBook:QuestBook;
  readonly storyWorld = new StoryWorldState();
  private runtimeSnapshot:StoryRuntimeSnapshot = {version:2,sequence:0,runs:[],completedEvents:[],handledOccurrences:[],encounterResults:[],pendingOccurrences:[],occurrenceSequences:[]};
  private runtimeValidator?:StoryRuntime;
  private readonly receipts = new Map<string,QuestSettlement>();
  private readonly factSequences = new Map<string,number>();
  private worldContext:()=>Record<string,StoryWorldValue> = ()=>({});
  private readonly questConditionInputs:((context:StoryConditionContext)=>StoryWorldValue|undefined)[]=[];
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
  private transactionDepth = 0;
  private pendingNotification = false;
  get restorationVersion():number { return this.restoreRevision; }
  private coins = 0;
  get money():number { return this.coins; }
  gainMoney(amount:number):void {
    if(!Number.isSafeInteger(amount)||amount<0||!Number.isSafeInteger(this.coins+amount))throw new Error('金币数量无效');
    this.coins+=amount;this.emit();
  }
  spendMoney(amount:number):void {
    if(!Number.isSafeInteger(amount)||amount<0||amount>this.coins)throw new Error('金币不足');
    this.coins-=amount;this.emit();
  }
  private readonly enemyStates = new Map<string, EnemyState>();
  private trackedQuest?: string;
  private debugFocusQuestValue?: string;
  /** 任务组的主线／支线归属；NPC 任务槽按原版先主线后支线的顺序取。 */
  private readonly questGroupKinds: ReadonlyMap<string, 'main' | 'side'>;
  private questSlotProjection?: { version: number; focus?: string; values: Map<string, CampaignQuest | undefined> };
  /** 角色头顶的任务标记按任务簿版本缓存；版本不变时交互候选不必重扫全部任务。 */
  private markerActorProjection?: { version: number; focus?: string; values: Map<string, boolean> };
  /** GM 任务调试的焦点；任务面板据此只列出当前任务。 */
  get debugFocusQuest():string|undefined { return this.debugFocusQuestValue; }
  focusDebugQuest(id:string|undefined):void { this.debugFocusQuestValue=id; this.emit(); }
  private playerState?: Readonly<StoryPlayerState>;
  get player():Readonly<StoryPlayerState>|undefined { return this.hero?.player ?? this.playerState; }
  setHealth(value:number):void {
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
  questDropRequirements(pending:ReadonlyMap<string,number>=new Map()):readonly (readonly QuestDropRequirement[])[] {
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

  /** 任务列表的只读投影；同一任务簿版本内返回同一份，调用方不得改写。 */
  get quests():ReadonlyMap<string,Readonly<QuestProgress & {count:number}>> {
    const questVersion=this.questBook.version,cached=this.questsProjection;
    if(cached?.questVersion===questVersion)return cached.value;
    const value=new Map(this.questBook.captureState().quests.map(([id,state])=>[id,Object.freeze({...state,count:Object.values(state.goals).reduce((sum,count)=>sum+count,0)})]));
    this.questsProjection={questVersion,value};
    return value;
  }
  get flags():ReadonlySet<string> { return this.storyWorld.flagIds; }
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
    hero?.setSkillUseHandler((item,skill)=>this.skills.applyItem(item,skill));
    this.party=hero&&items&&stats&&companions?new PartyRoster(hero,stats,items,companions,()=>this.emit(),id=>{this.cooldowns.removeActor(id);this.frenzyAnimations.removeActor(id);},
      sourceItem=>this.recordQuestFact('recruit',sourceItem,'recruit'),operation=>this.atomicPartyChange(operation)):undefined;
    this.bag = hero?.bag ?? new Bag(()=>this.emit(),items,character?.classId,items?'game':'none');
    const inputs={events:new Set<string>(),choices:new Set<string>(),flags:new Set<string>(),world:new Set<string>()};
    for(const quest of campaign.quests){
      const references=storyConditionReferences(quest.availableWhen);
      for(const key of Object.keys(inputs) as (keyof typeof inputs)[])for(const id of references[key])inputs[key].add(id);
    }
    for(const id of inputs.events)this.questConditionInputs.push(context=>context.eventStatus(id));
    for(const id of inputs.choices)this.questConditionInputs.push(context=>context.choice(id));
    for(const id of inputs.flags)this.questConditionInputs.push(context=>context.flag(id));
    for(const key of inputs.world)this.questConditionInputs.push(context=>context.world(key));
    this.questBook=new QuestBook(this.campaign.quests,()=>this.questContext(),sideQuestIds(this.campaign.questGroups));
    hero?.subscribe(()=>this.emit());
    this.refresh();
  }
  private questContext() {
    return {...this.conditionContext(),classId:this.hero?.classId??this.character?.classId,itemCount:(id:string)=>this.itemCount(id),
      equippedItemCount:(item:string)=>Object.values(this.bag.equipmentItems(this.bag.equipmentFor(this.party?.controlledId??'player'))).filter(id=>id===item).length};
  }
  private atomicPartyChange<T>(operation:()=>T):T {
    const before=this.captureState(),pending=this.pendingNotification;
    return this.transaction(()=>{
      try{return operation();}
      catch(error){this.restoreUnchecked(before);this.pendingNotification=pending;throw error;}
    });
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
  get runtimeState():StoryRuntimeSnapshot {return structuredClone(this.runtimeSnapshot);}
  set runtimeState(value:StoryRuntimeSnapshot) {
    const next=this.prepareRuntime(value);this.validateStoryLinks(this.storyWorld.captureState(),next);this.runtimeSnapshot=next;
  }
  private prepareRuntime(snapshot:StoryRuntimeSnapshot):StoryRuntimeSnapshot {
    const runtime=this.runtimeValidator??=new StoryRuntime(this.campaign,{prepare:async()=>{},capture:()=>undefined,present:async()=>({}),finish:async()=>{},
      commit:()=>{},rollback:()=>{},evaluate:condition=>this.evaluateCondition(condition)});
    return runtime.prepareRestore(snapshot);
  }
  evaluateCondition(condition:StoryCondition,commands:readonly StoryCommand[]=[]):boolean {
    if(!commands.length)return evaluateStoryCondition(condition,this.conditionContext());
    const preview=this.planStoryCommands(commands);
    const states=preview.questBook.progressEntries();
    return evaluateStoryCondition(condition,{...this.conditionContext(),questStatus:id=>states.get(id)?.status??'locked',
      questCompletedCycles:id=>states.get(id)?.completedCycles??0,flag:id=>preview.world.flags.includes(id),
      choice:id=>preview.world.choices.find(([key])=>key===id)?.[1],
      world:key=>key==='map'?preview.world.location?.map??this.worldContext()[key]:this.worldContext()[key]});
  }
  /** 调试准备在独立会话中执行，安装之前不会通知正式导演。 */
  createStorySandbox():Session {
    const hero=this.hero&&this.stats?new BattleCharacter(this.hero.classId,this.stats,this.bag.catalog):undefined;
    return new Session(this.campaign,this.playerState,this.character,this.bag.catalog,hero,this.battle,this.stats,this.companions);
  }

  captureState():SessionState { return this.captureStateWith(this.questBook.captureState()); }
  /** 存档用：GM 调试钉住只是现场状态；舞台演员外观也不是持久数据，写档前剥离。 */
  capturePersistentState():SessionState {
    const state=this.captureState();
    if(state.questBook.debugPins?.length)delete state.questBook.debugPins;
    delete state.debugFocusQuest;
    state.runtime=toPlaybackCheckpoint(state.runtime);
    return state;
  }
  /**
   * 批次失败时的回滚基线：任务簿改用 O(1) 检查点，占位里只保留会话级的事实序号镜像。
   *
   * `rollbackBatch` 会走 `QuestBook.rollbackTo`，所以这里的 `questBook` 占位不参与恢复；
   * 存档、检查点与导演节点基线仍用完整的 `captureState()`。
   */
  captureBatchBaseline():{state:SessionState;quests:QuestBookCheckpoint} {
    return {quests:this.questBook.checkpoint(),
      state:this.captureStateWith({version:5,quests:[],runningQuestIds:[],factSequences:[...this.factSequences]})};
  }
  rollbackBatch(baseline:{state:SessionState;quests:QuestBookCheckpoint}):void { this.restoreUnchecked(baseline.state,baseline.quests); }
  private captureStateWith(questBook:QuestBookState):SessionState {
    // 各子系统自己的 `captureState()` 已经返回新对象，这里只对**按引用共享**的三项做深拷贝：
    // 运行时快照、奖励收据与敌人状态（`player` 是冻结值，标量与字符串不可变）。
    // 省掉外层那份整会话克隆——它连 505 条任务状态一起复制，是死亡结算的一项固定开销。
    return {classId:this.hero?.classId??this.character?.classId,
      questBook,storyWorld:this.storyWorld.captureState(),runtime:structuredClone(this.runtimeSnapshot),
      receipts:[...this.receipts.values()].map(receipt=>structuredClone(receipt)),
      factSequences:[...this.factSequences],trackedQuest:this.trackedQuest,debugFocusQuest:this.debugFocusQuestValue,player:this.playerState,money:this.coins,gameTimeMs:this.gameTimeMs,
      enemies:[...this.enemyStates].map(([id,enemy])=>[id,structuredClone(enemy)]),bag:this.bag.captureState(),hero:this.hero?.captureState(),skills:this.skills.captureState(),
      party:this.party?.captureState(),recovery:this.recovery.captureState(),resourceRecovery:this.resourceRecovery.captureState(),
      combatClock:this.combatClock.captureState(),cooldowns:this.cooldowns.captureState(),frenzyAnimations:this.frenzyAnimations.captureState(),chests:this.chests.captureState(),springs:this.springs.captureState(),legendaryWeapons:this.legendaryWeapons.captureState(),shops:this.shops.captureState(),
      questItemGeneration:this.questItemGenerators.captureState(),groundLoot:groundLootFor(this).captureState(),
      lootPity:this.lootPity.captureState(),partyItemChance:this.partyItemChance};
  }
  private restoreUnchecked(restored:SessionState,quests?:QuestBookCheckpoint):void {
    this.questProjection=undefined;this.questsProjection=undefined;
    // 回滚与校验后的恢复都走这里：状态已经过 validateInventoryState，重验只会让错误处理
    // 自己抛错、把真正的异常盖掉。
    this.bag.restoreUnchecked(restored.bag);
    if(restored.hero)this.hero!.restoreState(restored.hero);
    this.skills.restoreState(restored.skills);
    if(restored.party)this.party!.restoreState(restored.party);
    // 批次回滚走 O(1) 检查点；存档/检查点恢复仍走带校验的 `restoreState`。
    if(quests)this.questBook.rollbackTo(quests);else this.questBook.restoreState(restored.questBook);
    this.storyWorld.restoreState(restored.storyWorld);
    this.runtimeSnapshot=structuredClone(restored.runtime);
    this.receipts.clear();for(const receipt of restored.receipts)this.receipts.set(JSON.stringify([receipt.quest,receipt.cycle]),structuredClone(receipt));
    this.factSequences.clear();for(const [source,sequence]of restored.factSequences)this.factSequences.set(source,sequence);
    this.enemyStates.clear();for(const [id,enemy] of restored.enemies)this.enemyStates.set(id,enemy);
    this.trackedQuest=restored.trackedQuest;this.debugFocusQuestValue=restored.debugFocusQuest;this.playerState=restored.player?Object.freeze({...restored.player}):undefined;
    this.coins=restored.money;this.gameTimeMs=restored.gameTimeMs;
    this.recovery.restoreState(restored.recovery);this.chests.restoreState(restored.chests);this.springs.restoreState(restored.springs);this.legendaryWeapons.restoreState(restored.legendaryWeapons);this.shops.restoreState(restored.shops);
    const clock=restored.combatClock??{frame:Math.floor(restored.resourceRecovery.elapsedMs/LOGIC_FRAME_MS),remainderMs:restored.resourceRecovery.elapsedMs%LOGIC_FRAME_MS};
    this.combatClock.restoreState(clock);this.cooldowns.restoreState(restored.cooldowns??{actors:[]});
    this.frenzyAnimations.restoreState(restored.frenzyAnimations??[]);
    this.resourceRecovery.restoreState({...restored.resourceRecovery,elapsedMs:clock.frame*LOGIC_FRAME_MS});groundLootFor(this).restoreState(restored.groundLoot);
    this.questItemGenerators.restoreState(restored.questItemGeneration,groundLootFor(this));
    this.lootPity.restoreState(restored.lootPity??{version:2,members:[],chests:[],bossDefeats:[]});
    this.partyItemChance=restored.partyItemChance??0;
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
    this.transaction(()=>{
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
      this.questItemGenerators.advance(frame,quest=>this.status(quest)==='active',groundLootFor(this));
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
  removeStoryEnemy(id:string):void {
    this.storyWorld.apply({kind:'remove',id});
    this.enemyStates.set(id,{...this.enemyStates.get(id),health:0,deadUntil:'permanent'});
    this.emit();
  }
  setEnemyVitals(id:string,health:number,mana:number):void {
    this.enemyStates.set(id,{...this.enemyStates.get(id),health,mana});
  }
  canSpawnEnemy(spawn:EnemySpawn|CampaignEnemyPlacement):boolean {
    if('activeQuest' in spawn&&this.status(spawn.activeQuest)!=='active')return false;
    if(!this.storyWorld.visible(spawn.id))return false;
    const state=this.enemyStates.get(spawn.id);
    if(state?.deadUntil===undefined)return true;
    if(state.deadUntil==='permanent'||this.gameTimeMs<state.deadUntil)return false;
    this.enemyStates.delete(spawn.id);return true;
  }
  /** 类型 3 任务把低血量的怪物变成同格可交互角色，交互之后才记目标次数。 */
  weakenQuestTarget(enemyId:string,source:{id:string;map:string;x:number;y:number}):boolean {
    const match=this.campaign.quests.flatMap(quest=>this.status(quest.id)==='active'
      ?(quest.targetChanges??[]).filter(change=>change.enemyId===enemyId&&
        (this.questBook.state(quest.id)?.goals[change.goal]??0)<(quest.goals.find(goal=>goal.id===change.goal)?.quantity??0))
        .map(change=>({quest,change})):[])[0];
    if(!match||!this.canSpawnEnemy({...source,enemyId}))return false;
    this.transaction(()=>{
      this.applyStoryCommands([
        // 捕捉目标只在这次进图有效：`place` 按 `scope` 决定访问寿命，传进命令里的 `mapVisit`
        // 会被它覆盖；不带 scope 的话，离图后 NPC 还留在世界里，可捕捉状态却已随进图清掉。
        {type:'world',command:{kind:'place',scope:'visit',entity:{id:'quest-target:'+source.id,map:source.map,actor:match.change.actor,
          characterId:match.quest.goals.find(goal=>goal.id===match.change.goal)?.characterId,authority:'story',
          x:source.x,y:source.y,visible:true,hint:match.change.interactText||match.change.changedText}}},
      ]);
      // 转换不会调用原版死亡重置；本次地图仍占用源槽，离图后重新登记。
      this.enemyStates.set(source.id,{health:1,deadUntil:'permanent',capture:{map:source.map,visit:this.storyWorld.visit}});
      this.emit();
    });
    return true;
  }
  enemyDefeated(spawn:EnemySpawn|CampaignEnemyPlacement,respawnMs=DEFAULT_ENEMY_RESPAWN_MS):boolean {
    if(this.enemyStates.get(spawn.id)?.deadUntil!==undefined)return false;
    if('activeQuest' in spawn&&this.status(spawn.activeQuest)!=='active')return false;
    this.transaction(()=>{
      const commands:StoryCommand[]=[{type:'quest',command:{type:'fact',fact:this.nextQuestFact('defeat',spawn.enemyId,'combat')}}];
      if('activeQuest' in spawn)commands.push({type:'item-give',item:spawn.rewardItem,quantity:1});
      this.applyStoryCommands(commands);
      this.enemyStates.set(spawn.id,{deadUntil:spawn.respawn===false?'permanent':this.gameTimeMs+respawnMs});
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
  transaction<T>(operation:()=>T):T {
    this.transactionDepth++;
    try{return operation();}
    finally{this.transactionDepth--;if(!this.transactionDepth&&this.pendingNotification){this.pendingNotification=false;this.emit();}}
  }
  emit(): void {
    if(this.transactionDepth){this.pendingNotification=true;return;}
    this.refresh(); for (const listener of this.listeners) listener(this);
  }
  refresh():void {
    if(!this.questBook)return;
    const questVersion=this.questBook.version,bagVersion=this.bag.revision,owner=this.party?.controlledId??'player';
    const context=this.questConditionInputs.length?this.conditionContext():undefined;
    const conditions=this.questConditionInputs.map(read=>read(context!)),previous=this.questProjection;
    if(previous&&previous.questVersion===questVersion&&previous.bagVersion===bagVersion&&previous.owner===owner&&
      conditions.every((value,index)=>Object.is(value,previous.conditions[index])))return;
    this.questBook.commit(this.questBook.plan({type:'refresh'}));
    // 任务计划自身可能改变版本；下一次读取应复用刚提交的投影。
    this.recordQuestProjection();
  }
  /** 记下这次任务投影的输入，供 `refresh` 判断结果能不能复用。 */
  private recordQuestProjection():void {
    const context=this.questConditionInputs.length?this.conditionContext():undefined;
    this.questProjection={questVersion:this.questBook.version,bagVersion:this.bag.revision,
      owner:this.party?.controlledId??'player',conditions:this.questConditionInputs.map(read=>read(context!))};
  }
  definition(id:string):CampaignQuest|undefined{return this.campaign.quests.find(quest=>quest.id===id);}
  status(id:string):QuestStatus{return this.questBook?.status(id)??'locked';}
  rewardReceiptFor(id:string,cycle?:number):QuestRewardReceipt|undefined {
    const receipt=cycle===undefined?[...this.receipts.values()].filter(value=>value.quest===id).at(-1):this.receipts.get(JSON.stringify([id,cycle]));
    return receipt?structuredClone(receipt.reward):undefined;
  }
  accept(id:string):boolean {
    this.refresh();if(this.status(id)!=='available')return false;
    this.applyStoryCommands([{type:'quest',command:{type:'accept',quest:id,cycle:this.questBook.state(id)!.cycle}}]);return true;
  }
  /**
   * 进行中的任务里指到这个目标的目标。`talk` 与 `interact` 两类目标导出后都落在 NPC 的 `actor`
   * 上（与摆放点 `objective` 的写法同一口径），对玩家是同一件事：走过去跟它交互。
   */
  private waitingGoals(target:string,characterId?:string):{kind:'talk'|'interact';target:string}[] {
    const goals:{kind:'talk'|'interact';target:string}[]=[];
    for(const quest of this.campaign.quests){
      if(this.status(quest.id)!=='active')continue;
      for(const goal of quest.goals)
        if((characterId!==undefined&&goal.characterId!==undefined?goal.characterId===characterId:goal.target===target)
          &&(goal.kind==='talk'||goal.kind==='interact'))goals.push({kind:goal.kind,target:goal.target});
    }
    return goals;
  }
  /**
   * 摆放点这次交互能不能推进任务：`objective` 声明的目标或 NPC 自己的 `actor`，
   * 只要有一条进行中的任务指着它就算。场景用它把没有别的用途的摆放点也算成可交互对象。
   */
  canInteract(target:string,_instance:string,characterId?:string):boolean {
    return this.waitingGoals(target,characterId).length>0;
  }
  /**
   * 玩家跟一个目标交互一次。原版里「去跟某人说话」「去对某个东西用一次」本身就是任务目标：
   * 进行中任务里指到这个目标的按类型各记一次事实，任务日志与头顶标记随之更新。
   * 剧情事件接管这次交互时由剧情脚本自己推进目标，这里不记账（见 `StoryDirector.interact`）。
   */
  interact(target:string,instance:string,characterId?:string):boolean {
    if(instance.startsWith('quest-target:')){
      const source=this.enemyStates.get(instance.slice('quest-target:'.length))?.capture,entity=this.storyWorld.entity(instance);
      if(!source||source.visit!==this.storyWorld.visit||!entity||!this.storyWorld.visible(instance))return false;
    }
    const kinds=[...new Set(this.waitingGoals(target,characterId).map(goal=>goal.kind))];
    if(!kinds.length)return false;
    const remove=instance.startsWith('quest-target:')&&this.campaign.quests.some(quest=>this.status(quest.id)==='active'
      &&quest.targetChanges?.some(change=>change.actor===target&&change.removeAfterInteraction));
    const commands:StoryCommand[]=[
      ...kinds.map(kind=>({type:'quest' as const,
        command:{type:'fact' as const,fact:{...this.nextQuestFact(kind,target,kind==='interact'?'interaction':'talk'),...(characterId?{characterId}:{})}}})),
    ];
    if(remove)commands.push({type:'world',command:{kind:'remove',id:instance}});
    this.transaction(()=>{
      this.applyStoryCommands(commands);
    });
    return true;
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
  pinDebugQuest(id:string):void { this.questBook.pinDebug(id); this.refresh(); }
  unpinDebugQuest(id:string):void { this.questBook.unpinDebug(id); this.refresh(); }
  mark(flag:string):void {this.applyStoryCommands([{type:'flag',flag}]);}
  visible(entity:VisibilityRules & {condition?:StoryCondition}):boolean {
    return this.storyWorld.visible(entity.id)&&evaluateStoryCondition(entity.condition,this.conditionContext());
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
      &&(!!focus||this.questBook.visible(quest.id))&&['ready','available','active'].includes(this.status(quest.id)))
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
    // 待交付包含隐藏任务：它们同样在运行池里，原版第一段循环不会因为日志不可见而跳过。
    for(const id of this.questBook.runningQuestIds){
      if(this.status(id)!=='ready')continue;
      const quest=this.definition(id);
      if(quest&&this.matchesQuestActor(quest,actor,characterId,true))return quest;
    }
    const available=this.campaign.quests.filter(quest=>this.status(quest.id)==='available'
      &&this.questBook.visible(quest.id)&&this.matchesQuestActor(quest,actor,characterId,false));
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
   * 两种：**隐藏任务**不进任务日志（`forActor` 因此看不到），但它由剧情事件接取后，原版同样要在
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
      &&!this.questBook.visible(quest.id));
  }
  marker(actor:string,characterId?:string):QuestStatus|null {const quest=this.npcQuestSlot(actor,characterId);return quest?this.status(quest.id):null;}
  /**
   * 头顶该不该给这个角色／物件挂标记。看的是「有没有**日志可见**的任务把这里当发布者或交付对象」：
   * 隐藏任务（如 #50 的矿洞路障）不进日志，也就不该在场景里提示玩家去点它。
   * 调试焦点只看焦点任务：前置任务的人物不挂标记。
   */
  markerActor(actor:string,characterId?:string):boolean {
    const version=this.questBook.version,focus=this.debugFocusQuestValue,cached=this.markerActorProjection;
    if(!cached||cached.version!==version||cached.focus!==focus)this.markerActorProjection={version,focus,values:new Map()};
    const values=this.markerActorProjection!.values,key=actor+'\0'+(characterId??'');
    if(!values.has(key)){
      const visibleFocus=!!focus;
      values.set(key,this.campaign.quests.some(quest=>{
        const status=this.status(quest.id);
        if(!['available','active','ready'].includes(status))return false;
        return (!focus||quest.id===focus)
          &&this.matchesQuestActor(quest,actor,characterId,status!=='available')
          &&(visibleFocus||this.questBook.visible(quest.id));
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
    if(this.trackedQuest&&this.questBook.visible(this.trackedQuest)&&['active','ready'].includes(this.status(this.trackedQuest)))return this.definition(this.trackedQuest);
    return this.campaign.quests.find(quest=>this.questBook.visible(quest.id)&&['active','ready'].includes(this.status(quest.id)))??
      this.campaign.quests.find(quest=>this.questBook.visible(quest.id)&&this.status(quest.id)==='available');
  }
  trackQuest(id:string):boolean {
    const focus=this.debugFocusQuestValue;
    if(focus&&id!==focus)return false;
    if((!focus&&!this.questBook.visible(id))||!['active','ready'].includes(this.status(id)))return false;
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
  private planStoryCommands(commands:readonly StoryCommand[]) {
    const world=new StoryWorldState();world.restoreState(this.storyWorld.captureState());
    const loot=new GroundLootStore();loot.restoreState(groundLootFor(this).captureState());
    const hero=this.hero?new BattleCharacter(this.hero.classId,this.hero.catalog,this.bag.catalog):undefined;
    const bag=hero?.bag??new Bag(()=>{},this.bag.catalog,this.bag.classId,'none');bag.restoreState(this.bag.captureState());
    if(hero)hero.restoreState(this.hero!.captureState());
    const party=this.party&&hero?new PartyRoster(hero,hero.catalog,this.bag.catalog,this.party.catalog,()=>{}):undefined;
    if(party)party.restoreState(this.party!.captureState());
    const fallback=this.playerState?structuredClone(this.playerState):undefined;
    // 金币与背包一样要在这遍预算里先算：同一批命令里「先给后取」要能通过，不足则整批不落地。
    let coins=this.coins;
    const receipts:QuestSettlement[]=[],rewardsByCommand=new Map<number,readonly QuestSettlement[]>(),itemsByCommand=new Map<number,{grants:readonly {item:string;quantity:number}[];removals:readonly {item:string;quantity:number}[]}>();
    // 沙盒与真实任务簿共享同一份不可变状态根：预演改状态是换条目，碰不到来源簿（见 `QuestBook.fork`）。
    const book=this.questBook.fork(()=>({...this.questContext(),classId:hero?.classId??this.character?.classId,itemCount:id=>bag.count(id),
      equippedItemCount:item=>Object.values(bag.equipmentItems(bag.equipmentFor(party?.controlledId??'player'))).filter(id=>id===item).length,
      flag:id=>world.hasFlag(id),choice:id=>world.choice(id),world:key=>this.worldValue(world,key)}));
    for(const [commandIndex,command]of commands.entries()){
      switch(command.type){
        case 'quest':{
          const plan=book.plan(command.command);
          for(const item of plan.itemRemovals)if(!bag.remove(item.item,item.quantity))throw new Error('剧情物品不足');
          const grants:{item:string;quantity:number}[]=[];
          for(const item of plan.itemGrants){bag.add(item.item,item.quantity);grants.push(item);}
          for(const receipt of plan.rewards){if(receipt.reward.experience)hero?.addExperience(receipt.reward.experience);coins+=receipt.reward.money;}
          book.commit(plan);receipts.push(...plan.rewards);rewardsByCommand.set(commandIndex,plan.rewards);
          itemsByCommand.set(commandIndex,{grants,removals:plan.itemRemovals});break;
        }
        case 'interaction':{
          if(!command.target||!command.instance)throw new Error('剧情交互目标无效');
          const sequence=book.factSequence('interaction')+1;
          book.commit(book.plan({type:'fact',fact:{kind:'interact',target:command.target,occurrence:{source:'interaction',sequence}}}));break;
        }
        case 'talk':{
          if(!command.target)throw new Error('剧情对话目标无效');
          const sequence=book.factSequence('talk')+1;
          book.commit(book.plan({type:'fact',fact:{kind:'talk',target:command.target,occurrence:{source:'talk',sequence}}}));break;
        }
        case 'item-give':case 'item-take':
          if(!Number.isSafeInteger(command.quantity)||command.quantity<=0)throw new Error('剧情物品数量无效');
          if(command.type==='item-give')bag.add(command.item,command.quantity);
          else if(!(command.allowPartial&&bag.count(command.item)===0)&&!bag.remove(command.item,command.allowPartial?Math.min(command.quantity,bag.count(command.item)):command.quantity))throw new Error('剧情物品不足');break;
        case 'money-give':case 'money-take':{
          if(!Number.isSafeInteger(command.amount)||command.amount<=0)throw new Error('剧情金币数量无效');
          if(command.type==='money-take'){
            if(command.amount>coins&&!command.allowPartial)throw new Error('剧情金币不足');
            coins=Math.max(0,coins-command.amount);
          }else{ if(!Number.isSafeInteger(coins+command.amount))throw new Error('剧情金币数量无效'); coins+=command.amount; }
          break;
        }
        case 'item-drop':
          if(!this.bag.catalog.items[command.item]||!Number.isSafeInteger(command.quantity)||command.quantity<=0||!Number.isFinite(command.x)||!Number.isFinite(command.y))throw new Error('剧情地面物品无效');
          loot.add(command.map??world.currentLocation?.map??this.campaign.start.map,command.x,command.y,[{kind:'item',item:command.item,quantity:command.quantity}]);
          break;
        case 'flag':world.apply({kind:'flag',id:command.flag,value:command.value??true});break;
        case 'choice':world.apply({kind:'choice',id:command.choice,value:command.value});break;
        case 'world':world.apply(command.command);break;
        case 'travel':world.apply({kind:'travel',destination:command.destination});break;
        case 'encounter':world.apply({kind:'encounter',encounter:command.encounter});break;
        case 'party-join':case 'party-leave':case 'party-control':case 'health':case 'mana':case 'equip':case 'unequip-destroy':
          this.applyActorCommand(command,bag,hero,party,fallback);break;
        default:throw new Error('未知剧情游戏命令');
      }
    }
    // 每条 quest 命令都以 `refresh()` 收尾（见 `QuestBook.plan`），所以末尾是 quest 命令时这一步多余；
    // 末尾是别的命令（改了背包或世界）才需要重算物品类目标。
    if(commands.at(-1)?.type!=='quest')book.commit(book.plan({type:'refresh'}));
    return {questBook:book,world:world.captureState(),loot:loot.captureState(),receipts,rewardsByCommand,itemsByCommand};
  }
  applyStoryCommands(commands:readonly StoryCommand[],checkpoint?:StoryRuntimeSnapshot):void {
    const plan=this.planStoryCommands(commands),nextRuntime=checkpoint?this.prepareRuntime(checkpoint):undefined;
    this.validateStoryLinks(plan.world,nextRuntime??this.runtimeSnapshot);
    // 批次回滚基线：任务簿用 O(1) 检查点，其余子系统照旧。见 `captureBatchBaseline`。
    const before=this.captureBatchBaseline(),pending=this.pendingNotification;
    this.transaction(()=>{
      try{
        const fallback=this.playerState?structuredClone(this.playerState):undefined;
        for(const [commandIndex,command]of commands.entries()){
          const items=plan.itemsByCommand.get(commandIndex);
          for(const item of items?.removals??[])if(!this.bag.remove(item.item,item.quantity))throw new Error('剧情物品交付失败');
          for(const item of items?.grants??[])this.bag.add(item.item,item.quantity);
          if(command.type==='item-give')this.bag.add(command.item,command.quantity);
          if(command.type==='item-take'&&!(command.allowPartial&&this.bag.count(command.item)===0)&&!this.bag.remove(command.item,command.allowPartial?Math.min(command.quantity,this.bag.count(command.item)):command.quantity))throw new Error('剧情物品交付失败');
          if(command.type==='money-give')this.gainMoney(command.amount);
          if(command.type==='money-take')this.spendMoney(command.allowPartial?Math.min(command.amount,this.coins):command.amount);
          for(const receipt of plan.rewardsByCommand.get(commandIndex)??[]){
            const key=JSON.stringify([receipt.quest,receipt.cycle]);if(this.receipts.has(key))throw new Error('任务奖励已结算');
            if(receipt.reward.experience)this.hero?.addExperience(receipt.reward.experience);
            if(receipt.reward.money)this.gainMoney(receipt.reward.money);this.receipts.set(key,structuredClone(receipt));
          }
          this.applyActorCommand(command,this.bag,this.hero,this.party,fallback);
        }
        if(fallback)this.playerState=Object.freeze(fallback);
        // 直接把沙盒那份状态根接过来：它是预演沙盒改出来的、出自同一份任务定义；
        // 失败回滚用的 `before` 与读档仍走带校验的 `prepareRestore`。
        this.questBook.adopt(plan.questBook);this.storyWorld.restoreState(plan.world);groundLootFor(this).restoreState(plan.loot);
        if(nextRuntime)this.runtimeSnapshot=nextRuntime;
        for(const [source,sequence]of plan.questBook.factSequenceEntries())this.factSequences.set(source,sequence);
        // 沙盒收尾时已经用批后的背包与世界算过一遍，装进来的就是定点：直接认领这次投影，
        // 免得紧跟其后的 `emit → refresh` 再跑一次全量任务计划。
        this.recordQuestProjection();
        this.emit();
      }catch(error){this.rollbackBatch(before);this.pendingNotification=pending;throw error;}
    });
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

import type { PlacedEnemy, EnemyDefinition } from './battle.ts';
import { EnemyRoster } from './enemy-roster.ts';
import type { CampaignEnemyPlacement, EnemySpawn, QuestItemSpawn, QuestStatus, WorldMap } from './content.ts';
import { encounterSpawnId, type StoryEncounter } from './story-world.ts';
import { BREAKABLE_ENEMY_IDS } from './drops.ts';

export { encounterSpawnId } from './story-world.ts';

/** 地图敌人名册所需的最小会话端口；由 `Session` 结构兼容，保持零双向导入。 */
export interface WorldEnemySessionPort {
  enterMap(map: string, questItemSpawns?: readonly QuestItemSpawn[], boundary?: WorldMap, mapSpawns?: readonly EnemySpawn[]): void;
  readonly party?: { readonly activeSize: number };
  readonly hero?: { readonly level: number };
  readonly storyWorld: {
    readonly revision: number;
    readonly encounterRevision: number;
    readonly activeEncounters: readonly StoryEncounter[];
    visible(id: string): boolean;
    enemyAvailable(map: string, enemyId: string): boolean;
    enemySpawns(map: string): EnemySpawn[];
  };
  readonly questBook: {
    readonly version: number;
    readonly runningQuestIds: readonly string[];
    status(id: string): QuestStatus;
  };
  readonly chests: {
    readonly revision: number;
    readonly spawns: readonly EnemySpawn[];
  };
  readonly enemySpawnRevision: number;
  readonly nowMs: number;
  status(id: string): QuestStatus;
  enemyVitals(id: string): Readonly<{ health?: number; mana?: number; deadUntil?: number | 'permanent'; offscreenRespawnAt?: number; capture?: unknown }>;
  setEnemyVitals(id: string, health: number, mana: number): void;
  canRespawnEnemy(spawn: EnemySpawn | CampaignEnemyPlacement, offscreen?: boolean): boolean;
  clearEnemyDefeat(id: string, offscreen?: boolean): boolean;
}

/** 剧情批量清怪所需的最小会话端口；由 `Session` 结构兼容。 */
export interface StoryEnemyRemovalSessionPort {
  readonly storyWorld: {
    readonly activeEncounters: readonly StoryEncounter[];
    readonly pendingEnemyRemovals: readonly { enemyId: string; map?: string; all: boolean }[];
    consumeEnemyRemovals(consumed?: (command: { enemyId: string; map?: string; all: boolean }) => boolean): void;
  };
  recordStoryDefeat(enemyId: string): void;
  removeStoryEnemy(id: string): void;
}

type WorldSpawn = EnemySpawn | CampaignEnemyPlacement;

/** 可破坏景物替换成特殊敌人的百分比权重：5% 出本类景物，7% 出箱子。 */
const BREAKABLE_SPECIAL_ENEMY_PERCENT = 5;
const BREAKABLE_BOX_PERCENT = 7;
/** 权重骰按 0..99 的百分比抽取。 */
const PERCENT_SCALE = 100;

export interface QuestEnemySnapshot {
  revision: number;
  ids: ReadonlySet<string>;
}

/** 任务关键敌人的只读来源；由组合根提供，名册不依赖战役与掉落目录。 */
export interface QuestEnemyProvider {
  snapshot(): QuestEnemySnapshot;
}

/** 主镜头的地图坐标范围；边缘缓冲也以地图像素计。 */
export interface EnemyRespawnView {x:number;y:number;width:number;height:number}
export const ENEMY_RESPAWN_VIEW_MARGIN_PX=48;
/** One map's enemy roster. Stable spawn IDs and combat resources live in Session. */
export class WorldEnemyRoster extends EnemyRoster {
  readonly session:WorldEnemySessionPort;
  private readonly mapId:string;
  private readonly rawMapSpawns:readonly WorldSpawn[];
  private readonly staticSpawns:readonly WorldSpawn[];
  private readonly questEnemies?:QuestEnemyProvider;
  private readonly breakableSpawn?:'bush'|'jar';
  /** 生产场景传 Math.random；测试和离线验证默认不替换，结果稳定可复现。 */
  private readonly random:()=>number;
  /** 本次进图每个静态生成槽的替换结果；槽位真正离场时清掉，重新掷。 */
  private readonly breakableRolls=new Map<string,string>();
  /** 可能被可破坏物替换的静态槽，按生成点 id 索引；恢复名册时据此对齐替换结果。 */
  private readonly breakableSlots:ReadonlyMap<string,WorldSpawn>;
  /** 本次进图累计出现过的任务关键敌人；本次访问内保持原怪不被可破坏景物替换。 */
  private readonly questSpawnIds=new Set<string>();
  /** 地图静态刷怪槽和战役追加槽；只有这些槽允许任务目标豁免剧情移除。 */
  private readonly staticSpawnIds:ReadonlySet<string>;
  /** 可破坏物替换结果的版本：缓存重建后必须重新掷骰。 */
  private breakableRevision=0;
  private spawnsCache?:{sources:ReadonlyMap<string,WorldSpawn>;revision:number;value:readonly WorldSpawn[]};
  private sourceProjection?:{story:number;chests:number;quests:number;sources:ReadonlySet<string>|undefined;size:number;byId:ReadonlyMap<string,WorldSpawn>};
  private spawnIndex?:{spawns:readonly WorldSpawn[];byId:ReadonlyMap<string,WorldSpawn>};
  private membershipRevision=0;
  /**
   * 完成遭遇的判定缓存。遭遇增删/结算、敌人死亡或捕获、名册整份恢复都会改变对应修订号；
   * 当前只按这些变化失效，不按渲染帧重算。
   */
  private completedCache?:{encounterRevision:number;enemySpawnRevision:number;membershipRevision:number;value:readonly StoryEncounter[]};
  private lastRefresh?:{spawns:readonly WorldSpawn[];enemyRevision:number;questVersion:number;membershipRevision:number;members:ReadonlySet<string>;nextSpawnAt:number};
  private readonly offscreenWaiting=new Map<string,WorldSpawn>();
  private respawnView?:EnemyRespawnView;
  private questSourceRevision?:number;
  private questSourceIds?:ReadonlySet<string>;
  private emptyReported=false;
  private presenceVersion=0;
  private presenceInputs?:{story:number;quest:number;deaths:number;members:number;chests:number;breakables:number;sources:ReadonlySet<string>|undefined};
  get spawns(): readonly WorldSpawn[] {
    const sources=this.projectedSources();
    const cached=this.spawnsCache;
    if(cached?.sources===sources&&cached.revision===this.breakableRevision)return cached.value;
    const value=[...sources.values()].map(spawn=>this.staticSpawnIds.has(spawn.id)?this.breakableSpawnFor(spawn):spawn);
    this.spawnsCache={sources,revision:this.breakableRevision,value};
    return value;
  }
  private readonly sources = new Map<string,WorldSpawn>();
  constructor(session:WorldEnemySessionPort,map:WorldMap,questSpawns:readonly CampaignEnemyPlacement[],
    questEnemies?:QuestEnemyProvider,random:()=>number=()=>1){
    super();
    this.session=session;
    this.mapId=map.id;
    this.questEnemies=questEnemies;
    this.breakableSpawn=map.breakableSpawn;
    this.random=random;
    this.rawMapSpawns=map.enemySpawns??[];
    this.staticSpawns=[...this.rawMapSpawns,...questSpawns];
    this.staticSpawnIds=new Set(this.staticSpawns.map(spawn=>spawn.id));
    // 只索引原始地图槽和战役追加槽；读档恢复时要靠它把名册里的身份写回替换缓存。
    this.breakableSlots=new Map(this.staticSpawns
      .filter(spawn=>'breakableEligible' in spawn&&spawn.breakableEligible)
      .map(spawn=>[spawn.id,spawn]));
    session.enterMap(map.id,map.questItemSpawns??[],map,map.enemySpawns);
    this.setPartySize(session.party?.activeSize??1,[]);
    this.collectQuestSpawns();
    for(const spawn of this.spawns)this.sources.set(spawn.id,spawn);
    this.refresh();
  }
capturePreparedState():{roster:ReturnType<EnemyRoster['captureState']>;breakableRolls:[string,string][]}{
    return {roster:this.captureState(),breakableRolls:[...this.breakableRolls]};
  }
  adoptPreparedState(state:{roster:ReturnType<EnemyRoster['captureState']>;breakableRolls:[string,string][]}):void{
    this.breakableRolls.clear();for(const [id,enemy] of state.breakableRolls)this.breakableRolls.set(id,enemy);
    this.breakableRevision++;
    this.restoreState(state.roster);
    this.refresh();
  }
  /**
   * 恢复名册时，可破坏物槽的替换结果必须跟着名册里的身份走。
   *
   * `breakableRolls` 只在本次访问内有效，不写进存档；读档/检查点恢复会新建一个已经
   * 预掷过随机数的名册。若不把恢复条目的 `enemyId` 写回缓存，下一次 `refresh`
   * 会把同 key 当成“换了只怪”，先删名册再按新随机身份加回，与场上实例错开。
   */
  override restoreState(state:ReturnType<EnemyRoster['captureState']>):void{
    super.restoreState(state);
    this.membershipRevision++;
    for(const placed of this.enemies){
      const slot=this.breakableSlots.get(placed.key);
      if(!slot)continue;
      // 任务关键敌人由 breakableSpawnFor 强制恢复原怪并自行删缓存，这里保持一致。
      if(this.questSpawnIds.has(slot.enemyId))this.breakableRolls.delete(placed.key);
      else this.breakableRolls.set(placed.key,placed.enemyId);
    }
    this.breakableRevision++;
    // source() 要给死亡结算提供恢复后的真实敌人身份，不能停留在构造时的随机结果。
    this.sources.clear();
    for(const spawn of this.spawns)this.sources.set(spawn.id,spawn);
  }

  source(id:string):WorldSpawn|undefined{return this.sources.get(id);}
  /** 当前实例的有效在场状态；读取不会复活敌人或改写剧情记录。 */
  isPresent(id:string,enemyId?:string):boolean {
    const placed=this.enemy(id);
    if(!placed||enemyId!==undefined&&placed.enemyId!==enemyId)return false;
    const state=this.session.enemyVitals(id);
    if(state.capture||state.deadUntil!==undefined)return false;
    const source=this.sources.get(id);
    if(!source)return this.session.storyWorld.visible(id);
    const current=this.projectedSources().get(id);
    if(!current||this.spawnPresence(current)==='absent')return false;
    const identity=this.questSpawnIds.has(current.enemyId)?current.enemyId:this.breakableRolls.get(id)??current.enemyId;
    return identity===placed.enemyId;
  }
  /** 候选名单缓存同时跟随剧情、任务、死亡与名册变化。 */
  get presenceRevision():number {
    this.collectQuestSpawns();
    const story=this.session.storyWorld.revision,quest=this.session.questBook.version;
    const deaths=this.session.enemySpawnRevision,members=this.membershipRevision,sources=this.questSourceIds;
    const chests=this.session.chests.revision,breakables=this.breakableRevision;
    const old=this.presenceInputs;
    if(!old||old.story!==story||old.quest!==quest||old.deaths!==deaths||old.members!==members||old.chests!==chests||old.breakables!==breakables||old.sources!==sources){
      this.presenceInputs={story,quest,deaths,members,chests,breakables,sources};this.presenceVersion++;
    }
    return this.presenceVersion;
  }
  override placeEnemy(enemyId:string,x:number,y:number):PlacedEnemy {
    const placed=super.placeEnemy(enemyId,x,y);this.membershipRevision++;return placed;
  }
  override restoreEnemy(placed:PlacedEnemy):void {
    const before=this.enemies.length;super.restoreEnemy(placed);
    if(this.enemies.length!==before)this.membershipRevision++;
  }
  override removeEnemy(key:string):void {
    const before=this.enemies.length;super.removeEnemy(key);
    if(this.enemies.length!==before)this.membershipRevision++;
  }
  completedEncounters():readonly StoryEncounter[]{
    const encounterRevision=this.session.storyWorld.encounterRevision,enemySpawnRevision=this.session.enemySpawnRevision;
    const cached=this.completedCache;
    if(cached&&cached.encounterRevision===encounterRevision&&cached.enemySpawnRevision===enemySpawnRevision&&
      cached.membershipRevision===this.membershipRevision)return cached.value;
    // 判定仍是“死亡已结算且不是捕获”，不能只看血量是否为 0。
    const value=Object.freeze(this.session.storyWorld.activeEncounters.filter(encounter=>encounter.map===this.mapId&&encounter.spawns.length>0&&
      encounter.spawns.every(spawn=>{const state=this.session.enemyVitals(encounterSpawnId(encounter.id,spawn.id));
        return state.deadUntil!==undefined&&!state.capture;})));
    this.completedCache={encounterRevision,enemySpawnRevision,membershipRevision:this.membershipRevision,value};
    return value;
  }
  override setPartySize(size:number,definitions:readonly EnemyDefinition[]):void{
    if(size===this.partySize)return;
    super.setPartySize(size,definitions);
    for(const placed of this.enemies){const definition=definitions.find(enemy=>enemy.id===placed.enemyId);
      if(!definition)continue;
      const snapshot=this.enemySnapshot(placed.key,definition,this.session.hero?.level??1);
      if(snapshot)this.session.setEnemyVitals(placed.key,snapshot.health,snapshot.mana);
    }
  }
  refresh(view?:EnemyRespawnView):{added:PlacedEnemy[];removed:string[]}{
    const added:PlacedEnemy[]=[],removed:string[]=[];
    if(view&&(!Number.isFinite(view.x)||!Number.isFinite(view.y)||!Number.isFinite(view.width)||!Number.isFinite(view.height)||view.width<=0||view.height<=0))view=undefined;
    const oldView=this.respawnView;
    const viewChanged=!!view!==!!oldView||!!view&&!!oldView&&
      (view.x!==oldView.x||view.y!==oldView.y||view.width!==oldView.width||view.height!==oldView.height);
    if(view){
      if(oldView){oldView.x=view.x;oldView.y=view.y;oldView.width=view.width;oldView.height=view.height;}
      else this.respawnView={x:view.x,y:view.y,width:view.width,height:view.height};
    }else this.respawnView=undefined;
    // 镜头移动只复核等待中的生成点；没有可提前刷新的点就沿用正常缓存。
    let offscreenReady=false;
    if(viewChanged)for(const spawn of this.offscreenWaiting.values()){
      if(this.outsideRespawnView(spawn,view)&&this.session.canRespawnEnemy(spawn,true)){offscreenReady=true;break;}
    }
    const spawns=this.spawns,previous=this.lastRefresh;
    if(previous?.spawns===spawns&&previous.enemyRevision===this.session.enemySpawnRevision&&
      previous.questVersion===this.session.questBook.version&&previous.membershipRevision===this.membershipRevision&&
      previous.members.size===this.enemies.length&&!offscreenReady&&this.session.nowMs<previous.nextSpawnAt&&this.identitiesMatchSources(previous.members))return {added,removed};
    if(this.spawnIndex?.spawns!==spawns)this.spawnIndex={spawns,byId:new Map(spawns.map(spawn=>[spawn.id,spawn]))};
    const current=this.spawnIndex.byId;
    let nextSpawnAt=Infinity;
    this.offscreenWaiting.clear();
    const present=new Set(this.enemies.map(enemy=>enemy.key));
    for(const placed of [...this.enemies]){
      const spawn=current.get(placed.key)??this.sources.get(placed.key);
      if(!spawn)continue;
      // 槽位离场（死亡、隐藏、从本次生成集合消失）才丢弃替换结果，下次出现重掷。
      const leaving=!current.has(spawn.id)||!this.spawnAllowed(spawn,view);
      // 同 key 换身份只是这一槽改了外观，缓存仍是本次访问的结果，下一帧不能再掷一次。
      if(!leaving&&placed.enemyId===spawn.enemyId)continue;
      super.removeEnemy(placed.key);present.delete(placed.key);removed.push(placed.key);
      if(leaving&&this.breakableRolls.delete(placed.key))this.breakableRevision++;
    }
    // 主人从名册消失时，它名下的召唤物也一起离场；否则快照里会留下找不到主人的孤儿召唤。
    const removedSet=new Set(removed);
    for(let changed=true;changed;){
      changed=false;
      for(const placed of [...this.enemies]){
        if(placed.summonedBy===undefined||!removedSet.has(placed.summonedBy)||removedSet.has(placed.key))continue;
        super.removeEnemy(placed.key);present.delete(placed.key);removed.push(placed.key);removedSet.add(placed.key);changed=true;
      }
    }
    for(const spawn of spawns){
      this.sources.set(spawn.id,spawn);
      if(!this.spawnAllowed(spawn,view)){
        const state=this.session.enemyVitals(spawn.id),deadline=state.deadUntil;
        if(typeof deadline==='number'&&deadline>this.session.nowMs){
          nextSpawnAt=Math.min(nextSpawnAt,deadline);
          if(this.staticSpawnIds.has(spawn.id)&&spawn.respawn!==false&&!state.capture&&state.offscreenRespawnAt!==undefined){
            this.offscreenWaiting.set(spawn.id,spawn);
            if(state.offscreenRespawnAt>this.session.nowMs)nextSpawnAt=Math.min(nextSpawnAt,state.offscreenRespawnAt);
          }
        }
        continue;
      }
      if(present.has(spawn.id))continue;
      const vitals=this.session.enemyVitals(spawn.id);
      const placed:PlacedEnemy={key:spawn.id,enemyId:spawn.enemyId,x:spawn.x,y:spawn.y,health:vitals.health,mana:vitals.mana};
      this.restoreEnemy(placed);present.add(spawn.id);added.push(placed);
    }
    // 生成集合缩小时同步丢弃旧来源，避免同图待久后 sources 只增不减。
    for(const id of this.sources.keys())if(!current.has(id))this.sources.delete(id);
    this.recordEmptyDiagnostic(spawns);
    this.lastRefresh={spawns,enemyRevision:this.session.enemySpawnRevision,questVersion:this.session.questBook.version,
      membershipRevision:this.membershipRevision,members:present,nextSpawnAt};
    return {added,removed};
  }
  /** 名册公开的实例允许恢复路径修正身份；这里只核对标识，不重建表或查询生成条件。 */
  private identitiesMatchSources(members:ReadonlySet<string>):boolean {
    for(const placed of this.enemies){
      if(!members.has(placed.key))return false;
      const source=this.sources.get(placed.key);
      if(source&&source.enemyId!==placed.enemyId)return false;
    }
    return true;
  }
  override setEnemyHealth(key:string,value:number,definition:EnemyDefinition):void {
    super.setEnemyHealth(key,value,definition);
    const snapshot=this.enemySnapshot(key,definition,this.session.hero?.level??1);
    if(snapshot)this.session.setEnemyVitals(key,snapshot.health,snapshot.mana);
  }
  override setEnemyMaxHealthOverride(key:string,maxHealth:number|undefined,definition:EnemyDefinition):void {
    super.setEnemyMaxHealthOverride(key,maxHealth,definition);
    const snapshot=this.enemySnapshot(key,definition,this.session.hero?.level??1);
    if(snapshot)this.session.setEnemyVitals(key,snapshot.health,snapshot.mana);
  }
  override setEnemyMana(key:string,value:number,definition:EnemyDefinition):void {
    super.setEnemyMana(key,value,definition);
    const snapshot=this.enemySnapshot(key,definition,this.session.hero?.level??1);
    if(snapshot)this.session.setEnemyVitals(key,snapshot.health,snapshot.mana);
  }
  private breakableSpawnFor(spawn:WorldSpawn):WorldSpawn{
    if(!('breakableEligible' in spawn)||!spawn.breakableEligible)return spawn;
    // 任务关键敌人优先：任务目标出现时恢复原怪，并让 refresh 替换掉已生成的景物。
    if(this.questSpawnIds.has(spawn.enemyId)){this.breakableRolls.delete(spawn.id);this.breakableRevision++;return spawn;}
    let enemyId=this.breakableRolls.get(spawn.id);
    if(enemyId===undefined){
      enemyId=this.rollBreakableEnemy(spawn.enemyId);
      this.breakableRolls.set(spawn.id,enemyId);this.breakableRevision++;
    }
    return enemyId===spawn.enemyId?spawn:{...spawn,enemyId};
  }
  private rollBreakableEnemy(original:string):string{
    const roll=Math.floor(this.random()*PERCENT_SCALE);
    if(this.breakableSpawn==='bush'){
      if(roll<BREAKABLE_SPECIAL_ENEMY_PERCENT)return BREAKABLE_ENEMY_IDS.bush;
      if(roll<BREAKABLE_BOX_PERCENT)return BREAKABLE_ENEMY_IDS.box;
    }else if(this.breakableSpawn==='jar'){
      if(roll<BREAKABLE_SPECIAL_ENEMY_PERCENT)return BREAKABLE_ENEMY_IDS.jar;
      if(roll<BREAKABLE_BOX_PERCENT)return BREAKABLE_ENEMY_IDS.box;
    }else if(roll<BREAKABLE_SPECIAL_ENEMY_PERCENT)return BREAKABLE_ENEMY_IDS.box;
    return original;
  }
  private collectQuestSpawns():number{
    const snapshot=this.questEnemies?.snapshot();
    if(snapshot&&(snapshot.revision!==this.questSourceRevision||snapshot.ids!==this.questSourceIds)){
      for(const id of snapshot.ids)this.questSpawnIds.add(id);
      this.questSourceRevision=snapshot.revision;
      this.questSourceIds=snapshot.ids;
    }
    return snapshot?.revision??0;
  }
  /** 有效剧情资格含静态任务恢复；死亡与刷新计时由刷新入口处理。 */
  private storySpawnable(spawn:WorldSpawn):boolean{
    return this.spawnPresence(spawn)!=='absent';
  }

  /** 当前 active 任务的目标怪；任务目标集合由 `collectQuestSpawns` 在每次投影前更新。 */
  private questTarget(spawn:WorldSpawn):boolean {
    if(!this.questSourceIds?.has(spawn.enemyId))return false;
    return !('activeQuest' in spawn)||this.session.status(spawn.activeQuest)==='active';
  }
  /** 剧情禁用不压当前任务目标；任务结束后 `enemyAvailable` 重新生效。 */
  private spawnAvailable(spawn:WorldSpawn):boolean {
    return this.spawnPresence(spawn)!=='absent';
  }
  private spawnPresence(spawn:WorldSpawn):'story'|'quest'|'absent' {
    if('activeQuest' in spawn&&this.session.status(spawn.activeQuest)!=='active')return 'absent';
    if(this.session.storyWorld.visible(spawn.id)&&(!this.staticSpawnIds.has(spawn.id)||this.session.storyWorld.enemyAvailable(this.mapId,spawn.enemyId)))return 'story';
    return this.staticSpawnIds.has(spawn.id)&&this.questTarget(spawn)?'quest':'absent';
  }
  private projectedSources():ReadonlyMap<string,WorldSpawn> {
    const questRevision=this.collectQuestSpawns();
    const story=this.session.storyWorld.revision,chests=this.session.chests.revision,sources=this.questSourceIds,size=this.questSpawnIds.size;
    const old=this.sourceProjection;
    if(old?.story===story&&old.chests===chests&&old.quests===questRevision&&old.sources===sources&&old.size===size)return old.byId;
    const encounters=this.session.storyWorld.activeEncounters.filter(encounter=>encounter.map===this.mapId);
    // 遭遇占用同格同身份的地图槽时，地图实例让位给这次遭遇。
    const claimed=new Set(encounters.flatMap(encounter=>encounter.spawns.map(spawn=>occupiedKey(spawn.enemyId,spawn.x,spawn.y))));
    const resident=[...this.staticSpawns.filter(spawn=>this.spawnAvailable(spawn)),
      ...this.session.storyWorld.enemySpawns(this.mapId),...this.session.chests.spawns];
    const value=[...resident.filter(spawn=>!claimed.has(occupiedKey(spawn.enemyId,spawn.x,spawn.y))),
      ...encounters.flatMap(encounter=>encounter.spawns.map(spawn=>({...spawn,id:encounterSpawnId(encounter.id,spawn.id),respawn:false as const})))];
    const byId=new Map(value.map(spawn=>[spawn.id,spawn]));
    this.sourceProjection={story,chests,quests:questRevision,sources,size,byId};return byId;
  }
  private outsideRespawnView(spawn:WorldSpawn,view:EnemyRespawnView|undefined):boolean {
    if(!view||!this.staticSpawnIds.has(spawn.id)||spawn.respawn===false)return false;
    const margin=ENEMY_RESPAWN_VIEW_MARGIN_PX;
    return spawn.x<view.x-margin||spawn.x>view.x+view.width+margin||
      spawn.y<view.y-margin||spawn.y>view.y+view.height+margin;
  }
  /** 刷新统一消费剧情资格与死亡计时；静态任务槽可以解除剧情清场留下的永久死亡。 */
  private spawnAllowed(spawn:WorldSpawn,view?:EnemyRespawnView):boolean {
    const presence=this.spawnPresence(spawn);
    if(presence==='absent')return false;
    const offscreen=this.outsideRespawnView(spawn,view);
    if(!this.session.canRespawnEnemy(spawn,offscreen)){
      // 永久死亡只在剧情移除的静态任务槽上解除；捕捉记录由清理入口继续保护。
      if(presence!=='quest'||this.session.storyWorld.visible(spawn.id)||this.session.enemyVitals(spawn.id).deadUntil!=='permanent')return false;
    }
    // 清理死亡记录只发生在刷新入口，查询保留原始记录。
    return this.session.clearEnemyDefeat(spawn.id,offscreen);
  }
  private recordEmptyDiagnostic(spawns:readonly WorldSpawn[]):void{
    if(this.emptyReported||this.enemies.length||!this.rawMapSpawns.length)return;
    if(spawns.some(spawn=>this.storySpawnable(spawn)))return;
    this.emptyReported=true;
    globalThis.storyDiagnostics?.record('map-enemies-empty',{
      map:this.mapId,heroLevel:this.session.hero?.level??1,
      spawns:spawns.length,quests:this.session.questBook.runningQuestIds
        .filter(id=>this.session.questBook.status(id)==='active'),
    });
  }
}

/** 同一格同一敌人的判定键：用来让遭遇点和地图常驻怪不各生成一只。 */
function occupiedKey(enemyId:string,x:number,y:number):string{return `${enemyId}|${x}|${y}`;}

/** 剧情移除以当前实例为准；它不产生经验和掉落。进行中遭遇被移走时，任务目标按战斗结束结算。 */
export function applyStoryEnemyRemovals(session:StoryEnemyRemovalSessionPort,map:string,enemies:readonly Pick<PlacedEnemy,'key'|'enemyId'>[],remove:(key:string)=>void):void {
  const removed=new Set<string>();
  // 进行中的剧情遭遇被移走时，这场战斗本身已经结束，按击败记录任务目标；
  // 普通地图敌人的清场不计击杀，避免把剧情清场当成玩家亲手击败。
  const activeEncounterKeys=new Set(session.storyWorld.activeEncounters.flatMap(encounter=>
    encounter.spawns.map(spawn=>encounterSpawnId(encounter.id,spawn.id))));
  for(const command of session.storyWorld.pendingEnemyRemovals){
    if(command.map&&command.map!==map)continue;
    const matches=enemies.filter(enemy=>!removed.has(enemy.key)&&enemy.enemyId===command.enemyId);
    for(const enemy of command.all?matches:matches.slice(0,1)){
      if(activeEncounterKeys.has(enemy.key))session.recordStoryDefeat(enemy.enemyId);
      session.removeStoryEnemy(enemy.key);remove(enemy.key);removed.add(enemy.key);
    }
  }
  // 只消费这张地图的命令；其他地图的待处理移除留到它们各自的场景再生效。
  session.storyWorld.consumeEnemyRemovals(command=>command.map===undefined||command.map===map);
}

import type { PlacedEnemy, EnemyDefinition } from './battle.ts';
import { EnemyRoster } from './enemy-roster.ts';
import type { CampaignEnemyPlacement, EnemySpawn, WorldMap } from './content.ts';
import type { Session } from './session.ts';
import type { StoryEncounter } from './story-world.ts';
import { BREAKABLE_ENEMY_IDS } from './drops.ts';

export type WorldSpawn = EnemySpawn | CampaignEnemyPlacement;

export interface QuestEnemySnapshot {
  revision: number;
  ids: ReadonlySet<string>;
}

/** 任务关键敌人的只读来源；由组合根提供，名册不依赖战役与掉落目录。 */
export interface QuestEnemyProvider {
  snapshot(): QuestEnemySnapshot;
}

export interface MapSpawnSelectionOptions {
  /** active 任务的关键敌人：无论档位都保留。 */
  questEnemies?: ReadonlySet<string>;
  /** 当前剧情下这个站位是否还有出现资格；不得读取死亡/刷新计时。 */
  spawnable?: (spawn: WorldSpawn) => boolean;
}

/**
 * 按主角等级选择地图的敌人档位。
 *
 * 复刻规则：取不超过主角等级的最高档，低于全部档位时用最低档；达到下一档
 * 代表等级才切换。active 任务的关键敌人无视档位保留。整个静态选择在当前
 * 剧情下都不可生成时，只向更低的一档回退一次，避免提前放出未来章节的敌人。
 *
 * 不触碰 Session；`spawnable` 只用于判断剧情资格，临时死亡和刷新计时不参与。
 */
function tierLevels(spawns:readonly WorldSpawn[]):number[]{
  return [...new Set(spawns.flatMap(spawn=>spawn.tierLevel===undefined?[]:[spawn.tierLevel]))]
    .sort((a,b)=>a-b);
}

export function selectMapSpawns(map:WorldMap,questSpawns:readonly CampaignEnemyPlacement[],heroLevel:number,
  options:MapSpawnSelectionOptions={}):WorldSpawn[]{
  const raw=map.enemySpawns??[];
  const tiers=tierLevels(raw);
  if(!tiers.length)return [...raw,...questSpawns];

  let selected=tiers[0]!;
  for(const tier of tiers)if(tier<=heroLevel)selected=tier;

  const questEnemies=options.questEnemies,spawnable=options.spawnable??(()=>true);
  const chosen=new Set<number>();
  raw.forEach((spawn,index)=>{
    if(spawn.tierLevel===undefined||spawn.tierLevel===selected||questEnemies?.has(spawn.enemyId))
      chosen.add(index);
  });

  const base=[...chosen].map(index=>raw[index]!);
  if(![...base,...questSpawns].some(spawnable)){
    // 只补更低的一档，并用它替换不可用的选中档；没有低档可用就保持空图，由名册记录诊断。
    for(const tier of tiers.filter(value=>value<selected).reverse()){
      const indices=raw.flatMap((spawn,index)=>spawn.tierLevel===tier?[index]:[]);
      if(!indices.some(index=>spawnable(raw[index]!)))continue;
      raw.forEach((spawn,index)=>{
        if(spawn.tierLevel===selected&&!questEnemies?.has(spawn.enemyId))chosen.delete(index);
      });
      for(const index of indices)chosen.add(index);
      break;
    }
  }
  return [...raw.filter((_,index)=>chosen.has(index)),...questSpawns];
}

/** One map's enemy roster. Stable spawn IDs and combat resources live in Session. */
export class WorldEnemyRoster extends EnemyRoster {
  readonly session:Session;
  private readonly mapId:string;
  private readonly rawMapSpawns:readonly WorldSpawn[];
  private readonly bandSpawns:readonly WorldSpawn[];
  private readonly mapSpawnIds:ReadonlySet<string>;
  private readonly heroLevel:number;
  private readonly questEnemies?:QuestEnemyProvider;
  private readonly breakableSpawn?:'bush'|'jar';
  /** 生产场景传 Math.random；测试和离线验证默认不替换，结果稳定可复现。 */
  private readonly random:()=>number;
  /** 本次进图每个静态生成槽的替换结果；槽位真正离场时清掉，重新掷。 */
  private readonly breakableRolls=new Map<string,string>();
  /** 可能被可破坏物替换的静态槽，按生成点 id 索引；恢复名册时据此对齐替换结果。 */
  private readonly breakableSlots:ReadonlyMap<string,WorldSpawn>;
  /** 本次进图累计的任务关键敌人；只增不减，避免任务完成时撤掉正在交战的怪。 */
  private readonly questSpawnIds=new Set<string>();
  /** 可破坏物替换结果的版本：缓存重建后必须重新掷骰。 */
  private breakableRevision=0;
  private spawnsCache?:{key:string;value:readonly WorldSpawn[]};
  private emptyReported=false;
  get spawns(): readonly WorldSpawn[] {
    const questRevision=this.collectQuestSpawns();
    const cacheKey=`${this.session.storyWorld.revision}|${this.session.chests.revision}|${questRevision}|${this.questSpawnIds.size}|${this.breakableRevision}`;
    const cached=this.spawnsCache;
    if(cached?.key===cacheKey)return cached.value;
    const extras=this.questSpawnIds.size
      ? this.rawMapSpawns.filter(spawn=>this.questSpawnIds.has(spawn.enemyId)&&!this.mapSpawnIds.has(spawn.id))
      : [];
    const value=[...this.bandSpawns.filter(spawn=>this.session.storyWorld.enemyAvailable(this.mapId,spawn.enemyId))
      .map(spawn=>this.breakableSpawnFor(spawn)),
      ...extras.filter(spawn=>this.session.storyWorld.enemyAvailable(this.mapId,spawn.enemyId))
        .map(spawn=>this.breakableSpawnFor(spawn)),
      ...this.session.storyWorld.enemySpawns(this.mapId),...this.session.chests.spawns,...this.session.storyWorld.activeEncounters
      .filter(encounter=>encounter.map===this.mapId).flatMap(encounter=>encounter.spawns.map(spawn=>({
        ...spawn,id:encounterSpawnId(encounter.id,spawn.id),respawn:false as const
      })))];
    // 第一次生成可破坏物替换时版本会变，缓存键按生成后的版本记录，下一次可以直接命中。
    this.spawnsCache={key:`${this.session.storyWorld.revision}|${this.session.chests.revision}|${questRevision}|${this.questSpawnIds.size}|${this.breakableRevision}`,
      value};
    return value;
  }
  private readonly sources = new Map<string,WorldSpawn>();
  constructor(session:Session,map:WorldMap,questSpawns:readonly CampaignEnemyPlacement[],heroLevel:number,
    questEnemies?:QuestEnemyProvider,random:()=>number=()=>1){
    super();
    this.session=session;
    this.mapId=map.id;
    this.heroLevel=heroLevel;
    this.questEnemies=questEnemies;
    this.breakableSpawn=map.breakableSpawn;
    this.random=random;
    this.rawMapSpawns=map.enemySpawns??[];
    // 只索引原始地图槽和战役追加槽；读档恢复时要靠它把名册里的身份写回替换缓存。
    this.breakableSlots=new Map([...this.rawMapSpawns,...questSpawns]
      .filter(spawn=>'breakableEligible' in spawn&&spawn.breakableEligible)
      .map(spawn=>[spawn.id,spawn]));
    session.enterMap(map.id,map.questItemSpawns??[],map,map.enemySpawns);
    this.setPartySize(session.party?.activeSize??1,[]);
    this.collectQuestSpawns();
    this.bandSpawns=selectMapSpawns(map,questSpawns,heroLevel,{
      questEnemies:this.questSpawnIds,spawnable:spawn=>this.storySpawnable(spawn)});
    this.mapSpawnIds=new Set(this.bandSpawns.map(spawn=>spawn.id));
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
  completedEncounters():readonly StoryEncounter[]{
    return this.session.storyWorld.activeEncounters.filter(encounter=>encounter.map===this.mapId&&encounter.spawns.length>0&&
      encounter.spawns.every(spawn=>{const state=this.session.enemyVitals(encounterSpawnId(encounter.id,spawn.id));
        return state.deadUntil!==undefined&&!state.capture;}));
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
  refresh():{added:PlacedEnemy[];removed:string[]}{
    const added:PlacedEnemy[]=[],removed:string[]=[];
    const spawns=this.spawns,active=new Set<string>(),current=new Map<string,WorldSpawn>();
    for(const spawn of spawns){active.add(spawn.id);current.set(spawn.id,spawn);}
    const present=new Set(this.enemies.map(enemy=>enemy.key));
    for(const placed of [...this.enemies]){
      const spawn=current.get(placed.key)??this.sources.get(placed.key);
      if(!spawn)continue;
      // 槽位离场（死亡、隐藏、从本次生成集合消失）才丢弃替换结果，下次出现重掷。
      const leaving=!active.has(spawn.id)||!this.session.canSpawnEnemy(spawn);
      // 同 key 换身份只是这一槽改了外观，缓存仍是本次访问的结果，下一帧不能再掷一次。
      if(!leaving&&placed.enemyId===spawn.enemyId)continue;
      super.removeEnemy(placed.key);present.delete(placed.key);removed.push(placed.key);
      if(leaving){this.breakableRolls.delete(placed.key);this.breakableRevision++;}
    }
    for(const spawn of spawns){
      this.sources.set(spawn.id,spawn);
      if(!this.session.canSpawnEnemy(spawn)||present.has(spawn.id))continue;
      const vitals=this.session.enemyVitals(spawn.id);
      const placed:PlacedEnemy={key:spawn.id,enemyId:spawn.enemyId,x:spawn.x,y:spawn.y,health:vitals.health,mana:vitals.mana};
      this.restoreEnemy(placed);present.add(spawn.id);added.push(placed);
    }
    this.recordEmptyDiagnostic(spawns);
    return {added,removed};
  }
  override setEnemyHealth(key:string,value:number,definition:EnemyDefinition):void {
    super.setEnemyHealth(key,value,definition);
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
    const roll=Math.floor(this.random()*100);
    if(this.breakableSpawn==='bush'){
      if(roll<5)return BREAKABLE_ENEMY_IDS.bush;
      if(roll<7)return BREAKABLE_ENEMY_IDS.box;
    }else if(this.breakableSpawn==='jar'){
      if(roll<5)return BREAKABLE_ENEMY_IDS.jar;
      if(roll<7)return BREAKABLE_ENEMY_IDS.box;
    }else if(roll<5)return BREAKABLE_ENEMY_IDS.box;
    return original;
  }
  private collectQuestSpawns():number{
    const snapshot=this.questEnemies?.snapshot();
    if(snapshot)for(const id of snapshot.ids)this.questSpawnIds.add(id);
    return snapshot?.revision??0;
  }
  /** 剧情资格：active 任务槽、剧情可见性、敌人可用性；刻意不看死亡/刷新计时。 */
  private storySpawnable(spawn:WorldSpawn):boolean{
    if('activeQuest' in spawn&&this.session.status(spawn.activeQuest)!=='active')return false;
    return this.session.storyWorld.visible(spawn.id)&&this.session.storyWorld.enemyAvailable(this.mapId,spawn.enemyId);
  }
  private recordEmptyDiagnostic(spawns:readonly WorldSpawn[]):void{
    if(this.emptyReported||this.enemies.length||!this.rawMapSpawns.length)return;
    if(spawns.some(spawn=>this.storySpawnable(spawn)))return;
    this.emptyReported=true;
    globalThis.storyDiagnostics?.record('map-enemies-empty',{
      map:this.mapId,heroLevel:this.heroLevel,tiers:this.tiers(),
      spawns:spawns.length,quests:this.session.questBook.runningQuestIds
        .filter(id=>this.session.questBook.status(id)==='active'),
    });
  }
  private tiers():number[]{
    return tierLevels(this.rawMapSpawns);
  }
}

/** Each encounter occurrence owns separate combat resources, even on the same map. */
export function encounterSpawnId(encounter:string,spawn:string):string{return `${encounter}:${spawn}`;}

/** 剧情移除以当前实例为准；它不产生玩家击杀、奖励或掉落。 */
export function applyStoryEnemyRemovals(session:Session,map:string,enemies:readonly Pick<PlacedEnemy,'key'|'enemyId'>[],remove:(key:string)=>void):void {
  const removed=new Set<string>();
  for(const command of session.storyWorld.pendingEnemyRemovals){
    if(command.map&&command.map!==map)continue;
    const matches=enemies.filter(enemy=>!removed.has(enemy.key)&&enemy.enemyId===command.enemyId);
    for(const enemy of command.all?matches:matches.slice(0,1)){
      session.removeStoryEnemy(enemy.key);remove(enemy.key);removed.add(enemy.key);
    }
  }
  session.storyWorld.consumeEnemyRemovals();
}

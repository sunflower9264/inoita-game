import {BATTLE_BUFF_KEYS,type BattleBuffKey} from './battle-semantics.ts';
import type { EntityPlacement, Facing, MapExit, PlacementAuthority, TravelDestination } from './content.ts';
import { placementAuthority } from './actor-authority.ts';

export interface StoryEntityState {
  id:string;
  map?:string;
  actor?:string;
  characterId?:string;
  authority?:PlacementAuthority;
  mapVisit?:number;
  x?:number;
  y?:number;
  facing?:Facing;
  visible?:boolean;
  removed?:boolean;
  hint?:string;
}
interface StoryEncounterSpawn {
  id:string; enemyId:string; x:number; y:number;
}
export interface StoryEncounter {
  id:string;
  definitionId?:string;
  map:string;
  mapFromStage?:boolean;
  status:'prepared'|'active'|'won'|'lost';
  spawns:StoryEncounterSpawn[];
}
/**
 * 已完成遭遇只保留最近这些条。
 *
 * 唯一需要已完成状态的消费者是 `StoryDirector.observe` 的 battle 触发：它只关心刚结束、
 * 还没观察过的结果。`StoryRuntime` 自己的 `encounterResults` 也只记最近 64 条，
 * 这里取同一个窗口，超出的一次性遭遇及其怪物死亡记录都不会再被任何代码读到。
 */
const COMPLETED_ENCOUNTER_HISTORY_LIMIT=64;
const isCompletedEncounter=(encounter:Readonly<StoryEncounter>):boolean=>
  encounter.status==='won'||encounter.status==='lost';
export interface StoryWorldSnapshot {
  entities:StoryEntityState[];
  exits:[string,boolean][];
  flags:string[];
  choices:[string,string][];
  encounters:StoryEncounter[];
  location?:TravelDestination;
  mapVisit:number;
  enemyRemovals?:{enemyId:string;map?:string;all:boolean}[];
  enemyLocations?:{id:string;enemyId:string;map:string;x:number;y:number;mapVisit?:number;respawn?:false}[];
  appearances?:[string,string][];
  partyBuffs?:{buff:BattleBuffKey;strength:number}[];
}
export type StoryWorldCommand =
  | {kind:'remove-enemy';enemyId:string;map?:string;all:boolean}
  | {kind:'enemy-location';enemyId:string;location:{map:string;x:number;y:number}|null;scope?:'visit';respawn?:false;mapFromStage?:boolean}
  | {kind:'actor-appearance';actor:string;appearance:string}
  | {kind:'party-buff';buff:BattleBuffKey;strength:number}
  | {kind:'place';mapFromStage?:boolean;scope?:'visit';entity:StoryEntityState & {map:string;actor:string;x:number;y:number}}
  | {kind:'remove-character';characterId:string;map:string;mapFromStage?:boolean;all:boolean}
  | {kind:'show'|'hide'|'remove';id:string}
  | {kind:'actor-visibility';map:string;actor:string;characterId?:string;visible:boolean}
  | {kind:'enemy-availability';map:string;enemyId:string;available:boolean}
  | {kind:'exit';id:string;enabled:boolean}
  | {kind:'flag';id:string;value:boolean}
  | {kind:'choice';id:string;value:string}
  | {kind:'travel';destination:TravelDestination}
  | {kind:'encounter';encounter:StoryEncounter}
  | {kind:'encounter-result';id:string;result:'won'|'lost'};

/** Stable exit identity belongs to the semantic map, independent of scene instances. */
export function storyExitId(map:string,exit:MapExit):string {
  return exit.id??`${map}:${exit.destination}:${exit.x}:${exit.y}:${exit.width}:${exit.height}`;
}

/** Each encounter occurrence owns separate combat resources, even on the same map. */
export function encounterSpawnId(encounter: string, spawn: string): string {
  return `${encounter}:${spawn}`;
}

/** Persistent story objects; temporary cinematic actors remain in the presentation scene. */
export class StoryWorldState {
  private entities=new Map<string,StoryEntityState>();
  private exits=new Map<string,boolean>();
  private flags=new Set<string>();
  private choices=new Map<string,string>();
  private encounters=new Map<string,StoryEncounter>();
  /** 仅索引进行中的遭遇，按加入顺序排列；每帧读取只走这里，已结束的历史不参与遍历。 */
  private activeEncounterIds=new Set<string>();
  /** 完成顺序；裁剪按它淘汰最早结束的遭遇，而不是按创建顺序。 */
  private completedEncounterOrder:string[]=[];
  /** 已被有界历史裁掉、等待会话清理对应敌人状态的遭遇。 */
  private prunedEncounters:StoryEncounter[]=[];
  private location?:TravelDestination;
  private mapVisit=0;
  private enemyRemovals:{enemyId:string;map?:string;all:boolean}[]=[];
  get pendingEnemyRemovals(){return this.enemyRemovals.map(value=>({...value}));}
  /** 只清掉本次真正应用过的命令；其他地图的待处理项留到那张图上再生效。 */
  consumeEnemyRemovals(consumed?:(command:{enemyId:string;map?:string;all:boolean})=>boolean):void{
    if(!consumed){this.enemyRemovals=[];return;}
    this.enemyRemovals=this.enemyRemovals.filter(command=>!consumed({...command}));
  }
  private enemyLocations=new Map<string,{id:string;enemyId:string;map:string;x:number;y:number;mapVisit?:number;respawn?:false}>();
  /** 每次剧情世界变化递增；只读投影可以据此复用上一次的结果。 */
  private revisionValue=0;
  get revision():number{return this.revisionValue;}
  /** 每次写入或恢复主角剧情落点（`travel` / `restoreState`）递增，同坐标重复回退也能驱动正式世界投影。 */
  private locationRevisionValue=0;
  get locationRevision():number{return this.locationRevisionValue;}
  private encounterRevisionValue=0;
  private encounterStatusesCache?:{revision:number;value:Map<string,{status:StoryEncounter['status'];definitionId?:string}>};
  /**
   * 遭遇集合的修订号：新增遭遇（包括剧情以 `active` 状态新建）和结果变成 `won`/`lost` 时推进；
   * `restoreState` 替换整份世界也推进。其他世界命令不改变它，遭遇状态缓存可以据此复用。
   */
  get encounterRevision():number{return this.encounterRevisionValue;}
  enemySpawns(map:string){return [...this.enemyLocations.values()].filter(value=>value.map===map).map(value=>({...value}));}
  private appearances=new Map<string,string>();
  actorAppearance(actor:string):string{return this.appearances.get(actor)??actor;}

  hasAppearanceOverride(actor:string):boolean { return this.appearances.has(actor); }
  private partyBuffs:{buff:BattleBuffKey;strength:number}[]=[];
  get pendingPartyBuffs(){return this.partyBuffs.map(value=>({...value}));}
  consumePartyBuffs(count:number):void{this.partyBuffs.splice(0,count);}
  get currentLocation():TravelDestination|undefined{return this.location?{...this.location}:undefined;}
  get visit():number{return this.mapVisit;}
  hasFlag(id:string):boolean{return this.flags.has(id);}
  get flagIds():ReadonlySet<string>{return new Set(this.flags);}
  choice(id:string):string|undefined{return this.choices.get(id);}
  /** 遭遇状态快照：观察只需要 id、status 和 definitionId。 */
  encounterStatuses():Map<string,{status:StoryEncounter['status'];definitionId?:string}>{
    const cached=this.encounterStatusesCache;
    if(cached?.revision===this.encounterRevisionValue)return cached.value;
    const result=new Map<string,{status:StoryEncounter['status'];definitionId?:string}>();
    for(const [id,encounter] of this.encounters)result.set(id,{status:encounter.status,definitionId:encounter.definitionId});
    this.encounterStatusesCache={revision:this.encounterRevisionValue,value:result};
    return result;
  }
  entity(id:string):Readonly<StoryEntityState>|undefined{const value=this.entities.get(id);return value?{...value}:undefined;}
  encounter(id:string):Readonly<StoryEncounter>|undefined{const value=this.encounters.get(id);return value?structuredClone(value):undefined;}
  /** 进行中遭遇：每帧只走 active 索引，不扫描 encounters 里只增不减的历史记录。 */
  get activeEncounters():readonly StoryEncounter[]{
    const result:StoryEncounter[]=[];
    for(const id of this.activeEncounterIds){
      const encounter=this.encounters.get(id);
      if(!encounter)throw new Error('剧情遭遇索引失效：'+id);
      result.push(structuredClone(encounter));
    }
    return result;
  }
  /** 取走刚被历史上限裁掉的遭遇；会话据此删除这些一次性遭遇的敌人状态。 */
  consumePrunedEncounters():StoryEncounter[]{
    const value=this.prunedEncounters;this.prunedEncounters=[];return value;
  }
  /** 已完成遭遇截到最近 {@link COMPLETED_ENCOUNTER_HISTORY_LIMIT} 条，并记下被裁掉的实例。 */
  private pruneCompletedEncounters():void{
    const tracked=new Set(this.completedEncounterOrder);
    for(const [id,encounter] of this.encounters)
      if(isCompletedEncounter(encounter)&&!tracked.has(id))this.completedEncounterOrder.push(id);
    const completed=this.completedEncounterOrder.filter(id=>{
      const encounter=this.encounters.get(id);return !!encounter&&isCompletedEncounter(encounter);
    });
    const excess=completed.length-COMPLETED_ENCOUNTER_HISTORY_LIMIT;
    if(excess<=0){this.completedEncounterOrder=completed;return;}
    this.completedEncounterOrder=completed.slice(excess);
    for(const id of completed.slice(0,excess)){
      const encounter=this.encounters.get(id);
      if(!encounter)continue;
      this.encounters.delete(id);
      this.activeEncounterIds.delete(id);
      this.prunedEncounters.push(structuredClone(encounter));
    }
    // 世界快照按 revision 复用；删掉遭遇后必须让缓存和观察者都看到这次变化。
    this.revisionValue++;this.encounterRevisionValue++;
  }
  exitEnabled(map:string,exit:MapExit):boolean{return this.exits.get(storyExitId(map,exit))!==false;}
  /**
   * 「角色不在场」有两种寿命：
   * - `absent-actor`：原版 `0x26`/`0x27` 的地图清除名单，离开再回来也不生成；
   * - `absent-actor-visit`：原版 `0x28` 的 leave 只撤下当前地图实例，新一次进图静态人物会重新生成。
   * 之前的实现把两种都写成永久标记，导致剧情清场时被撤下的任务 NPC 再也回不来
   * （quest-351 的阿诺德被雪之精灵村的战斗移除后无法交付）。
   */
  private absentKey(map:string,actor:string,characterId?:string):string{
    return JSON.stringify(['absent-actor',map,characterId??actor]);
  }
  private absentVisitKey(map:string,actor:string,characterId:string|undefined,visit:number):string{
    return JSON.stringify(['absent-actor-visit',visit,map,characterId??actor]);
  }
  get hasVisitAbsences():boolean {
    for(const flag of this.flags)if(flag.startsWith('["absent-actor-visit",'))return true;
    return false;
  }
  actorVisible(map:string,actor:string,characterId?:string,visit=this.mapVisit):boolean{
    return !this.flags.has(this.absentKey(map,actor,characterId))
      && !this.flags.has(this.absentVisitKey(map,actor,characterId,visit));
  }
  /** 清掉这次进图的临时缺席；永久清除名单（absent-actor）按剧情保持。 */
  clearVisitAbsence(map:string,actor:string,characterId?:string):boolean{
    if(!this.flags.delete(this.absentVisitKey(map,actor,characterId,this.mapVisit)))return false;
    this.revisionValue++;return true;
  }
  enemyAvailable(map:string,enemyId:string):boolean{return !this.flags.has(JSON.stringify(['absent-enemy',map,enemyId]));}
  projectEntities(map:string,base:readonly EntityPlacement[],definitions:readonly EntityPlacement[]=base,visit=this.mapVisit):EntityPlacement[]{
    const projected=new Map<string,EntityPlacement>();
    const located=new Set([...this.entities.values()].filter(entity=>placementAuthority(entity)==='registered'&&entity.map===map&&!entity.removed
      &&(entity.mapVisit===undefined||entity.mapVisit===visit)).map(entity=>entity.characterId??entity.actor));
    for(const entity of base){
      if(placementAuthority(entity)!=='registered'&&located.has(entity.characterId??entity.actor))continue;
      const stored=this.entities.get(entity.id);
      const override=stored?.mapVisit!==undefined&&stored.mapVisit!==visit?undefined:stored;
      if(override?.removed||(override?.map&&override.map!==map)||!this.actorVisible(map,override?.actor??entity.actor,override?.characterId??entity.characterId,visit))continue;
      projected.set(entity.id,{...entity,...override});
    }
    for(const entity of this.entities.values()){
      if(entity.removed||entity.map!==map||entity.mapVisit!==undefined&&entity.mapVisit!==visit
        ||placementAuthority(entity)!=='registered'&&located.has(entity.characterId??entity.actor)
        ||!entity.actor||!this.actorVisible(map,entity.actor,entity.characterId,visit)||entity.x===undefined||entity.y===undefined||projected.has(entity.id))continue;
      projected.set(entity.id,{...definitions.find(definition=>definition.id===entity.id),...entity,actor:entity.actor,x:entity.x,y:entity.y});
    }
    return [...projected.values()];
  }
  visible(id:string,visit=this.mapVisit):boolean{const value=this.entities.get(id);
    if(value?.mapVisit!==undefined&&value.mapVisit!==visit)return true;
    return !value?.removed&&value?.visible!==false;}
  /** 这个物件是不是剧情在世界里登记过的实例（而不是地图静态摆放）。 */
  isPlaced(id:string):boolean{return this.entities.has(id);}
  apply(command:StoryWorldCommand):void{
    this.revisionValue++;
    switch(command.kind){
      case 'remove-enemy':this.enemyRemovals.push({enemyId:command.enemyId,map:command.map,all:command.all});return;
      case 'enemy-location':{
        if(command.location)this.enemyLocations.set(command.enemyId,{id:'story-located-'+command.enemyId,enemyId:command.enemyId,...command.location,
          mapVisit:command.scope==='visit'?this.mapVisit+(command.location.map!==this.location?.map?1:0):undefined,
          ...(command.respawn===false?{respawn:false}:{})});
        else this.enemyLocations.delete(command.enemyId);return;
      }
      case 'actor-appearance':this.appearances.set(command.actor,command.appearance);return;
      case 'party-buff':this.partyBuffs.push({buff:command.buff,strength:command.strength});return;
      case 'place':{
        const entity=command.entity;
        if(!entity.id||!entity.map||!entity.actor||!Number.isFinite(entity.x)||!Number.isFinite(entity.y))throw new Error('剧情角色位置无效');
        // 位置登记是这个角色在这张图上的最终摆放：同一角色先前的过场实例只是摆位过程，
        // 留在世界里会和登记副本重叠成两个同名 NPC。旧存档里的重复实例由投影再挡一层。
        if(placementAuthority(entity)==='registered'&&entity.characterId)
          for(const [id,other] of this.entities)
            if(placementAuthority(other)==='story'&&other.characterId===entity.characterId&&other.map===entity.map&&!other.removed)this.entities.delete(id);
        // 常驻登记必须显式清掉旧的访问寿命：同一实例可能先由演出按 visit 登记，
        // 后续原版命令再把它永久摆出来；只靠对象展开会把旧的 mapVisit 留下来。
        this.entities.set(entity.id,{...this.entities.get(entity.id),...entity,authority:placementAuthority(entity),removed:false,
          mapVisit:command.scope==='visit'?this.mapVisit+(entity.map!==this.location?.map?1:0):undefined});
        // 任何可见登记都会把角色明确摆出来，撤销这张图上「角色不在场」的旧标记：
        // 事件常先 remove-character 再在后面的节点里重新登记（event-162 → event-163 的波西娅）。
        // 访问作用域同样要撤销，否则重新登场的过场角色会被上一次移除的静态标记挡住。
        if(entity.visible!==false&&entity.characterId){
          this.flags.delete(this.absentKey(entity.map,entity.actor,entity.characterId));
          this.flags.delete(this.absentVisitKey(entity.map,entity.actor,entity.characterId,this.mapVisit));
        }
        return;
      }
      case 'remove-character':{
        // 有位置登记时，这个角色在本图只有一个正式副本；旧存档遗留的过场副本一起撤下，
        // 否则登记副本先被移除后，过场副本会重新露出来。
        const registered=[...this.entities.values()].some(entity=>placementAuthority(entity)==='registered'
          &&entity.characterId===command.characterId&&entity.map===command.map&&!entity.removed);
        for(const entity of this.entities.values())if(entity.characterId===command.characterId&&entity.map===command.map&&!entity.removed){
          entity.removed=true;if(!command.all&&!registered)break;
        }
        // 地图静态摆放不在 `entities` 表里。只要本图这个角色已经没有任何可见的剧情实例，
        // 就记「本图缺少该角色」：场景刷新会同时隐藏静态副本并停掉碰撞。
        // 只在还有剧情实例留下时不记，避免 `all:false` 误伤同图的其他副本。
        // `all:true` 对应原版按 ID 清场（0x25），是永久的地图清除；`all:false` 对应 leave
        // （0x28），只撤下当前进图的静态副本，离开再回来由地图重新生成。
        if(command.characterId){
          const remaining=[...this.entities.values()].some(entity=>entity.characterId===command.characterId
            &&entity.map===command.map&&!entity.removed);
          if(!remaining)this.flags.add(command.all
            ? this.absentKey(command.map,command.characterId,command.characterId)
            : this.absentVisitKey(command.map,command.characterId,command.characterId,this.mapVisit));
        }
        return;
      }
      case 'show':case 'hide':case 'remove':{
        this.entities.set(command.id,{...this.entities.get(command.id),id:command.id,
          ...(command.kind==='remove'?{removed:true}:{visible:command.kind==='show',removed:false})});return;
      }
      case 'actor-visibility':case 'enemy-availability':{
        const key=command.kind==='actor-visibility'?JSON.stringify(['absent-actor',command.map,command.characterId??command.actor]):JSON.stringify(['absent-enemy',command.map,command.enemyId]);
        const available=command.kind==='actor-visibility'?command.visible:command.available;
        if(available){
          this.flags.delete(key);
          if(command.kind==='actor-visibility')
            this.flags.delete(this.absentVisitKey(command.map,command.actor,command.characterId,this.mapVisit));
        }else this.flags.add(key);return;
      }
      case 'exit':this.exits.set(command.id,command.enabled);return;
      case 'flag':if(command.value)this.flags.add(command.id);else this.flags.delete(command.id);return;
      case 'choice':this.choices.set(command.id,command.value);return;
      case 'travel':{
        if(!command.destination.map||!Number.isFinite(command.destination.x)||!Number.isFinite(command.destination.y))throw new Error('剧情转场位置无效');
        if(this.location?.map!==command.destination.map)this.mapVisit++;
        for(const entity of this.entities.values())if(entity.mapVisit!==undefined&&entity.mapVisit!==this.mapVisit)this.entities.delete(entity.id);
        for(const [id,enemy] of this.enemyLocations)if(enemy.mapVisit!==undefined&&enemy.mapVisit!==this.mapVisit)this.enemyLocations.delete(id);
        // 只属于上一次进图的静态缺席随转场过期；永久清除名单（absent-actor）继续保留。
        for(const flag of [...this.flags])if(flag.startsWith('["absent-actor-visit"')){
          const value=JSON.parse(flag) as unknown[];
          if(value[1]!==this.mapVisit)this.flags.delete(flag);
        }
        this.location={...command.destination};
        this.locationRevisionValue++;return;
      }
      case 'encounter':{
        this.validateEncounter(command.encounter);
        const existing=this.encounters.get(command.encounter.id);
        if(existing)throw new Error('剧情遭遇实例已经存在：'+existing.id);
        const encounter=structuredClone(command.encounter);
        this.encounters.set(encounter.id,encounter);
        if(encounter.status==='active')this.activeEncounterIds.add(encounter.id);
        this.encounterRevisionValue++;return;
      }
      case 'encounter-result':{
        const encounter=this.encounters.get(command.id);
        if(!encounter)throw new Error('剧情遭遇不存在：'+command.id);
        if(encounter.status==='won'||encounter.status==='lost'){
          if(encounter.status!==command.result)throw new Error('剧情遭遇结果冲突：'+command.id);
          return;
        }
        encounter.status=command.result;
        this.activeEncounterIds.delete(command.id);
        this.completedEncounterOrder.push(encounter.id);
        this.encounterRevisionValue++;
        this.pruneCompletedEncounters();return;
      }
    }
  }
  captureState():StoryWorldSnapshot{
    return structuredClone({entities:[...this.entities.values()],exits:[...this.exits],flags:[...this.flags],
      choices:[...this.choices],encounters:[...this.encounters.values()],location:this.location,mapVisit:this.mapVisit,partyBuffs:this.partyBuffs,appearances:[...this.appearances],enemyLocations:[...this.enemyLocations.values()],enemyRemovals:this.enemyRemovals});
  }
  prepareRestore(state:StoryWorldSnapshot):StoryWorldSnapshot{
    const result=structuredClone(state);
    for(const removal of result.enemyRemovals??[])if(!removal.enemyId||typeof removal.all!=='boolean')throw new Error('剧情敌人移除无效');
    for(const location of result.enemyLocations??[])if(!location.id||!location.enemyId||!location.map||!Number.isFinite(location.x)||!Number.isFinite(location.y))throw new Error('剧情敌人位置无效');
    for(const location of result.enemyLocations??[])if(location.respawn!==undefined&&location.respawn!==false||location.mapVisit!==undefined&&(!Number.isSafeInteger(location.mapVisit)||location.mapVisit<0))throw new Error('剧情临时敌人寿命无效');
    for(const buff of result.partyBuffs??[])if(!BATTLE_BUFF_KEYS.includes(buff.buff)||!Number.isSafeInteger(buff.strength)||buff.strength<0)throw new Error('剧情队伍状态无效');
    if(!Number.isSafeInteger(result.mapVisit)||result.mapVisit<0)throw new Error('剧情地图访问版本无效');
    for(const [name,ids]of [['角色',result.entities.map(e=>e.id)],['遭遇',result.encounters.map(e=>e.id)],['出口',result.exits.map(e=>e[0])],['选择',result.choices.map(e=>e[0])]] as const)
      if(ids.some(id=>!id)||new Set(ids).size!==ids.length)throw new Error('剧情'+name+'标识重复或无效');
    for(const entity of result.entities){
      if(entity.characterId!==undefined&&(typeof entity.characterId!=='string'||!entity.characterId))throw new Error('剧情人物身份无效');
      if(entity.authority!==undefined&&!['registered','npc','story','static'].includes(entity.authority))throw new Error('剧情角色来源无效');
      if(entity.mapVisit!==undefined&&(!Number.isSafeInteger(entity.mapVisit)||entity.mapVisit<0))throw new Error('剧情临时物件访问版本无效');
      if((entity.x!==undefined&&!Number.isFinite(entity.x))||(entity.y!==undefined&&!Number.isFinite(entity.y)))throw new Error('剧情角色快照位置无效');
      if(entity.facing!==undefined&&!['north','south','east','west'].includes(entity.facing))throw new Error('剧情角色快照朝向无效');
      if(entity.visible!==undefined&&typeof entity.visible!=='boolean'||entity.removed!==undefined&&typeof entity.removed!=='boolean')throw new Error('剧情角色快照可见状态无效');
    }
    if(result.location&&(!result.location.map||!Number.isFinite(result.location.x)||!Number.isFinite(result.location.y)||!['north','south','east','west'].includes(result.location.facing)))throw new Error('剧情世界快照落点无效');
    if(result.exits.some(([id,value])=>!id||typeof value!=='boolean')||result.choices.some(([id,value])=>!id||typeof value!=='string')
      ||result.flags.some(id=>!id)||new Set(result.flags).size!==result.flags.length)throw new Error('剧情世界快照标记无效');
    for(const encounter of result.encounters)this.validateEncounter(encounter);
    return result;
  }
  private validateEncounter(encounter:StoryEncounter):void{
    if(!encounter.id||!['prepared','active','won','lost'].includes(encounter.status)||!encounter.map
      ||new Set(encounter.spawns.map(spawn=>spawn.id)).size!==encounter.spawns.length
      ||encounter.spawns.some(spawn=>!spawn.id||!spawn.enemyId||!Number.isFinite(spawn.x)||!Number.isFinite(spawn.y)))throw new Error('剧情遭遇快照无效');
  }
  restoreState(state:StoryWorldSnapshot):void{
    this.revisionValue++;this.locationRevisionValue++;this.encounterRevisionValue++;
    const restored=this.prepareRestore(state);
    this.entities=new Map(restored.entities.map(e=>[e.id,e]));this.exits=new Map(restored.exits);
    this.flags=new Set(restored.flags);this.choices=new Map(restored.choices);
    this.encounters=new Map(restored.encounters.map(e=>[e.id,e]));
    // 整份快照替换后按快照顺序重建进行中索引，旧世界的索引不能残留。
    this.activeEncounterIds=new Set(restored.encounters.filter(e=>e.status==='active').map(e=>e.id));
    this.location=restored.location;this.mapVisit=restored.mapVisit;this.partyBuffs=restored.partyBuffs??[];this.enemyRemovals=restored.enemyRemovals??[];this.appearances=new Map(restored.appearances??[]);this.enemyLocations=new Map((restored.enemyLocations??[]).map(value=>[value.enemyId,value]));
    this.prunedEncounters=[];
    this.completedEncounterOrder=[...this.encounters.values()].filter(isCompletedEncounter).map(encounter=>encounter.id);
  }
}

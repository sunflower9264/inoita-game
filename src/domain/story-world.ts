import {BATTLE_BUFF_KEYS,type BattleBuffKey} from './battle-semantics.ts';
import type { EntityPlacement, Facing, MapExit, TravelDestination } from './content.ts';

export interface StoryEntityState {
  id:string;
  map?:string;
  actor?:string;
  characterId?:string;
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

/** Persistent story objects; temporary cinematic actors remain in the presentation scene. */
export class StoryWorldState {
  private entities=new Map<string,StoryEntityState>();
  private exits=new Map<string,boolean>();
  private flags=new Set<string>();
  private choices=new Map<string,string>();
  private encounters=new Map<string,StoryEncounter>();
  private location?:TravelDestination;
  private mapVisit=0;
  private enemyRemovals:{enemyId:string;map?:string;all:boolean}[]=[];
  get pendingEnemyRemovals(){return this.enemyRemovals.map(value=>({...value}));}
  consumeEnemyRemovals():void{this.enemyRemovals=[];}
  private enemyLocations=new Map<string,{id:string;enemyId:string;map:string;x:number;y:number;mapVisit?:number;respawn?:false}>();
  enemySpawns(map:string){return [...this.enemyLocations.values()].filter(value=>value.map===map).map(value=>({...value}));}
  private appearances=new Map<string,string>();
  actorAppearance(actor:string):string{return this.appearances.get(actor)??actor;}
  private partyBuffs:{buff:BattleBuffKey;strength:number}[]=[];
  get pendingPartyBuffs(){return this.partyBuffs.map(value=>({...value}));}
  consumePartyBuffs(count:number):void{this.partyBuffs.splice(0,count);}
  get currentLocation():TravelDestination|undefined{return this.location?{...this.location}:undefined;}
  get visit():number{return this.mapVisit;}
  hasFlag(id:string):boolean{return this.flags.has(id);}
  get flagIds():ReadonlySet<string>{return new Set(this.flags);}
  choice(id:string):string|undefined{return this.choices.get(id);}
  /** 选择快照：只复制 choices，避免剧情观察每次 emit 深拷贝整个世界。 */
  choiceValues():Map<string,string>{return new Map(this.choices);}
  /** 遭遇状态快照：观察只需要 id、status 和 definitionId。 */
  encounterStatuses():Map<string,{status:StoryEncounter['status'];definitionId?:string}>{
    const result=new Map<string,{status:StoryEncounter['status'];definitionId?:string}>();
    for(const [id,encounter] of this.encounters)result.set(id,{status:encounter.status,definitionId:encounter.definitionId});
    return result;
  }
  entity(id:string):Readonly<StoryEntityState>|undefined{const value=this.entities.get(id);return value?{...value}:undefined;}
  encounter(id:string):Readonly<StoryEncounter>|undefined{const value=this.encounters.get(id);return value?structuredClone(value):undefined;}
  get activeEncounters():readonly StoryEncounter[]{return [...this.encounters.values()].filter(e=>e.status==='active').map(e=>structuredClone(e));}
  exitEnabled(map:string,exit:MapExit):boolean{return this.exits.get(storyExitId(map,exit))!==false;}
  actorVisible(map:string,actor:string,characterId?:string):boolean{return !this.flags.has(JSON.stringify(['absent-actor',map,characterId??actor]));}
  enemyAvailable(map:string,enemyId:string):boolean{return !this.flags.has(JSON.stringify(['absent-enemy',map,enemyId]));}
  projectEntities(map:string,base:readonly EntityPlacement[],definitions:readonly EntityPlacement[]=base,visit=this.mapVisit):EntityPlacement[]{
    const projected=new Map<string,EntityPlacement>();
    const located=new Set([...this.entities.values()].filter(entity=>entity.id.startsWith('quest-npc-located-')&&entity.map===map&&!entity.removed
      &&(entity.mapVisit===undefined||entity.mapVisit===visit)).map(entity=>entity.characterId??entity.actor));
    for(const entity of base){
      if(!entity.id.startsWith('quest-npc-located-')&&located.has(entity.characterId??entity.actor))continue;
      const stored=this.entities.get(entity.id);
      const override=stored?.mapVisit!==undefined&&stored.mapVisit!==visit?undefined:stored;
      if(override?.removed||(override?.map&&override.map!==map)||!this.actorVisible(map,override?.actor??entity.actor,override?.characterId??entity.characterId))continue;
      projected.set(entity.id,{...entity,...override});
    }
    for(const entity of this.entities.values()){
      if(entity.removed||entity.map!==map||entity.mapVisit!==undefined&&entity.mapVisit!==visit||!entity.actor||!this.actorVisible(map,entity.actor,entity.characterId)||entity.x===undefined||entity.y===undefined||projected.has(entity.id))continue;
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
        // 常驻登记必须显式清掉旧的访问寿命：同一实例可能先由演出按 visit 登记，
        // 后续原版命令再把它永久摆出来；只靠对象展开会把旧的 mapVisit 留下来。
        this.entities.set(entity.id,{...this.entities.get(entity.id),...entity,removed:false,
          mapVisit:command.scope==='visit'?this.mapVisit+(entity.map!==this.location?.map?1:0):undefined});
        // 常驻登记（非访问作用域）把角色明确摆出来时，撤销这张图上「角色不在场」的旧标记：
        // 事件常先 remove-character 再在后面的节点里重新登记（event-162 → event-163 的波西娅）。
        if(command.scope!=='visit'&&entity.visible!==false&&entity.characterId)
          this.flags.delete(JSON.stringify(['absent-actor',entity.map,entity.characterId]));
        return;
      }
      case 'remove-character':{
        let matched=false;
        for(const entity of this.entities.values())if(entity.characterId===command.characterId&&entity.map===command.map&&!entity.removed){
          entity.removed=true;matched=true;if(!command.all)break;
        }
        // 地图静态摆放不在 `entities` 表里：没有剧情实例可移除时，按「本图缺少该角色」
        // 记录，投影与场景刷新才会隐藏它并停掉碰撞。
        if(!matched&&command.characterId)this.flags.add(JSON.stringify(['absent-actor',command.map,command.characterId]));
        return;
      }
      case 'show':case 'hide':case 'remove':{
        this.entities.set(command.id,{...this.entities.get(command.id),id:command.id,
          ...(command.kind==='remove'?{removed:true}:{visible:command.kind==='show',removed:false})});return;
      }
      case 'actor-visibility':case 'enemy-availability':{
        const key=command.kind==='actor-visibility'?JSON.stringify(['absent-actor',command.map,command.characterId??command.actor]):JSON.stringify(['absent-enemy',command.map,command.enemyId]);
        const available=command.kind==='actor-visibility'?command.visible:command.available;
        if(available)this.flags.delete(key);else this.flags.add(key);return;
      }
      case 'exit':this.exits.set(command.id,command.enabled);return;
      case 'flag':if(command.value)this.flags.add(command.id);else this.flags.delete(command.id);return;
      case 'choice':this.choices.set(command.id,command.value);return;
      case 'travel':{
        if(!command.destination.map||!Number.isFinite(command.destination.x)||!Number.isFinite(command.destination.y))throw new Error('剧情转场位置无效');
        if(this.location?.map!==command.destination.map)this.mapVisit++;
        for(const entity of this.entities.values())if(entity.mapVisit!==undefined&&entity.mapVisit!==this.mapVisit)this.entities.delete(entity.id);
        for(const [id,enemy] of this.enemyLocations)if(enemy.mapVisit!==undefined&&enemy.mapVisit!==this.mapVisit)this.enemyLocations.delete(id);
        this.location={...command.destination};return;
      }
      case 'encounter':{
        this.validateEncounter(command.encounter);
        const existing=this.encounters.get(command.encounter.id);
        if(existing)throw new Error('剧情遭遇实例已经存在：'+existing.id);
        this.encounters.set(command.encounter.id,structuredClone(command.encounter));return;
      }
      case 'encounter-result':{
        const encounter=this.encounters.get(command.id);
        if(!encounter)throw new Error('剧情遭遇不存在：'+command.id);
        if(encounter.status==='won'||encounter.status==='lost'){
          if(encounter.status!==command.result)throw new Error('剧情遭遇结果冲突：'+command.id);
          return;
        }
        encounter.status=command.result;return;
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
    const restored=this.prepareRestore(state);
    this.entities=new Map(restored.entities.map(e=>[e.id,e]));this.exits=new Map(restored.exits);
    this.flags=new Set(restored.flags);this.choices=new Map(restored.choices);
    this.encounters=new Map(restored.encounters.map(e=>[e.id,e]));this.location=restored.location;this.mapVisit=restored.mapVisit;this.partyBuffs=restored.partyBuffs??[];this.enemyRemovals=restored.enemyRemovals??[];this.appearances=new Map(restored.appearances??[]);this.enemyLocations=new Map((restored.enemyLocations??[]).map(value=>[value.enemyId,value]));
  }
}

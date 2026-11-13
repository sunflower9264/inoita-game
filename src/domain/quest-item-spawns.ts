import type { QuestItemSpawn } from './content.ts';
import type { GroundLootStore } from './ground-loot.ts';

/** 原版任务生成点共用 150 帧检查间隔；生成器的剩余帧也按这个节奏递减。 */
const GENERATOR_CHECK_INTERVAL_FRAMES = 150;

interface ItemGeneratorState { id:string; remainingFrames:number; dropId?:string; exhausted:boolean }
export interface QuestItemGenerationState {
  map?:string;
  mapVisit:number;
  nextCheckFrame:number;
  generators:ItemGeneratorState[];
}

/** Native generation checks share a 150-frame gate; individual timers use gameplay frames. */
export class QuestItemGenerators {
  private state:QuestItemGenerationState={mapVisit:0,nextCheckFrame:0,generators:[]};
  private definitions=new Map<string,QuestItemSpawn>();

  enter(map:string,mapVisit:number,definitions:readonly QuestItemSpawn[],ground:GroundLootStore):void {
    const incoming=new Map(definitions.map(definition=>[definition.id,definition]));
    if(this.state.map===map&&this.state.mapVisit===mapVisit){
      if(this.state.generators.length!==incoming.size||this.state.generators.some(generator=>!incoming.has(generator.id)))throw new Error('任务地面物品生成点与当前地图不符');
      this.definitions=incoming;return;
    }
    const previousDrops=new Set(this.state.generators.flatMap(generator=>generator.dropId?[generator.dropId]:[]));
    if(previousDrops.size){const saved=ground.captureState();saved.drops=saved.drops.filter(drop=>!previousDrops.has(drop.id));ground.restoreState(saved);}
    this.definitions=incoming;
    this.state={map,mapVisit,nextCheckFrame:0,generators:definitions.map(definition=>({id:definition.id,remainingFrames:0,exhausted:false}))};
  }

  /**
   * `canProduce` 由会话层按“任务道具还差多少件”判断。
   * 前一个生成点产出的物品会立刻算进后一个的判断，所以同一帧也会自然停在上限。
   */
  advance(frame:number,canProduce:(definition:QuestItemSpawn)=>boolean,ground:GroundLootStore):void {
    if(!this.state.map||this.state.nextCheckFrame>=frame)return;
    for(const generator of this.state.generators){
      if(generator.exhausted||generator.dropId)continue;
      const definition=this.definitions.get(generator.id);if(!definition)continue;
      if(generator.remainingFrames>0)generator.remainingFrames-=GENERATOR_CHECK_INTERVAL_FRAMES;
      if(generator.remainingFrames>0||!canProduce(definition))continue;
      const [drop]=ground.add(this.state.map,definition.x,definition.y,[{kind:'item',item:definition.item,quantity:1}]);
      generator.dropId=drop.id;
    }
    this.state.nextCheckFrame=frame+GENERATOR_CHECK_INTERVAL_FRAMES;
  }

  collected(dropIds:readonly string[],frame:number):void {
    const collected=new Set(dropIds);
    for(const generator of this.state.generators)if(generator.dropId&&collected.has(generator.dropId)){
      const definition=this.definitions.get(generator.id);if(!definition)throw new Error('任务地面物品生成点尚未载入');
      delete generator.dropId;
      if(definition.respawnFrames===0){generator.exhausted=true;generator.remainingFrames=0;}
      else generator.remainingFrames=definition.respawnFrames-this.state.nextCheckFrame+frame+generator.remainingFrames;
    }
  }

  captureState():QuestItemGenerationState{return structuredClone(this.state);}
  restoreState(state:QuestItemGenerationState,ground?:GroundLootStore):void {
    if(!state||!Number.isSafeInteger(state.mapVisit)||state.mapVisit<0||!Number.isSafeInteger(state.nextCheckFrame)||state.nextCheckFrame<0||!Array.isArray(state.generators))throw new Error('任务地面物品生成状态无效');
    if(state.map!==undefined&&(typeof state.map!=='string'||!state.map))throw new Error('任务地面物品地图无效');
    const ids=new Set<string>(),drops=new Set<string>();
    for(const generator of state.generators){
      if(!generator||typeof generator.id!=='string'||!generator.id||ids.has(generator.id)||!Number.isSafeInteger(generator.remainingFrames)||typeof generator.exhausted!=='boolean')throw new Error('任务地面物品生成器无效');
      ids.add(generator.id);
      if(generator.dropId!==undefined){
        if(typeof generator.dropId!=='string'||!generator.dropId||drops.has(generator.dropId)||!state.map||ground&&!ground.forMap(state.map).some(drop=>drop.id===generator.dropId))throw new Error('任务地面物品实例无效');
        drops.add(generator.dropId);
      }
    }
    if(!state.map&&state.generators.length)throw new Error('任务地面物品缺少地图');
    const retain=this.state.map===state.map&&state.generators.every(generator=>this.definitions.has(generator.id));
    this.state=structuredClone(state);if(!retain)this.definitions.clear();
  }
}

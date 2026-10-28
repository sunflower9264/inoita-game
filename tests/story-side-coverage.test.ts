import assert from 'node:assert/strict';
import test from 'node:test';
import {headlessContent} from './helpers/story-playthrough.ts';

type Placement={map:string;x:number;y:number;characterId?:string};
type Spawn={map:string;x:number;y:number};
type Gap={quest:string;reason:string};

/**
 * 支线全流程覆盖台账：把“有哪些任务可自动跑、哪些跑不了、为什么”冻结成发布门槛。
 * 这里只检查路线能否从内容构造；实际完成和交付由击倒、物品、交互三条回放测试验证。
 */
test('active side quest coverage stays explicit and every gap has a reason',()=>{
  const {campaign,maps,items}=headlessContent;
  const groupKind=new Map<string,string>();
  for(const group of campaign.questGroups)for(const id of group.questIds)groupKind.set(id,group.kind);
  const hidden=new Set(campaign.quests.filter(quest=>quest.hidden).map(quest=>quest.id));
  const isSide=(quest:string)=>hidden.has(quest)||groupKind.get(quest)==='side';
  const questById=new Map(campaign.quests.map(quest=>[quest.id,quest]));
  const placements:Placement[]=[];
  for(const [mapId,map] of maps)for(const entity of map.entities)
    if(entity.characterId)placements.push({map:mapId,x:entity.x,y:entity.y,characterId:entity.characterId});
  for(const entity of campaign.placements??[])
    if(entity.characterId)placements.push({map:entity.map,x:entity.x,y:entity.y,characterId:entity.characterId});
  const spawnsFor=(enemyId:string):Spawn[]=>{
    const result:Spawn[]=[];
    for(const [mapId,map] of maps)for(const spawn of map.enemySpawns??[])
      if(spawn.enemyId===enemyId)result.push({map:mapId,x:spawn.x,y:spawn.y});
    for(const spawn of campaign.enemyPlacements??[])
      if(spawn.enemyId===enemyId)result.push({map:spawn.map,x:spawn.x,y:spawn.y});
    return result;
  };
  const hasDelivery=(questId:string)=>placements.some(placement=>placement.characterId===questById.get(questId)?.deliveryCharacterId);
  const coverage={defeat:0,item:0,interact:0};
  const gaps:Gap[]=[];
  for(const task of campaign.debugStory?.tasks??[]){
    if(task.phase!=='active'||!isSide(task.quest))continue;
    const quest=questById.get(task.quest);
    if(!quest?.goals?.length){gaps.push({quest:task.quest,reason:'没有目标'});continue;}
    const kinds=[...new Set(quest.goals.map(goal=>goal.kind))];
    if(kinds.length>1){gaps.push({quest:task.quest,reason:`混合目标 ${kinds.join('+')}`});continue;}
    const kind=kinds[0];
    if(kind==='defeat'){
      const required=new Map<string,number>();
      for(const goal of quest.goals)required.set(goal.target,(required.get(goal.target)??0)+goal.quantity);
      let runnable=!!quest.deliveryCharacterId&&hasDelivery(quest.id);
      for(const [enemyId,quantity]of required)if(spawnsFor(enemyId).length<quantity)runnable=false;
      if(!runnable){gaps.push({quest:task.quest,reason:'击倒路线不可构造（缺交付人或生成点）'});continue;}
      coverage.defeat++;continue;
    }
    if(kind==='item'){
      const runnable=!!quest.deliveryCharacterId&&hasDelivery(quest.id)&&quest.goals.every(goal=>items.items[goal.target]);
      if(!runnable){gaps.push({quest:task.quest,reason:'物品路线不可构造（缺物品或交付人）'});continue;}
      coverage.item++;continue;
    }
    if(kind==='interact'){
      let runnable=!!quest.deliveryCharacterId&&hasDelivery(quest.id);
      for(const goal of quest.goals){
        const change=quest.targetChanges?.find(candidate=>candidate.goal===goal.id);
        if(!change?.enemyId||spawnsFor(change.enemyId).length<goal.quantity)runnable=false;
      }
      if(!runnable){gaps.push({quest:task.quest,reason:'交互路线不可构造（缺捕获源或交付人）'});continue;}
      coverage.interact++;continue;
    }
    gaps.push({quest:task.quest,reason:`目标类型 ${kind} 暂无自动回放`});
  }
  assert.deepEqual(coverage,{defeat:28,item:53,interact:7},'可自动完成的击倒、物品、交互支线数量发生变化');
  assert.deepEqual(gaps.map(gap=>gap.quest).sort(),['quest-132','quest-181','quest-226','quest-234','quest-301','quest-471','quest-73','quest-86','quest-93'],
    '未覆盖的支线必须逐条列在台账里');
  assert.ok(gaps.every(gap=>gap.reason.trim()),'每条未覆盖支线都要写原因');
});

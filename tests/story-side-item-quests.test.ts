import assert from 'node:assert/strict';
import test from 'node:test';
import {prepareTaskStart} from '../src/debug/story-jump.ts';
import {headlessContent,playthrough} from './helpers/story-playthrough.ts';

type Placement={map:string;x:number;y:number;characterId?:string};

test('active item side quests can be satisfied and handed in through the real director',async()=>{
  const {campaign,maps,items}=headlessContent;
  const groupKind=new Map<string,string>();
  for(const group of campaign.questGroups)for(const id of group.questIds)groupKind.set(id,group.kind);
  const hidden=new Set(campaign.quests.filter(quest=>quest.hidden).map(quest=>quest.id));
  const isSide=(quest:string)=>hidden.has(quest)||groupKind.get(quest)==='side';
  const placements:Placement[]=[];
  for(const [mapId,map] of maps)for(const entity of map.entities)
    if(entity.characterId)placements.push({map:mapId,x:entity.x,y:entity.y,characterId:entity.characterId});
  for(const entity of campaign.placements??[])
    if(entity.characterId)placements.push({map:entity.map,x:entity.x,y:entity.y,characterId:entity.characterId});
  const base=playthrough();
  const failures:string[]=[];
  const unsupported:string[]=[];
  let passed=0;
  try{
    for(const task of campaign.debugStory?.tasks??[]){
      if(task.phase!=='active'||!isSide(task.quest))continue;
      const quest=campaign.quests.find(candidate=>candidate.id===task.quest);
      if(!quest?.goals?.length||!quest.goals.every(goal=>goal.kind==='item')||!quest.deliveryCharacterId)continue;
      if(quest.goals.some(goal=>!items.items[goal.target])){unsupported.push(`${task.quest}: 物品不存在`);continue;}
      const delivery=placements.find(placement=>placement.characterId===quest.deliveryCharacterId);
      if(!delivery){unsupported.push(`${task.quest}: 找不到交付人 ${quest.deliveryCharacterId}`);continue;}
      const prepared=await prepareTaskStart(base.session,{quest:task.quest});
      const h=playthrough(prepared);
      try{
        for(const goal of quest.goals)h.session.bag.add(goal.target,goal.quantity);
        h.session.emit();
        await h.idle();
        assert.equal(h.session.status(quest.id),'ready',`${quest.id} 集齐物品后应可交付`);
        h.session.applyStoryCommands([{type:'travel',destination:{map:delivery.map,x:delivery.x,y:delivery.y,facing:'south'}}]);
        await h.idle();
        const entity=h.entities().find(candidate=>candidate.characterId===quest.deliveryCharacterId);
        assert.ok(entity,`${quest.id} 交付人应在地图上`);
        await h.director.interact(entity,headlessContent.world.actors[entity.actor]);
        await h.idle();
        const finalStatus=h.session.status(quest.id);
        assert.ok(finalStatus==='completed'||(quest.repeat&&finalStatus==='available'),
          `${quest.id} 交任务后应完成${quest.repeat?'（可重复任务应回到 available）':''}`);
        passed++;
      }catch(error){
        failures.push(`${task.quest}: ${error instanceof Error?error.message:String(error)}`);
      }finally{
        h.director.dispose();
      }
    }
  }finally{
    base.director.dispose();
  }
  assert.deepEqual(failures,[],`可执行物品支线失败；通过 ${passed} 条，未覆盖 ${unsupported.length} 条`);
  assert.ok(passed>=20,`实际只通过 ${passed} 条物品支线`);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {prepareTaskStart} from '../src/debug/story-jump.ts';
import {headlessContent,playthrough} from './helpers/story-playthrough.ts';

type Placement={map:string;x:number;y:number;characterId?:string};

test('active interaction side quests can capture targets and be handed in through the real director',async()=>{
  const {campaign,maps}=headlessContent;
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
      if(!quest?.goals?.length||!quest.goals.every(goal=>goal.kind==='interact')||!quest.deliveryCharacterId)continue;
      const route:{enemyId:string;map:string;x:number;y:number;target:string;characterId?:string}[]=[];
      let missing=false;
      for(const goal of quest.goals){
        const change=quest.targetChanges?.find(candidate=>candidate.goal===goal.id);
        if(!change?.enemyId){unsupported.push(`${task.quest}: ${goal.id} 没有捕获源敌人`);missing=true;break;}
        const candidates:{map:string;x:number;y:number}[]=[];
        for(const [mapId,map] of maps)for(const spawn of map.enemySpawns??[])
          if(spawn.enemyId===change.enemyId)candidates.push({map:mapId,x:spawn.x,y:spawn.y});
        for(const spawn of campaign.enemyPlacements??[])
          if(spawn.enemyId===change.enemyId)candidates.push({map:spawn.map,x:spawn.x,y:spawn.y});
        if(candidates.length<goal.quantity){unsupported.push(`${task.quest}: ${change.enemyId} 需要 ${goal.quantity} 个生成点，只有 ${candidates.length} 个`);missing=true;break;}
        route.push(...candidates.slice(0,goal.quantity).map(spawn=>({...spawn,enemyId:change.enemyId,target:goal.target,characterId:goal.characterId})));
      }
      if(missing)continue;
      const delivery=placements.find(placement=>placement.characterId===quest.deliveryCharacterId);
      if(!delivery){unsupported.push(`${task.quest}: 找不到交付人 ${quest.deliveryCharacterId}`);continue;}
      const prepared=await prepareTaskStart(base.session,{quest:task.quest});
      const h=playthrough(prepared);
      try{
        const travelTo=async(map:string,x:number,y:number)=>{
          h.session.applyStoryCommands([{type:'travel',destination:{map,x,y,facing:'south'}}]);
          await h.idle();
        };
        for(const step of route){
          await travelTo(step.map,step.x,step.y);
          await h.damage(step.enemyId,0.05);
          const target=h.entities().find(candidate=>candidate.characterId===step.characterId||candidate.actor===step.target);
          assert.ok(target,`${quest.id} 捕获目标 ${step.target} 应出现`);
          await h.director.interact(target,headlessContent.world.actors[target.actor]);
          await h.idle();
        }
        assert.equal(h.session.status(quest.id),'ready',`${quest.id} 交互完成后应可交付`);
        await travelTo(delivery.map,delivery.x,delivery.y);
        const giver=h.entities().find(candidate=>candidate.characterId===quest.deliveryCharacterId);
        assert.ok(giver,`${quest.id} 交付人应在地图上`);
        await h.director.interact(giver,headlessContent.world.actors[giver.actor]);
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
  assert.deepEqual(failures,[],`可执行交互支线失败；通过 ${passed} 条，未覆盖 ${unsupported.length} 条`);
  assert.ok(passed>=7,`实际只通过 ${passed} 条交互支线`);
});

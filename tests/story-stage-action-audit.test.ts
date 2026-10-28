import assert from 'node:assert/strict';
import test from 'node:test';
import {assertUniqueActorInstances} from '../src/domain/actor-census.ts';
import {mapPlacementCandidates} from '../src/domain/map-placement.ts';
import {applyStorySceneAction,resolveStoryScene} from '../src/domain/story-scene.ts';
import {assertScenePlan,planScene} from '../src/domain/scene-plan.ts';
import type {SceneActorState} from '../src/domain/scene-snapshot.ts';
import type {PerformanceAction,StoryStage} from '../src/domain/story-performance.ts';
import {headlessContent} from './helpers/story-playthrough.ts';

test('every stage declaration can replay its local presentation without duplicate actors',()=>{
  const {campaign,maps}=headlessContent;
  let stages=0,actions=0;
  for(const [script,body] of Object.entries(campaign.scripts as Record<string,{nodes:any[]}>)){
    for(const node of body.nodes){
      for(const stage of (node.presentation??[]).filter((action:any)=>action.type==='stage') as StoryStage[]){
        stages++;
        const map=maps.get(stage.map);
        assert.ok(map,`${script}/${node.id}: 地图不存在 ${stage.map}`);
        const actors:SceneActorState[]=[
          {id:'player',actor:campaign.start.actor,memberId:'player',x:stage.x,y:stage.y,facing:stage.facing,
            visible:stage.playerVisible},
          ...mapPlacementCandidates(map!,campaign as never).map(entity=>({
            id:`entity:${entity.id}`,actor:entity.actor,characterId:entity.characterId,worldEntityId:entity.id,
            x:entity.x??0,y:entity.y??0,
            facing:(entity as typeof entity & {facing?:'north'|'south'|'east'|'west'}).facing??'south',visible:true,
          })),
        ];
        let snapshot=resolveStoryScene(stage,{map:stage.map,actors});
        assertUniqueActorInstances(snapshot.scene.actors,`${script}/${node.id}/stage`);
        assertScenePlan(planScene(snapshot.scene,snapshot.bindings));
        for(const action of node.presentation??[] as PerformanceAction[]){
          if(action===stage)continue;
          if(action.type==='stage')break;
          if(action.type==='dialogue'||action.type==='choice'||action.type==='quest-popup'||action.type==='sound'
            ||action.type==='music'||action.type==='wait'||action.type==='fade'||action.type==='camera-point')continue;
          snapshot=applyStorySceneAction(snapshot,action);
          actions++;
          assertUniqueActorInstances(snapshot.scene.actors,`${script}/${node.id}/${action.type}`);
          assertScenePlan(planScene(snapshot.scene,snapshot.bindings));
        }
      }
    }
  }
  assert.ok(stages>=700,`只审计到 ${stages} 个舞台`);
  assert.ok(actions>=1000,`只审计到 ${actions} 个舞台动作`);
});

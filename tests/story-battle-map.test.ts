import assert from 'node:assert/strict';
import { stageSnapshot } from './helpers/story-stage.ts';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import type {Campaign} from '../src/domain/campaign.ts';
import type {WorldIndex,WorldMap} from '../src/domain/content.ts';
import {Session} from '../src/domain/session.ts';
import {StoryDirector,type StoryUI} from '../src/domain/story-director.ts';
import {type StoryStage,type StoryPresentationPort} from '../src/domain/story-performance.ts';
import {resolveStoryScene} from '../src/domain/story-scene.ts';
import {NavigationWorld} from '../src/domain/navigation-world.ts';

const read=<T>(name:string):T=>JSON.parse(readFileSync(new URL('../public/content/'+name+'.json',import.meta.url),'utf8'));
const published=read<Campaign>('campaign'),world=read<WorldIndex>('world');
const trial=read<WorldMap>('maps/room-of-trials-14ea25e4'),road=read<WorldMap>('maps/road-of-truth-4458f0db');
const stages=(event:number)=>published.scripts['event-'+event].nodes.flatMap(node=>node.presentation).filter(action=>action.type==='stage');

// Isolate the formal battle aftermath: no preceding chapter state or fabricated exits.
test('371 inherits its actual battlefield, clears the trial-room barriers and keeps the native road exit reachable',async()=>{
  const campaign:Campaign={...published,events:[],questGroups:[],placements:[],mapEntryPlacements:[]};
  const session=new Session(campaign);
  session.applyStoryCommands([{type:'travel',destination:{map:trial.id,x:264,y:232,facing:'south'}}]);
  session.accept('quest-315');session.accept('quest-316');
  for(const node of published.scripts['event-369'].nodes)for(const command of node.commands)
    if(command.type==='world'&&command.command.kind==='place')session.applyStoryCommands([command]);
  assert.equal(session.storyWorld.projectEntities(trial.id,[]).filter(entity=>entity.characterId==='npc-303').length,8);
  let stage:StoryStage={type:'stage',map:trial.id,x:264,y:232,facing:'south',playerVisible:true,cast:[]};
  const presentation:StoryPresentationPort={begin(){},async execute(action){
    if(action.type==='stage'){
      const prior=stage;stage=resolveStoryScene(action,stageSnapshot(stage).scene);
      if(action.retainPlayerPosition&&stage.map===prior.map)Object.assign(stage,{x:prior.x,y:prior.y,facing:prior.facing});
    }else if('target' in action&&action.target==='player'){
      if(action.type==='appear'||action.type==='walk')Object.assign(stage,{x:action.x,y:action.y});
      if(action.type==='face'||action.type==='appear')stage.facing=action.facing;
    }
  },getStageState:()=>stageSnapshot(stage),getWorldChanges:()=>[],async finish(){},release(){}};
  const ui:StoryUI={async dialogue(){},async choice(_prompt,options){return options[0];},async questPopup(){},
    closeDialogue(){},skipDialogue(){}};
  const director=new StoryDirector(campaign,session,ui,()=>{},presentation);
  try{
    await director.script('event-371');
    assert.equal(session.status('quest-316'),'completed');
    assert.equal(session.storyWorld.currentLocation?.map,trial.id,'a matching monster in another chapter cannot move the battlefield');
    const entities=session.storyWorld.projectEntities(trial.id,[]).filter(entity=>session.storyWorld.visible(entity.id));
    assert.equal(entities.filter(entity=>entity.characterId==='npc-303').length,0);
    const chest=entities.find(entity=>entity.characterId==='npc-212');assert.ok(chest);
    assert.deepEqual([chest.x,chest.y,session.storyWorld.entity(chest.id)?.mapVisit],[472,232,undefined],
      'the one-time story chest remains available across map visits');
    const exit=trial.exits[2];assert.equal(exit.destination,road.id);
    assert.deepEqual(exit.spawn,{x:24,y:184});
    assert.equal(session.storyWorld.exitEnabled(trial.id,exit),true);
    const navigation=new NavigationWorld(trial),location=session.storyWorld.currentLocation!;
    const player={position:()=>location,shape:()=>world.actors[published.start.actor],enabled:()=>true};
    navigation.register(player);
    for(const entity of entities)navigation.register({position:()=>entity,shape:()=>world.actors[entity.actor],enabled:()=>true});
    assert.ok(navigation.path(player,{x:564,y:228}),'the cleared original east exit has a physical walking path');
    session.applyStoryCommands([{type:'travel',destination:{map:exit.destination,...exit.spawn,facing:'east'}}]);
    const ending=published.events.find(event=>event.id==='event-372')!;
    assert.equal(session.storyWorld.currentLocation?.map,ending.map);
    assert.equal(session.evaluateCondition(ending.condition!),true);
    session.applyStoryCommands([{type:'travel',destination:{map:trial.id,x:264,y:232,facing:'south'}}]);
    assert.ok(session.storyWorld.projectEntities(trial.id,[]).some(entity=>entity.id===chest.id),
      'returning to the battlefield preserves its one-time reward chest');
  }finally{director.dispose();}
});

test('battle stage inheritance preserves an explicit later native map change',()=>{
  const declaration=stages(371)[0];assert.equal(declaration.mapFromWorld,true);
  const actual:StoryStage={type:'stage',map:trial.id,x:264,y:232,facing:'south',playerVisible:true,cast:[]};
  assert.equal(resolveStoryScene(declaration,stageSnapshot(actual).scene).map,trial.id);
  // 402 changes maps after the seal battle. `resolveStoryScene` 以传入场景为准，所以旧地图的
  // 缓存不能冒充目标图；presenter 会在 `resetActors` 时为目标图重新准备 source。
  const destination=stages(402).find(stage=>stage.map==='elven-sanctuary-entrance-36976f1d'&&stage.resetActors);assert.ok(destination);
  assert.equal(destination.mapFromWorld,undefined);
  assert.equal(resolveStoryScene(destination,stageSnapshot(actual).scene).map,trial.id,'旧地图缓存不会把舞台带到新图');
  const prepared=stageSnapshot({...actual,map:destination.map}).scene;
  assert.equal(prepared.map,destination.map);
  assert.equal(resolveStoryScene(destination,prepared).map,destination.map,'为目标图准备好 source 后才切过去');
});

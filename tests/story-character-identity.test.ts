import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import type {Campaign} from '../src/domain/campaign.ts';
import {Session} from '../src/domain/session.ts';
import {StoryDirector,type StoryUI} from '../src/domain/story-director.ts';
import type {StoryStage} from '../src/domain/story-performance.ts';
import {resolveStoryScene} from '../src/domain/story-scene.ts';
import {stageSnapshot} from './helpers/story-stage.ts';

const campaign=JSON.parse(readFileSync(new URL('../public/content/campaign.json',import.meta.url),'utf8')) as Campaign;

test('four native goblins keep all four registered locations after saving, moving and removing one',()=>{
  const session=new Session(campaign);
  const commands=campaign.scripts['event-20'].nodes.flatMap(node=>node.commands).filter(command=>command.type==='world'&&command.command.kind==='place');
  session.applyStoryCommands(commands);
  const restored=new Session(campaign);restored.restoreState(session.captureState());
  const map='hakan-desert-4-7c711a9e';
  const actors=restored.storyWorld.projectEntities(map,[]);
  assert.deepEqual(actors.map(actor=>[actor.x,actor.y]),[[392,328],[456,328],[392,296],[456,296]]);
  assert.equal(new Set(actors.map(actor=>actor.characterId)).size,4);
  assert.equal(new Set(actors.map(actor=>actor.actor)).size,1);
  restored.storyWorld.apply({kind:'remove',id:actors[0].id});
  assert.equal(restored.storyWorld.projectEntities(map,[]).length,3);
});

test('moving and hiding one character leaves a different character with the same appearance in place',()=>{
  const session=new Session(campaign),base=[
    {id:'north',characterId:'north-guard',actor:'guard',x:24,y:24},
    {id:'south',characterId:'south-guard',actor:'guard',x:24,y:72},
  ];
  session.storyWorld.apply({kind:'place',entity:{id:'quest-npc-located-north',characterId:'north-guard',actor:'guard',map:'village',x:72,y:24}});
  assert.deepEqual(session.storyWorld.projectEntities('village',base).map(entity=>[entity.characterId,entity.x,entity.y]),
    [['south-guard',24,72],['north-guard',72,24]]);
  session.storyWorld.apply({kind:'actor-visibility',map:'village',actor:'guard',characterId:'north-guard',visible:false});
  assert.deepEqual(session.storyWorld.projectEntities('village',base),[base[1]]);
});

test('quest offers, objectives and delivery distinguish two characters sharing one appearance',()=>{
  const quests=['north','south'].map(id=>({id,title:id,description:id,giver:'guard',giverCharacterId:id,delivery:'guard',deliveryCharacterId:id,
    guidance:{available:id,active:id},completion:'all' as const,goals:[{id:'talk',kind:'interact' as const,target:'guard',characterId:id,quantity:1}],progressText:id,completeText:id}));
  const session=new Session({...campaign,events:[],quests,questGroups:[{id:'guards',title:'guards',kind:'side',questIds:['north','south']}]});
  assert.deepEqual(session.forActor('guard','north').map(quest=>quest.id),['north']);
  session.accept('north');session.accept('south');
  assert.equal(session.interact('guard','south-instance','south'),true);
  assert.equal(session.status('south'),'ready');assert.equal(session.status('north'),'active');
  assert.deepEqual(session.forActor('guard','north').map(quest=>quest.id),['north']);
  assert.deepEqual(session.forActor('guard','south').map(quest=>quest.id),['south']);
});

test('near events dispatch only for the approached character, including characters with the same appearance',async()=>{
  const content:Campaign={...campaign,quests:[],questGroups:[],events:['north','south'].map(id=>({id,source:'near',near:'guard',nearCharacterId:id,script:id})),
    scripts:Object.fromEntries(['north','south'].map(id=>[id,{entry:'done',nodes:[{id:'done',presentation:[],commands:[{type:'flag',flag:id}],exit:{type:'end'}}]}]))};
  const session=new Session(content);
  const ui:StoryUI={async dialogue(){},async choice(_prompt,options){return options[0];},async questPopup(){},closeDialogue(){},skipDialogue(){}};
  const director=new StoryDirector(content,session,ui,()=>{});
  try{
    assert.equal(await director.approach(content.events[1], {id:'south-instance',actor:'guard',characterId:'south'}),true);
    assert.equal(session.storyWorld.hasFlag('south'),true);
    assert.equal(session.storyWorld.hasFlag('north'),false);
  }finally{director.dispose();}
});

test('a stage inherits the position of the named character rather than the first matching appearance',()=>{
  const current:StoryStage={type:'stage',map:'village',x:24,y:24,facing:'south',playerVisible:true,cast:[
    {id:'north',characterId:'north',actor:'guard',x:40,y:24,facing:'south',visible:true},
    {id:'south',characterId:'south',actor:'guard',x:40,y:72,facing:'north',visible:true},
  ]};
  const declaration:StoryStage={...current,mapFromWorld:true,cast:[{...current.cast[1],x:8,y:8,inheritPosition:true}]};
  assert.equal(resolveStoryScene(declaration,stageSnapshot(current).scene).cast[0].y,72);
});

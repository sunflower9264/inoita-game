import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import type { Campaign } from '../src/domain/campaign.ts';
import type { WorldMap } from '../src/domain/content.ts';
import { Session } from '../src/domain/session.ts';
import { StoryDirector, type StoryUI } from '../src/domain/story-director.ts';
import { WorldEnemyRoster, applyStoryEnemyRemovals } from '../src/domain/world-enemies.ts';

const campaign = JSON.parse(readFileSync(new URL('../public/content/campaign.json', import.meta.url), 'utf8')) as Campaign;
const sanctuary = JSON.parse(readFileSync(new URL('../public/content/maps/old-sanctuary-54cffd62.json', import.meta.url), 'utf8')) as WorldMap;
const ui: StoryUI = {async dialogue(){}, async choice(_prompt,options){return options[0];}, async questPopup(){},closeDialogue(){},skipDialogue(){},toast(){}};
const presentation = {begin(){},async execute(){},async finish(){},async release(){}};
async function settled(director: StoryDirector): Promise<void> {
  for (let i=0;i<20;i++) { await setImmediate(); if (!director.runtime.busy) { await setImmediate(); if (!director.runtime.busy) return; } }
  assert.fail('剧情没有在有限调度次数内收尾');
}

test('completing a parent event automatically starts its child without any quest or inventory change', async () => {
  const content: Campaign = {...campaign, events:[
    {id:'parent',source:'battle',key:'parent',script:'parent'},
    {id:'child',source:'event',script:'child',condition:{type:'event',event:'parent',status:'completed'}},
  ], scripts:{
    parent:{entry:'done',nodes:[{id:'done',presentation:[],commands:[],exit:{type:'end'}}]},
    child:{entry:'done',nodes:[{id:'done',presentation:[],commands:[{type:'flag',flag:'child-played'}],exit:{type:'end'}}]},
  }};
  const session=new Session(content),director=new StoryDirector(content,session,ui,()=>{},presentation);
  assert.equal(session.storyWorld.hasFlag('child-played'),false);
  await director.notify('battle','parent'); await settled(director);
  assert.equal(session.storyWorld.hasFlag('child-played'),true);
  assert.equal(director.runtime.eventStatus('child'),'completed');
  director.dispose();
});

for (const [enemy,event,previous,next] of [
  ['enemy-head-werewolf-1','event-61','quest-46','quest-47'],
  ['enemy-zahad-kuruhatt-1','event-112','quest-123','quest-124'],
  ['enemy-redhood-bandits-boss-1','event-135','quest-78','quest-79'],
]) test(`${event} starts from the original monster death and grants the next quest once`, async () => {
  const trigger=campaign.events.find(candidate=>candidate.id===event)!;
  assert.equal(trigger.source,'battle'); assert.equal(trigger.key,'defeat:'+enemy);
  const content:Campaign={...campaign,events:[trigger]};
  const session=new Session(content),director=new StoryDirector(content,session,ui,()=>{},presentation);
  // 原版这段戏发生在战斗地图上，运行时给 `mapFromStage` 的物件定位时要读「当前地图」
  // （`story-runtime` 取 `stage.map ?? port.currentMap()`）。空会话没有位置，这三条会假失败在
  // 「剧情物件缺少当前地图」——那是夹具缺上下文，不是玩家断点（报告 2026-10-15 的 E-09）。
  const battleMap=campaign.scripts[event].nodes.flatMap(node=>node.presentation).find(action=>action.type==='stage')!.map;
  session.storyWorld.apply({kind:'travel',destination:{map:battleMap,x:0,y:0,facing:'south'}});
  session.applyStoryCommands([{type:'quest',command:{type:'accept',quest:previous}}]);
  session.enemyDefeated({id:'boss-instance',enemyId:enemy,x:0,y:0}); await settled(director);
  assert.equal(director.runtime.eventStatus(event),'completed');
  assert.equal(session.status(previous),'completed');
  assert.ok(['active','ready'].includes(session.status(next)));
  const receipts=session.captureState().receipts;
  session.enemyDefeated({id:'boss-instance',enemyId:enemy,x:0,y:0}); await settled(director);
  assert.deepEqual(session.captureState().receipts,receipts);
  director.dispose();
});

test('native low-health triggers require crossing 30%, respect conditions, and stop intercepting after completion', async()=>{
  const content:Campaign={...campaign,quests:[],questGroups:[],events:[
    {id:'threshold',source:'battle',key:'health-below-30:boss',script:'threshold',condition:{type:'flag',flag:'allowed'}},
  ],scripts:{threshold:{entry:'done',nodes:[{id:'done',presentation:[],commands:[{type:'flag',flag:'threshold-played'}],exit:{type:'end'}}]}}};
  const session=new Session(content),director=new StoryDirector(content,session,ui,()=>{},presentation);
  assert.equal(director.healthChanged('boss',100,0,100),false);
  session.applyStoryCommands([{type:'flag',flag:'allowed'}]);
  assert.equal(director.healthChanged('boss',100,31,100),false);
  assert.equal(director.healthChanged('boss',30,0,100),false);
  assert.equal(director.healthChanged('boss',10,60,100),false);
  assert.equal(director.healthChanged('another-boss',100,0,100),false);
  assert.equal(director.healthChanged('boss',31,30,100),true);
  await settled(director);
  assert.equal(session.storyWorld.hasFlag('threshold-played'),true);
  assert.equal(director.healthChanged('boss',100,0,100),false);
  director.dispose();
});

test('every health-below-30 battle event removes the enemy that triggered it',()=>{
  for(const event of campaign.events.filter(candidate=>candidate.source==='battle'&&candidate.key?.startsWith('health-below-30:'))){
    const key=event.key;if(!key||!key.startsWith('health-below-30:'))continue;
    const enemyId=key.slice('health-below-30:'.length);
    const commands=campaign.scripts[event.script].nodes.flatMap(node=>node.commands);
    assert.ok(commands.some(command=>command.type==='world'&&command.command.kind==='remove-enemy'
      &&command.command.enemyId===enemyId),`${event.id} 必须结束 ${enemyId} 的遭遇，否则后续演出会复制战斗敌人`);
  }
});

test('event-55 remove-enemy completes the active Shinty encounter',()=>{
  const session=new Session(campaign);
  session.applyStoryCommands([
    {type:'travel',destination:{map:sanctuary.id,x:128,y:160,facing:'south'}},
    {type:'world',command:{kind:'encounter',encounter:{id:'event-54-battle',map:sanctuary.id,status:'active',
      spawns:[{id:'enemy-0',enemyId:'enemy-shin-1',x:280,y:216}]}}},
  ]);
  const roster=new WorldEnemyRoster(session,sanctuary,[],20);
  const spawn=roster.enemies.find(value=>value.enemyId==='enemy-shin-1');
  assert.ok(spawn,'战斗遭遇应先出现在名册里');
  const remove=campaign.scripts['event-55'].nodes.flatMap(node=>node.commands).find(command=>
    command.type==='world'&&command.command.kind==='remove-enemy'&&command.command.enemyId==='enemy-shin-1');
  assert.ok(remove,'event-55 必须交接战斗结束');
  session.applyStoryCommands([remove]);
  applyStoryEnemyRemovals(session,sanctuary.id,roster.enemies,key=>roster.removeEnemy(key));
  assert.equal(session.enemyVitals(spawn.key).deadUntil,'permanent');
  assert.deepEqual(roster.completedEncounters().map(encounter=>encounter.id),['event-54-battle']);
});

test('death and health condition scenes begin on the battle map before any explicit native map change',()=>{
  const firstMap=(id:string)=>campaign.scripts[id].nodes.flatMap(node=>node.presentation).find(action=>action.type==='stage')!.map;
  assert.equal(firstMap('event-61'),'werewolf-lair-43f5b4c5');
  assert.equal(firstMap('event-112'),'steel-altar-a048555a');
  assert.equal(firstMap('event-135'),'redhoods-boss-room-c9f73fd1');
  assert.equal(firstMap('event-55'),'old-sanctuary-54cffd62');
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { QuestItemGenerators } from '../src/domain/quest-item-spawns.ts';
import { GroundLootStore, groundLootFor } from '../src/domain/ground-loot.ts';
import { Session } from '../src/domain/session.ts';
import { WorldLootCoordinator } from '../src/scenes/world-loot.ts';
import type { QuestItemSpawn } from '../src/domain/content.ts';
import type { Campaign, CampaignQuest } from '../src/domain/campaign.ts';
import type { DropReward } from '../src/domain/drops.ts';
import type { ItemCatalog } from '../src/domain/items.ts';

const point:QuestItemSpawn={id:'copper-point',quest:'collection',item:'copper',x:56,y:120,respawnFrames:312};
const canProduce=(definition:QuestItemSpawn)=>definition.quest==='collection';

const readContent=()=>({
  campaign:JSON.parse(readFileSync(new URL('../public/content/campaign.json',import.meta.url),'utf8')),
  items:JSON.parse(readFileSync(new URL('../public/content/items.json',import.meta.url),'utf8')),
});
const questOnlyContent=(campaign:Campaign,quest:CampaignQuest):Campaign=>({...campaign,quests:[quest],questGroups:[],events:[]});

const pickupScene=(content:Campaign,items:ItemCatalog,held:number,questIds:readonly string[])=>{
  const run=new Session(content,undefined,undefined,items);
  for(const id of questIds)run.accept(id);
  if(held)run.bag.add('lumps-of-copper',held);run.emit();
  let message='';
  const loot=new WorldLootCoordinator({
    app:{session:run,items,ui:{showInstant:(text:string)=>{message=text;}} as never},
    destroyed:false,loadingWorld:false,map:undefined,dropCatalog:undefined,
    navigation:undefined,combat:undefined,player:undefined,
    syncView(){},enqueuePickup(){},
  });
  return {run,receive:(reward:DropReward={kind:'item',item:'lumps-of-copper',quantity:1})=>loot.receiveReward(reward),message:()=>message};
};

test('only active tasks produce one physical item at each native point',()=>{
  const generators=new QuestItemGenerators(),ground=new GroundLootStore();
  generators.enter('mine',1,[point,{...point,id:'other',quest:'later'}],ground);
  generators.advance(0,canProduce,ground);assert.equal(ground.forMap('mine').length,0);
  generators.advance(1,canProduce,ground);
  const [drop]=ground.forMap('mine');assert.deepEqual({x:drop.x,y:drop.y,reward:drop.reward},{x:56,y:120,reward:{kind:'item',item:'copper',quantity:1}});
  generators.advance(1000,canProduce,ground);assert.equal(ground.forMap('mine').length,1,'uncollected item binds its generator');
  assert.deepEqual(ground.collectNearby('mine',56,120,()=>false),[]);
  generators.advance(1200,canProduce,ground);assert.equal(ground.forMap('mine').length,1,'a full bag keeps the same item on the ground');
});

test('pickup resets native counters and the strict shared check gate controls regeneration',()=>{
  const generators=new QuestItemGenerators(),ground=new GroundLootStore();generators.enter('mine',1,[point],ground);
  generators.advance(1,canProduce,ground);
  const picked=ground.collectNearby('mine',56,120,()=>{});generators.collected(picked.map(drop=>drop.id),10);
  assert.equal(generators.captureState().generators[0].remainingFrames,171);
  generators.advance(151,canProduce,ground);assert.equal(ground.forMap('mine').length,0);
  generators.advance(152,canProduce,ground);assert.equal(generators.captureState().generators[0].remainingFrames,21);
  generators.advance(302,canProduce,ground);assert.equal(ground.forMap('mine').length,0);
  generators.advance(303,canProduce,ground);assert.equal(ground.forMap('mine').length,1);
});

test('completed tasks stop producing and save restoration preserves an uncollected item',()=>{
  const generators=new QuestItemGenerators(),ground=new GroundLootStore();generators.enter('mine',1,[point],ground);generators.advance(1,canProduce,ground);
  const restored=new QuestItemGenerators();restored.restoreState(JSON.parse(JSON.stringify(generators.captureState())),ground);
  restored.enter('mine',1,[point],ground);restored.advance(1000,canProduce,ground);
  assert.equal(ground.forMap('mine').length,1);
  const picked=ground.collectNearby('mine',56,120,()=>{});restored.collected(picked.map(drop=>drop.id),1000);
  restored.advance(1151,()=>false,ground);assert.equal(ground.forMap('mine').length,0);
  restored.advance(1400,canProduce,ground);assert.equal(ground.forMap('mine').length,1,'a later active task cycle can generate again');
});

test('leaving a map clears its generated items while other ground rewards survive',()=>{
  const generators=new QuestItemGenerators(),ground=new GroundLootStore();generators.enter('mine',1,[point],ground);generators.advance(1,canProduce,ground);
  ground.add('mine',8,8,[{kind:'money',amount:3}]);
  generators.enter('camp',2,[],ground);
  assert.deepEqual(ground.forMap('mine').map(drop=>drop.reward),[{kind:'money',amount:3}]);
  generators.enter('mine',3,[point],ground);generators.advance(10,canProduce,ground);
  assert.equal(ground.forMap('mine').filter(drop=>drop.reward.kind==='item').length,1);
});

test('invalid generator snapshots are rejected before replacing the live state',()=>{
  const generators=new QuestItemGenerators(),ground=new GroundLootStore();generators.enter('mine',1,[point],ground);generators.advance(1,canProduce,ground);
  const saved=generators.captureState(),bad=structuredClone(saved);bad.generators[0].dropId='missing';
  assert.throws(()=>generators.restoreState(bad,ground),/实例/);assert.deepEqual(generators.captureState(),saved);
});

test('session clock, JSON restore and pickup share the same generator countdown',async()=>{
  const {Session}=await import('../src/domain/session.ts');
  const {groundLootFor}=await import('../src/domain/ground-loot.ts');
  const {readFileSync}=await import('node:fs');
  const campaign=JSON.parse(readFileSync(new URL('../public/content/campaign.json',import.meta.url),'utf8'));
  const items=JSON.parse(readFileSync(new URL('../public/content/items.json',import.meta.url),'utf8'));
  const quest={...campaign.quests.find((quest:{id:string})=>quest.id==='quest-49'),availableWhen:{type:'always',value:true}};
  const content={...campaign,quests:[quest],questGroups:[],events:[]};
  const create=()=>new Session(content,undefined,undefined,items);
  const run=create(),definition={...point,quest:'quest-49',item:'lumps-of-copper'};
  run.applyStoryCommands([{type:'travel',destination:{map:'mine',x:56,y:120,facing:'south'}}]);
  run.enterMap('mine',[definition]);run.accept('quest-49');run.advanceCombatFrames(60,()=>{});
  const saved=JSON.parse(JSON.stringify(run.captureState())),loaded=create();loaded.restoreState(saved);
  loaded.enterMap('mine',[definition]);loaded.advanceCombatFrames(540,()=>{});
  const ground=groundLootFor(loaded);assert.equal(ground.forMap('mine').length,1,'read resumes the same bound item');
  const picked=ground.collectNearby('mine',56,120,reward=>{if(reward.kind==='item')loaded.bag.add(reward.item,reward.quantity);});
  loaded.questItemGenerators.collected(picked.map(drop=>drop.id),loaded.combatTick);loaded.emit();
  const mid=JSON.parse(JSON.stringify(loaded.captureState())),again=create();again.restoreState(mid);again.enterMap('mine',[definition]);
  again.advanceCombatFrames((303-again.combatTick)*60,()=>{});
  assert.equal(groundLootFor(again).forMap('mine').length,1,'read retains the original reset deadline');
  assert.equal(again.itemCount('lumps-of-copper'),1);
  const bad=structuredClone(again.captureState());bad.questItemGeneration.generators[0].dropId='missing';
  const before=again.captureState();assert.throws(()=>again.restoreState(bad),/实例/);assert.deepEqual(again.captureState(),before);
});

test('seven native points stop at the five task items still needed',()=>{
  const {campaign,items}=readContent();
  const quest={...campaign.quests.find((quest:{id:string})=>quest.id==='quest-49'),availableWhen:{type:'always',value:true}};
  const run=new Session(questOnlyContent(campaign,quest),undefined,undefined,items);
  const definition={...point,quest:'quest-49',item:'lumps-of-copper'};
  const spawns=Array.from({length:7},(_,index)=>({...definition,id:`copper-${index}`,x:40+index*16}));
  run.enterMap('mine',spawns);run.accept('quest-49');run.advanceCombatFrames(60,()=>{});
  const ground=groundLootFor(run);
  assert.equal(ground.forMap('mine').filter(drop=>drop.reward.kind==='item').length,5);
  assert.equal(run.questItemRemaining('quest-49','lumps-of-copper'),0);
});

test('a filled goal stops its own points while another goal keeps producing',()=>{
  const {campaign,items}=readContent();
  const base=campaign.quests.find((quest:{id:string})=>quest.id==='quest-49');
  const quest={...base,availableWhen:{type:'always',value:true},handoverItems:[],goals:[
    {id:'copper',kind:'item',target:'lumps-of-copper',quantity:2},
    {id:'zinc',kind:'item',target:'lumps-of-zinc',quantity:3},
  ]};
  const run=new Session(questOnlyContent(campaign,quest),undefined,undefined,items);
  const spawns=[
    ...Array.from({length:4},(_,index)=>({...point,id:`copper-${index}`,quest:'quest-49',item:'lumps-of-copper',x:40+index*16,y:100})),
    ...Array.from({length:4},(_,index)=>({...point,id:`zinc-${index}`,quest:'quest-49',item:'lumps-of-zinc',x:40+index*16,y:160})),
  ];
  run.enterMap('mine',spawns);run.accept('quest-49');run.advanceCombatFrames(60,()=>{});
  const drops=groundLootFor(run).forMap('mine');
  const count=(item:string)=>drops.filter(drop=>drop.reward.kind==='item'&&drop.reward.item===item).length;
  assert.equal(count('lumps-of-copper'),2);
  assert.equal(count('lumps-of-zinc'),3);
});

test('a partially filled task still produces the missing items',()=>{
  const {campaign,items}=readContent();
  const quest={...campaign.quests.find((quest:{id:string})=>quest.id==='quest-49'),availableWhen:{type:'always',value:true}};
  const run=new Session(questOnlyContent(campaign,quest),undefined,undefined,items);
  const definition={...point,quest:'quest-49',item:'lumps-of-copper'};
  const spawns=Array.from({length:3},(_,index)=>({...definition,id:`copper-${index}`,x:40+index*16}));
  run.enterMap('mine',spawns);run.accept('quest-49');run.bag.add('lumps-of-copper',2);run.emit();
  const copperRequirement=()=>run.questDropRequirements().flat().find(goal=>goal.item==='lumps-of-copper');
  assert.deepEqual(copperRequirement(),{item:'lumps-of-copper',quantity:5,owned:2});
  run.advanceCombatFrames(60,()=>{});
  assert.equal(groundLootFor(run).forMap('mine').length,3);
  assert.deepEqual(copperRequirement(),{item:'lumps-of-copper',quantity:5,owned:5});
});

test('an over-quota task item stays on the ground and shows a message',()=>{
  const {campaign,items}=readContent();
  const quest={...campaign.quests.find((quest:{id:string})=>quest.id==='quest-49'),availableWhen:{type:'always',value:true}};
  const content=questOnlyContent(campaign,quest);
  const full=pickupScene(content,items,5,['quest-49']);
  assert.equal(full.receive(),false);
  assert.equal(full.run.itemCount('lumps-of-copper'),5);
  assert.match(full.message(),/够了|不能捡/);
  const store=new GroundLootStore();store.add('mine',10,10,[{kind:'item',item:'lumps-of-copper',quantity:1}]);
  const picked=store.collectNearby('mine',10,10,reward=>full.receive(reward));
  assert.equal(picked.length,0,'超量的任务道具不能捡');
  assert.equal(store.forMap('mine').length,1,'道具留在原地');
  const partial=pickupScene(content,items,4,['quest-49']);
  assert.equal(partial.receive(),true);
  assert.equal(partial.run.itemCount('lumps-of-copper'),5);
});

test('a task item is collectible when no active task needs it',()=>{
  const {campaign,items}=readContent();
  const quest={...campaign.quests.find((quest:{id:string})=>quest.id==='quest-49'),availableWhen:{type:'always',value:true}};
  const idle=pickupScene(questOnlyContent(campaign,quest),items,5,[]);
  assert.equal(idle.receive(),true);
  assert.equal(idle.run.itemCount('lumps-of-copper'),6);
  assert.equal(idle.message(),'');
});

test('a task item is collectible while another active task still needs it',()=>{
  const {campaign,items}=readContent();
  const base=campaign.quests.find((quest:{id:string})=>quest.id==='quest-49');
  const satisfied={...base,id:'satisfied-copper',availableWhen:{type:'always',value:true},handoverItems:[],goals:[
    {id:'copper',kind:'item',target:'lumps-of-copper',quantity:5},
    {id:'zinc',kind:'item',target:'lumps-of-zinc',quantity:10},
  ]};
  const missing={...base,id:'missing-copper',availableWhen:{type:'always',value:true},handoverItems:[],goals:[
    {id:'copper',kind:'item',target:'lumps-of-copper',quantity:8},
  ]};
  const content={...campaign,quests:[satisfied,missing],questGroups:[],events:[]} as Campaign;
  const scene=pickupScene(content,items,5,['satisfied-copper','missing-copper']);
  assert.equal(scene.run.status('satisfied-copper'),'active','另一个目标没完成，任务仍在进行中');
  assert.equal(scene.run.status('missing-copper'),'active');
  assert.equal(scene.receive(),true);
  assert.equal(scene.run.itemCount('lumps-of-copper'),6);
  assert.equal(scene.message(),'');
});

test('quest pickups survive ordinary loot overflow and complete the task after loading',()=>{
  const {campaign,items}=readContent();
  const quest={...campaign.quests.find((q:CampaignQuest)=>q.id==='quest-49'),availableWhen:{type:'always',value:true}};
  const content=questOnlyContent(campaign,quest);
  const {run}=pickupScene(content,items,4,['quest-49']);
  run.bag.add('lumps-of-zinc',10);
  const spawn={...point,quest:quest.id,item:'lumps-of-copper'};
  run.enterMap('mine',[spawn]);
  run.advanceCombatFrames(60,()=>{});
  const store=groundLootFor(run);
  const coins=store.add('mine',0,0,Array.from({length:70},()=>({kind:'money' as const,amount:1})));
  const [other]=store.add('camp',0,0,[{kind:'money',amount:3}]);

  const loaded=pickupScene(content,items,0,[]);
  loaded.run.restoreState(JSON.parse(JSON.stringify(run.captureState())));
  loaded.run.enterMap('mine',[spawn]);
  const ground=groundLootFor(loaded.run);
  ground.addFlying('mine',{x:0,y:0},{x:16,y:16,direction:0},'mana-gem',100);
  assert.deepEqual(ground.forMap('mine').filter(drop=>drop.reward.kind==='money'),coins.slice(-63));
  assert.deepEqual(ground.forMap('camp'),[other]);
  const picked=ground.collectNearby('mine',spawn.x,spawn.y,loaded.receive);
  assert.equal(picked.length,1);
  loaded.run.questItemGenerators.collected(picked.map(drop=>drop.id),loaded.run.combatTick);
  loaded.run.emit();
  assert.equal(loaded.run.status(quest.id),'ready');
});

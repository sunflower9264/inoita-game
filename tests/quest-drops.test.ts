import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseDrops, rollQuestDrops, type DropCatalog, type QuestDropRequirement } from '../src/domain/drops.ts';
import { Session, DEFAULT_ENEMY_RESPAWN_MS } from '../src/domain/session.ts';
import { groundLootFor } from '../src/domain/ground-loot.ts';
import { WorldEnemyRoster } from '../src/domain/world-enemies.ts';
import type { Campaign } from '../src/domain/campaign.ts';
import type { ActorDefinition, WorldMap } from '../src/domain/content.ts';
import type { ItemCatalog } from '../src/domain/items.ts';

const read=<T>(file:string):T=>JSON.parse(readFileSync(new URL(`../public/content/${file}.json`,import.meta.url),'utf8')) as T;
const catalog=read<DropCatalog>('drops'),campaign=read<Campaign>('campaign'),items=read<ItemCatalog>('items');
const map=read<WorldMap>('maps/shadow-training-dungeon-2-a6b8293b');
const need=(item:string,quantity=1,owned=0):QuestDropRequirement=>({item,quantity,owned});
const enemy='enemy-reagents-1',reward={kind:'item',item:'ectoplasm',quantity:1} as const;
function session():Session {
  const quest={...campaign.quests.find(quest=>quest.id==='knight-uniform')!,availableWhen:{type:'always' as const,value:true}};
  return new Session({...campaign,quests:[quest],questGroups:[],events:[]},undefined,
    {classId:'assassin',appearance:{} as ActorDefinition},items);
}

test('export keeps only the first monster/item row and the native strict 1..99 boundary',()=>{
  assert.deepEqual(catalog.questItems[enemy],[{item:'ectoplasm',threshold:80}]);
  for(const rules of Object.values(catalog.questItems))assert.equal(new Set(rules.map(rule=>rule.item)).size,rules.length);
  assert.deepEqual(rollQuestDrops(catalog,enemy,[[need('ectoplasm')]],()=>78/99),[reward]);
  assert.deepEqual(rollQuestDrops(catalog,enemy,[[need('ectoplasm')]],()=>79/99),[]);
  assert.deepEqual(rollQuestDrops(catalog,enemy,[[need('ectoplasm')]],()=>98/99),[]);
  const certain={...catalog,questItems:{[enemy]:[{item:'ectoplasm',threshold:100}]}};
  assert.deepEqual(rollQuestDrops(certain,enemy,[[need('ectoplasm')]],()=>98/99),[reward]);
});

test('within one quest only the first matching required item rolls, even when it fails',()=>{
  let draws=0;
  const data={...catalog,questItems:{[enemy]:[{item:'ectoplasm',threshold:80},{item:'small-healing-potion',threshold:100}]}};
  assert.deepEqual(rollQuestDrops(data,enemy,[[need('unrelated'),need('ectoplasm'),need('ectoplasm'),need('small-healing-potion')]],()=>{draws++;return 79/99;}),[]);
  assert.equal(draws,1);
  assert.deepEqual(rollQuestDrops(data,enemy,[],()=>assert.fail('no active requirement')),[]);
  assert.deepEqual(rollQuestDrops(data,'another-enemy',[[need('ectoplasm')]],()=>assert.fail('no matching rule')),[]);
});

test('task drop validation checks enemy and item references, thresholds, and duplicate items',()=>{
  const enemyIds=Object.keys(catalog.enemies);
  assert.equal(parseDrops(catalog,items,enemyIds),catalog);
  for(const rules of [
    [{item:'missing',threshold:80}], [{item:'ectoplasm',threshold:0}],
    [{item:'ectoplasm',threshold:101}], [{item:'ectoplasm',threshold:80.5}],
    [{item:'ectoplasm',threshold:80},{item:'ectoplasm',threshold:80}],
  ])assert.throws(()=>parseDrops({...catalog,questItems:{[enemy]:rules}},items,enemyIds),/任务掉落无效/);
  assert.throws(()=>parseDrops({...catalog,questItems:{missing:[{item:'ectoplasm',threshold:80}]}},items,enemyIds),/任务掉落无效/);
});

test('native map spirits drop on the ground and pickup completes the five-item handover',()=>{
  const run=session(),ground=groundLootFor(run),roster=new WorldEnemyRoster(run,map,[],4);
  const spirits=roster.spawns.filter(spawn=>spawn.enemyId===enemy);
  assert.deepEqual(spirits.map(({x,y})=>[x,y]),[[136,232],[56,328],[72,536],[296,536],[488,536]]);
  assert.deepEqual(run.questDropRequirements(),[]);
  assert.deepEqual(rollQuestDrops(catalog,enemy,run.questDropRequirements(),()=>assert.fail('quest not accepted')),[]);
  assert.equal(run.accept('knight-uniform'),true);
  assert.deepEqual(run.questDropRequirements(),[[need('ectoplasm',5)]]);
  for(const [index,spawn] of spirits.entries()){
    run.enemyDefeated(spawn);
    const rewards=rollQuestDrops(catalog,enemy,run.questDropRequirements(),()=>0);
    const [drop]=ground.add(map.id,spawn.x,spawn.y,rewards);
    assert.deepEqual({map:drop.map,x:drop.x,y:drop.y,reward:drop.reward},{map:map.id,x:spawn.x,y:spawn.y,reward});
    assert.equal(run.itemCount('ectoplasm'),index,'uncollected ground material does not count as inventory');
    ground.collectNearby(map.id,spawn.x,spawn.y,reward=>{if(reward.kind==='item')run.bag.add(reward.item,reward.quantity);});
    run.emit();
    assert.equal(run.itemCount('ectoplasm'),index+1);
  }
  assert.equal(run.status('knight-uniform'),'ready');
  assert.deepEqual(run.questDropRequirements(),[]);
  assert.deepEqual(rollQuestDrops(catalog,enemy,run.questDropRequirements(),()=>assert.fail('enough material')),[]);
  assert.equal(run.complete('knight-uniform'),true);
  assert.equal(run.itemCount('ectoplasm'),0);
  assert.equal(run.itemCount('berkel-leather-armor'),1);
  assert.equal(run.complete('knight-uniform'),false);
  assert.deepEqual(run.questDropRequirements(),[],'completed quest cannot resume material drops after handover');
});

test('a failed spirit roll leaves the task active and the same native spawn can replenish later',()=>{
  const run=session(),spawn=map.enemySpawns!.find(spawn=>spawn.enemyId===enemy)!;
  run.accept('knight-uniform');run.enemyDefeated(spawn);
  assert.deepEqual(rollQuestDrops(catalog,enemy,run.questDropRequirements(),()=>79/99),[]);
  assert.equal(run.status('knight-uniform'),'active');
  assert.equal(run.canSpawnEnemy(spawn),false);
  run.advanceGameTime(DEFAULT_ENEMY_RESPAWN_MS);
  assert.equal(run.canSpawnEnemy(spawn),true);
  run.enemyDefeated(spawn);
  assert.deepEqual(rollQuestDrops(catalog,enemy,run.questDropRequirements(),()=>0),[reward]);
  assert.equal(run.itemCount('ectoplasm'),0);
});

test('failed rolls advance to the next quest, including another quest for the same item',()=>{
  const second={kind:'item',item:'mithril',quantity:1} as const;
  const data={...catalog,questItems:{[enemy]:[{item:'ectoplasm',threshold:80},{item:'mithril',threshold:100}]}};
  let draws=0;
  assert.deepEqual(rollQuestDrops(data,enemy,[[need('ectoplasm')],[need('mithril')]],()=>{draws++;return 79/99;}),[second]);
  assert.equal(draws,2);
  const sequence=[79/99,0];
  assert.deepEqual(rollQuestDrops(data,enemy,[[need('ectoplasm')],[need('ectoplasm')]],()=>sequence.shift()!),[reward]);
  assert.equal(sequence.length,0,'不同任务需要同一物品时各自尝试');
  const minimum={...data,questItems:{[enemy]:[{item:'ectoplasm',threshold:1},{item:'mithril',threshold:100}]}};
  draws=0;
  assert.deepEqual(rollQuestDrops(minimum,enemy,[[need('ectoplasm'),need('mithril')],[need('mithril')]],()=>{draws++;return 0;}),[second]);
  assert.equal(draws,2,'掉率1仍是首个匹配目标；抽样必败后才转下一个任务');
});

test('the first matching fulfilled goal skips the rest of its quest without drawing',()=>{
  const data={...catalog,questItems:{[enemy]:[{item:'ectoplasm',threshold:80},{item:'mithril',threshold:100}]}};
  assert.deepEqual(rollQuestDrops(data,enemy,[[need('unrelated'),need('ectoplasm',1,1),need('mithril')]],()=>assert.fail('fulfilled first match')),[]);
  let draws=0;
  assert.deepEqual(rollQuestDrops(data,enemy,[[need('ectoplasm',1,1),need('mithril')],[need('mithril')]],()=>{draws++;return 0;}),[{kind:'item',item:'mithril',quantity:1}]);
  assert.equal(draws,1);
  assert.deepEqual(rollQuestDrops(data,enemy,[[need('unrelated'),need('ectoplasm')],[need('mithril')]],()=>{assert.equal(++draws,2);return 0;}),[reward]);
});

test('uncollected task drops count toward the requirement and stop further production',()=>{
  const run=session(),ground=groundLootFor(run);
  run.accept('knight-uniform');
  for(let index=0;index<5;index++){
    const rewards=rollQuestDrops(catalog,enemy,run.questDropRequirements(ground.pendingItemCounts()),()=>0);
    assert.deepEqual(rewards,[reward]);
    ground.add(map.id,200+index*24,200,rewards);
  }
  assert.equal(ground.pendingItemCounts().get('ectoplasm'),5);
  assert.deepEqual(rollQuestDrops(catalog,enemy,run.questDropRequirements(ground.pendingItemCounts()),
    ()=>assert.fail('five already on the ground')),[]);
  for(const drop of ground.forMap(map.id))
    ground.collectNearby(map.id,drop.x,drop.y,reward=>{if(reward.kind==='item')run.bag.add(reward.item,reward.quantity);});
  run.emit();
  assert.equal(run.itemCount('ectoplasm'),5);
  assert.equal(run.status('knight-uniform'),'ready');
});

test('session preserves quest boundaries, acceptance order, duplicate items and fulfilled goals',()=>{
  const base=campaign.quests.find(quest=>quest.id==='knight-uniform')!;
  const first={...base,id:'first',hidden:true,handoverItems:[],rewards:undefined,completeScript:null,goals:[
    {id:'ore',kind:'item' as const,target:'mithril',quantity:1},
    {id:'material',kind:'item' as const,target:'ectoplasm',quantity:1},
  ]};
  const second={...base,id:'second',handoverItems:[],rewards:undefined,completeScript:null,goals:[
    {id:'material',kind:'item' as const,target:'ectoplasm',quantity:2},
  ]};
  const run=new Session({...campaign,quests:[first,second],questGroups:[],events:[]},undefined,undefined,items);
  run.accept('second');run.accept('first');run.bag.add('mithril');run.emit();
  assert.deepEqual(run.questDropRequirements(),[
    [need('ectoplasm',2)],
    [need('mithril',1,1),need('ectoplasm')],
  ]);
  const data={...catalog,questItems:{[enemy]:[{item:'mithril',threshold:100},{item:'ectoplasm',threshold:80}]}};
  let draws=0;
  assert.deepEqual(rollQuestDrops(data,enemy,run.questDropRequirements(),()=>{draws++;return 79/99;}),[]);
  assert.equal(draws,1,'第二任务的首个匹配物品已足，不再抽它后面的目标');
  const restored=new Session({...campaign,quests:[first,second],questGroups:[],events:[]},undefined,undefined,items);
  restored.restoreState(JSON.parse(JSON.stringify(run.captureState())));
  assert.deepEqual(restored.questDropRequirements(),run.questDropRequirements());
});

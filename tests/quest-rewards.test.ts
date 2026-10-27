import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Bag } from '../src/domain/bag.ts';
import { Session } from '../src/domain/session.ts';
import { groundLootFor } from '../src/domain/ground-loot.ts';
import { BattleCharacter, type CharacterStatsCatalog } from '../src/domain/character-stats.ts';
import type { Campaign } from '../src/domain/campaign.ts';
import type { ActorDefinition } from '../src/domain/content.ts';
import type { ItemCatalog } from '../src/domain/items.ts';
import type { CompanionCatalog } from '../src/domain/party.ts';

const read=<T>(name:string):T=>JSON.parse(readFileSync(new URL(`../public/content/${name}.json`,import.meta.url),'utf8')) as T;
const items=read<ItemCatalog>('items'),campaign=read<Campaign>('campaign');
const normalItems=Object.keys(items.items).filter(id=>items.items[id].category!=='quest'&&!items.items[id].pickup);
const questItems=Object.keys(items.items).filter(id=>items.items[id].category==='quest');
const makeBag=()=>new Bag(()=>{},items,'assassin');
function makeSession(id='quest-181'):Session {
  const quest={...campaign.quests.find(quest=>quest.id===id)!,availableWhen:{type:'always' as const,value:true}};
  return new Session({...campaign,quests:[quest],questGroups:[],events:[]},undefined,
    {classId:'assassin',appearance:{} as ActorDefinition},items);
}
test('ordinary and quest inventories grow past sixteen cells and survive JSON restore',()=>{
  const bag=makeBag();
  for(const id of normalItems.slice(0,48))bag.add(id);
  for(const id of questItems.slice(0,40))bag.add(id);
  assert.equal(bag.entries.length,88);
  const entry=bag.entries[0];assert.equal(bag.placeInCell(entry.id,'all',120),true);
  bag.verifyConsistency();
  const restored=makeBag();restored.restoreState(JSON.parse(JSON.stringify(bag.captureState())));
  assert.deepEqual(restored.captureState(),bag.captureState());
});

test('task 181 grants replacement potions directly once with more than sixteen ordinary items',()=>{
  const run=makeSession();
  assert.deepEqual(run.definition('quest-181')!.rewards!.items,[{item:'healing-potion-m',quantity:2}]);
  for(const id of normalItems.slice(0,32))run.bag.add(id);
  assert.equal(run.accept('quest-181'),true);
  const before=run.itemCount('healing-potion-m'),goal=run.definition('quest-181')!.goals[0];
  for(let index=0;index<goal.quantity;index++)run.enemyDefeated({id:`mosquito-${index}`,enemyId:goal.target,x:8,y:8});
  assert.equal(run.complete('quest-181'),true);
  assert.equal(run.itemCount('healing-potion-m'),before+2);
  assert.equal(groundLootFor(run).forMap(campaign.start.map).length,0);
  assert.equal(run.complete('quest-181'),false);assert.equal(run.itemCount('healing-potion-m'),before+2);
  run.bag.verifyConsistency();
});

test('story companion equipment returns beyond sixteen cells and remains saveable',()=>{
  const stats=read<CharacterStatsCatalog>('character-stats'),companions=read<CompanionCatalog>('companions');
  const create=()=>new Session(campaign,undefined,undefined,items,new BattleCharacter('assassin',stats,items),undefined,stats,companions);
  const run=create();run.party!.joinStory('mercenary-azad');
  for(const id of normalItems.slice(0,15))run.bag.add(id);
  assert.equal(run.bag.entries.length,15);
  assert.equal(run.party!.leaveStory('mercenary-azad'),true);
  assert.equal(run.bag.entries.length,17);
  const state=JSON.parse(JSON.stringify(run.captureState()));
  const restored=create();restored.restoreState(state);
  assert.deepEqual(restored.captureState(),run.captureState());
});

test('task 88 grants replacement potions as a normal physical reward',()=>{
  const run=makeSession('quest-88'),quest=run.definition('quest-88')!;
  assert.deepEqual(quest.rewards!.items,[{item:'healing-potion-l',quantity:2}]);
  assert.equal(run.accept(quest.id),true);run.bag.add(quest.goals[0].target,quest.goals[0].quantity);run.emit();
  assert.equal(run.complete(quest.id),true);assert.equal(run.itemCount('healing-potion-l'),2);
  assert.equal(groundLootFor(run).forMap(campaign.start.map).length,0);
  run.bag.verifyConsistency();
});

test('opening a container grants all its contents beyond sixteen cells',()=>{
  const bag=makeBag(),pack=Object.keys(items.items).find(id=>items.items[id].use?.kind==='pack'&&items.items[id].use!.rewards!.length>1)!;
  const rewards=items.items[pack].use!.rewards!,outputs=new Set(rewards.map(reward=>reward.item));
  bag.add(pack);for(const id of normalItems){if(bag.entries.length===32)break;if(id!==pack&&!outputs.has(id))bag.add(id);}
  const entry=bag.entries.find(entry=>entry.item===pack)!;
  bag.use(entry.id);assert.equal(bag.count(pack),0);
  for(const reward of rewards)assert.equal(bag.count(reward.item),reward.quantity);
  assert.ok(bag.entries.length>32);bag.verifyConsistency();
});

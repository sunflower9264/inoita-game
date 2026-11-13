import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Bag } from '../src/domain/bag.ts';
import type { BattleCatalog } from '../src/domain/battle.ts';
import type { CharacterStatsCatalog } from '../src/domain/character-stats.ts';
import { settleCombatRewards } from '../src/domain/combat-rewards.ts';
import { parseDrops, rollEnemyLoot } from '../src/domain/drops.ts';
import type { ItemCatalog } from '../src/domain/items.ts';
import { LootPity } from '../src/domain/loot-pity.ts';

const read = <T>(name:string):T => JSON.parse(readFileSync(new URL(`../public/content/${name}.json`,import.meta.url),'utf8')) as T;
const items=read<ItemCatalog>('items');
const stats=read<CharacterStatsCatalog>('character-stats');
const battle=read<BattleCatalog>('battle');
const drops=parseDrops(read('drops'),items,battle.enemies.map(enemy=>enemy.id));

test('equipment follows actual enemy level across all three rarity pools',()=>{
  let seed=20061011;
  const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);
  const catalog=structuredClone(drops);
  const id='enemy-shadow-elite-knight-1';
  const counts=new Set<number>();
  for(let index=0;index<10000;index++){
    const options=index%3===0?{uniqueGuarantee:true}:index%3===1?{epicGuarantee:true}:{};
    for(const reward of rollEnemyLoot(catalog,stats,id,70,42,random,{}, {...options,sourceLevel:100}).rewards){
      if(reward.kind!=='item'||!reward.roll)continue;
      const level=items.items[reward.item]!.level;
      assert.ok(level>=85&&level<=100,`${reward.item} has level ${level}`);
      counts.add(reward.roll.rarity);
    }
  }
  assert.ok(counts.has(3));
  assert.ok(counts.has(4));
  assert.ok([...counts].some(rarity=>rarity<3));
});

test('all eligible rarity pools obey the equipment window at each source level',()=>{
  const catalog=structuredClone(drops);
  const id='enemy-shadow-elite-knight-1';
  const rule=catalog.enemies[id]!;
  for(const kind of Object.keys(rule.chances) as (keyof typeof rule.chances)[])rule.chances[kind]=0;
  rule.chances.equipment=10000;
  catalog.epicDrops!.enemyChance=0;
  for(let level=1;level<=107;level++)for(const options of [{},{uniqueGuarantee:true},{epicGuarantee:true}]){
    const cap=Math.min(level,105);
    const result=rollEnemyLoot(catalog,stats,id,105,1,()=>0.5,{}, {...options,sourceLevel:level});
    for(const reward of result.rewards){
      if(reward.kind!=='item'||!reward.roll)continue;
      const itemLevel=items.items[reward.item]!.level;
      assert.ok(itemLevel>=Math.max(1,cap-15)&&itemLevel<=cap,`${level}: ${reward.item} ${itemLevel}`);
    }
  }
});

test('shared pity guarantees yellow at 25 and purple at 40 eligible points',()=>{
  const catalog=structuredClone(drops);
  const id='enemy-evil-spirit-of-abyss-1';
  const rule=catalog.enemies[id]!;
  for(const kind of Object.keys(rule.chances) as (keyof typeof rule.chances)[])rule.chances[kind]=0;
  catalog.epicDrops!.enemyChance=0;
  const enemy=battle.enemies.find(entry=>entry.id===id)!;
  const pity=new LootPity();
  const run=()=>{
    const result=settleCombatRewards({enemy,hasSpawn:true,enemyLevel:106,elite:false,heroLevel:105,map:'test',x:0,y:0,
      lootLevel:42,partySize:3,earnsExperience:true,party:[{id:'player',level:105},{id:'ally',level:105},{id:'ally2',level:105}],
      drops:catalog,stats,random:()=>0.9999,questRequirements:[],pity,reserved:{misses:0,claimed:new Set(),pending:new Set()}});
    for(const record of result.pityRecords)pity.recordEnemy(record.ownerId,record,record.eligibility,record.points);
    return result.owners.flatMap(owner=>owner.rewards).filter(reward=>reward.kind==='item'&&reward.roll);
  };
  for(let count=1;count<25;count++)assert.equal(run().length,0,`early yellow on ${count}`);
  const yellow=run();
  assert.equal(yellow.length,1);
  assert.equal(yellow[0]!.kind==='item'&&yellow[0]!.roll?.rarity,3);
  for(let count=26;count<40;count++)run();
  const purple=run();
  assert.equal(purple.length,1);
  assert.equal(purple[0]!.kind==='item'&&purple[0]!.roll?.rarity,4);
  assert.equal(pity.counters('player').epicMisses,0);
});

test('bosses advance two points and normal kills do not advance rarity pity',()=>{
  const pity=new LootPity();
  const eligible={withinWindow:true,unique:true,epic:true};
  pity.counters('player').uniqueMisses=23;
  assert.equal(pity.uniqueGuaranteed('player',drops.pity!,2),true);
  pity.recordEnemy('player',{equipment:false},eligible,0);
  assert.equal(pity.counters('player').uniqueMisses,23);
  pity.recordEnemy('player',{equipment:false},eligible,2);
  assert.equal(pity.counters('player').uniqueMisses,25);
});

test('low-level elite advances and triggers epic pity when a matching item exists',()=>{
  const id='enemy-head-goblin-1';
  const enemy=battle.enemies.find(entry=>entry.id===id)!;
  const catalog=structuredClone(drops);
  catalog.epicDrops!.enemyChance=0;
  const pity=new LootPity();
  pity.counters('player').epicMisses=39;
  const result=settleCombatRewards({enemy,hasSpawn:true,enemyLevel:13,elite:false,heroLevel:13,map:'test',x:0,y:0,
    partySize:1,earnsExperience:true,party:[{id:'player',level:13}],drops:catalog,stats,random:()=>0.9999,
    questRequirements:[],pity,reserved:{misses:0,claimed:new Set(),pending:new Set()}});
  const epic=result.owners[0]!.rewards.find(reward=>reward.kind==='item'&&reward.roll?.rarity===4);
  assert.ok(epic&&epic.kind==='item');
  assert.equal(epic.item,'cloak-of-devotion');
  const record=result.pityRecords[0]!;
  assert.equal(record.eligibility.epic,true);
  pity.recordEnemy(record.ownerId,record,record.eligibility,record.points);
  assert.equal(pity.counters('player').epicMisses,0);
});

test('three members receive only one equipment reward and a first boss kill gives yellow',()=>{
  const enemy=battle.enemies.find(entry=>entry.id==='enemy-blackhoods-boss-1')!;
  const pity=new LootPity();
  const result=settleCombatRewards({enemy,hasSpawn:true,oneTime:true,enemyLevel:65,elite:false,heroLevel:60,map:'test',x:0,y:0,
    lootLevel:20,partySize:3,earnsExperience:true,party:[{id:'player',level:60},{id:'ally',level:60},{id:'ally2',level:60}],
    drops,stats,random:()=>0,questRequirements:[],pity,reserved:{misses:0,claimed:new Set(),pending:new Set()}});
  const equipment=result.owners.flatMap(owner=>owner.rewards).filter(reward=>reward.kind==='item'&&reward.roll);
  assert.equal(equipment.length,1);
  assert.ok(equipment[0]!.kind==='item'&&equipment[0]!.roll!.rarity>=3);
  assert.equal(result.pityRecords.length,1);
  assert.equal(result.pityRecords[0]!.points,2);
});

test('one-time story elite guarantees one of its eligible fixed items on the first defeat',()=>{
  const id='enemy-mutated-zombie-1';
  const enemy=battle.enemies.find(entry=>entry.id===id)!;
  const result=settleCombatRewards({enemy,hasSpawn:true,oneTime:true,enemyLevel:102,elite:false,heroLevel:100,map:'test',x:0,y:0,
    partySize:1,earnsExperience:true,party:[{id:'player',level:100}],drops,stats,random:()=>0.9999,
    questRequirements:[],pity:new LootPity(),reserved:{misses:0,claimed:new Set(),pending:new Set()}});
  const gear=result.owners[0]!.rewards.filter(reward=>reward.kind==='item'&&reward.roll);
  assert.equal(gear.length,1);
  const reward=gear[0]!;
  assert.ok(reward.kind==='item');
  assert.ok(drops.enemies[id]!.fixed.some(choice=>choice.item===reward.item));
});

test('dropped sealed boxes retain their level through a bag snapshot',()=>{
  const bag=new Bag(()=>{},items);
  const prepared=bag.prepareDrop('sealed-necklace-chest',{lootLevel:100});
  bag.receiveDrop(prepared);
  bag.receiveDrop(bag.prepareDrop('sealed-necklace-chest',{lootLevel:95}));
  const restored=new Bag(()=>{},items);
  restored.restoreState(bag.captureState());
  const box=restored.entries.find(entry=>entry.item==='sealed-necklace-chest')!;
  assert.equal(restored.entries.filter(entry=>entry.item==='sealed-necklace-chest').length,2);
  assert.equal(box.lootLevel,100);
  const result=restored.use(box.id,undefined,undefined,()=>0);
  const level=items.items[result.rewards[0]!.item]!.level;
  assert.ok(level>=85&&level<=100);
});

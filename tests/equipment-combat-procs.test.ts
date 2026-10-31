import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {equipmentCombatProcs} from '../src/domain/equipment-combat-procs.ts';
import {BattleCharacter,type ItemNumbers,type CharacterStatsCatalog} from '../src/domain/character-stats.ts';
import type {ItemCatalog,ItemInstance} from '../src/domain/items.ts';

const item=(id:string,numbers?:Pick<ItemNumbers,'modifiers'|'gemModifiers'>):ItemInstance=>({
  id,item:'test-equipment',quantity:1,enhancement:0,gems:[],
  ...(numbers?{numbers:{magicPercent:0,sockets:0,enhancementUses:0,...numbers}}:{}),
});
const zero={pendulumStunChance:0,frostRetaliationChance:0,healingEnergyChance:0,zealotRate:0,instantRecoveryPerThousand:0};

test('five equipment thresholds come from item and gem modifiers with signed integer units',()=>{
  const equipped=[item('weapon',{modifiers:[{stat:'pendulum',value:90},{stat:'frost',value:300},
    {stat:'healingEnergy',value:50},{stat:'zealot',value:200},{stat:'instantRecovery',value:30},
    {stat:'criticalRate',value:999}],
    gemModifiers:[{stat:'pendulum',value:10},{stat:'zealot',value:-50}]}),
    item('other',{modifiers:[{stat:'frost',value:-25}],gemModifiers:[{stat:'instantRecovery',value:5}]}),
    item('unrolled')];
  const before=structuredClone(equipped);
  assert.deepEqual(equipmentCombatProcs(equipped),{pendulumStunChance:100,frostRetaliationChance:275,
    healingEnergyChance:50,zealotRate:150,instantRecoveryPerThousand:35});
  assert.deepEqual(equipped,before);
  assert.deepEqual(equipmentCombatProcs([]),zero);
});

test('existing equipment catalog feeds the five native fixed options',()=>{
  const read=(name:string)=>JSON.parse(readFileSync(new URL(`../public/content/${name}.json`,import.meta.url),'utf8'));
  const hero=new BattleCharacter('dark-knight',read('character-stats') as CharacterStatsCatalog,read('items') as ItemCatalog);
  const names=['lance-of-longinus','armor-of-sorrow','emperor-s-sword','soul-destroyer','black-uniform'];
  for(const name of names)hero.bag.add(name);
  const equipped=names.map(name=>hero.bag.entries.find(entry=>entry.item===name)!);
  assert.ok(equipped.every(entry=>entry?.numbers));
  const rates=equipmentCombatProcs(equipped);
  assert.equal(rates.pendulumStunChance,90);
  assert.equal(rates.frostRetaliationChance,300);
  assert.equal(rates.healingEnergyChance,50);
  assert.equal(rates.zealotRate,200);
  assert.ok(rates.instantRecoveryPerThousand>=15&&rates.instantRecoveryPerThousand<=45);
});

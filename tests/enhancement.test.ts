import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BattleCharacter } from '../src/domain/character-stats.ts';
import { enhancementChance, enhancementOdds } from '../src/domain/enhancement.ts';
import { parseCharacterStats, parseItemCatalog } from '../src/application/content-validation.ts';

const read=(name:string)=>JSON.parse(fs.readFileSync(new URL(`../public/content/${name}.json`,import.meta.url),'utf8'));
const catalog=parseCharacterStats(read('character-stats')),items=parseItemCatalog(read('items'));
const create=()=>new BattleCharacter('dark-knight',catalog,items);
const close=(actual:number,expected:number)=>assert.ok(Math.abs(actual-expected)<1e-12,`${actual} != ${expected}`);

test('enhancementChance clamps the native 1..998 roll',()=>{
  assert.equal(enhancementChance(-10),0);
  assert.equal(enhancementChance(0),0);
  assert.equal(enhancementChance(1),0);
  close(enhancementChance(300),299/998);
  close(enhancementChance(998),997/998);
  assert.equal(enhancementChance(999),1);
  assert.equal(enhancementChance(5000),1);
  assert.equal(enhancementChance(Number.NaN),0);
  assert.equal(enhancementChance(Number.POSITIVE_INFINITY),0);
});

test('enhancementOdds matches the native thresholds',()=>{
  const normal=enhancementOdds(0,false,0);
  assert.equal(normal.success,1);assert.equal(normal.failure,0);assert.equal(normal.losesLevel,false);
  close(normal.double,249/998);
  close(enhancementOdds(0,false,300).double,549/998);
  const chaosAtOne=enhancementOdds(1,true,0);
  assert.equal(chaosAtOne.success,1);assert.equal(chaosAtOne.failure,0);assert.equal(chaosAtOne.losesLevel,true);
  close(chaosAtOne.double,213/998);
  const chaosAtTen=enhancementOdds(10,true,0);
  close(chaosAtTen.success,453/998);
  close(chaosAtTen.failure,1-453/998);
  close(chaosAtTen.double,(453/998)*(92/998));
});

test('applicationOdds only exposes usable combinations',()=>{
  const hero=create(),bag=hero.bag;
  bag.add('novice-weapon-scroll');bag.add('chaos-weapon-scroll');
  const weapon=bag.get(bag.equipment['main-hand']!)!;
  const normal=bag.entries.find(entry=>entry.item==='novice-weapon-scroll')!;
  const chaos=bag.entries.find(entry=>entry.item==='chaos-weapon-scroll')!;
  const at=(level:number,uses:number)=>{const state=bag.captureState();const target=state.instances.find(entry=>entry.id===weapon.id)!;target.enhancement=level;target.numbers!.enhancementUses=uses;bag.restoreState(state);};
  at(0,3);
  assert.ok(bag.applicationOdds(normal.id,weapon.id));
  assert.equal(bag.applicationOdds(chaos.id,weapon.id),undefined,'混沌 +0 被 enchant-first 拦下');
  at(1,3);
  assert.equal(bag.applicationOdds(chaos.id,weapon.id),undefined,'混沌要求耐久 0');
  at(1,0);
  assert.equal(bag.applicationOdds(chaos.id,weapon.id)!.success,1);
  at(10,0);
  close(bag.applicationOdds(chaos.id,weapon.id)!.success,453/998);
  at(30,3);
  assert.equal(bag.applicationOdds(normal.id,weapon.id),undefined,'满级不能继续强化');
  at(5,0);
  assert.equal(bag.applicationOdds(normal.id,weapon.id),undefined,'普通卷轴耐久不足');
});

test('bag.use outcomes agree with enhancementOdds',()=>{
  const hero=create(),bag=hero.bag;bag.add('novice-weapon-scroll',3);
  const weapon=bag.get(bag.equipment['main-hand']!)!;
  const normal=bag.entries.find(entry=>entry.item==='novice-weapon-scroll')!;
  const at=(level:number,uses:number)=>{const state=bag.captureState();const target=state.instances.find(entry=>entry.id===weapon.id)!;target.enhancement=level;target.numbers!.enhancementUses=uses;bag.restoreState(state);};
  at(0,3);
  bag.use(normal.id,weapon.id,undefined,()=>0.99);
  assert.equal(bag.get(weapon.id)!.enhancement,1);
  assert.equal(bag.get(weapon.id)!.numbers!.enhancementUses,2);
  at(0,2);
  bag.use(normal.id,weapon.id,undefined,()=>0);
  assert.equal(bag.get(weapon.id)!.enhancement,2);
});

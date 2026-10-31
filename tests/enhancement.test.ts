import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BattleCharacter } from '../src/domain/character-stats.ts';
import { enhancementChance, enhancementOdds } from '../src/domain/enhancement.ts';
import { parseCharacterStats, parseItemCatalog } from '../src/application/content-validation.ts';
import type { ItemInstance } from '../src/domain/items.ts';

const read=(name:string)=>JSON.parse(fs.readFileSync(new URL(`../public/content/${name}.json`,import.meta.url),'utf8'));
const catalog=parseCharacterStats(read('character-stats')),items=parseItemCatalog(read('items'));
const create=()=>new BattleCharacter('dark-knight',catalog,items);
const close=(actual:number,expected:number)=>assert.ok(Math.abs(actual-expected)<1e-12,`${actual} != ${expected}`);
const setState=(hero:BattleCharacter,id:string,change:(entry:ItemInstance)=>void)=>{const state=hero.bag.captureState();change(state.instances.find(entry=>entry.id===id)!);hero.bag.restoreState(state);};

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

test('unsocket returns the gem with its stored modifier',()=>{
  const hero=create(),bag=hero.bag;bag.add('novice-jewel');bag.add('standard-jewel');
  const weapon=bag.get(bag.equipment['main-hand']!)!;
  setState(hero,weapon.id,entry=>{entry.numbers!.sockets=3;});
  const gems=bag.entries.filter(entry=>items.items[entry.item].use?.kind==='socket');
  bag.use(gems[0]!.id,weapon.id);bag.use(gems[1]!.id,weapon.id);
  const before=bag.get(weapon.id)!;
  assert.equal(before.gems.length,2);
  const removedModifier=before.numbers!.gemModifiers[0]!,removedItem=before.gems[0]!,revision=bag.revision;
  const result=bag.unsocket(weapon.id,0);
  const after=bag.get(weapon.id)!;
  assert.equal(after.gems.length,1);
  assert.deepEqual(after.numbers!.gemModifiers,[before.numbers!.gemModifiers[1]]);
  const restored=bag.get(result.gemId)!;
  assert.equal(restored.item,removedItem);
  assert.deepEqual(restored.numbers!.modifiers,[removedModifier]);
  assert.equal(bag.entries.filter(entry=>entry.id===result.gemId).length,1);
  assert.ok(bag.revision>revision);
});

test('swapGem puts the old gem back with its modifier',()=>{
  const hero=create(),bag=hero.bag;bag.add('novice-jewel');bag.add('standard-jewel');
  const weapon=bag.get(bag.equipment['main-hand']!)!;
  setState(hero,weapon.id,entry=>{entry.numbers!.sockets=3;});
  const first=bag.entries.find(entry=>entry.item==='novice-jewel')!;
  bag.use(first.id,weapon.id);
  const old=bag.get(weapon.id)!;const oldItem=old.gems[0]!,oldModifier=old.numbers!.gemModifiers[0]!;
  const source=bag.entries.find(entry=>entry.item==='standard-jewel')!;
  const sourceModifier=source.numbers!.modifiers[0]!;
  const result=bag.swapGem(weapon.id,0,source.id);
  const after=bag.get(weapon.id)!;
  assert.equal(after.gems[0],source.item);
  assert.deepEqual(after.numbers!.gemModifiers[0],sourceModifier);
  assert.equal(bag.get(source.id),undefined);
  const restored=bag.get(result.removedId)!;
  assert.equal(restored.item,oldItem);
  assert.deepEqual(restored.numbers!.modifiers,[oldModifier]);
});

test('socket guards reject corrupt or locked equipment without changing state',()=>{
  const hero=create(),bag=hero.bag;bag.add('novice-jewel');
  const weapon=bag.get(bag.equipment['main-hand']!)!;
  setState(hero,weapon.id,entry=>{entry.numbers!.sockets=3;});
  const gem=bag.entries.find(entry=>entry.item==='novice-jewel')!;
  bag.use(gem.id,weapon.id);
  setState(hero,weapon.id,entry=>{entry.numbers!.gemModifiers=[];});
  const before=structuredClone(bag.get(weapon.id));
  assert.throws(()=>bag.unsocket(weapon.id,0),/数据不完整/);
  assert.deepEqual(bag.get(weapon.id),before);
  bag.add('standard-jewel');
  const source=bag.entries.find(entry=>entry.item==='standard-jewel')!;
  assert.throws(()=>bag.swapGem(weapon.id,0,source.id),/数据不完整/);
  assert.deepEqual(bag.get(weapon.id),before);
  assert.ok(bag.get(source.id));
  const lockedId=Object.keys(items.items).find(id=>items.items[id].equipment?.locked&&catalog.equipment[id])!;bag.add(lockedId);
  const locked=bag.entries.find(entry=>entry.item===lockedId)!;
  setState(hero,locked.id,entry=>{entry.numbers!.sockets=1;entry.numbers!.gemModifiers=[{...gem.numbers!.modifiers[0]!}];entry.gems=[gem.item];});
  assert.throws(()=>bag.unsocket(locked.id,0),/锁定/);
  assert.throws(()=>bag.swapGem(locked.id,0,source.id),/锁定/);
  assert.ok(bag.get(source.id));
});

test('previewGemChange only computes for worn or empty-slot equipment',()=>{
  const hero=create(),bag=hero.bag,weapon=bag.get(bag.equipment['main-hand']!)!;
  const before=hero.panel;
  const preview=hero.previewGemChange(weapon.id,[{stat:'strength',value:10}]);
  assert.ok(preview);
  assert.equal(preview!.attributes.strength,before.attributes.strength+10);
  const spareId=Object.keys(items.items).find(id=>{const equipment=items.items[id].equipment;return equipment?.slot==='ring'&&equipment.classes.includes('dark-knight')&&!equipment.locked&&catalog.equipment[id];})!;bag.add(spareId);
  const spare=bag.entries.find(entry=>entry.item===spareId)!;
  const equipped=hero.previewGemChange(spare.id,[{stat:'strength',value:10}]);
  assert.ok(equipped,'背包装备放进空槽时给出装备后面板');
  const foreignId=Object.keys(items.items).find(id=>{const equipment=items.items[id].equipment;return equipment&&!equipment.classes.includes('dark-knight')&&!equipment.locked&&catalog.equipment[id];})!;bag.add(foreignId);
  const foreign=bag.entries.find(entry=>entry.item===foreignId)!;
  assert.equal(hero.previewGemChange(foreign.id,[{stat:'strength',value:10}]),undefined);
});

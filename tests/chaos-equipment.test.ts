import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {equipmentLevel,rollChaos,type ChaosRule} from '../src/domain/chaos-equipment.ts';
import {BattleCharacter,equipmentPower,type CharacterStatsCatalog} from '../src/domain/character-stats.ts';
import type {ItemCatalog,ItemInstance} from '../src/domain/items.ts';
import {itemDescriptionBody} from '../src/ui/item-detail-lines.ts';
import type {ShopCatalog} from '../src/domain/shop.ts';
const read=<T>(file:string):T=>JSON.parse(readFileSync(new URL(`../public/content/${file}.json`,import.meta.url),'utf8'));
const items=read<ItemCatalog>('items'),stats=read<CharacterStatsCatalog>('character-stats'),shops=read<ShopCatalog>('shops');
const operations=read<{operations:Record<string,{rule:ChaosRule}>}>('crafting').operations;
const entry:ItemInstance={id:'fixture',item:'fixture',quantity:1,enhancement:0,gems:[]};

test('chaos rolls use two inclusive dice, signed averages and tier limits',()=>{
  const rule=operations.chaos.rule;
  assert.deepEqual(rule,{valueDelta:[-23,25],valueBounds:[0,150],levelDiceDivisor:40,levelClampDivisor:10});
  assert.deepEqual(rollChaos({level:99},entry,'chaos',rule,()=>0),{tier:'chaos',valuePercent:77,levelOffset:-2});
  assert.deepEqual(rollChaos({level:99},entry,'chaos',rule,()=>.999),{tier:'chaos',valuePercent:125,levelOffset:2});
  let index=0;const draws=[0,.999,0,.999];
  assert.deepEqual(rollChaos({level:99},entry,'chaos',rule,()=>draws[index++]),{tier:'chaos',valuePercent:101,levelOffset:0});
  const boosted={...entry,numbers:{modifiers:[],gemModifiers:[],magicPercent:0,sockets:0,enhancementUses:0,chaos:{tier:'chaos' as const,valuePercent:149,levelOffset:-2}}};
  assert.equal(rollChaos({level:99},boosted,'chaos',rule,()=>.999).valuePercent,150);
  boosted.numbers.chaos.valuePercent=199;
  assert.equal(rollChaos({level:99},boosted,'epic-chaos',operations['epic-chaos'].rule,()=>.999).valuePercent,200);
  assert.equal(equipmentLevel({level:99},{...boosted,numbers:{...boosted.numbers,chaos:{tier:'chaos',valuePercent:100,levelOffset:5}}}),100);
  assert.equal(equipmentLevel({level:103},{...boosted,numbers:{...boosted.numbers,chaos:{tier:'chaos',valuePercent:100,levelOffset:5}}}),105);
  assert.throws(()=>rollChaos({level:99},entry,'chaos',rule,()=>1),/随机/);
});

test('purification clears only chaos and updates actual power, level conditions and description',()=>{
  const hero=new BattleCharacter('dark-knight',stats,items),bag=hero.bag;
  const target=bag.get(bag.equipment['main-hand']!)!;
  bag.unequip('main-hand');
  const state=bag.captureState(),gear=state.instances.find(value=>value.id===target.id)!;
  gear.enhancement=4;gear.gems=['novice-jewel'];gear.numbers!.enhancementRule={step:1,threshold:10,extra:1};
  gear.numbers!.chaos={tier:'epic-chaos',valuePercent:150,levelOffset:2};
  gear.numbers!.gemModifiers=[{stat:'strength',value:3}];bag.restoreState(state);
  const before=bag.get(target.id)!,power=equipmentPower(stats.equipment[target.item],before);
  assert.equal(power.attack,Math.trunc((stats.equipment[target.item].attack+4)*1.5));
  assert.match(bag.equipProblem(target.id,'main-hand')!,/需要等级 3/);
  assert.match(bag.equipProblem(target.id,'main-hand','companion',hero.classId,1)!,/需要等级 3/);
  const body=itemDescriptionBody({item:items.items[target.item],entry:before,numbers:stats.equipment[target.item],catalog:stats,grades:shops.grades,member:{classId:hero.classId,level:1},gemNames:before.gems.map(id=>items.items[id]?.name)});
  assert.equal(body.color,'#ff6c00');assert(JSON.stringify(body.rows).includes('3'));
  const purifier=Object.entries(items.items).find(([,item])=>item.use?.kind==='purify')![0];bag.add(purifier,2);
  const source=bag.entries.find(value=>value.item===purifier)!;const layouts=bag.captureState();let changes=0;hero.subscribe(()=>changes++);
  bag.use(source.id,target.id);
  const purified=bag.get(target.id)!;delete before.numbers!.chaos;
  assert.deepEqual(purified,before);assert.equal(changes,1);assert.equal(bag.canApply(source.id,target.id),false);
  assert.equal(bag.equipProblem(target.id,'main-hand'),undefined);
  assert.equal(equipmentPower(stats.equipment[target.item],purified).attack,stats.equipment[target.item].attack+4);
  assert.equal(bag.allCells.findIndex(value=>value?.id===target.id),layouts.allCells.indexOf(target.id));
  assert.deepEqual(bag.captureState().instances.find(value=>value.id===target.id),purified);
  const zero={...purified,numbers:{...purified.numbers!,chaos:{tier:'chaos' as const,valuePercent:0,levelOffset:0}}};
  assert.equal(equipmentPower(stats.equipment[target.item],zero).attack,1);
});

test('scroll eligibility uses original ability level even when chaos lowers the equip requirement',()=>{
  const hero=new BattleCharacter('dark-knight',stats,items),bag=hero.bag;
  bag.add('blade-of-hell');bag.add('novice-weapon-scroll');
  const target=bag.entries.find(e=>e.item==='blade-of-hell')!,source=bag.entries.find(e=>e.item==='novice-weapon-scroll')!;
  const state=bag.captureState(),gear=state.instances.find(e=>e.id===target.id)!;
  gear.numbers!.chaos={tier:'epic-chaos',valuePercent:120,levelOffset:-1};gear.numbers!.enhancementUses=3;bag.restoreState(state);
  assert.equal(equipmentLevel(items.items[target.item],bag.get(target.id)!),33);
  assert.equal(bag.canApply(source.id,target.id),true);
  const before=bag.captureState();assert.equal(bag.applicationProblem(source.id,target.id),'enchant-level');
  assert.throws(()=>bag.use(source.id,target.id),/等级不符/);assert.deepEqual(bag.captureState(),before);
});

test('only the top and special scroll pair is interchangeable, and durability is checked before the level cap',()=>{
  const hero=new BattleCharacter('dark-knight',stats,items),bag=hero.bag;
  const inBag=(id:string)=>{bag.add(id);return bag.entries.find(e=>e.item===id)!.id;};
  const scroll=(id:string)=>{bag.add(id,3);return bag.entries.find(e=>e.item===id)!.id;};
  const withUses=(id:string,uses:number)=>{const state=bag.captureState();state.instances.find(e=>e.id===id)!.numbers!.enhancementUses=uses;bag.restoreState(state);};
  const weapon=inBag('dagger'),armor=inBag('robe');withUses(weapon,5);withUses(armor,5);
  const topWeapon=scroll('supreme-weapon-scroll'),specialWeapon=scroll('sp-weapon-enhance-scroll');
  bag.use(topWeapon,weapon,undefined,()=>.999);
  assert.equal(bag.targetProblem(specialWeapon,weapon),undefined);
  const topArmor=scroll('supreme-armor-scroll'),specialArmor=scroll('sp-armor-enhance-scroll');
  bag.use(topArmor,armor,undefined,()=>.999);
  assert.equal(bag.targetProblem(specialArmor,armor),undefined);
  const plain=inBag('short-sword');withUses(plain,5);
  const novice=scroll('novice-weapon-scroll'),standard=scroll('standard-weapon-scroll');
  bag.use(novice,plain,undefined,()=>.999);
  assert.equal(bag.applicationProblem(standard,plain),'enchant-rule');
  const state=bag.captureState(),gear=state.instances.find(e=>e.id===plain)!;
  gear.enhancement=30;gear.numbers!.enhancementUses=0;bag.restoreState(state);
  assert.equal(bag.applicationProblem(novice,plain),'enchant-durability');
});

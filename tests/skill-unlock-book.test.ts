import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { BattleCatalog } from '../src/domain/battle.ts';
import type { Campaign } from '../src/domain/campaign.ts';
import { BattleCharacter, type CharacterStatsCatalog } from '../src/domain/character-stats.ts';
import { blockedNormalAcquisitionIds, type ItemCatalog } from '../src/domain/items.ts';
import type { CompanionCatalog } from '../src/domain/party.ts';
import { parseDrops } from '../src/domain/drops.ts';
import { Storefront } from '../src/domain/shop.ts';
import { Session } from '../src/domain/session.ts';
import { parseShops } from '../src/application/content-validation.ts';

const read=<T>(name:string):T=>JSON.parse(readFileSync(new URL(`../public/content/${name}.json`,import.meta.url),'utf8')) as T;
const items=read<ItemCatalog>('items'),stats=read<CharacterStatsCatalog>('character-stats'),companions=read<CompanionCatalog>('companions');
const campaign=read<Campaign>('campaign'),battle=read<BattleCatalog>('battle');
const sealed=['sealed-skillbook-black-knight','sealed-skillbook-assassin','sealed-skillbook-warlock','sealed-skillbook-priest','sealed-skillbook-ranger','sealed-skillbook-warrior'];

function fixture(){
  const hero=new BattleCharacter('dark-knight',stats,items);
  const session=new Session(campaign,undefined,undefined,items,hero,battle,stats,companions);
  const recruit=(item:string)=>{session.bag.add(item);return session.party!.recruit(session.bag.entries.find(entry=>entry.item===item)!.id,()=>0).member;};
  return {session,recruit};
}

test('sealed skill books open into a bound unlock book for a random class skill',()=>{
  const {session}=fixture();
  session.bag.add('sealed-skillbook-black-knight');
  const sealedEntry=session.bag.entries.find(entry=>entry.item==='sealed-skillbook-black-knight')!;
  const result=session.bag.use(sealedEntry.id,undefined,undefined,()=>0);
  assert.equal(result.rewards.length,1);
  assert.equal(result.rewards[0]!.item,'skill-unlock-book');
  assert.ok(result.skill&&battle.classes.find(entry=>entry.id==='dark-knight')!.skills.includes(result.skill));
  assert.equal(session.bag.count('sealed-skillbook-black-knight'),0);
  const opened=session.bag.entries.find(entry=>entry.item==='skill-unlock-book')!;
  assert.equal(opened.skill,result.skill);
});

test('an unlock book teaches a mercenary an off-table skill without being consumed',()=>{
  const {session,recruit}=fixture();
  const member=recruit('mercenary-emblem-black-knight');
  const classSkills=battle.classes.find(entry=>entry.id===member.classId)!.skills;
  const missing=classSkills.find(id=>!(id in member.skills.skillLevels()))!;
  assert.ok(missing,'佣兵初始技能表不覆盖全部职业技能');
  session.bag.add('skill-unlock-book',1,missing);
  const book=session.bag.entries.find(entry=>entry.item==='skill-unlock-book')!;

  const result=session.bag.use(book.id,undefined,missing,()=>0.5,member.id);
  assert.match(result.message,/已解锁/);
  assert.equal(member.skills.skillLevels()[missing],1,'解锁后从 1 级开始');
  assert.ok(session.bag.get(book.id),'解锁书使用后不消失');
  assert.equal(member.skills.bookProblem(missing,battle),undefined,'解锁技能可以用普通技能书继续升级');
  assert.equal(member.skills.book(missing,battle),2);
  assert.equal(member.skills.bookProblem(missing,battle),undefined);

  assert.throws(()=>session.bag.use(book.id,undefined,missing,()=>0.5,member.id),/已学会/);
  assert.ok(session.bag.get(book.id),'已学会时书仍在背包里');
  assert.throws(()=>session.bag.use(book.id,undefined,missing,()=>0.5,'player'),/佣兵/);

  const second=recruit('mercenary-emblem-black-knight');
  assert.equal(second.classId,member.classId);
  assert.equal(second.skills.skillLevels()[missing]??0,0);
  session.bag.use(book.id,undefined,missing,()=>0.5,second.id);
  assert.equal(second.skills.skillLevels()[missing],1,'同一本书可以给另一个同职业佣兵');
  assert.ok(session.bag.get(book.id));

  const assassin=recruit('mercenary-emblem-assassin');
  assert.throws(()=>session.bag.use(book.id,undefined,missing,()=>0.5,assassin.id),/职业不符/);
  assert.ok(session.bag.get(book.id));
});

test('unlocked skills are saved and restored with the mercenary',()=>{
  const {session,recruit}=fixture();
  const member=recruit('mercenary-emblem-black-knight');
  const missing=battle.classes.find(entry=>entry.id===member.classId)!.skills.find(id=>!(id in member.skills.skillLevels()))!;
  session.bag.add('skill-unlock-book',1,missing);
  session.bag.use(session.bag.entries.find(entry=>entry.item==='skill-unlock-book')!.id,undefined,missing,()=>0.5,member.id);
  const state=member.captureState();
  assert.equal(state.unlockedSkills?.[missing],1);
  const restored=recruit('mercenary-emblem-black-knight');
  restored.restoreState(state);
  assert.equal(restored.skills.skillLevels()[missing],1,'读档后解锁技能仍在');
  assert.equal(restored.skills.bookProblem(missing,battle),undefined);
});

test('unlocking an initial-table skill at level zero freezes its natural growth and books still raise it',()=>{
  const {session,recruit}=fixture();
  const member=recruit('mercenary-emblem-black-knight');
  const capped=Object.keys(member.generated.skillCaps).find(id=>(member.skills.skillLevels()[id]??0)===0);
  assert.ok(capped,'佣兵初始技能表里存在尚未到等级的技能');
  session.bag.add('skill-unlock-book',1,capped);
  session.bag.use(session.bag.entries.find(entry=>entry.item==='skill-unlock-book')!.id,undefined,capped,()=>0.5,member.id);
  assert.equal(member.skills.skillLevels()[capped],1);
  member.addExperience(Number.MAX_SAFE_INTEGER);
  assert.equal(member.skills.skillLevels()[capped],1,'解锁技能不随角色等级自然成长');
  assert.equal(member.skills.book(capped,battle),2,'普通技能书仍能从解锁等级继续升');
});

test('mercenary max-all learns every class skill and keeps it at max after level changes',()=>{
  const {recruit}=fixture();
  const member=recruit('mercenary-emblem-black-knight');
  const classSkills=battle.classes.find(entry=>entry.id===member.classId)!.skills;
  member.skills.maxAll(battle,member.classId);
  for(const id of classSkills){
    const maximum=battle.skills[id]!.companion?.ranks.length??battle.skills[id]!.ranks.length;
    assert.equal(member.skills.skillLevels()[id],maximum,`${id} 应满级`);
  }
  member.addExperience(Number.MAX_SAFE_INTEGER);
  for(const id of classSkills){
    const maximum=battle.skills[id]!.companion?.ranks.length??battle.skills[id]!.ranks.length;
    assert.equal(member.skills.skillLevels()[id],maximum,`${id} 升级后仍满级`);
  }
});

test('skill books and sealed books can be sold and discarded',()=>{
  const {session}=fixture();
  const catalog=parseShops(read('shops'));
  const store=new Storefront(catalog,items,stats,session,'merchandise-dealer-b09d9585','shadow-camp');
  const skill=battle.classes.find(entry=>entry.id==='dark-knight')!.skills[0]!;
  for(const [id,bookSkill] of [['skillbook',undefined],['sealed-skillbook-black-knight',undefined],['skill-unlock-book',skill]] as const){
    session.bag.add(id,1,bookSkill);
    const entry=session.bag.entries.find(value=>value.item===id)!;
    assert.ok(store.sellPrice(entry)>0,`${id} 应有售价`);
    const before=session.money;store.sell(entry.id,1);
    assert.equal(session.bag.count(id),0,`${id} 可以出售`);
    assert.ok(session.money>before,`${id} 出售后有钱`);
    session.bag.add(id,1,bookSkill);
    const discarded=session.bag.entries.find(value=>value.item===id)!;
    session.bag.discard(discarded.id,1);
    assert.equal(session.bag.count(id),0,`${id} 可以丢弃`);
  }
});

test('sealed books sold by shops have a positive price and can be bought',()=>{
  const catalog=parseShops(read('shops'));
  const id='test-sealed-shop';
  catalog.shops[id]={name:'测试商人',priceRatePercent:100,fixedStock:['sealed-skillbook-black-knight'],categories:[],stockRules:[]};
  const s=new Session(campaign,undefined,undefined,items);
  const store=new Storefront(catalog,items,stats,s,id,'shadow-camp');
  const offer=store.offers.find(value=>value.instance.item==='sealed-skillbook-black-knight')!;
  assert.ok(offer);
  const price=store.buyPrice(offer.id);
  assert.ok(price>0,'封印技能书必须有正价格');
  s.gainMoney(price);
  store.buy(offer.id,1);
  assert.equal(s.bag.count('sealed-skillbook-black-knight'),1);
});

test('sealed skill books remain in the reserved channel and also enter normal loot and shops',()=>{
  const drops=parseDrops(read('drops'),items,battle.enemies.map(enemy=>enemy.id));
  const blocked=blockedNormalAcquisitionIds(items);
  for(const id of sealed){
    assert.equal(blocked.has(id),false,`${id} 可以正常获取`);
    assert.ok(items.items[id]!.basePrice>0,`${id} 商店价格必须为正`);
    assert.ok(drops.pools.ordinary.misc?.some(choice=>choice.item===id));
    assert.ok(drops.pools.advanced.misc?.some(choice=>choice.item===id));
    assert.equal(read<{reservedDrops:{entries:{item:string;once:boolean}[]}}>('drops').reservedDrops.entries.find(entry=>entry.item===id)?.once,false);
  }
  const shops=read<{profiles:Record<string,{pools:Record<string,{item?:string}[]>}>}>('shops');
  for(const profile of ['black-market','lamp'])
    for(const id of sealed)assert.ok(shops.profiles[profile]!.pools.misc?.some(choice=>choice.item===id));
  assert.equal(items.items['skill-unlock-book']?.use?.kind,'unlock-skill');
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Session } from '../src/domain/session.ts';
import { Storefront, itemValue, saleValue } from '../src/domain/shop.ts';
import type { ItemCatalog } from '../src/domain/items.ts';
import { equipmentPower, calculateCharacter, type CharacterStatsCatalog } from '../src/domain/character-stats.ts';
import type { Campaign } from '../src/domain/campaign.ts';
import { parseShops } from '../src/application/content-validation.ts';

const read = <T>(name:string):T => JSON.parse(readFileSync(new URL(`../public/content/${name}.json`,import.meta.url),'utf8')) as T;
const items=read<ItemCatalog>('items'),stats=read<CharacterStatsCatalog>('character-stats'),shops=parseShops(read('shops'));
const campaign=read<Campaign>('campaign');
const general='merchandise-dealer-b09d9585',weapon='weapons-dealer-f31d78ce',armor='armor-trader-70af4958';
const black='crooked-street-vendor-582a688d',rare='rare-items-dealer-2d609a7f';
const session=()=>new Session(campaign,undefined,undefined,items);
const open=(s:Session,id=general,catalog=shops,random=()=>0.1)=>new Storefront(catalog,items,stats,s,id,s.shops.mapId??'shadow-camp',random);
const offer=(store:Storefront,item:string)=>store.offers.find(offer=>!offer.sold&&offer.instance.item===item)!;

test('only the general merchants carry the party-wipe prayer at its authored price',()=>{
  const s=session(),store=open(s),id=offer(store,'resurrection-prayer').id;
  assert.equal(store.buyPrice(id),1000);assert.equal(items.items['resurrection-prayer'].basePrice,1000);
  s.gainMoney(1000);assert.equal(store.buy(id,1),1000);assert.equal(s.money,0);
  assert.equal(s.bag.count('resurrection-prayer'),1);
  const entry=s.bag.entries.find(value=>value.item==='resurrection-prayer')!;
  assert.throws(()=>store.sell(entry.id,1),/无法出售/);
  const generalShops=Object.entries(shops.shops).filter(([,shop])=>shop.name==='杂货商人');
  assert.equal(generalShops.length,5);
  for(const [key,shop] of Object.entries(shops.shops))
    assert.equal(shop.fixedStock.includes('resurrection-prayer'),shop.name==='杂货商人',`${key} 的货架与商店类型不一致`);
});

test('ordinary merchant validates quantities and publishes one complete transaction',()=>{
  const s=session(),store=open(s),id=offer(store,'healing-potion-s').id;
  assert.equal(store.buyPrice(id),15);assert.throws(()=>store.buy(id,1),/金币不足/);
  assert.equal(s.bag.count('healing-potion-s'),5);
  s.gainMoney(50);const snapshots:number[][]=[];
  s.subscribe(()=>snapshots.push([s.money,s.bag.count('healing-potion-s')]));
  assert.equal(store.buy(id,2),30);assert.deepEqual(snapshots,[[20,7]]);
  const entry=s.bag.entries.find(item=>item.item==='healing-potion-s')!;
  assert.equal(store.sell(entry.id,3),9);assert.deepEqual(snapshots.at(-1),[29,4]);assert.equal(snapshots.length,2);
  for(const count of [0,-1,1.5,100])assert.throws(()=>store.buy(id,count),/数量无效/);
  assert.throws(()=>store.sell(entry.id,99),/数量无效/);assert.equal(s.money,29);
 });

test('bulk sale validates the whole batch before mutating and settles with one notification',()=>{
  const s=session(),store=open(s),id=offer(store,'healing-potion-s').id;
  s.gainMoney(100);store.buy(id,2);
  const potion=s.bag.entries.find(value=>value.item==='healing-potion-s')!;
  s.bag.add('resurrection-prayer');
  const quest=s.bag.entries.find(value=>value.item==='resurrection-prayer')!;
  const money=s.money,count=s.bag.count('healing-potion-s');
  // 批里只要有一件卖不掉，整批都不落地。
  assert.throws(()=>store.sellMany([{id:potion.id,quantity:1},{id:quest.id,quantity:1}]),/无法出售/);
  assert.equal(s.money,money);assert.equal(s.bag.count('healing-potion-s'),count);
  assert.throws(()=>store.sellMany([]),/请选择/);
  assert.throws(()=>store.sellMany([{id:potion.id,quantity:1},{id:potion.id,quantity:1}]),/数量无效/);
  const price=store.sellPrice(potion),snapshots:number[]=[];
  s.subscribe(()=>snapshots.push(s.money));
  assert.equal(store.sellMany([{id:potion.id,quantity:1}]),price);
  assert.deepEqual(snapshots,[money+price],'整批只通知一次');
  assert.equal(s.bag.count('healing-potion-s'),count-1);assert.equal(s.money,money+price);
});

test('native weapon and armor categories are exact, independent of equipment slots',()=>{
  const s=session(),weapons=open(s,weapon),armors=open(s,armor);
  assert.equal(weapons.shop.categories.length,9);assert.equal(armors.shop.categories.length,9);
  assert.deepEqual(armors.shop.categories,['cloth','leather','plate','hat','helmet','gloves','boots','shield','circlet']);
  for(const store of [weapons,armors])for(const category of store.shop.categories){
    store.selectCategory(category);assert.ok(store.offers.length<=16);
    assert.ok(store.offers.every(offer=>items.items[offer.instance.item].kind===category));
  }
  assert.equal(open(s).shop.categories.length,0);assert.throws(()=>weapons.selectCategory('necklace'));
  assert.equal(Object.keys(shops.shops).length,18);
});

test('unlimited equipment copies keep the displayed grade and attributes, with separate identities',()=>{
  const s=session(),store=open(s,weapon),preview=store.offers[0];s.gainMoney(100000);
  const numbers=structuredClone(preview.instance.numbers),price=store.buyPrice(preview.id);
  assert.equal(numbers!.grade,2);assert.equal(numbers!.sockets,0);
  store.buy(preview.id,1);store.buy(preview.id,1);
  const bought=s.bag.entries.filter(entry=>entry.item===preview.instance.item).slice(-2);
  assert.equal(bought.length,2);assert.notEqual(bought[0].id,bought[1].id);
  for(const entry of bought){assert.deepEqual(entry.numbers,numbers);assert.equal(itemValue(items,stats,entry.item,entry),price);}
  assert.equal(preview.sold,false);assert.throws(()=>store.buy(preview.id,2),/数量无效/);
});

test('limited stock allows duplicates, retains sold holes on reopen, and rerolls only after a map change',()=>{
  const s=session(),store=open(s,black),limited=store.offers.filter(offer=>offer.limited);
  assert.equal(limited.length,8);assert.equal(new Set(limited.map(offer=>offer.instance.item)).size,1);
  const picked=limited[0],numbers=structuredClone(picked.instance.numbers);s.gainMoney(100000);
  store.buy(picked.id,1);assert.equal(picked.sold,true);
  assert.deepEqual(s.bag.entries.filter(entry=>entry.item===picked.instance.item).at(-1)!.numbers,numbers);
  assert.throws(()=>store.buy(picked.id,1),/货架/);
  const reopened=open(s,black,shops,()=>{throw new Error('random stock rerolled');});
  assert.deepEqual(reopened.offers.filter(offer=>offer.limited),limited);
  s.enterMap('shadow-camp');assert.deepEqual(open(s,black).offers.filter(offer=>offer.limited),limited);
  s.enterMap('shadow-forest-east');s.enterMap('shadow-camp');
  assert.notEqual(open(s,black).offers.find(offer=>offer.limited)!.id,picked.id);
});

test('sixteen limited slots are shared across merchants and sold slots remain occupied',()=>{
  const s=session();assert.equal(open(s,black).offers.filter(offer=>offer.limited).length,8);
  assert.equal(open(s,shops.lampShop).offers.filter(offer=>offer.limited).length,8);
  assert.equal(open(s,rare).offers.length,0);
});

test('black market uses map level and group eight, lamp uses main character level and group nine',()=>{
  const catalog=structuredClone(shops),s=session();catalog.mapShopLevels['shadow-camp']=80;
  const market=open(s,black,catalog),lamp=open(s,catalog.lampShop,catalog);
  for(const value of market.offers.filter(offer=>offer.limited)){
    const level=catalog.equipment[value.instance.item].dropLevel;assert.ok(level>=75&&level<=85);
  }
  for(const value of lamp.offers.filter(offer=>offer.limited)){
    const level=catalog.equipment[value.instance.item].dropLevel;assert.ok(level>=1&&level<=6);
  }
  assert.equal(market.buyPrice(offer(market,'healing-potion-s').id),45);
  assert.equal(lamp.buyPrice(offer(lamp,'healing-potion-s').id),30);
});

test('empty random candidates stay empty without inventing substitute equipment',()=>{
  const catalog=structuredClone(shops),s=session();
  for(const value of Object.values(catalog.equipment)){value.randomListed=false;value.uniqueListed=false;}
  const profile=catalog.profiles['black-market'];
  profile.chances={generic:0,equipment:10000,consumable:0,upgrade:0,crafting:0,misc:0};
  assert.equal(open(s,black,catalog).offers.filter(offer=>offer.limited).length,0);
  assert.equal(open(s,rare,catalog).offers.length,0);
});

test('rare merchant conceals attributes and uses level-based quotation without a second multiplier',()=>{
  const s=session(),store=open(s,rare,shops,()=>0.2),entry=store.offers[0];assert.ok(entry);
  assert.equal(entry.concealed,true);assert.equal(entry.limited,true);
  const price=shops.equipment[entry.instance.item].concealedPrices[1];assert.ok(price>0);
  assert.equal(store.buyPrice(entry.id),price);
  const numbers=structuredClone(entry.instance.numbers);s.gainMoney(100000);store.buy(entry.id,1);
  assert.deepEqual(s.bag.entries.filter(value=>value.item===entry.instance.item).at(-1)!.numbers,numbers);
  assert.equal(open(s,rare).offers[0].sold,true);
});

test('rolled grades drive both weapon prices and equipped combat power',()=>{
  const s=session(),store=open(s,black,shops,()=>0.1),entry=store.offers.find(offer=>offer.limited)!.instance;
  const d=stats.equipment[entry.item],variant=shops.equipment[entry.item].variants[entry.numbers!.grade!];
  assert.equal(entry.numbers!.grade,0);assert.equal(equipmentPower(d,entry).attack,variant.attack);
  const zero={strength:0,dexterity:0,vitality:0,intelligence:0,mentality:0};
  const bare=calculateCharacter(stats,items,'dark-knight',1,zero,{}),equipped=calculateCharacter(stats,items,'dark-knight',1,zero,{'main-hand':entry});
  assert.equal(equipped.physicalAttack-bare.physicalAttack,variant.attack);
  assert.equal(itemValue(items,stats,entry.item,entry),Math.trunc(variant.attack*(items.items[entry.item].level+140)/10));
});

test('sellability is separate from discardability, and premium prices use the native formula',()=>{
  const catalog=structuredClone(items),s=new Session(campaign,undefined,undefined,catalog);
  catalog.items['healing-potion-s'].discardable=false;
  const store=new Storefront(shops,catalog,stats,s,general,'shadow-camp');
  const potion=s.bag.entries.find(entry=>entry.item==='healing-potion-s')!;assert.equal(store.sellPrice(potion),3);
  catalog.items['healing-potion-s'].sellable=false;assert.equal(store.sellPrice(potion),0);assert.throws(()=>store.sell(potion.id,1),/无法出售/);
  const premium=Object.keys(catalog.items).find(id=>catalog.items[id].pricePremium&&catalog.items[id].equipment)!;
  const price=itemValue(catalog,stats,premium);catalog.items[premium].pricePremium=false;
  assert.equal(price,itemValue(catalog,stats,premium)*8+30000);assert.equal(saleValue(15),3);
});

test('limited consumables sell once and cannot be bought as unlimited stacks',()=>{
  const catalog=structuredClone(shops),s=session(),profile=catalog.profiles['black-market'];
  profile.chances={generic:10000,equipment:0,consumable:0,upgrade:0,crafting:0,misc:0};
  profile.pools.generic=[{weight:10000,item:'healing-potion-s'}];
  const store=open(s,black,catalog),entry=store.offers.find(offer=>offer.limited)!;s.gainMoney(1000);
  assert.throws(()=>store.buy(entry.id,2),/数量无效/);store.buy(entry.id,1);assert.equal(entry.sold,true);
});

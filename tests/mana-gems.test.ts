import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseItemCatalog} from '../src/application/content-validation.ts';
import {Bag} from '../src/domain/bag.ts';
import {GroundLootStore} from '../src/domain/ground-loot.ts';
import {recoverManaPickup,rollManaGem} from '../src/domain/mana-gems.ts';
import {RecoveryItems} from '../src/domain/recovery-items.ts';
import {Session} from '../src/domain/session.ts';
import {Storefront,type ShopCatalog} from '../src/domain/shop.ts';
import type { Campaign } from '../src/domain/campaign.ts';
import type {CharacterStatsCatalog} from '../src/domain/character-stats.ts';
const read=(name:string)=>JSON.parse(readFileSync(new URL(`../public/content/${name}.json`,import.meta.url),'utf8'));
const items=parseItemCatalog(read('items')),pickup=items.items['mana-gem'].pickup!;
const member=(id:string,mana:number,maxMana:number,health=1)=>({id,player:{health,mana,maxMana},setMana(value:number){this.player.mana=value;}});

test('mana pickup restores every living party slot using the collector maximum and ignores potion cooldown',()=>{
  const party=[member('player',10,100),member('ally',399,500),member('dead',0,400,0)];
  const recovery=new RecoveryItems(),bag=new Bag(()=>{},items,'dark-knight','game');
  recovery.use(bag,bag.entries.find(entry=>entry.item==='healing-potion-s')!.id,
    [{id:'player',player:{health:1,maxHealth:100,mana:0,maxMana:100},setHealth:()=>{},setMana:()=>{}}],'player');
  const before=recovery.cooldown;assert.equal(before.cooling,true);
  const result=recoverManaPickup(pickup,party,'ally')!;
  assert.equal(result.amount,100);
  assert.deepEqual(party.map(m=>m.player.mana),[100,499,0]);
  assert.deepEqual(result.effects,['player','ally']);
  assert.deepEqual(recovery.cooldown,before);
  party[0].player.mana=100;party[1].player.mana=500;
  const ground=new GroundLootStore();ground.add('map',0,0,[{kind:'item',item:'mana-gem',quantity:1}]);
  let effects:string[]=[];
  ground.collectNearby('map',12,12,()=>{effects=recoverManaPickup(pickup,party,'ally')!.effects;});
  assert.deepEqual(effects,['ally']);assert.deepEqual(ground.forMap('map'),[]);
});

test('a dead collector yields no pickup instead of throwing from a frame callback',()=>{
  const party=[member('player',0,100,0),member('ally',0,100)];
  assert.equal(recoverManaPickup(pickup,party,'player'),undefined);
  assert.equal(recoverManaPickup(pickup,party,'missing'),undefined);
});

test('mana pickup retains native ordered effect propagation and integer rounding',()=>{
  const party=[member('full-before',100,100),member('collector',0,101),member('full-after',50,50)];
  const result=recoverManaPickup(pickup,party,'collector')!;
  assert.equal(result.amount,20);assert.equal(party[1].player.mana,20);
  assert.deepEqual(result.effects,['collector','full-after']);
});

test('mana gems stay out of seeded inventory, shortcuts, rewards and all storefront paths',()=>{
  const bag=new Bag(()=>{},items,'dark-knight','game');
  assert.equal(bag.count('mana-gem'),0);
  assert.throws(()=>bag.add('mana-gem'),/地面/);
  assert.throws(()=>bag.receiveDrop({id:'gem',item:'mana-gem',quantity:1,enhancement:0,gems:[]}),/无效/);
  assert.equal(items.items['mana-gem'].shortcut,false,'不能登记到快捷位，背包里因此没有那枚按钮');
  const shops=read('shops') as ShopCatalog;
  shops.shops.test={name:'test',priceRatePercent:100,categories:[],fixedStock:['mana-gem','healing-potion-s'],stockRules:[{kind:'random-stock',attempts:2,levelRadius:5,profile:'black-market'}]};
  const profile=shops.profiles['black-market'];
  profile.chances={generic:10000,equipment:0,consumable:0,upgrade:0,crafting:0,misc:0};
  profile.pools.generic=[{weight:10000,item:'mana-gem'}];profile.uniqueChanceByLevel.fill(0);
  const session=new Session(read('campaign') as Campaign,undefined,undefined,items);
  const store=new Storefront(shops,items,read('character-stats') as CharacterStatsCatalog,session,'test','shadow-camp');
  assert.deepEqual(store.offers.map(offer=>offer.instance.item),['healing-potion-s']);assert.throws(()=>store.buy('mana-gem',1),/货架/);
});

test('hit rolls use strict native thresholds, positive damage and four directional landing attempts',()=>{
  const origin={x:100,y:100},free=()=>true;
  assert.equal(rollManaGem(pickup,0,'skill',undefined,origin,free,()=>0),undefined);
  assert.equal(rollManaGem(pickup,1,'weapon',undefined,origin,free,()=>0),undefined);
  assert.ok(rollManaGem(pickup,1,'weapon','dagger',origin,free,()=>58/999));
  assert.equal(rollManaGem(pickup,1,'weapon','dagger',origin,free,()=>59/999),undefined);
  assert.ok(rollManaGem(pickup,1,'skill',undefined,origin,free,()=>8/999));
  assert.equal(rollManaGem(pickup,1,'skill','bow',origin,free,()=>9/999),undefined);
  const tried:{x:number;y:number}[]=[];
  const landing=rollManaGem(pickup,1,'skill',undefined,origin,p=>{tried.push(p);return false;},()=>0)!;
  assert.equal(tried.length,4);assert.equal(landing.direction,3);
  assert.deepEqual(tried.map(p=>[p.x,p.y]),[[116,139],[47,111],[80,41],[149,74]]);
});

test('flying gems cannot be collected before all nine original frames finish and stay on their map',()=>{
  const ground=new GroundLootStore(),clip=pickup.hitDrop.directions[0].clip;
  assert.equal(clip.frames,9);assert.equal(clip.frames*1000/clip.frameRate,540);
  ground.addFlying('map',{x:0,y:0},{x:20,y:40,direction:0},'mana-gem',540);
  const collect=()=>ground.collectNearby('map',20,40,()=>{});
  assert.equal(collect().length,0);
  ground.advance('other',1000);assert.equal(collect().length,0);
  ground.advance('map',539);assert.equal(collect().length,0);
  ground.advance('map',1);assert.equal(collect().length,1);
  assert.equal(collect().length,0);
});

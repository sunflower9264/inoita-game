import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { BattleCharacter, type CharacterStatsCatalog } from '../src/domain/character-stats.ts';
import type { CompanionCatalog, CompanionGroupEffect } from '../src/domain/party.ts';
import type { BattleCatalog } from '../src/domain/battle.ts';
import type { Campaign } from '../src/domain/campaign.ts';
import type { ItemCatalog } from '../src/domain/items.ts';
import { Session } from '../src/domain/session.ts';
import { Storefront, saleValue, type ShopCatalog } from '../src/domain/shop.ts';
import { rollEnemyLoot, rollBreakableLoot, type DropCatalog, type DropModifiers } from '../src/domain/drops.ts';

const read=<T>(name:string):T=>JSON.parse(readFileSync(new URL(`../public/content/${name}.json`,import.meta.url),'utf8')) as T;
const campaign=read<Campaign>('campaign'),items=read<ItemCatalog>('items'),stats=read<CharacterStatsCatalog>('character-stats');
const battle=read<BattleCatalog>('battle'),companions=read<CompanionCatalog>('companions'),shops=read<ShopCatalog>('shops');
const enemyDrops=(data:DropCatalog,enemyId:string,playerLevel:number,random:()=>number,modifiers?:DropModifiers)=>
  rollEnemyLoot(data,stats,enemyId,playerLevel,playerLevel,random,modifiers).rewards;
function withGroups(effects:CompanionGroupEffect[]):Session {
  const hero=new BattleCharacter('dark-knight',stats,items),session=new Session(campaign,undefined,undefined,items,hero,battle,stats,companions);
  session.bag.add('mercenary-emblem-priest');
  session.party!.recruit(session.bag.entries.find(entry=>entry.item==='mercenary-emblem-priest')!.id,()=>0);
  const state=session.party!.captureState();state.members[0].generated.groupSkills=effects;session.party!.restoreState(state);
  return session;
}

test('reserve mercenary group skills adjust live shop quotes and actual transactions with native rounding',()=>{
  const session=withGroups(['buy-discount','sell-price']);
  assert.equal(session.party!.activeSize,1);
  const store=new Storefront(shops,items,stats,session,'merchandise-dealer-b09d9585',campaign.start.map);
  const offer=store.offers.find(offer=>items.items[offer.instance.item].basePrice>=200)!;
  const price=items.items[offer.instance.item].basePrice,discounted=price-Math.floor(price*.02);
  assert.equal(store.buyPrice(offer.id),discounted);
  session.gainMoney(10000);assert.equal(store.buy(offer.id,2),discounted*2);
  const bought=session.bag.entries.find(entry=>entry.item===offer.instance.item)!;
  const sale=saleValue(price),boosted=sale+Math.floor(sale*.03);
  assert.equal(store.sellPrice(bought),boosted);assert.equal(store.sell(bought.id,1),boosted);
  const member=session.party!.snapshot().reserves[0];session.party!.dismiss(member);
  assert.equal(store.buyPrice(offer.id),price);assert.equal(store.sellPrice(bought),sale);
});

test('potion group skills increase the shared heal and subtract forty-five logic frames from its cooldown',()=>{
  const session=withGroups(['potion-recovery','potion-cooldown-ms']),hero=session.hero!;
  hero.addExperience(10000);hero.setHealth(1);
  const modifiers=session.party!.groupModifiers(),entry=session.bag.entries.find(entry=>entry.item===items.startingShortcut)!;
  const recovery=items.items[entry.item].use!.recovery!;
  // 开局快捷位是点数回复药水；比例式的元气恢复药水另有用例。
  if(recovery.mode!=='amount')throw new Error('开局快捷位应当是点数回复药水');
  const result=session.recovery.use(session.bag,entry.id,[{id:'player',player:hero.player,setHealth:value=>hero.setHealth(value),setMana:value=>hero.setMana(value)}],'player',{
    recoveryBonus:!!modifiers['potion-recovery'],cooldownReductionMs:modifiers['potion-cooldown-ms']
  },()=>0);
  assert.equal(result.used,true);
  if(result.used)assert.equal(result.amount,recovery.minHealth+Math.floor(recovery.minHealth/10));
  assert.equal(session.recovery.cooldown.remainingMs,recovery.cooldownMs-2700);
  assert.equal(session.recovery.cooldown.durationMs,recovery.cooldownMs);
});

test('drop talents add absolute chances after level scaling and never enable a zero-rate slot',()=>{
  const catalog=read<DropCatalog>('drops'),source=Object.values(catalog.enemies)[0];
  for(const [slot,effect,value] of [['equipment','equipment-drop',10],['upgrade','scroll-drop',20],['crafting','material-drop',20]] as const){
    const chances={money:0,equipment:0,consumable:0,upgrade:0,crafting:0,misc:0,unique:0,fixed:0};chances[slot]=50;
    const data:DropCatalog={...catalog,enemies:{fixture:{...source,level:1,rolls:1,pool:'fixture',chances}},
      pools:{...catalog.pools,fixture:{upgrade:[{item:'resurrection-scroll',weight:10000}],crafting:[{item:'mithril',weight:10000}]}},
      equipment:{weapon:[{item:'fixture-weapon',dropLevel:1}],armor:[],special:[],unique:[],epic:[]}};
    const random=()=>{let n=0;return()=>n++===0?5/9999:0;};
    const modifiers:DropModifiers={[effect]:value};
    assert.deepEqual(enemyDrops(data,'fixture',99,random()),[]);
    assert.equal(enemyDrops(data,'fixture',99,random(),modifiers).length,1);
    data.enemies.fixture.chances[slot]=0;
    assert.deepEqual(enemyDrops(data,'fixture',99,()=>0,modifiers),[]);
  }
});

test('the treasure talent selects the better breakable-box table on the original 49/999 boundary',()=>{
  const data=read<DropCatalog>('drops');
  const base=data.breakables!.box,fortunate=data.breakables!['fortunate-box'];
  for(const rule of [base,fortunate]){rule.spawn=undefined;rule.chances={money:0,equipment:0,consumable:0,upgrade:0,crafting:0,misc:0,unique:0,fixed:0};rule.uniqueChance.numerator=0;}
  fortunate.chances.money=10000;
  const random=(first:number)=>{let n=0;return()=>n++===0?first:0;};
  assert.equal(rollBreakableLoot(data,stats,'box',1,1,random(48/999),{'chest-quality':1}).rewards.length,1);
  assert.equal(rollBreakableLoot(data,stats,'box',1,1,random(49/999),{'chest-quality':1}).rewards.length,0);
  assert.equal(rollBreakableLoot(data,stats,'box',1,1,()=>0).rewards.length,0);
});

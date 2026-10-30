import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {EquipmentCrafting,CraftingError,parseCrafting} from '../src/domain/crafting.ts';
import {BattleCharacter,type CharacterStatsCatalog} from '../src/domain/character-stats.ts';
import {Session} from '../src/domain/session.ts';
import type {ItemCatalog} from '../src/domain/items.ts';
import type {Campaign} from '../src/domain/campaign.ts';

const read=<T>(file:string):T=>JSON.parse(readFileSync(new URL(`../public/content/${file}.json`,import.meta.url),'utf8'));
const items=read<ItemCatalog>('items'),stats=read<CharacterStatsCatalog>('character-stats'),campaign=read<Campaign>('campaign');
const craftingCatalog=parseCrafting(read('crafting'));
function fixture(){
  const hero=new BattleCharacter('dark-knight',stats,items),session=new Session(campaign,undefined,undefined,items,hero);
  session.gainMoney(100000);
  return {hero,session,crafting:new EquipmentCrafting(session,craftingCatalog)};
}
const notice=(expected:string)=>(error:unknown)=>error instanceof CraftingError&&error.notice===expected;

test('recipe list hides book recipes until learned and always shows potion and jewel recipes',()=>{
  const {hero,crafting}=fixture();
  let ids=crafting.availableRecipes().map(entry=>entry.id);
  assert.ok(ids.includes('mix-healing-potion-s'));assert.ok(ids.includes('mix-chaos-jewel'));
  assert.ok(!ids.includes('craft-angurvadel'));
  const state=hero.bag.captureState();state.recipes=[...state.recipes,'craft-angurvadel'];hero.bag.restoreState(state);
  ids=crafting.availableRecipes().map(entry=>entry.id);
  assert.ok(ids.includes('craft-angurvadel'));
});

test('book recipe rejects before learning, then charges materials and money once',()=>{
  const {hero,session,crafting}=fixture(),bag=hero.bag,recipe=items.recipes['craft-angurvadel'];
  assert.throws(()=>crafting.recipeQuote('craft-angurvadel'),notice('craft-recipe'));
  const state=bag.captureState();state.recipes=[...state.recipes,'craft-angurvadel'];bag.restoreState(state);
  for(const material of recipe.materials)bag.add(material.item,material.quantity);
  const before=bag.counts,money=session.money;
  crafting.recipeCommit(crafting.recipeQuote('craft-angurvadel'));
  assert.equal(bag.count(recipe.result),1);
  for(const material of recipe.materials)assert.equal(bag.count(material.item),before.get(material.item)!-material.quantity);
  assert.equal(session.money,money-recipe.cost);
});

test('always-available potion recipe works without learning and consumes lower potions',()=>{
  const {hero,session,crafting}=fixture(),bag=hero.bag,recipe=items.recipes['mix-life-potion-m'];
  for(const material of recipe.materials)bag.add(material.item,material.quantity);
  const money=session.money;
  crafting.recipeCommit(crafting.recipeQuote('mix-life-potion-m'));
  assert.equal(bag.count('life-potion-m'),1);
  assert.equal(bag.count('healing-potion-m'),0);assert.equal(bag.count('fruit-of-cause'),0);
  assert.equal(session.money,money-recipe.cost);
});

test('missing materials, missing money and stale quotes leave the bag untouched',()=>{
  const {hero,session,crafting}=fixture(),bag=hero.bag,recipe=items.recipes['mix-healing-potion-s'];
  assert.throws(()=>crafting.recipeQuote('mix-healing-potion-s'),notice('craft-materials'));
  bag.add('leaf-of-life',recipe.materials[0].quantity);
  session.spendMoney(session.money);
  assert.throws(()=>crafting.recipeQuote('mix-healing-potion-s'),notice('craft-money'));
  session.gainMoney(10);
  const quote=crafting.recipeQuote('mix-healing-potion-s');
  bag.add('leaf-of-life',1);
  const snapshot=session.captureState();
  assert.throws(()=>crafting.recipeCommit(quote),notice('craft-target'));
  assert.deepEqual(session.captureState(),snapshot);
});

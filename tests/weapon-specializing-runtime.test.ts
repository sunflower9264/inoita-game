import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import test from 'node:test';
import type {BattleCatalog,ResolvedBasicAttack} from '../src/domain/battle.ts';
import type {ActorDefinition} from '../src/domain/content.ts';
import type {ItemCatalog} from '../src/domain/items.ts';
import type {WardrobeCatalog} from '../src/domain/wardrobe.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import {resolveBasicAttack} from '../src/domain/basic-attack.ts';
const hook=registerHooks({resolve(specifier,context,next){return specifier==='phaser'
  ?{url:'data:text/javascript,export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}}}',shortCircuit:true}:next(specifier,context);}});
const {WorldCombat}=await import('../src/scenes/world-combat.ts');hook.deregister();
const read=(file:string)=>JSON.parse(readFileSync(new URL(`../public/content/${file}.json`,import.meta.url),'utf8'));
const catalog=read('battle') as BattleCatalog,items=read('items') as ItemCatalog,wardrobe=read('wardrobe') as WardrobeCatalog;
const method=(name:string)=>Reflect.get(WorldCombat.prototype,name);
function fixture(){
  const equipment:Record<string,string>={};
  let bagRevision=0;
  const equip=(slot:string,kind:string)=>{bagRevision++;equipment[slot]=Object.keys(items.items).find(key=>items.items[key].kind===kind&&items.items[key].equipment)!;assert.ok(equipment[slot],kind);};
  equip('main-hand','longsword');equip('off-hand','dagger');equip('body','leather');
  let heroRank=1,allyRank=8;
  const configuration=(rank:()=>number)=>({get version(){return rank();},draft:()=>({levels:{'weapon-specializing':rank()}})});
  const member=(rank:()=>number)=>({classId:'warrior',level:10,panel:{physicalAttack:100,magicAttack:50,maxHealth:1000,maxMana:100},
    player:{health:500,maxHealth:1000,mana:100,maxMana:100},skills:configuration(rank),
    bag:{get revision(){return bagRevision;},equipmentFor:()=>equipment,get:()=>undefined,equipmentItems:(keys:Record<string,string>)=>keys}});
  const hero=member(()=>heroRank),ally=member(()=>allyRank),conditions=new CombatConditions();
  const host=Object.setPrototypeOf({hero,conditions,arena:[],passivesCache:new Map(),skillTableCache:new Map(),
    equipmentEffectsCache:new Map(),aiSkillCostCache:new Map(),
    app:{battleCatalog:catalog,items,wardrobe,
    session:{skills:configuration(()=>heroRank),party:{groupModifiers:()=>({})}}},memberOf:(id:string)=>id==='player'?hero:ally},WorldCombat.prototype);
  const call=(name:string,...args:unknown[])=>method(name).call(host,...args);
  const attribute=(key:string,id='player')=>call('actorAttribute',id,key) as number;
  const stances=wardrobe.stances['longsword:dagger'];
  const actor={id:'warrior',clips:Object.fromEntries(Object.entries(stances).map(([name,key])=>[name,{frames:wardrobe.poses[key!].frames.length}]))} as unknown as ActorDefinition;
  const normal=resolveBasicAttack({basicAttacks:{normal:wardrobe.attacks['longsword:dagger']}},
    {actor,basicAttack:{profileId:'normal',clips:{north:'attack-north',south:'attack-south',east:'attack-east',west:'attack-west'}}});
  const select=()=>call('selectBasicAttack','player',actor,normal) as ResolvedBasicAttack;
  return {host,hero,ally,conditions,equipment,equip,attribute,call,select,normal,
    learn:(rank:number)=>{heroRank=rank;},learnAlly:(rank:number)=>{allyRank=rank;}};
}

test('all learned ranks add the exact offhand chance to current weapon and armor contributions',()=>{
  const f=fixture();
  for(const [index,bonus] of [61,101,161,241,261,281,301,321].entries()){
    f.learn(index+1);assert.equal(f.attribute('offhandAttackChance'),190+bonus);
  }
  f.learn(0);assert.equal(f.attribute('offhandAttackChance'),190);
  f.learn(1);f.equip('off-hand','axe');f.equip('body','plate');assert.equal(f.attribute('offhandAttackChance'),151);
});

test('the strict dual-wield roll retains the hidden one-point increment and re-reads the current learned rank',t=>{
  const f=fixture();t.mock.method(Math,'random',()=>(250-.5)/999);
  assert.deepEqual(f.select().strikes,[{frame:2,hand:'main-hand'},{frame:5,hand:'offhand'}]);
  t.mock.method(Math,'random',()=>(251-.5)/999);assert.equal(f.select(),f.normal);
  f.learn(2);assert.ok(f.select().strikes);
  f.learn(0);assert.equal(f.select(),f.normal);
});

test('the passive stacks with Storm of Frenzy without bypassing actual offhand equipment eligibility',t=>{
  const f=fixture(),unit=catalog.skills['storm-of-frenzy'].action!.combatUnits![0];
  assert.equal(unit.effect,'buff');if(unit.effect!=='buff')throw new Error('missing parent');
  f.conditions.applyBuff('player',unit.buff,unit.ranks[0].strength,unit.ranks[0].effect);
  assert.equal(f.attribute('offhandAttackChance'),401);
  let rolls=0;t.mock.method(Math,'random',()=>{rolls++;return 0;});assert.ok(f.select().strikes);assert.equal(rolls,1);
  delete f.equipment['off-hand'];assert.equal(f.select(),f.normal);assert.equal(rolls,1);
});

test('two-handed damage uses the exact main-hand class and stays separate from the unconditional offhand stat',()=>{
  const f=fixture();delete f.equipment['off-hand'];f.equip('body','plate');
  for(const kind of ['longsword','dagger','axe','mace','staff','bow','crossbow','two-handed']){
    f.equip('main-hand',kind);assert.equal(f.attribute('physicalDamageRate'),kind==='two-handed'?30:0,kind);
    assert.equal(f.attribute('offhandAttackChance'),61,kind);assert.equal(f.attribute('magicDamageRate'),0,kind);
  }
  f.learn(8);assert.equal(f.attribute('physicalDamageRate'),160);
});

test('each party member reads its own learned rank and another class does not acquire warrior passives',()=>{
  const f=fixture();assert.equal(f.attribute('offhandAttackChance','player'),251);
  // 原式 trunc((400+(1+20*12)*10)/10)=281，加装备 190。
  assert.equal(f.attribute('offhandAttackChance','ally'),471);
  f.learnAlly(0);assert.equal(f.attribute('offhandAttackChance','ally'),190);
  f.ally.classId='priest';f.learnAlly(8);assert.equal(f.attribute('offhandAttackChance','ally'),0);
});

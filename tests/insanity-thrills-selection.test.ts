import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import test from 'node:test';
import type {BattleCatalog,BasicAttackSelection,ResolvedBasicAttack} from '../src/domain/battle.ts';
import type {ActorDefinition,WorldIndex} from '../src/domain/content.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import {FrenzyAnimationMemory} from '../src/domain/frenzy-animation.ts';
import type {ItemCatalog} from '../src/domain/items.ts';
import type {WardrobeCatalog} from '../src/domain/wardrobe.ts';
import {Session} from '../src/domain/session.ts';
const hook=registerHooks({resolve(specifier,context,next){return specifier==='phaser'
  ?{url:'data:text/javascript,export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}}}',shortCircuit:true}:next(specifier,context);}});
const {WorldCombat}=await import('../src/scenes/world-combat.ts');hook.deregister();
const read=(name:string)=>JSON.parse(readFileSync(new URL(`../public/content/${name}.json`,import.meta.url),'utf8'));
const catalog=read('battle') as BattleCatalog,items=read('items') as ItemCatalog,wardrobe=read('wardrobe') as WardrobeCatalog;
const actor=Object.values((read('world') as WorldIndex).actors).find(actor=>actor.clips['frenzy-blade-south'])!;
const method=(name:string)=>Reflect.get(WorldCombat.prototype,name);
function fixture(memory=new FrenzyAnimationMemory()){
  let rank=1;
  const equipment:Record<string,string>={},allyEquipment:Record<string,string>={};
  const equip=(kind:string,slot='main-hand',target=equipment)=>{
    target[slot]=Object.keys(items.items).find(id=>items.items[id].kind===kind&&items.items[id].equipment)!;
    assert.ok(target[slot]);
  };
  equip('longsword');
  const skills={draft:()=>({levels:{'insanity-thrills':rank}})};
  const member=(gear:Record<string,string>)=>({classId:'warrior',level:10,panel:{},
    player:{health:100,maxHealth:100,mana:100,maxMana:100},skills,
    bag:{equipmentFor:()=>gear,equipmentItems:(gear:Record<string,string>)=>gear,get:()=>undefined}});
  const hero=member(equipment),ally=member(allyEquipment),conditions=new CombatConditions();
  const host=Object.setPrototypeOf({hero,conditions,arena:[],partyControllers:new Map(),
    app:{battleCatalog:catalog,items,wardrobe,session:{skills,frenzyAnimations:memory,party:{groupModifiers:()=>({})}}},
    memberOf:(id:string)=>id==='player'?hero:id==='ally'?ally:undefined},WorldCombat.prototype);
  const call=(name:string,...args:unknown[])=>method(name).call(host,...args);
  const normal=call('equipmentAttack',actor) as ResolvedBasicAttack;
  const select=(id='player',appearance:ActorDefinition=actor)=>call('selectBasicAttack',id,appearance,normal) as BasicAttackSelection;
  return {host,equipment,allyEquipment,equip,normal,select,call,conditions,memory,learn:(value:number)=>{rank=value;}};
}
function attack(value:BasicAttackSelection):ResolvedBasicAttack {assert.ok(!('kind' in value));return value;}

test('all eight learned frenzy ranks use a strict current threshold and real fixed weapon poses',t=>{
  const f=fixture();let roll=1,rolls=0;t.mock.method(Math,'random',()=>{rolls++;return (roll-.5)/999;});
  for(const [index,chance]of [170,230,270,290,310,330,350,370].entries()){
    f.learn(index+1);assert.equal(f.call('actorAttribute','player','frenzyAttackChance'),chance);
    for(const [kind,frames,strike]of [['longsword',8,4],['axe',8,4],['mace',8,4],['two-handed',12,4],['dagger',5,2],['staff',8,7]] as const){
      f.equip(kind);roll=chance;const before=rolls;assert.equal(f.select(),f.normal);assert.equal(rolls,before+1);
      roll=chance-1;const selected=attack(f.select());assert.equal(selected.cycleFrames,frames);assert.equal(selected.effectiveCycleFrames,frames);assert.equal(selected.strikeFrame,strike);
      assert.equal(selected.timing,'fixed-animation');
    }
  }
  f.learn(0);const before=rolls;assert.equal(f.select(),f.normal);assert.equal(rolls,before);
  f.conditions.setTemporaryAttribute('player','frenzyAttackChance',1000);roll=999;assert.notEqual(f.select(),f.normal);
});

test('dual-wield success skips frenzy reads and failure reaches two chance reads around its own roll',t=>{
  const f=fixture();f.equip('dagger','off-hand');let roll=1;
  const order:string[]=[];const attribute=f.host.actorAttribute.bind(f.host);
  f.host.actorAttribute=(id:string,key:string)=>{order.push(key);return attribute(id,key);};
  t.mock.method(Math,'random',()=>{order.push('roll');return (roll-.5)/999;});
  const dual=attack(f.select());assert.ok(dual.strikes);assert.deepEqual(order,['roll','offhandAttackChance']);
  assert.deepEqual(f.memory.captureState(),[]);
  order.length=0;roll=150;const frenzy=attack(f.select());assert.equal(frenzy.timing,'fixed-animation');
  assert.deepEqual(order,['roll','offhandAttackChance','frenzyAttackChance','roll','frenzyAttackChance']);
  delete f.equipment['off-hand'];order.length=0;
  t.mock.method(Math,'random',()=>{order.push('roll');f.conditions.setTemporaryAttribute('player','frenzyAttackChance',1);return 0;});
  assert.equal(f.select(),f.normal);assert.deepEqual(order,['frenzyAttackChance','roll','frenzyAttackChance']);
});

test('valid empty-hand shield waits retain intermediate equipment animation lengths only after the first frenzy',t=>{
  const f=fixture();t.mock.method(Math,'random',()=>0);
  f.equip('dagger');f.call('updateEquipment');
  delete f.equipment['main-hand'];f.equip('shield','off-hand');f.call('updateEquipment');
  assert.deepEqual(f.select(),{kind:'animation-unavailable',durationFrames:128});
  for(const [kind,frames]of [['dagger',5],['two-handed',12],['staff',8]] as const){
    delete f.equipment['off-hand'];f.equip(kind);f.call('updateEquipment');
    // No intervening attack: changing equipment still updates the existing action's animation length.
    delete f.equipment['main-hand'];f.equip('shield','off-hand');f.call('updateEquipment');
    assert.deepEqual(f.select(),{kind:'animation-unavailable',durationFrames:frames});
  }
  f.equip('shield','off-hand',f.allyEquipment);
  assert.deepEqual(f.select('ally'),{kind:'animation-unavailable',durationFrames:128});
  const rebuilt=fixture(f.memory);delete rebuilt.equipment['main-hand'];rebuilt.equip('shield','off-hand');
  assert.deepEqual(rebuilt.select(),{kind:'animation-unavailable',durationFrames:8});
  f.memory.removeActor('player');assert.deepEqual(f.select(),{kind:'animation-unavailable',durationFrames:128});
});

test('session map changes and actor revival preserve the existing frenzy animation memory',()=>{
  const session=new Session(read('campaign'));
  session.frenzyAnimations.select('player',5,128);session.frenzyAnimations.select('ally',12,128);
  session.enterMap('first-map');session.enterMap('second-map');session.reviveCombatActor('player');
  assert.equal(session.frenzyAnimations.select('player',undefined,128),5);
  assert.equal(session.frenzyAnimations.select('ally',undefined,128),12);
});

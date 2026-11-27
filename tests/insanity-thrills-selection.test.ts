import assert from 'node:assert/strict';
import test from 'node:test';
import type {BasicAttackSelection,ResolvedBasicAttack} from '../src/domain/battle.ts';
import {BattleCharacter} from '../src/domain/character-stats.ts';
import type {ActorDefinition,WorldIndex} from '../src/domain/content.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import {FrenzyAnimationMemory} from '../src/domain/frenzy-animation.ts';
import {Session} from '../src/domain/session.ts';
import {
  createCombatTestHarness,
  createTestMember,
  loadBattleCatalog,
  loadCampaignCatalog,
  loadCharacterStatsCatalog,
  loadCompanionCatalog,
  loadContentCatalog,
  loadItemCatalog,
  loadWardrobeCatalog,
} from './support/combat-test-harness.ts';
import {createTestWorldCombat} from './support/world-combat-fixture.ts';

const catalog=loadBattleCatalog(),items=loadItemCatalog(),wardrobe=loadWardrobeCatalog();
const actor=Object.values(loadContentCatalog<WorldIndex>('world').actors).find(entry=>entry.clips['frenzy-blade-south'])!;

function fixture(memory=new FrenzyAnimationMemory()){
  let rank=1,revision=0;
  const equipment:Record<string,string>={},allyEquipment:Record<string,string>={};
  const equip=(kind:string,slot='main-hand',target=equipment)=>{
    target[slot]=Object.keys(items.items).find(id=>items.items[id].kind===kind&&items.items[id].equipment)!;
    revision++;
    assert.ok(target[slot]);
  };
  equip('longsword');
  const skills={get version(){return rank;},resetVersion:0,draft:()=>({levels:{'insanity-thrills':rank}})};
  const member=(id:string,gear:Record<string,string>)=>{
    const entry=createTestMember({
      id,classId:'warrior',level:10,health:100,maxHealth:100,mana:100,maxMana:100,
      bag:{get revision(){return revision;},equipmentFor:()=>gear,equipmentItems:eq=>eq,get:()=>undefined},
    });
    entry.skills=skills;
    return entry;
  };
  const hero=member('player',equipment),ally=member('ally',allyEquipment),conditions=new CombatConditions();
  const members=new Map([['player',hero],['ally',ally]]);
  const harness=createCombatTestHarness({
    battleCatalog:catalog,items,wardrobe,conditions,hero,members,frenzyAnimations:memory,
    sessionSkills:()=>skills as never,
    activeParty:()=>['player','ally'],
    withThreat:false,
  });
  const normal=harness.stats.equipmentAttack(actor);
  const select=(id='player',appearance:ActorDefinition=actor)=>harness.stats.selectBasicAttack(id,appearance,normal);
  return {harness,equipment,allyEquipment,equip,normal,select,conditions,memory,learn:(value:number)=>{rank=value;},
    get revision(){return revision;}};
}
function attack(value:BasicAttackSelection):ResolvedBasicAttack {assert.ok(!('kind' in value));return value;}

test('all eight learned frenzy ranks use a strict current threshold and real fixed weapon poses',t=>{
  const f=fixture();let roll=1,rolls=0;t.mock.method(Math,'random',()=>{rolls++;return (roll-.5)/999;});
  for(const [index,chance]of [170,230,270,290,310,330,350,370].entries()){
    f.learn(index+1);assert.equal(f.harness.stats.actorAttribute('player','frenzyAttackChance'),chance);
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
  const order:string[]=[];const attribute=f.harness.stats.actorAttribute.bind(f.harness.stats);
  f.harness.stats.actorAttribute=(id,key)=>{order.push(key);return attribute(id,key);};
  t.mock.method(Math,'random',()=>{order.push('roll');return (roll-.5)/999;});
  const dual=attack(f.select());assert.ok(dual.strikes);assert.deepEqual(order,['roll','offhandAttackChance']);
  assert.equal(f.memory.captureState().length,0);
  order.length=0;roll=150;const frenzy=attack(f.select());assert.equal(frenzy.timing,'fixed-animation');
  assert.deepEqual(order,['roll','offhandAttackChance','frenzyAttackChance','roll','frenzyAttackChance']);
  delete f.equipment['off-hand'];order.length=0;
  t.mock.method(Math,'random',()=>{order.push('roll');f.conditions.setTemporaryAttribute('player','frenzyAttackChance',1);return 0;});
  assert.equal(f.select(),f.normal);assert.deepEqual(order,['frenzyAttackChance','roll','frenzyAttackChance']);
});

test('valid empty-hand shield waits retain intermediate equipment animation lengths only after the first frenzy',async t=>{
  const campaign=loadCampaignCatalog(),characterStats=loadCharacterStatsCatalog(),companions=loadCompanionCatalog();
  const realHero=new BattleCharacter('warrior',characterStats,items);
  const session=new Session(campaign,undefined,undefined,items,realHero,catalog,characterStats,companions);
  const f=fixture(session.frenzyAnimations);
  t.mock.method(realHero.bag,'equipmentFor',()=>f.equipment);
  t.mock.method(realHero.bag,'equipmentItems',(eq:Record<string,string|undefined>)=>eq);
  const world=await createTestWorldCombat({
    hero:realHero,session,battleCatalog:catalog,items,wardrobe,characterStats,
  });
  try{
    t.mock.method(Math,'random',()=>0);
    f.equip('dagger');world.combat.updateEquipment();
    delete f.equipment['main-hand'];f.equip('shield','off-hand');world.combat.updateEquipment();
    assert.deepEqual(f.select(),{kind:'animation-unavailable',durationFrames:128});
    for(const [kind,frames]of [['dagger',5],['two-handed',12],['staff',8]] as const){
      delete f.equipment['off-hand'];f.equip(kind);world.combat.updateEquipment();
      // No intervening attack: changing equipment still updates the existing action's animation length.
      delete f.equipment['main-hand'];f.equip('shield','off-hand');world.combat.updateEquipment();
      assert.deepEqual(f.select(),{kind:'animation-unavailable',durationFrames:frames});
    }
    f.equip('shield','off-hand',f.allyEquipment);
    assert.deepEqual(f.select('ally'),{kind:'animation-unavailable',durationFrames:128});
    const rebuilt=fixture(f.memory);delete rebuilt.equipment['main-hand'];rebuilt.equip('shield','off-hand');
    assert.deepEqual(rebuilt.select(),{kind:'animation-unavailable',durationFrames:8});
    f.memory.removeActor('player');assert.deepEqual(f.select(),{kind:'animation-unavailable',durationFrames:128});
  }finally{
    world.combat.destroy();
  }
});

test('session map changes and actor revival preserve the existing frenzy animation memory',()=>{
  const session=new Session(loadCampaignCatalog());
  session.frenzyAnimations.select('player',5,128);session.frenzyAnimations.select('ally',12,128);
  session.enterMap('first-map');session.enterMap('second-map');session.reviveCombatActor('player');
  assert.equal(session.frenzyAnimations.select('player',undefined,128),5);
  assert.equal(session.frenzyAnimations.select('ally',undefined,128),12);
});

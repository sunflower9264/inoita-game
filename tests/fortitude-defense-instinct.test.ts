import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import test from 'node:test';
import type {BattleCatalog} from '../src/domain/battle.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import {CombatHitResolution} from '../src/domain/combat-hit-resolution.ts';
import type {AttackContact} from '../src/domain/combat.ts';
import type {PhysicalHit} from '../src/domain/physical-hit.ts';

const hook=registerHooks({resolve(specifier,context,next){return specifier==='phaser'
  ?{url:'data:text/javascript,export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}}}',shortCircuit:true}
  :next(specifier,context);}});
const {WorldCombat}=await import('../src/scenes/world-combat.ts');hook.deregister();
const catalog=JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')) as BattleCatalog;
const method=(name:string)=>Reflect.get(WorldCombat.prototype,name);
const chances=[60,80,100,130,140,150,160,170];

test('fortitude exports the defense cooldown-reset chance for every rank',()=>{
  const units=catalog.skills['fortitude'].passiveUnits!;
  assert.equal(units.length,1);
  assert.equal(units[0].attribute,'defenseCooldownResetChance');
  assert.equal(units[0].condition,'always');
  assert.deepEqual(units[0].ranks.map(rank=>'amount' in rank?rank.amount:null),chances);
});

const primary={strength:0,dexterity:0,vitality:0,intelligence:0,mentality:0};
const base={level:10,physicalAttack:100,magicAttack:0,baseDefense:0,defense:0,defenseRate:0,
  maxHealth:1000,maxMana:100,hitBase:100,hitBonus:0,evasionBase:0,evasionBonus:0,
  criticalRate:0,criticalResistance:0,criticalDamage:0,criticalDamageResistance:0,weaponBlock:0,shieldBlock:0,
  physicalResistance:0,physicalResistanceBonus:0,magicResistance:0,baseMagicResistance:0,attributes:primary};

function fixture(rank:number){
  const member=(id:string)=>({classId:'assassin',level:10,panel:{...structuredClone(base)},
    player:{health:1000,maxHealth:1000,mana:50,maxMana:100},
    skills:{draft:()=>({levels:id==='ally'?{fortitude:rank}:{}})},
    bag:{equipmentFor:()=>({}),get:()=>undefined,equipmentItems:()=>({})}});
  const members=new Map([['player',member('player')],['ally',member('ally')]]);
  const conditions=new CombatConditions(),reset:string[]=[];
  const controllers=new Map([['ally',{resetSkillCooldowns:()=>reset.push('ally')}]]);
  const host=Object.setPrototypeOf({hero:members.get('player'),conditions,hitResolution:new CombatHitResolution(),
    pendingDefeats:new Set<string>(),fallen:new Set<string>(),allies:[],arena:[],partyControllers:controllers,
    passivesCache:new Map(),skillTableCache:new Map(),equipmentEffectsCache:new Map(),
    aiSkillCostCache:new Map(),
    app:{battleCatalog:catalog,items:{items:{}},
      session:{skills:{draft:()=>({levels:{}})},party:{activeIds:['player','ally'],controlledId:'player',groupModifiers:()=>({})},
        cooldowns:{resetActor:(id:string)=>reset.push(`session:${id}`)}}},
    scene:{events:{emit:()=>{}}},memberOf:(id:string)=>members.get(id),visualOf:()=>undefined,
    reactToBuff:()=>{},threat:undefined,
  },WorldCombat.prototype);
  const call=(name:string,...args:unknown[])=>method(name).call(host,...args);
  const contact:AttackContact={casterId:'player',targetId:'ally'} as AttackContact;
  const strike=(kind:PhysicalHit['kind'],damageKind:'physical'|'magic'='physical')=>
    call('resolveHitReactions',contact,{kind,damage:0} as PhysicalHit,damageKind,'probe',host.hero);
  return {reset,strike,attribute:()=>call('actorAttribute','ally','defenseCooldownResetChance')};
}

test('a physical miss or weapon block rolls the learned chance and clears that defender’s cooldowns',t=>{
  const f=fixture(8);
  assert.equal(f.attribute(),160,'the learned passive feeds the attribute pipeline');
  t.mock.method(Math,'random',()=>0);
  for(const kind of ['miss','weapon-block'] as const){
    f.reset.length=0;f.strike(kind);
    assert.deepEqual(f.reset,['ally'],`${kind} must reset the defender's skill cooldowns`);
  }
});

test('shield blocks, ordinary hits and magic never trigger the defense reaction',t=>{
  const f=fixture(8);
  t.mock.method(Math,'random',()=>0);
  for(const [kind,damageKind] of [['shield-block','physical'],['hit','physical'],['critical','physical'],['miss','magic']] as const){
    f.reset.length=0;f.strike(kind,damageKind);
    assert.deepEqual(f.reset,[],`${damageKind} ${kind} must not reset cooldowns`);
  }
});

test('the threshold is drawn strictly and an unlearned passive never draws',t=>{
  t.mock.method(Math,'random',()=>0);
  const none=fixture(0);
  assert.equal(none.attribute(),0);
  const draws:{count:number}[]=[{count:0}];
  t.mock.method(Math,'random',()=>{draws[0].count+=1;return 0;});
  none.strike('miss');
  assert.equal(draws[0].count,0,'a zero threshold must not draw at all');
  t.mock.restoreAll();

  // 原表 u03 八级 b=12；(b+4)*10 = 160。
  const f=fixture(8),threshold=160;
  t.mock.method(Math,'random',()=>(threshold-.5)/999);
  f.strike('miss');
  assert.deepEqual(f.reset,[],'an equal threshold fails, matching the native strict comparison');
  t.mock.method(Math,'random',()=>(threshold-1-.5)/999);
  f.strike('miss');
  assert.deepEqual(f.reset,['ally']);
});

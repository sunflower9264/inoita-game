import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import test from 'node:test';
import type {BattleBuffEffect,BattleCatalog} from '../src/domain/battle.ts';
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

type CounterUnit={ranks:{effect:BattleBuffEffect}[]};
const unit=catalog.skills['blade-deflection'].action!.combatUnits![0] as unknown as CounterUnit;

test('blade deflection exports the weapon-block counter and its weaken child on every rank',()=>{
  assert.equal(unit.ranks.length,8);
  unit.ranks.forEach((rank,index)=>{
    assert.deepEqual(rank.effect.simulationFrames,{lastActiveFrame:45},'the parent buff runs 45 frames');
    const reaction=rank.effect.reactions?.[0];
    assert.equal(reaction?.kind,'weapon-block-counter');
    assert.ok(reaction&&'buff' in reaction);
    const child=reaction.buff;
    assert.equal(child.key,'blade-deflection-weaken');
    assert.equal(child.rankPriority,[2002,2004,2006,2009,2010,2011,2012,2013][index],'the child preserves native strength ordering');
    assert.deepEqual(child.effect.simulationFrames,{lastActiveFrame:75});
    assert.equal(child.effect.durationMs,4560);
    assert.deepEqual(child.effect.modifiers,[
      {attribute:'physicalAttack',operation:{kind:'multiply-thousandth',ratePerThousand:300}},
      {attribute:'magicAttack',operation:{kind:'multiply-thousandth',ratePerThousand:300}},
    ]);
  });
});

const primary={strength:0,dexterity:0,vitality:0,intelligence:0,mentality:0};
const base={level:10,physicalAttack:100,magicAttack:0,baseDefense:0,defense:0,defenseRate:0,
  maxHealth:1000,maxMana:100,hitBase:100,hitBonus:0,evasionBase:0,evasionBonus:0,
  criticalRate:0,criticalResistance:0,criticalDamage:0,criticalDamageResistance:0,weaponBlock:0,shieldBlock:0,
  physicalResistance:0,physicalResistanceBonus:0,magicResistance:0,baseMagicResistance:0,attributes:primary};

function fixture(){
  const member=()=>({classId:'assassin',level:10,panel:{...structuredClone(base)},
    player:{health:1000,maxHealth:1000,mana:50,maxMana:100},
    skills:{draft:()=>({levels:{}})},bag:{equipmentFor:()=>({}),get:()=>undefined,equipmentItems:()=>({})}});
  const members=new Map([['player',member()],['ally',member()]]);
  const conditions=new CombatConditions(),applied:{targetId:string;key:string;sourceId:string}[]=[];
  const host=Object.setPrototypeOf({hero:members.get('player'),conditions,hitResolution:new CombatHitResolution(),
    pendingDefeats:new Set<string>(),fallen:new Set<string>(),allies:[],arena:[],
    passivesCache:new Map(),skillTableCache:new Map(),equipmentEffectsCache:new Map(),
    aiSkillCostCache:new Map(),
    app:{battleCatalog:catalog,items:{items:{}},session:{skills:{draft:()=>({levels:{}})},
      party:{activeIds:['player','ally'],controlledId:'player',groupModifiers:()=>({})}}},
    scene:{events:{emit:()=>{}}},memberOf:(id:string)=>members.get(id),visualOf:()=>undefined,threat:undefined,
    applyActorBuff:(targetId:string,key:string,_priority:number,_effect:BattleBuffEffect,sourceId:string)=>{
      applied.push({targetId,key,sourceId});},
  },WorldCombat.prototype);
  const call=(name:string,...args:unknown[])=>method(name).call(host,...args);
  const contact:AttackContact={casterId:'player',targetId:'ally'} as AttackContact;
  const strike=(kind:PhysicalHit['kind'],damageKind:'physical'|'magic'='physical')=>
    call('resolveHitReactions',contact,{kind,damage:0} as PhysicalHit,damageKind,'probe',host.hero);
  const guard=()=>conditions.applyBuff('ally','blade-deflection',1,unit.ranks[0].effect,'ally');
  return {applied,strike,guard,clear:()=>conditions.removeBuff('ally','blade-deflection')};
}

test('a weapon block sends the weaken debuff to the attacker with the defender as its source',()=>{
  const f=fixture();f.guard();f.strike('weapon-block');
  assert.deepEqual(f.applied,[{targetId:'player',key:'blade-deflection-weaken',sourceId:'ally'}],
    'the counter targets the attacker and is sourced from the blocking defender');
});

test('misses, shield blocks, ordinary hits and magic never counter',()=>{
  const f=fixture();f.guard();
  for(const [kind,damageKind] of [['miss','physical'],['shield-block','physical'],['hit','physical'],['critical','physical'],['weapon-block','magic']] as const){
    f.applied.length=0;f.strike(kind,damageKind);
    assert.deepEqual(f.applied,[],`${damageKind} ${kind} must not counter`);
  }
});

test('the counter belongs to the active blade deflection buff',()=>{
  const f=fixture();f.guard();f.strike('weapon-block');
  assert.equal(f.applied.length,1);
  f.clear();f.applied.length=0;f.strike('weapon-block');
  assert.deepEqual(f.applied,[],'without the buff there is no counter debuff');
});

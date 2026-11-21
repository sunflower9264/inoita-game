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
const frameLifetimes=[90,120,150,195,210,225,240,255];

type BuffUnit={ranks:{effect:BattleBuffEffect}[]};
const unit=catalog.skills['spiritual-blade'].action!.combatUnits![0] as unknown as BuffUnit;

test('spiritual blade exports the mana reaction and frame lifetimes for every rank',()=>{
  assert.equal(unit.ranks.length,8);
  unit.ranks.forEach((rank,index)=>{
    assert.deepEqual(rank.effect.reactions,[{kind:'mana-on-physical-success',amount:4,effect:'mana-recovery'}]);
    assert.deepEqual(rank.effect.simulationFrames,{lastActiveFrame:frameLifetimes[index]});
    assert.equal(rank.effect.durationMs,(frameLifetimes[index]+1)*60);
    assert.deepEqual(rank.effect.modifiers,[],'the mana write is a reaction, not a numeric attribute');
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
    skills:{draft:()=>({levels:{}})},bag:{equipmentFor:()=>({}),get:()=>undefined}});
  const members=new Map([['player',member()],['ally',member()]]);
  const conditions=new CombatConditions(),restored:[string,number][]=[],played:[string,unknown[]][]=[];
  const host=Object.setPrototypeOf({hero:members.get('player'),conditions,hitResolution:new CombatHitResolution(),
    pendingDefeats:new Set<string>(),fallen:new Set<string>(),allies:[],
    passivesCache:new Map(),skillTableCache:new Map(),equipmentEffectsCache:new Map(),
    aiSkillCostCache:new Map(),
    arena:[],app:{battleCatalog:catalog,session:{skills:{draft:()=>({levels:{}})}},party:{activeIds:['player'],controlledId:'player'}},
    scene:{events:{emit:()=>{}}},memberOf:(id:string)=>members.get(id),partyPassives:()=>[],visualOf:()=>undefined,
    restoreMana:(id:string,amount:number)=>{restored.push([id,amount]);},
    presenterFor:()=>({showEffects:(id:string,effects:unknown[])=>{played.push([id,effects]);}}),
    react:()=>{},threat:undefined,
  },WorldCombat.prototype);
  const call=(name:string,...args:unknown[])=>method(name).call(host,...args);
  const contact:AttackContact={casterId:'player',targetId:'ally'} as AttackContact;
  const strike=(kind:PhysicalHit['kind'],damageKind:'physical'|'magic'='physical')=>
    call('resolveHitReactions',contact,{kind,damage:0} as PhysicalHit,damageKind,'probe',host.hero);
  const apply=()=>conditions.applyBuff('player','spiritual-blade',1,unit.ranks[0].effect,'player');
  return {conditions,restored,played,strike,apply,clear:()=>conditions.removeBuff('player','spiritual-blade')};
}

test('an active spiritual blade restores mana after every physical outcome, including a zero-damage block',()=>{
  const f=fixture();f.apply();
  for(const kind of ['hit','critical','weapon-block','shield-block'] as const){
    f.restored.length=0;f.played.length=0;f.strike(kind);
    assert.deepEqual(f.restored,[['player',4]],`${kind} must restore the caster's mana`);
    assert.deepEqual(f.played,[['player',[{effect:'mana-recovery',recipient:'target',placement:'attached'}]]],
      `${kind} must play the attached effect even when the pool is full`);
  }
});

test('a miss and a magic hit produce neither the restore nor the effect',()=>{
  const f=fixture();f.apply();
  f.strike('miss');
  f.strike('hit','magic');
  assert.deepEqual(f.restored,[]);
  assert.deepEqual(f.played,[]);
});

test('the reaction belongs to the active buff, so an expired spiritual blade stops restoring',()=>{
  const f=fixture();f.apply();f.strike('hit');
  assert.deepEqual(f.restored,[['player',4]]);
  f.clear();f.restored.length=0;f.strike('hit');
  assert.deepEqual(f.restored,[],'without the buff there is no mana write');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import type { SkillUnitHit } from '../src/domain/combat.ts';
import { CombatEffectExecutor, type CombatEffectPort } from '../src/domain/combat-effect-executor.ts';

interface Probe {
  mana:{ player:number; enemy:number };
  calls:string[];
}

/** `damageImmune` 对应原版状态 14；`debugInvincible` 对应 GM 调试无敌；`debugInfiniteMana` 对应 GM 调试无限蓝。 */
function probe(options:{damageImmune?:boolean;debugInvincible?:boolean;debugInfiniteMana?:boolean}):{executor:CombatEffectExecutor;state:Probe} {
  const state:Probe={mana:{player:50,enemy:0},calls:[]};
  const side=(id:string)=>id==='player';
  const port={
    conditions:{
      canReceiveDamage:()=>!options.damageImmune,
      canLoseHealth:()=>!options.damageImmune&&!options.debugInvincible,
      losesMana:()=>!options.debugInfiniteMana
    },
    random:()=>0,
    run:<T>(work:()=>T)=>work(),
    available:()=>true,
    partySide:side,
    fighter:()=>({}),
    position:()=>undefined,
    vitals:(id:string)=>({health:100,mana:state.mana[side(id)?'player':'enemy'],maxMana:100}),
    attribute:()=>0,
    valueSourceId:()=>'',
    prepare:()=>undefined,
    setMana:(id:string,value:number)=>{state.mana[side(id)?'player':'enemy']=value;state.calls.push(`mana:${id}:${value}`);},
    showHit:()=>state.calls.push('showHit'),
    hit:()=>state.calls.push('hit')
  } as unknown as CombatEffectPort;
  return {executor:new CombatEffectExecutor(port),state};
}

const hit=(unit:unknown):SkillUnitHit=>({
  casterId:'enemy',targetId:'player',cueIndex:0,
  skill:{id:'probe',action:{combatUnits:[unit],hitEffectStyle:'weapon'},level:1} as never,
  preparedDamage:{source:'magicAttack',weightedAddition:0,fixedAddition:10,operation:{kind:'add',amount:0}}
});

const drainUnit={effect:'drain',source:'magicAttack',ranks:[{}]};

test('GM infinite mana prevents a drain effect from consuming MP',()=>{
  const {executor,state}=probe({debugInfiniteMana:true});
  assert.equal(executor.execute(hit(drainUnit)),'success');
  assert.deepEqual(state.mana,{player:50,enemy:0});
  assert.deepEqual(state.calls,[]);
});

test('GM invincibility alone does not prevent a drain effect from consuming MP',()=>{
  const {executor,state}=probe({debugInvincible:true});
  assert.equal(executor.execute(hit(drainUnit)),'success');
  assert.deepEqual(state.mana,{player:40,enemy:10});
});

test('a normal target still loses MP to a drain effect',()=>{
  const {executor,state}=probe({});
  assert.equal(executor.execute(hit(drainUnit)),'success');
  assert.deepEqual(state.mana,{player:40,enemy:10});
});

test('GM invincibility still blocks physical damage',()=>{
  const {executor,state}=probe({debugInvincible:true});
  const outcome=executor.execute(hit({effect:'physical',source:'physicalAttack',ranks:[{}]}));
  assert.equal(outcome,'failure');
  assert.deepEqual(state.calls,['showHit']);
});

test('the native damage-immune state still rejects every hostile unit',()=>{
  const {executor,state}=probe({damageImmune:true});
  assert.equal(executor.execute(hit(drainUnit)),'failure');
  assert.deepEqual(state.calls,[]);
});

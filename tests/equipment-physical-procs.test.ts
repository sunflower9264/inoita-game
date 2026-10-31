import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import test from 'node:test';
import type {BattleCatalog} from '../src/domain/battle.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';

const hook=registerHooks({resolve(specifier,context,next){return specifier==='phaser'
  ?{url:'data:text/javascript,export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}}}',shortCircuit:true}
  :next(specifier,context);}});
const {WorldCombat}=await import('../src/scenes/world-combat.ts');hook.deregister();
const catalog=JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')) as BattleCatalog;

function fixture(){
  const conditions=new CombatConditions(),heals:{id:string;amount:number}[]=[],buffs:{targetId:string;key:string;sourceId:string}[]=[],order:string[]=[];
  const equipment={numbers:{modifiers:[] as {stat:string;value:number}[],gemModifiers:[]}};
  const allyEquipment={numbers:{modifiers:[] as {stat:string;value:number}[],gemModifiers:[]}};
  type GearNumbers={numbers:{modifiers:{stat:string;value:number}[];gemModifiers:{stat:string;value:number}[]}};
  const makeMember=(gears:GearNumbers)=>({classId:'dark-knight',level:10,
    bag:{equipmentFor:()=>({body:'armor'}),get:()=>gears},
    panel:{physicalAttack:100,magicAttack:0,maxHealth:1000,maxMana:0},player:{health:500,maxHealth:1000,maxMana:0}});
  const hero=makeMember(equipment),ally=makeMember(allyEquipment);
  const members=new Map([['player',hero],['ally',ally]]);
  const enemies=[{key:'enemy-0',definition:{acceptsBuffs:true},visual:{container:{active:true}}}];
  const host=Object.setPrototypeOf({
    hero,conditions,arena:enemies,app:{battleCatalog:catalog,session:{}},
    memberOf:(id:string)=>members.get(id),
    partyPassives:()=>[],applyStateConsequences:(_id:string,states:readonly string[])=>{for(const state of states)order.push(state);},
    applyActorBuff:(targetId:string,key:string,_priority:number,_effect:unknown,sourceId:string)=>{
      buffs.push({targetId,key,sourceId});order.push(key);return true;},
    restoreHealth:(id:string,amount:number)=>{heals.push({id,amount});order.push('heal');},
    readResourceCapacity:()=>1000,
  },WorldCombat.prototype);
  const call=(name:string,...args:unknown[])=>Reflect.get(WorldCombat.prototype,name).call(host,...args);
  return {conditions,equipment,allyEquipment,heals,buffs,order,call,
    event:{casterId:'player',targetId:'enemy-0'},
    hit:{kind:'hit' as const,damage:0}};
}

test('pendulum stuns with the native 45-frame lifetime and 1000 never rolls dice',(t)=>{
  t.mock.method(Math,'random',()=>{throw new Error('threshold 1000 must not roll');});
  const f=fixture();f.equipment.numbers.modifiers=[{stat:'pendulum',value:1000}];
  f.call('physicalSuccessEquipmentProcs',f.event,{kind:'weapon-block',damage:0});
  assert.equal(f.conditions.hasState('enemy-0','stun'),true);
});

test('pendulum chance zero does not roll and chance one never succeeds',(t)=>{
  const f=fixture();f.equipment.numbers.modifiers=[{stat:'pendulum',value:0}];
  t.mock.method(Math,'random',()=>{throw new Error('zero chance must not roll');});
  f.call('physicalSuccessEquipmentProcs',f.event,f.hit);
  assert.equal(f.conditions.hasState('enemy-0','stun'),false);
  t.mock.restoreAll();
  t.mock.method(Math,'random',()=>0);
  f.equipment.numbers.modifiers=[{stat:'pendulum',value:1}];
  f.call('physicalSuccessEquipmentProcs',f.event,f.hit);
  assert.equal(f.conditions.hasState('enemy-0','stun'),false);
});

test('frost retaliates on the attacker with attack-slow from the defender',(t)=>{
  t.mock.method(Math,'random',()=>0);
  const f=fixture();f.equipment.numbers.modifiers=[{stat:'frost',value:1000}];
  f.call('physicalSuccessEquipmentProcs',{casterId:'enemy-0',targetId:'player'},f.hit);
  assert.deepEqual(f.buffs,[{targetId:'enemy-0',key:'attack-slow',sourceId:'player'}]);
});

test('healing energy restores one fiftieth of the attacker maximum health',(t)=>{
  t.mock.method(Math,'random',()=>0);
  const f=fixture();f.equipment.numbers.modifiers=[{stat:'healingEnergy',value:1000}];
  f.call('physicalSuccessEquipmentProcs',f.event,f.hit);
  assert.deepEqual(f.heals,[{id:'player',amount:20}]);
});

test('physical success procs run in pendulum, frost, healing order on zero-damage blocks',(t)=>{
  t.mock.method(Math,'random',()=>{throw new Error('all three thresholds are 1000');});
  const f=fixture();
  f.equipment.numbers.modifiers=[{stat:'pendulum',value:1000},{stat:'healingEnergy',value:1000}];
  f.allyEquipment.numbers.modifiers=[{stat:'frost',value:1000}];
  f.call('physicalSuccessEquipmentProcs',{casterId:'player',targetId:'ally'},{kind:'weapon-block',damage:0});
  assert.deepEqual(f.order,['stun','attack-slow','heal']);
});

test('instant recovery heals the missed target without dice and ignores rates below one',(t)=>{
  t.mock.method(Math,'random',()=>{throw new Error('instant recovery must not roll');});
  const f=fixture();f.equipment.numbers.modifiers=[{stat:'instantRecovery',value:30}];
  f.call('instantRecoveryOnMiss',{casterId:'enemy-0',targetId:'player'});
  assert.deepEqual(f.heals,[{id:'player',amount:30}]);
  f.equipment.numbers.modifiers=[{stat:'instantRecovery',value:0}];
  f.call('instantRecoveryOnMiss',{casterId:'enemy-0',targetId:'player'});
  assert.equal(f.heals.length,1);
});

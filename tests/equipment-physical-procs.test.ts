import assert from 'node:assert/strict';
import test from 'node:test';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import type {ItemInstance} from '../src/domain/items.ts';
import {createCombatTestHarness,createTestEnemy,createTestMember,loadBattleCatalog} from './support/combat-test-harness.ts';

const catalog=loadBattleCatalog();

function fixture(){
  const conditions=new CombatConditions(),heals:{id:string;amount:number}[]=[],buffs:{targetId:string;key:string;sourceId:string}[]=[],order:string[]=[];
  const equipment={revision:0,numbers:{modifiers:[] as {stat:string;value:number}[],gemModifiers:[]}};
  const allyEquipment={revision:0,numbers:{modifiers:[] as {stat:string;value:number}[],gemModifiers:[]}};
  type GearNumbers={revision:number;numbers:{modifiers:{stat:string;value:number}[];gemModifiers:{stat:string;value:number}[]}};
  const makeMember=(id:string,gears:GearNumbers)=>createTestMember({
    id,classId:'dark-knight',level:10,health:500,maxHealth:1000,maxMana:0,
    panel:{physicalAttack:100,magicAttack:0,maxHealth:1000,maxMana:0},
    bag:{get revision(){return gears.revision;},equipmentFor:()=>({body:'armor'}),equipmentItems:()=>({}),get:()=>gears as unknown as ItemInstance},
  });
  const hero=makeMember('player',equipment),ally=makeMember('ally',allyEquipment);
  const members=new Map([['player',hero],['ally',ally]]);
  const enemies=new Map([['enemy-0',createTestEnemy({key:'enemy-0',definition:{...catalog.enemies[0],acceptsBuffs:true,stateRules:undefined}})]]);
  const harness=createCombatTestHarness({
    battleCatalog:catalog,conditions,hero,members,enemies,
    settlementOverrides:{
      onStateConsequences:(_id,states)=>{for(const state of states)order.push(state);},
    },
  });
  harness.stats.partyPassives=()=>[];
  harness.settlement.applyActorBuff=(targetId,key,_priority,_effect,sourceId)=>{
    buffs.push({targetId,key,sourceId});order.push(key);return true;
  };
  harness.settlement.restoreHealth=(id,amount)=>{heals.push({id,amount});order.push('heal');};
  harness.stats.readResourceCapacity=()=>1000;
  return {harness,conditions,equipment,allyEquipment,heals,buffs,order,
    event:{casterId:'player',targetId:'enemy-0'},
    hit:{kind:'hit' as const,damage:0}};
}

test('pendulum stuns with the native 45-frame lifetime and 1000 never rolls dice',(t)=>{
  t.mock.method(Math,'random',()=>{throw new Error('threshold 1000 must not roll');});
  const f=fixture();f.equipment.numbers.modifiers=[{stat:'pendulum',value:1000}];
  f.harness.settlement.physicalSuccessEquipmentProcs(f.event,{kind:'weapon-block',damage:0});
  assert.equal(f.conditions.hasState('enemy-0','stun'),true);
});

test('pendulum chance zero does not roll and chance one never succeeds',(t)=>{
  const f=fixture();f.equipment.numbers.modifiers=[{stat:'pendulum',value:0}];
  t.mock.method(Math,'random',()=>{throw new Error('zero chance must not roll');});
  f.harness.settlement.physicalSuccessEquipmentProcs(f.event,f.hit);
  assert.equal(f.conditions.hasState('enemy-0','stun'),false);
  t.mock.restoreAll();
  t.mock.method(Math,'random',()=>0);
  f.equipment.numbers.modifiers=[{stat:'pendulum',value:1}];f.equipment.revision++;
  f.harness.settlement.physicalSuccessEquipmentProcs(f.event,f.hit);
  assert.equal(f.conditions.hasState('enemy-0','stun'),false);
});

test('frost retaliates on the attacker with attack-slow from the defender',(t)=>{
  t.mock.method(Math,'random',()=>0);
  const f=fixture();f.equipment.numbers.modifiers=[{stat:'frost',value:1000}];
  f.harness.settlement.physicalSuccessEquipmentProcs({casterId:'enemy-0',targetId:'player'},f.hit);
  assert.deepEqual(f.buffs,[{targetId:'enemy-0',key:'attack-slow',sourceId:'player'}]);
});

test('healing energy restores one fiftieth of the attacker maximum health',(t)=>{
  t.mock.method(Math,'random',()=>0);
  const f=fixture();f.equipment.numbers.modifiers=[{stat:'healingEnergy',value:1000}];
  f.harness.settlement.physicalSuccessEquipmentProcs(f.event,f.hit);
  assert.deepEqual(f.heals,[{id:'player',amount:20}]);
});

test('physical success procs run in pendulum, frost, healing order on zero-damage blocks',(t)=>{
  t.mock.method(Math,'random',()=>{throw new Error('all three thresholds are 1000');});
  const f=fixture();
  f.equipment.numbers.modifiers=[{stat:'pendulum',value:1000},{stat:'healingEnergy',value:1000}];
  f.allyEquipment.numbers.modifiers=[{stat:'frost',value:1000}];
  f.harness.settlement.physicalSuccessEquipmentProcs({casterId:'player',targetId:'ally'},{kind:'weapon-block',damage:0});
  assert.deepEqual(f.order,['stun','attack-slow','heal']);
});

test('instant recovery heals the missed target without dice and ignores rates below one',(t)=>{
  t.mock.method(Math,'random',()=>{throw new Error('instant recovery must not roll');});
  const f=fixture();f.equipment.numbers.modifiers=[{stat:'instantRecovery',value:30}];
  f.harness.settlement.instantRecoveryOnMiss({casterId:'enemy-0',targetId:'player'});
  assert.deepEqual(f.heals,[{id:'player',amount:30}]);
  f.equipment.numbers.modifiers=[{stat:'instantRecovery',value:0}];f.equipment.revision++;
  f.harness.settlement.instantRecoveryOnMiss({casterId:'enemy-0',targetId:'player'});
  assert.equal(f.heals.length,1);
});

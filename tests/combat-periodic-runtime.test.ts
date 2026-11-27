import assert from 'node:assert/strict';
import test from 'node:test';
import type {CombatActorAttributes} from '../src/domain/combat-damage-source.ts';
import type {PeriodicTick} from '../src/domain/combat-conditions.ts';
import {createCombatTestHarness,createTestMember} from './support/combat-test-harness.ts';

const attributes:CombatActorAttributes={physicalAttack:100,magicAttack:80,maxHealth:1000,physicalDamageRate:500,
  magicDamageRate:1000,stealthDamageRate:0,primaryAttributes:{strength:0,dexterity:0,vitality:0,intelligence:20,mentality:25}};
function fixture(classId='warlock'){
  const commands:unknown[]=[];
  const members=new Map([['source',createTestMember({id:'source',classId})],['ally',createTestMember({id:'ally'})]]);
  const harness=createCombatTestHarness({
    members,activeParty:()=>['source','ally'],withThreat:false,
    settlementOverrides:{
      onShowEffects:(_actorId,id,effects)=>commands.push(['visual',id,effects]),
    },
  });
  harness.stats.actorAttributes=(id:string)=>id==='source'?attributes:undefined;
  harness.stats.actorAttribute=(id:string,key:string):number=>key==='healingPowerRate'?id==='target'?500:1000:key==='lifeFeastRate'?0:160;
  harness.settlement.restoreHealth=(id:string,amount:number)=>commands.push(['heal',id,amount]);
  harness.settlement.settleHit=(_event,hit)=>commands.push(['damage',hit.damage]);
  const run=(effect:PeriodicTick['effect'],buffId:PeriodicTick['buffId']='blood-curse',stackCount=1)=>
    harness.settlement.periodicTick({sourceId:'source',targetId:'target',buffId,stackCount,effect});
  return {harness,commands,run};
}
test('periodic curse heals its own source before damaging and applies stack operands',()=>{
  const {commands,run}=fixture();
  run({kind:'magic-curse',ratePerThousand:200},'blood-curse',2);
  assert.deepEqual(commands,[['heal','source',52],['damage',52]]);
});
test('periodic normal damage chooses the source class instead of party membership',()=>{
  for(const [classId,expected] of [['warlock',160],['priest',160],['dark-knight',150]] as const){
    const {commands,run}=fixture(classId);run({kind:'normal-damage',operation:{kind:'keep'}});
    assert.deepEqual(commands,[['damage',expected]]);
  }
});
test('light command reads the recipient healing rate and caster mentality',()=>{
  const {commands,run}=fixture();
  run({kind:'healing',attribute:'bestNormalDamage',operation:{kind:'multiply-thousandth',ratePerThousand:500}},'light-command');
  assert.deepEqual(commands,[['heal','target',41]]);
});
test('source-independent visuals continue when the source actor is no longer available',()=>{
  const {harness,commands,run}=fixture();harness.stats.actorAttributes=()=>undefined;
  run({kind:'visual',effect:'life-drain'});
  run({kind:'magic-curse',ratePerThousand:100});
  assert.equal(commands.length,1);assert.equal((commands[0] as string[])[0],'visual');
});

test('periodic healing multiplies a zero recipient rate instead of skipping it like ordinary healing',()=>{
  const {harness,commands,run}=fixture();
  harness.stats.actorAttribute=(_id:string,key:string)=>key==='healingPowerRate'?0:160;
  run({kind:'healing',attribute:'bestNormalDamage',operation:{kind:'keep'}},'fire-offering');
  assert.equal(commands.length,0);
});

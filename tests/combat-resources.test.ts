import test from 'node:test';
import assert from 'node:assert/strict';
import {calculateManaCost,CombatResourceRecovery,defaultResourceAttributes,RESOURCE_RECOVERY_INTERVAL_MS,type ResourceRecoveryActor} from '../src/domain/combat-resources.ts';

const actor=(actorId:string,values:Partial<ResourceRecoveryActor>={}):ResourceRecoveryActor=>({
  actorId,alive:true,level:1,healthRecoveryPerPulse:99,manaRecoveryPerPulse:8,...values,
});

test('member recovery uses its own level formula while monster defaults keep native zero health and mana cost',()=>{
  for(const [level,health] of [[1,99],[2,103],[10,132],[50,276],[110,492]]){
    assert.deepEqual(defaultResourceAttributes('member',level),{
      healthRecoveryPerPulse:health,manaRecoveryPerPulse:8,manaCostRate:1000,manaCostReductionRate:0,
    });
    assert.deepEqual(defaultResourceAttributes('monster',level),{
      healthRecoveryPerPulse:0,manaRecoveryPerPulse:8,manaCostRate:0,manaCostReductionRate:0,
    });
  }
  const defaults=defaultResourceAttributes('member',1);defaults.manaRecoveryPerPulse=999;
  assert.equal(defaultResourceAttributes('member',1).manaRecoveryPerPulse,8);
});

test('mana cost applies the difference of native thousandth rates and truncates once toward zero',()=>{
  assert.equal(calculateManaCost(37,1000,0),37);
  assert.equal(calculateManaCost(37,1400,0),51);
  assert.equal(calculateManaCost(37,1400,350),38);
  assert.equal(calculateManaCost(7,500,700),-1);
  assert.equal(calculateManaCost(1,500,700),0);
  assert.equal(calculateManaCost(100,0,0),0);
});

test('recovery first fires strictly after the native 30-frame deadline and repeats every 31 frames',()=>{
  const clock=new CombatResourceRecovery(),actors=[actor('player')];
  assert.equal(RESOURCE_RECOVERY_INTERVAL_MS,1860);
  assert.equal(clock.millisecondsUntilNextPulse,1860);
  assert.deepEqual(clock.advance(1800,actors),[]);
  assert.equal(clock.millisecondsUntilNextPulse,60);
  assert.deepEqual(clock.advance(59,actors),[]);
  assert.equal(clock.millisecondsUntilNextPulse,1);
  assert.deepEqual(clock.advance(1,actors),[{atMs:1860,amounts:[{actorId:'player',healthAmount:99,manaAmount:8}]}]);
  assert.equal(clock.millisecondsUntilNextPulse,1860);
  assert.deepEqual(clock.advance(1859,actors),[]);
  assert.equal(clock.advance(1,actors)[0].atMs,3720);
});

test('every living actor uses its own recovery values and emergency recovery adds three times its own level',()=>{
  const clock=new CombatResourceRecovery();
  const actors=[actor('player'),actor('ally',{level:20,healthRecoveryPerPulse:168,manaRecoveryPerPulse:16}),
    actor('monster',{level:7,healthRecoveryPerPulse:3,manaRecoveryPerPulse:2,emergencyRecovery:true}),
    actor('dead',{alive:false,emergencyRecovery:true})];
  assert.deepEqual(clock.advance(1860,actors)[0].amounts,[
    {actorId:'player',healthAmount:99,manaAmount:8},
    {actorId:'ally',healthAmount:168,manaAmount:16},
    {actorId:'monster',healthAmount:24,manaAmount:2},
  ]);
});

test('large deltas emit each crossed pulse and preserve the same phase as smaller updates',()=>{
  const single=new CombatResourceRecovery(),chunked=new CombatResourceRecovery(),actors=[actor('ally')];
  const expected=single.advance(1860*100+777,actors);
  const actual=[];
  for(let i=0;i<186;i++)actual.push(...chunked.advance(1000,actors));
  actual.push(...chunked.advance(777,actors));
  assert.equal(expected.length,100);
  assert.deepEqual(actual,expected);
  assert.deepEqual(chunked.captureState(),single.captureState());
  assert.equal(single.advance(1083,actors)[0].atMs,1860*101);
});

test('capture and restore retain a partially elapsed deadline across actor changes',()=>{
  const clock=new CombatResourceRecovery();
  clock.advance(2100,[actor('player')]);
  const saved=clock.captureState();
  const restored=new CombatResourceRecovery();restored.restoreState(saved);
  assert.equal(restored.millisecondsUntilNextPulse,1620);
  saved.deadlineTick=999;
  assert.deepEqual(restored.advance(1619,[actor('new-ally')]),[]);
  assert.deepEqual(restored.advance(1,[actor('new-ally',{healthRecoveryPerPulse:12,manaRecoveryPerPulse:3})]),[
    {atMs:3720,amounts:[{actorId:'new-ally',healthAmount:12,manaAmount:3}]},
  ]);
});

test('empty rosters still advance the shared phase and paused updates produce no pulses',()=>{
  const clock=new CombatResourceRecovery();
  assert.deepEqual(clock.advance(2000,[]),[{atMs:1860,amounts:[]}]);
  const saved=clock.captureState();
  for(const delta of [0,-1,NaN,Infinity])assert.deepEqual(clock.advance(delta,[actor('player')]),[]);
  assert.deepEqual(clock.captureState(),saved);
  assert.equal(clock.advance(1720,[actor('player')])[0].atMs,3720);
});

test('pulse due check matches the 30-frame deadline without building recovery inputs',()=>{
  const clock=new CombatResourceRecovery();
  assert.equal(clock.pulseDueAtFrame(30),false);
  assert.equal(clock.pulseDueAtFrame(31),true);
  clock.advanceToFrame(31,[actor('player')]);
  assert.equal(clock.pulseDueAtFrame(32),false);
  assert.equal(clock.pulseDueAtFrame(61),false);
  assert.equal(clock.pulseDueAtFrame(62),true);
});

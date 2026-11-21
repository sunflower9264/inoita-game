import assert from 'node:assert/strict';
import test from 'node:test';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import {resolveHitReactionPipeline,resolveHolySacrifice,type HitReactionPort} from '../src/domain/combat-reaction-pipeline.ts';
import type {AttackContact} from '../src/domain/combat.ts';

test('Holy Sacrifice computes damage and eligibility without a scene',()=>{
  const guard={id:'guard',fallen:false,pendingDefeat:false,canLoseHealth:true,physicalResistance:277,magicResistance:-1000};
  const run=(damage:number,kind:'physical'|'magic',overrides:Partial<typeof guard>={})=>
    resolveHolySacrifice(damage,kind,275,()=>({...guard,...overrides}));
  assert.deepEqual(run(100,'physical'),{victimDamage:73,protectorId:'guard',protectorDamage:19});
  assert.deepEqual(run(100,'magic'),{victimDamage:73,protectorId:'guard',protectorDamage:54});
  assert.equal(run(1,'physical'),undefined);
  assert.equal(run(1,'magic')?.protectorDamage,0);
  assert.equal(run(100,'magic',{pendingDefeat:true}),undefined);
  assert.equal(run(100,'magic',{fallen:true}),undefined);
  assert.deepEqual(run(100,'magic',{canLoseHealth:false}),{victimDamage:73,protectorId:'guard',protectorDamage:0});
  assert.equal(resolveHolySacrifice(100,'physical',1000,()=>guard),undefined);
});

const event:AttackContact={casterId:'attacker',targetId:'target'};
const port=(overrides:Partial<HitReactionPort>={}):HitReactionPort=>({
  conditions:new CombatConditions(),actorAttribute:()=>0,
  react:()=>{},reactToBuff:()=>{},lightningOfHellReaction:()=>{},godOfJusticeReaction:()=>{},
  summonOwnerReactions:()=>{},disturbanceReaction:()=>{},partySide:()=>false,activePartySlots:()=>[],
  partyRevengeReactions:()=>{},equipmentRecovery:()=>({lifeDrainPerThousand:0}),isTwoHanded:()=>false,
  moltenReflection:()=>{},holySacrificeTransfer:()=>{},attackProc:()=>{},
  physicalSuccessEquipmentProcs:()=>{},instantRecoveryOnMiss:()=>{},...overrides,
});

test('miss reaches instant recovery for physical and magic, magic shield block does not',()=>{
  let recovered=0,success=0;
  const shared={instantRecoveryOnMiss:()=>recovered++,physicalSuccessEquipmentProcs:()=>success++};
  resolveHitReactionPipeline(event,{kind:'miss',damage:0},'physical','basic-attack',port(shared));
  assert.equal(recovered,1);assert.equal(success,0);
  resolveHitReactionPipeline(event,{kind:'miss',damage:0},'magic','firestorm',port(shared));
  assert.equal(recovered,2);assert.equal(success,0);
  resolveHitReactionPipeline(event,{kind:'shield-block',damage:0},'magic','firestorm',port(shared));
  assert.equal(recovered,2);assert.equal(success,0);
});

test('physical success procs fire on hit, weapon block, shield block and zero damage',()=>{
  for(const kind of ['hit','critical','weapon-block','shield-block'] as const){
    let success=0;
    resolveHitReactionPipeline(event,{kind,damage:0},'physical','basic-attack',
      port({physicalSuccessEquipmentProcs:()=>success++}));
    assert.equal(success,1,kind);
  }
  let success=0;
  resolveHitReactionPipeline(event,{kind:'hit',damage:0},'magic','firestorm',
    port({physicalSuccessEquipmentProcs:()=>success++}));
  assert.equal(success,0);
});

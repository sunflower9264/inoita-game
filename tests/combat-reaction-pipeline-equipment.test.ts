import assert from 'node:assert/strict';
import test from 'node:test';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import {resolveHitReactionPipeline,type HitReactionPort} from '../src/domain/combat-reaction-pipeline.ts';
import type {AttackContact} from '../src/domain/combat.ts';

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

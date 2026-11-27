import assert from 'node:assert/strict';
import test from 'node:test';
import type {BattleBuffEffect} from '../src/domain/battle.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import {createCombatTestHarness,loadBattleCatalog} from './support/combat-test-harness.ts';

const catalog=loadBattleCatalog();
const skill=catalog.skills['ambush'];
const unit=skill.action!.combatUnits![0] as {effect:'buff';buff:'ambush';ranks:{strength:number;effect:BattleBuffEffect}[]};
const recovery=catalog.statusAttackBuffs!['ambush-recovery']!;
const rates=[260,300,340,400,420,440,460,480];

test('eight ranks keep the damage rate, the ambush state and the 180 frame cap',()=>{
  unit.ranks.forEach((rank,index)=>{
    const effect=rank.effect;
    assert.deepEqual(effect.modifiers,[{attribute:'physicalDamageRate',operation:{kind:'add',amount:rates[index]}}],`rank ${index+1}`);
    assert.deepEqual(effect.states,['ambush']);
    assert.equal(effect.simulationFrames?.lastActiveFrame,180);
    assert.equal(effect.durationMs,181*60);assert.equal(effect.maxStacks,1);
    assert.deepEqual(effect.stateDurationProfiles!.ambush!.normal,{lastActiveFrame:270});
  });
});

test('the recovery buff starts stopped and adds a quarter of the base step every fifteen frames',()=>{
  assert.deepEqual(recovery.modifiers,[{attribute:'moveSpeed',operation:{kind:'set',amount:0}}]);
  assert.deepEqual(recovery.attributeRamps,[{attribute:'moveSpeed',intervalFrames:15,operation:{kind:'add',amount:250}}]);
  assert.equal(recovery.simulationFrames?.lastActiveFrame,45);
  assert.equal(recovery.simulationFrames?.pulseIntervalFrames,15);
  const conditions=new CombatConditions();
  assert.equal(conditions.attribute('hero','moveSpeed',1000),1000);
  conditions.applyBuff('hero','ambush-recovery',0,recovery,'hero');
  assert.equal(conditions.attribute('hero','moveSpeed',1000),250);
  conditions.update(14*60);assert.equal(conditions.attribute('hero','moveSpeed',1000),250);
  conditions.update(60);assert.equal(conditions.attribute('hero','moveSpeed',1000),500);
  conditions.update(15*60);assert.equal(conditions.attribute('hero','moveSpeed',1000),750);
  conditions.update(15*60);assert.equal(conditions.attribute('hero','moveSpeed',1000),1000);
  conditions.update(2*60);
  assert.equal(conditions.hasBuff('hero','ambush-recovery'),false);
  assert.equal(conditions.attribute('hero','moveSpeed',1000),1000);
});

test('a real direction input cancels both crouch buffs and starts the recovery',()=>{
  const conditions=new CombatConditions();
  const harness=createCombatTestHarness({battleCatalog:catalog,conditions,controlledId:()=>'hero'});
  harness.settlement.cancelAmbushOnDirection();
  assert.deepEqual(conditions.snapshot('hero'),[]);
  conditions.applyBuff('hero','ambush',2004,unit.ranks[1]!.effect,'hero');
  conditions.applyBuff('hero','sniping',5004,{durationMs:10860,tickMs:0,states:[],modifiers:[],periodic:[]},'hero');
  harness.settlement.cancelAmbushOnDirection();
  assert.equal(conditions.hasBuff('hero','ambush'),false);
  assert.equal(conditions.hasBuff('hero','sniping'),false);
  assert.equal(conditions.hasBuff('hero','ambush-recovery'),true);
  assert.equal(conditions.hasState('hero','ambush'),false);
  assert.equal(conditions.attribute('hero','moveSpeed',1000),250);
  assert.equal(conditions.attribute('hero','physicalDamageRate',0),0);
});

test('the crouch blocks auto approach without stopping manual directions or attacks',()=>{
  const conditions=new CombatConditions();
  conditions.applyBuff('hero','ambush',2002,unit.ranks[0]!.effect,'hero');
  assert.equal(conditions.canAutoApproach('hero'),false);
  assert.equal(conditions.canMove('hero'),true);assert.equal(conditions.canAct('hero'),true);
  conditions.removeBuff('hero','ambush');
  assert.equal(conditions.canAutoApproach('hero'),true);
});

test('the crouch keeps its own self visual unit after the buff unit',()=>{
  const cues=skill.action!.events!.find(event=>event.kind==='units')!.cues!;
  assert.deepEqual(skill.action!.combatUnits!.map(entry=>entry.effect),['buff','visual']);
  assert.equal(cues.length,2);
  assert.deepEqual(cues[1],{target:'self',targetRangePx:0,targetSelection:'reuse-previous',
    effects:[{effect:'fanged-bite',recipient:'target',placement:'attached'}]});
});

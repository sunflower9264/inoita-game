import assert from 'node:assert/strict';
import test from 'node:test';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import {createCombatTestHarness,createTestMember} from './support/combat-test-harness.ts';

test('periodic and reflected direct damage wake sleeping targets only when damage is accepted',()=>{
  const conditions=new CombatConditions();
  const member=createTestMember({id:'target',health:100,maxHealth:100});
  let shown=0;
  const harness=createCombatTestHarness({
    conditions,members:new Map([['target',member]]),
    settlementOverrides:{onShowHit:()=>{shown++;}},
  });
  const sleep=()=>conditions.applyBuff('target','monster-sleep',1,{durationMs:5000,tickMs:0,
    modifiers:[],states:['sleep'],periodic:[]},'caster');
  for(const presentation of [{periodic:true},{}]){
    sleep();harness.settlement.settleHit({casterId:'source',targetId:'target'},{kind:'hit',damage:1},undefined,presentation);
    assert.equal(conditions.hasState('target','sleep'),false);
    assert.equal(conditions.hasBuff('target','monster-sleep'),false);
  }
  assert.equal(member.player.health,98);assert.equal(shown,2);
  sleep();conditions.applyState('target','damage-immune',5000);
  harness.settlement.settleHit({casterId:'source',targetId:'target'},{kind:'hit',damage:1},undefined,{periodic:true});
  assert.equal(conditions.hasState('target','sleep'),true);
  assert.equal(member.player.health,98);assert.equal(shown,2);
  conditions.removeState('target','damage-immune');
  harness.settlement.settleHit({casterId:'source',targetId:'target'},{kind:'hit',damage:0},undefined,{periodic:true});
  assert.equal(conditions.hasState('target','sleep'),true);
});

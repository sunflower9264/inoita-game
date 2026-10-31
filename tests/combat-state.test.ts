import assert from 'node:assert/strict';
import test from 'node:test';
import {combatStateCapabilities} from '../src/domain/combat-state.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';

test('potion states gate recovery items and skill shortcuts independently',()=>{
  assert.equal(combatStateCapabilities(['potion-sickness']).canUseRecoveryItems,false);
  assert.equal(combatStateCapabilities(['potion-sickness']).canUseSkillShortcuts,true);
  assert.equal(combatStateCapabilities(['shortcut-sealed']).canUseSkillShortcuts,false);
  assert.equal(combatStateCapabilities(['shortcut-sealed']).canUseRecoveryItems,true);
  assert.equal(combatStateCapabilities(['potion-recovery-halved']).canUseRecoveryItems,true);
  assert.equal(combatStateCapabilities(['potion-recovery-halved']).canUseSkillShortcuts,true);
  assert.equal(combatStateCapabilities(['sleep','potion-sickness']).canAct,false);
});

test('conditions expose the two potion gates and remove them with the state',()=>{
  const conditions=new CombatConditions();
  conditions.applyState('actor','potion-sickness',1000);
  conditions.applyState('actor','shortcut-sealed',1000);
  assert.equal(conditions.canUseRecoveryItems('actor'),false);
  assert.equal(conditions.canUseSkillShortcuts('actor'),false);
  conditions.removeState('actor','potion-sickness');
  assert.equal(conditions.canUseRecoveryItems('actor'),true);
  assert.equal(conditions.canUseSkillShortcuts('actor'),false);
  conditions.removeState('actor','shortcut-sealed');
  assert.equal(conditions.canUseSkillShortcuts('actor'),true);
});

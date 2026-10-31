import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import type {BattleCatalog} from '../src/domain/battle.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import {SAVE_FORMAT} from '../src/domain/save-game.ts';

const battle=JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')) as BattleCatalog;
const potionBuffs=['spring-potion-sickness','spring-potion-weakened','spring-skill-seal'] as const;

test('potion buffs and states survive a checkpoint round-trip',()=>{
  const conditions=new CombatConditions();
  for(const key of potionBuffs)conditions.applyBuff('actor',key,1,battle.statusAttackBuffs![key]!,'actor');
  assert.equal(conditions.canUseRecoveryItems('actor'),false);
  assert.equal(conditions.canUseSkillShortcuts('actor'),false);
  const restored=new CombatConditions();
  restored.restoreState(conditions.captureState());
  for(const key of potionBuffs)assert.equal(restored.hasBuff('actor',key),true,key);
  assert.equal(restored.hasState('actor','potion-sickness'),true);
  assert.equal(restored.hasState('actor','potion-recovery-halved'),true);
  assert.equal(restored.hasState('actor','shortcut-sealed'),true);
  assert.equal(restored.canUseRecoveryItems('actor'),false);
  assert.equal(restored.canUseSkillShortcuts('actor'),false);
});

test('an older checkpoint without the new keys still restores and the save format is unchanged',()=>{
  const restored=new CombatConditions();
  restored.restoreState(new CombatConditions().captureState());
  assert.equal(restored.hasState('actor','potion-sickness'),false);
  assert.equal(restored.canUseRecoveryItems('actor'),true);
  assert.equal(restored.canUseSkillShortcuts('actor'),true);
  assert.equal(SAVE_FORMAT,39);
});

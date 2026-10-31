import test from 'node:test';
import assert from 'node:assert/strict';
import { drainMana } from '../src/domain/mana-drain.ts';

test('mana drain grants the full formula amount even against an empty target and caps the caster',()=>{
  assert.deepEqual(drainMana(18,0,12,100),{targetMana:0,casterMana:30});
  assert.deepEqual(drainMana(18,5,95,100),{targetMana:0,casterMana:100});
  assert.deepEqual(drainMana(18,40,12,100),{targetMana:22,casterMana:30});
});

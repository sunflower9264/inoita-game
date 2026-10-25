import assert from 'node:assert/strict';
import test from 'node:test';
import type { GameUI } from '../src/ui/game-ui.ts';
import { StoryApp } from '../src/app.ts';

test('releaseResidentCombat releases once and clears the session stamp', () => {
  const app = new StoryApp({} as GameUI);
  let released = 0;
  app.residentCombatAssets = { release: () => { released++; } };
  app.residentCombatClassId = 'warlock';
  app.residentCombatReady = true;
  app.releaseResidentCombat();
  assert.equal(released, 1);
  assert.equal(app.residentCombatAssets, undefined);
  assert.equal(app.residentCombatClassId, undefined);
  assert.equal(app.residentCombatReady, false);
  app.releaseResidentCombat();
  assert.equal(released, 1, '重复释放必须是幂等的');
});

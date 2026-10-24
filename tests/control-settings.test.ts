import assert from 'node:assert/strict';
import test from 'node:test';
import { controlSettings, type MoveControlStyle } from '../src/application/control-settings.ts';

test('controlSettings defaults to stick and notifies subscribers on change', () => {
  const events: MoveControlStyle[] = [];
  const unsubscribe = controlSettings.subscribe(style => events.push(style));

  controlSettings.setMoveStyle('dpad');
  assert.equal(controlSettings.moveStyle, 'dpad');
  assert.deepEqual(events, ['dpad']);

  controlSettings.setMoveStyle('stick');
  assert.equal(controlSettings.moveStyle, 'stick');
  assert.deepEqual(events, ['dpad', 'stick']);

  unsubscribe();
  controlSettings.setMoveStyle('dpad');
  assert.equal(events.length, 2, 'Unsubscribed listener should not receive events');

  // Reset to default
  controlSettings.setMoveStyle('stick');
  assert.equal(controlSettings.moveStyle, 'stick');
});

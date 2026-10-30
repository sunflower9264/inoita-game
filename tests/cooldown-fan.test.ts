import assert from 'node:assert/strict';
import test from 'node:test';
import { cooldownFanState, cooldownSecondsLabel, shortcutCooldown } from '../src/ui/phaser/cooldown-fan.ts';

test('冷却秒数向上取整，没有冷却时为空', () => {
  assert.equal(cooldownSecondsLabel(0), '');
  assert.equal(cooldownSecondsLabel(-5), '');
  assert.equal(cooldownSecondsLabel(1), '1');
  assert.equal(cooldownSecondsLabel(1001), '2');
  assert.equal(cooldownSecondsLabel(2000), '2');
});

test('扇形状态随进度变化，零时长不会产生 NaN', () => {
  assert.equal(cooldownFanState(undefined, 32), '');
  assert.equal(cooldownFanState({ remainingMs: 0, durationMs: 2000 }, 32), '');
  assert.equal(cooldownFanState({ remainingMs: 1000, durationMs: 2000 }, 32), '0.5:32');
  assert.equal(cooldownFanState({ remainingMs: 500, durationMs: 0 }, 32), '0:32');
});

test('技能冷却按 id 取，物品用自己的格子冷却', () => {
  const cooldowns = { fireball: { remainingMs: 1200, durationMs: 3000 } };
  assert.deepEqual(shortcutCooldown({ entry: { kind: 'skill', id: 'fireball' } }, cooldowns), cooldowns.fireball);
  const itemCooldown = { remainingMs: 800, durationMs: 1000 };
  assert.deepEqual(shortcutCooldown({ entry: { kind: 'item', id: 'potion' }, cooldown: itemCooldown }, cooldowns), itemCooldown);
  assert.equal(shortcutCooldown({ entry: null }, cooldowns), undefined);
  assert.equal(shortcutCooldown(undefined, cooldowns), undefined);
});

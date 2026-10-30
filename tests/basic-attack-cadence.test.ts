import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { CombatCooldownStore } from '../src/domain/combat-cooldowns.ts';
import { CombatRuntime } from '../src/domain/combat-runtime.ts';
import { CombatController } from '../src/domain/combat.ts';
import type { CombatPort, Combatant } from '../src/domain/combat.ts';
import type { BattleCatalog } from '../src/domain/battle.ts';
import { resolveBasicAttack } from '../src/domain/basic-attack.ts';
import { basicAttackFrames, basicSelectionFrames } from '../src/domain/combat-tempo.ts';

const catalog = JSON.parse(readFileSync(new URL('../public/content/battle.json', import.meta.url), 'utf8')) as BattleCatalog;
const warlock = catalog.classes.find(value => value.id === 'warlock')!;
const basic = resolveBasicAttack(catalog, warlock);
const caster: Combatant = { id: 'player', team: 'party', position: { x: 0, y: 0 }, bounds: { x: -8, y: -8, width: 16, height: 16 } };
const enemy: Combatant = { ...caster, id: 'enemy', team: 'hostile', position: { x: 24, y: 0 } };

function fixture() {
  let now = 0, speed = 1000;
  let complete: (() => void) | undefined;
  const cooldowns = new CombatCooldownStore(() => now);
  const port: CombatPort = {
    cooldowns: cooldowns.forActor('player'),
    canSelectSkill: () => true,
    actor: id => [caster, enemy].find(value => value.id === id),
    candidates: () => [caster, enemy],
    facing: () => 'east',
    moveToward: () => {},
    stop: () => {},
    canStand: () => true,
    relocate: () => {},
    play: (action, _frame, onComplete) => {
      action.getAttackSpeedRate = () => speed;
      complete = onComplete;
      return () => { complete = undefined; };
    },
    frame: () => {},
    clearEffects: () => {},
  };
  const controller = new CombatController('player', basic, port);
  controller.useClock(() => now);
  return {
    controller,
    setNow: (value: number) => { now = value; },
    setSpeed: (value: number) => { speed = value; },
    finish: () => complete?.(),
  };
}

test('canceling after the strike does not shorten the basic attack cycle', () => {
  const f = fixture();
  assert.equal(f.controller.requestTarget(enemy.id), 'started');
  f.controller.cancel();
  assert.equal(f.controller.requestTarget(enemy.id), 'busy', '取消动作不能提前放行下一次普攻');
  f.setNow(basicAttackFrames(basic, 1000) - 1);
  assert.equal(f.controller.requestTarget(enemy.id), 'busy', '周期结束前一帧仍然不行');
  f.setNow(basicAttackFrames(basic, 1000));
  assert.equal(f.controller.requestTarget(enemy.id), 'started', '完整周期结束后恢复出手');
});

test('a completed basic attack allows the next one exactly at the cycle end', () => {
  const f = fixture();
  f.controller.requestTarget(enemy.id);
  f.finish();
  f.setNow(basicAttackFrames(basic, 1000) - 1);
  assert.equal(f.controller.requestTarget(enemy.id), 'busy');
  f.setNow(basicAttackFrames(basic, 1000));
  assert.equal(f.controller.requestTarget(enemy.id), 'started');
});

test('the cadence lock uses the attack speed of the action that started', () => {
  const f = fixture();
  f.setSpeed(2000);
  f.controller.requestTarget(enemy.id);
  f.controller.cancel();
  f.setNow(basicAttackFrames(basic, 2000) - 1);
  assert.equal(f.controller.requestTarget(enemy.id), 'busy');
  f.setNow(basicAttackFrames(basic, 2000));
  assert.equal(f.controller.requestTarget(enemy.id), 'started');
});

test('active skills may take over while the basic cadence lock is still running', () => {
  const f = fixture();
  f.controller.requestTarget(enemy.id);
  f.controller.cancel();
  const skill = catalog.skills['demon-s-shield'].action!;
  assert.equal(f.controller.requestManualSkill({ id: 'demon-s-shield', action: skill }), 'started');
});

test('fixed animation and missing-animation waits use their own full frame counts', () => {
  assert.equal(basicAttackFrames({ ...basic, timing: 'fixed-animation' }, 2000), basic.effectiveCycleFrames);
  assert.equal(basicSelectionFrames({ kind: 'animation-unavailable', durationFrames: 7 }, 2000), 7);
});

test('runtime injects the clock and keeps the cadence lock after a canceled strike', () => {
  let now = 0;
  const runtime = new CombatRuntime(() => now);
  const cooldowns = new CombatCooldownStore(() => now);
  const port: CombatPort = {
    cooldowns: cooldowns.forActor('player'),
    canSelectSkill: () => true,
    actor: id => [caster, enemy].find(value => value.id === id),
    candidates: () => [caster, enemy],
    facing: () => 'east',
    moveToward: () => {},
    stop: () => {},
    canStand: () => true,
    relocate: () => {},
    play: (action, frame, complete) => {
      action.getAttackSpeedRate = () => 1000;
      return runtime.play(action, { sourceFrames: 10, frameDurationMs: 60 }, frame, complete);
    },
    frame: () => {},
    clearEffects: () => {},
  };
  const controller = new CombatController('player', basic, port);
  runtime.registerActor('player', controller);
  assert.equal(controller.requestTarget(enemy.id), 'started');
  runtime.step(++now);
  controller.cancel();
  assert.equal(controller.requestTarget(enemy.id), 'busy');
  while (now < basicAttackFrames(basic, 1000) - 1) runtime.step(++now);
  assert.equal(controller.requestTarget(enemy.id), 'busy');
  runtime.step(++now);
  assert.equal(controller.requestTarget(enemy.id), 'started');
});

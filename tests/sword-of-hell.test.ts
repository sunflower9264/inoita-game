import assert from 'node:assert/strict';
import test from 'node:test';
import type { ActionDispatchDefinition } from '../src/domain/battle.ts';
import { actionDamage } from '../src/domain/action-damage.ts';
import { CombatConditions } from '../src/domain/combat-conditions.ts';
import { CombatCooldownStore } from '../src/domain/combat-cooldowns.ts';
import { CombatController, resolveCueTargets, type ActionPlayback, type Combatant, type CombatPort, type SkillUnitHit } from '../src/domain/combat.ts';
import type { EnemySnapshot } from '../src/domain/enemy-stats.ts';
import type { PhysicalHit } from '../src/domain/physical-hit.ts';
import { dispatchFrame } from './support/combat-driver.ts';
import { createCombatTestHarness, createTestEnemy, createTestMember, loadBattleCatalog, ZERO_PRIMARY_ATTRIBUTES } from './support/combat-test-harness.ts';

const catalog = loadBattleCatalog();
const skill = catalog.skills['sword-of-hell'], action = skill.action!, units = action.combatUnits!;
const damage = units[0], event = action.events.find(entry => entry.kind === 'units')!;
if (damage.effect !== 'physical' || event.kind !== 'units') throw new Error('Sword of Hell action missing');
const primary = ZERO_PRIMARY_ATTRIBUTES;
const base = {
  level: 10, physicalAttack: 201, magicAttack: 303, maxHealth: 10000, hitBase: 100, hitBonus: 0,
  evasionBase: 0, evasionBonus: 0, criticalRate: 0, criticalResistance: 0, criticalDamage: 0, criticalDamageResistance: 0,
  weaponBlock: 0, shieldBlock: 0, physicalResistance: 0, magicResistance: 0,
};
const actor = (id: string, x = 16, y = 0, team = 'enemy'): Combatant => ({ id, team, position: { x, y }, bounds: { x: -4, y: -4, width: 8, height: 8 } });

function fixture(targets: Combatant[] = []) {
  const caster = actor('caster', 0, 0, 'party'), actors = new Map([caster, ...targets].map(item => [item.id, item]));
  const stats = new Map(targets.map(item => [
    item.id,
    {
      ...base,
      health: 10000,
    },
  ]));
  const enemies = new Map(targets.map(item => [
    item.id,
    createTestEnemy({ key: item.id, definition: { ...catalog.enemies[0], stateRules: undefined }, level: 10, health: 10000, maxHealth: 10000 }),
  ]));
  const conditions = new CombatConditions();
  const hits: { event: SkillUnitHit; hit: PhysicalHit }[] = [];
  const taunts: string[] = [], order: string[] = [], attempts: SkillUnitHit[] = [], feedback: ActionDispatchDefinition[] = [];
  const member = createTestMember({
    id: 'caster',
    level: 10,
    panel: { ...base, attributes: primary, baseDefense: 0, defense: 0, defenseRate: 0, baseMagicResistance: 0, maxMana: 100 },
    maxHealth: 10000,
    health: 10000,
    maxMana: 100,
    mana: 100,
  });
  const harness = createCombatTestHarness({
    battleCatalog: catalog,
    conditions,
    hero: member,
    members: new Map([['caster', member]]),
    enemies,
    activeParty: () => ['caster'],
    combatant: id => actors.get(id),
    combatants: () => [...actors.values()],
    statsOverrides: {
      enemySnapshot: id => stats.get(id) as unknown as EnemySnapshot | undefined,
    },
    settlementOverrides: {
      isPendingDefeat: () => false,
      enemySnapshot: id => stats.get(id) as unknown as EnemySnapshot | undefined,
      onShowHit: () => {},
      onDropMana: () => {},
    },
  });
  harness.settlement.setThreatSystem({
    taunt: (_source: string, target: string) => { taunts.push(target); order.push(`taunt:${target}`); },
    damage: () => {},
  } as never);
  harness.settlement.resolveHitReactions = () => {};
  const baseSettleHit = harness.settlement.settleHit.bind(harness.settlement);
  harness.settlement.settleHit = (hitEvent, hit, enemy, presentation) => {
    hits.push({ event: hitEvent as SkillUnitHit, hit });
    baseSettleHit(hitEvent, hit, enemy, presentation);
  };
  const presenter = {
    pose: () => {},
    visualEffect: (cue: { effect: string }) => order.push(`effect:${cue.effect}`),
    visual: (id: string) => (actors.has(id) ? { container: { active: true, ...actors.get(id)!.position } } : undefined),
  };
  let affordable = true;
  let frame = (_index: number) => {}, spent = 0, moves = 0, turns = 0, playback: ActionPlayback | undefined;
  const port: CombatPort = {
    cooldowns: new CombatCooldownStore(() => 0).forActor('caster'),
    actor: id => actors.get(id),
    candidates: () => [...actors.values()],
    facing: () => 'west',
    face: () => { turns++; },
    moveToward: () => { moves++; },
    stop: () => {},
    canStand: () => true,
    relocate: () => { moves++; },
    clearEffects: () => {},
    canSpendMana: () => affordable,
    spendMana: cost => { spent += cost; return true; },
    play: (value, onFrame) => { playback = value; frame = onFrame; return () => {}; },
    frame: (value, index, contact, ready) => dispatchFrame(presenter, value, index, contact, ready, undefined, (def: ActionDispatchDefinition, work: () => void) => {
      work();
      feedback.push(def);
      order.push('feedback');
    }),
    unit: hit => {
      attempts.push(hit);
      order.push(`unit:${hit.cueIndex}:${hit.targetId}`);
      return harness.settlement.skillUnit(hit);
    },
  };
  const combat = new CombatController('caster', null, port);
  return {
    caster, stats, hits, taunts, order, attempts, feedback, combat, conditions,
    start: (targetId?: string) => combat.requestManualSkill({ id: skill.id, action, level: 1, manaCost: 60 }, targetId),
    frame: (index: number) => frame(index),
    affordable: (value: boolean) => { affordable = value; },
    counts: () => ({ spent, moves, turns }),
    playback: () => playback,
  };
}

test('all eight Sword of Hell ranks preserve the native weighted damage, cost, and existing animation lengths', () => {
  assert.deepEqual(units.map(unit => unit.effect), ['physical', 'taunt']);
  assert.equal(damage.source, 'bestNormalDamage');
  assert.deepEqual(damage.attributeWeights, { strength: 12, dexterity: 0, vitality: 0, intelligence: 10, mentality: 0 });
  assert.deepEqual(
    damage.ranks.map(rank => rank.operation),
    [2650, 2950, 3150, 3250, 3350, 3450, 3550, 3650].map(ratePerThousand => ({ kind: 'multiply-thousandth', ratePerThousand })),
  );
  assert.deepEqual(
    damage.ranks.map((_, i) => actionDamage(damage, i + 1, {
      physicalAttack: 100, magicAttack: 137, bestNormalDamage: 137, maxHealth: 1000,
      primaryAttributes: { ...primary, strength: 3, intelligence: 4 },
    })),
    [381, 424, 453, 468, 482, 496, 511, 525],
  );
  assert.deepEqual(skill.ranks.map(rank => rank.manaCost), Array(8).fill(60));
  assert.equal(action.cooldownFrames, 60);
  const clips = catalog.classes.find(entry => entry.id === 'dark-knight')!.actor.clips;
  for (const direction of ['south', 'west', 'north', 'east'] as const) assert.equal(clips[`skill-sword-of-hell-${direction}`]!.frames, 25);
  for (const clip of Object.values(catalog.attackEffects['hellsword-swing'].clips)) assert.equal(clip.frames, 20);
});

test('empty casts remain in place and preserve facing even with a selected distant enemy', () => {
  for (const targets of [[], [actor('far', 1000)]]) {
    const run = fixture(targets);
    assert.equal(action.requiresTarget, false);
    assert.equal(run.start(targets[0]?.id), 'started');
    assert.deepEqual(run.counts(), { spent: 60, moves: 0, turns: 0 });
    assert.equal(run.playback()!.facing, 'west');
    assert.equal(run.playback()!.target, undefined);
    assert.deepEqual(run.order, ['effect:hellsword-swing']);
    run.frame(1);
    run.frame(9);
    assert.equal(run.attempts.length, 0);
    run.frame(10);
    assert.deepEqual(run.order, ['effect:hellsword-swing', 'feedback']);
    assert.equal(run.feedback.length, 1);
    assert.equal(run.combat.snapshot().cooldowns[skill.id].remainingMs, action.cooldownFrames * 60);
  }
});

test('the two area queries use quantized octagonal foot distance at axis and diagonal boundaries', () => {
  const caster = actor('caster', 0, 0, 'party'), targets = [actor('axis-in', 79), actor('axis-out', 80), actor('diagonal-in', 57, 57), actor('diagonal-out', 58, 58)];
  targets[1].bounds = { x: -100, y: -100, width: 200, height: 200 };
  for (const cue of event.cues) {
    assert.equal(cue.targetRangeMetric, 'octagonal-grid');
    assert.equal(cue.targetRangePx, 72);
    assert.deepEqual(resolveCueTargets(cue, caster, targets[1], targets).map(target => target.id), ['axis-in', 'diagonal-in']);
  }
  assert.deepEqual(event.cues.map(cue => cue.targetSelection), ['search', 'reuse-previous']);
});

test('the actual controller and presenter cap both Direct units to the first sixteen eligible enemies', t => {
  t.mock.method(Math, 'random', () => 0.2);
  const valid = Array.from({ length: 17 }, (_, index) => actor(`enemy-${index}`));
  const run = fixture([actor('far', 80), { ...actor('hidden'), states: ['stealthed'] }, actor('friendly', 16, 0, 'party'), ...valid]);
  assert.equal(run.start(), 'started');
  run.frame(10);
  const expected = valid.slice(0, 16).map(target => target.id);
  for (let cue = 0; cue < 2; cue++) assert.deepEqual(run.attempts.filter(hit => hit.cueIndex === cue).map(hit => hit.targetId), expected);
  assert.deepEqual(run.taunts, expected);
  assert.equal(run.feedback.length, 1);
  assert.equal(run.order.at(-1), 'feedback');
});

test('miss and zero damage skip only their later taunt and the shared feedback runs after the complete Direct sequence', t => {
  t.mock.method(Math, 'random', () => 0.2);
  const run = fixture([actor('hit'), actor('miss'), actor('zero')]);
  run.stats.get('miss')!.evasionBonus = 750;
  run.stats.get('zero')!.physicalResistance = 1000;
  run.start();
  run.frame(10);
  assert.deepEqual(run.hits.map(({ event, hit }) => [event.targetId, hit.kind, hit.damage]), [['hit', 'hit', 802], ['miss', 'miss', 0], ['zero', 'hit', 0]]);
  assert.deepEqual(run.attempts.map(hit => [hit.cueIndex, hit.targetId]), [[0, 'hit'], [0, 'miss'], [0, 'zero'], [1, 'hit']]);
  assert.deepEqual(run.order, ['effect:hellsword-swing', 'unit:0:hit', 'unit:0:miss', 'unit:0:zero', 'unit:1:hit', 'taunt:hit', 'feedback']);
  assert.deepEqual(run.feedback, [{ breaksStealth: true, shake: true, vibrationMs: 300, sound: 'Bn_Hell_Sword' }]);
  run.frame(10);
  run.frame(24);
  assert.equal(run.feedback.length, 1, 'catch-up and repeated frame notifications do not replay feedback');
});

test('an entirely immune area still gets one cast feedback while insufficient mana prevents the whole action', () => {
  const immune = fixture([{ ...actor('immune'), states: ['damage-immune'] }]);
  immune.conditions.applyState('immune', 'damage-immune', 1000);
  assert.equal(immune.start(), 'started');
  immune.frame(10);
  assert.equal(immune.hits.length, 0);
  assert.equal(immune.taunts.length, 0);
  assert.deepEqual(immune.order, ['effect:hellsword-swing', 'unit:0:immune', 'feedback']);
  assert.equal(immune.feedback.length, 1);
  const empty = fixture();
  empty.affordable(false);
  assert.equal(empty.start(), 'no-mana');
  assert.deepEqual(empty.counts(), { spent: 0, moves: 0, turns: 0 });
  assert.equal(empty.order.length, 0);
  assert.equal(empty.playback(), undefined);
});

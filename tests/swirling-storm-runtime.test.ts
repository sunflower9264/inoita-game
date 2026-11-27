import assert from 'node:assert/strict';
import test from 'node:test';
import type { ActionDispatchDefinition } from '../src/domain/battle.ts';
import { CombatConditions } from '../src/domain/combat-conditions.ts';
import { CombatCooldownStore } from '../src/domain/combat-cooldowns.ts';
import { CombatHitResolution } from '../src/domain/combat-hit-resolution.ts';
import { CombatController, type AttackContact, type Combatant, type CombatPort, type SkillUnitHit } from '../src/domain/combat.ts';
import type { EnemySnapshot } from '../src/domain/enemy-stats.ts';
import type { PhysicalHit } from '../src/domain/physical-hit.ts';
import { dispatchFrame } from './support/combat-driver.ts';
import { createCombatTestHarness, createTestEnemy, createTestMember, loadBattleCatalog } from './support/combat-test-harness.ts';

const catalog = loadBattleCatalog();
const skill = catalog.skills['swirling-storm'], action = skill.action!;
const enemyDefinition = { ...catalog.enemies.find(enemy => enemy.acceptsBuffs !== false)!, stateRules: undefined };
const actor = (id: string, x = 16, y = 0, team = 'enemy'): Combatant => ({ id, team, position: { x, y }, bounds: { x: -4, y: -4, width: 8, height: 8 } });
const base = {
  level: 10, physicalAttack: 101, magicAttack: 203, baseDefense: 0, defense: 0, defenseRate: 0,
  physicalResistance: 0, physicalResistanceBonus: 0, magicResistance: 0, baseMagicResistance: 0,
  maxHealth: 10000, maxMana: 100, hitBase: 100, hitBonus: 0, evasionBase: 0, evasionBonus: 0,
  criticalRate: 0, criticalResistance: 0, criticalDamage: 0, criticalDamageResistance: 0, weaponBlock: 0, shieldBlock: 0,
  attributes: { strength: 11, dexterity: 17, vitality: 0, intelligence: 0, mentality: 0 },
};

function fixture(targets: Combatant[] = []) {
  const caster = actor('player', 0, 0, 'party'), actors = new Map([caster, ...targets].map(value => [value.id, value]));
  const conditions = new CombatConditions(), resolution = new CombatHitResolution(), fallen = new Set<string>();
  const stats = new Map<string, EnemySnapshot>(targets.map(value => [
    value.id,
    {
      ...structuredClone(base),
      id: enemyDefinition.id,
      name: enemyDefinition.name,
      sceneLevel: false,
      elite: false,
      partySize: 1,
      hitRate: 100,
      evasionRate: 0,
      baseExperience: 0,
      experience: 0,
      health: 10000,
      mana: 100,
    },
  ]));
  const enemies = new Map(
    targets.filter(value => value.team === 'enemy').map(value => [
      value.id,
      createTestEnemy({ key: value.id, definition: enemyDefinition, level: 10, health: 10000, maxHealth: 10000 }),
    ]),
  );
  const order: string[] = [], attempts: SkillUnitHit[] = [], hits: { event: SkillUnitHit; hit: PhysicalHit }[] = [];
  const member = createTestMember({ id: 'player', classId: 'warrior', level: 10, panel: structuredClone(base), maxHealth: 10000, health: 10000, maxMana: 100, mana: 100 });
  const visuals = new Map([...actors].map(([id, value]) => [id, { container: { active: true, ...value.position }, layers: [{ setAlpha: () => {} }] }]));
  let afterHit: (event: SkillUnitHit, hit: PhysicalHit) => void = () => {};
  const combatantOf = (id: string) => {
    const value = actors.get(id);
    return value && !fallen.has(id) ? { ...value, states: conditions.activeStates(id) } : undefined;
  };
  const harness = createCombatTestHarness({
    battleCatalog: catalog,
    conditions,
    hitResolution: resolution,
    hero: member,
    members: new Map([['player', member]]),
    enemies,
    activeParty: () => ['player'],
    combatant: combatantOf,
    combatants: () => [...actors.keys()].flatMap(id => {
      const value = combatantOf(id);
      return value ? [value] : [];
    }),
    statsOverrides: {
      enemySnapshot: id => stats.get(id),
    },
    settlementOverrides: {
      isFallen: id => fallen.has(id),
      isPendingDefeat: () => false,
      enemySnapshot: id => stats.get(id),
      setEnemyHealth: (id, value) => {
        const s = stats.get(id);
        if (s) s.health = value;
      },
      onActionSound: (_casterId, name) => order.push(`sound:${name}`),
      onActionShake: () => order.push('shake'),
      onDropMana: () => {},
      onShowHit: (event, hit) => {
        hits.push({ event: event as SkillUnitHit, hit });
        order.push(`hit:${event.targetId}:${hit.kind}:${hit.damage}`);
        afterHit(event as SkillUnitHit, hit);
      },
    },
  });
  harness.settlement.resolveHitReactions = () => {};
  const baseApplyBuff = harness.settlement.applyActorBuff.bind(harness.settlement);
  harness.settlement.applyActorBuff = (targetId, key, priority, effect, sourceId) => {
    const accepted = baseApplyBuff(targetId, key, priority, effect, sourceId);
    if (accepted) order.push(`buff:${targetId}`);
    return accepted;
  };
  const presenter = {
    pose: () => {},
    visual: (id: string) => visuals.get(id),
    candidates: () => [...actors.keys()].flatMap(id => {
      const value = combatantOf(id);
      return value ? [value] : [];
    }),
    visualEffect: (effect: { effect: string }, variant: string) => order.push(`effect:${effect.effect}:${variant}`),
  };
  let frame = (_index: number) => {}, spent = 0, moves = 0;
  const cooldowns = new CombatCooldownStore(() => 0).forActor('player');
  const port: CombatPort = {
    cooldowns,
    actor: combatantOf,
    candidates: () => presenter.candidates(),
    facing: () => 'east',
    moveToward: () => { moves++; },
    stop: () => {},
    canStand: () => true,
    relocate: () => { moves++; },
    clearEffects: () => { order.push('clear:player'); },
    canSpendMana: cost => member.player.mana >= cost,
    spendMana: cost => { spent += cost; member.player.mana -= cost; return true; },
    play: (_playback, onFrame) => { frame = onFrame; return () => {}; },
    frame: (playback, index, contact, ready, area) => resolution.run(() => dispatchFrame(presenter, playback, index, contact, ready, undefined,
      (definition: ActionDispatchDefinition, work: () => void, after?: () => void) => harness.settlement.runActionDispatch(playback, definition, work, after), area)),
    prepareUnit: event => harness.settlement.prepareSkillUnit(event),
    runUnitSequence: work => resolution.run(work),
    unit: hit => { attempts.push(hit); return harness.settlement.skillUnit(hit); },
    unitFeedback: () => {},
  };
  const combat = new CombatController('player', null, port);
  return {
    caster, actors, conditions, resolution, fallen, stats, order, attempts, hits, member, harness, combat,
    start: (targetId?: string) => combat.requestManualSkill({ id: skill.id, action, level: 1, manaCost: 60 }, targetId),
    frame: (index: number) => frame(index),
    counts: () => ({ spent, moves }),
    afterHit: (callback: typeof afterHit) => { afterHit = callback; },
  };
}

test('startup needs an enemy but a started storm dispatches all five empty pulses after target loss with one charge', () => {
  const empty = fixture();
  assert.equal(empty.start(), 'no-target');
  assert.deepEqual(empty.counts(), { spent: 0, moves: 0 });
  assert.deepEqual(empty.combat.snapshot().cooldowns, {});
  const f = fixture([actor('enemy')]);
  assert.equal(f.start(), 'started');
  assert.equal(f.member.player.mana, 40);
  assert.deepEqual(f.counts(), { spent: 60, moves: 0 });
  assert.deepEqual(f.combat.snapshot().cooldowns[skill.id], { remainingMs: 5400, durationMs: 5400 });
  assert.deepEqual(f.order, ['effect:swirl-ring:default']);
  f.actors.delete('enemy');
  f.combat.targetRemoved('enemy');
  f.frame(15);
  f.frame(15);
  assert.equal(f.attempts.length, 0);
  assert.deepEqual(f.order, ['effect:swirl-ring:default', ...Array.from({ length: 5 }, () => ['shake', 'sound:Wa_Wheel_Wind']).flat()]);
  assert.equal(f.combat.snapshot().state, 'attacking', 'frame 15 is the last pulse, not the animation end');
  assert.deepEqual(f.counts(), { spent: 60, moves: 0 });
});

test('the real storm area uses integer grid range nine with axis 79/80 and diagonal 57/58 boundaries', t => {
  t.mock.method(Math, 'random', () => 0.2);
  const f = fixture([
    actor('anchor'), actor('axis-in', 79), actor('axis-out', 80), actor('diagonal-in', 57, 57),
    actor('diagonal-out', 58, 58), actor('ally', 16, 0, 'party'), actor('hidden'),
  ]);
  f.conditions.applyState('hidden', 'stealthed', 10000);
  assert.equal(f.start('anchor'), 'started');
  f.frame(3);
  assert.deepEqual(f.hits.map(value => value.event.targetId), ['anchor', 'axis-in', 'diagonal-in']);
  assert.deepEqual(f.hits.map(value => value.hit.damage), [69, 69, 69]);
  for (const id of ['axis-out', 'diagonal-out', 'ally', 'hidden']) assert.equal(f.stats.get(id)!.health, 10000, id);
});

test('each pulse rebuilds its sixteen-slot target group while damage immunity continues to consume a slot', t => {
  t.mock.method(Math, 'random', () => 0.2);
  const targets = Array.from({ length: 18 }, (_, index) => actor(`enemy-${index}`)), f = fixture(targets);
  f.conditions.applyState('enemy-0', 'damage-immune', 10000);
  assert.equal(f.start('enemy-1'), 'started');
  f.frame(3);
  assert.deepEqual(f.attempts.map(hit => hit.targetId), targets.slice(0, 16).map(value => value.id));
  assert.equal(f.hits[0].hit.damage, 0);
  assert.equal(f.stats.get('enemy-16')!.health, 10000);
  f.actors.delete('enemy-1');
  f.conditions.applyState('enemy-2', 'stealthed', 10000);
  f.frame(6);
  assert.deepEqual(f.attempts.slice(16).map(hit => hit.targetId), ['enemy-0', ...targets.slice(3).map(value => value.id)]);
  assert.equal(f.hits[16].hit.damage, 0);
  assert.equal(f.stats.get('enemy-16')!.health, 9931);
  assert.equal(f.stats.get('enemy-17')!.health, 9931);
});

test('a pulse fixes its primary contribution and target list but reads source attack live, then the next pulse uses the new center and stats', t => {
  t.mock.method(Math, 'random', () => 0.2);
  const f = fixture([actor('first'), actor('second'), actor('next-center', 516)]);
  f.afterHit(event => {
    if (event.targetId === 'first') {
      f.conditions.setTemporaryAttribute('player', 'physicalAttack', 201);
      f.member.panel.attributes.strength = 111;
      f.caster.position = { x: 500, y: 0 };
      f.actors.get('second')!.position.x = 1000;
      f.conditions.applyState('second', 'stealthed', 10000);
    }
  });
  assert.equal(f.start('first'), 'started');
  f.frame(3);
  assert.deepEqual(f.hits.map(value => [value.event.targetId, value.hit.damage]), [['first', 69], ['second', 122]]);
  f.frame(6);
  assert.deepEqual(f.hits.map(value => [value.event.targetId, value.hit.damage]), [['first', 69], ['second', 122], ['next-center', 175]]);
});

test('failed pulses do not poison later Direct calls and the skill damage bonus is consumed by the first non-miss', t => {
  t.mock.method(Math, 'random', () => 0.2);
  const f = fixture([actor('enemy')]), target = f.stats.get('enemy')!;
  // Controlled skill-bonus probe; this does not add Dark Strike to a warrior's learned skills.
  const bonus = catalog.skills['dark-strike'].action!.combatUnits!.find(unit => unit.effect === 'buff')!;
  assert.equal(bonus.effect, 'buff');
  f.harness.settlement.applyActorBuff('player', bonus.buff, bonus.ranks[0].strength, bonus.ranks[0].effect, 'bonus-probe');
  target.evasionBonus = 750;
  assert.equal(f.start('enemy'), 'started');
  f.frame(3);
  assert.equal(f.conditions.hasBuff('player', 'dark-strike'), true);
  target.evasionBonus = 0;
  f.frame(6);
  assert.equal(f.conditions.hasBuff('player', 'dark-strike'), false);
  target.physicalResistanceBonus = 1000;
  f.frame(9);
  target.physicalResistanceBonus = 0;
  f.frame(15);
  assert.deepEqual(f.hits.map(value => value.hit), [
    { kind: 'miss', damage: 0 }, { kind: 'hit', damage: 83 }, { kind: 'hit', damage: 0 }, { kind: 'hit', damage: 69 }, { kind: 'hit', damage: 69 },
  ]);
  assert.equal(f.order.filter(value => value === 'sound:Wa_Wheel_Wind').length, 5);
  assert.deepEqual(f.attempts.map(value => value.cueIndex), [0, 0, 0, 0, 0]);
});

test('a reflected zero-HP caster completes the current pulse and its feedback before death cancels the remaining pulses', t => {
  t.mock.method(Math, 'random', () => 0.2);
  const f = fixture([actor('first'), actor('second')]);
  f.member.player.health = 30;
  // State-only probe tests dispatch timing, independently of stealth damage modifiers.
  f.conditions.applyState('player', 'stealthed', 10000);
  f.harness.settlement.resolveHitReactions = (event: AttackContact) => {
    if (event.targetId === 'first') {
      f.harness.settlement.settleHit({ casterId: 'first', targetId: 'player' }, { kind: 'hit', damage: 30 });
      assert.equal(f.resolution.isAwaitingDefeat('player'), true);
    }
  };
  let defeated = false;
  const origDefeat = () => {
    if (defeated) return;
    defeated = true;
    f.order.push('defeat:player');
    f.fallen.add('player');
    f.combat.cancel(true);
  };
  // onMemberDefeated fires after hitResolution.run exits.
  f.harness.settlement.settleHit = ((baseSettle => (event, hit, enemy, presentation) => {
    baseSettle(event, hit, enemy, presentation);
    if (event.targetId === 'player' && f.member.player.health === 0) {
      f.resolution.deferDefeat('player', origDefeat);
    }
  })(f.harness.settlement.settleHit.bind(f.harness.settlement)));
  f.harness.settlement.react = () => {};
  const remove = f.conditions.removeState.bind(f.conditions);
  f.conditions.removeState = (id, key) => {
    if (id === 'player' && key === 'stealthed') f.order.push('break-stealth');
    return remove(id, key);
  };
  assert.equal(f.start('first'), 'started');
  f.frame(3);
  assert.deepEqual(f.order, [
    'effect:swirl-ring:default', 'hit:player:hit:30', 'hit:first:hit:69', 'hit:second:hit:69',
    'shake', 'break-stealth', 'sound:Wa_Wheel_Wind', 'defeat:player', 'clear:player',
  ]);
  const before = [...f.order];
  f.frame(15);
  assert.deepEqual(f.order, before);
  assert.equal(f.attempts.length, 2);
  assert.equal(f.combat.snapshot().state, 'idle');
});

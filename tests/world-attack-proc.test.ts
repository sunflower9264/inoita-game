import assert from 'node:assert/strict';
import test from 'node:test';
import type { Combatant } from '../src/domain/combat.ts';
import type { BattleStatKey } from '../src/domain/battle-semantics.ts';
import { CombatConditions } from '../src/domain/combat-conditions.ts';
import { feedbackPlan, selectFeedbackAssets } from '../src/domain/combat-feedback.ts';
import { CombatHitResolution } from '../src/domain/combat-hit-resolution.ts';
import type { EnemySnapshot } from '../src/domain/enemy-stats.ts';
import type { ItemInstance } from '../src/domain/items.ts';
import {
  createCombatTestHarness,
  createTestEnemy,
  createTestMember,
  loadBattleCatalog,
  loadItemCatalog,
  ZERO_PRIMARY_ATTRIBUTES,
} from './support/combat-test-harness.ts';
import { createTestWorldCombat } from './support/world-combat-fixture.ts';

const catalog = loadBattleCatalog();
const items = loadItemCatalog();
const baseWeapon = items.items[Object.keys(items.items).find(key => items.items[key].kind === 'longsword')!]!;
const primary = ZERO_PRIMARY_ATTRIBUTES;
const actor = (id: string, x: number, team = 'enemy'): Combatant => ({
  id,
  team,
  position: { x, y: 0 },
  facing: 'east',
  bounds: { x: -8, y: -8, width: 16, height: 16 },
});

function fixture(count = 1) {
  const conditions = new CombatConditions();
  const order: string[] = [];
  const actors = [actor('player', 0, 'party'), ...Array.from({ length: count }, (_, i) => actor(`enemy-${i}`, 8 + i))];
  const equipment = { numbers: { modifiers: [] as { stat: string; value: number }[], gemModifiers: [] } } as unknown as ItemInstance;
  const hero = createTestMember({
    id: 'player',
    classId: 'dark-knight',
    level: 1,
    panel: { physicalAttack: 101, magicAttack: 30, maxHealth: 1000 },
    health: 1000,
    maxHealth: 1000,
    bag: {
      revision: 0,
      equipmentFor: () => ({ 'main-hand': 'weapon' }),
      equipmentItems: eq => eq,
      get: () => equipment,
    },
  });
  const states = new Map<string, EnemySnapshot>(
    actors.slice(1).map(value => [
      value.id,
      {
        id: catalog.enemies[0].id,
        name: catalog.enemies[0].name,
        level: 1,
        sceneLevel: false,
        elite: false,
        partySize: 1,
        health: 10000,
        maxHealth: 10000,
        mana: 100,
        maxMana: 100,
        physicalAttack: 100,
        magicAttack: 0,
        defense: 0,
        defenseRate: 0,
        physicalResistanceBonus: 0,
        hitBase: 100,
        hitBonus: 0,
        hitRate: 100,
        evasionBase: 0,
        evasionBonus: 0,
        evasionRate: 0,
        criticalRate: 0,
        criticalResistance: 0,
        criticalDamage: 0,
        criticalDamageResistance: 0,
        weaponBlock: 0,
        shieldBlock: 0,
        physicalResistance: 0,
        magicResistance: 0,
        baseExperience: 0,
        experience: 0,
      },
    ]),
  );
  const enemies = new Map(
    actors.slice(1).map(value => [
      value.id,
      createTestEnemy({
        key: value.id,
        definition: { ...catalog.enemies[0], acceptsBuffs: true, stateRules: undefined },
        level: 1,
        health: 10000,
        maxHealth: 10000,
      }),
    ]),
  );
  let current: string | undefined = 'enemy-0';
  const hitResolution = new CombatHitResolution();
  const harness = createCombatTestHarness({
    battleCatalog: catalog,
    items: { ...items, items: { ...items.items, weapon: baseWeapon } },
    conditions,
    hitResolution,
    hero,
    members: new Map([['player', hero]]),
    enemies,
    activeParty: () => ['player'],
    combatant: id => actors.find(value => value.id === id),
    combatants: () => actors,
    currentTargetOf: () => current,
    statsOverrides: {
      enemySnapshot: id => states.get(id),
    },
    settlementOverrides: {
      enemySnapshot: id => states.get(id),
      setEnemyHealth: (id, health) => {
        const s = states.get(id);
        if (s) s.health = health;
      },
      setReactionTarget: (_actorId, id) => {
        current = id;
      },
      threat: { damage: (_source: string, id: string, damage: number) => order.push(`hate:${id}:${damage}`) } as never,
      onShowHit: (event, hit) => order.push(`damage:${event.targetId}:${hit.damage}`),
      onStateConsequences: () => {},
    },
  });
  harness.stats.partyPassives = () => [];
  harness.stats.partyFighter = () => ({}) as never;
  harness.stats.actorAttributes = () => ({
    physicalAttack: hero.panel.physicalAttack,
    magicAttack: hero.panel.magicAttack,
    physicalDamageRate: 0,
    magicDamageRate: 0,
    stealthDamageRate: 0,
    primaryAttributes: primary,
    maxHealth: 1000,
    maxMana: 0,
  });

  const proc = () => hitResolution.run(() => harness.settlement.attackProc({ casterId: 'player', targetId: 'enemy-0' }, { kind: 'hit', damage: 100 }));
  const chance = (key: BattleStatKey, value: number) => conditions.setTemporaryAttribute('player', key, value);
  return {
    harness,
    hero,
    conditions,
    order,
    actors,
    states,
    enemies,
    equipment,
    proc,
    chance,
    select: (id: string | undefined) => {
      current = id;
    },
  };
}

test('actual temporary skill units cache equipment plus buffs and clear to the latest normal sources', () => {
  const f = fixture();
  f.equipment.numbers!.modifiers = [{ stat: 'fire', value: 100 }] as never;
  f.conditions.applyBuff('player', 'molten-armor', 1, {
    durationMs: 1000,
    tickMs: 0,
    states: [],
    periodic: [],
    modifiers: [{ attribute: 'fireSplashChance', operation: { kind: 'add', amount: 56 } }],
  });
  const event = { casterId: 'player', targetId: 'player', cueIndex: 0, skill: { id: 'firestorm', level: 1, action: catalog.skills.firestorm.action! } };
  assert.equal(f.harness.settlement.skillUnit(event), 'success');
  assert.equal(f.harness.stats.actorAttribute('player', 'fireSplashChance'), 212);
  (f.equipment.numbers!.modifiers[0] as unknown as { value: number }).value = 200;
  f.hero.bag.revision++;
  assert.equal(f.harness.stats.actorAttribute('player', 'fireSplashChance'), 212);
  assert.equal(f.harness.settlement.skillUnit({ ...event, cueIndex: 2 }), 'success');
  assert.equal(f.harness.stats.actorAttribute('player', 'fireSplashChance'), 256);
});

test('actual poison proc has no immediate damage and uses dynamic source damage on periodic ticks', t => {
  t.mock.method(Math, 'random', () => 0);
  const f = fixture();
  f.chance('poisonStrikeChance', 1000);
  f.proc();
  f.proc();
  f.proc();
  assert.equal(f.states.get('enemy-0')!.health, 10000);
  assert.equal(f.order.length, 0);
  assert.equal(f.conditions.snapshot('enemy-0')[0].stackCount, 3);
  f.hero.panel.physicalAttack = 201;
  f.conditions.update(60, tick => f.harness.settlement.periodicTick(tick));
  assert.equal(f.states.get('enemy-0')!.health, 9916);
  assert.deepEqual(f.order, ['hate:enemy-0:84', 'damage:enemy-0:84']);
});

test('zero direct elemental damage still installs its child, and immunity only rejects direct damage', t => {
  t.mock.method(Math, 'random', () => 0);
  const f = fixture();
  f.hero.panel.physicalAttack = 0;
  f.chance('frostStrikeChance', 1000);
  f.proc();
  assert.ok(f.conditions.hasBuff('enemy-0', 'attack-slow'));
  assert.equal(f.order.length, 0);
  f.hero.panel.physicalAttack = 101;
  f.conditions.applyState('enemy-0', 'damage-immune', 1000);
  f.chance('darknessStrikeChance', 1000);
  f.proc();
  assert.ok(f.conditions.hasBuff('enemy-0', 'darkness-strike-impact'));
  assert.equal(f.order.length, 0);
  f.enemies.get('enemy-0')!.definition.acceptsBuffs = false;
  f.conditions.removeBuff('enemy-0', 'attack-slow');
  f.proc();
  assert.equal(f.conditions.hasBuff('enemy-0', 'attack-slow'), false);
});

test('fire uses the live selected target, includes the primary and counts immune entries toward its sixteen slots', t => {
  t.mock.method(Math, 'random', () => 0);
  const f = fixture(17);
  f.chance('fireSplashChance', 1000);
  f.chance('poisonStrikeChance', 1000);
  f.conditions.applyState('enemy-0', 'damage-immune', 1000);
  f.select('enemy-8');
  f.proc();
  assert.equal(f.states.get('enemy-0')!.health, 10000);
  for (let i = 1; i < 16; i++) assert.equal(f.states.get(`enemy-${i}`)!.health, 9950);
  assert.equal(f.states.get('enemy-16')!.health, 10000);
  assert.equal(f.conditions.hasBuff('enemy-0', 'poisoned'), false);
});

test('reachable empty fire splash retries the probability and then continues without hanging', t => {
  const dice = [0, 0.999];
  const calls: number[] = [];
  t.mock.method(Math, 'random', () => {
    const value = dice.shift();
    assert.notEqual(value, undefined);
    calls.push(value!);
    return value!;
  });
  const f = fixture();
  f.actors[1].position.x = 32;
  f.chance('fireSplashChance', 56);
  f.proc();
  assert.deepEqual(calls, [0, 0.999]);
  assert.equal(f.order.length, 0);
});

test('shared feedback rolls occur before the visual availability gate, with periodic impact excluded', async t => {
  let domainRolls = 0;
  const hit = { kind: 'hit' as const, damage: 1 };
  const normalFeedback = {
    hit,
    style: 'weapon' as const,
    periodic: false,
    casterControlled: true,
    targetFriendly: false,
    targetParty: false,
    involvesControlled: true,
  };
  const periodicFeedback = { ...normalFeedback, periodic: true };
  selectFeedbackAssets(normalFeedback, catalog.feedback, () => {
    domainRolls++;
    return 0.5;
  }, true, feedbackPlan(normalFeedback));
  assert.equal(domainRolls, 2);
  selectFeedbackAssets(periodicFeedback, catalog.feedback, () => {
    domainRolls++;
    return 0.5;
  }, true, feedbackPlan(periodicFeedback));
  assert.equal(domainRolls, 3);

  let rolls = 0;
  t.mock.method(Math, 'random', () => {
    rolls++;
    return 0.5;
  });
  const world = await createTestWorldCombat();
  await world.combat.start();
  const showHit = Reflect.get(world.combat, 'showHit') as (
    event: { casterId: string; targetId: string },
    hit: { kind: 'hit'; damage: number },
    options: { periodic?: boolean },
  ) => void;
  const event = { casterId: 'player', targetId: 'enemy-0' };
  showHit.call(world.combat, event, hit, {});
  assert.equal(rolls, 2);
  showHit.call(world.combat, event, hit, { periodic: true });
  assert.equal(rolls, 3);
  world.combat.destroy();
});

test('equipment and buffs combine before the native probability threshold is clamped', () => {
  const f = fixture();
  f.equipment.numbers!.modifiers = [{ stat: 'fire', value: -100 }] as never;
  assert.equal(f.harness.stats.actorAttribute('player', 'fireSplashChance'), 0);
  const event = { casterId: 'player', targetId: 'player', cueIndex: 0, skill: { id: 'firestorm', level: 1, action: catalog.skills.firestorm.action! } };
  f.harness.settlement.skillUnit(event);
  assert.equal(f.harness.stats.actorAttribute('player', 'fireSplashChance'), 56);
});

test('cached negative thresholds bypass normal clamping and consecutive writes read that exact value', () => {
  const f = fixture();
  f.conditions.setTemporaryAttribute('player', 'fireSplashChance', -100);
  assert.equal(f.harness.stats.actorAttribute('player', 'fireSplashChance'), -100);
  const event = { casterId: 'player', targetId: 'player', cueIndex: 0, skill: { id: 'firestorm', level: 1, action: catalog.skills.firestorm.action! } };
  f.harness.settlement.skillUnit(event);
  assert.equal(f.harness.stats.actorAttribute('player', 'fireSplashChance'), -44);
  f.harness.settlement.skillUnit({ ...event, cueIndex: 2 });
  assert.equal(f.harness.stats.actorAttribute('player', 'fireSplashChance'), 0);
});

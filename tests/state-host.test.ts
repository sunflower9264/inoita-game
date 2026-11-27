import assert from 'node:assert/strict';
import test from 'node:test';
import type { BattleBuffEffect, CombatUnit, EnemyDefinition } from '../src/domain/battle.ts';
import type { BattleStateKey } from '../src/domain/battle-semantics.ts';
import { CombatConditions } from '../src/domain/combat-conditions.ts';
import type { ItemInstance } from '../src/domain/items.ts';
import { createCombatTestHarness, createTestEnemy, createTestMember, loadBattleCatalog } from './support/combat-test-harness.ts';

const catalog = loadBattleCatalog();
const attackStun = catalog.statusAttackBuffs!['attack-stun']!;
const stateUnit: CombatUnit = {
  effect: 'state',
  state: 'stun',
  ranks: [{
    chanceThreshold: 1000,
    durationMs: 1200,
    stateDurationProfile: { normal: { lastActiveFrame: 19 }, targetShortened: { lastActiveFrame: 9 } },
  }],
};
const baseEnemyDefinition: EnemyDefinition = {
  ...catalog.enemies[0],
  stateRules: undefined,
  acceptsBuffs: undefined,
};

function fixture() {
  const equipment: ItemInstance[] = [];
  const bag = {
    revision: 0,
    equipmentFor: () => Object.fromEntries(equipment.map((_, i) => [String(i), String(i)])),
    equipmentItems: (eq: Record<string, string | undefined>) => eq,
    get: (id: string) => equipment[Number(id)],
  };
  const member = createTestMember({ id: 'player', level: 1, maxHealth: 100, health: 100, bag });
  const enemy = createTestEnemy({ key: 'enemy', definition: structuredClone(baseEnemyDefinition), health: 100, maxHealth: 100 });
  const conditions = new CombatConditions();
  const consequences: (readonly BattleStateKey[])[] = [];
  const harness = createCombatTestHarness({
    battleCatalog: catalog,
    conditions,
    hero: member,
    members: new Map([['player', member]]),
    enemies: new Map([['enemy', enemy]]),
    activeParty: () => ['player'],
    settlementOverrides: {
      onStateConsequences: (_id, states) => {
        if (states.length) consequences.push(states);
      },
    },
  });
  const apply = (effect: BattleBuffEffect = attackStun, priority = 1, target = 'enemy', source = 'player') =>
    harness.settlement.applyActorBuff(target, 'attack-stun', priority, effect, source);
  const direct = (target = 'enemy', source = 'player', unit = stateUnit) =>
    harness.settlement.skillUnit({
      casterId: source,
      targetId: target,
      cueIndex: 0,
      skill: { id: 'state-test', level: 1, action: { cooldownFrames: 0, approachDistanceUnits: 1, searchRadiusPx: 64, transition: null, events: [], combatUnits: [unit] } },
    });
  return { harness, conditions, consequences, equipment, enemies: [enemy], apply, direct };
}

test('equipment positive immunity belongs to the recipient and rejects without a resistance roll', t => {
  t.mock.method(Math, 'random', () => assert.fail('guaranteed state with immunity must not roll'));
  const f = fixture();
  f.equipment.push({ numbers: { modifiers: [{ stat: 'stunResistance', value: 1 }], gemModifiers: [] } } as unknown as ItemInstance);
  assert.equal(f.direct('player', 'enemy'), 'failure');
  assert.equal(f.conditions.hasState('player', 'stun'), false);
  assert.equal(f.direct(), 'success');
  assert.equal(f.conditions.hasState('enemy', 'stun'), true);
  f.equipment[0].numbers!.modifiers[0].value = -5;
  f.conditions.setTemporaryAttribute('player', 'stunImmunity', -2);
  assert.equal(f.direct('player', 'enemy'), 'success');
  f.conditions.setTemporaryAttribute('player', 'stunImmunity', 1);
  assert.equal(f.direct('player', 'enemy'), 'failure');
});

test('generic resistance draws once for an enemy, while friendly state application skips it', t => {
  let rolls = 0;
  t.mock.method(Math, 'random', () => { rolls++; return 0; });
  const f = fixture();
  f.conditions.setTemporaryAttribute('enemy', 'stateResistance', 1000);
  assert.equal(f.direct(), 'failure');
  assert.equal(rolls, 1);
  assert.equal(f.direct('enemy', 'enemy'), 'success');
  assert.equal(rolls, 1);
});

test('compiled monster rules let the state expire before its buff, reject boss stun and reject whole buffs separately', () => {
  const normal = fixture(), short = fixture(), boss = fixture(), immune = fixture();
  short.enemies[0].definition.stateRules = { buffDurationScaleByState: { stun: 0.5 } };
  boss.enemies[0].definition.stateRules = { immuneStates: ['stun'], durationScale: 0.5 };
  immune.enemies[0].definition.acceptsBuffs = false;
  for (const f of [normal, short, boss]) assert.equal(f.apply(), true);
  assert.equal(immune.apply(), false);
  assert.equal(boss.conditions.hasState('enemy', 'stun'), false);
  assert.equal(boss.conditions.hasBuff('enemy', 'attack-stun'), true);
  normal.conditions.update(1440);
  short.conditions.update(1440);
  assert.equal(normal.conditions.hasState('enemy', 'stun'), true);
  assert.equal(short.conditions.hasState('enemy', 'stun'), false);
  assert.equal(short.conditions.hasBuff('enemy', 'attack-stun'), true);
  normal.conditions.update(480);
  assert.equal(normal.conditions.hasState('enemy', 'stun'), false);
});

test('weak buff rejection consumes no state roll; initialization sees the accepted new buff modifiers', t => {
  const f = fixture();
  let rolls = 0;
  t.mock.method(Math, 'random', () => { rolls++; return 0.9; });
  f.conditions.setTemporaryAttribute('enemy', 'stateResistance', 100);
  assert.equal(f.apply(attackStun, 2), true);
  assert.equal(rolls, 1);
  assert.equal(f.apply(attackStun, 1), false);
  assert.equal(rolls, 1);
  const effect = { ...attackStun, modifiers: [{ attribute: 'stunImmunity' as const, operation: { kind: 'set' as const, amount: 1 } }] };
  assert.equal(f.apply(effect, 3), true);
  assert.equal(rolls, 1);
  assert.equal(f.conditions.hasState('enemy', 'stun'), false);
  assert.equal(f.conditions.hasBuff('enemy', 'attack-stun'), true);
});

test('node exhaustion fails direct state but keeps an accepted buff without firing state consequences', () => {
  const f = fixture();
  for (let i = 0; i < 128; i++) assert.equal(f.conditions.applyStateFrames(`occupied-${i}`, 'sleep', 100), true);
  assert.equal(f.direct(), 'failure');
  assert.equal(f.apply(), true);
  assert.equal(f.conditions.hasState('enemy', 'stun'), false);
  assert.equal(f.conditions.hasBuff('enemy', 'attack-stun'), true);
  assert.equal(f.consequences.length, 0);
});

test('all exported direct states and state buffs carry independent frame profiles', () => {
  let direct = 0, buffs = 0;
  function visit(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    const object = value as Record<string, unknown>;
    if (object.effect === 'state') {
      const unit = value as Extract<CombatUnit, { effect: 'state' }>;
      for (const rank of unit.ranks) {
        assert.ok(rank.stateDurationProfile);
        assert.equal(rank.durationMs, (rank.stateDurationProfile.normal.lastActiveFrame + 1) * 60);
        direct++;
      }
    }
    if (Array.isArray(object.states) && object.states.length) {
      const effect = value as BattleBuffEffect;
      assert.ok(effect.simulationFrames);
      for (const state of effect.states) assert.ok(effect.stateDurationProfiles?.[state]);
      buffs++;
    }
    for (const entry of Object.values(object)) visit(entry);
  }
  // 两种成长各有 48 个公共技能状态档位及 8 个召唤命令状态档位（含 dragon-slam）。
  // 状态增益：两种成长各 40 个技能定义，另有 51 个怪物定义和 6 个属性攻击定义。
  visit(catalog);
  assert.equal(direct, 2 * (48 + 8));
  assert.equal(buffs, 2 * 40 + 51 + 6);
  assert.equal(catalog.enemies.filter(enemy => enemy.acceptsBuffs === false).length, 3);
  assert.equal(catalog.enemies.filter(enemy => enemy.stateRules?.durationScale === 0.5).length, 31);
});

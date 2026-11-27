import assert from 'node:assert/strict';
import test from 'node:test';
import { CombatConditions } from '../src/domain/combat-conditions.ts';
import { createCombatTestHarness, createTestMember, loadBattleCatalog, type TestMemberFixture } from './support/combat-test-harness.ts';

const catalog = loadBattleCatalog();

test('wrath of darkness uses each rank chance and immediately stacks on physical receipt even at zero damage', t => {
  t.mock.method(Math, 'random', () => 0);
  const conditions = new CombatConditions();
  let rank = 1;
  const defender = createTestMember({
    id: 'defender',
    classId: 'dark-knight',
  });
  defender.skills = {
    get version() {
      return rank;
    },
    resetVersion: 0,
    draft: () => ({ levels: { 'wrath-of-darkness': rank } }),
  } as unknown as TestMemberFixture['skills'];
  const harness = createCombatTestHarness({
    battleCatalog: catalog,
    conditions,
    members: new Map([['defender', defender]]),
    activeParty: () => ['defender'],
    settlementOverrides: {
      onStateConsequences: () => {},
    },
  });
  harness.stats.equipmentRecovery = () => ({ lifeDrainPerThousand: 0, manaRecoveryPerPulse: 0, manaCostReductionRate: 0 });
  harness.stats.actorAttribute = () => 0;
  harness.settlement.attackProc = () => {};

  const hit = (damageKind: 'physical' | 'magic', kind: 'hit' | 'miss' | 'critical' | 'weapon-block' | 'shield-block') =>
    harness.settlement.resolveHitReactions({ casterId: 'attacker', targetId: 'defender' }, { kind, damage: 0 }, damageKind, 'basic-attack');

  for (const [kind, outcome] of [
    ['physical', 'miss'],
    ['magic', 'hit'],
    ['magic', 'shield-block'],
  ] as const) {
    hit(kind, outcome);
  }
  assert.equal(conditions.hasBuff('defender', 'wrath-of-darkness'), false);
  for (const outcome of ['hit', 'critical', 'weapon-block', 'shield-block'] as const) hit('physical', outcome);
  assert.equal(conditions.attribute('defender', 'attackSpeedRate', 1000), 1400);
  for (let i = 0; i < 7; i++) hit('physical', 'hit');
  assert.equal(conditions.attribute('defender', 'attackSpeedRate', 1000), 2000);
  assert.equal(conditions.snapshot('defender')[0].stackCount, 10);
  assert.equal(conditions.snapshot('defender')[0].sourceId, 'defender');
  conditions.update(3660);
  assert.equal(conditions.hasBuff('defender', 'wrath-of-darkness'), true);
  hit('physical', 'hit');
  conditions.update(3660);
  assert.equal(conditions.hasBuff('defender', 'wrath-of-darkness'), true);
  conditions.update(60);
  assert.equal(conditions.attribute('defender', 'attackSpeedRate', 1000), 1000);
  for (const [index, chance] of [120, 180, 220, 240, 260, 280, 300, 320].entries()) {
    rank = index + 1;
    const reaction = catalog.skills['wrath-of-darkness'].reactionsByRank![index][0];
    assert.equal(reaction.kind, 'wrath-of-darkness');
    if (reaction.kind !== 'wrath-of-darkness') continue;
    assert.equal(reaction.chanceThreshold, chance);
    assert.deepEqual(reaction.buff.effect.simulationFrames, { lastActiveFrame: 60 });
    assert.equal(reaction.buff.effect.maxStacks, 10);
    conditions.clear();
    hit('physical', 'hit');
    assert.equal(conditions.attribute('defender', 'attackSpeedRate', 1000), 1100);
  }
});

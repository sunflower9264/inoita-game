import assert from 'node:assert/strict';
import test from 'node:test';
import type { BattleBuffEffect, EnemyDefinition } from '../src/domain/battle.ts';
import { resolveBuffReactions, type BuffReaction } from '../src/domain/buff-reactions.ts';
import { CombatConditions } from '../src/domain/combat-conditions.ts';
import { frameStateDurationProfile } from '../src/domain/state-application.ts';
import { createCombatTestHarness, createTestEnemy, createTestMember, loadBattleCatalog } from './support/combat-test-harness.ts';

const catalog = loadBattleCatalog();
const unit = catalog.skills['survival-instinct'].action!.combatUnits![0] as {
  effect: 'buff';
  buff: 'survival-instinct';
  ranks: { strength: number; effect: BattleBuffEffect }[];
};
const caps = [90, 120, 150, 180, 195, 210, 225, 240];

test('eight ranks keep the block rate, the stun parameter and the 240 frame cap', () => {
  unit.ranks.forEach((rank, index) => {
    const effect = rank.effect;
    assert.deepEqual(effect.modifiers, [
      { attribute: 'weaponBlock', operation: { kind: 'add', amount: 300 } },
      { attribute: 'weaponBlockCounterStunDuration', operation: { kind: 'add', amount: 20 } },
    ], `rank ${index + 1}`);
    assert.deepEqual(effect.reactions, [{ kind: 'weapon-block-stun', state: 'stun', durationAttribute: 'weaponBlockCounterStunDuration' }]);
    assert.equal(effect.simulationFrames?.lastActiveFrame, caps[index]);
    assert.equal(effect.durationMs, (caps[index] + 1) * 60);
    assert.equal(effect.maxStacks, 1);
  });
});

test('only a weapon block produces the counter stun', () => {
  const reactions = unit.ranks[0]!.effect.reactions as readonly BuffReaction[];
  const event = { ownerId: 'defender', opponentId: 'attacker', damageKind: 'physical' } as const;
  assert.deepEqual(
    resolveBuffReactions(reactions, { ...event, kind: 'weapon-block-stun', outcome: 'weapon-block' }),
    [{ kind: 'apply-state', attributeOwner: 'defender', targetId: 'attacker', state: 'stun', durationAttribute: 'weaponBlockCounterStunDuration' }],
  );
  for (const outcome of ['miss', 'hit', 'critical', 'shield-block'] as const)
    assert.deepEqual(resolveBuffReactions(reactions, { ...event, kind: 'weapon-block-stun', outcome }), [], outcome);
  assert.deepEqual(
    resolveBuffReactions(reactions, { ownerId: 'defender', opponentId: 'attacker', damageKind: 'magic', kind: 'weapon-block-stun', outcome: 'weapon-block' }),
    [],
  );
});

test('the attribute is a native duration parameter that the frame profile halves before converting', () => {
  assert.deepEqual(frameStateDurationProfile(20), { normal: { lastActiveFrame: 30 }, targetShortened: { lastActiveFrame: 15 } });
  assert.deepEqual(frameStateDurationProfile(21), { normal: { lastActiveFrame: 31 }, targetShortened: { lastActiveFrame: 15 } });
});

test('the scene stuns the attacker for thirty frames and honours immunity and shortening', () => {
  const command = { attributeOwner: 'defender', targetId: 'attacker', state: 'stun', durationAttribute: 'weaponBlockCounterStunDuration' } as const;
  const runCase = (stateRules?: EnemyDefinition['stateRules']) => {
    const conditions = new CombatConditions();
    const defender = createTestMember({ id: 'defender' });
    const enemy = createTestEnemy({ key: 'attacker', definition: { ...catalog.enemies[0], stateRules } });
    const harness = createCombatTestHarness({
      battleCatalog: catalog,
      conditions,
      hero: defender,
      members: new Map([['defender', defender]]),
      enemies: new Map([['attacker', enemy]]),
    });
    harness.stats.actorAttribute = () => 20;
    harness.settlement.applyReactionState(command);
    return { conditions, harness };
  };

  const normal = runCase();
  assert.equal(normal.conditions.hasState('attacker', 'stun'), true);
  assert.deepEqual(normal.harness.log.stateConsequences.map(entry => entry.states), [['stun']]);
  normal.conditions.update(30 * 60);
  assert.equal(normal.conditions.hasState('attacker', 'stun'), true);
  normal.conditions.update(60);
  assert.equal(normal.conditions.hasState('attacker', 'stun'), true);
  normal.conditions.update(60);
  assert.equal(normal.conditions.hasState('attacker', 'stun'), false);

  const immune = runCase({ immuneStates: ['stun'] });
  assert.equal(immune.conditions.hasState('attacker', 'stun'), false);

  const shortened = runCase({ durationScale: 0.5 });
  shortened.conditions.update(15 * 60);
  assert.equal(shortened.conditions.hasState('attacker', 'stun'), true);
  shortened.conditions.update(60);
  assert.equal(shortened.conditions.hasState('attacker', 'stun'), true);
  shortened.conditions.update(60);
  assert.equal(shortened.conditions.hasState('attacker', 'stun'), false);
});

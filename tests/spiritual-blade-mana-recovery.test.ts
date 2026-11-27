import assert from 'node:assert/strict';
import test from 'node:test';
import type { BattleBuffEffect } from '../src/domain/battle.ts';
import { CombatConditions } from '../src/domain/combat-conditions.ts';
import type { AttackContact } from '../src/domain/combat.ts';
import type { PhysicalHit } from '../src/domain/physical-hit.ts';
import { createCombatTestHarness, createTestMember, loadBattleCatalog } from './support/combat-test-harness.ts';

const catalog = loadBattleCatalog();
const frameLifetimes = [90, 120, 150, 195, 210, 225, 240, 255];

type BuffUnit = { ranks: { effect: BattleBuffEffect }[] };
const unit = catalog.skills['spiritual-blade'].action!.combatUnits![0] as unknown as BuffUnit;

test('spiritual blade exports the mana reaction and frame lifetimes for every rank', () => {
  assert.equal(unit.ranks.length, 8);
  unit.ranks.forEach((rank, index) => {
    assert.deepEqual(rank.effect.reactions, [{ kind: 'mana-on-physical-success', amount: 4, effect: 'mana-recovery' }]);
    assert.deepEqual(rank.effect.simulationFrames, { lastActiveFrame: frameLifetimes[index] });
    assert.equal(rank.effect.durationMs, (frameLifetimes[index] + 1) * 60);
    assert.deepEqual(rank.effect.modifiers, [], 'the mana write is a reaction, not a numeric attribute');
  });
});

function fixture() {
  const member = () => createTestMember({ classId: 'assassin', level: 10, maxHealth: 1000, maxMana: 100, mana: 50 });
  const members = new Map([['player', member()], ['ally', member()]]);
  const conditions = new CombatConditions();
  const restored: [string, number][] = [];
  const played: [string, unknown[]][] = [];
  const harness = createCombatTestHarness({
    battleCatalog: catalog,
    conditions,
    hero: members.get('player'),
    members,
    activeParty: () => ['player'],
    settlementOverrides: {
      onShowEffects: (_actorId, id, effects) => {
        played.push([id, [...effects]]);
      },
    },
  });
  harness.stats.equipmentRecovery = () => ({ lifeDrainPerThousand: 0, manaRecoveryPerPulse: 0, manaCostReductionRate: 0 });
  harness.settlement.restoreMana = (id: string, amount: number) => {
    restored.push([id, amount]);
  };
  harness.settlement.react = () => {};
  const contact: AttackContact = { casterId: 'player', targetId: 'ally' };
  const strike = (kind: PhysicalHit['kind'], damageKind: 'physical' | 'magic' = 'physical') =>
    harness.settlement.resolveHitReactions(contact, { kind, damage: 0 }, damageKind, 'probe');
  const apply = () => conditions.applyBuff('player', 'spiritual-blade', 1, unit.ranks[0].effect, 'player');
  return { conditions, restored, played, strike, apply, clear: () => conditions.removeBuff('player', 'spiritual-blade') };
}

test('an active spiritual blade restores mana after every physical outcome, including a zero-damage block', () => {
  const f = fixture();
  f.apply();
  for (const kind of ['hit', 'critical', 'weapon-block', 'shield-block'] as const) {
    f.restored.length = 0;
    f.played.length = 0;
    f.strike(kind);
    assert.deepEqual(f.restored, [['player', 4]], `${kind} must restore the caster's mana`);
    assert.deepEqual(
      f.played,
      [['player', [{ effect: 'mana-recovery', recipient: 'target', placement: 'attached' }]]],
      `${kind} must play the attached effect even when the pool is full`,
    );
  }
});

test('a miss and a magic hit produce neither the restore nor the effect', () => {
  const f = fixture();
  f.apply();
  f.strike('miss');
  f.strike('hit', 'magic');
  assert.equal(f.restored.length, 0);
  assert.equal(f.played.length, 0);
});

test('the reaction belongs to the active buff, so an expired spiritual blade stops restoring', () => {
  const f = fixture();
  f.apply();
  f.strike('hit');
  assert.deepEqual(f.restored, [['player', 4]]);
  f.clear();
  f.restored.length = 0;
  f.strike('hit');
  assert.equal(f.restored.length, 0, 'without the buff there is no mana write');
});

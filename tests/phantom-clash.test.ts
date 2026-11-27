import assert from 'node:assert/strict';
import test from 'node:test';
import { actionDamage } from '../src/domain/action-damage.ts';
import { CombatConditions } from '../src/domain/combat-conditions.ts';
import { rollPhysicalHit, rollMagicHit, type PhysicalFighter, type PhysicalHit } from '../src/domain/physical-hit.ts';
import { resolveSkillUnitSequence } from '../src/domain/skill-unit-sequence.ts';
import {
  createCombatTestHarness,
  createTestEnemy,
  createTestMember,
  loadBattleCatalog,
} from './support/combat-test-harness.ts';

const catalog = loadBattleCatalog();
const skill = catalog.skills['phantom-clash'];
const action = skill.action!;
const units = action.combatUnits!;
const damage = units[0];
const buff = units[1];
assert.equal(damage.effect, 'physical');
assert.equal(buff.effect, 'buff');
if (damage.effect !== 'physical' || buff.effect !== 'buff') throw new Error('Phantom Clash units missing');
const ranks = buff.ranks;
const fighter: PhysicalFighter = {
  level: 10,
  physicalAttack: 100,
  hitBase: 100,
  hitBonus: 1000,
  evasionBase: 0,
  evasionBonus: 0,
  criticalRate: 0,
  criticalResistance: 0,
  criticalDamage: 0,
  criticalDamageResistance: 0,
  weaponBlock: 0,
  shieldBlock: 0,
  physicalResistance: 0,
};
const primary = { strength: 3, dexterity: 0, vitality: 0, intelligence: 4, mentality: 0 };

test('all eight phantom clash ranks preserve native damage weights, strength ordering and resistance reductions', () => {
  assert.deepEqual(
    units.map(unit => unit.effect),
    ['physical', 'buff', 'taunt'],
  );
  assert.equal(damage.source, 'bestNormalDamage');
  assert.deepEqual(damage.attributeWeights, { strength: 10, dexterity: 0, vitality: 0, intelligence: 12, mentality: 0 });
  assert.deepEqual(
    damage.ranks.map(rank => rank.operation),
    [2250, 2450, 2650, 2950, 3050, 3150, 3250, 3350].map(ratePerThousand => ({ kind: 'multiply-thousandth', ratePerThousand })),
  );
  assert.deepEqual(
    damage.ranks.map((_, index) =>
      actionDamage(damage, index + 1, {
        physicalAttack: 100,
        magicAttack: 137,
        bestNormalDamage: 137,
        maxHealth: 1000,
        primaryAttributes: primary,
      }),
    ),
    [324, 352, 381, 424, 439, 453, 468, 482],
  );
  assert.deepEqual(
    ranks.map(rank => rank.strength),
    [1002, 1004, 1006, 1009, 1010, 1011, 1012, 1013],
  );
  for (const [index, rank] of ranks.entries()) {
    assert.equal(rank.chanceThreshold, 1000);
    assert.deepEqual(
      rank.effect.modifiers,
      ['physicalResistanceBonus', 'magicResistance'].map(attribute => ({
        attribute,
        operation: { kind: 'decrease-thousandth', ratePerThousand: [140, 180, 220, 280, 300, 320, 340, 360][index] },
      })),
    );
  }
});

test('the debuff reduces only extra physical resistance and magic resistance, preserving raw defense and its rate', () => {
  const base = { ...fighter, defense: 260, defenseRate: 1000, physicalResistanceBonus: 101, magicResistance: 203 };
  for (const [index, rank] of ranks.entries()) {
    const conditions = new CombatConditions();
    conditions.applyBuff('target', 'phantom-clash', rank.strength, rank.effect);
    const current = conditions.fighter('target', base);
    const extra = [86, 82, 78, 72, 70, 68, 66, 64][index];
    assert.deepEqual([current.defense, current.defenseRate], [260, 1000]);
    assert.equal(current.physicalResistance, 666 + extra);
    assert.equal(current.magicResistance, [174, 166, 158, 146, 142, 138, 133, 129][index]);
    assert.equal(rollPhysicalHit(fighter, current, () => 0.5, 1000).damage, 334 - extra);
    assert.equal(rollMagicHit(fighter, current, 1000, () => 0.5).damage, 1000 - current.magicResistance!);
    conditions.removeBuff('target', 'phantom-clash');
    assert.deepEqual([conditions.fighter('target', base).physicalResistance, conditions.fighter('target', base).magicResistance], [767, 203]);
  }
});

test('all ranks retain the debuff through processing boundary 121 and remove it on boundary 122', () => {
  for (const rank of ranks) {
    assert.equal(rank.effect.durationMs, 7260);
    assert.equal(rank.effect.maxStacks, 1);
    assert.deepEqual(rank.effect.simulationFrames, { lastActiveFrame: 120 });
    assert.equal(rank.effect.tickMs, 0);
    assert.deepEqual(rank.effect.periodic, []);
    const conditions = new CombatConditions();
    conditions.applyBuff('target', 'phantom-clash', rank.strength, rank.effect, 'caster');
    conditions.update(120 * 60);
    assert.equal(conditions.hasBuff('target', 'phantom-clash'), true);
    conditions.update(60);
    assert.equal(conditions.hasBuff('target', 'phantom-clash'), true);
    conditions.update(59);
    assert.equal(conditions.hasBuff('target', 'phantom-clash'), true);
    conditions.update(1);
    assert.equal(conditions.hasBuff('target', 'phantom-clash'), false);
  }
});

test('weaker applications preserve source and age; stronger and equal applications refresh one layer', () => {
  const conditions = new CombatConditions();
  const apply = (index: number, source: string) => conditions.applyBuff('target', 'phantom-clash', ranks[index].strength, ranks[index].effect, source);
  apply(3, 'original');
  conditions.update(600);
  const before = conditions.captureState();
  assert.equal(apply(0, 'weak'), false);
  assert.deepEqual(conditions.captureState(), before);
  assert.equal(apply(7, 'strong'), true);
  assert.equal(conditions.snapshot('target').length, 1);
  assert.equal(conditions.snapshot('target')[0].sourceId, 'strong');
  assert.equal(conditions.snapshot('target')[0].stackCount, 1);
  conditions.update(121 * 60);
  assert.equal(conditions.hasBuff('target', 'phantom-clash'), true);
  assert.equal(apply(7, 'equal'), true);
  conditions.update(60);
  assert.equal(conditions.hasBuff('target', 'phantom-clash'), true);
  assert.equal(conditions.snapshot('target')[0].sourceId, 'equal');
  conditions.update(121 * 60);
  assert.equal(conditions.hasBuff('target', 'phantom-clash'), false);
});

function fixture() {
  const source = { ...fighter };
  const target = { ...fighter };
  const conditions = new CombatConditions();
  const hits: PhysicalHit[] = [];
  const taunts: string[] = [];
  const caster = createTestMember({
    id: 'caster',
    level: 10,
    maxHealth: 100,
    maxMana: 100,
    panel: { physicalAttack: 100, magicAttack: 137, attributes: primary },
  });
  const enemyDef = catalog.enemies.find(entry => entry.acceptsBuffs !== false && !entry.stateRules?.immuneToAllStates)!;
  const enemy = createTestEnemy({
    key: 'enemy',
    definition: enemyDef,
    health: 10000,
    maxHealth: 10000,
  });
  const harness = createCombatTestHarness({
    battleCatalog: catalog,
    conditions,
    hero: caster,
    members: new Map([['caster', caster]]),
    enemies: new Map([['enemy', enemy]]),
    activeParty: () => ['caster'],
    settlementOverrides: {
      onShowHit: (_event, hit) => hits.push(hit),
      onEnemyZeroHealth: undefined,
    },
  });
  harness.stats.partyFighter = () => source;
  harness.stats.enemyFighter = () => target;
  harness.settlement.resolveHitReactions = () => {};
  harness.threat!.taunt = (id: string) => {
    taunts.push(id);
  };
  const run = (level = 1) =>
    resolveSkillUnitSequence(units, {
      targets: () => ['enemy'],
      unit: (cueIndex, targetId) =>
        harness.settlement.skillUnit({
          casterId: 'caster',
          targetId,
          cueIndex,
          skill: { id: skill.id, level, action },
        }),
    });
  return { source, target, conditions, hits, taunts, run };
}

test('misses and non-miss zero damage skip both following units without poisoning an independent transition call', t => {
  t.mock.method(Math, 'random', () => 0.1);
  for (const failure of ['miss', 'zero'] as const) {
    const f = fixture();
    if (failure === 'miss') {
      f.source.hitBase = 0;
      f.source.hitBonus = 0;
      f.target.evasionBonus = 750;
    } else {
      f.target.physicalResistance = 1000;
    }
    assert.deepEqual(
      f.run().map(result => result.outcome),
      ['failure', 'skipped', 'skipped'],
    );
    assert.equal(f.hits[0].kind, failure === 'miss' ? 'miss' : 'hit');
    assert.equal(f.hits[0].damage, 0);
    assert.equal(f.conditions.hasBuff('enemy', 'phantom-clash'), false);
    assert.equal(f.taunts.length, 0);
    f.source.hitBase = 100;
    f.source.hitBonus = 1000;
    f.target.evasionBonus = 0;
    f.target.physicalResistance = 0;
    assert.deepEqual(
      f.run(8).map(result => result.outcome),
      ['success', 'success', 'success'],
    );
    assert.equal(f.hits.at(-1)!.damage, 482);
    assert.equal(f.conditions.hasBuff('enemy', 'phantom-clash'), true);
    assert.deepEqual(f.taunts, ['caster']);
    f.conditions.update(600);
    const before = f.conditions.captureState();
    assert.deepEqual(
      f.run(1).map(result => result.outcome),
      ['success', 'success', 'success'],
    );
    assert.deepEqual(f.conditions.captureState(), before);
    assert.deepEqual(f.taunts, ['caster', 'caster']);
  }
});

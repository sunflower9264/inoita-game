import assert from 'node:assert/strict';
import test from 'node:test';
import type { CombatUnit, NumericCombatUnit } from '../src/domain/battle.ts';
import type { PhysicalFighter, PhysicalHit } from '../src/domain/physical-hit.ts';
import { CombatConditions } from '../src/domain/combat-conditions.ts';
import { resolveSkillUnitSequence } from '../src/domain/skill-unit-sequence.ts';
import {
  createCombatTestHarness,
  createTestEnemy,
  createTestMember,
  loadBattleCatalog,
} from './support/combat-test-harness.ts';

const catalog = loadBattleCatalog();
const primary = { strength: 0, dexterity: 0, vitality: 0, intelligence: 0, mentality: 0 };
const damage = (effect: 'physical' | 'magic' = 'physical'): NumericCombatUnit => ({
  effect,
  source: 'physicalAttack',
  attributeWeights: primary,
  ranks: [{ fixedAddition: 0, operation: { kind: 'add', amount: 0 } }],
});
const buff = (chanceThreshold = 1000, strength = 1): CombatUnit => ({
  effect: 'buff',
  buff: 'dark-strike',
  ranks: [{ strength, chanceThreshold, effect: { durationMs: 1000, tickMs: 0, modifiers: [], states: [], periodic: [] } }],
});

function fixture() {
  const fighter: PhysicalFighter = {
    level: 1,
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
  const defender = { ...fighter };
  const conditions = new CombatConditions();
  const hits: PhysicalHit[] = [];
  const phases: string[] = [];
  const member = createTestMember({
    id: 'player',
    level: 1,
    maxHealth: 100,
    maxMana: 100,
    panel: { attributes: primary },
  });
  const normalEnemy = catalog.enemies.find(entry => entry.acceptsBuffs !== false && !entry.stateRules?.immuneToAllStates)!;
  const enemy = createTestEnemy({
    key: 'enemy',
    definition: structuredClone(normalEnemy),
    health: 100,
    maxHealth: 100,
  });
  const harness = createCombatTestHarness({
    battleCatalog: catalog,
    conditions,
    hero: member,
    members: new Map([['player', member]]),
    enemies: new Map([['enemy', enemy]]),
    activeParty: () => ['player'],
    combatant: id => ({ id, team: id === 'player' ? 'party' : 'hostile', position: { x: 0, y: 0 }, bounds: { x: -4, y: -4, width: 8, height: 8 } }),
    settlementOverrides: {
      onShowHit: (_event, hit) => hits.push(hit),
      onStateConsequences: () => phases.push('state'),
    },
  });
  harness.stats.partyFighter = () => fighter;
  harness.stats.enemyFighter = () => defender;
  harness.stats.actorAttribute = (_id: string, key: string) => (['physicalAttack', 'magicAttack', 'maxHealth'].includes(key) ? 100 : 0);
  harness.stats.actorAttributes = () => ({
    physicalAttack: 100,
    magicAttack: 100,
    maxHealth: 100,
    physicalDamageRate: 0,
    magicDamageRate: 0,
    stealthDamageRate: 0,
    primaryAttributes: primary,
  });
  harness.settlement.settleHit = (_event, hit) => hits.push(hit);
  harness.settlement.resolveHitReactions = () => phases.push('reactions');
  harness.threat!.taunt = () => phases.push('taunt');
  harness.threat!.state = () => {};
  const run = (units: CombatUnit[], targets = (_index: number) => ['enemy']) =>
    resolveSkillUnitSequence(units, {
      targets,
      unit: (cueIndex, targetId) =>
        harness.settlement.skillUnit({
          casterId: 'player',
          targetId,
          cueIndex,
          skill: { id: 'test', level: 1, action: { combatUnits: units } as never },
        }),
    });
  return { enemy, fighter, defender, conditions, hits, phases, run };
}

test('real damage results gate later units, including positive physical and magic blocks', t => {
  t.mock.method(Math, 'random', () => 0.1);
  for (const kind of ['physical', 'magic'] as const) {
    for (const outcome of ['miss', 'zero', 'hit', 'weapon-block', 'shield-block'] as const) {
      if (kind === 'magic' && outcome === 'weapon-block') continue;
      const f = fixture();
      if (outcome === 'miss') {
        f.fighter.hitBonus = 0;
        f.fighter.hitBase = 0;
        f.defender.evasionBonus = 750;
      }
      if (outcome === 'zero') {
        f.defender.physicalResistance = 1000;
        f.defender.magicResistance = 1000;
      }
      if (outcome === 'weapon-block') f.defender.weaponBlock = 500;
      if (outcome === 'shield-block') f.defender.shieldBlock = 500;
      const result = f.run([damage(kind), buff(), { effect: 'taunt' }]);
      const succeeds = outcome !== 'miss' && outcome !== 'zero';
      assert.deepEqual(
        result.map(row => row.outcome),
        succeeds ? ['success', 'success', 'success'] : ['failure', 'skipped', 'skipped'],
        `${kind}/${outcome}`,
      );
      assert.equal(f.conditions.hasBuff('enemy', 'dark-strike'), succeeds);
      assert.equal(f.phases.includes('taunt'), succeeds);
      assert.equal(f.hits[0].kind, outcome === 'zero' ? 'hit' : outcome);
    }
  }
});

test('chance failure consumes its roll, guaranteed weak buff rejection remains successful', t => {
  let rolls = 0;
  t.mock.method(Math, 'random', () => {
    rolls++;
    return 0.1;
  });
  const f = fixture();
  assert.deepEqual(
    f.run([buff(0), { effect: 'taunt' }]).map(row => row.outcome),
    ['failure', 'skipped'],
  );
  assert.equal(rolls, 1);
  f.run([buff(1000, 10)]);
  assert.equal(rolls, 1);
  assert.deepEqual(
    f.run([buff(1000, 1), { effect: 'taunt' }]).map(row => row.outcome),
    ['success', 'success'],
  );
  assert.equal(rolls, 1);
  assert.equal(f.phases.at(-1), 'taunt');
});

test('enemy damage immunity rejects before rolls and reactions; self buff remains allowed', t => {
  t.mock.method(Math, 'random', () => assert.fail('immune entry must not draw'));
  const f = fixture();
  f.conditions.applyState('enemy', 'damage-immune', 1000, 'enemy');
  assert.deepEqual(
    f.run([damage(), buff()]).map(row => row.outcome),
    ['failure', 'skipped'],
  );
  assert.deepEqual(f.hits, [{ kind: 'hit', damage: 0 }]);
  assert.equal(f.phases.length, 0);
  f.conditions.applyState('player', 'damage-immune', 1000, 'player');
  assert.equal(f.run([buff()], () => ['player'])[0].outcome, 'success');
});

test('state probability and rejection block following units, refreshing an accepted state succeeds', t => {
  let rolls = 0;
  t.mock.method(Math, 'random', () => {
    rolls++;
    return 0.1;
  });
  const f = fixture();
  const state: CombatUnit = { effect: 'state', state: 'stun', ranks: [{ chanceThreshold: 0, durationMs: 1000 }] };
  assert.deepEqual(
    f.run([state, { effect: 'taunt' }]).map(row => row.outcome),
    ['failure', 'skipped'],
  );
  assert.equal(rolls, 1);
  state.ranks[0].chanceThreshold = 1000;
  f.enemy.definition.stateRules = { immuneStates: ['stun'] };
  assert.equal(f.run([state])[0].outcome, 'failure');
  assert.equal(rolls, 1);
  f.enemy.definition.stateRules = undefined;
  assert.equal(f.run([state])[0].outcome, 'success');
  assert.equal(f.run([state, { effect: 'taunt' }])[1].outcome, 'success');
});

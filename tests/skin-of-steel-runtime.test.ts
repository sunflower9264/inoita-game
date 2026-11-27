import assert from 'node:assert/strict';
import test from 'node:test';
import { BattleCharacter } from '../src/domain/character-stats.ts';
import { CombatConditions } from '../src/domain/combat-conditions.ts';
import { CombatHitResolution } from '../src/domain/combat-hit-resolution.ts';
import type { BattleBuffEffect, NumericCombatUnit } from '../src/domain/battle.ts';
import type { PhysicalFighter, PhysicalHit } from '../src/domain/physical-hit.ts';
import {
  createCombatTestHarness,
  loadBattleCatalog,
  loadCharacterStatsCatalog,
  loadItemCatalog,
} from './support/combat-test-harness.ts';

const catalog = loadBattleCatalog();
const items = loadItemCatalog();
const stats = loadCharacterStatsCatalog();

function fixture(magicResistance = 200) {
  const hero = new BattleCharacter('warrior', stats, items);
  const ally = new BattleCharacter('warrior', stats, items);
  const item = hero.bag.get(hero.bag.equipment['main-hand']!)!;
  const held = new Set(hero.bag.entries.map(entry => entry.id));
  hero.bag.receiveDrop({ ...item, numbers: { ...item.numbers!, modifiers: [{ stat: 'magicResistance', value: magicResistance }], gemModifiers: [] } });
  hero.bag.equip(hero.bag.entries.find(entry => !held.has(entry.id))!.id, 'main-hand');
  let rank = 1;
  let allyRank = 0;
  const configuration = (value: () => number) => ({
    get version() {
      return value();
    },
    resetVersion: 0,
    draft: () => ({ levels: { 'skin-of-steel': value() } }),
  });
  Object.assign(ally, { skills: configuration(() => allyRank) });
  const conditions = new CombatConditions();
  let hit: PhysicalHit | undefined;
  const harness = createCombatTestHarness({
    battleCatalog: catalog,
    characterStats: stats,
    items,
    conditions,
    hitResolution: new CombatHitResolution(),
    hero,
    members: new Map([
      ['player', hero],
      ['ally', ally],
    ]),
    sessionSkills: () => configuration(() => rank) as never,
    party: () => ({ groupModifiers: () => ({}), groupModifierVersion: 0 }) as never,
    activeParty: () => ['player', 'ally'],
    combatant: id => ({ id, team: 'party', position: { x: 0, y: 0 }, bounds: { x: -4, y: -4, width: 8, height: 8 } }),
    settlementOverrides: {
      onShowHit: (_event, value) => {
        hit = value;
      },
    },
  });
  harness.settlement.resolveHitReactions = () => {};
  harness.settlement.settleHit = (_event, value) => {
    hit = value;
  };
  const fighter = (id = 'player') => harness.stats.partyFighter(id) as PhysicalFighter;
  const magic = (amount = 1000) => {
    const unit: NumericCombatUnit = {
      effect: 'magic',
      source: 'none',
      attributeWeights: { strength: 0, dexterity: 0, vitality: 0, intelligence: 0, mentality: 0 },
      ranks: [{ fixedAddition: amount, operation: { kind: 'keep' } }],
    };
    harness.settlement.skillUnit({
      casterId: 'ally',
      targetId: 'player',
      cueIndex: 0,
      skill: { id: 'test', level: 1, action: { combatUnits: [unit] } as never },
    });
    return hit!;
  };
  return {
    hero,
    ally,
    conditions,
    harness,
    fighter,
    magic,
    learn: (value: number) => {
      rank = value;
    },
    learnAlly: (value: number) => {
      allyRank = value;
    },
  };
}

const effect = (modifiers: BattleBuffEffect['modifiers']): BattleBuffEffect => ({ durationMs: 1000, tickMs: 0, states: [], periodic: [], modifiers });

test('real equipment panels feed each learned resistance exactly once through the shared party fighter', () => {
  const f = fixture();
  for (const [index, bonus] of [45, 65, 85, 115, 125, 135, 145, 155].entries()) {
    f.learn(index + 1);
    assert.equal(f.hero.panel.baseMagicResistance, 200);
    assert.equal(f.hero.panel.magicResistance, 200);
    assert.equal(f.fighter().magicResistance, 200 + bonus);
    assert.equal(f.fighter().physicalResistance, f.hero.panel.physicalResistance + bonus);
    assert.equal(f.harness.stats.actorAttribute('player', 'magicResistance'), 200 + bonus);
  }
  f.learn(0);
  assert.equal(f.fighter().magicResistance, 200);
  assert.equal(f.fighter().physicalResistance, f.hero.panel.physicalResistance);
});

test('high equipment magic resistance survives until after the learned passive and debuff, then caps the actual incoming spell', t => {
  t.mock.method(Math, 'random', () => 0.99);
  const f = fixture(800);
  assert.equal(f.hero.panel.baseMagicResistance, 800);
  assert.equal(f.hero.panel.magicResistance, 750);
  assert.equal(f.fighter().magicResistance, 750);
  assert.equal(f.magic().damage, 250);
  f.conditions.applyBuff('player', 'enrage', 1, effect([{ attribute: 'magicResistance', operation: { kind: 'subtract', amount: 100 } }]));
  assert.equal(f.harness.stats.actorAttribute('player', 'magicResistance'), 745);
  assert.equal(f.fighter().magicResistance, 745);
  assert.equal(f.magic().damage, 255);
});

test('signed equipment magic resistance and negative final resistance increase real magic damage', t => {
  t.mock.method(Math, 'random', () => 0.99);
  const f = fixture(-100);
  assert.equal(f.hero.panel.baseMagicResistance, -100);
  assert.equal(f.hero.panel.magicResistance, -100);
  assert.equal(f.fighter().magicResistance, -55);
  assert.equal(f.harness.stats.actorAttribute('player', 'magicResistance'), -55);
  assert.equal(f.magic(100).damage, 105);
});

test('native Phantom Clash and divine defense break modify learned bonuses while keeping the defense curve separate', () => {
  const f = fixture();
  const unit = catalog.skills['phantom-clash'].action!.combatUnits!.find(entry => entry.effect === 'buff');
  assert.equal(unit?.effect, 'buff');
  if (unit?.effect !== 'buff') throw new Error('missing phantom debuff');
  f.conditions.applyBuff('player', unit.buff, unit.ranks[0].strength, unit.ranks[0].effect);
  assert.equal(f.fighter().physicalResistance, f.hero.panel.physicalResistance + 38);
  assert.equal(f.fighter().magicResistance, 210);
  f.conditions.removeBuff('player', unit.buff);
  const divine = catalog.statusAttackBuffs?.['divine-defense-break'];
  assert.ok(divine);
  f.conditions.applyBuff('player', 'divine-defense-break', 1, divine);
  assert.equal(f.fighter().physicalResistance, f.hero.panel.physicalResistance);
  assert.equal(f.fighter().magicResistance, 0);
  f.conditions.removeBuff('player', 'divine-defense-break');
  assert.equal(f.fighter().magicResistance, 245);
});

test('each member keeps its own learned rank and explicit magic resistance caches bypass ordinary recomputation', t => {
  t.mock.method(Math, 'random', () => 0.99);
  const f = fixture();
  f.learnAlly(8);
  // 原式 trunc((400+(10+20*12)*10)/20)=145，佣兵八级 b=12。
  assert.equal(f.fighter('ally').magicResistance, 145);
  assert.equal(f.fighter().magicResistance, 245);
  f.conditions.setTemporaryAttribute('player', 'magicResistance', 1000);
  assert.equal(f.harness.stats.actorAttribute('player', 'magicResistance'), 1000);
  assert.equal(f.fighter().magicResistance, 1000);
  assert.equal(f.magic().damage, 0);
  const high = fixture(800);
  high.harness.settlement.skillUnit({
    casterId: 'player',
    targetId: 'player',
    cueIndex: 0,
    skill: {
      id: 'test',
      level: 1,
      action: { combatUnits: [{ effect: 'set-attribute', attribute: 'magicResistance', ranks: [{ kind: 'multiply-thousandth', ratePerThousand: 1200 }] }] } as never,
    },
  });
  assert.equal(high.harness.stats.actorAttribute('player', 'magicResistance'), 900);
  assert.equal(high.fighter().magicResistance, 900);
  assert.equal(high.magic().damage, 100);
});

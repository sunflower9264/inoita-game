import assert from 'node:assert/strict';
import test from 'node:test';
import type { BasicAttackDefinition, BattleBuffEffect, NumericCombatUnit, ResolvedBasicAttack, SkillAction } from '../src/domain/battle.ts';
import { CombatConditions } from '../src/domain/combat-conditions.ts';
import type { CombatActorAttributes } from '../src/domain/combat-damage-source.ts';
import { CombatHitResolution } from '../src/domain/combat-hit-resolution.ts';
import type { AttackContact, Combatant, SkillUnitHit } from '../src/domain/combat.ts';
import type { EnemySnapshot } from '../src/domain/enemy-stats.ts';
import type { PhysicalFighter, PhysicalHit } from '../src/domain/physical-hit.ts';
import {
  createCombatTestHarness,
  createTestEnemy,
  createTestMember,
  loadBattleCatalog,
  loadWardrobeCatalog,
  ZERO_PRIMARY_ATTRIBUTES,
} from './support/combat-test-harness.ts';

const catalog = loadBattleCatalog();
const wardrobe = loadWardrobeCatalog();
const primary = ZERO_PRIMARY_ATTRIBUTES;
const base = {
  level: 10, physicalAttack: 100, magicAttack: 0, baseDefense: 0, defense: 0, defenseRate: 0,
  maxHealth: 10000, maxMana: 100, hitBase: 100, hitBonus: 0, evasionBase: 0, evasionBonus: 0,
  criticalRate: 0, criticalResistance: 0, criticalDamage: 0, criticalDamageResistance: 0, weaponBlock: 0, shieldBlock: 0,
  physicalResistance: 0, physicalResistanceBonus: 0, magicResistance: 0, baseMagicResistance: 0, attributes: primary,
};

// Complete controlled source, independent of the still-unreviewed Whist content.
const stealthEffect = (enabled = 1, rate = 736): BattleBuffEffect => ({
  durationMs: 5460, tickMs: 0, simulationFrames: { lastActiveFrame: 90 }, maxStacks: 1,
  states: ['stealthed'], stateDurationProfiles: { stealthed: { normal: { lastActiveFrame: 135 } } }, periodic: [],
  modifiers: [
    { attribute: 'stealthAttackEnabled', operation: { kind: 'set', amount: enabled } },
    { attribute: 'stealthDamageRate', operation: { kind: 'add', amount: rate } },
  ],
});

function damageAction(effect: 'physical' | 'magic' = 'physical', source: NumericCombatUnit['source'] = 'none', amount = 100, skill = true): SkillAction {
  return {
    usesSkillDamageBuff: skill, events: [], cooldownFrames: 0, approachDistanceUnits: 4, searchRadiusPx: 64, transition: null,
    combatUnits: [{ effect, source, attributeWeights: { ...primary }, ranks: [{ fixedAddition: amount, operation: { kind: 'keep' } }] }],
  };
}

function resolved(definition: BasicAttackDefinition): ResolvedBasicAttack {
  return {
    ...definition, profileId: 'test', step: 0, stepCount: 1, effectiveCycleFrames: definition.cycleFrames,
    clips: { north: 'attack-north', south: 'attack-south', east: 'attack-east', west: 'attack-west' },
    sequence: { north: [], south: [], east: [], west: [] },
  };
}

function fixture() {
  const member = (id: string, physicalAttack: number, magicAttack: number) =>
    createTestMember({
      id,
      classId: 'warrior',
      level: 10,
      maxHealth: 10000,
      maxMana: 100,
      panel: { ...structuredClone(base), physicalAttack, magicAttack },
    });
  const player = member('player', 100, 0), ally = member('ally', 40, 90);
  const members = new Map([['player', player], ['ally', ally]]);
  const enemySnap = (overrides: Partial<EnemySnapshot>): EnemySnapshot => ({
    id: catalog.enemies[0].id,
    name: catalog.enemies[0].name,
    sceneLevel: false,
    elite: false,
    partySize: 1,
    baseExperience: 0,
    experience: 0,
    ...structuredClone(base),
    hitRate: 100,
    evasionRate: 0,
    health: 10000,
    mana: 100,
    ...overrides,
  });
  const stats = new Map<string, EnemySnapshot>([
    ['monster', enemySnap({ physicalAttack: 70, magicAttack: 60 })],
    ['target', enemySnap({})],
  ]);
  const enemies = new Map([
    ['monster', createTestEnemy({ key: 'monster', definition: catalog.enemies[0], level: 10, health: 10000, maxHealth: 10000 })],
    ['target', createTestEnemy({ key: 'target', definition: catalog.enemies[0], level: 10, health: 10000, maxHealth: 10000 })],
  ]);
  const actors = new Map([...members.keys(), ...stats.keys()].map((id, index): [string, Combatant] => [
    id,
    { id, team: members.has(id) ? 'party' : 'enemy', position: { x: index * 8, y: 0 }, bounds: { x: -4, y: -4, width: 8, height: 8 } },
  ]));
  const conditions = new CombatConditions();
  const hits: { event: AttackContact; hit: PhysicalHit }[] = [];
  const order: string[] = [];
  const harness = createCombatTestHarness({
    battleCatalog: catalog,
    wardrobe,
    conditions,
    hitResolution: new CombatHitResolution(),
    hero: player,
    members,
    enemies,
    activeParty: () => ['player', 'ally'],
    combatant: id => actors.get(id),
    combatants: () => [...actors.values()],
    statsOverrides: {
      enemySnapshot: id => stats.get(id),
    },
    settlementOverrides: {
      enemySnapshot: id => stats.get(id),
      setEnemyHealth: (id, health) => {
        const s = stats.get(id);
        if (s) s.health = health;
      },
      onActionSound: (_id, name) => order.push(`sound:${name}`),
      onDropMana: () => {},
      onShowHit: (event, hit) => {
        hits.push({ event, hit });
        order.push(`${conditions.canReceiveDamage(event.targetId) ? 'hit' : 'immune'}:${hit.damage}`);
      },
    },
  });
  harness.settlement.resolveHitReactions = () => {};
  harness.settlement.react = () => order.push('stealth-break');
  const event = (casterId = 'player', action = damageAction()): SkillUnitHit => ({
    casterId,
    targetId: casterId === 'monster' ? 'player' : 'target',
    cueIndex: 0,
    skill: { id: 'stealth-consumer-probe', level: 1, action },
  });
  const strike = (casterId = 'player', action = damageAction()) => {
    harness.settlement.skillUnit(event(casterId, action));
    return hits.at(-1)!.hit;
  };
  const buff = (id = 'player', enabled = 1, rate = 736) => conditions.applyBuff(id, 'whist', 1, stealthEffect(enabled, rate), id);
  const fighter = (id: string): PhysicalFighter =>
    members.has(id) ? harness.stats.partyFighter(id)! : harness.stats.enemyFighter(id, catalog.enemies[0], 10)!;
  return {
    harness, conditions, hits, order, player, ally, stats, actors, event, strike, buff, fighter,
    attributes: (id: string) => harness.stats.actorAttributes(id) as CombatActorAttributes,
  };
}

test('member, companion and monster consumers use their own complete stealth source and raw attacks', t => {
  t.mock.method(Math, 'random', () => 0.8);
  const f = fixture();
  for (const [id, rate, rawPhysical, rawMagic, normalPhysical, skillDamage] of [
    ['player', 736, 100, 0, 173, 190], ['ally', 500, 40, 90, 60, 75], ['monster', 1000, 70, 60, 140, 160],
  ] as const) {
    f.buff(id, 1, rate);
    const attributes = f.attributes(id), fighter = f.fighter(id);
    assert.equal(attributes.physicalAttack, rawPhysical, id);
    assert.equal(attributes.magicAttack, rawMagic, id);
    assert.equal(attributes.stealthDamageRate, rate, id);
    assert.equal(fighter.physicalAttack, normalPhysical, id);
    assert.equal(fighter.stealthAttackEnabled, true, id);
    assert.equal(fighter.stealthDamageRate, rate, id);
    assert.equal(f.strike(id, damageAction('physical', 'none', 10)).damage, skillDamage, id);
  }
  assert.equal(f.harness.stats.actorAttribute('ally', 'bestNormalDamage'), 90, 'the companion keeps its stronger magic candidate');
  assert.equal(f.harness.stats.actorAttribute('monster', 'bestNormalDamage'), 140);
});

test('the attribute gate is independent of state and rate, and skill terms truncate before either block', t => {
  t.mock.method(Math, 'random', () => 0.2);
  const stateOnly = fixture();
  stateOnly.conditions.applyState('player', 'stealthed', 10000);
  assert.equal(stateOnly.strike().damage, 100);
  assert.equal(stateOnly.attributes('player').stealthDamageRate, 0);
  const disabled = fixture();
  disabled.buff('player', 0, 736);
  assert.equal(disabled.strike().damage, 100);
  assert.equal(disabled.attributes('player').stealthDamageRate, 0);
  const zeroRate = fixture();
  zeroRate.buff('player', 1, 0);
  assert.equal(zeroRate.strike().damage, 200);
  const stateExpired = fixture(), shortState = stealthEffect();
  shortState.stateDurationProfiles = { stealthed: { normal: { lastActiveFrame: 0 } } };
  stateExpired.conditions.applyBuff('player', 'whist', 1, shortState);
  stateExpired.conditions.update(120);
  assert.equal(stateExpired.conditions.hasState('player', 'stealthed'), false);
  assert.equal(stateExpired.conditions.hasBuff('player', 'whist'), true);
  assert.equal(stateExpired.strike().damage, 346, 'a natural state expiry does not negate the remaining attribute source');
  const f = fixture();
  f.player.panel.physicalAttack = 101;
  f.buff();
  f.conditions.setTemporaryAttribute('player', 'physicalDamageRate', 137);
  assert.equal(f.strike('player', damageAction('physical', 'none', 104)).damage, 369);
  f.stats.get('target')!.weaponBlock = 300;
  assert.deepEqual(f.strike('player', damageAction('physical', 'none', 104)), { kind: 'weapon-block', damage: 258 });
  f.stats.get('target')!.weaponBlock = 0;
  f.stats.get('target')!.shieldBlock = 300;
  assert.deepEqual(f.strike('player', damageAction('physical', 'none', 104)), { kind: 'shield-block', damage: 111 });
});

test('MISS and damage immunity skip the extra raw-attack read, while a successful skill reads it after the hit die', t => {
  let rolls = 0;
  const f = fixture();
  f.buff();
  let reads = 0;
  const baseAttr = f.harness.stats.actorAttribute.bind(f.harness.stats);
  f.harness.stats.actorAttribute = (id, key) => {
    if (id === 'player' && key === 'physicalAttack') reads++;
    return baseAttr(id, key);
  };
  t.mock.method(Math, 'random', () => {
    rolls++;
    f.conditions.setTemporaryAttribute('player', 'physicalAttack', 200);
    return 0.2;
  });
  f.stats.get('target')!.evasionBonus = 750;
  assert.deepEqual(f.strike(), { kind: 'miss', damage: 0 });
  assert.equal(reads, 0);
  assert.equal(rolls, 1);
  f.conditions.applyState('target', 'damage-immune', 10000);
  f.strike();
  assert.equal(reads, 0);
  assert.equal(rolls, 1);
  f.conditions.removeState('target', 'damage-immune');
  f.stats.get('target')!.evasionBonus = 0;
  f.conditions.clearTemporaryAttribute('player', 'physicalAttack');
  assert.equal(f.strike().damage, 520, 'D1 uses its fixed 100 base; D2 reads 200 after the hit roll');
  assert.equal(reads, 1);
  assert.equal(rolls, 2);
});

test('actual normal and dual profiles receive ordinary stealth scaling without the extra skill term or skill-buff consumption', t => {
  t.mock.method(Math, 'random', () => 0.8);
  const f = fixture();
  f.buff();
  const bonus = catalog.skills['dark-strike'].action!.combatUnits!.find(unit => unit.effect === 'buff');
  assert.equal(bonus?.effect, 'buff');
  if (bonus?.effect !== 'buff') throw new Error('missing skill damage buff');
  f.conditions.applyBuff('player', bonus.buff, bonus.ranks[0].strength, bonus.ranks[0].effect);
  const ordinary = resolved(catalog.basicAttacks['longsword-slash']);
  const dual = resolved(wardrobe.dualWieldAttacks!['dagger:dagger']);
  f.harness.settlement.attackContact({ casterId: 'player', targetId: 'target', basicAttack: ordinary });
  f.harness.settlement.attackContact({ casterId: 'player', targetId: 'target', basicAttack: dual, hand: 'main-hand' });
  f.harness.settlement.attackContact({ casterId: 'player', targetId: 'target', basicAttack: dual, hand: 'offhand' });
  // With no weapon contributions in this fixture, the offhand uses half of raw P: 50 × 1736 / 1000.
  assert.deepEqual(f.hits.map(value => value.hit.damage), [300, 173, 86]);
  assert.equal(f.conditions.hasBuff('player', 'dark-strike'), true);
});

test('magic sourced from best normal damage benefits indirectly while raw magic and the magic hit multiplier stay unchanged', t => {
  t.mock.method(Math, 'random', () => 0.8);
  const f = fixture();
  f.player.panel.magicAttack = 160;
  assert.equal(f.strike('player', damageAction('magic', 'bestNormalDamage', 0)).damage, 160);
  f.buff();
  assert.equal(f.harness.stats.actorAttribute('player', 'bestNormalDamage'), 173);
  assert.equal(f.strike('player', damageAction('magic', 'bestNormalDamage', 0)).damage, 173);
  assert.equal(f.strike('player', damageAction('magic', 'magicAttack', 0)).damage, 160);
  f.conditions.setTemporaryAttribute('player', 'magicDamageRate', 100);
  assert.equal(f.strike('player', damageAction('magic', 'magicAttack', 0)).damage, 176);
});

test('each target reads its own current source attack, then dispatch removes the complete owner buff before the next dispatch', t => {
  t.mock.method(Math, 'random', () => 0.8);
  const f = fixture();
  f.buff();
  const action = damageAction(), event = f.event('player', action);
  const prepared = f.harness.settlement.prepareSkillUnit(event);
  f.harness.settlement.resolveHitReactions = () => f.conditions.setTemporaryAttribute('player', 'physicalAttack', 200);
  const playback = { caster: f.actors.get('player')!, facing: 'east' as const, basicAttack: null, skill: event.skill };
  f.harness.settlement.runActionDispatch(playback, { breaksStealth: true, sound: 'dispatch-tail' }, () => {
    f.harness.settlement.skillUnit({ ...event, preparedDamage: prepared });
    f.harness.settlement.skillUnit({ ...event, targetId: 'monster', preparedDamage: prepared });
    assert.equal(f.conditions.hasBuff('player', 'whist'), true);
  });
  assert.deepEqual(f.order, ['hit:346', 'hit:520', 'stealth-break', 'sound:dispatch-tail']);
  assert.equal(f.conditions.hasState('player', 'stealthed'), false);
  assert.equal(f.conditions.hasBuff('player', 'whist'), false);
  assert.equal(f.attributes('player').stealthDamageRate, 0);
  assert.equal(f.fighter('player').stealthAttackEnabled, false);
  f.conditions.clearTemporaryAttribute('player', 'physicalAttack');
  assert.equal(f.strike().damage, 100);
  const expiry = fixture();
  expiry.buff();
  expiry.conditions.update(91 * 60);
  assert.equal(expiry.strike().damage, 346);
  expiry.conditions.update(60);
  assert.equal(expiry.conditions.hasState('player', 'stealthed'), false);
  assert.equal(expiry.strike().damage, 100);
});

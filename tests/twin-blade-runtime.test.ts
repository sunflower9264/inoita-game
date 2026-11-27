import assert from 'node:assert/strict';
import test from 'node:test';
import type { ResolvedBasicAttack } from '../src/domain/battle.ts';
import { resolveBasicAttack } from '../src/domain/basic-attack.ts';
import { CombatConditions } from '../src/domain/combat-conditions.ts';
import type { AttackContact } from '../src/domain/combat.ts';
import type { ActorDefinition } from '../src/domain/content.ts';
import type { ItemInstance } from '../src/domain/items.ts';
import type { PhysicalHit } from '../src/domain/physical-hit.ts';
import {
  createCombatTestHarness,
  createTestMember,
  loadBattleCatalog,
  loadCharacterStatsCatalog,
  loadItemCatalog,
  loadWardrobeCatalog,
  type TestMemberFixture,
} from './support/combat-test-harness.ts';

const catalog = loadBattleCatalog();
const items = loadItemCatalog();
const wardrobe = loadWardrobeCatalog();
const stats = loadCharacterStatsCatalog();
const chanceBonuses = [30, 50, 80, 120, 130, 140, 150, 160], criticalBonuses = [76, 126, 201, 301, 326, 351, 376, 401];
// 原表 u03 各级 b；公式 563/565 分别 trunc((400+(1+20*b)*10)/20) 与 /8。
const companionScaling = [2, 4, 6, 8, 9, 10, 11, 12];
const companionChanceBonuses = companionScaling.map(b => Math.trunc((400 + (1 + 20 * b) * 10) / 20));
const companionCriticalBonuses = companionScaling.map(b => Math.trunc((400 + (1 + 20 * b) * 10) / 8));
type MemberId = 'player' | 'ally' | 'target';

function fixture() {
  // Controlled panels isolate this passive; World computes attributes, selection and both hits.
  const conditions = new CombatConditions();
  const hits: { sourceId: string; hand: AttackContact['hand']; hit: PhysicalHit }[] = [];
  const ranks: Record<MemberId, number> = { player: 1, ally: 8, target: 0 };
  const equipment: Record<MemberId, Record<string, string>> = { player: {}, ally: {}, target: {} };
  const entries = new Map<string, ItemInstance>();
  let bagRevision = 0;
  const item = (kind: string) => Object.keys(items.items).find(id => items.items[id].kind === kind && items.items[id].equipment)!;
  const equip = (id: MemberId, slot: 'main-hand' | 'off-hand' | 'body', kind: string | undefined, power = 0) => {
    bagRevision++;
    if (!kind) {
      delete equipment[id][slot];
      return;
    }
    const key = `${id}:${slot}`;
    equipment[id][slot] = key;
    entries.set(key, { id: key, item: item(kind), enhancement: 0, numbers: { baseAttack: power, modifiers: [], gemModifiers: [] } } as unknown as ItemInstance);
  };
  for (const id of ['player', 'ally'] as const) {
    equip(id, 'main-hand', 'longsword', 60);
    equip(id, 'off-hand', 'dagger', 40);
    equip(id, 'body', 'leather');
  }
  const bag = {
    get revision() { return bagRevision; },
    equipmentFor: (id: string) => equipment[id as MemberId],
    get: (id: string) => entries.get(id),
    equipmentItems: (value: Record<string, string | undefined>) =>
      Object.fromEntries(Object.entries(value).flatMap(([slot, id]) => (id ? [[slot, entries.get(id)!.item]] : []))),
  };
  const configuration = (id: MemberId) => ({
    get version() { return ranks[id]; },
    resetVersion: 0,
    draft: () => ({ levels: { 'twin-blade': ranks[id] } }),
  });
  const member = (id: MemberId) => {
    const m = createTestMember({
      id,
      classId: id === 'target' ? 'dark-knight' : 'assassin',
      level: 10,
      maxHealth: 1000,
      health: 1000,
      maxMana: 100,
      mana: 100,
      bag,
      panel: {
        physicalAttack: 101, magicAttack: 50, baseDefense: 0, defense: 0, defenseRate: 0, maxHealth: 1000, maxMana: 100,
        hitBase: 100, hitBonus: 1000, evasionBase: 0, evasionBonus: 0, criticalRate: 0, criticalResistance: 0, criticalDamage: 500,
        criticalDamageResistance: 0, weaponBlock: 0, shieldBlock: 0, physicalResistance: 0, baseMagicResistance: 0, magicResistance: 0,
        attributes: { strength: 0, dexterity: 0, vitality: 0, intelligence: 0, mentality: 0 },
      },
    });
    m.skills = configuration(id);
    return m;
  };
  const members = { player: member('player'), ally: member('ally'), target: member('target') };
  const harness = createCombatTestHarness({
    battleCatalog: catalog,
    items,
    wardrobe,
    characterStats: stats,
    conditions,
    hero: members.player,
    members: new Map(Object.entries(members)),
    activeParty: () => ['player', 'ally'],
    combatant: id => (id in members ? { id, team: id === 'target' ? 'enemy' : 'party', position: { x: 0, y: 0 }, bounds: { x: 0, y: 0, width: 8, height: 8 } } : undefined),
    statsOverrides: {
      skillConfiguration: (_id, m) => (m as unknown as TestMemberFixture).skills as never,
    },
    settlementOverrides: {
      onShowHit: () => {},
      onDropMana: () => {},
    },
  });
  harness.stats.equipmentRecovery = () => ({ lifeDrainPerThousand: 0, manaRecoveryPerPulse: 0, manaCostReductionRate: 0 });
  harness.settlement.attackProc = () => {};
  harness.settlement.settleHit = (event, hit) => hits.push({ sourceId: event.casterId, hand: event.hand, hit });
  const clips = Object.fromEntries(['dagger:dagger', 'longsword:dagger'].flatMap(stance =>
    Object.entries(wardrobe.stances[stance]).map(([name, key]) => [name, { frames: wardrobe.poses[key!].frames.length }])));
  const actor = { id: 'assassin-fixture', clips } as unknown as ActorDefinition;
  const normal = resolveBasicAttack(
    { basicAttacks: { normal: wardrobe.attacks['longsword:dagger'] } },
    { actor, basicAttack: { profileId: 'normal', clips: { north: 'attack-north', south: 'attack-south', east: 'attack-east', west: 'attack-west' } } },
  );
  const select = (id: MemberId = 'player') => harness.stats.selectBasicAttack(id, actor, normal) as ResolvedBasicAttack;
  const attribute = (id: MemberId, key: string) => harness.stats.actorAttribute(id, key as never);
  const contact = (sourceId: MemberId, profile: ResolvedBasicAttack, hand: 'main-hand' | 'offhand') =>
    harness.settlement.attackContact({ casterId: sourceId, targetId: 'target', basicAttack: profile, hand });
  return { harness, conditions, hits, ranks, members, equipment, entries, equip, select, attribute, contact, normal };
}

test('all eight Twin Blade ranks use the owning member’s learned values in real party attributes', () => {
  const f = fixture();
  for (const owner of ['player', 'ally'] as const) {
    const other = owner === 'player' ? 'ally' : 'player';
    f.ranks[other] = 0;
    for (let rank = 1; rank <= 8; rank++) {
      f.ranks[owner] = rank;
      assert.equal(f.attribute(owner, 'offhandAttackChance'), 190 + (owner === 'player' ? chanceBonuses : companionChanceBonuses)[rank - 1]);
      assert.equal(f.attribute(owner, 'criticalDamage'), 500 + (owner === 'player' ? criticalBonuses : companionCriticalBonuses)[rank - 1]);
      assert.equal(f.attribute(other, 'offhandAttackChance'), 190);
      assert.equal(f.attribute(other, 'criticalDamage'), 500);
    }
  }
});

test('the critical bonus follows only the main weapon while offhand chance remains unconditional', () => {
  const f = fixture();
  f.ranks.player = 8;
  for (const main of ['dagger', 'longsword', 'axe', 'mace', undefined]) {
    f.equip('player', 'main-hand', main, 60);
    for (const offhand of main ? ['dagger', 'longsword', 'shield', undefined] : [undefined]) {
      f.equip('player', 'off-hand', offhand, 40);
      assert.equal(f.attribute('player', 'criticalDamage'), 500 + (['dagger', 'longsword'].includes(main ?? '') ? 401 : 0));
      const weaponChance = offhand === 'dagger' ? 140 : offhand === 'longsword' ? 100 : 0;
      assert.equal(f.attribute('player', 'offhandAttackChance'), weaponChance + 50 + 160);
    }
  }
  f.equip('player', 'body', undefined);
  assert.equal(f.attribute('player', 'offhandAttackChance'), 160);
  assert.equal(f.attribute('player', 'criticalDamage'), 500, 'empty main has no default sword fallback');
});

test('real dual selection rolls once before the live chance and rejects an equal threshold for every rank', t => {
  const f = fixture(), order: string[] = [];
  let roll = 1;
  t.mock.method(Math, 'random', () => { order.push('roll'); return (roll - 0.5) / 999; });
  const original = f.harness.stats.actorAttribute.bind(f.harness.stats);
  f.harness.stats.actorAttribute = (id, key) => {
    if (key === 'offhandAttackChance') order.push(`chance:${id}`);
    return original(id, key);
  };
  for (const owner of ['player', 'ally'] as const) for (let rank = 1; rank <= 8; rank++) {
    f.ranks[owner] = rank;
    const threshold = 190 + (owner === 'player' ? chanceBonuses : companionChanceBonuses)[rank - 1];
    roll = threshold;
    order.length = 0;
    assert.equal(f.select(owner), f.normal);
    assert.deepEqual(order, ['roll', `chance:${owner}`]);
    roll = threshold - 1;
    order.length = 0;
    const selected = f.select(owner);
    assert.deepEqual(selected.strikes, [{ frame: 2, hand: 'main-hand' }, { frame: 5, hand: 'offhand' }]);
    assert.deepEqual(order, ['roll', `chance:${owner}`]);
  }
  f.ranks.player = 1;
  order.length = 0;
  t.mock.method(Math, 'random', () => { order.push('roll'); f.ranks.player = 8; return (300 - 0.5) / 999; });
  assert.notEqual(f.select(), f.normal, 'the rank changed by the draw is read after that draw');
  assert.deepEqual(order, ['roll', 'chance:player']);
});

test('positive learned chance cannot replace the requirement for a real offhand weapon', t => {
  const f = fixture();
  f.ranks.player = 8;
  t.mock.method(Math, 'random', () => assert.fail('no offhand weapon means no dual-wield roll'));
  for (const offhand of [undefined, 'shield']) {
    f.equip('player', 'off-hand', offhand);
    assert.equal(f.attribute('player', 'offhandAttackChance'), 210);
    assert.equal(f.select(), f.normal);
  }
});

test('both selected hands apply their own raw attack and the additive critical bonus exactly once', t => {
  const f = fixture();
  t.mock.method(Math, 'random', () => 0);
  for (const owner of ['player', 'ally'] as const) {
    f.members[owner].panel.criticalRate = 1000;
    for (let rank = 1; rank <= 8; rank++) {
      f.ranks[owner] = rank;
      const selected = f.select(owner);
      f.hits.length = 0;
      f.contact(owner, selected, 'main-hand');
      f.contact(owner, selected, 'offhand');
      const criticalRate = 1500 + (owner === 'player' ? criticalBonuses : companionCriticalBonuses)[rank - 1];
      assert.deepEqual(f.hits, [
        { sourceId: owner, hand: 'main-hand', hit: { kind: 'critical', damage: Math.trunc(101 * criticalRate / 1000) } },
        { sourceId: owner, hand: 'offhand', hit: { kind: 'critical', damage: Math.trunc(60 * criticalRate / 1000) } },
      ]);
    }
  }
  f.ranks.player = 1;
  f.conditions.setTemporaryAttribute('player', 'physicalDamageRate', 500);
  f.members.target.panel.criticalDamageResistance = 125;
  f.hits.length = 0;
  const selected = f.select();
  f.contact('player', selected, 'main-hand');
  f.contact('player', selected, 'offhand');
  assert.deepEqual(
    f.hits.map(entry => entry.hit),
    [{ kind: 'critical', damage: 207 }, { kind: 'critical', damage: 123 }],
    'damage-rate truncation precedes critical bonus, then target critical resistance truncates again',
  );
});

test('the second hand reads current learned critical damage and noncritical attacks do not consume the bonus', t => {
  const f = fixture();
  t.mock.method(Math, 'random', () => 0);
  f.members.player.panel.criticalRate = 1000;
  const selected = f.select();
  f.contact('player', selected, 'main-hand');
  f.ranks.player = 8;
  f.contact('player', selected, 'offhand');
  assert.deepEqual(f.hits.map(entry => entry.hit), [{ kind: 'critical', damage: 159 }, { kind: 'critical', damage: 114 }]);
  f.members.player.panel.criticalRate = 0;
  f.hits.length = 0;
  f.contact('player', selected, 'main-hand');
  f.contact('player', selected, 'offhand');
  assert.deepEqual(f.hits.map(entry => entry.hit), [{ kind: 'hit', damage: 101 }, { kind: 'hit', damage: 60 }]);
  assert.equal(f.attribute('player', 'criticalDamage'), 901);
});

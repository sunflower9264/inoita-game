import assert from 'node:assert/strict';
import test from 'node:test';
import type { ResolvedBasicAttack } from '../src/domain/battle.ts';
import { resolveBasicAttack } from '../src/domain/basic-attack.ts';
import { CombatConditions } from '../src/domain/combat-conditions.ts';
import { CombatHitResolution } from '../src/domain/combat-hit-resolution.ts';
import type { AttackContact } from '../src/domain/combat.ts';
import type { ActorDefinition } from '../src/domain/content.ts';
import type { ItemInstance } from '../src/domain/items.ts';
import type { PhysicalHit } from '../src/domain/physical-hit.ts';
import {
  createCombatTestHarness,
  createTestEnemy,
  createTestMember,
  loadBattleCatalog,
  loadCharacterStatsCatalog,
  loadContentCatalog,
  loadItemCatalog,
  loadWardrobeCatalog,
  type TestMemberFixture,
} from './support/combat-test-harness.ts';

const catalog = loadBattleCatalog();
const items = loadItemCatalog();
const wardrobe = loadWardrobeCatalog();
const characterStats = loadCharacterStatsCatalog();
const action = catalog.skills['storm-of-frenzy'].action!;

function fixture() {
  const conditions = new CombatConditions();
  const hitResolution = new CombatHitResolution();
  const order: string[] = [];
  const hits: number[] = [];
  const item = (kind: string) => Object.keys(items.items).find(key => items.items[key].kind === kind && items.items[key].equipment)!;
  const main = item('longsword'), offhand = item('dagger'), body = item('leather');
  const entries = new Map<string, ItemInstance>([
    ['main', { id: 'main', item: main, enhancement: 0, numbers: { baseAttack: 60, modifiers: [], gemModifiers: [] } } as unknown as ItemInstance],
    ['offhand', { id: 'offhand', item: offhand, enhancement: 0, numbers: { baseAttack: 40, modifiers: [], gemModifiers: [] } } as unknown as ItemInstance],
    ['body', { id: 'body', item: body, enhancement: 0 } as ItemInstance],
  ]);
  const equipment: Record<string, string | undefined> = { 'main-hand': 'main', 'off-hand': 'offhand', body: 'body' };
  const bag = {
    revision: 0,
    equipmentFor: () => equipment,
    get: (id: string) => entries.get(id),
    equipmentItems: (keys: Record<string, string | undefined>) =>
      Object.fromEntries(Object.entries(keys).flatMap(([slot, id]) => (id ? [[slot, entries.get(id)!.item]] : []))),
  };
  const base = {
    level: 10, physicalAttack: 100, magicAttack: 50, baseDefense: 0, defense: 0, defenseRate: 0, maxHealth: 1000, maxMana: 100,
    hitBase: 100, hitBonus: 1000, evasionBase: 0, evasionBonus: 0, criticalRate: 0, criticalResistance: 0, criticalDamage: 0,
    criticalDamageResistance: 0, weaponBlock: 0, shieldBlock: 0, physicalResistance: 0, magicResistance: 0,
    attributes: { strength: 0, dexterity: 0, vitality: 0, intelligence: 0, mentality: 0 },
  };
  let learned = 1;
  const skills = {
    get version() { return learned; },
    resetVersion: 0,
    draft: () => ({ levels: { 'storm-of-frenzy': learned, 'blood-thirst': 1 } }),
  };
  const member = (id: string, classId = 'warrior') => {
    const m = createTestMember({
      id,
      classId,
      level: 10,
      maxHealth: 1000,
      health: 500,
      maxMana: 100,
      mana: 100,
      panel: { ...base },
      bag,
    });
    m.skills = skills;
    const baseSetHealth = m.setHealth.bind(m);
    m.setHealth = (value: number) => {
      baseSetHealth(value);
      order.push(`heal:${value}`);
    };
    return m;
  };
  const player = member('player'), target = member('target', 'dark-knight'), near = member('near'), far = member('far'), fourth = member('fourth');
  const members = new Map([['player', player], ['target', target], ['near', near], ['far', far], ['fourth', fourth]]);
  const ids = ['player', 'near', 'far', 'fourth'];
  let onShowHit = (_event: AttackContact, _hit: PhysicalHit) => {};
  const harness = createCombatTestHarness({
    battleCatalog: catalog,
    items,
    wardrobe,
    characterStats,
    conditions,
    hitResolution,
    hero: player,
    members,
    activeParty: () => ids,
    combatant: id => {
      if (harness.enemies.has(id) || members.has(id)) {
        return { id, team: id === 'target' ? 'enemy' : 'party', position: { x: id === 'far' ? 9999 : 0, y: 0 }, bounds: { x: 0, y: 0, width: 8, height: 8 }, states: conditions.activeStates(id) };
      }
      return undefined;
    },
    statsOverrides: {
      skillConfiguration: (_id, m) => (m as unknown as TestMemberFixture).skills as never,
    },
    settlementOverrides: {
      onBuffApplication: () => assert.fail('these buffs have no application effect'),
      onShowEffects: (_actorId, _targetId, effects) => effects.forEach(effect => order.push(effect.effect)),
      onShowHit: (event, hit) => onShowHit(event, hit),
      onDropMana: () => {},
    },
  });
  harness.stats.equipmentRecovery = () => ({ lifeDrainPerThousand: 0, manaRecoveryPerPulse: 0, manaCostReductionRate: 0 });
  harness.settlement.attackProc = () => {};
  const baseSettleHit = harness.settlement.settleHit.bind(harness.settlement);
  harness.settlement.settleHit = (event, hit, enemy, presentation) => {
    hits.push(hit.damage);
    order.push(`damage:${hit.damage}`);
    baseSettleHit(event, hit, enemy, presentation);
  };
  const cast = (level = 1) => harness.settlement.skillUnit({ casterId: 'player', targetId: 'player', cueIndex: 0, skill: { id: 'storm-of-frenzy', action, level } });
  const contact = (kind: PhysicalHit['kind'] = 'hit', damageKind: 'physical' | 'magic' = 'physical', damage = 0) =>
    harness.settlement.resolveHitReactions({ casterId: 'player', targetId: 'target' }, { kind, damage }, damageKind, 'basic-attack');
  const stances = wardrobe.stances['longsword:dagger'];
  const actor = {
    id: 'test',
    clips: Object.fromEntries(Object.entries(stances).map(([name, key]) => [name, { frames: wardrobe.poses[key!].frames.length }])),
  } as unknown as ActorDefinition;
  const normal = resolveBasicAttack(
    { basicAttacks: { normal: wardrobe.attacks['longsword:dagger'] } },
    { actor, basicAttack: { profileId: 'normal', clips: { north: 'attack-north', south: 'attack-south', east: 'attack-east', west: 'attack-west' } } },
  );
  const select = () => harness.stats.selectBasicAttack('player', actor, normal) as ResolvedBasicAttack;
  return {
    harness, conditions, hitResolution, player, target, near, far, ids, order, hits, equipment, entries, cast, contact, select, normal, actor,
    learn: (rank: number) => { learned = rank; },
    onShowHit: (cb: typeof onShowHit) => { onShowHit = cb; },
  };
}

test('the parent gives the first three active party slots independent children at any distance without requiring visuals', () => {
  const f = fixture();
  f.cast(1);
  f.learn(8);
  f.contact();
  for (const id of ['player', 'near', 'far']) {
    const buff = f.conditions.snapshot(id).find(entry => entry.id === 'storm-of-frenzy-power')!;
    assert.ok(buff, id);
    assert.equal(buff.sourceId, 'player');
    assert.equal(buff.strength, 4003);
    assert.equal(f.harness.stats.actorAttribute(id, 'physicalDamageRate'), 80);
    assert.equal(f.harness.stats.actorAttribute(id, 'magicDamageRate'), 80);
  }
  assert.equal(f.conditions.hasBuff('fourth', 'storm-of-frenzy-power'), false);
  assert.equal(f.conditions.hasBuff('target', 'storm-of-frenzy-power'), false);
});

test('only physical successes grant stacks and immediate repeated zero-damage hits reach the five-layer cap', () => {
  for (const damageKind of ['physical', 'magic'] as const) for (const outcome of ['hit', 'critical', 'weapon-block', 'shield-block', 'miss'] as const) {
    const f = fixture();
    f.cast();
    for (let hit = 0; hit < 7; hit++) f.contact(outcome, damageKind, 0);
    assert.equal(f.harness.stats.actorAttribute('near', 'physicalDamageRate'), damageKind === 'physical' && outcome !== 'miss' ? 400 : 0);
  }
});

test('party eligibility keeps pending zero-HP slots, excludes formal defeats, and does not replace them with later slots', () => {
  const f = fixture();
  f.cast();
  f.near.player.health = 0;
  f.far.player.health = 0;
  f.harness.fallen.add('far');
  f.hitResolution.run(() => {
    f.hitResolution.deferDefeat('near', () => {});
    f.contact();
    assert.equal(f.conditions.hasBuff('near', 'storm-of-frenzy-power'), true);
    assert.equal(f.conditions.hasBuff('far', 'storm-of-frenzy-power'), false);
    assert.equal(f.conditions.hasBuff('fourth', 'storm-of-frenzy-power'), false);
  });
});

test('Blood Thirst completes before the party reaction and reflection observes the newly added layer', t => {
  t.mock.method(Math, 'random', () => 0);
  const f = fixture();
  f.cast();
  const blood = catalog.skills['blood-thirst'].action!;
  f.harness.settlement.skillUnit({ casterId: 'player', targetId: 'player', cueIndex: 0, skill: { id: 'blood-thirst', level: 1, action: blood } });
  const apply = f.harness.settlement.applyActorBuff.bind(f.harness.settlement);
  f.harness.settlement.applyActorBuff = (targetId, key, priority, effect, sourceId) => {
    if (key === 'storm-of-frenzy-power') f.order.push(`stack:${targetId}`);
    return apply(targetId, key, priority, effect, sourceId);
  };
  f.conditions.setTemporaryAttribute('target', 'moltenReflectionPerThousand', 100);
  f.harness.settlement.moltenReflection = () => f.order.push(`reflection:${f.harness.stats.actorAttribute('player', 'physicalDamageRate')}`);
  f.contact('hit', 'physical', 100);
  assert.deepEqual(f.order, ['heal:522', 'life-drain', 'stack:player', 'stack:near', 'stack:far', 'reflection:80']);
});

test('offhand selection uses real offhand equipment plus the active parent and fixes the dedicated two-hit profile', t => {
  const f = fixture();
  assert.equal(f.harness.stats.actorAttribute('player', 'offhandAttackChance'), 190);
  f.cast();
  assert.equal(f.harness.stats.actorAttribute('player', 'offhandAttackChance'), 340);
  const order: string[] = [];
  t.mock.method(Math, 'random', () => { order.push('roll'); return 0; });
  const original = f.harness.stats.actorAttribute.bind(f.harness.stats);
  f.harness.stats.actorAttribute = (id, key) => {
    if (key === 'offhandAttackChance') order.push('chance');
    return original(id, key);
  };
  const selected = f.select();
  assert.deepEqual(order, ['roll', 'chance']);
  assert.deepEqual(selected.strikes, [{ frame: 2, hand: 'main-hand' }, { frame: 5, hand: 'offhand' }]);
  assert.equal(selected.clips.east, 'dual-attack-east');
  assert.equal(selected.strikeFrame, 2);
  delete f.equipment['off-hand'];
  order.length = 0;
  assert.equal(f.select(), f.normal);
  assert.equal(order.length, 0);
});

test('main and offhand contacts use their live weapon powers and apply the damage multiplier once', t => {
  t.mock.method(Math, 'random', () => 0);
  const f = fixture(), profile = f.select();
  f.conditions.setTemporaryAttribute('player', 'physicalDamageRate', 500);
  f.harness.settlement.attackContact({ casterId: 'player', targetId: 'target', basicAttack: profile, hand: 'main-hand' });
  f.harness.settlement.attackContact({ casterId: 'player', targetId: 'target', basicAttack: profile, hand: 'offhand' });
  assert.deepEqual(f.hits, [150, 90]);
  f.entries.get('offhand')!.numbers!.baseAttack = 50;
  f.harness.settlement.attackContact({ casterId: 'player', targetId: 'target', basicAttack: profile, hand: 'offhand' });
  assert.equal(f.hits.at(-1), 105);
});

test('the first hit grants a damage layer for the offhand hit while preserving its already calculated damage', t => {
  t.mock.method(Math, 'random', () => 0);
  const f = fixture();
  f.cast();
  const profile = f.select();
  f.harness.settlement.attackContact({ casterId: 'player', targetId: 'target', basicAttack: profile, hand: 'main-hand' });
  f.harness.settlement.attackContact({ casterId: 'player', targetId: 'target', basicAttack: profile, hand: 'offhand' });
  assert.deepEqual(f.hits, [100, 64]);
  assert.equal(f.harness.stats.actorAttribute('player', 'physicalDamageRate'), 160);
});

test('immune targets receive zero feedback before either basic hand can roll or grant physical success reactions', t => {
  const f = fixture();
  f.cast();
  t.mock.method(Math, 'random', () => 0);
  const profile = f.select();
  f.harness.members.delete('target');
  f.harness.enemies.set('target', createTestEnemy({ key: 'target', definition: catalog.enemies[0] }));
  f.conditions.applyBuff('target', 'guardian-of-darkness', 1, { durationMs: 1000, tickMs: 0, states: ['damage-immune'], modifiers: [], periodic: [] });
  const feedback: PhysicalHit[] = [];
  f.onShowHit((_event, hit) => feedback.push(hit));
  t.mock.method(Math, 'random', () => assert.fail('hit and reaction rolls must occur after the immunity gate'));
  for (const extra of [{}, { basicAttack: profile, hand: 'main-hand' as const }, { basicAttack: profile, hand: 'offhand' as const }])
    f.harness.settlement.attackContact({ casterId: 'player', targetId: 'target', ...extra });
  assert.deepEqual(feedback, Array.from({ length: 3 }, () => ({ kind: 'hit', damage: 0 })));
  assert.equal(f.hits.length, 0);
  assert.equal(f.conditions.hasBuff('player', 'storm-of-frenzy-power'), false);
});

test('exported companion actors can select both real dual-wield variants without a costume renderer', t => {
  t.mock.method(Math, 'random', () => 0);
  const actors = Object.values(loadContentCatalog<{ actors: Record<string, ActorDefinition> }>('world').actors);
  const companions = actors.filter(actor => actor.clips['dual-attack-north']);
  assert.ok(companions.length > 0);
  const f = fixture(), dagger = Object.keys(items.items).find(key => items.items[key].kind === 'dagger' && items.items[key].equipment)!;
  const sword = f.entries.get('main')!.item;
  for (const actor of companions) for (const [item, clip, frames] of [[sword, 'dual-attack-north', 7], [dagger, 'dual-quick-attack-north', 5]] as const) {
    f.entries.get('main')!.item = item;
    const selected = f.harness.stats.selectBasicAttack('player', actor, f.normal) as ResolvedBasicAttack;
    assert.notEqual(selected, f.normal, actor.id);
    assert.equal(selected.clips.north, clip, actor.id);
    assert.equal(actor.clips[selected.clips.north]!.frames, frames, actor.id);
  }
});

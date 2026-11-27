import assert from 'node:assert/strict';
import test from 'node:test';
import { CombatConditions } from '../src/domain/combat-conditions.ts';
import type { PhysicalHit } from '../src/domain/physical-hit.ts';
import type { SkillReactionEvent } from '../src/domain/skill-reactions.ts';
import {
  createCombatTestHarness,
  createTestMember,
  loadBattleCatalog,
  loadWardrobeCatalog,
} from './support/combat-test-harness.ts';

const catalog = loadBattleCatalog();
const wardrobe = loadWardrobeCatalog();

test('host keeps physical block, attacker success and defender receipt in native order', () => {
  const phases: string[] = [];
  const conditions = new CombatConditions();
  conditions.removeState = () => {
    phases.push('wake');
  };
  const harness = createCombatTestHarness({ battleCatalog: catalog, conditions });
  harness.settlement.reactToBuff = () => {};
  harness.settlement.react = (event: SkillReactionEvent) => {
    phases.push(`${event.kind}:${event.ownerId}`);
  };
  harness.settlement.partySide = () => false;
  harness.settlement.summonOwnerReactions = () => {};
  harness.settlement.disturbanceReaction = () => {};
  harness.settlement.physicalSuccessEquipmentProcs = () => {};
  harness.settlement.instantRecoveryOnMiss = () => {};
  harness.settlement.attackProc = () => {
    phases.push('attribute-effects');
  };
  for (const outcome of ['weapon-block', 'shield-block'] as const) {
    phases.length = 0;
    harness.settlement.resolveHitReactions({ casterId: 'ally', targetId: 'enemy' }, { kind: outcome, damage: 12 }, 'physical', 'basic-attack');
    // 普攻不发 skill-attack-success；技能才发（见下面那两条魔法用例）。
    assert.deepEqual(phases, ['physical-block:enemy', 'attack-success:ally', 'physical-flare:ally', 'attack-effects:ally', 'physical-hit-received:enemy', 'wake', 'attribute-effects']);
  }
  for (const [damageKind, kind] of [
    ['physical', 'miss'],
    ['magic', 'shield-block'],
  ] as const) {
    phases.length = 0;
    harness.settlement.resolveHitReactions({ casterId: 'ally', targetId: 'enemy' }, { kind, damage: 0 }, damageKind, 'firestorm');
    assert.equal(phases.length, 0);
  }
  harness.settlement.resolveHitReactions({ casterId: 'ally', targetId: 'enemy' }, { kind: 'critical', damage: 12 }, 'magic', 'firestorm');
  assert.deepEqual(phases, ['skill-attack-success:ally', 'attack-success:ally', 'attack-effects:ally', 'wake', 'attribute-effects']);
});

test('soul sword reuses dark strike strength and reads the casting companion loadout', () => {
  const data = structuredClone(catalog);
  const conditions = new CombatConditions();
  const effects: string[] = [];
  data.skills['soul-sword'].companion!.reactionsByRank = data.skills['soul-sword'].ranks.map(() => [
    {
      kind: 'soul-sword',
      chanceThreshold: 1000,
      buffFromLearnedSkill: 'dark-strike',
      physicalEffects: ['soul-sword'],
      magicEffects: ['soul-sword-magic', 'soul-sword'],
    },
  ]);
  let rank = 1;
  const classId = data.classes.find(character => character.skills.includes('soul-sword'))!.id;
  const companion = createTestMember({ id: 'ally', classId });
  Object.assign(companion, {
    skills: {
      get version() {
        return rank;
      },
      resetVersion: 0,
      draft: () => ({ levels: { 'soul-sword': 1, 'dark-strike': rank } }),
    },
  });
  const harness = createCombatTestHarness({
    battleCatalog: data,
    conditions,
    members: new Map([['ally', companion]]),
    settlementOverrides: {
      onShowEffects: (_actorId, _targetId, list) => effects.push(...list.map(entry => entry.effect)),
    },
  });
  const event = {
    kind: 'attack-success',
    ownerId: 'ally',
    opponentId: 'enemy',
    damageKind: 'physical',
    outcome: 'hit',
    hitDamage: 100,
    otherLifeDrainPerThousand: 0,
  } as const;
  harness.settlement.react(event);
  const unit = data.skills['dark-strike'].companion!.action!.combatUnits!.find(entry => entry.effect === 'buff')!;
  assert.equal(unit.effect, 'buff');
  if (unit.effect !== 'buff') return;
  // Buff 0 公式 1064：trunc((4000+(a+20*b)*10)/20)，佣兵 a=1，一级 b=2。
  assert.equal(conditions.attribute('ally', 'skillDamageBonus', 0), 220);
  rank = 8;
  harness.settlement.react(event);
  assert.equal(conditions.attribute('ally', 'skillDamageBonus', 0), 320, '佣兵八级 b=12');
  assert.equal(conditions.snapshot('ally').filter(condition => condition.kind === 'buff').length, 1);
  assert.deepEqual(effects, ['soul-sword', 'soul-sword']);
  assert.deepEqual(harness.stats.learnedReactionBuff('ally', 'dark-strike'), {
    key: 'dark-strike',
    rankPriority: unit.ranks[7].strength,
    effect: unit.ranks[7].effect,
  });
});

test('basic attack resolves reaction healing before the fatal main damage is committed', () => {
  const order: string[] = [];
  const fighter = {
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
  const player = createTestMember({ id: 'player' });
  const ally = createTestMember({ id: 'ally' });
  const harness = createCombatTestHarness({
    battleCatalog: catalog,
    hero: player,
    members: new Map([
      ['player', player],
      ['ally', ally],
    ]),
    activeParty: () => ['player', 'ally'],
    memberActorDefinition: () => catalog.classes[0]!.actor,
    combatant: id => ({ id, team: 'party', position: { x: 0, y: 0 }, bounds: { x: -4, y: -4, width: 8, height: 8 } }),
  });
  harness.stats.partyFighter = () => fighter;
  const profile = catalog.basicAttacks[catalog.classes[0]!.basicAttack.profileId]!;
  harness.stats.equipmentAttack = () => ({
    ...profile,
    profileId: 'test',
    step: 0,
    stepCount: 1,
    effectiveCycleFrames: profile.cycleFrames,
    clips: { north: 'attack-north', south: 'attack-south', east: 'attack-east', west: 'attack-west' },
    sequence: { north: [], south: [], east: [], west: [] },
  });
  harness.stats.actorAttributes = () => ({
    ...fighter,
    magicAttack: 0,
    maxHealth: 1000,
    physicalDamageRate: 0,
    magicDamageRate: 0,
    stealthDamageRate: 0,
    primaryAttributes: { strength: 0, dexterity: 0, vitality: 0, intelligence: 0, mentality: 0 },
  });
  harness.settlement.resolveHitReactions = () => {
    order.push('reactions');
  };
  harness.settlement.settleHit = (_event, hit: PhysicalHit) => {
    assert.ok(hit.damage > 0);
    order.push('damage');
  };
  harness.settlement.attackContact({ casterId: 'player', targetId: 'ally' });
  assert.deepEqual(order, ['reactions', 'damage']);
});

test('blood sword combines the caster equipment rate and learned rank before healing', () => {
  const data = structuredClone(catalog);
  const classId = data.classes.find(character => character.skills.includes('blood-sword'))!.id;
  const effects: string[] = [];
  const conditions = new CombatConditions();
  const hero = createTestMember({
    id: 'player',
    classId,
    health: 20,
    maxHealth: 100,
    maxMana: 0,
    skillLevels: { 'blood-sword': 1 },
    bag: {
      revision: 0,
      equipmentFor: () => ({ 'main-hand': 'sword' }),
      equipmentItems: eq => eq,
      get: () => ({ id: 'sword', item: 'sword', quantity: 1, enhancement: 0, gems: [], numbers: { modifiers: [{ stat: 'lifeSteal', value: 50 }], gemModifiers: [], magicPercent: 0, sockets: 0, enhancementUses: 0 } }),
    },
  });
  const harness = createCombatTestHarness({
    battleCatalog: data,
    conditions,
    hero,
    members: new Map([['player', hero]]),
    sessionSkills: () => hero.skills as never,
    activeParty: () => ['player'],
    settlementOverrides: {
      onShowEffects: (_actorId, _targetId, list) => effects.push(...list.map(entry => entry.effect)),
    },
  });
  harness.settlement.attackProc = () => {};
  harness.settlement.resolveHitReactions({ casterId: 'player', targetId: 'enemy' }, { kind: 'hit', damage: 15 }, 'physical', 'basic-attack');
  const reaction = data.skills['blood-sword'].reactionsByRank![0].find(entry => entry.kind === 'blood-sword')!;
  assert.equal(reaction.kind, 'blood-sword');
  if (reaction.kind !== 'blood-sword') return;
  assert.equal(hero.player.health, 20 + Math.trunc((15 * (50 + reaction.lifeDrainPerThousand)) / 1000));
  assert.deepEqual(effects, ['life-drain']);
  const before = hero.player.health;
  harness.settlement.resolveHitReactions({ casterId: 'player', targetId: 'enemy' }, { kind: 'hit', damage: 15 }, 'magic', 'firestorm');
  assert.equal(hero.player.health, before);
  assert.deepEqual(effects, ['life-drain']);
});

test('attribute effects use the attacker class normal damage and require positive main damage', () => {
  const damage: number[] = [];
  const reads: string[] = [];
  let classId: string | null = 'warlock';
  const harness = createCombatTestHarness({
    battleCatalog: { ...catalog, statusAttackBuffs: {} },
    combatant: () => ({ id: 'enemy', team: 'party', position: { x: 0, y: 0 }, bounds: { x: -4, y: -4, width: 8, height: 8 } }),
    settlementOverrides: {
      memberOf: () => (classId ? createTestMember({ id: 'ally', classId }) : undefined) as never,
      groupModifiers: () => ({}),
    },
  });
  harness.stats.actorAttributes = () => ({
    physicalAttack: 100,
    magicAttack: 200,
    maxHealth: 1000,
    physicalDamageRate: 500,
    magicDamageRate: 100,
    stealthDamageRate: 0,
    primaryAttributes: { strength: 0, dexterity: 0, vitality: 0, intelligence: 0, mentality: 0 },
  });
  harness.stats.actorAttribute = (_id: string, key: string) => {
    reads.push(key);
    return key === 'darknessStrikeChance' ? 1000 : 0;
  };
  harness.settlement.settleHit = (_event, hit) => {
    damage.push(hit.damage);
  };
  const event = { casterId: 'ally', targetId: 'enemy' };
  for (const actorClass of ['warlock', 'priest', 'dark-knight', null]) {
    classId = actorClass;
    harness.settlement.attackProc(event, { kind: 'hit', damage: 1 });
  }
  assert.deepEqual(damage, [660, 660, 450, 450]);
  reads.length = 0;
  damage.length = 0;
  harness.settlement.attackProc(event, { kind: 'hit', damage: 0 });
  harness.settlement.attackProc(event, { kind: 'miss', damage: 0 });
  assert.equal(damage.length, 0);
  assert.equal(reads.length, 0);
});

test('contact uses the equipped attack formula and its physical or magical settlement', () => {
  const fighter = {
    level: 1,
    physicalAttack: 150,
    magicAttack: 200,
    physicalDamageRate: 500,
    magicDamageRate: 0,
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
  let stance = 'longsword:empty';
  const hits: { kind: string; amount: number }[] = [];
  const player = createTestMember({ id: 'player' });
  const ally = createTestMember({ id: 'ally' });
  const harness = createCombatTestHarness({
    battleCatalog: catalog,
    wardrobe,
    hero: player,
    members: new Map([
      ['player', player],
      ['ally', ally],
    ]),
    activeParty: () => ['player', 'ally'],
    memberActorDefinition: () => catalog.classes[0]!.actor,
    combatant: id => ({ id, team: 'party', position: { x: 0, y: 0 }, bounds: { x: -4, y: -4, width: 8, height: 8 } }),
  });
  harness.stats.partyFighter = () => fighter;
  harness.stats.equipmentAttack = () => {
    const profile = wardrobe.attacks[stance];
    return {
      ...profile,
      profileId: 'test',
      step: 0,
      stepCount: 1,
      effectiveCycleFrames: profile.cycleFrames,
      clips: { north: 'attack-north', south: 'attack-south', east: 'attack-east', west: 'attack-west' },
      sequence: { north: [], south: [], east: [], west: [] },
    };
  };
  harness.stats.actorAttributes = () => ({
    physicalAttack: 100,
    magicAttack: 200,
    physicalDamageRate: 500,
    magicDamageRate: 0,
    stealthDamageRate: 0,
    maxHealth: 1000,
    primaryAttributes: { strength: 0, dexterity: 0, vitality: 0, intelligence: 0, mentality: 0 },
  });
  harness.settlement.resolveHitReactions = (_event, hit: PhysicalHit, kind: 'physical' | 'magic') => {
    hits.push({ kind, amount: hit.damage });
  };
  harness.settlement.settleHit = () => {};
  harness.settlement.attackContact({ casterId: 'player', targetId: 'ally' });
  stance = 'staff:empty';
  harness.settlement.attackContact({ casterId: 'player', targetId: 'ally' });
  assert.deepEqual(hits, [
    { kind: 'physical', amount: 300 },
    { kind: 'magic', amount: 200 },
  ]);
});

test('灵魂之刃的回蓝排在防守方黑暗之怒之后、属性攻击之前', () => {
  const order: string[] = [];
  const manaReaction = { kind: 'mana-on-physical-success', amount: 7, effect: 'mana-recovery' } as const;
  const conditions = new CombatConditions();
  conditions.activeBuffReactions = () => [manaReaction];
  conditions.hasBuff = () => false;
  conditions.removeState = () => {};
  const harness = createCombatTestHarness({ battleCatalog: catalog, conditions });
  harness.settlement.reactToBuff = event => {
    if (event.kind === 'physical-success') order.push(`mana:${event.ownerId}`);
  };
  harness.settlement.react = event => {
    if (event.kind === 'physical-hit-received') order.push(`wrath:${event.ownerId}`);
  };
  harness.settlement.summonOwnerReactions = () => {};
  harness.settlement.partySide = () => false;
  harness.settlement.disturbanceReaction = () => {};
  harness.settlement.holySacrificeTransfer = () => {};
  harness.settlement.physicalSuccessEquipmentProcs = () => {};
  harness.settlement.lightningOfHellReaction = () => {};
  harness.settlement.attackProc = () => {
    order.push('attribute-effects');
  };
  harness.settlement.resolveHitReactions({ casterId: 'attacker', targetId: 'defender' }, { kind: 'hit', damage: 12 }, 'physical', 'basic-attack');
  assert.deepEqual(order, ['wrath:defender', 'mana:attacker', 'attribute-effects'], '回蓝在黑暗之怒之后、正伤门与属性攻击之前');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import type { BattleBuffEffect } from '../src/domain/battle.ts';
import { CombatConditions } from '../src/domain/combat-conditions.ts';
import { createCombatTestHarness, createTestMember, loadBattleCatalog, type TestMemberFixture } from './support/combat-test-harness.ts';

const catalog = loadBattleCatalog();
const parent = [catalog.skills['summon-bard'].action!.combatUnits!.find(unit => unit.effect === 'buff')!] as const;
if (parent[0].effect !== 'buff') throw new Error('missing summon bard buff');
const parentUnit = parent[0];
const child = [catalog.skills['bard-of-destruction'].reactionsByRank![0][0]] as const;
if (!('buff' in child[0])) throw new Error('missing bard of destruction child');
const resistance = [130, 150, 170, 200, 210, 220, 230, 240];
const caps = [105, 135, 165, 210, 225, 240, 255, 270];
const attackRates = [100, 140, 180, 240, 260, 280, 300, 320];

test('eight ranks resist both damage kinds on the frame clock and declare the accepted hook', () => {
  parentUnit.ranks.forEach((rank, index) => {
    const effect = rank.effect;
    assert.deepEqual(effect.modifiers, [
      { attribute: 'physicalResistanceBonus', operation: { kind: 'add', amount: resistance[index] } },
      { attribute: 'magicResistance', operation: { kind: 'add', amount: resistance[index] } },
    ], `rank ${index + 1}`);
    assert.deepEqual(effect.simulationFrames, { lastActiveFrame: caps[index] });
    assert.equal(effect.durationMs, (caps[index]! + 1) * 60);
    assert.equal(effect.maxStacks, 1);
    assert.deepEqual(effect.onAccepted, [{ kind: 'apply-learned-buff', skill: 'bard-of-destruction', target: 'source' }]);
    assert.ok(effect.appearanceColors?.length, '紫色循环保留');
  });
});

test('the child carries one layer of both attack rates and its own fallback lifetime', () => {
  catalog.skills['bard-of-destruction'].reactionsByRank!.forEach((rank, index) => {
    const reaction = rank[0] as { kind: string; buff: { key: string; rankPriority: number; effect: BattleBuffEffect } };
    assert.equal(reaction.kind, 'bard-of-destruction');
    assert.equal(reaction.buff.key, 'bard-of-destruction');
    assert.deepEqual(reaction.buff.effect.modifiers, [
      { attribute: 'physicalDamageRate', operation: { kind: 'add', amount: attackRates[index] } },
      { attribute: 'magicDamageRate', operation: { kind: 'add', amount: attackRates[index] } },
    ], `rank ${index + 1}`);
    assert.deepEqual(reaction.buff.effect.simulationFrames, { lastActiveFrame: caps[index] });
    assert.equal(reaction.buff.effect.maxStacks, 1);
    assert.ok(reaction.buff.effect.appearanceColors?.length, '红色循环');
  });
});

function fixture(casterRank = 8, plainRank = 0) {
  const conditions = new CombatConditions();
  const log: string[] = [];
  const member = (id: string, rank: number) => createTestMember({
    id,
    classId: 'warlock',
    maxHealth: 100,
    maxMana: 0,
    skillLevels: rank ? { 'bard-of-destruction': rank } : {},
  });
  const members = new Map([['player', member('player', casterRank)], ['plain', member('plain', plainRank)]]);
  const harness = createCombatTestHarness({
    battleCatalog: catalog,
    conditions,
    hero: members.get('player'),
    members,
    activeParty: () => ['player'],
    statsOverrides: {
      skillConfiguration: (_id, m) => (m as unknown as TestMemberFixture).skills as never,
    },
  });
  const baseAccepted = harness.settlement.applyAcceptedEffects.bind(harness.settlement);
  harness.settlement.applyAcceptedEffects = (sourceId, targetId, effect) => {
    // 只记父增益自己的那次；子增益身上没有接受钩子。
    if (effect.onAccepted?.length) log.push('accepted');
    baseAccepted(sourceId, targetId, effect);
  };
  const apply = (targetId: string, sourceId: string, rank: number) =>
    harness.settlement.applyActorBuff(
      targetId,
      'summon-bard',
      parentUnit.ranks[rank - 1]!.strength,
      parentUnit.ranks[rank - 1]!.effect,
      sourceId,
    );
  const childState = (id: string) => conditions.snapshot(id).find(entry => entry.id === 'bard-of-destruction');
  return { conditions, log, apply, childState };
}

test('an accepted parent gives the caster the child, copying the parent cap when it is present', () => {
  const run = fixture(8);
  assert.equal(run.apply('player', 'player', 1), true);
  const child = run.childState('player');
  assert.equal(child?.strength, 2013, '子增益按施法者八级的原版强度比较替换优先级');
  assert.equal(run.conditions.attribute('player', 'physicalDamageRate', 0), 320);
  // 施法者自己带着一级父增益（上限 105），所以子增益复制 105 而不是用它自己的 270。
  assert.equal(run.conditions.buffLifetimeFrames('player', 'bard-of-destruction'), 105);
  assert.equal(run.conditions.buffLifetimeFrames('player', 'summon-bard'), 105);
});

test('a parent on someone else leaves the child at its own formula cap', () => {
  const elsewhere = fixture(8);
  assert.equal(elsewhere.apply('plain', 'player', 1), true);
  assert.equal(elsewhere.childState('plain'), undefined, '来源是施法者，子增益不去目标身上');
  assert.equal(elsewhere.conditions.buffLifetimeFrames('player', 'bard-of-destruction'), 270, '没有父增益就用八级子自己的上限');
  // 反向对照：一级子增益遇到八级父增益，也按父的 270 而不是自己的 105。
  const weaker = fixture(1);
  assert.equal(weaker.apply('player', 'player', 8), true);
  assert.equal(weaker.conditions.buffLifetimeFrames('player', 'bard-of-destruction'), 270);
  assert.equal(weaker.conditions.attribute('player', 'physicalDamageRate', 0), 100, '三格属性仍取自己的一级');
});

test('a lower-rank parent is refused and creates nothing', () => {
  const run = fixture(8);
  assert.equal(run.apply('player', 'player', 8), true);
  assert.equal(run.conditions.buffLifetimeFrames('player', 'bard-of-destruction'), 270);
  assert.deepEqual(run.log, ['accepted']);
  // 低等级父增益被 applyBuff 直接拒绝，接受钩子一次都不进。
  assert.equal(run.apply('player', 'player', 1), false);
  assert.deepEqual(run.log, ['accepted'], '被拒绝时不执行接受钩子');
  assert.equal(run.conditions.buffLifetimeFrames('player', 'bard-of-destruction'), 270, '子增益保持在原来的上限');
  // 没学这个被动的人挂上父增益也不会建子增益。
  const plain = fixture(0);
  assert.equal(plain.apply('plain', 'plain', 1), true);
  assert.equal(plain.childState('plain'), undefined);
  assert.equal(plain.conditions.attribute('plain', 'physicalDamageRate', 0), 0);
});

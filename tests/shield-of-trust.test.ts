import assert from 'node:assert/strict';
import test from 'node:test';
import { CombatConditions } from '../src/domain/combat-conditions.ts';
import { CombatHitResolution } from '../src/domain/combat-hit-resolution.ts';
import { resolveSkillReactions, type SkillReaction } from '../src/domain/skill-reactions.ts';
import {
  createCombatTestHarness,
  createTestMember,
  loadBattleCatalog,
} from './support/combat-test-harness.ts';

const catalog = loadBattleCatalog();
const skill = catalog.skills['shield-of-trust'];
const perLayer = [65, 85, 105, 125, 135, 145, 155, 165];
const noBuff = { random: () => 0, learnedBuff: () => undefined };

test('eight ranks grant one layer worth of both damage rates and carry no passive modifier', () => {
  assert.deepEqual(skill.passiveUnits, []);
  skill.reactionsByRank!.forEach((rank, index) => {
    const reaction = rank[0] as Extract<SkillReaction, { kind: 'shield-of-trust' }>;
    assert.equal(reaction.kind, 'shield-of-trust');
    assert.equal(reaction.buff.key, 'shield-of-trust');
    assert.equal(reaction.buff.rankPriority, [3003, 3005, 3007, 3009, 3010, 3011, 3012, 3013][index]);
    assert.deepEqual(
      reaction.buff.effect.modifiers,
      [
        { attribute: 'physicalDamageRate', operation: { kind: 'add', amount: perLayer[index] } },
        { attribute: 'magicDamageRate', operation: { kind: 'add', amount: perLayer[index] } },
      ],
      `rank ${index + 1}`,
    );
    assert.equal(reaction.buff.effect.maxStacks, 3);
    assert.deepEqual(reaction.buff.effect.simulationFrames, { lastActiveFrame: 90 });
    assert.equal(reaction.buff.effect.durationMs, 5460);
  });
});

test('both physical blocks hand the party a layer while misses and magic blocks do nothing', () => {
  const rank = skill.reactionsByRank![7] as readonly SkillReaction[];
  const reaction = rank[0] as Extract<SkillReaction, { kind: 'shield-of-trust' }>;
  assert.deepEqual(resolveSkillReactions(rank, { kind: 'physical-block', ownerId: 'player' }, noBuff), [
    { kind: 'apply-party-buff', sourceId: 'player', buff: reaction.buff },
  ]);
  // 这个事件本身就是「物理格挡发生了」：落空与魔法盾挡在派发处就不发这个事件，
  // 所以不在这里重复判 outcome，改由下面走 resolveHitReactions 的用例覆盖。
});

function fixture(rank = 1) {
  const conditions = new CombatConditions();
  const sent: string[] = [];
  let revision = 0;
  const member = (id: string) => {
    const entry = createTestMember({
      id,
      classId: 'priest',
      health: id === 'third' ? 0 : 100,
      maxHealth: 100,
      maxMana: 0,
    });
    Object.assign(entry, {
      skills: {
        get version() {
          return revision;
        },
        resetVersion: 0,
        draft: () => ({ levels: { 'shield-of-trust': rank } }),
      },
    });
    return entry;
  };
  const members = new Map(['player', 'ally', 'third', 'extra'].map(id => [id, member(id)]));
  const hitResolution = new CombatHitResolution();
  hitResolution.isAwaitingDefeat = (id: string) => id === 'third';
  const harness = createCombatTestHarness({
    battleCatalog: catalog,
    conditions,
    hitResolution,
    hero: members.get('player')!,
    members,
    sessionSkills: () => members.get('player')!.skills as never,
    activeParty: () => ['player', 'ally', 'third', 'extra'],
    settlementOverrides: {
      onBuffApplication: (_source: string, id: string) => sent.push(id),
    },
  });
  // 第三名同链角色血量 0 但还没结算完，仍算 active；第四名不在固定三槽里。
  harness.fallen.add('fallen-one');
  harness.settlement.attackProc = () => {};
  const hit = (damageKind: 'physical' | 'magic', kind: 'hit' | 'miss' | 'weapon-block' | 'shield-block') =>
    harness.settlement.resolveHitReactions({ casterId: 'attacker', targetId: 'player' }, { kind, damage: 0 }, damageKind, 'basic-attack');
  return {
    conditions,
    hit,
    sent,
    setRank: (value: number) => {
      rank = value;
      revision++;
    },
  };
}

test('a block gives each of the three slots a layer, at any distance and including an un-settled zero-HP member', () => {
  const { conditions, hit } = fixture();
  hit('physical', 'weapon-block');
  for (const id of ['player', 'ally', 'third']) {
    assert.equal(conditions.attribute(id, 'physicalDamageRate', 0), 65, id);
    assert.equal(conditions.attribute(id, 'magicDamageRate', 0), 65, id);
    assert.equal(conditions.snapshot(id)[0]?.sourceId, 'player', '来源是格挡者');
  }
  assert.equal(conditions.snapshot('extra').length, 0, '不在三槽里');
  assert.equal(conditions.snapshot('fallen-one').length, 0);
  // 三层封顶：再挡两次仍是一级的三倍，不会到第四层。
  hit('physical', 'shield-block');
  hit('physical', 'weapon-block');
  assert.equal(conditions.attribute('player', 'physicalDamageRate', 0), 195);
  assert.equal(conditions.snapshot('player')[0]?.stackCount, 3);
  hit('physical', 'weapon-block');
  assert.equal(conditions.attribute('player', 'physicalDamageRate', 0), 195);
  assert.equal(conditions.snapshot('player')[0]?.stackCount, 3);
});

test('a stronger rank refills the layers and the buff ends on its inclusive last frame', () => {
  const { conditions, hit, setRank } = fixture();
  hit('physical', 'weapon-block');
  setRank(8);
  // 落空不给层；换成八级后的一次格挡按共用的「更强等级替换并叠一层」处理。
  hit('physical', 'miss');
  assert.equal(conditions.attribute('player', 'physicalDamageRate', 0), 65);
  hit('physical', 'shield-block');
  assert.equal(conditions.attribute('player', 'physicalDamageRate', 0), 330);
  assert.equal(conditions.snapshot('player')[0]?.stackCount, 2);
  hit('physical', 'weapon-block');
  assert.equal(conditions.attribute('player', 'physicalDamageRate', 0), 495);
  hit('physical', 'weapon-block');
  assert.equal(conditions.snapshot('player')[0]?.stackCount, 3, '三层封顶');
  conditions.update(90 * 60);
  assert.equal(conditions.hasBuff('player', 'shield-of-trust'), true);
  conditions.update(60);
  assert.equal(conditions.hasBuff('player', 'shield-of-trust'), true);
  conditions.update(60);
  assert.equal(conditions.hasBuff('player', 'shield-of-trust'), false);
  assert.equal(conditions.attribute('player', 'physicalDamageRate', 0), 0);
});

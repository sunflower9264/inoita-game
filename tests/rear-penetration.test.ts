import assert from 'node:assert/strict';
import test from 'node:test';
import { CombatConditions } from '../src/domain/combat-conditions.ts';
import type { PhysicalHit } from '../src/domain/physical-hit.ts';
import {
  createCombatTestHarness,
  createTestEnemy,
  createTestMember,
  loadBattleCatalog,
} from './support/combat-test-harness.ts';

const catalog = loadBattleCatalog();
const rates = [100, 140, 180, 240, 260, 280, 300, 320];

test('eight ranks carry the physical damage rate bonus and nothing else', () => {
  const passive = catalog.skills['rear-penetration'].passiveUnits![0] as { attribute: string; ranks: { kind: string; amount: number }[] };
  assert.equal(passive.attribute, 'rearPenetrationRate');
  assert.deepEqual(
    passive.ranks,
    rates.map(amount => ({ kind: 'add', amount })),
  );
});

const physicalProfile = catalog.basicAttacks[catalog.classes[0]!.basicAttack.profileId]!;
const magicProfile = Object.values(catalog.basicAttacks).find(attack => attack.damage.effect === 'magic')!;

function fixture({ rank = 8, targetTarget = 'someone-else' as string | undefined, magic = false } = {}) {
  const conditions = new CombatConditions();
  const hits: { damageKind: string; extra: number }[] = [];
  const caster = createTestMember({
    id: 'player',
    classId: 'ranger',
    level: 1,
    maxHealth: 100,
    skillLevels: rank ? { 'rear-penetration': rank } : {},
    panel: {
      physicalAttack: 100,
      magicAttack: 100,
      baseDefense: 0,
      defense: 0,
      defenseRate: 0,
      maxHealth: 100,
      hitBase: 0,
      hitBonus: 0,
      evasionBase: 0,
      evasionBonus: 0,
      criticalRate: 0,
      criticalResistance: 0,
      criticalDamage: 0,
      criticalDamageResistance: 0,
      weaponBlock: 0,
      shieldBlock: 0,
      physicalResistance: 0,
      magicResistance: 0,
    },
  });
  const baseEnemy = catalog.enemies.find(entry => entry.acceptsBuffs !== false && !entry.stateRules?.immuneToAllStates)!;
  const enemy = createTestEnemy({
    key: 'enemy',
    definition: {
      ...baseEnemy,
      basicAttack: {
        profileId: 'a',
        clips: { north: 'attack-north', south: 'attack-south', east: 'attack-east', west: 'attack-west' },
      },
    },
    health: 100,
    maxHealth: 100,
    // 目标当前在打谁，就是这项技能唯一的条件。
    targetId: targetTarget,
  });
  const harness = createCombatTestHarness({
    battleCatalog: catalog,
    conditions,
    hero: caster,
    members: new Map([['player', caster]]),
    enemies: new Map([['enemy', enemy]]),
    activeParty: () => ['player'],
    sessionSkills: () => caster.skills as never,
    memberActorDefinition: () => catalog.classes[0]!.actor,
  });
  const profile = magic ? magicProfile : physicalProfile;
  harness.stats.equipmentAttack = () => ({
    ...profile,
    profileId: 'test',
    step: 0,
    stepCount: 1,
    effectiveCycleFrames: profile.cycleFrames,
    clips: { north: 'attack-north', south: 'attack-south', east: 'attack-east', west: 'attack-west' },
    sequence: { north: [], south: [], east: [], west: [] },
  });
  harness.stats.enemyFighter = () => ({
    level: 1,
    physicalAttack: 0,
    magicAttack: 0,
    defense: 0,
    defenseRate: 0,
    maxHealth: 100,
    hitBase: 0,
    hitBonus: 0,
    evasionBase: 0,
    evasionBonus: 0,
    criticalRate: 0,
    criticalResistance: 0,
    criticalDamage: 0,
    criticalDamageResistance: 0,
    weaponBlock: 0,
    shieldBlock: 0,
    physicalResistance: 0,
    magicResistance: 0,
  });
  harness.settlement.resolveHitReactions = () => {};
  // attack-contact 处理器里读到的物理命中参数：把额外伤害率记下来即可判断有没有加成。
  harness.settlement.settleHit = (_event, hit: PhysicalHit) => {
    hits.push({ damageKind: magic ? 'magic' : 'physical', extra: hit.damage });
  };
  const contact = () => harness.settlement.attackContact({ casterId: 'player', targetId: 'enemy' });
  return { contact, hits, conditions, settlement: harness.settlement };
}

test('the bonus applies when the target is not attacking the attacker', t => {
  t.mock.method(Math, 'random', () => 0.99);
  const run = fixture({ targetTarget: 'someone-else' });
  run.contact();
  assert.equal(run.hits.length, 1, '命中确实结算了');
  // 目标在打别人：额外伤害率 320‰ 生效，普攻基数 100 → 132。
  assert.equal(run.hits[0]!.extra, 132);
});

test('the bonus disappears once the target turns on the attacker, and magic never gets it', t => {
  t.mock.method(Math, 'random', () => 0.99);
  const facing = fixture({ targetTarget: 'player' });
  facing.contact();
  assert.equal(facing.hits[0]!.extra, 100, '目标正在打攻击者就不加');
  const noTarget = fixture({ targetTarget: undefined });
  noTarget.contact();
  assert.equal(noTarget.hits[0]!.extra, 132, '目标没有目标也算');
  // 魔法根本不会去读这一项：直接看它有没有被调用。
  const spell = fixture({ targetTarget: 'someone-else', magic: true });
  let reads = 0;
  spell.settlement.rearPenetrationBonus = () => {
    reads++;
    return 320;
  };
  spell.contact();
  assert.equal(reads, 0, '魔法不读背后渗透');
  const unlearned = fixture({ rank: 0, targetTarget: 'someone-else' });
  unlearned.contact();
  assert.equal(unlearned.hits[0]!.extra, 100, '没学就没有加成');
});

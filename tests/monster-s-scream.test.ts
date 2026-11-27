import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createCombatTestHarness,
  createTestEnemy,
  createTestMember,
  loadBattleCatalog,
} from './support/combat-test-harness.ts';

const catalog = loadBattleCatalog();
const action = catalog.skills['monster-s-scream'].action!;
const baseEnemy = catalog.enemies[0]!;
const command = (growth: 'action' | 'companion' = 'action') => {
  const entry = catalog.enemies.find(enemy => enemy.id === 'enemy-hell-s-pawn-1')!.commandAction!;
  return (growth === 'companion' ? entry.companionAction : entry.action)!;
};

test('起手要求自己的活动召唤，命令动作本身不需要目标且按主人取数值', () => {
  assert.equal(action.requiresActiveSummon, true, '原版条件 37');
  assert.equal(action.requiresTarget, undefined, '技能本身只下命令，不选敌人');
  const order = command();
  assert.equal(order.requiresTarget, false, '命令围绕召唤物自身，不需要先选敌人');
  assert.deepEqual(
    order.events[0].kind === 'units' && order.events[0].cues.map(cue => [cue.target, cue.targetRangePx, cue.targetRangeMetric]),
    [
      ['area', 72, 'octagonal-grid'],
      ['area', 72, 'octagonal-grid'],
      ['area', 72, 'octagonal-grid'],
    ],
  );
  const magic = order.combatUnits!.find(unit => unit.effect === 'magic');
  assert.equal(magic?.effect === 'magic' && magic.ownerValues, true, '私有命令的伤害读主人');
  assert.equal(command('companion').requiresTarget, false, '佣兵分支同样不需要目标');
});

function gate(summons: { key: string; summonedBy: string; definition?: { commandAction?: unknown } }[]) {
  const enemies = new Map(
    summons.map(summon => [
      summon.key,
      createTestEnemy({
        key: summon.key,
        summonedBy: summon.summonedBy,
        definition: {
          ...baseEnemy,
          commandAction: summon.definition?.commandAction as typeof baseEnemy.commandAction,
        },
      }),
    ]),
  );
  const harness = createCombatTestHarness({ battleCatalog: catalog, enemies });
  return (skillId: string) =>
    harness.stats.canSelectSkill('companion-warlock', {
      id: skillId,
      action: catalog.skills[skillId].action!,
    });
}

test('没有自己的活动召唤时起手资格为假，有召唤才放行', () => {
  const wolf = { key: 'wolf', summonedBy: '', definition: {} };
  assert.equal(gate([wolf])('monster-s-scream'), false, '场上没有召唤：起手前就拒绝');
  assert.equal(gate([{ key: 'own', summonedBy: 'player', definition: { commandAction: command() } }])('monster-s-scream'), false, '别人拥有的召唤不算');
  assert.equal(gate([{ key: 'no-command', summonedBy: 'companion-warlock', definition: {} }])('monster-s-scream'), false, '没有受命动作的召唤不算数');
  assert.equal(gate([{ key: 'own', summonedBy: 'companion-warlock', definition: { commandAction: command() } }])('monster-s-scream'), true, '有自己的召唤：放行');
  assert.equal(gate([wolf])('celestial-lightning'), true, '其它技能不受这条门槛影响');
});

test('命令动作的伤害按主人读原魔攻与五维，命中仍归召唤物', () => {
  const order = command();
  const magic = order.combatUnits!.find(unit => unit.effect === 'magic')!;
  const owner = createTestMember({
    id: 'companion-warlock',
    classId: 'warlock',
    panel: {
      magicAttack: 200,
      attributes: { strength: 0, dexterity: 0, vitality: 0, intelligence: 100, mentality: 50 },
    },
  });
  const summon = createTestEnemy({
    key: 'pawn',
    definition: baseEnemy,
    summonedBy: 'companion-warlock',
  });
  const harness = createCombatTestHarness({
    battleCatalog: catalog,
    members: new Map([['companion-warlock', owner]]),
    enemies: new Map([['pawn', summon]]),
  });
  const prepared = harness.settlement.prepareSkillUnit({
    casterId: 'pawn',
    cueIndex: 0,
    skill: { id: 'monster-hell-scream', level: 1, action: { ...order, combatUnits: [magic] } },
  });
  assert.equal(prepared!.weightedAddition, 160, '主人 INT100×10 + MEN50×12 合计 1600 再除十');
  // 原魔攻 200 + 五维 160 = 360，乘 1980‰ 得 712。
  assert.equal(harness.stats.actorAttribute('companion-warlock', 'magicAttack') + prepared!.weightedAddition, 360);
  assert.equal(Math.trunc(((200 + 160) * 1980) / 1000), 712);
  assert.equal(harness.settlement.unitValueSourceId('pawn', magic), 'companion-warlock', '数值来源是主人');
});

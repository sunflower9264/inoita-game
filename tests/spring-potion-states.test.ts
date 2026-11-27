import assert from 'node:assert/strict';
import test from 'node:test';
import { CombatConditions } from '../src/domain/combat-conditions.ts';
import { createCombatTestHarness, createTestMember, loadBattleCatalog } from './support/combat-test-harness.ts';
import { createTestWorldCombat } from './support/world-combat-fixture.ts';

const catalog = loadBattleCatalog();

function fixture() {
  const conditions = new CombatConditions();
  const applied: { id: string; key: string }[] = [];
  const members = new Map([
    ['player', createTestMember({ id: 'player', health: 40, maxHealth: 100, mana: 0, maxMana: 100, equipmentItems: { 'off-hand': 'basic-shield' } })],
    ['ally', createTestMember({ id: 'ally', health: 40, maxHealth: 100, mana: 0, maxMana: 100 })],
  ]);
  let controlledId = 'player';
  const harness = createCombatTestHarness({
    battleCatalog: catalog,
    conditions,
    hero: members.get('player'),
    members,
    activeParty: () => [...members.keys()],
    controlledId: () => controlledId,
  });
  harness.settlement.applyActorBuff = (id, key) => {
    applied.push({ id, key });
    return true;
  };
  return {
    conditions,
    members,
    applied,
    harness,
    setControlledId: (id: string) => {
      controlledId = id;
    },
  };
}

test('positive spring buffs reach every living active member', () => {
  const f = fixture();
  f.harness.settlement.applySpringBuff('spring-power-up', 'party');
  assert.deepEqual(f.applied, [{ id: 'player', key: 'spring-power-up' }, { id: 'ally', key: 'spring-power-up' }]);
  f.applied.length = 0;
  f.members.get('ally')!.player.health = 0;
  f.harness.settlement.applySpringBuff('spring-mana-recovery', 'party');
  assert.deepEqual(f.applied, [{ id: 'player', key: 'spring-mana-recovery' }], '阵亡队员不再获得泉水正面状态');
});

test('negative and mixed spring buffs land only on the currently controlled character', () => {
  const f = fixture();
  f.setControlledId('ally');
  f.harness.settlement.applySpringBuff('spring-potion-sickness', 'single');
  f.harness.settlement.applySpringBuff('spring-frenzy', 'single');
  assert.deepEqual(f.applied, [{ id: 'ally', key: 'spring-potion-sickness' }, { id: 'ally', key: 'spring-frenzy' }]);
});

test('shortcut seal blocks skill input and the skill slot before the runtime request', async () => {
  const f = fixture();
  f.conditions.applyState('player', 'shortcut-sealed', 1000);
  assert.equal(f.harness.stats.skillSlotAvailable('player', 'shield-bash'), false);
  f.conditions.removeState('player', 'shortcut-sealed');
  assert.equal(f.conditions.canUseSkillShortcuts('player'), true);
  assert.equal(f.harness.stats.skillSlotAvailable('player', 'shield-bash'), true);

  const world = await createTestWorldCombat();
  world.hero.bag.addEquipped('basic-shield', 'off-hand', 'player', world.hero.classId);
  world.session.skills.maxAll();
  const enemyDef = catalog.enemies.find(entry => entry.id === 'enemy-shin-1')!;
  world.roster.placeEnemy(enemyDef.id, 80, 64);
  await world.combat.start();
  world.combat.applySpringBuff('spring-skill-seal', 'single');
  assert.equal(world.combat.skillSlotAvailable('shield-bash'), false);
  world.combat.attack('shield-bash');
  assert.equal(world.combat.attackState, 'idle');
  assert.equal(world.hero.player.mana, world.hero.player.maxMana);
  world.combat.destroy();
});

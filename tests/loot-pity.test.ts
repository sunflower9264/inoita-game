import assert from 'node:assert/strict';
import test from 'node:test';
import { LootPity, type LootPityConfig, type PityEligibility } from '../src/domain/loot-pity.ts';

const config: LootPityConfig = {
  equipment: { stepPermille: 60, capPermille: 900 },
  unique: { stepPermille: 100, capPermille: 900, guaranteeAfter: 10 },
  epic: { stepPermille: 10, capPermille: 600, guaranteeAfter: 40 },
  levelWindow: 10
};
const eligible: PityEligibility = { withinWindow: true, unique: true, epic: true };
const outside: PityEligibility = { withinWindow: false, unique: false, epic: false };

test('equipment, unique and epic counters rise independently and cap', () => {
  const pity = new LootPity();
  for (let index = 0; index < 5; index += 1) pity.recordEnemy('player', { equipment: false }, eligible);
  assert.equal(pity.equipmentBonus('player', config), 300);
  assert.equal(pity.uniqueBonus('player', config), 500);
  assert.equal(pity.epicBonus('player', config), 50);
  for (let index = 0; index < 100; index += 1) pity.recordEnemy('player', { equipment: false }, eligible);
  assert.equal(pity.equipmentBonus('player', config), config.equipment.capPermille);
  assert.equal(pity.uniqueBonus('player', config), config.unique.capPermille);
  assert.equal(pity.epicBonus('player', config), config.epic.capPermille);
});

test('blue equipment resets only the equipment counter, not the unique counter', () => {
  const pity = new LootPity();
  for (let index = 0; index < 5; index += 1) pity.recordEnemy('player', { equipment: false }, eligible);
  pity.recordEnemy('player', { equipment: true, bestRarity: 2 }, eligible);
  assert.equal(pity.equipmentBonus('player', config), 0);
  assert.equal(pity.uniqueBonus('player', config), 600, '蓝装不再清黄账');
  assert.equal(pity.epicBonus('player', config), 60);
});

test('unique and epic hits reset their own counters, purple resets both', () => {
  const pity = new LootPity();
  for (let index = 0; index < 5; index += 1) pity.recordEnemy('player', { equipment: false }, eligible);
  pity.recordEnemy('player', { equipment: true, bestRarity: 3 }, eligible);
  assert.equal(pity.uniqueBonus('player', config), 0);
  assert.equal(pity.epicBonus('player', config), 60, '黄装不刷新紫账');
  pity.recordEnemy('player', { equipment: true, bestRarity: 4 }, eligible);
  assert.equal(pity.uniqueBonus('player', config), 0);
  assert.equal(pity.epicBonus('player', config), 0);
});

test('hard guarantees fire on the configured attempt', () => {
  const pity = new LootPity();
  for (let index = 0; index < 8; index += 1) pity.recordEnemy('player', { equipment: false }, eligible);
  assert.equal(pity.uniqueGuaranteed('player', config), false);
  pity.recordEnemy('player', { equipment: false }, eligible);
  assert.equal(pity.uniqueGuaranteed('player', config), true, '第 10 次合格击杀必出黄装');
  for (let index = 0; index < 29; index += 1) pity.recordEnemy('player', { equipment: false }, eligible);
  assert.equal(pity.epicGuaranteed('player', config), false);
  pity.recordEnemy('player', { equipment: false }, eligible);
  assert.equal(pity.epicGuaranteed('player', config), true, '第 40 次合格击杀必出紫装');
});

test('kills outside the level window neither build nor clear pity', () => {
  const pity = new LootPity();
  pity.recordEnemy('player', { equipment: false }, outside);
  assert.equal(pity.equipmentBonus('player', config), 0);
  pity.recordEnemy('player', { equipment: false }, eligible);
  pity.recordEnemy('player', { equipment: true, bestRarity: 2 }, outside);
  assert.equal(pity.equipmentBonus('player', config), 60);
  assert.equal(pity.uniqueBonus('player', config), 100);
});

test('a boss first kill is guaranteed only once per save', () => {
  const pity = new LootPity();
  assert.equal(pity.takeBossFirstDefeat('enemy-boss'), true);
  assert.equal(pity.takeBossFirstDefeat('enemy-boss'), false);
  assert.equal(pity.bossDefeated('enemy-boss'), true);
});

test('chest pity is tracked per chest kind and survives a snapshot round-trip', () => {
  const pity = new LootPity();
  for (let index = 0; index < 4; index += 1) pity.recordChest('ordinary', { equipment: false });
  assert.equal(pity.chestEquipmentBonus('ordinary', config), 240);
  assert.equal(pity.chestEquipmentBonus('improved', config), 0);
  const saved = pity.captureState();
  const restored = new LootPity();
  restored.restoreState(saved);
  assert.equal(restored.chestEquipmentBonus('ordinary', config), 240);
  restored.recordChest('ordinary', { equipment: true });
  assert.equal(restored.chestEquipmentBonus('ordinary', config), 0);
});

test('leaving the party drops that member counters', () => {
  const pity = new LootPity();
  pity.recordEnemy('story-mercenary-olaf', { equipment: false }, eligible);
  assert.ok(pity.equipmentBonus('story-mercenary-olaf', config) > 0);
  pity.removeMember('story-mercenary-olaf');
  assert.equal(pity.equipmentBonus('story-mercenary-olaf', config), 0);
});

test('legendary and epic counters round-trip through the version 2 state', () => {
  const pity = new LootPity();
  for (let index = 0; index < 3; index += 1) pity.recordEnemy('player', { equipment: false }, eligible);
  const restored = new LootPity();
  restored.restoreState(pity.captureState());
  assert.equal(restored.uniqueBonus('player', config), 300);
  assert.equal(restored.epicBonus('player', config), 30);
  assert.throws(() => restored.restoreState({ version: 1 } as never), /掉落保底状态无效/);
});

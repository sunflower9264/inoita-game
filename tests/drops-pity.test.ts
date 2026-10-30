import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { firstBossGuarantee, parseDrops, type PityConfig } from '../src/domain/drops.ts';
import type { BattleCatalog } from '../src/domain/battle.ts';
import type { ItemCatalog } from '../src/domain/items.ts';

const read = <T>(name: string): T => JSON.parse(readFileSync(new URL(`../public/content/${name}.json`, import.meta.url), 'utf8')) as T;
const items = read<ItemCatalog>('items');
const battle = read<BattleCatalog>('battle');
const drops = read<Record<string, unknown>>('drops');
const enemyIds = battle.enemies.map(enemy => enemy.id);
const pity: PityConfig = {
  equipment: { stepPermille: 60, capPermille: 900 },
  unique: { stepPermille: 100, capPermille: 900, guaranteeAfter: 10 },
  epic: { stepPermille: 10, capPermille: 600, guaranteeAfter: 40 },
  levelWindow: 10,
  bossGuarantee: { equipment: true, minRarity: 2 }
};

test('first boss guarantee follows the configured equipment switch', () => {
  assert.deepEqual(firstBossGuarantee(pity, true), { equipmentBonus: 10000, minRarity: 2 });
  assert.deepEqual(firstBossGuarantee(pity, false), { equipmentBonus: 0 });
  assert.deepEqual(firstBossGuarantee({ ...pity, bossGuarantee: { equipment: false, minRarity: 2 } }, true), { equipmentBonus: 0 });
  assert.deepEqual(firstBossGuarantee(undefined, true), { equipmentBonus: 0 });
});

test('parseDrops rejects malformed pity configuration', () => {
  const invalidEquipment = structuredClone(drops) as {
    pity: PityConfig;
  };
  invalidEquipment.pity.bossGuarantee.equipment = 'yes' as unknown as boolean;
  assert.throws(() => parseDrops(invalidEquipment, items, enemyIds), /保底配置无效/);

  const invalidRarity = structuredClone(drops) as { pity: PityConfig };
  invalidRarity.pity.bossGuarantee.minRarity = 5;
  assert.throws(() => parseDrops(invalidRarity, items, enemyIds), /保底配置无效/);

  const invalidStep = structuredClone(drops) as { pity: PityConfig };
  invalidStep.pity.equipment.stepPermille = 901;
  assert.throws(() => parseDrops(invalidStep, items, enemyIds), /保底配置无效/);

  const invalidWindow = structuredClone(drops) as { pity: PityConfig };
  invalidWindow.pity.levelWindow = -1;
  assert.throws(() => parseDrops(invalidWindow, items, enemyIds), /保底配置无效/);

  const invalidGuarantee = structuredClone(drops) as { pity: PityConfig };
  invalidGuarantee.pity.unique.guaranteeAfter = 0;
  assert.throws(() => parseDrops(invalidGuarantee, items, enemyIds), /保底配置无效/);

  const invalidEpic = structuredClone(drops) as { epicDrops: { minLevel: number; enemyChance: number; chestChance: number } };
  invalidEpic.epicDrops.enemyChance = 20000;
  assert.throws(() => parseDrops(invalidEpic, items, enemyIds), /紫装掉落配置无效/);

  const duplicateEpic = structuredClone(drops) as { equipment: { epic: { item: string; dropLevel: number }[] } };
  duplicateEpic.equipment.epic.push({ ...duplicateEpic.equipment.epic[0]! });
  assert.throws(() => parseDrops(duplicateEpic, items, enemyIds), /紫装掉落配置无效/);
});

test('the shipped pity configuration parses', () => {
  assert.doesNotThrow(() => parseDrops(structuredClone(drops), items, enemyIds));
});

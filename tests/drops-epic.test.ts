import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseDrops, rollChestLoot, rollEnemyLoot, specialDropEligibility,
  type ChestOpenResult, type DropCatalog, type DropReward, type DropRoll
} from '../src/domain/drops.ts';
import type { CharacterStatsCatalog } from '../src/domain/character-stats.ts';
import type { ItemCatalog } from '../src/domain/items.ts';
import type { BattleCatalog } from '../src/domain/battle.ts';

const read = <T>(name: string): T => JSON.parse(readFileSync(new URL(`../public/content/${name}.json`, import.meta.url), 'utf8')) as T;
const items = read<ItemCatalog>('items');
const storyEquipment = new Set(items.storyEquipment ?? []);
const stats = read<CharacterStatsCatalog>('character-stats');
const battle = read<BattleCatalog>('battle');
const rawDrops = read<DropCatalog>('drops');
const drops = parseDrops(rawDrops, items, battle.enemies.map(enemy => enemy.id));

type RolledReward = Extract<DropReward, { kind: 'item' }> & { roll: DropRoll };
const withRarity = (result: ChestOpenResult, rarity: number): RolledReward[] =>
  result.rewards.filter((reward): reward is RolledReward =>
    reward.kind === 'item' && reward.roll?.rarity === rarity);
const epicRewards = (result: ChestOpenResult) => withRarity(result, 4);
const uniqueRewards = (result: ChestOpenResult) => withRarity(result, 3);

function enemyId(predicate: (rule: DropCatalog['enemies'][string]) => boolean): string {
  const found = Object.entries(drops.enemies).find(([, rule]) => predicate(rule));
  assert.ok(found, '需要一条符合条件的敌人掉落规则');
  return found[0];
}

function clearRule(data: DropCatalog, id: string) {
  const rule = data.enemies[id]!;
  for (const key of Object.keys(rule.chances)) rule.chances[key as keyof typeof rule.chances] = 0;
  rule.fixed = [];
  return rule;
}

test('epic pool contains every non-story rarity-4 equipment at its own level', () => {
  const rarity = new Map((stats.grades ?? []).map(grade => [grade.index, grade.rarity]));
  const target = Object.entries(stats.equipment)
    .filter(([id, entry]) => {
      const item = items.items[id];
      return !!item && item.category === 'equipment' && !storyEquipment.has(id)
        && entry.defaultGrade !== undefined && rarity.get(entry.defaultGrade) === 4;
    })
    .map(([id]) => id);
  const pool = rawDrops.equipment.epic.map(entry => entry.item);
  assert.equal(pool.length, 199);
  assert.equal(new Set(pool).size, 199);
  assert.ok([...storyEquipment].every(id => !pool.includes(id)), '剧情人物装备不进入史诗池');
  assert.deepEqual([...pool].sort(), [...target].sort());
  assert.ok(rawDrops.equipment.epic.every(entry => entry.dropLevel === items.items[entry.item]!.level));
  assert.equal(target.filter(id => id.startsWith('merciless-')).length, 6, '品级 14 的紫装也在池内');
  const lowLevel = Object.entries(stats.equipment)
    .filter(([id, entry]) => {
      const item = items.items[id];
      return !!item && (item.level ?? 0) < 59 && entry.defaultGrade !== undefined
        && rarity.get(entry.defaultGrade) === 4;
    })
    .map(([id]) => id);
  assert.equal(lowLevel.length, 43);
  assert.ok(lowLevel.filter(id => !storyEquipment.has(id)).every(id => pool.includes(id)));
  assert.ok(drops.equipment.epic.some(entry => entry.item === 'cloak-of-devotion' && entry.dropLevel === 1));
  assert.ok(!drops.equipment.epic.some(entry => entry.item === 'black-sword-2'), '保留道具使用独立掉落');
});

test('epic is rolled once per kill even when the enemy has three passes', () => {
  const data = structuredClone(drops);
  const id = enemyId(rule => rule.rolls === 3 && rule.level >= 59 && !rule.noNormalDrops);
  const rule = clearRule(data, id);
  rule.rolls = 3;
  data.epicDrops!.enemyChance = 10000;
  const result = rollEnemyLoot(data, stats, id, rule.level, rule.level, () => .5);
  const epics = epicRewards(result);
  assert.equal(epics.length, 1);
  assert.equal(epics[0]!.roll!.rarity, 4);
  assert.equal(epics[0]!.roll!.sockets, false);
  assert.equal(epics[0]!.roll!.grade, stats.equipment[epics[0]!.item]!.defaultGrade);
});

test('epic item level follows the defeated enemy', () => {
  assert.equal(specialDropEligibility(drops, 58, 100, 100).epic, true, '越级击杀可以掉高等级紫装');
  assert.equal(specialDropEligibility(drops, 1, 1, 1).epic, true, '1 级有候选紫装');
  assert.equal(specialDropEligibility(drops, 100, 58, 58).epic, false, '当前等级范围没有普通紫装候选');
  const bandCap = specialDropEligibility(drops, 100, 100, 50);
  assert.equal(bandCap.cap, 100, '地图等级不限制怪物掉落');
  assert.equal(bandCap.epic, true);
  assert.equal(specialDropEligibility(drops, 60, 100, 100).cap, 100);
  assert.equal(specialDropEligibility(drops, 105, 105, 105).cap, 105);
});

test('low-level enemies can drop epic equipment and an empty pool is skipped', () => {
  const lowLevelId = enemyId(rule => rule.level === 1 && !rule.noNormalDrops);
  const low = structuredClone(drops);
  const lowRule = clearRule(low, lowLevelId);
  low.epicDrops!.enemyChance = 10000;
  const lowResult = rollEnemyLoot(low, stats, lowLevelId, lowRule.level, lowRule.level, () => 0);
  assert.equal(epicRewards(lowResult)[0]?.item, 'cloak-of-devotion');

  const empty = structuredClone(drops);
  empty.equipment.epic = [];
  const highLevelId = enemyId(rule => rule.level >= 59 && !rule.noNormalDrops);
  const highRule = clearRule(empty, highLevelId);
  const emptyResult = rollEnemyLoot(empty, stats, highLevelId, highRule.level, highRule.level, () => 0, {},
    { epicGuarantee: true });
  assert.equal(epicRewards(emptyResult).length, 0, '空池不判定、不报错');
});

test('epic hard guarantee forces a purple even against a failing random stream', () => {
  const data = structuredClone(drops);
  const id = enemyId(rule => rule.level >= 59 && !rule.noNormalDrops);
  const rule = clearRule(data, id);
  data.epicDrops!.enemyChance = 0;
  const forced = rollEnemyLoot(data, stats, id, rule.level, rule.level, () => .9999, {},
    { epicGuarantee: true });
  assert.equal(epicRewards(forced).length, 1);
  const none = rollEnemyLoot(data, stats, id, rule.level, rule.level, () => .9999, {},
    { epicGuarantee: false });
  assert.equal(epicRewards(none).length, 0);
});

test('chests roll epic items whenever their level has candidates', () => {
  const data = structuredClone(drops);
  const rule = data.chests.ordinary;
  for (const key of Object.keys(rule.chances)) rule.chances[key as keyof typeof rule.chances] = 0;
  rule.fixed = [];
  delete rule.spawn;
  data.epicDrops!.chestChance = 10000;
  assert.equal(epicRewards(rollChestLoot(data, stats, 'ordinary', 60, 60, () => 0)).length, 1);
  data.epicDrops!.chestChance = 0;
  assert.equal(epicRewards(rollChestLoot(data, stats, 'ordinary', 60, 60, () => 0)).length, 0);
  data.epicDrops!.chestChance = 10000;
  assert.equal(epicRewards(rollChestLoot(data, stats, 'ordinary', 1, 1, () => 0))[0]?.item, 'cloak-of-devotion');
  assert.equal(epicRewards(rollChestLoot(data, stats, 'ordinary', 17, 17, () => 0)).length, 0,
    '等级范围里没有候选时不掉紫装');
});

test('unique slot rolls once per kill even with three passes', () => {
  const data = structuredClone(drops);
  const id = enemyId(rule => rule.rolls === 3 && rule.level >= 59 && !rule.noNormalDrops);
  const rule = clearRule(data, id);
  rule.rolls = 3;
  rule.chances.unique = 10000;
  assert.equal(uniqueRewards(rollEnemyLoot(data, stats, id, rule.level, rule.level, () => .5)).length, 1);

  const legacy = structuredClone(drops);
  delete legacy.pity;
  delete legacy.epicDrops;
  const legacyRule = clearRule(legacy, id);
  legacyRule.rolls = 3;
  legacyRule.chances.unique = 10000;
  assert.equal(uniqueRewards(rollEnemyLoot(legacy, stats, id, legacyRule.level, legacyRule.level, () => .5)).length, 1);
});

test('unique guarantee forces one yellow; an empty unique pool is skipped', () => {
  const data = structuredClone(drops);
  const id = enemyId(rule => rule.level >= 59 && !rule.noNormalDrops);
  const rule = clearRule(data, id);
  rule.rolls = 1;
  const forced = rollEnemyLoot(data, stats, id, rule.level, rule.level, () => .9999, {},
    { uniqueGuarantee: true });
  assert.equal(uniqueRewards(forced).length, 1);

  const empty = structuredClone(drops);
  empty.equipment.unique = [];
  const emptyRule = clearRule(empty, id);
  emptyRule.rolls = 1;
  const skipped = rollEnemyLoot(empty, stats, id, emptyRule.level, emptyRule.level, () => .9999, {},
    { uniqueGuarantee: true });
  assert.equal(uniqueRewards(skipped).length, 0);
});

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
const stats = read<CharacterStatsCatalog>('character-stats');
const battle = read<BattleCatalog>('battle');
const drops = read<DropCatalog>('drops');
parseDrops(drops, items, battle.enemies.map(enemy => enemy.id));

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

test('epic pool contains every level 59+ rarity-4 equipment and nothing below 59', () => {
  const rarity = new Map((stats.grades ?? []).map(grade => [grade.index, grade.rarity]));
  const target = Object.entries(stats.equipment)
    .filter(([id, entry]) => {
      const item = items.items[id];
      return !!item && item.category === 'equipment' && (item.level ?? 0) >= 59
        && entry.defaultGrade !== undefined && rarity.get(entry.defaultGrade) === 4;
    })
    .map(([id]) => id);
  const pool = drops.equipment.epic.map(entry => entry.item);
  assert.equal(pool.length, 166);
  assert.equal(new Set(pool).size, 166);
  assert.deepEqual([...pool].sort(), [...target].sort());
  assert.ok(drops.equipment.epic.every(entry => entry.dropLevel >= 59));
  assert.equal(target.filter(id => id.startsWith('merciless-')).length, 6, '品级 14 的紫装也在池内');
  const lowLevel = Object.entries(stats.equipment)
    .filter(([id, entry]) => {
      const item = items.items[id];
      return !!item && (item.level ?? 0) < 59 && entry.defaultGrade !== undefined
        && rarity.get(entry.defaultGrade) === 4;
    })
    .map(([id]) => id);
  assert.equal(lowLevel.length, 43);
  assert.ok(lowLevel.every(id => !pool.includes(id)), '59 级以下紫装不进入随机池');
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

test('epic item level cap is the minimum of player, content and chapter', () => {
  assert.equal(specialDropEligibility(drops, 58, 100, 100).epic, false, '人物等级不够');
  assert.equal(specialDropEligibility(drops, 100, 58, 58).epic, false, '内容等级不够');
  const bandCap = specialDropEligibility(drops, 100, 100, 50);
  assert.equal(bandCap.cap, 50, '章节上限压住物品等级');
  assert.equal(bandCap.epic, false);
  assert.equal(specialDropEligibility(drops, 60, 100, 100).cap, 60);
  assert.equal(specialDropEligibility(drops, 105, 105, 105).cap, 105);
});

test('below level 59 or with an empty epic pool, the epic path is skipped', () => {
  const lowLevelId = enemyId(rule => rule.level < 59 && !rule.noNormalDrops);
  const low = structuredClone(drops);
  const lowRule = clearRule(low, lowLevelId);
  const lowResult = rollEnemyLoot(low, stats, lowLevelId, lowRule.level, lowRule.level, () => 0);
  assert.equal(epicRewards(lowResult).length, 0);

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

test('chests use a fixed epic chance, skip below 59, and never use kill pity', () => {
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
  assert.equal(epicRewards(rollChestLoot(data, stats, 'ordinary', 58, 60, () => 0)).length, 0,
    '宝箱等级低于 59 不判定');
});

test('v3 unique slot rolls once per kill while v2 keeps three passes', () => {
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
  assert.equal(uniqueRewards(rollEnemyLoot(legacy, stats, id, legacyRule.level, legacyRule.level, () => .5)).length, 3);
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

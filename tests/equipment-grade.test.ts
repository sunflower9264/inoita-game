import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { rollEquipmentNumbers } from '../src/domain/character-stats.ts';
import { rollGrade, staticGrade } from '../src/domain/equipment-grade.ts';
import { chapterBand, parseDrops, rollEnemyLoot } from '../src/domain/drops.ts';
import { parseCharacterStats, parseItemCatalog } from '../src/application/content-validation.ts';

const read = (name: string) => JSON.parse(readFileSync(new URL(`../public/content/${name}.json`, import.meta.url), 'utf8'));
const stats = parseCharacterStats(read('character-stats'));
const items = parseItemCatalog(read('items'));
const drops = parseDrops(read('drops'), items, read('battle').enemies.map((enemy: { id: string }) => enemy.id));

/** 固定种子 LCG；返回 [0,1)。 */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const profile = { weights: [700, 230, 70, 0, 0], rarityScale: [1000, 1000, 1000, 0, 0], maxGrade: 9 };
const expected = [31.5, 21, 14, 3.5, 6.9, 11.5, 4.6, 2.1, 3.5, 1.4];

test('random ground equipment reproduces the native 0..9 grade distribution', () => {
  const random = seeded(0x9e3779b9);
  const counts = new Array(10).fill(0);
  const rolls = 200_000;
  for (let index = 0; index < rolls; index += 1) {
    const result = rollGrade(stats, stats.equipment.dagger!, profile, random);
    assert.ok(result);
    counts[result.grade] += 1;
  }
  const actual = counts.map((count: number) => count / rolls * 100);
  for (let grade = 0; grade < 10; grade += 1)
    assert.ok(Math.abs(actual[grade] - expected[grade]) <= 0.7,
      `品级 ${grade}: ${actual[grade].toFixed(2)}% 偏离原版 ${expected[grade]}%`);
});

test('grade decides attack, options and socket cap', () => {
  const random = seeded(7);
  for (const grade of [0, 2, 5, 8]) {
    const variant = stats.equipment.dagger!.gradeVariants![grade]!;
    const numbers = rollEquipmentNumbers(stats.equipment.dagger!, random, true,
      { grade, gradeName: variant.name, attack: variant.attack, defense: variant.defense,
        optionCount: variant.optionCount, socketLimit: variant.socketLimit });
    assert.equal(numbers.grade, grade);
    assert.equal(numbers.baseAttack, variant.attack);
    assert.equal(numbers.modifiers.length >= variant.optionCount, true);
    assert.ok(numbers.sockets <= variant.socketLimit);
  }
});

test('a rarity floor only changes grades after the slot already succeeded', () => {
  const random = seeded(11);
  for (let index = 0; index < 2000; index += 1) {
    const result = rollGrade(stats, stats.equipment.dagger!, { ...profile, minRarity: 2 }, random);
    assert.ok(result);
    assert.equal(result.rarity, 2);
    assert.ok(result.grade >= 7 && result.grade <= 9);
  }
});

test('unique equipment keeps its static grade and never rolls sockets', () => {
  const unique = Object.values(stats.equipment).find(equipment => equipment.defaultGrade === 10 && equipment.gradeVariants);
  assert.ok(unique);
  const result = staticGrade(stats, unique!);
  assert.ok(result);
  assert.equal(result!.grade, 10);
  assert.equal(result!.rarity, 3);
  const numbers = rollEquipmentNumbers(unique!, seeded(3), false,
    { grade: result!.grade, gradeName: result!.gradeName, attack: result!.attack, defense: result!.defense,
      optionCount: result!.optionCount, socketLimit: result!.socketLimit });
  assert.equal(numbers.sockets, 0);
});

test('enemy equipment follows the enemy level even in an earlier chapter', () => {
  const band = chapterBand(drops, 10);
  assert.ok(band);
  assert.equal(band!.maxItemLevel, 15);
  const high = chapterBand(drops, 100);
  assert.ok(high);
  assert.equal(high!.maxItemLevel, 105);
  const levelById = new Map<string, number>();
  for (const rows of Object.values(drops.equipment)) for (const row of rows) levelById.set(row.item, row.dropLevel);
  const random = seeded(0x1234567);
  let equipmentCount = 0;
  for (let index = 0; index < 5000; index += 1) {
    const result = rollEnemyLoot(drops, stats, 'enemy-scorpion-1', 100, 10, random);
    for (const reward of result.rewards) {
      if (reward.kind !== 'item') continue;
      const level = levelById.get(reward.item);
      if (level !== undefined) {
        equipmentCount++;
        assert.ok(level >= 84 && level <= 99, `${reward.item} 等级 ${level} 超出怪物等级范围`);
      }
    }
  }
  assert.ok(equipmentCount > 0, '应当抽到装备');
});

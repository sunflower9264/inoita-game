import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { equipmentSlotFrame } from '../src/ui/item-name-color.ts';
import type { ItemCatalog } from '../src/domain/items.ts';
import type { CharacterStatsCatalog, ItemNumbers } from '../src/domain/character-stats.ts';
import { parseShops } from '../src/application/content-validation.ts';

const read = <T>(name: string): T => JSON.parse(fs.readFileSync(new URL(`../public/content/${name}.json`, import.meta.url), 'utf8')) as T;
const items = read<ItemCatalog>('items'), stats = read<CharacterStatsCatalog>('character-stats'), shops = parseShops(read('shops'));
const panels = read<{ assets: Record<string, string> }>('menu-panels');
const keyOf = (name: string) => Object.entries(items.items).find(([, value]) => value.name === name)![0];
const numbers = (grade: number, chaos?: ItemNumbers['chaos']): ItemNumbers => ({
  modifiers: [], gemModifiers: [], magicPercent: 20, sockets: 3, enhancementUses: 7, grade, baseAttack: 300, baseDefense: 50, chaos
});

test('equipment slot frames pick the frame that matches the description title color', () => {
  const dagger = items.items[keyOf('短剑')], definition = stats.equipment[keyOf('短剑')];
  const expected: Record<number, string | undefined> = {0: undefined, 1: 'inventory-slot-rarity-1', 2: 'inventory-slot-rarity-2', 3: 'inventory-slot-rarity-3', 4: 'inventory-slot-rarity-4'};
  for (let grade = 0; grade < 15; grade++) {
    assert.equal(equipmentSlotFrame(dagger, numbers(grade), definition, shops.grades), expected[shops.grades[grade].rarity], `grade ${grade}`);
  }
  assert.equal(equipmentSlotFrame(dagger, numbers(7, {tier: 'chaos'} as ItemNumbers['chaos']), definition, shops.grades), 'inventory-slot-chaos');
  assert.equal(equipmentSlotFrame(dagger, numbers(7, {tier: 'epic-chaos'} as ItemNumbers['chaos']), definition, shops.grades), 'inventory-slot-epic-chaos');
  assert.equal(equipmentSlotFrame(undefined, numbers(2), definition, shops.grades), undefined, '空格子沿用默认底图');
});

test('only equipment takes a frame; potions and materials keep the default slot', () => {
  const potion = Object.entries(items.items).find(([, item]) => item.name === '恢复药水（小）')![0];
  assert.equal(equipmentSlotFrame(items.items[potion], numbers(3), stats.equipment[potion], shops.grades), undefined);
});

test('every quality frame is configured and shipped as an image', () => {
  const frames = ['inventory-slot-rarity-1', 'inventory-slot-rarity-2', 'inventory-slot-rarity-3', 'inventory-slot-rarity-4',
    'inventory-slot-chaos', 'inventory-slot-epic-chaos'];
  for (const frame of frames) {
    const file = panels.assets[frame];
    assert.equal(typeof file, 'string', `menu-panels 缺少 ${frame}`);
    assert.ok(fs.existsSync(new URL(`../public/${file}`, import.meta.url)), `缺少图片 ${file}`);
  }
});

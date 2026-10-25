import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { ShopCatalog } from '../src/domain/shop.ts';
import type { CharacterStatsCatalog } from '../src/domain/character-stats.ts';
import { parseShops, parseShopEquipment } from '../src/application/content-validation.ts';
import { ContentLoader } from '../src/application/content-loader.ts';

const source = JSON.parse(fs.readFileSync(new URL('../public/content/shops.json', import.meta.url), 'utf8')) as ShopCatalog;
const stats = JSON.parse(fs.readFileSync(new URL('../public/content/character-stats.json', import.meta.url), 'utf8')) as CharacterStatsCatalog;

test('shops core and equipment split preserve the complete catalog', () => {
  const core = structuredClone(source);
  const equipment = core.equipment;
  core.equipment = {};
  const parsed = parseShops(core);
  assert.deepEqual(parsed.equipment, {});
  const restored = parseShopEquipment({ equipment });
  assert.deepEqual(restored, source.equipment);
});

test('equipment split omits variants and derives them from character-stats', () => {
  const equipment = Object.fromEntries(Object.entries(source.equipment).map(([id, entry]) => {
    const { variants: _variants, ...rest } = entry;
    return [id, rest];
  }));
  const restored = parseShopEquipment({ equipment }, stats);
  for (const [id, entry] of Object.entries(source.equipment)) {
    assert.deepEqual(restored[id]!.variants, entry.variants.map(variant => ({
      attack: variant.attack, defense: variant.defense, gradeName: variant.gradeName,
      optionCount: variant.optionCount, socketLimit: variant.socketLimit
    })));
  }
});

test('trusted ContentLoader returns the lazy equipment payload', async () => {
  const original = globalThis.fetch;
  const equipment = Object.fromEntries(Object.entries(source.equipment).map(([id, entry]) => {
    const { variants: _variants, ...rest } = entry;
    return [id, rest];
  }));
  globalThis.fetch = (async (url: string) => ({
    ok: true,
    json: async () => url.includes('shops-equipment') ? { equipment } : stats
  } as Response)) as typeof fetch;
  try {
    const loader = new ContentLoader();
    loader.trusted = true;
    const loaded = await loader.shopEquipment();
    assert.equal(Object.keys(loaded).length, Object.keys(source.equipment).length);
    assert.equal(loaded.dagger!.variants.length, 15);
  } finally { globalThis.fetch = original; }
});

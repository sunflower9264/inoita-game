import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  parseBattle, parseCompanions, parseWardrobe, parseWorld
} from '../src/application/content-validation.ts';
import { characterAssets } from '../src/rendering/combat-asset-descriptors.ts';
import { residentCombatCoverageGaps } from '../src/rendering/combat-visual-coverage.ts';
import { residentCombatAssets } from '../src/rendering/resident-combat-assets.ts';

const read = (file: string): any => JSON.parse(fs.readFileSync(new URL(`../public/content/${file}`, import.meta.url), 'utf8'));
const battle = parseBattle(read('battle.json'));
const wardrobe = parseWardrobe(read('wardrobe.json'));
const world = parseWorld(read('world.json'));
const companions = parseCompanions(read('companions.json'));

test('scoped resident packs keep only the active class and every companion appearance', () => {
  const full = residentCombatAssets({ battle, wardrobe, world, companions });
  const fullByKey = new Map(full.assets.map(asset => [asset.key, JSON.stringify(asset)]));
  const companionActors = new Set(Object.values(companions.definitions).map(definition => definition.actor));
  assert.equal(companionActors.size, 41);
  for (const character of battle.classes) {
    const scoped = residentCombatAssets({ battle, wardrobe, world, companions, classIds: [character.id] });
    assert.ok(scoped.actorIds.has(character.actor.id));
    for (const actor of companionActors) assert.ok(scoped.actorIds.has(actor), `${character.id} missing companion ${actor}`);
    for (const other of battle.classes) if (other.id !== character.id)
      assert.equal(scoped.actorIds.has(other.actor.id), false, `${character.id} leaked ${other.id}`);
    for (const asset of scoped.assets) {
      assert.equal(fullByKey.get(asset.key), JSON.stringify(asset), `${character.id}: ${asset.key}`);
    }
    for (const effect of scoped.effectNames) assert.ok(full.effectNames.has(effect), `${character.id}: ${effect}`);
    assert.ok(scoped.effectNames.size < full.effectNames.size, `${character.id} did not narrow effects`);
    for (const asset of characterAssets(character.actor)) assert.ok(scoped.assets.some(value => value.key === asset.key), `${character.id}: ${asset.key}`);
    for (const skillId of character.skills)
      assert.ok(scoped.assets.some(value => value.key === battle.skills[skillId].icon), `${character.id}: icon ${skillId}`);
    const gaps = residentCombatCoverageGaps({ battle, wardrobe, world, companions, classIds: [character.id] });
    assert.deepEqual(gaps, { effects: [], layers: [], actorLayers: [], definitions: [] }, character.id);
  }
});

test('an unknown or empty class scope is explicit, not silently full', () => {
  assert.throws(() => residentCombatAssets({ battle, wardrobe, world, companions, classIds: ['missing'] }), /职业不存在/);
  const empty = residentCombatAssets({ battle, wardrobe, world, companions, classIds: [] });
  for (const character of battle.classes) assert.equal(empty.actorIds.has(character.actor.id), false);
  assert.equal(empty.assets.some(asset => asset.key.includes('battle-')), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import type { BattleCatalog } from '../src/domain/battle.ts';
import { BattleCharacter } from '../src/domain/character-stats.ts';
import type { ActorDefinition, WorldMap } from '../src/domain/content.ts';
import { BREAKABLE_ENEMY_IDS, breakableKindOf, parseDrops, rollBreakableLoot } from '../src/domain/drops.ts';
import { Session } from '../src/domain/session.ts';
import { WorldEnemyRoster } from '../src/domain/world-enemies.ts';
import { CHARACTER_ATLAS_ALIASES } from '../tools/character-atlas-aliases.ts';
import {
  loadBattleCatalog,
  loadCampaignCatalog,
  loadCharacterStatsCatalog,
  loadCompanionCatalog,
  loadContentCatalog,
  loadItemCatalog,
} from './support/combat-test-harness.ts';
import { createFakePhaserScene, createTestWorldCombat } from './support/world-combat-fixture.ts';

function normalizeActorClips(actor: ActorDefinition): void {
  for (const clip of Object.values(actor.clips)) {
    for (const layer of clip?.layers ?? []) {
      if (layer.file) layer.file = CHARACTER_ATLAS_ALIASES[layer.file] ?? layer.file;
    }
  }
}

function normalizeBattleCatalog(raw: BattleCatalog): BattleCatalog {
  const copy = structuredClone(raw);
  for (const cls of copy.classes) normalizeActorClips(cls.actor);
  for (const enemy of copy.enemies) normalizeActorClips(enemy.actor);
  return copy;
}

const items = loadItemCatalog();
const battle = normalizeBattleCatalog(loadBattleCatalog());
const stats = loadCharacterStatsCatalog();
const campaign = loadCampaignCatalog();
const companions = loadCompanionCatalog();
const catalog = parseDrops(loadContentCatalog<Record<string, unknown>>('drops'), items, battle.enemies.map(enemy => enemy.id));

test('breakable enemy ids map exactly, without substring matching', () => {
  assert.equal(breakableKindOf(BREAKABLE_ENEMY_IDS.bush), 'bush');
  assert.equal(breakableKindOf(BREAKABLE_ENEMY_IDS.jar), 'jar');
  assert.equal(breakableKindOf(BREAKABLE_ENEMY_IDS.box), 'box');
  assert.equal(breakableKindOf('enemy-bush-scorpion-1'), undefined);
  assert.equal(breakableKindOf('enemy-box-mimic-1'), undefined);
});

test('breakable loot is not suppressed by an overleveled hero', () => {
  const data=structuredClone(catalog);
  const rule=data.breakables!.jar!;
  for(const slot of Object.keys(rule.chances) as (keyof typeof rule.chances)[])rule.chances[slot]=0;
  rule.chances.money=9000;rule.uniqueChance.numerator=0;delete rule.spawn;
  assert.equal(rollBreakableLoot(data,stats,'jar',1,100,()=>0.05).rewards.length,1);
});

test('breakable loot uses the same rolled result shape as a chest', () => {
  const result = rollBreakableLoot(catalog, stats, 'jar', 5, 10, () => 0, {});
  assert.ok(Array.isArray(result.rewards));
  assert.ok(Array.isArray(result.enemies));
  for (const reward of result.rewards) {
    if (reward.kind === 'item') assert.equal(reward.quantity, 1);
  }
});

test('a defeated breakable opens one death ticket and reports its settlement', async t => {
  t.mock.method(Math, 'random', () => 0.2);
  let syncs = 0;
  const removals: string[] = [], settled: Record<string, unknown>[] = [];
  const enemy = battle.enemies.find(value => value.id === BREAKABLE_ENEMY_IDS.jar)!;
  const spawn = { id: 'spawn', enemyId: enemy.id, x: 80, y: 64, breakableEligible: true };
  const map: WorldMap = {
    id: 'breakable-map', name: 'breakable-map', width: 320, height: 320, tileSize: 16, columns: 20, rows: 20,
    blocked: Array<boolean>(400).fill(false), ground: '', canopy: '', features: [], entities: [], exits: [],
    lootLevel: 0, enemySpawns: [spawn],
  };
  const hero = new BattleCharacter('dark-knight', stats, items);
  const session = new Session(campaign, undefined, undefined, items, hero, battle, stats, companions);
  const roster = new WorldEnemyRoster(session, map, [], hero.level);
  roster.refresh();
  roster.setEnemyHealth(spawn.id, 1, enemy);
  t.mock.method(session, 'settleEnemyDefeat', (input: Record<string, unknown>) => {
    settled.push(input);
    session.enemyDefeated(spawn);
    return { settlement: { isBreakable: true } as never, levelledIds: [], notify() {} };
  });
  const phaserScene = createFakePhaserScene();
  (phaserScene.tweens as unknown as Record<string, unknown>).killTweensOf = () => {};
  const origSprite = phaserScene.add.sprite as unknown as (...args: unknown[]) => { scene: unknown; anims: Record<string, unknown> };
  phaserScene.add.sprite = ((...args: unknown[]) => {
    const sprite = origSprite(...args);
    sprite.scene = phaserScene;
    sprite.anims.create = () => ({ destroy() {} });
    return sprite;
  }) as unknown as typeof phaserScene.add.sprite;
  const world = await createTestWorldCombat({ phaserScene, map, hero, session, roster, drops: catalog, battleCatalog: battle });
  const origRemove = world.combat.removeEnemy.bind(world.combat);
  t.mock.method(world.combat, 'removeEnemy', (key: string) => {
    removals.push(key);
    return origRemove(key);
  });
  const origSync = world.combat.syncChestEnemies.bind(world.combat);
  t.mock.method(world.combat, 'syncChestEnemies', () => {
    syncs += 1;
    return origSync();
  });
  await world.combat.start();
  world.combat.selectEnemy(spawn.id);
  world.combat.attack();
  for (let i = 0; i < 20 && settled.length === 0; i++) world.combat.update(60, true);
  world.combat.settleForSave();

  assert.equal(settled.length, 1, '一次击杀只开一张死亡单');
  const input = settled[0]!;
  assert.equal(input.key, spawn.id);
  assert.equal(input.spawn, spawn);
  assert.equal(input.map, 'breakable-map');
  assert.equal(input.enemyLevel, 1);
  assert.equal(input.earnsExperience, true, '由队伍命中，经验由奖励层按景物怪规则决定');
  assert.equal(input.drops, catalog);
  assert.deepEqual(removals, [spawn.id]);
  assert.equal(syncs, 1, '景物结算后同步衍生怪');
  world.combat.destroy();
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseBattle, parseCampaign, parseItemCatalog, parseMap, parseWorld } from '../src/application/content-validation.ts';
import { validateStoryReferences } from '../src/application/story-reference-validation.ts';
import { NavigationWorld } from '../src/domain/navigation-world.ts';

const read = (name: string): unknown => JSON.parse(readFileSync(new URL(`../public/content/${name}.json`, import.meta.url), 'utf8'));
const world = parseWorld(read('world')), campaign = parseCampaign(read('campaign'));
const battle = parseBattle(read('battle')), items = parseItemCatalog(read('items'));
const maps = new Map(world.maps.map(ref => {
  const map = parseMap(read(ref.file.replace(/^content\//, '').replace(/\.json$/, '')));
  return [map.id, map] as const;
}));
const mine = maps.get('mines-west-section2-b1-83d7f81e')!;

test('quest 49 exposes its seven native copper positions and each is reachable from the exported entrance', () => {
  // QUESTGENBASE 行0–6，格坐标先乘16再加8，均位于原地图69；运行测试只读游戏产物。
  const points = [[56, 120], [248, 152], [392, 152], [392, 296], [168, 312], [88, 280], [136, 376]];
  assert.deepEqual(mine.questItemSpawns?.map(spawn => [spawn.x, spawn.y]), points);
  assert.ok(mine.questItemSpawns?.every(spawn => spawn.quest === 'quest-49' && spawn.item === 'lumps-of-copper'));
  const start = { x: 456, y: 104 };
  assert.ok([...maps.values()].some(map => map.exits.some(exit => exit.destination === mine.id
    && exit.spawn.x === start.x && exit.spawn.y === start.y)), '入口仍由真实出口提供');
  const navigation = new NavigationWorld(mine);
  const player = { position: () => start, shape: () => world.actors[campaign.start.actor], enabled: () => true };
  navigation.register(player);
  for (const entity of mine.entities) navigation.register({ position: () => entity, shape: () => world.actors[entity.actor], enabled: () => true });
  for (const spawn of mine.questItemSpawns!) {
    assert.equal(navigation.canStand(player, spawn), true, spawn.id);
    assert.ok(navigation.path(player, spawn), spawn.id);
  }
});

test('map parsing rejects duplicate quest item identifiers, invalid frame intervals and coordinates outside the map', () => {
  const duplicate = structuredClone(mine);
  duplicate.questItemSpawns![1].id = duplicate.questItemSpawns![0].id;
  assert.throws(() => parseMap(duplicate), /questItemSpawns/);
  const frames = structuredClone(mine);
  frames.questItemSpawns![0].respawnFrames = -1;
  assert.throws(() => parseMap(frames), /respawnFrames/);
  const outside = structuredClone(mine);
  outside.questItemSpawns![0].x = outside.width;
  assert.throws(() => parseMap(outside), /任务物品生成点超出地图/);
});

test('shared content reference validation checks map quest item and quest identifiers', () => {
  validateStoryReferences(campaign, world, battle, maps, items);
  const missingItem = structuredClone(mine);
  missingItem.questItemSpawns![0].item = 'missing-item';
  assert.throws(() => validateStoryReferences(campaign, world, battle, new Map(maps).set(mine.id, missingItem), items), /地图任务物品不存在 missing-item/);
  const missingQuest = structuredClone(mine);
  missingQuest.questItemSpawns![0].quest = 'missing-quest';
  assert.throws(() => validateStoryReferences(campaign, world, battle, new Map(maps).set(mine.id, missingQuest), items), /地图任务物品引用任务不存在 missing-quest/);
});

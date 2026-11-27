import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { BattleCatalog } from '../src/domain/battle.ts';
import { BattleCharacter } from '../src/domain/character-stats.ts';
import { CombatActorStats } from '../src/domain/combat-actor-stats.ts';
import type { ActorDefinition, WorldMap } from '../src/domain/content.ts';
import { EnemyRoster } from '../src/domain/enemy-roster.ts';
import {
  PRESSURE_DEFAULT_MAX_ENEMIES,
  PRESSURE_MAX_ENEMIES_LIMIT,
  PRESSURE_MAX_HEALTH_LIMIT,
  normalizePressureEnemyHealth,
  normalizePressureMaxEnemies,
  pressureEnemy,
} from '../src/domain/pressure-enemies.ts';
import { Session } from '../src/domain/session.ts';
import { CHARACTER_ATLAS_ALIASES } from '../tools/character-atlas-aliases.ts';
import {
  loadCampaignCatalog,
  loadCharacterStatsCatalog,
  loadCompanionCatalog,
  loadItemCatalog,
} from './support/combat-test-harness.ts';
import { createFakePhaserScene, createTestWorldCombat } from './support/world-combat-fixture.ts';
import { buildTestWorldScene, loadWorldSceneClass } from './support/world-scene-fixture.ts';

const WorldScene = await loadWorldSceneClass();

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

const battle = normalizeBattleCatalog(JSON.parse(readFileSync(new URL('../public/content/battle.json', import.meta.url), 'utf8')) as BattleCatalog);

function fullPhaserScene() {
  const scene = createFakePhaserScene({
    cameras: { main: { width: 640, height: 360, zoomX: 1, zoomY: 1, worldView: undefined, followOffset: { x: 0, y: 0 }, setFollowOffset() {} } },
    tweens: { add: () => ({ stop() {}, pause() {}, resume() {} }), getTweensOf: () => [], killTweensOf: () => {} },
  });
  const origSprite = scene.add.sprite.bind(scene.add) as unknown as (...args: unknown[]) => { scene: unknown; anims: Record<string, unknown> };
  scene.add.sprite = ((...args: unknown[]) => {
    const sprite = origSprite(...args);
    sprite.scene = scene;
    sprite.anims = { ...sprite.anims, create: () => ({ destroy() {} }), remove: () => {} };
    return sprite as never;
  }) as never;
  return scene;
}

function openMap(id: string, tiles = 64): WorldMap {
  return {
    id, name: id, width: tiles * 16, height: tiles * 16, tileSize: 16, columns: tiles, rows: tiles,
    blocked: Array<boolean>(tiles * tiles).fill(false), ground: '', canopy: '', features: [], entities: [], exits: [],
    enemySpawns: [],
  };
}

test('压测刷怪达到上限后不再生成', async () => {
  const world = await createTestWorldCombat({
    map: openMap('pressure-cap-map', 64),
    battleCatalog: battle,
    phaserScene: fullPhaserScene(),
    appOverrides: { pressureMode: true },
  });
  await world.combat.start();
  for (let index = 0; index < PRESSURE_DEFAULT_MAX_ENEMIES; index++) {
    const point = { x: 80 + (index % 8) * 96, y: 80 + Math.floor(index / 8) * 96 };
    assert.equal(world.combat.spawnPressureEnemy('enemy-red-snake-1', point), true);
  }
  assert.equal(world.combat.spawnPressureEnemy(), false);
  world.combat.destroy();
});

test('压测阵亡只补满倒下的成员，全灭入口不进入阵亡状态', async () => {
  const items = loadItemCatalog(), statsCatalog = loadCharacterStatsCatalog();
  const campaign = loadCampaignCatalog(), companions = loadCompanionCatalog();
  const hero = new BattleCharacter('dark-knight', statsCatalog, items);
  const session = new Session(campaign, undefined, undefined, items, hero, battle, statsCatalog, companions);
  session.bag.add('mercenary-emblem-black-knight');
  const ally = session.party!.recruit(session.bag.entries.find(e => e.item === 'mercenary-emblem-black-knight')!.id, () => 0).member;
  session.party!.deployFirstAvailable(ally.id);
  const actor = battle.classes.find(entry => entry.id === ally.classId)!.actor;
  const revived: string[] = [];
  let defeatHandled = 0;
  const world = await createTestWorldCombat({
    hero, session, map: openMap('pressure-revive-map', 20), battleCatalog: battle, phaserScene: fullPhaserScene(),
    appOverrides: {
      pressureMode: true,
      world: { actors: { [ally.definition.actor]: actor, [actor.id]: actor } } as never,
    },
    sceneOverrides: {
      reviveMember: (id: string) => {
        revived.push(id);
        if (id === 'player') hero.setHealth(hero.player.maxHealth);
        else ally.setHealth(ally.player.maxHealth);
        return { ok: true };
      },
      handleCombatDefeat: () => { defeatHandled++; },
    },
  });
  await world.combat.start();
  hero.setHealth(0);
  world.combat.reviveFallenForPressure();
  assert.deepEqual(revived, ['player']);

  hero.setHealth(0);
  ally.setHealth(0);
  world.combat.update(16, false);
  assert.equal(defeatHandled, 0, '压测全灭不进入 defeated');
  assert.deepEqual(revived, ['player', 'player', ally.id], '全灭入口会再次尝试补满倒下成员');
  world.combat.destroy();
});

test('压测模式拒绝手动存档和检查点', () => {
  const host = buildTestWorldScene(WorldScene, { app: { pressureMode: true, session: {} } });
  assert.deepEqual(host.captureSaveWorld(), { ok: false, reason: 'pressure' });
  assert.equal(host.captureCheckpoint(), false);
});


test('挑战怪物按角色等级随机选择普通战斗怪', () => {
  const first = pressureEnemy(battle.enemies, 1, () => 0)!;
  const last = pressureEnemy(battle.enemies, 1, () => 0.999999)!;
  assert.notEqual(first.id, last.id);
  assert.ok(first.level !== null && first.level <= 3);
  assert.ok(last.level !== null && last.level <= 3);
  assert.equal(first.specialRank, 0);
  const higher = pressureEnemy(battle.enemies, 44, () => 0)!;
  assert.ok(higher.level !== null && Math.abs(higher.level - 44) <= 2);
  assert.equal(pressureEnemy([], 1), undefined);
});

test('挑战模式先按出生点刷怪，补怪达到上限时不加载素材', async () => {
  const created: {id:string;point?:{x:number;y:number}}[]=[];
  let callback=()=>{};
  let allowed=true;
  const host = buildTestWorldScene(WorldScene, {
    app: { pressureMode: true, battleCatalog: battle, session: { hero: { level: 1 } } },
    combat: {
      canSpawnPressureEnemy: () => allowed,
      preparePressureEnemy: async () => true,
      spawnPressureEnemy: (id: string, point?: { x: number; y: number }) => created.push({ id, point }),
    },
    sceneOverrides: {
      pressureStartPoints: [{ x: 10, y: 20 }, { x: 30, y: 40 }],
      time: { addEvent: (options: { callback: () => void }) => { callback = options.callback; return {}; } },
    },
  });
  await host.startPressureSpawner();
  assert.deepEqual(created.map(entry=>entry.point),[{x:10,y:20},{x:30,y:40}]);
  allowed=false;callback();
  assert.equal(created.length,2);
  allowed=true;callback();await Promise.resolve();
  assert.equal(created.length,3);
});

test('挑战模式异步加载刷怪期间若世界已暂停，加载完成后不再刷怪', async () => {
  const created: string[] = [];
  let paused = false;
  let releaseLoad!: (ok: boolean) => void;
  let callback = () => {};
  const host = buildTestWorldScene(WorldScene, {
    app: { pressureMode: true, battleCatalog: battle, session: { hero: { level: 1 } } },
    combat: {
      canSpawnPressureEnemy: () => true,
      preparePressureEnemy: () => new Promise<boolean>(resolve => { releaseLoad = resolve; }),
      spawnPressureEnemy: (id: string) => { created.push(id); return true; },
    },
    sceneOverrides: {
      pressureStartPoints: [],
      scene: { isPaused: () => paused },
      time: { addEvent: (options: { callback: () => void }) => { callback = options.callback; return {}; } },
    },
  });

  await host.startPressureSpawner();
  callback();
  paused = true;
  releaseLoad(true);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(created, [], '暂停期间不应把刚加载完的怪刷到场上');

  paused = false;
  callback();
  releaseLoad(true);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(created.length, 1, '恢复运行后继续正常刷怪');
});

test('挑战调试参数归一化遵守默认与上下限边界', () => {
  assert.equal(normalizePressureMaxEnemies(Number.NaN), PRESSURE_DEFAULT_MAX_ENEMIES);
  assert.equal(normalizePressureMaxEnemies(-5), 0);
  assert.equal(normalizePressureMaxEnemies(12.9), 12);
  assert.equal(normalizePressureMaxEnemies(999), PRESSURE_MAX_ENEMIES_LIMIT);
  assert.equal(normalizePressureEnemyHealth(undefined), undefined);
  assert.equal(normalizePressureEnemyHealth(Number.NaN), undefined);
  assert.equal(normalizePressureEnemyHealth(0), 1);
  assert.equal(normalizePressureEnemyHealth(-100), 1);
  assert.equal(normalizePressureEnemyHealth(12345.8), 12345);
  assert.equal(normalizePressureEnemyHealth(PRESSURE_MAX_HEALTH_LIMIT + 500), PRESSURE_MAX_HEALTH_LIMIT);
});

test('EnemyRoster 覆写与清除最大血量会更新活怪上限、允许高血量扣血且不复活 0 血怪', () => {
  const roster = new EnemyRoster();
  const definition = battle.enemies.find(enemy => enemy.id === 'enemy-red-snake-1')!;
  const alive = roster.placeEnemy(definition.id, 10, 20);
  const dead = roster.placeEnemy(definition.id, 30, 40);
  const defaultMax = roster.enemySnapshot(alive.key, definition)!.maxHealth;
  roster.setEnemyHealth(dead.key, 0, definition);

  roster.setEnemyMaxHealthOverride(alive.key, 10_000, definition);
  roster.setEnemyMaxHealthOverride(dead.key, 10_000, definition);
  assert.equal(roster.enemySnapshot(alive.key, definition)!.maxHealth, 10_000);
  assert.equal(roster.enemySnapshot(alive.key, definition)!.health, 10_000);
  assert.equal(roster.enemySnapshot(dead.key, definition)!.health, 0, '不复活 0 血待结算怪');

  roster.setEnemyHealth(alive.key, 6_500, definition);
  assert.equal(roster.enemySnapshot(alive.key, definition)!.health, 6_500, '受击扣血不被原版低上限截断');

  roster.setPartySize(3, battle.enemies);
  assert.equal(roster.enemySnapshot(alive.key, definition)!.maxHealth, 10_000, '队伍人数变化保留血量覆盖');
  assert.equal(roster.enemySnapshot(alive.key, definition)!.health, 6_500);

  roster.setEnemyMaxHealthOverride(alive.key, undefined, definition);
  const restored = roster.enemySnapshot(alive.key, definition)!;
  assert.notEqual(restored.maxHealth, 10_000);
  assert.equal(restored.health, restored.maxHealth);
  assert.ok(restored.maxHealth >= defaultMax);
});

test('挑战调试修改怪物数量与血量：新刷怪遵循自定义参数，调低数量立刻裁减且跳过召唤物与待死亡怪', async t => {
  t.mock.method(Math, 'random', () => 0.5);
  const definition = battle.enemies.find(enemy => enemy.id === 'enemy-red-snake-1')!;
  const items = loadItemCatalog(), statsCatalog = loadCharacterStatsCatalog(), campaign = loadCampaignCatalog();
  const hero = new BattleCharacter('warlock', statsCatalog, items);
  const session = new Session(campaign, undefined, undefined, items, hero, battle);
  session.skills.maxAll();
  session.skills.bar().assign(0, 0, { kind: 'skill', id: 'hell-s-pawn' });
  const pressureSettings: { maxEnemies: number; enemyMaxHealth?: number } = { maxEnemies: 5, enemyMaxHealth: undefined };
  let targetRefreshes = 0;
  const world = await createTestWorldCombat({
    hero, session, map: openMap('pressure-settings-map', 32), battleCatalog: battle, phaserScene: fullPhaserScene(),
    appOverrides: { pressureMode: true, pressureSettings },
    sceneOverrides: { refreshCombatTarget: () => { targetRefreshes++; } },
  });
  await world.combat.start();

  // 先召出友方召唤物，再刷 4 只普通怪并把第 4 只打进待死亡队列。
  world.combat.attack('hell-s-pawn');
  for (let step = 0; step < 7; step++) world.combat.update(60, true);
  const summonKey = world.roster.enemies.find(entry => entry.summonedBy === 'player')!.key;
  assert.equal(world.combat.spawnPressureEnemy(definition.id, { x: 180, y: 120 }), true);
  assert.equal(world.combat.spawnPressureEnemy(definition.id, { x: 240, y: 120 }), true);
  assert.equal(world.combat.spawnPressureEnemy(definition.id, { x: 300, y: 120 }), true);
  assert.equal(world.combat.spawnPressureEnemy(definition.id, { x: 104, y: 64 }), true);
  const [placed1, placed2, placed3, dying] = world.roster.enemies.filter(entry => entry.key !== summonKey);
  world.roster.setEnemyHealth(dying.key, 1, definition);
  world.combat.selectEnemy(dying.key);
  world.combat.attack();
  for (let step = 0; step < 20 && world.roster.enemySnapshot(dying.key, definition, hero.level)!.health > 0; step++) {
    world.combat.update(60, true);
  }
  assert.equal(world.roster.enemySnapshot(dying.key, definition, hero.level)!.health, 0);

  const capacityUpdated: string[] = [];
  const origInputs = CombatActorStats.prototype.resourceCapacityInputs;
  t.mock.method(CombatActorStats.prototype, 'resourceCapacityInputs', function (this: CombatActorStats, id: string) {
    capacityUpdated.push(id);
    return origInputs.call(this, id);
  });

  pressureSettings.maxEnemies = 2;
  assert.equal(world.combat.pressureEnemyCount(), 3, '只统计活着的非召唤普通怪');
  world.combat.applyPressureSettings();
  assert.equal(world.roster.isPresent(placed3.key), false, '调低上限后立刻裁减超出部分且不碰召唤物和待死亡怪');
  assert.equal(world.roster.isPresent(summonKey), true);
  assert.equal(world.combat.pressureEnemyCount(), 2);
  assert.equal(world.combat.canSpawnPressureEnemy(), false, '达到自定义上限 2 时不可继续刷怪');

  pressureSettings.enemyMaxHealth = 50_000;
  targetRefreshes = 0;
  capacityUpdated.length = 0;
  world.combat.applyPressureSettings({ applyHealth: true });
  assert.equal(world.roster.enemySnapshot(placed1.key, definition)!.maxHealth, 50_000);
  assert.equal(world.roster.enemySnapshot(placed2.key, definition)!.health, 50_000);
  const summonDef = battle.enemies.find(entry => entry.id === 'enemy-hell-s-pawn-1')!;
  assert.notEqual(world.roster.enemySnapshot(summonKey, summonDef)!.maxHealth, 50_000, '友方召唤物不应用怪物血量覆盖');
  assert.notEqual(world.roster.enemySnapshot(dying.key, definition)!.maxHealth, 50_000, '待死亡结算怪不应用血量覆盖');
  assert.deepEqual(capacityUpdated, [placed1.key, placed2.key]);
  assert.equal(targetRefreshes, 1);

  pressureSettings.maxEnemies = 3;
  assert.equal(world.combat.canSpawnPressureEnemy(), true, '提高上限后允许继续刷怪');
  assert.equal(world.combat.spawnPressureEnemy(definition.id, { x: 220, y: 220 }), true);
  assert.equal(world.combat.pressureEnemyCount(), 3);
  const newest = world.roster.enemies.at(-1)!;
  assert.equal(world.roster.enemySnapshot(newest.key, definition)!.maxHealth, 50_000, '新刷出的怪立即继承固定血量覆盖');

  pressureSettings.maxEnemies = 0;
  world.combat.applyPressureSettings();
  assert.equal(world.combat.pressureEnemyCount(), 0, '设为 0 时清空场上所有普通怪');
  assert.equal(world.combat.spawnPressureEnemy(definition.id), false);
  world.combat.destroy();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { PendingEnemyDefeats } from '../src/domain/combat-outcomes.ts';
import type { BattleCatalog } from '../src/domain/battle.ts';
import { EnemyRoster } from '../src/domain/enemy-roster.ts';
import {
  PRESSURE_DEFAULT_MAX_ENEMIES,
  PRESSURE_MAX_ENEMIES_LIMIT,
  PRESSURE_MAX_HEALTH_LIMIT,
  normalizePressureEnemyHealth,
  normalizePressureMaxEnemies,
  pressureEnemy,
} from '../src/domain/pressure-enemies.ts';

const hook = registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'phaser'
      ? { url: 'data:text/javascript,export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}}}', shortCircuit: true }
      : next(specifier, context);
  }
});
const { WorldCombat } = await import('../src/scenes/world-combat.ts');
const { WorldScene } = await import('../src/scenes/world-scene.ts');
hook.deregister();

const battle = JSON.parse(readFileSync(new URL('../public/content/battle.json', import.meta.url), 'utf8')) as BattleCatalog;

function combatHost(overrides: Record<string, unknown> = {}) {
  return Object.setPrototypeOf({
    closed: false, defeated: false, movement: {}, arena: [], pendingDefeats: new PendingEnemyDefeats(),
    app: { battleCatalog: battle, session: { party: { activeIds: [] } } },
    ...overrides
  }, WorldCombat.prototype) as {
    closed: boolean; defeated: boolean; arena: unknown[]; app: unknown;
    spawnPressureEnemy(enemyId?: string): boolean;
    reviveFallenForPressure(): void;
  };
}

test('压测刷怪达到上限后不再生成', () => {
  const host = combatHost({ arena: Array.from({ length: 40 }, (_, index) => ({ key: `enemy-${index}` })) });
  assert.equal(host.spawnPressureEnemy(), false);
});

test('压测阵亡只补满倒下的成员，全灭入口不进入阵亡状态', () => {
  const revived: string[] = [];
  const host = combatHost({
    app: { pressureMode: true, battleCatalog: battle, session: { party: { activeIds: ['player', 'ally'] } } },
    memberOf: (id: string) => ({ player: { health: id === 'player' ? 0 : 100 } }),
    scene: { reviveMember: (id: string) => { revived.push(id); return { ok: true }; } }
  });
  host.reviveFallenForPressure();
  assert.deepEqual(revived, ['player']);

  const playerDefeated = Reflect.get(WorldCombat.prototype, 'playerDefeated') as (this: unknown) => void;
  playerDefeated.call(host);
  assert.equal(host.defeated, false, '压测全灭不进入 defeated');
  assert.deepEqual(revived, ['player', 'player'], '全灭入口会再次尝试补满倒下成员');
});

test('压测模式拒绝手动存档和检查点', () => {
  const host = Object.setPrototypeOf({ app: { pressureMode: true }, session: {} }, WorldScene.prototype) as {
    app: { pressureMode: boolean };
  };
  const captureSaveWorld = WorldScene.prototype.captureSaveWorld as (this: unknown) => unknown;
  assert.deepEqual(captureSaveWorld.call(host), { ok: false, reason: 'pressure' });
  const captureCheckpoint = Reflect.get(WorldScene.prototype, 'captureCheckpoint') as (this: unknown) => boolean;
  assert.equal(captureCheckpoint.call(host), false);
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
  const host=Object.setPrototypeOf({
    app:{pressureMode:true,battleCatalog:battle,session:{hero:{level:1}}},
    request:new AbortController(),destroyed:false,pressureStartPoints:[{x:10,y:20},{x:30,y:40}],
    combat:{canSpawnPressureEnemy:()=>allowed,preparePressureEnemy:async()=>true,
      spawnPressureEnemy:(id:string,point?:{x:number;y:number})=>created.push({id,point})},
    time:{addEvent:(options:{callback:()=>void})=>{callback=options.callback;return {};}}
  },WorldScene.prototype) as InstanceType<typeof WorldScene>;
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
  const host = Object.setPrototypeOf({
    app: { pressureMode: true, battleCatalog: battle, session: { hero: { level: 1 } } },
    request: new AbortController(),
    destroyed: false,
    pressureStartPoints: [],
    scene: { isPaused: () => paused },
    combat: {
      canSpawnPressureEnemy: () => true,
      preparePressureEnemy: () => new Promise<boolean>(resolve => { releaseLoad = resolve; }),
      spawnPressureEnemy: (id: string) => { created.push(id); return true; },
    },
    time: { addEvent: (options: { callback: () => void }) => { callback = options.callback; return {}; } },
  }, WorldScene.prototype) as InstanceType<typeof WorldScene>;

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

test('挑战调试修改怪物数量与血量：新刷怪遵循自定义参数，调低数量立刻裁减且跳过召唤物与待死亡怪', () => {
  const definition = battle.enemies.find(enemy => enemy.id === 'enemy-red-snake-1')!;
  const roster = new EnemyRoster();
  const placed1 = roster.placeEnemy(definition.id, 10, 10);
  const placed2 = roster.placeEnemy(definition.id, 20, 10);
  const placed3 = roster.placeEnemy(definition.id, 30, 10);
  const summon = roster.placeEnemy(definition.id, 40, 10);
  const dying = roster.placeEnemy(definition.id, 50, 10);
  const pendingDefeats = new PendingEnemyDefeats();
  pendingDefeats.add(dying.key, () => {});

  const removed: string[] = [];
  const capacityUpdated: string[] = [];
  let targetRefreshes = 0;
  const arena = [
    { key: placed1.key, definition },
    { key: placed2.key, definition },
    { key: placed3.key, definition },
    { key: summon.key, definition, summonedBy: 'player' },
    { key: dying.key, definition },
  ];
  const pressureSettings: { maxEnemies: number; enemyMaxHealth?: number } = { maxEnemies: 2, enemyMaxHealth: undefined };
  const host = Object.setPrototypeOf({
    closed: false, defeated: false, movement: {
      position: () => ({ x: 100, y: 100 }),
      navigation: { canPlaceBody: () => true },
    },
    controlledVisual: {},
    roster,
    arena,
    pendingDefeats,
    app: { pressureMode: true, pressureSettings, battleCatalog: battle, session: { party: { activeIds: [] } } },
    scene: { refreshCombatTarget: () => { targetRefreshes++; } },
    removeEnemy(key: string) {
      removed.push(key);
      const index = arena.findIndex(entry => entry.key === key);
      if (index >= 0) arena.splice(index, 1);
      roster.removeEnemy(key);
    },
    resourceCapacityInputs(key: string) { capacityUpdated.push(key); },
    buildEnemy(placed: { key: string }, def: typeof definition) { return { key: placed.key, definition: def }; },
  }, WorldCombat.prototype) as unknown as {
    canSpawnPressureEnemy(): boolean;
    spawnPressureEnemy(enemyId?: string, initialPoint?: { x: number; y: number }): boolean;
    pressureEnemyCount(): number;
    applyPressureSettings(options?: { applyHealth?: boolean }): void;
  };

  assert.equal(host.pressureEnemyCount(), 3, '只统计活着的非召唤普通怪');
  host.applyPressureSettings();
  assert.deepEqual(removed, [placed3.key], '调低上限后立刻裁减超出部分且不碰召唤物和待死亡怪');
  assert.equal(host.pressureEnemyCount(), 2);
  assert.equal(host.canSpawnPressureEnemy(), false, '达到自定义上限 2 时不可继续刷怪');

  pressureSettings.enemyMaxHealth = 50_000;
  host.applyPressureSettings({ applyHealth: true });
  assert.equal(roster.enemySnapshot(placed1.key, definition)!.maxHealth, 50_000);
  assert.equal(roster.enemySnapshot(placed2.key, definition)!.health, 50_000);
  assert.notEqual(roster.enemySnapshot(summon.key, definition)!.maxHealth, 50_000, '友方召唤物不应用怪物血量覆盖');
  assert.notEqual(roster.enemySnapshot(dying.key, definition)!.maxHealth, 50_000, '待死亡结算怪不应用血量覆盖');
  assert.deepEqual(capacityUpdated, [placed1.key, placed2.key]);
  assert.equal(targetRefreshes, 1);

  pressureSettings.maxEnemies = 3;
  assert.equal(host.canSpawnPressureEnemy(), true, '提高上限后允许继续刷怪');
  assert.equal(host.spawnPressureEnemy(definition.id, { x: 60, y: 60 }), true);
  assert.equal(host.pressureEnemyCount(), 3);
  const newest = arena.at(-1)!;
  assert.equal(roster.enemySnapshot(newest.key, definition)!.maxHealth, 50_000, '新刷出的怪立即继承固定血量覆盖');

  pressureSettings.maxEnemies = 0;
  host.applyPressureSettings();
  assert.equal(host.pressureEnemyCount(), 0, '设为 0 时清空场上所有普通怪');
  assert.equal(host.spawnPressureEnemy(definition.id), false);
});

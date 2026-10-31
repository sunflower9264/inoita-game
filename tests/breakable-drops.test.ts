import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import type { BattleCatalog } from '../src/domain/battle.ts';
import type { CharacterStatsCatalog } from '../src/domain/character-stats.ts';
import { ChestVisits } from '../src/domain/chests.ts';
import { CombatConditions } from '../src/domain/combat-conditions.ts';
import { CombatHitResolution } from '../src/domain/combat-hit-resolution.ts';
import { PendingEnemyDefeats } from '../src/domain/combat-outcomes.ts';
import { BREAKABLE_ENEMY_IDS, breakableKindOf, parseDrops, rollBreakableLoot } from '../src/domain/drops.ts';
import type { ItemCatalog } from '../src/domain/items.ts';

const hook = registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'phaser'
      ? { url: 'data:text/javascript,export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}}}', shortCircuit: true }
      : next(specifier, context);
  }
});
const { WorldCombat } = await import('../src/scenes/world-combat.ts');
hook.deregister();

const read = <T>(name: string): T => JSON.parse(readFileSync(new URL(`../public/content/${name}.json`, import.meta.url), 'utf8')) as T;
const items = read<ItemCatalog>('items');
const battle = read<BattleCatalog>('battle');
const stats = read<CharacterStatsCatalog>('character-stats');
const catalog = parseDrops(read<Record<string, unknown>>('drops'), items, battle.enemies.map(enemy => enemy.id));

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

test('a defeated breakable rolls once, skips experience and pity, and keeps quest drops', t => {
  t.mock.method(Math, 'random', () => 0);
  const chests = new ChestVisits();
  chests.enterMap('breakable-map');
  let experience = 0, pityRecords = 0, syncs = 0;
  const defeated: unknown[] = [], removals: string[] = [];
  const loot: { rewards: readonly unknown[]; rendered: boolean }[] = [];
  const session = {
    party: { livingIds: ['player'], groupModifiers: () => ({}), addExperience: (value: number) => { experience += value; } },
    isOneHitKill: () => false,
    chests,
    questDropRequirements: () => [],
    enemyDefeated: (spawn: unknown) => { defeated.push(spawn); },
    lootPity: { recordEnemy: () => { pityRecords += 1; }, takeBossFirstDefeat: () => false }
  };
  const enemy = battle.enemies.find(value => value.id === BREAKABLE_ENEMY_IDS.jar)!;
  const spawn = { id: 'spawn', enemyId: enemy.id, x: 10, y: 20, breakableEligible: true };
  const target = { key: spawn.id, definition: enemy,
    visual: { container: { x: 10, y: 20, active: true, disableInteractive() {} } }, presenter: { clear() {} } };
  const hero = { level: 10 };
  let enemyHealth = 1;
  const roster = {
    enemySnapshot: () => ({ health: enemyHealth, maxHealth: 1000, level: 1, elite: false }),
    source: () => spawn, setEnemyHealth: (_key: string, value: number) => { enemyHealth = value; }
  };
  const scene = { map: { id: 'breakable-map', lootLevel: 0 }, refreshCombatTarget() {},
    spawnLootOnMap: (_map: string, _x: number, _y: number, rewards: readonly unknown[], rendered: boolean) => {
      loot.push({ rewards, rendered });
    } };
  const host = Object.setPrototypeOf({
    app: { session, characterStats: stats, audio: { monsterDeath() {} }, director: { healthChanged: () => false } },
    drops: catalog, conditions: new CombatConditions(), hitResolution: new CombatHitResolution(),
    pendingDefeats: new PendingEnemyDefeats(), roster, scene, hero, arena: [],
    memberOf: (id: string) => id === 'player' ? { player: { health: 100 }, level: 10 } : undefined,
    removeEnemy: (key: string) => { removals.push(key); }, syncChestEnemies: () => { syncs += 1; },
    outcomes: { cancelDeath() {}, vanish() {}, levelUp() {} },
    runtime: { cancel() {}, schedule() {} }, movement: { stop() {}, setEnabled() {} },
    partyControllers: new Map(), showHit() {}
  }, WorldCombat.prototype);
  Reflect.get(WorldCombat.prototype, 'settleHit').call(host,
    { casterId: 'player', targetId: spawn.id }, { damage: 5 }, hero, target);

  assert.deepEqual(defeated, [spawn]);
  assert.deepEqual(removals, [spawn.id]);
  assert.equal(syncs, 1);
  assert.equal(experience, 0, '景物怪不给经验');
  assert.equal(pityRecords, 0, '景物怪不记录装备保底');
  assert.equal(loot.length, 2, '景物奖励与任务掉落各结算一次');
  assert.ok(loot[0]!.rewards.length > 0);
  assert.deepEqual(loot[1]!.rewards, []);
  assert.deepEqual(chests.spawns.map(value => value.enemyId), ['enemy-barrel-of-toxic-waste-1']);
  assert.equal(chests.spawns[0]!.id, 'breakable:1:breakable-map:spawn:0');
});

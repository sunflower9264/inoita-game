import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import type { BattleCatalog } from '../src/domain/battle.ts';
import type { CharacterStatsCatalog } from '../src/domain/character-stats.ts';
import { BattleCharacter } from '../src/domain/character-stats.ts';
import { ChestVisits } from '../src/domain/chests.ts';
import { CombatConditions } from '../src/domain/combat-conditions.ts';
import { CombatHitResolution } from '../src/domain/combat-hit-resolution.ts';
import { PendingEnemyDefeats } from '../src/domain/combat-outcomes.ts';
import { parseDrops, type DropCatalog, type QuestDropRequirement } from '../src/domain/drops.ts';
import type { ItemCatalog } from '../src/domain/items.ts';
import { LootPity } from '../src/domain/loot-pity.ts';
import { calculateEnemy } from '../src/domain/enemy-stats.ts';

const phaser = registerHooks({ resolve(specifier, context, next) {
  return specifier === 'phaser'
    ? { shortCircuit: true, url: 'data:text/javascript,export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}}}' }
    : next(specifier, context);
}});
const { WorldCombat } = await import('../src/scenes/world-combat.ts');
phaser.deregister();

const read = <T>(name: string): T => JSON.parse(readFileSync(new URL(`../public/content/${name}.json`, import.meta.url), 'utf8')) as T;
const items = read<ItemCatalog>('items');
const battle = read<BattleCatalog>('battle');
const stats = read<CharacterStatsCatalog>('character-stats');
const drops = parseDrops(read<Record<string, unknown>>('drops'), items, battle.enemies.map(enemy => enemy.id));

interface RewardCall { map: string; x: number; y: number; rewards: readonly { kind: string; item?: string; amount?: number; roll?: { rarity: number } }[]; rendered: boolean }
interface Member { id: string; level: number }

interface HarnessOptions {
  enemyId?: string;
  heroLevel?: number;
  level?: number;
  elite?: boolean;
  lootLevel?: number;
  casterId?: string;
  members?: Member[];
  arena?: { key: string; summonedBy?: string; definition: { commandAction?: unknown } }[];
  quests?: readonly (readonly QuestDropRequirement[])[];
  sceneLevel?: number;
  drops?: DropCatalog;
}

function harness(options: HarnessOptions = {}) {
  const enemyId = options.enemyId ?? 'enemy-slime-1';
  const definition = battle.enemies.find(enemy => enemy.id === enemyId)!;
  const heroLevel = options.heroLevel ?? 10;
  const level = options.level ?? 1;
  const map = 'reward-map';
  const members = options.members ?? [{ id: 'player', level: heroLevel }];
  const memberById = new Map(members.map(member => [member.id, { player: { health: 100 }, level: member.level }]));
  const hero = new BattleCharacter('dark-knight', stats, items);
  hero.restoreState({ ...hero.captureState(), level: heroLevel });

  const experience: number[] = [];
  const pity = new LootPity();
  const chests = new ChestVisits();
  chests.enterMap(map);
  const session = {
    hero: { level: heroLevel },
    party: {
      livingIds: members.map(member => member.id),
      get: (id: string) => memberById.get(id),
      groupModifiers: () => ({}),
      addExperience: (amount: number) => { experience.push(amount); },
    },
    partyItemChance: 0,
    lootPity: pity,
    claimedReservedDrops: new Set<string>(),
    reservedDropMisses: 0,
    chests,
    questDropRequirements: () => options.quests ?? [],
    enemyDefeated: (spawn: unknown) => { defeated.push(spawn); },
    isOneHitKill: () => false,
    enemyVitals: () => ({}),
  };
  const loot: RewardCall[] = [];
  const defeated: unknown[] = [];
  const removals: string[] = [];
  const audio: string[] = [];
  let syncs = 0, enemyHealth = 1;
  const spawn = { id: `spawn-${enemyId}`, enemyId, x: 10, y: 20 };
  const roster = {
    enemySnapshot: () => ({ health: enemyHealth, maxHealth: 1000, level, elite: options.elite ?? false }),
    source: () => spawn,
    setEnemyHealth: (_key: string, value: number) => { enemyHealth = value; },
  };
  const scene = {
    map: { id: map, lootLevel: options.lootLevel ?? 0 },
    refreshCombatTarget() {},
    spawnLootOnMap: (_map: string, x: number, y: number, rewards: RewardCall['rewards'], rendered: boolean) => {
      loot.push({ map: _map, x, y, rewards, rendered });
    },
  };
  const dropCatalog = options.drops ?? drops;
  const target = {
    key: spawn.id, definition, visual: { container: { x: 10, y: 20, active: true, disableInteractive() {} } },
    presenter: { clear() {} },
  };
  const scheduled = new Map<string, () => void>();
  const host = Object.setPrototypeOf({
    app: {
      session, characterStats: stats,
      audio: { monsterDeath: (id: string) => { audio.push(id); } },
      director: { healthChanged: () => false },
    },
    drops: dropCatalog, conditions: new CombatConditions(), hitResolution: new CombatHitResolution(),
    pendingDefeats: new PendingEnemyDefeats(), roster, scene, hero: { level: heroLevel },
    arena: options.arena ?? [],
    allies: [],
    memberOf: (id: string) => memberById.get(id),
    removeEnemy: (key: string) => { removals.push(key); },
    syncChestEnemies: () => { syncs += 1; },
    outcomes: { cancelDeath() {}, vanish() {}, levelUp() {} },
    runtime: { cancel: (key: string) => { scheduled.delete(key); }, schedule: (key: string, _frames: number, work: () => void) => { scheduled.set(key, work); } },
    movement: { stop() {}, setEnabled() {} },
    partyControllers: new Map(), focusTargetId: undefined, closed: false, threat: undefined,
    recordSummonContact() {}, showHit() {},
  }, WorldCombat.prototype) as unknown as {
    app: { session: typeof session };
    scene: typeof scene;
    pendingDefeats: PendingEnemyDefeats;
  };
  const settle = () => {
    (Reflect.get(WorldCombat.prototype, 'settleHit') as
      (this: unknown, event: unknown, hit: unknown, hero: unknown, targetEnemy: unknown) => void)
      .call(host, { casterId: options.casterId ?? 'player', targetId: spawn.id }, { damage: 5 }, hero, target);
    // vanish 敌人会等死亡表现播完再结算；测试里立即推进到结算帧。
    for (const work of [...scheduled.values()]) work();
    scheduled.clear();
  };
  return { host, settle, definition, hero, session, pity, chests, spawn, loot, defeated, removals, audio, experience,
    syncs: () => syncs };
}

test('a normal kill grants experience and rolls ordinary loot for every living member', t => {
  t.mock.method(Math, 'random', () => 0);
  const run = harness({ enemyId: 'enemy-slime-1', heroLevel: 10, level: 1 });
  run.settle();

  const expected = calculateEnemy(run.definition, { level: 1, elite: false, partySize: 1, playerLevel: 10 }).experience;
  assert.deepEqual(run.experience, [expected], '普通击杀按敌人等级、精英和队伍人数结算一次经验');
  assert.deepEqual(run.defeated, [run.spawn], '有地图生成点的敌人写入击杀记录');
  assert.deepEqual(run.removals, [run.spawn.id]);
  assert.deepEqual(run.audio, ['enemy-slime-1'], '击杀音效在结算时提示');
  assert.equal(run.loot.length, 2, '普通掉落与任务掉落各一次');
  const ordinary = run.loot[0]!;
  assert.ok(ordinary.rewards.length > 0, '固定随机源下普通掉落非空');
  assert.ok(ordinary.rewards.some(reward => reward.kind === 'money'), '普通掉落包含货币槽');
  assert.ok(ordinary.rewards.some(reward => reward.kind === 'item'), '普通掉落包含物品槽');
  assert.deepEqual(run.loot[1]!.rewards, [], '没有任务需求时不产出任务掉落');
  assert.equal(run.syncs(), 0, '普通敌人不需要同步宝箱怪');
  assert.equal(run.pity.counters('player').equipmentMisses, 0, '掉出装备后清空装备保底计数');
});

test('a breakable is rolled once with no experience and no pity, and its spawned enemies stay in the visit', t => {
  t.mock.method(Math, 'random', () => 0);
  const run = harness({ enemyId: 'enemy-jar-1', heroLevel: 10 });
  run.settle();

  assert.deepEqual(run.experience, [], '景物怪不给经验');
  assert.equal(run.loot.length, 2, '景物奖励与任务掉落各结算一次');
  assert.ok(run.loot[0]!.rewards.length > 0, '景物奖励按可破坏物规则掷出');
  assert.deepEqual(run.loot[1]!.rewards, []);
  assert.equal(run.syncs(), 1, '景物消失后同步宝箱怪投影');
  assert.deepEqual(run.chests.spawns.map(spawn => spawn.enemyId), ['enemy-barrel-of-toxic-waste-1']);
  assert.equal(run.pity.counters('player').equipmentMisses, 0, '景物怪不累计装备保底');
  assert.deepEqual(run.removals, [run.spawn.id]);
});

test('a summon kill grants experience while a non-party killer does not', t => {
  t.mock.method(Math, 'random', () => 0.999);
  const summonRun = harness({
    enemyId: 'enemy-slime-1', heroLevel: 10, casterId: 'summon-1',
    arena: [{ key: 'summon-1', summonedBy: 'player', definition: {} }],
  });
  summonRun.settle();
  assert.equal(summonRun.experience.length, 1, '友方召唤物的击杀算给队伍');
  assert.ok(summonRun.experience[0]! > 0);

  const hostileRun = harness({ enemyId: 'enemy-slime-1', heroLevel: 10, casterId: 'enemy-other' });
  hostileRun.settle();
  assert.deepEqual(hostileRun.experience, [], '非队伍来源的击杀不给经验');
});

test('the unique pity forces a unique drop and resets the unique counter', t => {
  t.mock.method(Math, 'random', () => 0.999);
  const run = harness({ enemyId: 'enemy-head-goblin-1', heroLevel: 20, level: 13 });
  run.pity.counters('player').uniqueMisses = 24;

  run.settle();

  const rewards = run.loot.flatMap(call => call.rewards);
  const uniqueItems = new Set(drops.equipment.unique.map(choice => choice.item));
  const guaranteed = rewards.find(reward => reward.kind === 'item' && reward.roll);
  assert.ok(guaranteed, '黄装保底必须产出带品级快照的物品');
  assert.ok(uniqueItems.has(guaranteed.item!), '保底产出的是黄装池物品');
  assert.equal(run.pity.counters('player').uniqueMisses, 0, '命中黄装后清空黄装保底计数');
  assert.equal(run.pity.counters('player').equipmentMisses, 0, '带品级快照的黄装同时算作装备命中，装备保底清零');
});

test('the equipment pity bonus is added to the ordinary equipment slot', t => {
  t.mock.method(Math, 'random', () => 0.999);
  const catalog = structuredClone(drops);
  catalog.pity!.equipment = { stepPermille: 10000, capPermille: 10000 };
  const run = harness({ enemyId: 'enemy-head-goblin-1', heroLevel: 20, level: 13, drops: catalog });
  run.pity.counters('player').equipmentMisses = 1;

  run.settle();

  const rewards = run.loot.flatMap(call => call.rewards);
  assert.ok(rewards.some(reward => reward.kind === 'item' && reward.roll),
    '装备保底加成把装备槽推到必中');
  assert.equal(run.pity.counters('player').equipmentMisses, 0, '装备命中后清空装备保底计数');
});

test('the epic pity forces an epic drop once eligible', t => {
  t.mock.method(Math, 'random', () => 0.999);
  const run = harness({ enemyId: 'enemy-blackhoods-boss-1', heroLevel: 60, level: 65 });
  run.pity.takeBossFirstDefeat('enemy-blackhoods-boss-1');
  run.pity.counters('player').epicMisses = 39;

  run.settle();

  const rewards = run.loot.flatMap(call => call.rewards);
  assert.ok(rewards.some(reward => reward.kind === 'item' && reward.roll?.rarity === 4), '紫装保底产出紫装');
  assert.equal(run.pity.counters('player').epicMisses, 0, '命中紫装后清空紫装保底计数');
});

test('the first boss defeat guarantees equipment, and the same boss does not repeat it', t => {
  t.mock.method(Math, 'random', () => 0.999);
  const run = harness({ enemyId: 'enemy-starving-boss-wolf-1', heroLevel: 10, level: 6 });

  run.settle();
  const first = run.loot.flatMap(call => call.rewards);
  assert.ok(first.some(reward => reward.kind === 'item' && reward.roll && reward.roll.rarity >= 2),
    'Boss 首杀按配置保底装备并抬高最低稀有度');
  assert.equal(run.pity.bossDefeated('enemy-starving-boss-wolf-1'), true, '首杀记录写入保底状态');

  const second = harness({ enemyId: 'enemy-starving-boss-wolf-1', heroLevel: 10, level: 6 });
  second.pity.takeBossFirstDefeat('enemy-starving-boss-wolf-1');
  second.pity.counters('player').equipmentMisses = 0;
  second.settle();
  assert.ok(second.loot.flatMap(call => call.rewards).some(reward=>reward.roll&&reward.roll.rarity>=2), 'Boss 每次至少掉落稀有装备');
});

test('a paid drop uses its own channel and advances its own pity counter', t => {
  t.mock.method(Math, 'random', () => 0.999);
  const run = harness({ enemyId: 'enemy-head-goblin-1', heroLevel: 20, level: 13 });
  run.session.reservedDropMisses = 24;

  run.settle();

  const reservedItems = new Set(drops.reservedDrops!.entries.map(entry => entry.item));
  const rewards = run.loot.flatMap(call => call.rewards);
  assert.ok(rewards.some(reward => reward.kind === 'item' && reservedItems.has(reward.item!)),
    '付费道具从独立通道掉落，不混入普通掉落池');
  assert.equal(run.session.reservedDropMisses, 25, '付费道具保底计数独立推进');
  assert.equal(run.pity.counters('player').equipmentMisses, 1, '付费通道不影响普通装备保底');
});

test('quest drops spawn once per kill even when the party has two members', t => {
  t.mock.method(Math, 'random', () => 0);
  const run = harness({
    enemyId: 'enemy-slime-1', heroLevel: 10,
    members: [{ id: 'player', level: 10 }, { id: 'ally', level: 8 }],
    quests: [[{ item: 'magic-stone-piece', quantity: 3, owned: 0 }]],
  });
  run.settle();

  const questCalls = run.loot.filter(call => call.rewards.some(reward => reward.kind === 'item' && reward.item === 'magic-stone-piece'));
  assert.equal(questCalls.length, 1, '任务掉落共享，不随队伍人数翻倍');
  assert.equal(questCalls[0]!.rewards.filter(reward => reward.item === 'magic-stone-piece').length, 1);
  assert.equal(run.loot.length, 3, '两名成员各一次普通掉落，再加一次任务掉落');
});

test('a kill without a map spawn still grants experience but has no loot or defeat record', t => {
  t.mock.method(Math, 'random', () => 0);
  const run = harness({ enemyId: 'enemy-slime-1', heroLevel: 10 });
  (run.host as unknown as { roster: { source: () => undefined } }).roster.source = () => undefined;
  run.settle();

  assert.equal(run.experience.length, 1, '召唤/临时敌人即使没有生成点也给经验');
  assert.equal(run.loot.length, 0, '没有生成点就不结算掉落');
  assert.deepEqual(run.defeated, [], '没有生成点不写击杀记录');
});

test('an enemy without a drop rule skips normal loot but still records the kill', () => {
  const run = harness({ enemyId: 'enemy-slime-1', heroLevel: 10 });
  (run.host as unknown as { drops: DropCatalog }).drops = { ...drops, enemies: {} };
  run.settle();
  assert.equal(run.loot.length, 1, '只剩任务掉落这一次空结算');
  assert.deepEqual(run.loot[0]!.rewards, []);
  assert.deepEqual(run.audio, ['enemy-slime-1']);
  assert.deepEqual(run.removals, [run.spawn.id]);
});

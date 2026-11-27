import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Bag } from '../src/domain/bag.ts';
import type { Campaign, CampaignQuest } from '../src/domain/campaign.ts';
import type { ItemCatalog } from '../src/domain/items.ts';
import { QuestBook, type QuestContext } from '../src/domain/quest-book.ts';
import { groundLootFor } from '../src/domain/ground-loot.ts';
import { Session } from '../src/domain/session.ts';
import {
  DEFAULT_ENEMY_RESPAWN_MS,
  OFFSCREEN_ENEMY_RESPAWN_MS,
  SessionEnemyStore,
} from '../src/domain/session-enemies.ts';
import { SessionQuestCoordinator } from '../src/domain/session-quests.ts';
import {
  validateSessionInventoryState,
  validateSessionRestoreScalars,
} from '../src/domain/session-state-validation.ts';
import { applyActorStoryCommand, storyCommandSubsystems } from '../src/domain/session-story-commands.ts';
import { LootPity } from '../src/domain/loot-pity.ts';

function collectTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...collectTsFiles(full));
    else if (entry.name.endsWith('.ts')) results.push(full);
  }
  return results.sort();
}

test('src/ maintains 0 multi-node SCCs (including inline imports) and strict layer boundaries', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const srcRoot = path.join(root, 'src');
  const files = collectTsFiles(srcRoot).map(file => path.relative(root, file).replace(/\\/g, '/'));
  const fileSet = new Set(files);
  const edges = new Map<string, Set<string>>(files.map(file => [file, new Set()]));
  const importPattern = /(?:from\s+|import\s*\(\s*|^\s*import\s+)['"](\.[^'"]+)['"]/gm;

  for (const file of files) {
    const content = fs.readFileSync(path.join(root, file), 'utf8');
    const dir = path.posix.dirname(file);
    for (const match of content.matchAll(importPattern)) {
      let target = path.posix.normalize(path.posix.join(dir, match[1]!));
      if (!target.endsWith('.ts')) {
        if (fileSet.has(`${target}.ts`)) target = `${target}.ts`;
        else if (fileSet.has(`${target}/index.ts`)) target = `${target}/index.ts`;
      }
      if (fileSet.has(target) && target !== file) edges.get(file)!.add(target);
    }
  }

  let index = 0;
  const indices = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const sccs: string[][] = [];

  const strongConnect = (v: string): void => {
    indices.set(v, index);
    lowlink.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);
    for (const w of edges.get(v)!) {
      if (!indices.has(w)) {
        strongConnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, indices.get(w)!));
      }
    }
    if (lowlink.get(v) === indices.get(v)) {
      const scc: string[] = [];
      while (true) {
        const w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
        if (w === v) break;
      }
      if (scc.length > 1) sccs.push(scc.sort());
    }
  };

  for (const file of files) {
    if (!indices.has(file)) strongConnect(file);
  }
  assert.deepEqual(sccs, [], `检测到源码循环依赖 SCC: ${JSON.stringify(sccs)}`);

  const forbiddenDomainTargets = /^src\/(application|rendering|scenes|ui|debug|generated)\/|^src\/(app|main|session-lifecycle)\.ts$/;
  const forbiddenRenderingTargets = /^src\/(scenes|ui)\/|^src\/(app|main)\.ts$/;
  const allowedRenderingUiExceptions = new Set([
    'src/rendering/pickup-messages.ts -> src/ui/dom/dom-ui.ts',
    'src/rendering/pickup-messages.ts -> src/ui/item-name-color.ts',
  ]);
  const forbiddenSceneTargets = /^src\/(app|main)\.ts$/;
  const zeroPhaserDir = /^src\/(domain|debug|ui\/(dom|panels|hud))\//;
  const layerViolations: string[] = [];

  for (const file of files) {
    const content = fs.readFileSync(path.join(root, file), 'utf8');
    if (zeroPhaserDir.test(file) && /from\s+['"]phaser['"]/.test(content)) {
      layerViolations.push(`${file} -> phaser`);
    }
    for (const target of edges.get(file)!) {
      const edge = `${file} -> ${target}`;
      if (file.startsWith('src/domain/') && forbiddenDomainTargets.test(target)) layerViolations.push(edge);
      if (file.startsWith('src/rendering/') && forbiddenRenderingTargets.test(target) && !allowedRenderingUiExceptions.has(edge)) {
        layerViolations.push(edge);
      }
      if (file.startsWith('src/scenes/') && forbiddenSceneTargets.test(target)) layerViolations.push(edge);
    }
  }
  assert.deepEqual(layerViolations, [], `检测到跨层反向依赖: ${JSON.stringify(layerViolations)}`);
});

test('SessionEnemyStore separates vitals revision from spawnRevision and handles map transitions and timers', () => {
  const store = new SessionEnemyStore();
  assert.equal(store.revision, 0);
  assert.equal(store.spawnRevision, 0);

  store.setVitals('slime-1', 40, 10);
  assert.equal(store.revision, 1);
  assert.equal(store.spawnRevision, 0, '受伤/回蓝只推进存档修订号，不使生成名单失效');

  const respawnable = { id: 'slime-1', enemyId: 'slime', x: 10, y: 10 };
  store.markDefeated(respawnable, 1_000);
  assert.equal(store.revision, 2);
  assert.equal(store.spawnRevision, 1);
  assert.equal(store.canRespawn(respawnable, 1_000 + OFFSCREEN_ENEMY_RESPAWN_MS - 1, true), false);
  assert.equal(store.canRespawn(respawnable, 1_000 + OFFSCREEN_ENEMY_RESPAWN_MS, true), true);
  assert.equal(store.canRespawn(respawnable, 1_000 + DEFAULT_ENEMY_RESPAWN_MS - 1, false), false);
  assert.equal(store.clearDefeat('slime-1', 1_000 + OFFSCREEN_ENEMY_RESPAWN_MS, true), true);
  assert.equal(store.spawnRevision, 2);
  assert.equal(store.raw('slime-1'), undefined);

  store.markDefeated({ id: 'boss-1', respawn: false }, 2_000);
  store.markDefeated({ id: 'breakable:box:1', respawn: false }, 2_000);
  store.markCaptured('cap-1', 'town', 1);
  assert.equal(store.clearDefeat('cap-1', 999_999, true), false, '已捕捉目标不得被 clearDefeat 释放');

  store.transitionMap(
    'forest',
    'town',
    [{ id: 'chest:1', enemyId: 'mimic', x: 0, y: 0, respawn: false }],
    2,
    [],
  );
  assert.equal(store.raw('cap-1'), undefined, '过期的捕捉记录随切图清除');
  assert.equal(store.raw('breakable:box:1'), undefined, '可破坏物永久死亡仅限当次地图访问');
  assert.equal(store.raw('boss-1')?.deadUntil, 'permanent', '非可破坏一次性怪物保持永久死亡');

  const beforePrefixRev = store.spawnRevision;
  store.setVitals('story-located-1', 100, 0);
  store.markStoryRemoved('story-located-2');
  assert.equal(store.forgetByPrefix('story-located-'), 2);
  assert.ok(store.spawnRevision > beforePrefixRev);
});

function minimalQuest(id: string, patch: Partial<CampaignQuest> = {}): CampaignQuest {
  return {
    id,
    title: id,
    description: id,
    giver: 'elder',
    guidance: { available: '接取', active: '进行' },
    goals: [],
    completion: 'talk',
    progressText: '继续',
    completeText: '完成',
    ...patch,
  };
}

test('SessionQuestCoordinator caches projections by quest version and enforces one receipt per cycle', () => {
  const quests: CampaignQuest[] = [
    minimalQuest('q-main', {
      completion: 'all',
      goals: [{ id: 'g1', kind: 'talk', target: 'guard', quantity: 1 }],
      rewards: { experience: 50, money: 25, items: [] },
    }),
  ];
  const campaign: Campaign = {
    version: 2,
    contentVersion: 1,
    start: { map: 'town', x: 0, y: 0, actor: 'hero', facing: 'south', script: 'start' },
    scripts: {},
    events: [],
    quests,
    questGroups: [{ id: 'main-group', kind: 'main', title: '主线', questIds: ['q-main'] }],
    placements: [],
  };
  const context: QuestContext = {
    questStatus: () => 'available',
    eventStatus: () => 'idle',
    choice: () => undefined,
    flag: () => false,
    world: () => undefined,
    itemCount: () => 0,
  };
  const book = new QuestBook(quests, () => context, new Set());
  book.commit(book.plan({ type: 'refresh' }));
  const coordinator = new SessionQuestCoordinator(campaign);

  assert.equal(coordinator.npcQuestSlot(book, 'elder')?.id, 'q-main');
  assert.equal(coordinator.markerActor(book, 'elder'), true);
  assert.equal(coordinator.markerActor(book, 'guard'), false);

  book.commit(book.plan({ type: 'accept', quest: 'q-main', cycle: 0 }));
  assert.equal(coordinator.markerActor(book, 'guard'), true, '接取后缓存失效并暴露进行中目标标记');

  let exp = 0, money = 0;
  const grant = { addExperience: (amount: number) => { exp += amount; }, gainMoney: (amount: number) => { money += amount; } };
  coordinator.recordReceipt({ quest: 'q-main', cycle: 0, reward: { experience: 50, money: 25, items: [] } }, grant);
  assert.equal(exp, 50);
  assert.equal(money, 25);
  assert.equal(coordinator.receiptRevision, 1);

  assert.throws(
    () => coordinator.recordReceipt({ quest: 'q-main', cycle: 0, reward: { experience: 50, money: 25, items: [] } }, grant),
    /任务奖励已结算/,
  );
  assert.equal(exp, 50);
  assert.equal(money, 25);

  coordinator.retainSettlements(new Set(['q-main']));
  assert.equal(coordinator.receiptRevision, 1);
  coordinator.retainSettlements(new Set());
  assert.equal(coordinator.receiptRevision, 2);
  assert.equal(coordinator.rewardReceiptFor('q-main'), undefined);
});

test('session-state-validation rejects corrupted shortcut owners, duplicate enemies, and invalid captures', () => {
  const catalog: ItemCatalog = {
    items: {},
    startingEquipment: {},
    startingInventory: [],
    startingShortcut: '',
    dualWieldClasses: [],
    merchantItems: [],
    classSkills: {},
    recipes: {},
  };
  const baseBag = new Bag(() => {}, catalog, undefined, 'none').captureState();

  assert.throws(() => validateSessionInventoryState({
    bag: { ...baseBag, shortcuts: [['ghost-member', []]] },
  }, catalog), /快捷栏的拥有者不存在/);

  assert.throws(() => validateSessionInventoryState({
    bag: baseBag,
    legendaryWeapons: { used: ['invalid-key-without-colon'] },
  }, catalog), /已拔古剑记录无效/);

  const baseBook = new QuestBook([], () => ({
    questStatus: () => 'locked',
    eventStatus: () => 'idle',
    choice: () => undefined,
    flag: () => false,
    world: () => undefined,
    itemCount: () => 0,
  }), new Set()).captureState();
  const baseScalarState = {
    questBook: baseBook,
    receipts: [],
    money: 0,
    gameTimeMs: 0,
    resourceRecovery: { elapsedMs: 0, deadlineTick: 0 },
    enemies: [] as [string, { health?: number; deadUntil?: number | 'permanent'; offscreenRespawnAt?: number; capture?: { map: string; visit: number } }][],
    storyWorld: {
      entities: [],
      exits: [],
      flags: [],
      choices: [],
      encounters: [],
      mapVisit: 1,
    },
  };

  assert.throws(() => validateSessionRestoreScalars({
    ...baseScalarState,
    enemies: [['e1', { health: 10 }], ['e1', { health: 20 }]],
  }, { definition: () => undefined, catalog }), /检查点敌人状态无效/);

  assert.throws(() => validateSessionRestoreScalars({
    ...baseScalarState,
    enemies: [['e1', { deadUntil: 'permanent', capture: { map: 'town', visit: 99 } }]],
  }, { definition: () => undefined, catalog }), /检查点捕捉来源无效/);

  assert.throws(() => validateSessionRestoreScalars({
    ...baseScalarState,
    enemies: [['e1', { deadUntil: 1000, offscreenRespawnAt: 2000 }]],
  }, { definition: () => undefined, catalog }), /检查点敌人刷新时间无效/);

  assert.throws(() => validateSessionRestoreScalars({
    ...baseScalarState,
    receipts: [{ quest: 'missing', cycle: 0, reward: { experience: 0, money: 0, items: [] } }],
  }, { definition: () => undefined, catalog }), /检查点奖励记录无效/);
});

test('Session.placeGroundRewards works standalone outside enclosing atomic and Session.marker refreshes pending state', () => {
  const fetchQuest = minimalQuest('q-fetch', {
    completion: 'all',
    goals: [{ id: 'g-herb', kind: 'item', target: 'herb', quantity: 1 }],
  });
  const catalog: ItemCatalog = {
    items: {
      herb: {
        name: '草药',
        description: '草药',
        category: 'consumable',
        icon: '',
        groundSprite: { file: '', width: 16, height: 16, anchorX: 0.5, anchorY: 1 },
        kind: 'consumable',
        typeName: '消耗品',
        stackable: true,
        discardable: true,
        shortcut: false,
        level: 1,
        basePrice: 1,
        storeListed: false,
      },
    },
    startingEquipment: {},
    startingInventory: [],
    startingShortcut: '',
    dualWieldClasses: [],
    merchantItems: [],
    classSkills: {},
    recipes: {},
  };
  const campaign: Campaign = {
    version: 2,
    contentVersion: 1,
    start: { map: 'town', x: 10, y: 10, actor: 'hero', facing: 'south', script: 'start' },
    scripts: {},
    events: [],
    quests: [fetchQuest],
    questGroups: [{ id: 'g', kind: 'main', title: '主线', questIds: ['q-fetch'] }],
    placements: [],
  };
  const session = new Session(
    campaign,
    { level: 1, health: 100, maxHealth: 100, mana: 50, maxMana: 50, experience: 0, nextLevelExperience: 100 },
    { classId: 'warrior', appearance: { id: 'warrior', name: 'warrior', description: '', clips: {}, portrait: null } },
    catalog,
  );

  // 独立调用 placeGroundRewards（不套外层 atomic）不得抛 TypeError，且失败套外层 atomic 时可回滚地图掉落。
  session.placeGroundRewards('town', 12, 16, [{ kind: 'money', amount: 15 }]);
  assert.equal(groundLootFor(session).dropsOnMap('town').length, 1);

  assert.throws(() => session.atomic(() => {
    session.placeGroundRewards('town', 20, 24, [{ kind: 'money', amount: 30 }]);
    assert.equal(groundLootFor(session).dropsOnMap('town').length, 2);
    throw new Error('rollback ground rewards');
  }, ['bag']), /rollback ground rewards/);
  assert.equal(groundLootFor(session).dropsOnMap('town').length, 1);

  // batchNotifications 期间新增任务道具时，marker() 仍应刷新并返回最新的 'ready'。
  assert.equal(session.accept('q-fetch'), true);
  assert.equal(session.marker('elder'), 'active');
  session.batchNotifications(() => {
    session.bag.add('herb', 1);
    assert.equal(session.marker('elder'), 'ready');
  });
});

test('session-story-commands maps subsystems conservatively and mutates fallback player vitals safely', () => {
  assert.deepEqual(storyCommandSubsystems({ type: 'world', command: { kind: 'encounter-result', id: 'e1', result: 'won' } }), ['storyWorld', 'enemies']);
  assert.deepEqual(storyCommandSubsystems({ type: 'quest', command: { type: 'complete', quest: 'q1', cycle: 0 } }), ['questBook', 'bag', 'hero', 'skills', 'coins', 'receipts', 'reservedDrops']);

  const bag = new Bag(() => {}, undefined, undefined, 'none');
  const fallback = { level: 1, health: 10, maxHealth: 100, mana: 5, maxMana: 40, experience: 0, nextLevelExperience: 100 };
  applyActorStoryCommand({ type: 'health', member: 'player', value: 'full' }, { bag, fallback, lootPity: new LootPity() });
  applyActorStoryCommand({ type: 'mana', member: 'player', value: 25 }, { bag, fallback, lootPity: new LootPity() });
  assert.equal(fallback.health, 100);
  assert.equal(fallback.mana, 25);
});

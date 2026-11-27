import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { IndexedDbSaveStorage } from '../src/application/save-storage.ts';
import type { StoryUIContext } from '../src/application/ports.ts';
import type { BattleCatalog } from '../src/domain/battle.ts';
import type { Campaign } from '../src/domain/campaign.ts';
import { BattleCharacter, type CharacterStatsCatalog } from '../src/domain/character-stats.ts';
import type { ActorDefinition, AnimationClip, WorldIndex, WorldMap } from '../src/domain/content.ts';
import type { ItemCatalog } from '../src/domain/items.ts';
import type { CompanionCatalog } from '../src/domain/party.ts';
import {
  AUTO_SAVE_SLOT,
  MANUAL_SAVE_SLOT_COUNT,
  SaveSlots,
  captureSaveGame,
  saveSummary,
} from '../src/domain/save-game.ts';
import { validateSceneSnapshot } from '../src/domain/scene-snapshot.ts';
import { Session } from '../src/domain/session.ts';
import type { SavePageHost } from '../src/ui/save-page.ts';
import { createFakePhaserScene, createTestWorldCombat } from './support/world-combat-fixture.ts';
import { buildTestWorldScene, loadWorldSceneClass } from './support/world-scene-fixture.ts';

const read = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(`../public/content/${name}.json`, import.meta.url), 'utf8')) as T;
const campaign = read<Campaign>('campaign');
const items = read<ItemCatalog>('items');
const stats = read<CharacterStatsCatalog>('character-stats');
const battle = read<BattleCatalog>('battle');
const companions = read<CompanionCatalog>('companions');
const worldIndex = read<WorldIndex>('world');

const phaserHook = registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'phaser'
      ? {
          shortCircuit: true,
          url: `data:text/javascript,${encodeURIComponent(`
            export default {
              WEBGL: 2, BlendModes: { NORMAL: 0, ADD: 1 },
              Scene: class {}, Geom: { Rectangle: class {}, Circle: class {} },
              Math: { Clamp: (value, min, max) => Math.max(min, Math.min(max, value)) }
            };
          `)}`,
        }
      : next(specifier, context);
  },
});
const { SavePage } = await import('../src/ui/save-page.ts');
phaserHook.deregister();
const WorldScene = await loadWorldSceneClass();

function createSession(): Session {
  return new Session(
    campaign,
    undefined,
    undefined,
    items,
    new BattleCharacter('warlock', stats, items),
    battle,
    stats,
    companions,
  );
}

function createCappedLocalStorage(maxChars: number, initial: Record<string, string> = {}) {
  const entries = new Map(Object.entries(initial));
  const usedChars = () => {
    let sum = 0;
    for (const [k, v] of entries) sum += k.length + v.length;
    return sum;
  };
  return {
    entries,
    get length() { return entries.size; },
    key(index: number) { return [...entries.keys()][index] ?? null; },
    getItem(key: string) { return entries.get(key) ?? null; },
    setItem(key: string, value: string) {
      const previous = entries.get(key);
      const nextChars = usedChars() - (previous ? key.length + previous.length : 0) + key.length + value.length;
      if (nextChars > maxChars) {
        const err = new Error('The quota has been exceeded.');
        err.name = 'QuotaExceededError';
        throw err;
      }
      entries.set(key, value);
    },
    removeItem(key: string) { entries.delete(key); },
  };
}

function createFakeIndexedDb(options: { failOpen?: boolean; failPutAfter?: number } = {}) {
  const databases = new Map<string, Map<string, Map<string, string>>>();
  let puts = 0;

  const factory = {
    open(dbName: string) {
      const openReq: Record<string, unknown> = {
        result: undefined,
        error: null,
        onupgradeneeded: null as (() => void) | null,
        onsuccess: null as (() => void) | null,
        onerror: null as (() => void) | null,
        onblocked: null as (() => void) | null,
      };
      queueMicrotask(() => {
        if (options.failOpen) {
          openReq.error = new Error('IndexedDB disabled in private mode');
          (openReq.onerror as (() => void) | null)?.();
          return;
        }
        let stores = databases.get(dbName);
        const isNew = !stores;
        if (!stores) {
          stores = new Map();
          databases.set(dbName, stores);
        }
        const db = {
          objectStoreNames: {
            contains: (name: string) => stores!.has(name),
          },
          createObjectStore(name: string) {
            if (!stores!.has(name)) stores!.set(name, new Map());
            return {};
          },
          close() {},
          transaction(storeName: string, _mode: string) {
            const storeData = stores!.get(storeName);
            if (!storeData) throw new Error(`Missing objectStore ${storeName}`);
            let failed: Error | undefined;
            const ops: (() => void)[] = [];
            const tx: Record<string, unknown> = {
              error: null,
              oncomplete: null as (() => void) | null,
              onerror: null as (() => void) | null,
              onabort: null as (() => void) | null,
              objectStore() {
                return {
                  getAllKeys() {
                    const req: Record<string, unknown> = { result: undefined, onsuccess: null, onerror: null };
                    ops.push(() => {
                      req.result = [...storeData.keys()];
                      (req.onsuccess as (() => void) | null)?.();
                    });
                    return req;
                  },
                  getAll() {
                    const req: Record<string, unknown> = { result: undefined, onsuccess: null, onerror: null };
                    ops.push(() => {
                      req.result = [...storeData.values()];
                      (req.onsuccess as (() => void) | null)?.();
                    });
                    return req;
                  },
                  put(value: string, key: string) {
                    const req: Record<string, unknown> = { result: key, onsuccess: null, onerror: null };
                    ops.push(() => {
                      puts += 1;
                      if (options.failPutAfter !== undefined && puts > options.failPutAfter) {
                        const err = new Error('Disk full');
                        err.name = 'QuotaExceededError';
                        failed = err;
                        req.error = err;
                        (req.onerror as (() => void) | null)?.();
                        return;
                      }
                      storeData.set(key, value);
                      (req.onsuccess as (() => void) | null)?.();
                    });
                    return req;
                  },
                  delete(key: string) {
                    const req: Record<string, unknown> = { result: undefined, onsuccess: null, onerror: null };
                    ops.push(() => {
                      storeData.delete(key);
                      (req.onsuccess as (() => void) | null)?.();
                    });
                    return req;
                  },
                };
              },
            };
            queueMicrotask(() => {
              for (const op of ops) {
                if (failed) break;
                op();
              }
              if (failed) {
                tx.error = failed;
                (tx.onabort as (() => void) | null)?.();
              } else {
                (tx.oncomplete as (() => void) | null)?.();
              }
            });
            return tx;
          },
        };
        openReq.result = db;
        if (isNew) (openReq.onupgradeneeded as (() => void) | null)?.();
        (openReq.onsuccess as (() => void) | null)?.();
      });
      return openReq;
    },
  } as unknown as IDBFactory;

  return {
    factory,
    storeEntries(dbName = 'inotia4-saves', storeName = 'slots') {
      return databases.get(dbName)?.get(storeName) ?? new Map<string, string>();
    },
  };
}

test('IndexedDbSaveStorage 突破 localStorage 5 MiB 配额写满 11 个带截图存档槽，并一次性搬迁清理旧 localStorage 键', async () => {
  const session = createSession();
  const baseSummary = saveSummary(
    session,
    { id: 'border-gateway-67e044a2', name: '边境关口' },
    { name: '黑魔导', portrait: 'assets/ui/menus/character-kiyan.png' },
    'data:image/jpeg;base64,' + 'A'.repeat(320_000),
  );
  const legacyRecord = captureSaveGame(session, { location: { map: 'border-gateway-67e044a2' } }, {
    ...baseSummary,
    name: '旧本地档',
  });
  const legacyRaw = JSON.stringify(legacyRecord);

  // 模拟 WebKit 2.6M UTF-16 字符上限：放 1 个旧档 + 其他设置，写满 11 个槽在 localStorage 必崩。
  const legacyStorage = createCappedLocalStorage(2_600_000, {
    'inotia4.story.v1.slot2': legacyRaw,
    'inotia4.audio.v1': '{"bgm":0.8}',
  });
  assert.throws(() => {
    for (let i = 0; i < MANUAL_SAVE_SLOT_COUNT; i += 1) {
      legacyStorage.setItem(`test.slot${i}`, legacyRaw);
    }
  }, /quota/i);
  for (let i = 0; i < MANUAL_SAVE_SLOT_COUNT; i += 1) legacyStorage.removeItem(`test.slot${i}`);

  const idb = createFakeIndexedDb();
  const storage = new IndexedDbSaveStorage({ indexedDB: idb.factory, legacyStorage });
  const slots = new SaveSlots<{ location: { map: string } }>(storage);
  await slots.ready();

  // 启动预热后：旧 localStorage 里的 slot2 已无损搬进 IndexedDB，且 localStorage 里的存档键已清理腾空，非存档设置保留。
  assert.equal(legacyStorage.getItem('inotia4.story.v1.slot2'), null);
  assert.equal(legacyStorage.getItem('inotia4.audio.v1'), '{"bgm":0.8}');
  const migrated = slots.peek(2);
  assert.equal(migrated.kind, 'ok');
  if (migrated.kind === 'ok') assert.equal(migrated.summary.name, '旧本地档');

  // 连续写入自动槽 + 全部 10 个大容量手动槽（总体积 > 6 MiB），全部落盘成功且重新打开数据库可读。
  slots.write(AUTO_SAVE_SLOT, captureSaveGame(session, { location: { map: 'border-gateway-67e044a2' } }, baseSummary));
  for (let slot = 0; slot < MANUAL_SAVE_SLOT_COUNT; slot += 1) {
    slots.write(slot, captureSaveGame(session, { location: { map: 'border-gateway-67e044a2' } }, baseSummary));
  }
  await slots.flush();
  assert.equal(idb.storeEntries().size, MANUAL_SAVE_SLOT_COUNT + 1);

  const reopened = new SaveSlots<{ location: { map: string } }>(
    new IndexedDbSaveStorage({ indexedDB: idb.factory, legacyStorage }),
  );
  await reopened.ready();
  assert.equal(reopened.peek(AUTO_SAVE_SLOT).kind, 'ok');
  assert.equal(reopened.peek(2).kind === 'ok' && reopened.peek(2).kind === 'ok' ? (reopened.peek(2) as { summary: { name?: string } }).summary.name : undefined, '旧本地档');
  for (let slot = 0; slot < MANUAL_SAVE_SLOT_COUNT; slot += 1) {
    assert.equal(reopened.inspect(slot).kind, 'ok');
  }
});

test('IndexedDB 事务失败时回滚内存缓存，SavePage 如实报告保存失败且不触发跳转回调', async () => {
  const session = createSession();
  const idb = createFakeIndexedDb({ failPutAfter: 1 });
  const storage = new IndexedDbSaveStorage({ indexedDB: idb.factory });
  const saves = new SaveSlots(storage);
  await saves.ready();

  let notice = '';
  const savedRefs: number[] = [];
  const app = {
    saves,
    saveSlot: undefined as number | undefined,
    storyClasses: { classes: [{ id: 'warlock', name: '黑魔导' }] },
    menuPanels: { character: { portraits: { kiyan: { image: 'kiyan.png' } } }, assets: {} },
    captureSaveWorld: () => ({ ok: true as const, map: { id: 'border-gateway-67e044a2', name: '边境关口' }, world: { location: { map: 'border-gateway-67e044a2' } } }),
    audio: { ui() {} },
  } as unknown as StoryUIContext;
  const host: SavePageHost = {
    app,
    session: () => session,
    world: () => worldIndex,
    contentAssets: () => ({ 'save-slot': 'slot.png', 'save-empty': 'empty.png' }),
    updateConfirmation: () => {},
    render: () => {},
    sync: () => {},
    busy: () => false,
    setItemNotice: msg => { notice = msg; },
    afterManualSave: ref => { savedRefs.push(ref); },
    modal: () => { throw new Error('unused'); },
    modalWriter: () => ({ add: () => {} }),
    beginModal: () => {},
    scroll: () => { throw new Error('unused'); },
    finishScroll: () => {},
  };
  const page = new SavePage(host);
  const internals = page as unknown as { saveToSlot(ref: number): void };

  // 第一次写槽 0：事务成功。
  internals.saveToSlot(0);
  await saves.flush();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(notice, '保存成功');
  assert.equal(app.saveSlot, 0);
  assert.deepEqual(savedRefs, [0]);
  assert.equal(saves.peek(0).kind, 'ok');

  // 第二次写槽 1：底层 IndexedDB 抛磁盘满，内存镜像与摘要缓存自动回滚为空槽，UI 报保存失败。
  internals.saveToSlot(1);
  await assert.rejects(async () => { await saves.flush(1); }, /Disk full/);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(notice, '保存失败');
  assert.equal(app.saveSlot, 0);
  assert.deepEqual(savedRefs, [0]);
  assert.equal(saves.peek(1).kind, 'empty');

  // 第三次：后台自动槽写盘失败时，不影响紧随其后的手动删槽 0 成功落盘（按槽位隔离 flush）。
  const baseRecord = captureSaveGame(
    session,
    { location: { map: 'border-gateway-67e044a2' } },
    saveSummary(session, { id: 'border-gateway-67e044a2', name: '边境关口' }, { name: '黑魔导', portrait: 'kiyan.png' }),
  );
  saves.write(AUTO_SAVE_SLOT, baseRecord);
  const autoFlush = saves.flush(AUTO_SAVE_SLOT);
  const deleteInternals = page as unknown as { deleteSlot(ref: number): void };
  notice = '';
  deleteInternals.deleteSlot(0);
  await saves.flush(0);
  await assert.rejects(async () => { await autoFlush; }, /Disk full/);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.notEqual(notice, '保存失败', '自动槽配额失败不应污染手动删槽结果');
  assert.equal(saves.peek(0).kind, 'empty');
  assert.equal(app.saveSlot, undefined);
});

test('IndexedDbSaveStorage 在 ready() 完成前发起的同步写入不会被预热读盘覆盖', async () => {
  const session = createSession();
  const oldRecord = captureSaveGame(
    session,
    { location: { map: 'camp' } },
    { ...saveSummary(session, { id: 'camp', name: '营地' }, { name: '黑魔导', portrait: 'kiyan.png' }), name: '旧数据库档' },
  );
  const newRecord = captureSaveGame(
    session,
    { location: { map: 'border-gateway-67e044a2' } },
    { ...saveSummary(session, { id: 'border-gateway-67e044a2', name: '边境关口' }, { name: '黑魔导', portrait: 'kiyan.png' }), name: '预热期新档' },
  );
  const idb = createFakeIndexedDb();
  const seed = new SaveSlots(new IndexedDbSaveStorage({ indexedDB: idb.factory }));
  await seed.ready();
  seed.write(0, oldRecord);
  await seed.flush(0);

  // 新建实例后不等待 ready()，直接同步写入槽 0。
  const coldStorage = new IndexedDbSaveStorage({ indexedDB: idb.factory });
  const coldSlots = new SaveSlots(coldStorage);
  void coldSlots.ready();
  coldSlots.write(0, newRecord);
  await coldSlots.flush(0);

  const peeked = coldSlots.peek(0);
  assert.equal(peeked.kind, 'ok');
  if (peeked.kind === 'ok') assert.equal(peeked.summary.name, '预热期新档');
  assert.ok(idb.storeEntries().get('inotia4.story.v1.slot0')?.includes('预热期新档'));
});

test('IndexedDbSaveStorage 首次搬迁事务失败时保留旧档可读，且删槽落盘后同步清除旧 localStorage 键', async () => {
  const session = createSession();
  const legacyRecord = captureSaveGame(
    session,
    { location: { map: 'border-gateway-67e044a2' } },
    { ...saveSummary(session, { id: 'border-gateway-67e044a2', name: '边境关口' }, { name: '黑魔导', portrait: 'kiyan.png' }), name: '保留旧档' },
  );
  const legacyRaw = JSON.stringify(legacyRecord);
  const legacyStorage = createCappedLocalStorage(1_000_000, {
    'inotia4.story.v1.slot3': legacyRaw,
  });
  const idb = createFakeIndexedDb({ failPutAfter: 0 });
  const storage = new IndexedDbSaveStorage({ indexedDB: idb.factory, legacyStorage });
  const slots = new SaveSlots(storage);
  await slots.ready();

  // 搬迁 put 失败：localStorage 旧键未删，内存镜像仍保留旧档可读，不会变为空槽。
  assert.equal(legacyStorage.getItem('inotia4.story.v1.slot3'), legacyRaw);
  const peeked = slots.peek(3);
  assert.equal(peeked.kind, 'ok');
  if (peeked.kind === 'ok') assert.equal(peeked.summary.name, '保留旧档');

  // 玩家删除槽 3（delete 事务不计入 put 配额）：IDB 提交成功后一并清掉 localStorage 旧键，防止下次启动复活。
  slots.erase(3);
  await slots.flush(3);
  assert.equal(slots.peek(3).kind, 'empty');
  assert.equal(legacyStorage.getItem('inotia4.story.v1.slot3'), null);
});

test('IndexedDbSaveStorage 在 open 挂起超时后自动降级至 localStorage，连接后台失效时自动重连', async () => {
  const session = createSession();
  const record = captureSaveGame(
    session,
    { location: { map: 'border-gateway-67e044a2' } },
    { ...saveSummary(session, { id: 'border-gateway-67e044a2', name: '边境关口' }, { name: '黑魔导', portrait: 'kiyan.png' }), name: '超时回退档' },
  );
  const legacyStorage = createCappedLocalStorage(1_000_000);

  // 1. open() 永久不触发回调：openTimeoutMs 到期后立即回退 localStorage，不卡死 ready()。
  let lateClosed = false;
  const hungFactory = {
    open() {
      const req: Record<string, unknown> = { result: undefined, onsuccess: null, onerror: null, onblocked: null, onupgradeneeded: null };
      setTimeout(() => {
        req.result = { close() { lateClosed = true; } };
        (req.onsuccess as (() => void) | null)?.();
      }, 60).unref?.();
      return req;
    },
  } as unknown as IDBFactory;

  const fallbackStorage = new IndexedDbSaveStorage({
    indexedDB: hungFactory,
    legacyStorage,
    openTimeoutMs: 15,
  });
  const fallbackSlots = new SaveSlots(fallbackStorage);
  await fallbackSlots.ready();
  fallbackSlots.write(0, record);
  assert.equal(fallbackSlots.peek(0).kind, 'ok');
  assert.ok(legacyStorage.getItem('inotia4.story.v1.slot0')?.includes('超时回退档'));
  await new Promise(resolve => setTimeout(resolve, 75));
  assert.equal(lateClosed, true, '迟到打开的数据库句柄应被立即关闭');

  // 2. 运行中连接被浏览器后台主动关闭（transaction 抛 InvalidStateError）：自动重新 openDatabase 后写入成功。
  const baseIdb = createFakeIndexedDb();
  let injectStaleOnce = false;
  const reconnectFactory = {
    open(dbName: string, version?: number) {
      const req = baseIdb.factory.open(dbName, version);
      const origGetter = () => req.result as { transaction: (...args: unknown[]) => unknown; onclose?: (() => void) | null };
      queueMicrotask(() => {
        queueMicrotask(() => {
          const db = origGetter();
          if (!db) return;
          const rawTx = db.transaction.bind(db);
          db.transaction = (...args: unknown[]) => {
            if (injectStaleOnce) {
              injectStaleOnce = false;
              const err = new Error('Connection is closing');
              err.name = 'InvalidStateError';
              throw err;
            }
            return rawTx(...args);
          };
        });
      });
      return req;
    },
  } as unknown as IDBFactory;

  const reconnectSlots = new SaveSlots(new IndexedDbSaveStorage({ indexedDB: reconnectFactory }));
  await reconnectSlots.ready();
  injectStaleOnce = true;
  reconnectSlots.write(1, record);
  await reconnectSlots.flush(1);
  assert.equal(reconnectSlots.peek(1).kind, 'ok');
  assert.ok(baseIdb.storeEntries().get('inotia4.story.v1.slot1')?.includes('超时回退档'));
});

function stripActorFiles(actor: ActorDefinition): ActorDefinition {
  const clips: ActorDefinition['clips'] = {};
  for (const [name, clip] of Object.entries(actor.clips) as [keyof ActorDefinition['clips'], AnimationClip | undefined][]) {
    if (!clip) continue;
    clips[name] = { ...clip, layers: clip.layers.map(layer => ({ ...layer, file: '' })) };
  }
  return { ...actor, clips };
}

test('captureSaveWorld 剥离主角、伙伴、怪物和地图实体的可重建外观，运行时检查点仍保留完整外观', async () => {
  const localBattle: BattleCatalog = {
    ...battle,
    classes: battle.classes.map(entry => ({ ...entry, actor: stripActorFiles(entry.actor) })),
    enemies: battle.enemies.map(entry => ({ ...entry, actor: stripActorFiles(entry.actor) })),
  };
  const session = new Session(
    campaign,
    undefined,
    undefined,
    items,
    new BattleCharacter('warlock', stats, items),
    localBattle,
    stats,
    companions,
  );
  session.bag.add('mercenary-emblem-black-knight', 1);
  const recruited = session.party!.recruit(
    session.bag.entries.find(entry => entry.item === 'mercenary-emblem-black-knight')!.id,
    () => 0,
  ).member;
  session.party!.deployFirstAvailable(recruited.id);

  const dkActor = localBattle.classes.find(entry => entry.id === 'dark-knight')!.actor;
  const map: WorldMap = {
    id: 'camp',
    name: '营地',
    width: 320,
    height: 320,
    tileSize: 16,
    columns: 20,
    rows: 20,
    blocked: Array<boolean>(400).fill(false),
    ground: '',
    canopy: '',
    features: [],
    entities: [{ id: 'npc-1', actor: campaign.start.actor, x: 64, y: 64 }],
    exits: [],
    enemySpawns: [{ id: 'wolf-1', enemyId: 'enemy-snake-1', x: 160, y: 160 }],
  };
  const phaserScene = createFakePhaserScene();
  const baseAdd = phaserScene.add as unknown as { sprite: (...args: unknown[]) => Record<string, unknown> };
  const fullScene = createFakePhaserScene({
    tweens: { ...(phaserScene.tweens as object), killTweensOf: () => {}, getTweensOf: () => [] },
    add: {
      ...baseAdd,
      sprite: (...args: unknown[]) => {
        const sprite = baseAdd.sprite(...args);
        const anims = sprite.anims as Record<string, unknown>;
        Object.assign(anims, {
          isPlaying: false,
          getProgress: () => 0,
          create: (cfg: unknown) => {
            const anim = { ...(cfg as object), destroy: () => {} };
            anims.currentAnim = anim;
            return anim;
          },
        });
        Object.assign(sprite, {
          scene: fullScene,
          texture: sprite.texture ?? { key: '' },
          setTexture() { return sprite; },
          play() { anims.isPlaying = true; return sprite; },
        });
        return sprite;
      },
    },
  });
  const worldCombat = await createTestWorldCombat({
    phaserScene: fullScene,
    map,
    hero: session.hero!,
    session,
    battleCatalog: localBattle,
    items,
    characterStats: stats,
    appOverrides: { world: { actors: { ...worldIndex.actors, [recruited.definition.actor]: dkActor } } as never },
  });
  await worldCombat.combat.start();

  const heavyActor: ActorDefinition = worldIndex.actors[campaign.start.actor]!;
  const playerVisual = {
    entity: { id: 'player', actor: campaign.start.actor, x: 32, y: 32 },
    actor: heavyActor,
    container: { x: 32, y: 32, visible: true, alpha: 1 },
    layers: [],
    clipName: 'idle-south' as const,
  };
  const propVisual = {
    entity: { id: 'prop-1', actor: campaign.start.actor, x: 64, y: 64 },
    actor: heavyActor,
    container: { x: 64, y: 64, visible: true, alpha: 1 },
    layers: [],
    clipName: 'idle-south' as const,
  };
  const host = buildTestWorldScene(WorldScene, {
    map,
    player: playerVisual,
    characters: [propVisual],
    facing: 'south',
    movement: { position: (c: { container: { x: number; y: number } }) => ({ x: c.container.x, y: c.container.y }) },
    combat: worldCombat.combat,
    app: { ui: {}, session },
    sceneOverrides: { baseEntities: [] },
  });

  const liveSnapshot = host.captureStoryWorld(true);
  assert.ok(liveSnapshot.scene);
  assert.ok(liveSnapshot.scene.actors.every(actor => actor.appearance !== undefined), '运行时检查点保留全部外观');

  const saveResult = host.captureSaveWorld();
  assert.equal(saveResult.ok, true);
  if (!saveResult.ok) return;
  assert.ok(saveResult.world.scene);
  validateSceneSnapshot(saveResult.world.scene);
  assert.ok(saveResult.world.scene.actors.every(actor => actor.appearance === undefined), '持久存档剥离全部可重建外观');
  assert.ok(
    JSON.stringify(saveResult.world).length < JSON.stringify(liveSnapshot).length * 0.5,
    '持久存档世界快照体积显著小于带完整外观的运行时检查点',
  );
  worldCombat.combat.destroy();
});

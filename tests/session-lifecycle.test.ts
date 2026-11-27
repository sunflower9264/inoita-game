import assert from 'node:assert/strict';
import test from 'node:test';
import { CloudSaveClient } from '../src/application/cloud-save.ts';
import { restoreCloudSaves } from '../src/application/cloud-save-sync.ts';
import type { StoryApp } from '../src/app.ts';
import { defaultPressureSettings, PRESSURE_MAX_ENEMIES_LIMIT } from '../src/domain/pressure-enemies.ts';
import { captureSaveGame, saveSummary, SaveSlots, type SaveSlotRef } from '../src/domain/save-game.ts';
import { newStorySession } from '../src/domain/story-class.ts';
import type { StoryWorldViewSnapshot } from '../src/application/world-snapshot.ts';
import {
  PRESSURE_MAP,
  PRESSURE_START,
  createSessionLifecycle,
  type LifecycleWorldScene,
  type SessionSceneHandle,
} from '../src/session-lifecycle.ts';

function fakeWorldScene(partial: Partial<LifecycleWorldScene>): LifecycleWorldScene {
  return partial as LifecycleWorldScene;
}

function stubHooks(overrides: Partial<Parameters<typeof createSessionLifecycle>[1]> = {}): Parameters<typeof createSessionLifecycle>[1] {
  return {
    lifetime: { current: new AbortController() },
    worldScene: () => undefined,
    currentScene: () => undefined,
    gmOn: () => false,
    runtimeDiagnostics: () => ({}),
    prepareStory: async () => {},
    prepareMenuCore: async () => {},
    refreshMenuWhenReady() {},
    cancelCommonPreload() {},
    clearMenuPreparations() {},
    recordSceneChange() {},
    remeasureRefreshAfterStart() {},
    startAutoSave() {},
    stopAutoSave() {},
    autoSaver: () => undefined,
    ...overrides,
  };
}

test('cloud restore checks a real session and map before replacing each local slot', async t => {
  const { headlessContent } = await import('./helpers/story-playthrough.ts');
  const { campaign, world, items, battle, stats, storyClasses, companions, maps } = headlessContent;
  const selected = storyClasses.classes[0]!;
  const actor = world.actors[campaign.start.actor];
  const session = newStorySession(campaign, actor, selected, items, stats, battle, companions);
  const map = world.maps.find(value => value.id === campaign.start.map)!;
  const scene: StoryWorldViewSnapshot = { location: { map: map.id, x: 16, y: 24, facing: 'west' }, generatedEntities: [] };
  const game = captureSaveGame(
    session,
    scene,
    saveSummary(session, map, { name: selected.name, portrait: 'kiyan.png' }, 'data:image/jpeg;base64,AQ=='),
  );
  game.summary.name = '云端章节';
  const broken = structuredClone(game);
  broken.world.location.map = 'missing-map';
  const files: string[] = [];
  const app = {
    session,
    campaign,
    world,
    items,
    storyClasses,
    characterStats: stats,
    battleCatalog: battle,
    companions,
    content: {
      storyClasses: async () => storyClasses,
      map: async (file: string) => {
        files.push(file);
        if (files.length === 1) throw new Error('目标地图暂时无法加载');
        assert.equal(file, map.file);
        return maps.get(map.id);
      },
    },
  } as unknown as StoryApp;
  const lifecycle = createSessionLifecycle(app, stubHooks());
  const local = new Map<string, string>();
  const slots = new SaveSlots<StoryWorldViewSnapshot>({
    getItem: key => local.get(key) ?? null,
    setItem: (key, value) => { local.set(key, value); },
    removeItem: key => { local.delete(key); },
  });
  const original = JSON.stringify({ ...game, summary: { ...game.summary, name: '本机章节' } });
  slots.writeRaw(0, original);
  slots.writeRaw(1, original);
  const cloud = new CloudSaveClient();
  t.mock.method(cloud, 'list', async () => ({
    ok: true,
    value: [0, 1, 2].map(slot => ({ slot, format: game.format, bytes: 1, updatedAt: 1, summary: game.summary })),
  }));
  t.mock.method(cloud, 'download', async (slot: SaveSlotRef) => ({ ok: true, value: slot === 0 ? broken : game }));
  const result = await restoreCloudSaves({
    cloud,
    saves: slots,
    confirm: async () => true,
    validate: async (candidate, signal, slot) => { await lifecycle.prepareCandidate(candidate, signal, slot); },
  });
  assert.deepEqual(result.failures, [
    { slot: 0, reason: '游戏存档出错。无法正常进行游戏。' },
    { slot: 1, reason: '游戏存档出错。无法正常进行游戏。' },
  ]);
  assert.equal(result.completed, 1);
  assert.deepEqual(files, [map.file, map.file]);
  for (const slot of [0, 1, 2]) {
    const reading = slots.readRaw(slot);
    assert.ok(reading.kind === 'ok');
    assert.equal(reading.raw, slot === 2 ? JSON.stringify(game) : original);
  }
  assert.equal(app.session, session);
});

test('leaving a session cancels business work before shutdown and releases resources only after shutdown', () => {
  const events: string[] = [];
  const controller = new AbortController();
  let shutdown: (() => void) | undefined;
  const session = {} as StoryApp['session'];
  const scene: SessionSceneHandle = {
    sys: { isActive: () => true, isPaused: () => false },
    events: { once(_event: string, done: () => void) { shutdown = done; } },
    scene: {
      start() {
        events.push('scene-stop');
        assert.equal(controller.signal.aborted, true);
      },
    },
  };
  const app = {
    session,
    mode: 'game',
    ui: { canReturn: true, resetInput() { events.push('input'); }, lock() {}, setMode() {} },
    gm: { dispose() { events.push('gm'); } },
    director: { dispose() { events.push('director'); } },
    clearMapPrefetch() {},
    clearStoryPrefetch() {},
    releaseSession(expected: unknown) {
      assert.equal(expected, session);
      events.push('release');
    },
    game: { scene: { getScene() { return undefined; } } },
  } as unknown as StoryApp;
  const lifecycle = createSessionLifecycle(app, stubHooks({
    lifetime: { current: controller },
    worldScene: () => fakeWorldScene({ discardWorldWork() { events.push('discard'); } }),
    currentScene: () => scene,
    stopAutoSave() { events.push('save-stop'); },
  }));
  lifecycle.exit();
  assert.deepEqual(events, ['discard', 'save-stop', 'gm', 'director', 'input', 'scene-stop']);
  assert.equal(app.mode, 'menu');
  assert.ok(shutdown);
  shutdown();
  assert.equal(events.at(-1), 'release');
});

test('startPressureTest clears pressureMode on both content failure and entry abort', async () => {
  const errors: string[] = [];
  const app = {
    mode: 'menu',
    suspended: false,
    pressureMode: false,
    pressureSettings: defaultPressureSettings(),
    ui: {
      ready: true,
      loading() {},
      error(message: string) { errors.push(message); },
      resetInput() {},
    },
    game: { scene: { isActive: (key: string) => key === 'menu' } },
    content: {
      storyClasses: async () => {
        throw new Error('压测内容不可用');
      },
    },
  } as unknown as StoryApp;

  const lifecycle = createSessionLifecycle(app, stubHooks());
  await lifecycle.startPressureTest();
  assert.equal(app.pressureMode, false);
  assert.equal(app.mode, 'menu');
  assert.deepEqual(errors, ['压测内容不可用']);

  let resolveClasses!: (value: unknown) => void;
  (app as unknown as { content: unknown }).content = {
    storyClasses: () => new Promise(resolve => { resolveClasses = resolve; }),
  };
  const inFlight = lifecycle.startPressureTest();
  assert.equal(app.pressureMode, true);
  lifecycle.beginEntry();
  resolveClasses({ classes: [], defaultClass: 'hero' });
  await inFlight;
  assert.equal(app.pressureMode, false);
  assert.deepEqual(errors, ['压测内容不可用']);
});

test('updatePressureSettings clamps bounds and only marks applyHealth when enemyMaxHealth key is present', () => {
  const calls: Array<{ applyHealth?: boolean } | undefined> = [];
  const app = {
    mode: 'game',
    pressureMode: false,
    pressureSettings: defaultPressureSettings(),
    ui: { ready: true, loading() {}, error() {}, resetInput() {} },
  } as unknown as StoryApp;
  const lifecycle = createSessionLifecycle(app, stubHooks({
    worldScene: () => fakeWorldScene({
      applyPressureSettings(options?: { applyHealth?: boolean }) { calls.push(options); },
    }),
  }));

  lifecycle.updatePressureSettings({ maxEnemies: 500 });
  assert.equal(calls.length, 0);

  app.pressureMode = true;
  lifecycle.updatePressureSettings({ maxEnemies: 999 });
  assert.deepEqual(app.pressureSettings, { maxEnemies: PRESSURE_MAX_ENEMIES_LIMIT, enemyMaxHealth: undefined });
  assert.deepEqual(calls, [{ applyHealth: false }]);

  lifecycle.updatePressureSettings({ enemyMaxHealth: 1234.9 });
  assert.deepEqual(app.pressureSettings, { maxEnemies: PRESSURE_MAX_ENEMIES_LIMIT, enemyMaxHealth: 1234 });
  assert.deepEqual(calls, [{ applyHealth: false }, { applyHealth: true }]);

  lifecycle.updatePressureSettings({ enemyMaxHealth: undefined });
  assert.deepEqual(app.pressureSettings, { maxEnemies: PRESSURE_MAX_ENEMIES_LIMIT, enemyMaxHealth: undefined });
  assert.deepEqual(calls, [{ applyHealth: false }, { applyHealth: true }, { applyHealth: true }]);
});

test('changePressureClass waits for world shutdown before releasing old session and aborts if pressureMode exits', async () => {
  const { headlessContent } = await import('./helpers/story-playthrough.ts');
  const { campaign, world, items, battle, stats, storyClasses, companions } = headlessContent;
  const oldSession = newStorySession(campaign, world.actors[campaign.start.actor], storyClasses.classes[0]!,
    items, stats, battle, companions);
  const nextClass = storyClasses.classes[1] ?? storyClasses.classes[0]!;
  const events: string[] = [];
  let triggerShutdown: (() => void) | undefined;
  let startedData: Record<string, unknown> | undefined;

  const app = {
    mode: 'game',
    suspended: false,
    pressureMode: true,
    pressureSettings: defaultPressureSettings(),
    saveSlot: 1,
    campaign,
    world,
    items,
    characterStats: stats,
    battleCatalog: battle,
    companions,
    storyClasses,
    storyInterface: { assets: {}, portraits: {} },
    content: { clearSessionCaches() { events.push('clear-caches'); } },
    checkpoint: { clear() {} },
    storyAssetPreparation: { clear() {} },
    releaseResidentCombat() {},
    clearMapHistory() {},
    clearMapPrefetch() {},
    clearStoryPrefetch() {},
    releaseSession(expected: unknown) {
      assert.equal(expected, oldSession);
      events.push('release-session');
      return true;
    },
    storyUI: { bind() {}, prewarmBag() {} },
    session: oldSession,
    ui: {
      ready: true,
      playerActor: '',
      questItemName: () => '',
      loading() {},
      resetInput() {},
      lock() {},
      setMode() {},
      closeDialogue() {},
      skipDialogue() {},
    },
    game: {
      scene: {
        stop(key: string) { events.push(`stop:${key}`); },
        start(key: string, data: Record<string, unknown>) {
          events.push(`start:${key}`);
          startedData = data;
        },
      },
    },
  } as unknown as StoryApp;

  const lifecycle = createSessionLifecycle(app, stubHooks({
    worldScene: () => fakeWorldScene({
      loadingWorld: false,
      discardWorldWork() { events.push('discard'); },
      events: { once(_event, listener) { triggerShutdown = listener; } },
    }),
    stopAutoSave() { events.push('stop-autosave'); },
    startAutoSave() { events.push('start-autosave'); },
  }));

  const pending = lifecycle.changePressureClass(nextClass.id);
  assert.deepEqual(events, ['discard', 'stop-autosave', 'stop:world']);
  assert.ok(triggerShutdown);
  (triggerShutdown as () => void)();
  await pending;

  assert.equal(app.saveSlot, undefined);
  assert.equal(events.includes('release-session'), true);
  assert.ok(events.indexOf('release-session') < events.indexOf('start-autosave'));
  assert.equal(events.at(-1), 'start:world');
  assert.equal(startedData?.map, PRESSURE_MAP);
  assert.equal(startedData?.x, PRESSURE_START.x);
  assert.equal(startedData?.y, PRESSURE_START.y);

  // If pressureMode turns false during shutdown, old session is released but arena does not restart.
  events.length = 0;
  triggerShutdown = undefined;
  const secondSession = app.session;
  app.releaseSession = (expected: unknown) => {
    assert.equal(expected, secondSession);
    events.push('release-second');
    return true;
  };
  const abortedChange = lifecycle.changePressureClass(nextClass.id);
  app.pressureMode = false;
  assert.ok(triggerShutdown);
  (triggerShutdown as () => void)();
  await abortedChange;
  assert.equal(events.includes('release-second'), true);
  assert.equal(events.includes('start:world'), false);
});

test('enterGame and pausePressure transition scenes and respect suspension', async () => {
  const started: Array<{ key: string; action: string }> = [];
  let modeSet = '';
  let suspended = false;
  const app = {
    mode: 'menu',
    get suspended() { return suspended; },
    content: { storyClasses: async () => ({ defaultClass: 'hero', classes: [] }) },
    ui: {
      loading() {},
      error() {},
      setMode(mode: string) { modeSet = mode; },
      resetInput() {},
    },
    game: {
      scene: {
        isActive: (key: string) => key === 'menu',
        getScene: () => ({
          scene: {
            start(key: string) { started.push({ key, action: 'start' }); },
          },
        }),
      },
    },
  } as unknown as StoryApp;

  const worldActions: string[] = [];
  const lifecycle = createSessionLifecycle(app, stubHooks({
    worldScene: () => fakeWorldScene({
      scene: {
        pause() { worldActions.push('pause'); },
        resume() { worldActions.push('resume'); },
      },
    }),
  }));

  await lifecycle.enterGame(2);
  assert.equal(app.saveSlot, 2);
  assert.equal(app.mode, 'class-select');
  assert.equal(modeSet, 'class-select');
  assert.deepEqual(started, [{ key: 'story-class-select', action: 'start' }]);

  lifecycle.pausePressure(true);
  lifecycle.pausePressure(false);
  suspended = true;
  lifecycle.pausePressure(false);
  assert.deepEqual(worldActions, ['pause', 'resume']);
});

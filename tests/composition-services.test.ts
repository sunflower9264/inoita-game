import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { type AssetLease } from '../src/application/assets.ts';
import {
  editingText,
  installDisplayFramePacing,
  installPageSuspensionLifecycle,
} from '../src/application/browser-lifecycle.ts';
import { StoryContentBootstrap } from '../src/application/content-bootstrap.ts';
import {
  parseControlSkin,
  parseMenuPanels,
  parseShops,
  parseStatusHud,
  parseStoryInterface,
  parseWardrobe,
} from '../src/application/content-validation.ts';
import { attachGmSessionBridge, detachGmSessionBridge } from '../src/application/gm-session-bridge.ts';
import { RuntimeDiagnosticsController } from '../src/application/runtime-diagnostics.ts';
import { SessionAutoSaveController } from '../src/application/session-auto-save.ts';
import type { StoryWorldViewSnapshot } from '../src/application/world-snapshot.ts';
import { parseCrafting } from '../src/domain/crafting.ts';
import { defaultPressureSettings } from '../src/domain/pressure-enemies.ts';
import type { SaveGame } from '../src/domain/save-game.ts';
import { SessionCheckpoint } from '../src/domain/session-checkpoint.ts';
import { newStorySession } from '../src/domain/story-class.ts';
import { StoryDirector } from '../src/domain/story-director.ts';

function readContent(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../public/content/${name}.json`, import.meta.url), 'utf8'));
}

function withDiagnostics<T>(
  record: (kind: string, details: unknown, withState?: boolean) => void,
  fn: () => Promise<T> | T,
): Promise<T> {
  const previous = globalThis.storyDiagnostics;
  globalThis.storyDiagnostics = {
    record,
    flush: async () => {},
    setSnapshot() {},
    setMetrics() {},
    export: async () => '',
  };
  return Promise.resolve().then(fn).finally(() => {
    globalThis.storyDiagnostics = previous;
  });
}

test('SessionAutoSaveController discards stale async screenshot writes and allows background sync flush', async () => {
  const { headlessContent } = await import('./helpers/story-playthrough.ts');
  const { campaign, world, items, battle, stats, storyClasses, companions } = headlessContent;
  const session = newStorySession(campaign, world.actors[campaign.start.actor], storyClasses.classes[0]!,
    items, stats, battle, companions);

  const writes: Array<SaveGame<StoryWorldViewSnapshot>> = [];
  let resolveScreenshot: ((value: string | undefined) => void) | undefined;
  let onCaptureStarted: (() => void) | undefined;
  let nowValue = 1000;
  let storyJumpActive = false;
  let latestThumbnail: string | undefined = 'data:image/jpeg;base64,PREVIOUS';
  let resetCalls = 0;

  const menuPanels = parseMenuPanels(readContent('menu-panels'));
  const app = {
    mode: 'game' as const,
    suspended: false,
    locked: false,
    pressureMode: false,
    get storyJumpActive() { return storyJumpActive; },
    session,
    world,
    storyClasses,
    menuPanels,
    saves: {
      write(_slot: 'auto' | number, game: SaveGame<StoryWorldViewSnapshot>) {
        writes.push(game);
      },
    },
    captureSaveWorld: () => ({
      ok: true as const,
      map: { id: campaign.start.map, name: '城镇' },
      world: { location: { map: campaign.start.map, x: 10, y: 20, facing: 'south' as const }, generatedEntities: [] },
    }),
  };

  const controller = new SessionAutoSaveController({
    app,
    thumbnails: {
      latest: () => latestThumbnail,
      capture: () => new Promise(resolve => {
        resolveScreenshot = resolve;
        onCaptureStarted?.();
      }),
      reset: () => { resetCalls += 1; },
    },
    now: () => nowValue,
  });

  controller.start(session);
  controller.flushForBackground();
  assert.equal(writes.length, 1);
  assert.equal(writes[0]!.summary.screenshot, 'data:image/jpeg;base64,PREVIOUS');

  // Stop mid-flight async capture: late screenshot resolution must not write to auto slot.
  nowValue = 4000;
  const firstCaptureStarted = new Promise<void>(resolve => { onCaptureStarted = resolve; });
  controller.request();
  const staleFlush = controller.current!.flush();
  await firstCaptureStarted;
  controller.stop();
  assert.equal(resetCalls, 2); // start() calls stop() once + explicit stop()
  resolveScreenshot!('data:image/jpeg;base64,LATE');
  await staleFlush;
  assert.equal(writes.length, 1);

  // Story jump becoming active while awaiting screenshot also suppresses stale write.
  controller.start(session);
  nowValue = 7000;
  const secondCaptureStarted = new Promise<void>(resolve => { onCaptureStarted = resolve; });
  controller.request();
  const pendingFlush = controller.current!.flush();
  await secondCaptureStarted;
  storyJumpActive = true;
  resolveScreenshot!('data:image/jpeg;base64,JUMPING');
  await pendingFlush;
  assert.equal(writes.length, 1);

  storyJumpActive = false;
  nowValue = 10_000;
  latestThumbnail = undefined;
  const thirdCaptureStarted = new Promise<void>(resolve => { onCaptureStarted = resolve; });
  controller.request();
  const validFlush = controller.current!.flush();
  await thirdCaptureStarted;
  resolveScreenshot!('data:image/jpeg;base64,FRESH');
  await validFlush;
  assert.equal(writes.length, 2);
  assert.equal(writes[1]!.summary.screenshot, 'data:image/jpeg;base64,FRESH');

  controller.stop();
});

test('StoryContentBootstrap isolates shared content loading from entry aborts and cleans up common leases', async () => {
  const { headlessContent } = await import('./helpers/story-playthrough.ts');
  let worldFetchSignal: AbortSignal | undefined;
  let releasedCommon = 0;
  const leases: AssetLease[] = [{ release() { releasedCommon += 1; } }];
  let worldCalls = 0;

  const storyInterface = parseStoryInterface(readContent('story-interface'));
  const menuPanels = parseMenuPanels(readContent('menu-panels'));
  const wardrobe = parseWardrobe(readContent('wardrobe'));
  const statusHud = parseStatusHud(readContent('status-hud'));
  const controlSkin = parseControlSkin(readContent('control-skin'));
  const shops = parseShops(readContent('shops'));
  const crafting = parseCrafting(readContent('crafting'));
  const app = {
    content: {
      trusted: true,
      world: async (signal?: AbortSignal) => {
        worldCalls += 1;
        worldFetchSignal = signal;
        return headlessContent.world;
      },
      campaign: async () => headlessContent.campaign,
      storyInterface: async () => storyInterface,
      battle: async () => headlessContent.battle,
      menuPanels: async () => menuPanels,
      items: async () => headlessContent.items,
      wardrobe: async () => wardrobe,
      statusHud: async () => statusHud,
      controlSkin: async () => controlSkin,
      characterStats: async () => headlessContent.stats,
      shops: async () => shops,
      companions: async () => headlessContent.companions,
      crafting: async () => crafting,
      prepareTownPoses: async () => {},
      shopEquipment: async () => shops.equipment,
      releaseValidationCaches() {},
    } as never,
    commonAssetLeases: leases,
    releaseCommonAssets() {
      for (const lease of leases.splice(0)) lease.release();
    },
  };

  const batchSignals: AbortSignal[] = [];
  let releaseExtraLate = 0;
  let notifySecondBatch!: () => void;
  const secondBatchStarted = new Promise<void>(resolve => { notifySecondBatch = resolve; });
  let notifySecondSettled!: () => void;
  const secondBatchSettled = new Promise<void>(resolve => { notifySecondSettled = resolve; });
  const bootstrap = new StoryContentBootstrap({
    app,
    gmOn: () => false,
    canLoadCommon: () => true,
    loadCommonBatch: async (_batch, signal) => {
      batchSignals.push(signal);
      if (batchSignals.length === 1) {
        return { release() {} };
      }
      notifySecondBatch();
      return await new Promise<AssetLease>(resolve => {
        signal.addEventListener('abort', () => resolve({
          release() {
            releaseExtraLate += 1;
            notifySecondSettled();
          },
        }), { once: true });
      });
    },
  });

  const callerAbort = new AbortController();
  callerAbort.abort();
  await bootstrap.prepareStory(callerAbort.signal);
  assert.equal(worldFetchSignal?.aborted, false);
  assert.equal(worldCalls, 1);

  bootstrap.prefetchCommon();
  await secondBatchStarted;
  assert.equal(app.commonAssetLeases.length, 2); // initial 1 + first common batch
  bootstrap.cancelCommonPreload();
  await secondBatchSettled;
  assert.equal(releaseExtraLate, 1); // aborted second batch released instead of retained

  bootstrap.dispose();
  assert.equal(bootstrap.contentSignal.aborted, true);
  assert.equal(releasedCommon, 1);
});

test('RuntimeDiagnosticsController suppresses idle low-fps alerts and respects the 5-minute cooldown', async () => {
  let nowValue = 10_000;
  const recorded: Array<{ kind: string; details: Record<string, unknown> }> = [];
  const diagnostics = new RuntimeDiagnosticsController({
    app: {
      mode: 'game',
      ready: true,
      locked: false,
      lockOwners: [],
      suspended: false,
      defeatOpen: false,
      dialogueOpen: false,
      choiceOpen: false,
      questPopupOpen: false,
      controlLayoutEditing: false,
      keyBindingEditing: false,
      pressureSettings: defaultPressureSettings(),
      trustedContent: true,
      menuOpen: false,
    },
    game: () => undefined,
    worldScene: () => ({ map: { id: 'town' }, diagnosticSnapshot: () => ({ ok: true }) }),
    gmOn: () => false,
    editingText: () => false,
    now: () => nowValue,
  });

  await withDiagnostics((kind, details) => {
    recorded.push({ kind, details: details as Record<string, unknown> });
  }, () => {
    // 1) After >2000ms idle reset, interval samples exist without secondSamples: must NOT alert.
    let t = 0;
    for (let i = 0; i < 40; i += 1) {
      t += 60;
      diagnostics.frame(t);
    }
    diagnostics.frame(t + 3000); // triggers idle reset
    t += 3000;
    for (let i = 0; i < 35; i += 1) {
      t += 20;
      diagnostics.frame(t);
    }
    diagnostics.tick();
    assert.equal(recorded.some(entry => entry.kind === 'performance-low-fps'), false);

    // 2) Sustained slow frames spanning >1s produce secondSamples > 0 -> alerts once.
    t += 3000;
    diagnostics.frame(t);
    for (let i = 0; i < 36; i += 1) {
      t += 45;
      diagnostics.frame(t);
    }
    nowValue = 20_000;
    diagnostics.tick();
    assert.equal(recorded.filter(entry => entry.kind === 'performance-low-fps').length, 1);

    // 3) Within 5-minute cooldown: must NOT alert again even on slow ticks.
    for (let i = 0; i < 36; i += 1) {
      t += 45;
      diagnostics.frame(t);
    }
    nowValue = 120_000;
    diagnostics.tick();
    assert.equal(recorded.filter(entry => entry.kind === 'performance-low-fps').length, 1);

    // 4) Past 5-minute cooldown: alerts again.
    for (let i = 0; i < 36; i += 1) {
      t += 45;
      diagnostics.frame(t);
    }
    nowValue = 360_000;
    diagnostics.tick();
    assert.equal(recorded.filter(entry => entry.kind === 'performance-low-fps').length, 2);
  });
});

test('attachGmSessionBridge and detachGmSessionBridge manage globalThis.gm and world port bindings', async () => {
  const { headlessContent } = await import('./helpers/story-playthrough.ts');
  const { campaign, world, items, battle, stats, storyClasses, companions } = headlessContent;
  const session = newStorySession(campaign, world.actors[campaign.start.actor], storyClasses.classes[0]!,
    items, stats, battle, companions);
  const director = new StoryDirector(campaign, session, {
    dialogue: async () => {},
    choice: async (_p, opts) => opts[0]!,
    questPopup: async () => {},
    toast() {},
    closeDialogue() {},
    skipDialogue() {},
  }, () => {});
  const controller = new AbortController();
  let noclipState = false;
  const app = {
    session,
    director,
    checkpoint: new SessionCheckpoint<StoryWorldViewSnapshot>(),
    storyUI: { close() {}, diagnosticState: () => ({ open: false }) },
    gm: undefined as ReturnType<typeof attachGmSessionBridge>,
    gmNoclip: false,
    gmSpeedMultiplier: 1,
    storyJumpActive: false,
  };

  try {
    assert.equal(attachGmSessionBridge({
      app,
      session,
      campaign,
      director,
      signal: controller.signal,
      gmOn: () => false,
      worldScene: () => undefined,
      runtimeDiagnostics: () => ({ mode: 'game' }),
    }), undefined);
    assert.equal(globalThis.gm, undefined);

    const gm = attachGmSessionBridge({
      app,
      session,
      campaign,
      director,
      signal: controller.signal,
      gmOn: () => true,
      worldScene: () => ({
        map: { id: campaign.start.map },
        worldReady: () => true,
        captureStoryWorld: () => ({ location: { map: campaign.start.map, x: 0, y: 0, facing: 'south' }, generatedEntities: [] }),
        projectStoryWorld: async () => {},
        restoreStoryWorld: async () => {},
        checkpointStoryWorld() {},
        rescuePlayer: () => ({ ok: true, moved: false }),
        setNoclip: enabled => { noclipState = enabled; return { ok: true }; },
        setSpeedMultiplier: () => ({ ok: true }),
        setInvincible: () => ({ ok: true }),
        setInfiniteMana: () => ({ ok: true }),
        setOneHitKill: () => ({ ok: true }),
        reviveMember: () => ({ ok: true }),
      }),
      runtimeDiagnostics: () => ({ mode: 'game', custom: true }),
    });
    assert.ok(gm);
    assert.equal(globalThis.gm, gm);
    assert.equal(gm.setNoclip(true).ok, true);
    assert.equal(noclipState, true);
    assert.equal(app.gmNoclip, true);
    assert.deepEqual(gm.digest().runtime, { mode: 'game', custom: true });

    detachGmSessionBridge(app);
    assert.equal(app.gm, undefined);
    assert.equal(globalThis.gm, undefined);
  } finally {
    detachGmSessionBridge(app);
    director.dispose();
  }
});

test('RuntimeDiagnosticsController snapshot and metrics aggregate renderer, texture bytes, and audio safely', async () => {
  const { headlessContent } = await import('./helpers/story-playthrough.ts');
  const { campaign, world, items, battle, stats, storyClasses, companions } = headlessContent;
  const session = newStorySession(campaign, world.actors[campaign.start.actor], storyClasses.classes[0]!,
    items, stats, battle, companions);

  const glCalls: string[] = [];
  const diagnostics = new RuntimeDiagnosticsController({
    app: {
      mode: 'game',
      ready: true,
      locked: true,
      lockOwners: ['game'],
      suspended: false,
      defeatOpen: false,
      dialogueOpen: false,
      choiceOpen: false,
      questPopupOpen: false,
      controlLayoutEditing: false,
      keyBindingEditing: false,
      pressureMode: true,
      pressureSettings: defaultPressureSettings(),
      trustedContent: false,
      menuOpen: false,
      session,
      audio: {
        captureStoryAudio: () => ({ music: 'town' }),
        settings: { music: 1, effects: 1 },
      },
    },
    game: () => ({
      renderer: {
        gl: {
          VERSION: 1,
          VENDOR: 2,
          RENDERER: 3,
          MAX_TEXTURE_SIZE: 4,
          getExtension: (name: string) => { glCalls.push(name); return null; },
          getParameter: (param: number) => `val:${param}`,
        } as unknown as WebGLRenderingContext,
      },
      textures: {
        getTextureKeys: () => ['a', 'b'],
        get: (key: string) => ({ source: { width: key === 'a' ? 10 : 20, height: 10 } }),
      },
      sound: {
        locked: false,
        mute: false,
        context: { state: 'running' },
        getAll: () => [{ key: 'bgm', isPlaying: true, isPaused: false }],
      },
    }),
    worldScene: () => ({ map: { id: 'town' }, diagnosticSnapshot: () => ({ ready: true }) }),
    gmOn: () => true,
    editingText: () => false,
    now: () => 5000,
  });

  const metrics = diagnostics.metrics();
  assert.deepEqual(glCalls, ['WEBGL_debug_renderer_info']);
  assert.deepEqual(metrics.textures, { count: 2, estimatedBytes: (10 * 10 + 20 * 10) * 4 });
  assert.equal((metrics.renderer as { unmaskedRenderer: unknown }).unmaskedRenderer, null);
  assert.equal((diagnostics.compact().lockOwners as readonly string[])[0], 'game');

  const snapshot = diagnostics.snapshot();
  assert.equal(snapshot.gm, true);
  assert.deepEqual((snapshot.audio as { playing: string[] }).playing, ['bgm']);
  assert.deepEqual(snapshot.pressureSettings, defaultPressureSettings());
});

test('browser-lifecycle handles missing DOM constructors and cancels background/orientation work on dispose', () => {
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevRaf = globalThis.requestAnimationFrame;
  const prevCancelRaf = globalThis.cancelAnimationFrame;

  const docListeners = new Map<string, Set<() => void>>();
  const winListeners = new Map<string, Set<() => void>>();
  let rafId = 1;
  const cancelledRafs: number[] = [];
  const sceneEvents: string[] = [];
  const audioEvents: string[] = [];
  let flushCount = 0;
  let suspendedState = false;
  let hidden = false;
  let innerWidth = 1000;
  let innerHeight = 600;
  let lockOwners: string[] = [];

  class FakeTarget {
    private readonly map: Map<string, Set<() => void>>;
    constructor(map: Map<string, Set<() => void>>) { this.map = map; }
    addEventListener(type: string, cb: () => void) {
      let set = this.map.get(type);
      if (!set) { set = new Set(); this.map.set(type, set); }
      set.add(cb);
    }
    removeEventListener(type: string, cb: () => void) {
      this.map.get(type)?.delete(cb);
    }
    emit(type: string) {
      for (const cb of [...(this.map.get(type) ?? [])]) cb();
    }
  }
  const fakeDoc = new FakeTarget(docListeners);
  const fakeWin = new FakeTarget(winListeners);

  try {
    Object.defineProperties(fakeDoc, {
      hidden: { get: () => hidden, configurable: true },
      visibilityState: { get: () => (hidden ? 'hidden' : 'visible'), configurable: true },
      activeElement: { value: {}, configurable: true },
    });
    Object.defineProperties(fakeWin, {
      innerWidth: { get: () => innerWidth, configurable: true },
      innerHeight: { get: () => innerHeight, configurable: true },
      setTimeout: { value: globalThis.setTimeout, configurable: true },
      clearTimeout: { value: globalThis.clearTimeout, configurable: true },
      matchMedia: { value: () => ({ addEventListener() {}, removeEventListener() {} }), configurable: true },
    });
    Object.assign(globalThis, {
      document: fakeDoc,
      window: fakeWin,
      requestAnimationFrame: () => ++rafId,
      cancelAnimationFrame: (id: number) => { cancelledRafs.push(id); },
    });

    assert.equal(editingText(), false);

    const fpsLimits: number[] = [];
    const pacing = installDisplayFramePacing({
      setFpsLimit: limit => fpsLimits.push(limit),
      applyRenderScale() {},
    });
    (globalThis as { __inoitaDisplayHz?: number }).__inoitaDisplayHz = 120;
    fakeWin.emit('inoita-display-rate');
    assert.ok(fpsLimits.length >= 1);
    pacing.dispose();

    const suspension = installPageSuspensionLifecycle({
      isAlreadySuspended: () => suspendedState,
      flushForBackground: () => { flushCount += 1; },
      setUiSuspended: val => { suspendedState = val; },
      hasLockOwner: owner => lockOwners.includes(owner),
      currentScene: () => ({
        isActive: () => !suspendedState,
        isPaused: () => suspendedState,
        pause() { sceneEvents.push('pause'); },
        resume() { sceneEvents.push('resume'); },
      }),
      storyStageScene: () => undefined,
      pauseAllSound: () => audioEvents.push('pause'),
      resumeAllSound: () => audioEvents.push('resume'),
      unlockSound() {},
      resetInput() {},
    });

    sceneEvents.length = 0;
    hidden = true;
    fakeDoc.emit('visibilitychange');
    assert.equal(flushCount, 1);
    assert.deepEqual(sceneEvents, ['pause']);

    lockOwners = ['pressure-debug'];
    hidden = false;
    fakeDoc.emit('visibilitychange');
    assert.deepEqual(sceneEvents, ['pause']); // pressure-debug prevents resume

    fakeWin.emit('orientationchange');
    suspension.dispose();
    assert.equal(cancelledRafs.at(-1), rafId);
  } finally {
    delete (globalThis as { __inoitaDisplayHz?: number }).__inoitaDisplayHz;
    Object.assign(globalThis, {
      document: prevDoc,
      window: prevWin,
      requestAnimationFrame: prevRaf,
      cancelAnimationFrame: prevCancelRaf,
    });
  }
});

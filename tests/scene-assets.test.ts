import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type Phaser from 'phaser';
import { loadSceneAssets, missingSceneAssets, retainLoadedSceneAssets } from '../src/rendering/scene-assets.ts';
import type { PendingAsset } from '../src/rendering/scene-assets.ts';

const asset: PendingAsset = { kind: 'spritesheet', key: 'skill-effect', file: 'assets/effect.png', config: { frameWidth: 8, frameHeight: 8, endFrame: 2 } };
const diagnostic = (pattern: RegExp) => (error: unknown) => error instanceof Error && pattern.test(String(error.cause));

function setup() {
  const events = new EventEmitter();
  const frames = new Map<string, Set<string | number>>();
  const removed: string[] = [];
  const queued: PendingAsset[] = [];
  let starts = 0;
  let outcome: 'success' | 'decode-error' | 'network-error' | 'missing-frame' | 'pending' = 'success';
  const load = Object.assign(new EventEmitter(), {
    spritesheet: (key: string, file: string, config: Phaser.Types.Loader.FileTypes.ImageFrameConfig) =>
      queued.push({ kind: 'spritesheet', key, file, config }),
    image: (key: string, file: string) => queued.push({ kind: 'image', key, file }),
    atlas: (key: string, file: string, atlas: string) => queued.push({ kind: 'atlas', key, file, atlas }),
    start: () => { starts++; queueMicrotask(() => {
      if (outcome === 'pending') return;
      for (const asset of queued.splice(0)) {
        if (outcome === 'network-error') load.emit('loaderror', { key: asset.key });
        if (asset.kind === 'atlas') {
          if (outcome === 'success') frames.set(asset.key, new Set(['frame-a', 'frame-b']));
          if (outcome === 'missing-frame') frames.set(asset.key, new Set(['frame-a']));
        } else {
          if (outcome === 'success') frames.set(asset.key, new Set([0, 1, 2]));
          if (outcome === 'missing-frame') frames.set(asset.key, new Set([0, 2]));
        }
      }
      // Phaser's decode failure reaches complete without loaderror or a failed count.
      load.emit('complete', load, 0, 0);
    }); }
  });
  const scene = {
    events, load,
    textures: {
      exists: (key: string) => frames.has(key),
      get: (key: string) => ({ has: (frame: string) => {
        const values = frames.get(key)!;
        return values.has(frame) || values.has(Number(frame));
      } }),
      remove: (key: string) => { removed.push(key); frames.delete(key); }
    },
    anims: { exists: () => false, remove: () => {} }
  } as unknown as Phaser.Scene;
  return { scene, events, load, frames, removed, queued, starts: () => starts, outcome: (next: typeof outcome) => { outcome = next; } };
}

test('decode failure rejects with the asset key and path, then retry can acquire and release it', async () => {
  const run = setup(); run.outcome('decode-error');
  await assert.rejects(loadSceneAssets(run.scene, [asset], () => {}), diagnostic(/skill-effect.*assets\/effect\.png/));
  assert.equal(run.events.listenerCount('shutdown'), 0);
  assert.deepEqual(run.load.eventNames(), []);
  run.outcome('success');
  const lease = await loadSceneAssets(run.scene, [asset], () => {});
  lease.release(); lease.release();
  assert.deepEqual(run.removed, [asset.key]);
});

test('missing middle frames reject both fresh and cached sprite sheets', async () => {
  for (const cached of [false, true]) {
    const run = setup(); run.outcome('missing-frame');
    if (cached) run.frames.set(asset.key, new Set([0, 2]));
    await assert.rejects(loadSceneAssets(run.scene, [asset], () => {}), diagnostic(/skill-effect.*帧 1/));
    assert.equal(run.starts(), 1, '预检判缺时必须真的进入 loader');
    assert.equal(run.frames.size, 0);
    assert.equal(run.events.listenerCount('shutdown'), 0);
  }
});

test('cached sprite sheet with missing frames is rebuilt instead of skipped', async () => {
  const run = setup();
  run.frames.set(asset.key, new Set([0, 2]));
  assert.equal(missingSceneAssets(run.scene, [asset]).length, 1, '预检按帧判断');
  const lease = await loadSceneAssets(run.scene, [asset], () => {});
  assert.equal(run.starts(), 1, '残帧缓存必须重新加载');
  assert.deepEqual([...run.frames.get(asset.key)!], [0, 1, 2]);
  assert.equal(missingSceneAssets(run.scene, [asset]).length, 0);
  lease.release();
  assert.deepEqual(run.removed, [asset.key, asset.key], '重建时删旧纹理，租约释放时删新纹理');
});

test('a residual texture held by another lease is not rebuilt', async () => {
  const run = setup();
  const held = await loadSceneAssets(run.scene, [asset], () => {}, true);
  run.frames.set(asset.key, new Set([0, 2]));
  await assert.rejects(loadSceneAssets(run.scene, [asset], () => {}), /仍被其他租约持有/);
  assert.deepEqual([...run.frames.get(asset.key)!], [0, 2], '共享纹理不能删');
  assert.equal(run.removed.includes(asset.key), false);
  held.release();
  assert.deepEqual(run.removed, [asset.key]);
});

test('valid cached assets stay alive until the last lease is released', async () => {
  const run = setup();
  const first = await loadSceneAssets(run.scene, [asset, asset], () => {});
  const second = await loadSceneAssets(run.scene, [asset], () => {}, true);
  assert.equal(run.queued.length, 0);
  run.events.emit('shutdown');
  assert.equal(run.frames.size, 1);
  first.release(); second.release(); second.release();
  assert.deepEqual(run.removed, [asset.key]);
});

test('simultaneous requests on one scene share a loader batch and retain independent leases', async () => {
  const run = setup();
  const [first, second] = await Promise.all([
    loadSceneAssets(run.scene, [asset], () => {}),
    loadSceneAssets(run.scene, [asset], () => {}, true)
  ]);
  assert.equal(run.starts(), 1);
  first.release();
  assert.equal(run.frames.size, 1);
  second.release();
  assert.deepEqual(run.removed, [asset.key]);
});

test('scenes sharing one texture manager register a key only once', async () => {
  const run = setup();
  let otherStarts = 0;
  const otherLoad = Object.assign(new EventEmitter(), {
    image() {}, spritesheet() {}, start() { otherStarts++; }
  });
  const otherScene = { ...run.scene, events: new EventEmitter(), load: otherLoad } as unknown as Phaser.Scene;
  const [first, second] = await Promise.all([
    loadSceneAssets(run.scene, [asset], () => {}),
    loadSceneAssets(otherScene, [asset], () => {})
  ]);
  assert.equal(run.starts(), 1);
  assert.equal(otherStarts, 0, '同一纹理库已有加载在排队，另一个场景不应再启动 loader');
  first.release(); second.release();
  assert.deepEqual(run.removed, [asset.key]);
});

test('network failure and shutdown clean up loading listeners and ownership', async () => {
  const network = setup(); network.outcome('network-error');
  await assert.rejects(loadSceneAssets(network.scene, [asset], () => {}), diagnostic(/skill-effect/));
  assert.deepEqual(network.load.eventNames(), []);
  const cancelled = setup(); cancelled.outcome('pending');
  const pending = loadSceneAssets(cancelled.scene, [asset], () => {});
  cancelled.events.emit('shutdown');
  await assert.rejects(pending, { name: 'AbortError' });
  assert.deepEqual(cancelled.load.eventNames(), []);
  assert.equal(cancelled.events.listenerCount('shutdown'), 0);
});

test('atlas assets load with string frames and verify their sentinel frame', async () => {
  const atlas: PendingAsset = { kind: 'atlas', key: 'props-atlas:0', file: 'assets/props/atlas/props-0.png',
    atlas: 'assets/props/atlas/props-0.json', frame: 'frame-a' };
  const run = setup();
  assert.equal(missingSceneAssets(run.scene, [atlas]).length, 1);
  run.frames.set(atlas.key, new Set(['frame-b']));
  assert.equal(missingSceneAssets(run.scene, [atlas]).length, 1, '哨兵帧缺失必须重新加载');
  const lease = await loadSceneAssets(run.scene, [atlas], () => {});
  assert.equal(missingSceneAssets(run.scene, [atlas]).length, 0);
  assert.equal(run.queued.length, 0);
  lease.release();
  assert.deepEqual(run.removed, [atlas.key, atlas.key], '哨兵帧缺失时先删旧纹理，释放时再删新纹理');
});

test('concurrent loaders can repair one damaged atlas texture without one failing', async () => {
  const atlas: PendingAsset = { kind: 'atlas', key: 'props-atlas:0', file: 'assets/props/atlas/props-0.png',
    atlas: 'assets/props/atlas/props-0.json', frame: 'frame-a' };
  const run = setup();
  run.frames.set(atlas.key, new Set(['frame-b'])); // 哨兵帧缺失的损坏缓存
  const [first, second] = await Promise.all([
    loadSceneAssets(run.scene, [atlas], () => {}),
    loadSceneAssets(run.scene, [atlas], () => {})
  ]);
  assert.equal(missingSceneAssets(run.scene, [atlas]).length, 0);
  first.release(); second.release();
  assert.deepEqual(run.removed, [atlas.key, atlas.key], '只删一次旧缓存，最后释放一次新纹理');
});

test('retaining assets verifies textures and frames before taking a lease', () => {
  const run = setup();
  assert.throws(() => retainLoadedSceneAssets(run.scene, [asset]), /常驻资源尚未就绪：skill-effect/);
  run.frames.set(asset.key, new Set([0, 2]));
  assert.throws(() => retainLoadedSceneAssets(run.scene, [asset]), /缺少帧 1/);
  run.frames.set(asset.key, new Set([0, 1, 2]));
  const lease = retainLoadedSceneAssets(run.scene, [asset]);
  lease.release();
  assert.deepEqual(run.removed, [asset.key]);
});

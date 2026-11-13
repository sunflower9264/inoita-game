import test from 'node:test';
import assert from 'node:assert/strict';
import { DomAssets, type DomImageLoader } from '../src/ui/dom/assets.ts';
import { UI_ATLAS_FRAMES } from '../src/generated/ui-atlas.ts';

test('a stalled image or atlas times out, releases its shared entry and can retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const stalled of ['image', 'atlas'] as const) {
    let hang = true;
    let requestSignal: AbortSignal | undefined;
    const assets = new DomAssets({
      image: async (_url, signal) => {
        if (stalled === 'image' && hang) { requestSignal = signal; return new Promise(() => {}); }
        return { width: 100, height: 100 };
      },
      atlas: async (_url, signal) => {
        if (stalled === 'atlas' && hang) { requestSignal = signal; return new Promise(() => {}); }
        return { frames: { 'assets/skills/ambush.png': { frame: { x: 0, y: 0, w: 10, h: 10 } } } };
      }
    });
    const file = stalled === 'image' ? 'pending.png' : 'assets/skills/ambush.png';
    const pending = assets.acquire(file, new AbortController().signal);
    const rejected = assert.rejects(pending, /界面资源加载超时/);
    for (let i = 0; i < 30 && !requestSignal; i++) await Promise.resolve();
    assert.ok(requestSignal);
    t.mock.timers.tick(15_000);
    await rejected;
    assert.equal(requestSignal.aborted, true);
    assert.equal(assets.size, 0);
    hang = false;
    const lease = await assets.acquire(file, new AbortController().signal);
    lease.release();
  }
});

test('a stalled browser image decode can time out and cancel the image', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let removed = false;
  class PendingImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    naturalWidth = 10;
    naturalHeight = 10;
    set src(_value: string) { queueMicrotask(() => this.onload?.()); }
    decode(): Promise<void> { return new Promise(() => {}); }
    removeAttribute(): void { removed = true; }
  }
  const previous = globalThis.Image;
  globalThis.Image = PendingImage as unknown as typeof Image;
  try {
    const assets = new DomAssets();
    const pending = assets.acquire('decode.png', new AbortController().signal);
    const rejected = assert.rejects(pending, /界面资源加载超时/);
    await Promise.resolve();
    t.mock.timers.tick(15_000);
    await rejected;
    assert.equal(removed, true);
    assert.equal(assets.size, 0);
  } finally { globalThis.Image = previous; }
});

test('shared image loading survives one owner cancelling and releases on the last owner', async () => {
  let finish!: (size: { width: number; height: number }) => void;
  let loads = 0;
  let sharedSignal!: AbortSignal;
  const loader: DomImageLoader = {
    image: (_url, signal) => { loads++; sharedSignal = signal; return new Promise(resolve => { finish = resolve; }); },
    atlas: async () => ({ frames: {} })
  };
  const assets = new DomAssets(loader), first = new AbortController(), second = new AbortController();
  const a = assets.acquire('assets/example.png', first.signal);
  const b = assets.acquire('/assets/example.png', second.signal);
  const rejected = assert.rejects(a, { name: 'AbortError' });
  first.abort();
  await rejected;
  assert.equal(loads, 1);
  assert.equal(sharedSignal.aborted, false);
  finish({ width: 100, height: 80 });
  const lease = await b;
  assert.deepEqual(lease.source.frame, { x: 0, y: 0, width: 100, height: 80 });
  lease.release(); lease.release();
  assert.equal(sharedSignal.aborted, true);
  assert.equal(assets.size, 0);
});

test('different icon frames share the atlas image and metadata', async () => {
  let images = 0, metadata = 0;
  const assets = new DomAssets({
    image: async () => { images++; return { width: 2048, height: 2048 }; },
    atlas: async () => { metadata++; return { frames: {
      'assets/skills/ambush.png': { frame: { x: 12, y: 22, w: 75, h: 75 } },
      'assets/skills/aimed-shot.png': { frame: { x: 92, y: 22, w: 75, h: 75 } }
    } }; }
  });
  const signal = new AbortController().signal;
  const [a, b] = await Promise.all([assets.acquire('assets/skills/ambush.png', signal), assets.acquire('assets/skills/aimed-shot.png', signal)]);
  assert.equal(images, 1); assert.equal(metadata, 1);
  assert.equal(a.source.url, b.source.url);
  assert.equal(a.source.frame.x, 12); assert.equal(b.source.frame.x, 92);
  a.release(); assert.equal(assets.size, 1);
  b.release(); assert.equal(assets.size, 0);
});

test('failed preload releases earlier images and permits retry', async () => {
  let fail = true;
  const assets = new DomAssets({
    image: async url => { if (url.endsWith('bad.png') && fail) throw new Error('failed'); return { width: 5, height: 6 }; },
    atlas: async () => ({ frames: {} })
  });
  const signal = new AbortController().signal;
  await assert.rejects(assets.preloadFiles(['ok.png', 'bad.png'], signal, () => {}), /failed/);
  assert.equal(assets.size, 0);
  fail = false;
  const progress: number[] = [];
  const lease = await assets.preloadFiles(['ok.png', 'ok.png', 'bad.png'], signal, value => progress.push(value));
  assert.deepEqual(progress, [.5, 1]); lease.release(); assert.equal(assets.size, 0);
});

test('cancellation rejects even while a shared image remains pending', async () => {
  const assets = new DomAssets({ image: () => new Promise(() => {}), atlas: async () => ({ frames: {} }) });
  const controller = new AbortController();
  const pending = assets.acquire('pending.png', controller.signal);
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  controller.abort(); await rejected;
  assert.equal(assets.size, 0);
});

test('a leased image keeps its decoded element available to the menu', async () => {
  const image = { naturalWidth: 32, naturalHeight: 20 } as HTMLImageElement;
  const assets = new DomAssets({ image: async () => ({ width: 32, height: 20, image }), atlas: async () => ({ frames: {} }) });
  const lease = await assets.acquire('resident.png', new AbortController().signal);
  assert.equal(lease.source.image, image);
  lease.release();
  assert.equal(assets.size, 0);
});

test('an atlas frame pointing at a missing page fails instead of loading the raw file', async () => {
  const file = Object.keys(UI_ATLAS_FRAMES)[0]!;
  const entry = UI_ATLAS_FRAMES[file]!;
  const page = entry.page;
  entry.page = 9999;
  try {
    const assets = new DomAssets({
      image: async () => { throw new Error('不应加载原文件'); },
      atlas: async () => ({ frames: {} })
    });
    assert.throws(() => assets.peek(file), /界面图集缺页/);
    await assert.rejects(assets.acquire(file, new AbortController().signal), /界面图集缺页/);
  } finally {
    entry.page = page;
  }
});

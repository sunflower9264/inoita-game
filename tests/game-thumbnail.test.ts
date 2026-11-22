import assert from 'node:assert/strict';
import test from 'node:test';
import type Phaser from 'phaser';
import { SaveThumbnails, thumbnailSize } from '../src/ui/phaser/game-thumbnail.ts';

test('存档缩略图等比缩进最大尺寸，不放大也不变形', () => {
  assert.deepEqual(thumbnailSize(1280, 720), { width: 360, height: 203 });
  assert.deepEqual(thumbnailSize(960, 640), { width: 305, height: 203 });
  assert.deepEqual(thumbnailSize(360, 203), { width: 360, height: 203 });
  // 小于上限的图保持原尺寸，避免把小画面放大后变糊。
  assert.deepEqual(thumbnailSize(200, 100), { width: 200, height: 100 });
  // 极端宽窄比例也必须至少留 1 像素。
  assert.deepEqual(thumbnailSize(10000, 10), { width: 360, height: 1 });
  assert.deepEqual(thumbnailSize(0, 100), { width: 0, height: 0 });
  assert.deepEqual(thumbnailSize(Number.NaN, 100), { width: 0, height: 0 });
});

test('换局后只接收本局的截图，后台保存只读取本局最近的画面', async t => {
  class Frame {
    width = 32;
    height = 24;
    url: string;
    constructor(url: string) { this.url = url; }
  }
  let drawn: Frame | undefined;
  const document = { createElement: () => ({
    getContext: () => ({ drawImage: (frame: Frame) => { drawn = frame; } }),
    toDataURL: () => drawn!.url,
  }) };
  for (const [key, value] of Object.entries({ HTMLImageElement: Frame, document })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => previous ? Object.defineProperty(globalThis, key, previous) : Reflect.deleteProperty(globalThis, key));
  }
  const frames: ((image: Frame) => void)[] = [];
  const renderer = {
    snapshotState: { callback: null as ((image: Frame) => void) | null },
    snapshot(callback: (image: Frame) => void) { renderer.snapshotState.callback = callback; frames.push(callback); },
  };
  const game = { renderer } as unknown as Phaser.Game;
  const photos = new SaveThumbnails();
  const old = new Frame('data:image/jpeg;base64,AQ==');
  const current = new Frame('data:image/jpeg;base64,Ag==');

  const first = photos.capture(game);
  assert.equal(renderer.snapshotState.callback, frames[0], '截图请求挂在渲染器的一次性回调上');
  frames[0](old);
  assert.equal(await first, old.url);
  assert.equal(renderer.snapshotState.callback, null, '完成的快照清掉渲染器回调');
  const previous = photos.capture(game);
  assert.equal(renderer.snapshotState.callback, frames[1]);
  photos.reset();
  assert.equal(renderer.snapshotState.callback, null, '换局时清掉渲染器里还没执行的快照回调');
  const next = photos.capture(game);
  assert.equal(renderer.snapshotState.callback, frames[2], '新的一局重新挂自己的回调');
  assert.equal(await previous, undefined);
  assert.equal(photos.capture(game), next);
  assert.equal(frames.length, 3);
  frames[1](old);
  assert.equal(photos.latest, undefined);
  assert.equal(photos.capture(game), next);
  frames[2](current);
  assert.equal(await next, current.url);
  assert.equal(photos.latest, current.url);

  const delayed = photos.capture(game, 0);
  assert.equal(await delayed, undefined);
  frames[3](old);
  assert.equal(photos.latest, current.url);
});

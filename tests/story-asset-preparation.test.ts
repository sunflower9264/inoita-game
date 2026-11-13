import test from 'node:test';
import assert from 'node:assert/strict';
import { StoryAssetPreparation } from '../src/application/story-asset-preparation.ts';

test('world handoff shares a pending download and retains it until the receiver owns it', async () => {
  const preparation = new StoryAssetPreparation(), signal = new AbortController().signal;
  let finish!: () => void, calls = 0, releases = 0;
  const load = async () => { calls++; await new Promise<void>(resolve => { finish = resolve; }); return { release: () => { releases++; } }; };
  const first = preparation.prepare('B', 'B/script', signal, load);
  assert.equal(preparation.prepare('B', 'B/script', signal, load), first);
  await Promise.resolve();
  let ready = false;
  const handoff = preparation.wait('B').then(() => { ready = true; });
  assert.equal(ready, false);
  finish(); await handoff;
  assert.equal(calls, 1); assert.equal(releases, 0);
  preparation.release('B'); preparation.clear(); assert.equal(releases, 1);
});

test('superseded and cancelled late results release without replacing the new target', async () => {
  const preparation = new StoryAssetPreparation(), owner = new AbortController();
  let finish!: () => void, oldReleased = 0, newReleased = 0;
  const old = preparation.prepare('A', 'A', owner.signal, async () => {
    await new Promise<void>(resolve => { finish = resolve; }); return { release: () => { oldReleased++; } };
  });
  await Promise.resolve();
  await preparation.prepare('B', 'B', owner.signal, async () => ({ release: () => { newReleased++; } }));
  finish(); await old;
  assert.equal(oldReleased, 1); assert.equal(newReleased, 0);
  owner.abort(); assert.equal(newReleased, 1);
});

test('failed prefetch allows foreground fallback and a later retry', async () => {
  const preparation = new StoryAssetPreparation(), signal = new AbortController().signal;
  const failed = preparation.prepare('B', 'B', signal, async () => { throw new Error('offline'); });
  await preparation.wait('B'); await assert.rejects(failed, /offline/);
  let ready = false;
  await preparation.prepare('B', 'B', signal, async () => { ready = true; return { release() {} }; });
  assert.equal(ready, true); preparation.clear();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ContentLoader } from '../src/application/content-loader.ts';

const fixture = JSON.parse(readFileSync(new URL('../public/content/status-hud.json', import.meta.url), 'utf8'));

test('concurrent callers fetch and parse one content file once, even if one caller cancels', async () => {
  const original = globalThis.fetch;
  let calls = 0, parses = 0;
  let finish!: (response: Response) => void;
  globalThis.fetch = (async () => {
    calls++;
    return new Promise<Response>(resolve => { finish = resolve; });
  }) as typeof fetch;
  try {
    const loader = new ContentLoader();
    const cancelled = new AbortController();
    const first = loader.statusHud(cancelled.signal);
    const second = loader.statusHud();
    cancelled.abort();
    await assert.rejects(first, { name: 'AbortError' });
    finish({ ok: true, json: async () => { parses++; return fixture; } } as Response);
    const result = await second;
    assert.equal(calls, 1);
    assert.equal(parses, 1);
    assert.equal(await loader.statusHud(), result);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});

test('trusted loader returns raw JSON without running the semantic parser', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: true, json: async () => ({}) } as Response)) as typeof fetch;
  try {
    const trusted = new ContentLoader();
    trusted.trusted = true;
    assert.deepEqual(await trusted.statusHud(), {});
    const checked = new ContentLoader();
    await assert.rejects(checked.statusHud());
  } finally { globalThis.fetch = original; }
});

test('failed content can be requested again', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return calls === 1 ? { ok: false } as Response : { ok: true, json: async () => fixture } as Response;
  }) as typeof fetch;
  try {
    const loader = new ContentLoader();
    await assert.rejects(loader.statusHud(), /status-hud.json/);
    await loader.statusHud();
    assert.equal(calls, 2);
  } finally { globalThis.fetch = original; }
});

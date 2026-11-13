import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ContentLoader } from '../src/application/content-loader.ts';

const fixture = JSON.parse(readFileSync(new URL('../public/content/status-hud.json', import.meta.url), 'utf8'));

test('a stalled content request times out for all callers and can be retried', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const original = globalThis.fetch;
  let calls = 0;
  let requestSignal: AbortSignal | undefined;
  globalThis.fetch = ((_url, options) => {
    calls++;
    requestSignal = options?.signal as AbortSignal;
    return calls === 1 ? new Promise<Response>(() => {}) : Promise.resolve({ ok: true, json: async () => fixture } as Response);
  }) as typeof fetch;
  try {
    const loader = new ContentLoader();
    const first = loader.statusHud();
    const second = loader.statusHud();
    const failures = Promise.all([assert.rejects(first, /资源加载超时/), assert.rejects(second, /资源加载超时/)]);
    t.mock.timers.tick(15_000);
    await failures;
    assert.equal(requestSignal?.aborted, true);
    await loader.statusHud();
    assert.equal(calls, 2);
  } finally { globalThis.fetch = original; }
});

test('releasing the debug catalog makes the next request reload it',async()=>{
  const original=globalThis.fetch;let calls=0;
  globalThis.fetch=(async()=>{calls++;return {ok:true,json:async()=>({tasks:[]})} as Response;}) as typeof fetch;
  try{
    const loader=new ContentLoader();
    const first=await loader.storyDebug();assert.equal(await loader.storyDebug(),first);
    loader.releaseStoryDebug();const next=await loader.storyDebug();
    assert.notEqual(next,first);assert.equal(calls,2);
  }finally{globalThis.fetch=original;}
});

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

const manifest = { schema: 1, contentVersion: '', required: {} };
const manifestResponse = () => ({ ok: true, json: async () => manifest } as Response);

test('trusted loader returns raw JSON without running the semantic parser', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => String(input) === 'content-manifest.json'
    ? manifestResponse() : { ok: true, json: async () => ({}) } as Response) as typeof fetch;
  try {
    const trusted = new ContentLoader();
    trusted.trusted = true;
    assert.deepEqual(await trusted.statusHud(), {});
    const checked = new ContentLoader();
    await assert.rejects(checked.statusHud());
  } finally { globalThis.fetch = original; }
});

test('trusted loader rejects a content version that differs from the page build', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => String(input) === 'content-manifest.json'
    ? { ok: true, json: async () => ({ ...manifest, contentVersion: 'other' }) } as Response
    : { ok: true, json: async () => ({}) } as Response) as typeof fetch;
  try {
    const loader = new ContentLoader();
    loader.trusted = true;
    loader.contentVersion = 'page-build';
    await assert.rejects(loader.statusHud(), /内容版本与页面不一致/);
  } finally { globalThis.fetch = original; }
});

test('trusted loader rejects a file missing a required top-level key', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => String(input) === 'content-manifest.json'
    ? { ok: true, json: async () => ({ ...manifest, required: { 'content/status-hud.json': ['version'] } }) } as Response
    : { ok: true, json: async () => ({}) } as Response) as typeof fetch;
  try {
    const loader = new ContentLoader();
    loader.trusted = true;
    await assert.rejects(loader.statusHud(), /缺少必需字段：content\/status-hud\.json version/);
  } finally { globalThis.fetch = original; }
});

test('trusted loader fails clearly when the production manifest is missing', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => String(input) === 'content-manifest.json'
    ? { ok: false } as Response : { ok: true, json: async () => ({}) } as Response) as typeof fetch;
  try {
    const loader = new ContentLoader();
    loader.trusted = true;
    await assert.rejects(loader.statusHud(), /生产内容清单缺失/);
  } finally { globalThis.fetch = original; }
});

test('trusted wardrobe returns the core file and fetches only requested poses', async () => {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url === 'content-manifest.json') return manifestResponse();
    const body = url === 'content/wardrobe.json' ? { poses: {} } : { mirrorX: false, frameRate: 8, frames: [] };
    return { ok: true, json: async () => body } as Response;
  }) as typeof fetch;
  try {
    const loader = new ContentLoader();
    loader.trusted = true;
    assert.deepEqual(await loader.wardrobe(), { poses: {} });
    await loader.wardrobePoses(['pose-a']);
    assert.deepEqual(calls, ['content/wardrobe.json', 'content-manifest.json', 'content/wardrobe/poses/pose-a.json']);
    await loader.wardrobePoses(['pose-a']);
    assert.deepEqual(calls, ['content/wardrobe.json', 'content-manifest.json', 'content/wardrobe/poses/pose-a.json', 'content/wardrobe/poses/pose-a.json']);
  } finally { globalThis.fetch = original; }
});

test('map cache retains two recently read results without invalidating returned maps or in-flight downloads', async () => {
  const original = globalThis.fetch, calls = new Map<string, number>();
  let finish!: () => void;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === 'content-manifest.json') return manifestResponse();
    calls.set(url, (calls.get(url) ?? 0) + 1);
    const response = { ok: true, json: async () => ({ id: url }) } as Response;
    if (url === 'pending') return new Promise<Response>(resolve => { finish = () => resolve(response); });
    return response;
  }) as typeof fetch;
  try {
    const loader = new ContentLoader(); loader.trusted = true;
    const pending = loader.map('pending');
    const first = await loader.map('a'); await loader.map('b');
    assert.equal(await loader.map('a'), first);
    await loader.map('c');
    assert.equal(await loader.map('a'), first);
    await loader.map('b');
    assert.equal(calls.get('a'), 1); assert.equal(calls.get('b'), 2);
    assert.equal(first.id, 'a');
    const sharedPending = loader.map('pending'); finish();
    assert.equal(await pending, await sharedPending); assert.equal(calls.get('pending'), 1);
  } finally { globalThis.fetch = original; }
});

test('pose requests share in-flight data but release completed results to their callers', async () => {
  const original = globalThis.fetch;
  let calls = 0, finish!: () => void;
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (String(input) === 'content-manifest.json') return manifestResponse();
    calls++;
    return new Promise<Response>(resolve => { finish = () => resolve({ ok: true, json: async () => ({ frames: [], frameRate: 8 }) } as Response); });
  }) as typeof fetch;
  try {
    const loader = new ContentLoader(); loader.trusted = true;
    const first = loader.wardrobePoses(['idle']), second = loader.wardrobePoses(['idle']);
    finish(); const [a, b] = await Promise.all([first, second]);
    assert.equal(a.idle, b.idle); assert.equal(calls, 1);
    const next = loader.wardrobePoses(['idle']); finish(); await next;
    assert.equal(calls, 2);
  } finally { globalThis.fetch = original; }
});

test('validation releases full wardrobe poses and source-format callers can reload an individual pose', async () => {
  const original = globalThis.fetch;
  const source = readFileSync(new URL('../public/content/wardrobe.json', import.meta.url), 'utf8');
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++; return { ok: true, json: async () => JSON.parse(source) } as Response;
  }) as typeof fetch;
  try {
    const loader = new ContentLoader(), wardrobe = await loader.wardrobe();
    const id = Object.keys(wardrobe.poses)[0]!;
    const pose = wardrobe.poses[id];
    loader.releaseValidationCaches(wardrobe);
    assert.deepEqual(wardrobe.poses, {});
    assert.deepEqual((await loader.wardrobePoses([id]))[id], pose);
    assert.equal(calls, 2);
    assert.deepEqual(wardrobe.poses, {});
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

test('session cleanup keeps core content tables cached', async () => {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === 'content-manifest.json') return manifestResponse();
    calls.push(url);
    return { ok: true, json: async () => ({}) } as Response;
  }) as typeof fetch;
  try {
    const loader = new ContentLoader();
    loader.trusted = true;
    await loader.statusHud();
    loader.clearSessionCaches();
    await loader.statusHud();
    assert.deepEqual(calls, ['content/status-hud.json']);
  } finally { globalThis.fetch = original; }
});

test('session cleanup drops map and pose content so the next request reloads them', async () => {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === 'content-manifest.json') return manifestResponse();
    calls.push(url);
    return { ok: true, json: async () => ({}) } as Response;
  }) as typeof fetch;
  try {
    const loader = new ContentLoader();
    loader.trusted = true;
    await loader.map('content/maps/town.json');
    await loader.wardrobePoses(['pose-a']);
    loader.clearSessionCaches();
    await loader.map('content/maps/town.json');
    await loader.wardrobePoses(['pose-a']);
    assert.deepEqual(calls, [
      'content/maps/town.json', 'content/wardrobe/poses/pose-a.json',
      'content/maps/town.json', 'content/wardrobe/poses/pose-a.json',
    ]);
  } finally { globalThis.fetch = original; }
});

test('session cleanup keeps an in-flight map request and resolves its waiter', async () => {
  const original = globalThis.fetch;
  let mapCalls = 0;
  let finish!: () => void;
  const value = { id: 'town' };
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === 'content-manifest.json') return manifestResponse();
    mapCalls++;
    return new Promise<Response>(resolve => {
      finish = () => resolve({ ok: true, json: async () => value } as Response);
    });
  }) as typeof fetch;
  try {
    const loader = new ContentLoader();
    loader.trusted = true;
    const pending = loader.map('content/maps/town.json');
    loader.clearSessionCaches();
    finish();
    assert.equal(await pending, value);
    assert.equal(await loader.map('content/maps/town.json'), value);
    assert.equal(mapCalls, 1, '完成后仍留在缓存里，下一次调用不再请求');
  } finally { globalThis.fetch = original; }
});

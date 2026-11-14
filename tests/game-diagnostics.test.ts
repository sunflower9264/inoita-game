import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const source = await readFile(new URL('../public/diagnostics.js', import.meta.url), 'utf8');
const { installDiagnosticSnapshot, installStorySkipDiagnostics, FrameStats } = await import('../src/application/game-diagnostics.ts');
const middlewareUrl = new URL('../tools/diagnostic-collector.mjs', import.meta.url).href;
type Middleware = (req: EventEmitter & { url: string; method: string; headers: Record<string, string> }, res: {
  setHeader(key: string, value: string): void; writeHead(status: number): void; end(): void; writableEnded: boolean;
}, next: () => void) => void;
const { createDiagnosticMiddleware } = await import(middlewareUrl) as { createDiagnosticMiddleware(root: string): Middleware };
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

interface Entry { id: string; session: string; seq: number; kind: string; details: Record<string, unknown>;
  state: unknown; repeats?: number; build?: unknown }
interface Collector {
  record(kind: string, details: unknown, withState?: boolean): void; flush(): Promise<void>;
  setSnapshot(provider: () => unknown): void;
  setMetrics(provider: () => unknown): void;
  export(): Promise<string>;
}
function client(storage = new Map<string, string>(), brokenStorage = false,
  options: { native?: boolean; hostname?: string; onNativeReport?: (body: string, id: string) => void;
    indexedDB?: unknown; fetchStatus?: () => number } = {}) {
  const windowEvents = new EventEmitter(), documentEvents = new EventEmitter();
  const sent: { entries: Entry[] }[] = [], originals: unknown[][] = [], intervals: (() => void)[] = [];
  const timeouts: { id: number; callback: () => void }[] = [];
  let now = 1000, nextTimeout = 1, online = true;
  class Clock extends Date { static override now() { return now; } }
  const document = { currentScript: { src: 'http://localhost:4002/diagnostics.js' }, visibilityState: 'visible',
    addEventListener: (event: string, callback: (...args: unknown[]) => void) => documentEvents.on(event, callback) };
  const sandbox = {
    document, console: { error: (...args: unknown[]) => originals.push(args),
      warn: (...args: unknown[]) => originals.push(args) },
    location: { pathname: '/', hostname: options.hostname }, navigator: { userAgent: 'test mobile' },
    innerWidth: 800, innerHeight: 400, devicePixelRatio: 2, URL, AbortController, Date: Clock,
    localStorage: { getItem: (key: string) => { if (brokenStorage) throw Error('disabled'); return storage.get(key) ?? null; },
      setItem: (key: string, value: string) => { if (brokenStorage) throw Error('disabled'); storage.set(key, value); },
      removeItem: (key: string) => { if (brokenStorage) throw Error('disabled'); storage.delete(key); } },
    addEventListener: (event: string, callback: (...args: unknown[]) => void) => windowEvents.on(event, callback),
    setInterval: (callback: () => void) => { intervals.push(callback); return intervals.length; },
    setTimeout: (callback: () => void) => { const id = nextTimeout++; timeouts.push({ id, callback }); return id; },
    clearTimeout: (id: number) => { const index = timeouts.findIndex(timer => timer.id === id);
      if (index >= 0) timeouts.splice(index, 1); },
    fetch: async (_url: string, request: { body: string }) => {
      if (!online) throw Error('offline');
      const status = options.fetchStatus?.() ?? 200;
      const ok = status >= 200 && status < 300;
      if (ok) sent.push(JSON.parse(request.body));
      return { ok, status };
    },
    InotiaNative: options.native ? { report: (body: string, id: string) => options.onNativeReport?.(body, id) } : undefined,
    indexedDB: options.indexedDB,
    storyDiagnostics: undefined as Collector | undefined,
    window: undefined as unknown
  };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(source, context);
  const collector = sandbox.storyDiagnostics!;
  const entries = async () => (JSON.parse(await collector.export()) as { entries: Entry[] }).entries;
  return { sandbox, context, collector, sent, entries, originals, windowEvents, documentEvents, document, storage,
    pending: entries,
    nativeResult: (id: string, ok: boolean) =>
      (sandbox as unknown as { __inoitaNativeReportResult?: (id: string, ok: boolean) => void })
        .__inoitaNativeReportResult?.(id, ok),
    online(value: boolean) { online = value; },
    advance(ms: number) { now += ms; for (const timer of intervals) timer(); },
    runTimers() { for (const timer of timeouts.splice(0)) timer.callback(); } };
}

/** 只实现收集器用到的 IndexedDB 子集：add/delete/count/getAll/openCursor。 */
function fakeIndexedDB(options: { failAdds?: boolean } = {}) {
  const stores = new Map<string, Map<number, Record<string, unknown>>>();
  let nextKey = 1;
  const clone = <T>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
  function cursorRequest(map: Map<number, Record<string, unknown>>, direction?: string) {
    const request: {
      result?: { value: Record<string, unknown>; delete(): void; continue(): void } | null;
      onsuccess?: () => void;
    } = {};
    const keys = [...map.keys()].sort((a, b) => a - b);
    if (direction === 'prev') keys.reverse();
    let index = 0;
    const step = (): void => {
      if (index >= keys.length) { request.result = null; request.onsuccess?.(); return; }
      const key = keys[index++];
      request.result = { value: map.get(key)!,
        delete() { map.delete(key); },
        continue() { Promise.resolve().then(step); } };
      request.onsuccess?.();
    };
    Promise.resolve().then(step);
    return request;
  }
  function database() {
    return {
      objectStoreNames: { contains: (name: string) => stores.has(name) },
      createObjectStore(name: string) { stores.set(name, new Map()); return { createIndex() {} }; },
      transaction(name: string) {
        const map = stores.get(name)!;
        const tx: { complete?: () => void; error?: () => void } = {};
        return {
          set oncomplete(callback: () => void) { tx.complete = callback; },
          set onerror(callback: () => void) { tx.error = callback; },
          set onabort(callback: () => void) { tx.error = callback; },
          objectStore() {
            return {
              add(entry: Record<string, unknown>) {
                Promise.resolve().then(() => {
                  if (options.failAdds) { tx.error?.(); return; }
                  const key = nextKey++;
                  map.set(key, { ...clone(entry), key });
                  tx.complete?.();
                });
              },
              delete(key: number) {
                Promise.resolve().then(() => { map.delete(key); tx.complete?.(); });
              },
              count() {
                const request: { result?: number; onsuccess?: () => void } = {};
                Promise.resolve().then(() => { request.result = map.size; request.onsuccess?.(); });
                return request;
              },
              getAll() {
                const request: { result?: Record<string, unknown>[]; onsuccess?: () => void } = {};
                Promise.resolve().then(() => { request.result = [...map.values()]; request.onsuccess?.(); });
                return request;
              },
              openCursor(_range?: unknown, direction?: string) { return cursorRequest(map, direction); },
            };
          },
        };
      },
    };
  }
  return {
    api: {
      open(_name: string, _version?: number) {
        const request: { result?: unknown; onupgradeneeded?: () => void; onsuccess?: () => void } = {};
        Promise.resolve().then(() => {
          request.result = database();
          // 真实 IndexedDB 只在建库或升版本时触发；这里只在 store 缺失时模拟。
          if (!stores.has('entries')) request.onupgradeneeded?.();
          request.onsuccess?.();
        });
        return request;
      },
    },
    entries(): Record<string, unknown>[] { return [...stores.values()].flatMap(map => [...map.values()]); },
  };
}

test('console and global errors retain stack, cause, state and original console output', async () => {
  const f = client(); await settle();
  f.collector.setSnapshot(() => ({ map: 'shadow-forest-east', health: 12 }));
  const circular: { self?: unknown } = {}; circular.self = circular;
  const error = new Error('strike failed', { cause: new Error('missing frame') });
  f.sandbox.console.error(error, circular);
  f.windowEvents.emit('error', { target: vm.runInContext('window', f.context), message: 'strike failed', filename: 'world-combat.ts', lineno: 20, colno: 8, error });
  f.windowEvents.emit('unhandledrejection', { reason: error });
  await settle();
  assert.deepEqual(f.originals, [[error, circular]]);
  const records = await f.entries();
  assert.deepEqual(records.slice(-3).map(entry => entry.kind), ['console-error', 'window-error', 'unhandled-rejection']);
  const args = records.at(-3)!.details.args as { message: string; stack: string; cause: { message: string }; self: string }[];
  assert.equal(args[0].message, 'strike failed'); assert.match(args[0].stack, /strike failed/);
  assert.equal(args[0].cause.message, 'missing frame'); assert.equal(args[1].self, '[Circular]');
  assert.deepEqual(records.at(-1)!.state, { map: 'shadow-forest-east', health: 12 });
});

test('resource errors and WebGL loss are captured independently of the frame loop', async () => {
  const f = client(); await settle();
  f.windowEvents.emit('error', { target: { tagName: 'IMG', src: '/soldier.png' } });
  f.documentEvents.emit('webglcontextlost', { statusMessage: 'context lost' });
  await settle();
  const records = await f.entries();
  assert.equal(records.at(-2)!.kind, 'resource-error');
  assert.equal(records.at(-2)!.details.url, '/soldier.png');
  assert.equal(records.at(-1)!.kind, 'webgl-context-lost');
});

test('failed upload persists across reload and is only removed after server acknowledgement', async () => {
  const f = client(); await settle(); f.online(false);
  f.collector.record('window-error', { message: 'offline strike' }); await settle();
  f.runTimers();
  const saved = f.storage.get('inotia4.diagnostics.pending.v1')!;
  assert.match(saved, /offline strike/);
  const next = client(f.storage); await settle();
  await next.collector.flush(); await settle();
  assert(next.sent.some(batch => batch.entries.some(entry => entry.details.message === 'offline strike')));
  next.runTimers();
  assert.equal(next.storage.get('inotia4.diagnostics.pending.v1'), '[]');
});

test('the native bridge acknowledges records without a fetch round trip', async () => {
  const reports: string[] = [];
  const f = client(new Map(), false, { native: true, onNativeReport: (_body, id) => reports.push(id) });
  await settle();
  assert.equal(f.sent.length, 0, '原生桥可用时不再走 fetch');
  assert.equal(reports.length, 1, '启动记录立即交给原生桥');
  assert.equal((await f.pending()).length, 1);
  f.nativeResult(reports[0]!, true);
  await settle();
  assert.equal((await f.pending()).length, 0, '原生桥确认后才删除待发记录');
});

test('a rejected native report keeps the record pending', async () => {
  const reports: string[] = [];
  const f = client(new Map(), false, { native: true, onNativeReport: (_body, id) => reports.push(id) });
  await settle();
  f.nativeResult(reports[0]!, false);
  await settle();
  assert.equal((await f.pending()).length, 1);
});

test('an offline shell placeholder response never discards pending records', async () => {
  const f = client(new Map(), false, { hostname: 'appassets.androidplatform.net' });
  await settle();
  assert.ok((await f.pending()).length > 0, '本地 asset loader 的 204 只是占位响应');
});

test('indexeddb journal survives reload and reports an unfinished session', async () => {
  const fake = fakeIndexedDB();
  const first = client(new Map(), false, { indexedDB: fake.api }); await settle();
  first.online(false);
  first.collector.record('window-error', { message: 'idb offline strike' });
  await settle();
  await first.collector.flush();
  assert(fake.entries().some(entry => (entry.details as { message?: string }).message === 'idb offline strike'));

  const second = client(new Map(), false, { indexedDB: fake.api }); await settle();
  await second.collector.flush(); await settle();
  assert(second.sent.some(batch => batch.entries.some(entry =>
    (entry.details as { message?: string }).message === 'idb offline strike')));
  assert(second.sent.some(batch => batch.entries.some(entry => entry.kind === 'session-recovered')));
  await settle();
  assert(!fake.entries().some(entry =>
    (entry.details as { message?: string }).message === 'idb offline strike'));
});

test('legacy pending entries migrate into the indexeddb journal', async () => {
  const legacyEntry = { id: 'old:1', session: 'old', seq: 1, kind: 'window-error',
    time: '2026-01-01T00:00:00.000Z', details: { message: 'legacy error' } };
  const storage = new Map([['inotia4.diagnostics.pending.v1', JSON.stringify([legacyEntry])]]);
  const fake = fakeIndexedDB();
  const f = client(storage, false, { indexedDB: fake.api }); await settle();
  await f.collector.flush(); await settle();
  assert(f.sent.some(batch => batch.entries.some(entry =>
    (entry.details as { message?: string }).message === 'legacy error')));
  assert.equal(storage.get('inotia4.diagnostics.pending.v1'), undefined);
});

test('server rejections drop poison records instead of blocking later uploads', async () => {
  let status = 413;
  const f = client(new Map(), false, { fetchStatus: () => status }); await settle();
  f.collector.record('window-error', { message: 'too large' });
  await settle();
  for (let index = 0; index < 4; index += 1) { await f.collector.flush(); await settle(); }
  assert(!(await f.pending()).some(entry => entry.details.message === 'too large'));
  status = 204;
  f.collector.record('window-error', { message: 'after drop' });
  await settle();
  for (let index = 0; index < 3; index += 1) { await f.collector.flush(); await settle(); }
  assert(f.sent.some(batch => batch.entries.some(entry => entry.details.message === 'after drop')));
});

test('repeated 400 responses isolate and drop the offending batch', async () => {
  let status = 400;
  const f = client(new Map(), false, { fetchStatus: () => status }); await settle();
  f.collector.record('custom-a', { label: 'a' }, false);
  f.collector.record('custom-b', { label: 'b' }, false);
  await settle();
  for (let index = 0; index < 15; index += 1) { f.advance(61_000); await f.collector.flush(); await settle(); }
  status = 204;
  f.collector.record('custom-c', { label: 'c' }, false);
  await settle();
  for (let index = 0; index < 3; index += 1) { await f.collector.flush(); await settle(); }
  assert(f.sent.some(batch => batch.entries.some(entry => entry.kind === 'custom-c')));
});

test('an oversized pending record cannot block the upload queue', async () => {
  const huge = { id: 'old:huge', session: 'old', seq: 1, kind: 'combat-tick', time: '2026-01-01T00:00:00.000Z',
    details: { args: Array.from({ length: 20 }, () => '中'.repeat(2000)) } };
  const small = { id: 'old:small', session: 'old', seq: 2, kind: 'combat-tick', time: '2026-01-01T00:00:01.000Z',
    details: { message: 'after huge' } };
  const storage = new Map([['inotia4.diagnostics.pending.v1', JSON.stringify([huge, small])]]);
  const f = client(storage); await settle();
  for (let index = 0; index < 3; index += 1) { await f.collector.flush(); await settle(); }
  assert(f.sent.some(batch => batch.entries.some(entry => entry.details.message === 'after huge')));
});

test('fallback records stay uploadable while indexeddb is available', async () => {
  const fake = fakeIndexedDB({ failAdds: true });
  const f = client(new Map(), false, { indexedDB: fake.api }); await settle();
  f.collector.record('combat-tick', { enemies: 1 });
  await settle();
  for (let index = 0; index < 4; index += 1) { await f.collector.flush(); await settle(); }
  assert(f.sent.some(batch => batch.entries.some(entry => entry.kind === 'combat-tick')));
  assert(!(await f.pending()).some(entry => entry.kind === 'combat-tick'));
  const tick = f.sent.flatMap(batch => batch.entries).find(entry => entry.kind === 'combat-tick');
  assert.equal(tick?.state, undefined, '非错误记录默认不附完整快照');
});

test('trimming the fallback queue keeps records that are being uploaded', async () => {
  const fake = fakeIndexedDB({ failAdds: true });
  const reports: string[] = [];
  const f = client(new Map(), false, { indexedDB: fake.api, native: true,
    onNativeReport: (_body, id) => reports.push(id) });
  await settle();
  assert.equal(reports.length, 1, '启动记录正在等待原生确认');
  for (let index = 0; index < 210; index += 1) f.collector.record('custom', { index }, false);
  await settle();
  assert((await f.pending()).some(entry => entry.kind === 'session-start'), '在途记录没有被裁剪删除');
});

test('pagehide keeps a synchronous session-end copy', async () => {
  const storage = new Map<string, string>();
  const fake = fakeIndexedDB();
  const f = client(storage, false, { indexedDB: fake.api }); await settle();
  f.windowEvents.emit('pagehide');
  const fatal = JSON.parse(storage.get('inotia4.diagnostics.fatal.v1') || '[]') as Entry[];
  assert(fatal.some(entry => entry.kind === 'session-end'));
});

test('batch budgets count UTF-8 bytes rather than characters', async () => {
  const f = client(new Map(), false, { fetchStatus: () => 204 }); await settle();
  for (let index = 0; index < 20; index += 1) {
    f.sandbox.console.error(`${index}${'中'.repeat(2000)}`);
  }
  await settle();
  for (let index = 0; index < 10; index += 1) { await f.collector.flush(); await settle(); }
  assert(f.sent.length >= 2, '中文记录应按字节拆成多批');
  for (const batch of f.sent) {
    const bytes = Buffer.byteLength(JSON.stringify({ version: 1, entries: batch.entries }), 'utf8');
    assert(bytes <= 64 * 1024, `batch bytes=${bytes}`);
  }
});

test('broken storage, circular state and throwing getters cannot prevent console output', async () => {
  const f = client(new Map(), true); await settle();
  const state: { self?: unknown } = {}; state.self = state;
  f.collector.setSnapshot(() => state);
  const hostile = Object.defineProperty({}, 'bad', { enumerable: true, get() { throw Error('getter'); } });
  assert.doesNotThrow(() => f.sandbox.console.error(hostile));
  await settle();
  assert.equal(f.originals.length, 1);
  assert.deepEqual((await f.entries()).at(-1)!.state, { self: '[Circular]' });
  assert.deepEqual((await f.entries()).at(-1)!.details.args, [{ bad: '[Unreadable]' }]);
  f.collector.setSnapshot(() => { throw Error('snapshot failed'); });
  assert.doesNotThrow(() => f.collector.record('test', {}, true));
  await settle();
  assert.match(JSON.stringify((await f.entries()).at(-1)!.state), /snapshot failed/);
});

test('reinstalling the script leaves a single console interceptor and folds repeated errors', async () => {
  const f = client(); await settle(); f.online(false);
  vm.runInContext(source, f.context);
  for (let i = 0; i < 45; i++) f.sandbox.console.error('x'.repeat(50000));
  await settle();
  assert.equal(f.originals.length, 45);
  const first = await f.entries();
  assert.equal(first.filter(entry => entry.kind === 'console-error').length, 1, '同一窗口内同一条错误只留一条');
  f.advance(5000);
  f.sandbox.console.error('x'.repeat(50000));
  await settle();
  const second = await f.entries();
  const errors = second.filter(entry => entry.kind === 'console-error');
  assert.equal(errors.length, 2);
  assert.equal(errors.at(-1)!.repeats, 44, '被压掉的次数记在下一条上');
  assert(second.every(entry => JSON.stringify(entry).length <= 12000));
  f.runTimers();
  assert.equal((JSON.parse(f.storage.get('inotia4.diagnostics.pending.v1')!) as unknown[]).length, second.length);
});

test('diagnostic snapshot attaches state without hooking engine frames', async () => {
  const f = client(); await settle();
  globalThis.storyDiagnostics = f.collector;
  try {
    const clear = installDiagnosticSnapshot(() => ({ map: 'forest' }));
    f.collector.record('test', {}, true);
    await settle();
    assert.deepEqual((await f.entries()).at(-1)!.state, { map: 'forest' });
    clear();
    f.collector.record('test', {}, true);
    await settle();
    assert.equal((await f.entries()).at(-1)!.state, null);
  } finally {
    globalThis.storyDiagnostics = undefined;
  }
});

test('frame stats report delivered frames, long frames and reset after idle gaps', () => {
  const stats = new FrameStats();
  let now = 0;
  for (let index = 0; index < 70; index += 1) { now += 16.7; stats.frame(now); }
  const busy = stats.snapshot();
  assert.equal(busy.frames, 70);
  assert(busy.fps >= 50 && busy.fps <= 60, `fps=${busy.fps}`);
  assert(busy.p95FrameMs >= 16 && busy.p95FrameMs <= 17, `p95=${busy.p95FrameMs}`);
  assert.equal(busy.longFrames, 0);
  now += 120; stats.frame(now);
  assert.equal(stats.snapshot().longFrames, 1);
  const beforeIdle = stats.snapshot().frames;
  now += 3000; stats.frame(now);
  const afterIdle = stats.snapshot();
  assert.equal(afterIdle.frames, beforeIdle + 1);
  assert.equal(afterIdle.samples, 0, '长空档后的第一帧不参与统计');
});

function request(middleware: Middleware, body: string, method = 'POST', url = '/__diagnostics/report') {
  return new Promise<number>(resolve => {
    const req = Object.assign(new EventEmitter(), { method, url, headers: {} as Record<string, string> });
    let status = 200;
    const res = { writableEnded: false, setHeader() {}, writeHead(value: number) { status = value; },
      end() { this.writableEnded = true; resolve(status); } };
    middleware(req, res, () => resolve(404));
    req.emit('data', Buffer.from(body)); req.emit('end');
  });
}
test('server acknowledges only stored records, rejects invalid payloads and preserves unrelated routes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'inotia-diagnostics-'));
  try {
    const middleware = createDiagnosticMiddleware(root);
    assert.equal(await request(middleware, '{'), 400);
    assert.equal(await request(middleware, 'x'.repeat(70000)), 413);
    assert.equal(await request(middleware, '{}', 'GET'), 405);
    assert.equal(await request(middleware, '{}', 'GET', '/content/battle.json'), 404);
    const body = (id: string) => JSON.stringify({ version: 1, entries: [{ id, kind: 'window-error', time: 'now', details: { message: 'strike failed' } }] });
    assert.deepEqual(await Promise.all([request(middleware, body('a')), request(middleware, body('b'))]), [204, 204]);
    const text = await readFile(path.join(root, '.diagnostics/client-errors.jsonl'), 'utf8');
    const records = text.trim().split('\n').map(line => JSON.parse(line) as { id: string; receivedAt: string });
    assert.deepEqual(records.map(record => record.id), ['a', 'b']);
    assert(records.every(record => Number.isFinite(Date.parse(record.receivedAt))));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('server splits session records, accepts batches and drops duplicate ids', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'inotia-diagnostics-'));
  try {
    const middleware = createDiagnosticMiddleware(root);
    const entries = Array.from({ length: 20 }, (_, index) => ({
      id: `session-${index}`, kind: index === 0 ? 'window-error' : 'combat-tick',
      time: 'now', details: { index },
    }));
    assert.equal(await request(middleware, JSON.stringify({ version: 1, entries })), 204);
    assert.equal(await request(middleware, JSON.stringify({ version: 1, entries })), 204);
    const errors = await readFile(path.join(root, '.diagnostics/client-errors.jsonl'), 'utf8');
    const session = await readFile(path.join(root, '.diagnostics/client-session.jsonl'), 'utf8');
    assert.equal(errors.trim().split('\n').length, 1);
    assert.equal(session.trim().split('\n').length, 19, '第二次上报的重复 id 被丢弃');
    assert.equal(await request(middleware, JSON.stringify({ version: 1, entries: [...entries, { id: 'x', kind: 'y', time: 'now' }] })), 400);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a failed write does not mark the id as delivered', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'inotia-diagnostics-'));
  try {
    const blocker = path.join(root, '.diagnostics');
    await writeFile(blocker, 'not a directory');
    const middleware = createDiagnosticMiddleware(root);
    const body = JSON.stringify({ version: 1, entries: [{ id: 'retry:1', kind: 'window-error', time: 'now' }] });
    assert.equal(await request(middleware, body), 500);
    await rm(blocker, { force: true });
    assert.equal(await request(middleware, body), 204, '写盘失败后重试仍应被接收');
    const text = await readFile(path.join(root, '.diagnostics', 'client-errors.jsonl'), 'utf8');
    assert.match(text, /retry:1/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('resource phases stay in the skip summary until actual input release', () => {
  const director: Pick<import('../src/domain/story-director.ts').StoryDirector, 'onSkipProgress'> = {};
  const records: object[] = []; let now = 0;
  installStorySkipDiagnostics(director, (_kind, details) => records.push(details), () => now);
  director.onSkipProgress!('requested');
  now = 10; director.onSkipProgress!('assets-start');
  now = 20; director.onSkipProgress!('assets-ready');
  now = 25; director.onSkipProgress!('outfit-ready');
  assert.equal(records.length, 0);
  now = 30; director.onSkipProgress!('released');
  assert.deepEqual(records, [{ outcome: 'released', logicMs: null, worldReadyMs: null, unlockedMs: 30, elapsedMs: 30,
    stages: { 'assets-start': 10, 'assets-ready': 20, 'outfit-ready': 25 } }]);
});

test('skip diagnostics report logical completion, world readiness and actual unlock once', () => {
  const director: Pick<import('../src/domain/story-director.ts').StoryDirector, 'onSkipProgress'> = {};
  const records: { kind: string; details: object }[] = []; let now = 100;
  installStorySkipDiagnostics(director, (kind, details) => records.push({ kind, details }), () => now);
  director.onSkipProgress!('requested'); now = 110; director.onSkipProgress!('requested');
  now = 120; director.onSkipProgress!('logic-complete'); now = 150; director.onSkipProgress!('world-ready');
  assert.equal(records.length, 0); now = 160; director.onSkipProgress!('released'); director.onSkipProgress!('released');
  assert.deepEqual(records, [{ kind: 'story-skip-summary', details: { outcome: 'released', logicMs: 20, worldReadyMs: 50, unlockedMs: 60, elapsedMs: 60 } }]);
  now = 200; director.onSkipProgress!('requested'); now = 210; director.onSkipProgress!('logic-complete');
  now = 230; director.onSkipProgress!('world-ready'); director.onSkipProgress!('choice');
  now = 900; director.onSkipProgress!('released');
  assert.equal(records.length, 2); assert.deepEqual(records[1].details, { outcome: 'choice', logicMs: 10, worldReadyMs: 30, unlockedMs: null, elapsedMs: 30 });
  director.onSkipProgress!('requested'); director.onSkipProgress!('cancelled'); now = 905; director.onSkipProgress!('released');
  assert.deepEqual(records[2].details, { outcome: 'cancelled', logicMs: null, worldReadyMs: null, unlockedMs: 5, elapsedMs: 5 });
});

import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const source = await readFile(new URL('../public/diagnostics.js', import.meta.url), 'utf8');
const { installDiagnosticSnapshot, installStorySkipDiagnostics } = await import('../src/application/game-diagnostics.ts');
const middlewareUrl = new URL('../tools/diagnostic-collector.mjs', import.meta.url).href;
type Middleware = (req: EventEmitter & { url: string; method: string }, res: {
  setHeader(key: string, value: string): void; writeHead(status: number): void; end(): void; writableEnded: boolean;
}, next: () => void) => void;
const { createDiagnosticMiddleware } = await import(middlewareUrl) as { createDiagnosticMiddleware(root: string): Middleware };
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

interface Entry { id: string; kind: string; details: Record<string, unknown>; state: unknown }
interface Collector {
  record(kind: string, details: unknown): void; flush(): Promise<void>;
  setSnapshot(provider: () => unknown): void;
  export(): string;
}
function client(storage = new Map<string, string>(), brokenStorage = false,
  options: { native?: boolean; hostname?: string; onNativeReport?: (body: string, id: string) => void } = {}) {
  const windowEvents = new EventEmitter(), documentEvents = new EventEmitter();
  const sent: { entries: Entry[] }[] = [], originals: unknown[][] = [], intervals: (() => void)[] = [];
  const timeouts: { id: number; callback: () => void }[] = [];
  let now = 1000, nextTimeout = 1, online = true;
  class Clock extends Date { static override now() { return now; } }
  const document = { currentScript: { src: 'http://localhost:4002/diagnostics.js' }, visibilityState: 'visible',
    addEventListener: (event: string, callback: (...args: unknown[]) => void) => documentEvents.on(event, callback) };
  const sandbox = {
    document, console: { error: (...args: unknown[]) => originals.push(args) },
    location: { pathname: '/', hostname: options.hostname }, navigator: { userAgent: 'test mobile' },
    innerWidth: 800, innerHeight: 400, devicePixelRatio: 2, URL, AbortController, Date: Clock,
    localStorage: { getItem: (key: string) => { if (brokenStorage) throw Error('disabled'); return storage.get(key) ?? null; },
      setItem: (key: string, value: string) => { if (brokenStorage) throw Error('disabled'); storage.set(key, value); } },
    addEventListener: (event: string, callback: (...args: unknown[]) => void) => windowEvents.on(event, callback),
    setInterval: (callback: () => void) => { intervals.push(callback); return intervals.length; },
    // 落盘改成 2 秒防抖后，测试自己决定什么时候让定时器到期。
    setTimeout: (callback: () => void) => { const id = nextTimeout++; timeouts.push({ id, callback }); return id; },
    clearTimeout: (id: number) => { const index = timeouts.findIndex(timer => timer.id === id);
      if (index >= 0) timeouts.splice(index, 1); },
    fetch: async (_url: string, request: { body: string }) => {
      if (!online) throw Error('offline'); sent.push(JSON.parse(request.body)); return { ok: true };
    },
    InotiaNative: options.native ? { report: (body: string, id: string) => options.onNativeReport?.(body, id) } : undefined,
    storyDiagnostics: undefined as Collector | undefined,
    window: undefined as unknown
  };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(source, context);
  const collector = sandbox.storyDiagnostics!;
  const entries = () => (JSON.parse(collector.export()) as { entries: Entry[] }).entries;
  return { sandbox, context, collector, sent, entries, originals, windowEvents, documentEvents, document, storage,
    pending: () => (JSON.parse(collector.export()) as { pending: Entry[] }).pending,
    nativeResult: (id: string, ok: boolean) =>
      (sandbox as unknown as { __inoitaNativeReportResult?: (id: string, ok: boolean) => void })
        .__inoitaNativeReportResult?.(id, ok),
    online(value: boolean) { online = value; },
    advance(ms: number) { now += ms; for (const timer of intervals) timer(); },
    runTimers() { for (const timer of timeouts.splice(0)) timer.callback(); } };
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
  const records = f.entries();
  assert.deepEqual(records.slice(-3).map(entry => entry.kind), ['console-error', 'window-error', 'unhandled-rejection']);
  const args = records.at(-3)!.details.args as { message: string; stack: string; cause: { message: string }; self: string }[];
  assert.equal(args[0].message, 'strike failed'); assert.match(args[0].stack, /strike failed/);
  assert.equal(args[0].cause.message, 'missing frame'); assert.equal(args[1].self, '[Circular]');
  assert.deepEqual(records.at(-1)!.state, { map: 'shadow-forest-east', health: 12 });
});

test('resource errors and WebGL loss are captured independently of the frame loop', () => {
  const f = client();
  f.windowEvents.emit('error', { target: { tagName: 'IMG', src: '/soldier.png' } });
  f.documentEvents.emit('webglcontextlost', { statusMessage: 'context lost' });
  assert.equal(f.entries().at(-2)!.kind, 'resource-error');
  assert.equal(f.entries().at(-2)!.details.url, '/soldier.png');
  assert.equal(f.entries().at(-1)!.kind, 'webgl-context-lost');
});

test('failed upload persists across reload and is only removed after server acknowledgement', async () => {
  const f = client(); await settle(); f.online(false);
  f.collector.record('window-error', { message: 'offline strike' }); await settle();
  f.runTimers();
  const saved = f.storage.get('inotia4.diagnostics.pending.v1')!;
  assert.match(saved, /offline strike/);
  const next = client(f.storage); await settle();
  assert.equal(next.sent[0].entries[0].id, f.entries().at(-1)!.id);
  await next.collector.flush(); await settle();
  next.runTimers();
  assert.equal(next.storage.get('inotia4.diagnostics.pending.v1'), '[]');
});

test('the native bridge acknowledges records without a fetch round trip', async () => {
  const reports: string[] = [];
  const f = client(new Map(), false, { native: true, onNativeReport: (_body, id) => reports.push(id) });
  await settle();
  assert.equal(f.sent.length, 0, '原生桥可用时不再走 fetch');
  assert.equal(reports.length, 1, '启动记录立即交给原生桥');
  assert.equal(f.pending().length, 1);
  f.nativeResult(reports[0]!, true);
  await settle();
  assert.equal(f.pending().length, 0, '原生桥确认后才删除待发记录');
});

test('a rejected native report keeps the record pending', async () => {
  const reports: string[] = [];
  const f = client(new Map(), false, { native: true, onNativeReport: (_body, id) => reports.push(id) });
  await settle();
  f.nativeResult(reports[0]!, false);
  await settle();
  assert.equal(f.pending().length, 1);
});

test('an offline shell placeholder response never discards pending records', async () => {
  const f = client(new Map(), false, { hostname: 'appassets.androidplatform.net' });
  await settle();
  assert.ok(f.pending().length > 0, '本地 asset loader 的 204 只是占位响应');
});

test('broken storage, circular state and throwing getters cannot prevent console output', () => {
  const f = client(new Map(), true);
  const state: { self?: unknown } = {}; state.self = state;
  f.collector.setSnapshot(() => state);
  const hostile = Object.defineProperty({}, 'bad', { enumerable: true, get() { throw Error('getter'); } });
  assert.doesNotThrow(() => f.sandbox.console.error(hostile));
  assert.equal(f.originals.length, 1);
  assert.deepEqual(f.entries().at(-1)!.state, { self: '[Circular]' });
  assert.deepEqual(f.entries().at(-1)!.details.args, [{ bad: '[Unreadable]' }]);
  f.collector.setSnapshot(() => { throw Error('snapshot failed'); });
  assert.doesNotThrow(() => f.collector.record('test', {}));
  assert.match(JSON.stringify(f.entries().at(-1)!.state), /snapshot failed/);
});

test('reinstalling the script leaves a single console interceptor and bounds records', async () => {
  const f = client(); await settle(); f.online(false);
  vm.runInContext(source, f.context);
  for (let i = 0; i < 45; i++) f.sandbox.console.error('x'.repeat(50000));
  assert.equal(f.originals.length, 45); assert.equal(f.entries().length, 32);
  assert(f.entries().every(entry => JSON.stringify(entry).length <= 12000));
  f.runTimers();
  assert.equal((JSON.parse(f.storage.get('inotia4.diagnostics.pending.v1')!) as unknown[]).length, 32);
});

test('diagnostic snapshot attaches state without hooking engine frames', () => {
  const f = client();
  globalThis.storyDiagnostics = f.collector;
  try {
    const clear = installDiagnosticSnapshot(() => ({ map: 'forest' }));
    f.collector.record('test', {});
    assert.deepEqual(f.entries().at(-1)!.state, { map: 'forest' });
    clear();
    f.collector.record('test', {});
    assert.equal(f.entries().at(-1)!.state, null);
  } finally {
    globalThis.storyDiagnostics = undefined;
  }
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

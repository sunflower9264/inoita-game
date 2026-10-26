import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { registerHooks } from 'node:module';
import type Phaser from 'phaser';

const source = await readFile(new URL('../public/diagnostics.js', import.meta.url), 'utf8');
const hooks = registerHooks({ resolve(specifier, context, next) {
  return specifier === 'phaser' ? { shortCircuit: true, url: 'data:text/javascript,export default {Core:{Events:{PRE_STEP:"prestep",POST_STEP:"poststep",POST_RENDER:"postrender",DESTROY:"destroy"}}}' } : next(specifier, context);
} });
const { installGameDiagnostics } = await import('../src/application/game-diagnostics.ts');
hooks.deregister();
const middlewareUrl = new URL('../tools/diagnostic-collector.mjs', import.meta.url).href;
type Middleware = (req: EventEmitter & { url: string; method: string }, res: {
  setHeader(key: string, value: string): void; writeHead(status: number): void; end(): void; writableEnded: boolean;
}, next: () => void) => void;
const { createDiagnosticMiddleware } = await import(middlewareUrl) as { createDiagnosticMiddleware(root: string): Middleware };
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

interface Entry { id: string; kind: string; details: Record<string, unknown>; state: unknown; frame: { phase: string } }
interface Collector {
  record(kind: string, details: unknown): void; flush(): Promise<void>;
  setSnapshot(provider: () => unknown): void; markFrame(phase: string): void; stopFrames(): void;
  export(): string;
}
function client(storage = new Map<string, string>(), brokenStorage = false,
  options: { native?: boolean; hostname?: string; search?: string; onNativeReport?: (body: string, id: string) => void } = {}) {
  const windowEvents = new EventEmitter(), documentEvents = new EventEmitter();
  const sent: { entries: Entry[] }[] = [], originals: unknown[][] = [], intervals: (() => void)[] = [];
  let now = 1000, online = true;
  class Clock extends Date { static override now() { return now; } }
  const document = { currentScript: { src: 'http://localhost:4002/diagnostics.js' }, visibilityState: 'visible',
    addEventListener: (event: string, callback: (...args: unknown[]) => void) => documentEvents.on(event, callback) };
  const sandbox = {
    document, console: { error: (...args: unknown[]) => originals.push(args) },
    location: { pathname: '/', hostname: options.hostname, search: options.search ?? '' }, navigator: { userAgent: 'test mobile' },
    innerWidth: 800, innerHeight: 400, devicePixelRatio: 2, URL, AbortController, Date: Clock,
    localStorage: { getItem: (key: string) => { if (brokenStorage) throw Error('disabled'); return storage.get(key) ?? null; },
      setItem: (key: string, value: string) => { if (brokenStorage) throw Error('disabled'); storage.set(key, value); } },
    addEventListener: (event: string, callback: (...args: unknown[]) => void) => windowEvents.on(event, callback),
    setInterval: (callback: () => void) => { intervals.push(callback); return intervals.length; },
    setTimeout: () => 1, clearTimeout: () => {},
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
    advance(ms: number) { now += ms; for (const timer of intervals) timer(); } };
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
  const saved = f.storage.get('inotia4.diagnostics.pending.v1')!;
  assert.match(saved, /offline strike/);
  const next = client(f.storage); await settle();
  assert.equal(next.sent[0].entries[0].id, f.entries().at(-1)!.id);
  await next.collector.flush(); await settle();
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

test('stopped game frames report once per gap and ignore background time', () => {
  const f = client(); f.collector.markFrame('update'); f.advance(6000);
  assert.equal(f.entries().at(-1)!.kind, 'frame-stalled');
  assert.equal(f.entries().at(-1)!.frame.phase, 'update');
  const count = f.entries().length; f.advance(6000); assert.equal(f.entries().length, count);
  f.collector.markFrame('idle'); f.document.visibilityState = 'hidden';
  f.documentEvents.emit('visibilitychange'); f.advance(20000); assert.equal(f.entries().length, count);
  f.document.visibilityState = 'visible'; f.documentEvents.emit('visibilitychange');
  f.advance(2000); assert.equal(f.entries().length, count);
  f.advance(4000); assert.equal(f.entries().length, count + 1);
  f.collector.stopFrames(); f.advance(10000); assert.equal(f.entries().length, count + 1);
});

test('?perf records low-frequency frame stats while normal play stays untouched', () => {
  const frame = (f: ReturnType<typeof client>) => {
    f.collector.markFrame('update'); f.advance(4);
    f.collector.markFrame('render'); f.advance(8);
    f.collector.markFrame('idle'); f.advance(4);
  };
  const perf = client(new Map(), false, { search: '?perf' });
  for (let index = 0; index < 30; index++) frame(perf);
  perf.advance(30000);
  const stats = perf.entries().find(entry => entry.kind === 'frame-stats');
  assert.ok(stats, '满 30 秒记录一次窗口统计');
  assert.deepEqual(stats.details, {
    frames: 30, p50Ms: 12, p95Ms: 12, maxMs: 12, updateP95Ms: 4, renderP95Ms: 8,
    long50Ms: 0, long100Ms: 0, dpr: 2, build: null
  });
  assert.equal(perf.entries().filter(entry => entry.kind === 'frame-stats').length, 1, '不按帧上报');

  const plain = client();
  for (let index = 0; index < 30; index++) frame(plain);
  plain.advance(30000);
  assert.equal(plain.entries().some(entry => entry.kind === 'frame-stats'), false, '没带 ?perf 不采样');
});

test('?perf drops the window around background/stop and ignores out-of-order phases', () => {
  const perf = client(new Map(), false, { search: '?perf' });
  for (let index = 0; index < 10; index++) {
    perf.collector.markFrame('update'); perf.advance(4);
    perf.collector.markFrame('render'); perf.advance(8);
    perf.collector.markFrame('idle'); perf.advance(4);
  }
  perf.advance(10000);
  perf.document.visibilityState = 'hidden'; perf.documentEvents.emit('visibilitychange');
  perf.advance(30000);
  assert.equal(perf.entries().some(entry => entry.kind === 'frame-stats'), false, '后台期间不上报旧窗口');
  perf.document.visibilityState = 'visible'; perf.documentEvents.emit('visibilitychange');
  perf.advance(10000);
  assert.equal(perf.entries().some(entry => entry.kind === 'frame-stats'), false, '回前台后重新累计 30 秒');
  // render/idle 缺少 update 时不能写入负数或超大 update/render 样本。
  perf.collector.markFrame('render'); perf.advance(5); perf.collector.markFrame('idle');
  perf.advance(30000);
  assert.equal(perf.entries().some(entry => entry.kind === 'frame-stats'), false, '没有完整帧就不上报');
  perf.collector.markFrame('update'); perf.advance(4);
  perf.collector.markFrame('render'); perf.advance(8);
  perf.collector.markFrame('idle'); perf.advance(4);
  perf.advance(30000);
  const stats = perf.entries().find(entry => entry.kind === 'frame-stats');
  assert.ok(stats);
  assert.equal(stats.details.frames, 1, '只有顺序完整的帧才进窗口');
  perf.collector.stopFrames();
  perf.advance(40000);
  assert.equal(perf.entries().filter(entry => entry.kind === 'frame-stats').length, 1, 'stop 后清空窗口');
});

test('reinstalling the script leaves a single console interceptor and bounds records', async () => {
  const f = client(); await settle(); f.online(false);
  vm.runInContext(source, f.context);
  for (let i = 0; i < 45; i++) f.sandbox.console.error('x'.repeat(50000));
  assert.equal(f.originals.length, 45); assert.equal(f.entries().length, 32);
  assert(f.entries().every(entry => JSON.stringify(entry).length <= 12000));
  assert.equal((JSON.parse(f.storage.get('inotia4.diagnostics.pending.v1')!) as unknown[]).length, 32);
});

test('engine event observers do not replace updates and are removed on destroy', () => {
  const f = client(), events = new EventEmitter();
  globalThis.storyDiagnostics = f.collector;
  try {
    installGameDiagnostics({ events } as unknown as Phaser.Game, () => ({ map: 'forest' }));
    events.emit('prestep'); f.collector.record('test', {});
    assert.equal(f.entries().at(-1)!.frame.phase, 'update');
    events.emit('poststep'); f.collector.record('test', {});
    assert.equal(f.entries().at(-1)!.frame.phase, 'render');
    events.emit('postrender'); f.collector.record('test', {});
    assert.equal(f.entries().at(-1)!.frame.phase, 'idle');
    events.emit('destroy'); assert.equal(events.listenerCount('prestep'), 0);
    assert.equal(events.listenerCount('poststep'), 0); assert.equal(events.listenerCount('postrender'), 0);
    f.advance(8000); assert.equal(f.entries().at(-1)!.kind, 'test');
  } finally { globalThis.storyDiagnostics = undefined; }
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

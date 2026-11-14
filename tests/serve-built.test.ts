import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { createGameServer, parseRange } from '../tools/serve-built.ts';
import { sha256Hex } from '../tools/update-manifest.ts';

interface Response { status: number; headers: http.IncomingHttpHeaders; body: Buffer }
interface RequestOptions { method?: string; headers?: Record<string, string>; body?: string }

function request(port: number, urlPath: string, options: RequestOptions = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: options.method ?? 'GET', headers: options.headers ?? {} },
      response => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }));
      });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'story-serve-built-'));
  const dist = path.join(root, 'dist');
  await mkdir(path.join(dist, 'bundles'), { recursive: true });
  await mkdir(path.join(dist, 'content'), { recursive: true });
  await mkdir(path.join(dist, 'assets', 'audio'), { recursive: true });
  await writeFile(path.join(dist, 'index.html'), '<!doctype html><link rel="icon" href="./assets/a.png"><script type="module" src="./bundles/app-abc.js"></script>');
  await writeFile(path.join(dist, 'bundles', 'app-abc.js'), 'console.log("x");\n'.repeat(300));
  await writeFile(path.join(dist, 'content', 'x.json'), JSON.stringify({ padding: 'x'.repeat(4096) }));
  await writeFile(path.join(dist, 'assets', 'a.png'), Buffer.from([137, 80, 78, 71]));
  await writeFile(path.join(dist, 'assets', 'audio', 'test.mp3'), Buffer.alloc(2048, 7));
  const meta = { schema: 1 as const, builtAt: '2026-10-22T00:00:00.000Z', assetVersion: 'asset123', contentVersion: 'content456' };
  await writeFile(path.join(dist, '.build-meta.json'), JSON.stringify(meta));

  const updateBuildId = '0123456789abcdef';
  const updateManifest = JSON.stringify({
    schema: 1,
    buildId: updateBuildId,
    assetVersion: 'asset123',
    contentVersion: 'content456',
    files: [{ p: 'index.html', h: 'a'.repeat(16), s: 1285 }, { p: 'padding.txt', h: 'b'.repeat(16), s: 4096 }],
    padding: 'x'.repeat(2048),
  });
  const updateManifestSha = sha256Hex(Buffer.from(updateManifest));
  const updatePointer = JSON.stringify({
    schema: 1, buildId: updateBuildId, builtAt: '2026-11-01T00:00:00.000Z',
    manifest: `update/${updateBuildId}.json`, manifestSha256: updateManifestSha, minShell: 1,
  });
  await mkdir(path.join(dist, 'update'), { recursive: true });
  await writeFile(path.join(dist, 'update', updateBuildId + '.json'), updateManifest);
  await writeFile(path.join(dist, 'update', updateBuildId + '.json.sig'), 'c2ln');
  for (const name of ['latest.json', 'latest-staging.json']) {
    await writeFile(path.join(dist, 'update', name), updatePointer);
    await writeFile(path.join(dist, 'update', name + '.sig'), 'c2ln');
  }
  await writeFile(path.join(dist, 'update', 'other.json'), '{}');
  let clock = 1_000_000;
  const server = createGameServer({ projectRoot: root, distDir: dist, now: () => clock });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as { port: number }).port;
  return {
    root, dist, meta, port, server, updateBuildId, updateManifest, updateManifestSha,
    advance(ms: number) { clock += ms; },
    async close() {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('serves index with no-cache and supports conditional requests', async () => {
  const f = await fixture();
  try {
    const first = await request(f.port, '/');
    assert.equal(first.status, 200);
    assert.match(String(first.headers['content-type']), /text\/html/);
    assert.equal(first.headers['cache-control'], 'no-cache');
    assert.ok(first.headers.etag);
    const again = await request(f.port, '/', { headers: { 'if-none-match': String(first.headers.etag) } });
    assert.equal(again.status, 304);
    assert.equal(again.body.length, 0);
  } finally { await f.close(); }
});

test('cache policy only trusts the current version', async () => {
  const f = await fixture();
  try {
    const bundle = await request(f.port, '/bundles/app-abc.js');
    assert.match(String(bundle.headers['cache-control']), /immutable/);
    const current = await request(f.port, '/assets/a.png?v=asset123');
    assert.match(String(current.headers['cache-control']), /immutable/);
    const stale = await request(f.port, '/assets/a.png?v=old');
    assert.equal(stale.headers['cache-control'], 'no-cache');
    const missing = await request(f.port, '/assets/a.png');
    assert.equal(missing.headers['cache-control'], 'no-cache');
    const content = await request(f.port, '/content/x.json?v=content456');
    assert.match(String(content.headers['cache-control']), /immutable/);
    const wrong = await request(f.port, '/content/x.json?v=asset123');
    assert.equal(wrong.headers['cache-control'], 'no-cache');
  } finally { await f.close(); }
});

test('update pointers are never cached and manifests are immutable', async () => {
  const f = await fixture();
  try {
    for (const pointer of ['latest.json', 'latest-staging.json']) {
      const file = await request(f.port, `/update/${pointer}`);
      assert.equal(file.headers['cache-control'], 'no-store');
      const signature = await request(f.port, `/update/${pointer}.sig`);
      assert.equal(signature.headers['cache-control'], 'no-store');
    }
    const manifest = await request(f.port, `/update/${f.updateBuildId}.json`);
    assert.match(String(manifest.headers['cache-control']), /max-age=31536000, immutable/);
    const signature = await request(f.port, `/update/${f.updateBuildId}.json.sig`);
    assert.match(String(signature.headers['cache-control']), /max-age=31536000, immutable/);
    const other = await request(f.port, '/update/other.json');
    assert.equal(other.headers['cache-control'], 'no-cache');
  } finally { await f.close(); }
});

test('update manifest keeps signed bytes through gzip and identity', async () => {
  const f = await fixture();
  try {
    const compressed = await request(f.port, `/update/${f.updateBuildId}.json`, { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(compressed.headers['content-encoding'], 'gzip');
    assert.equal(sha256Hex(gunzipSync(compressed.body)), f.updateManifestSha);

    const identity = await request(f.port, `/update/${f.updateBuildId}.json`, { headers: { 'accept-encoding': 'identity' } });
    assert.equal(identity.headers['content-encoding'], undefined);
    assert.equal(sha256Hex(identity.body), f.updateManifestSha);
    assert.equal(identity.body.toString(), f.updateManifest);
  } finally { await f.close(); }
});

test('gzip, HEAD and Range keep bytes and headers correct', async () => {
  const f = await fixture();
  try {
    const gz = await request(f.port, '/content/x.json', { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.match(String(gz.headers.vary), /Accept-Encoding/);
    assert.equal(JSON.parse(gunzipSync(gz.body).toString()).padding.length, 4096);
    const refused = await request(f.port, '/content/x.json', { headers: { 'accept-encoding': 'gzip;q=0' } });
    assert.equal(refused.headers['content-encoding'], undefined);

    const head = await request(f.port, '/assets/audio/test.mp3', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0);
    assert.equal(Number(head.headers['content-length']), 2048);
    assert.equal(head.headers['accept-ranges'], 'bytes');
    assert.equal(head.headers['content-type'], 'audio/mpeg');

    const ranged = await request(f.port, '/assets/audio/test.mp3', { headers: { range: 'bytes=0-9' } });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.body.length, 10);
    assert.equal(ranged.headers['content-range'], 'bytes 0-9/2048');
    const suffix = await request(f.port, '/assets/audio/test.mp3', { headers: { range: 'bytes=-5' } });
    assert.equal(suffix.body.length, 5);
    const invalid = await request(f.port, '/assets/audio/test.mp3', { headers: { range: 'bytes=99999-' } });
    assert.equal(invalid.status, 416);
    assert.equal(invalid.headers['content-range'], 'bytes */2048');
    const multiple = await request(f.port, '/assets/audio/test.mp3', { headers: { range: 'bytes=0-1,3-4' } });
    assert.equal(multiple.status, 200);
    assert.equal(multiple.body.length, 2048);
  } finally { await f.close(); }
});

test('rejects traversal, dotfiles and unsupported methods', async () => {
  const f = await fixture();
  try {
    assert.equal((await request(f.port, '/%2e%2e/package.json')).status, 404);
    assert.equal((await request(f.port, '/..%2fpackage.json')).status, 404);
    assert.equal((await request(f.port, '/.build-meta.json')).status, 404);
    assert.equal((await request(f.port, '/missing.png')).status, 404);
    const post = await request(f.port, '/index.html', { method: 'POST' });
    assert.equal(post.status, 405);
    assert.equal(post.headers.allow, 'GET, HEAD');
    assert.equal(post.headers['cache-control'], 'no-store');
  } finally { await f.close(); }
});

test('exposes build metadata and reports missing builds', async () => {
  const f = await fixture();
  try {
    const build = await request(f.port, '/__build');
    assert.equal(build.status, 200);
    assert.equal(build.headers['cache-control'], 'no-store');
    const value = JSON.parse(build.body.toString());
    assert.deepEqual(value.meta, f.meta);
    await unlink(path.join(f.dist, '.build-meta.json'));
    f.advance(1000);
    const missing = await request(f.port, '/__build');
    assert.equal(missing.status, 503);
    const index = await request(f.port, '/');
    assert.equal(index.status, 200, '缺少 meta 不影响静态页面');
  } finally { await f.close(); }
});

test('receives diagnostics reports into the project log', async () => {
  const f = await fixture();
  try {
    const payload = JSON.stringify({ version: 1, entries: [{ id: 'test:1', kind: 'manual', time: '2026-10-22T00:00:00Z' }] });
    const posted = await request(f.port, '/__diagnostics/report', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: payload,
    });
    assert.equal(posted.status, 204);
    // 非错误记录进会话流；错误流只有 isErrorEntry 命中的记录。
    const log = await readFile(path.join(f.root, '.diagnostics', 'client-session.jsonl'), 'utf8');
    assert.match(log, /"id":"test:1"/);
    const get = await request(f.port, '/__diagnostics/report');
    assert.equal(get.status, 405);
    const bad = await request(f.port, '/__diagnostics/report', { method: 'POST', body: '{}' });
    assert.equal(bad.status, 400);
  } finally { await f.close(); }
});

test('parseRange handles single, suffix and multi ranges', () => {
  assert.deepEqual(parseRange('bytes=0-9', 100), { start: 0, end: 9 });
  assert.deepEqual(parseRange('bytes=10-', 100), { start: 10, end: 99 });
  assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.equal(parseRange('bytes=100-', 100), 'invalid');
  assert.equal(parseRange('bytes=0-1,3-4', 100), 'multiple');
  assert.equal(parseRange(undefined, 100), undefined);
});

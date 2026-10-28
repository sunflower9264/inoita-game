import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { createDiagnosticMiddleware } from './diagnostic-collector.mjs';
import { BUILD_META_FILENAME, type BuildMeta } from './build-version.ts';

const gzipAsync = promisify(gzip);
const META_CACHE_MS = 250;
const COMPRESSION_LIMIT = 32 * 1024 * 1024;
const COMPRESSION_MIN_BYTES = 1024;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

export function mimeType(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

function compressible(type: string): boolean {
  return /^(?:text\/|application\/(?:json|manifest\+json)|image\/svg\+xml)/.test(type);
}

/** 解析 Accept-Encoding，正确处理 `gzip;q=0` 与逗号列表。 */
export function acceptsGzip(header: string | undefined): boolean {
  if (!header) return false;
  for (const part of header.split(',')) {
    const [name, ...parameters] = part.trim().toLowerCase().split(';');
    if (name !== 'gzip' && name !== '*') continue;
    const q = parameters.find(value => value.trim().startsWith('q='));
    if (!q || Number.parseFloat(q.split('=')[1]?.trim() ?? '1') > 0) return true;
  }
  return false;
}

export function cachePolicyFor(pathname: string, search: URLSearchParams, meta: BuildMeta | undefined): string {
  if (pathname.startsWith('/bundles/')) return 'public, max-age=31536000, immutable';
  if (meta && pathname.startsWith('/assets/') && search.get('v') === meta.assetVersion)
    return 'public, max-age=31536000, immutable';
  if (meta && pathname.startsWith('/content/') && search.get('v') === meta.contentVersion)
    return 'public, max-age=31536000, immutable';
  return 'no-cache';
}

export interface ByteRange { start: number; end: number }
export type RangeResult = ByteRange | 'invalid' | 'multiple' | undefined;

/** 单段 Range；多段返回 multiple（调用方退化为 200 全量），不可满足返回 invalid。 */
export function parseRange(header: string | undefined, size: number): RangeResult {
  if (!header) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return 'multiple';
  if (match[1] === '' && match[2] === '') return 'invalid';
  if (match[1] === '') {
    const length = Number(match[2]);
    if (!Number.isSafeInteger(length) || length <= 0) return 'invalid';
    return { start: Math.max(0, size - length), end: size - 1 };
  }
  const start = Number(match[1]);
  if (!Number.isSafeInteger(start) || start < 0 || start >= size) return 'invalid';
  const end = match[2] === '' ? size - 1 : Number(match[2]);
  if (!Number.isSafeInteger(end) || end < start) return 'invalid';
  return { start, end: Math.min(end, size - 1) };
}

interface ParsedPath { segments: string[]; pathname: string }

/** 逐段解码并拒绝点文件、父目录和编码后的分隔符。 */
function parseRequestPath(pathname: string): ParsedPath | undefined {
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); } catch { return undefined; }
  if (decoded.includes('\0')) return undefined;
  const segments = decoded.split('/').filter(segment => segment !== '');
  for (const segment of segments)
    if (segment === '.' || segment === '..' || segment.startsWith('.') || /[\\/]/.test(segment)) return undefined;
  return { segments, pathname: decoded };
}

interface FileInfo {
  size: number; mtimeMs: number; ino: bigint; mtimeNs: bigint;
}

function etagOf(file: FileInfo): string {
  return `"${file.size.toString(16)}-${file.ino.toString(16)}-${file.mtimeNs.toString(16)}"`;
}

function matchesEtag(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header.split(',').some(value => {
    const trimmed = value.trim();
    return trimmed === '*' || trimmed.replace(/^W\//, '') === etag;
  });
}

function notModifiedSince(header: string | undefined, mtimeMs: number): boolean {
  if (!header) return false;
  const time = Date.parse(header);
  return Number.isFinite(time) && Math.floor(mtimeMs / 1000) * 1000 <= time;
}

interface CompressionEntry { key: string; buffer: Buffer }

export interface GameServerOptions {
  projectRoot: string;
  distDir?: string;
  now?: () => number;
}

export function createGameServer(options: GameServerOptions): Server {
  const projectRoot = path.resolve(options.projectRoot);
  const distDir = path.resolve(options.distDir ?? path.join(projectRoot, 'dist'));
  const now = options.now ?? Date.now;
  const startedAt = now();
  const diagnostic = createDiagnosticMiddleware(projectRoot);
  const compressed = new Map<string, CompressionEntry>();
  let compressedBytes = 0;
  let metaCache: { at: number; meta: BuildMeta | undefined } | undefined;

  async function readMeta(): Promise<BuildMeta | undefined> {
    const at = now();
    if (metaCache && at - metaCache.at < META_CACHE_MS) return metaCache.meta;
    let meta: BuildMeta | undefined;
    try {
      const value = JSON.parse(await readFile(path.join(distDir, BUILD_META_FILENAME), 'utf8'));
      if (value && value.schema === 1 && typeof value.assetVersion === 'string'
        && typeof value.contentVersion === 'string' && typeof value.builtAt === 'string') meta = value;
    } catch { meta = undefined; }
    metaCache = { at, meta };
    return meta;
  }

  async function gzipped(key: string, body: Buffer): Promise<Buffer> {
    const cached = compressed.get(key);
    if (cached) return cached.buffer;
    const buffer = await gzipAsync(body);
    compressed.set(key, { key, buffer });
    compressedBytes += buffer.length;
    while (compressedBytes > COMPRESSION_LIMIT && compressed.size > 1) {
      const oldest = compressed.keys().next().value;
      if (oldest === undefined) break;
      const entry = compressed.get(oldest);
      compressed.delete(oldest);
      if (entry) compressedBytes -= entry.buffer.length;
    }
    return buffer;
  }

  function sendError(res: ServerResponse, status: number, message: string, retryAfter?: number): void {
    if (res.headersSent) { res.destroy(); return; }
    const headers: Record<string, string | number> = {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': Buffer.byteLength(message),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    };
    if (retryAfter !== undefined) headers['Retry-After'] = String(retryAfter);
    res.writeHead(status, headers);
    res.end(message);
  }

  async function fileInfo(file: string): Promise<FileInfo | undefined> {
    try {
      const info = await stat(file, { bigint: true });
      if (!info.isFile()) return undefined;
      return {
        size: Number(info.size), mtimeMs: Number(info.mtimeMs),
        ino: info.ino, mtimeNs: info.mtimeNs ?? BigInt(Math.trunc(Number(info.mtimeMs) * 1e6)),
      };
    } catch { return undefined; }
  }

  async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      sendError(res, 405, 'Method Not Allowed');
      return;
    }
    let requestUrl: URL;
    try { requestUrl = new URL(req.url ?? '/', 'http://localhost'); }
    catch { sendError(res, 400, 'Bad Request'); return; }
    const parsed = parseRequestPath(requestUrl.pathname);
    if (!parsed) { sendError(res, 404, 'Not Found'); return; }
    const relative = parsed.segments.length ? parsed.segments.join('/') : 'index.html';
    const resolved = path.resolve(distDir, relative);
    if (resolved !== distDir && !resolved.startsWith(distDir + path.sep)) { sendError(res, 404, 'Not Found'); return; }
    const isIndex = relative === 'index.html';
    // 构建替换 dist 的极短窗口：先确认 dist 在，重试一次；仍不在则 503，避免缓存成 404。
    try { await stat(distDir); }
    catch {
      await new Promise(resolve => setTimeout(resolve, 75));
      try { await stat(distDir); }
      catch { sendError(res, 503, 'Build is being replaced', 1); return; }
    }
    let real: string;
    try { real = await realpath(resolved); }
    catch {
      if (!isIndex) { sendError(res, 404, 'Not Found'); return; }
      await new Promise(resolve => setTimeout(resolve, 75));
      try { real = await realpath(resolved); }
      catch { sendError(res, 503, 'Build is being replaced', 1); return; }
    }
    if (!real.startsWith(distDir + path.sep) && real !== distDir) { sendError(res, 404, 'Not Found'); return; }
    let info = await fileInfo(real);
    if (!info && isIndex) {
      await new Promise(resolve => setTimeout(resolve, 75));
      info = await fileInfo(real);
    }
    if (!info) {
      if (isIndex) sendError(res, 503, 'Build is being replaced', 1);
      else sendError(res, 404, 'Not Found');
      return;
    }

    const type = mimeType(real);
    const etag = etagOf(info);
    const cacheControl = cachePolicyFor(requestUrl.pathname, requestUrl.searchParams, await readMeta());
    const headers: Record<string, string | number> = {
      'Content-Type': type,
      'Cache-Control': cacheControl,
      'Accept-Ranges': 'bytes',
      'X-Content-Type-Options': 'nosniff',
    };
    if (cacheControl === 'no-cache') {
      headers.ETag = etag;
      headers['Last-Modified'] = new Date(info.mtimeMs).toUTCString();
    }
    if (compressible(type)) headers.Vary = 'Accept-Encoding';

    if (cacheControl === 'no-cache'
      && (matchesEtag(req.headers['if-none-match'], etag)
        || (!req.headers['if-none-match'] && notModifiedSince(req.headers['if-modified-since'], info.mtimeMs)))) {
      res.writeHead(304, headers);
      res.end();
      return;
    }

    const rangeHeader = typeof req.headers.range === 'string' ? req.headers.range : undefined;
    const ifRange = typeof req.headers['if-range'] === 'string' ? req.headers['if-range'] : undefined;
    const rangeAllowed = !ifRange || ifRange.replace(/^W\//, '') === etag;
    const range = rangeAllowed ? parseRange(rangeHeader, info.size) : undefined;
    if (range === 'invalid') {
      headers['Content-Range'] = `bytes */${info.size}`;
      res.writeHead(416, headers);
      res.end();
      return;
    }
    const selected = range && range !== 'multiple' ? range : undefined;
    if (selected) {
      headers['Content-Range'] = `bytes ${selected.start}-${selected.end}/${info.size}`;
      headers['Content-Length'] = selected.end - selected.start + 1;
      res.writeHead(206, headers);
      if (req.method === 'HEAD') { res.end(); return; }
      createReadStream(real, { start: selected.start, end: selected.end })
        .on('error', () => res.destroy()).pipe(res);
      return;
    }

    if (compressible(type) && info.size >= COMPRESSION_MIN_BYTES && acceptsGzip(req.headers['accept-encoding'])) {
      const body = await readFile(real);
      const buffer = await gzipped(`${real}:${info.ino}:${info.size}:${info.mtimeNs}`, body);
      headers['Content-Encoding'] = 'gzip';
      headers['Content-Length'] = buffer.length;
      res.writeHead(200, headers);
      if (req.method === 'HEAD') res.end(); else res.end(buffer);
      return;
    }

    headers['Content-Length'] = info.size;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') { res.end(); return; }
    createReadStream(real).on('error', () => res.destroy()).pipe(res);
  }

  const server = createServer((req, res) => {
    let url: URL;
    try { url = new URL(req.url ?? '/', 'http://localhost'); }
    catch { sendError(res, 400, 'Bad Request'); return; }
    if (url.pathname === '/__build') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('Allow', 'GET, HEAD');
        sendError(res, 405, 'Method Not Allowed');
        return;
      }
      void readMeta().then(meta => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        if (!meta) {
          res.writeHead(503);
          res.end(JSON.stringify({ ok: false, error: 'build-meta-missing' }));
          return;
        }
        res.writeHead(200);
        res.end(JSON.stringify({
          ok: true, meta, pid: process.pid, startedAt,
          uptimeSeconds: Math.max(0, Math.round((now() - startedAt) / 1000)),
        }));
      }).catch(() => sendError(res, 500, 'Internal Server Error'));
      return;
    }
    diagnostic(req, res, () => { void serveStatic(req, res); });
  });
  server.on('clientError', (_error, socket) => { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); });
  return server;
}

export interface StartedServer { server: Server; port: number }

export async function startGameServer(options: GameServerOptions & { port?: number; host?: string }): Promise<StartedServer> {
  const server = createGameServer(options);
  const port = options.port ?? 4004;
  const host = options.host ?? '127.0.0.1';
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return { server, port };
}

function cliOptions(argv: string[]): { port: number; host: string } {
  let port = 4004, host = '127.0.0.1';
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (value === '--port') port = Number(argv[++index]);
    else if (value.startsWith('--port=')) port = Number(value.slice('--port='.length));
    else if (value === '--host') host = argv[++index] ?? host;
    else if (value.startsWith('--host=')) host = value.slice('--host='.length);
  }
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error(`端口无效：${port}`);
  return { port, host };
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (invoked) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { port, host } = cliOptions(process.argv.slice(2));
  startGameServer({ projectRoot: root, port, host }).then(({ server }) => {
    console.log(`Built game: http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/`);
    const stop = () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(1), 5000).unref(); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
  }).catch(error => {
    console.error(`打包服务启动失败：${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}

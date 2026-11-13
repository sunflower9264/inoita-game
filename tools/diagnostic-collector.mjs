import fs from 'node:fs/promises';
import path from 'node:path';

/** 保留的旧日志份数；当前文件 + 一份 previous + 这些编号文件。 */
const MAX_OLDER_LOGS = 6;
/** 旧客户端在每个逻辑帧都报同一条检查点诊断；同一个会话在同一张图 60 秒内只留一条。 */
const NOISY_KIND = 'checkpoint-kept-waiting-encounter';
const NOISY_WINDOW_MS = 60_000;
const lastNoisyAt = new Map();

/** 单个诊断日志文件达到 2 MiB 就轮转。 */
const LOG_FILE_LIMIT_BYTES = 2 * 1024 * 1024;
/** 诊断上报请求体上限 64 KiB。 */
const REPORT_BODY_LIMIT_BYTES = 64 * 1024;
/** 上报协议版本、单次最多条数和单条 JSON 最大长度。 */
const REPORT_SCHEMA_VERSION = 1;
const MAX_REPORT_ENTRIES = 3;
const MAX_ENTRY_JSON_LENGTH = 12_000;
/** 去重表最多保留的键数；超过后清掉窗口 5 倍以前的记录。 */
const NOISY_KEY_LIMIT = 512;
const NOISY_RETENTION_MULTIPLIER = 5;
/** 预检请求结果缓存一天。 */
const CORS_PREFLIGHT_MAX_AGE_SECONDS = 24 * 60 * 60;

function withoutRepeatedNoise(entries) {
  const now = Date.now();
  const kept = [];
  for (const entry of entries) {
    if (entry.kind !== NOISY_KIND) { kept.push(entry); continue; }
    const mapId = typeof entry.details?.map === 'string' ? entry.details.map : '';
    const key = `${entry.session ?? ''}\u0000${mapId}`;
    const last = lastNoisyAt.get(key) ?? 0;
    if (now - last < NOISY_WINDOW_MS) continue;
    lastNoisyAt.set(key, now);
    kept.push(entry);
  }
  if (lastNoisyAt.size > NOISY_KEY_LIMIT) {
    for (const [key, at] of lastNoisyAt) if (now - at > NOISY_WINDOW_MS * NOISY_RETENTION_MULTIPLIER) lastNoisyAt.delete(key);
  }
  return kept;
}

/** 开发服务与 4002 打包静态服务共用。JSONL 每行一条记录，并保留多份轮转文件。 */
export function createDiagnosticMiddleware(root) {
  const directory = path.join(root, '.diagnostics');
  const file = path.join(directory, 'client-errors.jsonl');
  const previous = path.join(directory, 'client-errors.previous.jsonl');
  const older = index => path.join(directory, `client-errors.previous-${index}.jsonl`);
  let writes = Promise.resolve();
  async function moveIfExists(from, to) {
    try { await fs.rename(from, to); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  async function rotate() {
    for (let index = MAX_OLDER_LOGS; index >= 2; index -= 1) await moveIfExists(older(index - 1), older(index));
    await moveIfExists(previous, older(1));
    await fs.rename(file, previous);
  }
  async function save(entries) {
    await fs.mkdir(directory, { recursive: true });
    let size = 0;
    try { size = (await fs.stat(file)).size; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const receivedAt = new Date().toISOString();
    const text = entries.map(entry => JSON.stringify({ receivedAt, ...entry }) + '\n').join('');
    if (size + Buffer.byteLength(text) > LOG_FILE_LIMIT_BYTES) await rotate();
    await fs.appendFile(file, text, 'utf8');
  }
  return function diagnostics(req, res, next) {
    if (req.url?.split('?')[0] !== '/__diagnostics/report') { next(); return; }
    res.setHeader('Cache-Control', 'no-store');
    // 离线 APK 的页面源是 WebView 的本地 HTTPS 域，上报跨到本服务，需要放行这一来源。
    const origin = req.headers.origin;
    const allowedOrigin = origin === 'https://appassets.androidplatform.net'
      || origin === 'http://appassets.androidplatform.net';
    if (allowedOrigin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      if (!allowedOrigin) { res.writeHead(403); res.end(); return; }
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', String(CORS_PREFLIGHT_MAX_AGE_SECONDS));
      res.writeHead(204); res.end(); return;
    }
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); res.writeHead(405); res.end(); return; }
    let bytes = 0, oversized = false;
    const chunks = [];
    req.on('data', chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > REPORT_BODY_LIMIT_BYTES) {
        if (!oversized) { oversized = true; chunks.length = 0; res.writeHead(413); res.end(); }
      } else if (!oversized) chunks.push(chunk);
    });
    req.on('error', () => { if (!res.writableEnded) { res.writeHead(400); res.end(); } });
    req.on('end', () => {
      if (oversized) return;
      let entries;
      try {
        const report = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        entries = report.entries;
        if (report.version !== REPORT_SCHEMA_VERSION || !Array.isArray(entries) || !entries.length
          || entries.length > MAX_REPORT_ENTRIES
          || entries.some(entry => !entry || typeof entry.id !== 'string' || typeof entry.kind !== 'string'
            || typeof entry.time !== 'string' || JSON.stringify(entry).length > MAX_ENTRY_JSON_LENGTH)) throw new Error('Invalid report');
      } catch { res.writeHead(400); res.end(); return; }
      const kept = withoutRepeatedNoise(entries);
      if (!kept.length) { res.writeHead(204); res.end(); return; }
      const write = writes.then(() => save(kept));
      writes = write.catch(() => {});
      void write.then(() => { res.writeHead(204); res.end(); }, () => { res.writeHead(500); res.end(); });
    });
  };
}

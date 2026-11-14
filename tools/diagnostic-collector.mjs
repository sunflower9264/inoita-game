import fs from 'node:fs/promises';
import path from 'node:path';

/** 当前文件 + 一份 previous + 这些编号文件。 */
const MAX_OLDER_LOGS = 6;
/** 旧客户端在每个逻辑帧都报同一条检查点诊断；同一个会话在同一张图 60 秒内只留一条。 */
const NOISY_KIND = 'checkpoint-kept-waiting-encounter';
const NOISY_WINDOW_MS = 60_000;
const lastNoisyAt = new Map();

/** 错误流保留较小，运行日志更大；两者各自轮转，互不挤占。 */
const STREAMS = {
  errors: { file: 'client-errors.jsonl', limitBytes: 2 * 1024 * 1024, older: MAX_OLDER_LOGS },
  session: { file: 'client-session.jsonl', limitBytes: 8 * 1024 * 1024, older: 9 },
};
/** 诊断上报请求体上限 64 KiB。 */
const REPORT_BODY_LIMIT_BYTES = 64 * 1024;
/** 上报协议版本、单次最多条数和单条 JSON 最大字节数。 */
const REPORT_SCHEMA_VERSION = 1;
const MAX_REPORT_ENTRIES = 20;
/** 按编码后的字节算；中文错误文本一个字符占 3 字节。 */
const MAX_ENTRY_JSON_LENGTH = 40_000;
/** 去重表最多保留的键数；超过后清掉最早的一批。 */
const SEEN_ID_LIMIT = 20_000;
/** 预检请求结果缓存一天。 */
const CORS_PREFLIGHT_MAX_AGE_SECONDS = 24 * 60 * 60;

/** 错误、警告和恢复记录进错误流，其余运行事件进会话流。 */
export function isErrorEntry(entry) {
  const kind = typeof entry?.kind === 'string' ? entry.kind : '';
  return kind === 'console-warn' || kind === 'webgl-context-lost' || kind === 'session-recovered'
    || kind === 'unhandled-rejection' || kind === 'world-failure' || kind === 'content-load-error'
    || kind.endsWith('-error') || kind.endsWith('-failed') || kind.endsWith('-failure');
}

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
  if (lastNoisyAt.size > 512) {
    for (const [key, at] of lastNoisyAt) if (now - at > NOISY_WINDOW_MS * 5) lastNoisyAt.delete(key);
  }
  return kept;
}

function createLogStream(directory, file, limitBytes, olderCount) {
  const current = path.join(directory, file);
  const previous = path.join(directory, file.replace('.jsonl', '.previous.jsonl'));
  const older = index => path.join(directory, file.replace('.jsonl', `.previous-${index}.jsonl`));
  let writes = Promise.resolve();
  async function moveIfExists(from, to) {
    try { await fs.rename(from, to); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  async function rotate() {
    for (let index = olderCount; index >= 2; index -= 1) await moveIfExists(older(index - 1), older(index));
    await moveIfExists(previous, older(1));
    await moveIfExists(current, previous);
  }
  async function save(entries) {
    await fs.mkdir(directory, { recursive: true });
    let size = 0;
    try { size = (await fs.stat(current)).size; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const receivedAt = new Date().toISOString();
    const text = entries.map(entry => JSON.stringify({ receivedAt, ...entry }) + '\n').join('');
    if (size + Buffer.byteLength(text) > limitBytes) await rotate();
    await fs.appendFile(current, text, 'utf8');
  }
  return {
    write(entries) {
      const write = writes.then(() => save(entries));
      writes = write.catch(() => {});
      return write;
    },
  };
}

/** 开发服务与 4002 打包静态服务共用。JSONL 每行一条记录，并按错误/会话分流。 */
export function createDiagnosticMiddleware(root) {
  const directory = path.join(root, '.diagnostics');
  const streams = {
    errors: createLogStream(directory, STREAMS.errors.file, STREAMS.errors.limitBytes, STREAMS.errors.older),
    session: createLogStream(directory, STREAMS.session.file, STREAMS.session.limitBytes, STREAMS.session.older),
  };
  /** 重试可能造成重复 id；写盘成功后才记账，写失败让客户端重试时仍能通过。 */
  const seenIds = new Set();
  const seenOrder = [];
  function remember(id) {
    if (seenIds.has(id)) return;
    seenIds.add(id);
    seenOrder.push(id);
    if (seenOrder.length > SEEN_ID_LIMIT) {
      const drop = seenOrder.splice(0, Math.floor(SEEN_ID_LIMIT / 4));
      for (const key of drop) seenIds.delete(key);
    }
  }
  function split(entries) {
    const errors = [], session = [];
    for (const entry of entries) (isErrorEntry(entry) ? errors : session).push(entry);
    return { errors, session };
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
            || typeof entry.time !== 'string' || Buffer.byteLength(JSON.stringify(entry)) > MAX_ENTRY_JSON_LENGTH)) throw new Error('Invalid report');
      } catch { res.writeHead(400); res.end(); return; }
      const fresh = entries.filter(entry => !seenIds.has(entry.id));
      const kept = withoutRepeatedNoise(fresh);
      if (!kept.length) { res.writeHead(204); res.end(); return; }
      const splitEntries = split(kept);
      const pending = [];
      if (splitEntries.errors.length) pending.push(streams.errors.write(splitEntries.errors));
      if (splitEntries.session.length) pending.push(streams.session.write(splitEntries.session));
      void Promise.all(pending).then(
        () => { for (const entry of kept) remember(entry.id); res.writeHead(204); res.end(); },
        () => { if (!res.writableEnded) { res.writeHead(500); res.end(); } });
    });
  };
}

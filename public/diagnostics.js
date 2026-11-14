/* 在游戏模块之前安装：所有诊断先写入本地日志，再由后台协程上传。 */
(() => {
  if (window.storyDiagnostics) return;
  const SCHEMA_VERSION = 1;
  /** 本地日志数据库；IDB 不可用时退回 localStorage 队列。 */
  const DB_NAME = 'inotia4.diagnostics';
  const DB_STORE = 'entries';
  const LEGACY_KEY = 'inotia4.diagnostics.pending.v1';
  /** 致命记录先同步落一小份，进程被杀后下次启动补传。 */
  const FATAL_KEY = 'inotia4.diagnostics.fatal.v1';
  /** 页面隐藏时写入的结束标记单独存一份，不占用致命错误的两个应急槽位。 */
  const SESSION_END_KEY = 'inotia4.diagnostics.session-end.v1';
  const MAX_BATCH_ENTRIES = 20;
  /** 批量预算按编码后的字节算；服务端和 keepalive 都按字节限制。 */
  const MAX_BATCH_BYTES = 48 * 1024;
  const MAX_ENTRY_LENGTH = 12_000;
  const MAX_LOCAL_ENTRIES = 5000;
  const MAX_LOCAL_AGE_MS = 7 * 24 * 60 * 60 * 1000;
  const MAX_FALLBACK_ENTRIES = 200;
  /** 同一种错误在这个窗口内只记第一条，其余计数到下一批。 */
  const RATE_WINDOW_MS = 5_000;
  /** 错误/警告总量上限，防止每条都不同的报错风暴拖垮主线程。 */
  const RATE_TOTAL_LIMIT = 120;
  const RATE_TOTAL_WINDOW_MS = 60_000;
  /** IndexedDB 操作超时后走降级队列，避免一个卡住的事务让上报永久停住。 */
  const IDB_TIMEOUT_MS = 5_000;
  const RECENT_EXPORT_LIMIT = 200;
  const session = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  const startedAt = Date.now();
  const localEndpoint = new URL('./__diagnostics/report', document.currentScript.src).href;
  // 离线 APK 优先走原生桥：旧 WebView 不保证支持 document-start 注入，
  // 同源地址又会被 WebViewAssetLoader 用 204 占位，fetch 会误以为已经上报。
  const nativeBridge = (() => {
    try { return !!(window.InotiaNative && typeof window.InotiaNative.report === 'function'); }
    catch { return false; }
  })();
  const offlineShell = location.hostname === 'appassets.androidplatform.net';
  const endpoint = () => {
    const runtime = globalThis.__inoitaEndpoints;
    if (runtime && typeof runtime === 'object' && runtime.version === 1
      && typeof runtime.diagnosticsReport === 'string' && runtime.diagnosticsReport)
      return runtime.diagnosticsReport;
    return localEndpoint;
  };
  const build = (() => {
    try { return window.__inoitaBuild && typeof window.__inoitaBuild === 'object' ? window.__inoitaBuild : null; }
    catch { return null; }
  })();

  let sequence = 0, sending = false, capturing = false;
  let snapshot = () => null, metrics = () => null;
  const textEncoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

  /** UTF-8 字节数；没有 TextEncoder 时手算，避免把中文按字符数当成字节数。 */
  function utf8Bytes(text) {
    if (textEncoder) return textEncoder.encode(text).byteLength;
    let bytes = 0;
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      if (code < 0x80) bytes += 1;
      else if (code < 0x800) bytes += 2;
      else if (code >= 0xD800 && code <= 0xDBFF && index + 1 < text.length
        && text.charCodeAt(index + 1) >= 0xDC00 && text.charCodeAt(index + 1) <= 0xDFFF) {
        bytes += 4; index += 1;
      } else bytes += 3;
    }
    return bytes;
  }

  function withTimeout(promise, ms, fallback) {
    return new Promise(resolve => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true; resolve(fallback);
      }, ms);
      promise.then(value => {
        if (settled) return;
        settled = true; clearTimeout(timer); resolve(value);
      }, () => {
        if (settled) return;
        settled = true; clearTimeout(timer); resolve(fallback);
      });
    });
  }

  // 限制深度和长度；错误对象、循环引用和带异常 getter 的对象都能记录。
  function safe(value, depth = 0, seen = new WeakSet()) {
    try {
      if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
      if (typeof value === 'string') return value.slice(0, 2000);
      if (typeof value !== 'object') return String(value).slice(0, 2000);
      if (seen.has(value)) return '[Circular]';
      if (depth >= 6) return '[Depth limit]';
      seen.add(value);
      if (value instanceof Error || Object.prototype.toString.call(value) === '[object Error]') {
        return { name: safe(value.name), message: safe(value.message), stack: safe(value.stack),
          cause: safe(value.cause, depth + 1, seen) };
      }
      if (Array.isArray(value)) return value.slice(0, 20).map(item => safe(item, depth + 1, seen));
      const result = {};
      for (const key of Object.keys(value).slice(0, 20)) {
        try { result[key] = safe(value[key], depth + 1, seen); }
        catch { result[key] = '[Unreadable]'; }
      }
      return result;
    } catch { return '[Unserializable]'; }
  }

  function readMetrics() {
    try { return safe(metrics()); } catch (error) { return { error: safe(error) }; }
  }

  function navigationTiming() {
    try {
      const entry = performance.getEntriesByType('navigation')[0];
      if (!entry) return null;
      return { domInteractive: Math.round(entry.domInteractive), domContentLoaded: Math.round(entry.domContentLoadedEventEnd),
        loadEventEnd: Math.round(entry.loadEventEnd), transferSize: entry.transferSize, type: entry.type };
    } catch { return null; }
  }

  function environment() {
    const nav = navigator, connection = nav.connection || nav.mozConnection || nav.webkitConnection;
    const screenSize = typeof screen !== 'undefined' ? screen : null;
    const viewport = typeof visualViewport !== 'undefined' ? visualViewport : null;
    return {
      timeOrigin: typeof performance !== 'undefined' && typeof performance.timeOrigin === 'number'
        ? Math.round(performance.timeOrigin) : null,
      language: nav.language, maxTouchPoints: nav.maxTouchPoints,
      hardwareConcurrency: nav.hardwareConcurrency ?? null, deviceMemory: nav.deviceMemory ?? null,
      online: nav.onLine, connection: connection ? { effectiveType: connection.effectiveType,
        downlink: connection.downlink, rtt: connection.rtt, saveData: connection.saveData } : null,
      screen: screenSize ? { width: screenSize.width, height: screenSize.height,
        availWidth: screenSize.availWidth, availHeight: screenSize.availHeight } : null,
      orientation: screenSize?.orientation ? { type: screenSize.orientation.type, angle: screenSize.orientation.angle } : null,
      viewport: { width: innerWidth, height: innerHeight, pixelRatio: devicePixelRatio,
        scale: viewport?.scale ?? null, offsetTop: viewport?.offsetTop ?? null },
    };
  }

  /**
   * 本地日志：优先 IndexedDB；打不开时退回 localStorage 队列。
   * 上传成功后删除已确认的记录，崩溃或刷新后下次启动继续上传。
   */
  function createQueue() {
    let dbPromise;
    function openDb() {
      if (dbPromise) return dbPromise;
      dbPromise = withTimeout(new Promise(resolve => {
        try {
          if (typeof indexedDB === 'undefined') { resolve(null); return; }
          const request = indexedDB.open(DB_NAME, 1);
          request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(DB_STORE)) {
              const store = db.createObjectStore(DB_STORE, { keyPath: 'key', autoIncrement: true });
              store.createIndex('session', 'session');
              store.createIndex('time', 'time');
            }
          };
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => resolve(null);
          request.onblocked = () => resolve(null);
        } catch { resolve(null); }
      }), IDB_TIMEOUT_MS, null);
      return dbPromise;
    }
    function fallbackLoad() {
      try {
        const saved = JSON.parse(localStorage.getItem(LEGACY_KEY) || '[]');
        return Array.isArray(saved) ? saved.filter(item => item && typeof item.id === 'string') : [];
      } catch { return []; }
    }
    let fallback = fallbackLoad();
    function fallbackSave() {
      try { localStorage.setItem(LEGACY_KEY, JSON.stringify(fallback)); } catch { /* 手机可能禁用存储。 */ }
    }
    let fallbackTimer = 0;
    /** 降级队列的写入合并到一秒一次，避免每条事件都同步序列化整份数组。 */
    function fallbackSaveSoon() {
      if (fallbackTimer) return;
      fallbackTimer = setTimeout(() => { fallbackTimer = 0; fallbackSave(); }, 1000);
    }
    function flushFallback() {
      if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = 0; }
      fallbackSave();
    }
    /** 正在上传的批次；清理时跳过，避免把发送中的记录删掉。 */
    const inFlight = new Set();
    function idbAdd(db, entry) {
      const operation = new Promise(resolve => {
        try {
          const tx = db.transaction(DB_STORE, 'readwrite');
          tx.objectStore(DB_STORE).add(entry);
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => resolve(false);
          tx.onabort = () => resolve(false);
        } catch { resolve(false); }
      });
      return withTimeout(operation, IDB_TIMEOUT_MS, false);
    }
    function idbReadBatch(db, limit, maxBytes) {
      const operation = new Promise(resolve => {
        const out = [];
        let bytes = 0;
        if (maxBytes <= 0 || limit <= 0) { resolve(out); return; }
        try {
          const request = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).openCursor();
          request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor || out.length >= limit) { resolve(out); return; }
            const entry = cursor.value;
            const size = utf8Bytes(JSON.stringify(entry)) + 1;
            // 首条即使超预算也要放行；否则整条队列永远读不出东西。
            if (bytes + size > maxBytes && out.length) { resolve(out); return; }
            out.push(entry); bytes += size;
            cursor.continue();
          };
          request.onerror = () => resolve(out);
        } catch { resolve(out); }
      });
      return withTimeout(operation, IDB_TIMEOUT_MS, []);
    }
    return {
      inFlight,
      flushFallback,
      async ready() { await openDb(); },
      async add(entry) {
        // 单条超过批量预算时任何一批都装不下，服务端也会拒收；直接丢弃，避免堵住队列。
        if (utf8Bytes(JSON.stringify(entry)) > MAX_BATCH_BYTES) return;
        const db = await openDb();
        if (db && await idbAdd(db, entry)) return;
        fallback.push(entry);
        if (fallback.length > MAX_FALLBACK_ENTRIES) {
          // 与 prune 同一口径：正在上传、尚未确认的记录不能删，只淘汰最旧的非在途记录。
          const excess = fallback.length - MAX_FALLBACK_ENTRIES;
          const dropped = new Set();
          for (const item of fallback) {
            if (dropped.size >= excess) break;
            if (!inFlight.has(item.id)) dropped.add(item.id);
          }
          fallback = fallback.filter(item => !dropped.has(item.id));
        }
        fallbackSaveSoon();
      },
      async readBatch(limit, maxBytes) {
        const db = await openDb();
        // 运行中写 IndexedDB 失败会落到降级队列；读批次时先把它带上，不能只等下次启动迁移。
        const out = [];
        let bytes = 0;
        for (const entry of fallback) {
          const size = utf8Bytes(JSON.stringify(entry)) + 1;
          // 首条即使超预算也要放行；否则 flush 永远拿到空批，后面的记录全部积压。
          if (bytes + size > maxBytes && out.length) break;
          out.push(entry); bytes += size;
          if (out.length >= limit) break;
        }
        const remaining = maxBytes - bytes;
        if (out.length >= limit || remaining <= 0 || !db) return out;
        const idbEntries = await idbReadBatch(db, limit - out.length, remaining);
        return out.concat(idbEntries);
      },
      async remove(entries) {
        const ids = new Set(entries.map(entry => entry.id));
        const before = fallback.length;
        fallback = fallback.filter(item => !ids.has(item.id));
        if (fallback.length !== before) fallbackSave();
        const db = await openDb();
        if (!db) return;
        const keys = entries.map(entry => entry.key).filter(key => typeof key === 'number');
        if (!keys.length) return;
        try {
          const operation = new Promise(resolve => {
            const tx = db.transaction(DB_STORE, 'readwrite');
            const store = tx.objectStore(DB_STORE);
            for (const key of keys) store.delete(key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
            tx.onabort = () => resolve();
          });
          await withTimeout(operation, IDB_TIMEOUT_MS, undefined);
        } catch { /* 下次启动还会重试。 */ }
      },
      async lastOtherSession(other) {
        let fallbackCandidate = null;
        for (let index = fallback.length - 1; index >= 0; index -= 1) {
          if (fallback[index].session !== other) { fallbackCandidate = fallback[index]; break; }
        }
        const db = await openDb();
        let idbCandidate = null;
        if (db) {
          const operation = new Promise(resolve => {
            try {
              const request = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).openCursor(null, 'prev');
              request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) { resolve(null); return; }
                if (cursor.value.session !== other) { resolve(cursor.value); return; }
                cursor.continue();
              };
              request.onerror = () => resolve(null);
            } catch { resolve(null); }
          });
          idbCandidate = await withTimeout(operation, IDB_TIMEOUT_MS, null);
        }
        if (!fallbackCandidate) return idbCandidate;
        if (!idbCandidate) return fallbackCandidate;
        const fallbackAt = Date.parse(fallbackCandidate.time) || 0;
        const idbAt = Date.parse(idbCandidate.time) || 0;
        if (fallbackAt !== idbAt) return fallbackAt > idbAt ? fallbackCandidate : idbCandidate;
        return (fallbackCandidate.seq ?? 0) >= (idbCandidate.seq ?? 0) ? fallbackCandidate : idbCandidate;
      },
      async exportEntries(limit) {
        const db = await openDb();
        const idbEntries = !db ? [] : await withTimeout(new Promise(resolve => {
          try {
            const request = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => resolve([]);
          } catch { resolve([]); }
        }), IDB_TIMEOUT_MS, []);
        return [...fallback, ...idbEntries]
          .map(entry => ({ entry, at: Date.parse(entry.time) || 0, seq: entry.seq ?? 0 }))
          .sort((a, b) => a.at - b.at || a.seq - b.seq)
          .slice(-limit)
          .map(item => item.entry);
      },
      async prune() {
        if (!inFlight.size && fallback.length > MAX_FALLBACK_ENTRIES) {
          fallback = fallback.slice(-MAX_FALLBACK_ENTRIES);
          fallbackSave();
        }
        const db = await openDb();
        if (!db) return;
        const deadline = Date.now() - MAX_LOCAL_AGE_MS;
        try {
          const dbCount = await withTimeout(new Promise(resolve => {
            const request = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).count();
            request.onsuccess = () => resolve(request.result || 0); request.onerror = () => resolve(0);
          }), IDB_TIMEOUT_MS, 0);
          if (!dbCount) return;
          const surplus = Math.max(0, dbCount - MAX_LOCAL_ENTRIES);
          let seen = 0;
          const operation = new Promise(resolve => {
            const tx = db.transaction(DB_STORE, 'readwrite');
            const store = tx.objectStore(DB_STORE);
            const request = store.openCursor();
            request.onsuccess = () => {
              const cursor = request.result;
              if (!cursor) { resolve(); return; }
              if (inFlight.has(cursor.value.id)) { seen += 1; cursor.continue(); return; }
              seen += 1;
              const when = Date.parse(cursor.value.time);
              if (seen <= surplus || (Number.isFinite(when) && when < deadline)) cursor.delete();
              cursor.continue();
            };
            request.onerror = () => resolve();
            tx.oncomplete = () => resolve();
            tx.onabort = () => resolve();
          });
          await withTimeout(operation, IDB_TIMEOUT_MS, undefined);
        } catch { /* 清理失败不影响记录。 */ }
      },
      async migrate() {
        const db = await openDb();
        if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = 0; }
        const legacy = fallback.slice();
        const emergencyEntries = key => {
          try {
            const saved = JSON.parse(localStorage.getItem(key) || '[]');
            return Array.isArray(saved) ? saved.filter(entry => entry && typeof entry.id === 'string') : [];
          } catch { return []; }
        };
        const fatal = emergencyEntries(FATAL_KEY);
        const sessionEnd = emergencyEntries(SESSION_END_KEY);
        const stashed = [...fatal, ...sessionEnd];
        if (!db) {
          // 没有 IndexedDB 时应急副本也必须能补传：并入降级队列，上传成功后随 remove 清除。
          const known = new Set(fallback.map(item => item.id));
          for (const entry of stashed) if (!known.has(entry.id)) fallback.push(entry);
          if (fallback.length > MAX_FALLBACK_ENTRIES) fallback = fallback.slice(-MAX_FALLBACK_ENTRIES);
          // 先把副本落到待发队列，再清应急键，避免两步之间进程被杀导致记录消失。
          if (stashed.length) {
            fallbackSave();
            try {
              localStorage.removeItem(FATAL_KEY);
              localStorage.removeItem(SESSION_END_KEY);
            } catch { /* 存储不可用时保留。 */ }
          }
          return;
        }
        const movedIds = new Set();
        // 单个事务已经各自有 5 秒超时；整个迁移再设总时限，避免 IDB 卡死时 ready 等上几分钟。
        const deadline = Date.now() + IDB_TIMEOUT_MS * 2;
        for (const entry of [...legacy, ...stashed]) {
          if (Date.now() > deadline) break;
          const copy = { ...entry };
          delete copy.key;
          copy.recovered = true;
          if (await idbAdd(db, copy)) movedIds.add(entry.id);
        }
        if (!movedIds.size) return;
        fallback = fallback.filter(item => !movedIds.has(item.id));
        fallbackSave();
        try {
          const keep = (key, entries) => {
            const remaining = entries.filter(item => !movedIds.has(item.id));
            if (remaining.length) localStorage.setItem(key, JSON.stringify(remaining));
            else localStorage.removeItem(key);
          };
          keep(FATAL_KEY, fatal);
          keep(SESSION_END_KEY, sessionEnd);
          if (!fallback.length) localStorage.removeItem(LEGACY_KEY);
        } catch { /* 存储不可用时保留内存队列。 */ }
      },
    };
  }

  const queue = createQueue();
  const ready = (async () => {
    await queue.ready();
    await queue.migrate();
    await queue.add(buildEntry('session-start', {
      message: '诊断会话开始', navigation: navigationTiming(), environment: environment(),
    }, false));
    const previous = await queue.lastOtherSession(session);
    if (previous && previous.kind !== 'session-end') {
      await queue.add(buildEntry('session-recovered', {
        previousSession: previous.session, previousKind: previous.kind, previousTime: previous.time,
        previousSeq: previous.seq, previousSinceStartMs: previous.sinceStartMs,
      }, false));
    }
    void queue.prune();
    void flush();
  })();
  /** 定时把待发记录送出去；不依赖游戏帧循环。两秒一次，空闲时只做一次空读。 */
  setInterval(() => { void flush(); }, 2000);
  setInterval(() => { void queue.prune(); }, 10 * 60 * 1000);

  const rate = new Map();
  /** 413 后先缩到单条隔离毒记录；400 视为全局问题，保留并退避。 */
  let batchEntryLimit = MAX_BATCH_ENTRIES;
  let blockedUntil = 0;
  /** 连续被服务端以 400 拒绝的次数；到上限后隔离或丢弃，避免协议错位时永久重试。 */
  let consecutiveRejections = 0;
  /** 与 server 分流口径一致；错误类默认附完整快照，也参与全局限流。 */
  function isErrorKind(kind) {
    return kind === 'console-warn' || kind === 'webgl-context-lost' || kind === 'session-recovered'
      || kind === 'unhandled-rejection' || kind === 'world-failure' || kind === 'content-load-error'
      || kind.endsWith('-error') || kind.endsWith('-failed') || kind.endsWith('-failure');
  }
  const FATAL = new Set(['window-error', 'unhandled-rejection', 'webgl-context-lost']);
  function fingerprint(details) {
    try {
      if (details && typeof details === 'object') {
        if (typeof details.message === 'string') return details.message.split('\n')[0].slice(0, 200);
        if (details.args) return JSON.stringify(safe(details.args)).slice(0, 200);
        if (details.reason) return JSON.stringify(safe(details.reason)).slice(0, 200);
      }
      return JSON.stringify(safe(details)).slice(0, 200);
    } catch { return ''; }
  }
  let rateWindowStart = 0, rateWindowCount = 0;
  function repeatOf(kind, details) {
    if (!isErrorKind(kind)) return { limited: false, repeats: 0 };
    const now = Date.now();
    // 先卡总量：每条都不同的报错风暴也不会无限写日志。
    if (now - rateWindowStart >= RATE_TOTAL_WINDOW_MS) { rateWindowStart = now; rateWindowCount = 0; }
    rateWindowCount += 1;
    if (rateWindowCount > RATE_TOTAL_LIMIT) return { limited: true, repeats: 0 };
    const key = kind + '\u0000' + fingerprint(details);
    const last = rate.get(key);
    if (last && now - last.at < RATE_WINDOW_MS) { last.suppressed += 1; return { limited: true, repeats: 0 }; }
    const repeats = last ? last.suppressed : 0;
    rate.set(key, { at: now, suppressed: 0 });
    if (rate.size > 256) {
      for (const [candidate, entry] of rate) if (now - entry.at > RATE_WINDOW_MS * 5) rate.delete(candidate);
    }
    return { limited: false, repeats };
  }
  function buildEntry(kind, details, withState) {
    const entry = {
      id: session + ':' + (++sequence), session, seq: sequence,
      time: new Date().toISOString(),
      sinceStartMs: Math.round((nowMs()) * 10) / 10,
      kind, page: location.pathname, userAgent: navigator.userAgent,
      visibility: document.visibilityState, build,
    };
    if (withState) {
      try { entry.state = safe(snapshot()); } catch (error) { entry.state = { snapshotError: safe(error) }; }
    }
    entry.details = safe(details);
    const metricsNow = readMetrics();
    if (metricsNow != null) entry.metrics = metricsNow;
    if (withState) {
      const length = JSON.stringify(entry).length;
      if (length > MAX_ENTRY_LENGTH) {
        entry.details = { truncated: JSON.stringify(entry.details).slice(0, 4000) };
        entry.state = { truncated: JSON.stringify(entry.state).slice(0, 4000) };
      }
    }
    return entry;
  }
  function nowMs() {
    try { return performance.now(); } catch { return Date.now() - startedAt; }
  }
  function stashEmergency(key, entry) {
    try {
      const saved = JSON.parse(localStorage.getItem(key) || '[]');
      const next = Array.isArray(saved) ? saved : [];
      next.push(entry);
      localStorage.setItem(key, JSON.stringify(next.slice(-2)));
    } catch { /* 存储不可用时只能依赖 IndexedDB。 */ }
  }
  function record(kind, details, withState = isErrorKind(kind)) {
    if (capturing) return;
    capturing = true;
    try {
      const repeat = repeatOf(kind, details);
      if (repeat.limited) return;
      const entry = buildEntry(kind, details, withState);
      if (repeat.repeats) entry.repeats = repeat.repeats;
      if (FATAL.has(kind)) stashEmergency(FATAL_KEY, entry);
      void ready.then(() => queue.add(entry));
    } catch { /* 收集器不能成为新的游戏异常来源。 */ }
    finally { capturing = false; }
  }

  const nativeCallbacks = new Map();
  window.__inoitaNativeReportResult = function (id, result) {
    const callback = nativeCallbacks.get(id);
    if (!callback) return;
    nativeCallbacks.delete(id);
    // 新壳回传 HTTP 状态码；旧壳只回传布尔，按 200 / 网络失败换算，保持兼容。
    callback(result === true ? 200 : typeof result === 'number' ? result : 0);
  };
  /** 返回原生桥转发得到的 HTTP 状态码；0 表示桥不可达或超时。 */
  function sendNative(body, id) {
    return new Promise(resolve => {
      const timer = setTimeout(() => { nativeCallbacks.delete(id); resolve(0); }, 20000);
      nativeCallbacks.set(id, status => { clearTimeout(timer); resolve(status); });
      try { window.InotiaNative.report(body, id); }
      catch { clearTimeout(timer); nativeCallbacks.delete(id); resolve(0); }
    });
  }
  async function flush() {
    await ready;
    if (sending) return;
    if (Date.now() < blockedUntil) return;
    sending = true;
    let batch = [];
    try {
      batch = await queue.readBatch(nativeBridge ? 3 : batchEntryLimit, MAX_BATCH_BYTES);
      if (!batch.length) return;
      for (const entry of batch) queue.inFlight.add(entry.id);
      const entries = batch.map(entry => {
        const copy = { ...entry };
        delete copy.key;
        return copy;
      });
      const body = JSON.stringify({ version: SCHEMA_VERSION, entries });
      let status = 0;
      let ok = false;
      if (nativeBridge) {
        status = await sendNative(body, entries[0].id);
        ok = status >= 200 && status < 300;
      } else {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        try {
          const response = await fetch(endpoint(), { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body, keepalive: true, signal: controller.signal });
          status = response.status;
          ok = response.ok;
          // 离线壳的原生桥不可用时，同源地址只是 asset loader 的占位响应。
          if (ok && offlineShell && endpoint() === localEndpoint) ok = false;
        } finally { clearTimeout(timeout); }
      }
      if (ok) {
        batchEntryLimit = nativeBridge ? 3 : MAX_BATCH_ENTRIES;
        blockedUntil = 0;
        consecutiveRejections = 0;
        await queue.remove(batch);
      } else if (status === 413) {
        consecutiveRejections = 0;
        // 先缩到单条：确认是某一条太大就丢掉它，不让整条队列永久卡住。
        if (batch.length > 1) batchEntryLimit = 1;
        else {
          await queue.remove(batch);
          batchEntryLimit = nativeBridge ? 3 : MAX_BATCH_ENTRIES;
        }
      } else if (status === 400) {
        // 协议版本、代理或毒记录都会返回 400。先退避重试；连续三次后逐级隔离：
        // 多条批次缩到单条，单条仍被拒就丢弃这一条，避免整条队列永远发不出去。
        consecutiveRejections += 1;
        if (consecutiveRejections >= 3 && batch.length > 1) {
          batchEntryLimit = 1;
          consecutiveRejections = 0;
        } else if (consecutiveRejections >= 3) {
          await queue.remove(batch);
          batchEntryLimit = nativeBridge ? 3 : MAX_BATCH_ENTRIES;
          consecutiveRejections = 0;
        } else {
          blockedUntil = Date.now() + 60_000;
        }
      }
    } catch { /* 发送失败保留日志，下一轮重试。 */ }
    finally {
      for (const entry of batch) queue.inFlight.delete(entry.id);
      sending = false;
    }
  }

  function slowResources() {
    try {
      const entries = performance.getEntriesByType('resource')
        .filter(entry => entry.duration > 1000)
        .sort((a, b) => b.duration - a.duration)
        .slice(0, 8)
        .map(entry => ({ url: entry.name, duration: Math.round(entry.duration),
          transferSize: entry.transferSize, initiatorType: entry.initiatorType }));
      return entries;
    } catch { return []; }
  }
  setTimeout(() => {
    const entries = slowResources();
    if (entries.length) record('slow-resources', { entries }, false);
  }, 10_000);

  // 抓栈比较贵；用惰性字段，只有真正写入日志时才构造错误对象，被限流压掉的重复错误不付这份开销。
  const originalError = console.error;
  console.error = function (...args) {
    record('console-error', { args, get callStack() { return new Error('console.error').stack; } });
    return originalError.apply(this, args);
  };
  const originalWarn = console.warn;
  console.warn = function (...args) {
    record('console-warn', { args, get callStack() { return new Error('console.warn').stack; } });
    return originalWarn.apply(this, args);
  };
  window.addEventListener('error', event => {
    const target = event.target;
    if (target && target !== window) {
      record('resource-error', { tag: target.tagName, url: target.currentSrc || target.src || target.href },
        false);
    } else {
      record('window-error', { message: event.message, file: event.filename, line: event.lineno,
        column: event.colno, error: event.error });
    }
  }, true);
  window.addEventListener('unhandledrejection', event => record('unhandled-rejection', { reason: event.reason }));
  window.addEventListener('pagehide', () => {
    const entry = buildEntry('session-end', { durationMs: Date.now() - startedAt, sequence }, false);
    // 页面可能立刻被系统收回：结束标记同步写一份应急副本，IndexedDB 提交不保证完成。
    // 单独存一个键，避免挤掉可能还没写进 IndexedDB 的致命错误。
    stashEmergency(SESSION_END_KEY, entry);
    queue.flushFallback();
    void ready.then(async () => { await queue.add(entry); await flush(); });
  });
  document.addEventListener('visibilitychange', () => {
    record('visibility', { state: document.visibilityState }, false);
  });
  window.addEventListener('orientationchange', () => {
    const orientation = typeof screen !== 'undefined' && screen.orientation ? {
      type: screen.orientation.type, angle: screen.orientation.angle } : null;
    record('orientation', { orientation }, false);
  });
  window.addEventListener('online', () => { record('network', { online: true }, false); void flush(); });
  window.addEventListener('offline', () => record('network', { online: false }, false));
  document.addEventListener('webglcontextlost', event => record('webgl-context-lost', { status: event.statusMessage }), true);
  document.addEventListener('webglcontextrestored', () => record('webgl-context-restored', {}), true);

  window.storyDiagnostics = {
    record, flush,
    setSnapshot(provider) { snapshot = provider; },
    setMetrics(provider) { metrics = provider; },
    async export() {
      await ready;
      const entries = await queue.exportEntries(RECENT_EXPORT_LIMIT);
      return JSON.stringify({ version: SCHEMA_VERSION, session, entries }, null, 2);
    },
  };
})();

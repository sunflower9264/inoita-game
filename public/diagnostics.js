/* 在游戏模块之前安装，诊断发送不依赖 Phaser 的帧循环。 */
(() => {
  if (window.storyDiagnostics) return;
  const storageKey = 'inotia4.diagnostics.pending.v1';
  const localEndpoint = new URL('./__diagnostics/report', document.currentScript.src).href;
  // 离线 APK 优先走原生桥：旧 WebView 不保证支持 document-start 注入，
  // 同源地址又会被 WebViewAssetLoader 用 204 占位，fetch 会误以为已经上报。
  const nativeBridge = (() => {
    try { return !!(window.InotiaNative && typeof window.InotiaNative.report === 'function'); }
    catch { return false; }
  })();
  const offlineShell = location.hostname === 'appassets.androidplatform.net';
  const endpoint = () => typeof globalThis.__inoitaDiagnosticsEndpoint === 'string' && globalThis.__inoitaDiagnosticsEndpoint
    ? globalThis.__inoitaDiagnosticsEndpoint
    : localEndpoint;
  const session = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  let sequence = 0, sending = false, snapshot = () => null;
  let pending = [], recent = [], capturing = false;
  let lastFrame = 0, phase = 'boot', stalled = false, visibleSince = Date.now();
  // 帧时间只在 `?perf` 下采样：正常游玩不写数组、不发额外诊断。
  // 30 秒一窗口，最多保留约 30 秒的帧；排序只在窗口结束时做一次。
  const perfEnabled = /[?&]perf(?:=|&|$)/.test(String(location.search || ''));
  const FRAME_WINDOW = 1800, FRAME_REPORT_MS = 30000;
  const frameSamples = new Float64Array(FRAME_WINDOW), updateSamples = new Float64Array(FRAME_WINDOW), renderSamples = new Float64Array(FRAME_WINDOW);
  let frameSampleCount = 0, frameSampleCursor = 0, lastFrameReport = Date.now();
  let updateStartedAt = 0, renderStartedAt = 0;
  const buildVersion = (() => {
    try { return new URL(document.currentScript.src).searchParams.get('v'); }
    catch { return null; }
  })();
  function nowMs() {
    try { return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now(); }
    catch { return Date.now(); }
  }
  function addFrameSample(frameMs, updateMs, renderMs) {
    if (!perfEnabled || document.visibilityState !== 'visible'
      || !Number.isFinite(frameMs) || frameMs < 0
      || !Number.isFinite(updateMs) || updateMs < 0
      || !Number.isFinite(renderMs) || renderMs < 0) return;
    frameSamples[frameSampleCursor] = frameMs;
    updateSamples[frameSampleCursor] = updateMs;
    renderSamples[frameSampleCursor] = renderMs;
    frameSampleCursor = (frameSampleCursor + 1) % FRAME_WINDOW;
    if (frameSampleCount < FRAME_WINDOW) frameSampleCount++;
  }
  function sortedWindow(source) {
    const values = [];
    for (let index = 0; index < frameSampleCount; index++) values.push(source[index]);
    return values.sort((a, b) => a - b);
  }
  function percentile(values, ratio) {
    return values[Math.min(values.length - 1, Math.floor(values.length * ratio))] ?? 0;
  }
  function reportFrameStats(now) {
    if (!perfEnabled || !frameSampleCount || document.visibilityState !== 'visible' || now - lastFrameReport < FRAME_REPORT_MS) return;
    const frames = sortedWindow(frameSamples), updates = sortedWindow(updateSamples), renders = sortedWindow(renderSamples);
    lastFrameReport = now;
    const stats = {
      frames: frameSampleCount,
      p50Ms: +percentile(frames, .5).toFixed(2),
      p95Ms: +percentile(frames, .95).toFixed(2),
      maxMs: +frames[frames.length - 1].toFixed(2),
      updateP95Ms: +percentile(updates, .95).toFixed(2),
      renderP95Ms: +percentile(renders, .95).toFixed(2),
      long50Ms: frames.filter(value => value > 50).length,
      long100Ms: frames.filter(value => value > 100).length,
      dpr: typeof devicePixelRatio === 'number' ? devicePixelRatio : null,
      build: buildVersion
    };
    frameSampleCount = 0; frameSampleCursor = 0;
    record('frame-stats', stats);
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
  function persist() {
    try { localStorage.setItem(storageKey, JSON.stringify(pending)); } catch { /* 手机可能禁用存储。 */ }
  }
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || '[]');
    if (Array.isArray(saved)) pending = saved.filter(item => item && typeof item.id === 'string'
      && JSON.stringify(item).length <= 12000).slice(-32);
  } catch { /* 损坏的诊断缓存不影响游戏启动。 */ }

  const nativeCallbacks = new Map();
  window.__inoitaNativeReportResult = function (id, ok) {
    const callback = nativeCallbacks.get(id);
    if (callback) { nativeCallbacks.delete(id); callback(!!ok); }
  };
  function sendNative(body, id) {
    return new Promise(resolve => {
      const timer = setTimeout(() => { nativeCallbacks.delete(id); resolve(false); }, 20000);
      nativeCallbacks.set(id, ok => { clearTimeout(timer); resolve(ok); });
      try { window.InotiaNative.report(body, id); }
      catch { clearTimeout(timer); nativeCallbacks.delete(id); resolve(false); }
    });
  }
  async function flush() {
    if (sending || !pending.length) return;
    sending = true;
    // 单条最多约 36 KB，包含中文时仍低于 keepalive 的 64 KB 限制。
    const batch = pending.slice(0, 1);
    const body = JSON.stringify({ version: 1, entries: batch });
    try {
      let ok = false;
      if (nativeBridge) ok = await sendNative(body, batch[0].id);
      else {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        try {
          const response = await fetch(endpoint(), { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body, keepalive: true, signal: controller.signal });
          ok = response.ok;
          // 离线壳的原生桥不可用时，同源地址只是 asset loader 的占位响应。
          if (ok && offlineShell && endpoint() === localEndpoint) ok = false;
        } finally { clearTimeout(timeout); }
      }
      if (ok) {
        const ids = new Set(batch.map(item => item.id));
        pending = pending.filter(item => !ids.has(item.id));
        persist();
      }
    } catch { /* 发送失败保留待发记录，避免诊断错误递归。 */ }
    finally { sending = false; }
  }
  function record(kind, details) {
    if (capturing) return;
    capturing = true;
    try {
      let state;
      try { state = safe(snapshot()); } catch (error) { state = { snapshotError: safe(error) }; }
      const entry = { id: session + ':' + (++sequence), session, time: new Date().toISOString(), kind,
        page: location.pathname, userAgent: navigator.userAgent, visibility: document.visibilityState,
        viewport: { width: innerWidth, height: innerHeight, pixelRatio: devicePixelRatio },
        frame: { phase, lastFrameAgoMs: lastFrame ? Date.now() - lastFrame : null },
        details: safe(details), state };
      if (JSON.stringify(entry).length > 12000) {
        entry.details = { truncated: JSON.stringify(entry.details).slice(0, 4000) };
        entry.state = { truncated: JSON.stringify(entry.state).slice(0, 4000) };
      }
      recent.push(entry); recent = recent.slice(-32);
      pending.push(entry); pending = pending.slice(-32);
      persist();
      void flush();
    } catch { /* 收集器不能成为新的游戏异常来源。 */ }
    finally { capturing = false; }
  }

  const originalError = console.error;
  console.error = function (...args) {
    record('console-error', { args, callStack: new Error('console.error').stack });
    return originalError.apply(this, args);
  };
  window.addEventListener('error', event => {
    const target = event.target;
    if (target && target !== window) {
      record('resource-error', { tag: target.tagName, url: target.currentSrc || target.src || target.href });
    } else {
      record('window-error', { message: event.message, file: event.filename, line: event.lineno,
        column: event.colno, error: event.error });
    }
  }, true);
  window.addEventListener('unhandledrejection', event => record('unhandled-rejection', { reason: event.reason }));
  window.addEventListener('pagehide', () => { void flush(); });
  document.addEventListener('visibilitychange', () => {
    visibleSince = Date.now(); stalled = false;
    // 后台期间不采样；回到前台时丢掉后台前的旧窗口，避免把两段时间混成一条统计。
    frameSampleCount = 0; frameSampleCursor = 0; lastFrameReport = Date.now();
  });
  document.addEventListener('webglcontextlost', event => record('webgl-context-lost', { status: event.statusMessage }), true);
  document.addEventListener('webglcontextrestored', () => record('webgl-context-restored', {}), true);
  window.storyDiagnostics = {
    record, flush,
    setSnapshot(provider) { snapshot = provider; },
    markFrame(nextPhase) {
      phase = nextPhase; lastFrame = Date.now(); stalled = false;
      if (!perfEnabled) return;
      const now = nowMs();
      if (nextPhase === 'update') updateStartedAt = now;
      else if (nextPhase === 'render') renderStartedAt = now;
      else if (nextPhase === 'idle' && updateStartedAt && renderStartedAt) {
        addFrameSample(now - updateStartedAt, renderStartedAt - updateStartedAt, now - renderStartedAt);
        updateStartedAt = 0; renderStartedAt = 0;
      }
    },
    stopFrames() {
      lastFrame = 0; phase = 'stopped';
      updateStartedAt = 0; renderStartedAt = 0;
      frameSampleCount = 0; frameSampleCursor = 0;
    },
    export() { return JSON.stringify({ version: 1, entries: recent, pending }, null, 2); }
  };
  // 真正阻塞整个 JavaScript 线程时此计时器也不能执行；异常造成的停帧可以记录。
  setInterval(() => {
    if (lastFrame && document.visibilityState === 'visible' && !stalled
      && Date.now() - Math.max(lastFrame, visibleSince) > 5000) {
      stalled = true;
      record('frame-stalled', { message: '游戏超过 5 秒未进入下一帧' });
    }
    reportFrameStats(Date.now());
    void flush();
  }, 2000);
  record('collector-start', { message: '手机诊断收集器已启动', version: 1 });
})();

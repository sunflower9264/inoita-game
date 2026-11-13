import {
  CLOUD_LOCK_DURATION_MS,
  CLOUD_SAVE_MAX_BYTES,
  cloudLockedMessage,
  cloudRateLimitedMessage,
  cloudSaveSlotId,
  cloudWrongCurrentPasswordMessage,
  cloudWrongPasswordMessage,
  parseCloudSaveSlotId,
} from '../domain/cloud-save.ts';
import type { SaveSlotRef, SaveSummary } from '../domain/save-game.ts';
import { CLOUD_PATH } from './endpoints.ts';

const SESSION_KEY = 'inotia4.cloud.v1.session';
const REQUEST_TIMEOUT_MS = 12_000;
/** 服务端限流时没带 Retry-After 的默认等待秒数。 */
const DEFAULT_RETRY_AFTER_SECONDS = 60;
/** 云存档服务用 HTTP 状态码表达失败类别；这里只给协议码命名，不改界面文案。 */
const HTTP_STATUS = {
  unauthorized: 401,
  forbidden: 403,
  notFound: 404,
  payloadTooLarge: 413,
  rateLimited: 429,
  serverError: 500,
  storageFull: 507,
} as const;

type CloudSaveErrorCode =
  | 'network'
  | 'timeout'
  | 'aborted'
  | 'unsupported'
  | 'unauthorized'
  | 'invalid-credentials'
  | 'locked'
  | 'rate-limited'
  | 'account-exists'
  | 'invalid-input'
  | 'too-large'
  | 'storage-full'
  | 'not-found'
  | 'server';

export interface CloudSaveError {
  code: CloudSaveErrorCode;
  message: string;
  remainingAttempts?: number;
  retryAfterSeconds?: number;
}

type CloudResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: CloudSaveError };

export interface CloudSession {
  account: string;
  token: string;
  expiresAt: number;
  /** 会话链总上限；旧版本 localStorage 没有这个字段。 */
  absoluteExpiresAt?: number;
}

export interface CloudSaveEntry {
  slot: SaveSlotRef;
  format: number;
  bytes: number;
  summary: SaveSummary;
  savedAt?: number;
  updatedAt: number;
}

export interface CloudSavePort {
  readonly account?: string;
  readonly loggedIn: boolean;
  readonly expiresAt?: number;
  readonly absoluteExpiresAt?: number;
  login(account: string, password: string, signal?: AbortSignal): Promise<CloudResult<CloudSession>>;
  register(account: string, password: string, signal?: AbortSignal): Promise<CloudResult<CloudSession>>;
  changePassword(currentPassword: string, newPassword: string, signal?: AbortSignal): Promise<CloudResult<CloudSession>>;
  /** 续期：剩余有效期内换发新 token；未到续期窗口时服务端返回 renewed:false。 */
  refresh(signal?: AbortSignal): Promise<CloudResult<CloudSession>>;
  logout(signal?: AbortSignal): Promise<CloudResult<void>>;
  list(signal?: AbortSignal): Promise<CloudResult<CloudSaveEntry[]>>;
  upload(slot: SaveSlotRef, game: unknown, signal?: AbortSignal): Promise<CloudResult<CloudSaveEntry>>;
  download(slot: SaveSlotRef, signal?: AbortSignal): Promise<CloudResult<unknown>>;
  forget(): void;
}

export interface CloudSessionStore {
  read(): CloudSession | undefined;
  write(session: CloudSession): void;
  clear(): void;
}

interface CloudSaveClientOptions {
  /** 网页留空走同源；APK 传原生注入的绝对地址。 */
  baseUrl?: string | (() => string);
  fetch?: typeof fetch;
  storage?: CloudSessionStore;
}

function fail<T>(code: CloudSaveErrorCode, message: string): CloudResult<T> {
  return { ok: false, error: { code, message } };
}

function browserSessionStore(): CloudSessionStore {
  return {
    read() {
      if (typeof localStorage === 'undefined') return undefined;
      try {
        const raw = localStorage.getItem(SESSION_KEY);
        if (!raw) return undefined;
        const value = JSON.parse(raw) as Partial<CloudSession>;
        if (typeof value.account !== 'string' || typeof value.token !== 'string' || typeof value.expiresAt !== 'number')
          return undefined;
        return {
          account: value.account, token: value.token, expiresAt: value.expiresAt,
          ...(typeof value.absoluteExpiresAt === 'number' ? { absoluteExpiresAt: value.absoluteExpiresAt } : {}),
        };
      } catch { return undefined; }
    },
    write(session) {
      if (typeof localStorage === 'undefined') return;
      try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch { /* 存储不可用只影响自动登录 */ }
    },
    clear() {
      if (typeof localStorage === 'undefined') return;
      try { localStorage.removeItem(SESSION_KEY); } catch { /* 存储不可用只影响自动登录 */ }
    },
  };
}

function endpointProblem(base: string): string | undefined {
  if (!base || !/^[a-z][a-z0-9+.-]*:\/\//i.test(base)) return undefined;
  let url: URL;
  try { url = new URL(base); } catch { return '云存档地址无效。'; }
  if (url.protocol === 'https:') return undefined;
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1') return undefined;
  return '云存档地址必须使用 HTTPS。';
}

function packagedWithoutEndpoint(base: string): boolean {
  if (base) return false;
  const hostname = (globalThis as { location?: { hostname?: string } }).location?.hostname;
  return hostname === 'appassets.androidplatform.net';
}

function errorFromResponse(status: number, data: unknown): CloudSaveError {
  const record = data && typeof data === 'object' && !Array.isArray(data)
    ? data as { error?: unknown; message?: unknown; remainingAttempts?: unknown; retryAfterSeconds?: unknown }
    : {};
  const code = typeof record.error === 'string' ? record.error : '';
  const message = typeof record.message === 'string' ? record.message : undefined;
  const remaining = typeof record.remainingAttempts === 'number' && Number.isFinite(record.remainingAttempts)
    ? record.remainingAttempts : undefined;
  const retry = typeof record.retryAfterSeconds === 'number' && Number.isFinite(record.retryAfterSeconds)
    ? record.retryAfterSeconds : undefined;
  switch (code) {
    case 'invalid-credentials': {
      const attempts = remaining ?? 1;
      return { code: 'invalid-credentials', message: cloudWrongPasswordMessage(attempts), remainingAttempts: attempts };
    }
    case 'locked': {
      const seconds = retry ?? Math.ceil(CLOUD_LOCK_DURATION_MS / 1000);
      return { code: 'locked', message: cloudLockedMessage(seconds), retryAfterSeconds: seconds };
    }
    case 'rate-limited': {
      const seconds = retry ?? DEFAULT_RETRY_AFTER_SECONDS;
      return { code: 'rate-limited', message: cloudRateLimitedMessage(seconds), retryAfterSeconds: seconds };
    }
    case 'account-exists':
      return { code: 'account-exists', message: message ?? '这个账号已被注册，请直接登录。' };
    case 'invalid-input':
      return { code: 'invalid-input', message: message ?? '输入内容不符合要求。' };
    case 'too-large':
      return { code: 'too-large', message: message ?? '存档过大，无法上传。' };
    case 'storage-full':
      return { code: 'storage-full', message: message ?? '云端存档空间不足。' };
    case 'save-not-found':
    case 'not-found':
      return { code: 'not-found', message: message ?? '云端没有这个存档。' };
    case 'unauthorized':
      return { code: 'unauthorized', message: '账号已在其他地方登录或登录已失效，请重新登录。' };
    case 'cloud-unavailable':
    case 'server':
      return { code: 'server', message: '云存档服务暂时不可用。' };
    default:
      if (status === HTTP_STATUS.unauthorized) return { code: 'unauthorized', message: '登录已失效，请重新登录。' };
      if (status === HTTP_STATUS.forbidden) return { code: 'unsupported', message: '当前来源不允许访问云存档。' };
      if (status === HTTP_STATUS.notFound) return { code: 'not-found', message: '云端没有这个存档。' };
      if (status === HTTP_STATUS.payloadTooLarge) return { code: 'too-large', message: '存档过大，无法上传。' };
      if (status === HTTP_STATUS.rateLimited) {
        const seconds = retry ?? DEFAULT_RETRY_AFTER_SECONDS;
        return { code: 'rate-limited', message: cloudRateLimitedMessage(seconds), retryAfterSeconds: seconds };
      }
      if (status === HTTP_STATUS.storageFull) return { code: 'storage-full', message: '云端存档空间不足。' };
      if (status >= HTTP_STATUS.serverError) return { code: 'server', message: '云存档服务暂时不可用。' };
      return { code: 'server', message: message ?? '云存档操作失败。' };
  }
}

function normalizeEntry(value: unknown): CloudSaveEntry | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const slotValue = typeof record.slot === 'number' ? String(record.slot)
    : typeof record.slot === 'string' ? record.slot : undefined;
  const slot = slotValue ? parseCloudSaveSlotId(slotValue) : undefined;
  if (slot === undefined) return undefined;
  const format = typeof record.format === 'number' && Number.isFinite(record.format) ? record.format : 0;
  const bytes = typeof record.bytes === 'number' && Number.isFinite(record.bytes) ? record.bytes : 0;
  const updatedAt = typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt) ? record.updatedAt : 0;
  const summaryValue = record.summary;
  if (!summaryValue || typeof summaryValue !== 'object' || Array.isArray(summaryValue)) return undefined;
  const summaryRecord = summaryValue as Record<string, unknown>;
  const classId = typeof summaryRecord.classId === 'string' ? summaryRecord.classId : undefined;
  const mapId = typeof summaryRecord.mapId === 'string' ? summaryRecord.mapId : undefined;
  const level = typeof summaryRecord.level === 'number' && Number.isFinite(summaryRecord.level)
    ? summaryRecord.level : undefined;
  if (!classId || !mapId || level === undefined) return undefined;
  const summary: SaveSummary = {
    classId,
    className: typeof summaryRecord.className === 'string' ? summaryRecord.className : classId,
    portrait: typeof summaryRecord.portrait === 'string' ? summaryRecord.portrait : '',
    level,
    mapId,
    mapName: typeof summaryRecord.mapName === 'string' ? summaryRecord.mapName : mapId,
    ...(typeof summaryRecord.name === 'string' ? { name: summaryRecord.name } : {}),
    ...(typeof summaryRecord.savedAt === 'number' && Number.isFinite(summaryRecord.savedAt)
      ? { savedAt: summaryRecord.savedAt } : {}),
  };
  const savedAt = typeof record.savedAt === 'number' && Number.isFinite(record.savedAt) ? record.savedAt : undefined;
  return { slot, format, bytes, summary, updatedAt, ...(savedAt !== undefined ? { savedAt } : {}) };
}

/**
 * 云存档 HTTP 客户端。所有方法返回结果对象，不向界面抛异常；构造时不联网。
 * 网页用同源 `/__cloud`，APK 用原生注入的绝对 HTTPS 地址。
 */
export class CloudSaveClient implements CloudSavePort {
  private readonly baseUrlOption: string | (() => string);
  private readonly fetchImpl?: typeof fetch;
  private readonly storage: CloudSessionStore;
  private session?: CloudSession;
  private requestSerial = 0;

  constructor(options: CloudSaveClientOptions = {}) {
    this.baseUrlOption = options.baseUrl ?? '';
    this.fetchImpl = options.fetch;
    this.storage = options.storage ?? browserSessionStore();
    try { this.session = this.storage.read(); } catch { this.session = undefined; }
  }

  get account(): string | undefined { return this.session?.account; }
  get loggedIn(): boolean { return !!this.session; }
  get expiresAt(): number | undefined { return this.session?.expiresAt; }
  get absoluteExpiresAt(): number | undefined { return this.session?.absoluteExpiresAt; }

  forget(): void {
    this.session = undefined;
    try { this.storage.clear(); } catch { /* 存储不可用只影响自动登录 */ }
  }

  private baseUrl(): string {
    const value = typeof this.baseUrlOption === 'function' ? this.baseUrlOption() : this.baseUrlOption;
    return value.replace(/\/+$/, '');
  }

  private setSession(session: CloudSession): void {
    this.session = session;
    try { this.storage.write(session); } catch { /* 存储不可用只影响自动登录 */ }
  }

  private async request<T>(
    path: string,
    options: { method: string; body?: unknown; auth?: boolean; signal?: AbortSignal },
  ): Promise<CloudResult<T>> {
    const base = this.baseUrl();
    const problem = endpointProblem(base);
    if (problem) return fail('unsupported', problem);
    if (packagedWithoutEndpoint(base)) return fail('unsupported', '云存档暂不可用，本机存档不受影响。');
    const fetchImpl = this.fetchImpl ?? (globalThis as { fetch?: typeof fetch }).fetch;
    if (typeof fetchImpl !== 'function') return fail('unsupported', '当前浏览器不支持网络请求。');
    const serial = ++this.requestSerial;
    // 网页同源时 base 为空：接口仍必须落在 /__cloud 下，不能把 /login 发到站点根。
    const endpoint = base ? `${base}${path}` : `${CLOUD_PATH}${path}`;
    const controller = new AbortController();
    let timedOut = false;
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => { timedOut = true; controller.abort(); }, REQUEST_TIMEOUT_MS);
    const onAbort = (): void => controller.abort();
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }
    const headers: Record<string, string> = {};
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.auth && this.session) headers.Authorization = `Bearer ${this.session.token}`;
    try {
      const response = await fetchImpl(endpoint, {
        method: options.method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
      const text = await response.text();
      let data: unknown;
      if (text) {
        try { data = JSON.parse(text); } catch { data = undefined; }
      }
      if (!response.ok) {
        const error = errorFromResponse(response.status, data);
        // 改密时“当前密码错误”也是 401，但 token 本身有效，不能把玩家踢下线。
        if (response.status === HTTP_STATUS.unauthorized && options.auth && serial === this.requestSerial && error.code !== 'invalid-credentials') {
          this.forget();
        }
        return { ok: false, error };
      }
      return { ok: true, value: data as T };
    } catch {
      if (options.signal?.aborted) return fail('aborted', '操作已取消。');
      if (timedOut) return fail('timeout', '连接云存档服务超时，请稍后重试。');
      return fail('network', '无法连接云存档服务，请检查网络。');
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }

  private sessionFrom(value: unknown): CloudSession | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const record = value as Partial<CloudSession>;
    if (typeof record.account !== 'string' || typeof record.token !== 'string' || typeof record.expiresAt !== 'number')
      return undefined;
    return {
      account: record.account, token: record.token, expiresAt: record.expiresAt,
      ...(typeof record.absoluteExpiresAt === 'number' ? { absoluteExpiresAt: record.absoluteExpiresAt } : {}),
    };
  }

  async login(account: string, password: string, signal?: AbortSignal): Promise<CloudResult<CloudSession>> {
    const result = await this.request<unknown>('/login', { method: 'POST', body: { account, password }, signal });
    if (!result.ok) return result;
    const session = this.sessionFrom(result.value);
    if (!session) return fail('server', '云存档服务返回了无效的登录信息。');
    this.setSession(session);
    return { ok: true, value: session };
  }

  async register(account: string, password: string, signal?: AbortSignal): Promise<CloudResult<CloudSession>> {
    const result = await this.request<unknown>('/register', { method: 'POST', body: { account, password }, signal });
    if (!result.ok) return result;
    const session = this.sessionFrom(result.value);
    if (!session) return fail('server', '云存档服务返回了无效的登录信息。');
    this.setSession(session);
    return { ok: true, value: session };
  }

  async changePassword(currentPassword: string, newPassword: string, signal?: AbortSignal): Promise<CloudResult<CloudSession>> {
    const result = await this.request<unknown>('/password', {
      method: 'POST', body: { currentPassword, newPassword }, auth: true, signal,
    });
    if (!result.ok) {
      if (result.error.code === 'invalid-credentials') {
        return {
          ok: false,
          error: { ...result.error, message: cloudWrongCurrentPasswordMessage(result.error.remainingAttempts ?? 1) },
        };
      }
      return result;
    }
    const session = this.sessionFrom(result.value);
    if (!session) return fail('server', '云存档服务返回了无效的登录信息。');
    this.setSession(session);
    return { ok: true, value: session };
  }

  async refresh(signal?: AbortSignal): Promise<CloudResult<CloudSession>> {
    if (!this.session) return fail('unauthorized', '登录已失效，请重新登录。');
    const result = await this.request<unknown>('/refresh', { method: 'POST', auth: true, signal });
    if (!result.ok) return result;
    const value = result.value && typeof result.value === 'object' && !Array.isArray(result.value)
      ? result.value as { renewed?: unknown; account?: unknown; token?: unknown; expiresAt?: unknown; absoluteExpiresAt?: unknown }
      : {};
    if (value.renewed === false) {
      const session: CloudSession = {
        ...this.session,
        ...(typeof value.account === 'string' ? { account: value.account } : {}),
        ...(typeof value.expiresAt === 'number' ? { expiresAt: value.expiresAt } : {}),
        ...(typeof value.absoluteExpiresAt === 'number' ? { absoluteExpiresAt: value.absoluteExpiresAt } : {}),
      };
      this.setSession(session);
      return { ok: true, value: session };
    }
    const session = this.sessionFrom(value);
    if (!session) return fail('server', '云存档服务返回了无效的登录信息。');
    this.setSession(session);
    return { ok: true, value: session };
  }

  async logout(signal?: AbortSignal): Promise<CloudResult<void>> {
    if (!this.session) return { ok: true, value: undefined };
    await this.request<void>('/logout', { method: 'POST', auth: true, signal });
    this.forget();
    return { ok: true, value: undefined };
  }

  async list(signal?: AbortSignal): Promise<CloudResult<CloudSaveEntry[]>> {
    const result = await this.request<unknown>('/saves', { method: 'GET', auth: true, signal });
    if (!result.ok) return result;
    const value = result.value && typeof result.value === 'object' && !Array.isArray(result.value)
      ? result.value as { account?: unknown; saves?: unknown }
      : {};
    const account = typeof value.account === 'string' ? value.account : this.session?.account;
    if (account && this.session) this.setSession({ ...this.session, account });
    const saves = Array.isArray(value.saves) ? value.saves : [];
    const entries: CloudSaveEntry[] = [];
    for (const entry of saves) {
      const normalized = normalizeEntry(entry);
      if (normalized) entries.push(normalized);
    }
    return { ok: true, value: entries };
  }

  async upload(slot: SaveSlotRef, game: unknown, signal?: AbortSignal): Promise<CloudResult<CloudSaveEntry>> {
    const raw = JSON.stringify(game);
    if (new TextEncoder().encode(raw).length > CLOUD_SAVE_MAX_BYTES)
      return fail('too-large', '存档超过 2 MiB，无法上传。');
    const result = await this.request<unknown>(`/saves/${cloudSaveSlotId(slot)}`, {
      method: 'PUT', body: game, auth: true, signal,
    });
    if (!result.ok) return result;
    const entry = normalizeEntry(result.value);
    return entry ? { ok: true, value: entry } : fail('server', '云端返回的存档摘要无效。');
  }

  async download(slot: SaveSlotRef, signal?: AbortSignal): Promise<CloudResult<unknown>> {
    return this.request<unknown>(`/saves/${cloudSaveSlotId(slot)}`, { method: 'GET', auth: true, signal });
  }
}

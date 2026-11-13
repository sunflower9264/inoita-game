import { Buffer } from 'node:buffer';
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { statSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import {
  CLOUD_ACCOUNT_SAVE_QUOTA_BYTES,
  CLOUD_LOGIN_MAX_FAILURES,
  CLOUD_LOCK_DURATION_MS,
  CLOUD_NEW_PASSWORD_SAME_MESSAGE,
  CLOUD_SAVE_MAX_BYTES,
  CLOUD_SESSION_ABSOLUTE_TTL_MS,
  CLOUD_SESSION_RENEW_WINDOW_MS,
  CLOUD_SESSION_TTL_MS,
  cloudAccountIdentity,
  cloudSaveSlotId,
  normalizeCloudAccount,
  parseCloudSaveSlotId,
  validateCloudAccount,
  validateCloudPassword,
} from '../src/domain/cloud-save.ts';
import type { SaveSlotRef, SaveSummary } from '../src/domain/save-game.ts';

const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 32;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
/** 读取旧密码哈希时允许的 scrypt 参数范围；异常参数直接拒绝，避免拖垮登录。 */
const SCRYPT_MIN_N = 2;
const SCRYPT_MAX_N = 65536;
const SCRYPT_MIN_R = 1;
const SCRYPT_MAX_R = 32;
const SCRYPT_MIN_P = 1;
const SCRYPT_MAX_P = 16;
const SCRYPT_VERIFY_MAXMEM = 128 * 1024 * 1024;
/** 新密码哈希使用的盐长度。 */
const SCRYPT_SALT_BYTES = 16;
const MAX_CONCURRENT_SCRYPT = 2;
const DUMMY_SALT = Buffer.from('inoita-cloud-dummy-salt');

export type CloudStoreErrorCode =
  | 'invalid-input'
  | 'account-exists'
  | 'invalid-credentials'
  | 'locked'
  | 'unauthorized'
  | 'save-not-found'
  | 'too-large'
  | 'storage-full'
  | 'cloud-unavailable'
  | 'server';

export class CloudStoreError extends Error {
  readonly code: CloudStoreErrorCode;
  readonly remainingAttempts?: number;
  readonly retryAfterSeconds?: number;

  constructor(code: CloudStoreErrorCode, message: string, options: { remainingAttempts?: number; retryAfterSeconds?: number } = {}) {
    super(message);
    this.name = 'CloudStoreError';
    this.code = code;
    this.remainingAttempts = options.remainingAttempts;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

interface CloudAccountRecord {
  version: 1;
  account: string;
  passwordHash: string;
  createdAt: number;
  failedAttempts: number;
  lockedUntil: number;
}

interface CloudSessionRecord {
  tokenHash: string;
  accountKey: string;
  account: string;
  /** 当前 token 的签发时刻。 */
  createdAt: number;
  /** 会话链起点：登录、注册或改密时刻；续期不改变它。 */
  startedAt: number;
  expiresAt: number;
  /** 会话链的硬上限；到达后必须重新登录。 */
  absoluteExpiresAt: number;
}

interface CloudSaveEntry {
  slot: SaveSlotRef;
  format: number;
  bytes: number;
  summary: SaveSummary;
  savedAt?: number;
  updatedAt: number;
}

interface CloudAuthResult {
  token: string;
  account: string;
  expiresAt: number;
  absoluteExpiresAt: number;
}

type CloudRefreshResult =
  | { renewed: true; token: string; account: string; expiresAt: number; absoluteExpiresAt: number }
  | { renewed: false; account: string; expiresAt: number; absoluteExpiresAt: number };

interface CloudSaveStoreOptions {
  dataDir: string;
  now?: () => number;
  /** 测试用：缩小配额，避免造几十 MB 的存档。 */
  saveQuotaBytes?: number;
  sessionTtlMs?: number;
  sessionAbsoluteTtlMs?: number;
}

export interface CloudSaveStore {
  /** 会话文件是懒加载的；所有公开方法都会先 await 它。 */
  readonly ready: Promise<void>;
  register(account: string, password: string): Promise<CloudAuthResult>;
  login(account: string, password: string): Promise<CloudAuthResult>;
  changePassword(accountKey: string, currentPassword: string, newPassword: string): Promise<CloudAuthResult>;
  logout(token: string): Promise<void>;
  authenticate(token: string): Promise<{ accountKey: string; account: string; tokenHash: string }>;
  refreshSession(accountKey: string, tokenHash: string): Promise<CloudRefreshResult>;
  listSaves(accountKey: string): Promise<CloudSaveEntry[]>;
  uploadSave(accountKey: string, slot: SaveSlotRef, game: unknown): Promise<CloudSaveEntry>;
  downloadSave(accountKey: string, slot: SaveSlotRef): Promise<unknown>;
}

interface StoredSave {
  version: 1;
  slot: SaveSlotRef;
  format: number;
  bytes: number;
  summary: SaveSummary;
  savedAt?: number;
  updatedAt: number;
  game: unknown;
}

const scryptAsync = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number }
) => Promise<Buffer>;

let scryptActive = 0;
const scryptWaiters: (() => void)[] = [];

async function withScryptSlot<T>(work: () => Promise<T>): Promise<T> {
  if (scryptActive >= MAX_CONCURRENT_SCRYPT) await new Promise<void>(resolve => scryptWaiters.push(resolve));
  scryptActive += 1;
  try {
    return await work();
  } finally {
    scryptActive -= 1;
    scryptWaiters.shift()?.();
  }
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const key = await withScryptSlot(() => scryptAsync(password, salt, SCRYPT_KEY_LENGTH, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM,
  }));
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (![N, r, p].every(Number.isSafeInteger)
    || N < SCRYPT_MIN_N || N > SCRYPT_MAX_N
    || r < SCRYPT_MIN_R || r > SCRYPT_MAX_R
    || p < SCRYPT_MIN_P || p > SCRYPT_MAX_P) return false;
  const salt = Buffer.from(parts[4] ?? '', 'base64');
  const expected = Buffer.from(parts[5] ?? '', 'base64');
  if (!salt.length || !expected.length) return false;
  const actual = await withScryptSlot(() => scryptAsync(password, salt, expected.length, {
    N, r, p, maxmem: SCRYPT_VERIFY_MAXMEM,
  }));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** 账号不存在时也跑一次同样成本的哈希，避免响应时间直接暴露账号是否存在。 */
async function dummyVerify(password: string): Promise<void> {
  await withScryptSlot(() => scryptAsync(password, DUMMY_SALT, SCRYPT_KEY_LENGTH, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM,
  }));
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function accountKey(account: string): string {
  return sha256(cloudAccountIdentity(account));
}

function tokenHash(token: string): string {
  return sha256(token);
}

function isMissing(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT';
}

function isStorageError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === 'ENOSPC' || code === 'EDQUOT';
}

async function atomicWrite(file: string, text: string): Promise<void> {
  const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temp, text, { encoding: 'utf8', mode: 0o600 });
    await rename(temp, file);
  } catch (error) {
    try { await unlink(temp); } catch { /* 临时文件可能还没创建 */ }
    throw error;
  }
}

function textValue(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined;
}

function normalizeSummary(value: unknown): SaveSummary | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Partial<SaveSummary>;
  const classId = textValue(record.classId, 64);
  const mapId = textValue(record.mapId, 64);
  const level = typeof record.level === 'number' && Number.isFinite(record.level) ? record.level : undefined;
  if (!classId || !mapId || level === undefined) return undefined;
  const className = textValue(record.className, 64) ?? classId;
  const mapName = textValue(record.mapName, 64) ?? mapId;
  const portrait = textValue(record.portrait, 256) ?? '';
  const name = textValue(record.name, 24);
  const savedAt = typeof record.savedAt === 'number' && Number.isFinite(record.savedAt) ? record.savedAt : undefined;
  return {
    classId, className, portrait, level, mapId, mapName,
    ...(name !== undefined ? { name } : {}),
    ...(savedAt !== undefined ? { savedAt } : {}),
  };
}

function normalizeStoredGame(game: unknown): { format: number; summary: SaveSummary; bytes: number; savedAt?: number } {
  if (!game || typeof game !== 'object' || Array.isArray(game))
    throw new CloudStoreError('invalid-input', '存档内容无效。');
  const record = game as { format?: unknown; summary?: unknown; session?: unknown; world?: unknown };
  if (typeof record.format !== 'number' || !Number.isFinite(record.format))
    throw new CloudStoreError('invalid-input', '存档版本无效。');
  if (!record.session || typeof record.session !== 'object' || Array.isArray(record.session)
    || !record.world || typeof record.world !== 'object' || Array.isArray(record.world))
    throw new CloudStoreError('invalid-input', '存档缺少会话或世界状态。');
  const summary = normalizeSummary(record.summary);
  if (!summary) throw new CloudStoreError('invalid-input', '存档摘要无效。');
  const bytes = Buffer.byteLength(JSON.stringify(game), 'utf8');
  return { format: record.format, summary, bytes, ...(summary.savedAt !== undefined ? { savedAt: summary.savedAt } : {}) };
}

function normalizeSession(value: unknown): CloudSessionRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Partial<CloudSessionRecord>;
  if (typeof record.tokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(record.tokenHash)) return undefined;
  if (typeof record.accountKey !== 'string' || !/^[0-9a-f]{64}$/.test(record.accountKey)) return undefined;
  if (typeof record.account !== 'string' || typeof record.createdAt !== 'number' || typeof record.expiresAt !== 'number') return undefined;
  if (!Number.isFinite(record.createdAt) || !Number.isFinite(record.expiresAt)) return undefined;
  // 旧会话没有会话链字段：把创建时刻当作链起点，总上限按默认 90 天补。
  const startedAt = typeof record.startedAt === 'number' && Number.isFinite(record.startedAt)
    ? record.startedAt : record.createdAt;
  const absoluteExpiresAt = typeof record.absoluteExpiresAt === 'number' && Number.isFinite(record.absoluteExpiresAt)
    ? record.absoluteExpiresAt : startedAt + CLOUD_SESSION_ABSOLUTE_TTL_MS;
  return {
    tokenHash: record.tokenHash,
    accountKey: record.accountKey,
    account: record.account,
    createdAt: record.createdAt,
    startedAt,
    expiresAt: record.expiresAt,
    absoluteExpiresAt,
  };
}

function entryOf(stored: StoredSave): CloudSaveEntry {
  return {
    slot: stored.slot,
    format: stored.format,
    bytes: stored.bytes,
    summary: stored.summary,
    updatedAt: stored.updatedAt,
    ...(stored.savedAt !== undefined ? { savedAt: stored.savedAt } : {}),
  };
}

class CloudSaveStoreImpl implements CloudSaveStore {
  readonly ready: Promise<void>;
  private readonly dataDir: string;
  private readonly accountsDir: string;
  private readonly savesRoot: string;
  private readonly sessionFile: string;
  private readonly now: () => number;
  private readonly saveQuotaBytes: number;
  private readonly sessionTtlMs: number;
  private readonly sessionAbsoluteTtlMs: number;
  private readonly sessionsByAccount = new Map<string, CloudSessionRecord>();
  private readonly sessionsByToken = new Map<string, CloudSessionRecord>();
  private readonly locks = new Map<string, Promise<void>>();
  private sessionWrite: Promise<void> = Promise.resolve();

  constructor(options: CloudSaveStoreOptions) {
    this.dataDir = path.resolve(options.dataDir);
    const existing = statSync(this.dataDir, { throwIfNoEntry: false });
    if (existing && !existing.isDirectory()) {
      throw new CloudStoreError('cloud-unavailable', '云存档数据目录不可用。');
    }
    this.accountsDir = path.join(this.dataDir, 'accounts');
    this.savesRoot = path.join(this.dataDir, 'saves');
    this.sessionFile = path.join(this.dataDir, 'sessions.json');
    this.now = options.now ?? Date.now;
    this.saveQuotaBytes = options.saveQuotaBytes ?? CLOUD_ACCOUNT_SAVE_QUOTA_BYTES;
    this.sessionTtlMs = options.sessionTtlMs ?? CLOUD_SESSION_TTL_MS;
    this.sessionAbsoluteTtlMs = options.sessionAbsoluteTtlMs ?? CLOUD_SESSION_ABSOLUTE_TTL_MS;
    this.ready = this.loadSessions().catch(error => {
      console.warn('云存档会话加载失败，按空会话启动', error);
      this.sessionsByAccount.clear();
      this.sessionsByToken.clear();
    });
  }

  private accountFile(key: string): string {
    return path.join(this.accountsDir, `${key}.json`);
  }

  private saveDir(key: string): string {
    return path.join(this.savesRoot, key);
  }

  private saveFile(key: string, slot: SaveSlotRef): string {
    return path.join(this.saveDir(key), `${cloudSaveSlotId(slot)}.json`);
  }

  private withLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(work);
    const tail = run.then(() => undefined, () => undefined);
    this.locks.set(key, tail);
    void tail.finally(() => {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    });
    return run;
  }

  private async readAccount(key: string): Promise<CloudAccountRecord | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.accountFile(key), 'utf8');
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new CloudStoreError('server', '账号数据损坏。'); }
    const record = parsed as Partial<CloudAccountRecord>;
    if (!record || record.version !== 1 || typeof record.account !== 'string'
      || typeof record.passwordHash !== 'string' || typeof record.createdAt !== 'number'
      || typeof record.failedAttempts !== 'number' || typeof record.lockedUntil !== 'number') {
      throw new CloudStoreError('server', '账号数据损坏。');
    }
    return record as CloudAccountRecord;
  }

  private async writeAccount(key: string, record: CloudAccountRecord): Promise<void> {
    await mkdir(this.accountsDir, { recursive: true, mode: 0o700 });
    await atomicWrite(this.accountFile(key), JSON.stringify(record));
  }

  private async loadSessions(): Promise<void> {
    let raw: string;
    try { raw = await readFile(this.sessionFile, 'utf8'); }
    catch (error) { if (isMissing(error)) return; throw error; }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch { console.warn('云存档会话文件损坏，按空会话启动'); return; }
    const value = parsed as { version?: unknown; sessions?: unknown };
    if (value.version !== 1 || !Array.isArray(value.sessions)) {
      console.warn('云存档会话文件格式不匹配，按空会话启动');
      return;
    }
    for (const entry of value.sessions) {
      const session = normalizeSession(entry);
      const nowMs = this.now();
      if (!session || session.expiresAt <= nowMs || nowMs >= session.absoluteExpiresAt) continue;
      const existing = this.sessionsByAccount.get(session.accountKey);
      if (existing && existing.createdAt >= session.createdAt) continue;
      if (existing) this.sessionsByToken.delete(existing.tokenHash);
      this.sessionsByAccount.set(session.accountKey, session);
      this.sessionsByToken.set(session.tokenHash, session);
    }
  }

  private queueSessionWrite(): Promise<void> {
    const write = this.sessionWrite.catch(() => {}).then(() => this.persistSessions());
    this.sessionWrite = write.then(() => undefined, () => undefined);
    return write;
  }

  private async persistSessions(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    const sessions = [...this.sessionsByAccount.values()].sort((left, right) => left.createdAt - right.createdAt);
    await atomicWrite(this.sessionFile, JSON.stringify({ version: 1, sessions }));
  }

  private async replaceSession(key: string, account: string, startedAt?: number): Promise<CloudAuthResult> {
    const token = randomBytes(32).toString('base64url');
    const hash = tokenHash(token);
    const createdAt = this.now();
    const sessionStartedAt = startedAt ?? createdAt;
    const absoluteExpiresAt = sessionStartedAt + this.sessionAbsoluteTtlMs;
    const session: CloudSessionRecord = {
      tokenHash: hash, accountKey: key, account, createdAt,
      startedAt: sessionStartedAt,
      expiresAt: Math.min(createdAt + this.sessionTtlMs, absoluteExpiresAt),
      absoluteExpiresAt,
    };
    const previous = this.sessionsByAccount.get(key);
    if (previous) this.sessionsByToken.delete(previous.tokenHash);
    this.sessionsByAccount.set(key, session);
    this.sessionsByToken.set(hash, session);
    try {
      await this.queueSessionWrite();
    } catch {
      this.sessionsByToken.delete(hash);
      if (previous) {
        this.sessionsByAccount.set(key, previous);
        this.sessionsByToken.set(previous.tokenHash, previous);
      } else {
        this.sessionsByAccount.delete(key);
      }
      throw new CloudStoreError('server', '登录会话保存失败，请稍后重试。');
    }
    return { token, account, expiresAt: session.expiresAt, absoluteExpiresAt: session.absoluteExpiresAt };
  }

  async register(account: string, password: string): Promise<CloudAuthResult> {
    await this.ready;
    const problem = validateCloudAccount(account) ?? validateCloudPassword(password);
    if (problem) throw new CloudStoreError('invalid-input', problem);
    const normalized = normalizeCloudAccount(account);
    const key = accountKey(normalized);
    return this.withLock('register', async () => {
      if (await this.readAccount(key)) throw new CloudStoreError('account-exists', '这个账号已被注册，请直接登录。');
      const record: CloudAccountRecord = {
        version: 1,
        account: normalized,
        passwordHash: await hashPassword(password),
        createdAt: this.now(),
        failedAttempts: 0,
        lockedUntil: 0,
      };
      await this.writeAccount(key, record);
      return this.replaceSession(key, normalized);
    });
  }

  async login(account: string, password: string): Promise<CloudAuthResult> {
    await this.ready;
    const problem = validateCloudAccount(account) ?? validateCloudPassword(password);
    if (problem) throw new CloudStoreError('invalid-input', problem);
    const normalized = normalizeCloudAccount(account);
    const key = accountKey(normalized);
    const outcome = await this.withLock(key, async () => {
      const record = await this.readAccount(key);
      if (!record) {
        await dummyVerify(password);
        return { kind: 'invalid' as const, remainingAttempts: CLOUD_LOGIN_MAX_FAILURES - 1 };
      }
      const nowMs = this.now();
      if (record.lockedUntil > nowMs) {
        return { kind: 'locked' as const, retryAfterSeconds: Math.ceil((record.lockedUntil - nowMs) / 1000) };
      }
      if (record.lockedUntil > 0 && record.lockedUntil <= nowMs) {
        record.failedAttempts = 0;
        record.lockedUntil = 0;
      }
      if (await verifyPassword(password, record.passwordHash)) {
        record.failedAttempts = 0;
        record.lockedUntil = 0;
        try { await this.writeAccount(key, record); } catch (error) { console.warn('云存档登录计数重置失败', error); }
        return { kind: 'ok' as const, account: record.account };
      }
      record.failedAttempts += 1;
      if (record.failedAttempts >= CLOUD_LOGIN_MAX_FAILURES) {
        record.lockedUntil = nowMs + CLOUD_LOCK_DURATION_MS;
        try { await this.writeAccount(key, record); }
        catch { throw new CloudStoreError('server', '账号锁定状态保存失败，请稍后重试。'); }
        return { kind: 'locked' as const, retryAfterSeconds: Math.ceil(CLOUD_LOCK_DURATION_MS / 1000) };
      }
      try { await this.writeAccount(key, record); }
      catch { throw new CloudStoreError('server', '账号状态保存失败，请稍后重试。'); }
      return { kind: 'invalid' as const, remainingAttempts: CLOUD_LOGIN_MAX_FAILURES - record.failedAttempts };
    });
    if (outcome.kind === 'invalid') {
      throw new CloudStoreError('invalid-credentials', '账号或密码错误。', { remainingAttempts: outcome.remainingAttempts });
    }
    if (outcome.kind === 'locked') {
      throw new CloudStoreError('locked', '密码连续输错 3 次，账号已锁定。', { retryAfterSeconds: outcome.retryAfterSeconds });
    }
    return this.replaceSession(key, outcome.account);
  }

  async changePassword(key: string, currentPassword: string, newPassword: string): Promise<CloudAuthResult> {
    await this.ready;
    const problem = validateCloudPassword(newPassword);
    if (problem) throw new CloudStoreError('invalid-input', problem);
    return this.withLock(key, async () => {
      const record = await this.readAccount(key);
      if (!record) throw new CloudStoreError('unauthorized', '登录已失效，请重新登录。');
      const nowMs = this.now();
      if (!(await verifyPassword(currentPassword, record.passwordHash))) {
        record.failedAttempts += 1;
        if (record.failedAttempts >= CLOUD_LOGIN_MAX_FAILURES) {
          record.lockedUntil = nowMs + CLOUD_LOCK_DURATION_MS;
          try { await this.writeAccount(key, record); }
          catch { throw new CloudStoreError('server', '账号锁定状态保存失败，请稍后重试。'); }
          throw new CloudStoreError('locked', '密码连续输错 3 次，账号已锁定。', {
            retryAfterSeconds: Math.ceil(CLOUD_LOCK_DURATION_MS / 1000),
          });
        }
        try { await this.writeAccount(key, record); }
        catch { throw new CloudStoreError('server', '账号状态保存失败，请稍后重试。'); }
        throw new CloudStoreError('invalid-credentials', '当前密码错误。', {
          remainingAttempts: CLOUD_LOGIN_MAX_FAILURES - record.failedAttempts,
        });
      }
      if (newPassword === currentPassword) throw new CloudStoreError('invalid-input', CLOUD_NEW_PASSWORD_SAME_MESSAGE);
      record.passwordHash = await hashPassword(newPassword);
      record.failedAttempts = 0;
      record.lockedUntil = 0;
      try { await this.writeAccount(key, record); }
      catch { throw new CloudStoreError('server', '密码保存失败，请稍后重试。'); }
      // 改密后换发新 token，旧 token（包括发起这次请求的那个）立即失效。
      return this.replaceSession(key, record.account);
    });
  }

  async logout(token: string): Promise<void> {
    await this.ready;
    if (!SESSION_TOKEN_PATTERN.test(token)) return;
    const hash = tokenHash(token);
    const session = this.sessionsByToken.get(hash);
    if (!session) return;
    this.sessionsByToken.delete(hash);
    if (this.sessionsByAccount.get(session.accountKey)?.tokenHash === hash) {
      this.sessionsByAccount.delete(session.accountKey);
    }
    try { await this.queueSessionWrite(); }
    catch (error) { console.warn('云存档会话保存失败', error); }
  }

  async authenticate(token: string): Promise<{ accountKey: string; account: string; tokenHash: string }> {
    await this.ready;
    if (!SESSION_TOKEN_PATTERN.test(token)) throw new CloudStoreError('unauthorized', '登录已失效，请重新登录。');
    const hash = tokenHash(token);
    const session = this.sessionsByToken.get(hash);
    if (!session) throw new CloudStoreError('unauthorized', '登录已失效，请重新登录。');
    const nowMs = this.now();
    if (session.expiresAt <= nowMs || nowMs >= session.absoluteExpiresAt) {
      this.sessionsByToken.delete(hash);
      if (this.sessionsByAccount.get(session.accountKey)?.tokenHash === hash) {
        this.sessionsByAccount.delete(session.accountKey);
      }
      // 过期会话的清理是一次性的；等写盘完成再返回 401，测试和部署都不会留下悬空写。
      try { await this.queueSessionWrite(); } catch { /* 写失败不影响本次 401 */ }
      throw new CloudStoreError('unauthorized', '登录已到期，请重新登录。');
    }
    return { accountKey: session.accountKey, account: session.account, tokenHash: hash };
  }

  async refreshSession(key: string, tokenHash: string): Promise<CloudRefreshResult> {
    await this.ready;
    return this.withLock(key, async () => {
      const session = this.sessionsByAccount.get(key);
      if (!session || session.tokenHash !== tokenHash) {
        throw new CloudStoreError('unauthorized', '登录已失效，请重新登录。');
      }
      const nowMs = this.now();
      if (session.expiresAt <= nowMs || nowMs >= session.absoluteExpiresAt) {
        throw new CloudStoreError('unauthorized', '登录已到期，请重新登录。');
      }
      if (session.expiresAt - nowMs > CLOUD_SESSION_RENEW_WINDOW_MS) {
        return {
          renewed: false as const,
          account: session.account,
          expiresAt: session.expiresAt,
          absoluteExpiresAt: session.absoluteExpiresAt,
        };
      }
      const result = await this.replaceSession(key, session.account, session.startedAt);
      return { renewed: true as const, ...result };
    });
  }

  private async readStoredSave(key: string, slot: SaveSlotRef): Promise<StoredSave | undefined> {
    let raw: string;
    try { raw = await readFile(this.saveFile(key, slot), 'utf8'); }
    catch { return undefined; }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch { return undefined; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const value = parsed as Partial<StoredSave>;
    if (value.version !== 1 || value.slot !== slot || typeof value.format !== 'number'
      || typeof value.bytes !== 'number' || typeof value.updatedAt !== 'number'
      || !value.summary || typeof value.summary !== 'object' || Array.isArray(value.summary)) return undefined;
    return value as StoredSave;
  }

  private async fileSize(file: string): Promise<number> {
    try { return (await stat(file)).size; }
    catch { return 0; }
  }

  private async accountSaveBytes(key: string): Promise<number> {
    const dir = this.saveDir(key);
    let files: string[];
    try { files = await readdir(dir); }
    catch (error) { if (isMissing(error)) return 0; throw error; }
    let total = 0;
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      total += await this.fileSize(path.join(dir, file));
    }
    return total;
  }

  async listSaves(key: string): Promise<CloudSaveEntry[]> {
    const dir = this.saveDir(key);
    let files: string[];
    try { files = await readdir(dir); }
    catch (error) {
      if (isMissing(error)) return [];
      throw new CloudStoreError('server', '读取云端存档失败。');
    }
    const entries: CloudSaveEntry[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const slot = parseCloudSaveSlotId(file.slice(0, -5));
      if (slot === undefined) continue;
      const stored = await this.readStoredSave(key, slot);
      if (stored) entries.push(entryOf(stored));
    }
    entries.sort((left, right) => right.updatedAt - left.updatedAt);
    return entries;
  }

  async uploadSave(key: string, slot: SaveSlotRef, game: unknown): Promise<CloudSaveEntry> {
    const normalized = normalizeStoredGame(game);
    if (normalized.bytes > CLOUD_SAVE_MAX_BYTES) {
      throw new CloudStoreError('too-large', '存档超过 2 MiB，无法上传。');
    }
    return this.withLock(`saves:${key}`, async () => {
      const existingSize = await this.fileSize(this.saveFile(key, slot));
      const used = await this.accountSaveBytes(key);
      if (used - existingSize + normalized.bytes > this.saveQuotaBytes) {
        throw new CloudStoreError('storage-full', '云端存档空间不足。');
      }
      const stored: StoredSave = {
        version: 1, slot, format: normalized.format, bytes: normalized.bytes, summary: normalized.summary,
        ...(normalized.savedAt !== undefined ? { savedAt: normalized.savedAt } : {}),
        updatedAt: this.now(), game,
      };
      try {
        await mkdir(this.saveDir(key), { recursive: true, mode: 0o700 });
        await atomicWrite(this.saveFile(key, slot), JSON.stringify(stored));
      } catch (error) {
        if (isStorageError(error)) throw new CloudStoreError('storage-full', '云端存档写入失败，空间不足。');
        throw error;
      }
      return entryOf(stored);
    });
  }

  async downloadSave(key: string, slot: SaveSlotRef): Promise<unknown> {
    const stored = await this.readStoredSave(key, slot);
    if (!stored) throw new CloudStoreError('save-not-found', '云端没有这个存档。');
    return stored.game;
  }
}

export function createCloudSaveStore(options: CloudSaveStoreOptions): CloudSaveStore {
  return new CloudSaveStoreImpl(options);
}

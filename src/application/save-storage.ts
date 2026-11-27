import type { SaveStorage } from '../domain/save-game.ts';

const SAVE_DB_NAME = 'inotia4-saves';
const SAVE_DB_VERSION = 1;
const SAVE_STORE_NAME = 'slots';
const DEFAULT_SAVE_PREFIX = 'inotia4.story.v1';
const DEFAULT_OPEN_TIMEOUT_MS = 4_000;

interface LegacyStorageLike {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface IndexedDbSaveStorageOptions {
  indexedDB?: IDBFactory;
  legacyStorage?: LegacyStorageLike;
  prefix?: string;
  dbName?: string;
  openTimeoutMs?: number;
}

function readSavedAt(raw: string): number {
  try {
    const parsed = JSON.parse(raw) as { summary?: { savedAt?: unknown } };
    const savedAt = parsed?.summary?.savedAt;
    return typeof savedAt === 'number' && Number.isFinite(savedAt) ? savedAt : -1;
  } catch {
    return -1;
  }
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 请求失败'));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 事务失败'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 事务中止'));
  });
}

function collectLegacyEntries(storage: LegacyStorageLike | undefined, prefix: string): Map<string, string> {
  const entries = new Map<string, string>();
  if (!storage) return entries;
  const matchPrefix = `${prefix}.`;
  try {
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(matchPrefix)) keys.push(key);
    }
    for (const key of keys) {
      const value = storage.getItem(key);
      if (value !== null) entries.set(key, value);
    }
  } catch {
    // 忽略受限环境对 localStorage 枚举的拦截。
  }
  return entries;
}

/**
 * 浏览器存档存储：内存维护同步镜像以支撑零延迟读槽，持久化落盘到 IndexedDB（突破 localStorage 5 MiB 上限）。
 * 启动预热时一次性把旧版留在 localStorage 里的 `inotia4.story.v1.*` 存档搬入 IndexedDB 并删除旧键腾空配额；
 * 若当前环境禁用或不支持 IndexedDB，则自动退回 localStorage。
 */
export class IndexedDbSaveStorage implements SaveStorage {
  private readonly idbFactory?: IDBFactory;
  private readonly legacy?: LegacyStorageLike;
  private readonly prefix: string;
  private readonly dbName: string;
  private readonly openTimeoutMs: number;
  private readonly memory = new Map<string, string>();
  private readonly committed = new Map<string, string>();
  private readonly dirtyBeforeReady = new Set<string>();
  private readonly latestOp = new Map<string, symbol>();
  private readonly inFlight = new Set<Promise<void>>();
  private readonly inFlightByKey = new Map<string, Promise<void>>();
  private tail: Promise<void> = Promise.resolve();
  private readyPromise?: Promise<void>;
  private db?: IDBDatabase;
  private initialized = false;
  private fallbackToLegacy = false;

  constructor(options: IndexedDbSaveStorageOptions = {}) {
    this.idbFactory = options.indexedDB;
    this.legacy = options.legacyStorage;
    this.prefix = options.prefix ?? DEFAULT_SAVE_PREFIX;
    this.dbName = options.dbName ?? SAVE_DB_NAME;
    this.openTimeoutMs = options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS;
    for (const [key, value] of collectLegacyEntries(this.legacy, this.prefix)) {
      this.memory.set(key, value);
      this.committed.set(key, value);
    }
  }

  ready(): Promise<void> {
    return (this.readyPromise ??= this.initialize());
  }

  flush(key?: string): Promise<void> | undefined {
    if (key !== undefined) {
      return this.inFlightByKey.get(key);
    }
    if (!this.inFlight.size) return undefined;
    const pending = [...this.inFlight];
    return Promise.allSettled(pending).then(results => {
      const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failed) throw failed.reason;
    });
  }

  getItem(key: string): string | null {
    if (this.fallbackToLegacy) {
      return this.legacy ? this.legacy.getItem(key) : (this.memory.get(key) ?? null);
    }
    return this.memory.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.fallbackToLegacy) {
      if (!this.legacy) throw new Error('当前环境不支持本地存档');
      this.legacy.setItem(key, value);
      this.memory.set(key, value);
      this.committed.set(key, value);
      return;
    }
    this.memory.set(key, value);
    if (!this.initialized) this.dirtyBeforeReady.add(key);
    this.scheduleWrite(key, value);
  }

  removeItem(key: string): void {
    if (this.fallbackToLegacy) {
      if (!this.legacy) throw new Error('当前环境不支持本地存档');
      this.legacy.removeItem(key);
      this.memory.delete(key);
      this.committed.delete(key);
      return;
    }
    this.memory.delete(key);
    if (!this.initialized) this.dirtyBeforeReady.add(key);
    this.scheduleWrite(key, null);
  }

  close(): void {
    this.db?.close();
    this.db = undefined;
  }

  private scheduleWrite(key: string, value: string | null): void {
    const token = Symbol(key);
    this.latestOp.set(key, token);
    const syncMemoryIfLatest = () => {
      if (this.latestOp.get(key) !== token) return;
      if (value === null) this.memory.delete(key);
      else this.memory.set(key, value);
    };
    const task = async () => {
      await this.ready();
      if (this.fallbackToLegacy) {
        if (!this.legacy) throw new Error('当前环境不支持本地存档');
        if (value === null) {
          this.legacy.removeItem(key);
          this.committed.delete(key);
        } else {
          this.legacy.setItem(key, value);
          this.committed.set(key, value);
        }
        syncMemoryIfLatest();
        return;
      }
      await this.writeToDb(key, value);
      try {
        this.legacy?.removeItem(key);
      } catch {
        // 忽略受限存储清理失败。
      }
      if (value === null) this.committed.delete(key);
      else this.committed.set(key, value);
      syncMemoryIfLatest();
    };
    const op = this.tail.then(task, task).catch(error => {
      if (this.latestOp.get(key) === token) {
        const previous = this.committed.get(key);
        if (previous === undefined) this.memory.delete(key);
        else this.memory.set(key, previous);
      }
      throw error;
    });
    this.tail = op.then(() => undefined, () => undefined);
    this.inFlight.add(op);
    this.inFlightByKey.set(key, op);
    void op.catch(() => undefined).finally(() => {
      this.inFlight.delete(op);
      if (this.inFlightByKey.get(key) === op) this.inFlightByKey.delete(key);
    });
  }

  private async initialize(): Promise<void> {
    if (!this.idbFactory) {
      this.fallbackToLegacy = true;
      this.initialized = true;
      this.dirtyBeforeReady.clear();
      return;
    }
    let db: IDBDatabase;
    let existing: Map<string, string>;
    try {
      db = await this.openDatabase(this.idbFactory);
      existing = await this.readAllFromDb(db);
    } catch (error) {
      this.fallbackToLegacy = true;
      this.initialized = true;
      this.dirtyBeforeReady.clear();
      globalThis.storyDiagnostics?.record('save-storage-fallback', {
        reason: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    this.db = db;
    const legacyEntries = collectLegacyEntries(this.legacy, this.prefix);
    try {
      for (const [key, value] of existing) {
        this.committed.set(key, value);
        if (!this.dirtyBeforeReady.has(key)) this.memory.set(key, value);
      }
      const migrations = new Map<string, string>();
      for (const [key, legacyRaw] of legacyEntries) {
        if (this.dirtyBeforeReady.has(key)) continue;
        const dbRaw = existing.get(key);
        if (dbRaw === undefined || readSavedAt(legacyRaw) > readSavedAt(dbRaw)) {
          migrations.set(key, legacyRaw);
          this.memory.set(key, legacyRaw);
        }
      }
      if (migrations.size > 0) {
        try {
          const tx = db.transaction(SAVE_STORE_NAME, 'readwrite');
          const store = tx.objectStore(SAVE_STORE_NAME);
          for (const [key, value] of migrations) store.put(value, key);
          await transactionDone(tx);
          for (const [key, value] of migrations) {
            this.committed.set(key, value);
            if (!this.dirtyBeforeReady.has(key) && !this.latestOp.has(key)) {
              this.memory.set(key, value);
            }
          }
        } catch (error) {
          for (const [key, legacyRaw] of migrations) {
            this.committed.set(key, legacyRaw);
            if (!this.dirtyBeforeReady.has(key) && !this.latestOp.has(key)) {
              this.memory.set(key, legacyRaw);
            }
          }
          globalThis.storyDiagnostics?.record('save-storage-migration-failed', {
            reason: error instanceof Error ? error.message : String(error),
          });
          return;
        }
      }
      if (legacyEntries.size > 0 && this.legacy) {
        let removedCount = 0;
        for (const key of legacyEntries.keys()) {
          if (this.dirtyBeforeReady.has(key)) continue;
          try {
            this.legacy.removeItem(key);
            removedCount += 1;
          } catch {
            // 忽略只读或受限存储清理失败。
          }
        }
        if (removedCount > 0) {
          globalThis.storyDiagnostics?.record('save-storage-migrated', { count: removedCount }, false);
        }
      }
    } finally {
      this.initialized = true;
      this.dirtyBeforeReady.clear();
    }
  }

  private async ensureDatabase(): Promise<IDBDatabase> {
    if (this.db) return this.db;
    if (!this.idbFactory) throw new Error('本地存档数据库尚未就绪');
    const db = await this.openDatabase(this.idbFactory);
    this.db = db;
    return db;
  }

  private async writeToDb(key: string, value: string | null): Promise<void> {
    let db = await this.ensureDatabase();
    let tx: IDBTransaction;
    try {
      tx = db.transaction(SAVE_STORE_NAME, 'readwrite');
    } catch (error) {
      if ((error as { name?: string })?.name !== 'InvalidStateError') throw error;
      if (this.db === db) this.db = undefined;
      db = await this.ensureDatabase();
      tx = db.transaction(SAVE_STORE_NAME, 'readwrite');
    }
    const store = tx.objectStore(SAVE_STORE_NAME);
    if (value === null) store.delete(key);
    else store.put(value, key);
    await transactionDone(tx);
  }

  private openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
    return new Promise<IDBDatabase>((resolve, reject) => {
      let settled = false;
      const timer =
        this.openTimeoutMs > 0
          ? setTimeout(() => {
              if (settled) return;
              settled = true;
              reject(new Error('打开本地存档数据库超时'));
            }, this.openTimeoutMs)
          : undefined;
      (timer as { unref?: () => void } | undefined)?.unref?.();
      const finishError = (error: unknown) => {
        if (timer !== undefined) clearTimeout(timer);
        if (settled) return;
        settled = true;
        reject(error);
      };
      let request: IDBOpenDBRequest;
      try {
        request = factory.open(this.dbName, SAVE_DB_VERSION);
      } catch (error) {
        finishError(error);
        return;
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(SAVE_STORE_NAME)) {
          db.createObjectStore(SAVE_STORE_NAME);
        }
      };
      request.onsuccess = () => {
        if (timer !== undefined) clearTimeout(timer);
        const db = request.result;
        if (settled) {
          try { db.close(); } catch {}
          return;
        }
        settled = true;
        db.onversionchange = () => {
          try { db.close(); } catch {}
          if (this.db === db) this.db = undefined;
        };
        (db as IDBDatabase & { onclose?: (() => void) | null }).onclose = () => {
          if (this.db === db) this.db = undefined;
        };
        resolve(db);
      };
      request.onerror = () => finishError(request.error ?? new Error('无法打开本地存档数据库'));
      request.onblocked = () => finishError(new Error('本地存档数据库被阻塞'));
    });
  }

  private async readAllFromDb(db: IDBDatabase): Promise<Map<string, string>> {
    const tx = db.transaction(SAVE_STORE_NAME, 'readonly');
    const store = tx.objectStore(SAVE_STORE_NAME);
    const done = transactionDone(tx);
    const [keys, values] = await Promise.all([
      requestToPromise(store.getAllKeys()),
      requestToPromise(store.getAll()),
      done,
    ]);
    const entries = new Map<string, string>();
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      const value = values[index];
      if (typeof key === 'string' && typeof value === 'string') {
        entries.set(key, value);
      }
    }
    return entries;
  }
}

export function createBrowserSaveStorage(prefix = DEFAULT_SAVE_PREFIX): SaveStorage | undefined {
  const idb = typeof indexedDB !== 'undefined' ? indexedDB : undefined;
  let legacy: LegacyStorageLike | undefined;
  try {
    legacy = typeof localStorage !== 'undefined' ? localStorage : undefined;
  } catch {
    legacy = undefined;
  }
  if (!idb && !legacy) return undefined;
  const storage = new IndexedDbSaveStorage({ indexedDB: idb, legacyStorage: legacy, prefix });
  void storage.ready();
  return storage;
}

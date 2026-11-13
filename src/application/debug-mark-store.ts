import type { DebugMark, DebugMarkStore, DebugMarkSummary } from '../debug/debug-marks.ts';

const DATABASE = 'inotia4.debug-marks.v1';
/** 调试标记库的结构版本；对象仓库或索引变化时加一，打开库时触发升级。 */
const DATABASE_VERSION = 1;
/** 摘要分页：默认一页多少条，以及单页允许的最大条数。 */
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
/** 每次操作结束后关闭连接，不让会话或完整现场留在缓存里。 */
export class IndexedDbDebugMarkStore implements DebugMarkStore {
  private readonly factory: () => IDBFactory | undefined;
  constructor(factory: () => IDBFactory | undefined = () => globalThis.indexedDB) { this.factory = factory; }

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const indexedDB = this.factory();
      if (!indexedDB) { reject(new Error('设备不支持本机调试标记数据库')); return; }
      const request = indexedDB.open(DATABASE, DATABASE_VERSION);
      let blocked = false;
      request.onupgradeneeded = () => {
        const db = request.result;
        const summaries = db.createObjectStore('summaries', { keyPath: 'name' });
        summaries.createIndex('savedAt', 'savedAt');
        db.createObjectStore('bodies', { keyPath: 'summary.name' });
      };
      request.onerror = () => reject(request.error ?? new Error('打开调试标记数据库失败'));
      request.onblocked = () => { blocked = true; reject(new Error('调试标记数据库正在被其他页面升级')); };
      request.onsuccess = () => { if (blocked) request.result.close(); else resolve(request.result); };
    });
  }

  private async transaction<T>(stores: string[], mode: IDBTransactionMode,
    work: (tx: IDBTransaction, result: (value: T) => void) => void): Promise<T> {
    const db = await this.open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction(stores, mode);
        let value: T;
        tx.oncomplete = () => resolve(value);
        tx.onabort = () => reject(tx.error ?? new Error('调试标记写入已取消，原标记保留'));
        tx.onerror = () => { /* abort 才是事务最终结果。 */ };
        try { work(tx, result => { value = result; }); }
        catch (error) { tx.abort(); reject(error); }
      });
    } finally { db.close(); }
  }

  put(mark: DebugMark): Promise<void> {
    return this.transaction(['summaries', 'bodies'], 'readwrite', tx => {
      tx.objectStore('summaries').put(mark.summary);
      tx.objectStore('bodies').put(mark);
    });
  }
  get(name: string): Promise<DebugMark | undefined> {
    return this.transaction(['bodies'], 'readonly', (tx, result) => {
      const request = tx.objectStore('bodies').get(name);
      request.onsuccess = () => result(request.result as DebugMark | undefined);
    });
  }
  list(offset = 0, limit = DEFAULT_PAGE_SIZE): Promise<DebugMarkSummary[]> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE)
      return Promise.reject(new Error(`分页范围无效：offset ≥ 0，limit 为 1–${MAX_PAGE_SIZE}`));
    return this.transaction(['summaries'], 'readonly', (tx, result) => {
      const summaries: DebugMarkSummary[] = [];
      let skipped = false;
      const request = tx.objectStore('summaries').index('savedAt').openCursor(null, 'prev');
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || summaries.length === limit) { result(summaries); return; }
        if (!skipped && offset) { skipped = true; cursor.advance(offset); return; }
        summaries.push(cursor.value as DebugMarkSummary);
        cursor.continue();
      };
    });
  }
  delete(name: string): Promise<void> {
    return this.transaction(['summaries', 'bodies'], 'readwrite', tx => {
      tx.objectStore('summaries').delete(name);
      tx.objectStore('bodies').delete(name);
    });
  }
}

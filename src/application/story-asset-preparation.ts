import type { AssetLease } from './assets.ts';

/** 会话持有一个预取目标；地图场景关闭不会中断它。 */
export class StoryAssetPreparation {
  private entry?: { key: string; map: string; controller: AbortController; task: Promise<void>; lease?: AssetLease; dispose(): void };

  prepare(map: string, key: string, signal: AbortSignal, load: (signal: AbortSignal) => Promise<AssetLease>): Promise<void> {
    signal.throwIfAborted();
    if (this.entry?.key === key) return this.entry.task;
    this.clear();
    const controller = new AbortController();
    const abort = () => { if (this.entry === entry) this.clear(); };
    const entry = { key, map, controller, task: Promise.resolve(), lease: undefined as AssetLease | undefined,
      dispose: () => signal.removeEventListener('abort', abort) };
    this.entry = entry;
    signal.addEventListener('abort', abort, { once: true });
    entry.task = Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return load(controller.signal);
    }).then(lease => {
      if (this.entry !== entry || controller.signal.aborted) lease.release();
      else entry.lease = lease;
    }).catch(error => {
      if (this.entry === entry) this.clear();
      throw error;
    });
    return entry.task;
  }

  async wait(map: string): Promise<void> {
    if (this.entry?.map === map) await this.entry.task.catch(() => {});
  }

  release(map: string): void { if (this.entry?.map === map) this.clear(); }

  clear(): void {
    const entry = this.entry;
    this.entry = undefined;
    if (!entry) return;
    entry.dispose(); entry.controller.abort(); entry.lease?.release();
  }
}

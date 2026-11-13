import type { AssetLease } from './assets.ts';

/** 会话持有一个预取目标；地图场景关闭不会中断它。 */
export class StoryAssetPreparation {
  private preparation?: { key: string; map: string; controller: AbortController; task: Promise<void>; lease?: AssetLease; dispose(): void };

  prepare(map: string, key: string, signal: AbortSignal, load: (signal: AbortSignal) => Promise<AssetLease>): Promise<void> {
    signal.throwIfAborted();
    if (this.preparation?.key === key) return this.preparation.task;
    this.clear();
    const controller = new AbortController();
    const abort = () => { if (this.preparation === preparation) this.clear(); };
    const preparation = { key, map, controller, task: Promise.resolve(), lease: undefined as AssetLease | undefined,
      dispose: () => signal.removeEventListener('abort', abort) };
    this.preparation = preparation;
    signal.addEventListener('abort', abort, { once: true });
    preparation.task = Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return load(controller.signal);
    }).then(lease => {
      if (this.preparation !== preparation || controller.signal.aborted) lease.release();
      else preparation.lease = lease;
    }).catch(error => {
      if (this.preparation === preparation) this.clear();
      throw error;
    });
    return preparation.task;
  }

  async wait(map: string): Promise<void> {
    if (this.preparation?.map === map) await this.preparation.task.catch(() => {});
  }

  release(map: string): void { if (this.preparation?.map === map) this.clear(); }

  clear(): void {
    const preparation = this.preparation;
    this.preparation = undefined;
    if (!preparation) return;
    preparation.dispose(); preparation.controller.abort(); preparation.lease?.release();
  }
}

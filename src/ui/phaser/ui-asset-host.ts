import type Phaser from 'phaser';
import type { AssetLease } from '../../application/assets.ts';
import { domAssets } from '../dom/assets.ts';
import { loadUiImages, uiImageFileNames } from './widgets.ts';

/**
 * 菜单图片的预载与释放。正式 UI 场景持有租约账，菜单预载通过 `app.uiAssets` 读取。
 */
export interface UiAssetHost {
  preloadFiles(files: string[], signal: AbortSignal, progress: (value: number) => void): Promise<void>;
  /** 会话级常驻图：取到后一直留着，回标题不释放。 */
  preloadResident(files: string[], signal: AbortSignal, progress: (value: number) => void): Promise<void>;
  releaseContent(): void;
  releaseResident(): void;
}

/**
 * 把本局立绘记在 `content` 账上，`releaseContent` 一次释放；
 * 菜单框架与标题图记在 `resident` 账上，跟着页面活到游戏销毁。
 */
export class SceneUiAssets implements UiAssetHost {
  private readonly content: AssetLease[] = [];
  private readonly resident: AssetLease[] = [];
  private readonly residentFiles = new Map<string, AbortSignal>();
  private readonly scene: Phaser.Scene;
  constructor(scene: Phaser.Scene) { this.scene = scene; }

  async preloadFiles(files: string[], signal: AbortSignal, progress: (value: number) => void): Promise<void> {
    signal.throwIfAborted();
    const lease = await loadUiImages(this.scene, files, value => { if (!signal.aborted) progress(value); }, signal);
    if (signal.aborted) { lease.release(); signal.throwIfAborted(); }
    this.content.push(lease);
  }

  async preloadResident(files: string[], signal: AbortSignal, progress: (value: number) => void): Promise<void> {
    signal.throwIfAborted();
    const names = uiImageFileNames(files);
    // 去重按去掉前导斜杠的路径；加载仍用原始路径，保证相对/绝对地址不被改写。
    const key = (file: string): string => file.replace(/^\//, '');
    const missing = names.filter(name => {
      const owner = this.residentFiles.get(key(name));
      return !owner || owner.aborted;
    });
    if (!missing.length) { progress(1); return; }
    const lease = await domAssets.preloadFiles(missing, signal, value => { if (!signal.aborted) progress(value); });
    if (signal.aborted) { lease.release(); signal.throwIfAborted(); }
    for (const name of missing) this.residentFiles.set(key(name), signal);
    const retained: AssetLease = { release: () => {
      signal.removeEventListener('abort', retained.release);
      const index = this.resident.indexOf(retained);
      if (index < 0) return;
      this.resident.splice(index, 1);
      for (const name of missing) if (this.residentFiles.get(key(name)) === signal) this.residentFiles.delete(key(name));
      lease.release();
    } };
    this.resident.push(retained);
    signal.addEventListener('abort', retained.release, { once: true });
  }

  /** 单张图（立绘）也走同一本账，和本局内容一起释放。 */
  retain(lease: AssetLease): void { this.content.push(lease); }

  releaseContent(): void { this.content.splice(0).forEach(lease => lease.release()); }

  /** 页面销毁时释放常驻图；场景正常重启不调用。 */
  releaseResident(): void {
    while (this.resident.length) this.resident[0]!.release();
    this.residentFiles.clear();
  }
}

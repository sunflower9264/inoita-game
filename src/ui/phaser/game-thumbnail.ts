import type Phaser from 'phaser';

/**
 * 存档缩略图：从 Phaser 画布截当前游戏画面，等比缩成小 JPEG。
 *
 * 存档页是 DOM 层，Phaser 画布上仍是游戏世界；`renderer.snapshot` 只读画布像素，
 * 所以截到的画面不会带菜单和文字。回调在下一帧渲染完成后才到，调用方需要等待；
 * 超时或环境不支持时返回 `undefined`，保存照常进行，只是没有图片。
 */
export const SAVE_THUMBNAIL_MAX_WIDTH = 360;
export const SAVE_THUMBNAIL_MAX_HEIGHT = 203;
const SAVE_THUMBNAIL_QUALITY = 0.7;
/** 画布快照先按更高画质取原图，缩到存档尺寸后才按 `SAVE_THUMBNAIL_QUALITY` 编码。 */
const SNAPSHOT_QUALITY = 0.9;
const SNAPSHOT_TIMEOUT_MS = 1200;

/** 等比缩到最大宽高内，不放大。 */
export function thumbnailSize(width: number, height: number,
  maxWidth = SAVE_THUMBNAIL_MAX_WIDTH, maxHeight = SAVE_THUMBNAIL_MAX_HEIGHT): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
    return { width: 0, height: 0 };
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function encodeThumbnail(image: HTMLImageElement | Phaser.Display.Color): string | undefined {
  if (typeof document === 'undefined' || !(image instanceof HTMLImageElement)) return;
  const { width, height } = thumbnailSize(image.width, image.height);
  if (!width || !height) return;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return;
  context.drawImage(image, 0, 0, width, height);
  const url = canvas.toDataURL('image/jpeg', SAVE_THUMBNAIL_QUALITY);
  return url.startsWith('data:image/') ? url : undefined;
}

/** 同一局的手动和自动存档共享正在等的画面，以及最近一次成功的截图。 */
export class SaveThumbnails {
  private pending?: { promise: Promise<string | undefined>; cancel(): void };
  private screenshot?: string;
  /** 已排定、还没到渲染回调的 Phaser 快照；换局时连同它一起取消。 */
  private queued?: {
    renderer: Phaser.Renderer.WebGL.WebGLRenderer | Phaser.Renderer.Canvas.CanvasRenderer;
    callback: Phaser.Types.Renderer.Snapshot.SnapshotCallback;
  };

  get latest(): string | undefined { return this.screenshot; }

  reset(): void {
    this.pending?.cancel();
    this.screenshot = undefined;
  }

  /** 清掉还在等下一帧的那次快照，避免换局后仍回读旧画布像素。 */
  private releaseQueuedSnapshot(): void {
    const queued = this.queued;
    this.queued = undefined;
    if (!queued) return;
    // Phaser 的类型把 callback 写成必有函数，运行时初始值是 null；
    // 渲染器在 postRender 里也按 null 表示没有待处理快照。
    const state = queued.renderer.snapshotState as unknown as {
      callback: Phaser.Types.Renderer.Snapshot.SnapshotCallback | null;
    };
    if (state.callback === queued.callback) state.callback = null;
  }

  capture(game: Phaser.Game | undefined, timeoutMs = SNAPSHOT_TIMEOUT_MS): Promise<string | undefined> {
    const renderer = game?.renderer;
    if (!renderer || typeof renderer.snapshot !== 'function') return Promise.resolve(undefined);
    if (this.pending) return this.pending.promise;

    let resolve!: (value?: string) => void;
    const promise = new Promise<string | undefined>(done => { resolve = done; });
    const finish = (value?: string): void => {
      if (this.pending?.promise !== promise) return;
      this.pending = undefined;
      clearTimeout(timer);
      if (value) this.screenshot = value;
      this.releaseQueuedSnapshot();
      resolve(value);
    };
    const cancel = () => finish();
    const timer = setTimeout(cancel, timeoutMs);
    this.pending = { promise, cancel };
    const callback = (image: HTMLImageElement | Phaser.Display.Color): void => {
      if (this.pending?.promise !== promise) return;
      try {
        finish(encodeThumbnail(image));
      } catch {
        cancel();
      }
    };
    this.queued = { renderer, callback };
    try {
      renderer.snapshot(callback, 'image/jpeg', SNAPSHOT_QUALITY);
    } catch {
      cancel();
    }
    return promise;
  }
}

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

/** 同一时间只允许一张在途截图：Phaser 每帧只能挂一个 snapshot。 */
let pending: Promise<string | undefined> | undefined;

export function captureSaveThumbnail(game: Phaser.Game | undefined,
  timeoutMs = SNAPSHOT_TIMEOUT_MS): Promise<string | undefined> {
  if (!game) return Promise.resolve(undefined);
  if (pending) return pending;
  const renderer = game.renderer as Phaser.Renderer.WebGL.WebGLRenderer | undefined;
  if (!renderer || typeof renderer.snapshot !== 'function') return Promise.resolve(undefined);
  pending = new Promise<string | undefined>(resolve => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value?: string): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(value);
    };
    timer = setTimeout(() => finish(undefined), timeoutMs);
    try {
      renderer.snapshot(image => {
        // 超时已经落地时不要再做缩放和 JPEG 编码。
        if (settled) return;
        // 回调参数是 HTMLImageElement；snapshotPixel 才返回 Color，这里不会走到。
        if (typeof document === 'undefined' || !(image instanceof HTMLImageElement)) { finish(undefined); return; }
        try {
          const size = thumbnailSize(image.width, image.height);
          if (!size.width || !size.height) { finish(undefined); return; }
          const canvas = document.createElement('canvas');
          canvas.width = size.width;
          canvas.height = size.height;
          const context = canvas.getContext('2d');
          if (!context) { finish(undefined); return; }
          context.drawImage(image, 0, 0, size.width, size.height);
          const url = canvas.toDataURL('image/jpeg', SAVE_THUMBNAIL_QUALITY);
          finish(url.startsWith('data:image/') ? url : undefined);
        } catch {
          finish(undefined);
        }
      }, 'image/jpeg', SNAPSHOT_QUALITY);
    } catch {
      finish(undefined);
    }
  }).finally(() => { pending = undefined; });
  return pending;
}

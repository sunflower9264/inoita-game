import type Phaser from 'phaser';

/**
 * Phaser 的 WebGL 恢复事件名。
 *
 * 值必须与 `Phaser.Renderer.Events.RESTORE_WEBGL` 一致。这里不运行时导入 Phaser：
 * 本模块会被 Node 单元测试间接加载，Phaser 的浏览器入口在 Node 下没有 `window`。
 */
const RESTORE_WEBGL_EVENT = 'restorewebgl';

interface RendererEvents {
  on?(event: string, listener: () => void): unknown;
  off?(event: string, listener: () => void): unknown;
}

/**
 * 监听 Phaser 的 WebGL 恢复事件。
 *
 * Phaser 会自己重建着色器、缓冲区和已加载图片的纹理；但衣柜用 DynamicTexture
 * 合成的人工外观、滚动区的动态遮罩都只有显存副本，必须由持有者在恢复后重画。
 * 事件名集中在 `RESTORE_WEBGL_EVENT`，别在调用处手写字符串。
 */
export function onWebGLRestore(scene: Phaser.Scene, listener: () => void): () => void {
  const renderer = scene.game?.renderer as unknown as RendererEvents | undefined;
  if (typeof renderer?.on !== 'function') return () => {};
  renderer.on(RESTORE_WEBGL_EVENT, listener);
  return () => renderer.off?.(RESTORE_WEBGL_EVENT, listener);
}

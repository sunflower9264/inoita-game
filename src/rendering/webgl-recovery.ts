import type Phaser from 'phaser';

interface RendererEvents {
  on?(event: string, listener: () => void): unknown;
  off?(event: string, listener: () => void): unknown;
}

/**
 * 监听 Phaser 的 WebGL 恢复事件。
 *
 * Phaser 会自己重建着色器、缓冲区和已加载图片的纹理；但衣柜用 DynamicTexture
 * 合成的人工外观、滚动区的动态遮罩都只有显存副本，必须由持有者在恢复后重画。
 * 事件名来自 `Phaser.Renderer.Events.RESTORE_WEBGL`，值是 `restorewebgl`。
 */
export function onWebGLRestore(scene: Phaser.Scene, listener: () => void): () => void {
  const renderer = scene.game?.renderer as unknown as RendererEvents | undefined;
  if (typeof renderer?.on !== 'function') return () => {};
  renderer.on('restorewebgl', listener);
  return () => renderer.off?.('restorewebgl', listener);
}

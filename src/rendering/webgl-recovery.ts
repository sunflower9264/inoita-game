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
  contextLost?: boolean;
  gl?: Pick<WebGLRenderingContext, 'isContextLost' | 'getParameter' | 'MAX_TEXTURE_SIZE' | 'MAX_RENDERBUFFER_SIZE'>;
}

export function isWebGLContextLost(scene: Phaser.Scene): boolean {
  const renderer = scene.game?.renderer as unknown as RendererEvents | undefined;
  return renderer?.contextLost === true || renderer?.gl?.isContextLost() === true;
}

/** 等引擎重建资源后再合成；超时和场景取消都结束等待。 */
export function waitForWebGLRestore(scene: Phaser.Scene, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (!isWebGLContextLost(scene)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); off(); signal.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); reject(signal.reason); };
    const restored = () => { if (!isWebGLContextLost(scene)) { cleanup(); resolve(); } };
    const off = onWebGLRestore(scene, restored);
    const timer = setTimeout(() => {
      cleanup(); reject(new Error('绘图服务未能恢复，请重新打开游戏后读取存档。'));
    }, 15000);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort(); else restored();
  });
}

/** 合成纹理同时受纹理和绘图缓冲的边长限制。 */
export function webGLTextureLimit(scene: Phaser.Scene): number {
  const renderer = scene.game?.renderer as unknown as RendererEvents | undefined;
  const gl = renderer?.gl;
  if (!gl) return 2048;
  const limits = [gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE)]
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0);
  return Math.min(2048, ...limits);
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

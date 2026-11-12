import type Phaser from 'phaser';
import type { ControlViewport } from '../control-layout.ts';
import { frameRect, readSafeArea } from '../viewport.ts';

/** DOM 安全区以 CSS 像素提供，这里统一换成画框坐标。 */
export function controlViewport(scene: Phaser.Scene, width = scene.scale.width, height = scene.scale.height): ControlViewport {
  const frame = frameRect(), safe = readSafeArea();
  const unitX = width / Math.max(1, frame.width), unitY = height / Math.max(1, frame.height);
  return {width, height, insets: {left: safe.left * unitX, right: safe.right * unitX, top: safe.top * unitY, bottom: safe.bottom * unitY}};
}

/** DOM 控件直接写 CSS 坐标，布局视口也必须用画框的 CSS 尺寸。 */
export function controlViewportCss(_scene: Phaser.Scene): ControlViewport {
  const frame = frameRect();
  const safe = readSafeArea();
  return {
    width: frame.width,
    height: frame.height,
    insets: { left: safe.left, right: safe.right, top: safe.top, bottom: safe.bottom }
  };
}

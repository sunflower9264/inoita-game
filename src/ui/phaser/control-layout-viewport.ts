import type { ControlViewport } from '../control-layout.ts';
import { frameRect, readSafeArea } from '../viewport.ts';

/** 所有屏幕控件共用画框的 CSS 宽高和安全区。 */
export function controlViewport(): ControlViewport {
  const frame = frameRect();
  const safe = readSafeArea();
  return {
    width: frame.width,
    height: frame.height,
    insets: { left: safe.left, right: safe.right, top: safe.top, bottom: safe.bottom }
  };
}

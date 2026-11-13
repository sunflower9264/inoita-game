import type { UiSurface } from './widgets.ts';

/** 四角件宽 24；上边高 27、下边高 26，和四角原始图对齐。 */
const CORNER_WIDTH = 24;
const TOP_EDGE_HEIGHT = 27;
const BOTTOM_EDGE_HEIGHT = 26;

/**
 * 用实心条画的那种边框，原版 `UI_FillBorderRect @0x1438dc`。名字带 Fill，但里面没有填充：
 * 它与 `UI_DrawBorderRect` 的差别只在美术——四角是图组 15 索引 27 左上／28 右上／32 左下／33 右下
 * （24×27 与 24×26），上下边取自 `UI_003.png` 的 (2,483) 那块 361×24 实心横条。
 *
 * 原版在这种框上画的上下边用 `GRPX_DrawPartEx(src(2,483), dst(宽−48, 24))`、左右边另有一块
 * 竖条（源 (289,231)），左右的绘制高度是 `高−53`，所以 53 像素高的标题条上没有左右边——
 * 本作目前只用它画 53 高的标题条（技能页与人物页加点时的属性栏顶条），左右边因此省略。
 *
 * 横条要按四角的高度铺满（上 27、下 26），不能按素材原始高度 24 画：上条只铺到 `y+24` 而四角
 * 到 `y+27`，四角之间就留一条 3 像素的横缝，透出背后的世界画面。素材是纯色横条，纵向拉伸无差别。
 */
export function drawSolidBorder(v: UiSurface, assets: Record<string, string>, x: number, y: number, width: number, height: number): void {
  const span = width - CORNER_WIDTH * 2, right = x + width - CORNER_WIDTH, bottom = y + height - BOTTOM_EDGE_HEIGHT;
  v.image(assets['solid-nw'], x, y, CORNER_WIDTH, TOP_EDGE_HEIGHT);
  v.image(assets['solid-ne'], right, y, CORNER_WIDTH, TOP_EDGE_HEIGHT);
  v.image(assets['solid-sw'], x, bottom, CORNER_WIDTH, BOTTOM_EDGE_HEIGHT);
  v.image(assets['solid-se'], right, bottom, CORNER_WIDTH, BOTTOM_EDGE_HEIGHT);
  v.image(assets['solid-edge'], x + CORNER_WIDTH, y, span, TOP_EDGE_HEIGHT);
  v.image(assets['solid-edge'], x + CORNER_WIDTH, bottom, span, BOTTOM_EDGE_HEIGHT).setFlipY(true);
}

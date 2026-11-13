import type { UiSurface } from './widgets.ts';

/** 四角件的边长；中间四条带和中央块都从它推出。 */
const CORNER_SIZE = 15;
/** 原版九宫格填充色 RGB(111,111,111)。 */
const BAND_COLOR = 0x6f6f6f;
/** 强度按百分比给出，100 表示完全不透明。 */
const FULL_STRENGTH = 100;

/**
 * 压暗的圆角带，原版 `UI_FillRoundRect @0x1434d4`。
 *
 * 四角是图组 15 的四块 15×15 灰色圆角件（索引 68 左上／69 右上／73 左下／74 右下），
 * 中间用 RGB(111,111,111) 填满九宫格：上条 `(x+15, y, 宽−30, 15)`、下条
 * `(x+15, y+高−15, 宽−30, 15)`、左条 `(x, y+15, 15, 高−30)`、右条
 * `(x+宽−15, y+15, 15, 高−30)`、中央 `(x+15, y+15, 宽−30, 高−30)`。五块加四角要正好
 * 铺满整个矩形，少一块就会透出后面的画面。
 *
 * 第 7 个参数是这条带的强度（0–100）：它同时是填充与四角的透明度，也是四角的压暗量
 * （原版把它取反成 `100−强度` 传给 `GRPX_DrawPart` 的最后一个参数，0 表示不压暗）。
 * 人物属性行与队伍页的条带使用强度 50。
 */
export function drawRoundBand(v: UiSurface, assets: Record<string, string>, x: number, y: number, width: number, height: number, strength: number, hole?:{x:number;y:number;width:number;height:number}): void {
  const alpha = strength / FULL_STRENGTH, color = BAND_COLOR, corner = CORNER_SIZE, span = CORNER_SIZE * 2;
  v.image(assets['round-nw'], x, y, corner, corner).setAlpha(alpha);
  v.image(assets['round-ne'], x + width - corner, y, corner, corner).setAlpha(alpha);
  v.image(assets['round-sw'], x, y + height - corner, corner, corner).setAlpha(alpha);
  v.image(assets['round-se'], x + width - corner, y + height - corner, corner, corner).setAlpha(alpha);
  const bands = [
    [x + corner, y, width - span, corner],
    [x + corner, y + height - corner, width - span, corner],
    [x, y + corner, corner, height - span],
    [x + width - corner, y + corner, corner, height - span],
    [x + corner, y + corner, width - span, height - span],
  ];
  for (const [left, top, bandWidth, bandHeight] of bands) {
    const right=left+bandWidth,bottom=top+bandHeight;
    const l=hole?Math.max(left,hole.x):right,r=hole?Math.min(right,hole.x+hole.width):left;
    const t=hole?Math.max(top,hole.y):bottom,b=hole?Math.min(bottom,hole.y+hole.height):top;
    if(l>=r||t>=b){v.rect(left,top,bandWidth,bandHeight,color,alpha);continue;}
    for(const [px,py,w,h] of [[left,top,bandWidth,t-top],[left,b,bandWidth,bottom-b],[left,t,l-left,b-t],[r,t,right-r,b-t]])
      if(w>0&&h>0)v.rect(px,py,w,h,color,alpha);
  }
}

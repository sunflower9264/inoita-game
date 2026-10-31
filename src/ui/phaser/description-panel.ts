import type Phaser from 'phaser';
import type { UiSurface } from './widgets.ts';
import { DESCRIPTION_PANEL, DESCRIPTION_TEXT } from '../bag-layout.ts';
import type { ItemDescriptionRow } from '../item-detail-lines.ts';
import { drawDescriptionText } from './description-text.ts';

/** 面板的关闭矩形；`descriptionPanel(width)` 收窄时它跟着右边缘走。 */
type CloseRect = { close:{x:number; y:number; size:number} };

/**
 * 说明面板自己的底色与图框，物品说明与商品说明共用。
 *
 * 原版 `UIDesc_Draw @0x1486e8` 先在这块矩形上画内缩 10 的黑色底色，再调
 * `UI_DrawBorderRect` 画图框；高度恒为 431，宽度由调用方按它盖住的那一栏给（见 `descriptionPanel`），
 * 底色的不透明度见 `DESCRIPTION_PANEL.backgroundAlpha`。
 * 证据见 `work/findings/desc-panel-2026-10-12.md`。
 */
export function drawDescriptionPanel(v: UiSurface, assets: Record<string, string>, x: number, y: number, width: number,
  height = DESCRIPTION_PANEL.height): void {
  const { inset, background, backgroundAlpha } = DESCRIPTION_PANEL;
  v.rect(x + inset, y + inset, width - inset * 2, height - inset * 2, background, backgroundAlpha);
  v.border(assets, x, y, width, height);
}

/**
 * 面板顶部的物品名。`UIDesc_Draw @0x148874` 把它画在 (面板左+20, 面板顶+22)、左对齐、
 * 占宽 `面板宽−82`（余下的右边留给关闭按钮），字号与商店页分类名同号。
 * 它不属于正文滚动区，所以画在面板上而不是滚动内容里——名字紧贴面板顶，正文从 +60 才开始。
 */
export function drawDescriptionTitle(v: UiSurface, name: string, x: number, y: number, width: number, color: string = DESCRIPTION_TEXT): void {
  const title = DESCRIPTION_PANEL.title;
  v.text(name, x + title.x, y + title.y, Math.max(0, width - title.right), title.size, color);
}

/**
 * 正文与属性块之间那条浅蓝点线：`UI_DrawHDotLine @0x143e78` 以 8 像素为步长画 5 像素一段，
 * 颜色 `#8caace`（`UIDesc_DrawTextScroll @0x145d30` 传的 `0xff8caece`）。
 */
export function drawDescriptionSeparator(v: UiSurface, x: number, y: number, width: number, parent?: Phaser.GameObjects.Container): void {
  for (let offset = 0; offset < width; offset += 8) {
    v.rect(x + offset, y, Math.min(5, width - offset), 1, 0x8caace, 1, parent);
  }
}

/**
 * 说明面板的正文：逐行绘制 `row.parts`。返回正文总高，
 * 调用方接着画宝石图标或底部按钮。背包页与商店共用，保证两处行序与样式一致。
 */
export function drawDescriptionRows(v: UiSurface, rows: ItemDescriptionRow[], width: number, parent?: Phaser.GameObjects.Container): number {
  let y = 0;
  for (const row of rows) y += drawDescriptionText(v, row.parts, 0, y, width, 22, parent) + 5;
  return y;
}

/**
 * 右上角的关闭按钮：`UIDesc_DrawButton @0x145e18` 画图组 15 索引 23，即 `close` 那张
 * 67×67 的圆钮（正是背包页外面那枚关闭菜单的同一张图），落点取面板的 `close` 矩形，
 * 比面板顶边高 6 像素，骑在右上角。按下去时叠的是索引 38 那张橙色圆环，所以高亮也是圆的，
 * 不会在圆钮上罩出一块方块。标签留给键盘与调试用，面板上不画字。
 */
export function drawDescriptionClose(v: UiSurface, assets: Record<string, string>, panel: CloseRect,
  left: number, top: number, action: () => void): void {
  v.button('', left + panel.close.x, top + panel.close.y, panel.close.size, panel.close.size, action,
    { image: assets['close'], pressed: assets['close-pressed'] }).setData('label', '关闭');
}

import type { UiNode } from '../dom/node.ts';
import type { UiSurface } from './widgets.ts';
import { DESCRIPTION_PANEL, DESCRIPTION_TEXT } from '../bag-layout.ts';
import type { ItemDescriptionRow } from '../item-detail-lines.ts';
import type { MenuTextClip, MenuTextWriter } from '../dom/menu-text.ts';
import { layoutDescriptionTextForSurface, writeDescriptionText } from './description-text.ts';

/** 正文行高与行距；断行和 DOM 落字共用。 */
const DESCRIPTION_BODY_SIZE = 22, DESCRIPTION_ROW_GAP = 5;
/** 正文与属性块之间的点线：8 像素一步、每步 5 像素实线，浅蓝色。 */
const DOTTED_LINE_STEP = 8, DOTTED_LINE_DASH = 5, DOTTED_LINE_COLOR = 0x8caace;

/** 面板的关闭矩形；`descriptionPanel(width)` 收窄时它跟着右边缘走。 */
type CloseRect = { close:{x:number; y:number; size:number} };

/** 说明面板改用 DOM 文字时，正文相对内容块的落点和裁剪范围。 */
interface DescriptionDomTarget {
  writer: MenuTextWriter;
  /** 同一页内唯一；页内多份说明用不同前缀。 */
  keyPrefix: string;
  /** 滚动内容原点的内容块坐标。 */
  x: number;
  y: number;
  /** 滚动区名；由 `MenuTextLayer` 按当前偏移重算位置。 */
  scroll?: string;
  /** 滚动视口在内容块坐标里的上下边界。 */
  clip?: MenuTextClip;
}

/**
 * 说明面板自己的底色与图框，物品说明与商品说明共用。
 *
 * 原版 `UIDesc_Draw @0x1486e8` 先在这块矩形上画内缩 10 的黑色底色，再调
 * `UI_DrawBorderRect` 画图框；高度恒为 431，宽度由调用方按它盖住的那一栏给（见 `descriptionPanel`），
 * 底色的不透明度见 `DESCRIPTION_PANEL.backgroundAlpha`。
 * 证据见 `work/findings/desc-panel-2026-10-12.md`。
 */
export function drawDescriptionPanel(v: UiSurface, assets: Record<string, string>, x: number, y: number, width: number,
  height = DESCRIPTION_PANEL.height, backgroundAlpha = DESCRIPTION_PANEL.backgroundAlpha): void {
  const { inset, background } = DESCRIPTION_PANEL;
  v.rect(x + inset, y + inset, width - inset * 2, height - inset * 2, background, backgroundAlpha);
  v.border(assets, x, y, width, height);
}

/**
 * 面板顶部的物品名。`UIDesc_Draw @0x148874` 把它画在 (面板左+20, 面板顶+22)、左对齐、
 * 占宽 `面板宽−82`（余下的右边留给关闭按钮），字号与商店页分类名同号。
 * 它不属于正文滚动区，所以画在面板上而不是滚动内容里——名字紧贴面板顶，正文从 +60 才开始。
 */
export function drawDescriptionTitle(name: string, x: number, y: number, width: number,
  color: string | undefined, dom: Pick<DescriptionDomTarget, 'writer' | 'keyPrefix'>): void {
  const title = DESCRIPTION_PANEL.title;
  const textWidth = Math.max(0, width - title.right);
  dom.writer.add({ key: dom.keyPrefix, text: name, x: x + title.x, y: y + title.y,
    style: { size: title.size, color: color ?? DESCRIPTION_TEXT, anchorX: 0, anchorY: 0, width: textWidth, wrap: 'word' } });
}

/** 物品名按同一宽度断行后的高度；标题换行时调用方把正文滚动区整体下移。 */
function descriptionTitleHeight(v: UiSurface, name: string, width: number): number {
  const title = DESCRIPTION_PANEL.title;
  return layoutDescriptionTextForSurface(v, [{ text: name }], Math.max(0, width - title.right), title.size).height;
}

/**
 * 标题换行后正文区需要下移的距离。
 *
 * 下移不能超过正文区原有高度减 60：极长的名字可以占很多行，若只按标题高度下移，
 * 滚动区会被推到动作按钮和价格带上。夹住之后最坏情况是正文区变矮，底部位置不变。
 */
export function descriptionTitleOverflow(v: UiSurface, name: string, width: number,
  titleY: number, scrollY: number, scrollHeight: number): number {
  const overflow = Math.max(0, titleY + descriptionTitleHeight(v, name, width) - scrollY);
  return Math.min(overflow, Math.max(0, scrollHeight - 60));
}

/**
 * 正文与属性块之间那条浅蓝点线：`UI_DrawHDotLine @0x143e78` 以 8 像素为步长画 5 像素一段，
 * 颜色 `#8caace`（`UIDesc_DrawTextScroll @0x145d30` 传的 `0xff8caece`）。
 */
export function drawDescriptionSeparator(v: UiSurface, x: number, y: number, width: number, parent?: UiNode): void {
  for (let offset = 0; offset < width; offset += DOTTED_LINE_STEP) {
    v.rect(x + offset, y, Math.min(DOTTED_LINE_DASH, width - offset), 1, DOTTED_LINE_COLOR, 1, parent);
  }
}

/**
 * 说明面板的正文：逐行处理 `row.parts` 并返回正文总高，调用方接着画宝石图标或底部按钮。
 * 给出 `dom` 时只把断行结果写成 DOM 标签，图框和滚动仍留在 Phaser；背包页与商店
 * 共用同一次断行和行序，保证两处样式一致。
 */
export function drawDescriptionRows(v: UiSurface, rows: ItemDescriptionRow[], width: number,
  dom: DescriptionDomTarget): number {
  let y = 0;
  rows.forEach((row, index) => {
    // 高度仍按布局阶段的断行结果预留；DOM 只负责按这一份结果落字。
    const layout = layoutDescriptionTextForSurface(v, row.parts, width, DESCRIPTION_BODY_SIZE);
    writeDescriptionText(dom.writer, `${dom.keyPrefix}-${index}`, layout, dom.x, dom.y + y, width, DESCRIPTION_BODY_SIZE,
      dom.scroll, dom.clip);
    y += layout.height + DESCRIPTION_ROW_GAP;
  });
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

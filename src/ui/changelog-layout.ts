/**
 * 标题页更新日志弹窗的几何与可视窗口。
 *
 * 弹窗画在标题页的 1200×640 弹层画布上，用标题页设置页同一张 `slot` 图；
 * 金线在图的四周内缩约 17 像素，按面板显示比例换算后文字区整体让开这条线，
 * 按条目高度只输出屏幕内能看到的几条。
 */
export const CHANGELOG_LAYOUT = {
  /** 更新日志使用标题页的完整宽度；确认框仍使用自己的尺寸。 */
  canvas: { width: 1200, height: 640 },
  /** 弹窗面板：在弹层画布里的外框。 */
  panel: { x: 38, y: 40, width: 1124, height: 560 },
  /** 正文让开图框金线与关闭钮。 */
  scroll: { x: 296, y: 160, width: 810, height: 370 },
  /** 版本列表与正文分别滚动。 */
  versions: { x: 94, y: 160, width: 178, height: 370, rowHeight: 68, buttonHeight: 58 },
  /** 标题中心在正文上方。 */
  titleY: 126,
  /** 右上角圆形关闭钮。 */
  close: { size: 67, right: 44, top: 50 },
  textSize: 24,
  /** 相邻两条更新日志之间的空档。 */
  entryGap: 26,
  /** 视口外多渲染的高度，滚动时不会出现整条空白。 */
  overscan: 320,
} as const;

export interface ChangelogMetrics {
  offsets: number[];
  total: number;
}

/** 根据每条正文的高度算累计起点和总内容高度；条目之间留空档，末尾不留。 */
export function changelogMetrics(heights: readonly number[], gap: number = CHANGELOG_LAYOUT.entryGap): ChangelogMetrics {
  const offsets: number[] = [];
  let total = 0;
  heights.forEach((height, index) => {
    offsets.push(total);
    total += Math.max(1, height);
    if (index < heights.length - 1) total += gap;
  });
  return { offsets, total };
}

/** 当前滚动位置下需要输出的条目范围（含视口外一层缓冲）。 */
export function changelogVisibleRange(offsets: readonly number[], heights: readonly number[],
  scrollTop: number, viewportHeight: number, overscan: number = CHANGELOG_LAYOUT.overscan): { first: number; last: number } {
  if (!heights.length) return { first: 0, last: -1 };
  const top = scrollTop - overscan, bottom = scrollTop + viewportHeight + overscan;
  let first = 0;
  while (first < heights.length && offsets[first]! + heights[first]! <= top) first++;
  let last = first - 1;
  for (let index = first; index < heights.length; index++) {
    if (offsets[index]! >= bottom) break;
    last = index;
  }
  return { first, last };
}

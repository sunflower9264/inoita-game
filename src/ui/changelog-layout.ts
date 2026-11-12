/**
 * 标题页更新日志弹窗的几何与可视窗口。
 *
 * 弹窗画在标题页的 1024×640 弹层画布上，用标题页设置页同一张 `slot` 图；
 * 金线在图的四周内缩约 17 像素，按面板显示比例换算后文字区整体让开这条线，
 * 按条目高度只输出屏幕内能看到的几条。
 */
export const CHANGELOG_LAYOUT = {
  /** 弹窗面板：在 1024×640 弹层画布里的外框。 */
  panel: { x: 82, y: 60, width: 860, height: 520 },
  /** 滚动文字区：让开 slot 的金线和关闭钮，文字不会压到边框。 */
  scroll: { x: 138, y: 180, width: 748, height: 340 },
  /** 标题中心在面板内、金线下方的位置。 */
  titleY: 146,
  /** 右上角圆形关闭钮。 */
  close: { size: 67, right: 44, top: 64 },
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

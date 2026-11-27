import type { DescriptionTextPart } from '../../domain/description-text.ts';
import { layoutDescriptionText } from '../description-text-layout.ts';
import { wrapText } from '../text-layout.ts';
import { DESCRIPTION_TEXT } from '../bag-layout.ts';
import type { MenuTextClip, MenuTextWriter } from '../dom/menu-text.ts';

const DEFAULT_LINE_SPACING = 5;

/** 一段说明的断行结果；行高和总高都由统一字宽与行距公式算出。 */
export interface DescriptionTextLayout {
  lines: { runs: { text: string; color?: string; x: number }[] }[];
  lineHeight: number;
  /** 与 `UiText` 的正文高度同口径：最后一行下面不留行距。 */
  height: number;
}

/** 仅需测多行换行高度时的最小表面接口；优先走 `measureText` 以避免创建探针节点。 */
export interface SurfaceHeightMeasurer {
  measureText?(text: string, size: number): number;
  text(value: string, x: number, y: number, width: number, size: number, color?: string): {
    readonly height: number;
    destroy(): void;
  };
}

/** 支持直接测宽或回退测试探针的表面接口。 */
export interface SurfaceTextMeasurer extends SurfaceHeightMeasurer {
  text(value: string, x: number, y: number, width: number, size: number, color?: string): {
    readonly height: number;
    readonly context: { measureText(text: string): number | { width: number } };
    destroy(): void;
  };
}

/** 计算自动换行后的正文高度；正式环境走 Canvas 测宽，无 `measureText` 的测试替身回退到探针。 */
export function measureWrappedTextHeight(
  view: SurfaceHeightMeasurer,
  value: string,
  width: number,
  size: number,
  color?: string,
  spacing = DEFAULT_LINE_SPACING,
): number {
  if (typeof view.measureText === 'function') {
    const measureText = view.measureText.bind(view);
    const lines = width ? wrapText(value, width, part => measureText(part, size)) : value.split('\n');
    const lineHeight = size + spacing;
    return Math.max(1, lines.length) * lineHeight - spacing;
  }
  const probe = view.text(value, 0, 0, width, size, color);
  try {
    return probe.height;
  } finally {
    probe.destroy();
  }
}

/**
 * 优先走无 DOM 分配的 2D Canvas 测宽；测试替身仅实现 `text()` 探针时自动回退到探针测量，
 * 确保正式运行与无真实 Canvas 的测试保持同一套行高和断行口径。
 */
export function withSurfaceTextMetrics<T>(
  view: SurfaceTextMeasurer,
  size: number,
  use: (measure: (text: string) => number, lineHeight: number) => T,
  spacing = DEFAULT_LINE_SPACING,
): T {
  if (typeof view.measureText === 'function') {
    const measureText = view.measureText.bind(view);
    return use(text => measureText(text, size), size + spacing);
  }
  const probe = view.text('测', 0, 0, 0, size);
  try {
    const measure = (text: string): number => {
      const result = probe.context.measureText(text);
      return typeof result === 'number' ? result : result.width;
    };
    return use(measure, probe.height + spacing);
  } finally {
    probe.destroy();
  }
}

/**
 * 用现有断行器算出每一行和每个色块的位置。
 */
export function layoutDescriptionTextForSurface(view: SurfaceTextMeasurer, parts: readonly DescriptionTextPart[],
  width: number, size: number): DescriptionTextLayout {
  if (!parts.length) return { lines: [], lineHeight: 0, height: 0 };
  return withSurfaceTextMetrics(view, size, (measure, lineHeight) => {
    const lines = layoutDescriptionText(parts, width, measure);
    return { lines, lineHeight, height: Math.max(0, lines.length * lineHeight - DEFAULT_LINE_SPACING) };
  });
}

/**
 * 把断行结果写成 DOM 文字。每个色块单独一条标签，横向位置和行高都沿用布局结果；
 * `clip` 用滚动视口的内容块坐标，滚动时由 `MenuTextLayer` 扣掉偏移后决定显隐。
 */
export function writeDescriptionText(writer: MenuTextWriter, keyPrefix: string, layout: DescriptionTextLayout,
  x: number, y: number, width: number, size: number, scroll?: string, clip?: MenuTextClip): void {
  layout.lines.forEach((line, lineIndex) => line.runs.forEach((run, runIndex) => {
    writer.add({
      key: `${keyPrefix}-${lineIndex}-${runIndex}`,
      text: run.text,
      x: x + run.x,
      y: y + lineIndex * layout.lineHeight,
      // 每个色块只占它在该行里的剩余宽度，避免浏览器量字略宽时越过面板右缘。
      style: { size, color: run.color ?? DESCRIPTION_TEXT, width: Math.max(1, width - run.x),
        lineHeight: layout.lineHeight, wrap: 'word' },
      scroll,
      clip
    });
  }));
}

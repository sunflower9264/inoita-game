import { layoutQuestText, type QuestTextLine } from '../quest-popup-layout.ts';
import { TEXT_COLORS } from '../text-style.ts';
import { withSurfaceTextMetrics, type SurfaceTextMeasurer } from './description-text.ts';

interface QuestTextLayout { lines: QuestTextLine[]; lineHeight: number; height: number }

/** 任务文本的固定行距；菜单与任务窗共用同一行距口径。 */
export const QUEST_LINE_SPACING = 5;

export function measureQuestText(view: SurfaceTextMeasurer, value: string, width: number, size: number): QuestTextLayout {
  if (!value) return { lines: [], lineHeight: 0, height: 0 };
  return withSurfaceTextMetrics(view, size, (measure, lineHeight) => {
    const lines = layoutQuestText(value, width, measure);
    return { lines, lineHeight, height: lines.length * lineHeight - QUEST_LINE_SPACING };
  }, QUEST_LINE_SPACING);
}

/** 任务文本的控制码字色。 */
export const QUEST_TEXT_COLORS = {
  base: TEXT_COLORS.white, title: '#bf0000', target: '#ff0000', person: '#00b4ff', muted: TEXT_COLORS.muted
} as const;

import { layoutQuestText, type QuestTextLine } from '../quest-popup-layout.ts';
import type { UiSurface } from './widgets.ts';
import { TEXT_COLORS } from '../text-style.ts';

interface QuestTextLayout { lines: QuestTextLine[]; lineHeight: number; height: number }

/** 任务文本的固定行距；Phaser 测量和任务窗的浏览器测量共用同一份。 */
export const QUEST_LINE_SPACING = 5;

export function measureQuestText(view: UiSurface, value: string, width: number, size: number): QuestTextLayout {
  if (!value) return { lines: [], lineHeight: 0, height: 0 };
  const probe = view.text('测', 0, 0, 0, size, TEXT_COLORS.white);
  const lines = layoutQuestText(value, width, text => probe.context.measureText(text).width);
  const lineHeight = probe.height + QUEST_LINE_SPACING, height = lines.length * lineHeight - QUEST_LINE_SPACING;
  probe.destroy();
  return { lines, lineHeight, height };
}

/** 任务文本的控制码字色；DOM 输出和 Phaser 输出共用同一张表。 */
export const QUEST_TEXT_COLORS = {
  base: TEXT_COLORS.white, title: '#bf0000', target: '#ff0000', person: '#00b4ff', muted: TEXT_COLORS.muted
} as const;

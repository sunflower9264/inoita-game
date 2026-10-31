import type Phaser from 'phaser';
import { layoutQuestText, type QuestTextLine } from '../quest-popup-layout.ts';
import type { UiSurface } from './widgets.ts';
import { TEXT_COLORS } from '../text-style.ts';

interface QuestTextLayout { lines: QuestTextLine[]; lineHeight: number; height: number }

export function measureQuestText(view: UiSurface, value: string, width: number, size: number): QuestTextLayout {
  if (!value) return { lines: [], lineHeight: 0, height: 0 };
  const probe = view.text('测', 0, 0, 0, size, TEXT_COLORS.white);
  const lines = layoutQuestText(value, width, text => probe.context.measureText(text).width);
  const lineHeight = probe.height + 5, height = lines.length * lineHeight - 5;
  probe.destroy();
  return { lines, lineHeight, height };
}

/** $B 恢复 X_TEXTCTRL 的基础字色；任务窗口的基础色为白色。 */
export function drawQuestText(view: UiSurface, layout: QuestTextLayout, x: number, y: number, width: number,
  size: number, parent: Phaser.GameObjects.Container, centered = false): void {
  const colors = { base: TEXT_COLORS.white, title: '#bf0000', target: '#ff0000', person: '#00b4ff', muted: TEXT_COLORS.muted };
  layout.lines.forEach((line, index) => {
    const offset = centered ? (width - line.width) / 2 : 0;
    for (const run of line.runs) view.text(run.text, x + offset + run.x, y + index * layout.lineHeight, 0, size, colors[run.tone], parent);
  });
}

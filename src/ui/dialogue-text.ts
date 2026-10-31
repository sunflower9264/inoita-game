import { textRuns, visibleIndex } from '../domain/text-markup.ts';
import { wrapText } from './text-layout.ts';
import { layoutKeyedText, type KeyedTextLine, type KeyedTextPart } from './quest-popup-layout.ts';

export interface DialogueTextLayout {
  /** 按显示行分组的带色片段，`x` 是这一行里相对行首的偏移。 */
  lines: KeyedTextLine<string>[];
}

/** 把一段对白按色段摊开；控制码给出的换行转成显式断行。 */
export function dialogueTextParts(value: string, base: string): KeyedTextPart<string>[] {
  const parts: KeyedTextPart<string>[] = [];
  for (const run of textRuns(value, base)) {
    const segments = run.text.split('\n');
    segments.forEach((segment, index) => {
      if (index) parts.push({ break: true });
      if (segment) parts.push({ text: segment, key: run.color });
    });
  }
  while (parts.length && 'break' in parts.at(-1)!) parts.pop();   // 结尾的换行不再补一行空白
  return parts;
}

/** 一页对白：要画的原文片段，以及这一页在原文里消耗到哪儿。 */
export interface DialoguePage {
  /**
   * 本页显示的**原文子串**（逐字显示与跳过都按原文下标记账，所以给的是原文而不是剥离控制码后的文本）。
   * 含本页开头的控制码——它决定这一页首段的字色；不含页尾那个由分页承担的换行。
   */
  text: string;
  /** 本页在传入文本里的结束位置；下一页从这里开始。翻页游标按它推进，不能用 `text.length` 反推。 */
  end: number;
}

/**
 * 对白分页。分页按**可见字符**计量：控制码零宽，既不占行宽也不占字符预算，
 * 且页面边界不会落在控制码中间。
 *
 * 断行沿用 `wrapText`，`&N`／`&P` 变成的 `\n` 是强制换行。页首的换行由分页本身提供，
 * 不再重复占一行。
 *
 * 每页的原文起点记在 `raw` 上，而不是用第一个可见字符的位置：控制码落在页首时，
 * 它必须跟着这一页走（否则首段字色退回基础色），也必须算进这一页消耗掉的原文长度
 * （否则翻页游标会停在控制码中间，翻出空白页）。
 */
export function dialoguePages(value: string, options: { width: number; lines: number; measure: (text: string) => number }): DialoguePage[] {
  const { text, offsets } = visibleIndex(value);
  const pages: DialoguePage[] = [];
  let start = 0;   // 可见文本下标
  let raw = 0;     // 本页在原文里的起点
  while (start < text.length || !pages.length) {
    // 页首换行由分页承担：跳过它，原文起点推到换行码之后（`&N`／`&P` 两字符，字面换行一字符）。
    while (start < text.length && text[start] === '\n') {
      raw = offsets[start] + (value[offsets[start]] === '\n' ? 1 : 2);
      start++;
    }
    let end = start;
    while (end < text.length) {
      const next = end + 1;
      if (next > start && wrapText(text.slice(start, next), options.width, options.measure).length > options.lines) break;
      end = next;
    }
    if (end === start) end = Math.min(text.length, start + 1);      // 单个字符也放不下时至少推进一格
    // 页尾落在换行上时把这一页收在换行之前：那个断行正是分页本身，不该再占一行。
    const last = end > start && text[end - 1] === '\n' ? end - 1 : end;
    pages.push({ text: value.slice(raw, offsets[last]), end: offsets[end] });
    raw = offsets[end];
    start = end;
  }
  return pages;
}

/** 把一页对白排成带色片段；测量函数由调用方提供（浏览器的字体度量）。 */
export function layoutDialogueText(value: string, base: string, width: number,
  measure: (text: string) => number): DialogueTextLayout {
  const lines = layoutKeyedText(dialogueTextParts(value, base), width, measure);
  return { lines };
}

/** 前缀的可见长度——逐字显示到第几个字符。 */
export function revealedRuns(layout: DialogueTextLayout, revealed: number): KeyedTextLine<string>[] {
  let remaining = revealed;
  return layout.lines.map(line => {
    const runs = line.runs.map(run => {
      if (remaining <= 0) return { ...run, text: '' };
      const characters = Array.from(run.text);
      const shown = Math.min(characters.length, remaining);
      remaining -= shown;
      return { ...run, text: characters.slice(0, shown).join('') };
    });
    return { ...line, runs };
  });
}

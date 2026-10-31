/**
 * 原版文本控制码。剧情对白、任务文本和物品说明共用同一套 `X_TEXTCTRL` 标记：
 *
 * - `$A`..`$Y`：切换字色，色表在 `libgame.so` 的 `0xbb9c8`，由
 *   `X_TEXTCTRL_GetColorFromCode@0x144f3c` 读取（原生按 ABGR 存像素，这里已转成 `#rrggbb`）。
 *   见 [任务弹窗的原生绘制](../../../work/findings/quest-popup-ui-2026-10-10.md)。
 * - `$B`：不是色表项，而是**结束带色片段、回到控件的基础色**（`CreateImgString` 的 `$B` 分支）。
 *   基础色随窗口而定：任务窗口是白色，对白框是它自己的字色。
 * - `&N`：显式换行。`&C`：色段锁定，出现在色码之前就锁住那个颜色，直到下一个 `&C`
 *   解锁并回到基础色。两者与 `$` 一样都在 `X_TEXTCTRL_CreateImgString@0x144914` 里
 *   按字符比较（`0x26` = `&`，`0x4e` = `N`，`0x43` = `C`）。
 * - `&P`：**依据弱**。同一个函数里没有 `0x50`（`P`）的比较，所以它不是这个文本控件处理的；
 *   导出侧（`description_text.py`、`parse_eventdata_structured.py`）都把它当换行，这里沿用，
 *   但它到底是段落空行、翻页点还是原样字面量尚未确证。见
 *   [文本控制码](../../../work/findings/184_enemy_defeat_lock_and_prediction_cost_2026-10-16.md) 之外的
 *   [memorytext 调查](../../../work/findings/10_memorytext.md)。
 *
 * 其余 `&X`（内容里出现过 `&R`／`&B`／`&G` 各一次）**不是控制码**，原生会原样显示，
 * 这里也留给文本，不做猜测性解释。
 *
 * 与物品／技能说明的关系：那边在**导出阶段**就把同样这些码解析成 `{text,color}` 段写进内容
 * （`work/tools/game_content/description_text.py`，同一张色表）。剧情对白在运行期解释，
 * 因为 `campaign.json` 的对白是一整串可跳过的文本流，跳过与逐字显示都按字符推进。
 */
export const TEXT_COLOR_CODES: Readonly<Record<string, string>> = {
  A: '#bf0000', C: '#00ff00', D: '#000000', E: '#000000', F: '#000000', G: '#808080',
  H: '#000000', I: '#000000', J: '#000000', K: '#000000', L: '#0012c8', M: '#4eff00',
  N: '#000000', O: '#ff6c00', P: '#ff00c0', Q: '#bd9e6b', R: '#ff0000', S: '#00b4ff',
  T: '#7878ff', U: '#000000', V: '#9c00ff', W: '#ffffff', X: '#000000', Y: '#fcff00',
};

export interface TextRun { text: string; color: string }

const CODE = /(\$[A-Y]|&[NPC]|\n)/g;

/** 基础色缺省为白色——任务窗口的口径；对白框要传自己的字色。 */
const DEFAULT_BASE = '#ffffff';

/** 把一段原版文本切成带颜色的片段；换行以 `\n` 落在片段文本里。 */
export function textRuns(value: string, base: string = DEFAULT_BASE): TextRun[] {
  const runs: TextRun[] = [];
  let color = base, locked = false, lockNext = false;
  const push = (text: string): void => {
    if (!text) return;
    const previous = runs.at(-1);
    if (previous && previous.color === color) previous.text += text;
    else runs.push({ text, color });
  };
  for (const token of (value ?? '').split(CODE)) {
    if (!token) continue;
    if (token === '&C') {
      if (locked) { locked = false; color = base; }
      else lockNext = true;
      continue;
    }
    if (token[0] === '$' && token.length === 2) {
      if (!locked) color = token === '$B' ? base : TEXT_COLOR_CODES[token[1]];
      if (lockNext) { locked = true; lockNext = false; }
      continue;
    }
    push(token === '&N' || token === '&P' ? '\n' : token);
  }
  return runs;
}

/** 去掉控制码之后真正显示出来的文本。 */
export function plainText(value: string): string {
  return textRuns(value).map(run => run.text).join('');
}

/**
 * 可见文本，以及每个可见字符在原文里的起始下标；末尾多一项，指向原文长度。
 * 分页与逐字显示都按可见字符计，控制码不占宽度、也不该被显示。
 */
export function visibleIndex(value: string): { text: string; offsets: number[] } {
  const characters: string[] = [], offsets: number[] = [];
  let raw = 0;
  for (const token of (value ?? '').split(CODE)) {
    if (!token) continue;
    const start = raw; raw += token.length;
    if (token === '&N' || token === '&P') { characters.push('\n'); offsets.push(start); continue; }
    if (token === '&C' || token[0] === '$' && token.length === 2) continue;
    // 同一段里的字符下标各不相同，按 UTF-16 长度逐个推进。
    let offset = start;
    for (const character of Array.from(token)) { characters.push(character); offsets.push(offset); offset += character.length; }
  }
  offsets.push(raw);
  return { text: characters.join(''), offsets };
}

/**
 * 逐字显示用的文本与下标：显式换行**不计**进度。
 *
 * 换行是排版断行，从画第一笔起就摆好了位置，不该像打字一样一个个敲出来；
 * 所以它既不算可见字数，也不会让打字机在换行处停一拍。
 */
export function typedIndex(value: string): { text: string; offsets: number[] } {
  const characters: string[] = [], offsets: number[] = [];
  let raw = 0;
  for (const token of (value ?? '').split(CODE)) {
    if (!token) continue;
    const start = raw; raw += token.length;
    if (token === '&N' || token === '&P' || token === '\n') continue;
    if (token === '&C' || token[0] === '$' && token.length === 2) continue;
    let offset = start;
    for (const character of Array.from(token)) { characters.push(character); offsets.push(offset); offset += character.length; }
  }
  offsets.push(raw);
  return { text: characters.join(''), offsets };
}

export function typedLength(value: string): number {
  return typedIndex(value).text.length;
}

/** 打完第 `count` 个字之后，原文的下标位置。 */
export function typedOffset(value: string, count: number): number {
  const { offsets } = typedIndex(value);
  return offsets[Math.max(0, Math.min(count, offsets.length - 1))];
}

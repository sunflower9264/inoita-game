import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { plainText } from '../src/domain/text-markup.ts';
import { dialoguePages, dialogueTextParts, layoutDialogueText, revealedRuns } from '../src/ui/dialogue-text.ts';

/** 一个字符固定 20px 宽；窄框 + 少行数就能把分页逼到多条。 */
const measure = (text: string): number => Array.from(text).length * 20;
const options = { width: 200, lines: 2, measure };

test('pages break by visible characters and drop the breaks that land on a page edge', () => {
  // 每页 2 行 × 10 字。`&N` 是页内换行，不自己翻页。
  const texts = (value: string) => dialoguePages(value, options).map(page => page.text);
  assert.deepEqual(texts('一二三四五六七八九十'), ['一二三四五六七八九十']);
  assert.deepEqual(texts('一二三四五&N六七八九十'), ['一二三四五&N六七八九十']);
  // 三个段落各占一行，第 3 行放不下才翻页；页尾那个换行由分页承担，下一页开头不留空行。
  const paged = dialoguePages('一二三四五六七八九十&N甲乙丙丁戊己庚辛壬癸&N子丑寅卯辰巳午未申酉', options);
  assert.deepEqual(paged.map(page => plainText(page.text)),
    ['一二三四五六七八九十\n甲乙丙丁戊己庚辛壬癸', '子丑寅卯辰巳午未申酉']);
});

test('each page reports how far into the source it reached', () => {
  // `end` 是翻页游标：它必须盖过这一页吃掉的原文，包括页尾那个被分页承担的换行。
  const text = '一二三四五六七八九十&N甲乙丙丁戊己庚辛壬癸&N子丑寅卯辰巳午未申酉';
  const pages = dialoguePages(text, options);
  assert.deepEqual(pages.map(page => page.end), [22, 34]);
  // 从每一页的 `end` 接着分页，能一路走到原文末尾，不会停在中途。
  let start = 0, rounds = 0;
  while (start < text.length && rounds < 10) { start += dialoguePages(text.slice(start), options)[0]!.end; rounds += 1; }
  assert.equal(start, text.length);
});

test('pages never split a control code and never lose a visible character', () => {
  const text = '$R红字$B普通&N第二段$S名字$B收尾';
  const pages = dialoguePages(text, { width: 60, lines: 2, measure });
  assert.ok(pages.length > 1, '这条应当被分成多页');
  // 只有原生真正处理的码会被吃掉；`&R` 这类不是控制码，原生也原样显示。
  for (const page of pages) assert.equal(/[$][A-Y]|&[NPC]/.test(plainText(page.text)), false, page.text);
  assert.equal(pages.map(page => plainText(page.text)).join('').replace(/\n/g, ''), plainText(text).replace(/\n/g, ''));
});

test('a line that opens with a control code pages without stalling or repeating', () => {
  // 回归：分页曾按 `page.length` 推进游标，比这一页吃掉的原文短两个字符（开头的 `$G`）。
  // 游标停在 `$B` 上，翻出一页空白并卡死；只以控制码开头、结尾无码的行则重复末尾几字。
  const width = 200, lines = 2;
  const cases = ['$G（竟然在执行$R教团任务$G的时候睡着了，看来我还得多练练啊）$B', '$S凯恩$B大人。', '$G（不过..总觉得有什么事即将发生..）$B'];
  for (const text of cases) {
    const pages = dialoguePages(text, { width, lines, measure });
    for (const page of pages) assert.notEqual(plainText(page.text).replace(/\n/g, ''), '', `${text} → 翻出空白页`);
    // 按 `end` 接着翻，能走到原文末尾；把各页可见文本接起来，不多不少。
    let start = 0, rounds = 0; const seen: string[] = [];
    while (start < text.length && rounds < 20) {
      const page = dialoguePages(text.slice(start), { width, lines, measure })[0]!;
      seen.push(plainText(page.text)); start += page.end; rounds += 1;
    }
    assert.equal(start, text.length, `${text} → 没翻到末尾`);
    assert.equal(seen.join('').replace(/\n/g, ''), plainText(text).replace(/\n/g, ''), text);
  }
});

test('layout keeps the native palette and the reveal truncates run by run', () => {
  const layout = layoutDialogueText('$S凯恩$B大人。$R小心$B', '#f5eedf', 400, measure);
  assert.deepEqual(layout.lines.map(line => line.runs.map(run => [run.text, run.key])),
    [[['凯恩', '#00b4ff'], ['大人。', '#f5eedf'], ['小心', '#ff0000']]]);
  // 逐字揭示：只截断每个色段的文字，段落顺序与位置不变。
  const shown = (count: number) => revealedRuns(layout, count).flatMap(line => line.runs.map(run => run.text)).join('');
  assert.equal(shown(0), '');
  assert.equal(shown(2), '凯恩');
  assert.equal(shown(5), '凯恩大人。');
  assert.equal(shown(7), '凯恩大人。小心');
  assert.equal(shown(9), '凯恩大人。小心');
});

test('a wrapped line reports where each colored run starts', () => {
  const layout = layoutDialogueText('$R一二三四$B五六', '#f5eedf', 60, measure);   // 每行 3 字
  assert.deepEqual(layout.lines.map(line => line.runs.map(run => [run.text, run.x])),
    [[['一二三', 0]], [['四', 0], ['五六', 20]]]);
});

test('every marked dialogue line of the real campaign pages without losing a character', () => {
  const campaign = JSON.parse(readFileSync(new URL('../public/content/campaign.json', import.meta.url), 'utf8'));
  const texts: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (!value || typeof value !== 'object') return;
    const node = value as Record<string, unknown>;
    if (node.type === 'dialogue' && typeof node.text === 'string') texts.push(node.text);
    Object.values(node).forEach(walk);
  };
  walk(campaign);
  const marked = texts.filter(text => /[$&][A-Z]/.test(text));
  assert.ok(marked.length > 1000);
  for (const text of marked) {
    const pages = dialoguePages(text, { width: 400, lines: 3, measure });
    for (const page of pages) {
      assert.equal(/[$][A-Y]|&[NPC]/.test(plainText(page.text)), false, `${text} → ${page.text}`);
      assert.deepEqual(dialogueTextParts(page.text, '#f5eedf').filter(part => 'text' in part).map(part => part.text).join(''),
        plainText(page.text).replace(/\n/g, ''), page.text);
    }
    // 每页都得有字可显示：空白页会让翻页停在那儿。
    for (const page of pages) assert.notEqual(plainText(page.text).replace(/\n/g, ''), '', text);
    // 一个字都不能丢或重复：把各页的可见文本接起来，应当等于整行的可见文本。
    assert.equal(pages.map(page => plainText(page.text)).join('').replace(/\n/g, ''), plainText(text).replace(/\n/g, ''), text);
    // 玩家的实际翻页是「取剩余文本的第一页，按 `end` 往前走」（见 `GameUI.dialogue`）：
    // 每一页都得有字，且必须能走到末尾——`rounds` 只是防死循环的上限。
    let start = 0, rounds = 0;
    while (start < text.length && rounds < 64) {
      const page = dialoguePages(text.slice(start), { width: 400, lines: 3, measure })[0]!;
      assert.notEqual(plainText(page.text).replace(/\n/g, ''), '', `${text} → 翻出空白页`);
      start += page.end; rounds += 1;
    }
    assert.equal(start, text.length, text);
  }
});

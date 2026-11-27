import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { textRuns, typedIndex, typedLength, typedOffset, visibleIndex, TEXT_COLOR_CODES } from '../src/domain/text-markup.ts';
import { layoutMarkupText } from '../src/ui/dialogue-text.ts';
import { plainText } from './support/story-fixtures.ts';

/** 选项面板的基础色（`src/ui/widgets.ts` 的 GOLD），$B 回到这里。 */
const CHOICE_GOLD = '#f3deb0';
const measure = (value: string): number => Array.from(value).length * 10;

test('native color codes map to the libgame palette and $B restores the window base color', () => {
  // 色表来自 libgame.so 的 0xbb9c8（X_TEXTCTRL_GetColorFromCode@0x144f3c）。
  assert.equal(TEXT_COLOR_CODES.A, '#bf0000'); assert.equal(TEXT_COLOR_CODES.R, '#ff0000');
  assert.equal(TEXT_COLOR_CODES.S, '#00b4ff'); assert.equal(TEXT_COLOR_CODES.G, '#808080');
  assert.deepEqual(textRuns('$R红$B普通'), [{ text: '红', color: '#ff0000' }, { text: '普通', color: '#ffffff' }]);
  // $B 回到调用方给的基础色，而不是色表里的黑色——对白框的字色不是白的。
  assert.deepEqual(textRuns('$R红$B普通', '#f5eedf'),
    [{ text: '红', color: '#ff0000' }, { text: '普通', color: '#f5eedf' }]);
});

test('explicit breaks and the $C color lock follow the native branches', () => {
  assert.deepEqual(textRuns('上&N下'), [{ text: '上\n下', color: '#ffffff' }]);
  assert.deepEqual(textRuns('上&P下'), [{ text: '上\n下', color: '#ffffff' }]);
  // &C 锁住紧接的那个颜色：后面的色码不再生效，第二个 &C 解锁并回到基础色。
  assert.deepEqual(textRuns('&C$R一直红$G还是红&C$G正常'),
    [{ text: '一直红还是红', color: '#ff0000' }, { text: '正常', color: '#808080' }]);
  // 相邻同色的片段合并成一段，免得画成一堆单字节点。
  assert.deepEqual(textRuns('$R甲乙$R丙'), [{ text: '甲乙丙', color: '#ff0000' }]);
});

test('visible text drops every control code and keeps the breaks', () => {
  assert.equal(plainText('$S凯恩$B大人。'), '凯恩大人。');
  assert.equal(plainText('有消息说那个$R女人$B从这个方向逃了。&N再让她跑了。'), '有消息说那个女人从这个方向逃了。\n再让她跑了。');
  assert.equal(plainText('$G（竟然在执行$R教团任务$G的时候睡着了）$B'), '（竟然在执行教团任务的时候睡着了）');
});

test('choice prompts keep native colors and never draw their control codes', () => {
  // 贝恩的付款选项：$S 蓝、$R 红，$B 回到选项面板的金色，控制码本身不进绘制文本。
  const prompt = '是否向$S贝恩$B支付$R钱$B来打听进入警卫哨所的方法吗？';
  const runs = layoutMarkupText(prompt, CHOICE_GOLD, 1000, measure).lines.flatMap(line => line.runs);
  assert.equal(runs.map(run => run.text).join(''), '是否向贝恩支付钱来打听进入警卫哨所的方法吗？');
  assert.ok(!runs.some(run => /[$&]/.test(run.text)), '控制码不显示给玩家');
  assert.equal(runs.find(run => run.text.includes('贝恩'))?.key, '#00b4ff');
  assert.equal(runs.find(run => run.text.includes('钱'))?.key, '#ff0000');
  assert.equal(runs.find(run => run.text.startsWith('来打听'))?.key, CHOICE_GOLD, '$B 回到选项基础色');
  assert.equal(runs.find(run => run.text.startsWith('是否向'))?.key, CHOICE_GOLD, '没写色码的文字保持原观感');
});

test('choice prompt breaks from &N stay inside their own colored line', () => {
  const lines = layoutMarkupText('$R第一行$B&N第二行', CHOICE_GOLD, 1000, measure).lines;
  assert.deepEqual(lines.map(line => line.runs.map(run => run.text).join('')), ['第一行', '第二行']);
  assert.equal(lines[0]!.runs[0]!.key, '#ff0000');
  assert.equal(lines[1]!.runs[0]!.key, CHOICE_GOLD);
  // 控制码不占宽度：同样的可见文字在窄宽度下仍按字符正常换行。
  const wrapped = layoutMarkupText('$R甲乙丙丁$B', CHOICE_GOLD, 15, measure);
  assert.equal(wrapped.lines.map(line => line.runs.map(run => run.text).join('')).join(''), '甲乙丙丁');
  assert.ok(wrapped.lines.length > 1);
});

test('visible offsets round-trip on every marked line of the real campaign', () => {
  // 逐字显示与分页都按可见字符推进，再换算回原文下标取子串。这条不变量一旦破了，
  // 打字机会停在半个控制码上、或者把 $ 显示出来。
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
  assert.ok(marked.length > 1000, `带控制码的对白只有 ${marked.length} 条，内容可能没加载对`);
  for (const text of marked) {
    // 分页口径：可见文本连换行一起，和去掉控制码的结果逐字相同。
    const { text: visible, offsets } = visibleIndex(text);
    assert.equal(offsets.length, visible.length + 1, text);
    assert.equal(offsets.at(-1), text.length, text);
    assert.equal(plainText(text), visible, text);
    for (let index = 1; index < offsets.length; index++) assert.ok(offsets[index]! >= offsets[index - 1]!, text);

    // 逐字口径：换行不占进度。按「打出来的字数」取原文前缀，再数一遍必须还是这个数。
    const typed = typedIndex(text);
    assert.equal(typed.text, visible.replace(/\n/g, ''), text);
    assert.equal(typedLength(text), typed.text.length, text);
    for (const count of [0, 1, Math.floor(typed.text.length / 2), typed.text.length]) {
      const raw = text.slice(0, typedOffset(text, count));
      assert.equal(typedLength(raw), count, `${text} 进度 ${count}`);
      assert.equal(typedIndex(raw).text, typed.text.slice(0, count), `${text} 前缀 ${count}`);
    }
  }
});

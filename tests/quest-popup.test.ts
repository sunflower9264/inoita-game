import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { moneyText, splitMoney } from '../src/domain/money.ts';
import { layoutQuestText, questPopupContent, questPopupLayout } from '../src/ui/quest-popup-layout.ts';

const textLines = (value: string, width: number) => layoutQuestText(value, width, text => Array.from(text).length)
  .map(line => line.runs.map(run => run.text).join(''));

test('quest colors share line measurement and keep closing punctuation with the preceding text', () => {
  const marked = '团长$S卓拉德$B命令：$R刺杀伯爵$B。';
  assert.deepEqual(textLines(marked, 6), textLines('团长卓拉德命令：刺杀伯爵。', 6));
  assert.deepEqual(textLines('$R刺杀伯爵$B。', 4), ['刺杀伯', '爵。']);
  assert.deepEqual(textLines('去见（团长）。', 3), ['去见', '（团', '长）。']);
  assert.deepEqual(textLines('前往。&N&N回来。', 10), ['前往。', '', '回来。']);
});

test('colored runs use whole-prefix widths so font kerning does not accumulate measurement drift', () => {
  const measure = (value: string) => value === 'AV' ? 1.5 : value.length;
  const lines = layoutQuestText('A$RV$B。', 2.5, measure);
  assert.deepEqual(lines.map(line => line.runs.map(run => run.text).join('')), ['A', 'V。']);
  const singleLine = layoutQuestText('A$RV$B!', 4, measure)[0];
  assert.equal(singleLine.runs[2].x, 1.5);
  assert.equal(singleLine.runs[2].tone, 'base');
});

test('acceptance shows objectives, completion shows only the received rewards', () => {
  const quest = { title: '暗杀伯爵', description: '去$R消灭伯爵$B。' };
  assert.deepEqual(questPopupContent('start', quest, undefined, id => id), {
    heading: '$A<暗杀伯爵>$B 获得', body: '去$R消灭伯爵$B。', money: 0,
  });
  assert.deepEqual(questPopupContent('complete', quest, {
    experience: 150, money: 10, items: [{ item: 'dagger', quantity: 1 }, { item: 'potion', quantity: 2 }],
  }, id => id === 'dagger' ? '短剑' : '药水'), {
    heading: '$A<暗杀伯爵>$B 完成', body: '经验值: 150\n短剑\n药水 ×2', money: 10,
  });
  assert.equal(questPopupContent('complete', quest, { experience: 0, money: 0, items: [] }, id => id).body, '');
});

test('native minimum height and content growth are preserved before browser scroll constraints', () => {
  const short = questPopupLayout('start', 30, 80, false);
  assert.equal(short.nativeHeight, 350);
  assert.equal(short.height, 350);
  assert.equal(short.x + short.width / 2, 400);
  assert.equal(short.y + short.height / 2, 240);
  const long = questPopupLayout('start', 30, 300, false);
  assert.equal(long.nativeHeight, 465);
  assert.equal(long.height, 364);
  assert.equal(long.y - 46, 12);
  assert.equal(long.bodyY + long.bodyHeight, long.buttonY - 20);
  assert.equal(questPopupLayout('complete', 30, 200, true).nativeHeight, 397);
  assert.equal(questPopupLayout('complete', 30, 200, false).nativeHeight, 365);
});

test('fusion quest details show the repeat note without angle brackets', () => {
  const campaign = JSON.parse(readFileSync(new URL('../public/content/campaign.json', import.meta.url), 'utf8'));
  const machines = campaign.quests.filter((quest: { giver?: string }) => quest.giver?.startsWith('fusion-machine'));
  assert.equal(machines.length, 11);
  for (const quest of machines) for (const field of ['description', 'progressText'] as const) {
    const text: string = quest[field];
    assert.ok(!/[<>]/.test(text), `${quest.id}/${field} 不应含尖括号：${text}`);
    assert.match(text, /^\$R(这是重复任务。|可重复任务。)\$B/);
  }
});

test('money uses copper units with original 100 and 10000 thresholds and display limit', () => {
  assert.deepEqual(splitMoney(10), { gold: 0, silver: 0, copper: 10 });
  assert.deepEqual(splitMoney(100), { gold: 0, silver: 1, copper: 0 });
  assert.deepEqual(splitMoney(10_101), { gold: 1, silver: 1, copper: 1 });
  assert.deepEqual(splitMoney(100_000_000), { gold: 9999, silver: 99, copper: 99 });
  assert.deepEqual(splitMoney(-1), { gold: 0, silver: 0, copper: 0 });
  assert.equal(moneyText(0), '0铜');
  assert.equal(moneyText(15), '15铜');
  assert.equal(moneyText(720), '7银20铜');
  assert.equal(moneyText(10_101), '1金1银1铜');
});

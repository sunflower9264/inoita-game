import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { questTextParts } from '../src/domain/quest-text.ts';

test('original quest color and line controls preserve visible wording', () => {
  const source = '团长$S卓拉德$B命令：$R刺杀伯爵$B。&N回去复命。';
  assert.deepEqual(questTextParts(source), [
    { text: '团长', tone: 'base' }, { text: '卓拉德', tone: 'person' },
    { text: '命令：', tone: 'base' }, { text: '刺杀伯爵', tone: 'target' },
    { text: '。', tone: 'base' }, { break: true }, { text: '回去复命。', tone: 'base' },
  ]);
  assert.equal(questTextParts(source).map(part => 'break' in part ? '\n' : part.text).join(''),
    '团长卓拉德命令：刺杀伯爵。\n回去复命。');
});

test('completed paragraph color stays locked across inline targets and restores after its closing control', () => {
  assert.deepEqual(questTextParts('&C$G[完成]&N找$S贝伦多$B，去$R教会$B。&C&N$S已达成$B继续'), [
    { text: '[完成]', tone: 'muted' }, { break: true }, { text: '找', tone: 'muted' },
    { text: '贝伦多', tone: 'muted' }, { text: '，去', tone: 'muted' }, { text: '教会', tone: 'muted' },
    { text: '。', tone: 'muted' }, { break: true }, { text: '已达成', tone: 'person' }, { text: '继续', tone: 'base' },
  ]);
});

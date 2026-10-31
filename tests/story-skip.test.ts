import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { StoryDirector, type StoryUI } from '../src/domain/story-director.ts';
import { Session } from '../src/domain/session.ts';
import { compileScript } from './support/story-fixtures.ts';
import type { Campaign } from '../src/domain/campaign.ts';
import type { ChoiceOption } from '../src/domain/content.ts';
import { parseCampaign, parseControlSkin } from '../src/application/content-validation.ts';

const campaign = parseCampaign(JSON.parse(fs.readFileSync(new URL('../public/content/campaign.json', import.meta.url), 'utf8')));
function harness(content: Campaign = campaign) {
  const session = new Session(content), lines: string[] = [], locks: boolean[] = [];
  let finish: (() => void) | undefined, choose: ((option: ChoiceOption) => void) | undefined;
  let cancel: (() => void) | undefined;
  const ui: StoryUI = {
    dialogue: (line, signal) => new Promise<void>((resolve, reject) => {
      lines.push(line.text);
      const abort = () => { clean(); reject(new DOMException('cancelled', 'AbortError')); };
      const clean = () => { signal?.removeEventListener('abort', abort); finish = undefined; cancel = undefined; };
      finish = () => { clean(); resolve(); }; cancel = abort;
      signal?.addEventListener('abort', abort, { once: true });
    }),
    choice: () => new Promise(resolve => { choose = resolve; }),
    async questPopup() {},
    skipDialogue: () => finish?.(), closeDialogue: () => cancel?.(), toast() {}
  };
  const director = new StoryDirector(content, session, ui, value => locks.push(value), { begin() {}, async execute() {}, async finish() {} });
  return { director, session, lines, locks, finish: () => finish?.(), choose: (option: ChoiceOption) => choose!(option) };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
test('skip stops at choices, resumes selected lines normally and preserves completion flags', async () => {
  const option = { label: '继续', value: 'go', lines: [{ speaker: '', actor: null, text: '选项后的对白' }] };
  const h = harness({ ...campaign, scripts: { ...campaign.scripts, demo: compileScript('demo', [
    { type: 'dialogue', speaker: '', actor: null, text: '第一句' }, { type: 'dialogue', speaker: '', actor: null, text: '第二句' },
    { type: 'choice', prompt: '选择', options: [option] }, { type: 'dialogue', speaker: '', actor: null, text: '最后一句' }
  ]) } });
  const result = h.director.trigger({ id: 'demo-trigger', script: 'demo', map: 'shadow-camp', x: 0, y: 0, width: 10, height: 10 });
  await tick();
  h.director.skip(); await tick();
  assert.deepEqual(h.lines, ['第一句']); assert.equal(h.director.busy, true);
  h.director.skip(); h.choose(option); await tick();
  assert.deepEqual(h.lines, ['第一句', '选项后的对白']);
  h.director.skip(); assert.equal(await result, true);
  assert.equal(h.session.flags.has('choice:demo:go'), true);
  assert.equal(h.session.flags.has('demo-trigger'), true);
  assert.deepEqual(h.locks, [true, false]);
  const replay = h.director.run(() => h.director.script('demo'));
  await tick();
  assert.equal(h.lines.at(-1), '第一句'); h.director.cancel(); assert.equal(await replay, false);
});
test('cancelling playback does not mark a skipped trigger complete or carry skip into the next run', async () => {
  const h = harness({ ...campaign, scripts: { ...campaign.scripts, demo: compileScript('demo', [{ type: 'dialogue', speaker: '', actor: null, text: '一句' }, { type: 'dialogue', speaker: '', actor: null, text: '两句' }]) } });
  const trigger = { id: 'cancelled', script: 'demo', map: 'shadow-camp', x: 0, y: 0, width: 10, height: 10 };
  const first = h.director.trigger(trigger); await tick(); h.director.skip(); h.director.cancel();
  assert.equal(await first, false); assert.equal(h.session.flags.has(trigger.id), false);
  const second = h.director.trigger(trigger); await tick(); assert.deepEqual(h.lines, ['一句', '一句']);
  h.finish(); await tick(); assert.equal(h.lines.at(-1), '两句'); h.finish(); assert.equal(await second, true);
});
test('shared control skin rejects missing or external images', () => {
  const skin = JSON.parse(fs.readFileSync(new URL('../public/content/control-skin.json', import.meta.url), 'utf8'));
  parseControlSkin(skin); delete skin['skip-pressed']; assert.throws(() => parseControlSkin(skin), /skip-pressed/);
  skin['skip-pressed'] = 'https://example.com/icon.png'; assert.throws(() => parseControlSkin(skin), /内部资源/);
});

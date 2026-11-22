import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { Campaign } from '../src/domain/campaign.ts';
import { questJournal } from '../src/domain/quest-journal.ts';
import { Session } from '../src/domain/session.ts';
import { StoryDirector, type StoryUI } from '../src/domain/story-director.ts';
import type { StoryStage } from '../src/domain/story-performance.ts';
import { stageSnapshot } from './helpers/story-stage.ts';

const campaign: Campaign = JSON.parse(readFileSync(new URL('../public/content/campaign.json', import.meta.url), 'utf8'));
const world = JSON.parse(readFileSync(new URL('../public/content/world.json', import.meta.url), 'utf8'));
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

/** 等剧情真正停下：既有运行时锁，也没有待处理的发生。 */
async function settle(director: StoryDirector): Promise<void> {
  for (let step = 0; step < 2000; step++) {
    await tick();
    if (!director.busy && !director.runtime.snapshot().pendingOccurrences.length) {
      await tick(); await tick();
      if (!director.busy && !director.runtime.snapshot().pendingOccurrences.length) return;
    }
  }
  throw new Error('剧情没有在预期步数内停下');
}

const stage: StoryStage = { type: 'stage', map: 'shadow-camp', x: 392, y: 328, facing: 'south', playerVisible: true, cast: [] };
const presentation = {
  begin() {}, async execute() {}, async finish() {}, async release() {},
  getStageState() { return stageSnapshot(stage); }, getWorldChanges() { return []; },
};

test('同一个选择值连续出现两次时，重复事件执行两次，一次性事件只执行一次', async () => {
  const content: Campaign = {
    version: 2, contentVersion: 1,
    start: { map: 'demo', x: 0, y: 0, actor: 'hero', facing: 'south', script: 'teach' },
    quests: [], questGroups: [], placements: [],
    scripts: {
      teach: { entry: 'done', nodes: [{ id: 'done', presentation: [], commands: [], exit: { type: 'end' } }] },
      once: { entry: 'done', nodes: [{ id: 'done', presentation: [], commands: [], exit: { type: 'end' } }] },
    },
    events: [
      { id: 'repeat-choice', source: 'choice', key: 'lesson', script: 'teach', repeat: true, place: { type: 'current' },
        condition: { type: 'choice', choice: 'lesson', value: 'same' } },
      { id: 'once-choice', source: 'choice', key: 'once', script: 'once', place: { type: 'current' },
        condition: { type: 'choice', choice: 'once', value: 'same' } },
    ],
  };
  const session = new Session(content);
  const ui: StoryUI = { async dialogue() {}, async choice(_prompt, options) { return options[0]; },
    async questPopup() {}, toast() {}, closeDialogue() {}, skipDialogue() {} };
  const director = new StoryDirector(content, session, ui, () => {});
  const completed: string[] = [];
  director.onEventCompleted = id => completed.push(id);
  try {
    for (let index = 0; index < 2; index++) {
      session.applyStoryCommands([{ type: 'choice', choice: 'lesson', value: 'same' }]);
      await settle(director);
      session.applyStoryCommands([{ type: 'choice', choice: 'once', value: 'same' }]);
      await settle(director);
    }
    assert.equal(completed.filter(id => id === 'repeat-choice').length, 2, '重复事件每次选择都要执行');
    assert.equal(completed.filter(id => id === 'once-choice').length, 1, '一次性事件不能被重复执行');
  } finally { director.dispose(); }
});

test('刺杀伯爵后连续选同一个教学选项，仍能接取下一段主线', async () => {
  const picks = ['option-0', 'option-0', 'option-3'];
  const ui: StoryUI = {
    async dialogue() {},
    async choice(_prompt, options) {
      const value = picks.shift();
      if (!value) throw new Error('多出了一次选项菜单');
      const option = options.find(candidate => candidate.value === value);
      assert.ok(option, `菜单里没有 ${value}`);
      return option;
    },
    async questPopup() {}, toast() {}, closeDialogue() {}, skipDialogue() {},
  };
  const session = new Session(campaign);
  session.accept('grafton-mission');
  session.enemyDefeated({ id: 'earl', enemyId: 'enemy-earl-grafton-1', x: 0, y: 0 });
  session.applyStoryCommands([{ type: 'travel', destination: { map: 'shadow-camp', x: 392, y: 328, facing: 'south' } }]);
  const director = new StoryDirector(campaign, session, ui, () => {}, presentation);
  try {
    await director.interact({ id: 'quest-npc-located-npc-40', actor: 'darius', characterId: 'npc-40', x: 392, y: 328 }, world.actors.darius);
    await settle(director);
    assert.equal(picks.length, 0, '最后一次选择应当直接结束教学，而不是继续弹菜单');
    assert.equal(session.status('cardinal-summons'), 'ready');
    assert.equal(director.runtime.eventStatus('event-411'), 'completed');
    assert.deepEqual(questJournal(campaign, session.quests).flatMap(group => group.entries.map(entry => entry.quest.id)),
      ['cardinal-summons'], '任务列表里要有下一段主线');
  } finally { director.dispose(); }
});

test('记忆层再次选择同一个目的地时，会重新接取对应任务', async () => {
  const ui: StoryUI = {
    async dialogue() {},
    async choice(_prompt, options) { return options[0]; },
    async questPopup() {}, toast() {}, closeDialogue() {}, skipDialogue() {},
  };
  const session = new Session(campaign);
  const director = new StoryDirector(campaign, session, ui, () => {}, presentation);
  try {
    session.applyStoryCommands([{ type: 'choice', choice: 'choice-17', value: 'option-0' }]);
    await settle(director);
    assert.equal(session.status('quest-374'), 'active');

    session.bag.add('memory-pieces', 999);
    for (const id of ['quest-374', 'quest-373', 'quest-372', 'quest-399'])
      session.applyStoryCommands([{ type: 'quest', command: { type: 'script-complete', quest: id } }]);
    session.applyStoryCommands([{ type: 'travel', destination: { map: 'kiyan-s-memory-layer-1-631d46d8', x: 232, y: 200, facing: 'south' } }]);
    await settle(director);
    assert.deepEqual(questJournal(campaign, session.quests), []);

    assert.equal(await director.notify('near', 'npc-598', 'kiyan-s-memory-layer-1-631d46d8'), true);
    await settle(director);
    for (const id of ['quest-374', 'quest-373', 'quest-372'])
      assert.ok(['active', 'ready'].includes(session.status(id)), `${id} 应当重新接取`);
    assert.ok(questJournal(campaign, session.quests).length > 0, '任务列表不能一直空着');
  } finally { director.dispose(); }
});

test('选择命令所在批次失败并回滚后，不会留下假的选择事件', async () => {
  const content: Campaign = {
    version: 2, contentVersion: 1,
    start: { map: 'demo', x: 0, y: 0, actor: 'hero', facing: 'south', script: 'teach' },
    quests: [], questGroups: [], placements: [],
    scripts: { teach: { entry: 'done', nodes: [{ id: 'done', presentation: [], commands: [], exit: { type: 'end' } }] } },
    events: [{ id: 'repeat-choice', source: 'choice', key: 'lesson', script: 'teach', repeat: true, place: { type: 'current' },
      condition: { type: 'choice', choice: 'lesson', value: 'same' } }],
  };
  const session = new Session(content);
  const ui: StoryUI = { async dialogue() {}, async choice(_prompt, options) { return options[0]; },
    async questPopup() {}, toast() {}, closeDialogue() {}, skipDialogue() {} };
  const director = new StoryDirector(content, session, ui, () => {});
  const completed: string[] = [];
  director.onEventCompleted = id => completed.push(id);
  try {
    assert.throws(() => session.applyStoryCommands([
      { type: 'choice', choice: 'lesson', value: 'same' },
      { type: 'money-take', amount: 1, allowPartial: false },
    ]), /剧情金币不足/);
    await settle(director);
    assert.deepEqual(completed, [], '失败的批次不能派发选择事件');
    session.applyStoryCommands([{ type: 'choice', choice: 'lesson', value: 'same' }]);
    await settle(director);
    assert.deepEqual(completed, ['repeat-choice'], '回滚后重新选择仍要正常触发');
  } finally { director.dispose(); }
});

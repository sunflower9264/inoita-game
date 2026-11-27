import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { Campaign } from '../src/domain/campaign.ts';
import { Session } from '../src/domain/session.ts';
import { StoryDirector, type StoryUI } from '../src/domain/story-director.ts';

const campaign = JSON.parse(readFileSync(new URL('../public/content/campaign.json', import.meta.url), 'utf8')) as Campaign;
const ui: StoryUI = { async dialogue() {}, async choice(_prompt, options) { return options[0]; },
  async questPopup() {}, closeDialogue() {}, skipDialogue() {} };
const presentation = { begin() {}, async execute() {}, async finish() {}, async release() {} };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('held triggers reject notify and trigger without starting playback', async () => {
  const session = new Session(campaign);
  const director = new StoryDirector(campaign, session, ui, () => {}, presentation);
  director.holdTriggers();
  assert.equal(director.busy, false, '触发保持不算忙碌，调试流程仍可继续设置状态');
  assert.equal(await director.notify('start'), false);
  assert.equal(await director.trigger({ id: 'event-5', script: 'event-5' }), false);
  assert.equal(director.busy, false);
  director.releaseTriggers();
  director.dispose();
});

test('changes observed while held update the observation tables without dispatching later', async () => {
  const session = new Session(campaign);
  const director = new StoryDirector(campaign, session, ui, () => {}, presentation);
  let dispatched = 0;
  director.notify = () => { dispatched++; return Promise.resolve(false); };

  director.holdTriggers();
  assert.equal(session.accept('grafton-mission'), true);
  await tick();
  assert.equal(dispatched, 0, '触发保持期间不开演');

  // 观察表在保持期间已经更新：恢复后再发一次没有变化的通知，不能补演保持期间的任务变化。
  director.releaseTriggers();
  session.emit();
  await tick();
  assert.equal(dispatched, 0, '保持期间的变化不会在恢复后补派发');

  // 恢复后的新变化照常派发。
  assert.equal(session.accept('cardinal-summons'), true);
  await tick();
  assert.ok(dispatched > 0, '恢复后新变化重新派发');
  director.dispose();
});

test('holding clears triggers already deferred behind a manual playback', () => {
  const session = new Session(campaign);
  const director = new StoryDirector(campaign, session, ui, () => {}, presentation);
  const internals = director as unknown as { deferredTriggers: (() => void)[] };
  let ran = false;
  internals.deferredTriggers.push(() => { ran = true; });
  director.holdTriggers();
  assert.equal(internals.deferredTriggers.length, 0);
  assert.equal(ran, false);
  director.dispose();
});

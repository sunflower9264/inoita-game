import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { Campaign } from '../src/domain/campaign.ts';
import { Session } from '../src/domain/session.ts';
import { StoryDirector, type StoryUI } from '../src/domain/story-director.ts';

const campaign = JSON.parse(readFileSync(new URL('../public/content/campaign.json', import.meta.url), 'utf8')) as Campaign;
const ui: StoryUI = { async dialogue() {}, async choice(_prompt, options) { return options[0]; }, async questPopup() {}, closeDialogue() {}, skipDialogue() {} };
const presentation = { begin() {}, async execute() {}, async finish() {}, async release() {} };

/** 统计 `Session.quests` 被读了几次：每读一次都要克隆并序列化整本任务簿的状态。 */
function countQuestReads(session: Session) {
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(session), 'quests')!;
  let reads = 0;
  Object.defineProperty(session, 'quests', { configurable: true, get() { reads++; return descriptor.get!.call(session); } });
  return () => reads;
}

test('quest observation reuses the quest book version instead of re-reading every quest', () => {
  const session = new Session(campaign), director = new StoryDirector(campaign, session, ui, () => {}, presentation);
  const reads = countQuestReads(session);
  session.emit();                       // 预热：先让任务投影与版本稳定下来
  const base = reads();
  // 与任务无关的通知（血量、金币、位置……频率远高于任务变化）不该重新采集任务状态。
  for (let index = 0; index < 10; index++) session.emit();
  assert.equal(reads(), base);
  // 与进行中任务无关的击杀只记下新的事件序号，任务状态没变，同样不该重新采集。
  session.recordQuestFact('defeat', 'enemy-wolf-1', 'combat');
  assert.equal(reads(), base, '只推进事件序号时不重新采集任务');
  // 任务真的变了必须重新采集，否则剧情事件会漏触发（`recordQuestFact` 自己会发一次通知）。
  assert.equal(session.accept('grafton-mission'), true);
  const accepted = reads();
  session.recordQuestFact('defeat', 'enemy-earl-grafton-1', 'combat');
  assert.ok(reads() > accepted, '任务变化后应当重新采集');
  director.dispose();
});

/** 统计 `Bag.counts` 被读了几次：每次未命中都要重建整张分类计数。 */
function countBagReads(session: Session) {
  const bag = session.bag;
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(bag), 'counts')!;
  let reads = 0;
  Object.defineProperty(bag, 'counts', { configurable: true, get() { reads++; return descriptor.get!.call(bag); } });
  return () => reads;
}

test('inventory observation reuses the bag revision instead of recounting every emit', () => {
  const session = new Session(campaign), director = new StoryDirector(campaign, session, ui, () => {}, presentation);
  const reads = countBagReads(session);
  session.emit();                       // 预热：先让背包版本稳定下来
  const base = reads();
  // 与背包无关的通知（血量、金币、位置……频率远高于拾取）不该重新统计整包物品。
  for (let index = 0; index < 10; index++) session.emit();
  assert.equal(reads(), base);
  // 背包真的变了必须重新统计，否则拾取类剧情事件会漏触发。
  session.bag.add('rat-tail');session.emit();
  assert.ok(reads() > base, '背包变化后应当重新统计');
  director.dispose();
});

/** 统计剧情世界被整份深拷贝了几次。 */
function countWorldCaptures(session: Session) {
  const world = session.storyWorld, original = world.captureState.bind(world);
  let reads = 0;
  world.captureState = () => { reads++; return original(); };
  return () => reads;
}

test('story observation reads choices and encounters without cloning the whole world', () => {
  const session = new Session(campaign), director = new StoryDirector(campaign, session, ui, () => {}, presentation);
  const captures = countWorldCaptures(session);
  session.emit();
  const base = captures();
  // 与剧情世界无关的通知（掉血、金币、位置……）不该深拷贝整个世界。
  for (let index = 0; index < 10; index++) session.emit();
  assert.equal(captures(), base);
  director.dispose();
});

test('choice and encounter observation reuse their revisions', () => {
  const session = new Session(campaign), director = new StoryDirector(campaign, session, ui, () => {}, presentation);
  let choiceReads = 0, encounterReads = 0;
  const choiceCounts = session.choiceWriteCounts.bind(session);
  session.choiceWriteCounts = () => { choiceReads++; return choiceCounts(); };
  const encounterStatuses = session.storyWorld.encounterStatuses.bind(session.storyWorld);
  session.storyWorld.encounterStatuses = () => { encounterReads++; return encounterStatuses(); };

  session.emit();
  const choiceBase = choiceReads, encounterBase = encounterReads;
  for (let index = 0; index < 10; index++) session.emit();
  assert.equal(choiceReads, choiceBase, '没有选择写入时不再读取选择表');
  assert.equal(encounterReads, encounterBase, '遭遇没变时不再重建状态表');

  session.applyStoryCommands([{ type: 'choice', choice: 'route', value: 'north' }]);session.emit();
  assert.ok(choiceReads > choiceBase, '选择写入后重新读取');
  session.storyWorld.apply({ kind: 'encounter', encounter: { id: 'probe', map: 'forest', status: 'active', spawns: [] } });session.emit();
  assert.ok(encounterReads > encounterBase, '遭遇变化后重新读取');
  director.dispose();
});

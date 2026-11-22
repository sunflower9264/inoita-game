import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseCampaign, parseWorld } from '../src/application/content-validation.ts';
import { Session } from '../src/domain/session.ts';
import { StoryDirector, type StoryUI } from '../src/domain/story-director.ts';
import type { Campaign, CampaignQuest } from '../src/domain/campaign.ts';
import type { ActorDefinition, EntityPlacement } from '../src/domain/content.ts';

/**
 * 交互目标的屏幕提示与「一根号角只触发一次」：
 * 场景交互入口 → `StoryDirector.interact` → `Session.interactWithFeedback` → 任务目标计数 + 提示。
 * 用真实内容驱动，避免用例写死任务行号。
 */
const read = (name: string) => JSON.parse(readFileSync(new URL(`../public/content/${name}.json`, import.meta.url), 'utf8'));
const campaign = parseCampaign(read('campaign')), world = parseWorld(read('world'));

function harness(content: Campaign = campaign) {
  const session = new Session(content), toasts: string[] = [], lines: string[] = [];
  const ui: StoryUI = {
    async dialogue(line) { lines.push(line.text); },
    async choice(_prompt, options) { return options[0]; },
    async questPopup() {}, closeDialogue() {}, skipDialogue() {},
    toast(message) { toasts.push(message); }
  };
  const director = new StoryDirector(content, session, ui, () => {}, { begin() {}, async execute() {}, async finish() {} });
  return { session, director, toasts, lines };
}

function emptyCampaign(quests: CampaignQuest[]): Campaign {
  return { version: 2, contentVersion: 1, start: { map: 'camp', actor: 'player', x: 16, y: 16, facing: 'south', script: 'opening' },
    quests, placements: [], questGroups: [], events: [],
    scripts: { opening: { entry: 'entry', nodes: [{ id: 'entry', presentation: [], commands: [], exit: { type: 'end' } }] } } };
}

test('each of the four horns shows the original destruction hint once and counts once', async () => {
  const quest = campaign.quests.find(candidate => candidate.id === 'quest-121')!;
  const goals = quest.goals.filter(goal => goal.kind === 'interact');
  assert.equal(goals.length, 4);
  assert.ok(goals.every(goal => goal.feedbackText === '破坏号角'), '四个号角都带原版提示');
  const placements = goals.map(goal => campaign.placements.find(placement => placement.actor === goal.target)!);
  assert.ok(placements.every(Boolean), '四个号角都有摆放点');

  const h = harness();
  assert.equal(h.session.accept(quest.id), true);
  assert.equal(h.session.status(quest.id), 'active');

  for (const [index, goal] of goals.entries()) {
    const placement = placements[index];
    assert.equal(h.session.canInteract(goal.target, placement.id, goal.characterId), true, '没记过数的号角可交互');
    assert.equal(h.session.quests.get(quest.id)!.goals[goal.id], 0);

    await h.director.interact(placement, world.actors[placement.actor]);
    assert.equal(h.session.quests.get(quest.id)!.goals[goal.id], 1, '一次交互只加一次');
    assert.equal(h.toasts.filter(message => message === '破坏号角').length, index + 1, '一次交互只弹一次');
    assert.equal(h.toasts.at(-1), '破坏号角');

    // 已经记过数的号角：不再是候选，直接调会话也不计数、不产生事实、不弹提示。
    assert.equal(h.session.canInteract(goal.target, placement.id, goal.characterId), false, '已完成的号角不再可交互');
    const facts = h.session.captureState().factSequences.length;
    assert.equal(h.session.interact(goal.target, placement.id, goal.characterId), false);
    assert.equal(h.session.quests.get(quest.id)!.goals[goal.id], 1, '重复交互不加计数');
    assert.equal(h.session.captureState().factSequences.length, facts, '重复交互不产生任务事实');
    assert.equal(h.toasts.length, index + 1, '重复交互不弹提示');

    // 其余还没破坏的号角仍然可以交互。
    for (const [otherIndex, other] of goals.entries()) {
      if (otherIndex <= index) continue;
      assert.equal(h.session.canInteract(other.target, placements[otherIndex].id, other.characterId), true);
    }
  }

  assert.equal(h.session.status(quest.id), 'ready', '四个号角都破坏后任务进入待交付');
  assert.equal(h.toasts.length, 4);
  await h.director.interact(placements[0], world.actors[placements[0].actor]);
  assert.equal(h.toasts.length, 4, '待交付后再交互不再弹提示');
  assert.equal(h.session.status(quest.id), 'ready');
  h.director.dispose();
});

test('a multi-count interact goal stays interactable until its quantity is reached', async () => {
  const quest: CampaignQuest = {
    id: 'multi', title: '多数量交互', description: '多数量交互', guidance: { available: '接取', active: '进行中' },
    completion: 'all', goals: [{ id: 'horn', kind: 'interact', target: 'altar', quantity: 3, feedbackText: '破坏号角' }],
    progressText: '进行中', completeText: '完成'
  };
  const h = harness(emptyCampaign([quest]));
  assert.equal(h.session.accept(quest.id), true);
  const entity: EntityPlacement = { id: 'altar-instance', actor: 'altar', x: 0, y: 0 };
  const actor = { id: 'altar', name: '祭坛', description: '' } as unknown as ActorDefinition;

  for (let count = 1; count <= 3; count++) {
    assert.equal(h.session.canInteract('altar', entity.id), true, `第 ${count} 次前仍可交互`);
    await h.director.interact(entity, actor);
    assert.equal(h.session.quests.get(quest.id)!.goals.horn, count);
    assert.equal(h.toasts.length, count, '每次真的推进都提示一次');
  }
  assert.equal(h.session.canInteract('altar', entity.id), false, '达到数量后不再可交互');
  assert.equal(h.session.interact('altar', entity.id), false, '直接调会话也不再计数');
  assert.equal(h.session.quests.get(quest.id)!.goals.horn, 3);
  assert.equal(h.session.status(quest.id), 'ready');

  // 走剧情交互入口时同理：达到数量后不再响应。
  await h.director.interact(entity, actor);
  assert.equal(h.toasts.length, 3);
  assert.equal(h.session.quests.get(quest.id)!.goals.horn, 3);
  h.director.dispose();
});

test('a journal-external quest still counts interaction goals but shows no prompt', async () => {
  const quest: CampaignQuest = {
    id: 'secret', title: '日志外任务', description: '日志外任务', guidance: { available: '接取', active: '进行中' },
    completion: 'all', journal: false,
    goals: [{ id: 'horn', kind: 'interact', target: 'altar', quantity: 1, feedbackText: '破坏号角' }],
    progressText: '进行中', completeText: '完成'
  };
  const h = harness(emptyCampaign([quest]));
  assert.equal(h.session.accept(quest.id), true);
  const entity: EntityPlacement = { id: 'altar-instance', actor: 'altar', x: 0, y: 0 };
  const actor = { id: 'altar', name: '祭坛', description: '' } as unknown as ActorDefinition;
  await h.director.interact(entity, actor);
  assert.equal(h.session.quests.get(quest.id)!.goals.horn, 1, '日志外任务照常计数');
  assert.equal(h.session.status(quest.id), 'ready');
  assert.equal(h.toasts.length, 0, '日志外任务不弹提示');
  h.director.dispose();
});

test('an interact goal without feedbackText keeps the previous silent behavior', async () => {
  const quest = campaign.quests.find(candidate => candidate.id === 'quest-86')!;
  const goals = quest.goals.filter(goal => goal.kind === 'interact');
  assert.ok(goals.length > 0);
  assert.ok(goals.every(goal => goal.feedbackText === undefined), '任务本身没有新的提示文本');
  const placements = goals.map(goal => campaign.placements.find(placement => placement.actor === goal.target)!);

  const h = harness();
  assert.equal(h.session.accept(quest.id), true);
  for (const [index, goal] of goals.entries()) {
    const placement = placements[index];
    await h.director.interact(placement, world.actors[placement.actor]);
    assert.equal(h.session.quests.get(quest.id)!.goals[goal.id], 1);
    assert.equal(h.toasts.length, 0, '没有 feedbackText 就不弹新提示');
    // 任务仍在进行时重复交互同一个目标：计数不变，也没有新提示。
    await h.director.interact(placement, world.actors[placement.actor]);
    assert.equal(h.session.quests.get(quest.id)!.goals[goal.id], 1, '重复交互不加计数');
    assert.equal(h.toasts.length, 0);
  }
  assert.equal(h.session.status(quest.id), 'ready');
  // 待交付后再交互已完成的目标：仍然安静。
  await h.director.interact(placements[0], world.actors[placements[0].actor]);
  assert.equal(h.toasts.length, 0);
  h.director.dispose();
});

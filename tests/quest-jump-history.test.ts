import assert from 'node:assert/strict';
import test from 'node:test';
import { headlessContent, playthrough } from './helpers/story-playthrough.ts';
import { applyQuestStartPlan, planQuestStart } from '../src/debug/quest-jump.ts';
import { questJumpHistory } from '../src/debug/quest-jump-history.ts';
import { newStorySession } from '../src/domain/story-class.ts';
import type { Campaign, CampaignQuest } from '../src/domain/campaign.ts';
import type { StoryEvent, StoryScript } from '../src/domain/story-graph.ts';

const campaign = headlessContent.campaign;

test('quest-21 可接取时不吞 cardinal-summons 的接取事件', () => {
  const h = playthrough();
  try {
    const plan = planQuestStart(campaign, h.session, 'quest-21');
    assert.equal(plan.accept?.eventId, 'event-13');
    for (const id of ['event-13', 'event-14', 'event-411'])
      assert.equal(plan.conditionPatch.completedEvents.includes(id), false, id);
    assert.equal(plan.conditionPatch.quests.find(entry => entry.id === 'quest-381')?.status, 'completed');
    applyQuestStartPlan(h.session, plan);
    assert.equal(h.session.status('cardinal-summons'), 'available');
    assert.equal(h.session.runtimeState.completedEvents.includes('event-411'), false);
  } finally { h.director.dispose(); }
});

test('quest-23 待交付时保留唯一完成事件，quest-153 保持已交付', () => {
  const h = playthrough();
  try {
    const available = planQuestStart(campaign, h.session, 'quest-23');
    assert.equal(available.accept?.eventId, 'event-19');
    assert.equal(available.conditionPatch.completedEvents.includes('event-45'), false);
    const ready = planQuestStart(campaign, h.session, 'quest-23', 'ready');
    assert.equal(ready.conditionPatch.completedEvents.includes('event-45'), false);
    assert.equal(ready.conditionPatch.quests.find(entry => entry.id === 'quest-153')?.status, 'completed');
    applyQuestStartPlan(h.session, ready);
    assert.equal(h.session.status('quest-23'), 'ready');
    assert.equal(h.session.runtimeState.completedEvents.includes('event-45'), false);
    assert.equal(h.session.status('quest-38'), 'available');
  } finally { h.director.dispose(); }
});

test('quest-84 待交付时保留唯一完成事件并落到 south-pendrik', () => {
  const h = playthrough();
  try {
    const plan = planQuestStart(campaign, h.session, 'quest-84', 'ready');
    assert.equal(plan.destination?.map, 'south-pendrik-6312caf9');
    assert.equal(plan.conditionPatch.completedEvents.includes('event-145'), false);
    assert.equal(plan.conditionPatch.quests.find(entry => entry.id === 'quest-90')?.status, 'completed');
    applyQuestStartPlan(h.session, plan);
    assert.equal(h.session.status('quest-84'), 'ready');
    assert.equal(h.session.runtimeState.completedEvents.includes('event-145'), false);
  } finally { h.director.dispose(); }
});

test('quest-168 的目的地跟随 event-10 的实际摆放', () => {
  const h = playthrough();
  try {
    const plan = planQuestStart(campaign, h.session, 'quest-168');
    assert.equal(plan.destination?.map, 'shadow-hall');
    assert.ok(plan.conditionPatch.completedEvents.includes('event-10'));
    assert.ok(plan.worldCommands.some(command => command.type === 'world'
      && command.command.kind === 'place' && command.command.entity.id === 'quest-npc-located-npc-40'
      && command.command.entity.map === 'shadow-hall'));
    applyQuestStartPlan(h.session, plan);
    assert.equal(h.session.storyWorld.hasFlag('quest-npc-located-npc-40'), true);
    assert.equal(h.session.storyWorld.entity('quest-npc-located-npc-40')?.map, 'shadow-hall');
  } finally { h.director.dispose(); }
});

test('quest-83 待交付的目的地使用正式摆放而不是静态地图', () => {
  const h = playthrough();
  try {
    const plan = planQuestStart(campaign, h.session, 'quest-83', 'ready');
    assert.equal(plan.destination?.map, 'pendrik-village-safehouse-b26c31d1');
    assert.ok(plan.worldCommands.some(command => command.type === 'world'
      && command.command.kind === 'place' && command.command.entity.id === 'quest-npc-located-npc-58'
      && command.command.entity.map === 'pendrik-village-safehouse-b26c31d1'));
    assert.equal(plan.conditionPatch.completedEvents.includes('event-143'), false);
    applyQuestStartPlan(h.session, plan);
    assert.equal(h.session.status('quest-83'), 'ready');
    assert.equal(h.session.storyWorld.hasFlag('quest-npc-located-npc-58'), true);
  } finally { h.director.dispose(); }
});

test('与目标无关的区域/进图事件不会随跳转提前完成', () => {
  const first = playthrough();
  try {
    const plan = planQuestStart(campaign, first.session, 'quest-381');
    for (const id of ['event-3', 'event-4'])
      assert.equal(plan.conditionPatch.completedEvents.includes(id), false, id);
    assert.equal(first.session.status('grafton-mission'), 'available');
  } finally { first.director.dispose(); }

  const second = playthrough();
  try {
    const plan = planQuestStart(campaign, second.session, 'quest-107');
    assert.equal(plan.conditionPatch.completedEvents.includes('event-197'), false);
    assert.equal(plan.destination?.map, 'kiyan-s-room-3b44ed56');
  } finally { second.director.dispose(); }
});

test('历史里已交付的重复任务回到 available 并保留完成轮次', () => {
  const content = repeatCampaign();
  const session = newStorySession(content, headlessContent.world.actors['kiyan'],
    headlessContent.storyClasses.classes[0], headlessContent.items, headlessContent.stats,
    headlessContent.battle, headlessContent.companions);
  const history = questJumpHistory(content, 'target-quest', 'active');
  assert.equal(history.progress.get('repeat-quest'), 'available');
  assert.ok(history.completedQuests.has('repeat-quest'));

  const plan = planQuestStart(content, session, 'target-quest', 'active');
  applyQuestStartPlan(session, plan);
  assert.equal(session.status('repeat-quest'), 'available');
  assert.equal(session.questBook.completedCycles('repeat-quest'), 1);
  assert.equal(session.rewardReceiptFor('repeat-quest'), undefined);
  assert.equal(session.accept('repeat-quest'), true);
  assert.equal(session.status('repeat-quest'), 'active');
});

function repeatCampaign(): Campaign {
  const quest = (id: string, extra: Partial<CampaignQuest> = {}): CampaignQuest => ({
    id, title: id, description: id, guidance: { available: id, active: id },
    progressText: id, completeText: id,
    goals: [{ id: 'goal', kind: 'defeat', target: 'enemy-test', quantity: 1 }],
    availableWhen: { type: 'always', value: true },
    completion: 'all',
    ...extra,
  });
  const scripts: Record<string, StoryScript> = {
    start: { entry: 'done', nodes: [{ id: 'done', presentation: [], commands: [], exit: { type: 'end' } }] },
    'repeat-accept': { entry: 'accept', nodes: [{ id: 'accept', presentation: [], commands: [
      { type: 'quest', command: { type: 'accept', quest: 'repeat-quest' } },
    ], exit: { type: 'end' } }] },
    'repeat-complete': { entry: 'done', nodes: [{ id: 'done', presentation: [], commands: [
      { type: 'quest', command: { type: 'script-complete', quest: 'repeat-quest' } },
    ], exit: { type: 'end' } }] },
    'target-accept': { entry: 'accept', nodes: [{ id: 'accept', presentation: [], commands: [
      { type: 'quest', command: { type: 'accept', quest: 'target-quest' } },
    ], exit: { type: 'end' } }] },
  };
  const events: StoryEvent[] = [
    { id: 'event-repeat', source: 'quest', key: 'repeat-quest', script: 'repeat-accept',
      condition: { type: 'always', value: true } },
    { id: 'event-repeat-done', source: 'quest', key: 'repeat-quest', script: 'repeat-complete',
      condition: { type: 'quest', quest: 'repeat-quest', status: 'active' } },
    { id: 'event-target', source: 'quest', key: 'target-quest', script: 'target-accept',
      condition: { type: 'quest', quest: 'repeat-quest', status: 'completed' } },
  ];
  return {
    version: 2, contentVersion: 1,
    start: { map: 'shadow-camp', x: 120, y: 312, actor: 'kiyan', facing: 'south', script: 'start' },
    quests: [
      quest('repeat-quest', { repeat: true }),
      quest('target-quest', {
        availableWhen: { type: 'quest', quest: 'repeat-quest', status: 'settled' },
      }),
    ],
    questGroups: [{ id: 'test', title: 'test', kind: 'main', questIds: ['repeat-quest', 'target-quest'] }],
    placements: [], events, scripts,
  };
}

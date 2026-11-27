import assert from 'node:assert/strict';
import test from 'node:test';
import { playthrough } from './helpers/story-playthrough.ts';
import { createGmActions } from '../src/debug/gm-actions.ts';

function snapshot(h: ReturnType<typeof playthrough>) {
  const quests = ['quest-261', 'quest-262', 'quest-263', 'quest-264', 'quest-371'];
  return {
    current: h.session.currentQuest()?.id,
    quests: Object.fromEntries(quests.map(id => [id, h.session.status(id)])),
    encounters: h.session.storyWorld.activeEncounters.map(encounter => encounter.id),
    event284: h.director.runtime.eventStatus('event-284'),
  };
}

function gmFor(h: ReturnType<typeof playthrough>) {
  return createGmActions({
    session: h.session,
    campaign: h.session.campaign,
    director: h.director,
    status: () => ({ mode: 'game', ready: true }),
    report: async () => true,
  });
}

/** 沿真实剧情走到石魔战斗开始：第三个结界石进行中，event-284-battle 正在等待玩家。 */
async function reachGolem() {
  const h = playthrough();
  h.session.applyStoryCommands([{ type: 'quest', command: { type: 'script-complete', quest: 'quest-261' } }]);
  await h.idle();
  h.session.applyStoryCommands([{ type: 'travel', destination: { map: 'eternal-forest-bounds-3-422e3aba', x: 184, y: 320, facing: 'north' } }]);

  h.choices(['option-1']);
  await h.approach('npc-409');
  h.choices(['option-1']);
  await h.talk('npc-409');
  await h.travel('eternal-forest-6-ea15883d');
  await h.travel('eternal-forest-bounds-3-422e3aba');
  h.choices(['option-0']);
  await h.talk('npc-409');

  assert.equal(h.session.status('quest-263'), 'active');
  assert.equal(h.session.storyWorld.activeEncounters.filter(encounter => encounter.definitionId === 'event-284-battle').length, 1);
  return h;
}

test('GM complete current quest settles the stone golem encounter and advances the chain', async () => {
  const h = await reachGolem();
  try {
    const result = gmFor(h).completeCurrentQuest();
    assert.equal(result.ok, true, result.reason);
    assert.match(result.reason ?? '', /已结算 1 场剧情战斗/);
    await h.idle();

    const state = snapshot(h);
    assert.equal(state.quests['quest-262'], 'completed', JSON.stringify(state));
    assert.equal(state.quests['quest-263'], 'completed', JSON.stringify(state));
    assert.equal(state.quests['quest-264'], 'active', JSON.stringify(state));
    assert.equal(state.current, 'quest-264', JSON.stringify(state));
    assert.deepEqual(state.encounters, [], JSON.stringify(state));
    assert.equal(state.event284, 'completed', JSON.stringify(state));
  } finally {
    h.director.dispose();
  }
});

test('GM complete current quest repairs a session already stuck by the old completion path', async () => {
  const h = await reachGolem();
  try {
    // 旧版本点“完成任务”留下的状态：包装任务已完成，石魔战斗和遭遇仍在等待。
    h.session.applyStoryCommands([{ type: 'quest', command: { type: 'script-complete', quest: 'quest-262' } }]);
    await h.idle();
    assert.equal(h.session.status('quest-262'), 'completed');
    assert.equal(h.session.status('quest-263'), 'active');
    assert.equal(h.session.currentQuest(), undefined);
    const unrelatedStatus = h.session.status('grafton-mission');

    const result = gmFor(h).completeCurrentQuest();
    assert.equal(result.ok, true, result.reason);
    assert.match(result.reason ?? '', /已结算 1 场剧情战斗/);
    await h.idle();

    const state = snapshot(h);
    assert.equal(state.quests['quest-262'], 'completed', JSON.stringify(state));
    assert.equal(state.quests['quest-263'], 'completed', JSON.stringify(state));
    assert.equal(state.quests['quest-264'], 'active', JSON.stringify(state));
    assert.equal(state.current, 'quest-264', JSON.stringify(state));
    assert.deepEqual(state.encounters, [], JSON.stringify(state));
    assert.equal(state.event284, 'completed', JSON.stringify(state));
    assert.equal(h.session.status('grafton-mission'), unrelatedStatus, '不能误完成无关任务');
  } finally {
    h.director.dispose();
  }
});

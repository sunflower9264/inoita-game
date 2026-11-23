import assert from 'node:assert/strict';
import test from 'node:test';
import { playthrough } from './helpers/story-playthrough.ts';
import { applyQuestStartPlan, planQuestStart } from '../src/debug/quest-jump.ts';
import type { SessionState } from '../src/domain/session.ts';

for (const [title, event, previous, quest, destination] of [
  ['前往钢之兽人部落', 'event-90', 'quest-110', 'quest-111', 'secret-sanctum-2-4e041f9e'],
  ['被绑架的兽人长老', 'event-92', 'quest-111', 'quest-112', 'steel-orc-village-guardpost-296888b5'],
]) {
  test(`跳过「${title}」以及从接取窗口读档，都只结算一次并结束在正确地图`, async t => {
    const setup = playthrough();
    setup.director.dispose();
    const plan = planQuestStart(setup.session.campaign, setup.session, quest);
    applyQuestStartPlan(setup.session, plan);
    assert.ok(plan.destination);
    setup.session.applyStoryCommands([{ type: 'travel', destination: plan.destination }]);

    const h = playthrough(setup.session.capturePersistentState());
    t.after(() => h.director.dispose());
    const closingStatuses = new Set<string>();
    const unsubscribe = h.session.subscribe(() => {
      const run = h.session.runtimeState.runs.find(candidate => candidate.eventId === event);
      const closingActionApplied = event === 'event-90'
        ? h.session.party?.get('story-mercenary-olaf')
        : h.session.storyWorld.entity('story-character-npc-58')?.removed;
      if (run && closingActionApplied) closingStatuses.add(run.status);
    });
    t.after(unsubscribe);
    let saved: SessionState | undefined;
    h.director.onPresentationStarted = () => h.director.skip();
    h.director.onSkipProgress = phase => {
      if (phase === 'quest-popup' && h.session.status(quest) === 'active') saved = h.session.capturePersistentState();
    };
    assert.equal(await h.director.enterRegion(event, plan.destination.map), true);
    await h.idle();
    assert.deepEqual(h.popups, ['complete:' + previous, 'start:' + quest]);
    assert.deepEqual([...closingStatuses], ['completed'], '收尾人物变化和事件完成同时可见');
    assert.ok(saved);

    const restored = playthrough(saved);
    t.after(() => restored.director.dispose());
    assert.equal(await restored.director.retry(), true);
    await restored.idle();
    assert.deepEqual(restored.popups, ['start:' + quest]);
    for (const game of [h, restored]) {
      assert.equal(game.director.runtime.eventStatus(event), 'completed');
      assert.equal(game.director.busy, false);
      assert.equal(game.session.status(previous), 'completed');
      assert.equal(game.session.status(quest), 'active');
      assert.equal(game.session.storyWorld.currentLocation?.map, destination);
      assert.ok(game.session.party?.get('story-mercenary-olaf'));
    }
    assert.deepEqual(restored.session.rewardReceiptFor(previous), h.session.rewardReceiptFor(previous));
  });
}

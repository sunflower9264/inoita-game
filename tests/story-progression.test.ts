import assert from 'node:assert/strict';
import test from 'node:test';
import { playthrough } from './helpers/story-playthrough.ts';
import { questJournal } from '../src/domain/quest-journal.ts';
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

test('a new game reaches the original Grafton battle, report, teaching choices and uniform handover through public game actions',async()=>{
  const h=playthrough();await h.director.start();await h.idle();
  assert.equal(h.director.runtime.eventStatus('event-0'),'completed');
  // 初始营地没有可见任务；刺杀任务要走到出口触发 event-1 后才接取。
  assert.equal(h.session.status('grafton-mission'),'available');
  assert.deepEqual(questJournal(h.session.campaign,h.session.quests),[]);
  await h.region('event-1');assert.equal(h.session.status('grafton-mission'),'active');
  assert.ok(h.popups.includes('start:grafton-mission'));
  await h.region('event-2');await h.travel('shadow-forest-east');
  // 序章路障是 quest-381 的目标：接取即待交付，靠近对话一次交付，
  // 事件 13 才移除它，往西的出口才通。事件 3 会把队伍带进洞口，所以先在这里完成。
  await h.talk('npc-120');
  assert.equal(h.session.status('quest-381'),'completed');
  await h.region('event-3');
  // 事件 4 是进图触发：走到洞穴那一刻就开演，不需要再走进原版矩形。
  await h.travel('silent-cave-depths');
  assert.equal(h.session.status('quest-22'),'active');
  const rocks=h.entities().filter(entity=>entity.characterId==='npc-134');assert.equal(rocks.length,6);
  await h.defeat('enemy-earl-grafton-1');
  assert.notEqual(h.director.runtime.eventStatus('event-5'),'completed','两名护卫没有死时不提前转场');
  await h.defeat('enemy-berkel-soldier-2');await h.defeat('enemy-berkel-soldier-3');
  assert.equal(h.director.runtime.eventStatus('event-5'),'completed');
  assert.equal(h.session.storyWorld.currentLocation?.map,'silent-cave-entrance');
  assert.equal(h.session.storyWorld.captureState().entities.some(entity=>rocks.some(rock=>rock.id===entity.id)),false,'离开地图后清理洞内落石');
  await h.travel('shadow-camp');h.choices(['option-0','option-1','option-2','option-0','option-3']);
  await h.talk('npc-40');
  assert.equal(h.session.status('grafton-mission'),'completed');
  for(const event of ['event-6','event-408','event-409','event-410','event-411'])assert.equal(h.director.runtime.eventStatus(event),'completed',event);
  assert.equal(h.session.status('cardinal-summons'),'ready');
  await h.travel('berkel-capital');await h.region('event-7');
  await h.talk('npc-55');
  assert.equal(h.session.status('meet-portia'),'ready');
  await h.travel('shadow-hall');
  await h.talk('npc-54');
  assert.equal(h.session.status('meet-portia'),'completed','Portia 只执行待交付槽，不再弹任务选择');
  assert.equal(h.session.status('knight-uniform'),'active');
  await h.travel('shadow-training-dungeon-2-a6b8293b');
  for(let count=0;count<5;count++){
    await h.defeat('enemy-reagents-1');
    assert.equal(h.session.itemCount('ectoplasm'),count+1,'试验精灵的任务材料拾取');
  }
  assert.equal(h.session.status('knight-uniform'),'ready');
  await h.travel('shadow-hall');await h.talk('npc-54');
  assert.equal(h.session.status('knight-uniform'),'completed');
  assert.equal(h.director.runtime.eventStatus('event-10'),'completed');
  assert.deepEqual(h.entities().filter(entity=>entity.characterId==='npc-40').map(entity=>[entity.id,entity.x,entity.y]),
    [['quest-npc-located-npc-40',264,344]],'剧情过场演员和任务位置不能重叠成两个卓拉德');
  assert.deepEqual(h.session.storyWorld.captureState().entities
    .filter(entity=>entity.characterId==='npc-40'&&!entity.removed).map(entity=>entity.id),
    ['quest-npc-located-npc-40'],'任务位置登记接管后不再保留同图的过场实例');
  assert.equal(h.session.itemCount('ectoplasm'),0);
  assert.ok(h.session.storyWorld.captureState().entities.some(entity=>entity.characterId==='npc-126'),'原版后续训练教官已登记');
  h.director.dispose();
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { moneyGain } from '../src/domain/economy.ts';
import { captureSaveGame, saveSummary } from '../src/domain/save-game.ts';
import { prepareSavedGame } from '../src/application/saved-game.ts';
import { headlessContent, playthrough } from './helpers/story-playthrough.ts';
import { createGmActions, type GmStoryJumpPort, type GmStoryJumpSnapshot } from '../src/debug/gm-actions.ts';

async function waitFor(check: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index++) {
    if (check()) return;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  throw new Error('等待条件超时');
}

function harness(options: { travelThrows?: boolean; holdPlay?: boolean; playThrows?: boolean; holdSettled?: boolean; refused?: boolean; noProgress?: boolean; wrongMap?: boolean } = {}, saved?: Parameters<typeof playthrough>[0]) {
  const h = playthrough(saved);
  const calls: string[] = [];
  let releasePlay: (() => void) | undefined;
  let releaseSettled: (() => void) | undefined;
  const snapshot = (): GmStoryJumpSnapshot => ({ session: h.session.captureState(), world: {} });
  const port: GmStoryJumpPort = {
    ready: () => true,
    capture: () => { calls.push('capture'); return snapshot(); },
    begin: () => { calls.push('begin'); h.director.holdTriggers(); },
    releaseTriggers: () => { calls.push('releaseTriggers'); h.director.releaseTriggers(); },
    closeMenu: () => calls.push('closeMenu'),
    travel: async destination => {
      calls.push('travel');
      if (options.travelThrows) throw new Error('传送失败');
      if (!options.wrongMap) {
        h.session.applyStoryCommands([{ type: 'travel', destination }]);
        h.landPlayer();
      }
    },
    play: async accept => {
      calls.push('play');
      if (options.holdPlay) await new Promise<void>(resolve => { releasePlay = resolve; });
      if (options.playThrows) throw new Error('剧情播放失败');
      if (options.refused) return false;
      if (options.noProgress) return true;
      if (accept.eventId) return h.director.trigger({ id: accept.eventId, script: accept.script });
      return h.director.script(accept.script);
    },
    settled: options.holdSettled
      ? async () => { await new Promise<void>(resolve => { releaseSettled = resolve; }); }
      : undefined,
    restore: async before => {
      calls.push('restore');
      h.session.restoreState(before.session);
    },
    checkpoint: () => { calls.push('checkpoint'); },
    finish: () => { calls.push('finish'); h.director.releaseTriggers(); },
    dispose: () => { calls.push('dispose'); h.director.releaseTriggers(); },
  };
  const gm = createGmActions({ session: h.session, campaign: h.session.campaign, director: h.director, storyJump: port,
    requestAutoSave: () => calls.push('autoSave') });
  return { h, gm, calls, release: () => releasePlay?.(), releaseSettled: () => releaseSettled?.(), hasSettled: () => !!releaseSettled };
}

test('the quest catalog and preview expose the ordered full list and a start plan', () => {
  const { h, gm } = harness();
  try {
    const catalog = gm.questCatalog();
    assert.ok(catalog.length > 0);
    assert.equal(catalog.flatMap(group => group.entries).length, 487);
    const preview = gm.previewQuestDebug('quest-11');
    assert.equal(preview.ok, true);
    assert.equal(preview.plan?.accept?.script, 'next:quest-10:quest-11');
  } finally { h.director.dispose(); }
});

test('a jump applies the plan, plays the accept scene and settles as normal progress', async () => {
  const { h, gm, calls } = harness();
  try {
    const result = await gm.startStoryJump('quest-11');
    assert.equal(result.ok, true, result.reason);
    assert.equal(h.session.status('quest-10'), 'completed');
    assert.equal(h.session.status('quest-11'), 'active');
    assert.deepEqual(calls.slice(0, 5), ['capture', 'begin', 'travel', 'releaseTriggers', 'play']);
    assert.deepEqual(calls.slice(5), ['finish', 'checkpoint', 'autoSave'],
      '接取剧情播完后直接交接，不留在调试态');
    assert.equal(calls.includes('restore'), false);
  } finally { h.director.dispose(); }
});

test('a setup failure restores the captured state and does not touch auto-save', async () => {
  const { h, gm, calls } = harness({ travelThrows: true });
  try {
    const result = await gm.startStoryJump('quest-11');
    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /传送失败/);
    assert.equal(h.session.status('quest-11'), 'locked');
    assert.equal(h.session.status('quest-10'), 'available');
    assert.ok(calls.includes('restore'));
    assert.ok(calls.includes('finish'));
    assert.equal(calls.includes('play'), false);
    assert.equal(calls.includes('checkpoint'), false);
    assert.equal(calls.includes('autoSave'), false);
    assert.equal(h.director.allowsAutomaticEvent(
      h.session.campaign.events.find(event => event.id === 'event-1')!), true,
      '启动失败也要清掉设置阶段的临时过滤器');
  } finally { h.director.dispose(); }
});

test('a story error after the jump starts keeps the jumped progress but reports failure', async () => {
  const { h, gm, calls } = harness({ playThrows: true });
  try {
    const result = await gm.startStoryJump('quest-11');
    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /接取剧情播放失败/);
    assert.equal(calls.includes('restore'), false, '接取剧情开演后不再回滚');
    assert.ok(calls.includes('finish'));
    assert.ok(calls.includes('autoSave'));
  } finally { h.director.dispose(); }
});

test('the handoff waits until the accept story really finishes', async () => {
  const { h, gm, calls, releaseSettled, hasSettled } = harness({ holdSettled: true });
  try {
    const jump = gm.startStoryJump('quest-11');
    await waitFor(() => hasSettled());
    assert.equal(calls.includes('finish'), false, '战斗等待期间不能先交接');
    assert.equal(calls.includes('autoSave'), false);
    releaseSettled();
    const result = await jump;
    assert.equal(result.ok, true, result.reason);
    assert.ok(calls.includes('finish'));
    assert.ok(calls.includes('autoSave'));
  } finally { h.director.dispose(); }
});

test('a second jump is rejected while the accept story is still running', async () => {
  const { h, gm, calls, release } = harness({ holdPlay: true });
  try {
    const first = gm.startStoryJump('quest-11');
    await waitFor(() => calls.includes('play'));
    const second = await gm.startStoryJump('quest-18');
    assert.equal(second.ok, false);
    assert.match(second.reason ?? '', /正在执行剧情跳转/);
    release();
    const done = await first;
    assert.equal(done.ok, true, done.reason);
  } finally { h.director.dispose(); }
});

test('跳进蜘蛛女王战并取胜，战后已交付也算跳转成功', async () => {
  const {h, gm, releaseSettled, hasSettled} = harness({holdSettled:true});
  try {
    const jump = gm.startStoryJump('quest-31');
    await waitFor(hasSettled);
    assert.equal(h.session.status('quest-31'), 'active');
    await h.updateWorld(await h.defeat('enemy-queen-spider-1'));
    assert.equal(h.session.status('quest-31'), 'completed');
    releaseSettled();
    const result = await jump;
    assert.ok(result.ok, result.reason);
    assert.equal(h.session.questBook.completedCycles('quest-31'), 1);
  } finally { releaseSettled(); h.director.dispose(); }
});

test('Grafton’s assassination can still be reported to Zorad', async () => {
  const { h, gm } = harness();
  try {
    const result = await gm.startStoryJump('grafton-mission', 'ready');
    assert.equal(result.ok, true, result.reason);
    assert.equal(h.session.status('grafton-mission'), 'ready');
    assert.equal(h.session.storyWorld.hasFlag('quest-npc-located-npc-40'), true);
    await h.talk('npc-40');
    assert.equal(h.session.status('grafton-mission'), 'completed');
  } finally { h.director.dispose(); }
});

test('寻找魔法师保留已播的营地演出，区域仍由正式导演派发', async () => {
  const { h, gm } = harness();
  try {
    assert.equal((await gm.startStoryJump('quest-10', 'ready')).ok, true);
    const event1 = h.session.campaign.events.find(event => event.id === 'event-1')!;
    assert.equal(h.director.allowsAutomaticEvent(event1), true);
    assert.equal(h.director.runtime.eventStatus('event-0'), 'completed');
    h.session.applyStoryCommands([{ type: 'travel', destination: { map: 'shadow-camp', x: 392, y: 328, facing: 'south' } }]);
    assert.equal(await h.director.enterRegion('event-1', 'shadow-camp'), false);
    assert.equal(h.director.runtime.eventStatus('event-1'), 'completed');
  } finally { h.director.dispose(); }
});

test('a jump from quest-10 follows the formal chain to quest-12', async () => {
  const { h, gm } = harness();
  try {
    assert.equal((await gm.startStoryJump('quest-10', 'ready')).ok, true);
    assert.equal(h.session.status('quest-10'), 'ready');

    assert.equal(h.session.complete('quest-10'), true);
    await h.idle();
    assert.equal(h.session.status('quest-10'), 'completed');
    assert.equal(h.session.status('quest-11'), 'available');

    assert.equal(h.session.accept('quest-11'), true);
    await h.idle();
    for (let index = 0; index < 5; index++)
      h.session.recordQuestFact('defeat', 'enemy-wild-wolf-1', 'gm-story-jump-test');
    await h.idle();
    assert.equal(h.session.status('quest-11'), 'ready');

    assert.equal(h.session.complete('quest-11'), true);
    for (let index = 0; index < 50 && h.director.runtime.eventStatus('event-15') !== 'completed'; index++)
      await h.idle();

    assert.equal(h.director.runtime.eventStatus('event-15'), 'completed');
    assert.equal(h.session.status('quest-12'), 'ready');
  } finally { h.director.dispose(); }
});

test('a jump reports an unstarted scene or a missing quest handoff', async () => {
  for (const options of [{ refused: true }, { noProgress: true }, { wrongMap: true }]) {
    const { h, gm, calls } = harness(options);
    try {
      const result = await gm.startStoryJump('quest-11');
      assert.equal(result.ok, false, JSON.stringify(options));
      assert.ok(result.reason);
      if (options.refused || options.wrongMap) {
        assert.ok(calls.includes('restore'));
        assert.equal(calls.includes('autoSave'), false);
      }
    } finally { h.director.dispose(); }
  }
});

const castleNorthwest = 'northwest-side-of-arnen-castle-1b3a4e22';
const castleOne = 'inside-arnen-castle01-8b6ce276';
const castleTwo = 'inside-arnen-castle02-9a1430d7';

async function escapeCastle(h: ReturnType<typeof playthrough>) {
  await h.travel('old-sanctuary-54cffd62');
  await h.region('event-54');
  assert.equal(await h.damage('enemy-shin-1', 0.2), true);
  assert.equal(h.director.runtime.eventStatus('event-19'), 'completed');
  assert.equal(h.session.status('quest-23'), 'active');
}

for (const [id, title, after] of [
  ['quest-43', '潜入艾伦尼城', 'quest-39'],
  ['quest-39', '艾伦尼士兵的奇袭', 'quest-40'],
  ['quest-40', '单独潜入', 'quest-40'],
  ['quest-41', '逃出艾伦尼城', 'quest-23'],
] as const) test(`从「${title}」跳转后可继续下一段正式剧情`, async () => {
  const { h, gm } = harness();
  try {
    const result = await gm.startStoryJump(id);
    assert.equal(result.ok, true, result.reason);
    await h.idle();
    assert.equal(h.session.status(id), 'active');
    if (id !== after) assert.ok(['available', 'locked'].includes(h.session.status(after)));
    if (id === 'quest-43') {
      await h.travel(castleNorthwest);
      await h.region('event-50');
    } else if (id === 'quest-39') {
      for (let i = 0; i < 8; i++) await h.defeat('enemy-arnen-sentinel-1');
    } else if (id === 'quest-40') {
      await h.travel(castleTwo);
      await h.approach('npc-94');
      assert.equal(h.director.runtime.eventStatus('event-57'), 'completed');
      await h.region('event-52');
    } else {
      await escapeCastle(h);
    }
    assert.equal(h.session.status(after), id === after ? 'ready' : 'active');
  } finally { h.director.dispose(); }
});

function reloadState(h: ReturnType<typeof playthrough>) {
  const { session } = h, { battle, stats, ...content } = headlessContent;
  const location = session.storyWorld.currentLocation!;
  const map = content.maps.get(location.map)!;
  const summary = saveSummary(session, map, { name: '凯恩', portrait: 'assets/ui/menus/character-kiyan.png' });
  const save = captureSaveGame(session, { location, generatedEntities: [] }, summary);
  return prepareSavedGame(JSON.parse(JSON.stringify(save)), { ...content, battleCatalog: battle, characterStats: stats }).session.captureState();
}

test('后期存档跳回救出圣女的现场，读档后能走回莱曼处领取一次奖励', async () => {
  const late = harness();
  let returned: ReturnType<typeof harness> | undefined;
  let loaded: ReturnType<typeof playthrough> | undefined;
  try {
    const forward = await late.gm.startStoryJump('quest-41');
    assert.equal(forward.ok, true, forward.reason);
    await late.h.idle();
    await escapeCastle(late.h);
    returned = harness({}, reloadState(late.h));
    const { h, gm } = returned;
    const preview = gm.previewQuestDebug('quest-40', 'ready').plan!;
    const back = await gm.startStoryJump(preview);
    assert.equal(back.ok, true, back.reason);
    assert.equal(h.session.status('quest-40'), 'ready');
    assert.equal(h.session.storyWorld.currentLocation?.map, castleTwo);
    assert.equal(h.director.runtime.eventStatus('event-57'), 'completed');
    assert.equal(h.director.runtime.eventStatus('event-53'), 'idle');
    assert.equal(h.session.storyWorld.activeEncounters.some(encounter => encounter.definitionId === 'event-54-battle'), false);
    loaded = playthrough(reloadState(h));
    const money = loaded.session.money;
    await loaded.travel(castleOne);
    await loaded.region('event-53');
    assert.equal(loaded.session.status('quest-40'), 'completed');
    assert.equal(loaded.session.status('quest-41'), 'active');
    assert.equal(loaded.session.money - money, moneyGain(preview.quest.rewards!.money));
    assert.equal(await loaded.director.enterRegion('event-53', castleOne), false);
    assert.equal(loaded.session.money - money, moneyGain(preview.quest.rewards!.money));
    await escapeCastle(loaded);
  } finally {
    loaded?.director.dispose(); returned?.h.director.dispose(); late.h.director.dispose();
  }
});

test('追击圣女的护卫骑士从正式演出进入，并能走回广场', async () => {
  const { h, gm } = harness();
  try {
    const jump = await gm.startStoryJump('quest-146');
    assert.equal(jump.ok, true, jump.reason);
    await h.idle();
    assert.equal(h.director.runtime.eventStatus('event-178'), 'completed');
    await h.travel('berkel-capital-square-3807c990');
    await h.region('event-179');
    await h.travel('empire-capital-alley-5-30743650');
    await h.region('event-180');
    assert.equal(h.session.status('quest-146'), 'completed');
    assert.equal(h.session.status('quest-148'), 'active');
  } finally { h.director.dispose(); }
});

test('前往卡姆兰秘密基地从正式接取演出进入', async () => {
  const { h, gm } = harness();
  try {
    const jump = await gm.startStoryJump('quest-23');
    assert.equal(jump.ok, true, jump.reason);
    assert.equal(h.director.runtime.eventStatus('event-19'), 'completed');
    assert.equal(h.session.status('quest-23'), 'active');
    assert.equal(h.session.storyWorld.currentLocation?.map, 'hakan-desert-1-f08340a0');
  } finally { h.director.dispose(); }
});

test('分毫之差读档折返哈肯沙漠，往返跳转只恢复因果现场', async () => {
  const { h, gm } = harness();
  let restored: ReturnType<typeof harness> | undefined;
  try {
    h.session.applyStoryCommands([{ type: 'quest', command: { type: 'accept', quest: 'quest-18' } }]);
    const jump = await gm.startStoryJump('quest-28');
    assert.ok(jump.ok, jump.reason);
    await h.idle();
    restored = harness({}, reloadState(h));
    const game = restored.h;
    // 因果历史只恢复到达 quest-28 必需的事件；没有因果关系的旧任务保持未完成。
    assert.equal(game.session.status('quest-18'), 'available');
    assert.equal(game.session.status('quest-24'), 'available');
    assert.equal(game.session.status('quest-26'), 'available');
    await game.travel('hakan-desert-2-95444e0c');
    assert.equal(await game.director.enterRegion('event-20', 'hakan-desert-2-95444e0c'), true,
      'event-20 没有被旧时间线提前完成，会按正式条件开演');
    await game.idle();
    assert.equal(game.session.status('quest-24'), 'active');
    const back = await restored.gm.startStoryJump('quest-24');
    assert.ok(back.ok, back.reason);
    assert.equal(game.session.status('quest-24'), 'active');
    assert.equal(game.director.runtime.eventStatus('event-21'), 'idle');
    assert.equal(game.director.runtime.eventStatus('event-23'), 'idle');
    assert.equal(game.session.status('quest-18'), 'available');
  } finally { restored?.h.director.dispose(); h.director.dispose(); }
});

test('跳到消失的圣女3后读档，蜘蛛女王按因果现场重打，回跳可再次迎战', async () => {
  const first = harness();
  let restored: ReturnType<typeof harness> | undefined;
  try {
    const jump = await first.gm.startStoryJump('quest-35');
    assert.ok(jump.ok, jump.reason);
    await first.h.idle();
    restored = harness({}, reloadState(first.h));
    const { h, gm } = restored;
    const spiderMap = 'spider-s-lair-2-ba4a24b9';
    await h.travel(spiderMap);
    await h.region('event-27');
    assert.equal(h.session.storyWorld.activeEncounters.length, 1,
      '因果历史没有提前清掉蜘蛛女王，进图后按正式流程出现');
    await h.updateWorld(await h.defeat('enemy-queen-spider-1'));
    assert.equal(h.session.storyWorld.activeEncounters.length, 0);
    assert.equal(h.director.runtime.eventStatus('event-27'), 'completed');
    assert.equal(h.director.runtime.eventStatus('event-28'), 'completed');
    assert.equal(h.session.status('quest-30'), 'completed');
    assert.equal(h.session.status('quest-31'), 'completed');
    assert.equal(h.session.status('quest-35'), 'active');
    await h.travel('goblin-s-lair-2-49c1710f');
    await h.region('event-35');
    assert.equal(h.director.runtime.eventStatus('event-35'), 'completed');

    const back = await gm.startStoryJump('quest-30');
    assert.ok(back.ok, back.reason);
    await h.idle();
    assert.equal(h.session.status('quest-33'), 'available');
    assert.equal(h.session.itemCount('robbie-s-special-antidote'), 1);
    await h.travel(spiderMap);
    await h.region('event-27');
    assert.equal(h.session.storyWorld.activeEncounters.length, 1);
    await h.updateWorld(await h.defeat('enemy-queen-spider-1'));
    assert.equal(h.session.status('quest-30'), 'completed');
    assert.equal(h.session.status('quest-31'), 'completed');
    assert.equal(h.session.storyWorld.activeEncounters.length, 0);
    assert.equal(h.director.runtime.eventStatus('event-27'), 'completed');
    assert.equal(h.director.runtime.eventStatus('event-28'), 'completed');
    assert.equal(await h.director.enterRegion('event-27', spiderMap), false);
    assert.equal(h.session.questBook.completedCycles('quest-30'), 1);
    await h.travel('goblin-prison-2-27ab25e1');
    await h.talk('npc-170');
    assert.equal(h.session.status('quest-33'), 'active');
    h.session.applyStoryCommands([{ type: 'item-give', item: 'prison-key-2', quantity: 1 }]);
    await h.talk('npc-170');
    assert.equal(h.session.status('quest-33'), 'completed');
  } finally { restored?.h.director.dispose(); first.h.director.dispose(); }
});

test('调试传送离开未打完的蜘蛛战后向前跳，只清理遭遇并落到目标剧情', async () => {
  const {h, gm} = harness();
  try {
    assert.ok((await gm.startStoryJump('quest-30')).ok);
    const entrance = h.session.storyWorld.currentLocation!;
    await h.travel('spider-s-lair-2-ba4a24b9');
    await h.region('event-27');
    assert.equal(h.session.storyWorld.activeEncounters.length, 1);
    const forward = await gm.startStoryJump('quest-35');
    assert.equal(forward.ok, false);
    h.session.applyStoryCommands([{type:'travel', destination:entrance}]);
    const jump = await gm.startStoryJump('quest-35');
    assert.ok(jump.ok, jump.reason);
    assert.equal(h.session.storyWorld.activeEncounters.length, 0);
    assert.equal(h.director.runtime.eventStatus('event-27'), 'idle');
    assert.equal(h.director.runtime.eventStatus('event-28'), 'idle');
    assert.equal(h.session.status('quest-30'), 'available',
      '没有打完的蜘蛛战不会随前跳伪造完成');
    assert.equal(h.session.status('quest-35'), 'active');
  } finally { h.director.dispose(); }
});

test('序幕战斗折返回影营地时沿用刺杀任务，跳回刺杀则可再次正常接取', async () => {
  const { h, gm } = harness();
  try {
    const later = await gm.startStoryJump('quest-381');
    assert.ok(later.ok, later.reason);
    assert.equal(h.session.status('grafton-mission'), 'available',
      '因果历史不伪造刺杀任务的接取');
    assert.equal(h.session.status('quest-381'), 'ready');
    await h.travel('shadow-camp');
    assert.equal(await h.director.enterRegion('event-1', 'shadow-camp'), true);
    await h.idle();
    assert.equal(h.session.status('grafton-mission'), 'active');
    const first = await gm.startStoryJump('grafton-mission');
    assert.ok(first.ok, first.reason);
    assert.equal(h.session.status('grafton-mission'), 'active');
    assert.equal(h.director.runtime.eventStatus('event-2'), 'idle');
    await h.travel('shadow-forest-west');
    await h.region('event-2');
    assert.equal(h.session.status('quest-381'), 'ready');
  } finally { h.director.dispose(); }
});

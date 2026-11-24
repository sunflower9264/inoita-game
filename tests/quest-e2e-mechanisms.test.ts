import assert from 'node:assert/strict';
import test from 'node:test';
import { moneyGain } from '../src/domain/economy.ts';
import { claimStoryTrigger } from '../src/domain/story-trigger-occupancy.ts';
import { buildStoryTriggerIndex } from '../src/domain/story-trigger-index.ts';
import { createQuestE2EHarness } from './support/quest-e2e-harness.ts';
import { createMiniQuestWorld } from './support/quest-mini-world.ts';

const miniContent = createMiniQuestWorld();

test('主线接取、商人让位、交付弹窗挂起后续剧情、按职业发奖与交完恢复开店', async () => {
  for (const [classId, expectedArmor, forbiddenArmor] of [
    ['dark-knight', 'berkel-plate-armor', 'berkel-leather-armor'],
    ['assassin', 'berkel-leather-armor', 'berkel-plate-armor'],
  ] as const) {
    const h = createQuestE2EHarness(miniContent, { classId });
    try {
      const startGate = h.pauseOnPopup('start');
      const acceptPromise = h.fireStoryEvent(miniContent.campaign.events.find(e => e.id === 'ev-accept-main')!);
      for (let i = 0; i < 20 && !startGate.isOpen(); i++) await new Promise<void>(r => setImmediate(r));

      assert.equal(startGate.isOpen(), true, '接取弹窗应处于打开阻塞状态');
      assert.equal(h.session.status('q-main-hunt'), 'active', '弹窗打开瞬间任务状态必须已提交为进行中');
      assert.equal(h.session.itemCount('west-mine-key'), 1, '接取赠送物品应已入包');
      assert.equal(
        h.visibleEntities('camp').some(e => e.characterId === 'npc-qm'),
        false,
        '军需商人在主线未完成期间被剧情暂时移走',
      );
      await startGate.confirm();
      await acceptPromise;

      // 日志外路障任务不弹任何任务面板，扣除钥匙即可完成
      const popupsBeforeGate = h.log.popups.length;
      await h.interactByIdentity('barricade', 'npc-barricade');
      assert.equal(h.session.status('q-hidden-gate'), 'completed');
      assert.equal(h.session.itemCount('west-mine-key'), 0);
      assert.equal(h.log.popups.length, popupsBeforeGate, '日志外任务交付绝不弹出面板');

      // 军需商人在主线尚未就绪时若在场交互，不占用任务槽而是正常打开商店
      const qmEntity = miniContent.maps.get('camp')!.entities.find(e => e.characterId === 'npc-qm')!;
      assert.equal(await h.interactWithEntity(qmEntity, 'camp'), 'shop');
      assert.equal(h.log.shopsOpened.length, 1);

      // 完成第一只魔物击杀与掉落拾取：触发「任务进度」瞬时消息
      const mainQuest = miniContent.campaign.quests.find(q => q.id === 'q-main-hunt')!;
      const reagentDef = miniContent.battle.enemies.find(e => e.id === 'enemy-reagents-1')!;
      h.setCurrentMap('wilds');
      const r1 = h.session.settleEnemyDefeat({
        key: 'reagent-1',
        spawn: { id: 'reagent-1', enemyId: 'enemy-reagents-1', x: 32, y: 32 },
        enemy: reagentDef,
        map: 'wilds',
        x: 32,
        y: 32,
        lootLevel: 1,
        enemyLevel: reagentDef.level ?? 1,
        elite: false,
        earnsExperience: true,
        pressureMode: false,
        drops: miniContent.drops,
        stats: miniContent.stats,
        random: () => 0,
        landing: (x, y) => ({ x, y }),
      });
      r1?.notify();
      // 同一生成点未刷新前重复结算不会重复记账
      assert.equal(
        h.session.settleEnemyDefeat({
          key: 'reagent-1',
          spawn: { id: 'reagent-1', enemyId: 'enemy-reagents-1', x: 32, y: 32 },
          enemy: reagentDef,
          map: 'wilds',
          x: 32,
          y: 32,
          lootLevel: 1,
          enemyLevel: reagentDef.level ?? 1,
          elite: false,
          earnsExperience: true,
          pressureMode: false,
          drops: miniContent.drops,
          stats: miniContent.stats,
          random: () => 0,
          landing: (x, y) => ({ x, y }),
        }),
        undefined,
      );
      h.collectAllGroundLootOnMap('wilds');
      assert.ok(h.log.instants.some(msg => msg.includes('1/2')), '应产生任务进度瞬时提示');

      // 完成第二只魔物：进入待交付后，原本被移走的军需商人自动恢复可见并让位给交付对话
      await h.fulfillQuestGoals(mainQuest);
      assert.equal(h.session.status('q-main-hunt'), 'ready');
      assert.ok(h.log.instants.some(msg => msg.includes('清剿荒原魔物')), '应产生任务可交付瞬时提示');
      assert.equal(
        h.visibleEntities('camp').some(e => e.characterId === 'npc-qm'),
        true,
        '任务进入待交付后，同图交付人自动恢复现身',
      );

      // 挂起完成奖励弹窗：验证扣物发奖已提交，但后续关联任务剧情 ev-after-main 在关窗前绝不抢跑
      const completeGate = h.pauseOnPopup('complete');
      const deliverPromise = h.interactByIdentity('quartermaster', 'npc-qm');
      for (let i = 0; i < 20 && !completeGate.isOpen(); i++) await new Promise<void>(r => setImmediate(r));

      assert.equal(completeGate.isOpen(), true);
      assert.equal(h.session.status('q-main-hunt'), 'completed');
      assert.equal(h.session.itemCount('ectoplasm'), 0, '交接材料已扣除');
      assert.equal(h.session.itemCount(expectedArmor), 1, '发放主角本职业专属护甲');
      assert.equal(h.session.itemCount(forbiddenArmor), 0, '过滤非本职业护甲');
      assert.equal(h.session.storyWorld.hasFlag('after-main-fired'), false, '完成弹窗关闭前后续任务剧情严禁提前开演');

      await completeGate.confirm();
      await deliverPromise;
      assert.equal(h.session.storyWorld.hasFlag('after-main-fired'), true, '确认关闭完成弹窗后自动放行后续任务剧情');

      // 交完主线且把支线接走进入 active（不占用可接/待交槽）后，再次与军需商人交互恢复打开商店
      h.session.accept('q-side-tusk-b');
      assert.equal(await h.interactWithEntity(qmEntity, 'camp'), 'shop');
      assert.equal(h.log.shopsOpened.length, 2);
    } finally {
      h.dispose();
    }
  }
});

test('两条进行中任务共享同种材料时，交完第一条立即使第二条退回进行中防双花', async () => {
  const h = createQuestE2EHarness(miniContent);
  try {
    h.session.applyStoryCommands([
      { type: 'item-give', item: 'ectoplasm', quantity: 2 },
      { type: 'quest', command: { type: 'script-complete', quest: 'q-main-hunt' } },
      { type: 'item-give', item: 'ectoplasm', quantity: 1 },
    ]);
    await h.settle();

    await h.interactByIdentity('captain', 'npc-captain');
    await h.interactByIdentity('quartermaster', 'npc-qm');
    assert.equal(h.session.status('q-side-tusk-a'), 'ready');
    assert.equal(h.session.status('q-side-tusk-b'), 'ready');

    await h.interactByIdentity('captain', 'npc-captain');
    assert.equal(h.session.status('q-side-tusk-a'), 'completed');
    assert.equal(h.session.itemCount('ectoplasm'), 0);
    assert.equal(h.session.status('q-side-tusk-b'), 'active');

    const moneyAfterFirst = h.session.money;
    await h.interactByIdentity('quartermaster', 'npc-qm');
    assert.equal(h.session.status('q-side-tusk-b'), 'active', '缺少材料时交互只播未完成提示，不能完成');
    assert.equal(h.session.money, moneyAfterFirst);
  } finally {
    h.dispose();
  }
});

test('确认门取消重开、跨章清空未完成支线与多轮融合器重复交付', async () => {
  const h = createQuestE2EHarness(miniContent);
  try {
    for (let cycle = 1; cycle <= 2; cycle++) {
      assert.equal(h.session.status('q-repeat-forger'), 'available');
      await h.interactByIdentity('forger', 'npc-forger');
      assert.equal(h.session.status('q-repeat-forger'), 'active');
      assert.equal(await h.interactByIdentity('forger', 'npc-forger'), 'crafting');

      await h.fulfillQuestGoals(miniContent.campaign.quests.find(q => q.id === 'q-repeat-forger')!);
      assert.equal(h.session.status('q-repeat-forger'), 'ready');
      await h.interactByIdentity('forger', 'npc-forger');
      assert.equal(h.session.questBook.completedCycles('q-repeat-forger'), cycle);
      assert.equal(h.session.status('q-repeat-forger'), 'available', '可重复任务交付后重置回可接取');
    }

    h.session.applyStoryCommands([
      { type: 'item-give', item: 'ectoplasm', quantity: 2 },
      { type: 'quest', command: { type: 'script-complete', quest: 'q-main-hunt' } },
      { type: 'quest', command: { type: 'accept', quest: 'q-side-tusk-a' } },
      { type: 'quest', command: { type: 'accept', quest: 'q-repeat-forger' } },
      { type: 'item-give', item: 'ectoplasm', quantity: 1 },
    ]);
    await h.settle();
    assert.equal(h.session.status('q-gate-confirm'), 'ready');
    assert.equal(h.session.status('q-side-tusk-a'), 'ready');
    assert.equal(h.session.status('q-repeat-forger'), 'ready');

    assert.equal(h.session.complete('q-gate-confirm'), false);

    // 第一次选「否（option-1）」取消：确认门保持 ready，支线原封不动，且可再次交互重开
    h.queueChoices('option-1');
    await h.interactByIdentity('sealstone', 'npc-seal');
    assert.equal(h.session.status('q-gate-confirm'), 'ready');
    assert.equal(h.session.status('q-side-tusk-a'), 'ready');

    // 第二次选「是（option-0）」跨越：reset-side-quests 清空所有进行中/待交付支线，随后击败石魔推进主线
    h.queueChoices('option-0');
    await h.interactByIdentity('sealstone', 'npc-seal');
    await h.settleActiveEncounters();

    assert.equal(h.session.status('q-gate-confirm'), 'completed');
    assert.equal(h.session.storyWorld.hasFlag('seal-cleared'), true);
    assert.equal(h.session.status('q-side-tusk-a'), 'available', '未交付支线在跨章重置后退回可接取');
    assert.equal(h.session.status('q-repeat-forger'), 'available');
  } finally {
    h.dispose();
  }
});

test('可选接取脚本拒绝后重接、交互反馈去重、残血变身捕捉与穿戴快捷满足', async () => {
  const h = createQuestE2EHarness(miniContent);
  try {
    h.session.applyStoryCommands([{ type: 'flag', flag: 'unlock-optional', value: true }]);
    await h.settle();

    h.queueChoices('no');
    await h.interactByIdentity('captain', 'npc-captain');
    assert.equal(h.session.status('q-optional-offer'), 'available');

    h.queueChoices('yes');
    await h.interactByIdentity('captain', 'npc-captain');
    assert.equal(h.session.status('q-optional-offer'), 'active');
    assert.equal(h.log.popups.filter(p => p.questId === 'q-optional-offer' && p.kind === 'start').length, 1);

    const horns = miniContent.maps.get('wilds')!.entities.filter(e => e.actor === 'horn');
    await h.interactWithEntity(horns[0]!, 'wilds');
    assert.equal(h.session.quests.get('q-optional-offer')?.goals.horn, 1);
    await h.interactWithEntity(horns[1]!, 'wilds');
    assert.equal(h.session.status('q-optional-offer'), 'ready');
    // 目标记满后再次交互号角不再重复记账、也不再重复弹出交互反馈提示
    await h.interactWithEntity(horns[0]!, 'wilds');
    assert.equal(h.session.quests.get('q-optional-offer')?.goals.horn, 2);
    assert.equal(h.log.toasts.filter(t => t === '吹响了警戒号角！').length, 2, '已记满目标重复交互不再弹反馈');

    await h.interactByIdentity('captain', 'npc-captain');
    assert.equal(h.session.status('q-optional-offer'), 'completed');
    assert.equal(h.log.popups.filter(p => p.questId === 'q-optional-offer' && p.kind === 'complete').length, 1);

    await h.interactByIdentity('captain', 'npc-captain');
    assert.equal(h.session.status('q-wolf-capture'), 'active');
    await h.fulfillQuestGoals(miniContent.campaign.quests.find(q => q.id === 'q-wolf-capture')!);
    assert.equal(h.session.status('q-wolf-capture'), 'ready');
    assert.equal(
      h.visibleEntities('camp').some(e => e.id.startsWith('quest-target:')),
      false,
      'removeAfterInteraction 捕获后立即移除临时捕捉实体',
    );
    await h.interactByIdentity('captain', 'npc-captain');
    assert.equal(h.session.status('q-wolf-capture'), 'completed');

    // 穿戴快捷满足（equipped-item-shortcut）：主角升至可穿戴等级并穿戴后续目标「板甲」时，无需收集前置 3 份灵魂物质即直接就绪
    h.session.hero!.addExperience(100_000);
    h.session.bag.add('berkel-plate-armor', 1);
    const armorInstance = h.session.bag.entries.find(e => e.item === 'berkel-plate-armor')!;
    h.session.bag.equip(armorInstance.id, 'body', 'player');
    await h.interactByIdentity('captain', 'npc-captain');
    assert.equal(h.session.status('q-equip-shortcut'), 'ready', '穿戴后续目标装备应直接满足整条有序物品目标');
    await h.interactByIdentity('captain', 'npc-captain');
    assert.equal(h.session.status('q-equip-shortcut'), 'completed');
  } finally {
    h.dispose();
  }
});

test('跳过剧情在选项和任务弹窗前停下，未提交前取消演出完整回滚，弹窗报错重试不丢奖不双发', async () => {
  const h1 = createQuestE2EHarness(miniContent);
  try {
    h1.session.applyStoryCommands([{ type: 'flag', flag: 'unlock-optional', value: true }]);
    h1.setPauseDialogue(true);
    const runOffer = h1.interactByIdentity('captain', 'npc-captain');
    for (let i = 0; i < 15 && h1.ui.pending === null; i++) await new Promise<void>(r => setImmediate(r));
    assert.ok(h1.ui.pending !== null, '首句对白正在等待翻页');

    const startPopupGate = h1.pauseOnPopup('start');
    h1.queueChoices('yes');
    h1.setPauseDialogue(false);
    h1.pressSkip();
    for (let i = 0; i < 20 && !startPopupGate.isOpen(); i++) await new Promise<void>(r => setImmediate(r));
    assert.ok(h1.log.skipPhases.includes('choice'), '跳过应在选项处暂停报告 choice 阶段');
    assert.ok(h1.log.skipPhases.includes('quest-popup'), '跳过应在任务弹窗处暂停报告 quest-popup 阶段');
    await startPopupGate.confirm();
    await runOffer;
    assert.equal(h1.session.status('q-optional-offer'), 'active');
  } finally {
    h1.dispose();
  }

  const h2 = createQuestE2EHarness(miniContent);
  try {
    h2.setPauseDialogue(true);
    const runAccept = h2.fireStoryEvent(miniContent.campaign.events.find(e => e.id === 'ev-accept-main')!);
    for (let i = 0; i < 15 && h2.ui.pending === null; i++) await new Promise<void>(r => setImmediate(r));
    h2.director.cancel();
    h2.setPauseDialogue(false);
    await runAccept;
    assert.equal(h2.session.status('q-main-hunt'), 'available');
    assert.equal(
      h2.visibleEntities('camp').some(e => e.characterId === 'npc-qm'),
      true,
      '未提交前取消演出不应把军需商人移走',
    );
  } finally {
    h2.dispose();
  }

  let injectedOnce = false;
  const h3 = createQuestE2EHarness(miniContent, {
    onStageAction() {
      if (!injectedOnce && h3.session.status('q-main-hunt') === 'completed') {
        injectedOnce = true;
        throw new Error('模拟舞台贴图加载失败');
      }
    },
  });
  try {
    h3.setExpectErrors(true);
    await h3.fireStoryEvent(miniContent.campaign.events.find(e => e.id === 'ev-accept-main')!);
    await h3.fulfillQuestGoals(miniContent.campaign.quests.find(q => q.id === 'q-main-hunt')!);
    const moneyBefore = h3.session.money;
    await h3.interactByIdentity('quartermaster', 'npc-qm');

    assert.equal(injectedOnce, true);
    assert.equal(h3.ui.failed, true, 'GameUI 应进入错误重试遮罩状态');
    assert.equal(h3.session.money, moneyBefore + moneyGain(120), '已完成任务的金币奖励不得丢失');
    assert.equal(h3.session.storyWorld.hasFlag('after-main-fired'), false, '抛错节点尚未提交');

    h3.setExpectErrors(false);
    h3.log.errors.length = 0;
    await h3.pressRetry();
    assert.equal(h3.ui.failed, false);
    assert.equal(h3.session.storyWorld.hasFlag('after-main-fired'), true, '点击重试后恢复完成后续剧情');
    assert.equal(h3.session.money, moneyBefore + moneyGain(120), '重试绝不二次发放奖励');
    assert.equal(
      h3.session.captureState().receipts.filter(r => r.quest === 'q-main-hunt').length,
      1,
      '奖励收据严格只有一份',
    );
  } finally {
    h3.dispose();
  }
});

test('触发区占用记录与已完成任务经正式格式 1 存读档恢复后不重播、不重复结算', async () => {
  const h = createQuestE2EHarness(miniContent);
  try {
    const campChars = h.visibleEntities('camp').map(entity => ({
      entity,
      container: { visible: true },
    }));
    const index = buildStoryTriggerIndex(miniContent.campaign, 'camp', campChars);
    const occupiedRegions = new Set<string>();
    const firstClaim = claimStoryTrigger(
      index.regionEvents,
      occupiedRegions,
      ev => ev.id === 'ev-accept-main',
      ev => ev.id,
    );
    assert.equal(firstClaim?.event.id, 'ev-accept-main');
    h.setTriggerContacts({ regions: [...occupiedRegions], characters: ['ent-seal'], nearEvents: ['ev-seal-prompt'] });

    await h.fireStoryEvent(miniContent.campaign.events.find(e => e.id === 'ev-accept-main')!);
    await h.fulfillQuestGoals(miniContent.campaign.quests.find(q => q.id === 'q-main-hunt')!);
    await h.interactByIdentity('quartermaster', 'npc-qm');
    const settledMoney = h.session.money;

    const { restored } = h.roundtripSaveLoad();
    try {
      assert.deepEqual(restored.triggerContacts.regions, ['ev-accept-main'], '正式读档保留区域接触占用表');
      assert.deepEqual(restored.triggerContacts.nearEvents, ['ev-seal-prompt'], '正式读档保留近身事件占用表');

      const restoredOccupied = new Set(restored.triggerContacts.regions);
      const duplicateClaim = claimStoryTrigger(
        index.regionEvents,
        restoredOccupied,
        ev => ev.id === 'ev-accept-main',
        ev => ev.id,
      );
      assert.equal(duplicateClaim, null, '未离开触发区域时读档不会再次触发');

      claimStoryTrigger(index.regionEvents, restoredOccupied, () => false, ev => ev.id);
      assert.equal(restoredOccupied.size, 0);

      assert.equal(restored.session.status('q-main-hunt'), 'completed');
      assert.equal(restored.session.complete('q-main-hunt'), false);
      assert.equal(restored.session.money, settledMoney);
    } finally {
      restored.dispose();
    }
  } finally {
    h.dispose();
  }
});

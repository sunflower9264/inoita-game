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
      // 军需商人在主线尚未接取/未就绪且在场可见时，不占用任务槽而是正常打开商店
      const qmEntity = miniContent.maps.get('camp')!.entities.find(e => e.characterId === 'npc-qm')!;
      assert.equal(await h.interactWithEntity(qmEntity, 'camp'), 'shop');
      assert.equal(h.log.shopsOpened.length, 1);

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

      // 已被剧情移走的军需商人严禁被底座兜底找回或交互
      await assert.rejects(() => h.interactByIdentity('quartermaster', 'npc-qm'), /找不到目标角色/);

      // 日志外路障任务不弹任何任务面板，扣除钥匙即可完成
      const popupsBeforeGate = h.log.popups.length;
      await h.interactByIdentity('barricade', 'npc-barricade');
      assert.equal(h.session.status('q-hidden-gate'), 'completed');
      assert.equal(h.session.itemCount('west-mine-key'), 0);
      assert.equal(h.log.popups.length, popupsBeforeGate, '日志外任务交付绝不弹出面板');

      // 完成第一只魔物击杀与掉落拾取：触发「任务进度」瞬时消息
      const mainQuest = miniContent.campaign.quests.find(q => q.id === 'q-main-hunt')!;
      const reagentDef = miniContent.battle.enemies.find(e => e.id === 'enemy-reagents-1')!;
      h.setCurrentMap('wilds');
      const r1 = h.session.settleEnemyDefeat({
        key: 'wilds-reagent-1',
        spawn: { id: 'wilds-reagent-1', enemyId: 'enemy-reagents-1', x: 96, y: 80 },
        enemy: reagentDef,
        map: 'wilds',
        x: 96,
        y: 80,
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
          key: 'wilds-reagent-1',
          spawn: { id: 'wilds-reagent-1', enemyId: 'enemy-reagents-1', x: 96, y: 80 },
          enemy: reagentDef,
          map: 'wilds',
          x: 96,
          y: 80,
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
      h.visibleEntities('wilds').some(e => e.id.startsWith('quest-target:')),
      false,
      'removeAfterInteraction 捕获后立即从 wilds 移除临时捕捉实体',
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
    assert.deepEqual(h.triggerContacts.regions, ['ev-accept-main'], '真实走入区域触发框后自动登记区域占用');
    await h.fulfillQuestGoals(miniContent.campaign.quests.find(q => q.id === 'q-main-hunt')!);
    await h.interactByIdentity('quartermaster', 'npc-qm');
    h.setTriggerContacts({ regions: ['ev-accept-main'], characters: ['ent-seal'], nearEvents: ['ev-seal-prompt'] });
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

test('底座五项硬核对反作弊自证：隐身人物、动态路障封框、禁用刷怪点、无来源物品与锁死出口均立即拦截，纯几何清障不依赖英文名且不误伤路人', async () => {
  const h = createQuestE2EHarness(miniContent);
  try {
    // 1. 人物被 actor-visibility 隐藏后，locateEntity 与交互直接判失败（不回退原始地图表、不造虚拟实体）
    h.session.applyStoryCommands([
      { type: 'world', command: { kind: 'actor-visibility', map: 'camp', actor: 'captain', characterId: 'npc-captain', visible: false } },
    ]);
    assert.throws(() => h.locateEntity('captain', 'npc-captain', ['camp']), /找不到目标角色/);

    // 2. 动态路障（即使使用非路障英文名）将 region 触发框完全封死且无解锁事件时，assertRegionReachable 立即判失败
    const blockedRegion = { x: 0, y: 0, width: 16, height: 16 };
    h.session.applyStoryCommands([
      {
        type: 'world',
        command: {
          kind: 'place',
          entity: { id: 'wall-1', map: 'camp', actor: 'sealstone', x: 8, y: 8, visible: true },
        },
      },
      {
        type: 'world',
        command: {
          kind: 'place',
          entity: { id: 'wall-2', map: 'camp', actor: 'sealstone', x: 24, y: 8, visible: true },
        },
      },
      {
        type: 'world',
        command: {
          kind: 'place',
          entity: { id: 'wall-3', map: 'camp', actor: 'sealstone', x: 8, y: 24, visible: true },
        },
      },
      {
        type: 'world',
        command: {
          kind: 'place',
          entity: { id: 'wall-4', map: 'camp', actor: 'sealstone', x: 24, y: 24, visible: true },
        },
      },
    ]);
    assert.throws(() => h.assertRegionReachable('camp', blockedRegion, 'blocked-corner'), /不可达或被动态路障堵死/);

    // 3. 地图上不存在该敌人刷怪点时，locateSpawnedEnemy 立即判失败（严禁编造假刷怪点）
    assert.throws(() => h.locateSpawnedEnemy('enemy-earl-grafton-1', ['wilds']), /WorldEnemyRoster 中均找不到已启用的敌人/);

    // 4. 构造无掉落、无采集点、无发物事件、无奖励且商店不卖的任务物品，fulfillQuestGoals 必须直接报错（严禁凭空塞包）
    const fakeQuest = {
      ...miniContent.campaign.quests.find(q => q.id === 'q-side-tusk-a')!,
      goals: [{ id: 'impossible', kind: 'item' as const, target: 'royal-dagger', quantity: 1, label: '不存在来源物品' }],
      handoverItems: [],
    };
    await assert.rejects(() => h.fulfillQuestGoals(fakeQuest), /均无可用合法来源/);
  } finally {
    h.dispose();
  }

  // 5. 同岛出口被 exitRules 锁死时，换图、找人、打怪、拿物与跨岛通道均严禁穿墙，必须立即报错拦截；无剧情桥接的孤岛同样拒绝跨岛
  const lockedContent = {
    ...miniContent,
    campaign: {
      ...miniContent.campaign,
      exitRules: [
        {
          map: 'camp',
          id: 'camp-to-wilds',
          condition: { type: 'flag' as const, flag: 'wilds-exit-unlocked', value: true },
        },
      ],
    },
  };
  const hLocked = createQuestE2EHarness(lockedContent);
  try {
    assert.equal(hLocked.reachableMapsFrom('camp').has('wilds'), false, '出口锁死时 wilds 必须不可达');
    assert.throws(
      () => hLocked.travelToMapEntrance('wilds'),
      /禁止穿墙换图/,
      '出口被 exitRules 锁死时严禁通过普通换图穿墙进入 wilds',
    );
    assert.throws(
      () => hLocked.crossIslandToMap('wilds', 'test-locked-door'),
      /同岛出口被锁死，严禁当作跨岛任务穿墙/,
      '同岛出口锁死绝不能冒充跨岛任务绕过',
    );
    assert.throws(
      () => hLocked.locateEntity('horn', 'npc-horn', ['wilds']),
      /找不到目标角色/,
      '出口锁死时严禁穿墙定位不可达地图上的人物/机关',
    );
    assert.throws(
      () => hLocked.locateSpawnedEnemy('enemy-reagents-1', ['wilds']),
      /可达候选地图.*找不到已启用的敌人/,
      '出口被 exitRules 锁死时严禁穿墙跨图定位敌人',
    );
    const lockedQuest = lockedContent.campaign.quests.find(q => q.id === 'q-side-tusk-a')!;
    await assert.rejects(
      () => hLocked.fulfillQuestGoals(lockedQuest),
      /可达掉落表.*未能真实获得|无可用合法来源/,
      '出口被 exitRules 锁死时严禁穿墙跨图刷取任务物品',
    );
  } finally {
    hLocked.dispose();
  }

  // 5b. 没有任何静态出口且没有任何正式剧情 stage/travel 桥接的孤立死岛，跨岛通道同样必须拒绝
  const orphanMap = {
    ...miniContent.maps.get('wilds')!,
    id: 'orphan-island',
    name: '无桥孤岛',
    exits: [],
  };
  const orphanContent = {
    ...miniContent,
    maps: new Map([...miniContent.maps, ['orphan-island', orphanMap]]),
  };
  const hOrphan = createQuestE2EHarness(orphanContent);
  try {
    assert.throws(
      () => hOrphan.crossIslandToMap('orphan-island', 'test-orphan'),
      /没有任何正式剧情切图桥接，严禁跨岛/,
      '无任何正式剧情桥接的孤岛必须被跨岛通道拒绝',
    );
  } finally {
    hOrphan.dispose();
  }

  // 6. 纯几何清障自证：非关键字障碍（sealstone）挡住区域触发框且有正式清障事件时自动打通，同时不误触发隐藏旁观村民的事件
  const geoContent = {
    ...miniContent,
    campaign: {
      ...miniContent.campaign,
      scripts: {
        ...miniContent.campaign.scripts,
        's-clear-seal-wall': {
          entry: 'n',
          nodes: [
            {
              id: 'n',
              presentation: [],
              commands: [{ type: 'world' as const, command: { kind: 'actor-visibility' as const, map: 'camp', actor: 'sealstone', visible: false } }],
              exit: { type: 'end' as const },
            },
          ],
        },
        's-hide-bystander': {
          entry: 'n',
          nodes: [
            {
              id: 'n',
              presentation: [],
              commands: [{ type: 'world' as const, command: { kind: 'actor-visibility' as const, map: 'camp', actor: 'captain', characterId: 'npc-captain', visible: false } }],
              exit: { type: 'end' as const },
            },
          ],
        },
        's-enter-corner': {
          entry: 'n',
          nodes: [
            {
              id: 'n',
              presentation: [],
              commands: [{ type: 'flag' as const, flag: 'corner-reached', value: true }],
              exit: { type: 'end' as const },
            },
          ],
        },
      },
      events: [
        ...miniContent.campaign.events,
        { id: 'ev-hide-bystander', source: 'event' as const, key: 'hide-bystander', map: 'camp', script: 's-hide-bystander' },
        { id: 'ev-clear-seal-wall', source: 'event' as const, key: 'clear-seal-wall', map: 'camp', script: 's-clear-seal-wall' },
        { id: 'ev-enter-corner', source: 'region' as const, map: 'camp', region: { x: 0, y: 0, width: 16, height: 16 }, script: 's-enter-corner' },
      ],
    },
  };
  const hGeo = createQuestE2EHarness(geoContent);
  try {
    hGeo.session.applyStoryCommands([
      { type: 'world', command: { kind: 'place', entity: { id: 'seal-w1', map: 'camp', actor: 'sealstone', x: 8, y: 8, visible: true } } },
      { type: 'world', command: { kind: 'place', entity: { id: 'seal-w2', map: 'camp', actor: 'sealstone', x: 24, y: 8, visible: true } } },
      { type: 'world', command: { kind: 'place', entity: { id: 'seal-w3', map: 'camp', actor: 'sealstone', x: 8, y: 24, visible: true } } },
      { type: 'world', command: { kind: 'place', entity: { id: 'seal-w4', map: 'camp', actor: 'sealstone', x: 24, y: 24, visible: true } } },
    ]);
    await hGeo.fireStoryEvent(geoContent.campaign.events.find(e => e.id === 'ev-enter-corner')!);
    assert.equal(hGeo.session.storyWorld.hasFlag('corner-reached'), true, '纯几何判定应自动识别并触发非关键字清障事件');
    assert.equal(
      hGeo.visibleEntities('camp').some(e => e.characterId === 'npc-captain'),
      true,
      '纯几何判定绝不误触发隐藏旁观村民的无关事件',
    );
  } finally {
    hGeo.dispose();
  }
});

test('正式地图触发竞争与进图事件：同点区域事件压制近身事件、跨图共用机关不串触发、进图事件自动派发', async () => {
  const triggerContent = {
    ...miniContent,
    campaign: {
      ...miniContent.campaign,
      scripts: {
        ...miniContent.campaign.scripts,
        's-region-first': {
          entry: 'n',
          nodes: [
            {
              id: 'n',
              presentation: [],
              commands: [{ type: 'flag' as const, flag: 'region-fired', value: true }],
              exit: { type: 'end' as const },
            },
          ],
        },
        's-near-second': {
          entry: 'n',
          nodes: [
            {
              id: 'n',
              presentation: [],
              commands: [{ type: 'flag' as const, flag: 'near-fired', value: true }],
              exit: { type: 'end' as const },
            },
          ],
        },
        's-wilds-horn-near': {
          entry: 'n',
          nodes: [
            {
              id: 'n',
              presentation: [],
              commands: [{ type: 'flag' as const, flag: 'wilds-horn-fired', value: true }],
              exit: { type: 'end' as const },
            },
          ],
        },
        's-wilds-entry': {
          entry: 'n',
          nodes: [
            {
              id: 'n',
              presentation: [],
              commands: [{ type: 'flag' as const, flag: 'wilds-entry-fired', value: true }],
              exit: { type: 'end' as const },
            },
          ],
        },
      },
      events: [
        ...miniContent.campaign.events,
        {
          id: 'ev-camp-overlap-region',
          source: 'region' as const,
          map: 'camp',
          region: { x: 104, y: 72, width: 16, height: 16 },
          script: 's-region-first',
        },
        {
          id: 'ev-camp-overlap-near',
          source: 'near' as const,
          map: 'camp',
          near: 'forger',
          nearCharacterId: 'npc-forger',
          script: 's-near-second',
        },
        {
          id: 'ev-wilds-horn-near',
          source: 'near' as const,
          map: 'wilds',
          near: 'horn',
          nearCharacterId: 'npc-horn',
          script: 's-wilds-horn-near',
        },
        {
          id: 'ev-wilds-entry',
          source: 'map-entry' as const,
          key: 'wilds',
          map: 'wilds',
          script: 's-wilds-entry',
        },
      ],
    },
  };

  const h = createQuestE2EHarness(triggerContent);
  try {
    // 1. 同一站立点同时命中区域事件与近身事件时，第一拍严格选区域事件并压制近身事件，第二拍才轮到近身事件
    const step1 = await h.stepWorldTriggersAt('camp', { x: 112, y: 80 });
    assert.deepEqual(step1, { kind: 'region', eventId: 'ev-camp-overlap-region', played: true });
    assert.equal(h.session.storyWorld.hasFlag('region-fired'), true);
    assert.equal(h.session.storyWorld.hasFlag('near-fired'), false, '同点区域事件未结算完前必须压制近身事件');

    const step2 = await h.stepWorldTriggersAt('camp', { x: 112, y: 80 });
    assert.deepEqual(step2, { kind: 'near', eventId: 'ev-camp-overlap-near', played: true });
    assert.equal(h.session.storyWorld.hasFlag('near-fired'), true);

    // 2. 在 camp 临时摆一个同编号 horn 机关，限定在 wilds 的近身事件绝不能在 camp 被误触发
    h.session.applyStoryCommands([
      {
        type: 'world',
        command: {
          kind: 'place',
          entity: { id: 'camp-horn', map: 'camp', actor: 'horn', characterId: 'npc-horn', x: 24, y: 120, visible: true },
        },
      },
    ]);
    const campHornStep = await h.stepWorldTriggersAt('camp', { x: 24, y: 136 });
    assert.equal(campHornStep, null, '限定了 wilds 地图的近身事件严禁在 camp 同编号机关上串触发');
    assert.equal(h.session.storyWorld.hasFlag('wilds-horn-fired'), false);

    // 3. 普通跨图进入 wilds 时，无需手动点名事件即自动触发 map-entry 进图事件
    h.travelToMapEntrance('wilds');
    await h.settle();
    assert.equal(h.session.storyWorld.hasFlag('wilds-entry-fired'), true, '进入新地图时应自动派发 map-entry 进图事件');
  } finally {
    h.dispose();
  }
});

test('正式世界交互选目标竞争与柜台距离：同坐标目标未满先选目标、记满自动切交付人，无资格摆设与超柜台距离严禁交互', async () => {
  const propActor = {
    ...miniContent.world.actors.sealstone!,
    id: 'silent_prop',
    name: '石柱',
    description: '',
  };
  const campBase = miniContent.maps.get('camp')!;
  const stackedContent = {
    ...miniContent,
    world: {
      ...miniContent.world,
      actors: {
        ...miniContent.world.actors,
        silent_prop: propActor,
      },
    },
    maps: new Map([
      ...miniContent.maps,
      [
        'camp',
        {
          ...campBase,
          entities: [
            ...campBase.entities,
            // 将一个号角目标与队长（交付人）重叠摆在同一像素坐标，并额外摆一个无任何交互资格的石柱
            { id: 'stacked-horn', actor: 'horn', characterId: 'npc-horn', objective: 'horn', x: 64, y: 64, flip: false },
            { id: 'silent-pillar', actor: 'silent_prop', x: 24, y: 120, flip: false },
          ],
        },
      ],
    ]),
  };
  const h = createQuestE2EHarness(stackedContent);
  try {
    h.session.applyStoryCommands([{ type: 'flag', flag: 'unlock-optional', value: true }]);
    await h.settle();

    // 1. 无任何任务/服务/商店/描述/目标资格的纯摆设严禁被选中或点名交互
    assert.equal(h.selectInteractionTargetAt('camp', { x: 24, y: 136 }), null);
    const pillar = h.visibleEntities('camp').find(e => e.id === 'silent-pillar')!;
    await assert.rejects(() => h.interactWithEntity(pillar, 'camp'), /无任何正式交互资格/);

    // 2. 接取号角支线后，同坐标(64,64)上 stacked-horn 为 0 档（推进目标），captain 为 1 档（进行中标记）：
    //    目标未满前站在(64,80)必须选中 stacked-horn，且严禁跨过它直接选中被遮蔽的 captain
    h.queueChoices('yes');
    await h.interactByIdentity('captain', 'npc-captain');
    assert.equal(h.session.status('q-optional-offer'), 'active');

    assert.equal(h.selectInteractionTargetAt('camp', { x: 64, y: 80 })?.entity.id, 'stacked-horn');
    const captainEnt = h.visibleEntities('camp').find(e => e.characterId === 'npc-captain')!;
    await assert.rejects(() => h.interactWithEntity(captainEnt, 'camp'), /被其他高优先级对象抢占/);

    const stackedHornEnt = h.visibleEntities('camp').find(e => e.id === 'stacked-horn')!;
    await h.interactWithEntity(stackedHornEnt, 'camp');
    assert.equal(h.session.quests.get('q-optional-offer')?.goals.horn, 1);

    // 去猎场吹响第 2 只号角记满目标后，q-optional-offer 变为 ready：同坐标(64,64)上 captain 升为 0 档（待交付），stacked-horn 退为 2 档
    const wildsHorn = stackedContent.maps.get('wilds')!.entities.find(e => e.actor === 'horn')!;
    await h.interactWithEntity(wildsHorn, 'wilds');
    assert.equal(h.session.status('q-optional-offer'), 'ready');

    assert.equal(h.selectInteractionTargetAt('camp', { x: 64, y: 80 })?.entity.id, 'ent-captain', '目标记满后同点自动切换选中交付人');
    await h.interactWithEntity(captainEnt, 'camp');
    assert.equal(h.session.status('q-optional-offer'), 'completed');
  } finally {
    h.dispose();
  }
});

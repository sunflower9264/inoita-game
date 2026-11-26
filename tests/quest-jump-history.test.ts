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

test('跳转现场会投影目标发布人显形、区域清障与常驻敌怪摆放，且不污染无关完成事件', () => {
  // 1. 隐藏发布人显形（暗黑魔法师凯恩 / 赏金猎人拉尔斯）与普通发布人任务落图
  {
    const h = playthrough();
    try {
      const p171 = planQuestStart(campaign, h.session, 'quest-171');
      applyQuestStartPlan(h.session, p171);
      assert.equal(h.session.storyWorld.actorVisible('shadow-hall', 'dark-sorcerer-kane-369ccd17', 'npc-364'), true);

      const p347 = planQuestStart(campaign, h.session, 'quest-347');
      assert.equal(p347.destination?.map, 'training-dungeon-one');
      applyQuestStartPlan(h.session, p347);
      assert.equal(h.session.storyWorld.actorVisible('training-dungeon-one', 'bounty-hunter-lars-9521311c', 'npc-593'), true);
      assert.equal(h.session.runtimeState.completedEvents.includes('event-19'), false);
    } finally { h.director.dispose(); }
  }

  // 2. 贝勒塞首都区域触发框前的路障清障，且不把无关的 event-19 拉进 completedEvents
  {
    const h = playthrough();
    try {
      const p146 = planQuestStart(campaign, h.session, 'quest-146');
      applyQuestStartPlan(h.session, p146);
      assert.equal(h.session.storyWorld.actorVisible('berkel-capital', 'barricade-a1eb664e', 'npc-120'), false);
      assert.equal(h.session.runtimeState.completedEvents.includes('event-19'), false);
    } finally { h.director.dispose(); }
  }

  // 3. 救出长老（quest-122）恢复前置已完结任务留下的常驻剧情敌怪摆放
  {
    const h = playthrough();
    try {
      const p122 = planQuestStart(campaign, h.session, 'quest-122');
      applyQuestStartPlan(h.session, p122);
      assert.equal(
        h.session.storyWorld.enemySpawns('fort-of-screams-floor-3-c78c50b3').some(s => s.enemyId === 'enemy-prison-of-screams-headguard-1'),
        true,
      );
    } finally { h.director.dispose(); }
  }

  // 4. 记忆层任务（如 quest-400）优先选择未预设自身已完成的正式接取入口，不提前烧毁首领前置任务
  {
    const h = playthrough();
    try {
      const p400 = planQuestStart(campaign, h.session, 'quest-400');
      assert.equal(p400.accept?.eventId, 'event-447');
      applyQuestStartPlan(h.session, p400);
      assert.notEqual(h.session.status('quest-376'), 'completed');
      assert.notEqual(h.session.status('quest-377'), 'completed');
    } finally { h.director.dispose(); }
  }

  // 5. 跨时间点跳转清理上一局访问级剧情敌怪（story-located-*）遗留的永久死亡记录
  {
    const h = playthrough();
    try {
      h.session.removeStoryEnemy('story-located-enemy-elf-seal-protector-1');
      assert.equal(h.session.enemyVitals('story-located-enemy-elf-seal-protector-1').deadUntil, 'permanent');
      applyQuestStartPlan(h.session, planQuestStart(campaign, h.session, 'quest-319'));
      assert.equal(h.session.enemyVitals('story-located-enemy-elf-seal-protector-1').deadUntil, undefined);
    } finally { h.director.dispose(); }
  }

  // 6. available 模式下目标任务自身的接取事件（如 quest-454 的 event-563）绝不提前重放进前置历史，保持现场铁门可见
  {
    const h = playthrough();
    try {
      const p454 = planQuestStart(campaign, h.session, 'quest-454');
      assert.equal(p454.accept?.eventId, 'event-563');
      assert.equal(p454.conditionPatch.completedEvents.includes('event-563'), false);
      applyQuestStartPlan(h.session, p454);
      assert.equal(
        h.session.storyWorld.actorVisible('kiyan-s-final-memory-layer-2-ecc3d1ca', 'steel-door-430a2b1b', 'npc-320'),
        true,
        '跳到「卓拉德」可接现场时，记忆 2 层铁门必须保持可见以供玩家靠近触发 event-563',
      );
    } finally { h.director.dispose(); }
  }
});

test('Session.forgetEnemyVitalsByPrefix 精准按前缀清理，历史显形与摆放投影严守先后护栏', () => {
  // 1. forgetEnemyVitalsByPrefix 只清理匹配前缀的条目，保留普通刷怪点记录并推进修订号
  const h = playthrough();
  try {
    h.session.removeStoryEnemy('story-located-alpha');
    h.session.removeStoryEnemy('story-located-beta');
    h.session.setEnemyVitals('normal-spawn-1', 42, 10);
    const revBefore = h.session.enemyRevision;
    const spawnRevBefore = h.session.enemySpawnRevision;

    assert.equal(h.session.forgetEnemyVitalsByPrefix('story-located-'), 2);
    assert.equal(h.session.enemyVitals('story-located-alpha').deadUntil, undefined);
    assert.equal(h.session.enemyVitals('story-located-beta').deadUntil, undefined);
    assert.equal(h.session.enemyVitals('normal-spawn-1').health, 42);
    assert.ok(h.session.enemyRevision > revBefore);
    assert.ok(h.session.enemySpawnRevision > spawnRevBefore);
    assert.equal(h.session.forgetEnemyVitalsByPrefix('story-located-'), 0);
  } finally {
    h.director.dispose();
  }

  // 2. 规则 1 / 规则 2 先后护栏：更晚章节的显形与登记摆放事件绝不被提前拉进早期任务的 available 现场
  const chronologyCampaign: Campaign = {
    version: 2,
    contentVersion: 1,
    start: { map: 'shadow-camp', x: 120, y: 312, actor: 'kiyan', facing: 'south', script: 'start' },
    quests: [
      {
        id: 'q-intro',
        title: 'q-intro',
        description: 'q-intro',
        guidance: { available: '', active: '' },
        progressText: '',
        completeText: '',
        goals: [],
        availableWhen: { type: 'always', value: true },
        completion: 'story',
      },
      {
        id: 'q-early',
        title: 'q-early',
        description: 'q-early',
        guidance: { available: '', active: '' },
        progressText: '',
        completeText: '',
        giver: 'darius',
        giverCharacterId: 'npc-1',
        delivery: 'darius',
        deliveryCharacterId: 'npc-2',
        goals: [],
        availableWhen: { type: 'quest', quest: 'q-intro', status: 'completed' },
        completion: 'story',
      },
      {
        id: 'q-later',
        title: 'q-later',
        description: 'q-later',
        guidance: { available: '', active: '' },
        progressText: '',
        completeText: '',
        goals: [],
        availableWhen: { type: 'quest', quest: 'q-early', status: 'completed' },
        completion: 'story',
      },
    ],
    questGroups: [{ id: 'g', title: 'g', kind: 'main', questIds: ['q-intro', 'q-early', 'q-later'] }],
    placements: [
      {
        id: 'quest-npc-located-npc-2',
        map: 'shadow-camp',
        actor: 'darius',
        characterId: 'npc-2',
        x: 120,
        y: 312,
        condition: { type: 'flag', flag: 'quest-npc-located-npc-2', value: true },
      },
    ],
    scripts: {
      start: { entry: 'done', nodes: [{ id: 'done', presentation: [], commands: [], exit: { type: 'end' } }] },
      's-intro': {
        entry: 'n',
        nodes: [
          {
            id: 'n',
            presentation: [],
            commands: [
              { type: 'quest', command: { type: 'accept', quest: 'q-intro' } },
              { type: 'quest', command: { type: 'script-complete', quest: 'q-intro' } },
              { type: 'world', command: { kind: 'actor-visibility', map: 'shadow-camp', actor: 'darius', characterId: 'npc-1', visible: false } },
            ],
            exit: { type: 'end' },
          },
        ],
      },
      's-early-accept': {
        entry: 'n',
        nodes: [{ id: 'n', presentation: [], commands: [{ type: 'quest', command: { type: 'accept', quest: 'q-early' } }], exit: { type: 'end' } }],
      },
      's-future-reveal': {
        entry: 'n',
        nodes: [
          {
            id: 'n',
            presentation: [],
            commands: [
              { type: 'world', command: { kind: 'actor-visibility', map: 'shadow-camp', actor: 'darius', characterId: 'npc-1', visible: true } },
              { type: 'flag', flag: 'quest-npc-located-npc-2', value: true },
            ],
            exit: { type: 'end' },
          },
        ],
      },
    },
    events: [
      { id: 'ev-intro', source: 'event', script: 's-intro', condition: { type: 'always', value: true } },
      { id: 'ev-early-accept', source: 'event', script: 's-early-accept', condition: { type: 'quest', quest: 'q-intro', status: 'completed' } },
      { id: 'ev-future-reveal', source: 'event', script: 's-future-reveal', condition: { type: 'quest', quest: 'q-later', status: 'active' } },
    ],
  };

  const history = questJumpHistory(chronologyCampaign, 'q-early', 'available');
  const reRevealed = history.world.some(
    cmd => cmd.type === 'world' && cmd.command.kind === 'actor-visibility' && cmd.command.characterId === 'npc-1' && cmd.command.visible,
  );
  const futurePlaced = history.world.some(
    cmd => (cmd.type === 'flag' && cmd.flag === 'quest-npc-located-npc-2') ||
      (cmd.type === 'world' && cmd.command.kind === 'flag' && cmd.command.id === 'quest-npc-located-npc-2'),
  );
  assert.equal(reRevealed, false, '更晚章节的显形事件不应提前投影到早期任务');
  assert.equal(futurePlaced, false, '更晚章节的登记摆放标志不应提前投影到早期任务');
});

test('无独立接取事件的任务也受先后护栏约束，且精确区分 characterId、all/false 摆放、净路障显隐、敌怪清除、两跳自环与世界标志', () => {
  // 1. 正式战役两跳自环任务（quest-402 / quest-407 / quest-428 / quest-445）在 available 模式下不再自我完成
  for (const qid of ['quest-402', 'quest-407', 'quest-428', 'quest-445']) {
    const h = questJumpHistory(campaign, qid, 'available');
    assert.equal(h.completedQuests.has(qid), false, `${qid} 在 available 模式下不应被两跳环路提前完成`);
    assert.notEqual(h.progress.get(qid), 'completed', `${qid} 在 available 模式下进度不应为 completed`);
  }

  // 2. 构造最小合成战役，集中覆盖：
  //    - 无接取事件的发布人任务拦截未来章节事件（targetAcceptIndex < 0）
  //    - Step 1 无 characterId 隐身不被带 characterId 的显形误匹配并继续匹配正确命令
  //    - Step 2 解包 all 内的正向 flag 摆放，同时绝不把 value:false 的摆放标志反手设真
  //    - Step 3 路障先隐藏后重新显形时按净状态不再投影旧隐藏命令
  //    - Step 4 enemy-location 后续被 location:null 清除时不再复活
  //    - quest-jump.ts 提取 world/flag 到 conditionPatch.flags 避免被覆写回 false
  const synthetic: Campaign = {
    version: 2,
    contentVersion: 1,
    start: { map: 'map-a', x: 64, y: 64, actor: 'kiyan', facing: 'south', script: 'start' },
    quests: [
      {
        id: 'q-pre',
        title: 'q-pre',
        description: 'q-pre',
        guidance: { available: '', active: '' },
        progressText: '',
        completeText: '',
        goals: [],
        availableWhen: { type: 'always', value: true },
        completion: 'story',
      },
      {
        id: 'q-target',
        title: 'q-target',
        description: 'q-target',
        guidance: { available: '', active: '' },
        progressText: '',
        completeText: '',
        giver: 'guard',
        delivery: 'ally',
        deliveryCharacterId: 'npc-ally',
        goals: [{ id: 'g1', kind: 'talk', target: 'scout', characterId: 'npc-scout', quantity: 1 }],
        places: { active: { type: 'fixed', map: 'map-a', x: 64, y: 64, source: 'test' } },
        availableWhen: { type: 'quest', quest: 'q-pre', status: 'completed' },
        completion: 'all',
      },
      {
        id: 'q-future',
        title: 'q-future',
        description: 'q-future',
        guidance: { available: '', active: '' },
        progressText: '',
        completeText: '',
        goals: [],
        availableWhen: { type: 'quest', quest: 'q-target', status: 'completed' },
        completion: 'story',
      },
    ],
    questGroups: [{ id: 'g', title: 'g', kind: 'main', questIds: ['q-pre', 'q-target', 'q-future'] }],
    placements: [
      {
        id: 'p-ally',
        map: 'map-a',
        actor: 'ally',
        characterId: 'npc-ally',
        x: 96,
        y: 96,
        condition: { type: 'all', conditions: [{ type: 'flag', flag: 'flag-ally-placed', value: true }] },
      },
      {
        id: 'p-scout-neg',
        map: 'map-a',
        actor: 'scout',
        characterId: 'npc-scout',
        x: 112,
        y: 96,
        condition: { type: 'flag', flag: 'flag-scout-gone', value: false },
      },
    ],
    scripts: {
      start: { entry: 'n', nodes: [{ id: 'n', presentation: [], commands: [], exit: { type: 'end' } }] },
      's-pre': {
        entry: 'n',
        nodes: [{
          id: 'n',
          presentation: [],
          commands: [
            { type: 'quest', command: { type: 'accept', quest: 'q-pre' } },
            { type: 'quest', command: { type: 'script-complete', quest: 'q-pre' } },
            { type: 'world', command: { kind: 'actor-visibility', map: 'map-a', actor: 'guard', visible: false } },
            { type: 'world', command: { kind: 'flag', id: 'world-flag-kept', value: true } },
          ],
          exit: { type: 'end' },
        }],
      },
      's-wrong-char-reveal': {
        entry: 'n',
        nodes: [{
          id: 'n',
          presentation: [],
          commands: [
            { type: 'world', command: { kind: 'actor-visibility', map: 'map-a', actor: 'guard', characterId: 'npc-other', visible: true } },
          ],
          exit: { type: 'end' },
        }],
      },
      's-right-reveal-and-place': {
        entry: 'n',
        nodes: [{
          id: 'n',
          presentation: [],
          commands: [
            { type: 'world', command: { kind: 'actor-visibility', map: 'map-a', actor: 'guard', visible: true } },
            { type: 'world', command: { kind: 'flag', id: 'flag-ally-placed', value: true } },
            { type: 'world', command: { kind: 'place', mapFromStage: true, entity: { id: 'p-ally', map: 'placeholder', actor: 'ally', characterId: 'npc-ally', x: 96, y: 96 } } },
            { type: 'world', command: { kind: 'enemy-location', enemyId: 'enemy-boss', location: { map: 'map-a', x: 80, y: 80 } } },
          ],
          exit: { type: 'end' },
        }],
      },
      's-clear-enemy': {
        entry: 'n',
        nodes: [{
          id: 'n',
          presentation: [],
          commands: [
            { type: 'world', command: { kind: 'enemy-location', enemyId: 'enemy-boss', location: null } },
          ],
          exit: { type: 'end' },
        }],
      },
      's-future-noise': {
        entry: 'n',
        nodes: [{
          id: 'n',
          presentation: [],
          commands: [
            { type: 'flag', flag: 'flag-scout-gone', value: true },
          ],
          exit: { type: 'end' },
        }],
      },
    },
    events: [
      { id: 'ev-pre', source: 'event', map: 'map-a', script: 's-pre', condition: { type: 'always', value: true } },
      { id: 'ev-wrong-reveal', source: 'event', map: 'map-a', script: 's-wrong-char-reveal', condition: { type: 'quest', quest: 'q-pre', status: 'completed' } },
      { id: 'ev-right-reveal', source: 'event', map: 'map-a', script: 's-right-reveal-and-place', condition: { type: 'quest', quest: 'q-pre', status: 'completed' } },
      { id: 'ev-clear-enemy', source: 'event', map: 'map-a', script: 's-clear-enemy', condition: { type: 'quest', quest: 'q-pre', status: 'completed' } },
      { id: 'ev-future-noise', source: 'event', map: 'map-a', script: 's-future-noise', condition: { type: 'quest', quest: 'q-future', status: 'active' } },
    ],
  };

  const session = newStorySession(
    synthetic,
    headlessContent.world.actors['kiyan'],
    headlessContent.storyClasses.classes[0],
    headlessContent.items,
    headlessContent.stats,
    headlessContent.battle,
    headlessContent.companions,
  );
  const plan = planQuestStart(synthetic, session, 'q-target', 'available');
  applyQuestStartPlan(session, plan);

  // Step 1: 跳过带 characterId='npc-other' 的伪匹配，找到真正无 characterId 的 guard 显形命令
  assert.equal(session.storyWorld.actorVisible('map-a', 'guard'), true, '无编号隐藏角色应精确匹配无编号显形命令');
  // Step 2: 解包 all 内的 flag-ally-placed 且 mapFromStage 正确解析为 map-a；绝不把 flag-scout-gone(value:false) 设成 true
  assert.equal(session.storyWorld.hasFlag('flag-ally-placed'), true, 'all 包装内的正向摆放标志应投影生效');
  assert.equal(session.storyWorld.entity('p-ally')?.map, 'map-a', 'mapFromStage 的 place 命令应解析为事件地图');
  assert.equal(session.storyWorld.hasFlag('flag-scout-gone'), false, 'value:false 的摆放标志与未来章节事件不得反手设真');
  // Step 4: 被后续 location:null 清除的 enemy-boss 不得复活
  assert.equal(session.storyWorld.enemySpawns('map-a').some(s => s.enemyId === 'enemy-boss'), false, '后续已清除的敌怪不得复活');
  // quest-jump.ts: world/flag 命令应同步进 conditionPatch.flags 并保留在会话中
  assert.equal(plan.conditionPatch.flags.some(f => f.flag === 'world-flag-kept' && f.value), true);
  assert.equal(session.storyWorld.hasFlag('world-flag-kept'), true);

  // 3. Step 3 净显隐状态：路障先隐藏后被更晚合法事件重新显形时，不再投影陈旧的隐藏命令
  const netObstacleCampaign: Campaign = {
    version: 2,
    contentVersion: 1,
    start: { map: 'map-a', x: 64, y: 64, actor: 'kiyan', facing: 'south', script: 'start' },
    quests: [
      {
        id: 'q-reg',
        title: 'q-reg',
        description: 'q-reg',
        guidance: { available: '', active: '' },
        progressText: '',
        completeText: '',
        goals: [],
        availableWhen: { type: 'always', value: true },
        completion: 'story',
      },
    ],
    questGroups: [{ id: 'g', title: 'g', kind: 'main', questIds: ['q-reg'] }],
    placements: [],
    scripts: {
      start: { entry: 'n', nodes: [{ id: 'n', presentation: [], commands: [], exit: { type: 'end' } }] },
      's-hide-door': {
        entry: 'n',
        nodes: [{ id: 'n', presentation: [], commands: [{ type: 'world', command: { kind: 'actor-visibility', map: 'map-a', actor: 'steel-door-1', visible: false } }], exit: { type: 'end' } }],
      },
      's-reshow-door': {
        entry: 'n',
        nodes: [{ id: 'n', presentation: [], commands: [{ type: 'world', command: { kind: 'actor-visibility', map: 'map-a', actor: 'steel-door-1', visible: true } }], exit: { type: 'end' } }],
      },
      's-reg-accept': {
        entry: 'n',
        nodes: [{ id: 'n', presentation: [], commands: [{ type: 'quest', command: { type: 'accept', quest: 'q-reg' } }], exit: { type: 'end' } }],
      },
    },
    events: [
      { id: 'ev-1-hide', source: 'event', map: 'map-a', script: 's-hide-door', condition: { type: 'always', value: true } },
      { id: 'ev-2-reshow', source: 'event', map: 'map-a', script: 's-reshow-door', condition: { type: 'always', value: true } },
      { id: 'ev-3-reg', source: 'region', map: 'map-a', region: { x: 0, y: 0, width: 32, height: 32 }, script: 's-reg-accept', condition: { type: 'always', value: true } },
    ],
  };
  const netHistory = questJumpHistory(netObstacleCampaign, 'q-reg', 'available');
  const staleHidden = netHistory.world.some(
    cmd => cmd.type === 'world' && cmd.command.kind === 'actor-visibility' && cmd.command.actor === 'steel-door-1' && !cmd.command.visible,
  );
  assert.equal(staleHidden, false, '路障被后续合法事件重新显形后，不应再投影更早的隐藏命令');
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

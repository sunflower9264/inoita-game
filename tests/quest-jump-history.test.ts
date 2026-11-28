import assert from 'node:assert/strict';
import test from 'node:test';
import { headlessContent, playthrough } from './helpers/story-playthrough.ts';
import { applyQuestStartPlan, planQuestStart } from '../src/debug/quest-jump.ts';
import { questJumpHistory } from '../src/debug/quest-jump-history.ts';
import { newStorySession } from '../src/domain/story-class.ts';
import { WorldEnemyRoster } from '../src/domain/world-enemies.ts';
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

test('调试跳转第 6 步按逻辑时序补齐开场、主线复用图切档与终局刷怪开关，支持往返跳转且无空图混刷', () => {
  const rosterEnemiesOn = (session: ReturnType<typeof playthrough>['session'], mapId: string): string[] => {
    const map = headlessContent.maps.get(mapId)!;
    const roster = new WorldEnemyRoster(session, map, []);
    const fromSpawns = [...new Set(roster.spawns.map(s => s.enemyId))].sort();
    const fromPlaced = [...new Set(roster.enemies.map(e => e.enemyId))].sort();
    assert.deepEqual(fromPlaced, fromSpawns, `${mapId} 实际生成敌人集合应与投影名单一致`);
    return fromPlaced;
  };

  const h = playthrough();
  try {
    const jumpAndCheck = (questId: string, mode: 'available' | 'active' | 'ready', mapId: string, expected: string[]) => {
      const plan = planQuestStart(campaign, h.session, questId, mode);
      applyQuestStartPlan(h.session, plan);
      assert.deepEqual(rosterEnemiesOn(h.session, mapId), expected, `${questId}(${mode}) @ ${mapId}`);
      return plan;
    };

    // 第 1 章（含 available / active）：仅刷 3~6 级初期怪，且 knight-uniform 可接取时不提前关闭第 1 章路障
    const ch1Avail = jumpAndCheck('knight-uniform', 'available', 'shadow-training-dungeon-2-a6b8293b', [
      'enemy-knife-needled-mosquitoes-1', 'enemy-reagents-1',
    ]);
    assert.equal(ch1Avail.conditionPatch.completedEvents.includes('event-604'), true);
    assert.equal(h.session.status('quest-180'), 'active');
    jumpAndCheck('knight-uniform', 'active', 'shadow-training-dungeon-2-a6b8293b', [
      'enemy-knife-needled-mosquitoes-1', 'enemy-reagents-1',
    ]);

    // 第 3 章（主线回帝国、旗标发布人 quest-105 及支线 quest-169 / quest-222）：补齐 event-55 / event-156，仅刷 41~43 级中期怪且零空图
    jumpAndCheck('quest-99', 'active', 'shadow-training-dungeon1-5e8c19b4', ['enemy-bat-2', 'enemy-skeleton-2']);
    jumpAndCheck('quest-105', 'available', 'shadow-training-dungeon-2-a6b8293b', [
      'enemy-black-skeleton-1', 'enemy-boss-skeleton-1', 'enemy-dungeon-mimics-1',
    ]);
    assert.equal(h.session.status('quest-180'), 'completed', '第 3 章任务 quest-105 应已越过第 1 章路障');
    jumpAndCheck('quest-169', 'available', 'training-dungeon-one', ['enemy-forest-snake-2', 'enemy-slime-3']);
    jumpAndCheck('quest-222', 'available', 'training-dungeon-one', ['enemy-forest-snake-2', 'enemy-slime-3']);

    // 终局链：接取前保持中期怪；激活及后续环（available / active）仅刷 94~105 级终局怪，不混刷 3~6 级初期怪
    const endBefore = jumpAndCheck('quest-495', 'available', 'shadow-training-dungeon1-5e8c19b4', ['enemy-bat-2', 'enemy-skeleton-2']);
    assert.equal(endBefore.conditionPatch.completedEvents.includes('event-605'), false);
    jumpAndCheck('quest-495', 'active', 'shadow-training-dungeon1-5e8c19b4', [
      'enemy-evil-bat-1', 'enemy-remains-of-a-forgotten-soldier-1',
    ]);
    const end496 = jumpAndCheck('quest-496', 'available', 'shadow-training-dungeon1-5e8c19b4', [
      'enemy-evil-bat-1', 'enemy-remains-of-a-forgotten-soldier-1',
    ]);
    assert.equal(end496.conditionPatch.completedEvents.includes('event-604'), true);
    assert.equal(end496.conditionPatch.completedEvents.includes('event-605'), true);
    assert.deepEqual(rosterEnemiesOn(h.session, 'shadow-training-dungeon-2-a6b8293b'), [
      'enemy-evil-bat-1', 'enemy-remains-of-a-forgotten-soldier-1',
    ]);
    jumpAndCheck('quest-496', 'active', 'shadow-training-dungeon1-5e8c19b4', [
      'enemy-evil-bat-1', 'enemy-remains-of-a-forgotten-soldier-1',
    ]);
    jumpAndCheck('quest-491', 'available', 'training-dungeon-one', ['enemy-deadly-poisonous-viper-1', 'enemy-heavy-slime-1']);
    jumpAndCheck('quest-491', 'active', 'training-dungeon-one', ['enemy-deadly-poisonous-viper-1', 'enemy-heavy-slime-1']);

    // GM 往返跳转（终局 -> 第 1 章 -> 开场 -> 终局）：无跨跳转残留污染
    jumpAndCheck('knight-uniform', 'available', 'shadow-training-dungeon-2-a6b8293b', [
      'enemy-knife-needled-mosquitoes-1', 'enemy-reagents-1',
    ]);
    const opening = planQuestStart(campaign, h.session, 'quest-180', 'available');
    assert.equal(opening.conditionPatch.completedEvents.includes('event-0'), false);
    assert.equal(opening.conditionPatch.completedEvents.includes('event-604'), false);
    applyQuestStartPlan(h.session, opening);
    jumpAndCheck('quest-496', 'available', 'shadow-training-dungeon1-5e8c19b4', [
      'enemy-evil-bat-1', 'enemy-remains-of-a-forgotten-soldier-1',
    ]);
  } finally {
    h.director.dispose();
  }
});

test('调试跳转第 6a 步开场刷怪链遵守逻辑时序、全键覆写仍记完成、支持多跳且不吞混合命令', () => {
  const mkQuest = (id: string, extra: Partial<CampaignQuest> = {}): CampaignQuest => ({
    id, title: id, description: id, guidance: { available: id, active: id },
    progressText: id, completeText: id, goals: [], availableWhen: { type: 'always', value: true }, completion: 'story',
    ...extra,
  });
  const synthetic: Campaign = {
    version: 2, contentVersion: 1,
    start: { map: 'm1', x: 16, y: 16, actor: 'kiyan', facing: 'south', script: 's-start' },
    quests: [
      mkQuest('q-mid'),
      mkQuest('q-target', { availableWhen: { type: 'quest', quest: 'q-mid', status: 'completed' } }),
    ],
    questGroups: [{ id: 'g', title: 'g', kind: 'main', questIds: ['q-mid', 'q-target'] }],
    placements: [],
    scripts: {
      's-start': { entry: 'n', nodes: [{ id: 'n', presentation: [], commands: [], exit: { type: 'end' } }] },
      's-mid': {
        entry: 'n',
        nodes: [{
          id: 'n', presentation: [],
          commands: [
            { type: 'quest', command: { type: 'script-complete', quest: 'q-mid' } },
            { type: 'world', command: { kind: 'enemy-availability', map: 'm1', enemyId: 'e-shared', available: true } },
            { type: 'world', command: { kind: 'enemy-availability', map: 'm1', enemyId: 'e-hop2', available: true } },
          ],
          exit: { type: 'end' },
        }],
      },
      's-init-1': {
        entry: 'n',
        nodes: [{
          id: 'n', presentation: [],
          commands: [
            { type: 'world', command: { kind: 'enemy-availability', map: 'm1', enemyId: 'e-shared', available: false } },
            { type: 'world', command: { kind: 'enemy-availability', map: 'm1', enemyId: 'e-only-init', available: false } },
          ],
          exit: { type: 'end' },
        }],
      },
      's-init-2': {
        entry: 'n',
        nodes: [{
          id: 'n', presentation: [],
          commands: [
            { type: 'world', command: { kind: 'enemy-availability', map: 'm1', enemyId: 'e-hop2', available: false } },
          ],
          exit: { type: 'end' },
        }],
      },
      's-mixed': {
        entry: 'n',
        nodes: [{
          id: 'n', presentation: [],
          commands: [
            { type: 'flag', flag: 'must-not-drop' },
            { type: 'world', command: { kind: 'enemy-availability', map: 'm1', enemyId: 'e-mixed', available: false } },
          ],
          exit: { type: 'end' },
        }],
      },
    },
    events: [
      { id: 'ev-start', source: 'start', script: 's-start', condition: { type: 'always', value: true } },
      // 故意把 mid 排在 init-1/init-2 之前（数组下标更小），验证第 6a 步按开场逻辑时序（0）比较，不倒挂覆写 mid
      { id: 'ev-mid', source: 'event', script: 's-mid', condition: { type: 'event', event: 'ev-start', status: 'completed' } },
      { id: 'ev-init-1', source: 'event', script: 's-init-1', condition: { type: 'event', event: 'ev-start', status: 'completed' } },
      { id: 'ev-init-2', source: 'event', script: 's-init-2', condition: { type: 'event', event: 'ev-init-1', status: 'completed' } },
      { id: 'ev-mixed', source: 'event', script: 's-mixed', condition: { type: 'event', event: 'ev-start', status: 'completed' } },
    ],
  };

  const history = questJumpHistory(synthetic, 'q-target', 'available');
  const avail = new Map<string, boolean>();
  for (const cmd of history.world) {
    if (cmd.type === 'world' && cmd.command.kind === 'enemy-availability') avail.set(cmd.command.enemyId, cmd.command.available);
  }
  assert.equal(avail.get('e-shared'), true, '排在数组末尾的开场初始化事件不能倒挂覆写后续中段开启状态');
  assert.equal(avail.get('e-only-init'), false, '未被后续覆盖的开场初始化开关正常写入');
  assert.equal(avail.get('e-hop2'), true, '多跳开场链同样不能覆写后续中段开启状态');
  assert.equal(history.completedEvents.has('ev-init-1'), true);
  assert.equal(history.completedEvents.has('ev-init-2'), true, '多跳开场链即使全部键被更晚事件覆盖，也应标记为已完成防止二次误触发');
  assert.equal(history.completedEvents.has('ev-mixed'), false, '含非 enemy-availability 混合命令的事件不被 6a 静默吞掉 flag 并标为已完成');
});

test('记忆层分翼跳转不把当层通关结算拉进前置历史，跨层后继无环重放并按原版重置翼标志任务', () => {
  const layers = [
    {
      clearEvent: 'event-452',
      wings: ['quest-372', 'quest-375', 'quest-378'],
      flags: ['quest-399', 'quest-400', 'quest-401'],
    },
    {
      clearEvent: 'event-468',
      wings: ['quest-390', 'quest-393', 'quest-396'],
      flags: ['quest-404', 'quest-405', 'quest-406'],
    },
    {
      clearEvent: 'event-493',
      wings: ['quest-416', 'quest-419', 'quest-422'],
      flags: ['quest-425', 'quest-426', 'quest-427'],
    },
    {
      clearEvent: 'event-512',
      wings: ['quest-433', 'quest-436', 'quest-439'],
      flags: ['quest-442', 'quest-443', 'quest-444'],
    },
  ] as const;

  for (const layer of layers) {
    for (const wingId of layer.wings) {
      for (const mode of ['available', 'active', 'ready'] as const) {
        const history = questJumpHistory(campaign, wingId, mode);
        assert.deepEqual(history.warnings, [], `${wingId} (${mode}) 不应出现历史依赖环或冲突警告`);
        assert.equal(
          history.completedEvents.has(layer.clearEvent),
          false,
          `${wingId} (${mode}) 不应将直接完成自身的通关事件 ${layer.clearEvent} 提前拉进历史`,
        );
        for (const flagId of layer.flags) {
          assert.notEqual(
            history.progress.get(flagId),
            'completed',
            `${wingId} (${mode}) 跳转现场不应遗留已完成的分翼标志任务 ${flagId}`,
          );
        }
      }
    }
  }

  // 跳到记忆 1 层哥布林翼 quest-378（ready）时不拉入 event-452/event-453，艾丽尼娅在场且不被 event-453 抢占
  const h = playthrough();
  try {
    const plan378 = planQuestStart(campaign, h.session, 'quest-378', 'ready');
    assert.equal(plan378.conditionPatch.completedEvents.includes('event-453'), false);
    assert.equal(plan378.conditionPatch.completedEvents.includes('event-452'), false);
    applyQuestStartPlan(h.session, plan378);
    const layer1Map = 'kiyan-s-memory-layer-1-631d46d8';
    const elenia = h.session.storyWorld
      .projectEntities(layer1Map, headlessContent.maps.get(layer1Map)?.entities ?? [], campaign.placements)
      .find(entity => entity.characterId === 'npc-598');
    assert.ok(elenia, '记忆 1 层艾丽尼娅在场');
    assert.notEqual(
      h.session.nearEvent(elenia, layer1Map)?.id,
      'event-453',
      'quest-399 未完成时，艾丽尼娅不应抢先触发灵界翼交付事件 event-453',
    );
  } finally {
    h.director.dispose();
  }

  // 第 2 层前置任务（如 quest-408）合法包含第 1 层通关 event-452：choice-17 优先采用非重复入口 event-560 而非重复交付 event-453，
  // 且无环重放并在 event-452 中把 quest-399..401 重置回 active（与 QuestBook 一致）
  const layer2 = questJumpHistory(campaign, 'quest-408', 'available');
  assert.deepEqual(layer2.warnings, []);
  assert.equal(layer2.completedEvents.has('event-560'), true);
  assert.equal(layer2.completedEvents.has('event-453'), false);
  assert.equal(layer2.completedEvents.has('event-452'), true);
  for (const flagId of ['quest-399', 'quest-400', 'quest-401']) {
    assert.equal(layer2.progress.get(flagId), 'active', `event-452 重放后应把 ${flagId} 重置回 active`);
  }
});

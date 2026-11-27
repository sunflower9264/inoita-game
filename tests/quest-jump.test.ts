import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { headlessContent, playthrough } from './helpers/story-playthrough.ts';
import { applyQuestStartPlan, planQuestStart } from '../src/debug/quest-jump.ts';
import { questJumpHistory } from '../src/debug/quest-jump-history.ts';
import { parseCampaign } from '../src/application/content-validation.ts';
import { parseDrops } from '../src/domain/drops.ts';
import { prepareSceneVisit } from '../src/domain/scene-visit.ts';
import type { Session } from '../src/domain/session.ts';
import { parseSprings } from '../src/domain/springs.ts';
import { resolveStoryScene } from '../src/domain/story-scene.ts';
import type { StoryStage } from '../src/domain/story-performance.ts';

const contentJson = (name: string) =>
  JSON.parse(readFileSync(new URL(`../public/content/${name}.json`, import.meta.url), 'utf8'));
const testDrops = parseDrops(contentJson('drops'), headlessContent.items,
  headlessContent.battle.enemies.map(enemy => enemy.id));
const testSprings = parseSprings(contentJson('springs'));

test('跳到《无耻的强盗》时已经接取《追击圣女3》，向前跳则保留支线',()=>{
  const campaign=headlessContent.campaign;
  const before=questJumpHistory(campaign,'quest-195','available');
  assert.equal(before.progress.has('quest-225'),false);
  const sideQuest=questJumpHistory(campaign,'quest-225','available');
  assert.equal(sideQuest.progress.get('quest-195'),'active');
});

/** 用正式进图与舞台解析流程预演接取演出。 */
function resolveAcceptStage(session: Session, stage: StoryStage) {
  const map = headlessContent.maps.get(stage.map)!;
  const scene = prepareSceneVisit({
    session, campaign: headlessContent.campaign, world: headlessContent.world,
    battleCatalog: headlessContent.battle, drops: testDrops, springs: testSprings,
  }, map, {
    id: 'player', actor: headlessContent.campaign.start.actor,
    x: stage.x, y: stage.y, facing: 'south', visible: true,
  }, () => 0.5);
  return resolveStoryScene(stage, scene);
}

function acceptStages(script: string): StoryStage[] {
  return headlessContent.campaign.scripts[script].nodes
    .flatMap(node => node.presentation)
    .filter((action): action is StoryStage => action.type === 'stage');
}

test('quest-11 starts available from its script-only accept chain', () => {
  const h = playthrough();
  try {
    const campaign = h.session.campaign;
    const plan = planQuestStart(campaign, h.session, 'quest-11');
    assert.equal(plan.mode, 'available');
    assert.equal(plan.fallback, false);
    assert.equal(plan.accept?.script, 'next:quest-10:quest-11');
    assert.equal(plan.accept?.eventId, undefined);
    assert.equal(plan.acceptAlternatives[0]?.script, 'next:quest-10:quest-11');
    assert.ok(plan.changedQuests.some(change => change.id === 'quest-10' && change.to === 'completed'));
    assert.ok(plan.destination, '任务可接取地点存在');

    applyQuestStartPlan(h.session, plan);
    assert.equal(h.session.status('quest-10'), 'completed');
    assert.equal(h.session.status('quest-11'), 'available');
    assert.equal(h.session.questBook.runningQuestIds.includes('quest-11'), false);
  } finally {
    h.director.dispose();
  }
});

test('quest-262 uses event-283 and clears a previously completed accept event', () => {
  const h = playthrough();
  try {
    const campaign = h.session.campaign;
    const plan = planQuestStart(campaign, h.session, 'quest-262');
    assert.equal(plan.mode, 'available');
    assert.equal(plan.accept?.eventId, 'event-283');
    assert.ok(plan.conditionPatch.quests.some(entry => entry.id === 'quest-261' && entry.status === 'completed'));

    const runtime = structuredClone(h.session.runtimeState);
    runtime.completedEvents = [...runtime.completedEvents, 'event-283'];
    h.session.runtimeState = runtime;

    applyQuestStartPlan(h.session, plan);
    assert.equal(h.session.status('quest-262'), 'available');
    assert.equal(h.session.runtimeState.completedEvents.includes('event-283'), false);
  } finally {
    h.director.dispose();
  }
});

test('a quest without an accept script stays available at the giver', () => {
  const h = playthrough();
  try {
    const campaign = h.session.campaign;
    const plan = planQuestStart(campaign, h.session, 'quest-18');
    assert.equal(plan.mode, 'available');
    assert.equal(plan.fallback, false);
    assert.equal(plan.accept, undefined);
    assert.equal(plan.destination?.map, 'training-dungeon-one');
  } finally {
    h.director.dispose();
  }
});

test('an accept event choice condition is patched with the required choice', () => {
  const h = playthrough();
  try {
    const campaign = h.session.campaign;
    const plan = planQuestStart(campaign, h.session, 'quest-502');
    const choice = plan.conditionPatch.choices.find(entry => entry.choice === 'choice-36');
    assert.ok(choice, 'choice-36 条件应被补进计划');
    assert.equal(choice.value, 'option-0');
    applyQuestStartPlan(h.session, plan);
    assert.equal(h.session.storyWorld.choice('choice-36'), 'option-0');
  } finally {
    h.director.dispose();
  }
});

test('a ready prerequisite stays ready after the full refresh', () => {
  const h = playthrough();
  try {
    const campaign = h.session.campaign;
    const plan = planQuestStart(campaign, h.session, 'quest-275');
    assert.equal(plan.accept?.eventId, 'event-301');
    assert.equal(plan.conditionPatch.unsatisfied.length, 0);
    applyQuestStartPlan(h.session, plan);
    assert.equal(h.session.status('quest-274'), 'ready');
    const event = campaign.events.find(entry => entry.id === 'event-301')!;
    assert.equal(h.session.evaluateCondition(event.condition!), true);
  } finally {
    h.director.dispose();
  }
});

test('applying a plan keeps the running pool exactly in sync with active and ready quests', () => {
  const h = playthrough();
  try {
    const plan = planQuestStart(h.session.campaign, h.session, 'quest-11');
    applyQuestStartPlan(h.session, plan);
    const running = new Set(h.session.questBook.runningQuestIds);
    for (const [id, state] of h.session.quests) {
      const shouldRun = state.status === 'active' || state.status === 'ready';
      assert.equal(running.has(id), shouldRun, `${id} 的运行池状态`);
    }
    // 调试状态必须还能被正式的读档校验接受，不能造出一份只有调试层认的现场。
    const sandbox = h.session.createStorySandbox();
    sandbox.restoreState(h.session.captureState());
    assert.equal(sandbox.status('quest-11'), 'available');
  } finally {
    h.director.dispose();
  }
});

test('刺杀格里普顿伯爵 can resume at the real delivery NPC in 影营地', () => {
  const h = playthrough();
  try {
    const plan = planQuestStart(h.session.campaign, h.session, 'grafton-mission', 'ready');
    assert.equal(plan.mode, 'ready');
    assert.equal(plan.accept, undefined);
    assert.equal(plan.destination?.map, 'shadow-camp');
    h.director.holdTriggers();
    applyQuestStartPlan(h.session, plan);
    h.session.questBook.clearDebugOverrides();
    assert.equal(h.session.status('grafton-mission'), 'ready');
    assert.ok(h.session.storyWorld.hasFlag('quest-npc-located-npc-40'));
    assert.ok(h.session.runtimeState.completedEvents.includes('event-0'));
  } finally {
    h.director.dispose();
  }
});

test('jump progress comes from the rescue handoff even with the menu entries reversed', () => {
  const h = playthrough();
  try {
    const original = h.session.campaign;
    const campaign = { ...original, questGroups: original.questGroups.map(group =>
      ({ ...group, questIds: [...group.questIds].reverse() })) };
    const plan = planQuestStart(campaign, h.session, 'quest-39');
    assert.equal(plan.accept?.eventId, 'event-50');
    h.director.holdTriggers();
    applyQuestStartPlan(h.session, plan);
    assert.equal(h.session.status('quest-43'), 'active');
    assert.ok(!['active', 'ready', 'completed'].includes(h.session.status('quest-40')));
    assert.ok(h.session.runtimeState.completedEvents.includes('event-49'));
  } finally {
    h.director.dispose();
  }
});

test('the return to Lehman starts after the rescue with the switch open and the handoff pending', () => {
  const h = playthrough();
  try {
    const plan = planQuestStart(h.session.campaign, h.session, 'quest-40', 'ready');
    assert.equal(plan.accept, undefined);
    assert.deepEqual(plan.destination, { map: 'inside-arnen-castle02-9a1430d7', x: 568, y: 40, facing: 'south' });
    h.director.holdTriggers();
    applyQuestStartPlan(h.session, plan);
    h.session.questBook.clearDebugOverrides();
    assert.equal(h.session.status('quest-39'), 'completed');
    assert.equal(h.session.status('quest-40'), 'ready');
    assert.ok(h.session.storyWorld.hasFlag('quest-npc-located-npc-93'));
    assert.ok(!h.session.storyWorld.hasFlag('quest-npc-located-npc-121'));
    assert.ok(h.session.runtimeState.completedEvents.includes('event-52'));
    assert.ok(!h.session.runtimeState.completedEvents.includes('event-53'));
    const before = planQuestStart(h.session.campaign, h.session, 'quest-40', 'available');
    applyQuestStartPlan(h.session, before);
    assert.equal(h.session.status('quest-39'), 'ready');
    assert.ok(!h.session.storyWorld.hasFlag('quest-npc-located-npc-93'));
    assert.ok(!h.session.runtimeState.completedEvents.includes('event-52'));
  } finally {
    h.director.dispose();
  }
});

test('quest-275 grants handover items and lets the prerequisite finish', () => {
  const h = playthrough();
  try {
    const plan = planQuestStart(h.session.campaign, h.session, 'quest-275');
    assert.equal(plan.mode, 'available');
    h.director.holdTriggers();
    applyQuestStartPlan(h.session, plan);
    assert.ok(h.session.bag.count('powder') >= 10, '补足火药');
    assert.ok(h.session.bag.count('firecracker') >= 5, '补足爆竹');
    assert.equal(h.session.status('quest-274'), 'ready');

    h.session.applyStoryCommands([{
      type: 'quest',
      command: { type: 'script-complete', quest: 'quest-274', cycle: h.session.questBook.state('quest-274')?.cycle },
    }]);
    assert.equal(h.session.status('quest-274'), 'completed', '正式完成要盖过调试钉住的 ready');
    h.director.releaseTriggers();
  } finally {
    h.director.dispose();
  }
});

test('quest-10 replays the original world commands for its accept scene cast', () => {
  const h = playthrough();
  try {
    const campaign = h.session.campaign;
    const plan = planQuestStart(campaign, h.session, 'quest-10');
    assert.equal(plan.accept?.eventId, 'event-47');
    assert.equal(plan.destination?.map, 'training-dungeon-one');
    assert.ok(plan.worldCommands.some(command => command.type === 'world'
      && command.command.kind === 'place' && command.command.entity.id === 'quest-npc-located-npc-59'));
    assert.ok(plan.worldCommands.some(command => command.type === 'flag'
      && command.flag === 'quest-npc-located-npc-59' && command.value === true));
    assert.equal(plan.worldCommands.some(command => command.type === 'quest'), false,
      '世界状态只重放世界命令，不改任务状态');
    assert.equal(plan.warnings.some(warning => warning.includes('找不到对应的剧情命令')), false);

    h.director.holdTriggers();
    applyQuestStartPlan(h.session, plan);
    h.director.releaseTriggers();

    assert.equal(h.session.storyWorld.isPlaced('quest-npc-located-npc-59'), true);
    assert.equal(h.session.storyWorld.hasFlag('quest-npc-located-npc-59'), true);
    const placement = campaign.placements.find(entry => entry.id === 'quest-npc-located-npc-59')!;
    assert.equal(h.session.visible(placement), true);
  } finally {
    h.director.dispose();
  }
});

test('quest-10 accept scene shows Lehman with the real stage pipeline', () => {
  const h = playthrough();
  try {
    const plan = planQuestStart(h.session.campaign, h.session, 'quest-10');
    h.director.holdTriggers();
    applyQuestStartPlan(h.session, plan);
    h.director.releaseTriggers();

    const stage = acceptStages('event-47')[0]!;
    const resolved = resolveAcceptStage(h.session, stage);
    const lehman = resolved.scene.actors.find(actor => actor.worldEntityId === 'quest-npc-located-npc-59');
    assert.ok(lehman);
    assert.equal(lehman.visible, true);
    assert.deepEqual([lehman.x, lehman.y], [200, 408]);
    assert.equal(resolved.cast.find(member => member.id === 'story-lehman-90989efd')?.visible, true);
  } finally {
    h.director.dispose();
  }
});

test('quest-153 replay follows the accept stage map instead of the destination', () => {
  const h = playthrough();
  try {
    const campaign = h.session.campaign;
    const plan = planQuestStart(campaign, h.session, 'quest-153');
    assert.equal(plan.accept?.eventId, 'event-44');
    assert.equal(plan.destination?.map, 'kamuran-wilderness-d37060c8');
    assert.ok(plan.worldCommands.some(command => command.type === 'world'
      && command.command.kind === 'place' && command.command.entity.id === 'quest-npc-located-npc-246'));
    // npc-82 没有 worldEntityId，只能按舞台地图匹配；只补目的地会漏掉它。
    assert.ok(plan.worldCommands.some(command => command.type === 'world'
      && command.command.kind === 'place' && command.command.entity.id === 'quest-npc-located-npc-82'));

    h.director.holdTriggers();
    applyQuestStartPlan(h.session, plan);
    h.director.releaseTriggers();

    const stage = acceptStages('event-44').find(value =>
      value.cast.some(member => member.worldEntityId === 'quest-npc-located-npc-246'))!;
    assert.equal(stage.map, 'leap-gate-district-1da2f793');
    const resolved = resolveAcceptStage(h.session, stage);
    const lehman = resolved.scene.actors.find(actor => actor.worldEntityId === 'quest-npc-located-npc-246');
    assert.ok(lehman);
    assert.equal(lehman.visible, true);
  } finally {
    h.director.dispose();
  }
});

test('a world entity placed on another map is replayed before the accept scene', () => {
  const h = playthrough();
  try {
    const campaign = h.session.campaign;
    h.session.storyWorld.apply({ kind: 'place', entity: {
      id: 'quest-npc-located-npc-59', map: 'inside-arnen-castle01-8b6ce276',
      actor: 'story-lehman-90989efd', characterId: 'npc-59', x: 200, y: 376, visible: true } });
    h.session.applyStoryCommands([{ type: 'flag', flag: 'quest-npc-located-npc-59', value: true }]);

    const plan = planQuestStart(campaign, h.session, 'quest-10');
    assert.ok(plan.worldCommands.some(command => command.type === 'world'
      && command.command.kind === 'place' && command.command.entity.id === 'quest-npc-located-npc-59'
      && command.command.entity.map === 'training-dungeon-one'));

    h.director.holdTriggers();
    applyQuestStartPlan(h.session, plan);
    h.director.releaseTriggers();
    assert.equal(h.session.storyWorld.entity('quest-npc-located-npc-59')?.map, 'training-dungeon-one');
  } finally {
    h.director.dispose();
  }
});

test('a placement from a later story event is not replayed into an earlier jump', () => {
  const h = playthrough();
  try {
    const campaign = h.session.campaign;
    const plan = planQuestStart(campaign, h.session, 'quest-317');
    assert.ok(plan.worldCommands.some(command => command.type === 'world'
      && command.command.kind === 'place' && command.command.entity.id === 'quest-npc-located-npc-445'
      && command.command.entity.map === 'eternal-snowy-forest-3-d519c1d9'));
    assert.equal(plan.worldCommands.some(command => command.type === 'world'
      && command.command.kind === 'remove-character' && command.command.characterId === 'npc-492'), false,
      '不能重放目标之后事件的清场命令');

    h.director.holdTriggers();
    applyQuestStartPlan(h.session, plan);
    h.director.releaseTriggers();
    assert.equal(h.session.storyWorld.entity('quest-npc-located-npc-445')?.map,
      'eternal-snowy-forest-3-d519c1d9');
    assert.equal(h.session.storyWorld.actorVisible('eternal-snowy-valley-f39c6607', 'npc-492'), true);
  } finally {
    h.director.dispose();
  }
});

test('a quest-gated placement that should stay hidden does not warn about a missing source', () => {
  const h = playthrough();
  try {
    const campaign = h.session.campaign;
    h.session.applyStoryCommands([{ type: 'quest', command: { type: 'accept', quest: 'quest-334' } }]);
    assert.equal(h.session.status('quest-334'), 'ready');

    const plan = planQuestStart(campaign, h.session, 'quest-322');
    assert.equal(plan.worldCommands.some(command => command.type === 'world'
      && command.command.kind === 'place' && command.command.entity.id === 'quest-npc-npc-449'), false);
    assert.equal(plan.warnings.some(warning => warning.includes('quest-npc-npc-449')), false,
      '条件要求隐藏的 NPC 不该报缺来源');
  } finally {
    h.director.dispose();
  }
});

test('a current accept-event place does not override the quest start location', () => {
  const h = playthrough();
  try {
    // event-341/342 的 place 是 current（跟随前置任务完成位置），不能把跳转起点留在当前图。
    assert.deepEqual(planQuestStart(h.session.campaign, h.session, 'quest-307').destination,
      { map: 'hunter-s-house-41096fbb', x: 232, y: 152, facing: 'south' });
    assert.equal(planQuestStart(h.session.campaign, h.session, 'quest-306').destination?.map,
      'eternal-snowy-forest-2-b7e43e5f');
    assert.equal(planQuestStart(h.session.campaign, h.session, 'quest-317').destination?.map,
      'eternal-snowy-forest-3-d519c1d9');
  } finally {
    h.director.dispose();
  }
});

test('与莱曼对话 prepares the handoff also named only in the intake script', () => {
  const h = playthrough();
  try {
    const before = planQuestStart(h.session.campaign, h.session, 'quest-153');
    assert.ok(before.conditionPatch.quests.some(entry => entry.id === 'quest-389' && entry.status === 'active'));
    const after = planQuestStart(h.session.campaign, h.session, 'quest-153', 'ready');
    applyQuestStartPlan(h.session, after);
    assert.equal(h.session.status('quest-389'), 'completed');
    assert.equal(h.session.status('quest-153'), 'ready');
    assert.ok(h.session.runtimeState.completedEvents.includes('event-44'));
  } finally { h.director.dispose(); }
});

test('rewinding the knight pursuit reopens its recorded followups through successive handoffs', () => {
  const h = playthrough();
  try {
    h.director.holdTriggers();
    for (const quest of ['quest-146', 'quest-148', 'quest-149']) {
      h.session.applyStoryCommands([{ type: 'quest', command: { type: 'script-complete', quest } }]);
    }
    h.session.runtimeState = { ...h.session.runtimeState,
      completedEvents: ['event-19', 'event-178', 'event-179', 'event-180', 'event-181', 'event-182', 'event-183'],
      occurrenceSequences: [[JSON.stringify(['event-181', 'region']), 8]],
    };
    applyQuestStartPlan(h.session, planQuestStart(h.session.campaign, h.session, 'quest-146'));
    for (const id of ['event-178', 'event-179', 'event-180', 'event-181', 'event-182', 'event-183'])
      assert.ok(!h.session.runtimeState.completedEvents.includes(id), id);
    assert.equal(h.session.runtimeState.occurrenceSequences.length, 0);
    // 因果历史只保留到达目标所必需的事件；与目标无关的旧记录一并清掉。
    assert.ok(!h.session.runtimeState.completedEvents.includes('event-19'));
    assert.equal(h.session.status('quest-148'), 'available');
    assert.equal(h.session.status('quest-149'), 'available');
  } finally { h.director.dispose(); }
});

test('incompatible intake conditions are reported in the preview', () => {
  const h = playthrough();
  try {
    const campaign = h.session.campaign;
    const plan = planQuestStart({ ...campaign, quests: campaign.quests.map(quest => quest.id !== 'quest-262'
      ? quest : { ...quest, availableWhen: { type: 'quest', quest: 'quest-261', status: 'active' } }) }, h.session, 'quest-262');
    assert.ok(plan.conditionPatch.unsatisfied.length);
  } finally { h.director.dispose(); }
});

test('跳到影子沼泽的埋伏，前两次必经的兽人部落接取演出均已结束', () => {
  const h = playthrough();
  try {
    const plan = planQuestStart(h.session.campaign, h.session, 'quest-113');
    assert.equal(plan.accept?.eventId, 'event-93');
    applyQuestStartPlan(h.session, plan);
    assert.ok(h.session.runtimeState.completedEvents.includes('event-90'));
    assert.ok(h.session.runtimeState.completedEvents.includes('event-92'));
    assert.ok(!h.session.runtimeState.completedEvents.includes('event-93'));
    assert.equal(h.session.status('quest-111'), 'completed');
  } finally { h.director.dispose(); }
});

test('全部任务都有可用的跳转现场，颠倒任务目录得到同一份计划', () => {
  const h = playthrough();
  try {
    const campaign = h.session.campaign;
    const reversed = { ...campaign, questGroups: [...campaign.questGroups].reverse().map(group =>
      ({ ...group, questIds: [...group.questIds].reverse() })) };
    const menuIds = campaign.questGroups.flatMap(group => group.questIds);
    assert.equal(new Set(menuIds).size, 487);
    for (const id of menuIds) {
      const plan = planQuestStart(campaign, h.session, id);
      assert.ok(plan.destination && headlessContent.maps.has(plan.destination.map), id);
      assert.deepEqual(plan.conditionPatch.unsatisfied, [], id);
      assert.deepEqual(planQuestStart(reversed, h.session, id), plan, id);
    }
  } finally { h.director.dispose(); }
});


test('记忆分支按目标接取条件固定选择，不追溯与目标无关的旧任务', () => {
  const h = playthrough();
  try {
    const {session} = h;
    applyQuestStartPlan(session, planQuestStart(session.campaign, session, 'quest-416', 'active'));
    assert.equal(session.storyWorld.choice('choice-21'), 'option-0');
    assert.equal(session.status('quest-416'), 'active');
    assert.equal(session.status('quest-353'), 'available');
    assert.equal(session.questBook.completedCycles('quest-353'), 0);
    assert.equal(session.status('quest-499'), 'available');
  } finally { h.director.dispose(); }
});

test('正式内容不再携带调试游玩顺序', () => {
  const raw = contentJson('campaign') as Record<string, unknown>;
  assert.equal('storyProgression' in raw, false);
  assert.doesNotThrow(() => parseCampaign(raw));
});

test('潜入骨之兽人部落时恢复同行的沃尔达克和伪装，重复跳转沿用同一件面具', () => {
  const h = playthrough();
  try {
    const {session} = h, money = session.money, experience = session.hero!.captureState().experience;
    h.director.holdTriggers();
    const plan = planQuestStart(session.campaign, session, 'quest-120', 'active');
    applyQuestStartPlan(session, plan);
    const mask = session.bag.equipmentFor('player').head;
    assert.ok(session.party?.get('story-mercenary-olaf'));
    assert.equal(session.bag.equipmentItems().head, 'disguise-mask');
    applyQuestStartPlan(session, plan);
    assert.equal(session.bag.equipmentFor('player').head, mask);
    assert.equal(session.money, money);
    assert.equal(session.hero!.captureState().experience, experience);
    applyQuestStartPlan(session, planQuestStart(session.campaign, session, 'quest-35'));
    assert.equal(session.party?.get('story-mercenary-olaf'), undefined);
    assert.notEqual(session.bag.equipmentItems().head, 'disguise-mask');
  } finally { h.director.dispose(); }
});

test('跳转到《试验新型融合器》时同步隐藏同坐标的初级融合器旧实例，避免按交互键被旧任务抢占', () => {
  const h = playthrough();
  try {
    h.director.holdTriggers();
    const plan = planQuestStart(h.session.campaign, h.session, 'quest-356', 'available');
    applyQuestStartPlan(h.session, plan);
    assert.equal(h.session.storyWorld.isPlaced('quest-npc-located-npc-579'), true);
    assert.equal(
      h.session.storyWorld.actorVisible('shadow-hall', 'fusion-machine-3d13b5ee', 'npc-576'),
      false,
      '放置中级融合器 npc-579 的同时必须隐藏同点初级融合器 npc-576',
    );
    assert.equal(
      h.session.storyWorld.actorVisible('shadow-hall', 'fusion-machine-3d13b5ee', 'npc-579'),
      true,
    );
  } finally {
    h.director.dispose();
  }
});

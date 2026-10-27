import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { Campaign } from '../src/domain/campaign.ts';
import type { ItemCatalog } from '../src/domain/items.ts';
import type { BattleCatalog } from '../src/domain/battle.ts';
import type { CharacterStatsCatalog } from '../src/domain/character-stats.ts';
import type { CompanionCatalog } from '../src/domain/party.ts';
import type { StoryClassCatalog } from '../src/domain/story-class.ts';
import { newStorySession } from '../src/domain/story-class.ts';
import { StoryDirector, type StoryUI } from '../src/domain/story-director.ts';
import { createGmActions, type GmCombatPort } from '../src/debug/gm-actions.ts';
import { prepareTaskStart } from '../src/debug/story-jump.ts';
import { questJournal } from '../src/domain/quest-journal.ts';
import { organizedInventory } from '../src/domain/inventory.ts';

// 这个文件**故意不注册 phaser 替身**：`gm-actions.ts` 一旦引入 Phaser 或 UI 模块就会在这里炸，
// 而无浏览器那条 agent 通道靠的就是「不引入」。这条约束由本文件的 import 本身守着。
const read = <T>(file: string): T => JSON.parse(readFileSync(new URL(`../public/content/${file}.json`, import.meta.url), 'utf8')) as T;
const campaign = read<Campaign>('campaign'), world = read<{ actors: Record<string, never> }>('world');
// 调试目录是独立产物，GM 测试与运行时一样显式挂载。
campaign.debugStory = read<Campaign['debugStory']>('debug/start');
const classes = read<StoryClassCatalog>('story-classes'), items = read<ItemCatalog>('items');
const stats = read<CharacterStatsCatalog>('character-stats'), battle = read<BattleCatalog>('battle');
const companions = read<CompanionCatalog>('companions');
const ui: StoryUI = { async dialogue() {}, async choice(_prompt, options) { return options[0]; }, async questPopup() {}, closeDialogue() {}, skipDialogue() {}, toast() {} };
const presentation = { begin() {}, async execute() {}, async finish() {}, async release() {} };

function harness(rescue?: () => { ok: boolean; reason?: string; moved?: boolean; from?: unknown; to?: unknown }, combat?: GmCombatPort) {
  const session = newStorySession(campaign, (world.actors as never as Record<string, never>)[campaign.start.actor]!, classes.classes[0]!, items, stats, battle, companions);
  const director = new StoryDirector(campaign, session, ui, () => {}, presentation);
  const sent: unknown[] = [];
  const gm = createGmActions({ session, campaign, director, rescue, combat, status: () => ({ mode: 'game', ready: true }),
    report: async payload => { sent.push(payload); return true; } });
  return { session, director, gm, sent };
}

/** 招募并上阵一个佣兵；上阵位置在主角之后。 */
function recruit(session: ReturnType<typeof harness>['session'], className = 'warlock') {
  const item = `mercenary-emblem-${className}`;
  session.bag.add(item);
  const entry = session.bag.entries.find(value => value.item === item)!;
  const member = session.party!.recruit(entry.id, () => 0).member;
  session.party!.deployFirstAvailable(member.id);
  return member;
}

test('the digest describes real content and stays inside the report budget', async () => {
  const { gm, sent } = harness();
  const digest = gm.digest();
  assert.ok((digest.quests as { counts: Record<string, number> }).counts, '摘要要带任务状态分布');
  assert.equal((digest.player as { classId: string | null }).classId, classes.classes[0]!.id);
  assert.deepEqual(digest.runtime, { mode: 'game', ready: true });
  assert.ok(Array.isArray((digest.world as { flags: string[] }).flags));
  assert.ok((digest.story as { completedEvents: number }).completedEvents >= 0);

  assert.deepEqual(await gm.report(), { ok: true });
  const payload = sent[0] as { version: number; entries: { id: string; kind: string; time: string; digest: unknown }[] };
  assert.equal(payload.version, 1);
  assert.equal(payload.entries.length, 1);
  assert.equal(payload.entries[0]!.kind, 'gm-state');
  // 收集器单条上限 12000 字符，超了整份上报会被拒。
  assert.ok(JSON.stringify(payload.entries[0]).length < 12000, `上报条目过大：${JSON.stringify(payload.entries[0]).length}`);
});

test('a mark round-trips the session while later edits stay rolled back', () => {
  const { session, gm } = harness();
  const facts = (source: string) => session.captureState().factSequences.find(([id]) => id === source)?.[1] ?? 0;
  assert.equal(gm.mark('before').ok, true);
  session.recordQuestFact('defeat', 'enemy-wolf-1', 'combat');
  assert.equal(facts('combat'), 1);
  assert.equal(gm.recall('before').ok, true);
  assert.equal(facts('combat'), 0, '回到标记点后，之后记的事实应当一并回退');
  assert.deepEqual(gm.marks(), ['before']);
});

test('failures come back as reasons instead of throwing, and every call is logged', () => {
  const { gm } = harness();
  const missing = gm.recall('nope');
  assert.equal(missing.ok, false); assert.match(missing.reason ?? '', /nope/);
  assert.equal(gm.mark('').ok, false);
  const log = gm.actions();
  assert.deepEqual(log.map(entry => entry.call), ['recall', 'mark']);
  assert.deepEqual(log[0]!.args, ['nope']);
  assert.equal(log[0]!.ok, false); assert.ok(log[1]!.reason);
  assert.ok(log.every(entry => typeof entry.at === 'string'));
});

test('a report carries the action log so a bug report says what was just done', async () => {
  const { gm, sent } = harness();
  gm.mark('checkpoint');
  await gm.report();
  const entry = (sent[0] as { entries: { digest: { gm: { actions: { call: string }[] } } }[] }).entries[0]!;
  assert.deepEqual(entry.digest.gm.actions.map(action => action.call), ['mark', 'report']);
});

test('an unreachable report endpoint degrades to a reason', async () => {
  const session = newStorySession(campaign, (world.actors as never as Record<string, never>)[campaign.start.actor]!, classes.classes[0]!, items, stats, battle, companions);
  const gm = createGmActions({ session, campaign, report: async () => false });
  const result = await gm.report();
  assert.equal(result.ok, false); assert.match(result.reason ?? '', /上报端点不可用/);
});

test('rescue forwards to the scene action, keeps both positions and is logged', () => {
  let calls = 0;
  const { gm } = harness(() => { calls += 1; return { ok: true, moved: true, from: { x: 192, y: 320 }, to: { x: 192, y: 336 } }; });
  assert.deepEqual(gm.rescue(), { ok: true, moved: true, from: { x: 192, y: 320 }, to: { x: 192, y: 336 } });
  assert.equal(calls, 1);
  assert.deepEqual(gm.actions().map(entry => entry.call), ['rescue']);
  // 没有场景时退回原因，不抛错。
  assert.match(createGmActions({ session: harness().session, campaign }).rescue().reason ?? '', /不支持/);
});

test('characters lists the hero and deployed companions in party order', () => {
  const { session, gm } = harness();
  assert.deepEqual(gm.characters().map(character => character.id), ['player']);
  const hero = gm.characters()[0]!;
  assert.equal(hero.name, '主角');
  assert.equal(hero.level, session.hero!.player.level);
  assert.equal(hero.health, session.hero!.player.health);
  assert.equal(hero.maxHealth, session.hero!.player.maxHealth);
  assert.equal(hero.invincible, false);
  assert.equal(hero.noCooldown, false);

  const member = recruit(session);
  assert.deepEqual(gm.characters().map(character => character.id), session.party!.activeIds);
  const companion = gm.characters().find(character => character.id === member.id)!;
  assert.equal(companion.name, member.definition.name);
  assert.equal(companion.level, member.player.level);
});

test('levelUp raises exactly one level and stops at max without any downgrade path', () => {
  const { session, gm } = harness();
  const before = session.hero!.level;
  const first = gm.levelUp('player');
  assert.equal(first.ok, true);
  assert.equal(first.level, before + 1);
  assert.equal(session.hero!.level, before + 1);

  while (session.hero!.level < stats.maxLevel) assert.equal(gm.levelUp('player').ok, true);
  const capped = gm.levelUp('player');
  assert.equal(capped.ok, false);
  assert.match(capped.reason ?? '', /满级/);
  assert.equal(session.hero!.level, stats.maxLevel, '满级后不会降级');
  assert.equal(gm.levelUp('nope').ok, false);
});

test('levelUp refuses a fallen character so it cannot silently revive', () => {
  const { session, gm } = harness();
  session.hero!.setHealth(0);
  const level = session.hero!.level;
  const result = gm.levelUp('player');
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /倒下/);
  assert.equal(session.hero!.level, level);
});

test('restoreHealth and restoreMana fill the live maxima', () => {
  const { session, gm } = harness();
  session.hero!.setHealth(1); session.hero!.setMana(0);
  assert.equal(gm.restoreHealth('player').ok, true);
  assert.equal(session.hero!.player.health, session.hero!.player.maxHealth);
  assert.equal(gm.restoreMana('player').ok, true);
  assert.equal(session.hero!.player.mana, session.hero!.player.maxMana);
});

test('a fallen character is revived through the combat port', () => {
  const revived: string[] = [];
  const holder: { session?: ReturnType<typeof harness>['session'] } = {};
  const combat: GmCombatPort = {
    setInvincible: () => ({ ok: true }),
    isInvincible: () => false,
    revive: id => {
      const session = holder.session!;
      session.hero!.setHealth(session.hero!.player.maxHealth);
      session.hero!.setMana(session.hero!.player.maxMana);
      revived.push(id);
      return { ok: true };
    },
  };
  const fixture = harness(undefined, combat);
  holder.session = fixture.session;
  fixture.session.hero!.setHealth(0);
  assert.equal(fixture.gm.restoreHealth('player').ok, true);
  assert.deepEqual(revived, ['player']);
  assert.ok(fixture.session.hero!.player.health > 0);

  // 没有战斗端口时如实失败，不把角色留在半复活状态。
  const headless = harness();
  headless.session.hero!.setHealth(0);
  const failed = headless.gm.restoreHealth('player');
  assert.equal(failed.ok, false);
  assert.match(failed.reason ?? '', /无法完成复活/);
});

test('recoverParty heals living members and leaves fallen ones to the combat port', () => {
  const { session, gm } = harness();
  const member = recruit(session);
  session.hero!.setHealth(1); session.hero!.setMana(0);
  member.setHealth(0);
  const result = gm.recoverParty();
  assert.equal(result.ok, true);
  assert.match(result.reason ?? '', /1 名倒下角色未能复活/);
  assert.equal(session.hero!.player.health, session.hero!.player.maxHealth);
  assert.equal(session.hero!.player.mana, session.hero!.player.maxMana);
  assert.equal(member.player.health, 0, '没有战斗场景时不擅自复活');
});

test('items excludes pickup-only items, filters and reports owned counts', () => {
  const { session, gm } = harness();
  const all = gm.items();
  assert.ok(!all.some(entry => entry.id === 'mana-gem'));
  assert.ok(all.length > 1000);

  const equipment = gm.items('equipment');
  assert.ok(equipment.length > 0);
  assert.ok(equipment.every(entry => entry.category === 'equipment'));

  const potion = all.find(entry => entry.id === 'healing-potion-s')!;
  assert.equal(potion.owned, session.bag.count('healing-potion-s'));

  // 顺序与背包整理共用同一套规则。
  const expected = organizedInventory(new Map(all.map(entry => [entry.id, 1] as const)), items.items).map(([id]) => id);
  assert.deepEqual(all.map(entry => entry.id), expected);
});

test('giveItem adds the requested quantity and refuses excluded items and bad counts', () => {
  const { session, gm } = harness();
  const before = session.bag.count('healing-potion-s');
  const result = gm.giveItem('healing-potion-s', 3);
  assert.equal(result.ok, true);
  assert.equal(result.requested, 3);
  assert.equal(result.total, before + 3);
  assert.equal(session.bag.count('healing-potion-s'), before + 3);

  for (const item of ['mana-gem', 'nope']) {
    assert.equal(gm.giveItem(item, 1).ok, false, item);
  }
  for (const quantity of [0, -1, 1.5, 1000]) {
    assert.equal(gm.giveItem('healing-potion-s', quantity).ok, false, String(quantity));
  }
});

test('gainMoney accepts only positive safe integers', () => {
  const { session, gm } = harness();
  const before = session.money;
  const result = gm.gainMoney(12_345);
  assert.equal(result.ok, true);
  assert.equal(result.money, before + 12_345);
  assert.equal(session.money, before + 12_345);
  for (const amount of [0, -1, 1.5]) assert.equal(gm.gainMoney(amount).ok, false, String(amount));
});

test('setNoCooldown readies every skill without recording a deadline', () => {
  const { session, gm } = harness();
  const port = session.cooldowns.forActor('player');
  assert.equal(gm.setNoCooldown('player', true).ok, true);
  port.start('strike', 90);
  assert.equal(port.isReady('strike'), true);
  assert.deepEqual(port.snapshot(), {});
  assert.deepEqual(session.cooldowns.captureState().actors, [], '调试开关不写存档');

  assert.equal(gm.setNoCooldown('player', false).ok, true);
  port.start('strike', 90);
  assert.equal(port.isReady('strike'), false);
  assert.ok(port.snapshot()['strike']);
  assert.equal(gm.setNoCooldown('nope', true).ok, false);
});

test('setInvincible needs a combat port and shows on the character list', () => {
  const flags = new Set<string>();
  const { gm } = harness(undefined, {
    setInvincible: (id, enabled) => { if (enabled) flags.add(id); else flags.delete(id); return { ok: true }; },
    isInvincible: id => flags.has(id),
  });
  assert.equal(gm.setInvincible('player', true).ok, true);
  assert.equal(gm.characters()[0]!.invincible, true);
  assert.equal(gm.setInvincible('nope', true).ok, false);

  const headless = harness();
  const failed = headless.gm.setInvincible('player', true);
  assert.equal(failed.ok, false);
  assert.match(failed.reason ?? '', /战斗场景/);
});

test('task preview prepares the default start without changing the current session', async () => {
  const {gm,session}=harness();const baseline=session.captureState();
  const task=session.campaign.debugStory!.tasks.find(task=>task.phase==='available')!;
  const preview=await gm.previewStory({quest:task.quest});
  assert.equal(preview.ok,true,preview.reason);
  assert.equal(preview.preview?.quest,task.quest);
  // 现场表停在开幕演出之前：可接取任务预览出来仍是可接取。
  assert.equal(preview.preview?.phase,'available');
  assert.equal(preview.preview?.location.map,task.start!.world!.location.map);
  assert.equal(preview.preview?.location.x,task.start!.world!.location.x);
  assert.equal(preview.preview?.location.y,task.start!.world!.location.y);
  assert.deepEqual(session.captureState(),baseline);
  assert.deepEqual(gm.actions(),[]);
  const missing=await gm.previewStory({quest:'quest-without-debug-entry'});
  assert.equal(missing.ok,false);
  assert.match(missing.reason??'',/没有调试入口/);
  assert.deepEqual(session.captureState(),baseline);
});

const DEBUG_START_QUEST = 'grafton-mission';
const DEBUG_START_ITEM = 'healing-potion-s';
const DEBUG_START_SCRIPT = 'debug-start-play';

/**
 * 手写一份现场表：不依赖导出器，验证运行时「套表 + 焦点 + 直接开演」这条通路。
 * 目标任务在副本里标成隐藏，用来确认焦点覆盖隐藏规则。
 */
function startTableCampaign(): Campaign {
  const copy = structuredClone(campaign) as Campaign;
  const task = copy.debugStory!.tasks.find(value => value.quest === DEBUG_START_QUEST)!;
  copy.quests.find(quest => quest.id === DEBUG_START_QUEST)!.hidden = true;
  copy.scripts[DEBUG_START_SCRIPT] = { entry: 'open', nodes: [
    { id: 'open', presentation: [], commands: [{ type: 'flag', flag: 'debug-play-ran' }], exit: { type: 'end' } },
  ] } as unknown as Campaign['scripts'][string];
  task.start = {
    quests: [{ id: DEBUG_START_QUEST, status: 'active', goals: {} }],
    running: [DEBUG_START_QUEST],
    world: {
      location: { map: 'shadow-camp', x: 320, y: 320, facing: 'south' },
      flags: ['debug-start-flag'], choices: [['debug-start-choice', 'yes']],
      entities: [{ id: 'debug-start-npc', map: 'shadow-camp', actor: copy.start.actor, x: 320, y: 336, visible: true }],
      absentActors: [{ map: 'shadow-camp', actor: copy.start.actor }],
    },
    items: [{ item: DEBUG_START_ITEM, quantity: 2 }],
    itemReset: [DEBUG_START_ITEM],
    completedEvents: [{ id: copy.events[0]!.id }],
    occurrenceSequences: [['debug-start', 1]],
    factSequences: [['debug-start', 1]],
    requiresProfile: { items: [{ item: DEBUG_START_ITEM, quantity: 1 }] },
  };
  task.play = { script: DEBUG_START_SCRIPT, cut: 'before-opening' };
  task.sourceHash = 'debug-start-test';
  return copy;
}

test('a hand-written start table is applied verbatim and the opening play runs through the real director', async () => {
  const debugCampaign = startTableCampaign();
  const session = newStorySession(debugCampaign,
    (world.actors as never as Record<string, never>)[debugCampaign.start.actor]!, classes.classes[0]!, items, stats, battle, companions);
  session.bag.add(DEBUG_START_ITEM, 3); // requiresProfile：玩家先得真有这件物品
  const prepared = await prepareTaskStart(session, { quest: DEBUG_START_QUEST });

  assert.equal(prepared.debugFocusQuest, DEBUG_START_QUEST);
  assert.equal(prepared.trackedQuest, DEBUG_START_QUEST);
  assert.equal(prepared.questBook.quests.find(([id]) => id === DEBUG_START_QUEST)?.[1].status, 'active');
  assert.deepEqual(prepared.questBook.runningQuestIds, [DEBUG_START_QUEST]);
  assert.equal(prepared.storyWorld.location?.map, 'shadow-camp');
  assert.ok(prepared.storyWorld.flags.includes('debug-start-flag'));
  // 结构化的缺场登记展开成世界状态里的标记。
  assert.ok(prepared.storyWorld.flags.includes(JSON.stringify(['absent-actor', 'shadow-camp', debugCampaign.start.actor])));
  assert.equal(prepared.storyWorld.choices.find(([id]) => id === 'debug-start-choice')?.[1], 'yes');
  assert.ok(prepared.storyWorld.entities.some(entity => entity.id === 'debug-start-npc' && entity.map === 'shadow-camp'));
  assert.ok(prepared.runtime.completedEvents.includes(debugCampaign.events[0]!.id));
  assert.equal(prepared.runtime.completedEvents.filter(id => id === debugCampaign.events[0]!.id).length, 1,
    '现场表已声明开场事件时并集不能重复记账');
  assert.equal(prepared.factSequences.find(([id]) => id === 'debug-start')?.[1], 1);
  assert.deepEqual(prepared.enemies, []);

  session.restoreState(prepared);
  assert.equal(session.itemCount(DEBUG_START_ITEM), 2, 'itemReset 先清空，items 再给绝对值');
  // 隐藏任务的焦点覆盖：任务日志只显示这一条。
  const journal = questJournal(debugCampaign, session.quests, session.debugFocusQuest);
  assert.deepEqual(journal.flatMap(group => group.entries.map(entry => entry.quest.id)), [DEBUG_START_QUEST]);

  // 直接开演：走正式导演，演出里的命令真的落地。
  // 记录调用瞬间的 `busy`：`debugJump` 的锁必须先放开，否则演出里的选项会被挡住。
  const played: { script: string; busy: boolean }[] = [];
  const director = new StoryDirector(debugCampaign, session, ui, () => {}, presentation);
  const play = director.script.bind(director);
  director.script = async (name, node) => { played.push({ script: String(name), busy: director.busy }); await play(name, node); };
  const persistence: string[] = [];
  const gm = createGmActions({ session, campaign: debugCampaign, director, status: () => ({}),
    persistence: { suspend: () => persistence.push('suspend'), resume: () => persistence.push('resume') },
    report: async () => true });

  const result = await gm.jumpStory({ quest: DEBUG_START_QUEST });
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(played, [{ script: DEBUG_START_SCRIPT, busy: false }], '开幕演出在 debugJump 解锁后才调用');
  assert.equal(session.flags.has('debug-play-ran'), true, '开幕演出真的执行了');
  assert.equal(result.play?.script, DEBUG_START_SCRIPT);
  assert.equal(result.sourceHash, 'debug-start-test');
  assert.deepEqual(persistence, ['suspend']);
  assert.deepEqual(gm.storyDebug(), { focus: DEBUG_START_QUEST, autoSavePaused: true });

  const ended = gm.endStoryDebug();
  assert.equal(ended.ok, true);
  assert.deepEqual(persistence, ['suspend', 'resume']);
  assert.deepEqual(gm.storyDebug(), { focus: undefined, autoSavePaused: false });
  assert.equal(gm.endStoryDebug().ok, false, '没有调试现场时如实失败');
  director.dispose();
});

test('a jump that cannot reach the debug scene restores the session and resumes auto saving', async () => {
  const debugCampaign = startTableCampaign();
  const session = newStorySession(debugCampaign,
    (world.actors as never as Record<string, never>)[debugCampaign.start.actor]!, classes.classes[0]!, items, stats, battle, companions);
  session.bag.add(DEBUG_START_ITEM, 3);
  const baseline = session.captureState();
  const persistence: string[] = [];
  const director = new StoryDirector(debugCampaign, session, ui, () => {}, presentation);
  const gm = createGmActions({ session, campaign: debugCampaign, director, status: () => ({}),
    travel: async () => ({ ok: false, reason: '测试切图失败' }),
    persistence: { suspend: () => persistence.push('suspend'), resume: () => persistence.push('resume') },
    report: async () => true });
  const result = await gm.jumpStory({ quest: DEBUG_START_QUEST });
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /测试切图失败/);
  assert.deepEqual(session.captureState(), baseline, '切图失败要把会话退回原处');
  assert.deepEqual(persistence, ['suspend', 'resume']);
  assert.equal(gm.storyDebug().autoSavePaused, false);
  director.dispose();
});


test('completeCurrentQuest, setNoclip, and setDoubleSpeed operate correctly through GM', () => {
  const { session, gm, director } = harness(undefined, undefined);
  assert.equal(gm.isNoclip(), false);
  assert.equal(gm.setNoclip(true).ok, true);
  assert.equal(gm.isDoubleSpeed(), false);
  assert.equal(gm.setDoubleSpeed(true).ok, true);

  const firstQuest = session.campaign.quests[0];
  if (firstQuest) {
    session.questBook.commit(session.questBook.plan({ type: 'accept', quest: firstQuest.id, source: 'script' }));
    assert.equal(session.status(firstQuest.id), 'active');
    const res = gm.completeCurrentQuest(firstQuest.id);
    assert.equal(res.ok, true, res.reason);
    assert.equal(session.status(firstQuest.id), 'completed');
  }
  director.dispose();
});

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
import { organizedDebugInventory } from '../src/domain/inventory.ts';

// 这个文件**故意不注册 phaser 替身**：`gm-actions.ts` 一旦引入 Phaser 或 UI 模块就会在这里炸，
// 而无浏览器那条 agent 通道靠的就是「不引入」。这条约束由本文件的 import 本身守着。
const read = <T>(file: string): T => JSON.parse(readFileSync(new URL(`../public/content/${file}.json`, import.meta.url), 'utf8')) as T;
const campaign = read<Campaign>('campaign'), world = read<{ actors: Record<string, never> }>('world');
const classes = read<StoryClassCatalog>('story-classes'), items = read<ItemCatalog>('items');
const stats = read<CharacterStatsCatalog>('character-stats'), battle = read<BattleCatalog>('battle');
const companions = read<CompanionCatalog>('companions');
const ui: StoryUI = { async dialogue() {}, async choice(_prompt, options) { return options[0]; }, async questPopup() {}, closeDialogue() {}, skipDialogue() {} };
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

test('failures come back as reasons instead of throwing, and every call is logged', () => {
  const { gm } = harness();
  const missing = gm.levelUp('nope');
  assert.equal(missing.ok, false); assert.match(missing.reason ?? '', /nope/);
  assert.equal(gm.giveItem('', 1).ok, false);
  const log = gm.actions();
  assert.deepEqual(log.map(entry => entry.call), ['levelUp', 'giveItem']);
  assert.deepEqual(log[0]!.args, ['nope']);
  assert.equal(log[0]!.ok, false); assert.ok(log[1]!.reason);
  assert.ok(log.every(entry => typeof entry.at === 'string'));
});

test('a report carries the action log so a bug report says what was just done', async () => {
  const { gm, sent } = harness();
  gm.setNoclip(true);
  await gm.report();
  const entry = (sent[0] as { entries: { digest: { gm: { actions: { call: string }[] } } }[] }).entries[0]!;
  assert.deepEqual(entry.digest.gm.actions.map(action => action.call), ['setNoclip', 'report']);
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
  assert.equal(hero.infiniteMana, false);
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
    setInfiniteMana: () => ({ ok: true }),
    isInfiniteMana: () => false,
    setOneHitKill: () => ({ ok: true }),
    isOneHitKill: () => false,
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

test('maxSkills learns and maxes every class skill for the hero without spending points', () => {
  const { session, gm } = harness();
  const classSkills = battle.classes.find(value => value.id === session.hero!.classId)!.skills;
  const before = Object.fromEntries(classSkills.map(id => [id, session.skills.level(id)]));
  const points = session.skills.points();
  let notifications = 0;
  const unsubscribe = session.subscribe(() => { notifications += 1; });
  const result = gm.maxSkills('player');
  unsubscribe();
  assert.equal(result.ok, true);
  for (const id of classSkills) {
    assert.equal(session.skills.level(id), battle.skills[id]!.ranks.length, `${id} 达到最高等级`);
  }
  assert.equal(session.skills.points(), points, '不消耗技能点');
  assert.equal(notifications, 1, '执行后只发一次会话通知');
  assert.equal(result.learned! + result.maxed!,
    classSkills.filter(id => before[id]! < battle.skills[id]!.ranks.length).length, '变化数量与实际提升的技能一致');
  const again = gm.maxSkills('player');
  assert.deepEqual([again.ok, again.learned, again.maxed], [true, 0, 0], '再次执行没有变化');
});

test('maxSkills learns every companion class skill at its growth maximum without changing level', () => {
  const { session, gm } = harness();
  const member = recruit(session);
  const classSkills = battle.classes.find(value => value.id === member.classId)!.skills;
  const maximum = (id: string) => battle.skills[id]!.companion?.ranks.length ?? battle.skills[id]!.ranks.length;
  const before = member.skills.skillLevels();
  const level = member.level;
  let notifications = 0;
  const unsubscribe = session.subscribe(() => { notifications += 1; });
  const result = gm.maxSkills(member.id);
  unsubscribe();
  assert.equal(result.ok, true);
  const levels = member.skills.skillLevels();
  for (const id of classSkills) assert.equal(levels[id], maximum(id), `${id} 达到伙伴成长最高等级`);
  const unlockedByGeneratedCaps = classSkills.filter(id => !(id in member.skills.caps));
  assert.ok(unlockedByGeneratedCaps.length > 0, '佣兵招募时的自然技能表只开放部分职业技能');
  for (const id of unlockedByGeneratedCaps) assert.ok((levels[id] ?? 0) > 0, `${id} 未开放也要学会`);
  assert.equal(result.learned! + result.maxed!,
    classSkills.filter(id => (before[id] ?? 0) < maximum(id)).length, '变化数量与实际提升的技能一致');
  assert.equal(member.level, level, '不改变角色等级');
  assert.equal(notifications, 1, '执行后只发一次会话通知');
  const again = gm.maxSkills(member.id);
  assert.deepEqual([again.ok, again.learned, again.maxed], [true, 0, 0], '再次执行没有变化');
  assert.equal(gm.maxSkills('nope').ok, false);
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

test('items excludes pickup-only and story-locked equipment, filters and reports owned counts', () => {
  const { session, gm } = harness();
  const all = gm.items();
  assert.ok(!all.some(entry => entry.id === 'mana-gem'));
  assert.equal(all.length, Object.values(items.items).filter(item => !item.pickup && !item.equipment?.locked).length);
  assert.ok(items.storyEquipment?.length, '内容目录含剧情人物专属装备');
  for (const id of items.storyEquipment!) assert.ok(!all.some(entry => entry.id === id), `${id} 不显示在调试清单`);

  const equipment = gm.items('equipment');
  assert.ok(equipment.length > 0);
  assert.ok(equipment.every(entry => entry.category === 'equipment'));
  assert.ok(equipment.every(entry => !items.items[entry.id]!.equipment?.locked));
  const foreign = equipment.find(entry => !items.items[entry.id]!.equipment!.classes.includes(session.hero!.classId));
  assert.ok(foreign, '其他职业的可穿戴装备仍可见');
  assert.equal(gm.giveItem(foreign.id, 1).ok, true, '可穿戴装备仍可发放');

  const potion = all.find(entry => entry.id === 'healing-potion-s')!;
  assert.equal(potion.owned, session.bag.count('healing-potion-s'));

  // 装备按种类连续成组，同组内等级从低到高。
  const expected = organizedDebugInventory(new Map(all.map(entry => [entry.id, 1] as const)), items.items).map(([id]) => id);
  assert.deepEqual(all.map(entry => entry.id), expected);
  const kinds = equipment.map(entry => items.items[entry.id]!.kind);
  const seen = new Set<string>();
  for (let index = 0; index < kinds.length; index += 1) {
    const kind = kinds[index]!;
    if (index > 0 && kind !== kinds[index - 1]) {
      assert.ok(!seen.has(kind), `同类装备必须连续：${kind}`);
      seen.add(kinds[index - 1]!);
    }
  }
  for (let index = 1; index < equipment.length; index += 1) {
    const previous = equipment[index - 1]!, current = equipment[index]!;
    if (items.items[previous.id]!.kind === items.items[current.id]!.kind)
      assert.ok(previous.level <= current.level, `同类装备按等级升序：${previous.id} / ${current.id}`);
  }
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
  for(const item of items.storyEquipment!)assert.equal(gm.giveItem(item,1).ok,false,item);
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
    setInfiniteMana: () => ({ ok: true }),
    isInfiniteMana: () => false,
    setOneHitKill: () => ({ ok: true }),
    isOneHitKill: () => false,
  });
  assert.equal(gm.setInvincible('player', true).ok, true);
  assert.equal(gm.characters()[0]!.invincible, true);
  assert.equal(gm.characters()[0]!.infiniteMana, false);
  assert.equal(gm.setInvincible('nope', true).ok, false);

  const headless = harness();
  const failed = headless.gm.setInvincible('player', true);
  assert.equal(failed.ok, false);
  assert.match(failed.reason ?? '', /战斗场景/);
});

test('setInfiniteMana needs a combat port, stays independent from invincibility, and shows on the character list', () => {
  const flags = new Set<string>();
  const { gm } = harness(undefined, {
    setInvincible: () => ({ ok: true }),
    isInvincible: () => false,
    setInfiniteMana: (id, enabled) => { if (enabled) flags.add(id); else flags.delete(id); return { ok: true }; },
    isInfiniteMana: id => flags.has(id),
    setOneHitKill: () => ({ ok: true }),
    isOneHitKill: () => false,
  });
  assert.equal(gm.setInfiniteMana('player', true).ok, true);
  assert.equal(gm.characters()[0]!.infiniteMana, true);
  assert.equal(gm.characters()[0]!.invincible, false);
  assert.equal(gm.setInfiniteMana('player', false).ok, true);
  assert.equal(gm.characters()[0]!.infiniteMana, false);
  assert.equal(gm.setInfiniteMana('nope', true).ok, false);

  const headless = harness();
  const failed = headless.gm.setInfiniteMana('player', true);
  assert.equal(failed.ok, false);
  assert.match(failed.reason ?? '', /战斗场景/);
});

test('setOneHitKill needs a combat port and shows on the character list', () => {
  const flags = new Set<string>();
  const { gm } = harness(undefined, {
    setInvincible: () => ({ ok: true }),
    isInvincible: () => false,
    setInfiniteMana: () => ({ ok: true }),
    isInfiniteMana: () => false,
    setOneHitKill: (id, enabled) => { if (enabled) flags.add(id); else flags.delete(id); return { ok: true }; },
    isOneHitKill: id => flags.has(id),
  });
  assert.equal(gm.setOneHitKill('player', true).ok, true);
  assert.equal(gm.characters()[0]!.oneHitKill, true);
  assert.equal(gm.setOneHitKill('nope', true).ok, false);

  const headless = harness();
  const failed = headless.gm.setOneHitKill('player', true);
  assert.equal(failed.ok, false);
  assert.match(failed.reason ?? '', /战斗场景/);
});

test('setTenSkillPointsPerLevel grants 10 skill points per level for hero and manual mercenaries and survives save/restore', () => {
  const { session, gm } = harness();
  const member = recruit(session);
  assert.equal(gm.isTenSkillPointsPerLevel(), false);

  const heroPointsBefore = session.hero!.skillPoints;
  const mercPointsBefore = member.skills.points();
  assert.equal(gm.setTenSkillPointsPerLevel(true).ok, true);
  assert.equal(gm.isTenSkillPointsPerLevel(), true);

  // 单级升级：主角和手动佣兵均获得 10 个技能点。
  assert.equal(gm.levelUp('player').ok, true);
  assert.equal(session.hero!.skillPoints, heroPointsBefore + 10);
  assert.equal(gm.levelUp(member.id).ok, true);
  assert.equal(member.skills.points(), mercPointsBefore + 10);

  // 一次经验连升两级：获得 20 个技能点。
  const twoLevelsExp = (session.hero!.player.nextLevelExperience - session.hero!.player.experience)
    + (stats.experience[session.hero!.level] ?? 0);
  const gained = session.hero!.addExperience(twoLevelsExp);
  assert.equal(gained, 2);
  assert.equal(session.hero!.skillPoints, heroPointsBefore + 30);

  // 佣兵消耗多于默认每级 1 点的技能点后，关闭开关再存档与读档仍能通过校验。
  const learnable = Object.keys(member.skills.caps).find(id => !member.skills.learningProblem(id));
  assert.ok(learnable, '佣兵至少有一门可学技能');
  while (!member.skills.learningProblem(learnable!)) member.skills.learn(learnable!);

  assert.equal(gm.setTenSkillPointsPerLevel(false).ok, true);
  assert.equal(gm.isTenSkillPointsPerLevel(), false);
  const afterOffHero = session.hero!.skillPoints;
  const afterOffMerc = member.skills.points();
  assert.equal(gm.levelUp('player').ok, true);
  assert.equal(session.hero!.skillPoints, afterOffHero + stats.skillPointsPerLevel);
  assert.equal(gm.levelUp(member.id).ok, true);
  assert.equal(member.skills.points(), afterOffMerc + stats.skillPointsPerLevel);

  // 存档再恢复到新会话（默认不开启调试开关），校验通过且技能点保留。
  const saved = session.captureState();
  const restored = harness().session;
  restored.restoreState(saved);
  assert.equal(restored.hero!.skillPoints, session.hero!.skillPoints);
  assert.equal(restored.party!.get(member.id)!.skills.points(), member.skills.points());
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

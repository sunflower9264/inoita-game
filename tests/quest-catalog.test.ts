import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseCampaign } from '../src/application/content-validation.ts';
import type { Campaign } from '../src/domain/campaign.ts';
import type { QuestProgress } from '../src/domain/quest-book.ts';
import {
  buildQuestCatalog,
  projectQuestCatalog,
  type QuestCatalogGroup,
} from '../src/debug/quest-catalog.ts';

const campaign = parseCampaign(JSON.parse(readFileSync(
  new URL('../public/content/campaign.json', import.meta.url), 'utf8',
))) as Campaign;
const index = buildQuestCatalog(campaign);

function progress(
  status: QuestProgress['status'],
  goals: Record<string, number> = {},
  completedCycles = status === 'completed' ? 1 : 0,
): QuestProgress {
  return { status, goals, cycle: 0, completedCycles };
}

function shape(catalog: QuestCatalogGroup[]): [string, string[]][] {
  return catalog.map(group => [group.definition.id, group.entries.map(entry => entry.quest.id)]);
}

test('catalog contains all 230 groups and all 487 quests exactly once', () => {
  const catalog = projectQuestCatalog(index, new Map());
  assert.equal(catalog.length, campaign.questGroups.length);
  assert.equal(catalog.length, 230);

  const ids = catalog.flatMap(group => group.entries.map(entry => entry.quest.id));
  assert.equal(ids.length, 487);
  assert.equal(new Set(ids).size, 487);
  assert.deepEqual(new Set(ids), new Set(campaign.quests.map(quest => quest.id)));
  assert.deepEqual(
    new Set(catalog.map(group => group.definition.id)),
    new Set(campaign.questGroups.map(group => group.id)),
  );
});

test('catalog starts with the opening main group and orders groups by their first quest position', () => {
  const catalog = projectQuestCatalog(index, new Map());
  assert.equal(catalog[0].definition.id, 'native-group-2');
  assert.equal(catalog[0].definition.title, '刺杀格里普顿伯爵');
  assert.equal(catalog[0].kind, 'main');
  assert.deepEqual(catalog[0].entries.map(entry => entry.quest.id), ['grafton-mission']);

  const position = new Map(campaign.quests.map((quest, at) => [quest.id, at]));
  const firstPositions = catalog.map(group => position.get(group.definition.questIds[0])!);
  assert.deepEqual(firstPositions, [...firstPositions].sort((left, right) => left - right));
});

test('side groups stay interleaved at their story position instead of being appended', () => {
  const catalog = projectQuestCatalog(index, new Map());
  const at = (id: string): number => catalog.findIndex(group => group.definition.id === id);
  const side = at('native-group-12');
  const before = at('native-group-6');
  const after = at('native-group-14');

  assert.ok(before < side && side < after, `${before} < ${side} < ${after}`);
  assert.equal(catalog[before].kind, 'main');
  assert.equal(catalog[after].kind, 'main');
  assert.equal(catalog[side].definition.title, '坤特的狼狗');
  assert.equal(catalog[side].kind, 'side');
  assert.deepEqual(catalog[side].entries.map(entry => entry.quest.id), ['quest-18']);
  assert.ok(side < catalog.length - 1, '支线组不能全部排在目录末尾');
});

test('the rescue group follows story order and journal-hidden battle quests remain visible', () => {
  const catalog = projectQuestCatalog(index, new Map());

  const battle = catalog.find(group => group.definition.id === 'native-group-100');
  assert.ok(battle);
  assert.deepEqual(battle.entries.map(entry => entry.quest.id), ['quest-218']);
  assert.equal(battle.entries[0].hidden, true);
  assert.equal(battle.entries[0].internal, false);
  assert.equal(battle.summary.hidden, 1);
  assert.equal(battle.summary.journalVisible, 0);

  const rescue = catalog.find(group => group.definition.id === 'native-group-7');
  assert.ok(rescue);
  assert.deepEqual(rescue.entries.map(entry => entry.quest.title), ['潜入艾伦尼城', '艾伦尼士兵的奇袭', '单独潜入', '逃出艾伦尼城']);
  assert.equal(rescue.summary.journalVisible, 4);
});

test('entries keep each group questIds order forward', () => {
  for (const group of projectQuestCatalog(index, new Map())) {
    assert.deepEqual(
      group.entries.map(entry => entry.quest.id),
      group.definition.questIds,
      group.definition.id,
    );
  }
});

test('side groups resolve the latest referenced main group as their story anchor', () => {
  const catalog = projectQuestCatalog(index, new Map());

  const logue = catalog.find(group => group.definition.id === 'native-group-59');
  assert.ok(logue);
  assert.equal(logue.definition.title, '洛格的订单');
  assert.equal(logue.definition.kind, 'side');
  assert.equal(logue.anchorMainGroupTitle, '修理次元之门');
  const anchorGroup = campaign.questGroups.find(group => group.title === logue.anchorMainGroupTitle);
  assert.equal(anchorGroup?.id, 'native-group-17');
  assert.equal(anchorGroup?.kind, 'main');

  // quest-223 同时引用 quest-195 和 quest-215；取故事位置最靠后的 quest-215 所在主线组。
  const hunter = catalog.find(group => group.definition.id === 'native-group-104');
  assert.ok(hunter);
  assert.equal(hunter.definition.title, '猎手的遗物');
  assert.equal(hunter.anchorMainGroupTitle, '获得鑫迪的药');
  // 没有跨组主线引用的支线退回它前面最近的主线组，不能显示成“没有进度归属”。
  const wolf = catalog.find(group => group.definition.title === '坤特的狼狗')!;
  assert.equal(wolf.anchorMainGroupTitle, '孤立的格鲁曼');
  const earlier = campaign.quests.findIndex(quest => quest.id === 'quest-195');
  const later = campaign.quests.findIndex(quest => quest.id === 'quest-215');
  assert.ok(later > earlier);
});

test('projecting new statuses updates entries and summaries without changing order', () => {
  const lockedCatalog = projectQuestCatalog(index, new Map());
  const lockedOrder = shape(lockedCatalog);
  const lockedOpening = lockedCatalog.find(group => group.definition.id === 'native-group-2')!;
  assert.equal(lockedOpening.entries[0].status, 'locked');
  assert.equal(lockedOpening.entries[0].progress.goals.objective, 0);
  assert.equal(lockedOpening.summary.completed, 0);
  assert.equal(lockedOpening.ready, false);
  assert.equal(lockedOpening.current, false);

  const activeCatalog = projectQuestCatalog(index, new Map([
    ['grafton-mission', progress('active', { objective: 0 })],
    ['quest-39', progress('active')],
  ]));
  assert.deepEqual(shape(activeCatalog), lockedOrder);

  const activeOpening = activeCatalog.find(group => group.definition.id === 'native-group-2')!;
  assert.equal(activeOpening.entries[0].status, 'active');
  assert.equal(activeOpening.summary.active, 1);
  assert.equal(activeOpening.summary.completed, 0);
  assert.equal(activeOpening.current, true);

  const activeRescue = activeCatalog.find(group => group.definition.id === 'native-group-7')!;
  assert.equal(activeRescue.entries.find(entry => entry.quest.id === 'quest-39')?.status, 'active');
  assert.equal(activeRescue.summary.active, 1);
  assert.equal(activeRescue.current, true);

  const readyCatalog = projectQuestCatalog(index, new Map([
    ['grafton-mission', progress('ready', { objective: 1 })],
  ]));
  assert.deepEqual(shape(readyCatalog), lockedOrder);
  const readyOpening = readyCatalog.find(group => group.definition.id === 'native-group-2')!;
  assert.equal(readyOpening.entries[0].status, 'ready');
  assert.equal(readyOpening.ready, true);
  assert.equal(readyOpening.current, true);

  const completedCatalog = projectQuestCatalog(index, new Map([
    ['grafton-mission', progress('completed', { objective: 1 })],
  ]));
  assert.deepEqual(shape(completedCatalog), lockedOrder);
  const completedOpening = completedCatalog.find(group => group.definition.id === 'native-group-2')!;
  assert.equal(completedOpening.entries[0].status, 'completed');
  assert.equal(completedOpening.summary.completed, 1);
  assert.equal(completedOpening.ready, false);
  assert.equal(completedOpening.current, false);
});

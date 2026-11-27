import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { domWindow, installMenuDom, type MenuElement } from './support/menu-dom.ts';
import type { Campaign, CampaignQuest } from '../src/domain/campaign.ts';
import type { QuestGroupDefinition, QuestStatus } from '../src/domain/content.ts';
import type { QuestProgress } from '../src/domain/quest-book.ts';
import type { GmActions } from '../src/debug/gm-actions.ts';
import type { QuestCatalogEntry, QuestCatalogGroup, QuestCatalogSummary } from '../src/debug/quest-catalog.ts';
import type { QuestStartPlan } from '../src/debug/quest-jump.ts';
import type { MenuTextSpec } from '../src/ui/dom/menu-text.ts';
import { UiNode } from '../src/ui/dom/node.ts';
import { domAssets } from '../src/ui/dom/assets.ts';
import { COMMON_BUTTON_IMAGES } from '../src/ui/common-button.ts';
import { UiSurface } from '../src/ui/widgets.ts';
import { GmPanel } from '../src/ui/panels/gm-panel.ts';

/** 只保留菜单节点真正用到的 Phaser 边界：事件、画框尺寸和画布矩形。 */
class Events {
  private readonly listeners = new Map<string, { callback: (...args: any[]) => void; context?: unknown; once: boolean }[]>();
  on(event: string, callback: (...args: any[]) => void, context?: unknown) {
    const rows = this.listeners.get(event) ?? [];
    rows.push({ callback, context, once: false });
    this.listeners.set(event, rows);
    return this;
  }
  once(event: string, callback: (...args: any[]) => void, context?: unknown) {
    this.on(event, callback, context);
    this.listeners.get(event)!.at(-1)!.once = true;
    return this;
  }
  off(event: string, callback: (...args: any[]) => void, context?: unknown) {
    this.listeners.set(event, (this.listeners.get(event) ?? [])
      .filter(row => row.callback !== callback || row.context !== context));
    return this;
  }
  emit(event: string, ...args: any[]) {
    for (const row of [...this.listeners.get(event) ?? []]) {
      if (row.once) this.off(event, row.callback, row.context);
      row.callback.apply(row.context, args);
    }
    return this;
  }
}

class MenuScene {
  readonly nodes: UiNode[] = [];
  readonly events = new Events();
  readonly scale = Object.assign(new Events(), { width: 1024, height: 640 });
  readonly game = {
    events: new Events(), renderer: { type: 1 },
    canvas: { getBoundingClientRect: () => ({ x: 0, y: 0, left: 0, top: 0, width: 1024, height: 640 }) },
  };
  readonly textures = { exists: () => false };
  onNodeCreated(node: UiNode): void {
    created.push(node);
    this.nodes.push(node);
  }
}

const cleanupDom = installMenuDom();
after(cleanupDom);

/** 搜索框挂在 #game-frame 下：先找覆盖层，再找里面的原生输入。 */
function questSearchRoot(): MenuElement | undefined {
  return domWindow.children[0]!.children.find(node => node.id === 'game-frame')!.children
    .find(node => String(node.className).includes('gm-quest-search'));
}
function questSearchField(): MenuElement | undefined {
  return questSearchRoot()?.children
    .find(node => String(node.className).includes('gm-quest-search-field'));
}
function questSearchValue(): string {
  return (questSearchField() as unknown as { value: string } | undefined)?.value ?? '';
}
/** 模拟输入框事件；真实浏览器里由用户敲键盘触发。 */
function typeQuestSearch(value: string): void {
  const field = questSearchField();
  assert.ok(field, '搜索框存在');
  (field as unknown as { value: string }).value = value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
}
function pressQuestSearchKey(key: string): void {
  const field = questSearchField();
  assert.ok(field, '搜索框存在');
  const event = new Event('keydown', { bubbles: true, cancelable: true });
  Object.assign(event, { key });
  field.dispatchEvent(event);
}
const preloaded = await domAssets.preloadFiles(COMMON_BUTTON_IMAGES, new AbortController().signal, () => {});
after(() => preloaded.release());

/** 记录所有创建过的 DOM 节点，按钮标签和顺序都从这份名单里找。 */
const created: UiNode[] = [];

const quest = (id: string, title: string): CampaignQuest => ({
  id, title, description: `${title}的说明`, completion: 'story',
  goals: [{ id: 'g1', kind: 'item', target: 'ingredient', quantity: 5, label: '收集食材' }],
  guidance: { available: '去接任务', active: '收集食材' },
  progressText: '进行中', completeText: '完成了',
}) as CampaignQuest;

const definition = (id: string, title: string, kind: 'main' | 'side', questIds: string[]): QuestGroupDefinition =>
  ({ id, title, kind, questIds });

const progress = (status: QuestStatus, current = 0): QuestProgress =>
  ({ status, cycle: 0, completedCycles: 0, goals: { g1: current } });

function summary(entries: QuestCatalogEntry[]): QuestCatalogSummary {
  const value: QuestCatalogSummary = {
    total: entries.length, journalVisible: 0, hidden: 0,
    available: 0, active: 0, ready: 0, completed: 0,
  };
  for (const entry of entries) {
    if (!entry.hidden && !entry.internal) value.journalVisible++;
    if (entry.hidden) value.hidden++;
    if (entry.status === 'available' || entry.status === 'active'
      || entry.status === 'ready' || entry.status === 'completed') value[entry.status]++;
  }
  return value;
}

function catalogGroup(
  group: QuestGroupDefinition, entries: QuestCatalogEntry[], anchor?: string,
): QuestCatalogGroup {
  const counts = summary(entries);
  return {
    definition: group, kind: group.kind, entries, summary: counts,
    ready: counts.ready > 0, current: counts.active > 0 || counts.ready > 0,
    anchorMainGroupTitle: anchor,
  };
}

function fixture(options: { unsatisfied?: boolean; ready?: boolean; scrollGroups?: boolean; rescue?: boolean } = {}) {
  created.length = 0;
  const quests: Record<string, CampaignQuest> = {
    'q-main-1': quest('q-main-1', '主线甲01'),
    'q-main-2': quest('q-main-2', '主线甲02'),
    'q-side-1': quest('q-side-1', '支线乙01'),
    'q-main-3': quest('q-main-3', '主线丙01'),
    'q-raw': quest('q-raw', '主线_测试_BOSS战'),
  };
  const entry = (id: string, status: QuestStatus, current = 0, hidden = false): QuestCatalogEntry =>
    ({ quest: quests[id]!, progress: progress(status, current), status, hidden, internal: false });
  const mainA = definition('group-main-a', '主线甲', 'main', ['q-main-1', 'q-main-2']);
  const sideB = definition('group-side-b', '支线乙', 'side', ['q-side-1']);
  const mainC = definition('group-main-c', '主线丙', 'main', ['q-main-3']);
  const raw = definition('group-raw', '格式组', 'side', ['q-raw']);
  const groups: QuestCatalogGroup[] = [
    catalogGroup(mainA, [entry('q-main-1', 'active', 2), entry('q-main-2', 'completed', 5)]),
    catalogGroup(sideB, [entry('q-side-1', 'locked', 0, true)], '主线甲'),
    catalogGroup(mainC, [entry('q-main-3', 'available')]),
    catalogGroup(raw, [entry('q-raw', 'locked')], '主线丙'),
  ];
  const definitions: QuestGroupDefinition[] = [mainA, sideB, mainC, raw];
  if (options.rescue) {
    quests['quest-40'] = quest('quest-40', '单独潜入');
    const rescue = definition('rescue', '圣女救援行动', 'main', ['quest-40']);
    definitions.push(rescue);
    groups.push(catalogGroup(rescue, [entry('quest-40', 'ready')]));
  }
  if (options.scrollGroups) {
    for (let index = 0; index < 18; index++) {
      const id = `q-far-${index}`;
      quests[id] = quest(id, `远端任务${index}`);
      const group = definition(`group-far-${index}`, `远端组${index}`, 'side', [id]);
      definitions.push(group);
      groups.push(catalogGroup(group, [entry(id, 'locked')], '主线丙'));
    }
  }
  const campaign = {
    quests: Object.values(quests), questGroups: definitions, placements: [],
  } as unknown as Campaign;

  const jumpCalls: string[] = [];
  const jumpModes: (string | undefined)[] = [];
  const gm = {
    digest: () => ({ quests: { active: [], ready: [] }, location: null, story: { completedEvents: 0, runs: [] } }),
    actions: () => [],
    isNoclip: () => false,
    isDoubleSpeed: () => false,
    questCatalog: () => groups,
    previewQuestDebug: (questId: string, mode: QuestStartPlan['mode']) => ({
      ok: true,
      plan: planFor(questId, mode),
    }),
  } as unknown as GmActions;

  function planFor(questId: string, mode: QuestStartPlan['mode']): QuestStartPlan {
    const target = campaign.quests.find(value => value.id === questId)!;
    return {
      questId, quest: target, mode: options.ready ? 'ready' : mode,
      changedQuests: [{ id: 'q-pre', title: '前置任务', from: 'locked', to: 'completed' }],
      accept: { script: 'script-accept', eventId: 'event-accept' },
      acceptAlternatives: [{ script: 'script-accept', eventId: 'event-accept' }],
      conditionPatch: { quests: [], completedQuests: [], choices: [], flags: [], completedEvents: [], removedEvents: [],
        unsatisfied: options.unsatisfied ? ['缺少接取选择'] : [] },
      worldCommands: [], storyItems: [],
      destination: { map: mode === 'ready' ? 'castle' : 'dungeon', x: 8, y: 9, facing: 'south' },
      warnings: [], fallback: options.ready === true,
    };
  }

  const scene = new MenuScene();
  const body = new UiSurface(scene, 960, 480);
  let specs: MenuTextSpec[] = [];
  const writer = { add: (spec: MenuTextSpec) => { specs.push(spec); } };
  let panel: GmPanel;
  const render = () => { specs = []; panel.update(body, writer); };
  panel = new GmPanel(gm, campaign, { close: () => {}, render,
    requestStoryJump: plan => { jumpCalls.push(plan.questId); jumpModes.push(plan.mode); } }, {
    active: () => true,
    setText: (key, text) => {
      const spec = specs.find(value => value.key === key);
      if (spec) spec.text = text;
    },
    moveText: (key, text, y) => {
      const spec = specs.find(value => value.key === key);
      if (spec) { spec.text = text; spec.y = y; }
    },
    refresh: () => {},
  });
  panel.render(body, writer);

  const shown = (label: string) => created.find(node =>
    node.active && node.shown && node.getData('uiAction') && node.getData('label') === label);
  const button = (label: string) => {
    const node = shown(label);
    assert.ok(node, `按钮存在：${label}`);
    return node!;
  };
  const click = (label: string) => (button(label).getData('action') as () => void)();
  const texts = () => specs.map(spec => spec.text);
  return {
    panel, body, scene, groups, campaign, texts, specs: () => specs, button, shown, click, jumpCalls, jumpModes,
    render,
    cleanup: () => { panel.dispose(); scene.events.emit('shutdown'); },
  };
}

test('the GM quest tab lists every group in catalog order with interleaved side quests', t => {
  const f = fixture(); t.after(f.cleanup);
  const tab = f.button('调试页 任务');
  assert.equal(tab.x, 856, '第四个页签在 856');
  assert.ok(tab.input!.hitArea.width + 856 <= 960, '第四个页签不越界');
  f.click('调试页 任务');

  assert.ok(f.button('任务组 主线甲'));
  assert.ok(f.button('任务组 支线乙'));
  assert.ok(f.button('任务组 主线丙'));
  assert.ok(f.button('任务组 主线甲').y < f.button('任务组 支线乙').y, '支线组排在主线甲之后');
  assert.ok(f.button('任务组 支线乙').y < f.button('任务组 主线丙').y, '支线组排在主线丙之前');
  assert.ok(f.texts().includes('支线'), '支线组有文字标签');
  assert.ok(f.texts().includes('当前 · 1/2 完成 · 进行中'), '当前进度组带摘要');
  // 首次打开自动选中当前进度组，右栏直接列出组内任务（按 questIds 顺序，不反转）。
  assert.ok(f.button('任务 主线甲01'));
  assert.ok(f.button('任务 主线甲02'));
  assert.ok(f.button('任务 主线甲01').y < f.button('任务 主线甲02').y, '组内任务保持内容顺序');
});

test('selecting a group shows its quests and selecting a quest shows the jump detail', t => {
  const f = fixture(); t.after(f.cleanup);
  f.click('调试页 任务');
  f.click('任务组 支线乙');
  assert.ok(f.button('任务 支线乙01'));
  assert.equal(f.shown('任务 主线甲01'), undefined, '换组后旧任务不再显示');
  assert.ok(f.texts().includes('未解锁 · 日志外任务'), '日志外任务带标签');

  f.click('任务 支线乙01');
  f.button('跳到可接取');
  assert.ok(f.texts().includes('将补前置 1 个'));
  assert.ok(f.texts().includes('解锁于：主线甲'));
  assert.ok(f.texts().includes('接取剧情：event-accept（脚本 script-accept）'));
  assert.ok(f.texts().includes('支线乙01的说明'));

  f.click('返回任务组');
  assert.ok(f.button('任务 支线乙01'), '返回后重新列出组内任务');
});

test('an unsatisfied accept condition offers the active fallback', t => {
  const f = fixture({ unsatisfied: true }); t.after(f.cleanup);
  f.click('调试页 任务');
  f.click('任务 主线甲01');
  assert.ok(f.button('跳到进行中'));
});

test('a talk quest starts from its ready delivery state', t => {
  const f = fixture({ ready: true }); t.after(f.cleanup);
  f.click('调试页 任务');
  f.click('任务 主线甲01');
  assert.ok(f.texts().includes('没有可接取入口，会直接放到待交付状态。'));
  f.click('跳到待交付');
  assert.deepEqual(f.jumpModes, ['ready']);
});

test('starting a jump asks the host to save first instead of running it directly', t => {
  const f = fixture(); t.after(f.cleanup);
  f.click('调试页 任务');
  f.click('任务 主线甲01');
  assert.ok(f.texts().includes('开始前会先打开存档页，保存成功后自动跳转。'));
  f.click('跳到可接取');
  assert.deepEqual(f.jumpCalls, ['q-main-1']);
  assert.deepEqual(f.jumpModes, ['available']);
});

test('the GM quest search box sits above the left column', t => {
  const f = fixture(); t.after(f.cleanup);
  f.click('调试页 任务');
  const field = questSearchField();
  assert.ok(field, '打开任务页后出现搜索框');
  assert.equal(field!.style.width, '500px');
  assert.equal(field!.style.height, '46px');
  assert.equal(field!.style.top, '8px');
  assert.equal(field!.style.left, '30px');
  assert.ok(Number.parseFloat(field!.style.fontSize) >= 16, '输入框字号不小于 16px');
  assert.equal(questSearchRoot()?.style.display, 'block');
  const entriesTitle = f.specs().find(spec => spec.key === 'gm-quest-entries-title');
  assert.equal(entriesTitle?.y, 70, '右栏内容从框顶开始');
});

test('typing a quest name lists cross-group results and clicking one opens its detail', t => {
  const f = fixture(); t.after(f.cleanup);
  f.click('调试页 任务');
  typeQuestSearch('支线乙01');
  assert.equal(f.shown('任务 主线甲01'), undefined, '搜索时右栏不再显示组内任务');
  assert.ok(f.button('搜索任务 支线乙01'));

  f.click('搜索任务 支线乙01');
  assert.equal(questSearchValue(), '', '选中结果后清空搜索');
  assert.ok(f.texts().includes('支线乙01的说明'), '打开普通任务详情');
  assert.ok(f.texts().includes('解锁于：主线甲'));
  assert.equal(f.shown('搜索任务 支线乙01'), undefined, '搜索结果退出');
});

test('a group name brings out all quests in that group', t => {
  const f = fixture(); t.after(f.cleanup);
  f.click('调试页 任务');
  typeQuestSearch('主线甲');
  assert.ok(f.button('搜索任务 主线甲01'));
  assert.ok(f.button('搜索任务 主线甲02'));
  assert.equal(f.shown('搜索任务 支线乙01'), undefined, '无关任务不出现');
  typeQuestSearch('不存在');
  assert.ok(f.texts().includes('没有匹配的任务'), '无结果时给出提示');
});

test('Enter opens the first result and Escape clears the search', t => {
  const f = fixture(); t.after(f.cleanup);
  f.click('调试页 任务');
  typeQuestSearch('主线甲');
  pressQuestSearchKey('Enter');
  assert.equal(questSearchValue(), '');
  assert.ok(f.texts().includes('主线甲01的说明'), 'Enter 打开第一条结果');

  typeQuestSearch('支线乙');
  assert.ok(f.button('搜索任务 支线乙01'));
  pressQuestSearchKey('Escape');
  assert.equal(questSearchValue(), '', 'Escape 清空输入');
  assert.ok(f.button('任务 主线甲01'), '回到当前组的任务列表，菜单没有关闭');
  assert.equal(f.shown('搜索任务 支线乙01'), undefined);
});

test('the quest search box only shows on the quest tab', t => {
  const f = fixture(); t.after(f.cleanup);
  f.click('调试页 任务');
  assert.equal(questSearchRoot()?.style.display, 'block');
  f.click('调试页 状态');
  assert.equal(questSearchRoot()?.style.display, 'none');
  f.click('调试页 任务');
  assert.equal(questSearchRoot()?.style.display, 'block');
});

test('raw story markers are shown as readable task text', t => {
  const f = fixture(); t.after(f.cleanup);
  f.click('调试页 任务');
  typeQuestSearch('测试');
  assert.ok(f.button('搜索任务 主线 · 测试：首领战'));
  f.click('搜索任务 主线 · 测试：首领战');
  assert.ok(f.texts().includes('主线 · 测试：首领战'));
  assert.ok(!f.texts().some(text => text.includes('_BOSS战')), '详情不显示内容标记');
});

test('selecting a search result scrolls the left catalog to its group', t => {
  const f = fixture({ scrollGroups: true }); t.after(f.cleanup);
  f.click('调试页 任务');
  typeQuestSearch('远端任务17');
  assert.ok(f.button('搜索任务 远端任务17'));
  f.click('搜索任务 远端任务17');
  assert.ok(f.button('任务组 远端组17'), '左栏滚到结果所在组');
  assert.ok(f.texts().includes('远端任务17的说明'));
});

test('the search box follows the menu frame after layout changes', t => {
  const f = fixture(); t.after(f.cleanup);
  f.click('调试页 任务');
  const field = questSearchField()!;
  f.body.root.setPosition(40, 30).setScale(2);
  f.panel.layoutSearch(f.body);
  assert.equal(field.style.left, '100px');
  assert.equal(field.style.top, '46px');
  assert.equal(field.style.width, '1000px');
  assert.equal(field.style.height, '92px');
});


test('单独潜入可分别预览两个现场，存档页收到所选现场', t => {
  const f = fixture({ rescue: true }); t.after(f.cleanup);
  f.click('调试页 任务');
  f.click('任务组 圣女救援行动');
  f.click('任务 单独潜入');
  assert.ok(f.texts().includes('传送：dungeon (8,9)'));
  f.click('已救出圣女，返回与莱曼汇合');
  assert.ok(f.texts().includes('传送：castle (8,9)'));
  f.click('跳到所选现场');
  f.click('独自进城救人');
  f.click('跳到所选现场');
  assert.deepEqual(f.jumpModes, ['ready', 'available']);
});

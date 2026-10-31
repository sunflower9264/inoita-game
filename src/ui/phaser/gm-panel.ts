import type { Campaign, CampaignQuest } from '../../domain/campaign.ts';
import { storyDebugEvidenceCount, type StoryDebugGap, type StoryDebugTask, type StoryDebugTarget } from '../../domain/story-debug.ts';
import type { GmActions, GmCharacterState, GmItemEntry, GmItemFilter } from '../../debug/gm-actions.ts';
import { INVENTORY_LABELS } from '../../domain/inventory.ts';
import type { UiSurface } from './widgets.ts';
import { drawQuestText, measureQuestText } from './quest-text.ts';

/**
 * 游戏内的 GM 面板——`gm-actions` 的人类通道，只负责显示与收集点击，不做任何动作逻辑。
 * agent 走 `work/tools/gm.mjs` 或 `globalThis.gm`，调的是同一个动作层，所以两边语义一致。
 *
 * 剧情页用 Phaser 的滚动区和可视行渲染：左侧列出可调试任务，右侧说明地点、进度与进入入口。
 * 进度只属于任务，在任务详情显示一次。
 *
 * 版面按菜单 body 的可用高度（约 468）排：子页签 8、过滤 54、双栏 100–436、提示 452。
 */
export interface GmPanelHooks {
  /** 关掉菜单，让剧情接管画面。 */
  close(): void;
  /** 重画整个菜单。 */
  render(): void;
  /** 播放失败时重新打开面板，让原因当场可见，而不是等下一条操作。 */
  reopen?(): void;
}

/** 把内容里的编号翻成名字；缺省时使用中文场景说明。 */
export interface GmReferences {
  mapName?(id: string): string | undefined;
  actorName?(id: string): string | undefined;
  /** 背包物品格底图，来自 `content/menu-panels.json` 的 `inventory-slot`。 */
  itemSlot?: string;
  /** 背包选中框，来自 `content/menu-panels.json` 的 `inventory-selected`。 */
  itemSelected?: string;
  /** 道具详情层：装配方用背包同一套说明面板画，关闭时回调清掉状态。 */
  itemDetail?(itemId: string, close: () => void): void;
  /** 大任务名：原版任务组（`questGroups`）的标题。 */
  questGroup?(id: string): string | undefined;
  /** 小任务进度：完成量/总量与当前状态，在任务详情显示一次。 */
  questProgress?(id: string): { status: string; done: number; total: number } | undefined;
}

type GmPage = 'status' | 'character' | 'items' | 'story';
const PAGES: readonly [GmPage, string][] = [
  ['status', '状态'], ['character', '人物'], ['items', '道具'], ['story', '剧情'],
];
/** 道具页：每页 40 格，按背包同款底图与选中框显示。 */
const ITEM_FILTERS: readonly GmItemFilter[] = ['all', 'equipment', 'consumable', 'material', 'quest'];
const ITEM_COLUMNS = 10;
const ITEM_ROWS = 4;
const ITEM_SLOT = 64;
const ITEM_STRIDE = 72;
const ITEM_GRID_X = 60;
const ITEM_GRID_Y = 100;
const ITEM_MAX = 999;
const clipText = (value: string, limit: number): string =>
  value.length > limit ? `${value.slice(0, limit)}…` : value;

/** 原内容中的战斗标记与未汉化占位文案转成可读的面板文字。 */
const readableStoryText = (value:string):string => {
  const translated=value.replaceAll('보류_베스킨의 목걸이','贝斯金的项链')
    .replaceAll('보류_뒷골목의 무법자들','后巷的不法之徒').replaceAll('보류_위험한 연구','危险的研究');
  if(/[가-힣]/.test(translated))return '这段任务的中文说明尚未补全。';
  return translated.replace(/[·_]EP\d+[A-Z]?/g,'').replace(/_BOSS战/g,'：首领战').replace(/BOSS/g,'首领').replaceAll('_',' · ');
};

type StoryCategory = 'main' | 'side' | 'hidden';
type StoryFilter = StoryCategory | 'gaps';
const CATEGORY_LABELS: Record<StoryCategory, string> = { main: '主线', side: '支线', hidden: '隐藏' };
const STORY_FILTERS: readonly (readonly [StoryFilter, string])[] = [
  ['main', '主线'], ['side', '支线'], ['hidden', '隐藏'], ['gaps', '缺口'],
];
const QUEST_STATUS_LABELS: Record<string, string> = {
  locked: '未解锁', available: '可接取', active: '进行中', ready: '待交付', completed: '已完成',
};
const PHASE_LABELS: Record<'available' | 'active', string> = { available: '可接取', active: '进行中' };
const CUT_LABELS: Record<string, string> = {
  'before-opening': '开幕前', 'after-accept': '接取后', 'event-end': '事件末',
};
const DEBUG_SCENE_NOTE = '调试现场：任务状态、物品和前置会由 GM 直接补齐，不代表正常流程可到达。';
const DEBUG_PAUSED_NOTE = '调试现场：自动存档已暂停';

/** 预览成功时动作层给出的现场；面板只读，不在本地推算。 */
interface TaskPreview {
  quest: string;
  phase: 'available' | 'active';
  location: { map: string; x: number; y: number };
  sourceHash?: string;
  accept?: { event?: string; script?: string; node?: string; actor?: string; giver?: string };
  play?: { script?: string; node?: string; event?: string; cut?: string };
  evidence?: number;
}
interface PreviewResult { ok: boolean; reason?: string; preview?: TaskPreview }

const readTaskPreview = (value: unknown): TaskPreview | undefined => {
  const preview = value as Partial<TaskPreview> | undefined;
  const location = preview?.location as Partial<TaskPreview['location']> | undefined;
  const phase = preview?.phase;
  return preview && typeof preview.quest === 'string' && (phase === 'available' || phase === 'active')
    && location && typeof location.map === 'string'
    ? preview as TaskPreview : undefined;
};

interface StoryTaskRow {
  task: StoryDebugTask;
  quest: CampaignQuest;
  title: string;
  category: StoryCategory;
}

export class GmPanel {
  private page: GmPage = 'status';
  private filter: StoryFilter = 'main';
  private result = '';
  private ending = false;
  private selectedQuest?: string;
  private selectedGap?: number;
  private storyCatalog?: StoryTaskRow[];
  /** 当前选中任务的预览请求；换任务就作废旧结果，迟到的响应不覆盖新选择。 */
  private previewQuest?: string;
  private previewResult?: PreviewResult;
  private previewToken = 0;
  private characterId = 'player';
  private itemFilter: GmItemFilter = 'all';
  private itemQuantity = 1;
  private itemSelected?: string;
  private itemDetail?: string;
  /** 道具网格的滚动位置：选物品、发放和重画都不应该把列表跳回顶部。 */
  private itemScroll = 0;
  /** 选中任务和换筛选会重画整页，列表与说明各存一份滚动位置。 */
  private storyScroll = 0;
  private storyIntroScroll = 0;

  private readonly gm: GmActions;
  private readonly campaign: Campaign;
  private readonly hooks: GmPanelHooks;
  private readonly references: GmReferences;
  // 项目启用 `erasableSyntaxOnly`：不能用构造函数参数属性，字段显式声明再赋值。
  constructor(gm: GmActions, campaign: Campaign, hooks: GmPanelHooks, references: GmReferences = {}) {
    this.gm = gm; this.campaign = campaign; this.hooks = hooks; this.references = references;
  }

  /** 收尾成功后由装配层调用：保留筛选与选中任务，只切回剧情页。 */
  showStoryPage(): void {
    this.page = 'story';
    this.result = '';
    this.hooks.render();
  }

  render(body: UiSurface): void {
    // 四个页签必须落在 960 宽的 body 内：536 + 3×108 + 104 = 964，右端贴到内容区边。
    PAGES.forEach(([page, label], index) =>
      body.button(label, 532 + index * 108, 8, 104, 46, () => { this.page = page; this.result = ''; this.hooks.render(); },
        { selected: this.page === page, fontSize: 20 }).setData('label', `调试页 ${label}`));
    const hint = this.page === 'story' ? this.renderStory(body)
      : this.page === 'character' ? this.renderCharacter(body)
      : this.page === 'items' ? this.renderItems(body)
      : this.renderStatus(body);
    body.text(this.result || hint, 60, 452, 900, 17, this.result ? '#ffd8a0' : '#c8bda6');
  }

  /** 状态页：摘要 + 上报 + 命名标记。 */
  private renderStatus(body: UiSurface): string {
    const digest = this.gm.digest();
    const quests = digest.quests as { active: unknown[]; ready: unknown[] };
    const location = digest.location as { map: string; x: number; y: number } | null;
    const story = digest.story as { completedEvents: number; runs: unknown[] };
    body.text(`地图 ${location ? `${location.map} (${location.x},${location.y})` : '还没进图'}`, 60, 70, 0, 20);
    body.text(`任务 进行中 ${quests.active.length} · 待交付 ${quests.ready.length}`, 60, 102, 0, 20);
    body.text(`剧情 已完成 ${story.completedEvents} 个事件 · 在跑 ${story.runs.length} 段`, 60, 134, 0, 20);
    body.button('上报当前状态', 60, 180, 220, 52, () => void this.onReport()).setData('label', '上报当前状态');
    body.button('记一个状态标记', 300, 180, 220, 52, () => this.onMark()).setData('label', '记一个状态标记');
    const marks = this.gm.marks();
    body.button(marks.length ? `回到「${marks.at(-1)}」` : '回到状态标记', 540, 180, 220, 52,
      () => this.onRecall(), { disabled: !marks.length }).setData('label', '回到状态标记');
    body.button('脱困', 780, 180, 180, 52, () => this.onRescue()).setData('label', '脱困');
    body.text(marks.length ? `已有标记：${marks.join('、')}` : '还没有状态标记。', 60, 244, 900, 16);
    body.text(`最近操作：${this.gm.actions().slice(-3).map(entry => entry.call).join(' → ') || '（还没有）'}`, 60, 276, 900, 16);

    const activeList = quests.active as { id: string; title: string }[];
    const currentId = (digest.quests as { current?: string }).current ?? activeList[0]?.id;
    const currentQuest = currentId ? this.campaign.quests.find(q => q.id === currentId) : undefined;
    const questBtnLabel = currentQuest ? `完成任务：「${clipText(currentQuest.title, 8)}」` : '立刻完成当前任务';
    body.button(questBtnLabel, 60, 316, 360, 48, () => this.onCompleteCurrentQuest(),
      { disabled: !currentQuest }).setData('label', '立刻完成当前任务');
    body.button(`穿墙：${this.gm.isNoclip() ? '开' : '关'}`, 440, 316, 220, 48,
      () => this.onToggleNoclip(), { selected: this.gm.isNoclip() }).setData('label', '穿墙');
    body.button(`2倍速度：${this.gm.isDoubleSpeed() ? '开' : '关'}`, 680, 316, 220, 48,
      () => this.onToggleDoubleSpeed(), { selected: this.gm.isDoubleSpeed() }).setData('label', '2倍速度');

    return '提示：穿墙开启后可自由穿越障碍与NPC；2倍速度提升移动跑图效率；完成当前任务可直接结算奖励。';
  }

  /** 人物页：选人、看数值、升级/回满/全队回满/无敌/无 CD。 */
  private renderCharacter(body: UiSurface): string {
    const characters = this.gm.characters();
    if (!characters.length) {
      body.text('当前会话没有角色数据。', 60, 80, 900, 20);
      return '';
    }
    if (!characters.some(character => character.id === this.characterId)) this.characterId = characters[0]!.id;
    characters.forEach((character, index) => {
      body.button(`${character.name} Lv.${character.level}`, 60 + index * 180, 56, 170, 42,
        () => { this.characterId = character.id; this.result = ''; this.hooks.render(); },
        { selected: character.id === this.characterId }).setData('label', `角色 ${character.id}`);
    });
    const selected = characters.find(character => character.id === this.characterId)!;
    body.text(`等级 Lv.${selected.level}`, 60, 112, 900, 20);
    body.text(selected.nextLevelExperience > 0
      ? `经验 ${selected.experience} / ${selected.nextLevelExperience}`
      : '经验 —（已满级）', 60, 144, 900, 18);
    body.text(`HP ${selected.health} / ${selected.maxHealth}`, 60, 176, 900, 18);
    body.text(`MP ${selected.mana} / ${selected.maxMana}`, 60, 208, 900, 18);
    body.text(`无敌 ${selected.invincible ? '开' : '关'} · 一击必杀 ${selected.oneHitKill ? '开' : '关'} · 技能 ${selected.noCooldown ? '无 CD' : '正常冷却'}`,
      60, 240, 900, 18);
    // 回满 HP 对倒下的角色也开放：动作层会走战斗侧复活，所以不按存活禁用。
    body.button('升一级', 60, 286, 160, 46, () => this.onLevelUp(),
      { disabled: !selected.alive || selected.nextLevelExperience <= 0 }).setData('label', '升一级');
    body.button('回满 HP', 232, 286, 160, 46, () => this.onRestoreHealth()).setData('label', '回满 HP');
    body.button('回满 MP', 404, 286, 160, 46, () => this.onRestoreMana(),
      { disabled: !selected.alive }).setData('label', '回满 MP');
    body.button('全队回满', 576, 286, 160, 46, () => this.onRecoverParty()).setData('label', '全队回满');
    body.button(`无敌：${selected.invincible ? '开' : '关'}`, 60, 346, 160, 46,
      () => this.onToggleInvincible(selected), { selected: selected.invincible }).setData('label', '无敌');
    body.button(`技能无 CD：${selected.noCooldown ? '开' : '关'}`, 232, 346, 170, 46,
      () => this.onToggleNoCooldown(selected), { selected: selected.noCooldown }).setData('label', '技能无 CD');
    body.button(`一击必杀：${selected.oneHitKill ? '开' : '关'}`, 416, 346, 190, 46,
      () => this.onToggleOneHitKill(selected), { selected: selected.oneHitKill }).setData('label', '一击必杀');
    return '升级只升不降；倒下角色点「回满 HP」即可复活。无敌只挡战斗伤害，不挡剧情直接改血；一击必杀在命中敌人时直接击杀，未命中仍然落空。';
  }

  /** 道具页：背包同款格子整页滚动；点格子打开与背包一致的详情层。 */
  private renderItems(body: UiSurface): string {
    const entries = this.gm.items(this.itemFilter);
    const grid = body.scroll(ITEM_GRID_X, ITEM_GRID_Y, ITEM_COLUMNS * ITEM_STRIDE, ITEM_ROWS * ITEM_STRIDE);
    entries.forEach((entry, index) => {
      const x = (index % ITEM_COLUMNS) * ITEM_STRIDE;
      const y = Math.floor(index / ITEM_COLUMNS) * ITEM_STRIDE;
      const button = body.button('', x, y, ITEM_SLOT, ITEM_SLOT,
        () => { this.itemSelected = entry.id; this.itemDetail = entry.id; this.itemQuantity = 1; this.result = ''; this.hooks.render(); },
        { ...(this.references.itemSlot ? { image: this.references.itemSlot } : {}), parent: grid.content, guard: grid.guard });
      body.image(entry.icon, 4, 4, ITEM_SLOT - 8, ITEM_SLOT - 8, button);
      if (entry.id === this.itemSelected && this.references.itemSelected)
        body.image(this.references.itemSelected, -5, -5, ITEM_SLOT + 10, ITEM_SLOT + 10, button);
      button.setData('label', `道具 ${entry.id}`);
    });
    // 滚动范围按实际行数给；每次重画后恢复上次的位置。
    grid.setHeight(Math.ceil(entries.length / ITEM_COLUMNS) * ITEM_STRIDE);
    grid.onScroll = () => { this.itemScroll = grid.scrollTop; };
    grid.scrollTop = this.itemScroll;

    const selected = entries.find(entry => entry.id === this.itemSelected);
    if (selected) {
      body.text(clipText(selected.name, 10), 786, 92, 150, 15);
      body.text(`${INVENTORY_LABELS[selected.category]} · Lv.${selected.level}`, 786, 136, 150, 14);
      body.text(`持有 ${selected.owned}`, 786, 160, 150, 14);
    } else {
      body.text('选一件物品', 786, 96, 150, 16);
    }
    body.text(`数量 ${this.itemQuantity}`, 786, 184, 150, 16);
    // 按钮上的字要短到能放进 66×34；完整含义留在 label 上，键盘与测试仍按它查找。
    body.button('-10', 786, 210, 66, 34, () => this.stepQuantity(-10)).setData('label', '数量 -10');
    body.button('+10', 866, 210, 66, 34, () => this.stepQuantity(10)).setData('label', '数量 +10');
    body.button('-1', 786, 246, 66, 34, () => this.stepQuantity(-1)).setData('label', '数量 -1');
    body.button('+1', 866, 246, 66, 34, () => this.stepQuantity(1)).setData('label', '数量 +1');
    body.button('+100', 786, 282, 66, 34, () => this.stepQuantity(100)).setData('label', '数量 +100');
    body.button('归 1', 866, 282, 66, 34,
      () => { this.itemQuantity = 1; this.hooks.render(); }).setData('label', '数量归 1');
    body.button('加入背包', 786, 324, 150, 44, () => this.onGiveItem(selected),
      { disabled: !selected }).setData('label', '加入背包');
    body.text(`金币 ${this.gm.money()}`, 60, 412, 200, 16);
    const moneyBands: readonly (readonly [string, number])[] = [['+1万', 10_000], ['+10万', 100_000], ['+100万', 1_000_000]];
    moneyBands.forEach(([label, amount], index) =>
      body.button(label, 280 + index * 100, 404, index === 2 ? 100 : 90, 40,
        () => this.onGainMoney(amount)).setData('label', `金币 ${label}`));
    body.text('滚轮或拖动列表查看更多', 610, 412, 340, 16);
    ITEM_FILTERS.forEach((filter, index) =>
      body.button(INVENTORY_LABELS[filter], 60 + index * 110, 56, 104, 32,
        () => {
          this.itemFilter = filter; this.itemScroll = 0; this.itemSelected = undefined;
          this.itemDetail = undefined; this.result = ''; this.hooks.render();
        },
        { selected: this.itemFilter === filter }).setData('label', `过滤 ${INVENTORY_LABELS[filter]}`));
    // 详情画在装配方提供的说明层上（与背包详情同一套面板）；关闭后重画本页。
    if (this.itemDetail && this.references.itemDetail)
      this.references.itemDetail(this.itemDetail, () => { this.itemDetail = undefined; this.hooks.render(); });
    return `共 ${entries.length} 件；不含地面拾取物品。`;
  }

  private stepQuantity(delta: number): void {
    this.itemQuantity = Math.max(1, Math.min(ITEM_MAX, this.itemQuantity + delta));
    this.hooks.render();
  }

  private onLevelUp(): void {
    const result = this.gm.levelUp(this.characterId);
    this.result = result.ok ? `已升到 Lv.${result.level}` : `升级失败：${result.reason}`;
    this.hooks.render();
  }
  private onRestoreHealth(): void {
    const result = this.gm.restoreHealth(this.characterId);
    this.result = result.ok ? 'HP 已回满' : `回血失败：${result.reason}`;
    this.hooks.render();
  }
  private onRestoreMana(): void {
    const result = this.gm.restoreMana(this.characterId);
    this.result = result.ok ? 'MP 已回满' : `回蓝失败：${result.reason}`;
    this.hooks.render();
  }
  private onRecoverParty(): void {
    const result = this.gm.recoverParty();
    this.result = result.ok ? `全队回满${result.reason ? `（${result.reason}）` : ''}` : `全队回满失败：${result.reason}`;
    this.hooks.render();
  }
  private onToggleInvincible(character: GmCharacterState): void {
    const result = this.gm.setInvincible(character.id, !character.invincible);
    this.result = result.ok ? `无敌：${!character.invincible ? '开' : '关'}` : `切换失败：${result.reason}`;
    this.hooks.render();
  }
  private onToggleOneHitKill(character: GmCharacterState): void {
    const result = this.gm.setOneHitKill(character.id, !character.oneHitKill);
    this.result = result.ok ? `一击必杀：${!character.oneHitKill ? '开' : '关'}` : `切换失败：${result.reason}`;
    this.hooks.render();
  }
  private onToggleNoCooldown(character: GmCharacterState): void {
    const result = this.gm.setNoCooldown(character.id, !character.noCooldown);
    this.result = result.ok ? `技能无 CD：${!character.noCooldown ? '开' : '关'}` : `切换失败：${result.reason}`;
    this.hooks.render();
  }
  private onGiveItem(entry: GmItemEntry | undefined): void {
    if (!entry) return;
    const result = this.gm.giveItem(entry.id, this.itemQuantity);
    this.result = result.ok
      ? `已加入 ${result.name} ×${result.requested}（持有 ${result.total}）`
      : `发放失败：${result.reason}`;
    this.hooks.render();
  }
  private onGainMoney(amount: number): void {
    const result = this.gm.gainMoney(amount);
    this.result = result.ok ? `金币 +${amount}，现有 ${result.money}` : `加金币失败：${result.reason}`;
    this.hooks.render();
  }

  /** 剧情页只有任务列表一层；Escape 交给菜单继续处理。 */

  private renderStory(body: UiSurface): string {
    // 缺口分区读导出器台账：只说明缺哪条证据，不触发预览，也不能进入任务。
    if (this.filter === 'gaps') return this.renderGaps(body);
    const debug = this.gm.storyDebug();
    const rows = this.storyTasks();
    if (!rows.some(row => row.task.quest === this.selectedQuest)) {
      this.selectedQuest = rows[0]?.task.quest;
      this.storyIntroScroll = 0;
    }
    const row = rows.find(row => row.task.quest === this.selectedQuest);
    body.rect(60,100,352,336,0x120d08,.72); body.rect(430,100,490,336,0x120d08,.72);
    STORY_FILTERS.forEach(([value,label],index)=>body.button(label,60+index*110,54,104,30,()=>{
      if(this.filter===value)return;this.filter=value;this.storyScroll=0;this.storyIntroScroll=0;this.selectedGap=undefined;this.hooks.render();
    },{selected:this.filter===value,fontSize:17}).setData('label',`分类 ${label}`));
    if (debug.focus) body.button(this.ending ? '正在结束调试…' : '结束本次调试',660,54,150,30,
      ()=>this.onEndDebug(),{disabled:this.ending}).setData('label','结束本次调试');
    const list=body.scroll(60,100,352,336);list.onScroll=()=>{this.storyScroll=list.scrollTop;};list.setHeight(rows.length*54);
    list.setVirtual(rows.length,54,(first,last)=>{
      for(let index=first;index<last;index++){
        const item=rows[index]!,selected=item.task.quest===this.selectedQuest,y=index*54;
        body.rect(0,y,352,52,selected?0x6f5232:0x241a10,selected?.74:.46,list.content);
        const button=body.button('',0,y,352,52,()=>{
          if(item.task.quest===this.selectedQuest)return;
          this.selectedQuest=item.task.quest;this.storyIntroScroll=0;this.hooks.render();
        },{bare:true,parent:list.content,guard:list.guard});
        button.setData('label',`任务 ${item.title}`).setData('category',item.category);
        body.text(clipText(item.title,17),12,5,328,18,selected?'#fff':'#f3deb0',button);
        const progress=this.references.questProgress?.(item.quest.id);
        body.text([CATEGORY_LABELS[item.category],progress?QUEST_STATUS_LABELS[progress.status]??'':undefined]
          .filter(Boolean).join(' · '),12,29,328,15,'#b8ab92',button);
      }
    });list.scrollTop=this.storyScroll;
    if(row)this.renderTaskDetail(body,row);
    else body.text('没有符合筛选条件的任务',442,112,466,19);
    return `可调任务 ${rows.length} 个${debug.focus?` · ${DEBUG_PAUSED_NOTE}`:''}`;
  }

  /** 缺口分区：每条缺口说明缺哪条证据与修复线索，不提供进入入口。 */
  private renderGaps(body: UiSurface): string {
    const gaps = this.gaps();
    if (this.selectedGap === undefined || this.selectedGap >= gaps.length) this.selectedGap = gaps.length ? 0 : undefined;
    body.rect(60,100,352,336,0x120d08,.72); body.rect(430,100,490,336,0x120d08,.72);
    STORY_FILTERS.forEach(([value,label],index)=>body.button(label,60+index*110,54,104,30,()=>{
      if(this.filter===value)return;this.filter=value;this.storyScroll=0;this.storyIntroScroll=0;this.hooks.render();
    },{selected:this.filter===value,fontSize:17}).setData('label',`分类 ${label}`));
    const list=body.scroll(60,100,352,336);list.setHeight(gaps.length*54);
    list.setVirtual(gaps.length,54,(first,last)=>{
      for(let index=first;index<last;index++){
        const gap=gaps[index]!,selected=index===this.selectedGap,y=index*54;
        body.rect(0,y,352,52,selected?0x6f5232:0x241a10,selected?.74:.46,list.content);
        const button=body.button('',0,y,352,52,()=>{
          if(index===this.selectedGap)return;
          this.selectedGap=index;this.hooks.render();
        },{bare:true,parent:list.content,guard:list.guard});
        button.setData('label',`缺口 ${gap.quest}`);
        body.text(clipText(this.questTitle(gap.quest),17),12,5,328,18,selected?'#fff':'#f3deb0',button);
        body.text(clipText(gap.kind,26),12,29,328,15,'#b8ab92',button);
      }
    });
    const gap=this.selectedGap!==undefined?gaps[this.selectedGap]:undefined;
    if(gap)this.renderGapDetail(body,gap);
    else body.text('没有缺口记录',442,112,466,19);
    return `缺口 ${gaps.length} 条`;
  }

  private renderGapDetail(body: UiSurface, gap: StoryDebugGap): void {
    body.text(clipText(this.questTitle(gap.quest),22),442,108,466,20,'#f3deb0');
    body.text(clipText(gap.kind,26),442,136,466,16,'#b8ab92');
    this.drawStoryDescription(body,gap.detail);
    body.text(clipText(`证据：${gap.evidence ?? '—'}`,56),442,258,466,15,'#b8ab92');
    body.text(clipText(`修复线索：${gap.fixHint ?? '继续查原版证据'}`,56),442,280,466,15,'#b8ab92');
    body.text(clipText('缺口任务不生成现场表，也不进入任务列表。',54),442,322,466,15,'#b8ab92');
  }

  /** 选中任务的详情：进度、说明、现场表来源与开幕演出；预览完成前不开放进入。 */
  private renderTaskDetail(body: UiSurface, row: StoryTaskRow): void {
    const progress=this.references.questProgress?.(row.quest.id);
    const progressLabel=progress
      ?`${QUEST_STATUS_LABELS[progress.status]??progress.status}${progress.total?` · 进度 ${progress.done}/${progress.total}`:''}`
      :CATEGORY_LABELS[row.category];
    body.text(clipText(row.title,22),442,108,466,20,'#f3deb0');
    body.text(progressLabel,442,136,466,16,'#b8ab92');
    this.drawStoryDescription(body,row.quest.description,68);
    const prepared=this.previewFor(row.task.quest);
    const preview=prepared.result?.preview;
    const map=preview?.location.map??row.task.entry.map;
    const mapName=this.references.mapName?.(map)??'剧情发生地';
    const phase=preview?.phase??row.task.phase;
    body.text(clipText(`地点：${mapName}`,28),442,234,466,15,'#b8ab92');
    body.text(`默认起点：${PHASE_LABELS[phase]}`,442,254,466,15,'#b8ab92');
    body.text(clipText(this.startSourceLabel(row.task,preview),58),442,274,466,15,'#b8ab92');
    body.text(clipText(this.acceptLabel(row.task,preview),58),442,294,466,15,'#b8ab92');
    body.text(clipText(this.playLabel(row.task,preview),58),442,314,466,15,'#b8ab92');
    const failure=!prepared.result?'正在准备任务现场…'
      :!prepared.result.ok?prepared.result.reason??'预览失败，原因未记录'
      :!preview?'预览没有返回任务现场':undefined;
    if(failure)body.text(clipText(failure,56),442,338,466,15,
      prepared.result&&!prepared.result.ok?'#ffd8a0':'#b8ab92');
    body.text(clipText(DEBUG_SCENE_NOTE,54),442,362,466,15,'#b8ab92');
    body.button('进入任务',442,392,466,40,()=>this.onPlay({quest:row.task.quest}),
      {disabled:!prepared.ready,fontSize:20}).setData('label','进入任务');
  }

  /** 现场表来源：显示证据条数与摘要。 */
  private startSourceLabel(task: StoryDebugTask, preview?: TaskPreview): string {
    const evidence = preview?.evidence ?? storyDebugEvidenceCount(task);
    const hash = task.sourceHash ?? preview?.sourceHash;
    return `现场表：已核查 · 证据 ${evidence} 条${hash?` · 摘要 ${hash.slice(0,10)}`:''}`;
  }

  /** 接取事件只显示人话，不把事件/脚本编号摊在界面上。 */
  private acceptLabel(task: StoryDebugTask, preview?: TaskPreview): string {
    const accept = task.accept ?? preview?.accept;
    if (!accept) return '接取事件：—';
    const parts: string[] = [];
    if (accept.event || accept.script || accept.node) parts.push('剧情事件');
    if (accept.actor) parts.push(this.references.actorName?.(accept.actor) ?? '原版人物');
    else if (accept.giver) parts.push('原版人物');
    if (!parts.length) parts.push('原版证据');
    return `接取事件：${parts.join(' · ')}`;
  }

  private playLabel(task: StoryDebugTask, preview?: TaskPreview): string {
    const play = task.play ?? preview?.play;
    if (!play) return '开幕演出：无（只落现场）';
    const cut = CUT_LABELS[play.cut ?? 'before-opening'] ?? '剧情演出';
    return `开幕演出：${cut}${play.node?' · 指定节点':''}`;
  }

  private gaps(): StoryDebugGap[] { return this.campaign.debugStory?.gaps ?? []; }
  private questTitle(id: string): string { return this.campaign.quests.find(quest=>quest.id===id)?.title??id; }

  /** 预览只对当前选中任务发起一次；换任务后迟到的结果直接丢弃。 */
  private previewFor(quest: string): { result?: PreviewResult; ready: boolean } {
    if(this.previewQuest!==quest){
      this.previewQuest=quest;this.previewResult=undefined;
      const token=++this.previewToken;
      const settle=(result:PreviewResult)=>{
        if(this.previewToken!==token||this.previewQuest!==quest)return;
        this.previewResult=result;
        if(this.page==='story')this.hooks.render();
      };
      void this.gm.previewStory({quest}).then(result=>{
        const preview=readTaskPreview(result.preview);
        settle(result.ok&&preview?{ok:true,preview}
          :result.ok?{ok:false,reason:'预览没有返回任务现场'}
          :{ok:false,reason:result.reason??'预览失败，原因未记录'});
      },error=>settle({ok:false,reason:error instanceof Error?error.message:String(error)}));
    }
    return {result:this.previewResult,ready:!!this.previewResult?.ok&&!!this.previewResult.preview};
  }

  private drawStoryDescription(body: UiSurface, text: string, height = 92): void {
    const scroll=body.scroll(442,162,466,height);scroll.onScroll=()=>{this.storyIntroScroll=scroll.scrollTop;};
    const layout=measureQuestText(body,readableStoryText(text),452,18);drawQuestText(body,layout,0,0,452,18,scroll.content);
    scroll.setHeight(layout.height);scroll.scrollTop=this.storyIntroScroll;
  }

  /** 目录只含算得出固定落点的任务；任务信息从 `campaign.quests` 关联，显示不用内部标识。 */
  private storyTasks(): StoryTaskRow[] {
    if(!this.storyCatalog){
      const side=new Set(this.campaign.questGroups.filter(group=>group.kind==='side').flatMap(group=>group.questIds));
      const quests=new Map(this.campaign.quests.map(quest=>[quest.id,quest]));
      // 目录顺序由现场表生成器按剧情依赖排好；这里保持目录顺序，不按任务定义顺序重排。
      this.storyCatalog=(this.campaign.debugStory?.tasks??[]).flatMap((task):StoryTaskRow[]=>{
        const quest=quests.get(task.quest);
        if(!quest)return [];
        const group=this.references.questGroup?.(quest.id);
        return [{
          task,quest,
          title:readableStoryText(group&&group!==quest.title?`${group} · ${quest.title}`:quest.title),
          category:quest.hidden?'hidden':side.has(quest.id)?'side':'main',
        }];
      });
    }
    return this.storyCatalog.filter(row=>row.category===this.filter);
  }

  private async onReport(): Promise<void> {
    const result = await this.gm.report();
    this.result = result.ok ? '已上报：服务器 .diagnostics/client-errors.jsonl 里能查到。' : `上报失败：${result.reason}`;
    this.hooks.render();
  }
  private onMark(): void {
    const name = `标记${this.gm.marks().length + 1}`;
    const result = this.gm.mark(name);
    this.result = result.ok ? `已记下「${name}」` : `记录失败：${result.reason}`;
    this.hooks.render();
  }
  private onRecall(): void {
    const name = this.gm.marks().at(-1);
    if (!name) return;
    const result = this.gm.recall(name);
    this.result = result.ok ? `已回到「${name}」` : `回退失败：${result.reason}`;
    this.hooks.render();
  }
  private onCompleteCurrentQuest(): void {
    const result = this.gm.completeCurrentQuest();
    this.result = result.reason ?? (result.ok ? '任务已完成' : '完成任务失败');
    this.hooks.render();
  }
  private onToggleNoclip(): void {
    const next = !this.gm.isNoclip();
    this.gm.setNoclip(next);
    this.result = next ? '穿墙模式已开启' : '穿墙模式已关闭';
    this.hooks.render();
  }
  private onToggleDoubleSpeed(): void {
    const next = !this.gm.isDoubleSpeed();
    this.gm.setDoubleSpeed(next);
    this.result = next ? '已开启 2 倍速度' : '已恢复正常速度';
    this.hooks.render();
  }
  private onRescue(): void {
    const result = this.gm.rescue();
    const place = (value: unknown) => {
      const point = value as { x?: number; y?: number } | undefined;
      return point && typeof point.x === 'number' ? `(${point.x},${point.y})` : '未知位置';
    };
    this.result = !result.ok ? `脱困失败：${result.reason}`
      : result.moved ? `已从 ${place(result.from)} 搬到 ${place(result.to)}`
      : '当前位置整个碰撞盒站得住，不需要脱困';
    this.hooks.render();
  }
  private onPlay(target: StoryDebugTarget): void {
    this.result='';this.hooks.close();
    void this.gm.jumpStory(target).then(result=>{
      // 失败原因直接写出来：多半是内容缺地点或切图被拒，只报「未能进入」没法复现。
      this.result=result.ok?'':`未能进入任务：${result.reason??'原因未记录'}`;
      if(!result.ok)this.hooks.reopen?.();
      this.hooks.render();
    });
  }
  private onEndDebug(): void {
    if(this.ending)return;
    this.ending=true;this.result='正在恢复进入调试前的状态…';this.hooks.render();
    void this.gm.endStoryDebug().then(result=>{
      this.ending=false;
      this.result=result.ok?'已结束调试，自动存档恢复':`结束调试失败：${result.reason}`;
      this.hooks.render();
    });
  }
}

import type { Campaign, CampaignQuest } from '../../domain/campaign.ts';
import type { GmActions, GmCharacterState, GmItemEntry, GmItemFilter } from '../../debug/gm-actions.ts';
import type { QuestCatalogEntry, QuestCatalogGroup } from '../../debug/quest-catalog.ts';
import { questJumpStages, type QuestStartMode, type QuestStartPlan } from '../../debug/quest-jump.ts';
import type { QuestStatus } from '../../domain/content.ts';
import { INVENTORY_LABELS } from '../../domain/inventory.ts';
import { GOLD, type ScrollArea, type UiSurface } from '../widgets.ts';
import type { MenuTextClip, MenuTextSpec, MenuTextWriter } from '../dom/menu-text.ts';
import type { UiImage, UiNode } from '../dom/node.ts';
import { QuestSearchInput } from '../dom/quest-search-input.ts';

/**
 * 游戏内的 GM 面板——`gm-actions` 的人类通道，只负责显示与收集点击，不做任何动作逻辑。
 * agent 走 `work/tools/gm.mjs` 或 `globalThis.gm`，调的是同一个动作层，所以两边语义一致。
 *
 * 版面按菜单 body 的可用高度（约 468）排：子页签 8、过滤 54、内容区 100–436、提示 452。
 */
interface GmPanelHooks {
  /** 关掉菜单，让剧情接管画面。 */
  close(): void;
  /** 重画整个菜单。 */
  render(): void;
  runAction?<T>(action:()=>T):T;
  /** 打开存档页；保存成功后由宿主执行剧情跳转。 */
  requestStoryJump?(plan: QuestStartPlan): void;
}

/** 把内容里的编号翻成名字；缺省时使用中文场景说明。 */
interface GmReferences {
  /** 背包物品格底图，来自 `content/menu-panels.json` 的 `inventory-slot`。 */
  itemSlot?: string;
  /** 背包选中框，来自 `content/menu-panels.json` 的 `inventory-selected`。 */
  itemSelected?: string;
  /** 任务组列表底图与状态图，来自 `content/menu-panels.json` 的同名资源。 */
  questRow?: string;
  questRowSelected?: string;
  questRowPressed?: string;
  questReady?: string;
  questMain?: string;
  /** 通用菜单图框；任务页沿用任务日志的左右两栏边框。 */
  assets?: Readonly<Record<string,string>>;
  /** 道具详情层：装配方用背包同一套说明面板画，关闭时回调清掉状态。 */
  itemDetail?(itemId: string, close: () => void): void;
  updateItemDetail?(itemId:string|undefined,close:()=>void):void;
  /** 把页面里的滚动区登记给菜单文字层，滚轮和拖动时 DOM 文字才能跟着走。 */
  registerScroll?(name: string, scroll: ScrollArea): void;
  removeScroll?(scroll: ScrollArea): void;
  active?():boolean;
  /** 滚动后重算 DOM 文字位置。 */
  refresh?(): void;
  setText?(key:string,text:string):void;
  /** 池化列表滚动时同时改文字和它在页面里的纵向位置。 */
  moveText?(key:string,text:string,y:number):void;
}

type GmPage = 'status' | 'character' | 'items' | 'quests';
const PAGES: readonly [GmPage, string][] = [
  ['status', '状态'], ['character', '人物'], ['items', '道具'], ['quests', '任务'],
];
const QUEST_STATUS_LABELS: Record<QuestStatus, string> = {
  locked: '未解锁', available: '可接取', active: '进行中', ready: '待交付', completed: '已完成',
};
const QUEST_STATUS_COLORS: Record<QuestStatus, string> = {
  locked: '#8a7a62', available: '#8fd18a', active: '#ffd8a0', ready: '#ffb36b', completed: '#a9a294',
};
/** 任务页左右两栏与原版任务日志同宽：左 536，右 380，中间留 16。 */
const QUEST_ROW_HEIGHT = 56;
const QUEST_ENTRY_HEIGHT = 52;
const QUEST_LEFT = { x: 30, y: 70, width: 504, height: 350 } as const;
const QUEST_RIGHT = { x: 582, y: 70, width: 348, height: 350 } as const;
/** 搜索框在左栏上方、与页签同一行；两栏任务内容都从框内顶部 70 开始。 */
const QUEST_SEARCH = { x: QUEST_LEFT.x, y: 8, width: 500, height: 46 } as const;
const QUEST_CONTENT_Y = 70;
const QUEST_DETAIL_HEIGHT = 282;
/** 没有调试任务时，右栏列表一直排到边框内沿（70..420）。 */
const QUEST_ENTRIES_HEIGHT = QUEST_RIGHT.y + QUEST_RIGHT.height - QUEST_CONTENT_Y;
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
const readableStoryText = (value: string): string => {
  const translated = value.replaceAll('보류_베스킨의 목걸이', '贝斯金的项链')
    .replaceAll('보류_뒷골목의 무법자들', '后巷的不法之徒').replaceAll('보류_위험한 연구', '危险的研究');
  if (/[가-힣]/.test(translated)) return '这段任务的中文说明尚未补全。';
  return translated.replace(/[·_]EP\d+[A-Z]?/g, '')
    .replace(/_BOSS战/g, '：首领战').replace(/BOSS/g, '首领').replaceAll('_', ' · ');
};

/** 搜索匹配前去掉空白并转小写，中文按子串比较。 */
const normalizeQuestQuery = (value: string): string => value.replace(/\s+/g, '').toLowerCase();
const questTextMatches = (text: string, query: string): boolean =>
  text.replace(/\s+/g, '').toLowerCase().includes(query);

interface QuestSearchResult {
  group: QuestCatalogGroup;
  entry: QuestCatalogEntry;
}

function collectQuestSearchResults(
  groups: readonly QuestCatalogGroup[], query: string,
): QuestSearchResult[] {
  const results: QuestSearchResult[] = [];
  if (!query) return results;
  for (const group of groups) {
    const groupMatches = questTextMatches(group.definition.title, query)
      || questTextMatches(readableStoryText(group.definition.title), query);
    for (const entry of group.entries) {
      if (groupMatches || questTextMatches(entry.quest.title, query)
        || questTextMatches(readableStoryText(entry.quest.title), query)) results.push({ group, entry });
    }
  }
  return results;
}

export class GmPanel {
  private page: GmPage = 'status';
  private result = '';
  private characterId = 'player';
  private itemFilter: GmItemFilter = 'all';
  private itemQuantity = 1;
  private itemQuantityTextKey?:string;
  private itemSelected?: string;
  private itemDetail?: string;
  /** 道具网格的滚动位置：选物品、发放和重画都不应该把列表跳回顶部。 */
  private itemScroll = 0;
  /** 任务页：左栏任务组、右栏任务或任务详情，各自保留选中与滚动位置。 */
  private questGroupId?: string;
  private questId?: string;
  private questPreview?: QuestStartPlan;
  private questList?: ScrollArea;
  private questEntryList?: ScrollArea;
  private questDetailScroll?: ScrollArea;
  private questListOffset = 0;
  /** 搜索选中远端组时指定左栏目标位置；下一次 capture 不能拿旧 scrollTop 覆盖它。 */
  private questListScrollTarget?: number;
  private questEntryOffset = 0;
  private questDetailOffset = 0;
  /** 搜索框里的原始文字；匹配前统一去空格并转小写。 */
  private questQuery = '';
  private questSearchList?: ScrollArea;
  private questSearchOffset = 0;
  private readonly questSearch: QuestSearchInput;
  private questInitialized = false;
  /** 本次重画的 DOM 文字出口；GM 页的文字全部按内容块坐标登记。 */
  private writer?: MenuTextWriter;
  private tabButtons=new Map<GmPage,UiNode>();
  private tabText:MenuTextSpec[]=[];
  private contentNodes:UiNode[]=[];
  private contentScrolls:ScrollArea[]=[];
  private refreshItemPage?:()=>void;
  private refreshStatusPage?:()=>void;
  private reportSerial=0;
  private characterControls?:{
    members:Map<string,{button:UiNode;key:string}>;values:string[];level:UiNode;mana:UiNode;
    toggles:{
      invincible:{button:UiNode;key:string};
      infiniteMana:{button:UiNode;key:string};
      noCooldown:{button:UiNode;key:string};
      oneHitKill:{button:UiNode;key:string};
    };
    tenSkillPoints:{button:UiNode;key:string};
  };
  private textSerial = 0;
  private resultTextKey?:string;

  private readonly gm: GmActions;
  private readonly campaign: Campaign;
  private readonly hooks: GmPanelHooks;
  private readonly references: GmReferences;
  // 项目启用 `erasableSyntaxOnly`：不能用构造函数参数属性，字段显式声明再赋值。
  constructor(gm: GmActions, campaign: Campaign, hooks: GmPanelHooks, references: GmReferences = {}) {
    this.gm = gm; this.campaign = campaign; this.hooks = hooks; this.references = references;
    this.questSearch = new QuestSearchInput({
      onInput: value => this.onQuestQuery(value),
      onSubmit: () => this.openFirstQuestSearchResult(),
      onEscape: () => this.clearQuestSearch(),
    });
  }

  /** 搜索框有焦点时菜单键盘整块让路；输入框自己处理 Enter/Escape。 */
  get searchFocused():boolean {
    return this.questSearch.focused;
  }

  /** 画框缩放、旋转或安全区变化后重新贴住左栏上方；不重建任务列表和滚动位置。 */
  layoutSearch(body: UiSurface):void {
    if (this.page !== 'quests') { this.questSearch.hide(); return; }
    this.showQuestSearch(body);
  }

  dispose():void {
    this.reportSerial++;
    this.questSearch.destroy();
    this.questSearchList=undefined;
    this.writer=undefined;
  }

  /** GM 页文字统一走 DOM；`writer` 由菜单提供，图框、按钮和滚动仍由 Phaser 画。 */
  render(body: UiSurface, writer?: MenuTextWriter): void {
    if (this.questPreview) this.questPreview = this.previewQuest(this.questPreview.questId, this.questPreview.mode);
    this.tabButtons.clear();this.tabText=[];this.textSerial=0;
    this.writer={add:spec=>{this.tabText.push(spec);writer?.add(spec);}};
    PAGES.forEach(([page, label], index) => {
      const button=this.button(body, label, 532 + index * 108, 8, 104, 46, () => {
        if(this.page===page)return;
        if (page === 'quests' && this.questPreview) this.questPreview = this.previewQuest(this.questPreview.questId, this.questPreview.mode);
        this.page=page;this.result='';this.hooks.render();
      }, { selected: this.page === page, fontSize: 20 }, `调试页 ${label}`);
      this.tabButtons.set(page,button);
    });
    this.renderContent(body,writer);
  }
  update(body:UiSurface,writer?:MenuTextWriter):void{
    this.captureQuestScrolls();
    for(const scroll of this.contentScrolls){
      this.references.removeScroll?.(scroll);scroll.destroy();
      const index=body.scrolls.indexOf(scroll);if(index>=0)body.scrolls.splice(index,1);
    }
    for(const node of this.contentNodes)node.destroy();
    body.pruneDestroyed();
    for(const [page,button] of this.tabButtons)(button.getData('setSelected') as (selected:boolean)=>void)(page===this.page);
    for(const spec of this.tabText)writer?.add(spec);
    this.textSerial=this.tabText.length;this.renderContent(body,writer);
  }
  private renderContent(body:UiSurface,writer?:MenuTextWriter):void{
    if (this.page !== 'quests') this.questSearch.hide();
    this.reportSerial++;this.writer=writer;this.characterControls=undefined;this.refreshItemPage=undefined;this.refreshStatusPage=undefined;const before=new Set(body.root.list),scrolls=new Set(body.scrolls);
    const hint = this.page === 'character' ? this.renderCharacter(body)
      : this.page === 'items' ? this.renderItems(body)
      : this.page === 'quests' ? this.renderQuests(body)
      : this.renderStatus(body);
    this.resultTextKey=`gm-text-${this.textSerial}`;
    this.text(this.result || hint, 60, 452, 900, 17, this.result ? '#ffd8a0' : '#c8bda6');
    this.contentNodes=body.root.list.filter(node=>!before.has(node));
    this.contentScrolls=body.scrolls.filter(scroll=>!scrolls.has(scroll));
    this.writer = undefined;
  }

  private text(value: string, x: number, y: number, width = 0, size = 22, color = GOLD,
    scroll?: string, clip?: MenuTextClip): void {
    this.textAt(`gm-text-${this.textSerial++}`, value, x, y, width, size, color, scroll, clip);
  }

  /** 固定 key 的文字；任务页的池化行靠它原地更新文字和位置。 */
  private textAt(key: string, value: string, x: number, y: number, width = 0, size = 22,
    color = GOLD, scroll?: string, clip?: MenuTextClip): void {
    this.writer?.add({
      key, text: value, x, y,
      style: { size, color, width: width || undefined, wrap: width ? 'word' : undefined },
      ...(scroll ? { scroll } : {}), ...(clip ? { clip } : {})
    });
  }

  /** 画一枚共用按钮皮肤，并把按钮文字登记到 DOM。 */
  private button(v: UiSurface, label: string, x: number, y: number, width: number, height: number,
    action: () => void, options: Parameters<UiSurface['button']>[6] = {}, dataLabel = label) {
    const button = v.button('', x, y, width, height, action, options).setData('label', dataLabel);
    if (label && this.writer) this.writer.add({
      key: `gm-text-${this.textSerial++}`, text: label, x: x + width / 2, y: y + height / 2,
      style: { size: options.fontSize ?? Math.min(22, height * .42), color: GOLD,
        anchorX: .5, anchorY: .5, width: width - 12, align: 'center', wrap: 'word' }
    });
    return button;
  }

  /** 状态页：摘要、上报、脱困与常用开关。 */
  private renderStatus(body: UiSurface): string {
    const text=(value:string,y:number,size:number,width=0)=>{const key=`gm-text-${this.textSerial}`;this.text(value,60,y,width,size);return key;};
    const button=(label:string,x:number,y:number,width:number,height:number,action:()=>void,options:Parameters<UiSurface['button']>[6]={})=>{
      const key=`gm-text-${this.textSerial}`;return {key,button:this.button(body,label,x,y,width,height,action,options)};
    };
    const digest=this.gm.digest(),quests=digest.quests as {active:{id:string;title:string}[];ready:unknown[];current?:string};
    const location=digest.location as {map:string;x:number;y:number}|null,story=digest.story as {completedEvents:number;runs:unknown[]};
    const locationKey=text(`地图 ${location?`${location.map} (${location.x},${location.y})`:'还没进图'}`,70,20);
    const questKey=text(`任务 进行中 ${quests.active.length} · 待交付 ${quests.ready.length}`,102,20);
    const storyKey=text(`剧情 已完成 ${story.completedEvents} 个事件 · 在跑 ${story.runs.length} 段`,134,20);
    button('上报当前状态',60,180,220,52,()=>void this.onReport()).button.setData('label','上报当前状态');
    button('脱困',300,180,220,52,()=>this.onRescue()).button.setData('label','脱困');
    const actionsKey=text(`最近操作：${this.gm.actions().slice(-3).map(entry=>entry.call).join(' → ')||'（还没有）'}`,276,16,900);
    const currentId=quests.current??quests.active[0]?.id,current=currentId?this.campaign.quests.find(q=>q.id===currentId):undefined;
    const quest=button(current?`完成任务：「${clipText(readableStoryText(current.title),8)}」`:'立刻完成当前任务',60,316,360,48,()=>this.onCompleteCurrentQuest(),{disabled:!current});quest.button.setData('label','立刻完成当前任务');
    const noclip=button(`穿墙：${this.gm.isNoclip()?'开':'关'}`,440,316,220,48,()=>this.onToggleNoclip(),{selected:this.gm.isNoclip()});noclip.button.setData('label','穿墙');
    const speed=button(`2倍速度：${this.gm.isDoubleSpeed()?'开':'关'}`,680,316,220,48,()=>this.onToggleDoubleSpeed(),{selected:this.gm.isDoubleSpeed()});speed.button.setData('label','2倍速度');
    this.refreshStatusPage=()=>{
      const set=this.references.setText;if(!set){this.hooks.render();return;}
      const data=this.gm.digest(),q=data.quests as {active:{id:string;title:string}[];ready:unknown[];current?:string};
      const place=data.location as {map:string;x:number;y:number}|null,storyState=data.story as {completedEvents:number;runs:unknown[]};
      set(locationKey,`地图 ${place?`${place.map} (${place.x},${place.y})`:'还没进图'}`);
      set(questKey,`任务 进行中 ${q.active.length} · 待交付 ${q.ready.length}`);set(storyKey,`剧情 已完成 ${storyState.completedEvents} 个事件 · 在跑 ${storyState.runs.length} 段`);
      set(actionsKey,`最近操作：${this.gm.actions().slice(-3).map(entry=>entry.call).join(' → ')||'（还没有）'}`);
      const id=q.current??q.active[0]?.id,task=id?this.campaign.quests.find(item=>item.id===id):undefined;
      set(quest.key,task?`完成任务：「${clipText(readableStoryText(task.title),8)}」`:'立刻完成当前任务');quest.button.getData('setEnabled')?.(!!task);
      const wall=this.gm.isNoclip(),fast=this.gm.isDoubleSpeed();set(noclip.key,`穿墙：${wall?'开':'关'}`);set(speed.key,`2倍速度：${fast?'开':'关'}`);
      noclip.button.getData('setSelected')?.(wall);speed.button.getData('setSelected')?.(fast);
      if(this.resultTextKey)set(this.resultTextKey,this.result);
    };
    return '提示：穿墙开启后可自由穿越障碍与NPC；2倍速度提升移动跑图效率；完成当前任务可直接结算奖励。';
  }
  private renderCharacter(body: UiSurface): string {
    const characters=this.gm.characters();
    if(!characters.length){this.text('当前会话没有角色数据。',60,80,900,20);return '';}
    if(!characters.some(character=>character.id===this.characterId))this.characterId=characters[0]!.id;
    const members=new Map<string,{button:UiNode;key:string}>();
    characters.forEach((character,index)=>{
      const key=`gm-text-${this.textSerial}`;
      const button=this.button(body,`${character.name} Lv.${character.level}`,60+index*180,56,170,42,()=>{
        if(this.characterId===character.id)return;this.characterId=character.id;this.result='';this.refreshCharacter();
      },{selected:character.id===this.characterId}).setData('label',`角色 ${character.id}`);
      members.set(character.id,{button,key});
    });
    const selected=characters.find(character=>character.id===this.characterId)!,values:string[]=[];
    const value=(text:string,y:number,size:number)=>{values.push(`gm-text-${this.textSerial}`);this.text(text,60,y,900,size);};
    value(`等级 Lv.${selected.level}`,112,20);
    value(selected.nextLevelExperience>0?`经验 ${selected.experience} / ${selected.nextLevelExperience}`:'经验 —（已满级）',144,18);
    value(`HP ${selected.health} / ${selected.maxHealth}`,176,18);value(`MP ${selected.mana} / ${selected.maxMana}`,208,18);
    value(`无敌 ${selected.invincible?'开':'关'} · 无限蓝 ${selected.infiniteMana?'开':'关'} · 一击必杀 ${selected.oneHitKill?'开':'关'} · 技能 ${selected.noCooldown?'无 CD':'正常冷却'}`,240,18);
    const level=this.button(body,'升一级',60,276,160,44,()=>this.onLevelUp(),{disabled:!selected.alive||selected.nextLevelExperience<=0}).setData('label','升一级');
    this.button(body,'回满 HP',232,276,160,44,()=>this.onRestoreHealth()).setData('label','回满 HP');
    const mana=this.button(body,'回满 MP',404,276,160,44,()=>this.onRestoreMana(),{disabled:!selected.alive}).setData('label','回满 MP');
    this.button(body,'全队回满',576,276,160,44,()=>this.onRecoverParty()).setData('label','全队回满');
    const toggle=(name:string,x:number,width:number,selectedValue:boolean,run:(current:GmCharacterState)=>void)=>{
      const key=`gm-text-${this.textSerial}`;
      const button=this.button(body,`${name}：${selectedValue?'开':'关'}`,x,332,width,44,()=>{
        const current=this.gm.characters().find(character=>character.id===this.characterId);if(current)run(current);
      },{selected:selectedValue}).setData('label',name);
      return {button,key};
    };
    const toggles={invincible:toggle('无敌',60,180,selected.invincible,current=>this.onToggleInvincible(current)),
      infiniteMana:toggle('无限蓝',252,190,selected.infiniteMana,current=>this.onToggleInfiniteMana(current)),
      noCooldown:toggle('技能无 CD',454,210,selected.noCooldown,current=>this.onToggleNoCooldown(current)),
      oneHitKill:toggle('一击必杀',676,200,selected.oneHitKill,current=>this.onToggleOneHitKill(current))};
    this.button(body,'技能全满',60,388,180,44,()=>this.onMaxSkills()).setData('label','技能全满');
    const tenEnabled=this.gm.isTenSkillPointsPerLevel();
    const tenKey=`gm-text-${this.textSerial}`;
    const tenButton=this.button(body,`升级10技能点：${tenEnabled?'开':'关'}`,252,388,260,44,()=>this.onToggleTenSkillPoints(),{selected:tenEnabled}).setData('label','升级10技能点');
    this.characterControls={members,values,level,mana,toggles,tenSkillPoints:{button:tenButton,key:tenKey}};
    return '无敌只挡战斗伤害，不挡剧情改血；无限蓝让技能不耗 MP 且免疫吸蓝；开启「升级10技能点」后每次升级获得 10 个技能点。';
  }
  /** 切换 GM 页或重画前保存任务页自己的滚动位置；滚动区随后会被销毁。 */
  private captureQuestScrolls():void {
    if(this.questList){this.questListOffset=this.questListScrollTarget??this.questList.scrollTop;this.questListScrollTarget=undefined;this.questList=undefined;}
    if(this.questEntryList){this.questEntryOffset=this.questEntryList.scrollTop;this.questEntryList=undefined;}
    if(this.questDetailScroll){this.questDetailOffset=this.questDetailScroll.scrollTop;this.questDetailScroll=undefined;}
    if(this.questSearchList){this.questSearchOffset=this.questSearchList.scrollTop;this.questSearchList=undefined;}
  }

  /**
   * 任务页：左栏是全部任务组（按剧情顺序，主线支线混排），右栏先列出组内任务，
   * 选中任务后切成详情与开始按钮。真正的状态修改由 `GmActions` 完成，面板只收集点击。
   */
  private renderQuests(body: UiSurface): string {
    this.showQuestSearch(body);
    const groups = this.gm.questCatalog();
    if (this.references.assets) {
      body.border(this.references.assets, 14, 56, 536, 378);
      body.border(this.references.assets, 566, 56, 380, 378);
    }
    if (!groups.length) {
      this.text('任务目录为空。', 60, 84, 900, 20);
      return '';
    }
    const group = this.questGroupFor(groups);
    this.renderQuestGroupList(body, groups);
    const query = normalizeQuestQuery(this.questQuery);
    if (query) {
      this.renderQuestSearchResults(body, groups, query);
    } else {
      const entry = group.entries.find(value => value.quest.id === this.questId);
      if (this.questId && !entry) { this.questId = undefined; this.questPreview = undefined; }
      if (this.questId) {
        if (this.questPreview?.questId !== this.questId) this.questPreview = this.previewQuest(this.questId);
        this.renderQuestDetail(body, group, this.questId);
      } else this.renderQuestGroupEntries(body, group);
    }
    const total = groups.reduce((count, value) => count + value.entries.length, 0);
    return `共 ${groups.length} 个任务组 · ${total} 个任务；左栏按剧情顺序排列，点任务组查看组内任务。`;
  }

  /** 搜索框每次重画都重新贴到左栏上方；节点不重建，输入焦点保持。 */
  private showQuestSearch(body: UiSurface): void {
    const matrix = body.root.getWorldTransformMatrix();
    const origin = matrix.transformPoint(QUEST_SEARCH.x, QUEST_SEARCH.y);
    this.questSearch.show({
      left: origin.x, top: origin.y,
      width: QUEST_SEARCH.width * matrix.scaleX,
      height: QUEST_SEARCH.height * matrix.scaleY,
      fontSize: 16 * matrix.scaleY,
    }, { value: this.questQuery, placeholder: '搜索任务名或任务组' });
  }

  /** 输入变化只改查询和选择，右栏按新结果重画；不重建输入框，避免丢焦点。 */
  private onQuestQuery(value: string): void {
    if (value === this.questQuery) return;
    this.questQuery = value;
    this.questId = undefined; this.questPreview = undefined;
    this.questSearchList = undefined; this.questSearchOffset = 0;
    this.questEntryList = undefined; this.questEntryOffset = 0;
    this.questDetailScroll = undefined; this.questDetailOffset = 0;
    this.result = '';
    this.hooks.render();
  }

  /** Enter 打开当前查询的第一条结果；没有结果时什么也不做。 */
  private openFirstQuestSearchResult(): void {
    const results = collectQuestSearchResults(this.gm.questCatalog(), normalizeQuestQuery(this.questQuery));
    const first = results[0];
    if (first) this.selectQuestSearchResult(first);
  }

  /** Escape 只清空搜索并 blur，菜单保持打开。 */
  private clearQuestSearch(): void {
    const hadQuery = this.questQuery.length > 0;
    this.questSearch.blur();
    this.questSearch.setValue('');
    this.questQuery = '';
    if (!hadQuery) return;
    this.questSearchList = undefined; this.questSearchOffset = 0;
    this.questEntryList = undefined; this.questEntryOffset = 0;
    this.questDetailScroll = undefined; this.questDetailOffset = 0;
    this.result = '';
    this.hooks.render();
  }

  /** 点击或回车选中结果：打开普通任务详情，左栏滚到对应组，清空搜索。 */
  private selectQuestSearchResult(result: QuestSearchResult): void {
    const groups = this.gm.questCatalog();
    const groupIndex = groups.findIndex(group => group.definition.id === result.group.definition.id);
    this.questSearch.blur();
    this.questSearch.setValue('');
    this.questQuery = '';
    this.questGroupId = result.group.definition.id;
    this.questId = result.entry.quest.id;
    this.questPreview = this.previewQuest(result.entry.quest.id);
    this.questSearchList = undefined; this.questSearchOffset = 0;
    this.questEntryList = undefined; this.questEntryOffset = 0;
    this.questDetailScroll = undefined; this.questDetailOffset = 0;
    this.questListScrollTarget = Math.max(0, groupIndex * QUEST_ROW_HEIGHT - QUEST_ROW_HEIGHT);
    this.questListOffset = this.questListScrollTarget;
    this.result = '';
    this.hooks.render();
  }

  /** 右栏搜索层：跨全部任务组，按目录顺序列出命中任务，只建视口内的行。 */
  private renderQuestSearchResults(
    body: UiSurface, groups: readonly QuestCatalogGroup[], query: string,
  ): void {
    const results = collectQuestSearchResults(groups, query);
    const height = QUEST_ENTRIES_HEIGHT;
    const list = body.scroll(QUEST_RIGHT.x, QUEST_CONTENT_Y, QUEST_RIGHT.width, height);
    this.questSearchList = list;
    this.references.registerScroll?.('gm-quest-search', list);
    const clip = { top: QUEST_CONTENT_Y, bottom: QUEST_CONTENT_Y + height } as const;
    if (!results.length)
      this.textAt('gm-quest-search-empty', '没有匹配的任务', QUEST_RIGHT.x, QUEST_CONTENT_Y + 8,
        QUEST_RIGHT.width, 16, '#c8bda6', 'gm-quest-search', clip);
    const rowHeight = QUEST_ENTRY_HEIGHT;
    const cells = Array.from({ length: Math.ceil(height / rowHeight) + 1 }, (_, slot) => {
      const title = `gm-quest-search-${slot}-title`;
      const meta = `gm-quest-search-${slot}-meta`;
      let current: QuestSearchResult | undefined;
      const button = this.button(body, '', 0, slot * rowHeight, QUEST_RIGHT.width, rowHeight, () => {
        if (current) this.selectQuestSearchResult(current);
      }, {
        ...(this.references.questRow ? { image: this.references.questRow } : {}),
        ...(this.references.questRowPressed ? { pressed: this.references.questRowPressed } : {}),
        parent: list.content, guard: list.guard,
      });
      this.textAt(title, '', QUEST_RIGHT.x + 12, QUEST_CONTENT_Y + slot * rowHeight + 7,
        QUEST_RIGHT.width - 24, 16, GOLD, 'gm-quest-search', clip);
      this.textAt(meta, '', QUEST_RIGHT.x + 12, QUEST_CONTENT_Y + slot * rowHeight + 29,
        QUEST_RIGHT.width - 24, 12, '#c8bda6', 'gm-quest-search', clip);
      return {
        button,
        set: (value: QuestSearchResult | undefined, index: number): void => {
          current = value;
          button.setVisible(!!value);
          if (!value) {
            this.references.setText?.(title, ''); this.references.setText?.(meta, '');
            return;
          }
          const y = index * rowHeight;
          button.setPosition(0, y).setData('label', `搜索任务 ${readableStoryText(value.entry.quest.title)}`);
          const titleText = clipText(readableStoryText(value.entry.quest.title), 22);
          const kind = value.group.kind === 'main' ? '主线' : '支线';
          const metaText = `${kind} · ${clipText(readableStoryText(value.group.definition.title), 16)} · ${QUEST_STATUS_LABELS[value.entry.status]}`;
          if (this.references.moveText) {
            this.references.moveText(title, titleText, QUEST_CONTENT_Y + y + 7);
            this.references.moveText(meta, metaText, QUEST_CONTENT_Y + y + 29);
          } else {
            this.references.setText?.(title, titleText);
            this.references.setText?.(meta, metaText);
          }
        },
      };
    });
    list.setHeight(Math.max(height, results.length * rowHeight));
    list.scrollTop = this.questSearchOffset;
    let firstRow = -1;
    const updateRows = () => {
      const first = Math.floor(list.scrollTop / rowHeight);
      if (first === firstRow) return;
      firstRow = first;
      cells.forEach((cell, slot) => cell.set(results[first + slot], first + slot));
    };
    list.onScroll = () => {
      this.questSearchOffset = list.scrollTop;
      updateRows();
      this.references.refresh?.();
    };
    updateRows();
  }

  /** 首次打开任务页时定位到当前进度组。 */
  private questGroupFor(groups: readonly QuestCatalogGroup[]): QuestCatalogGroup {
    if (!this.questInitialized) {
      this.questInitialized = true;
      const current = groups.find(group => group.current);
      if (current) {
        this.questGroupId = current.definition.id;
        this.questId = undefined;
        this.questPreview = undefined;
        this.questEntryOffset = 0; this.questDetailOffset = 0;
        this.questListOffset = Math.max(0, groups.indexOf(current) * QUEST_ROW_HEIGHT - QUEST_ROW_HEIGHT);
      }
    }
    let selected = groups.find(group => group.definition.id === this.questGroupId);
    if (!selected) {
      selected = groups.find(group => group.current) ?? groups[0]!;
      this.questGroupId = selected.definition.id;
      this.questId = undefined; this.questPreview = undefined;
    }
    return selected;
  }

  /** 左栏：全部任务组按目录顺序排列，只创建视口内的行，滚动时复用。 */
  private renderQuestGroupList(body: UiSurface, groups: readonly QuestCatalogGroup[]): void {
    const list = body.scroll(QUEST_LEFT.x, QUEST_LEFT.y, QUEST_LEFT.width, QUEST_LEFT.height);
    this.questList = list;
    this.references.registerScroll?.('gm-quest-groups', list);
    const width = 500, height = QUEST_ROW_HEIGHT;
    const clip = { top: QUEST_LEFT.y, bottom: QUEST_LEFT.y + QUEST_LEFT.height } as const;
    const cells: {
      button: UiNode; main?: UiImage; ready?: UiImage;
      set(value: QuestCatalogGroup | undefined, index: number): void;
    }[] = Array.from({ length: Math.ceil(QUEST_LEFT.height / height) + 1 }, (_, slot) => {
      const title = `gm-quest-group-${slot}-title`;
      const summary = `gm-quest-group-${slot}-summary`;
      const tag = `gm-quest-group-${slot}-tag`;
      let current: QuestCatalogGroup | undefined;
      let faceFile: string | undefined;
      const button = this.button(body, '', 0, slot * height, width, height, () => {
        const item = current;
        if (!item) return;
        if (item.definition.id === this.questGroupId && !this.questId && !this.questQuery) return;
        // 点任务组回到组内列表：清空搜索，右侧不再保留上一个搜索结果。
        this.questQuery = ''; this.questSearch.setValue(''); this.questSearch.blur();
        this.questSearchList = undefined; this.questSearchOffset = 0;
        this.questEntryList = undefined;
        this.questDetailScroll = undefined; this.questDetailOffset = 0;
        this.questEntryOffset = 0;
        this.questGroupId = item.definition.id;
        this.questId = undefined; this.questPreview = undefined;
        this.result = '';
        this.hooks.render();
      }, {
        ...(this.references.questRow ? { image: this.references.questRow } : {}),
        ...(this.references.questRowPressed ? { pressed: this.references.questRowPressed } : {}),
        parent: list.content, guard: list.guard,
      });
      const main = this.references.questMain
        ? body.image(this.references.questMain, 5, 5, 63, 45, button) : undefined;
      const ready = this.references.questReady
        ? body.image(this.references.questReady, 441, 4, 54, 47, button) : undefined;
      this.textAt(title, '', QUEST_LEFT.x + 75, QUEST_LEFT.y + slot * height + 7, 360, 17, GOLD, 'gm-quest-groups', clip);
      this.textAt(summary, '', QUEST_LEFT.x + 75, QUEST_LEFT.y + slot * height + 31, 360, 13, '#c8bda6', 'gm-quest-groups', clip);
      this.textAt(tag, '', QUEST_LEFT.x + 12, QUEST_LEFT.y + slot * height + 20, 60, 14, '#d9b26b', 'gm-quest-groups', clip);
      return {
        button, main, ready,
        set: (value: QuestCatalogGroup | undefined, index: number): void => {
          current = value;
          button.setVisible(!!value);
          main?.setVisible(!!value && value.kind === 'main');
          ready?.setVisible(!!value?.ready);
          if (!value) {
            this.references.setText?.(title, ''); this.references.setText?.(summary, ''); this.references.setText?.(tag, '');
            return;
          }
          const y = index * height;
          button.setPosition(0, y).setData('label', `任务组 ${readableStoryText(value.definition.title)}`);
          const selected = value.definition.id === this.questGroupId;
          const face = button.getData('face') as UiImage | undefined;
          const file = selected ? this.references.questRowSelected ?? this.references.questRow : this.references.questRow;
          // 滚动复用行时只有选中状态真的换了才重新取图，避免每滚一行都释放/申请图片租约。
          if (face && file && faceFile !== file) { faceFile = file; face.load(file); }
          const titleText = clipText(readableStoryText(value.definition.title), 24);
          const summaryText = this.questGroupSummary(value);
          const tagText = value.kind === 'side' ? '支线' : '';
          if (this.references.moveText) {
            this.references.moveText(title, titleText, QUEST_LEFT.y + y + 7);
            this.references.moveText(summary, summaryText, QUEST_LEFT.y + y + 31);
            this.references.moveText(tag, tagText, QUEST_LEFT.y + y + 20);
          } else {
            this.references.setText?.(title, titleText);
            this.references.setText?.(summary, summaryText);
            this.references.setText?.(tag, tagText);
          }
        },
      };
    });
    list.setHeight(Math.max(0, groups.length * height - 8));
    list.scrollTop = this.questListOffset;
    let firstRow = -1;
    const updateRows = () => {
      const first = Math.floor(list.scrollTop / height);
      if (first === firstRow) return;
      firstRow = first;
      cells.forEach((cell, slot) => cell.set(groups[first + slot], first + slot));
    };
    list.onScroll = () => {
      this.questListOffset = list.scrollTop;
      updateRows();
      this.references.refresh?.();
    };
    updateRows();
  }

  private questGroupSummary(group: QuestCatalogGroup): string {
    const summary = group.summary;
    const state = group.ready ? '待交付'
      : summary.active > 0 ? '进行中'
      : summary.available > 0 ? '可接取'
      : summary.completed === summary.total ? '已完成'
      : '未解锁';
    return `${group.current ? '当前 · ' : ''}${summary.completed}/${summary.total} 完成 · ${state}`;
  }

  /** 右栏第一层：选中任务组的全部任务，按 `entries` 顺序（也就是内容里的 `questIds` 顺序）。 */
  private renderQuestGroupEntries(body: UiSurface, group: QuestCatalogGroup): void {
    const height = QUEST_ENTRIES_HEIGHT;
    const list = body.scroll(QUEST_RIGHT.x, QUEST_CONTENT_Y, QUEST_RIGHT.width, height);
    this.questEntryList = list;
    this.references.registerScroll?.('gm-quest-entries', list);
    const clip = { top: QUEST_CONTENT_Y, bottom: QUEST_CONTENT_Y + height } as const;
    const kind = group.kind === 'main' ? '主线' : '支线';
    const anchor = group.anchorMainGroupTitle ? ` · 解锁于 ${readableStoryText(group.anchorMainGroupTitle)}` : '';
    this.textAt('gm-quest-entries-title', clipText(readableStoryText(group.definition.title), 18),
      QUEST_RIGHT.x, QUEST_CONTENT_Y, 348, 17, GOLD, 'gm-quest-entries', clip);
    this.textAt('gm-quest-entries-meta', `${kind} · ${group.entries.length} 个任务${anchor}`,
      QUEST_RIGHT.x, QUEST_CONTENT_Y + 22, 348, 13, '#c8bda6', 'gm-quest-entries', clip);
    group.entries.forEach((entry, index) => {
      const y = 40 + index * QUEST_ENTRY_HEIGHT;
      this.button(body, '', 0, y, QUEST_RIGHT.width, QUEST_ENTRY_HEIGHT, () => {
        if (this.questId === entry.quest.id) return;
        this.questEntryOffset = list.scrollTop;
        this.questId = entry.quest.id;
        this.questPreview = this.previewQuest(entry.quest.id);
        this.questDetailOffset = 0;
        this.result = this.questPreview ? '' : `无法预览任务 ${entry.quest.title}`;
        this.hooks.render();
      }, {
        ...(this.references.questRow ? { image: this.references.questRow } : {}),
        ...(this.references.questRowPressed ? { pressed: this.references.questRowPressed } : {}),
        parent: list.content, guard: list.guard,
      }).setData('label', `任务 ${readableStoryText(entry.quest.title)}`);
      this.textAt(`gm-quest-entry-${index}-title`, clipText(readableStoryText(entry.quest.title), 22),
        QUEST_RIGHT.x + 12, QUEST_CONTENT_Y + y + 7, QUEST_RIGHT.width - 24, 16, GOLD, 'gm-quest-entries', clip);
      this.textAt(`gm-quest-entry-${index}-status`, this.questEntryStatus(entry),
        QUEST_RIGHT.x + 12, QUEST_CONTENT_Y + y + 29, QUEST_RIGHT.width - 24, 12, QUEST_STATUS_COLORS[entry.status], 'gm-quest-entries', clip);
    });
    if (!group.entries.length)
      this.text('这个任务组没有任务。', QUEST_RIGHT.x, QUEST_CONTENT_Y + 48, 340, 16, '#c8bda6');
    list.setHeight(Math.max(height, 40 + group.entries.length * QUEST_ENTRY_HEIGHT));
    list.scrollTop = this.questEntryOffset;
    list.onScroll = () => {
      this.questEntryOffset = list.scrollTop;
      this.references.refresh?.();
    };
  }

  private questEntryStatus(entry: QuestCatalogEntry): string {
    const parts = [QUEST_STATUS_LABELS[entry.status]];
    if (entry.hidden || entry.internal) parts.push('日志外任务');
    return parts.join(' · ');
  }

  /** 右栏第二层：任务详情、起点预览和开始/返回按钮。 */
  private renderQuestDetail(body: UiSurface, group: QuestCatalogGroup, questId: string): void {
    const stages = questJumpStages(questId);
    const height = QUEST_DETAIL_HEIGHT - stages.length * 32;
    const clip = { top: QUEST_CONTENT_Y, bottom: QUEST_CONTENT_Y + height };
    const scroll = body.scroll(QUEST_RIGHT.x, QUEST_CONTENT_Y, QUEST_RIGHT.width, height);
    this.questDetailScroll = scroll;
    this.references.registerScroll?.('gm-quest-detail', scroll);
    const entry = group.entries.find(value => value.quest.id === questId)!;
    const quest = entry.quest;
    const plan = this.questPreview?.questId === questId ? this.questPreview : undefined;
    let y = QUEST_CONTENT_Y, index = 0;
    const line = (text: string, size: number, color = GOLD, width = 0, gap = 3): void => {
      if (!text) return;
      this.textAt(`gm-quest-detail-${index++}`, text, QUEST_RIGHT.x, y, width, size,
        color, 'gm-quest-detail', clip);
      const chars = width > 0 ? Math.max(1, Math.floor(width / Math.max(1, size))) : 0;
      const lines = chars ? Math.max(1, Math.ceil(Array.from(text).length / chars)) : 1;
      y += lines * (size + 5) + gap;
    };
    const kind = group.kind === 'main' ? '主线' : '支线';
    line(clipText(readableStoryText(quest.title), 20), 19, GOLD, 0, 4);
    line(`${kind} · ${clipText(readableStoryText(group.definition.title), 16)} · ${QUEST_STATUS_LABELS[entry.status]}`,
      14, QUEST_STATUS_COLORS[entry.status], QUEST_RIGHT.width, 5);
    if (group.kind === 'side' && group.anchorMainGroupTitle)
      line(`解锁于：${clipText(readableStoryText(group.anchorMainGroupTitle), 20)}`, 13, '#c8bda6', QUEST_RIGHT.width, 4);
    if (entry.hidden || entry.internal) line('日志外任务', 12, '#c8bda6', QUEST_RIGHT.width, 4);
    if (plan?.fallback) line(plan.mode === 'ready'
      ? '没有可接取入口，会直接放到待交付状态。'
      : '没有可接取入口，只能从进行中开始。', 13, '#ffd8a0', 340, 4);
    if (!plan) line('无法预览任务起点。', 13, '#ffd8a0', 340, 4);
    line(readableStoryText(quest.description), 14, '#d8cdb8', 340, 6);
    const placement = this.campaign.placements.find(value => value.actor === quest.giver
      || (quest.giverCharacterId !== undefined && value.characterId === quest.giverCharacterId));
    const giver = placement?.name ?? quest.giver, map = this.questMap(quest, plan) ?? placement?.map;
    if (giver || map)
      line(`${giver ? `发布者：${giver}` : ''}${giver && map ? '    ' : ''}${map ? `地图：${map}` : ''}`,
        13, '#c8bda6', 340, 5);
    if (quest.goals.length) {
      line('目标进度', 14, GOLD, 0, 2);
      for (const goal of quest.goals) {
        const current = entry.progress.goals[goal.id] ?? 0;
        line(`· ${goal.label ?? goal.target} ${current}/${goal.quantity}`, 13, '#c8bda6', 330, 2);
      }
    }
    const changes = plan ? plan.changedQuests.filter(change => change.id !== questId) : [];
    line(`将补前置 ${changes.length} 个`, 14, GOLD, 0, 2);
    for (const change of changes.slice(0, 8))
      line(`· ${clipText(readableStoryText(change.title), 18)}（${QUEST_STATUS_LABELS[change.from]} → ${QUEST_STATUS_LABELS[change.to]}）`,
        13, '#c8bda6', 330, 2);
    if (changes.length > 8) line(`…另有 ${changes.length - 8} 个`, 13, '#c8bda6', 330, 4);
    if (plan?.accept) {
      line(plan.accept.eventId
        ? `接取剧情：${plan.accept.eventId}（脚本 ${plan.accept.script}）`
        : `接取剧情：${plan.accept.script}（无对应事件，直接播放）`, 13, '#c8bda6', 340, 4);
    } else {
      line(plan?.mode === 'available' ? '到达发布者后可接取任务。' : '从所选任务阶段继续。', 13, '#c8bda6', 340, 4);
    }
    if (plan?.destination)
      line(`传送：${plan.destination.map} (${plan.destination.x},${plan.destination.y})`, 13, '#c8bda6', 340, 4);
    const warnings = [...(plan?.warnings ?? [])];
    for (const gap of plan?.conditionPatch.unsatisfied ?? [])
      if (!warnings.some(warning => warning.includes(gap))) warnings.push(gap);
    for (const warning of warnings) line(`注意：${warning}`, 13, '#ffd8a0', 340, 2);
    line('开始前会先打开存档页，保存成功后自动跳转。', 12, '#c8bda6', 340, 2);
    scroll.setHeight(Math.max(height, y - QUEST_CONTENT_Y + 6));
    scroll.scrollTop = this.questDetailOffset;
    scroll.onScroll = () => {
      this.questDetailOffset = scroll.scrollTop;
      this.references.refresh?.();
    };

    stages.forEach((stage, index) => {
      this.button(body, stage.label, QUEST_RIGHT.x, clip.bottom + 4 + index * 32, QUEST_RIGHT.width, 28, () => {
        this.questPreview = this.previewQuest(questId, stage.mode);
        this.questDetailOffset = 0;
        this.hooks.render();
      }, { disabled: plan?.mode === stage.mode, fontSize: 15 });
    });
    const label = stages.length ? '跳到所选现场' : plan?.mode === 'ready' ? '跳到待交付'
      : plan?.mode === 'active' ? '跳到进行中' : '跳到可接取';
    this.button(body, label, QUEST_RIGHT.x, 358, QUEST_RIGHT.width, 30, () => {
      if (!plan) return;
      if (this.hooks.requestStoryJump) this.hooks.requestStoryJump(plan);
      else void this.gm.startStoryJump(plan);
    }, { disabled: !plan, fontSize: 16 });
    this.button(body, '返回任务组', QUEST_RIGHT.x, 392, QUEST_RIGHT.width, 28,
      () => this.backToQuestGroup(), { fontSize: 15 });
  }

  /** 显示地图时优先用预览落点；没有预览就看任务的可接取地点和发布者摆放。 */
  private questMap(quest: CampaignQuest, plan?: QuestStartPlan): string | undefined {
    if (plan?.destination) return plan.destination.map;
    const place = quest.places?.available;
    if (place?.type === 'fixed') return place.map;
    if (place?.type === 'alternatives') return place.spots[0]?.map;
    return this.campaign.placements.find(placement => placement.actor === quest.giver)?.map;
  }

  private previewQuest(questId: string, mode: QuestStartMode = 'available'): QuestStartPlan | undefined {
    try {
      let result = this.gm.previewQuestDebug(questId, mode);
      if (result.plan?.mode === 'available' && result.plan.conditionPatch.unsatisfied.length) {
        const fallback = result.plan.quest.completion === 'talk' ? 'ready' : 'active';
        result = this.gm.previewQuestDebug(questId, fallback);
      }
      return result.ok ? result.plan : undefined;
    } catch { return undefined; }
  }

  private backToQuestGroup(): void {
    this.questId = undefined; this.questPreview = undefined;
    this.questDetailOffset = 0; this.result = '';
    this.hooks.render();
  }

  private perform<T>(action:()=>T):T{return this.hooks.runAction?this.hooks.runAction(action):action();}
  private refreshCharacter():void{
    const controls=this.characterControls,setText=this.references.setText;
    if(!controls||!setText){this.hooks.render();return;}
    const characters=this.gm.characters(),selected=characters.find(character=>character.id===this.characterId);
    if(!selected||characters.length!==controls.members.size){this.hooks.render();return;}
    for(const character of characters){const control=controls.members.get(character.id);if(!control){this.hooks.render();return;}
      setText(control.key,`${character.name} Lv.${character.level}`);control.button.getData('setSelected')?.(character.id===this.characterId);}
    const values=[`等级 Lv.${selected.level}`,selected.nextLevelExperience>0?`经验 ${selected.experience} / ${selected.nextLevelExperience}`:'经验 —（已满级）',
      `HP ${selected.health} / ${selected.maxHealth}`,`MP ${selected.mana} / ${selected.maxMana}`,
      `无敌 ${selected.invincible?'开':'关'} · 无限蓝 ${selected.infiniteMana?'开':'关'} · 一击必杀 ${selected.oneHitKill?'开':'关'} · 技能 ${selected.noCooldown?'无 CD':'正常冷却'}`];
    values.forEach((value,index)=>setText(controls.values[index],value));
    controls.level.getData('setEnabled')?.(selected.alive&&selected.nextLevelExperience>0);controls.mana.getData('setEnabled')?.(selected.alive);
    for(const [key,label] of [['invincible','无敌'],['infiniteMana','无限蓝'],['noCooldown','技能无 CD'],['oneHitKill','一击必杀']] as const){
      const control=controls.toggles[key],enabled=selected[key];control.button.getData('setSelected')?.(enabled);setText(control.key,`${label}：${enabled?'开':'关'}`);
    }
    const tenEnabled=this.gm.isTenSkillPointsPerLevel();
    controls.tenSkillPoints.button.getData('setSelected')?.(tenEnabled);
    setText(controls.tenSkillPoints.key,`升级10技能点：${tenEnabled?'开':'关'}`);
    if(this.resultTextKey)setText(this.resultTextKey,this.result||'无敌只挡战斗伤害，不挡剧情改血；无限蓝让技能不耗 MP 且免疫吸蓝；开启「升级10技能点」后每次升级获得 10 个技能点。');
  }

  private renderItems(body: UiSurface): string {
    let entries = this.gm.items(this.itemFilter);
    const grid = body.scroll(ITEM_GRID_X, ITEM_GRID_Y, ITEM_COLUMNS * ITEM_STRIDE, ITEM_ROWS * ITEM_STRIDE);
    let selectedId=this.itemSelected;
    let refreshSelection=()=>{};
    const slots = Array.from({length:Math.min(this.gm.items('all').length,ITEM_COLUMNS*(ITEM_ROWS+1))},()=>{
      let entry:GmItemEntry|undefined;
      const button = this.button(body, '', 0, 0, ITEM_SLOT, ITEM_SLOT,
        () => {
          if(!entry)return;this.itemSelected=entry.id;this.itemDetail=entry.id;this.itemQuantity=1;this.result='';
          if(!this.references.updateItemDetail||!this.references.setText){this.hooks.render();return;}
          refreshSelection();if(this.resultTextKey)this.references.setText(this.resultTextKey,`共 ${entries.length} 件；不含地面拾取物品。`);
          this.references.updateItemDetail(entry.id,()=>{this.itemDetail=undefined;this.references.updateItemDetail?.(undefined,()=>{});});
        },
        { ...(this.references.itemSlot ? { image: this.references.itemSlot } : {}), parent: grid.content, guard: grid.guard });
      const icon=body.image('',4,4,ITEM_SLOT-8,ITEM_SLOT-8,button);
      const selected=this.references.itemSelected?body.image(this.references.itemSelected,-5,-5,ITEM_SLOT+10,ITEM_SLOT+10,button):undefined;
      return {button,icon,selected,set(value:GmItemEntry|undefined,index:number){
        button.setVisible(!!value);if(!value){entry=undefined;return;}
        button.setPosition((index%ITEM_COLUMNS)*ITEM_STRIDE,Math.floor(index/ITEM_COLUMNS)*ITEM_STRIDE);
        if(entry?.icon!==value.icon)icon.load(value.icon);
        entry=value;button.setData('label',`道具 ${value.id}`);
        selected?.setVisible(value.id===selectedId);
      }};
    });
    // 滚动范围按实际行数给；每次重画后恢复上次的位置。
    grid.setHeight(Math.ceil(entries.length / ITEM_COLUMNS) * ITEM_STRIDE);
    grid.scrollTop = this.itemScroll;
    let firstSlot=-1;
    const updateSlots=()=>{
      const first=Math.floor(grid.scrollTop/ITEM_STRIDE)*ITEM_COLUMNS;
      if(first===firstSlot)return;firstSlot=first;
      slots.forEach((slot,index)=>slot.set(entries[first+index],first+index));
    };
    grid.onScroll = () => { this.itemScroll = grid.scrollTop;updateSlots(); };
    updateSlots();

    const selected = entries.find(entry => entry.id === this.itemSelected);
    const nameKey=`gm-text-${this.textSerial}`;this.text(selected?clipText(selected.name,10):'选一件物品',786,92,150,15);
    const categoryKey=`gm-text-${this.textSerial}`;this.text(selected?`${INVENTORY_LABELS[selected.category]} · Lv.${selected.level}`:'',786,136,150,14);
    const ownedKey=`gm-text-${this.textSerial}`;this.text(selected?`持有 ${selected.owned}`:'',786,160,150,14);
    this.itemQuantityTextKey=`gm-text-${this.textSerial}`;
    this.text(`数量 ${this.itemQuantity}`, 786, 184, 150, 16);
    // 按钮上的字要短到能放进 66×34；完整含义留在 label 上，键盘与测试仍按它查找。
    this.button(body, '-10', 786, 210, 66, 34, () => this.stepQuantity(-10)).setData('label', '数量 -10');
    this.button(body, '+10', 866, 210, 66, 34, () => this.stepQuantity(10)).setData('label', '数量 +10');
    this.button(body, '-1', 786, 246, 66, 34, () => this.stepQuantity(-1)).setData('label', '数量 -1');
    this.button(body, '+1', 866, 246, 66, 34, () => this.stepQuantity(1)).setData('label', '数量 +1');
    this.button(body, '+100', 786, 282, 66, 34, () => this.stepQuantity(100)).setData('label', '数量 +100');
    this.button(body, '归 1', 866, 282, 66, 34,
      () => this.setQuantity(1)).setData('label', '数量归 1');
    const give=this.button(body, '加入背包', 786, 324, 150, 44, () => this.onGiveItem(entries.find(entry=>entry.id===this.itemSelected)),
      { disabled: !selected }).setData('label', '加入背包');
    refreshSelection=()=>{
      selectedId=this.itemSelected;firstSlot=-1;updateSlots();
      const current=entries.find(entry=>entry.id===selectedId);
      this.references.setText?.(nameKey,current?clipText(current.name,10):'选一件物品');
      this.references.setText?.(categoryKey,current?`${INVENTORY_LABELS[current.category]} · Lv.${current.level}`:'');
      this.references.setText?.(ownedKey,current?`持有 ${current.owned}`:'');
      this.references.setText?.(this.itemQuantityTextKey!,`数量 ${this.itemQuantity}`);
      (give.getData('setEnabled') as (enabled:boolean)=>void)(!!current);
    };
    const moneyKey=`gm-text-${this.textSerial}`;this.text(`金币 ${this.gm.money()}`, 60, 412, 200, 16);
    this.refreshItemPage=()=>{
      if(!this.references.setText){this.hooks.render();return;}
      entries=this.gm.items(this.itemFilter);refreshSelection();
      this.references.setText(moneyKey,`金币 ${this.gm.money()}`);
      if(this.resultTextKey)this.references.setText(this.resultTextKey,this.result);
    };
    const moneyBands: readonly (readonly [string, number])[] = [['+1万', 10_000], ['+10万', 100_000], ['+100万', 1_000_000]];
    moneyBands.forEach(([label, amount], index) =>
      this.button(body, label, 280 + index * 100, 404, index === 2 ? 100 : 90, 40,
        () => this.onGainMoney(amount)).setData('label', `金币 ${label}`));
    this.text('滚轮或拖动列表查看更多', 610, 412, 340, 16);
    const filterButtons=new Map<GmItemFilter,UiNode>();
    ITEM_FILTERS.forEach((filter, index) => {
      const button=this.button(body, INVENTORY_LABELS[filter], 60 + index * 110, 56, 104, 32,
        () => {
          if(this.itemFilter===filter)return;
          this.itemFilter=filter;this.itemScroll=0;this.itemSelected=undefined;this.itemDetail=undefined;this.result='';
          if(!this.references.updateItemDetail||!this.references.setText){this.hooks.render();return;}
          entries=this.gm.items(filter);grid.setHeight(Math.ceil(entries.length/ITEM_COLUMNS)*ITEM_STRIDE);grid.scrollTop=0;
          for(const [key,control] of filterButtons)(control.getData('setSelected') as (value:boolean)=>void)(key===filter);
          refreshSelection();if(this.resultTextKey)this.references.setText(this.resultTextKey,`共 ${entries.length} 件；不含地面拾取物品。`);
          this.references.updateItemDetail(undefined,()=>{});
        },
        { selected: this.itemFilter === filter }).setData('label', `过滤 ${INVENTORY_LABELS[filter]}`);
      filterButtons.set(filter,button);
    });
    // 详情画在装配方提供的说明层上（与背包详情同一套面板）；关闭后重画本页。
    if (this.itemDetail && this.references.itemDetail)
      this.references.itemDetail(this.itemDetail, () => { this.itemDetail = undefined; if(this.references.updateItemDetail)this.references.updateItemDetail(undefined,()=>{});else this.hooks.render(); });
    return `共 ${entries.length} 件；不含地面拾取物品。`;
  }

  private stepQuantity(delta: number): void {
    this.setQuantity(this.itemQuantity+delta);
  }

  private setQuantity(value:number):void {
    this.itemQuantity=Math.max(1,Math.min(ITEM_MAX,value));
    if(this.itemQuantityTextKey&&this.references.setText)
      this.references.setText(this.itemQuantityTextKey,`数量 ${this.itemQuantity}`);
    else this.hooks.render();
  }

  private onLevelUp(): void {
    const result = this.perform(()=>this.gm.levelUp(this.characterId));
    this.result = result.ok ? `已升到 Lv.${result.level}` : `升级失败：${result.reason}`;
    this.refreshCharacter();
  }
  private onMaxSkills(): void {
    const result = this.perform(()=>this.gm.maxSkills(this.characterId));
    this.result = result.ok
      ? (result.learned || result.maxed
        ? `技能已全满：新学 ${result.learned ?? 0} 门，升级 ${result.maxed ?? 0} 门`
        : '技能已经全满')
      : `技能全满失败：${result.reason}`;
    this.refreshCharacter();
  }
  private onRestoreHealth(): void {
    const result = this.perform(()=>this.gm.restoreHealth(this.characterId));
    this.result = result.ok ? 'HP 已回满' : `回血失败：${result.reason}`;
    this.refreshCharacter();
  }
  private onRestoreMana(): void {
    const result = this.perform(()=>this.gm.restoreMana(this.characterId));
    this.result = result.ok ? 'MP 已回满' : `回蓝失败：${result.reason}`;
    this.refreshCharacter();
  }
  private onRecoverParty(): void {
    const result = this.perform(()=>this.gm.recoverParty());
    this.result = result.ok ? `全队回满${result.reason ? `（${result.reason}）` : ''}` : `全队回满失败：${result.reason}`;
    this.refreshCharacter();
  }
  private onToggleInvincible(character: GmCharacterState): void {
    const result = this.perform(()=>this.gm.setInvincible(character.id, !character.invincible));
    this.result = result.ok ? `无敌：${!character.invincible ? '开' : '关'}` : `切换失败：${result.reason}`;
    this.refreshCharacter();
  }
  private onToggleInfiniteMana(character: GmCharacterState): void {
    const result = this.perform(()=>this.gm.setInfiniteMana(character.id, !character.infiniteMana));
    this.result = result.ok ? `无限蓝：${!character.infiniteMana ? '开' : '关'}` : `切换失败：${result.reason}`;
    this.refreshCharacter();
  }
  private onToggleOneHitKill(character: GmCharacterState): void {
    const result = this.perform(()=>this.gm.setOneHitKill(character.id, !character.oneHitKill));
    this.result = result.ok ? `一击必杀：${!character.oneHitKill ? '开' : '关'}` : `切换失败：${result.reason}`;
    this.refreshCharacter();
  }
  private onToggleNoCooldown(character: GmCharacterState): void {
    const result = this.perform(()=>this.gm.setNoCooldown(character.id, !character.noCooldown));
    this.result = result.ok ? `技能无 CD：${!character.noCooldown ? '开' : '关'}` : `切换失败：${result.reason}`;
    this.refreshCharacter();
  }
  private onToggleTenSkillPoints(): void {
    const next = !this.gm.isTenSkillPointsPerLevel();
    const result = this.perform(()=>this.gm.setTenSkillPointsPerLevel(next));
    this.result = result.ok ? (next ? '升级技能点已改为每级 10 个' : '升级技能点已恢复默认（每级 1 个）') : `切换失败：${result.reason}`;
    this.refreshCharacter();
  }
  private onGiveItem(entry: GmItemEntry | undefined): void {
    if (!entry) return;
    const result = this.perform(()=>this.gm.giveItem(entry.id, this.itemQuantity));
    this.result = result.ok
      ? `已加入 ${result.name} ×${result.requested}（持有 ${result.total}）`
      : `发放失败：${result.reason}`;
    if(this.refreshItemPage)this.refreshItemPage();else this.hooks.render();
  }
  private onGainMoney(amount: number): void {
    const result = this.perform(()=>this.gm.gainMoney(amount));
    this.result = result.ok ? `金币 +${amount}，现有 ${result.money}` : `加金币失败：${result.reason}`;
    if(this.refreshItemPage)this.refreshItemPage();else this.hooks.render();
  }

  private async onReport(): Promise<void> {
    const serial=++this.reportSerial,result = await this.gm.report();
    if(serial!==this.reportSerial||this.references.active&&(!this.references.active()||this.page!=='status'))return;
    this.result = result.ok ? '已上报：服务器 .diagnostics/client-errors.jsonl 里能查到。' : `上报失败：${result.reason}`;
    if(this.refreshStatusPage)this.refreshStatusPage();else this.hooks.render();
  }
  private onCompleteCurrentQuest(): void {
    const result = this.perform(()=>this.gm.completeCurrentQuest());
    this.result = result.reason ?? (result.ok ? '任务已完成' : '完成任务失败');
    if(result.ok){ this.hooks.close(); return; }
    if(this.refreshStatusPage)this.refreshStatusPage();else this.hooks.render();
  }
  private onToggleNoclip(): void {
    const next = !this.gm.isNoclip();
    this.perform(()=>this.gm.setNoclip(next));
    this.result = next ? '穿墙模式已开启' : '穿墙模式已关闭';
    if(this.refreshStatusPage)this.refreshStatusPage();else this.hooks.render();
  }
  private onToggleDoubleSpeed(): void {
    const next = !this.gm.isDoubleSpeed();
    this.perform(()=>this.gm.setDoubleSpeed(next));
    this.result = next ? '已开启 2 倍速度' : '已恢复正常速度';
    if(this.refreshStatusPage)this.refreshStatusPage();else this.hooks.render();
  }
  private onRescue(): void {
    const result = this.perform(()=>this.gm.rescue());
    const place = (value: unknown) => {
      const point = value as { x?: number; y?: number } | undefined;
      return point && typeof point.x === 'number' ? `(${point.x},${point.y})` : '未知位置';
    };
    this.result = !result.ok ? `脱困失败：${result.reason}`
      : result.moved ? `已从 ${place(result.from)} 搬到 ${place(result.to)}`
      : '当前位置整个碰撞盒站得住，不需要脱困';
    if(this.refreshStatusPage)this.refreshStatusPage();else this.hooks.render();
  }
}

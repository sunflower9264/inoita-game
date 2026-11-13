import type { WorldIndex } from '../../domain/content.ts';
import type { MenuPanels } from '../../domain/menu-panels.ts';
import { questJournal, questJournalText } from '../../domain/quest-journal.ts';
import type { Session } from '../../domain/session.ts';
import { QUEST_TEXT_COLORS, measureQuestText } from './quest-text.ts';
import { TEXT_COLORS } from '../text-style.ts';
import { UiSurface, type ScrollArea } from './widgets.ts';
import type { MenuTextSpec, MenuTextWriter } from '../dom/menu-text.ts';
import type { UiImage, UiNode } from '../dom/node.ts';

/** 面板借宿主的滚动区登记文字位置；未注入时退回本画布自己的滚动区。 */
type ScrollFactory = (view:UiSurface,name:string,x:number,y:number,width:number,height:number)=>ScrollArea;

/** 任务组列表与同组进展；只负责阅读，不改变会话中的任务状态。 */
export class QuestPanel {
  private selectedGroup?: string;
  private detailVisible = false;
  private list?: ScrollArea;
  private detail?: ScrollArea;
  private view?: UiSurface;
  private rows = new Map<string,UiNode>();
  private listOffset = 0;
  private detailOffset = 0;
  private readonly session: Session;
  private readonly world: WorldIndex;
  private readonly panels: MenuPanels;
  private readonly changed: () => void;
  private readonly scrollArea: ScrollFactory;
  private readonly refreshText: () => void;
  private readonly rerenderText: () => void;
  /** 这一页要显示的文字；图框、按钮和滚动仍由 Phaser 画。 */
  private textSpecs: MenuTextSpec[] = [];
  /** 面板开着时每次 `emit` 都会重画，但任务只在版本变化时才变；按版本记住上一次的分组结果。 */
  private groups?: { questVersion: number; focus?: string; value: ReturnType<typeof questJournal> };

  constructor(session: Session, world: WorldIndex, panels: MenuPanels, changed: () => void,
    scrollArea?: ScrollFactory, refreshText: () => void = () => {}, rerenderText: () => void = () => {}) {
    this.session = session; this.world = world; this.panels = panels; this.changed = changed;
    this.scrollArea = scrollArea ?? ((view, _name, x, y, width, height) => view.scroll(x, y, width, height));
    this.refreshText = refreshText;
    this.rerenderText = rerenderText;
  }

  reset(): void {
    this.selectedGroup = undefined; this.detailVisible = false;
    this.list = undefined; this.detail = undefined; this.listOffset = 0; this.detailOffset = 0;
    this.textSpecs = []; this.view=undefined; this.rows.clear();
  }

  captureScroll(): void {
    if (this.list) this.listOffset = this.list.scrollTop;
    if (this.detail) this.detailOffset = this.detail.scrollTop;
  }

  private select(id: string): void {
    this.captureScroll();
    const previous=this.selectedGroup;
    this.selectedGroup = id; this.detailVisible = true; this.detailOffset = 0;
    for(const key of [previous,id]){
      if(!key)continue;
      const face=this.rows.get(key)?.getData('face') as UiImage|undefined;
      face?.load(this.panels.assets[key===id?'quest-row-selected':'quest-row']);
    }
    const group=this.groups?.value.find(group=>group.definition.id===id);
    if(!group||!this.view){this.changed();return;}
    this.renderDetail(this.view,group);
    this.rerenderText();
  }

  /** 页面文字交给菜单 DOM 层；滚动由宿主 `refresh` 跟随。 */
  renderText(writer: MenuTextWriter): void {
    for (const spec of this.textSpecs) writer.add(spec);
  }

  /** 列表滚动只收起详情；已经写出的详情文字要同时撤掉，不能浮在收起后的列表上。 */
  private hideDetail(): void {
    if (!this.detailVisible) return;
    this.detailVisible = false;
    this.detail?.cancelGesture();
    if (this.detail) this.detail.visible = false;
    if (!this.textSpecs.some(spec => spec.key.startsWith('quest-detail-'))) return;
    this.textSpecs = this.textSpecs.filter(spec => !spec.key.startsWith('quest-detail-'));
    this.rerenderText();
  }

  render(view: UiSurface): void {
    this.textSpecs = []; this.view=view; this.rows.clear();
    const questVersion = this.session.questBook.version, focus = this.session.debugFocusQuest, cached = this.groups;
    const groups = cached?.questVersion === questVersion && cached.focus === focus ? cached.value
      : (this.groups = { questVersion, focus, value: questJournal(this.session.campaign, this.session.quests, focus) }).value;
    const assets = this.panels.assets;
    // 打开任务页时默认选中第一个任务组并展示详情；滚动列表只暂时收起详情，不改变选中项。
    if (!groups.some(group => group.definition.id === this.selectedGroup)) {
      const first = groups[0];
      this.selectedGroup = first?.definition.id;
      this.detailVisible = !!first;
      this.detailOffset = 0;
    }
    this.detail = undefined;
    // 原版任务页两栏都只调 `UI_DrawBorderRect`（`UIQuestMenu_Draw @0x15fd84`，无任何填充），
    // 面板里露出的是黑色 65% 遮罩下的世界画面。
    view.border(assets, 14, 0, 556, 431);
    view.border(assets, 572, 0, 374, 431);
    const list = this.list = this.scrollArea(view, 'quest-list', 35, 27, 514, 376);
    list.onScroll = () => { this.hideDetail(); this.refreshText(); };
    groups.forEach((group, index) => {
      const main = group.definition.kind === 'main', selected = group.definition.id === this.selectedGroup;
      const row = view.button('', 0, index * 64, 514, 56, () => this.select(group.definition.id), {
        image: assets[selected ? 'quest-row-selected' : 'quest-row'], pressed: assets['quest-row-pressed'],
        parent: list.content, guard: list.guard,
      }).setData('label', group.definition.title);
      this.rows.set(group.definition.id,row);
      if (main) view.image(assets['quest-main'], 5, 5, 63, 45, row);
      this.textSpecs.push({key: `quest-row-${group.definition.id}`, text: group.definition.title,
        x: 35 + (main ? 70 : 10), y: 27 + index * 64 + 13, scroll: 'quest-list', clip: {top: 27, bottom: 403},
        style: {size: 24, color: TEXT_COLORS.primary, width: main ? 381 : 441, wrap: 'word'}});
      if (group.ready) view.image(assets['quest-ready'], 459, 4, 54, 47, row);
    });
    list.setHeight(Math.max(0, groups.length * 64 - 8));
    list.scrollTop = this.listOffset;

    const selected = groups.find(group => group.definition.id === this.selectedGroup);
    if (!selected || !this.detailVisible) return;
    this.renderDetail(view,selected);
  }

  private renderDetail(view:UiSurface,selected:ReturnType<typeof questJournal>[number]):void {
    this.textSpecs=this.textSpecs.filter(spec=>!spec.key.startsWith('quest-detail-'));
    const detail=this.detail??(this.detail=this.scrollArea(view,'quest-detail',594,20,330,390));
    detail.visible=true;
    detail.onScroll = () => this.refreshText();
    const text = questJournalText(selected, id => this.world.actors[id].name);
    const layout = measureQuestText(view, text, 330, 20);
    layout.lines.forEach((line, lineIndex) => {
      line.runs.forEach((run, runIndex) => {
        this.textSpecs.push({key: `quest-detail-${lineIndex}-${runIndex}`, text: run.text,
          x: 594 + run.x, y: 20 + lineIndex * layout.lineHeight, scroll: 'quest-detail',
          clip: {top: 20, bottom: 410}, style: {size: 20, color: QUEST_TEXT_COLORS[run.tone]}});
      });
    });
    detail.setHeight(layout.height);
    detail.scrollTop = this.detailOffset;
  }
}

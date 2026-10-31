import type { WorldIndex } from '../../domain/content.ts';
import type { MenuPanels } from '../../domain/menu-panels.ts';
import { questJournal, questJournalText } from '../../domain/quest-journal.ts';
import type { Session } from '../../domain/session.ts';
import { drawQuestText, measureQuestText } from './quest-text.ts';
import { TEXT_COLORS } from '../text-style.ts';
import { type ScrollArea, UiSurface } from './widgets.ts';

/** 任务组列表与同组进展；只负责阅读，不改变会话中的任务状态。 */
export class QuestPanel {
  private selectedGroup?: string;
  private detailVisible = false;
  private list?: ScrollArea;
  private detail?: ScrollArea;
  private listOffset = 0;
  private detailOffset = 0;
  private readonly session: Session;
  private readonly world: WorldIndex;
  private readonly panels: MenuPanels;
  private readonly changed: () => void;
  /** 面板开着时每次 `emit` 都会重画，但任务只在版本变化时才变；按版本记住上一次的分组结果。 */
  private groups?: { questVersion: number; focus?: string; value: ReturnType<typeof questJournal> };

  constructor(session: Session, world: WorldIndex, panels: MenuPanels, changed: () => void) {
    this.session = session; this.world = world; this.panels = panels; this.changed = changed;
  }

  reset(): void {
    this.selectedGroup = undefined; this.detailVisible = false;
    this.list = undefined; this.detail = undefined; this.listOffset = 0; this.detailOffset = 0;
  }

  captureScroll(): void {
    if (this.list) this.listOffset = this.list.scrollTop;
    if (this.detail) this.detailOffset = this.detail.scrollTop;
  }

  private select(id: string): void {
    this.captureScroll();
    this.selectedGroup = id; this.detailVisible = true; this.detailOffset = 0; this.detail = undefined;
    this.changed();
  }

  render(view: UiSurface): void {
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
    const list = this.list = view.scroll(35, 27, 514, 376);
    list.onScroll = () => {
      this.detailVisible = false;
      this.detail?.cancelGesture();
      if (this.detail) this.detail.visible = false;
    };
    groups.forEach((group, index) => {
      const main = group.definition.kind === 'main', selected = group.definition.id === this.selectedGroup;
      const row = view.button('', 0, index * 64, 514, 56, () => this.select(group.definition.id), {
        image: assets[selected ? 'quest-row-selected' : 'quest-row'], pressed: assets['quest-row-pressed'],
        parent: list.content, guard: list.guard,
      }).setData('label', group.definition.title);
      if (main) view.image(assets['quest-main'], 5, 5, 63, 45, row);
      view.text(group.definition.title, main ? 70 : 10, 13, group.ready ? (main ? 381 : 441) : (main ? 434 : 494), 24, TEXT_COLORS.primary, row);
      if (group.ready) view.image(assets['quest-ready'], 459, 4, 54, 47, row);
    });
    list.setHeight(Math.max(0, groups.length * 64 - 8));
    list.scrollTop = this.listOffset;

    const selected = groups.find(group => group.definition.id === this.selectedGroup);
    if (!selected || !this.detailVisible) return;
    const detail = this.detail = view.scroll(594, 20, 330, 390);
    const text = questJournalText(selected, id => this.world.actors[id].name);
    const layout = measureQuestText(view, text, 330, 20);
    drawQuestText(view, layout, 0, 0, 330, 20, detail.content);
    detail.setHeight(layout.height);
    detail.scrollTop = this.detailOffset;
  }
}

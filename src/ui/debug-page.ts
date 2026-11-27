import type { StoryUIContext } from '../application/ports.ts';
import type { GmActions } from '../debug/gm-actions.ts';
import type { QuestStartPlan } from '../debug/quest-jump.ts';
import type { ItemInstance } from '../domain/items.ts';
import type { Session } from '../domain/session.ts';
import { BAG_DESCRIPTION_WIDTH, descriptionPanel } from './bag-layout.ts';
import type { MenuTextLayer, MenuTextSpec, MenuTextWriter } from './dom/menu-text.ts';
import { itemDescriptionBody } from './item-detail-lines.ts';
import {
  descriptionTitleOverflow,
  drawDescriptionClose,
  drawDescriptionPanel,
  drawDescriptionRows,
  drawDescriptionTitle,
} from './panels/description-panel.ts';
import { GmPanel } from './panels/gm-panel.ts';
import type { StoryMenuPage } from './story-ui-signature.ts';
import type { ScrollArea, UiSurface } from './widgets.ts';

type DescriptionMember = Parameters<typeof itemDescriptionBody>[0]['member'];

export interface DebugPageHost {
  readonly app: Pick<StoryUIContext, 'gm' | 'menuPanels' | 'characterStats' | 'shops'>;
  readonly open: boolean;
  readonly page: StoryMenuPage;
  readonly body: UiSurface | undefined;
  readonly description: UiSurface | undefined;
  readonly menuText: MenuTextLayer | undefined;
  readonly scrollOffsets: Map<string, number>;
  session(): Session | undefined;
  member(): DescriptionMember;
  classNames(): Record<string, string>;
  scroll(name: string, x: number, y: number, w: number, h: number, surface?: UiSurface): ScrollArea;
  finishScroll(name: string, scroll: ScrollArea, height: number): void;
  registerScroll(name: string, scroll: ScrollArea): void;
  removeScroll(scroll: ScrollArea): void;
  removeDescriptionScrolls(): void;
  close(): void;
  requestStoryJump(plan: QuestStartPlan): void;
  runAction<T>(action: () => T): T;
  commitSession(): void;
  sync(): void;
}

/** 菜单内的 GM 调试页控制器，托管 GM 面板缓存、调试文字与物品详情预览层。 */
export class DebugPage {
  private readonly host: DebugPageHost;
  /** GM 面板按当前的动作层实例缓存；换会话（动作层重建）时一起换掉。 */
  private gmPanel?: GmPanel;
  private gmPanelOwner?: GmActions;
  /** GM 调试页这一轮绘制收集到的文字。 */
  private gmTextSpecs: MenuTextSpec[] = [];
  private gmDetailTextSpecs: MenuTextSpec[] = [];
  private gmDetailOpen = false;

  constructor(host: DebugPageHost) {
    this.host = host;
  }

  get searchFocused(): boolean {
    return !!this.gmPanel?.searchFocused;
  }

  layout(body: UiSurface): void {
    this.gmPanel?.layoutSearch(body);
  }

  /** 将调试页与详情弹层收集到的 DOM 文字写入菜单文字层。 */
  renderText(writer: MenuTextWriter): void {
    // 物品详情只盖住左侧一块：矩形外的调试页文字继续显示。
    for (const spec of this.gmTextSpecs) {
      if (!this.gmDetailOpen || !this.descriptionCovers(spec)) writer.add(spec);
    }
    if (this.gmDetailOpen) {
      for (const spec of this.gmDetailTextSpecs) writer.add(spec);
    }
  }

  render(body: UiSurface): void {
    const gm = this.host.app.gm;
    const session = this.host.session();
    if (!gm || !session) return;
    // 面板按当前动作层实例缓存：同一会话里保留过滤与选中，换会话就重建。
    if (this.gmPanelOwner !== gm) {
      const assets = this.host.app.menuPanels.assets;
      this.gmPanel = new GmPanel(
        gm,
        session.campaign,
        {
          close: () => this.host.close(),
          render: () => {
            if (this.host.app.gm === gm && this.gmPanelOwner === gm) this.update();
          },
          runAction: action => this.host.runAction(action),
          requestStoryJump: plan => this.host.requestStoryJump(plan),
        },
        {
          itemSlot: assets['inventory-slot'],
          itemSelected: assets['inventory-selected'],
          assets,
          questRow: assets['quest-row'],
          questRowSelected: assets['quest-row-selected'],
          questRowPressed: assets['quest-row-pressed'],
          questReady: assets['quest-ready'],
          questMain: assets['quest-main'],
          moveText: (key, text, y) => {
            const spec = this.gmTextSpecs.find(value => value.key === key);
            if (spec) {
              spec.text = text;
              spec.y = y;
            }
            this.host.menuText?.setText('debug', key, text);
            this.host.menuText?.refresh();
          },
          itemDetail: (itemId, close) => this.renderItemDetail(itemId, close),
          updateItemDetail: (itemId, close) => {
            if (!this.host.open || this.host.page !== 'debug' || this.gmPanelOwner !== gm) return;
            this.host.description?.clear();
            this.host.removeDescriptionScrolls();
            this.gmDetailTextSpecs = [];
            this.gmDetailOpen = false;
            if (itemId) this.renderItemDetail(itemId, close);
            this.host.menuText?.renderPage('debug');
            this.host.sync();
          },
          registerScroll: (name, scroll) => this.host.registerScroll(name, scroll),
          removeScroll: scroll => this.host.removeScroll(scroll),
          active: () => this.host.open && this.host.page === 'debug' && this.gmPanelOwner === gm,
          refresh: () => this.host.menuText?.refresh(),
          setText: (key, text) => {
            const spec = this.gmTextSpecs.find(value => value.key === key);
            if (spec) spec.text = text;
            this.host.menuText?.setText('debug', key, text);
          },
        },
      );
      this.gmPanelOwner = gm;
    }
    this.gmTextSpecs = [];
    this.gmDetailTextSpecs = [];
    this.gmDetailOpen = false;
    this.gmPanel?.render(body, { add: spec => this.gmTextSpecs.push(spec) });
  }

  release(): void {
    this.gmPanel?.dispose();
    this.gmPanel = undefined;
    this.gmPanelOwner = undefined;
    this.gmTextSpecs = [];
    this.gmDetailTextSpecs = [];
    this.gmDetailOpen = false;
    this.host.menuText?.beginPage('');
  }

  update(): void {
    if (!this.host.open || this.host.page !== 'debug' || !this.gmPanel || !this.host.body) return;
    this.host.description?.clear();
    this.host.removeDescriptionScrolls();
    this.gmDetailOpen = false;
    this.gmDetailTextSpecs = [];
    this.gmTextSpecs = [];
    this.gmPanel.update(this.host.body, { add: spec => this.gmTextSpecs.push(spec) });
    this.host.menuText?.renderPage('debug');
    this.host.commitSession();
    this.host.sync();
  }

  /** GM 调试页的物品详情固定在左侧，高 392；只让出这块矩形里的文字。 */
  private descriptionCovers(spec: MenuTextSpec): boolean {
    const rect = descriptionPanel(BAG_DESCRIPTION_WIDTH);
    return spec.x >= 60 && spec.x <= 60 + rect.width && spec.y >= rect.y && spec.y <= rect.y + 392;
  }

  /**
   * GM 道具页的详情层：用背包同一套说明面板与正文生成器，画在独立的说明画布（深度 300）上，
   * 因此表现为盖在道具页右侧的弹出层。物品可能还没进背包，所以用一份基础实例预览。
   */
  private renderItemDetail(itemId: string, close: () => void): void {
    const v = this.host.description;
    const session = this.host.session();
    if (!v || !session) return;
    const catalog = session.bag.catalog;
    const item = catalog.items[itemId];
    if (!item) return;
    this.gmDetailOpen = true;
    // 未持有的物品没有掷出的实例数值；用目录默认值与最大孔数预览，避免详情里全是 0。
    const defaults = this.host.app.characterStats.equipment[itemId];
    const entry: ItemInstance = {
      id: 'gm-preview',
      item: itemId,
      quantity: 1,
      enhancement: 0,
      gems: [],
      ...(defaults
        ? {
            numbers: {
              grade: defaults.defaultGrade ?? 2,
              gradeName: defaults.gradeName,
              modifiers: [],
              gemModifiers: [],
              magicPercent: defaults.magicPercent[0] ?? 0,
              sockets: item.equipment?.socketCapacity ?? 0,
              enhancementUses: defaults.fixedEnhancementUses ?? defaults.enhancementUses[0] ?? 0,
            },
          }
        : {}),
    };
    // 详情层停在左侧、底边抬到底部按钮之上：右侧数量/发放按钮与底部金币按钮始终可点。
    const panel = descriptionPanel(BAG_DESCRIPTION_WIDTH);
    const left = 60;
    const top = panel.y;
    const panelHeight = 392;
    // 透明拦截层挡住被盖住的道具格，避免点到看不见的物品；右侧与底部不在它范围内。
    v.rect(left, top, panel.width, panelHeight, 0x000000, 0).setInteractive();
    drawDescriptionPanel(v, this.host.app.menuPanels.assets, left, top, panel.width, panelHeight);
    // 每次打开都从正文顶部开始，不沿用上一件物品的滚动位置。
    this.host.scrollOffsets.delete('debug:item');
    const body = itemDescriptionBody({
      item,
      entry,
      numbers: this.host.app.characterStats.equipment[entry.item],
      catalog: this.host.app.characterStats,
      grades: this.host.app.shops.grades,
      member: this.host.member(),
      classNames: this.host.classNames(),
      gemNames: entry.gems.map(id => catalog.items[id]?.name),
      skill: entry.skill ? catalog.skillDescriptions?.[entry.skill] : undefined,
    });
    // 名字换行时正文区整体下移，底边仍停在原面板内。
    const titleOverflow = descriptionTitleOverflow(v, body.title, panel.width, panel.title.y, panel.scroll.y, panel.scroll.height);
    const scrollX = left + panel.scroll.x;
    const scrollY = top + panel.scroll.y + titleOverflow;
    const scrollHeight = Math.max(60, panel.scroll.height - titleOverflow);
    const clip = { top: scrollY, bottom: scrollY + scrollHeight };
    const writer = { add: (spec: MenuTextSpec) => this.gmDetailTextSpecs.push(spec) };
    const detail = this.host.scroll('item', left + panel.scroll.x, scrollY, panel.scroll.width, scrollHeight, v);
    drawDescriptionTitle(body.title, left, top, panel.width, body.color, { writer, keyPrefix: 'gm-item-title' });
    const height = drawDescriptionRows(v, body.rows, panel.scroll.width, {
      writer,
      keyPrefix: 'gm-item-row',
      x: scrollX,
      y: scrollY,
      scroll: 'item',
      clip,
    });
    this.host.finishScroll('item', detail, height);
    drawDescriptionClose(v, this.host.app.menuPanels.assets, panel, left, top, close);
  }
}

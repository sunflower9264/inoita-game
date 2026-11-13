import { UiNode, uiMount } from '../dom/node.ts';
import { UI_EVENTS } from '../../application/ui-events.ts';
import type Phaser from 'phaser';
import type { GameUI } from '../game-ui.ts';
import { MONEY } from '../item-layout.ts';
import { splitMoney } from '../../domain/money.ts';
import { frameRect, readSafeArea } from '../viewport.ts';
import { layoutQuestText, questPopupContent, questPopupLayout, type QuestTextLine } from '../quest-popup-layout.ts';
import { UiSurface, GOLD, type ScrollArea } from './widgets.ts';
import { FONT } from '../text-style.ts';
import { POPUP_FRAME } from '../shop-layout.ts';
import { QUEST_LINE_SPACING, QUEST_TEXT_COLORS } from './quest-text.ts';
import type { DomLabel, DomUi } from '../dom/dom-ui.ts';

type QuestPopupState = NonNullable<GameUI['quest']>;
interface QuestTextLayout { lines: QuestTextLine[]; lineHeight: number; height: number }
interface DomPlacement { label: DomLabel; x: number; y: number }

let measureCanvas: HTMLCanvasElement | undefined;

/** 用浏览器字体量任务文本；Phaser 只负责图框、滚动和按钮。 */
function questTextMetrics(size: number): { measure: (text: string) => number; lineHeight: number } {
  if (typeof document === 'undefined') return { measure: text => Array.from(text).length * size, lineHeight: size + QUEST_LINE_SPACING };
  const canvas = measureCanvas ??= document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) return { measure: text => Array.from(text).length * size, lineHeight: size + QUEST_LINE_SPACING };
  context.font = `${size}px ${FONT}`;
  // 与 Phaser Text 同口径：测试串的字体上下边界加固定行距。
  const metrics = context.measureText('|MÃ‰qgy');
  const lineHeight = (metrics.actualBoundingBoxAscent ?? size * .8) + (metrics.actualBoundingBoxDescent ?? size * .2) + QUEST_LINE_SPACING;
  return { measure: text => context.measureText(text).width, lineHeight };
}

function measureQuestText(value: string, width: number, size: number): QuestTextLayout {
  if (!value) return { lines: [], lineHeight: 0, height: 0 };
  const { measure, lineHeight } = questTextMetrics(size);
  const lines = layoutQuestText(value, width, measure);
  return { lines, lineHeight, height: lines.length * lineHeight - QUEST_LINE_SPACING };
}

/** 任务窗保留自己的原版坐标，正式对白与操作栏继续使用各自的参考尺寸。 */
export class QuestPopup {
  readonly surface: UiSurface;
  private readonly shade: UiNode;
  private readonly domUi?: DomUi;
  private quest?: QuestPopupState;
  private viewport = '';
  private domTitle: DomLabel[] = [];
  private domBody: DomLabel[] = [];
  private domMoney: DomLabel[] = [];
  private domButton?: DomLabel;
  private domClip?: DomLabel;
  private domScroll?: ScrollArea;
  private domPlacements: DomPlacement[] = [];
  private domScrollTop = 0;
  private domScale = 1;

  constructor(scene: Phaser.Scene, enabled: () => boolean, domUi?: DomUi) {
    this.surface = new UiSurface(scene, 800, 480, 1000, 'overlay');
    this.surface.enabled = enabled;
    this.domUi = domUi;
    this.shade = new UiNode(scene, uiMount(scene, 'overlay')).setSize(1,1).setFillStyle(0,.65).setDepth(998).setVisible(false);
    this.surface.visible(false);
  }

  sync(quest: QuestPopupState | undefined, assets: Record<string, string>, itemName: (id: string) => string): void {
    const v = this.surface, frame = frameRect(), safe = readSafeArea(), viewport = `${frame.width}:${frame.height}:${safe.left}:${safe.right}:${safe.top}:${safe.bottom}`;
    this.shade.setVisible(!!quest).setSize(frame.width, frame.height);
    // 任务和屏幕尺寸、安全区都没变时不必重新测量与排版。
    if (this.quest === quest && this.viewport === viewport) return;
    const scrollTop = this.quest === quest ? v.scrolls[0]?.scrollTop ?? 0 : 0;
    this.quest = quest; this.viewport = viewport;
    v.clear(); v.visible(!!quest); v.layout(0);
    if (!quest) { this.hideDom(); return; }

    const content = questPopupContent(quest.kind, quest.definition, quest.reward, itemName);
    const title = measureQuestText(content.heading, 410, 24), body = measureQuestText(content.body, 410, 24);
    const box = questPopupLayout(quest.kind, title.height, body.height, content.money > 0);
    v.rect(box.x + POPUP_FRAME.inset, box.y + POPUP_FRAME.inset,
      box.width - POPUP_FRAME.inset * 2, box.height - POPUP_FRAME.inset * 2, 0x000000, 1);
    v.nineSlice(assets['quest-popup-window'], box.x - 46, box.y - 46, box.width + 92, box.height + 92, 81);
    v.image(assets['quest-popup-rule'], 400, box.titleY + title.height + 7, 442, 14).setOrigin(.5);

    const scroll = v.scroll(box.bodyX, box.bodyY, box.bodyWidth, box.bodyHeight);
    let extent = body.height;
    if (content.money > 0) {
      (['gold', 'silver', 'copper'] as const).forEach((unit, index) => {
        const x = index * MONEY.stride;
        v.image(assets[`money-${unit}`], x, extent, MONEY.coin.width, MONEY.coin.height, scroll.content);
      });
      extent += 40;
    }
    scroll.setHeight(extent); scroll.scrollTop = scrollTop;

    v.button('', box.buttonX, box.buttonY, 125, 55, quest.confirm, {
      guard: () => this.quest === quest && v.enabled(),
    });
    v.layout(0);

    this.renderDom(title, body, content.money, box.bodyX, box.titleY, box.bodyY,
      box.bodyWidth, box.bodyHeight, box.buttonX, box.buttonY, scroll);
    scroll.onScroll = () => this.updateDomScroll();
  }

  key(event: KeyboardEvent): void {
    if (!this.quest || !this.surface.enabled()) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault(); this.surface.scene.game.events.emit(UI_EVENTS.select); this.quest.confirm();
    } else this.surface.key(event);
  }

  destroy(): void { this.removeDom(); this.surface.destroy(); this.shade.destroy(); }

  private surfacePoint(x: number, y: number): { x: number; y: number; scale: number } {
    const m = this.surface.root.getWorldTransformMatrix();
    return { x: (m.tx + x * m.scaleX), y: (m.ty + y * m.scaleY), scale: m.scaleX };
  }

  private placeLabel(pool: DomLabel[], index: number, parent: HTMLElement, text: string,
    x: number, y: number, size: number, color: string): DomLabel {
    const domUi = this.domUi!;
    let label = pool[index];
    if (!label) { label = domUi.label('overlay', 'dom-label'); pool.push(label); }
    if (label.element.parentElement !== parent) parent.appendChild(label.element);
    return label.setText(text).setStyle({ fontSize: `${Math.max(10, size)}px`, color }).setPosition(x, y).setVisible(true);
  }

  private hideLabels(labels: DomLabel[], used: number): void {
    for (let index = used; index < labels.length; index++) labels[index]!.setVisible(false);
  }

  private hideDom(): void {
    for (const label of this.domTitle) label.setVisible(false);
    for (const label of this.domBody) label.setVisible(false);
    for (const label of this.domMoney) label.setVisible(false);
    this.domClip?.setVisible(false);
    this.domButton?.setVisible(false);
    this.domScroll = undefined;
    this.domPlacements = [];
  }

  private removeDom(): void {
    this.domTitle.splice(0).forEach(label => label.remove());
    this.domBody.splice(0).forEach(label => label.remove());
    this.domMoney.splice(0).forEach(label => label.remove());
    this.domClip?.remove(); this.domClip = undefined;
    this.domButton?.remove(); this.domButton = undefined;
    this.domScroll = undefined;
    this.domPlacements = [];
  }

  private updateDomScroll(): void {
    const scroll = this.domScroll;
    if (!scroll) return;
    const top = scroll.scrollTop;
    if (top === this.domScrollTop) return;
    this.domScrollTop = top;
    for (const placement of this.domPlacements)
      placement.label.setPosition(placement.x, placement.y - top * this.domScale);
  }

  private renderDom(title: QuestTextLayout, body: QuestTextLayout, money: number,
    bodyX: number, titleY: number, bodyY: number, bodyWidth: number, bodyHeight: number,
    buttonX: number, buttonY: number, scroll: ScrollArea): void {
    const domUi = this.domUi;
    if (!domUi) return;
    const scale = this.surfacePoint(0, 0).scale, layer = domUi.layer('overlay');
    if (!layer) return;

    let cursor = 0;
    title.lines.forEach((line, index) => {
      const offset = (bodyWidth - line.width) / 2;
      for (const run of line.runs) {
        const point = this.surfacePoint(bodyX + offset + run.x, titleY + index * title.lineHeight);
        this.placeLabel(this.domTitle, cursor++, layer, run.text, point.x, point.y, 24 * scale, QUEST_TEXT_COLORS[run.tone]);
      }
    });
    this.hideLabels(this.domTitle, cursor);

    const clip = this.domClip ??= domUi.label('overlay', 'dom-label dom-quest-clip').setStyle({ overflow: 'hidden', pointerEvents: 'none' });
    const origin = this.surfacePoint(bodyX, bodyY);
    clip.setStyle({ width: `${bodyWidth * scale}px`, height: `${bodyHeight * scale}px` }).setPosition(origin.x, origin.y).setVisible(true);

    this.domPlacements = [];
    const top = scroll.scrollTop;
    cursor = 0;
    body.lines.forEach((line, index) => line.runs.forEach(run => {
      const x = run.x * scale, y = index * body.lineHeight * scale;
      const label = this.placeLabel(this.domBody, cursor++, clip.element, run.text,
        x, y - top * scale, 24 * scale, QUEST_TEXT_COLORS[run.tone]);
      this.domPlacements.push({ label, x, y });
    }));
    this.hideLabels(this.domBody, cursor);

    cursor = 0;
    if (money > 0) {
      const split = splitMoney(money);
      (['gold', 'silver', 'copper'] as const).forEach((unit, index) => {
        const x = (index * MONEY.stride + MONEY.digit.x) * scale;
        const y = (body.height + MONEY.digit.y) * scale;
        const label = this.placeLabel(this.domMoney, cursor++, clip.element, String(split[unit]),
          x, y - top * scale, 20 * scale, MONEY.color);
        this.domPlacements.push({ label, x, y });
      });
    }
    this.hideLabels(this.domMoney, cursor);

    this.domScroll = scroll;
    this.domScrollTop = top;
    this.domScale = scale;

    const button = this.domButton ??= domUi.label('overlay', 'dom-label', { x: .5, y: .5 });
    const center = this.surfacePoint(buttonX + 62.5, buttonY + 27.5);
    button.setText('确认').setStyle({ fontSize: `${Math.max(10, 24 * scale)}px`, color: GOLD })
      .setPosition(center.x, center.y).setVisible(true);
  }
}

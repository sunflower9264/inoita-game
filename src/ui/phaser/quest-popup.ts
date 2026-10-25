import { UI_EVENTS } from '../../application/ui-events.ts';
import type Phaser from 'phaser';
import type { GameUI } from '../game-ui.ts';
import { MONEY } from '../item-layout.ts';
import { splitMoney } from '../money-display.ts';
import { readSafeArea } from '../viewport.ts';
import { questPopupContent, questPopupLayout } from '../quest-popup-layout.ts';
import { UiSurface } from './widgets.ts';
import { drawQuestText, measureQuestText } from './quest-text.ts';

type QuestPopupState = NonNullable<GameUI['quest']>;

/** 任务窗保留自己的原版坐标，正式对白与操作栏继续使用各自的参考尺寸。 */
export class QuestPopup {
  readonly surface: UiSurface;
  private readonly shade: Phaser.GameObjects.Rectangle;
  private quest?: QuestPopupState;
  private viewport = '';

  constructor(scene: Phaser.Scene, enabled: () => boolean) {
    this.surface = new UiSurface(scene, 800, 480, 1000);
    this.surface.enabled = enabled;
    this.shade = scene.add.rectangle(0, 0, 1, 1, 0x000000, .65).setOrigin(0).setDepth(998.5).setVisible(false);
    this.surface.visible(false);
  }

  sync(quest: QuestPopupState | undefined, assets: Record<string, string>, itemName: (id: string) => string): void {
    const v = this.surface, safe = readSafeArea(), viewport = `${v.scene.scale.width}:${v.scene.scale.height}:${safe.left}:${safe.right}:${safe.top}:${safe.bottom}`;
    this.shade.setVisible(!!quest).setSize(v.scene.scale.width, v.scene.scale.height);
    // 任务和画布/安全区都没变时不必重新测量与排版。
    if (this.quest === quest && this.viewport === viewport) return;
    const scrollTop = this.quest === quest ? v.scrolls[0]?.scrollTop ?? 0 : 0;
    this.quest = quest; this.viewport = viewport;
    v.clear(); v.visible(!!quest); v.layout(0);
    if (!quest) return;

    const content = questPopupContent(quest.kind, quest.definition, quest.reward, itemName);
    const title = measureQuestText(v, content.heading, 410, 24), body = measureQuestText(v, content.body, 410, 24);
    const box = questPopupLayout(quest.kind, title.height, body.height, content.money > 0);
    v.rect(box.x + 35, box.y + 35, box.width - 70, box.height - 70, 0x000000, 1);
    v.nineSlice(assets['quest-popup-window'], box.x - 46, box.y - 46, box.width + 92, box.height + 92, 81);
    drawQuestText(v, title, box.bodyX, box.titleY, box.bodyWidth, 24, v.root, true);
    v.image(assets['quest-popup-rule'], 400, box.titleY + title.height + 7, 442, 14).setOrigin(.5);

    const scroll = v.scroll(box.bodyX, box.bodyY, box.bodyWidth, box.bodyHeight);
    drawQuestText(v, body, 0, 0, box.bodyWidth, 24, scroll.content);
    let extent = body.height;
    if (content.money > 0) {
      const money = splitMoney(content.money);
      (['gold', 'silver', 'copper'] as const).forEach((unit, index) => {
        const x = index * MONEY.stride;
        v.image(assets[`money-${unit}`], x, extent, MONEY.coin.width, MONEY.coin.height, scroll.content);
        v.text(String(money[unit]), x + MONEY.digit.x, extent + MONEY.digit.y, 0, 20, MONEY.color, scroll.content);
      });
      extent += 40;
    }
    scroll.setHeight(extent); scroll.scrollTop = scrollTop;

    v.button('确认', box.buttonX, box.buttonY, 125, 55, quest.confirm, {
      fontSize: 24,
      guard: () => this.quest === quest && v.enabled(),
    });
    v.layout(0);
  }

  key(event: KeyboardEvent): void {
    if (!this.quest || !this.surface.enabled()) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault(); this.surface.scene.game.events.emit(UI_EVENTS.select); this.quest.confirm();
    } else this.surface.key(event);
  }

  destroy(): void { this.surface.destroy(); this.shade.destroy(); }
}

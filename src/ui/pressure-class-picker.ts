import type Phaser from 'phaser';
import type { StoryClass, StoryClassCatalog } from '../domain/story-class.ts';
import { UiNode, type UiImage, type UiText } from './dom/node.ts';
import { UiSurface, loadUiImages } from './phaser/widgets.ts';
import { frameRect } from './viewport.ts';

/** 挑战模式换职弹层的虚拟尺寸与防碰撞布局参数（透明无底框，仅保留半透明遮罩）。 */
export const PRESSURE_PICKER_LAYOUT = {
  width: 760,
  height: 440,
  titleY: 26,
  gridTop: 66,
  cardWidth: 144,
  cardHeight: 114,
  iconSize: 74,
  columnGap: 20,
  rowGap: 12,
  actionsY: 360,
  actionHeight: 52,
  cancelX: 164,
  cancelWidth: 180,
  confirmX: 376,
  confirmWidth: 220,
} as const;

const GOLD = '#f3deb0';
const MUTED = '#d8d0c0';
const CURRENT_TAG = '#9fd3ff';
const LABEL_SHADOW = '0 2px 4px rgba(0,0,0,0.92)';

interface ClassCardEntry {
  readonly id: string;
  readonly button: UiNode;
  readonly selectionGlow: UiImage;
  readonly label: UiText;
}

export interface PressureClassPickerOptions {
  readonly scene: Phaser.Scene;
  readonly catalog: StoryClassCatalog;
  readonly classes: readonly StoryClass[];
  readonly currentClassId: string;
  readonly enabled: () => boolean;
  readonly onCancel: () => void;
  readonly onConfirm: (classId: string) => void;
}

/**
 * 挑战模式（压测）场内换职弹层：
 * - 无棕色实体底框，保留全屏暗色压暗遮罩拦截世界点击；
 * - 紧凑双行居中排布缩小后的职业图标，与底部操作行保留 54px 净空；
 * - 打开时一次性构建 DOM 并持有图标租约，点击切换仅就地更新高亮与确认态，彻底杜绝重建闪烁。
 */
export class PressureClassPicker {
  readonly backdrop: UiNode;
  readonly surface: UiSurface;
  private readonly currentClassId: string;
  private readonly cards = new Map<string, ClassCardEntry>();
  private readonly confirmButton: UiNode;
  private readonly controller = new AbortController();
  private releaseAssets?: () => void;
  private selectedId: string;
  private disposed = false;

  constructor(options: PressureClassPickerOptions) {
    const { scene, catalog, classes, currentClassId, enabled, onCancel, onConfirm } = options;
    this.currentClassId = currentClassId;
    this.selectedId = classes.some(entry => entry.id === currentClassId)
      ? currentClassId
      : (classes[0]?.id ?? currentClassId);

    const frame = frameRect();
    this.backdrop = new UiNode(scene)
      .setDepth(499)
      .setSize(frame.width, frame.height)
      .setFillStyle(0x000000, 0.68)
      .setInteractive();

    this.surface = new UiSurface(scene, PRESSURE_PICKER_LAYOUT.width, PRESSURE_PICKER_LAYOUT.height, 500);
    this.surface.enabled = enabled;

    // 预载并持有所用职业图标与选中光效租约，避免选择期间反复卸载/重取导致闪烁。
    const preloadFiles = [...new Set([...classes.map(entry => entry.icon), catalog.assets.selected])];
    void loadUiImages(scene, preloadFiles, undefined, this.controller.signal).then(lease => {
      if (this.disposed) {
        lease.release();
        return;
      }
      this.releaseAssets = () => lease.release();
    }).catch(() => {});

    const title = this.surface
      .text('选择职业', PRESSURE_PICKER_LAYOUT.width / 2, PRESSURE_PICKER_LAYOUT.titleY, 320, 24, GOLD)
      .setOrigin(0.5);
    title.element.style.textShadow = LABEL_SHADOW;

    // 6 职排 3+3，7 职排 4+3，8 职排 4+4；两行总底边固定在 306，与底部 360 操作行保持 54px 留白。
    const maxCols = Math.min(4, Math.max(1, Math.ceil(classes.length / 2)));
    const rows: StoryClass[][] = [];
    for (let i = 0; i < classes.length; i += maxCols) rows.push(classes.slice(i, i + maxCols));

    const { cardWidth, cardHeight, iconSize, columnGap, rowGap, gridTop } = PRESSURE_PICKER_LAYOUT;
    rows.forEach((row, rowIndex) => {
      const rowWidth = row.length * cardWidth + Math.max(0, row.length - 1) * columnGap;
      const startX = Math.round((PRESSURE_PICKER_LAYOUT.width - rowWidth) / 2);
      const y = gridTop + rowIndex * (cardHeight + rowGap);

      row.forEach((entry, colIndex) => {
        const x = startX + colIndex * (cardWidth + columnGap);
        const button = this.surface
          .button('', x, y, cardWidth, cardHeight, () => this.select(entry.id), { bare: true })
          .setData('label', entry.name);

        const iconX = Math.round((cardWidth - iconSize) / 2);
        const iconY = 4;
        this.surface.image(entry.icon, iconX, iconY, iconSize, iconSize, button);

        const selectionGlow = this.surface
          .image(catalog.assets.selected, iconX, iconY, iconSize, iconSize, button)
          .setBlendMode('add')
          .setVisible(false);

        const label = this.surface
          .text(entry.name, cardWidth / 2, iconY + iconSize + 15, cardWidth, 17, MUTED, button)
          .setOrigin(0.5)
          .setAlign('center');
        label.element.style.textShadow = LABEL_SHADOW;

        if (entry.id === currentClassId) {
          const badge = this.surface
            .text('当前', cardWidth / 2, iconY + iconSize + 34, cardWidth, 13, CURRENT_TAG, button)
            .setOrigin(0.5)
            .setAlign('center');
          badge.element.style.textShadow = LABEL_SHADOW;
        }

        this.cards.set(entry.id, { id: entry.id, button, selectionGlow, label });
      });
    });

    this.surface.button(
      '取消',
      PRESSURE_PICKER_LAYOUT.cancelX,
      PRESSURE_PICKER_LAYOUT.actionsY,
      PRESSURE_PICKER_LAYOUT.cancelWidth,
      PRESSURE_PICKER_LAYOUT.actionHeight,
      () => onCancel(),
    );

    this.confirmButton = this.surface.button(
      '以 1 级重新挑战',
      PRESSURE_PICKER_LAYOUT.confirmX,
      PRESSURE_PICKER_LAYOUT.actionsY,
      PRESSURE_PICKER_LAYOUT.confirmWidth,
      PRESSURE_PICKER_LAYOUT.actionHeight,
      () => {
        if (this.selectedId) onConfirm(this.selectedId);
      },
      { fontSize: 19, disabled: this.selectedId === this.currentClassId },
    );

    this.applySelectionVisuals();
    this.layout();
  }

  get selectedClassId(): string {
    return this.selectedId;
  }

  /** 就地切换选中状态与确认按钮可用态，不销毁或重建任何 DOM 节点。 */
  select(classId: string): void {
    if (this.disposed || !this.cards.has(classId) || this.selectedId === classId) return;
    this.selectedId = classId;
    this.applySelectionVisuals();
  }

  private applySelectionVisuals(): void {
    for (const card of this.cards.values()) {
      const selected = card.id === this.selectedId;
      if (card.selectionGlow.visible !== selected) card.selectionGlow.setVisible(selected);
      card.button.setData('selected', selected);
      card.label.element.style.color = selected ? GOLD : MUTED;
    }
    this.confirmButton.getData('setEnabled')?.(this.selectedId !== this.currentClassId);
  }

  setVisible(shown: boolean): void {
    if (this.disposed) return;
    this.surface.visible(shown);
    this.backdrop.setVisible(shown);
  }

  layout(): void {
    if (this.disposed) return;
    const frame = frameRect();
    this.backdrop.setSize(frame.width, frame.height);
    this.surface.layout(16);
  }

  key(event: KeyboardEvent): boolean {
    if (this.disposed) return false;
    return this.surface.key(event);
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.controller.abort();
    this.releaseAssets?.();
    this.releaseAssets = undefined;
    this.cards.clear();
    this.surface.destroy();
    this.backdrop.destroy();
  }
}

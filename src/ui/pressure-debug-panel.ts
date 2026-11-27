import type { StoryClass, StoryClassCatalog } from '../domain/story-class.ts';
import {
  PRESSURE_DEFAULT_MAX_ENEMIES,
  PRESSURE_MAX_ENEMIES_LIMIT,
  PRESSURE_MAX_HEALTH_LIMIT,
  PRESSURE_MIN_ENEMIES,
  PRESSURE_MIN_HEALTH,
  normalizePressureEnemyHealth,
  normalizePressureMaxEnemies,
  type PressureSettings,
} from '../domain/pressure-enemies.ts';
import { UiNode, type UiImage, type UiSceneHost, type UiText } from './dom/node.ts';
import { NumberPrompt } from './number-prompt.ts';
import { UiSurface, loadUiImages } from './widgets.ts';
import { frameRect } from './viewport.ts';

export type PressureDebugTab = 'class' | 'monster';

export const PRESSURE_COUNT_PRESETS = [0, 1, 5, 10, 20, 40, 100] as const;
export const PRESSURE_HEALTH_PRESETS = [
  { value: 1_000, label: '1千' },
  { value: 5_000, label: '5千' },
  { value: 10_000, label: '1万' },
  { value: 50_000, label: '5万' },
  { value: 100_000, label: '10万' },
  { value: 1_000_000, label: '100万' },
] as const;

/** 挑战模式调试弹层的虚拟尺寸与防碰撞布局参数（透明无底框，仅保留半透明遮罩）。 */
export const PRESSURE_DEBUG_LAYOUT = {
  width: 820,
  height: 480,
  tabY: 16,
  tabWidth: 160,
  tabHeight: 48,
  tabGap: 16,
  closeX: 754,
  closeY: 15,
  closeSize: 50,
  gridTop: 92,
  cardWidth: 144,
  cardHeight: 114,
  iconSize: 74,
  columnGap: 20,
  rowGap: 14,
  labelX: 64,
  controlX: 244,
  countRowY: 96,
  countPresetY: 164,
  healthRowY: 248,
  healthPresetY: 316,
  rowHeight: 52,
  presetHeight: 44,
  actionsY: 404,
  actionHeight: 52,
  leftActionX: 194,
  leftActionWidth: 180,
  rightActionX: 406,
  rightActionWidth: 220,
} as const;

const GOLD = '#f3deb0';
const MUTED = '#d8d0c0';
const CURRENT_TAG = '#9fd3ff';
const LABEL_SHADOW = '0 2px 4px rgba(0,0,0,0.92)';

const formatNumber = (value: number): string => value.toLocaleString('en-US');

interface ClassCardEntry {
  readonly id: string;
  readonly button: UiNode;
  readonly selectionGlow: UiImage;
  readonly label: UiText;
}

export interface PressureDebugPanelOptions {
  readonly scene: UiSceneHost;
  readonly catalog: StoryClassCatalog;
  readonly classes: readonly StoryClass[];
  readonly currentClassId: string;
  readonly settings: Readonly<PressureSettings>;
  readonly getLiveEnemyCount: () => number;
  readonly closeAssets?: { readonly close: string; readonly closePressed: string };
  readonly enabled: () => boolean;
  readonly onClose: () => void;
  readonly onConfirmClass: (classId: string) => void;
  readonly onUpdateSettings: (patch: Partial<PressureSettings>) => void;
}

/**
 * 挑战模式（压测）场内调试弹层：
 * - 无棕色实体底框，保留全屏暗色压暗遮罩拦截世界点击；
 * - 顶部提供「职业」「怪物」双页签与常驻关闭按钮，双页内容在构造时一次性构建，切换页签、选职、调参数均只就地更新状态与显隐，零重建闪烁；
 * - 「职业」页签延续紧凑双行居中排布，「怪物」页签采用左标签右控件的设置行风格并提供数字输入卡。
 */
export class PressureDebugPanel {
  readonly backdrop: UiNode;
  readonly surface: UiSurface;
  private readonly currentClassId: string;
  private readonly getLiveEnemyCount: () => number;
  private readonly onUpdateSettings: (patch: Partial<PressureSettings>) => void;
  private readonly tabButtons = new Map<PressureDebugTab, UiNode>();
  private readonly classPane: UiNode;
  private readonly monsterPane: UiNode;
  private readonly cards = new Map<string, ClassCardEntry>();
  private readonly confirmClassButton: UiNode;
  private readonly countMinusButton: UiNode;
  private readonly countPlusButton: UiNode;
  private readonly countValueButton: UiNode;
  private readonly liveCountText: UiText;
  private readonly countPresetButtons = new Map<number, UiNode>();
  private readonly healthDefaultButton: UiNode;
  private readonly healthValueButton: UiNode;
  private readonly healthModeText: UiText;
  private readonly healthPresetButtons = new Map<number, UiNode>();
  private readonly resetMonsterButton: UiNode;
  private readonly numberPrompt = new NumberPrompt();
  private readonly controller = new AbortController();
  private releaseAssets?: () => void;
  private activeTab: PressureDebugTab = 'class';
  private selectedId: string;
  private maxEnemies: number;
  private enemyMaxHealth: number | undefined;
  private disposed = false;

  constructor(options: PressureDebugPanelOptions) {
    const {
      scene, catalog, classes, currentClassId, settings, getLiveEnemyCount,
      closeAssets, enabled, onClose, onConfirmClass, onUpdateSettings,
    } = options;
    this.currentClassId = currentClassId;
    this.getLiveEnemyCount = getLiveEnemyCount;
    this.onUpdateSettings = onUpdateSettings;
    this.selectedId = classes.some(entry => entry.id === currentClassId)
      ? currentClassId
      : (classes[0]?.id ?? currentClassId);
    this.maxEnemies = normalizePressureMaxEnemies(settings.maxEnemies);
    this.enemyMaxHealth = normalizePressureEnemyHealth(settings.enemyMaxHealth);

    const frame = frameRect();
    this.backdrop = new UiNode(scene)
      .setDepth(499)
      .setSize(frame.width, frame.height)
      .setFillStyle(0x000000, 0.68)
      .setInteractive();

    this.surface = new UiSurface(scene, PRESSURE_DEBUG_LAYOUT.width, PRESSURE_DEBUG_LAYOUT.height, 500);
    this.surface.enabled = () => enabled() && !this.numberPrompt.active;

    // 预载并持有所用职业图标与选中光效租约，避免选择与切页期间反复卸载/重取导致闪烁。
    const preloadFiles = [...new Set([
      ...classes.map(entry => entry.icon),
      catalog.assets.selected,
      ...(closeAssets ? [closeAssets.close, closeAssets.closePressed] : []),
    ])];
    void loadUiImages(preloadFiles, undefined, this.controller.signal).then(lease => {
      if (this.disposed) {
        lease.release();
        return;
      }
      this.releaseAssets = () => lease.release();
    }).catch(() => {});

    // 顶部页签与常驻关闭按钮
    const tabs: readonly [PressureDebugTab, string][] = [['class', '职业'], ['monster', '怪物']];
    const totalTabWidth = tabs.length * PRESSURE_DEBUG_LAYOUT.tabWidth + (tabs.length - 1) * PRESSURE_DEBUG_LAYOUT.tabGap;
    const tabStartX = Math.round((PRESSURE_DEBUG_LAYOUT.width - totalTabWidth) / 2);
    tabs.forEach(([tab, label], index) => {
      const x = tabStartX + index * (PRESSURE_DEBUG_LAYOUT.tabWidth + PRESSURE_DEBUG_LAYOUT.tabGap);
      const button = this.surface
        .button(label, x, PRESSURE_DEBUG_LAYOUT.tabY, PRESSURE_DEBUG_LAYOUT.tabWidth, PRESSURE_DEBUG_LAYOUT.tabHeight,
          () => this.selectTab(tab), { fontSize: 21, selected: tab === this.activeTab })
        .setData('label', label);
      this.tabButtons.set(tab, button);
    });

    if (closeAssets) {
      this.surface
        .button('', PRESSURE_DEBUG_LAYOUT.closeX, PRESSURE_DEBUG_LAYOUT.closeY,
          PRESSURE_DEBUG_LAYOUT.closeSize, PRESSURE_DEBUG_LAYOUT.closeSize, () => onClose(),
          { image: closeAssets.close, pressed: closeAssets.closePressed })
        .setData('label', '关闭调试');
    } else {
      this.surface
        .button('×', PRESSURE_DEBUG_LAYOUT.closeX, PRESSURE_DEBUG_LAYOUT.closeY,
          PRESSURE_DEBUG_LAYOUT.closeSize, PRESSURE_DEBUG_LAYOUT.closeSize, () => onClose(), { fontSize: 24 })
        .setData('label', '关闭调试');
    }

    // 页签 1：职业选择（一次性构建，保留零闪烁体验）
    this.classPane = this.surface.container(0, 0);
    const maxCols = Math.min(4, Math.max(1, Math.ceil(classes.length / 2)));
    const rows: StoryClass[][] = [];
    for (let i = 0; i < classes.length; i += maxCols) rows.push(classes.slice(i, i + maxCols));

    const { cardWidth, cardHeight, iconSize, columnGap, rowGap, gridTop } = PRESSURE_DEBUG_LAYOUT;
    rows.forEach((row, rowIndex) => {
      const rowWidth = row.length * cardWidth + Math.max(0, row.length - 1) * columnGap;
      const startX = Math.round((PRESSURE_DEBUG_LAYOUT.width - rowWidth) / 2);
      const y = gridTop + rowIndex * (cardHeight + rowGap);

      row.forEach((entry, colIndex) => {
        const x = startX + colIndex * (cardWidth + columnGap);
        const button = this.surface
          .button('', x, y, cardWidth, cardHeight, () => this.selectClass(entry.id), { bare: true, parent: this.classPane })
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
      '关闭',
      PRESSURE_DEBUG_LAYOUT.leftActionX,
      PRESSURE_DEBUG_LAYOUT.actionsY,
      PRESSURE_DEBUG_LAYOUT.leftActionWidth,
      PRESSURE_DEBUG_LAYOUT.actionHeight,
      () => onClose(),
      { parent: this.classPane },
    );

    this.confirmClassButton = this.surface.button(
      '以 1 级重新挑战',
      PRESSURE_DEBUG_LAYOUT.rightActionX,
      PRESSURE_DEBUG_LAYOUT.actionsY,
      PRESSURE_DEBUG_LAYOUT.rightActionWidth,
      PRESSURE_DEBUG_LAYOUT.actionHeight,
      () => {
        if (this.selectedId) onConfirmClass(this.selectedId);
      },
      { fontSize: 19, disabled: this.selectedId === this.currentClassId, parent: this.classPane },
    );

    // 页签 2：怪物数量与怪物血量（左标签 + 右控件，设置页行排布）
    this.monsterPane = this.surface.container(0, 0);

    const countLabel = this.surface
      .text('怪物数量', PRESSURE_DEBUG_LAYOUT.labelX, PRESSURE_DEBUG_LAYOUT.countRowY + PRESSURE_DEBUG_LAYOUT.rowHeight / 2, 0, 24, GOLD, this.monsterPane)
      .setOrigin(0, 0.5);
    countLabel.element.style.textShadow = LABEL_SHADOW;

    this.countMinusButton = this.surface
      .button('−', PRESSURE_DEBUG_LAYOUT.controlX, PRESSURE_DEBUG_LAYOUT.countRowY, 64, PRESSURE_DEBUG_LAYOUT.rowHeight,
        () => this.stepMaxEnemies(-1), { fontSize: 26, parent: this.monsterPane, hold: { delayMs: 350, intervalMs: 70 } })
      .setData('label', '减少怪物数量');

    this.countValueButton = this.surface
      .button(`${this.maxEnemies} 只`, PRESSURE_DEBUG_LAYOUT.controlX + 76, PRESSURE_DEBUG_LAYOUT.countRowY, 160, PRESSURE_DEBUG_LAYOUT.rowHeight,
        () => this.openCountPrompt(), { fontSize: 22, parent: this.monsterPane })
      .setData('label', '输入怪物数量');

    this.countPlusButton = this.surface
      .button('＋', PRESSURE_DEBUG_LAYOUT.controlX + 248, PRESSURE_DEBUG_LAYOUT.countRowY, 64, PRESSURE_DEBUG_LAYOUT.rowHeight,
        () => this.stepMaxEnemies(1), { fontSize: 26, parent: this.monsterPane, hold: { delayMs: 350, intervalMs: 70 } })
      .setData('label', '增加怪物数量');

    this.liveCountText = this.surface
      .text('', PRESSURE_DEBUG_LAYOUT.controlX + 332, PRESSURE_DEBUG_LAYOUT.countRowY + PRESSURE_DEBUG_LAYOUT.rowHeight / 2, 0, 18, CURRENT_TAG, this.monsterPane)
      .setOrigin(0, 0.5);
    this.liveCountText.element.style.textShadow = LABEL_SHADOW;

    PRESSURE_COUNT_PRESETS.forEach((preset, index) => {
      const x = PRESSURE_DEBUG_LAYOUT.controlX + index * 74;
      const button = this.surface
        .button(String(preset), x, PRESSURE_DEBUG_LAYOUT.countPresetY, 64, PRESSURE_DEBUG_LAYOUT.presetHeight,
          () => this.applyMaxEnemies(preset), { fontSize: 18, parent: this.monsterPane })
        .setData('label', `怪物数量 ${preset}`);
      this.countPresetButtons.set(preset, button);
    });

    const healthLabel = this.surface
      .text('怪物血量', PRESSURE_DEBUG_LAYOUT.labelX, PRESSURE_DEBUG_LAYOUT.healthRowY + PRESSURE_DEBUG_LAYOUT.rowHeight / 2, 0, 24, GOLD, this.monsterPane)
      .setOrigin(0, 0.5);
    healthLabel.element.style.textShadow = LABEL_SHADOW;

    this.healthDefaultButton = this.surface
      .button('默认', PRESSURE_DEBUG_LAYOUT.controlX, PRESSURE_DEBUG_LAYOUT.healthRowY, 120, PRESSURE_DEBUG_LAYOUT.rowHeight,
        () => this.applyEnemyMaxHealth(undefined), { fontSize: 20, parent: this.monsterPane })
      .setData('label', '怪物血量默认');

    this.healthValueButton = this.surface
      .button('自定义血量', PRESSURE_DEBUG_LAYOUT.controlX + 132, PRESSURE_DEBUG_LAYOUT.healthRowY, 220, PRESSURE_DEBUG_LAYOUT.rowHeight,
        () => this.openHealthPrompt(), { fontSize: 20, parent: this.monsterPane })
      .setData('label', '输入怪物血量');

    this.healthModeText = this.surface
      .text('', PRESSURE_DEBUG_LAYOUT.controlX + 368, PRESSURE_DEBUG_LAYOUT.healthRowY + PRESSURE_DEBUG_LAYOUT.rowHeight / 2, 0, 18, MUTED, this.monsterPane)
      .setOrigin(0, 0.5);
    this.healthModeText.element.style.textShadow = LABEL_SHADOW;

    PRESSURE_HEALTH_PRESETS.forEach((preset, index) => {
      const x = PRESSURE_DEBUG_LAYOUT.controlX + index * 87;
      const button = this.surface
        .button(preset.label, x, PRESSURE_DEBUG_LAYOUT.healthPresetY, 76, PRESSURE_DEBUG_LAYOUT.presetHeight,
          () => this.applyEnemyMaxHealth(preset.value), { fontSize: 18, parent: this.monsterPane })
        .setData('label', `怪物血量 ${preset.label}`);
      this.healthPresetButtons.set(preset.value, button);
    });

    this.resetMonsterButton = this.surface
      .button(
        '恢复默认',
        PRESSURE_DEBUG_LAYOUT.leftActionX,
        PRESSURE_DEBUG_LAYOUT.actionsY,
        PRESSURE_DEBUG_LAYOUT.leftActionWidth,
        PRESSURE_DEBUG_LAYOUT.actionHeight,
        () => this.resetMonsterDefaults(),
        { parent: this.monsterPane },
      )
      .setData('label', '恢复默认');

    this.surface.button(
      '关闭',
      PRESSURE_DEBUG_LAYOUT.rightActionX,
      PRESSURE_DEBUG_LAYOUT.actionsY,
      PRESSURE_DEBUG_LAYOUT.rightActionWidth,
      PRESSURE_DEBUG_LAYOUT.actionHeight,
      () => onClose(),
      { parent: this.monsterPane },
    );

    this.applyTabVisuals();
    this.applyClassVisuals();
    this.applyMonsterVisuals();
    this.layout();
  }

  get currentTab(): PressureDebugTab {
    return this.activeTab;
  }

  get selectedClassId(): string {
    return this.selectedId;
  }

  /** 数字输入卡打开时由它自己接管 Escape 与 Enter。 */
  get prompting(): boolean {
    return this.numberPrompt.active;
  }

  /** 切换顶部页签，只更新容器显隐与按钮选中态，不重建 DOM。 */
  selectTab(tab: PressureDebugTab): void {
    if (this.disposed || this.activeTab === tab) return;
    this.numberPrompt.close();
    this.cancelStepPresses();
    this.activeTab = tab;
    this.applyTabVisuals();
    if (tab === 'monster') this.applyMonsterVisuals();
  }

  /** 就地切换选中职业与确认按钮可用态，不销毁或重建任何 DOM 节点。 */
  selectClass(classId: string): void {
    if (this.disposed || !this.cards.has(classId) || this.selectedId === classId) return;
    this.selectedId = classId;
    this.applyClassVisuals();
  }

  private stepMaxEnemies(delta: number): void {
    this.applyMaxEnemies(this.maxEnemies + delta);
  }

  private applyMaxEnemies(value: number): void {
    if (this.disposed) return;
    const next = normalizePressureMaxEnemies(value);
    if (next === this.maxEnemies) {
      this.applyMonsterVisuals();
      return;
    }
    this.maxEnemies = next;
    this.onUpdateSettings({ maxEnemies: next });
    this.applyMonsterVisuals();
  }

  private applyEnemyMaxHealth(value: number | undefined): void {
    if (this.disposed) return;
    const next = normalizePressureEnemyHealth(value);
    this.enemyMaxHealth = next;
    this.onUpdateSettings({ enemyMaxHealth: next });
    this.applyMonsterVisuals();
  }

  private resetMonsterDefaults(): void {
    if (this.disposed) return;
    this.maxEnemies = PRESSURE_DEFAULT_MAX_ENEMIES;
    this.enemyMaxHealth = undefined;
    this.onUpdateSettings({ maxEnemies: this.maxEnemies, enemyMaxHealth: undefined });
    this.applyMonsterVisuals();
  }

  private openCountPrompt(): void {
    if (this.disposed) return;
    this.cancelStepPresses();
    this.numberPrompt.show({
      title: '怪物数量上限',
      hint: `可输入 ${PRESSURE_MIN_ENEMIES} – ${PRESSURE_MAX_ENEMIES_LIMIT}`,
      initial: this.maxEnemies,
      minimum: PRESSURE_MIN_ENEMIES,
      maximum: PRESSURE_MAX_ENEMIES_LIMIT,
      scale: () => this.surface.root.getWorldTransformMatrix().scaleX || 1,
      onConfirm: value => this.applyMaxEnemies(value),
      onCancel: () => {},
    });
  }

  private openHealthPrompt(): void {
    if (this.disposed) return;
    this.cancelStepPresses();
    this.numberPrompt.show({
      title: '设定怪物血量',
      hint: `可输入 ${PRESSURE_MIN_HEALTH} – ${formatNumber(PRESSURE_MAX_HEALTH_LIMIT)}`,
      initial: this.enemyMaxHealth ?? 10_000,
      minimum: PRESSURE_MIN_HEALTH,
      maximum: PRESSURE_MAX_HEALTH_LIMIT,
      scale: () => this.surface.root.getWorldTransformMatrix().scaleX || 1,
      onConfirm: value => this.applyEnemyMaxHealth(value),
      onCancel: () => {},
    });
  }

  private cancelStepPresses(): void {
    this.countMinusButton.cancelPress();
    this.countPlusButton.cancelPress();
  }

  private applyTabVisuals(): void {
    this.classPane.setVisible(this.activeTab === 'class');
    this.monsterPane.setVisible(this.activeTab === 'monster');
    for (const [tab, button] of this.tabButtons) {
      button.getData('setSelected')?.(tab === this.activeTab);
    }
  }

  private applyClassVisuals(): void {
    for (const card of this.cards.values()) {
      const selected = card.id === this.selectedId;
      if (card.selectionGlow.visible !== selected) card.selectionGlow.setVisible(selected);
      card.button.setData('selected', selected);
      card.label.element.style.color = selected ? GOLD : MUTED;
    }
    this.confirmClassButton.getData('setEnabled')?.(this.selectedId !== this.currentClassId);
  }

  private applyMonsterVisuals(): void {
    (this.countValueButton.getData('labelText') as UiText | undefined)?.setText(`${this.maxEnemies} 只`);
    this.countMinusButton.getData('setEnabled')?.(this.maxEnemies > PRESSURE_MIN_ENEMIES);
    this.countPlusButton.getData('setEnabled')?.(this.maxEnemies < PRESSURE_MAX_ENEMIES_LIMIT);
    this.liveCountText.setText(`当前场上：${this.getLiveEnemyCount()} 只`);
    for (const [preset, button] of this.countPresetButtons) {
      button.getData('setSelected')?.(preset === this.maxEnemies);
    }

    const isDefaultHealth = this.enemyMaxHealth === undefined;
    this.healthDefaultButton.getData('setSelected')?.(isDefaultHealth);
    (this.healthValueButton.getData('labelText') as UiText | undefined)?.setText(
      isDefaultHealth ? '自定义血量' : formatNumber(this.enemyMaxHealth!),
    );
    this.healthValueButton.getData('setSelected')?.(!isDefaultHealth);
    this.healthModeText.setText(isDefaultHealth ? '原版公式' : '固定血量');
    this.healthModeText.element.style.color = isDefaultHealth ? MUTED : CURRENT_TAG;
    for (const [preset, button] of this.healthPresetButtons) {
      button.getData('setSelected')?.(!isDefaultHealth && preset === this.enemyMaxHealth);
    }

    const atDefault = this.maxEnemies === PRESSURE_DEFAULT_MAX_ENEMIES && isDefaultHealth;
    this.resetMonsterButton.getData('setEnabled')?.(!atDefault);
  }

  setVisible(shown: boolean): void {
    if (this.disposed) return;
    if (!shown) {
      this.numberPrompt.close();
      this.cancelStepPresses();
    }
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
    if (this.disposed || this.numberPrompt.active) return false;
    return this.surface.key(event);
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.numberPrompt.close();
    this.cancelStepPresses();
    this.controller.abort();
    this.releaseAssets?.();
    this.releaseAssets = undefined;
    this.cards.clear();
    this.tabButtons.clear();
    this.countPresetButtons.clear();
    this.healthPresetButtons.clear();
    this.surface.destroy();
    this.backdrop.destroy();
  }
}

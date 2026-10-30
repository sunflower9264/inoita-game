import Phaser from 'phaser';
import type { Hud } from '../../rendering/hud.ts';
import type { ControlSkin } from '../../domain/control-skin.ts';
import type { Cooldown } from '../../domain/combat.ts';
import { SHORTCUT_SLOT_COUNT } from '../../domain/shortcut-bar.ts';
import { controlViewport } from './control-layout-viewport.ts';
import { uiImageFor } from './widgets.ts';
import { FONT } from '../text-style.ts';
import { cooldownFanState, cooldownSecondsLabel, drawCooldownFan, shortcutCooldown } from './cooldown-fan.ts';
import type { ShortcutSlot } from './action-controls.ts';

const FRAME_SIZE = 80, ICON_SIZE = 64, GAP = 8;
const ROW_WIDTH = SHORTCUT_SLOT_COUNT * FRAME_SIZE + (SHORTCUT_SLOT_COUNT - 1) * GAP;

interface Cell {
  container: Phaser.GameObjects.Container;
  icon?: Phaser.GameObjects.Image;
  fan: Phaser.GameObjects.Graphics;
  seconds: Phaser.GameObjects.Text;
  quantity: Phaser.GameObjects.Text;
  iconKey?: string;
  fanState?: string;
}

/**
 * 电脑模式专用的只读技能状态行：只显示六个快捷位的图标和冷却。
 * 它不接收操作，只拦掉落在这一行上的鼠标点击，避免误触发地面普攻。
 */
export class ComputerSkillHud {
  private readonly scene: Phaser.Scene;
  private readonly hud: Hud;
  private readonly root: Phaser.GameObjects.Container;
  private readonly cells: Cell[] = [];
  private slots: readonly ShortcutSlot[] = [];
  private cooldowns: Readonly<Record<string, Cooldown>> = {};
  private pageSignature?: string;
  private cooldownSignature?: string;

  constructor(_owner: Phaser.Scene, hud: Hud, skin: ControlSkin) {
    this.hud = hud; this.scene = hud.scene;
    this.root = hud.add(this.scene.add.container(0, 0));

    for (let index = 0; index < SHORTCUT_SLOT_COUNT; index++) {
      const container = this.scene.add.container(-ROW_WIDTH / 2 + FRAME_SIZE / 2 + index * (FRAME_SIZE + GAP), 0);
      const shadow = this.scene.add.image(0, 0, skin['slot-shadow']).setDisplaySize(FRAME_SIZE, FRAME_SIZE);
      const ring = this.scene.add.image(0, 0, skin['slot-ring']).setDisplaySize(FRAME_SIZE, FRAME_SIZE);
      const fan = this.scene.add.graphics();
      const seconds = this.scene.add.text(0, 0, '', {
        fontFamily: FONT, fontSize: 24, color: '#ffffff', resolution: 3
      }).setOrigin(.5).setShadow(1, 1, '#000000', 2);
      const quantity = this.scene.add.text(FRAME_SIZE / 2 - 10, FRAME_SIZE / 2 - 8, '', {
        fontFamily: FONT, fontSize: 18, color: '#ffffff', resolution: 3
      }).setOrigin(1, 1).setShadow(1, 1, '#000000', 2);
      container.add([shadow, ring, fan, seconds, quantity]);
      this.root.add(container);
      this.cells.push({ container, fan, seconds, quantity });
    }

    // 整行拦点击：HUD 在 controls-ui 场景，交互对象会让这次点击停在这一层。
    this.root.setSize(ROW_WIDTH + 24, 210)
      .setInteractive(new Phaser.Geom.Rectangle(-ROW_WIDTH / 2 - 12, -96, ROW_WIDTH + 24, 210), Phaser.Geom.Rectangle.Contains)
      .setData('uiAction', true);
    this.root.on('pointerdown', (_pointer: Phaser.Input.Pointer, _x: number, _y: number,
      event: Phaser.Types.Input.EventData) => event.stopPropagation());
    this.setVisible(false);
  }

  /** 世界场景每帧算好的当前一页；签名没变就不重建图标和数量。 */
  setPage(slots: readonly ShortcutSlot[]): void {
    const signature = slots.map(slot => slot.entry
      ? `${slot.entry.kind}:${slot.entry.id}:${slot.icon ?? ''}:${slot.quantity}:${slot.enabled ? 1 : 0}:${slot.cooldown?.remainingMs ?? 0}/${slot.cooldown?.durationMs ?? 0}`
      : '_').join('|');
    if (signature === this.pageSignature) return;
    this.pageSignature = signature;
    this.slots = slots;
    this.paint();
  }

  /** 技能冷却与操作按钮同源；读数没变就跳过整行重画。 */
  setCooldowns(cooldowns: Readonly<Record<string, Cooldown>>): void {
    if (cooldowns === this.cooldowns) return;
    const signature = Object.keys(cooldowns).sort().map(id => `${id}:${cooldowns[id].remainingMs}`).join('|');
    if (signature === this.cooldownSignature) return;
    this.cooldownSignature = signature; this.cooldowns = cooldowns;
    this.paint();
  }

  layout(width: number, height: number): void {
    const viewport = controlViewport(this.scene, width, height);
    const safeWidth = Math.max(1, width - viewport.insets.left - viewport.insets.right);
    // 最多占安全区七成宽，窄屏时给左右状态面板留出位置。
    const scale = Math.max(.5, Math.min(1, safeWidth * .7 / (ROW_WIDTH + 24)));
    this.root.setScale(scale)
      .setPosition(viewport.insets.left + safeWidth / 2, height - viewport.insets.bottom - 94 * scale);
  }

  setVisible(visible: boolean): void {
    this.hud.setVisible(this.root, visible);
  }

  destroy(): void {
    this.root.destroy(true);
  }

  private paint(): void {
    this.cells.forEach((cell, index) => {
      const slot = this.slots[index];
      this.paintIcon(cell, slot?.icon);
      const cooldown = shortcutCooldown(slot, this.cooldowns);
      const state = cooldownFanState(cooldown, ICON_SIZE / 2);
      if (cell.fanState !== state) {
        cell.fanState = state;
        drawCooldownFan(cell.fan, ICON_SIZE / 2, cooldown);
      }
      const seconds = cooldownSecondsLabel(cooldown?.remainingMs ?? 0);
      if (cell.seconds.text !== seconds) cell.seconds.setText(seconds);

      const isItem = slot?.entry?.kind === 'item';
      const quantity = isItem && slot ? String(slot.quantity) : '';
      if (cell.quantity.text !== quantity) cell.quantity.setText(quantity);

      const cooling = (cooldown?.remainingMs ?? 0) > 0;
      const usable = !!slot?.entry && !cooling && (isItem ? (slot?.quantity ?? 0) > 0 : !!slot?.enabled);
      const alpha = cooling ? .45 : usable ? 1 : .4;
      cell.icon?.setAlpha(alpha);
      cell.quantity.setAlpha(alpha);
    });
  }

  private paintIcon(cell: Cell, file: string | undefined): void {
    if (!file) {
      cell.icon?.setVisible(false);
      cell.iconKey = undefined;
      return;
    }
    const ref = uiImageFor(this.scene, file);
    if (!this.scene.textures.exists(ref.key)) { cell.icon?.setVisible(false); cell.iconKey = undefined; return; }
    if (!cell.icon) {
      cell.icon = this.scene.add.image(0, 0, ref.key, ref.frame);
      cell.container.addAt(cell.icon, 2);
    } else if (cell.iconKey !== `${ref.key}:${ref.frame}`) {
      cell.icon.setTexture(ref.key, ref.frame);
    }
    cell.iconKey = `${ref.key}:${ref.frame}`;
    cell.icon.setDisplaySize(ICON_SIZE, ICON_SIZE).setVisible(true);
  }
}

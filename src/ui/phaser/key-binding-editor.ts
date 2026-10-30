import type Phaser from 'phaser';
import { UI_EVENTS } from '../../application/ui-events.ts';
import type { KeyBindingPreferences } from '../../application/key-bindings.ts';
import { KEY_ACTION_LABELS, bindingFromEvent, formatBinding, type KeyBindingAction } from '../../domain/key-bindings.ts';
import { UiSurface } from './widgets.ts';

/** 左列：移动、切组、菜单；右列：六个快捷位。两列各六行。 */
const LEFT_ACTIONS: readonly KeyBindingAction[] = ['move.up', 'move.down', 'move.left', 'move.right', 'wheel.next', 'menu'];
const RIGHT_ACTIONS: readonly KeyBindingAction[] = ['skill.1', 'skill.2', 'skill.3', 'skill.4', 'skill.5', 'skill.6'];
const ROW_TOP = 150, ROW_HEIGHT = 56, BUTTON_WIDTH = 160, BUTTON_HEIGHT = 46;

/**
 * 设置里的键位编辑面板。点击某个动作后按下新键；冲突或保留键直接显示原因，
 * 成功的绑定立即生效并写入本机存储。
 */
export class KeyBindingEditor {
  private readonly scene: Phaser.Scene;
  private readonly preferences: KeyBindingPreferences;
  private readonly assets: Record<string, string>;
  private readonly onClose: () => void;
  private readonly canvas: UiSurface;
  private active = false;
  private capture?: KeyBindingAction;
  private notice = '';

  constructor(scene: Phaser.Scene, preferences: KeyBindingPreferences, assets: Record<string, string>, onClose: () => void) {
    this.scene = scene; this.preferences = preferences; this.assets = assets; this.onClose = onClose;
    this.canvas = new UiSurface(scene, 960, 640, 350);
    scene.game.events.on(UI_EVENTS.cancelInput, this.cancelCapture, this);
    scene.input.on('gameout', this.cancelCapture, this);
    this.visible(false);
  }

  open(): void {
    this.active = true; this.capture = undefined; this.notice = '';
    this.render(); this.canvas.visible(true); this.layout();
  }

  /** 只隐藏并清捕获，不清空面板：避免在按钮自己的 pointerup 里销毁对象。 */
  close(): void {
    this.active = false; this.capture = undefined; this.canvas.visible(false);
  }

  visible(value: boolean): void {
    if (!value) this.cancelCapture();
    this.canvas.visible(value && this.active);
  }

  layout(): void { this.canvas.layout(12); }

  key(event: KeyboardEvent): void {
    const capture = this.capture;
    if (capture) {
      if (event.key === 'Escape') {
        event.preventDefault(); this.capture = undefined; this.notice = ''; this.render(); return;
      }
      const binding = bindingFromEvent(event);
      // 单独的修饰键和输入法合成中的按键不当作一次输入。
      if (!binding) return;
      // 捕获期间拦掉浏览器默认动作，Tab、F5 这类键不会在改键途中有副作用。
      event.preventDefault();
      const error = this.preferences.set(capture, binding);
      if (error) { this.notice = `${formatBinding(binding)}：${error}`; this.render(); return; }
      this.capture = undefined; this.notice = `已绑定：${formatBinding(binding)}`; this.render(); return;
    }
    if (event.key === 'Escape') { event.preventDefault(); this.onClose(); return; }
    this.canvas.key(event);
  }

  destroy(): void {
    this.scene.game.events.off(UI_EVENTS.cancelInput, this.cancelCapture, this);
    this.scene.input.off('gameout', this.cancelCapture, this);
    this.canvas.destroy();
  }

  private readonly cancelCapture = (): void => {
    if (this.capture === undefined) return;
    this.capture = undefined; this.notice = ''; this.render();
  };

  private beginCapture(action: KeyBindingAction): void {
    this.capture = action; this.notice = ''; this.render();
  }

  private render(): void {
    const v = this.canvas;
    v.clear();
    // 只画外框，不填深色底板：键位页和“操作设置”一样透出后面的游戏画面。
    v.border(this.assets, 0, 0, 960, 640);
    v.text('键位设置', 480, 24, 0, 34).setOrigin(.5, 0);
    v.text('点击动作后按下新按键；鼠标左键攻击固定', 480, 76, 0, 20).setOrigin(.5, 0);
    v.text('移动与轮组', 60, 120, 0, 24);
    v.text('技能与快捷位', 500, 120, 0, 24);
    this.paintColumn(LEFT_ACTIONS, 60);
    this.paintColumn(RIGHT_ACTIONS, 500);
    if (this.notice) v.text(this.notice, 480, 486, 880, 20, '#eb9587').setOrigin(.5, 0);
    v.button('恢复默认', 260, 528, 200, 52, () => {
      this.capture = undefined; this.preferences.reset(); this.notice = '已恢复默认键位'; this.render();
    });
    v.button('返回', 510, 528, 160, 52, () => this.onClose());
    v.button('', 881, 12, 67, 67, () => this.onClose(), { image: this.assets.close, pressed: this.assets['close-pressed'] })
      .setData('label', '关闭键位设置');
    v.text('Ctrl/Alt/Command 组合和 F1–F12 由浏览器或系统占用', 480, 598, 900, 16).setOrigin(.5, 0);
  }

  private paintColumn(actions: readonly KeyBindingAction[], left: number): void {
    actions.forEach((action, index) => {
      const top = ROW_TOP + index * ROW_HEIGHT;
      const capturing = this.capture === action;
      const text = capturing ? '按下按键…' : formatBinding(this.preferences.get(action));
      this.canvas.text(KEY_ACTION_LABELS[action], left, top + 12, 0, 22);
      this.canvas.button(text, left + 260, top, BUTTON_WIDTH, BUTTON_HEIGHT, () => this.beginCapture(action), {
        fontSize: 20, selected: capturing
      }).setData('label', `${KEY_ACTION_LABELS[action]}：${text}`);
    });
  }
}

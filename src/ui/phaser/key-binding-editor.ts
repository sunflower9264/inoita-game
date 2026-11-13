import type Phaser from 'phaser';
import { UI_EVENTS } from '../../application/ui-events.ts';
import type { KeyBindingPreferences } from '../../application/key-bindings.ts';
import { KEY_ACTION_LABELS, bindingFromEvent, formatBinding, type KeyBindingAction } from '../../domain/key-bindings.ts';
import type { DomLabel, DomUi } from '../dom/dom-ui.ts';
import type { UiNode } from '../dom/node.ts';
import { GOLD, UiSurface } from './widgets.ts';

/** 左列：移动、切人、切组、菜单；右列：六个快捷位。 */
const LEFT_ACTIONS: readonly KeyBindingAction[] = [
  'move.up', 'move.down', 'move.left', 'move.right',
  'party.previous', 'party.next', 'wheel.next', 'menu'
];
const RIGHT_ACTIONS: readonly KeyBindingAction[] = ['skill.1', 'skill.2', 'skill.3', 'skill.4', 'skill.5', 'skill.6'];
const ROW_TOP = 148, ROW_HEIGHT = 42, BUTTON_WIDTH = 160, BUTTON_HEIGHT = 36;
const ACTION_BUTTON_FONT = 18, FOOTER_BUTTON_HEIGHT = 52;
const FOOTER_BUTTON_FONT = Math.min(22, FOOTER_BUTTON_HEIGHT * .42);

/** 一条待输出的 DOM 文字；坐标是 960×640 面板坐标。 */
interface DomTextSpec {
  key: string; text: string; x: number; y: number; size: number;
  color: string; anchorX: number; anchorY: number; width?: number;
  align: 'left' | 'center' | 'right';
}

/**
 * 设置里的键位编辑面板。点击某个动作后按下新键；冲突或保留键直接显示原因，
 * 成功的绑定立即生效并写入本机存储。
 *
 * 文字统一交给 DOM：面板自己的 `UiSurface` 只负责图框、按钮底图和命中区。
 */
export class KeyBindingEditor {
  private readonly scene: Phaser.Scene;
  private readonly preferences: KeyBindingPreferences;
  private readonly assets: Record<string, string>;
  private readonly onClose: () => void;
  private readonly canvas: UiSurface;
  private readonly dom?: Pick<DomUi, 'label'>;
  private readonly domLabels = new Map<string, DomLabel>();
  private domSpecs: DomTextSpec[] = [];
  private bindingButtons=new Map<KeyBindingAction,UiNode>();
  private active = false;
  private capture?: KeyBindingAction;
  private notice = '';

  constructor(scene: Phaser.Scene, preferences: KeyBindingPreferences, assets: Record<string, string>,
    onClose: () => void, dom?: Pick<DomUi, 'label'>) {
    this.scene = scene; this.preferences = preferences; this.assets = assets; this.onClose = onClose; this.dom = dom;
    this.canvas = new UiSurface(scene, 960, 640, 350);
    scene.game.events.on(UI_EVENTS.cancelInput, this.cancelCapture, this);
    window.addEventListener('blur', this.cancelCapture);
    window.addEventListener('pointercancel', this.cancelCapture);
    this.visible(false);
  }

  open(): void {
    this.active = true; this.capture = undefined; this.notice = '';
    this.render(); this.canvas.visible(true); this.layout();
  }

  /** 只隐藏并清捕获，不清空面板：避免在按钮自己的 pointerup 里销毁对象。 */
  close(): void {
    this.active = false; this.capture = undefined; this.canvas.visible(false); this.applyDom();
  }

  visible(value: boolean): void {
    if (!value) this.cancelCapture();
    this.canvas.visible(value && this.active);
    this.applyDom();
  }

  layout(): void { this.canvas.layout(12); this.applyDom(); }

  key(event: KeyboardEvent): void {
    const capture = this.capture;
    if (capture) {
      if (event.key === 'Escape') {
        event.preventDefault(); this.capture = undefined; this.notice = ''; this.refreshBindings(); return;
      }
      const binding = bindingFromEvent(event);
      // 单独的修饰键和输入法合成中的按键不当作一次输入。
      if (!binding) return;
      // 捕获期间拦掉浏览器默认动作，Tab、F5 这类键不会在改键途中有副作用。
      event.preventDefault();
      const error = this.preferences.set(capture, binding);
      if (error) { this.notice = `${formatBinding(binding)}：${error}`; this.refreshBindings(); return; }
      this.capture = undefined; this.notice = `已绑定：${formatBinding(binding)}`; this.refreshBindings(); return;
    }
    if (event.key === 'Escape') { event.preventDefault(); this.onClose(); return; }
    this.canvas.key(event);
  }

  destroy(): void {
    this.scene.game.events.off(UI_EVENTS.cancelInput, this.cancelCapture, this);
    window.removeEventListener('blur', this.cancelCapture);
    window.removeEventListener('pointercancel', this.cancelCapture);
    this.canvas.destroy();
    for (const label of this.domLabels.values()) label.remove();
    this.domLabels.clear();
    this.domSpecs = [];
  }

  private readonly cancelCapture = (): void => {
    if (this.capture === undefined) return;
    this.capture = undefined; this.notice = ''; this.refreshBindings();
  };

  private beginCapture(action: KeyBindingAction): void {
    this.capture = action; this.notice = ''; this.refreshBindings();
  }

  private render(): void {
    const v = this.canvas;
    v.clear();
    this.domSpecs = [];this.bindingButtons.clear();
    // 桌面键位页是独立整页，铺深色底板；透明底会让文字和按钮跟游戏画面混在一起。
    v.frame(this.assets, 0, 0, 960, 640);
    this.pushText('title', '键位设置', 480, 24, 34, GOLD, .5, 0);
    this.pushText('hint', '点击动作后按下新按键；鼠标左键攻击固定', 480, 76, 20, GOLD, .5, 0);
    this.pushText('column-left', '移动与切换', 60, 116, 24);
    this.pushText('column-right', '技能与快捷位', 500, 116, 24);
    this.paintColumn(LEFT_ACTIONS, 60);
    this.paintColumn(RIGHT_ACTIONS, 500);
    this.pushText('notice', this.notice, 480, 490, 20, '#eb9587', .5, 0, 880, 'center');
    v.button('', 260, 528, 200, FOOTER_BUTTON_HEIGHT, () => {
      this.capture = undefined; this.preferences.reset(); this.notice = '已恢复默认键位'; this.refreshBindings();
    }).setData('label', '恢复默认');
    this.pushText('restore', '恢复默认', 360, 528 + FOOTER_BUTTON_HEIGHT / 2, FOOTER_BUTTON_FONT, GOLD, .5, .5);
    v.button('', 510, 528, 160, FOOTER_BUTTON_HEIGHT, () => this.onClose()).setData('label', '返回');
    this.pushText('back', '返回', 590, 528 + FOOTER_BUTTON_HEIGHT / 2, FOOTER_BUTTON_FONT, GOLD, .5, .5);
    v.button('', 881, 12, 67, 67, () => this.onClose(), { image: this.assets.close, pressed: this.assets['close-pressed'] })
      .setData('label', '关闭键位设置');
    this.pushText('footer', 'Ctrl/Alt/Command 组合和 F1–F12 由浏览器或系统占用', 480, 598, 16, GOLD, .5, 0, 900, 'center');
    this.applyDom();
  }

  private refreshBindings():void {
    for(const [action,button] of this.bindingButtons){
      const capturing=this.capture===action,text=capturing?'按下按键…':formatBinding(this.preferences.get(action));
      button.setData('label',`${KEY_ACTION_LABELS[action]}：${text}`);
      (button.getData('setSelected') as (value:boolean)=>void)(capturing);
      const spec=this.domSpecs.find(value=>value.key===`binding-${action}`);if(spec)spec.text=text;
    }
    const notice=this.domSpecs.find(value=>value.key==='notice');if(notice)notice.text=this.notice;
    this.applyDom();
  }

  private paintColumn(actions: readonly KeyBindingAction[], left: number): void {
    actions.forEach((action, index) => {
      const top = ROW_TOP + index * ROW_HEIGHT;
      const capturing = this.capture === action;
      const text = capturing ? '按下按键…' : formatBinding(this.preferences.get(action));
      this.pushText(`action-${action}`, KEY_ACTION_LABELS[action], left, top + 8, 20);
      const button=this.canvas.button('', left + 260, top, BUTTON_WIDTH, BUTTON_HEIGHT, () => this.beginCapture(action), {
        fontSize: ACTION_BUTTON_FONT, selected: capturing
      }).setData('label', `${KEY_ACTION_LABELS[action]}：${text}`);this.bindingButtons.set(action,button);
      this.pushText(`binding-${action}`, text, left + 260 + BUTTON_WIDTH / 2, top + BUTTON_HEIGHT / 2,
        ACTION_BUTTON_FONT, GOLD, .5, .5, BUTTON_WIDTH - 12, 'center');
    });
  }

  private pushText(key: string, text: string, x: number, y: number, size: number, color = GOLD,
    anchorX = 0, anchorY = 0, width?: number, align: DomTextSpec['align'] = 'left'): void {
    this.domSpecs.push({ key, text, x, y, size, color, anchorX, anchorY, width, align });
  }

  /** 把面板坐标里的文字规格投影到画框 CSS 坐标；面板隐藏时一并收起。 */
  private applyDom(): void {
    const dom = this.dom;
    if (!dom) return;
    const matrix = this.canvas.root.getWorldTransformMatrix();
    const shown = this.canvas.root.visible;
    const seen = new Set<string>();
    for (const spec of this.domSpecs) {
      seen.add(spec.key);
      let label = this.domLabels.get(spec.key);
      if (!label) {
        label = dom.label('screen', 'dom-key-binding-text', { x: spec.anchorX, y: spec.anchorY });
        this.domLabels.set(spec.key, label);
      }
      const point = matrix.transformPoint(spec.x, spec.y);
      const scale = matrix.scaleX;
      label.setText(spec.text).setAnchor(spec.anchorX, spec.anchorY).setPosition(point.x, point.y)
        .setStyle({ fontSize: `${Math.max(1, spec.size * scale)}px`, color: spec.color,
          lineHeight: `${(spec.size + 5) * scale}px`, textAlign: spec.align });
      if (spec.width !== undefined) {
        label.setStyle({ width: `${spec.width * scale}px`, whiteSpace: 'pre-wrap', overflowWrap: 'break-word' });
      } else {
        label.setStyle({ width: '', whiteSpace: 'nowrap', overflowWrap: 'normal' });
      }
      label.setVisible(shown);
    }
    for (const [key, label] of this.domLabels) {
      if (seen.has(key)) continue;
      label.remove();
      this.domLabels.delete(key);
    }
  }
}

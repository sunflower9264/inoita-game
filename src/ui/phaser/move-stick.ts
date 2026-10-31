import Phaser from 'phaser';
import { CONTROL_SIZES, ControlLayoutPreferences, resolveControlLayout } from '../control-layout.ts';
import { controlViewport } from './control-layout-viewport.ts';
import type { ControlSkin } from '../../domain/control-skin.ts';
import type { Hud } from '../../rendering/hud.ts';
import { controlSettings, type ControlMode, type MoveControlStyle } from '../../application/control-settings.ts';
import { keyBindings as defaultKeyBindings, type KeyBindingPreferences } from '../../application/key-bindings.ts';
import { MOVE_BINDING_ACTIONS, type KeyBindingAction } from '../../domain/key-bindings.ts';

/** 原版摇杆尺寸参数 */
const STICK_BASE_RADIUS = CONTROL_SIZES.move.width / 2;
export const STICK_KNOB_RADIUS = 35;
const STICK_KNOB_LIMIT = STICK_BASE_RADIUS * 0.6;
const STICK_DEAD_ZONE = 8.75;

/** 符文十字按键参数：圆盘可见直径与热区共用同一份 274。 */
export const DPAD_BASE_RADIUS = CONTROL_SIZES.moveDpad.width / 2;
export const DPAD_RUNE_ALPHA = 0.75;
export const DPAD_ARROW_OFFSET = 73, DPAD_ARROW_SCALE_NORM = 1.14;
const DPAD_ARROW_SCALE_GLOW = 1.25;
const DPAD_DEAD_ZONE = 12;

type CardinalDir = 'up' | 'down' | 'left' | 'right';

function dirToVector(dir: CardinalDir): { x: number; y: number } {
  switch (dir) {
    case 'up': return { x: 0, y: -1 };
    case 'down': return { x: 0, y: 1 };
    case 'left': return { x: -1, y: 0 };
    case 'right': return { x: 1, y: 0 };
  }
}

/** 移动动作与屏幕方向的对应；键位本身由玩家的绑定决定。 */
const MOVE_ACTION_DIRECTIONS: readonly [KeyBindingAction, CardinalDir][] = MOVE_BINDING_ACTIONS.map(action =>
  [action, action.slice(5) as CardinalDir] as const);

/**
 * 屏幕左下角的移动控制器：
 * - 支持两种模式自由切换：经典虚拟摇杆（自由 360°）与符文四向十字按键（严格四向互斥 + 发光反馈）。
 * - 双视图预挂载在同一容器内，切换时直接切显隐与热区半径，避免 Phaser `removeInteractive()` 下一帧异步清空 `input` 的陷阱。
 */
export class MoveStick {
  readonly axis = { x: 0, y: 0 };
  private readonly scene: Phaser.Scene;
  private readonly hud: Hud;
  private readonly skin: ControlSkin;
  private readonly container: Phaser.GameObjects.Container;
  private readonly hitArea: Phaser.Geom.Circle;
  private center = { x: 0, y: 0 };
  private pointerId = -1;
  /** 是否允许接输入；与“外观是否显示”分开，电脑模式隐藏外观后键盘仍可用。 */
  private inputEnabled = true;
  private mode: ControlMode;
  private readonly preferences: ControlLayoutPreferences | undefined;
  private readonly unsubscribePreferences: () => void;
  private readonly unsubscribeMode: () => void;
  private layoutHeight: number | undefined;

  // 虚拟摇杆视图组件
  private readonly stickBase: Phaser.GameObjects.Image;
  private readonly stickKnob: Phaser.GameObjects.Image;

  // 十字按键视图组件
  private readonly dpadBase: Phaser.GameObjects.Image;
  private readonly arrowUp: Phaser.GameObjects.Image;
  private readonly arrowDown: Phaser.GameObjects.Image;
  private readonly arrowLeft: Phaser.GameObjects.Image;
  private readonly arrowRight: Phaser.GameObjects.Image;

  private readonly keyHistory: { dir: CardinalDir; code: string }[] = [];
  private readonly bindings: KeyBindingPreferences;
  private readonly unsubscribeBindings: () => void;
  /** 每个箭头上次用的贴图；同 key 只更新缩放，不重复 setTexture。 */
  private readonly arrowKeys = ['','','',''];

  constructor(scene: Phaser.Scene, hud: Hud, skin: ControlSkin, preferences?: ControlLayoutPreferences,
    bindings: KeyBindingPreferences = defaultKeyBindings) {
    scene = hud.scene; this.scene = scene; this.hud = hud; this.skin = skin; this.preferences = preferences;
    this.bindings = bindings;
    this.mode = controlSettings.mode;
    this.container = hud.add(scene.make.container({ x: 0, y: 0 }, false));

    for (const file of [
      skin['stick-base'], skin.button,
      skin['arrow-up'], skin['arrow-up-glow'],
      skin['arrow-down'], skin['arrow-down-glow'],
      skin['arrow-left'], skin['arrow-left-glow'],
      skin['arrow-right'], skin['arrow-right-glow']
    ]) {
      if (file && scene.textures.exists(file)) scene.textures.get(file).setFilter(Phaser.Textures.FilterMode.LINEAR);
    }

    // 1. 经典虚拟摇杆图层
    this.stickBase = scene.add.image(0, 0, skin['stick-base']).setDisplaySize(STICK_BASE_RADIUS * 2, STICK_BASE_RADIUS * 2);
    this.stickKnob = scene.add.image(0, 0, skin.button).setDisplaySize(STICK_KNOB_RADIUS * 2, STICK_KNOB_RADIUS * 2);

    // 2. 符文四向十字按键图层
    this.dpadBase = scene.add.image(0, 0, skin['stick-base'])
      .setDisplaySize(DPAD_BASE_RADIUS * 2, DPAD_BASE_RADIUS * 2).setAlpha(DPAD_RUNE_ALPHA);
    this.arrowUp = scene.add.image(0, -DPAD_ARROW_OFFSET, skin['arrow-up']).setScale(DPAD_ARROW_SCALE_NORM);
    this.arrowDown = scene.add.image(0, DPAD_ARROW_OFFSET, skin['arrow-down']).setScale(DPAD_ARROW_SCALE_NORM);
    this.arrowLeft = scene.add.image(-DPAD_ARROW_OFFSET, 0, skin['arrow-left']).setScale(DPAD_ARROW_SCALE_NORM);
    this.arrowRight = scene.add.image(DPAD_ARROW_OFFSET, 0, skin['arrow-right']).setScale(DPAD_ARROW_SCALE_NORM);

    this.container.add([
      this.stickBase, this.stickKnob,
      this.dpadBase, this.arrowUp, this.arrowDown, this.arrowLeft, this.arrowRight
    ]);

    // 统一绑定一次交互热区与事件监听（切勿在运行时调用 removeInteractive，否则 Phaser 下一帧会清空 input）
    const initRadius = controlSettings.moveStyle === 'dpad' ? DPAD_BASE_RADIUS : STICK_BASE_RADIUS;
    this.hitArea = new Phaser.Geom.Circle(0, 0, initRadius);
    this.container.setInteractive(this.hitArea, Phaser.Geom.Circle.Contains);
    this.container.on('pointerdown', (pointer: Phaser.Input.Pointer, _x: number, _y: number, event: Phaser.Types.Input.EventData) => {
      event.stopPropagation();
      if (!this.inputEnabled || this.mode === 'keyboard') return;
      if (this.pointerId >= 0 && this.mode === 'stick') return;
      this.pointerId = pointer.id;
      this.track(pointer);
    });

    this.applyTouchStyle(controlSettings.moveStyle);
    this.refreshDisplay();

    this.unsubscribePreferences = preferences?.subscribe(() => {
      if (this.layoutHeight !== undefined) this.layout(this.layoutHeight);
    }) ?? (() => {});

    this.unsubscribeMode = controlSettings.subscribeMode(mode => {
      this.onModeChanged(mode);
    });
    // 改键后立刻生效：清掉按住中的方向，避免旧键的按下状态留在历史里。
    this.unsubscribeBindings = bindings.subscribe(() => this.reset());

    scene.input.on(Phaser.Input.Events.POINTER_MOVE, this.onMove, this);
    scene.input.on(Phaser.Input.Events.POINTER_UP, this.onUp, this);
    scene.input.on(Phaser.Input.Events.POINTER_UP_OUTSIDE, this.onUp, this);
    scene.input.on('gameout', this.onGameOut, this);
    scene.input.keyboard?.on('keydown', this.onKeyDown, this);
    scene.input.keyboard?.on('keyup', this.onKeyUp, this);
  }

  private applyTouchStyle(style: MoveControlStyle): void {
    this.reset();
    const isDpad = style === 'dpad';
    this.hitArea.setTo(0, 0, isDpad ? DPAD_BASE_RADIUS : STICK_BASE_RADIUS);
    this.stickBase.setVisible(!isDpad);
    this.stickKnob.setVisible(!isDpad);
    this.dpadBase.setVisible(isDpad);
    this.arrowUp.setVisible(isDpad);
    this.arrowDown.setVisible(isDpad);
    this.arrowLeft.setVisible(isDpad);
    this.arrowRight.setVisible(isDpad);
  }

  private get displayed(): boolean {
    return this.inputEnabled && this.mode !== 'keyboard';
  }

  private refreshDisplay(): void {
    this.hud.setVisible(this.container, this.displayed);
  }

  private onModeChanged(mode: ControlMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    // applyTouchStyle 会 reset：切到电脑模式时清掉按住中的方向和触摸指针。
    this.applyTouchStyle(controlSettings.moveStyle);
    // 十字键圆盘更大，切换样式后立刻按新尺寸重算位置，不等下一次缩放。
    if (this.layoutHeight !== undefined) this.layout(this.layoutHeight);
    this.refreshDisplay();
  }

  private onMove(pointer: Phaser.Input.Pointer): void {
    if (pointer.id === this.pointerId) this.track(pointer);
  }

  private onUp(pointer: Phaser.Input.Pointer): void {
    if (pointer.id === this.pointerId) this.reset();
  }

  private onGameOut(): void {
    this.keyHistory.length = 0;
    if (this.pointerId < 0) this.syncKeyAxis();
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (!this.inputEnabled || event.isComposing) return;
    const element = globalThis.document?.activeElement as HTMLElement | null;
    if (element && (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA'
      || element.tagName === 'SELECT' || element.isContentEditable)) return;
    const dir = this.directionFor(event);
    if (!dir) return;
    event.preventDefault();
    const code = event.code || event.key;
    // 同一个物理键按住不放会重复触发 keydown；后按优先的规则只看第一次。
    if (this.keyHistory.some(entry => entry.code === code)) return;
    this.keyHistory.push({ dir, code });
    if (this.pointerId < 0) this.syncKeyAxis();
  }

  private directionFor(event: KeyboardEvent): CardinalDir | undefined {
    for (const [action, dir] of MOVE_ACTION_DIRECTIONS)
      if (this.bindings.matches(action, event)) return dir;
    return undefined;
  }

  private onKeyUp(event: KeyboardEvent): void {
    // 只按物理键码移除，不重新匹配修饰键：先松开 Shift 时方向也不会卡住。
    const code = event.code || event.key;
    const index = this.keyHistory.findIndex(entry => entry.code === code);
    if (index < 0) return;
    this.keyHistory.splice(index, 1);
    if (this.pointerId < 0) this.syncKeyAxis();
  }

  private syncKeyAxis(): void {
    const last = this.keyHistory.at(-1);
    if (last && this.inputEnabled) {
      const vec = dirToVector(last.dir);
      this.axis.x = vec.x;
      this.axis.y = vec.y;
    } else {
      this.axis.x = 0;
      this.axis.y = 0;
    }
    this.stickKnob.setPosition(this.axis.x * STICK_KNOB_LIMIT, this.axis.y * STICK_KNOB_LIMIT);
    this.updateArrows();
  }

  private track(pointer: Phaser.Input.Pointer): void {
    const dx = (pointer.x - this.center.x) / this.container.scaleX;
    const dy = (pointer.y - this.center.y) / this.container.scaleY;
    const distance = Math.hypot(dx, dy);

    if (this.mode === 'dpad') {
      if (distance < DPAD_DEAD_ZONE) {
        this.axis.x = 0;
        this.axis.y = 0;
      } else {
        const deg = Math.atan2(dy, dx) * (180 / Math.PI);
        if (deg >= -45 && deg < 45) {
          this.axis.x = 1;
          this.axis.y = 0;
        } else if (deg >= 45 && deg < 135) {
          this.axis.x = 0;
          this.axis.y = 1;
        } else if (deg >= -135 && deg < -45) {
          this.axis.x = 0;
          this.axis.y = -1;
        } else {
          this.axis.x = -1;
          this.axis.y = 0;
        }
      }
      this.updateArrows();
    } else {
      const ratio = Math.min(1, STICK_KNOB_LIMIT / (distance || 1));
      const pushed = distance >= STICK_DEAD_ZONE;
      this.axis.x = pushed ? (dx * ratio) / STICK_KNOB_LIMIT : 0;
      this.axis.y = pushed ? (dy * ratio) / STICK_KNOB_LIMIT : 0;
      this.stickKnob.setPosition(pushed ? dx * ratio : 0, pushed ? dy * ratio : 0);
    }
  }

  private setArrow(index: number, image: Phaser.GameObjects.Image, key: string, scale: number): void {
    if (this.arrowKeys[index] !== key) { this.arrowKeys[index] = key; image.setTexture(key); }
    image.setScale(scale);
  }
  private updateArrows(): void {
    const up = this.axis.y < -0.3;
    const down = this.axis.y > 0.3;
    const left = this.axis.x < -0.3;
    const right = this.axis.x > 0.3;
    this.setArrow(0, this.arrowUp, up ? this.skin['arrow-up-glow'] : this.skin['arrow-up'], up ? DPAD_ARROW_SCALE_GLOW : DPAD_ARROW_SCALE_NORM);
    this.setArrow(1, this.arrowDown, down ? this.skin['arrow-down-glow'] : this.skin['arrow-down'], down ? DPAD_ARROW_SCALE_GLOW : DPAD_ARROW_SCALE_NORM);
    this.setArrow(2, this.arrowLeft, left ? this.skin['arrow-left-glow'] : this.skin['arrow-left'], left ? DPAD_ARROW_SCALE_GLOW : DPAD_ARROW_SCALE_NORM);
    this.setArrow(3, this.arrowRight, right ? this.skin['arrow-right-glow'] : this.skin['arrow-right'], right ? DPAD_ARROW_SCALE_GLOW : DPAD_ARROW_SCALE_NORM);
  }

  /** 松手或流程接管输入时回到中位。 */
  reset(): void {
    this.pointerId = -1;
    this.keyHistory.length = 0;
    this.axis.x = 0;
    this.axis.y = 0;
    this.stickKnob.setPosition(0, 0);
    this.updateArrows();
  }

  layout(height: number): void {
    this.layoutHeight = height;
    const moveSize = controlSettings.moveStyle === 'dpad' ? CONTROL_SIZES.moveDpad : CONTROL_SIZES.move;
    const position = resolveControlLayout(controlViewport(this.scene, this.scene.scale.width, height), this.preferences?.snapshot(), moveSize).move;
    this.center = { x: position.x, y: position.y };
    this.container.setScale(position.scale);
    this.container.setPosition(position.x, position.y);
    this.reset();
  }

  /** 加载中、对话或面板锁住输入、流程挂起时收起摇杆；收起后 Phaser 也不再把它算作点击目标。 */
  setVisible(visible: boolean): void {
    if (this.inputEnabled === visible) return;
    this.inputEnabled = visible;
    if (!visible) this.reset();
    this.refreshDisplay();
  }

  destroy(): void {
    this.unsubscribePreferences();
    this.unsubscribeMode();
    this.unsubscribeBindings();
    this.scene.input.off(Phaser.Input.Events.POINTER_MOVE, this.onMove, this);
    this.scene.input.off(Phaser.Input.Events.POINTER_UP, this.onUp, this);
    this.scene.input.off(Phaser.Input.Events.POINTER_UP_OUTSIDE, this.onUp, this);
    this.scene.input.off('gameout', this.onGameOut, this);
    this.scene.input.keyboard?.off('keydown', this.onKeyDown, this);
    this.scene.input.keyboard?.off('keyup', this.onKeyUp, this);
    this.container.destroy(true);
  }
}

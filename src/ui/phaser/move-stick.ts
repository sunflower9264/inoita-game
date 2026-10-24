import Phaser from 'phaser';
import { ControlLayoutPreferences, resolveControlLayout } from '../control-layout.ts';
import { controlViewport } from './control-layout-viewport.ts';
import type { ControlSkin } from '../../domain/control-skin.ts';
import type { Hud } from '../../rendering/hud.ts';
import { controlSettings, type MoveControlStyle } from '../../application/control-settings.ts';

/** 原版摇杆尺寸参数 */
const STICK_BASE_RADIUS = 105, STICK_KNOB_RADIUS = 35;
const STICK_KNOB_LIMIT = STICK_BASE_RADIUS * 0.6;
const STICK_DEAD_ZONE = 8.75;

/** 符文十字按键参数（放大 30%） */
const DPAD_BASE_RADIUS = 137;
const DPAD_RUNE_SCALE = 1.08, DPAD_RUNE_ALPHA = 0.75;
const DPAD_ARROW_OFFSET = 73, DPAD_ARROW_SCALE_NORM = 1.14, DPAD_ARROW_SCALE_GLOW = 1.25;
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

function keyToCardinal(event: KeyboardEvent): CardinalDir | undefined {
  switch (event.code || event.key) {
    case 'ArrowUp': case 'KeyW': case 'w': case 'W': return 'up';
    case 'ArrowDown': case 'KeyS': case 's': case 'S': return 'down';
    case 'ArrowLeft': case 'KeyA': case 'a': case 'A': return 'left';
    case 'ArrowRight': case 'KeyD': case 'd': case 'D': return 'right';
    default: return undefined;
  }
}

/**
 * 屏幕左下角的移动控制器：
 * - 支持两种模式自由切换：经典虚拟摇杆（自由 360°）与符文四向十字按键（严格四向互斥 + 发光反馈）。
 * - 响应用户在「设置」中的切换，支持多指触控与键盘输入。
 */
export class MoveStick {
  readonly axis = { x: 0, y: 0 };
  private readonly scene: Phaser.Scene;
  private readonly hud: Hud;
  private readonly skin: ControlSkin;
  private readonly container: Phaser.GameObjects.Container;
  private center = { x: 0, y: 0 };
  private isVisible = true;
  private readonly preferences: ControlLayoutPreferences | undefined;
  private readonly unsubscribePreferences: () => void;
  private readonly unsubscribeSettings: () => void;
  private layoutHeight: number | undefined;

  // 虚拟摇杆专用组件与状态
  private stickKnob?: Phaser.GameObjects.Image;
  private stickPointerId = -1;

  // 十字按键专用组件与状态
  private arrowUp?: Phaser.GameObjects.Image;
  private arrowDown?: Phaser.GameObjects.Image;
  private arrowLeft?: Phaser.GameObjects.Image;
  private arrowRight?: Phaser.GameObjects.Image;
  private readonly activeTouches = new Map<number, { x: number; y: number }>();
  private readonly touchHistory: number[] = [];
  private touchAxis = { x: 0, y: 0 };
  private readonly keyHistory: CardinalDir[] = [];

  constructor(scene: Phaser.Scene, hud: Hud, skin: ControlSkin, preferences?: ControlLayoutPreferences) {
    scene = hud.scene; this.scene = scene; this.hud = hud; this.skin = skin; this.preferences = preferences;
    this.container = hud.add(scene.make.container({ x: 0, y: 0 }, false));

    this.initStyle(controlSettings.moveStyle);

    this.unsubscribePreferences = preferences?.subscribe(() => {
      if (this.layoutHeight !== undefined) this.layout(this.layoutHeight);
    }) ?? (() => {});

    this.unsubscribeSettings = controlSettings.subscribe(style => {
      this.rebuild(style);
    });

    scene.input.on(Phaser.Input.Events.POINTER_MOVE, this.onMove, this);
    scene.input.on(Phaser.Input.Events.POINTER_UP, this.onUp, this);
    scene.input.on(Phaser.Input.Events.POINTER_UP_OUTSIDE, this.onUp, this);
    scene.input.on('gameout', this.onGameOut, this);
    scene.input.keyboard?.on('keydown', this.onKeyDown, this);
    scene.input.keyboard?.on('keyup', this.onKeyUp, this);
  }

  private rebuild(style: MoveControlStyle): void {
    this.reset();
    this.container.removeAll(true);
    this.container.removeInteractive();
    this.stickKnob = undefined;
    this.arrowUp = undefined;
    this.arrowDown = undefined;
    this.arrowLeft = undefined;
    this.arrowRight = undefined;
    this.initStyle(style);
    if (this.layoutHeight !== undefined) this.layout(this.layoutHeight);
    this.setVisible(this.isVisible);
  }

  private initStyle(style: MoveControlStyle): void {
    const scene = this.scene, skin = this.skin;
    if (style === 'dpad') {
      for (const file of [
        skin['stick-base'],
        skin['arrow-up'], skin['arrow-up-glow'],
        skin['arrow-down'], skin['arrow-down-glow'],
        skin['arrow-left'], skin['arrow-left-glow'],
        skin['arrow-right'], skin['arrow-right-glow']
      ]) {
        if (file && scene.textures.exists(file)) scene.textures.get(file).setFilter(Phaser.Textures.FilterMode.LINEAR);
      }
      const base = scene.add.image(0, 0, skin['stick-base']).setScale(DPAD_RUNE_SCALE).setAlpha(DPAD_RUNE_ALPHA);
      this.arrowUp = scene.add.image(0, -DPAD_ARROW_OFFSET, skin['arrow-up']).setScale(DPAD_ARROW_SCALE_NORM);
      this.arrowDown = scene.add.image(0, DPAD_ARROW_OFFSET, skin['arrow-down']).setScale(DPAD_ARROW_SCALE_NORM);
      this.arrowLeft = scene.add.image(-DPAD_ARROW_OFFSET, 0, skin['arrow-left']).setScale(DPAD_ARROW_SCALE_NORM);
      this.arrowRight = scene.add.image(DPAD_ARROW_OFFSET, 0, skin['arrow-right']).setScale(DPAD_ARROW_SCALE_NORM);
      this.container.add([base, this.arrowUp, this.arrowDown, this.arrowLeft, this.arrowRight]);
      this.container.setInteractive(new Phaser.Geom.Circle(0, 0, DPAD_BASE_RADIUS), Phaser.Geom.Circle.Contains);
      this.container.on('pointerdown', (pointer: Phaser.Input.Pointer, _x: number, _y: number, event: Phaser.Types.Input.EventData) => {
        event.stopPropagation();
        this.activeTouches.set(pointer.id, { x: pointer.x, y: pointer.y });
        const idx = this.touchHistory.indexOf(pointer.id);
        if (idx >= 0) this.touchHistory.splice(idx, 1);
        this.touchHistory.push(pointer.id);
        this.trackDpadTouch(pointer.x, pointer.y);
      });
    } else {
      for (const file of [skin['stick-base'], skin.button]) {
        if (file && scene.textures.exists(file)) scene.textures.get(file).setFilter(Phaser.Textures.FilterMode.LINEAR);
      }
      const base = scene.add.image(0, 0, skin['stick-base']).setDisplaySize(STICK_BASE_RADIUS * 2, STICK_BASE_RADIUS * 2);
      this.stickKnob = scene.add.image(0, 0, skin.button).setDisplaySize(STICK_KNOB_RADIUS * 2, STICK_KNOB_RADIUS * 2);
      this.container.add([base, this.stickKnob]);
      this.container.setInteractive(new Phaser.Geom.Circle(0, 0, STICK_BASE_RADIUS), Phaser.Geom.Circle.Contains);
      this.container.on('pointerdown', (pointer: Phaser.Input.Pointer, _x: number, _y: number, event: Phaser.Types.Input.EventData) => {
        event.stopPropagation();
        if (this.stickPointerId >= 0) return;
        this.stickPointerId = pointer.id;
        this.trackStick(pointer);
      });
    }
  }

  private onMove(pointer: Phaser.Input.Pointer): void {
    if (controlSettings.moveStyle === 'dpad') {
      if (!this.activeTouches.has(pointer.id)) return;
      this.activeTouches.set(pointer.id, { x: pointer.x, y: pointer.y });
      if (this.touchHistory.at(-1) === pointer.id) this.trackDpadTouch(pointer.x, pointer.y);
    } else {
      if (pointer.id === this.stickPointerId) this.trackStick(pointer);
    }
  }

  private onUp(pointer: Phaser.Input.Pointer): void {
    if (controlSettings.moveStyle === 'dpad') {
      if (!this.activeTouches.has(pointer.id)) return;
      this.activeTouches.delete(pointer.id);
      const idx = this.touchHistory.indexOf(pointer.id);
      if (idx >= 0) this.touchHistory.splice(idx, 1);
      if (this.touchHistory.length > 0) {
        const lastId = this.touchHistory.at(-1)!;
        const pos = this.activeTouches.get(lastId)!;
        this.trackDpadTouch(pos.x, pos.y);
      } else {
        this.touchAxis = { x: 0, y: 0 };
        this.syncAxis();
      }
    } else {
      if (pointer.id === this.stickPointerId) this.reset();
    }
  }

  private onGameOut(): void {
    this.keyHistory.length = 0;
    this.syncAxis();
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (!this.isVisible) return;
    const tag = (globalThis.document?.activeElement as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const dir = keyToCardinal(event);
    if (!dir) return;
    const idx = this.keyHistory.indexOf(dir);
    if (idx >= 0) this.keyHistory.splice(idx, 1);
    this.keyHistory.push(dir);
    this.syncAxis();
  }

  private onKeyUp(event: KeyboardEvent): void {
    const dir = keyToCardinal(event);
    if (!dir) return;
    const idx = this.keyHistory.indexOf(dir);
    if (idx >= 0) {
      this.keyHistory.splice(idx, 1);
      this.syncAxis();
    }
  }

  private trackStick(pointer: Phaser.Input.Pointer): void {
    const dx = (pointer.x - this.center.x) / this.container.scaleX;
    const dy = (pointer.y - this.center.y) / this.container.scaleY;
    const distance = Math.hypot(dx, dy);
    const ratio = Math.min(1, STICK_KNOB_LIMIT / (distance || 1));
    const pushed = distance >= STICK_DEAD_ZONE;
    this.axis.x = pushed ? (dx * ratio) / STICK_KNOB_LIMIT : 0;
    this.axis.y = pushed ? (dy * ratio) / STICK_KNOB_LIMIT : 0;
    this.stickKnob?.setPosition(pushed ? dx * ratio : 0, pushed ? dy * ratio : 0);
  }

  private trackDpadTouch(px: number, py: number): void {
    const dx = (px - this.center.x) / this.container.scaleX;
    const dy = (py - this.center.y) / this.container.scaleY;
    const distance = Math.hypot(dx, dy);
    if (distance < DPAD_DEAD_ZONE) {
      this.touchAxis = { x: 0, y: 0 };
    } else {
      const deg = Math.atan2(dy, dx) * (180 / Math.PI);
      if (deg >= -45 && deg < 45) this.touchAxis = { x: 1, y: 0 };
      else if (deg >= 45 && deg < 135) this.touchAxis = { x: 0, y: 1 };
      else if (deg >= -135 && deg < -45) this.touchAxis = { x: 0, y: -1 };
      else this.touchAxis = { x: -1, y: 0 };
    }
    this.syncAxis();
  }

  private syncAxis(): void {
    if (controlSettings.moveStyle === 'dpad') {
      const touchActive = this.activeTouches.size > 0 && (this.touchAxis.x !== 0 || this.touchAxis.y !== 0);
      if (touchActive) {
        this.axis.x = this.touchAxis.x;
        this.axis.y = this.touchAxis.y;
      } else if (this.keyHistory.length > 0 && this.isVisible) {
        const vec = dirToVector(this.keyHistory.at(-1)!);
        this.axis.x = vec.x;
        this.axis.y = vec.y;
      } else {
        this.axis.x = 0;
        this.axis.y = 0;
      }
      this.updateArrows();
    } else {
      if (this.stickPointerId < 0) {
        if (this.keyHistory.length > 0 && this.isVisible) {
          const vec = dirToVector(this.keyHistory.at(-1)!);
          this.axis.x = vec.x;
          this.axis.y = vec.y;
          this.stickKnob?.setPosition(vec.x * STICK_KNOB_LIMIT, vec.y * STICK_KNOB_LIMIT);
        } else {
          this.axis.x = 0;
          this.axis.y = 0;
          this.stickKnob?.setPosition(0, 0);
        }
      }
    }
  }

  private updateArrows(): void {
    if (!this.arrowUp || !this.arrowDown || !this.arrowLeft || !this.arrowRight) return;
    const up = this.axis.y < -0.3;
    const down = this.axis.y > 0.3;
    const left = this.axis.x < -0.3;
    const right = this.axis.x > 0.3;
    this.arrowUp.setTexture(up ? this.skin['arrow-up-glow'] : this.skin['arrow-up']).setScale(up ? DPAD_ARROW_SCALE_GLOW : DPAD_ARROW_SCALE_NORM);
    this.arrowDown.setTexture(down ? this.skin['arrow-down-glow'] : this.skin['arrow-down']).setScale(down ? DPAD_ARROW_SCALE_GLOW : DPAD_ARROW_SCALE_NORM);
    this.arrowLeft.setTexture(left ? this.skin['arrow-left-glow'] : this.skin['arrow-left']).setScale(left ? DPAD_ARROW_SCALE_GLOW : DPAD_ARROW_SCALE_NORM);
    this.arrowRight.setTexture(right ? this.skin['arrow-right-glow'] : this.skin['arrow-right']).setScale(right ? DPAD_ARROW_SCALE_GLOW : DPAD_ARROW_SCALE_NORM);
  }

  reset(): void {
    this.stickPointerId = -1;
    this.activeTouches.clear();
    this.touchHistory.length = 0;
    this.touchAxis = { x: 0, y: 0 };
    this.keyHistory.length = 0;
    this.axis.x = 0;
    this.axis.y = 0;
    this.stickKnob?.setPosition(0, 0);
    this.updateArrows();
  }

  layout(height: number): void {
    this.layoutHeight = height;
    const position = resolveControlLayout(controlViewport(this.scene, this.scene.scale.width, height), this.preferences?.snapshot()).move;
    this.center = { x: position.x, y: position.y };
    this.container.setScale(position.scale);
    this.container.setPosition(position.x, position.y);
    this.reset();
  }

  setVisible(visible: boolean): void {
    this.isVisible = visible;
    this.hud.setVisible(this.container, visible);
    if (!visible) this.reset();
  }

  destroy(): void {
    this.unsubscribePreferences();
    this.unsubscribeSettings();
    this.scene.input.off(Phaser.Input.Events.POINTER_MOVE, this.onMove, this);
    this.scene.input.off(Phaser.Input.Events.POINTER_UP, this.onUp, this);
    this.scene.input.off(Phaser.Input.Events.POINTER_UP_OUTSIDE, this.onUp, this);
    this.scene.input.off('gameout', this.onGameOut, this);
    this.scene.input.keyboard?.off('keydown', this.onKeyDown, this);
    this.scene.input.keyboard?.off('keyup', this.onKeyUp, this);
    this.container.destroy(true);
  }
}

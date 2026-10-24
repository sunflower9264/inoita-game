import Phaser from 'phaser';
import { ControlLayoutPreferences, resolveControlLayout } from '../control-layout.ts';
import { controlViewport } from './control-layout-viewport.ts';
import type { ControlSkin } from '../../domain/control-skin.ts';
import type { Hud } from '../../rendering/hud.ts';

/** 符文控制盘半径、方向箭头偏移与缩放参数（在原版基础上整体放大 30%）。 */
const BASE_RADIUS = 137;
const RUNE_SCALE = 1.08, RUNE_ALPHA = 0.75;
const ARROW_OFFSET = 73, ARROW_SCALE_NORM = 1.14, ARROW_SCALE_GLOW = 1.25;
/** 小于这个距离算没推动（死区 12px），避免手指轻微抖动触发移动。 */
const DEAD_ZONE = 12;

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
 * 屏幕左下角的 1:1 符文移动控制盘（Virtual D-Pad）：
 * - 视觉：半透明符文底盘 + 上/下/左/右 4 个方向箭头（按下时切换发光纹理并放大至 0.96）
 * - 移动方式：严格单键 4 正方向移动（45° 扇区划分，绝不走斜向），支持多指触摸栈与键盘 WASD/方向键单键后按独占栈。
 */
export class MoveStick {
  readonly axis = { x: 0, y: 0 };
  private readonly scene: Phaser.Scene;
  private readonly hud: Hud;
  private readonly skin: ControlSkin;
  private readonly container: Phaser.GameObjects.Container;
  private readonly arrowUp: Phaser.GameObjects.Image;
  private readonly arrowDown: Phaser.GameObjects.Image;
  private readonly arrowLeft: Phaser.GameObjects.Image;
  private readonly arrowRight: Phaser.GameObjects.Image;
  private center = { x: 0, y: 0 };
  private readonly activeTouches = new Map<number, { x: number; y: number }>();
  private readonly touchHistory: number[] = [];
  private touchAxis = { x: 0, y: 0 };
  private readonly keyHistory: CardinalDir[] = [];
  private isVisible = true;
  private readonly preferences: ControlLayoutPreferences | undefined;
  private readonly unsubscribe: () => void;
  private layoutHeight: number | undefined;

  constructor(scene: Phaser.Scene, hud: Hud, skin: ControlSkin, preferences?: ControlLayoutPreferences) {
    scene = hud.scene; this.scene = scene; this.hud = hud; this.skin = skin; this.preferences = preferences;
    this.unsubscribe = preferences?.subscribe(() => { if (this.layoutHeight !== undefined) this.layout(this.layoutHeight); }) ?? (() => {});
    this.container = hud.add(scene.make.container({ x: 0, y: 0 }, false));
    for (const file of [
      skin['stick-base'],
      skin['arrow-up'], skin['arrow-up-glow'],
      skin['arrow-down'], skin['arrow-down-glow'],
      skin['arrow-left'], skin['arrow-left-glow'],
      skin['arrow-right'], skin['arrow-right-glow']
    ]) {
      if (file && scene.textures.exists(file)) scene.textures.get(file).setFilter(Phaser.Textures.FilterMode.LINEAR);
    }
    const base = scene.add.image(0, 0, skin['stick-base']).setScale(RUNE_SCALE).setAlpha(RUNE_ALPHA);
    this.arrowUp = scene.add.image(0, -ARROW_OFFSET, skin['arrow-up']).setScale(ARROW_SCALE_NORM);
    this.arrowDown = scene.add.image(0, ARROW_OFFSET, skin['arrow-down']).setScale(ARROW_SCALE_NORM);
    this.arrowLeft = scene.add.image(-ARROW_OFFSET, 0, skin['arrow-left']).setScale(ARROW_SCALE_NORM);
    this.arrowRight = scene.add.image(ARROW_OFFSET, 0, skin['arrow-right']).setScale(ARROW_SCALE_NORM);
    this.container.add([base, this.arrowUp, this.arrowDown, this.arrowLeft, this.arrowRight]);
    this.container.setInteractive(new Phaser.Geom.Circle(0, 0, BASE_RADIUS), Phaser.Geom.Circle.Contains);
    this.container.on('pointerdown', (pointer: Phaser.Input.Pointer, _x: number, _y: number, event: Phaser.Types.Input.EventData) => {
      event.stopPropagation();
      this.activeTouches.set(pointer.id, { x: pointer.x, y: pointer.y });
      const idx = this.touchHistory.indexOf(pointer.id);
      if (idx >= 0) this.touchHistory.splice(idx, 1);
      this.touchHistory.push(pointer.id);
      this.trackTouch(pointer.x, pointer.y);
    });
    // 手指移出底盘也要继续跟随，支持多指触摸历史栈。
    scene.input.on(Phaser.Input.Events.POINTER_MOVE, this.onMove, this);
    scene.input.on(Phaser.Input.Events.POINTER_UP, this.onUp, this);
    scene.input.on(Phaser.Input.Events.POINTER_UP_OUTSIDE, this.onUp, this);
    scene.input.on('gameout', this.onGameOut, this);
    scene.input.keyboard?.on('keydown', this.onKeyDown, this);
    scene.input.keyboard?.on('keyup', this.onKeyUp, this);
  }
  private onMove(pointer: Phaser.Input.Pointer): void {
    if (!this.activeTouches.has(pointer.id)) return;
    this.activeTouches.set(pointer.id, { x: pointer.x, y: pointer.y });
    if (this.touchHistory.at(-1) === pointer.id) this.trackTouch(pointer.x, pointer.y);
  }
  private onUp(pointer: Phaser.Input.Pointer): void {
    if (!this.activeTouches.has(pointer.id)) return;
    this.activeTouches.delete(pointer.id);
    const idx = this.touchHistory.indexOf(pointer.id);
    if (idx >= 0) this.touchHistory.splice(idx, 1);
    if (this.touchHistory.length > 0) {
      const lastId = this.touchHistory.at(-1)!;
      const pos = this.activeTouches.get(lastId)!;
      this.trackTouch(pos.x, pos.y);
    } else {
      this.touchAxis = { x: 0, y: 0 };
      this.syncAxis();
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
  private trackTouch(px: number, py: number): void {
    const dx = (px - this.center.x) / this.container.scaleX;
    const dy = (py - this.center.y) / this.container.scaleY;
    const distance = Math.hypot(dx, dy);
    if (distance < DEAD_ZONE) {
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
  }
  private updateArrows(): void {
    const up = this.axis.y < -0.3;
    const down = this.axis.y > 0.3;
    const left = this.axis.x < -0.3;
    const right = this.axis.x > 0.3;
    this.arrowUp.setTexture(up ? this.skin['arrow-up-glow'] : this.skin['arrow-up']).setScale(up ? ARROW_SCALE_GLOW : ARROW_SCALE_NORM);
    this.arrowDown.setTexture(down ? this.skin['arrow-down-glow'] : this.skin['arrow-down']).setScale(down ? ARROW_SCALE_GLOW : ARROW_SCALE_NORM);
    this.arrowLeft.setTexture(left ? this.skin['arrow-left-glow'] : this.skin['arrow-left']).setScale(left ? ARROW_SCALE_GLOW : ARROW_SCALE_NORM);
    this.arrowRight.setTexture(right ? this.skin['arrow-right-glow'] : this.skin['arrow-right']).setScale(right ? ARROW_SCALE_GLOW : ARROW_SCALE_NORM);
  }
  /** 松手或流程接管输入时回到中位。 */
  reset(): void {
    this.activeTouches.clear();
    this.touchHistory.length = 0;
    this.touchAxis = { x: 0, y: 0 };
    this.keyHistory.length = 0;
    this.axis.x = 0;
    this.axis.y = 0;
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
  /** 加载中、对话或面板锁住输入、流程挂起时收起摇杆；收起后 Phaser 也不再把它算作点击目标。 */
  setVisible(visible: boolean): void {
    this.isVisible = visible;
    this.hud.setVisible(this.container, visible);
    if (!visible) this.reset();
  }
  destroy(): void {
    this.unsubscribe();
    this.scene.input.off(Phaser.Input.Events.POINTER_MOVE, this.onMove, this);
    this.scene.input.off(Phaser.Input.Events.POINTER_UP, this.onUp, this);
    this.scene.input.off(Phaser.Input.Events.POINTER_UP_OUTSIDE, this.onUp, this);
    this.scene.input.off('gameout', this.onGameOut, this);
    this.scene.input.keyboard?.off('keydown', this.onKeyDown, this);
    this.scene.input.keyboard?.off('keyup', this.onKeyUp, this);
    this.container.destroy(true);
  }
}

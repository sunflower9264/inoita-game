import type { ControlSkin } from '../../domain/control-skin.ts';
import { controlSettings, type ControlMode, type ControlSettings } from '../../application/control-settings.ts';
import type { KeyBindingPreferences } from '../../application/key-bindings.ts';
import { MOVE_BINDING_ACTIONS } from '../../domain/key-bindings.ts';
import { CONTROL_SIZES, resolveControlLayout, type ControlViewport, type ControlLayoutOverrides } from '../control-layout.ts';
import { DomComponent, DomImage } from './components.ts';
import { domAssets, type DomAssets } from './assets.ts';

export const STICK_KNOB_RADIUS = 35;
export const DPAD_BASE_RADIUS = CONTROL_SIZES.moveDpad.width / 2;
export const DPAD_RUNE_ALPHA = .75;
export const DPAD_ARROW_OFFSET = 73, DPAD_ARROW_SCALE_NORM = 1.14;
const KNOB_LIMIT = CONTROL_SIZES.move.width / 2 * .6;
/** 方向盘死区：触摸离中心不足 12 像素不产生方向。 */
const DPAD_DEAD_ZONE = 12;
/** 摇杆死区：不足 8.75 像素回中，避免手指轻碰就移动。 */
const STICK_DEAD_ZONE = 8.75;
/** 方向盘箭头高亮阈值：轴值超过 0.3 视为按下该方向。 */
const AXIS_ACTIVE_THRESHOLD = .3;
/** 方向盘箭头按下时的放大倍率。 */
const DPAD_ARROW_SCALE_ACTIVE = 1.25;
type Direction = 'up' | 'down' | 'left' | 'right';
const vectors: Record<Direction, { x: number; y: number }> = {
  up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 }
};
interface Arrow { root: DomComponent; image: DomImage; file?: string }

/** DOM 移动盘；触摸与键盘共用方向轴，布局、切模式和失去指针时回中。 */
export class DomMoveStick extends DomComponent {
  readonly axis = { x: 0, y: 0 };
  private readonly skin: ControlSkin;
  private readonly settings: ControlSettings;
  private readonly assets: DomAssets;
  private readonly failed: (error: unknown) => void;
  private readonly center: DomComponent;
  private readonly stick: DomComponent;
  private readonly dpad: DomComponent;
  private readonly knob: DomImage;
  private readonly arrows: Arrow[] = [];
  private readonly history: { direction: Direction; code: string }[] = [];
  private pointer?: number;
  private enabled = true;
  private viewport?: ControlViewport;
  private overrides?: ControlLayoutOverrides;
  constructor(parent: HTMLElement, skin: ControlSkin, failed: (error: unknown) => void, settings = controlSettings, assets = domAssets) {
    super(parent); this.skin = skin; this.settings = settings; this.failed = failed; this.assets = assets;
    Object.assign(this.element.style, { pointerEvents: 'auto', touchAction: 'none', borderRadius: '50%', clipPath: 'circle(50%)' });
    this.center = new DomComponent(this).rect({ x: 0, y: 0, width: 0, height: 0 });
    this.stick = new DomComponent(this.center); this.dpad = new DomComponent(this.center);
    this.image(this.stick, skin['stick-base'], CONTROL_SIZES.move.width);
    this.knob = this.image(this.stick, skin.button, STICK_KNOB_RADIUS * 2);
    this.image(this.dpad, skin['stick-base'], DPAD_BASE_RADIUS * 2).element.style.opacity = String(DPAD_RUNE_ALPHA);
    for (const [x, y] of [[0, -DPAD_ARROW_OFFSET], [0, DPAD_ARROW_OFFSET], [-DPAD_ARROW_OFFSET, 0], [DPAD_ARROW_OFFSET, 0]]) {
      const root = new DomComponent(this.dpad).rect({ x, y, width: 0, height: 0 });
      this.arrows.push({ root, image: new DomImage(root).naturalSize(.5, .5) });
    }
    const listen = (name: string, handler: (event: PointerEvent) => void) => {
      const callback = handler as EventListener;
      this.element.addEventListener(name, callback);
      this.own(() => this.element.removeEventListener(name, callback));
    };
    listen('pointerdown', event => {
      if (!this.enabled || this.settings.mode === 'keyboard' || event.button !== 0) return;
      const at = this.local(event);
      const radius = this.settings.moveStyle === 'dpad' ? DPAD_BASE_RADIUS : CONTROL_SIZES.move.width / 2;
      if (Math.hypot(at.x, at.y) > radius) return;
      event.stopPropagation(); event.preventDefault();
      this.reset(); this.pointer = event.pointerId; this.element.setPointerCapture(event.pointerId); this.track(at.x, at.y);
    });
    listen('pointermove', event => {
      if (this.pointer !== event.pointerId) return;
      event.stopPropagation(); event.preventDefault();
      if (event.buttons === 0) { this.reset(); return; }
      const at = this.local(event); this.track(at.x, at.y);
    });
    for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) listen(name, event => {
      if (this.pointer === event.pointerId) this.reset();
    });
    this.own(settings.subscribeMode(() => {
      this.reset(); if (this.viewport) this.layout(this.viewport, this.overrides); this.syncVisible();
    }));
    this.own(() => this.reset()); this.syncVisible(); this.updateArrows();
  }
  private image(parent: DomComponent, file: string, size: number): DomImage {
    const image = new DomImage(parent).rect({ x: -size / 2, y: -size / 2, width: size, height: size });
    this.load(image, file); return image;
  }
  private load(image: DomImage, file: string): void {
    void image.load(this.assets, file).catch(error => { if (!image.signal.aborted && (error as Error)?.name !== 'AbortError') this.failed(error); });
  }
  private local(event: PointerEvent): { x: number; y: number } {
    const bounds = this.element.getBoundingClientRect();
    const size = this.settings.moveStyle === 'dpad' ? CONTROL_SIZES.moveDpad.width : CONTROL_SIZES.move.width;
    return { x: ((event.clientX - bounds.left) / bounds.width - .5) * size, y: ((event.clientY - bounds.top) / bounds.height - .5) * size };
  }
  private track(dx: number, dy: number): void {
    const distance = Math.hypot(dx, dy);
    if (this.settings.mode === 'dpad') {
      if (distance < DPAD_DEAD_ZONE) this.assign(0, 0);
      else {
        const angle = Math.atan2(dy, dx) * 180 / Math.PI;
        if (angle >= -45 && angle < 45) this.assign(1, 0);
        else if (angle >= 45 && angle < 135) this.assign(0, 1);
        else if (angle >= -135 && angle < -45) this.assign(0, -1);
        else this.assign(-1, 0);
      }
    } else {
      const ratio = Math.min(1, KNOB_LIMIT / (distance || 1));
      this.assign(distance >= STICK_DEAD_ZONE ? dx * ratio / KNOB_LIMIT : 0, distance >= STICK_DEAD_ZONE ? dy * ratio / KNOB_LIMIT : 0);
    }
  }
  private assign(x: number, y: number): void {
    if (x === this.axis.x && y === this.axis.y) return;
    this.axis.x = x; this.axis.y = y;
    this.knob.element.style.transform = `translate(${x * KNOB_LIMIT}px,${y * KNOB_LIMIT}px)`;
    this.updateArrows();
  }
  private updateArrows(): void {
    const directions = ['up', 'down', 'left', 'right'] as const;
    const active = [this.axis.y < -AXIS_ACTIVE_THRESHOLD, this.axis.y > AXIS_ACTIVE_THRESHOLD,
      this.axis.x < -AXIS_ACTIVE_THRESHOLD, this.axis.x > AXIS_ACTIVE_THRESHOLD];
    this.arrows.forEach((arrow, index) => {
      const file = this.skin[`arrow-${directions[index]}${active[index] ? '-glow' : ''}`];
      if (file !== arrow.file) { arrow.file = file; this.load(arrow.image, file); }
      arrow.root.element.style.transform = `scale(${active[index] ? DPAD_ARROW_SCALE_ACTIVE : DPAD_ARROW_SCALE_NORM})`;
    });
  }
  keyDown(event: KeyboardEvent, bindings: KeyBindingPreferences): boolean {
    if (!this.enabled || event.isComposing) return false;
    const element = globalThis.document?.activeElement;
    if (element && (['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) || (element as HTMLElement).isContentEditable)) return false;
    const action = MOVE_BINDING_ACTIONS.find(action => bindings.matches(action, event));
    if (!action) return false;
    event.preventDefault();
    const code = event.code || event.key;
    if (!this.history.some(value => value.code === code)) this.history.push({ direction: action.slice(5) as Direction, code });
    if (this.pointer === undefined) this.syncKeys();
    return true;
  }
  keyUp(event: KeyboardEvent): void {
    const code = event.code || event.key, index = this.history.findIndex(value => value.code === code);
    if (index < 0) return;
    this.history.splice(index, 1); if (this.pointer === undefined) this.syncKeys();
  }
  private syncKeys(): void {
    const direction = this.history.at(-1)?.direction;
    const vector = direction && this.enabled ? vectors[direction] : { x: 0, y: 0 };
    this.assign(vector.x, vector.y);
  }
  reset(): void {
    const pointer = this.pointer; this.pointer = undefined; this.history.length = 0;
    if (pointer !== undefined && this.element.hasPointerCapture(pointer)) this.element.releasePointerCapture(pointer);
    this.assign(0, 0);
  }
  layout(viewport: ControlViewport, overrides?: ControlLayoutOverrides): void {
    this.viewport = viewport; this.overrides = overrides;
    const size = this.settings.moveStyle === 'dpad' ? CONTROL_SIZES.moveDpad : CONTROL_SIZES.move;
    const point = resolveControlLayout(viewport, overrides, size).move, scale = point.scale * point.userScale;
    this.rect({ x: point.x, y: point.y, width: size.width, height: size.height });
    Object.assign(this.element.style, { transformOrigin: '0 0', transform: `scale(${scale}) translate(-50%,-50%)` });
    this.center.rect({ x: size.width / 2, y: size.height / 2, width: 0, height: 0 }); this.reset();
  }
  setVisible(enabled: boolean): void { this.enabled = enabled; if (!enabled) this.reset(); this.syncVisible(); }
  private syncVisible(): void {
    const mode: ControlMode = this.settings.mode;
    this.stick.visible(this.settings.moveStyle === 'stick'); this.dpad.visible(this.settings.moveStyle === 'dpad');
    this.visible(this.enabled && mode !== 'keyboard');
  }
}

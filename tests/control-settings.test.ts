import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { controlSettings, type MoveControlStyle } from '../src/application/control-settings.ts';
import { KeyBindingPreferences } from '../src/application/key-bindings.ts';
import type { KeyBinding } from '../src/domain/key-bindings.ts';

const phaser = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'phaser') {
      return {
        url: `data:text/javascript,export default {
          Textures: { FilterMode: { LINEAR: 1 } },
          Input: { Events: { POINTER_MOVE: 'pointermove', POINTER_UP: 'pointerup', POINTER_UP_OUTSIDE: 'pointerupoutside' } },
          Geom: {
            Circle: class Circle {
              constructor(x, y, radius) { this.x = x; this.y = y; this.radius = radius; }
              setTo(x, y, radius) { this.x = x; this.y = y; this.radius = radius; return this; }
              static Contains(circle, x, y) { return Math.hypot(x - circle.x, y - circle.y) <= circle.radius; }
            }
          }
        }`,
        shortCircuit: true
      };
    }
    return next(specifier, context);
  }
});

const { MoveStick } = await import('../src/ui/phaser/move-stick.ts');
phaser.deregister();

test('controlSettings defaults to stick and notifies subscribers on change', () => {
  const events: MoveControlStyle[] = [];
  const unsubscribe = controlSettings.subscribe(style => events.push(style));

  controlSettings.setMoveStyle('dpad');
  assert.equal(controlSettings.moveStyle, 'dpad');
  assert.deepEqual(events, ['dpad']);

  controlSettings.setMoveStyle('stick');
  assert.equal(controlSettings.moveStyle, 'stick');
  assert.deepEqual(events, ['dpad', 'stick']);

  unsubscribe();
  controlSettings.setMoveStyle('dpad');
  assert.equal(events.length, 2, 'Unsubscribed listener should not receive events');

  controlSettings.setMoveStyle('stick');
  assert.equal(controlSettings.moveStyle, 'stick');
});

test('MoveStick switches between stick and dpad without calling removeInteractive and tracks 4-way movement accurately', () => {
  controlSettings.setMoveStyle('stick');

  let pointerDownHandler: ((pointer: { id: number; x: number; y: number }, x: number, y: number, event: { stopPropagation(): void }) => void) | undefined;
  const inputListeners = new Map<string, ((pointer: { id: number; x: number; y: number }) => void)>();
  let removeInteractiveCalled = false;

  const makeImage = () => ({
    visible: true,
    textureKey: '',
    x: 0,
    y: 0,
    setDisplaySize() { return this; },
    setScale() { return this; },
    setAlpha() { return this; },
    setVisible(v: boolean) { this.visible = v; return this; },
    setPosition(x: number, y: number) { this.x = x; this.y = y; return this; },
    setTexture(k: string) { this.textureKey = k; return this; }
  });

  const container = {
    scaleX: 1,
    scaleY: 1,
    x: 0,
    y: 0,
    hitArea: undefined as { radius: number } | undefined,
    add() { return this; },
    setInteractive(area: { radius: number }) { this.hitArea = area; return this; },
    removeInteractive() { removeInteractiveCalled = true; return this; },
    on(event: string, fn: typeof pointerDownHandler) {
      if (event === 'pointerdown') pointerDownHandler = fn;
      return this;
    },
    setScale(s: number) { this.scaleX = s; this.scaleY = s; return this; },
    setPosition(x: number, y: number) { this.x = x; this.y = y; return this; },
    destroy() {}
  };

  const scene = {
    game: { canvas: { getBoundingClientRect: () => ({ left: 0, right: 1280, top: 0, bottom: 720, width: 1280, height: 720 }) } },
    scale: { width: 1280, height: 720 },
    textures: { exists: () => false, get: () => ({ setFilter() {} }) },
    make: { container: () => container },
    add: { image: () => makeImage() },
    input: {
      on(event: string, fn: (p: { id: number; x: number; y: number }) => void, ctx: unknown) {
        inputListeners.set(event, fn.bind(ctx));
      },
      off() {}
    }
  };

  const hud = {
    scene,
    add: (c: unknown) => c,
    setVisible: () => {}
  };

  const skin = {
    'stick-base': 'base',
    button: 'btn',
    'button-pressed': 'btn-p',
    'slot-shadow': 's',
    'slot-ring': 'r',
    'slot-pressed': 'sp',
    'quantity-badge': 'q',
    swap: 'sw',
    'swap-pressed': 'swp',
    skip: 'sk',
    'skip-pressed': 'skp',
    'arrow-up': 'up',
    'arrow-up-glow': 'up-glow',
    'arrow-down': 'down',
    'arrow-down-glow': 'down-glow',
    'arrow-left': 'left',
    'arrow-left-glow': 'left-glow',
    'arrow-right': 'right',
    'arrow-right-glow': 'right-glow'
  };

  const stick = new MoveStick(scene as never, hud as never, skin as never);
  const cx = 0;
  const cy = 0;

  // Switch to dpad in settings
  controlSettings.setMoveStyle('dpad');
  assert.equal(removeInteractiveCalled, false, 'Must NEVER call removeInteractive on style switch');
  assert.equal(container.hitArea?.radius, 137);

  // Touch UP on D-pad
  pointerDownHandler!({ id: 1, x: cx, y: cy - 70 }, 0, 0, { stopPropagation() {} });
  assert.deepEqual(stick.axis, { x: 0, y: -1 }, 'Touching up arrow should drive character north');

  // Slide finger to RIGHT
  inputListeners.get('pointermove')!({ id: 1, x: cx + 70, y: cy });
  assert.deepEqual(stick.axis, { x: 1, y: 0 }, 'Sliding to right arrow should drive character east');

  // Slide finger to DOWN
  inputListeners.get('pointermove')!({ id: 1, x: cx, y: cy + 70 });
  assert.deepEqual(stick.axis, { x: 0, y: 1 }, 'Sliding to down arrow should drive character south');

  // Slide finger to LEFT
  inputListeners.get('pointermove')!({ id: 1, x: cx - 70, y: cy });
  assert.deepEqual(stick.axis, { x: -1, y: 0 }, 'Sliding to left arrow should drive character west');

  // Release finger
  inputListeners.get('pointerup')!({ id: 1, x: cx - 70, y: cy });
  assert.deepEqual(stick.axis, { x: 0, y: 0 }, 'Releasing finger should stop character');

  stick.destroy();
  controlSettings.setMoveStyle('stick');
});

test('MoveStick uses rebindable movement keys and clears by physical code', () => {
  controlSettings.setMoveStyle('stick');
  const keyboard = new Map<string, (event: KeyboardEvent) => void>();
  const makeImage = () => ({
    setDisplaySize() { return this; },
    setScale() { return this; },
    setAlpha() { return this; },
    setVisible() { return this; },
    setPosition() { return this; },
    setTexture() { return this; }
  });
  const container = {
    scaleX: 1, scaleY: 1, x: 0, y: 0,
    add() { return this; },
    setInteractive() { return this; },
    on() { return this; },
    setScale() { return this; },
    setPosition() { return this; },
    destroy() {}
  };
  const scene = {
    game: { canvas: { getBoundingClientRect: () => ({ left: 0, right: 1280, top: 0, bottom: 720, width: 1280, height: 720 }) } },
    scale: { width: 1280, height: 720 },
    textures: { exists: () => false, get: () => ({ setFilter() {} }) },
    make: { container: () => container },
    add: { image: () => makeImage() },
    input: {
      on() {},
      off() {},
      keyboard: {
        on(event: string, fn: (event: KeyboardEvent) => void, context: unknown) { keyboard.set(event, fn.bind(context)); },
        off(event: string) { keyboard.delete(event); }
      }
    }
  };
  const hud = { scene, add: (c: unknown) => c, setVisible: () => {} };
  const skin = {
    'stick-base': 'base', button: 'btn',
    'arrow-up': 'up', 'arrow-up-glow': 'up-glow',
    'arrow-down': 'down', 'arrow-down-glow': 'down-glow',
    'arrow-left': 'left', 'arrow-left-glow': 'left-glow',
    'arrow-right': 'right', 'arrow-right-glow': 'right-glow'
  };

  const bindings = new KeyBindingPreferences(null);
  const stick = new MoveStick(scene as never, hud as never, skin as never, undefined, bindings);
  const event = (code: string, init: Partial<KeyboardEvent> = {}): KeyboardEvent => ({
    code, key: code, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
    isComposing: false, preventDefault() {}, ...init
  }) as KeyboardEvent;
  const press = (code: string, init?: Partial<KeyboardEvent>) => keyboard.get('keydown')!(event(code, init));
  const release = (code: string, init?: Partial<KeyboardEvent>) => keyboard.get('keyup')!(event(code, init));

  press('KeyW');
  assert.deepEqual(stick.axis, { x: 0, y: -1 }, '默认 W 向上');
  release('KeyW');
  assert.deepEqual(stick.axis, { x: 0, y: 0 });

  const arrowUp: KeyBinding = { code: 'ArrowUp', shift: false, ctrl: false, alt: false, meta: false };
  assert.equal(bindings.set('move.up', arrowUp), undefined);
  press('KeyW');
  assert.deepEqual(stick.axis, { x: 0, y: 0 }, '改绑后旧键不再移动');
  press('ArrowUp');
  assert.deepEqual(stick.axis, { x: 0, y: -1 }, '新键立即生效');
  release('ArrowUp');
  assert.deepEqual(stick.axis, { x: 0, y: 0 });

  assert.equal(bindings.set('move.up', { code: 'KeyW', shift: true, ctrl: false, alt: false, meta: false }), undefined);
  press('KeyW', { shiftKey: true });
  assert.deepEqual(stick.axis, { x: 0, y: -1 });
  // 先松开 Shift：keyup 只看物理键码，方向不会卡住。
  release('KeyW', { shiftKey: false });
  assert.deepEqual(stick.axis, { x: 0, y: 0 });

  stick.destroy();
  controlSettings.setMoveStyle('stick');
});

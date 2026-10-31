import assert from 'node:assert/strict';
import test from 'node:test';
import { CONTROL_IDS, CONTROL_LAYOUT_STORAGE_KEY, CONTROL_SIZES, ControlLayoutPreferences, normalizeControlPosition, resolveControlLayout,
  type ControlLayoutOverrides, type ControlViewport, type StorageLike } from '../src/ui/control-layout.ts';
import { controlViewport } from '../src/ui/phaser/control-layout-viewport.ts';

const viewport: ControlViewport = {width: 960, height: 640, insets: {left: 0, right: 0, top: 0, bottom: 0}};
class MemoryStorage implements StorageLike {
  data = new Map<string, string>(); writes = 0;
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.data.set(key, value); this.writes++; }
}

test('device preferences persist independently, copy points, notify and restore defaults', () => {
  const storage = new MemoryStorage(), preferences = new ControlLayoutPreferences(storage);
  let changed = 0;
  const unsubscribe = preferences.subscribe(() => changed++);
  const point = {x: .4, y: .7};
  preferences.set('attack', point); point.x = .8;
  assert.deepEqual(preferences.snapshot(), {attack: {x: .4, y: .7}});
  const snapshot = preferences.snapshot(); snapshot.attack!.x = .9;
  assert.deepEqual(new ControlLayoutPreferences(storage).snapshot(), {attack: {x: .4, y: .7}});
  assert.equal(changed, 1);
  preferences.reset();
  assert.deepEqual(new ControlLayoutPreferences(storage).snapshot(), {});
  assert.equal(changed, 2);
  unsubscribe(); preferences.set('swap', {x: .8, y: .4});
  assert.equal(changed, 2);
});

test('malformed, outdated and out-of-range preferences use defaults without writing', () => {
  const storage = new MemoryStorage();
  for (const saved of ['{', 'null', '[]', '{"version":2,"positions":{}}',
    '{"version":1,"positions":[]}', '{"version":1,"positions":{"attack":{"x":2,"y":0.5}}}',
    '{"version":1,"positions":{"attack":{"x":0.5,"y":null}}}',
    '{"version":1,"positions":{"unknown":{"x":0.5,"y":0.5}}}']) {
    storage.data.set(CONTROL_LAYOUT_STORAGE_KEY, saved);
    assert.deepEqual(new ControlLayoutPreferences(storage).snapshot(), {});
  }
  assert.equal(storage.writes, 0);
  const preferences = new ControlLayoutPreferences(storage);
  for (const point of [{x: NaN, y: .5}, {x: .5, y: Infinity}, {x: -.1, y: .5}]) preferences.set('attack', point);
  assert.deepEqual(preferences.snapshot(), {});
  assert.equal(storage.writes, 0);
});

test('storage errors and storage disabled keep changes in memory', () => {
  for (const storage of [null, {getItem() { throw new Error('blocked'); }, setItem() { throw new Error('full'); }}]) {
    const preferences = new ControlLayoutPreferences(storage);
    preferences.set('move', {x: .3, y: .6});
    assert.deepEqual(preferences.snapshot(), {move: {x: .3, y: .6}});
    preferences.reset(); assert.deepEqual(preferences.snapshot(), {});
  }
});

test('default positions and sizes preserve the original action arc and movement stick', () => {
  const layout = resolveControlLayout(viewport);
  assert.deepEqual(layout.move, {x: 129, y: 511, width: 210, height: 210, scale: 1});
  assert.deepEqual(layout.attack, {x: 856, y: 560, width: 159, height: 160, scale: 1});
  assert.deepEqual(layout.swap, {x: 898, y: 350, width: 75, height: 75, scale: 1});
  assert.deepEqual(Array.from({length: 6}, (_, index) => {
    const placement = layout[`slot-${index}` as keyof typeof layout];
    return [placement.x, placement.y, placement.width, placement.height];
  }), [[514, 593, 94, 94], [614, 593, 94, 94], [714, 593, 94, 94], [727, 503, 94, 94], [795, 440, 94, 94], [889, 437, 94, 94]]);
  const withInsets = resolveControlLayout({...viewport, insets: {left: 30, right: 30, top: 10, bottom: 20}});
  assert.equal(withInsets.move.scale, 1);
  assert.equal(withInsets.attack.scale, .9375);
  assert.equal(withInsets.move.x, 159);
  assert.equal(withInsets.move.y, 491);
  assert.equal(withInsets.attack.x, 832.5);
  assert.equal(withInsets.attack.y, 545);
});

test('dpad movement disk uses the 274 diameter and stays inside the safe area', () => {
  const stick = resolveControlLayout(viewport);
  assert.deepEqual(stick.move, {x: 129, y: 511, width: 210, height: 210, scale: 1});

  const dpad = resolveControlLayout(viewport, {}, CONTROL_SIZES.moveDpad);
  assert.deepEqual(dpad.move, {x: 137, y: 503, width: 274, height: 274, scale: 1});
  assert.ok(dpad.move.x - dpad.move.width / 2 >= 0);
  assert.ok(dpad.move.y - dpad.move.height / 2 >= 0);
  assert.deepEqual(dpad.attack, stick.attack, '动作区不随移动样式改变');
  assert.deepEqual(dpad.swap, stick.swap);
  assert.deepEqual(Array.from({length: 6}, (_, index) => dpad[`slot-${index}` as keyof typeof dpad]),
    Array.from({length: 6}, (_, index) => stick[`slot-${index}` as keyof typeof stick]));

  const insetLayout = resolveControlLayout({...viewport, insets: {left: 30, right: 30, top: 10, bottom: 20}}, {}, CONTROL_SIZES.moveDpad).move;
  assert.deepEqual(insetLayout, {x: 167, y: 483, width: 274, height: 274, scale: 1});
  assert.ok(insetLayout.x - insetLayout.width / 2 >= 30);
  assert.ok(insetLayout.y - insetLayout.height / 2 >= 10);
  assert.ok(insetLayout.x + insetLayout.width / 2 <= viewport.width - 30);
  assert.ok(insetLayout.y + insetLayout.height / 2 <= viewport.height - 20);
});

test('dragging clamps each complete control into the safe area, permits overlap and roundtrips', () => {
  const safeViewport: ControlViewport = {width: 1920, height: 1280, insets: {left: 80, right: 40, top: 20, bottom: 40}};
  for (const id of CONTROL_IDS) {
    const lower = normalizeControlPosition(safeViewport, id, {x: -100, y: -100});
    const upper = normalizeControlPosition(safeViewport, id, {x: 9000, y: 9000});
    const low = resolveControlLayout(safeViewport, {[id]: lower})[id], high = resolveControlLayout(safeViewport, {[id]: upper})[id];
    assert.ok(Math.abs(low.x - low.width / 2 - 80) < 1e-9);
    assert.ok(Math.abs(low.y - low.height / 2 - 20) < 1e-9);
    assert.ok(Math.abs(high.x + high.width / 2 - 1880) < 1e-9);
    assert.ok(Math.abs(high.y + high.height / 2 - 1240) < 1e-9);
  }
  const dpadLayout = (point: {x: number; y: number}) => resolveControlLayout(safeViewport,
    {move: normalizeControlPosition(safeViewport, 'move', point, {}, CONTROL_SIZES.moveDpad)}, CONTROL_SIZES.moveDpad).move;
  const dpadLow = dpadLayout({x: -100, y: -100}), dpadHigh = dpadLayout({x: 9000, y: 9000});
  assert.ok(Math.abs(dpadLow.x - dpadLow.width / 2 - 80) < 1e-9);
  assert.ok(Math.abs(dpadLow.y - dpadLow.height / 2 - 20) < 1e-9);
  assert.ok(Math.abs(dpadHigh.x + dpadHigh.width / 2 - 1880) < 1e-9);
  assert.ok(Math.abs(dpadHigh.y + dpadHigh.height / 2 - 1240) < 1e-9);
  const overrides: ControlLayoutOverrides = Object.fromEntries(CONTROL_IDS.map(id => [id, {x: .5, y: .5}]));
  const overlapping = resolveControlLayout(safeViewport, overrides);
  for (const id of CONTROL_IDS) assert.deepEqual([overlapping[id].x, overlapping[id].y], [980, 630]);
  const point = {x: 600, y: 700}, normalized = normalizeControlPosition(safeViewport, 'move', point);
  const restored = resolveControlLayout(safeViewport, {move: normalized}).move;
  assert.ok(Math.abs(restored.x - point.x) < 1e-9 && Math.abs(restored.y - point.y) < 1e-9);
});

test('resizing projects positions without modifying or persisting saved preferences', () => {
  const storage = new MemoryStorage(), preferences = new ControlLayoutPreferences(storage);
  preferences.set('move', {x: .5, y: .6});
  preferences.set('slot-3', {x: .7, y: .3});
  const before = preferences.snapshot(), writes = storage.writes;
  for (const width of [480, 960, 1920, 2560]) {
    const layout = resolveControlLayout({...viewport, width}, preferences.snapshot());
    assert.equal(layout.move.x, width * .5);
    assert.equal(layout['slot-3'].x, width * .7);
  }
  assert.deepEqual(preferences.snapshot(), before);
  assert.equal(storage.writes, writes);
});

test('canvas helper converts CSS safe-area pixels using each canvas axis', () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  const original = ['document', 'getComputedStyle'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  try {
    globals.document = {getElementById: () => ({})};
    globals.getComputedStyle = () => ({paddingLeft: '20px', paddingRight: '30px', paddingTop: '10px', paddingBottom: '15px'});
    const scene = {scale: {width: 1920, height: 1280}, game: {canvas: {getBoundingClientRect: () => ({width: 960, height: 640})}}} as unknown as import('phaser').Scene;
    assert.deepEqual(controlViewport(scene), {width: 1920, height: 1280, insets: {left: 40, right: 60, top: 20, bottom: 30}});
    assert.deepEqual(controlViewport(scene, 960, 320), {width: 960, height: 320, insets: {left: 20, right: 30, top: 5, bottom: 7.5}});
  } finally {
    for (const [name, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globals[name];
    }
  }
});

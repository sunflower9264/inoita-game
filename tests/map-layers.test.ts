import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import type Phaser from 'phaser';
import type { WorldMap } from '../src/domain/content.ts';
import { PROP_ATLAS_BY_KEY } from '../src/generated/prop-atlas.ts';

const hook = registerHooks({ resolve(specifier, context, next) {
  return specifier === 'phaser'
    ? { shortCircuit: true, url: 'data:text/javascript,export default {BlendModes:{NORMAL:0,ADD:1,MULTIPLY:2,SCREEN:3}};' }
    : next(specifier, context);
} });
const { drawMapLayers, mapSurfaceAssets, dodgePixel } = await import('../src/rendering/map-layers.ts');
hook.deregister();

interface FakeImage {
  key: string; frame?: string; x: number; y: number; depth: number; flipped: boolean; blend: number | null;
  origin: { x: number; y: number }; scene?: object; destroyed: boolean;
  setOrigin(x?: number, y?: number): FakeImage; setDepth(value: number): FakeImage; setFlipX(value: boolean): FakeImage;
  setBlendMode(value: number): FakeImage; destroy(): void;
}

function fixture(failOnKey?: string, atlas?: { key: string; frame: string; width: number; height: number }) {
  const images: FakeImage[] = [], removed: string[] = [], drawImages: unknown[][] = [];
  const textures = new Map<string, { width: number; height: number }>([
    ['map-ground', { width: 4, height: 4 }], ['map-canopy', { width: 4, height: 4 }],
    ['prop-a', { width: 4, height: 4 }], ['prop-b', { width: 4, height: 4 }]
  ]);
  if (atlas) textures.set(atlas.key, { width: atlas.width, height: atlas.height });
  const scene = {
    textures: {
      exists: (key: string) => textures.has(key),
      get: (key: string) => {
        const source = textures.get(key)!;
        return {
          getSourceImage: () => source,
          get: (frame = '__BASE') => ({
            source: { image: { ...source, frame } },
            cutX: atlas && key === atlas.key ? 7 : 0,
            cutY: atlas && key === atlas.key ? 9 : 0,
            cutWidth: source.width ?? 1, cutHeight: source.height
          })
        };
      },
      remove: (key: string) => { removed.push(key); textures.delete(key); },
      createCanvas: (key: string, width: number, height: number) => {
        textures.set(key, { width, height });
        const data = new Uint8ClampedArray(width * height * 4).fill(100);
        return {
          key,
          context: {
            drawImage(...args: unknown[]) { drawImages.push(args); },
            getImageData: () => ({ data: new Uint8ClampedArray(data) }),
            putImageData() {}
          },
          refresh() {}
        };
      }
    },
    add: {
      image: (x: number, y: number, key: string, frame?: string) => {
        if (key === failOnKey) throw new Error('绘制失败：' + key);
        const image: FakeImage = {
          key, frame, x, y, depth: 0, flipped: false, blend: null, origin: { x: 0, y: 0 }, scene: {}, destroyed: false,
          setOrigin(originX = 0, originY = 0) { image.origin = { x: originX, y: originY }; return image; },
          setDepth(value) { image.depth = value; return image; },
          setFlipX(value) { image.flipped = value; return image; },
          setBlendMode(value) { image.blend = value; return image; },
          destroy() { image.destroyed = true; image.scene = undefined; }
        };
        images.push(image); return image;
      }
    }
  };
  return { scene: scene as unknown as Phaser.Scene, images, removed, drawImages };
}

const map = (features: WorldMap['features']) => ({ id: 'map', ground: 'ground.png', canopy: 'canopy.png', features } as unknown as WorldMap);

test('map surface assets keep ground, canopy and feature props together', () => {
  const assets = mapSurfaceAssets(map([{ texture: 'prop-a' } as WorldMap['features'][number]]), [
    { key: 'prop-a', file: 'a.png' }
  ]);
  assert.deepEqual(assets.map(asset => asset.key), ['map-ground', 'map-canopy', 'prop-a']);
  assert.throws(() => mapSurfaceAssets(map([{ texture: 'missing' } as WorldMap['features'][number]]), []), /场景物件缺少资源/);
});

test('dodge pixel preserves zero background and saturates a full foreground', () => {
  assert.equal(dodgePixel(0, 50), 0);
  assert.equal(dodgePixel(100, 255), 255);
  assert.equal(dodgePixel(100, 50), 124);
  assert.equal(dodgePixel(255, 254), 255);
});

test('static layers keep feature offsets, flip, blend and depth', () => {
  const run = fixture();
  const layers = drawMapLayers(run.scene, map([
    { texture: 'prop-a', x: 10, y: 20, offsetX: 3, offsetY: 4, width: 8, flip: true, blend: 'multiply' },
    { texture: 'prop-b', x: 30, y: 40, offsetX: 1, offsetY: 2, width: 6, flip: false, blend: 'add' }
  ]), { keyPrefix: 'test-dodge' });
  assert.deepEqual(run.images.map(image => image.key), ['map-ground', 'prop-a', 'prop-b', 'map-canopy']);
  assert.deepEqual(run.images.map(image => image.depth), [-10000, 20, 40, 10000]);
  assert.deepEqual([run.images[1]!.x, run.images[1]!.y, run.images[1]!.flipped, run.images[1]!.blend], [5, 16, true, 2]);
  assert.deepEqual([run.images[2]!.x, run.images[2]!.y, run.images[2]!.flipped, run.images[2]!.blend], [29, 38, false, 1]);
  layers.destroy(); layers.destroy();
  assert(run.images.every(image => image.destroyed));
  assert.deepEqual(run.removed, [], '静态层不能删除租约管理的 ground/canopy/prop');
});

test('color dodge creates its own texture and does not flip or blend the image again', () => {
  const run = fixture();
  const previous = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = {
    createElement: () => {
      const canvas = {
        width: 0, height: 0,
        getContext: () => ({
          translate() {}, scale() {}, drawImage() {},
          getImageData: () => ({ data: new Uint8ClampedArray(canvas.width * canvas.height * 4).fill(100) })
        })
      };
      return canvas;
    }
  };
  try {
    const layers = drawMapLayers(run.scene, map([
      { texture: 'prop-a', x: 10, y: 20, offsetX: 3, offsetY: 4, width: 8, flip: true, blend: 'color-dodge' }
    ]), { keyPrefix: 'test-dodge' });
    const feature = run.images[1]!;
    assert.match(feature.key, /^test-dodge-\d+$/);
    assert.equal(feature.flipped, false);
    assert.equal(feature.blend, null);
    layers.destroy();
    assert.equal(run.removed.length, 1, '只删除自己创建的合成纹理');
    assert.match(run.removed[0]!, /^test-dodge-\d+$/);
  } finally {
    (globalThis as { document?: unknown }).document = previous;
  }
});

test('map surface assets use one atlas page and drawing keeps the frame', () => {
  const [propKey, entry] = Object.entries(PROP_ATLAS_BY_KEY)[0]!;
  const run = fixture(undefined, { key: entry.key, frame: entry.frame, width: 8, height: 8 });
  const assets = mapSurfaceAssets(map([{ texture: propKey } as WorldMap['features'][number]]), [
    { key: propKey, file: 'unused.png' }
  ]);
  assert.deepEqual(assets.map(asset => asset.key), ['map-ground', 'map-canopy', entry.key]);
  assert.equal(assets[2]!.kind, 'atlas');
  const layers = drawMapLayers(run.scene, map([
    { texture: propKey, x: 10, y: 20, offsetX: 2, offsetY: 3, width: 8, flip: true, blend: 'multiply' }
  ]), { keyPrefix: 'test-atlas' });
  assert.deepEqual([run.images[1]!.key, run.images[1]!.frame], [entry.key, entry.frame]);
  assert.deepEqual(run.images[1]!.origin, { x: 0, y: 0 });
  assert.deepEqual([run.images[1]!.x, run.images[1]!.y, run.images[1]!.flipped, run.images[1]!.blend], [4, 17, true, 2]);
  layers.destroy();
  assert.deepEqual(run.removed, [], 'destroy 不能删除租约管理的图集页');
});

test('color dodge copies the atlas frame rect instead of the whole page', () => {
  const [propKey, entry] = Object.entries(PROP_ATLAS_BY_KEY)[0]!;
  const run = fixture(undefined, { key: entry.key, frame: entry.frame, width: 8, height: 8 });
  const previous = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = {
    createElement: () => {
      const canvas = {
        width: 0, height: 0,
        getContext: () => ({
          translate() {}, scale() {}, drawImage(...args: unknown[]) { run.drawImages.push(args); },
          getImageData: () => ({ data: new Uint8ClampedArray(canvas.width * canvas.height * 4).fill(100) })
        })
      };
      return canvas;
    }
  };
  try {
    drawMapLayers(run.scene, map([
      { texture: propKey, x: 10, y: 20, offsetX: 0, offsetY: 0, width: 8, flip: false, blend: 'color-dodge' }
    ]), { keyPrefix: 'test-dodge-atlas' });
    const propDraw = run.drawImages.find(args => args.length === 9 && (args[0] as { frame?: string })?.frame === entry.frame)!;
    assert.ok(propDraw, 'must draw a frame rect');
    assert.deepEqual(propDraw.slice(1), [7, 9, 8, 8, 0, 0, 8, 8]);
  } finally {
    (globalThis as { document?: unknown }).document = previous;
  }
});

test('real maps load one atlas page only when they have features', () => {
  const world = JSON.parse(fs.readFileSync(new URL('../public/content/world.json', import.meta.url), 'utf8'));
  let empty = 0, withFeatures = 0;
  for (const reference of world.maps) {
    const document = JSON.parse(fs.readFileSync(new URL(`../public/${reference.file}`, import.meta.url), 'utf8'));
    const assets = mapSurfaceAssets(document, world.props);
    if (!document.features.length) {
      empty++;
      assert.deepEqual(assets.map(asset => asset.key), [`${document.id}-ground`, `${document.id}-canopy`]);
    } else {
      withFeatures++;
      assert.deepEqual(assets.map(asset => asset.key),
        [`${document.id}-ground`, `${document.id}-canopy`, 'props-atlas:0']);
    }
  }
  assert.equal(empty, 22);
  assert.equal(withFeatures, 394);
});

test('a failed layer construction rolls back images and composite textures', () => {
  const run = fixture('map-canopy');
  assert.throws(() => drawMapLayers(run.scene, map([
    { texture: 'prop-a', x: 1, y: 2, offsetX: 0, offsetY: 0, width: 8, flip: false, blend: 'normal' }
  ]), { keyPrefix: 'test-dodge' }), /绘制失败/);
  assert(run.images.every(image => image.destroyed), '已画出的 ground/features 必须销毁');
});

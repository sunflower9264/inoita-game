import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { PNG } from 'pngjs';
import { contentDigest } from '../src/application/content-hash.ts';
import { PROP_ATLAS_BY_KEY, PROP_ATLAS_LAYOUT_DIGEST, PROP_ATLAS_PAGES, PROP_ATLAS_SOURCE_DIGEST } from '../src/generated/prop-atlas.ts';
import { propAtlasAssets, propRef } from '../src/rendering/prop-atlas.ts';
import { packPropAtlas, propFiles, propSourceDigest } from '../tools/build-prop-atlas.ts';

const read = (file: string): any => JSON.parse(fs.readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8'));
const pngSize = (file: string) => {
  const bytes = fs.readFileSync(new URL(`../public/${file}`, import.meta.url));
  assert.equal(bytes.toString('ascii', 1, 4), 'PNG', file);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
};
const props = propFiles();
const world = read('content/world.json');
const pages = new Map<string, any>(PROP_ATLAS_PAGES.map(page => [page.key, read(page.data)]));

test('every map prop and feature resolves to a complete, untrimmed atlas frame', () => {
  assert.equal(props.length, 763);
  assert.equal(new Set(props.map(prop => prop.key)).size, props.length);
  assert.equal(propSourceDigest(), PROP_ATLAS_SOURCE_DIGEST);
  const packed = packPropAtlas();
  assert.equal(packed.layoutDigest, PROP_ATLAS_LAYOUT_DIGEST);
  assert.deepEqual(packed.byKey, PROP_ATLAS_BY_KEY);
  assert.equal(packed.unique, 431);
  assert.equal(new Set(Object.values(PROP_ATLAS_BY_KEY).map(entry => entry.frame)).size, 431);
  const layout = {
    pages: PROP_ATLAS_PAGES.map(({ key, file, data, frame, width, height }) => ({ key, file, data, frame, width, height })),
    byKey: PROP_ATLAS_BY_KEY,
    frames: Object.fromEntries(PROP_ATLAS_PAGES.map(page => [page.key, pages.get(page.key)?.frames]))
  };
  assert.equal(contentDigest(layout), PROP_ATLAS_LAYOUT_DIGEST);
  for (const page of PROP_ATLAS_PAGES) {
    const atlas = pages.get(page.key)!;
    const size = pngSize(page.file);
    assert.deepEqual(atlas.meta.size, { w: size.width, h: size.height });
    assert.ok(size.width <= 2048 && size.height <= 2048);
    assert.ok(atlas.frames[page.frame], `missing sample frame ${page.frame}`);
    const atlasPng = PNG.sync.read(fs.readFileSync(new URL(`../public/${page.file}`, import.meta.url)));
    const rects = Object.entries(atlas.frames).map(([name, value]: [string, any]) => ({ name, ...value.frame }));
    for (let first = 0; first < rects.length; first++) for (let second = first + 1; second < rects.length; second++) {
      const a = rects[first]!, b = rects[second]!;
      assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y,
        `overlapping frames ${a.name} / ${b.name}`);
    }
    for (const [name, value] of Object.entries(atlas.frames) as [string, any][]) {
      const source = PNG.sync.read(fs.readFileSync(new URL(`../public/${name}`, import.meta.url)));
      assert.deepEqual({ w: value.frame.w, h: value.frame.h }, { w: source.width, h: source.height });
      for (let row = 0; row < value.frame.h; row++) {
        const from = row * value.frame.w * 4;
        const to = ((value.frame.y + row) * atlasPng.width + value.frame.x) * 4;
        assert.deepEqual(atlasPng.data.subarray(to, to + value.frame.w * 4),
          source.data.subarray(from, from + value.frame.w * 4), `frame pixels differ: ${name}`);
      }
    }
  }
  for (const prop of props) {
    const entry = PROP_ATLAS_BY_KEY[prop.key];
    assert.ok(entry, `missing mapping ${prop.key}`);
    const page = pages.get(entry.key);
    assert.ok(page, `missing page ${entry.key}`);
    const frame = page.frames[entry.frame];
    assert.ok(frame, `missing frame ${entry.frame}`);
    assert.equal(frame.trimmed, false);
    assert.equal(frame.rotated, false);
    const source = pngSize(entry.frame);
    assert.deepEqual(frame.sourceSize, { w: source.width, h: source.height });
    assert.deepEqual({ w: frame.frame.w, h: frame.frame.h }, { w: source.width, h: source.height });
    assert.ok(frame.frame.x >= 0 && frame.frame.y >= 0);
    assert.ok(frame.frame.x + frame.frame.w <= page.meta.size.w);
    assert.ok(frame.frame.y + frame.frame.h <= page.meta.size.h);
  }
  for (const map of world.maps) {
    const document = read(map.file);
    for (const feature of document.features) assert.ok(PROP_ATLAS_BY_KEY[feature.texture], `missing feature prop ${feature.texture}`);
  }
});

test('atlas assets collapse one page and unknown props keep the single-image fallback', () => {
  const assets = propAtlasAssets(Object.keys(PROP_ATLAS_BY_KEY), props);
  assert.equal(assets.length, PROP_ATLAS_PAGES.length);
  for (const asset of assets) assert.equal(asset.kind, 'atlas');
  const first = props[0]!;
  assert.deepEqual(propRef(first.key), { texture: PROP_ATLAS_BY_KEY[first.key]!.key, frame: PROP_ATLAS_BY_KEY[first.key]!.frame });
  assert.deepEqual(propRef('not-a-prop'), { texture: 'not-a-prop' });
  const fallback = propAtlasAssets(['not-a-prop'], [{ key: 'not-a-prop', file: 'assets/props/not-a-prop.png' }]);
  assert.deepEqual(fallback, [{ kind: 'image', key: 'not-a-prop', file: 'assets/props/not-a-prop.png' }]);
});

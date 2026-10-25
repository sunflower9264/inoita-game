import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { iconFiles, iconSourceDigest } from '../tools/build-icon-atlas.ts';
import { UI_ICON_ATLAS_DATA, UI_ICON_ATLAS_FILE, UI_ICON_FRAMES, UI_ICON_SOURCE_DIGEST } from '../src/generated/icon-atlas.ts';

test('every menu icon has an atlas frame and the atlas metadata matches the image', () => {
  const atlas = JSON.parse(fs.readFileSync(`public/${UI_ICON_ATLAS_DATA}`, 'utf8')) as {
    frames: Record<string, { frame: { x: number; y: number; w: number; h: number } }>;
    meta: { size: { w: number; h: number } };
  };
  const png = fs.readFileSync(`public/${UI_ICON_ATLAS_FILE}`);
  assert.equal(png.toString('ascii', 1, 4), 'PNG');
  assert.equal(png.readUInt32BE(16), atlas.meta.size.w);
  assert.equal(png.readUInt32BE(20), atlas.meta.size.h);
  assert.ok(atlas.meta.size.w <= 2048 && atlas.meta.size.h <= 2048);
  assert.equal(iconSourceDigest(), UI_ICON_SOURCE_DIGEST, 'run npm run atlas:icons');
  for (const file of iconFiles()) {
    const source = UI_ICON_FRAMES[file];
    assert.ok(source, `missing atlas mapping: ${file}`);
    const frame = atlas.frames[source];
    assert.ok(frame, `missing atlas frame: ${source}`);
    assert.ok(frame.frame.w > 0 && frame.frame.h > 0);
    assert.ok(frame.frame.x + frame.frame.w <= atlas.meta.size.w);
    assert.ok(frame.frame.y + frame.frame.h <= atlas.meta.size.h);
  }
});

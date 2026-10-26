import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { uiAtlasFiles, uiAtlasSourceDigest } from '../tools/build-ui-atlas.ts';
import { UI_ATLAS_FRAMES, UI_ATLAS_PAGES, UI_ATLAS_SOURCE_DIGEST } from '../src/generated/ui-atlas.ts';
import { UI_ICON_FRAMES } from '../src/generated/icon-atlas.ts';

function pngSize(file: string): { w: number; h: number } {
  const bytes = fs.readFileSync(file);
  assert.equal(bytes.toString('ascii', 1, 4), 'PNG', `not a PNG: ${file}`);
  return { w: bytes.readUInt32BE(16), h: bytes.readUInt32BE(20) };
}

test('every menu UI image has an atlas frame and the atlas metadata matches the source', () => {
  assert.equal(uiAtlasSourceDigest(), UI_ATLAS_SOURCE_DIGEST, 'run npm run atlas:ui');
  const pages = new Map(UI_ATLAS_PAGES.map(page => [page.key, {
    meta: JSON.parse(fs.readFileSync(`public/${page.data}`, 'utf8')) as {
      frames: Record<string, { frame: { x: number; y: number; w: number; h: number }; trimmed?: boolean; rotated?: boolean }>;
      meta: { size: { w: number; h: number } };
    },
    size: pngSize(`public/${page.file}`)
  }]));
  for (const page of UI_ATLAS_PAGES) {
    const value = pages.get(page.key)!;
    assert.equal(value.size.w, value.meta.meta.size.w);
    assert.equal(value.size.h, value.meta.meta.size.h);
    assert.ok(value.size.w <= 2048 && value.size.h <= 2048);
    assert.ok(value.meta.frames[page.frame], `missing sentinel frame: ${page.frame}`);
  }
  for (const file of uiAtlasFiles()) {
    assert.equal(UI_ICON_FRAMES[file], undefined, `file is in both atlases: ${file}`);
    const entry = UI_ATLAS_FRAMES[file];
    assert.ok(entry, `missing UI atlas mapping: ${file}`);
    const page = pages.get(entry.key);
    assert.ok(page, `missing UI atlas page: ${entry.key}`);
    const frame = page.meta.frames[entry.frame];
    assert.ok(frame, `missing UI atlas frame: ${entry.frame}`);
    assert.ok(!frame.trimmed && !frame.rotated, `UI atlas frame must not be trimmed or rotated: ${entry.frame}`);
    const rect = frame.frame, size = page.meta.meta.size;
    assert.ok(rect.w > 0 && rect.h > 0);
    assert.ok(rect.x >= 0 && rect.y >= 0 && rect.x + rect.w <= size.w && rect.y + rect.h <= size.h);
    const source = pngSize(`public/${entry.frame}`);
    assert.equal(rect.w, source.w);
    assert.equal(rect.h, source.h);
  }
});

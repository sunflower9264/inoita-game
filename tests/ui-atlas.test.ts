import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { uiAtlasFiles, uiAtlasGroups, uiAtlasSharedFiles, uiAtlasSourceDigest } from '../tools/build-ui-atlas.ts';
import { UI_ATLAS_FRAMES, UI_ATLAS_PAGES, UI_ATLAS_SOURCE_DIGEST } from '../src/generated/ui-atlas.ts';
import { UI_ICON_FRAMES } from '../src/generated/icon-atlas.ts';
import { COMMON_BUTTON_IMAGES } from '../src/ui/common-button.ts';
import { TITLE_MESSAGE_ASSETS, titleMenuImages } from '../src/application/menu-images.ts';
import { sourceAssetPath } from '../tools/asset-source.ts';
import { atlasImageSize } from './support/atlas-image.ts';

const content = (file: string): any => JSON.parse(fs.readFileSync(`public/content/${file}`, 'utf8'));

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
    size: atlasImageSize(`public/${page.file}`)
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
    const source = pngSize(sourceAssetPath(entry.frame));
    assert.equal(rect.w, source.w);
    assert.equal(rect.h, source.h);
  }
  assert.deepEqual(Object.keys(UI_ATLAS_FRAMES).sort(), uiAtlasFiles().sort(),
    'every atlas file path must have exactly one mapping entry');
});

test('UI atlas pages stay inside their load-package group', () => {
  const groups = uiAtlasGroups();
  const shared = uiAtlasSharedFiles();
  assert.ok(groups.length > 0);
  const pageGroups = new Set(UI_ATLAS_PAGES.map(page => page.group));
  const seen = new Set<string>();
  for (const group of groups) {
    assert.ok(group.files.length > 0, `empty group: ${group.name}`);
    assert.ok(pageGroups.has(group.name), `group has no page: ${group.name}`);
    for (const file of group.files) {
      assert.ok(!seen.has(file), `file is listed in two groups: ${file}`);
      seen.add(file);
      const entry = UI_ATLAS_FRAMES[file];
      assert.ok(entry, `missing UI atlas mapping: ${file}`);
      assert.equal(UI_ATLAS_PAGES[entry.page]!.group, group.name,
        `file landed on another group's page: ${file}`);
    }
  }
  for (const page of UI_ATLAS_PAGES) assert.ok(pageGroups.has(page.group), `unknown page group: ${page.group}`);
  // 内容相同的路径不重复铺帧，而是共用先出现的那一帧。
  for (const [file, canonical] of shared) {
    assert.ok(!seen.has(file), `shared file also owns a frame: ${file}`);
    assert.equal(UI_ATLAS_FRAMES[file]?.frame, UI_ATLAS_FRAMES[canonical]?.frame,
      `shared file does not reuse the canonical frame: ${file}`);
  }
  assert.equal(seen.size + shared.size, uiAtlasFiles().length);
});

test('title menu paths resolve to the title page once single-file exceptions are removed', () => {
  const single = new Set([
    ...COMMON_BUTTON_IMAGES,
    ...Object.values(TITLE_MESSAGE_ASSETS),
    'assets/ui/title-menu/background.png',
    'assets/ui/title-menu/logo.png'
  ].map(file => file.replace(/^\//, '')));
  for (const raw of titleMenuImages) {
    const file = raw.replace(/^\//, '');
    if (single.has(file)) {
      assert.equal(UI_ATLAS_FRAMES[file], undefined, `exception should stay outside the atlas: ${file}`);
      continue;
    }
    const entry = UI_ATLAS_FRAMES[file];
    assert.ok(entry, `missing UI atlas mapping: ${file}`);
    assert.equal(UI_ATLAS_PAGES[entry.page]!.group, 'title',
      `title first-screen image resolves to another group's page: ${file}`);
  }
});

test('shared buttons, title message bars and Phaser texture files stay on single-file loading', () => {
  const story = content('story-interface.json');
  const storyClasses = content('story-classes.json');
  const statusHud = content('status-hud.json');
  const controlSkin = content('control-skin.json');
  const files = [
    // 按钮皮肤按整张纹理取图，不能换成图集切片。
    ...COMMON_BUTTON_IMAGES,
    // 标题页只加载这 7 张提示条；进图集会提前拉整页。
    ...Object.values(TITLE_MESSAGE_ASSETS),
    // 任务窗按整张纹理使用。
    story.assets['quest-popup-window'],
    // 控件皮肤的文件路径同时是 Phaser 纹理键。
    ...Object.values(controlSkin),
    // 世界头顶血条和任务图标由 Phaser 直接取纹理。
    statusHud.assets['overhead-frame'], statusHud.assets['overhead-leader'],
    story.assets['minimap-ready'], story.assets['minimap-active'], story.assets['minimap-available'],
    // 职业选择背景由 Phaser 场景直接取纹理。
    storyClasses.background,
    // index.html 直接预载这两张图，必须保留原路径。
    'assets/ui/title-menu/background.png', 'assets/ui/title-menu/logo.png'
  ];
  for (const raw of files) {
    assert.equal(typeof raw, 'string');
    const file = String(raw).replace(/^\//, '');
    assert.equal(UI_ATLAS_FRAMES[file], undefined, `file should stay outside the UI atlas: ${file}`);
  }
});

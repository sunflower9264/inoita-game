import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { gameMenuImageGroups, titleMenuImages } from '../src/application/menu-images.ts';
import { COMMON_BUTTON_IMAGES } from '../src/ui/common-button.ts';
import { UI_ATLAS_FRAMES, UI_ATLAS_PAGES } from '../src/generated/ui-atlas.ts';
import { UI_ICON_ATLAS_DATA, UI_ICON_FRAMES } from '../src/generated/icon-atlas.ts';
import { uiImageFileNames } from '../src/ui/widgets.ts';

const content = (name: string) => JSON.parse(readFileSync(resolve('public/content', `${name}.json`), 'utf8'));

const atlasMeta = new Map<string, { frames: Record<string, unknown> }>();
function framesOf(data: string): Record<string, unknown> {
  let meta = atlasMeta.get(data);
  if (!meta) {
    meta = JSON.parse(readFileSync(resolve('public', data), 'utf8')) as { frames: Record<string, unknown> };
    atlasMeta.set(data, meta);
  }
  return meta.frames;
}

/** 菜单图片要么作为单文件留在 public，要么已经在图集页里有一帧。 */
function shippedImage(raw: string): boolean {
  const file = raw.replace(/^\/+/, '');
  if (existsSync(resolve('public', file))) return true;
  const ui = UI_ATLAS_FRAMES[file];
  if (ui) {
    const page = UI_ATLAS_PAGES[ui.page];
    return Boolean(page && framesOf(page.data)[ui.frame]);
  }
  const icon = UI_ICON_FRAMES[file];
  return Boolean(icon && framesOf(UI_ICON_ATLAS_DATA)[icon]);
}

test('game prepares every menu image from its content catalog', () => {
  const panels = content('menu-panels');
  const items = content('items');
  const battle = content('battle');
  const story = content('story-interface');

  const shops = content('shops');
  const groups = gameMenuImageGroups(panels, items, battle, story, shops);
  const images = [...new Set([...groups.core, ...groups.extra])];
  assert.equal(images.length, groups.core.length + groups.extra.length, 'duplicate image across groups');
  assert.ok(groups.core.includes(panels.assets['page-button-frame']), 'missing frame in core');
  assert.ok(!groups.core.includes(items.items[Object.keys(items.items)[0]].icon), 'item icons are background-loaded');
  assert.ok(groups.extra.includes(items.items[Object.keys(items.items)[0]].icon), 'missing item icon in extra');
  assert.ok(images.includes(panels.assets['page-button-frame']), 'missing menu skin');
  assert.ok(images.includes(items.items[Object.keys(items.items)[0]].icon), 'missing item icon');
  assert.ok(images.includes(battle.skills[Object.keys(battle.skills)[0]].icon), 'missing skill icon');
  for (const image of images) assert.ok(shippedImage(image), `missing ${image}`);

  assert.ok(images.includes(Object.values(story.assets)[0] as string));
  assert.ok(images.includes(Object.values(shops.assets)[0] as string));
  for (const image of titleMenuImages) assert.ok(shippedImage(image), `title: missing ${image}`);
  for(const image of COMMON_BUTTON_IMAGES){
    assert(images.includes(image),`game: missing shared button ${image}`);
    assert(titleMenuImages.includes(image),`title: missing shared button ${image}`);
    const png=readFileSync(resolve('public',image));
    assert.equal(png.readUInt32BE(16),470);
    assert.equal(png.readUInt32BE(20),image.includes('pressed')?119:112);
  }
});

test('a UI atlas frame without its page fails preload instead of loading the old file', () => {
  const file = Object.keys(UI_ATLAS_FRAMES)[0]!;
  const entry = UI_ATLAS_FRAMES[file]!;
  const page = entry.page;
  entry.page = UI_ATLAS_PAGES.length + 100;
  try {
    assert.throws(() => uiImageFileNames([file]), /界面图集缺页/);
  } finally {
    entry.page = page;
  }
});

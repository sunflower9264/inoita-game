import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { gameMenuImageGroups, titleMenuImages } from '../src/application/menu-images.ts';
import { COMMON_BUTTON_IMAGES } from '../src/ui/common-button.ts';

const content = (name: string) => JSON.parse(readFileSync(resolve('public/content', `${name}.json`), 'utf8'));

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
  for (const image of images) assert.ok(existsSync(resolve('public', image)), `missing ${image}`);

  assert.ok(images.includes(Object.values(story.assets)[0] as string));
  assert.ok(images.includes(Object.values(shops.assets)[0] as string));
  for (const image of titleMenuImages) assert.ok(existsSync(resolve('public', image.replace(/^\//,''))), `title: missing ${image}`);
  for(const image of COMMON_BUTTON_IMAGES){
    assert(images.includes(image),`game: missing shared button ${image}`);
    assert(titleMenuImages.includes(image),`title: missing shared button ${image}`);
    const png=readFileSync(resolve('public',image));
    assert.equal(png.readUInt32BE(16),470);
    assert.equal(png.readUInt32BE(20),image.includes('pressed')?119:112);
  }
});

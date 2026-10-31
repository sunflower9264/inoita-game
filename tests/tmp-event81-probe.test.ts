import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseBattle, parseCampaign, parseCharacterStats, parseCompanions, parseItemCatalog, parseMap, parseStoryClasses, parseStoryDebugCatalog, parseWorld } from '../src/application/content-validation.ts';
import { createHeadlessStory } from '../src/debug/headless-story.ts';
import { NavigationWorld } from '../src/domain/navigation-world.ts';
import type { WorldMap } from '../src/domain/content.ts';

const root = new URL('../public/content/', import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(`${name}.json`, root), 'utf8'));
const campaign = parseCampaign(read('campaign'));
campaign.debugStory = parseStoryDebugCatalog(read('debug/start'));
const world = parseWorld(read('world'));
const maps = new Map<string, WorldMap>(world.maps.map(reference => [reference.id, parseMap(read('maps/' + reference.id))]));

test('probe event-81', async () => {
  const story = createHeadlessStory({
    campaign, world, maps,
    items: parseItemCatalog(read('items')),
    battle: parseBattle(read('battle')),
    stats: parseCharacterStats(read('character-stats')),
    companions: parseCompanions(read('companions')),
    storyClasses: parseStoryClasses(read('story-classes')),
  });
  story.travel({ map: 'east-kamuran-b52d2b0e', x: 520, y: 136, facing: 'south' });
  const event = campaign.events.find(row => row.id === 'event-81')!;
  const result = await story.replayEvent(event);
  const state = story.capture();
  console.log('result', result);
  console.log('location', story.session.storyWorld.currentLocation);
  const flames = state.storyWorld.entities.filter(entity => entity.actor?.includes('flame'));
  console.log('flames', flames.map(entity => ({ id: entity.id, x: entity.x, y: entity.y, visible: entity.visible })));
  const map = maps.get('east-kamuran-b52d2b0e')!;
  const navigation = new NavigationWorld(map);
  const actor = (x: number, y: number, collision: { x: number; y: number; width: number; height: number }, faction: 'party' | 'neutral') => ({
    shape: () => ({ collision }),
    position: () => ({ x, y }),
    enabled: () => true,
    faction: () => faction,
  });
  const player = actor(488, 136, { x: -8, y: -8, width: 16, height: 16 }, 'party');
  navigation.register(player);
  for (const flame of flames)
    navigation.register(actor(flame.x!, flame.y!, { x: -24, y: -32, width: 48, height: 40 }, 'neutral'));
  navigation.register(actor(520, 136, { x: -8, y: -8, width: 16, height: 16 }, 'neutral'));
  navigation.register(actor(568, 136, { x: -8, y: -8, width: 16, height: 16 }, 'neutral'));
  navigation.register(actor(568, 184, { x: -8, y: -8, width: 16, height: 16 }, 'neutral'));
  navigation.register(actor(552, 344, { x: -8, y: -8, width: 16, height: 16 }, 'neutral'));
  navigation.register(actor(472, 440, { x: -8, y: -8, width: 16, height: 16 }, 'neutral'));
  console.log('path south-west', navigation.path(player, { x: 24, y: 392 })?.length);
  for (const start of [
    { x: 520, y: 136 }, { x: 520, y: 104 }, { x: 504, y: 120 }, { x: 504, y: 136 },
    { x: 536, y: 120 }, { x: 536, y: 136 }, { x: 520, y: 152 }, { x: 552, y: 120 },
    { x: 552, y: 136 }, { x: 568, y: 120 }, { x: 488, y: 120 }, { x: 488, y: 152 },
  ]) {
    const spot = actor(start.x, start.y, { x: -8, y: -8, width: 16, height: 16 }, 'party');
    console.log('start', start, 'canStand', navigation.canStand(spot, start), 'path', navigation.path(spot, { x: 24, y: 392 })?.length);
  }
  assert.ok(result.status === 'completed');
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { StoryWorldState } from '../src/domain/story-world.ts';
import type { Campaign } from '../src/domain/campaign.ts';
import type { WorldMap } from '../src/domain/content.ts';

const read = (file: string): unknown => JSON.parse(readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8'));
const campaign = read('content/campaign.json') as Campaign;
const world = read('content/world.json') as { maps: { id: string; file: string }[] };
const map = (id: string): WorldMap => {
  const reference = world.maps.find(value => value.id === id);
  assert.ok(reference, id);
  return read(reference.file) as WorldMap;
};
const worldCommands = (script: string, node?: string) => campaign.scripts[script].nodes
  .filter(value => node === undefined || value.id === node)
  .flatMap(value => value.commands)
  .filter(command => command.type === 'world')
  .map(command => command.command);

test('event-151 hides the static gate doors on land-of-exile-8, not just the staged copies', () => {
  const gate = map('land-of-exile-8-49bd8b1f');
  const state = new StoryWorldState();
  state.apply({ kind: 'travel', destination: { map: gate.id, x: 168, y: 96, facing: 'south' } });
  assert.deepEqual(state.projectEntities(gate.id, gate.entities).filter(entity => entity.characterId === 'npc-306').length,
    3, '事件前地图上本来有三段静态铁门');
  for (const command of worldCommands('event-151', 'scene-2')) state.apply(command);
  assert.deepEqual(state.projectEntities(gate.id, gate.entities).filter(entity => entity.characterId === 'npc-306'), [],
    'remove-character all:true 必须同时清掉静态铁门');
  state.apply({ kind: 'travel', destination: { map: 'land-of-exile-4-dffe6d0c', x: 168, y: 24, facing: 'south' } });
  state.apply({ kind: 'travel', destination: { map: gate.id, x: 168, y: 96, facing: 'south' } });
  assert.deepEqual(state.projectEntities(gate.id, gate.entities).filter(entity => entity.characterId === 'npc-306'), [],
    '离开再回来，已移除的铁门不能复活');
});

test('event-51 clears the boulders that event-50 placed over the castle exit', () => {
  const castle = map('inside-arnen-castle01-8b6ce276');
  const state = new StoryWorldState();
  state.apply({ kind: 'travel', destination: { map: castle.id, x: 104, y: 104, facing: 'south' } });
  for (const command of worldCommands('event-50')) state.apply(command);
  assert.ok(state.projectEntities(castle.id, castle.entities).some(entity => entity.characterId === 'npc-134'));
  for (const command of worldCommands('event-51')) state.apply(command);
  assert.deepEqual(state.projectEntities(castle.id, castle.entities)
    .filter(entity => entity.characterId === 'npc-134' || entity.characterId === 'npc-303'), [],
  '事件 51 收尾后出口巨石必须全部消失');
});

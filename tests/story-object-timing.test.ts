import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { StoryScript } from '../src/domain/story-graph.ts';
import type { PerformanceAction } from '../src/domain/story-performance.ts';

const campaign = JSON.parse(readFileSync(new URL('../public/content/campaign.json', import.meta.url), 'utf8')) as {
  scripts: Record<string, StoryScript>;
};
type PresentationAction = StoryScript['nodes'][number]['presentation'][number];
const flatten = (actions: readonly PresentationAction[]): PresentationAction[] =>
  actions.flatMap(action => action.type === 'parallel' ? flatten(action.actions) : [action]);

test('published native object appearances and removals keep their immediate action and atomic commit together', () => {
  let places = 0, removals = 0;
  for (const [id, script] of Object.entries(campaign.scripts)) {
    if (!id.startsWith('event-')) continue;
    for (const node of script.nodes) {
      for (const action of flatten(node.presentation)) {
        if (action.type !== 'world-object') continue;
        assert.ok(node.commands.some(command => command.type === 'world'
          && JSON.stringify(command.command) === JSON.stringify(action.command)), `${id}/${node.id}`);
        if (action.command.kind === 'place') {
          places++;
          assert.ok(action.target);
          assert.ok(action.mode === 'create' || action.mode === 'reuse');
        } else if (action.command.kind === 'remove-character') removals++;
      }
    }
  }
  assert.equal(places, 559);
  assert.equal(removals, 219);
});

test('the mine gate disappears after its location effect and before the next dialogue', () => {
  const actions = flatten(campaign.scripts['event-64'].nodes[0].presentation);
  const removed = actions.findIndex(action => action.type === 'world-object'
    && action.command.kind === 'remove-character');
  assert.ok(removed > 0);
  assert.ok(actions.slice(0, removed).some(action => action.type === 'location-effect'));
  assert.ok(actions.slice(removed + 1).some(action => action.type === 'dialogue'));
});

test('late static placements declare aliases without showing the veteran, gates, or campfire at scene entry', () => {
  for (const event of [23, 123, 362, 363]) {
    let stage: Extract<PerformanceAction, { type: 'stage' }> | undefined;
    for (const node of campaign.scripts[`event-${event}`].nodes) {
      for (const action of flatten(node.presentation)) {
        if (action.type === 'stage') stage = action;
        if (action.type !== 'world-object' || action.command.kind !== 'place') continue;
        const alias = stage?.cast.find(member => member.id === action.target);
        assert.ok(alias, `${event}/${node.id}/${action.target}`);
        assert.equal(alias.binding, 'world');
        assert.equal(alias.characterId, action.command.entity.characterId);
        assert.equal(alias.visible, false);
      }
    }
  }
});

test('same-kind repeated goblins retain explicit create intent instead of collapsing into one reused actor', () => {
  const appearances = campaign.scripts['event-23'].nodes.flatMap(node => flatten(node.presentation))
    .filter((action): action is Extract<PerformanceAction, {type:'appear'}> => action.type === 'appear' && action.mode === 'create');
  assert.ok(appearances.length >= 6);
  const counts = new Map<string, number>();
  for (const action of appearances) counts.set(action.target, (counts.get(action.target) ?? 0) + 1);
  assert.ok([...counts.values()].some(count => count >= 6));
  const repeated = appearances.filter(action => counts.get(action.target)! >= 6);
  const ids = repeated.map(action => action.worldEntityId);
  assert.ok(ids.every(Boolean));
  assert.equal(new Set(ids).size, ids.length);
  const committedIds = campaign.scripts['event-23'].nodes.flatMap(node => node.commands)
    .flatMap(command => command.type === 'world' && command.command.kind === 'place' ? [command.command.entity.id] : []);
  assert.ok(ids.every(id => committedIds.includes(id!)));
});

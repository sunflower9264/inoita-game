import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { localStoryScripts, storyReachableScripts } from '../src/domain/story-entry.ts';

const realCampaign = JSON.parse(readFileSync(new URL('../public/content/campaign.json', import.meta.url), 'utf8')) as Parameters<typeof localStoryScripts>[0]['campaign'];

const end = { type: 'end' as const };
const stage = (map: string) => ({ type: 'stage' as const, map, x: 0, y: 0, facing: 'south' as const, playerVisible: true, cast: [] });

function campaign() {
  return {
    scripts: {
      start: { entry: 'n', nodes: [{ id: 'n', presentation: [stage('start-next')], commands: [], exit: end }] },
      entry: { entry: 'n', nodes: [{ id: 'n', presentation: [stage('entry-next')], commands: [], exit: end }] },
      region: { entry: 'n', nodes: [{ id: 'n', presentation: [stage('region-next')], commands: [], exit: end }] },
      near: { entry: 'n', nodes: [{ id: 'n', presentation: [stage('near-next')], commands: [], exit: end }] },
      interact: { entry: 'n', nodes: [{ id: 'n', presentation: [stage('interact-next')], commands: [], exit: end }] },
      quest: { entry: 'n', nodes: [{ id: 'n', presentation: [stage('quest-next')], commands: [], exit: end }] },
      battle: { entry: 'n', nodes: [{ id: 'n', presentation: [stage('battle-next')], commands: [], exit: end }] }
    },
    events: [
      { id: 'e-start', source: 'start', script: 'start' },
      { id: 'e-entry', source: 'map-entry', key: 'map-a', script: 'entry' },
      { id: 'e-region', source: 'region', map: 'map-a', script: 'region' },
      { id: 'e-near', source: 'near', near: 'npc-actor', nearCharacterId: 'npc-1', script: 'near' },
      { id: 'e-battle', source: 'battle', key: 'defeat:goblin', script: 'battle' }
    ],
    placements: [
      { id: 'placement-id-1', map: 'map-a', actor: 'npc-actor', characterId: 'npc-1', x: 1, y: 2, condition: { type: 'always', value: true } }
    ],
    mapEntryPlacements: [],
    quests: [
      { id: 'q1', giver: 'npc-actor', giverCharacterId: 'npc-1', offerScript: 'quest', completeScript: null }
    ]
  } as unknown as Parameters<typeof localStoryScripts>[0]['campaign'];
}

const map = { id: 'map-a', entities: [{ id: 'chest', actor: 'chest-actor', x: 0, y: 0 }] } as unknown as Parameters<typeof localStoryScripts>[0]['map'];

function completed(openingFinished: boolean): string[] {
  return openingFinished ? ['e-start'] : [];
}

test('local scripts cover start, map-entry, region, near by actor, interaction, quest and battle', () => {
  const scripts = localStoryScripts({ campaign: campaign(), map, completedEvents: completed(false), enemyIds: ['goblin'] });
  assert.deepEqual(scripts.sort(), ['battle', 'entry', 'near', 'quest', 'region', 'start']);
});

test('an opening-finished session does not preload the start script', () => {
  const scripts = localStoryScripts({ campaign: campaign(), map, completedEvents: completed(true), enemyIds: ['goblin'] });
  assert.ok(!scripts.includes('start'));
});

test('completed one-time events do not preload while repeatable events remain eligible', () => {
  const data = campaign();
  data.events = data.events.map(event => event.id === 'e-region' ? { ...event, repeat: true } : event);
  const scripts = localStoryScripts({ campaign: data, map, completedEvents: ['e-start', 'e-entry', 'e-region', 'e-near', 'e-battle'], enemyIds: ['goblin'] });
  assert.ok(!scripts.includes('start'));
  assert.ok(!scripts.includes('entry'));
  assert.ok(!scripts.includes('near'));
  assert.ok(!scripts.includes('battle'));
  assert.ok(scripts.includes('region'));
});

test('near events match the actor and character, not the placement id', () => {
  const found = localStoryScripts({ campaign: campaign(), map, completedEvents: completed(true) });
  assert.ok(found.includes('near'), 'placement.id 不能作为 near 的匹配键，必须按 actor 命中');
  const wrong = campaign();
  wrong.events = wrong.events.map(event => event.id === 'e-near' ? { ...event, nearCharacterId: 'other-npc' } : event);
  const scripts = localStoryScripts({ campaign: wrong, map, completedEvents: completed(true) });
  assert.ok(!scripts.includes('near'));
});

test('afterInteractScript on a map entity is preloaded even without an event', () => {
  const withInteract = { ...map, entities: [{ id: 'chest', actor: 'chest-actor', x: 0, y: 0, afterInteractScript: 'interact' }] };
  const scripts = localStoryScripts({ campaign: campaign(), map: withInteract, completedEvents: completed(true) });
  assert.ok(scripts.includes('interact'));
});

test('a quest event whose active quest can play out on this map is prefetched, but not on unrelated maps', () => {
  const questStatus = (id: string) => id === 'quest-22' ? 'active' : 'locked';
  const cave = localStoryScripts({ campaign: realCampaign, map: { id: 'silent-cave-depths', entities: [] }, completedEvents: completed(true), questStatus });
  assert.ok(cave.includes('event-5'), '洞穴里的任务事件应在进图时一起预取，战斗结束后不再等加载');
  const camp = localStoryScripts({ campaign: realCampaign, map: { id: 'shadow-camp', entities: [] }, completedEvents: completed(true), questStatus });
  assert.ok(!camp.includes('event-5'), '与这张图无关的任务事件不应拖累入口加载');
  const idle = localStoryScripts({ campaign: realCampaign, map: { id: 'silent-cave-depths', entities: [] }, completedEvents: completed(true), questStatus: () => 'locked' });
  assert.ok(!idle.includes('event-5'), '任务没在进行中时不预取');
});

test('reachable scripts follow called scripts as well as the caller continuation', () => {
  const graph = {
    scripts: {
      main: { entry: 'n1', nodes: [
        { id: 'n1', presentation: [], commands: [], exit: { type: 'call', target: { script: 'side', node: 's1' }, then: { script: 'main', node: 'n2' } } },
        { id: 'n2', presentation: [], commands: [], exit: end }
      ] },
      side: { entry: 's1', nodes: [{ id: 's1', presentation: [], commands: [], exit: end }] }
    }
  } as unknown as Parameters<typeof storyReachableScripts>[0];
  assert.deepEqual(storyReachableScripts(graph, ['main']).sort(), ['main', 'side']);
});

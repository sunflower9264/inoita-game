import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseCampaign } from '../src/application/content-validation.ts';
import { Session } from '../src/domain/session.ts';
import { WorldEnemyRoster, encounterSpawnId } from '../src/domain/world-enemies.ts';
import type { WorldMap } from '../src/domain/content.ts';
import { StoryWorldState } from '../src/domain/story-world.ts';
import type { EntityPlacement } from '../src/domain/content.ts';

/** 原版 MAPTRASHSYSTEM 保存已清除对象；地图加载只生成不在名单内的对象。 */
const read = (name: string) => JSON.parse(fs.readFileSync(new URL(`../public/content/${name}.json`, import.meta.url), 'utf8'));
const campaign = parseCampaign(read('campaign'));
const index = read('world') as { maps: { id: string; file: string }[] };
const world = {
  entities: new Map(index.maps.map(map => {
    const path = map.file.replace(/^content\//, '').replace(/\.json$/, '');
    return [map.id, (read(path) as { entities: EntityPlacement[] }).entities] as const;
  }))
};

test('native blacklist Add suppresses steel doors and Remove allows their next appearance', () => {
  const commands = (script: string) => campaign.scripts[script].nodes.flatMap(node => node.commands)
    .filter(command => command.type === 'world').map(command => command.command);
  const opening = commands('event-110').filter(command => command.kind === 'actor-visibility');
  assert.ok(opening.length >= 2);
  assert.ok(opening.every(command => command.kind === 'actor-visibility' && !command.visible));
  const restoring = commands('event-331').filter(command => command.kind === 'actor-visibility');
  assert.ok(restoring.some(command => command.kind === 'actor-visibility' && command.visible
    && command.map === 'hall-of-afterlife-0780bd4c'));
});

test('object absence is scoped to map and actor and survives saving before the map is visited', () => {
  const actor='steel-door-185c9338', entity={id:'door',actor,x:24,y:24};
  const state=new StoryWorldState();
  state.apply({kind:'actor-visibility',map:'fortress',actor,visible:false});
  state.apply({kind:'place',entity:{...entity,id:'dynamic-door',map:'fortress'}});
  assert.deepEqual(state.projectEntities('fortress',[entity]),[]);
  assert.equal(state.projectEntities('another-fortress',[entity]).length,1);
  const restored=new StoryWorldState(); restored.restoreState(state.captureState());
  assert.deepEqual(restored.projectEntities('fortress',[entity]),[]);
  restored.apply({kind:'actor-visibility',map:'fortress',actor,visible:true});
  assert.equal(restored.projectEntities('fortress',[entity]).length,2);
});

test('a removed map object disappears from the projection and comes back on registration', () => {
  const map = 'fort-of-screams-floor-3-c78c50b3', id = 'steel-door-185c9338-006';
  const base = world.entities.get(map)!;
  assert.ok(base.some(entity => entity.id === id), '铁门本来就在地图上');
  const storyWorld = new StoryWorldState();
  assert.ok(storyWorld.projectEntities(map, base).some(entity => entity.id === id));
  storyWorld.apply({ kind: 'remove', id });
  assert.equal(storyWorld.projectEntities(map, base).some(entity => entity.id === id), false, '撤下之后地图上不再有它');
  storyWorld.apply({ kind: 'show', id });
  assert.ok(storyWorld.projectEntities(map, base).some(entity => entity.id === id), '再登记回来');
  // 存档口径：这些覆盖随世界状态一起存取，读回之后仍然生效。
  storyWorld.apply({ kind: 'remove', id });
  const restored = new StoryWorldState();
  restored.restoreState(storyWorld.captureState());
  assert.equal(restored.projectEntities(map, base).some(entity => entity.id === id), false, '读档后仍然撤下');
});


test('blacklisted map enemies are withheld while cinematic encounter spawns remain independent', () => {
  const state=new StoryWorldState();
  state.apply({kind:'enemy-availability',map:'forest',enemyId:'wolf',available:false});
  const restored=new StoryWorldState(); restored.restoreState(state.captureState());
  assert.equal(restored.enemyAvailable('forest','wolf'),false);
  assert.equal(restored.enemyAvailable('cave','wolf'),true);
  restored.apply({kind:'enemy-availability',map:'forest',enemyId:'wolf',available:true});
  assert.equal(restored.enemyAvailable('forest','wolf'),true);
});


test('a real map roster filters cleared generation points and keeps explicit encounter actors', () => {
  const map=read('maps/shadow-forest-west') as WorldMap, spawn=map.enemySpawns![0];
  assert.ok(spawn);
  const session=new Session(campaign);
  session.storyWorld.apply({kind:'enemy-availability',map:map.id,enemyId:spawn.enemyId,available:false});
  session.storyWorld.apply({kind:'encounter',encounter:{id:'movie',map:map.id,status:'active',spawns:[{id:'wolf',enemyId:spawn.enemyId,x:spawn.x+32,y:spawn.y}]}});
  const roster=new WorldEnemyRoster(session,{...map,enemySpawns:[spawn]},[],1);
  assert.deepEqual(roster.spawns.map(spawn=>spawn.id),[encounterSpawnId('movie','wolf')]);
  session.storyWorld.apply({kind:'enemy-availability',map:map.id,enemyId:spawn.enemyId,available:true});
  assert.ok(roster.spawns.some(candidate=>candidate.id===spawn.id));
});

test('an encounter that starts on a resident spawn leaves only one enemy there', () => {
  const map=read('maps/shadow-forest-west') as WorldMap, spawn=map.enemySpawns![0];
  assert.ok(spawn);
  const session=new Session(campaign);
  const roster=new WorldEnemyRoster(session,{...map,enemySpawns:[spawn]},[],1);
  assert.deepEqual(roster.spawns.map(candidate=>candidate.id),[spawn.id]);
  session.storyWorld.apply({kind:'encounter',encounter:{id:'event-72',map:map.id,status:'active',
    spawns:[{id:'guard',enemyId:spawn.enemyId,x:spawn.x,y:spawn.y}]}});
  assert.deepEqual(roster.spawns.map(candidate=>candidate.id),[encounterSpawnId('event-72','guard')]);
});

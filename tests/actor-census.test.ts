import assert from 'node:assert/strict';
import test from 'node:test';
import type { SceneActorState } from '../src/domain/scene-snapshot.ts';
import { actorInstanceKey, assertUniqueActorInstances, duplicateVisibleActors } from '../src/domain/actor-census.ts';

const actor = (id: string, extra: Partial<SceneActorState> = {}): SceneActorState => ({
  id, actor: 'guard', x: 10, y: 20, facing: 'south', visible: true, ...extra,
});

test('actor identity uses the source instance instead of the shared character number', () => {
  assert.equal(actorInstanceKey(actor('one', {worldEntityId: 'entity-one', characterId: 'npc-1'})), 'world:entity-one');
  assert.equal(actorInstanceKey(actor('two', {memberId: 'ally'})), 'member:ally');
  assert.equal(actorInstanceKey(actor('three', {enemyKey: 'wolf-1', enemyId: 'wolf'})), 'enemy:wolf-1');
  assert.equal(actorInstanceKey(actor('four', {characterId: 'npc-1'})), 'story:four');
});

test('two different map entities sharing a character number are not duplicates', () => {
  const actors = [
    actor('one', {worldEntityId: 'entity-one', characterId: 'npc-1'}),
    actor('two', {worldEntityId: 'entity-two', characterId: 'npc-1'}),
  ];
  assert.equal(duplicateVisibleActors(actors).size, 0);
});

test('the same instance drawn twice is reported, while a hidden copy is not a visual duplicate', () => {
  const actors = [
    actor('one', {worldEntityId: 'entity-one'}),
    actor('two', {worldEntityId: 'entity-one'}),
    actor('hidden', {worldEntityId: 'entity-two', visible: false}),
    actor('hidden-again', {worldEntityId: 'entity-two', visible: false}),
  ];
  assert.deepEqual([...duplicateVisibleActors(actors).keys()], ['world:entity-one']);
  assert.throws(() => assertUniqueActorInstances(actors, '测试舞台'), /测试舞台演员实例重复.*entity-one/);
});

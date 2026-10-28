import assert from 'node:assert/strict';
import test from 'node:test';
import type {SceneActorState,SceneSnapshot} from '../src/domain/scene-snapshot.ts';
import {actorRefFromState,actorRefKey} from '../src/domain/actor-ref.ts';
import {assertScenePlan,planScene} from '../src/domain/scene-plan.ts';

const actor=(id:string,extra:Partial<SceneActorState>={}):SceneActorState=>({
  id,actor:'guard',x:10,y:20,facing:'south',visible:true,...extra,
});
const snapshot=(actors:SceneActorState[]):SceneSnapshot=>({map:'camp',actors});

test('actor references carry their scope instead of using a global id',()=>{
  const left=actorRefFromState(actor('one',{worldEntityId:'gate'}),{map:'camp'});
  const right=actorRefFromState(actor('two',{worldEntityId:'gate'}),{map:'other'});
  assert.notEqual(actorRefKey(left),actorRefKey(right));
  assert.equal(actorRefKey(left),'world|camp|gate');
});

test('a party instance wins over a world copy field',()=>{
  const ref=actorRefFromState(actor('olaf',{memberId:'story-mercenary-olaf',worldEntityId:'story-character-npc-249'}),{map:'camp'});
  assert.deepEqual(ref,{source:'party',memberId:'story-mercenary-olaf'});
});

test('the scene plan rejects two visible actors for one source instance',()=>{
  const plan=planScene(snapshot([
    actor('first',{worldEntityId:'gate'}),
    actor('second',{worldEntityId:'gate'}),
  ]));
  assert.equal(plan.visible.get('world|camp|gate')?.length,2);
  assert.throws(()=>assertScenePlan(plan),/场景计划演员实例重复.*world\|camp\|gate/);
});

test('hidden copies stay out of the visible plan and actor aliases stay separate',()=>{
  const plan=planScene(snapshot([
    actor('first',{worldEntityId:'gate'}),
    actor('hidden',{worldEntityId:'gate',visible:false}),
  ]),[['gate','first']]);
  assert.equal(plan.visible.get('world|camp|gate')?.length,1);
  assert.deepEqual(plan.actors.find(entry=>entry.actorId==='first')?.aliases,['gate']);
  assert.doesNotThrow(()=>assertScenePlan(plan));
});

test('two aliases cannot point at the same plan actor',()=>{
  const plan=planScene(snapshot([actor('first',{worldEntityId:'gate'})]),[['one','first'],['two','first']]);
  assert.throws(()=>assertScenePlan(plan),/场景计划演员重复绑定/);
});


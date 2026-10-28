import assert from 'node:assert/strict';
import test from 'node:test';
import type {SceneActorState,SceneSnapshot} from '../src/domain/scene-snapshot.ts';
import {diffSceneActors} from '../src/domain/scene-delta.ts';

const actor=(id:string,extra:Partial<SceneActorState>={}):SceneActorState=>({
  id,actor:'guard',x:10,y:20,facing:'south',visible:true,...extra,
});
const snapshot=(actors:SceneActorState[]):SceneSnapshot=>({map:'camp',actors});

test('scene deltas follow source refs and report appear, update and remove',()=>{
  const before=snapshot([
    actor('gate',{worldEntityId:'gate',x:10}),
    actor('ally',{memberId:'ally',visible:false}),
  ]);
  const after=snapshot([
    actor('gate',{worldEntityId:'gate',x:30}),
    actor('npc',{worldEntityId:'npc',x:40}),
  ]);
  const delta=diffSceneActors(before,after);
  assert.deepEqual(delta.changes.map(change=>[change.kind,change.ref]),[
    ['update',{source:'world',map:'camp',entityId:'gate'}],
    ['appear',{source:'world',map:'camp',entityId:'npc'}],
    ['remove',{source:'party',memberId:'ally'}],
  ]);
});

test('scene deltas ignore purely visual fields that are not in the commit contract',()=>{
  const before=snapshot([actor('gate',{worldEntityId:'gate',clip:'idle-south'})]);
  const after=snapshot([actor('gate',{worldEntityId:'gate',clip:'walk-east',alpha:.4})]);
  assert.deepEqual(diffSceneActors(before,after).changes,[]);
});

test('scene deltas reject duplicate source instances before they reach commit',()=>{
  assert.throws(()=>diffSceneActors(snapshot([],),snapshot([
    actor('one',{worldEntityId:'gate'}),
    actor('two',{worldEntityId:'gate'}),
  ])),/场景差量演员实例重复/);
});

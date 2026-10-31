import type {SceneActorState,SceneSnapshot} from './scene-snapshot.ts';
import {actorRefFromState,actorRefKey,type ActorRef} from './actor-ref.ts';

export interface SceneActorDelta {
  ref:ActorRef;
  kind:'appear'|'update'|'remove';
  before?:SceneActorState;
  after?:SceneActorState;
}

export interface SceneDelta {
  map:string;
  changes:SceneActorDelta[];
}

function changed(before:SceneActorState,after:SceneActorState):boolean {
  return before.actor!==after.actor||before.x!==after.x||before.y!==after.y||before.facing!==after.facing
    ||before.visible!==after.visible||!!before.removed!==!!after.removed
    ||!!before.stageHidden!==!!after.stageHidden||!!before.unpositioned!==!!after.unpositioned
    ||before.worldEntityId!==after.worldEntityId||before.characterId!==after.characterId
    ||before.authority!==after.authority;
}

/**
 * 按 ActorRef 比较同一张地图的舞台状态，产生类型化差量。
 * 这是新提交层的纯函数基础，不修改任何快照。
 */
export function diffSceneActors(before:SceneSnapshot|undefined,after:SceneSnapshot,runId?:string):SceneDelta {
  const previous=new Map<string,SceneActorState>();
  for(const actor of before?.actors??[]){
    const key=actorRefKey(actorRefFromState(actor,{map:before!.map,runId}));
    if(previous.has(key))throw new Error(`场景差量基线演员实例重复：${key}`);
    previous.set(key,actor);
  }
  const changes:SceneActorDelta[]=[];
  const current=new Set<string>();
  for(const actor of after.actors){
    const ref=actorRefFromState(actor,{map:after.map,runId}),key=actorRefKey(ref);
    if(current.has(key))throw new Error(`场景差量演员实例重复：${key}`);
    current.add(key);
    const old=previous.get(key);
    if(!old)changes.push({ref,kind:'appear',after:actor});
    else if(changed(old,actor))changes.push({ref,kind:'update',before:old,after:actor});
  }
  for(const [key,actor] of previous)if(!current.has(key))changes.push({ref:actorRefFromState(actor,{map:before!.map,runId}),kind:'remove',before:actor});
  return {map:after.map,changes};
}

import type {SceneActorState} from './scene-snapshot.ts';

/**
 * 带作用域的演员实例引用。
 *
 * 地图实体编号只在单图唯一，所以 world 必须带 map；敌人实例只在一次战斗/遭遇里
 * 唯一，所以 combat 带地图和遭遇作用域；故事替身只在一次演出运行里唯一。
 * alias 只是本次演出的绑定名，不属于 ActorRef。
 */
export type ActorRef =
  | {source:'world';map:string;entityId:string}
  | {source:'party';memberId:string}
  | {source:'combat';map:string;encounterId?:string;enemyKey:string}
  | {source:'story';runId:string;instanceId:string};

export interface ActorRefContext {
  map:string;
  runId?:string;
  encounterId?:string;
}

export function actorRefKey(ref:ActorRef):string {
  switch(ref.source){
    case 'world':return `world|${ref.map}|${ref.entityId}`;
    case 'party':return `party|${ref.memberId}`;
    case 'combat':return `combat|${ref.map}|${ref.encounterId??''}|${ref.enemyKey}`;
    case 'story':return `story|${ref.runId}|${ref.instanceId}`;
  }
}

/** 旧 SceneActorState 的兼容适配器；新的计划/提交层只持有 ActorRef。 */
export function actorRefFromState(actor:SceneActorState,context:ActorRefContext):ActorRef {
  if(actor.memberId)return {source:'party',memberId:actor.memberId};
  if(actor.enemyKey)return {source:'combat',map:context.map,encounterId:context.encounterId,enemyKey:actor.enemyKey};
  if(actor.worldEntityId)return {source:'world',map:context.map,entityId:actor.worldEntityId};
  return {source:'story',runId:context.runId??'scene',instanceId:actor.id};
}

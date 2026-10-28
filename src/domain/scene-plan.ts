import type {SceneActorState,SceneSnapshot} from './scene-snapshot.ts';
import {actorRefFromState,actorRefKey,type ActorRef} from './actor-ref.ts';

export interface PlannedActor {
  /** 稳定实例引用；alias 不在这里。 */
  ref:ActorRef;
  refKey:string;
  /** 本次场景快照里的演员 id；只用于兼容旧数据和调试。 */
  actorId:string;
  actor:SceneActorState;
  /** 指向这个演员的舞台别名。 */
  aliases:string[];
}

export interface ScenePlan {
  map:string;
  actors:PlannedActor[];
  /** 可见实例按 refKey 分组；每份状态必须只有一个可见演员。 */
  visible:Map<string,PlannedActor[]>;
  bindings:Map<string,string>;
}

/** 从当前快照派生只读计划；不修改快照，也不写回世界。 */
export function planScene(snapshot:SceneSnapshot,bindings:readonly (readonly [string,string])[]=[],runId?:string):ScenePlan {
  const aliasesByActor=new Map<string,string[]>();
  const bindingMap=new Map<string,string>();
  for(const [alias,actorId] of bindings){
    bindingMap.set(alias,actorId);
    const aliases=aliasesByActor.get(actorId);
    if(aliases)aliases.push(alias);else aliasesByActor.set(actorId,[alias]);
  }
  const actors=snapshot.actors.map(actor=>{
    const ref=actorRefFromState(actor,{map:snapshot.map,runId});
    return {ref,refKey:actorRefKey(ref),actorId:actor.id,actor,aliases:[...(aliasesByActor.get(actor.id)??[])]};
  });
  const visible=new Map<string,PlannedActor[]>();
  for(const planned of actors){
    if(!planned.actor.visible||planned.actor.removed||planned.actor.stageHidden)continue;
    const same=visible.get(planned.refKey);
    if(same)same.push(planned);else visible.set(planned.refKey,[planned]);
  }
  return {map:snapshot.map,actors,visible,bindings:bindingMap};
}

export function assertScenePlan(plan:ScenePlan):void {
  const duplicates=[...plan.visible].filter(([,actors])=>actors.length>1);
  if(duplicates.length){
    const detail=duplicates.map(([key,actors])=>`${key} → ${actors.map(actor=>actor.actorId).join(', ')}`).join('；');
    throw new Error(`场景计划演员实例重复：${detail}`);
  }
  const owner=new Map<string,string>();
  for(const [alias,actorId] of plan.bindings){
    if(!plan.actors.some(actor=>actor.actorId===actorId))throw new Error(`场景计划绑定缺失：${alias} → ${actorId}`);
    const previous=owner.get(actorId);
    if(previous)throw new Error(`场景计划演员重复绑定：${previous} 与 ${alias} → ${actorId}`);
    owner.set(actorId,alias);
  }
}

/** 比较两份计划的可见实例；用于 shadow 报告，不用于生产判断。 */
export function diffScenePlans(left:ScenePlan,right:ScenePlan):{map:string;onlyLeft:string[];onlyRight:string[];changed:string[]} {
  const leftKeys=new Set(left.visible.keys()),rightKeys=new Set(right.visible.keys());
  return {
    map:left.map,
    onlyLeft:[...leftKeys].filter(key=>!rightKeys.has(key)),
    onlyRight:[...rightKeys].filter(key=>!leftKeys.has(key)),
    changed:[...leftKeys].filter(key=>rightKeys.has(key)
      && left.visible.get(key)![0]!.actorId!==right.visible.get(key)![0]!.actorId),
  };
}

import type { SceneActorState } from './scene-snapshot.ts';

/**
 * 场景演员的唯一实例键。
 *
 * `characterId` 是人物编号，不是实例编号：同一张图上可以有多盏火把、几块同样的
 * 路障或多名同外观士兵。真正判断“这是不是同一个人”要用这份来源键。
 */
export function actorInstanceKey(actor: SceneActorState): string {
  if (actor.worldEntityId) return `world:${actor.worldEntityId}`;
  if (actor.memberId) return `member:${actor.memberId}`;
  if (actor.enemyKey) return `enemy:${actor.enemyKey}`;
  return `story:${actor.id}`;
}

/** 同一实例键出现两个可见演员，就是舞台上多画了一份；隐藏的那份不算画面重复。 */
export function duplicateVisibleActors(actors: readonly SceneActorState[]): Map<string, SceneActorState[]> {
  const groups = new Map<string, SceneActorState[]>();
  for (const actor of actors) {
    if (!actor.visible || actor.removed || actor.stageHidden) continue;
    const key = actorInstanceKey(actor);
    const same = groups.get(key);
    if (same) same.push(actor);
    else groups.set(key, [actor]);
  }
  for (const [key, same] of groups) if (same.length < 2) groups.delete(key);
  return groups;
}

/** 在解析舞台、检查点和恢复快照的边界上执行，防止重复演员静默进入画面。 */
export function assertUniqueActorInstances(actors: readonly SceneActorState[], context: string): void {
  const duplicates = duplicateVisibleActors(actors);
  if (!duplicates.size) return;
  const detail = [...duplicates].map(([key, same]) => `${key} → ${same.map(actor => actor.id).join(', ')}`).join('；');
  throw new Error(`${context}演员实例重复：${detail}`);
}

/**
 * 场景演员核查所需的最小结构边界。
 * 由 `scene-snapshot.ts` 等调用方通过结构兼容传入，保持本模块零依赖。
 */
export interface CensusActor {
  readonly id: string;
  readonly visible: boolean;
  readonly worldEntityId?: string;
  readonly memberId?: string;
  readonly enemyKey?: string;
  readonly removed?: boolean;
  readonly stageHidden?: boolean;
}

/**
 * 场景演员的唯一实例键。
 *
 * `characterId` 是人物编号，不是实例编号：同一张图上可以有多盏火把、几块同样的
 * 路障或多名同外观士兵。真正判断“这是不是同一个人”要用这份来源键。
 */
export function actorInstanceKey(actor: Pick<CensusActor, 'id' | 'worldEntityId' | 'memberId' | 'enemyKey'>): string {
  if (actor.worldEntityId) return `world:${actor.worldEntityId}`;
  if (actor.memberId) return `member:${actor.memberId}`;
  if (actor.enemyKey) return `enemy:${actor.enemyKey}`;
  return `story:${actor.id}`;
}

/** 同一实例键出现两个可见演员，就是舞台上多画了一份；隐藏的那份不算画面重复。 */
export function duplicateVisibleActors<T extends CensusActor = CensusActor>(actors: readonly T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
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
export function assertUniqueActorInstances(actors: readonly CensusActor[], context: string): void {
  const duplicates = duplicateVisibleActors(actors);
  if (!duplicates.size) return;
  const detail = [...duplicates].map(([key, same]) => `${key} → ${same.map(actor => actor.id).join(', ')}`).join('；');
  throw new Error(`${context}演员实例重复：${detail}`);
}

import type { Campaign } from './campaign.ts';
import type { EntityPlacement, WorldMap } from './content.ts';

/** 剧情摆放是否覆盖地图静态摆放：有人物编号时按编号，否则按人物资源。 */
export function replacesMapEntity(authored: EntityPlacement, entity: EntityPlacement): boolean {
  return authored.characterId && entity.characterId
    ? authored.characterId === entity.characterId
    : authored.actor === entity.actor;
}

/** 本图所有剧情摆放；按地图筛选，不改动原内容。 */
export function authoredPlacements(map: WorldMap, campaign: Campaign): EntityPlacement[] {
  return campaign.placements.filter(entity => entity.map === map.id);
}

/** 条件可能在本图访问期间从成立变不成立；这类摆放要保留静态后备副本。 */
export function placementMayBeInactive(entity: EntityPlacement): boolean {
  const condition = (entity as EntityPlacement & {condition?: {type?: string}}).condition;
  return !!condition && condition.type !== 'always';
}

/**
 * 本图静态摆放中，没有被一条**当前有效**剧情摆放顶掉的部分。
 *
 * 条件不成立的剧情摆放不能提前顶掉静态人物，否则玩家会在地图上看到“人凭空消失”。
 * 剧情摆放本身仍由后续世界投影统一过滤。
 */
export function baseMapEntities(
  map: WorldMap,
  campaign: Campaign,
  active: (entity: EntityPlacement) => boolean = () => true
): EntityPlacement[] {
  const activeAuthored = authoredPlacements(map, campaign).filter(active);
  return map.entities.filter(entity => !activeAuthored.some(authored => replacesMapEntity(authored, entity)));
}

/**
 * 静态地图加剧情摆放的完整候选名单，供内容审计判断“这个人物编号是否唯一”。
 * 结果不做条件过滤，因此能暴露条件变化前后会指向不同副本的歧义。
 */
export function mapPlacementCandidates(map: WorldMap, campaign: Campaign): EntityPlacement[] {
  return [...baseMapEntities(map, campaign), ...authoredPlacements(map, campaign)];
}

/**
 * 从一份保留全部静态实体的基础名单里，去掉被当前有效剧情摆放顶掉的静态副本。
 *
 * 正式地图不能在进图时就把静态人物删掉：剧情条件可能在本次访问中从假变真，也可能
 * 从真变假。保留全部候选，每次投影按当前条件重新选，才不会在切换时突然缺人或两人。
 */
export function withoutReplacedStatic(
  base: readonly EntityPlacement[],
  map: WorldMap,
  campaign: Campaign,
  active: (entity: EntityPlacement) => boolean
): EntityPlacement[] {
  const staticIds = new Set((map.entities ?? []).map(entity => entity.id));
  const activeAuthored = authoredPlacements(map, campaign).filter(active);
  return base.filter(entity => !staticIds.has(entity.id)
    || !activeAuthored.some(authored => replacesMapEntity(authored, entity)));
}

/** 正式地图、剧情预备图、无头回放和测试共用的地图演员合并入口。 */
export function resolveMapActors(input: {
  base: readonly EntityPlacement[];
  map: WorldMap;
  campaign: Campaign;
  active: (entity: EntityPlacement) => boolean;
}): EntityPlacement[] {
  return withoutReplacedStatic(input.base, input.map, input.campaign, input.active);
}

import assert from 'node:assert/strict';
import { nearInteractive } from '../../src/domain/chests.ts';
import type { ActorDefinition, EntityPlacement, WorldMap } from '../../src/domain/content.ts';
import { authoredPlacements, baseMapEntities } from '../../src/domain/map-placement.ts';
import { overlapsFootRect, type GameRectangle, type Point } from '../../src/domain/navigation.ts';
import { mirroredCollision, NavigationWorld } from '../../src/domain/navigation-world.ts';
import type { Session } from '../../src/domain/session.ts';
import type { StoryEvent } from '../../src/domain/story-graph.ts';
import { storyExitId } from '../../src/domain/story-world.ts';
import type { ContentSourceIndexes, QuestHarnessContent } from './quest-e2e-indexes.ts';

export type ObstacleTarget =
  | { kind: 'region'; region: GameRectangle }
  | { kind: 'entity'; entity: EntityPlacement };

export function createQuestNavigation(
  content: QuestHarnessContent,
  sources: ContentSourceIndexes,
  session: Session,
  kiyanActor: ActorDefinition,
) {
  const currentMapObj = (): WorldMap => {
    const mapId = session.storyWorld.currentLocation?.map ?? content.campaign.start.map;
    const found = content.maps.get(mapId);
    assert.ok(found, `地图不存在：${mapId}`);
    return found;
  };

  /** 当前地图真实可见实体列表（与 WorldScene / prepareSceneVisit 显隐投影口径完全一致）。 */
  const visibleEntities = (mapId?: string): EntityPlacement[] => {
    const map = mapId ? content.maps.get(mapId)! : currentMapObj();
    const authored = authoredPlacements(map, content.campaign);
    const base = baseMapEntities(map, content.campaign, entity => session.visible(entity));
    return session.storyWorld
      .projectEntities(map.id, [...base, ...authored], content.campaign.placements)
      .filter(
        entity =>
          session.visible(entity) &&
          session.storyWorld.actorVisible(map.id, entity.actor, entity.characterId),
      );
  };

  let reachCacheKey = '';
  let reachCacheValue: ReadonlySet<string> = new Set();

  /**
   * 计算从当前所在地图沿“当前未被 exitRules 与 exitEnabled 禁用的真实静态出口”可达的全部地图集合（图级 BFS）。
   * 严禁跨过上锁出口或直接穿墙到孤岛地图。
   */
  const reachableMapsFrom = (originMapId?: string): ReadonlySet<string> => {
    const startMap = originMapId ?? session.storyWorld.currentLocation?.map ?? content.campaign.start.map;
    const key = `${startMap}\0${session.storyWorld.revision}\0${session.questBook.version}\0${session.runtimeState.sequence}`;
    if (key === reachCacheKey) return reachCacheValue;

    const reached = new Set<string>([startMap]);
    const queue = [startMap];
    for (let i = 0; i < queue.length; i++) {
      const mid = queue[i]!;
      const mapObj = content.maps.get(mid);
      if (!mapObj) continue;
      for (const ex of mapObj.exits) {
        const eid = storyExitId(mid, ex);
        const ruleCond = sources.exitRuleByKey.get(`${mid}\0${eid}`);
        const ruleOk = !ruleCond || session.evaluateCondition(ruleCond);
        if (!ruleOk || !session.storyWorld.exitEnabled(mid, ex)) continue;
        if (!reached.has(ex.destination) && content.maps.has(ex.destination)) {
          reached.add(ex.destination);
          queue.push(ex.destination);
        }
      }
    }
    reachCacheKey = key;
    reachCacheValue = reached;
    return reached;
  };

  /** 构建叠加当前真实在场实体动态碰撞盒的地图导航世界，并从入口做静态格子 BFS 返回所有主角可站立格中心点。 */
  const reachableCellsWithDynamicObstacles = (
    mapId: string,
    options?: { extraStarts?: readonly Point[]; ignoreEntityIds?: ReadonlySet<string> },
  ): { cells: Point[]; entities: EntityPlacement[] } => {
    const map = content.maps.get(mapId);
    assert.ok(map, `导航校验目标地图不存在：${mapId}`);
    const entities = visibleEntities(mapId);
    const ignoreEntityIds = options?.ignoreEntityIds;
    const obstacleParts: string[] = [];
    const obstacleEntities: { entity: EntityPlacement; col: NonNullable<ReturnType<typeof mirroredCollision>> }[] = [];
    for (const entity of entities) {
      if (ignoreEntityIds?.has(entity.id)) continue;
      const col = mirroredCollision(content.world.actors[entity.actor]?.collision, entity.flip);
      if (!col) continue;
      obstacleEntities.push({ entity, col });
      obstacleParts.push(`${entity.actor}@${entity.x},${entity.y},${entity.flip ? 1 : 0}`);
    }
    obstacleParts.sort();
    const obstacleSig = obstacleParts.join('|');

    const computeBfs = (starts: readonly Point[]): Point[] => {
      const startsSig = starts.map(s => `${Math.round(s.x)},${Math.round(s.y)}`).join(';');
      const cacheKey = `${mapId}\0${obstacleSig}\0${startsSig}`;
      const cached = sources.bfsCache.get(cacheKey);
      if (cached) return cached;

      const nav = new NavigationWorld(map);
      for (const { entity, col } of obstacleEntities) {
        nav.register({
          shape: () => ({ collision: col }),
          position: () => entity,
          enabled: () => true,
          faction: () => 'neutral',
        });
      }

      const visited = new Set<number>();
      const queue: number[] = [];
      const cells: Point[] = [];
      for (const sp of starts) {
        const p = nav.nearestBody(kiyanActor, sp) ?? nav.nearest(kiyanActor, sp);
        if (!p) continue;
        const cx = Math.floor(p.x / map.tileSize);
        const cy = Math.floor(p.y / map.tileSize);
        if (cx < 0 || cy < 0 || cx >= map.columns || cy >= map.rows) continue;
        const idx = cy * map.columns + cx;
        if (visited.has(idx)) continue;
        visited.add(idx);
        queue.push(idx);
        cells.push({ x: cx * map.tileSize + map.tileSize / 2, y: cy * map.tileSize + map.tileSize / 2 });
      }
      for (let i = 0; i < queue.length; i++) {
        const cell = queue[i]!;
        const cx = cell % map.columns;
        const cy = Math.floor(cell / map.columns);
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= map.columns || ny >= map.rows) continue;
          const nidx = ny * map.columns + nx;
          if (visited.has(nidx)) continue;
          const pt = { x: nx * map.tileSize + map.tileSize / 2, y: ny * map.tileSize + map.tileSize / 2 };
          if (!nav.canPlace(kiyanActor, pt)) continue;
          visited.add(nidx);
          queue.push(nidx);
          cells.push(pt);
        }
      }
      if (sources.bfsCache.size >= 4096) sources.bfsCache.clear();
      sources.bfsCache.set(cacheKey, cells);
      return cells;
    };

    const reachable = reachableMapsFrom();
    const enabledEntrances: Point[] = [];
    if (mapId === content.campaign.start.map && reachable.has(mapId)) {
      enabledEntrances.push({ x: content.campaign.start.x, y: content.campaign.start.y });
    }
    for (const incoming of sources.mapIncomingExits.get(mapId) ?? []) {
      if (!reachable.has(incoming.fromMap)) continue;
      const eid = storyExitId(incoming.fromMap, incoming.exit);
      const ruleCond = sources.exitRuleByKey.get(`${incoming.fromMap}\0${eid}`);
      const ruleOk = !ruleCond || session.evaluateCondition(ruleCond);
      if (!ruleOk || !session.storyWorld.exitEnabled(incoming.fromMap, incoming.exit)) continue;
      enabledEntrances.push(incoming.point);
    }
    if (reachable.has(mapId)) {
      const completedEvents = new Set(session.runtimeState.completedEvents);
      for (const landing of sources.storyEntryLandingsByMap.get(mapId) ?? []) {
        if (completedEvents.has(landing.eventId)) {
          enabledEntrances.push(landing.point);
        }
      }
    }
    const staticEntrances = enabledEntrances.length > 0
      ? enabledEntrances
      : (sources.mapEntrances.get(mapId) ?? []);
    const baseStarts: Point[] = [...staticEntrances, ...(options?.extraStarts ?? [])];
    const loc = session.storyWorld.currentLocation;
    // 仅当目标地图不存在任何静态入口（如纯脚本落点室内图）时回退当前位置，严禁用 GM 跳转落点绕过路障 BFS
    if (baseStarts.length === 0 && loc?.map === mapId) {
      return { cells: computeBfs([{ x: loc.x, y: loc.y }]), entities };
    }
    return { cells: computeBfs(baseStarts), entities };
  };

  /** 静态格子硬校验：region 触发框内至少有一格主角可站立、重叠脚底框且从当前入口不被当前在场动态路障堵死。 */
  const assertRegionReachable = (mapId: string, region: GameRectangle, label: string): Point => {
    const { cells, entities } = reachableCellsWithDynamicObstacles(mapId);
    const hit = cells.find(pt => overlapsFootRect(pt, region));
    if (!hit) {
      const blockers = entities
        .filter(e => Math.hypot(e.x - (region.x + region.width / 2), e.y - (region.y + region.height / 2)) < 96)
        .map(e => `${e.actor}(${e.characterId ?? e.id})@${e.x},${e.y}`);
      assert.fail(
        `区域触发框不可达或被动态路障堵死 [${label}] map=${mapId} region=${JSON.stringify(region)} 附近在场实体=[${blockers.join(', ')}]`,
      );
    }
    return hit;
  };

  /** 静态格子硬校验：目标在场实体周围至少存在一格主角可站立且处于交互/近身距离内、不被动态路障隔绝。 */
  const assertEntityApproachable = (mapId: string, entity: EntityPlacement, label: string): Point => {
    const actor = content.world.actors[entity.actor];
    assert.ok(actor, `角色定义缺失：${entity.actor}`);
    const isShop = content.shopActors?.has(entity.actor) ?? false;
    const bodyReach = isShop ? 64 : undefined;
    const { cells, entities } = reachableCellsWithDynamicObstacles(mapId);
    const hit = cells.find(pt => nearInteractive(pt, entity, actor.collision, !!entity.flip, bodyReach));
    if (!hit) {
      const blockers = entities
        .filter(e => e.id !== entity.id && Math.hypot(e.x - entity.x, e.y - entity.y) < 64)
        .map(e => `${e.actor}(${e.characterId ?? e.id})@${e.x},${e.y}`);
      assert.fail(
        `在场目标不可接近或被路障隔绝 [${label}] map=${mapId} target=${entity.actor}(${entity.characterId ?? entity.id})@${entity.x},${entity.y} 附近实体=[${blockers.join(', ')}]`,
      );
    }
    return hit;
  };

  /**
   * 纯几何阻塞判定（零英文角色名正则）：
   * 仅筛选“移除其碰撞体后直接打通目标，或为打通目标所必需”的正式清障事件，不误碰无关在场村民。
   */
  const findBlockingUnlockEvents = (
    mapId: string,
    target: ObstacleTarget,
    isCandidateEvent: (ev: StoryEvent) => boolean,
  ): StoryEvent[] => {
    const map = content.maps.get(mapId);
    if (!map) return [];
    const entities = visibleEntities(mapId);
    const entitiesByEvent = new Map<
      StoryEvent,
      { ids: Set<string>; items: { entity: EntityPlacement; col: NonNullable<ReturnType<typeof mirroredCollision>> }[] }
    >();
    const allRemovableIds = new Set<string>();

    for (const entity of entities) {
      if (target.kind === 'entity' && entity.id === target.entity.id) continue;
      const col = mirroredCollision(content.world.actors[entity.actor]?.collision, entity.flip);
      if (!col) continue;
      const evs = (sources.eventsHidingActorOnMap.get(`${mapId}\0${entity.characterId ?? entity.actor}`) ?? [])
        .filter((ev, idx, arr) => arr.indexOf(ev) === idx && isCandidateEvent(ev));
      if (!evs.length) continue;
      allRemovableIds.add(entity.id);
      for (const ev of evs) {
        let bucket = entitiesByEvent.get(ev);
        if (!bucket) {
          bucket = { ids: new Set(), items: [] };
          entitiesByEvent.set(ev, bucket);
        }
        if (!bucket.ids.has(entity.id)) {
          bucket.ids.add(entity.id);
          bucket.items.push({ entity, col });
        }
      }
    }
    if (allRemovableIds.size === 0) return [];

    const targetReached = (cells: readonly Point[]): boolean => {
      if (target.kind === 'region') {
        return cells.some(pt => overlapsFootRect(pt, target.region));
      }
      const actor = content.world.actors[target.entity.actor];
      if (!actor) return false;
      const bodyReach = content.shopActors?.has(target.entity.actor) ? 64 : undefined;
      return cells.some(pt => nearInteractive(pt, target.entity, actor.collision, !!target.entity.flip, bodyReach));
    };

    const allCleared = reachableCellsWithDynamicObstacles(mapId, { ignoreEntityIds: allRemovableIds }).cells;
    if (!targetReached(allCleared)) return [];

    const baseCells = reachableCellsWithDynamicObstacles(mapId).cells;
    const cellKey = (pt: Point) => Math.floor(pt.y / map.tileSize) * map.columns + Math.floor(pt.x / map.tileSize);
    const baseKeySet = new Set(baseCells.map(cellKey));
    const kiyanCol = kiyanActor.collision;
    const playerPad = Math.max(kiyanCol?.width ?? 16, kiyanCol?.height ?? 16) + map.tileSize;

    const directUnblockers: StoryEvent[] = [];
    const frontierNecessary: StoryEvent[] = [];
    const innerNecessary: StoryEvent[] = [];

    for (const [ev, bucket] of entitiesByEvent) {
      const afterOnlyThis = reachableCellsWithDynamicObstacles(mapId, { ignoreEntityIds: bucket.ids }).cells;
      if (targetReached(afterOnlyThis)) {
        directUnblockers.push(ev);
        continue;
      }
      // 必要性测试：保留该事件对应障碍、移除其余全部可移除障碍后若目标仍不可达，说明它属于串联/复合门障中的必需环节
      const withoutThis = new Set<string>();
      for (const id of allRemovableIds) {
        if (!bucket.ids.has(id)) withoutThis.add(id);
      }
      const needed = !targetReached(reachableCellsWithDynamicObstacles(mapId, { ignoreEntityIds: withoutThis }).cells);
      if (!needed) continue;

      const opensNewArea = afterOnlyThis.some(pt => {
        if (baseKeySet.has(cellKey(pt))) return false;
        return bucket.items.every(({ entity, col }) => {
          const left = entity.x + col.x - playerPad;
          const right = entity.x + col.x + col.width + playerPad;
          const top = entity.y + col.y - playerPad;
          const bottom = entity.y + col.y + col.height + playerPad;
          return pt.x < left || pt.x > right || pt.y < top || pt.y > bottom;
        });
      });
      if (opensNewArea) frontierNecessary.push(ev);
      else innerNecessary.push(ev);
    }

    return [...directUnblockers, ...frontierNecessary, ...innerNecessary];
  };

  /** 两张地图在静态出口拓扑上是否同属一个可步行连通片（忽略出口锁状态）。 */
  const canStaticallyWalkBetween = (fromMapId: string, toMapId: string): boolean => {
    if (fromMapId === toMapId) return true;
    return sources.staticReachableByMap.get(fromMapId)?.has(toMapId) ?? false;
  };

  /** 目标地图所在连通片是否至少存在一条正式剧情 stage / travel 切图入口（排除无桥接的孤立死岛）。 */
  const hasFormalStoryBridgeToIsland = (targetMapId: string): boolean => {
    if (sources.storyBridgeMaps.has(targetMapId)) return true;
    for (const bridgeMap of sources.storyBridgeMaps) {
      if (sources.staticReachableByMap.get(bridgeMap)?.has(targetMapId)) return true;
    }
    return false;
  };

  return {
    currentMapObj,
    visibleEntities,
    reachableMapsFrom,
    canStaticallyWalkBetween,
    hasFormalStoryBridgeToIsland,
    reachableCellsWithDynamicObstacles,
    assertRegionReachable,
    assertEntityApproachable,
    findBlockingUnlockEvents,
  };
}

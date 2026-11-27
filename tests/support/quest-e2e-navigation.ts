import assert from 'node:assert/strict';
import type { ActorDefinition, EntityPlacement, WorldMap } from '../../src/domain/content.ts';
import { withinInteractionRange } from '../../src/domain/interaction.ts';
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

  const isExitOpen = (mapId: string, ex: WorldMap['exits'][number]): boolean => {
    const eid = storyExitId(mapId, ex);
    const ruleCond = sources.exitRuleByKey.get(`${mapId}\0${eid}`);
    const ruleOk = !ruleCond || session.evaluateCondition(ruleCond);
    return ruleOk && session.storyWorld.exitEnabled(mapId, ex);
  };

  /**
   * 单图动态障碍格子 BFS（含同图传送阵迭代展开：仅当已可达格踩进已开启的同图传送入口框，才把传送终点并入搜索）。
   */
  const computeMapCellsFromStarts = (
    mapId: string,
    starts: readonly Point[],
    ignoreEntityIds?: ReadonlySet<string>,
  ): { cells: Point[]; entities: EntityPlacement[] } => {
    const map = content.maps.get(mapId);
    assert.ok(map, `导航校验目标地图不存在：${mapId}`);
    const entities = visibleEntities(mapId);
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

    const selfExits = map.exits.filter(ex => ex.destination === mapId && isExitOpen(mapId, ex));
    const selfSig = selfExits.map(ex => `${ex.x},${ex.y},${ex.width},${ex.height}->${ex.spawn.x},${ex.spawn.y}`).join(';');
    const startsSig = starts.map(s => `${Math.round(s.x)},${Math.round(s.y)}`).join(';');
    const cacheKey = `${mapId}\0${obstacleSig}\0${selfSig}\0${startsSig}`;
    const cached = sources.bfsCache.get(cacheKey);
    if (cached) return { cells: cached, entities };

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
    const seedPoint = (sp: Point) => {
      const p = nav.nearestBody(kiyanActor, sp) ?? nav.nearest(kiyanActor, sp);
      if (!p) return;
      const cx = Math.floor(p.x / map.tileSize);
      const cy = Math.floor(p.y / map.tileSize);
      if (cx < 0 || cy < 0 || cx >= map.columns || cy >= map.rows) return;
      const idx = cy * map.columns + cx;
      if (visited.has(idx)) return;
      visited.add(idx);
      queue.push(idx);
      cells.push({ x: cx * map.tileSize + map.tileSize / 2, y: cy * map.tileSize + map.tileSize / 2 });
    };

    for (const sp of starts) seedPoint(sp);
    const triggeredSelfExits = new Set<number>();
    let head = 0;
    while (head < queue.length) {
      while (head < queue.length) {
        const cell = queue[head++]!;
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
      for (let i = 0; i < selfExits.length; i++) {
        if (triggeredSelfExits.has(i)) continue;
        const ex = selfExits[i]!;
        if (cells.some(pt => overlapsFootRect(pt, ex))) {
          triggeredSelfExits.add(i);
          seedPoint(ex.spawn);
        }
      }
    }

    if (sources.bfsCache.size >= 65536) sources.bfsCache.clear();
    sources.bfsCache.set(cacheKey, cells);
    return { cells, entities };
  };

  let reachCacheKey = '';
  let reachCacheMaps: ReadonlySet<string> = new Set();
  let reachCacheEntrances: ReadonlyMap<string, Point[]> = new Map();

  const pushUniquePoint = (list: Point[], pt: Point): boolean => {
    if (list.some(existing => existing.x === pt.x && existing.y === pt.y)) return false;
    list.push({ x: pt.x, y: pt.y });
    return true;
  };

  const initialSeedsForOriginMap = (startMap: string, completedEvents: ReadonlySet<string>): Point[] => {
    const seeds: Point[] = [];
    if (startMap === content.campaign.start.map) {
      pushUniquePoint(seeds, { x: content.campaign.start.x, y: content.campaign.start.y });
    }
    for (const landing of sources.storyEntryLandingsByMap.get(startMap) ?? []) {
      if (completedEvents.has(landing.eventId)) {
        pushUniquePoint(seeds, landing.point);
      }
    }
    for (const inc of sources.upstreamIncomingExits.get(startMap) ?? []) {
      if (isExitOpen(inc.fromMap, inc.exit)) {
        pushUniquePoint(seeds, inc.point);
      }
    }
    if (seeds.length === 0) {
      for (const pt of sources.mapEntrances.get(startMap) ?? []) {
        pushUniquePoint(seeds, pt);
      }
    }
    const loc = session.storyWorld.currentLocation;
    if (seeds.length === 0 && loc?.map === startMap) {
      pushUniquePoint(seeds, { x: loc.x, y: loc.y });
    }
    return seeds;
  };

  /**
   * 跨图物理连通图计算：
   * 从当前所在地图的合法入口出发，仅当某条跨图出口既未被 exitRules/exitEnabled 锁死，
   * 又能在源地图绕过在场动态碰撞体真正踩进出口框（overlapsFootRect）时，才把对应 spawn 落点推入下一张地图。
   */
  const computeReachableGraph = (originMapId?: string) => {
    const startMap = originMapId ?? session.storyWorld.currentLocation?.map ?? content.campaign.start.map;
    const loc = session.storyWorld.currentLocation;
    const locFallbackKey =
      (sources.mapEntrances.get(startMap)?.length ?? 0) === 0 && loc?.map === startMap ? `${loc.x},${loc.y}` : '';
    const key = `${startMap}\0${locFallbackKey}\0${session.storyWorld.revision}\0${session.questBook.version}\0${session.runtimeState.sequence}`;
    if (key === reachCacheKey) {
      return { maps: reachCacheMaps, entrancesByMap: reachCacheEntrances };
    }

    const completedEvents = new Set(session.runtimeState.completedEvents);
    const entrancesByMap = new Map<string, Point[]>();
    entrancesByMap.set(startMap, initialSeedsForOriginMap(startMap, completedEvents));
    const queue = [startMap];
    const inQueue = new Set<string>([startMap]);

    for (let i = 0; i < queue.length; i++) {
      const mid = queue[i]!;
      inQueue.delete(mid);
      const mapObj = content.maps.get(mid);
      if (!mapObj) continue;
      const mapStarts = entrancesByMap.get(mid)!;
      if (mid === content.campaign.start.map) {
        pushUniquePoint(mapStarts, { x: content.campaign.start.x, y: content.campaign.start.y });
      }
      for (const landing of sources.storyEntryLandingsByMap.get(mid) ?? []) {
        if (completedEvents.has(landing.eventId)) {
          pushUniquePoint(mapStarts, landing.point);
        }
      }
      const { cells } = computeMapCellsFromStarts(mid, mapStarts);
      for (const ex of mapObj.exits) {
        if (ex.destination === mid || !content.maps.has(ex.destination)) continue;
        if (!isExitOpen(mid, ex)) continue;
        if (!cells.some(pt => overlapsFootRect(pt, ex))) continue;
        let destStarts = entrancesByMap.get(ex.destination);
        if (!destStarts) {
          destStarts = [];
          entrancesByMap.set(ex.destination, destStarts);
        }
        if (pushUniquePoint(destStarts, ex.spawn) && !inQueue.has(ex.destination)) {
          inQueue.add(ex.destination);
          queue.push(ex.destination);
        }
      }
    }

    const reached = new Set<string>(entrancesByMap.keys());
    reachCacheKey = key;
    reachCacheMaps = reached;
    reachCacheEntrances = entrancesByMap;
    return { maps: reached, entrancesByMap };
  };

  const reachableMapsFrom = (originMapId?: string): ReadonlySet<string> => computeReachableGraph(originMapId).maps;

  const reachableEntrancesFor = (targetMapId: string, originMapId?: string): readonly Point[] =>
    computeReachableGraph(originMapId).entrancesByMap.get(targetMapId) ?? [];

  /** 构建叠加当前真实在场实体动态碰撞盒的地图导航世界，并从当前真实已打通入口做静态格子 BFS 返回所有主角可站立格中心点。 */
  const reachableCellsWithDynamicObstacles = (
    mapId: string,
    options?: { extraStarts?: readonly Point[]; ignoreEntityIds?: ReadonlySet<string> },
  ): { cells: Point[]; entities: EntityPlacement[] } => {
    const graphEntrances = reachableEntrancesFor(mapId);
    const completedEvents = new Set(session.runtimeState.completedEvents);
    const baseStarts: Point[] =
      graphEntrances.length > 0 ? [...graphEntrances] : initialSeedsForOriginMap(mapId, completedEvents);
    for (const extra of options?.extraStarts ?? []) {
      pushUniquePoint(baseStarts, extra);
    }
    return computeMapCellsFromStarts(mapId, baseStarts, options?.ignoreEntityIds);
  };

  /** 校验在场敌人生成点在当前地图未被死墙或动态路障与主角彻底隔绝（对齐正式场景校正刷怪可站位口径）。 */
  const isEnemySpawnReachable = (mapId: string, enemyActorId: string | undefined, spawnPos: Point): boolean => {
    const map = content.maps.get(mapId);
    if (!map) return false;
    const nav = new NavigationWorld(map);
    const actorDef = (enemyActorId ? content.world.actors[enemyActorId] : undefined) ?? kiyanActor;
    const snapped = nav.nearestBody(actorDef, spawnPos) ?? nav.nearest(actorDef, spawnPos) ?? spawnPos;
    const { cells } = reachableCellsWithDynamicObstacles(mapId);
    return cells.some(pt => Math.hypot(pt.x - snapped.x, pt.y - snapped.y) <= 48);
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

  /** 静态格子硬校验：目标在场实体周围至少存在一格主角可站立且处于正式交互距离内（商店/旅店 32px，宝箱/古剑 24px，其余贴身 8px）、不被动态路障隔绝。 */
  const assertEntityApproachable = (mapId: string, entity: EntityPlacement, label: string): Point => {
    const actor = content.world.actors[entity.actor];
    assert.ok(actor, `角色定义缺失：${entity.actor}`);
    const isShop = content.shopActors?.has(entity.actor) ?? false;
    const { cells, entities } = reachableCellsWithDynamicObstacles(mapId);
    const hit = cells.find(pt => withinInteractionRange(pt, entity, actor, !!entity.flip, isShop));
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
      const isShop = content.shopActors?.has(target.entity.actor) ?? false;
      return cells.some(pt => withinInteractionRange(pt, target.entity, actor, !!target.entity.flip, isShop));
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
    reachableEntrancesFor,
    isEnemySpawnReachable,
    canStaticallyWalkBetween,
    hasFormalStoryBridgeToIsland,
    reachableCellsWithDynamicObstacles,
    assertRegionReachable,
    assertEntityApproachable,
    findBlockingUnlockEvents,
  };
}

import type { Point } from './navigation.ts';
import type { NavigationActor, NavigationShape, NavigationWorld } from './navigation-world.ts';

/**
 * 给上阵队员在主角身边找一个能放下整个身体、且从主角身边走得到的落点。
 *
 * - `nearestBody` 只按整盒判定，不查脚点；`movement.place` 的严格校验还要求脚点可站，
 *   所以候选点要用 `terrainFree` 复核一遍，保证返回的点能直接交给 `place`。
 * - 有整盒候选时先由 `nearestReachableBody` 检查与主角的地形连通性；被墙隔开时它会
 *   按可行走路径找最近的整盒点。
 * - 地图连整盒空间都没有时退回脚点口径（与旧行为一致）；完全没有可行走区域时返回
 *   `undefined`，由调用方决定报错还是保持原位。
 */
export function choosePartyLanding(navigation: NavigationWorld, shape: NavigationShape, origin: Point,
  ignore?: NavigationActor, avoid: readonly Point[] = []): Point | undefined {
  // 队友之间可以挤过彼此，但落位不能直接叠在主角或已站好的队友身上。
  const size = Math.max(shape.collision?.width ?? 0, shape.collision?.height ?? 0, 16);
  const clear = (point: Point) => avoid.every(other => Math.hypot(point.x - other.x, point.y - other.y) >= size);
  const settle = (point: Point) => clear(point) && navigation.terrainFree(point)
    && navigation.canPlaceBody(shape, point, ignore);
  const preferred = navigation.nearestBody(shape, origin, ignore, [], clear);
  if (preferred) {
    const reachable = navigation.nearestReachableBody(shape, origin, preferred, ignore, [], clear);
    if (reachable && settle(reachable)) return reachable;
    if (settle(preferred)) return preferred;
  }
  try { return navigation.nearest(shape, origin, ignore, [], clear); } catch { return undefined; }
}

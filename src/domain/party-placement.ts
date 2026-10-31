import type { Facing } from './content.ts';
import type { Point } from './navigation.ts';
import type { NavigationActor, NavigationShape, NavigationWorld } from './navigation-world.ts';

const FORMATION_FORWARD: Record<Facing, Point> = {
  north: { x: 0, y: -1 }, south: { x: 0, y: 1 }, east: { x: 1, y: 0 }, west: { x: -1, y: 0 },
};

const FORMATION_RADIUS = Math.hypot(16, 20);
const FORMATION_SPREAD = Math.atan2(16, 20);

/** 队长朝向对应的背后方向角（屏幕坐标）。 */
export function facingBackAngle(facing: Facing): number {
  const forward = FORMATION_FORWARD[facing];
  return Math.atan2(-forward.y, -forward.x);
}

/**
 * 按当前背后方向角和上阵槽位算偏移：站在队长背后约 25.6px，
 * 再沿圆弧向两侧各偏 38.7°。槽位 0 在屏幕左侧、槽位 1 在屏幕右侧（面朝南时）。
 * 两名佣兵共享同一个背后角度，平滑过程中也不会在同一侧重合。
 */
export function formationSlotOffset(backAngle: number, slot: 0 | 1): Point {
  const angle = backAngle + (slot === 0 ? -FORMATION_SPREAD : FORMATION_SPREAD);
  return { x: Math.cos(angle) * FORMATION_RADIUS, y: Math.sin(angle) * FORMATION_RADIUS };
}

/** 沿最短方向平滑旋转背后角度，避免 180° 换边时走远路。 */
export function smoothFormationAngle(current: number, target: number, alpha: number): number {
  const turn = Math.atan2(Math.sin(target - current), Math.cos(target - current));
  return current + turn * alpha;
}

/** 两个队伍单位按同一碰撞盒落位时是否重叠；边贴边不算重叠。 */
export function partyBodyOverlaps(point: Point, other: Point, shape: NavigationShape): boolean {
  const box = shape.collision;
  if (!box) return Math.hypot(point.x - other.x, point.y - other.y) < 16;
  const left = point.x + box.x, top = point.y + box.y;
  const otherLeft = other.x + box.x, otherTop = other.y + box.y;
  return left < otherLeft + box.width && otherLeft < left + box.width
    && top < otherTop + box.height && otherTop < top + box.height;
}

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
  // 用碰撞盒重叠判断而不是中心点距离，斜向候选也不会留下部分重叠。
  const clear = (point: Point) => avoid.every(other => !partyBodyOverlaps(point, other, shape));
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

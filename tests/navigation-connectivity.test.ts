import assert from 'node:assert/strict';
import test from 'node:test';
import { NavigationWorld } from '../src/domain/navigation-world.ts';
import { canTraverse, findPath, PATH_GRID_SIZE } from '../src/domain/pathfinding.ts';
import type { Point } from '../src/domain/navigation.ts';

const map = () => {
  const blocked = Array<boolean>(400).fill(false);
  // 确定性的障碍布局：中间一列封死，另外散布一些墙格，覆盖斜向角规则。
  for (let row = 0; row < 20; row++) blocked[row * 20 + 10] = true;
  for (let index = 0; index < blocked.length; index++) if ((index * 37) % 13 < 3) blocked[index] = true;
  return { name: 'connectivity', columns: 20, rows: 20, tileSize: 16, blocked };
};

test('cached terrain components agree with an exact path search', () => {
  const navigation = new NavigationWorld(map());
  const components = navigation as unknown as { terrainRoute(from: Point, to: Point): boolean };
  const free = (point: Point) => navigation.terrainFree(point);
  const exact = (from: Point, to: Point): boolean => {
    if (!free(from) || !free(to)) return false;
    return findPath(from, {
      bounds: navigation.bounds,
      canStand: free,
      isGoal: point => Math.hypot(point.x - to.x, point.y - to.y) <= PATH_GRID_SIZE && canTraverse(point, to, free),
      heuristic: point => Math.max(0, Math.hypot(point.x - to.x, point.y - to.y) - PATH_GRID_SIZE)
    }) !== null;
  };
  const points: Point[] = [];
  for (let y = 8; y < 320; y += 16) for (let x = 8; x < 320; x += 16) if (free({ x, y })) points.push({ x, y });
  // 真实角色脚点不保证落在 8 px 网格上；把非网格点也纳入对照。
  for (let index = 0; index < 120; index++) {
    const point = { x: 5 + (index * 47) % 310, y: 5 + (index * 83) % 310 };
    if (free(point)) points.push(point);
  }
  assert.ok(points.length > 100);
  for (let index = 0; index < 240; index++) {
    const from = points[(index * 97) % points.length], to = points[(index * 193 + 11) % points.length];
    assert.equal(components.terrainRoute(from, to), exact(from, to), `${JSON.stringify(from)} → ${JSON.stringify(to)}`);
  }
  navigation.prepareTerrainRouting();
  assert.equal(components.terrainRoute(points[0]!, points[1]!), exact(points[0]!, points[1]!), '预先建表不改变结果');
});

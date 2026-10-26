import assert from 'node:assert/strict';
import test from 'node:test';
import { NavigationWorld } from '../src/domain/navigation-world.ts';
import { WalkRoute } from '../src/domain/walk-route.ts';

const actorAt = (position: { x: number; y: number }) => ({
  shape: () => ({ collision: { x: -8, y: -8, width: 16, height: 16 } }),
  position: () => position,
  enabled: () => true
});

test('a long walk searches across frames and arrives without blocking the constructor', () => {
  const navigation = new NavigationWorld({ name: 'long-walk', bounds: { x: 0, y: 0, width: 1200, height: 1200 } });
  const position = { x: 24, y: 24 }, actor = actorAt(position);
  const route = new WalkRoute(navigation, actor, { x: 1176, y: 1176 }, 500);
  let pending = 0, steps = 0;
  while (route.state === 'walking' && steps < 2000) {
    const point = route.next(16.7);
    steps++;
    if (!point) { pending++; continue; }
    position.x = point.x; position.y = point.y;
  }
  assert.equal(route.state, 'arrived');
  assert.ok(pending > 0, '长路径不应在构造函数里一次算完');
  assert.ok(steps < 400, `走位帧数异常：${steps}`);
});

test('a walker without a collision box still respects terrain', () => {
  const blocked = Array<boolean>(40 * 40).fill(false);
  for (let row = 0; row < 40; row++) blocked[row * 40 + 20] = true;
  const navigation = new NavigationWorld({ name: 'split-no-body', columns: 40, rows: 40, tileSize: 16, blocked });
  const position = { x: 80, y: 320 };
  const actor = { shape: () => ({}), position: () => position, enabled: () => true };
  const route = new WalkRoute(navigation, actor, { x: 560, y: 320 }, 500);
  for (let index = 0; index < 200 && route.state === 'walking'; index++) route.next(16.7);
  assert.equal(route.state, 'failed', '没有碰撞盒只表示不查人物占位，不能穿墙');
});

test('an unreachable walk fails after a bounded search instead of hanging', () => {
  const blocked = Array<boolean>(40 * 40).fill(false);
  for (let row = 0; row < 40; row++) blocked[row * 40 + 20] = true;
  const navigation = new NavigationWorld({ name: 'split', columns: 40, rows: 40, tileSize: 16, blocked });
  const position = { x: 80, y: 320 }, actor = actorAt(position);
  const route = new WalkRoute(navigation, actor, { x: 560, y: 320 }, 500);
  for (let index = 0; index < 200 && route.state === 'walking'; index++) route.next(16.7);
  assert.equal(route.state, 'failed');
});

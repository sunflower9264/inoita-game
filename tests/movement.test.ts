import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import type Phaser from 'phaser';
import { NavigationWorld, mirroredCollision, collisionAt, overlaps, type NavigationActor, type NavigationShape } from '../src/domain/navigation-world.ts';
import { isBodyWalking, movementBodyClass, type MovementBody } from '../src/rendering/arcade-movement.ts';
import { MovementInterpolation } from '../src/rendering/movement-interpolation.ts';
import { GAME_FRAME_TIMING, installFrameLimitClock } from '../src/application/game-timing.ts';
import { WalkRoute } from '../src/domain/walk-route.ts';
import type { CollisionMap, Point } from '../src/domain/navigation.ts';
import { storyScriptActions } from '../src/domain/story-script.ts';
import type { Campaign } from '../src/domain/campaign.ts';
import type { WorldIndex, WorldMap } from '../src/domain/content.ts';
import type { PerformanceAction } from '../src/domain/story-performance.ts';

const require = createRequire(import.meta.url);
const World = require('../node_modules/phaser/src/physics/arcade/World.js') as typeof Phaser.Physics.Arcade.World;
const BaseBody = require('../node_modules/phaser/src/physics/arcade/Body.js') as typeof Phaser.Physics.Arcade.Body;
const Body = movementBodyClass(BaseBody);
const TimeStep = require('../node_modules/phaser/src/core/TimeStep.js') as typeof Phaser.Core.TimeStep;
const square = { collision: { x: -8, y: -8, width: 16, height: 16 } };

function startLoop(callback: (time: number, delta: number) => void): Phaser.Core.TimeStep {
  const loop = new TimeStep({} as Phaser.Game, GAME_FRAME_TIMING);
  installFrameLimitClock(loop);
  loop.raf.start = () => {};
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { performance } });
  try { loop.start(callback); }
  finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  }
  loop.lastTime = 0;
  return loop;
}

function fixture(terrain: CollisionMap | { name: string; bounds: { x: number; y: number; width: number; height: number } }) {
  const scene = { sys: { scale: { width: 640, height: 480 } } } as unknown as Phaser.Scene;
  const world = new World(scene, { gravity: { x: 0, y: 0 }, debug: false });
  const navigation = new NavigationWorld(terrain);
  const interpolation = new MovementInterpolation();
  const entries: { body: MovementBody; actor: NavigationActor; object: Phaser.GameObjects.GameObject & Point; dispose(): void }[] = [];
  const objects: Phaser.GameObjects.GameObject[] = [];
  world.addCollider(objects, objects, undefined, (a, b) => {
    const first = 'body' in a ? a.body : a, second = 'body' in b ? b.body : b;
    return first !== second && entries.some(e => e.body === first && e.actor.enabled() && !!e.actor.shape().collision) && entries.some(e => e.body === second && e.actor.enabled() && !!e.actor.shape().collision);
  });
  world.on('worldstep', (delta: number) => {
    for (const e of entries) if (e.body.enable) e.body.settleStep();
    interpolation.completeStep(delta * 1000 * world.timeScale);
  });
  let time = 0;
  const add = (point: Point, shape: NavigationShape = square, movable = true) => {
    const object = { ...point, scaleX: 1, scaleY: 1, angle: 0, rotation: 0, displayOriginX: 0, displayOriginY: 0, active: true, visible: true,
      setPosition(this: Point, x: number, y: number) { this.x = x; this.y = y; return this; }
    } as unknown as Phaser.GameObjects.GameObject & Point;
    const body = new Body(world, object);
    const actor: NavigationActor = { position: () => body.footPosition(), shape: () => shape, enabled: () => body.enable && (object as unknown as { visible: boolean }).visible };
    body.initialize(navigation, actor, movable); body.setSize(8, 8, false).setOffset(-4, -4); body.updateFromGameObject(); body.shape(shape); body.setImmovable(!movable);
    object.body = body; world.add(body); objects.push(object);
    const unregister = navigation.register(actor);
    interpolation.register(object, actor.position, actor.enabled);
    const entry = { body, actor, object, dispose: () => { interpolation.remove(object); unregister(); world.remove(body); objects.splice(objects.indexOf(object), 1); entries.splice(entries.indexOf(entry), 1); } };
    entries.push(entry); return entry;
  };
  const step = (delta = 1000 / 60) => {
    time += delta;
    if (!world.isPaused && world.bodies.size) interpolation.beginFrame(delta);
    world.update(time, delta); world.postUpdate();
  };
  // 没有实体范围的角色不参与通行判定（火把、出口标记这类装饰），与 `NavigationWorld.canPlace`
  // 同一口径：它们的位置本来就常贴在墙上或地图边界。
  const check = () => {
    const active = entries.filter(e => e.actor.enabled() && !!e.actor.shape().collision);
    for (const e of active) assert.ok(navigation.terrainFree(e.actor.position()), `blocked terrain ${JSON.stringify(e.actor.position())}`);
    for (let i = 0; i < active.length; i++) for (const b of active.slice(i + 1)) {
      const aBox = collisionAt(active[i].actor.shape(), active[i].actor.position()), bBox = collisionAt(b.actor.shape(), b.actor.position());
      if (aBox && bBox) assert.ok(!overlaps(aBox, bBox), `overlap ${JSON.stringify(active[i].actor.position())} / ${JSON.stringify(b.actor.position())}`);
    }
  };
  return { world, navigation, interpolation, add, step, check };
}
const empty = { name: 'arena', bounds: { x: 0, y: 0, width: 192, height: 192 } };

test('a fixed content body skips terrain constraints until it gets a movement intention', () => {
  const f = fixture(empty);
  const fixed = f.add({ x: 40, y: 40 }, square, false);
  const constrain = f.navigation.constrainTerrain.bind(f.navigation);
  let calls = 0;
  f.navigation.constrainTerrain = (...args: Parameters<typeof constrain>) => { calls++; return constrain(...args); };
  fixed.body.update(.016);
  assert.equal(calls, 0, '没有移动意图的机关不需要每步约束地形');
  fixed.body.drive({ x: 1, y: 0 }, 10);
  fixed.body.update(.016);
  assert.equal(calls, 1, '一旦有移动意图，仍然照常约束');
});

test('real game timing preserves speed and smooth display motion at 30–144 Hz', () => {
  const speed = 8 * 1000 / 60;
  for (const hz of [30, 59.94, 60, 90, 120, 144]) {
    const f = fixture({ name: 'open', bounds: { x: 0, y: 0, width: 10000, height: 10000 } });
    const player = f.add({ x: 100, y: 100 }); player.body.drive({ x: 1, y: 0 }, speed);
    let measure = false, elapsed = 0, callbacks = 0, lastDisplay = 0;
    const loop = startLoop((_time, delta) => {
      f.step(delta);
      const physical = player.actor.position();
      f.interpolation.apply();
      assert.deepEqual(player.actor.position(), physical, 'rendering must not move the Body');
      const displayed = player.object.x;
      if (measure) {
        elapsed += delta; callbacks++;
        assert.ok(Math.abs(displayed - lastDisplay - speed * delta / 1000) < 1e-6, `${hz} Hz uneven displacement`);
        assert.ok(isBodyWalking(player.body), `${hz} Hz must keep walking between physics steps`);
      }
      lastDisplay = displayed;
      f.interpolation.restore();
      assert.equal(player.object.x, physical.x, 'next physics update must see its own position');
    });
    const advance = (time: number) => loop.hasFpsLimit ? loop.stepLimitFPS(time) : loop.step(time);
    const warmup = Math.ceil(hz * 5), frames = Math.round(hz * 10);
    for (let i = 1; i <= warmup; i++) advance(i * 1000 / hz);
    const start = player.actor.position().x;
    measure = true;
    for (let i = 1; i <= frames; i++) advance((warmup + i) * 1000 / hz);
    const duration = frames * 1000 / hz;
    assert.ok(Math.abs(callbacks - Math.min(hz, 60) * duration / 1000) <= 1, `${hz} Hz must cap game frames at 60 FPS: ${callbacks}`);
    assert.ok(Math.abs(elapsed - duration) <= 1000 / hz + .001, `${hz} Hz clock drift: ${elapsed} / ${duration}`);
    assert.ok(Math.abs(player.actor.position().x - start - speed * duration / 1000) <= speed / 60 + 1e-6);
  }
});

test('jitter and long frames keep only the final physics interval for rendering', () => {
  const f = fixture({ name: 'open', bounds: { x: 0, y: 0, width: 10000, height: 10000 } });
  const player = f.add({ x: 100, y: 100 }); player.body.drive({ x: 1, y: 0 }, 120);
  let duration = 0, logicalTime = 0;
  const loop = startLoop((_time, delta) => { logicalTime += delta; f.step(delta); });
  for (let i = 0; i < 600; i++) { duration += 1000 / 120; loop.stepLimitFPS(duration); }
  const start = f.interpolation.position(player.object).x, startTime = logicalTime, startWall = duration;
  for (let i = 0; i < 1200; i++) {
    duration += i % 240 === 0 ? 80 : 1000 / 120 + Math.sin(i * 1.73);
    loop.stepLimitFPS(duration);
    const p = f.interpolation.position(player.object), physical = player.actor.position();
    assert.ok(p.x <= physical.x + 1e-7 && p.x >= physical.x - 2 - 1e-7);
    f.interpolation.apply(); f.interpolation.restore();
  }
  assert.ok(Math.abs(logicalTime - startTime - (duration - startWall)) < 1000 / 60);
  assert.ok(Math.abs(f.interpolation.position(player.object).x - start - 120 * (logicalTime - startTime) / 1000) < 1e-6);
  f.step(600);
  assert.ok(player.actor.position().x - f.interpolation.position(player.object).x <= 2 + 1e-7);
});

test('interpolation freezes on pause and resets for placement, shape changes and removal', () => {
  const f = fixture(empty), player = f.add({ x: 40, y: 40 });
  player.body.drive({ x: 1, y: 0 }, 120); f.step(25);
  assert.equal(f.interpolation.position(player.object).x, 41);
  f.world.pause(); f.step(500);
  assert.equal(f.interpolation.position(player.object).x, 41);
  f.interpolation.apply(); assert.equal(player.object.x, 41);
  f.interpolation.restore(); assert.equal(player.object.x, 42);
  player.body.halt(); player.body.reset(100, 80); player.body.updateFromGameObject();
  f.interpolation.reset(player.object);
  assert.deepEqual(f.interpolation.position(player.object), { x: 100, y: 80 });
  player.body.shape({ collision: { x: -12, y: -16, width: 24, height: 32 } });
  f.interpolation.reset(player.object);
  f.world.resume(); f.step(); f.check();
  assert.deepEqual(f.interpolation.position(player.object), { x: 100, y: 80 });
  player.body.drive({ x: -1, y: 0 }, 120); f.step(25);
  f.interpolation.apply();
  const physical = player.actor.position();
  player.dispose(); assert.deepEqual({ x: player.object.x, y: player.object.y }, physical);
  f.interpolation.destroy();
});

test('walking state survives render-only frames and stops after actual collision or release', () => {
  const f = fixture(empty), player = f.add({ x: 40, y: 80 }); f.add({ x: 80, y: 80 }, square, false);
  player.body.drive({ x: 1, y: 0 }, 120);
  f.step(1000 / 60); assert.ok(isBodyWalking(player.body));
  const before = player.actor.position();
  f.step(1000 / 120); assert.deepEqual(player.actor.position(), before); assert.ok(isBodyWalking(player.body));
  for (let i = 0; i < 60; i++) f.step(1000 / 120);
  assert.equal(player.actor.position().x, 64); assert.equal(isBodyWalking(player.body), false);
  assert.ok(player.body.deltaX() > 0, 'attempted movement is not the collision-resolved displacement');
  assert.equal(f.interpolation.position(player.object).x, 64); f.check();
  player.body.drive({ x: -1, y: 0 }, 120); f.step(1000 / 60); assert.ok(isBodyWalking(player.body));
  player.body.halt(); f.step(1000 / 60); assert.equal(isBodyWalking(player.body), false);
});

test('queries read live positions, shapes and visibility; batch destinations are atomic', () => {
  const f = fixture(empty), player = f.add({ x: 40, y: 40 }), npc = f.add({ x: 80, y: 40 }, square, false);
  assert.equal(f.navigation.canStand(player.actor, { x: 80, y: 40 }), false);
  npc.body.reset(96, 40); npc.body.updateFromGameObject();
  assert.equal(f.navigation.canStand(player.actor, { x: 80, y: 40 }), true);
  assert.equal(f.navigation.canPlaceAll([{ actor: player.actor, position: { x: 96, y: 40 } }, { actor: npc.actor, position: { x: 40, y: 40 } }]), true);
  assert.equal(f.navigation.canPlaceAll([{ actor: player.actor, position: { x: 96, y: 40 } }]), false);
  npc.body.enable = false; assert.equal(f.navigation.canStand(player.actor, { x: 96, y: 40 }), true);
  npc.body.enable = true; npc.dispose(); assert.equal(f.navigation.canStand(player.actor, { x: 96, y: 40 }), true);
  assert.deepEqual(mirroredCollision({ x: -8, y: -16, width: 24, height: 32 }, true), { x: -16, y: -16, width: 24, height: 32 });
});
test('Arcade movement stops at chest faces, slides around corners and preserves foot coordinates on shape changes', () => {
  for (const [point, axis, bound] of [[{ x: 40, y: 80 }, { x: 1, y: 0 }, 64], [{ x: 120, y: 80 }, { x: -1, y: 0 }, 96], [{ x: 80, y: 40 }, { x: 0, y: 1 }, 64], [{ x: 80, y: 120 }, { x: 0, y: -1 }, 96]] as [Point, Point, number][]) {
    const f = fixture(empty), player = f.add(point); f.add({ x: 80, y: 80 }, square, false);
    player.body.drive(axis, 133.333);
    for (let i = 0; i < 45; i++) { f.step(); f.check(); }
    const p = player.actor.position(); assert.ok(Math.abs((axis.x ? p.x : p.y) - bound) < .01);
    const before = player.actor.position(); player.body.shape({ collision: { x: -12, y: -16, width: 24, height: 32 } });
    assert.deepEqual(player.actor.position(), before);
    player.body.halt(); f.step(); assert.deepEqual(player.actor.position(), before);
  }
  const f = fixture(empty), player = f.add({ x: 64, y: 80 }); f.add({ x: 80, y: 80 }, square, false);
  player.body.drive({ x: 1, y: 1 }, 133.333);
  for (let i = 0; i < 45; i++) { f.step(); f.check(); }
  assert.ok(player.actor.position().x > 80 && player.actor.position().y > 100);
});
test('fixed physics steps preserve narrow passages and prevent long frames crossing walls, actors or waypoints', () => {
  const map = { name: 'corridor', tileSize: 16, columns: 3, rows: 12, blocked: Array.from({ length: 36 }, (_, i) => i % 3 !== 1) };
  const f = fixture(map), player = f.add({ x: 24, y: 24 }); player.body.drive({ x: 0, y: 1 }, 133.333);
  f.step(600); f.check(); assert.ok(player.actor.position().y > 90); assert.equal(player.actor.position().x, 24);
  player.body.toward({ x: 24, y: 112 }, 4000); f.step(500); f.check(); assert.equal(player.actor.position().y, 112);
  player.body.drive({ x: 1, y: 0 }, 4000); f.step(500); f.check(); assert.ok(player.actor.position().x < 32);
  const g = fixture(empty), fast = g.add({ x: 24, y: 80 }); g.add({ x: 80, y: 80 }, square, false);
  fast.body.drive({ x: 1, y: 0 }, 4000); g.step(500); g.check(); assert.ok(fast.actor.position().x <= 64);
});
test('moving actors block each other and halted or paused movement does not drift', () => {
  const f = fixture(empty), a = f.add({ x: 40, y: 80 }), b = f.add({ x: 120, y: 80 });
  a.body.drive({ x: 1, y: 0 }, 133.333); b.body.drive({ x: -1, y: 0 }, 133.333);
  for (let i = 0; i < 60; i++) { f.step(); f.check(); }
  a.body.halt(); b.body.halt(); const before = a.actor.position(); f.step(300); assert.deepEqual(a.actor.position(), before);
  a.body.drive({ x: 0, y: 1 }, 133.333); f.world.pause(); f.step(500); assert.deepEqual(a.actor.position(), before);
  f.world.resume(); f.step(); assert.ok(a.actor.position().y > before.y);
});
test('routes retry after a blocker moves and fail without teleporting when the destination stays occupied', () => {
  for (const clear of [true, false]) {
    const f = fixture(empty), player = f.add({ x: 24, y: 40 }), blocker = f.add({ x: 80, y: 80 }, square, false);
    const route = new WalkRoute(f.navigation, player.actor, { x: 120, y: 40 }, 133.333);
    player.body.walk(route, 133.333);
    blocker.body.reset(120, 40); blocker.body.updateFromGameObject();
    for (let i = 0; i < 300 && route.state === 'walking'; i++) {
      if (clear && i === 45) { blocker.body.reset(80, 80); blocker.body.updateFromGameObject(); }
      f.step(); f.check();
    }
    assert.equal(route.state, clear ? 'arrived' : 'failed');
    if (!clear) assert.notDeepEqual(player.actor.position(), route.destination);
  }
});
test('all authored walks complete with actual Arcade collisions, including parallel casts', () => {
  const read = (file: string) => JSON.parse(fs.readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8'));
  const campaign = read('content/campaign.json') as Campaign, world = read('content/world.json') as WorldIndex;
  const maps = new Map(world.maps.map(m => [m.id, read(m.file) as WorldMap]));
  let walks = 0;
  for (const script of Object.keys(campaign.scripts).filter(name => !name.includes(':'))) {
    const actions = storyScriptActions(campaign, script);
    let f: ReturnType<typeof fixture> | undefined;
    const cast = new Map<string, ReturnType<ReturnType<typeof fixture>['add']>>();
    const flatten = (a: PerformanceAction): Exclude<PerformanceAction, { type: 'parallel' }>[] => a.type === 'parallel' ? a.actions.flatMap(flatten) : [a];
    for (const action of actions) {
      if (action.type === 'dialogue' || action.type === 'choice' || action.type === 'quest-popup') continue;
      if (action.type === 'stage') {
        cast.clear();
        // `mapFromWorld` 的舞台声明「沿用场上现状」：坐标是占位，运行时按当前场景解析
        // （`resolveStoryStage`），校验器也不对它判落位。没有场上现状可依，整段不参与判定。
        if (action.mapFromWorld) { f = undefined; continue; }
        f = fixture(maps.get(action.map)!);
        const player = f.add(action, world.actors[campaign.start.actor], false); player.body.enable = action.playerVisible; cast.set('player', player);
        for (const member of action.cast) { const e = f.add(member, world.actors[member.actor], false); e.body.enable = member.visible; cast.set(member.id, e); }
        f.check(); continue;
      }
      if (!f) continue;
      const routes: { route: WalkRoute; entry: ReturnType<typeof f.add>; id: string }[] = [];
      for (const a of flatten(action)) {
        if (!('target' in a) || !a.target) continue;
        const entry = cast.get(a.target); if (!entry) continue;
        if (a.type === 'appear') { assert.ok(f.navigation.canPlace(entry.actor.shape(), a, entry.actor), `${script}/${a.target} appear`); entry.body.reset(a.x, a.y); entry.body.updateFromGameObject(); entry.body.enable = true; }
        if (a.type === 'leave') entry.body.enable = false;
        if (a.type === 'walk') {
          const route = new WalkRoute(f.navigation, entry.actor, a, a.speedPxPerSecond);
          entry.body.setImmovable(false); entry.body.walk(route, a.speedPxPerSecond); routes.push({ route, entry, id: a.target }); walks++;
        }
      }
      for (let i = 0; routes.some(r => r.route.state === 'walking') && i < 3000; i++) {
        f.step(); f.check();
        for (const r of routes) if (r.route.state === 'arrived') { r.entry.body.halt(); r.entry.body.setImmovable(true); }
      }
      for (const r of routes) { assert.equal(r.route.state, 'arrived', `${script}/${r.id}: ${r.route.error?.message}; ${JSON.stringify(r.entry.actor.position())} → ${JSON.stringify(r.route.destination)}; path ${JSON.stringify(f.navigation.path(r.entry.actor,r.route.destination))}; cast ${JSON.stringify([...cast].filter(([,e])=>e.actor.enabled()).map(([id,e])=>[id,e.actor.position()]))}`); r.entry.body.halt(); r.entry.body.setImmovable(true); }
    }
  }
  // 断言跑过的走位条数，防止脚本筛选或舞台处理改动后这段悄悄什么都不查。动态舞台整段跳过，
  // 所以这里只统计静态舞台里的走位；内容变多时同步这个数。
  assert.equal(walks, 963);
});

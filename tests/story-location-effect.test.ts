import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseCampaign, parseWorld } from '../src/application/content-validation.ts';
import { validateStoryPerformance } from '../src/application/story-performance-validation.ts';
import { compileScript, storyScriptActions } from './support/story-fixtures.ts';
import { mapEffectTone, performanceTargets } from '../src/domain/story-performance.ts';
import type { Campaign } from '../src/domain/campaign.ts';
import type { PerformanceAction } from '../src/domain/story-performance.ts';

const read = (file: string) => JSON.parse(fs.readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8'));
const campaign = parseCampaign(read('content/campaign.json')), world = parseWorld(read('content/world.json'));
const stage: PerformanceAction = { type: 'stage', map: 'shadow-camp', x: 120, y: 312, facing: 'south', playerVisible: true, cast: [] };
const withDemo = (...actions: PerformanceAction[]): Campaign => {
  const probe = structuredClone(campaign);
  probe.scripts.demo = compileScript('demo', [stage, ...actions]);
  return probe;
};

test('the authored performances carry every native location effect and map switch', () => {
  const actions = Object.keys(campaign.scripts).flatMap(name => storyScriptActions(campaign, name));
  assert.equal(actions.filter(action => action.type === 'location-effect').length, 21);
  assert.equal(actions.filter(action => action.type === 'map-effect').length, 8);
  // 事件 64 的第 12 条命令是 `0x4b`：效果 52、地图像素 (56,88)。打包坐标拆出来就是格中心。
  const event64 = storyScriptActions(campaign, 'event-64').filter(action => action.type === 'location-effect');
  assert.ok(event64.some(action => action.effect === 'story-burst-gold' && action.x === 56 && action.y === 88), '事件 64 的地点特效应落在 (56,88)');
  // 四个事件各一开一关，切图夹在中间；顺序与原版命令一致。
  for (const name of ['event-116', 'event-117', 'event-119', 'event-265']) {
    const switches = storyScriptActions(campaign, name).filter(action => action.type === 'map-effect');
    assert.deepEqual(switches.map(action => action.enabled), [true, false], `${name} 的开关应一开一关`);
  }
});

test('validation rejects a location effect the world does not carry', () => {
  assert.throws(() => validateStoryPerformance(world, withDemo({ type: 'location-effect', effect: 'missing-effect', x: 8, y: 8 })),
    /特效缺失 missing-effect/);
  validateStoryPerformance(world, withDemo(
    { type: 'location-effect', effect: 'story-burst-gold', x: 8, y: 8 },
    { type: 'map-effect', enabled: true },
    { type: 'map-effect', enabled: false }));
});

test('location effects and map switches never claim a performer', () => {
  assert.deepEqual(performanceTargets({ type: 'location-effect', effect: 'story-burst-gold', x: 8, y: 8 }), []);
  assert.deepEqual(performanceTargets({ type: 'map-effect', enabled: true }), []);
});

test('the map effect tone reproduces the native brightness recolor', () => {
  // 原版 `GRP_AddColorTone(2,0)`：L = (77R + 151G + 28B) >> 8，
  // R' = B' = 230L >> 8、G' = 220L >> 8。三行的比例由这两组系数决定。
  const [rr, rg, rb] = mapEffectTone;
  assert.ok(Math.abs(rg / rr - 151 / 77) < 1e-12);
  assert.ok(Math.abs(rb / rr - 28 / 77) < 1e-12);
  for (const channel of [0, 1, 2]) {
    const red = mapEffectTone[channel], green = mapEffectTone[5 + channel], blue = mapEffectTone[10 + channel];
    assert.ok(Math.abs(green / red - 220 / 230) < 1e-12, `第 ${channel} 列的绿行应是红行的 220/230`);
    assert.ok(Math.abs(blue - red) < 1e-12, `第 ${channel} 列的蓝行应与红行相同`);
  }
  assert.deepEqual(mapEffectTone.slice(15), [0, 0, 0, 1, 0]);
});

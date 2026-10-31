import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseCampaign, parseWorld } from '../src/application/content-validation.ts';
import { validateStoryPerformance } from '../src/application/story-performance-validation.ts';
import { compileScript, storyScriptActions } from './support/story-fixtures.ts';
import { STORY_POSE_NAMES } from '../src/domain/content.ts';
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
type PoseAction = Extract<PerformanceAction, { type: 'pose' }>;

test('every native 0x17 action the game can perform is published as a named pose', () => {
  const poses = Object.keys(campaign.scripts)
    .flatMap(name => storyScriptActions(campaign, name))
    .filter((action): action is PoseAction => action.type === 'pose' && action.pose !== 'idle' && action.pose !== 'attack');
  // 原版 118 条里 114 条找到了动画行；剩下 4 条（动作 4 与 154 的怪物实例）留在生成器的未支持台账里。
  assert.equal(poses.length, 114);
  const holding = [...new Set(poses.filter(action => action.hold).map(action => action.pose))].sort();
  // `ACTDATABASE +4 == 1` 的四个动作播完停在末帧：114 躺下、115 侧躺、147 哭号、149 拾取。
  assert.deepEqual(holding, ['cry', 'lie-down', 'lie-side', 'pick-up']);
  for (const action of poses) {
    assert.ok((STORY_POSE_NAMES as readonly string[]).includes(action.pose), `姿势名没有登记：${action.pose}`);
  }
});

test('validation rejects a pose the performer has no clip for', () => {
  validateStoryPerformance(world, withDemo({ type: 'pose', target: 'player', pose: 'cry', durationMs: 0, hold: true }));
  // 恶魔贵族的技能只有那两个首领有素材，主角身上不该有。
  assert.throws(() => validateStoryPerformance(world, withDemo(
    { type: 'pose', target: 'player', pose: 'demon-lord-attack', durationMs: 0 })), /动作缺失 kiyan\/demon-lord-attack-/);
});

test('the player performer carries every story pose it is asked to hold', () => {
  const clips = world.actors[campaign.start.actor].clips;
  for (const pose of ['cry', 'fall-down', 'give', 'lie-down', 'lie-side', 'look-around', 'pick-up', 'sway']) {
    for (const facing of ['north', 'south', 'east', 'west']) {
      assert.ok(clips[`${pose}-${facing}` as keyof typeof clips], `${campaign.start.actor} 缺 ${pose}-${facing}`);
    }
  }
});

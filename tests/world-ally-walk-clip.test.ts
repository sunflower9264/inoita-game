import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

// 世界场景的动画选择只用到剪辑名，不触碰渲染；用空 phaser 替身直接跑 afterMovement。
const phaser = registerHooks({ resolve(specifier, context, next) {
  return specifier === 'phaser'
    ? { url: 'data:text/javascript,export default {BlendModes:{NORMAL:0,ADD:1,MULTIPLY:2,SCREEN:3},Scene:class{},Physics:{Arcade:{Body:class{}}}}', shortCircuit: true }
    : next(specifier, context);
} });
const { WorldCombat } = await import('../src/scenes/world-combat.ts');
phaser.deregister();

function harness(moving: boolean, actionState = 'idle') {
  const requested: string[] = [];
  // 空剪辑表让 setCharacterClip 在读名后直接返回；记录它想播哪个动作。
  const clips = new Proxy({} as Record<string, unknown>, {
    get: (_target, key) => { requested.push(String(key)); return undefined; },
    ownKeys: () => [],
  });
  const body = { deltaXFinal: () => moving ? 2 : 0, deltaYFinal: () => 0 };
  const ally = {
    id: 'ally', member: { alive: true }, facing: 'south', body,
    visual: { actor: { clips }, container: {}, layers: [], clipName: null },
    controller: { actionState: () => actionState },
  };
  const host: any = Object.create(WorldCombat.prototype);
  const scene: any = {};
  scene.phaserScene = scene;
  for (const [key, value] of Object.entries({
    hero: { player: { health: 100 } },
    app: { session: { party: { controlledId: 'player' } } },
    scene,
    partyControllers: new Map(),
    allies: [ally],
    arena: [],
    pendingDefeats: new Set(),
    movement: { body: () => body },
  })) Object.defineProperty(host, key, { value, writable: true, configurable: true });
  return { host, requested };
}

test('跟随中的伙伴按物理位移选择行走动作', () => {
  const walking = harness(true);
  walking.host.afterMovement();
  assert.ok(walking.requested.includes('walk-south'), `期望 walk-south，实际 ${walking.requested.join(',')}`);
});

test('停下的伙伴回到待机动作', () => {
  const idle = harness(false);
  idle.host.afterMovement();
  assert.ok(idle.requested.includes('idle-south'), `期望 idle-south，实际 ${idle.requested.join(',')}`);
});

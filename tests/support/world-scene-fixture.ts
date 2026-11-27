import type { StoryContext } from '../../src/application/ports.ts';
import type { EntityPlacement, Facing, WorldMap } from '../../src/domain/content.ts';
import type { DropCatalog } from '../../src/domain/drops.ts';
import type { SpringCatalog } from '../../src/domain/springs.ts';
import type { MovementWorld } from '../../src/rendering/movement-world.ts';
import type { WorldCombat } from '../../src/scenes/world-combat.ts';
import type { WorldScene } from '../../src/scenes/world-scene.ts';
import type { WorldHud } from '../../src/ui/world-hud.ts';
import { createFakePhaserScene, installPhaserStubHooks } from './world-combat-fixture.ts';

let cachedWorldSceneCtor: typeof WorldScene | undefined;

/**
 * 注册最小 Phaser 运行时桩并动态加载真实 `WorldScene` 类，
 * 供测试通过 `new WorldScene(app)` 创建实例（零 `.prototype` 反射/篡改）。
 */
export async function loadWorldSceneClass(): Promise<typeof WorldScene> {
  if (cachedWorldSceneCtor) return cachedWorldSceneCtor;
  const hook = installPhaserStubHooks();
  try {
    const mod = await import('../../src/scenes/world-scene.ts');
    cachedWorldSceneCtor = mod.WorldScene;
    return cachedWorldSceneCtor;
  } finally {
    hook.deregister();
  }
}

export interface TestWorldSceneOptions {
  app?: Partial<StoryContext> | object;
  map?: WorldMap | object;
  player?: WorldScene['player'] | object;
  movement?: MovementWorld | object;
  combat?: WorldCombat | object;
  worldHud?: WorldHud | object;
  characters?: WorldScene['characters'] | readonly object[];
  entities?: EntityPlacement[];
  dropCatalog?: DropCatalog | object;
  springCatalog?: SpringCatalog | object;
  near?: WorldScene['near'] | object | null;
  facing?: Facing;
  loadingWorld?: boolean;
  destroyed?: boolean;
  stageOccluded?: boolean;
  sceneOverrides?: object;
}

/** 为已构造的 `WorldScene` 实例注入测试用假 Phaser 子系统与默认已加载状态（同步，零原型反射）。 */
export function buildTestWorldScene(WorldSceneCtor: typeof WorldScene, options: TestWorldSceneOptions = {}): WorldScene {
  const basePhaser = createFakePhaserScene();
  const scene = new WorldSceneCtor((options.app ?? {}) as StoryContext);
  Object.assign(scene, {
    events: basePhaser.events,
    game: basePhaser.game,
    cameras: basePhaser.cameras,
    time: basePhaser.time,
    tweens: basePhaser.tweens,
    textures: basePhaser.textures,
    anims: basePhaser.anims,
    load: basePhaser.load,
    add: basePhaser.add,
    sys: { isActive: () => true, isPaused: () => false },
    scene: { isActive: () => false, isPaused: () => false, get: () => undefined, restart: () => {}, stop: () => {} },
    scale: { width: 640, height: 360, on() {}, off() {} },
    input: { on() {}, off() {}, keyboard: null },
    physics: { world: {}, pause() {}, resume() {} },
    loadingWorld: options.loadingWorld ?? false,
    destroyed: options.destroyed ?? false,
    stageOccluded: options.stageOccluded ?? false,
    facing: options.facing ?? 'south',
    near: (options.near ?? null) as WorldScene['near'],
    map: options.map as WorldScene['map'],
    player: options.player as WorldScene['player'],
    movement: options.movement as WorldScene['movement'],
    combat: options.combat as WorldScene['combat'],
    worldHud: options.worldHud as WorldScene['worldHud'],
    characters: (options.characters ?? []) as WorldScene['characters'],
    entities: options.entities ?? [],
    dropCatalog: options.dropCatalog as WorldScene['dropCatalog'],
    springCatalog: options.springCatalog as WorldScene['springCatalog'],
  });
  if (options.sceneOverrides) {
    Object.defineProperties(scene, Object.getOwnPropertyDescriptors(options.sceneOverrides));
  }
  return scene;
}

/** 异步加载 `WorldScene` 并返回实例化测试宿主。 */
export async function createTestWorldScene(options: TestWorldSceneOptions = {}): Promise<WorldScene> {
  return buildTestWorldScene(await loadWorldSceneClass(), options);
}

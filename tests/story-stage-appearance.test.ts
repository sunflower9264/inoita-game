import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { registerHooks } from 'node:module';
import test from 'node:test';
import type { StoryContext } from '../src/application/ports.ts';
import type { ActorDefinition, WorldMap } from '../src/domain/content.ts';
import { stageSnapshot } from './helpers/story-stage.ts';
import { toPlaybackCheckpoint } from '../src/domain/playback-checkpoint.ts';

const hook = registerHooks({ resolve(specifier, context, next) {
  return specifier === 'phaser' ? { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(`
    export default {Scene:class {}, Physics:{Arcade:{Body:class {}}},BlendModes:{NORMAL:0,SCREEN:1,ADD:2,MULTIPLY:3},
      Scenes:{Events:{CREATE:'create',SHUTDOWN:'shutdown',PRE_UPDATE:'preupdate',POST_UPDATE:'postupdate',PRE_RENDER:'prerender',RENDER:'render'}},
      Cameras:{Scene2D:{Events:{PAN_COMPLETE:'pancomplete'}}}};
  `)}` } : next(specifier, context);
} });
const { StoryStageScene } = await import('../src/scenes/story-stage-scene.ts');
const { MovementWorld } = await import('../src/rendering/movement-world.ts');
hook.deregister();

// 假演员没有图集映射；空 file 走运行时动态纹理，按图层 key 取图。
const clip = (key: string) => ({ frameWidth: 8, frameHeight: 8, frames: 1, originX: 0, originY: 0,
  frameRate: 10, mirrorX: false, layers: [{ key, file: '', blend: 'normal' as const }] });
const actor = (id: string, clips: Record<string, ReturnType<typeof clip>>) =>
  ({ id, name: id, description: '', portrait: null, clips } as unknown as ActorDefinition);

const playerAppearance = actor('player', { 'idle-south': clip('player-idle-south') });
const storyDjinn = actor('enemy-lunatic-djinn-1', { 'idle-south': clip('djinn-idle-south'),
  'demon-lord-attack-west': clip('djinn-demon-lord-attack-west') });
const battleDjinn = actor('enemy-lunatic-djinn-battle', { 'idle-south': clip('battle-idle-south') });
const battleWithoutStory = actor('enemy-without-story-battle', { 'idle-south': clip('fallback-idle-south') });
const snapshotGuard = actor('guard-snapshot', { 'idle-south': clip('guard-idle-south') });
const worldGuard = actor('guard-world', { 'idle-south': clip('guard-world-idle-south') });
const worldActors = { 'enemy-lunatic-djinn-1': storyDjinn, hero: worldGuard };

const map = { id: 'small', name: 'Small', width: 256, height: 448, columns: 16, rows: 28,
  tileSize: 16, blocked: [], ground: 'ground.png', canopy: 'canopy.png', features: [], entities: [] } as unknown as WorldMap;

function fakeScene() {
  const events = new EventEmitter();
  const image = () => {
    const value: Record<string, any> = { scene: {} };
    value.setOrigin = () => value; value.setDepth = () => value; value.setFlipX = () => value;
    value.setBlendMode = () => value; value.destroy = () => { value.scene = undefined; };
    return value;
  };
  const container = () => {
    const value: Record<string, any> = { x: 0, y: 0, scene: {}, visible: true };
    value.setDepth = () => value; value.setVisible = (next: boolean) => { value.visible = next; return value; };
    value.setAlpha = () => value; value.addAt = () => {}; value.destroy = () => { value.scene = undefined; };
    return value;
  };
  const sprite = () => {
    const value: Record<string, any> = { anims: {} };
    value.setOrigin = () => value; value.setBlendMode = () => value; value.setScale = () => value;
    value.destroy = () => {};
    return value;
  };
  const camera = { scrollX: 0, scrollY: 0, width: 960, height: 640, zoom: 1,
    setBackgroundColor() { return camera; }, setZoom() { return camera; }, setRoundPixels() { return camera; },
    setBounds() { return camera; }, centerOn() { return camera; } };
  return {
    events, scale: { width: 960, height: 640, on() {}, off() {} },
    game: { canvas: { getBoundingClientRect: () => ({ width: 960, height: 640 }) } },
    sys: { isActive: () => true }, cameras: { main: camera },
    add: { image, container, sprite, group: () => ({ add() {} }) },
    physics: { world: { on() {}, add() {} }, add: { collider: () => ({}) } },
    textures: { exists: () => true, get: () => ({ has: () => true }), remove() {}, createCanvas() {} },
    anims: { exists: () => false, remove() {}, create() {}, generateFrameNumbers: () => [] }, input: {},
    load: { image() {}, start() {}, on() {}, once() {}, off() {} }
  };
}

test('the stage draws a world enemy with its story appearance even when the snapshot carries the battle look', async () => {
  const app = {
    world: { maps: [{ id: 'small', file: 'small.json' }], props: [], actors: worldActors, storyEffects: {} },
    content: { map: async () => map },
    wardrobe: { textures: [] },
    battleCatalog: { enemies: [{ id: 'enemy-without-story', actor: battleWithoutStory }] },
    session: { evaluateCondition: () => true, storyWorld: { visit: 0, currentLocation: { map: 'small' },
      visible: () => true, actorAppearance: (id: string) => id, projectEntities: (_map: string, base: unknown[]) => base } },
    campaign: { start: { actor: 'player' }, placements: [] }
  } as unknown as StoryContext;
  const scene = new StoryStageScene(app);
  Object.assign(scene, fakeScene(), {
    scene: { get: () => undefined }
  });
  const saved = { register: MovementWorld.prototype.register, setEnabled: MovementWorld.prototype.setEnabled,
    setGhost: MovementWorld.prototype.setGhost, remove: MovementWorld.prototype.remove,
    destroy: MovementWorld.prototype.destroy };
  MovementWorld.prototype.register = function () { return {} as never; };
  MovementWorld.prototype.setEnabled = function () {};
  MovementWorld.prototype.setGhost = function () {};
  MovementWorld.prototype.remove = function () {};
  MovementWorld.prototype.destroy = function () {};
  const stage = stageSnapshot({ type: 'stage', map: 'small', x: 16, y: 16, facing: 'south', playerVisible: true,
    cast: [
      { id: 'djinn', actor: 'enemy-lunatic-djinn-1', enemyId: 'enemy-lunatic-djinn-1', x: 32, y: 32, facing: 'west', visible: true },
      { id: 'no-story', actor: 'enemy-without-story', enemyId: 'enemy-without-story', x: 48, y: 48, facing: 'south', visible: true },
      { id: 'guard', actor: 'hero', x: 64, y: 64, facing: 'south', visible: true }
    ] });
  const sceneActor = (alias: string) => stage.scene.actors.find(entry => entry.id === `cast:${alias}`)!;
  // 快照来自战斗：外观是战斗外观，动作停在剧情姿态上。
  sceneActor('djinn').appearance = battleDjinn;
  sceneActor('djinn').clip = 'demon-lord-attack-west';
  sceneActor('no-story').appearance = battleWithoutStory;
  sceneActor('guard').appearance = snapshotGuard;
  try {
    // 旧实现会用战斗外观绘制，这里找不到 demon-lord-attack-west 而抛错。
    await scene.showStage(stage, new AbortController().signal, playerAppearance);
    assert.equal(scene.characters.get('cast:djinn')!.actor, storyDjinn, '敌人用 world.actors 的剧情外观');
    assert.equal(scene.characters.get('cast:no-story')!.actor, battleWithoutStory, '剧情外观缺失时回退快照外观');
    assert.equal(scene.characters.get('cast:guard')!.actor, snapshotGuard, '手写演员仍用快照外观');

    const saved = toPlaybackCheckpoint({ version: 2, sequence: 1, completedEvents: [], handledOccurrences: [], occurrenceSequences: [], encounterResults: [], pendingOccurrences: [],
      runs: [{ id: 'test', script: 'test', occurrence: 'test', cursor: { script: 'test', node: 'test' }, status: 'running', stage }] });
    await scene.showStage(saved.runs[0]!.stage!, new AbortController().signal, playerAppearance);
    assert.equal(scene.characters.get('cast:no-story')!.actor, battleWithoutStory, '存档去掉缓存外观后按敌人 ID 恢复');

    // 演出中新增的敌人走增量创建路径，同样优先剧情外观。
    const later = stageSnapshot({ type: 'stage', map: 'small', x: 16, y: 16, facing: 'south', playerVisible: true,
      cast: [
        { id: 'djinn', actor: 'enemy-lunatic-djinn-1', enemyId: 'enemy-lunatic-djinn-1', x: 32, y: 32, facing: 'west', visible: true },
        { id: 'no-story', actor: 'enemy-without-story', enemyId: 'enemy-without-story', x: 48, y: 48, facing: 'south', visible: true },
        { id: 'guard', actor: 'hero', x: 64, y: 64, facing: 'south', visible: true },
        { id: 'late', actor: 'enemy-lunatic-djinn-1', enemyId: 'enemy-lunatic-djinn-1', x: 80, y: 80, facing: 'east', visible: true }
      ] });
    const laterActor = later.scene.actors.find(entry => entry.id === 'cast:late')!;
    laterActor.appearance = battleDjinn;
    laterActor.clip = 'demon-lord-attack-west';
    scene.ensureActors(later);
    assert.equal(scene.characters.get('cast:late')!.actor, storyDjinn, '增量创建也优先剧情外观');
  } finally {
    MovementWorld.prototype.register = saved.register;
    MovementWorld.prototype.setEnabled = saved.setEnabled;
    MovementWorld.prototype.setGhost = saved.setGhost;
    MovementWorld.prototype.remove = saved.remove;
    MovementWorld.prototype.destroy = saved.destroy;
  }
});

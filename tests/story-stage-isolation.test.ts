import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { registerHooks } from 'node:module';
import test from 'node:test';
import type { StoryContext } from '../src/application/ports.ts';
import type { ActorDefinition, WorldMap } from '../src/domain/content.ts';
import { validateStoryStageSnapshot, type StoryStage, type StoryStageSnapshot } from '../src/domain/story-performance.ts';
import { SCENE_KEYS } from '../src/application/scene-keys.ts';
import { stageSnapshot } from './helpers/story-stage.ts';
import type { WorldScene } from '../src/scenes/world-scene.ts';
import type { StoryStageScene as StageSceneType } from '../src/scenes/story-stage-scene.ts';

const hook = registerHooks({ resolve(specifier, context, next) {
  return specifier === 'phaser' ? { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(`
    export default {Scene:class {}, Physics:{Arcade:{Body:class {}}},BlendModes:{NORMAL:0,SCREEN:1,ADD:2,MULTIPLY:3},
      Scenes:{Events:{CREATE:'create',SHUTDOWN:'shutdown',PRE_UPDATE:'preupdate',POST_UPDATE:'postupdate',PRE_RENDER:'prerender',RENDER:'render'}},
      Cameras:{Scene2D:{Events:{PAN_COMPLETE:'pancomplete'}}}};
  `)}` } : next(specifier, context);
} });
const { StoryPresenter } = await import('../src/rendering/story-presenter.ts');
const { StoryStageScene, STAGE_BACKDROP_COLOR, STAGE_TRANSPARENT_COLOR } = await import('../src/scenes/story-stage-scene.ts');
const { MovementWorld } = await import('../src/rendering/movement-world.ts');
hook.deregister();

const appearance = { id: 'hero', clips: {} } as ActorDefinition;

test('the initial curtain is drawn during create before readiness and survives map preparation', () => {
  const sequence: string[] = [], covers: { destroyed: boolean }[] = [], occlusions: boolean[] = [];
  const events = new EventEmitter(), scale = Object.assign(new EventEmitter(), { width: 320, height: 200 });
  const scene = new StoryStageScene({} as StoryContext);
  Object.assign(scene, { events, scale, cameras: { main: { setBackgroundColor() {} } }, input: {},
    scene: { get: (key: string) => key === SCENE_KEYS.world
      ? { setStageOccluded(value: boolean) { occlusions.push(value); } } : undefined },
    add: { rectangle(x: number, y: number, width: number, height: number, color: number) {
      assert.deepEqual({x,y,width,height,color}, {x:-320,y:-200,width:960,height:600,color:0});
      sequence.push('cover');
      const cover = { destroyed: false, setOrigin() { return this; }, setScrollFactor() { return this; },
        setDepth() { return this; }, setAlpha(opacity: number) { assert.equal(opacity, 1); return this; },
        destroy() { this.destroyed = true; } };
      covers.push(cover); return cover;
    } }
  });
  scene.create({ initialCurtain: { opacity: 1, color: 0 }, onReady: () => sequence.push('ready') });
  assert.deepEqual(sequence, ['cover']);
  assert.deepEqual(occlusions, [false], '首幕透明，正式世界保持可见');
  events.emit('create'); assert.deepEqual(sequence, ['cover', 'ready']);
  scene.releaseStage(true); assert.equal(covers[0].destroyed, false);
  assert.deepEqual(occlusions, [false], '保留幕布的中间释放不解除遮挡状态');
  scene.clearEarlyCurtain(); assert.equal(covers[0].destroyed, true);
  scene.showInitialCurtain({ opacity: 1, color: 0 });
  events.emit('shutdown'); assert.equal(covers[1].destroyed, true);
  assert.deepEqual(occlusions, [false, false], 'shutdown 后正式世界恢复可见');
});

test('the stage backdrop turns opaque only after a map is drawn and transparent on release', async () => {
  const colors: string[] = [];
  const map = { id: 'small', name: 'Small', width: 256, height: 448, columns: 16, rows: 28,
    tileSize: 16, blocked: [], ground: 'ground.png', canopy: 'canopy.png', features: [], entities: [] } as unknown as WorldMap;
  const app = {
    world: { maps: [{ id: 'small', file: 'small.json' }], props: [], actors: { hero: appearance }, storyEffects: {} },
    content: { map: async () => map },
    wardrobe: { textures: [] },
    session: { evaluateCondition: () => true, storyWorld: { visit: 0, currentLocation: { map: 'small' }, visible: () => true,
      actorAppearance: (actor: string) => actor, projectEntities: (_map: string, base: unknown[]) => base } },
    campaign: { start: { actor: 'hero' }, placements: [] }
  } as unknown as StoryContext;
  const scene = new StoryStageScene(app);
  const image = () => {
    const value: Record<string, unknown> = { scene: {}, setOrigin() { return value; }, setDepth() { return value; },
      setFlipX() { return value; }, setBlendMode() { return value; }, destroy() { value.scene = undefined; } };
    return value;
  };
  const container = () => {
    const value = Object.assign(new EventEmitter(), { x: 0, y: 0, scene: {}, visible: true,
      setOrigin() { return value; }, setDepth() { return value; }, setScrollFactor() { return value; },
      setPosition() { return value; }, setSize() { return value; }, setAlpha() { return value; },
      setVisible(next: boolean) { value.visible = next; return value; },
      destroy() { (value as { scene?: unknown }).scene = undefined; } });
    return value;
  };
  const camera = { scrollX: 0, scrollY: 0, width: 960, height: 640, zoom: 1,
    setBackgroundColor(color: string) { colors.push(color); return camera; },
    setZoom() { return camera; }, setRoundPixels() { return camera; }, setBounds() { return camera; }, centerOn() { return camera; } };
  const occlusions: boolean[] = [];
  Object.assign(scene, {
    scene: { get: (key: string) => key === SCENE_KEYS.world
      ? { setStageOccluded(value: boolean) { occlusions.push(value); } } : undefined },
    events: new EventEmitter(), scale: { width: 960, height: 640, on() {}, off() {} },
    game: { canvas: { getBoundingClientRect: () => ({ width: 960, height: 640 }) } },
    sys: { isActive: () => true }, cameras: { main: camera },
    add: { image, container, group: () => ({ add() {} }) },
    physics: { world: { on() {}, add() {} }, add: { collider: () => ({}) } },
    textures: { exists: () => true, get: () => ({ has: () => true }), remove() {}, createCanvas() {} },
    anims: { exists: () => false, remove() {} }, input: {},
    load: { image() {}, start() {}, on() {}, once() {}, off() {} }
  });
  const saved = { register: MovementWorld.prototype.register, setEnabled: MovementWorld.prototype.setEnabled,
    destroy: MovementWorld.prototype.destroy };
  MovementWorld.prototype.register = function () { return {} as never; };
  MovementWorld.prototype.setEnabled = function () {};
  MovementWorld.prototype.destroy = function () {};
  const stage = stageSnapshot({ type: 'stage', map: 'small', x: 16, y: 16, facing: 'south', playerVisible: true, cast: [] });
  const content = app.content as unknown as { map: (file: string, signal?: AbortSignal) => Promise<WorldMap> };
  try {
    // 首张地图加载失败：舞台仍透明，正式世界应保持可见。
    content.map = async () => { throw new Error('load failed'); };
    await assert.rejects(scene.showStage(stage, new AbortController().signal, appearance));
    assert.ok(!colors.includes(STAGE_BACKDROP_COLOR));
    assert.ok(!occlusions.includes(true), '首张图失败时正式世界不被遮挡');

    content.map = async () => map;
    await scene.showStage(stage, new AbortController().signal, appearance);
    assert.equal(colors.at(-1), STAGE_BACKDROP_COLOR);
    assert.deepEqual(occlusions, [true], '舞台铺满后才停掉正式世界');
    const previousPlayer=scene.player;
    app.world.actors.broken={id:'broken',clips:{'idle-east':{layers:[]}}} as unknown as ActorDefinition;
    const invalidCast=stageSnapshot({...stage,cast:[{id:'broken',actor:'broken',x:8,y:8,facing:'south',visible:true}]});
    await assert.rejects(scene.showStage(invalidCast,new AbortController().signal,appearance),/角色动作缺少资源/);
    assert.equal(scene.player,previousPlayer);assert.equal(scene.characters.size,1);
    assert.ok(previousPlayer?.container.scene,'下一幕构造失败保留当前角色');
    previousPlayer!.container.x=99;
    scene.ensureActors(stageSnapshot({...stage},[{id:'entity:door',actor:'hero',x:24,y:40,facing:'west',visible:true}]));
    assert.equal(scene.player,previousPlayer);assert.equal(scene.player!.container.x,99,'补充物件不打断既有走位');
    assert.ok(scene.characters.has('entity:door'));

    // 已有舞台时下一张图失败：保留已经画好的遮罩，不能露出世界。
    content.map = async () => { throw new Error('load failed'); };
    await assert.rejects(scene.showStage({ ...stage, map: 'other' }, new AbortController().signal, appearance));
    assert.equal(colors.at(-1), STAGE_BACKDROP_COLOR);
    assert.equal(occlusions.at(-1), true, '换图失败时保留遮挡，不露出正式世界');

    scene.releaseStage();
    assert.equal(colors.at(-1), STAGE_TRANSPARENT_COLOR);
    assert.deepEqual(occlusions, [true, false], '舞台释放后正式世界恢复渲染');
    // SHUTDOWN 时 CameraManager 可能已经销毁主相机，清理路径不能抛错。
    (scene.cameras as unknown as { main?: unknown }).main = undefined;
    assert.doesNotThrow(() => scene.releaseStage());
    assert.equal(occlusions.at(-1), false);
  } finally {
    MovementWorld.prototype.register = saved.register;
    MovementWorld.prototype.setEnabled = saved.setEnabled;
    MovementWorld.prototype.destroy = saved.destroy;
  }
});

test('a stage map draws static map entities and removes them with the map', async () => {
  const { drawStoryCharacters } = await import('../src/rendering/story-map-view.ts');
  const containers: { x: number; y: number; depth: number; scene?: unknown; setDepth(value: number): unknown; destroy(): void }[] = [];
  const scene = {
    add: {
      image() {
        const value: { scene?: unknown; setOrigin(): unknown; setDepth(): unknown; setFlipX(): unknown; setBlendMode(): unknown; destroy(): void } = {
          scene: {}, setOrigin() { return value; }, setDepth() { return value; }, setFlipX() { return value; },
          setBlendMode() { return value; }, destroy() { value.scene = undefined; }
        };
        return value;
      },
      container(x: number, y: number) {
        const value: { x: number; y: number; depth: number; scene?: unknown; setDepth(next: number): unknown; setVisible(): unknown; setAlpha(): unknown; destroy(): void } = {
          x, y, depth: 0, scene: {},
          setDepth(next) { this.depth = next; return this; },
          setVisible() { return this; }, setAlpha() { return this; },
          destroy() { this.scene = undefined; }
        };
        containers.push(value); return value;
      }
    },
    textures: { exists: () => false, remove() {} }
  };
  const map = { id: 'small', features: [], entities: [
    { id: 'exit', actor: 'map-exit-x', x: 24, y: 48 },
    { id: 'steel', actor: 'steel-door-x', x: 30, y: 64 },
    { id: 'torch', actor: 'torch-x', x: 12, y: 20 },
    { id: 'chest', actor: 'treasure-box-x', x: 8, y: 16 },
    { id: 'spring', actor: 'clear-springs-x', x: 4, y: 8, spring: true }
  ] } as unknown as WorldMap;
  const actors = map.entities.map(entity => ({...entity, facing:'south' as const, visible:true}));
  const appearances = new Map(actors.map(actor => [actor.id, {id:actor.actor,clips:{}} as ActorDefinition]));
  const characters = drawStoryCharacters(scene as unknown as Parameters<typeof drawStoryCharacters>[0], actors, appearances);
  assert.equal(containers.length, 5, '完整名单中的门、火把、宝箱与泉水全部绘制');
  assert.deepEqual({ x: containers[0]!.x, y: containers[0]!.y, depth: containers[0]!.depth }, { x: 24, y: 48, depth: 48.5 });
  assert.deepEqual({ x: containers[1]!.x, y: containers[1]!.y, depth: containers[1]!.depth }, { x: 30, y: 64, depth: 64.5 });
  assert.deepEqual({ x: containers[2]!.x, y: containers[2]!.y, depth: containers[2]!.depth }, { x: 12, y: 20, depth: 20.5 });
  for(const visual of characters.values())visual.container.destroy();
  assert(containers.every(container => container.scene === undefined), '清理演出地图时一并销毁门');
});

function harness() {
  const owner = {};
  const container = (x: number, y: number) => Object.assign(new EventEmitter(), {
    x, y, scene: owner as object | undefined, visible: true,
    setVisible(value: boolean) { this.visible = value; return this; },
    setDepth() { return this; }, setOrigin() { return this; }, setScrollFactor() { return this; },
    setPosition(x: number, y: number) { this.x = x; this.y = y; return this; },
    setSize() { return this; }, setFillStyle() { return this; }, setAlpha() { return this; },
    destroy() { this.scene = undefined; }
  });
  const visual = (x: number, y: number) => ({ actor: appearance, entity: { id: 'player', actor: 'hero', x, y }, container: container(x, y), layers: [], clipName: null });
  const world = { map: { id: 'home' }, player: visual(10, 20), facing: 'south', characters: [],
    cameras: { main: { scrollX: 5, scrollY: 6 } },
    scene: { launch() { throw new Error('active stage must be reused'); }, restart() { throw new Error('formal world must be retained'); } },
    captureStoryScene(this: WorldScene){return {map:this.map!.id,actors:[
      {id:'player',actor:'hero',x:this.player!.container.x,y:this.player!.container.y,facing:this.facing,visible:true},
      ...this.characters.map(visual=>({id:'entity:'+visual.entity.id,worldEntityId:visual.entity.id,actor:visual.entity.actor,
        characterId:visual.entity.characterId,x:visual.container.x,y:visual.container.y,facing:'south',visible:visual.container.visible}))]};},
    prefetchMap() {}, showStage() { throw new Error('formal world must not prepare cinematics'); }
  } as unknown as WorldScene;
  let released = 0, rendered = 0;
  const placeAllGroups: number[] = [], audioMaps: string[] = [];
  const movement = {
    stop() {}, remove() {}, register() {}, setEnabled() {}, setGhost() {},
    position(target: ReturnType<typeof visual>) { return { x: target.container.x, y: target.container.y }; },
    actor(target: ReturnType<typeof visual>) { return { enabled: () => target.container.visible !== false }; },
    body() { return { immovable: true, velocity: { x: 0, y: 0 }, setImmovable(value: boolean) { this.immovable = value; } }; },
    walkTo(target: ReturnType<typeof visual>, destination: { x: number; y: number }) {
      this.placeAll([{ visual: target, position: destination, enabled: true }]);
      return { state: 'arrived' as const };
    },
    place(target: ReturnType<typeof visual>, position: { x: number; y: number }) {
      this.placeAll([{ visual: target, position, enabled: target.container.visible }]);
    },
    placeContent(target: ReturnType<typeof visual>, position: { x: number; y: number }, enabled?:boolean) {
      this.placeAll([{ visual: target, position, enabled }]);
    },
    placeAll(values: { visual: ReturnType<typeof visual>; position: { x: number; y: number }; enabled?: boolean }[]) {
      placeAllGroups.push(values.length);
      for (const value of values) { value.visual.container.x = value.position.x; value.visual.container.y = value.position.y;
        if (value.enabled !== undefined) value.visual.container.visible = value.enabled; }
    }
  };
  const events = new EventEmitter();
  const stage = { characters: new Map(), map: undefined as { id: string } | undefined, player: visual(10, 20), facing: 'south', movement,
    cameras: { main: { scrollX: 0, scrollY: 0, width: 960, height: 640, zoom: 1, stopFollow() {},
      setScroll(this: { scrollX: number; scrollY: number }, x: number, y: number) { this.scrollX = x; this.scrollY = y; },
      centerOn(this: { scrollX: number; scrollY: number }, x: number, y: number) { this.scrollX = x - 480; this.scrollY = y - 320; }
    } }, sys: { isActive: () => true, isPaused: () => false },
    add: { container, rectangle: () => container(0, 0) }, scale: { width: 960, height: 640 },
    async showStage(this: { map?: { id: string }; player: ReturnType<typeof visual>; characters: Map<string, ReturnType<typeof visual>> }, value: StoryStageSnapshot, signal: AbortSignal) {
      signal.throwIfAborted(); this.map = { id: value.map }; rendered++;
      this.characters.clear();
      for(const actor of value.scene.actors){
        const character=visual(actor.x,actor.y);character.entity={id:actor.id,actor:actor.actor,x:actor.x,y:actor.y};
        character.container.visible=actor.visible;this.characters.set(actor.id,character);
      }
      this.player=this.characters.get('player')!;
      audioMaps.push(value.map);
    },
    ensureActors(this:{characters:Map<string,ReturnType<typeof visual>>},value:StoryStageSnapshot){
      for(const actor of value.scene.actors)if(!this.characters.has(actor.id)){
        const character=visual(actor.x,actor.y);character.entity={id:actor.id,actor:actor.actor,x:actor.x,y:actor.y};
        character.container.visible=actor.visible;this.characters.set(actor.id,character);
      }
    },
    async prepareActorAssets(){},
    releaseStage(this: { map?: { id: string } }) { released++; this.map = undefined; }, events,
    clearEarlyCurtain() {},
    scene: { stop() { events.emit('shutdown'); } }
  } as unknown as StageSceneType;
  const app = { session:{storyWorld:{actorAppearance:(id:string)=>id}}, world: { actors: { hero: appearance, guard: { ...appearance, id: 'guard' }, saint: { ...appearance, id: 'saint' } } }, campaign: { start: { actor: 'hero' } } } as unknown as StoryContext;
  const presenter = new StoryPresenter(app, () => world, () => stage);
  const prepared=(presenter as unknown as {scenes:Map<string,unknown>}).scenes;
  for(const map of ['hall','remote'])prepared.set(map,{map,actors:[{id:'player',actor:'hero',x:10,y:20,facing:'south',visible:true}]});
  return { presenter, stage, world, released: () => released, rendered: () => rendered,
    placeAllGroups: () => placeAllGroups, audioMaps: () => audioMaps };
}

test('cinematic travel retains formal world and only explicit bindings become world changes', async () => {
  const run = harness(), signal = new AbortController().signal;
  await run.presenter.begin(signal);
  await run.presenter.execute({ type: 'stage', map: 'hall', x: 30, y: 40, facing: 'east', playerVisible: true,
    cast: [
      { id: 'named-performer', worldEntityId: 'persistent-guard', actor: 'guard', x: 60, y: 70, facing: 'west', visible: true },
      { id: 'temporary-double', actor: 'guard', x: 80, y: 90, facing: 'south', visible: true }
    ] }, { signal, skipSignal: signal });
  await run.presenter.finish(true, signal);
  assert.equal(run.world.map!.id, 'home'); assert.equal(run.world.player!.container.x, 10);
  assert.equal(run.released(), 0, 'final frame remains while runtime commits and projects');
  assert.deepEqual(run.presenter.getWorldChanges(), [{ id: 'persistent-guard', map: 'hall', actor: 'guard', x: 60, y: 70, facing: 'west', visible: true }]);
  const saved = run.presenter.captureStage()!; saved.cast[0].x = 999;
  assert.equal(run.presenter.captureStage()!.cast[0].x, 60);
  await run.presenter.release(); assert.equal(run.released(), 1);
});

test('a single-frame stage animation never writes NaN progress into the captured scene', async () => {
  const run = harness(), signal = new AbortController().signal;
  await run.presenter.begin(signal);
  // 完整外观才能通过快照校验；这里只关心进度字段。
  run.stage.player!.actor = { id: 'hero', name: 'Hero', description: '', portrait: null, clips: {} };
  // Phaser 单帧动画的 getProgress() 是 NaN；舞台快照必须把它收敛成 undefined。
  run.stage.player!.layers.push({ anims: { currentAnim: {}, getProgress: () => NaN, isPlaying: true } } as never);
  const snapshot = run.presenter.captureStage()!;
  const player = snapshot.scene.actors.find(actor => actor.id === 'player')!;
  assert.equal(player.animationProgress, undefined);
  assert.equal(player.animationPlaying, true);
  assert.doesNotThrow(() => validateStoryStageSnapshot(snapshot));
});

test('交还操作权时重新应用正式世界的地图音乐，回菜单后不再应用', async () => {
  const applied: string[] = [];
  const world = { map: { id: 'shadow-camp' } } as unknown as WorldScene;
  const stage = { sys: { isActive: () => false, isPaused: () => false } } as unknown as StageSceneType;
  const presenter = (mode: string) => new StoryPresenter(
    { audio: { enterMap: (id: string) => applied.push(id) }, ui: { mode } } as unknown as StoryContext,
    () => world, () => stage);

  await presenter('game').release();
  assert.deepEqual(applied, ['shadow-camp']);
  await presenter('menu').release();
  assert.deepEqual(applied, ['shadow-camp'], '回菜单后不能再把地图音乐盖到菜单主题上');
});

test('deferred first stage inherits the world actor instead of resolving against its own declaration', async () => {
  const run = harness(), signal = new AbortController().signal;
  // 正式世界已经在洞穴入口，圣女是事件 3 登记在藏身处的世界实体。
  (run.world as unknown as { map: { id: string }; player: { container: { x: number; y: number } } }).map = { id: 'depths' };
  run.world.player!.container.x = 40; run.world.player!.container.y = 168;
  (run.world as unknown as { characters: unknown[] }).characters = [{
    entity: { id: 'quest-npc-located-npc-79', characterId: 'npc-79', actor: 'saint', x: 360, y: 136 },
    actor: { id: 'saint' }, container: { x: 360, y: 136, visible: true }, clipName: 'idle-south'
  }];
  // 上一段演出留下的最后一帧还停在同一张图、同一个旧坐标；它不是本段主角的起点。
  (run.stage as unknown as { map: { id: string } }).map = { id: 'depths' };
  run.stage.player!.container.x = 200; run.stage.player!.container.y = 184;
  // 这一幕自己的声明把圣女写成「位置未知、从现场继承」，主角坐标只是兜底锚点。
  const action: StoryStage = { type: 'stage', map: 'depths', x: 200, y: 184, facing: 'south', playerVisible: false,
    retainPlayerPosition: true, cast: [{ id: 'saint', actor: 'saint', characterId: 'npc-79', x: 2048, y: 2048,
      facing: 'south', visible: false, unpositioned: true, inheritPosition: true }] };
  await run.presenter.begin(signal, action, undefined, true);
  await run.presenter.execute(action, { signal, skipSignal: signal });
  const stage = run.presenter.captureStage()!;
  const saint = stage.cast.find(member => member.characterId === 'npc-79')!;
  assert.deepEqual([saint.x, saint.y, saint.visible, saint.unpositioned], [360, 136, true, undefined]);
  assert.deepEqual([stage.x, stage.y], [40, 168], '主角接正式世界的入口位置，而不是声明的兜底锚点');
});

test('show reveals an already positioned character without moving it', async () => {
  const run = harness(), signal = new AbortController().signal;
  await run.presenter.begin(signal);
  await run.presenter.execute({ type: 'stage', map: 'hall', x: 30, y: 40, facing: 'east', playerVisible: false, cast: [] },
    { signal, skipSignal: signal });
  assert.equal(run.stage.player!.container.visible, false);
  const before = { x: run.stage.player!.container.x, y: run.stage.player!.container.y };
  await run.presenter.execute({ type: 'show', target: 'player' }, { signal, skipSignal: signal });
  assert.equal(run.stage.player!.container.visible, true);
  assert.deepEqual([run.stage.player!.container.x, run.stage.player!.container.y], [before.x, before.y], '显形不能挪位置');
});

test('a stage handed to begin paints once, when the following execute runs', async () => {
  const run = harness(), signal = new AbortController().signal;
  const action = { type: 'stage' as const, map: 'hall', x: 30, y: 40, facing: 'east' as const, playerVisible: true, cast: [] };
  await run.presenter.begin(signal, action, undefined, true);
  assert.equal(run.rendered(), 0, '首幕舞台动作留给 execute 一次画出，begin 不重复建图');
  await run.presenter.execute(action, { signal, skipSignal: signal });
  assert.equal(run.rendered(), 1);
});

test('appear create registers its new instance before the scene pass resolves the alias', async () => {
  const run = harness(), signal = new AbortController().signal;
  await run.presenter.begin(signal);
  await run.presenter.execute({ type: 'stage', map: 'hall', x: 30, y: 40, facing: 'east', playerVisible: true,
    cast: [{ id: 'soldier', actor: 'guard', x: 60, y: 70, facing: 'south', visible: false }] }, { signal, skipSignal: signal });
  await run.presenter.execute({ type: 'appear', target: 'soldier', mode: 'create', worldEntityId: 'created-soldier',
    x: 80, y: 90, facing: 'north' }, { signal, skipSignal: signal });
  const member = run.presenter.captureStage()!.cast.find(member => member.id === 'soldier')!;
  assert.deepEqual([member.worldEntityId, member.x, member.y, member.facing, member.visible],
    ['created-soldier', 80, 90, 'north', true]);
});

test('stage snapshot records the Phaser camera midpoint without dividing by zoom', async () => {
  const run = harness(), signal = new AbortController().signal;
  await run.presenter.begin(signal);
  const camera = run.stage.cameras.main;
  camera.zoom = 2; camera.scrollX = 100; camera.scrollY = 50;
  assert.deepEqual(run.presenter.captureStage()!.camera, { x: 580, y: 370 });
});

test('parallel walks settle as one placement group after every actor arrives', async () => {
  const run = harness(), signal = new AbortController().signal;
  await run.presenter.begin(signal);
  await run.presenter.execute({ type: 'stage', map: 'hall', x: 30, y: 40, facing: 'east', playerVisible: true,
    cast: [{ id: 'guard', actor: 'guard', x: 60, y: 70, facing: 'south', visible: true },
      { id: 'saint', actor: 'saint', x: 80, y: 90, facing: 'south', visible: true }] }, { signal, skipSignal: signal });
  run.placeAllGroups().length = 0;
  await run.presenter.parallel([
    { type: 'walk', target: 'guard', x: 100, y: 110, speedPxPerSecond: 100 },
    { type: 'walk', target: 'saint', x: 120, y: 130, speedPxPerSecond: 100 }
  ], { signal, skipSignal: signal });
  assert.ok(run.placeAllGroups().some(size => size === 2), '并行走位结束后按整组落位');
  const snapshot = run.presenter.captureStage()!;
  const position = (alias: string) => snapshot.cast.find(member => member.id === alias)!;
  assert.deepEqual([position('guard').x, position('guard').y], [100, 110]);
  assert.deepEqual([position('saint').x, position('saint').y], [120, 130]);
});

test('a deferred mapFromWorld first stage draws its map only once', async () => {
  const run = harness(), signal = new AbortController().signal;
  await run.presenter.begin(signal, undefined, undefined, true);
  assert.equal(run.rendered(), 0, '延后的首幕不在 begin 里建图');
  await run.presenter.execute({ type: 'stage', mapFromWorld: true, map: 'home', x: 10, y: 20,
    facing: 'south', playerVisible: true, cast: [] }, { signal, skipSignal: signal });
  assert.equal(run.rendered(), 1);
  assert.deepEqual(run.audioMaps(), ['home'], '同一张图只切一次音乐');
});

test('failure restores cinematic baseline with caller signal and leaves formal world intact', async () => {
  const run = harness(), signal = new AbortController().signal;
  await run.presenter.begin(signal);
  await run.presenter.travel({ map: 'remote', x: 80, y: 90, facing: 'north' }, signal);
  await run.presenter.execute({ type: 'fade', opacity: 1, color: 0, durationMs: 0 }, { signal, skipSignal: signal });
  assert.equal(run.presenter.captureStage()!.curtain!.opacity, 1);
  await run.presenter.finish(false, signal);
  assert.equal(run.presenter.captureStage()!.map, 'home'); assert.equal(run.world.map!.id, 'home');
  assert.deepEqual(run.presenter.captureStage()!.curtain, { opacity: 0, color: 0 });
  assert.deepEqual(run.presenter.captureStage()!.camera, { x: 485, y: 326 });
  const abort = new AbortController(); abort.abort(new DOMException('cancelled', 'AbortError'));
  await run.presenter.finish(false, abort.signal); assert.equal(run.released(), 1);
});

test('cancelled or superseded resource loading releases the late lease without rebuilding a stage', async () => {
  for (const cancellation of ['abort', 'release']) {
    const events = new EventEmitter(), frames = new Set<string>(), pending: string[] = [];
    const load = Object.assign(new EventEmitter(), { image: (key: string) => pending.push(key), spritesheet() {}, start() {} });
    let mapEntries = 0;
    const app = { world: { maps: [{ id: 'map', file: 'map.json' }], props: [], actors: {} }, wardrobe: { textures: [] },
      session: { enterMap() { mapEntries++; }, evaluateCondition: () => true,
        storyWorld: { visit: 0, currentLocation: { map: 'map' }, visible: () => true,
          actorAppearance: (actor: string) => actor, projectEntities: (_map: string, base: unknown[]) => base } },
      campaign: { start: { actor: 'hero' }, placements: [] },
      content: { map: async () => ({ id: 'map', ground: 'ground.png', canopy: 'canopy.png', features: [], entities: [] } as unknown as WorldMap) }
    } as unknown as StoryContext;
    const scene = new StoryStageScene(app);
    Object.assign(scene, { events, load, sys: { isActive: () => true },
      textures: { exists: (key: string) => frames.has(key), get: () => ({ has: () => true }), remove: (key: string) => frames.delete(key) },
      anims: { exists: () => false } });
    const abort = new AbortController();
    const running = scene.showStage(stageSnapshot({ type: 'stage', map: 'map', x: 1, y: 2, facing: 'south', playerVisible: true, cast: [] }), abort.signal, appearance);
    await new Promise(resolve => setImmediate(resolve));
    if (cancellation === 'abort') abort.abort(new DOMException('cancelled', 'AbortError'));
    else scene.releaseStage();
    const rejected = assert.rejects(running, { name: 'AbortError' });
    // An abort returns before a pending loader settles; superseding a stage also rejects when its old loader finally returns.
    if (cancellation === 'abort') await rejected;
    for (const key of pending) frames.add(key);
    load.emit('complete'); await rejected; await new Promise(resolve => setImmediate(resolve));
    assert.equal(frames.size, 0); assert.equal(mapEntries, 0); assert.equal(scene.map, undefined);
  }
});

test('retainPlayerPosition continues from the formal world player when the stage has not shown that map yet', async () => {
  const run = harness(), signal = new AbortController().signal;
  await run.presenter.begin(signal);
  // 本段演出的第一镜：舞台场景还没放过任何一张图（map 为空），位置只能从正式世界取。
  (run.stage as unknown as { map?: unknown }).map = undefined;
  run.stage.player!.container.x = 50; run.stage.player!.container.y = 60;
  run.world.player!.container.x = 12; run.world.player!.container.y = 34;
  await run.presenter.execute({ type: 'stage', map: 'home', x: 999, y: 999, facing: 'north', playerVisible: true, cast: [], retainPlayerPosition: true },
    { signal, skipSignal: signal });
  const stage = run.presenter.captureStage()!;
  assert.deepEqual({ x: stage.x, y: stage.y, facing: stage.facing }, { x: 12, y: 34, facing: 'south' });
  // 没有 retainPlayerPosition 时仍用脚本坐标：台上演员各就各位，主角回到脚本写的位置。
  await run.presenter.execute({ type: 'stage', map: 'home', x: 999, y: 999, facing: 'north', playerVisible: true, cast: [] },
    { signal, skipSignal: signal });
  assert.deepEqual({ x: run.presenter.captureStage()!.x, y: run.presenter.captureStage()!.y }, { x: 999, y: 999 });
});

test('an invisible actor walks straight to its destination instead of stalling the performance', async () => {
  const run = harness(), signal = new AbortController().signal;
  await run.presenter.begin(signal);
  await run.presenter.execute({ type: 'stage', map: 'home', x: 10, y: 20, facing: 'south', playerVisible: true,
    cast: [{ id: 'hidden-guard', actor: 'guard', x: 60, y: 70, facing: 'west', visible: false }] }, { signal, skipSignal: signal });
  // 停用的角色不会被移动世界推进：`MovementBody.update` 在 `!actor.enabled()` 时提前返回，而
  // `WalkRoute` 的状态只在 `next()` 里推进。这条走位必须立刻收尾，否则演出会永远等下去。
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      run.presenter.execute({ type: 'walk', target: 'hidden-guard', x: 100, y: 120, speedPxPerSecond: 100 }, { signal, skipSignal: signal }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('停用角色的走位把演出挂住了')), 300); }),
    ]);
  } finally { clearTimeout(timer); }
  const member = run.presenter.captureStage()!.cast.find(cast => cast.id === 'hidden-guard')!;
  assert.deepEqual([member.x, member.y, member.visible], [100, 120, false], '落点照写，人物仍然不显示');
});

test('an off-stage actor is not pointed at: camera and pose do nothing when the position is unknown', async () => {
  const run = harness(), signal = new AbortController().signal;
  await run.presenter.begin(signal);
  await run.presenter.execute({ type: 'stage', map: 'home', x: 10, y: 20, facing: 'south', playerVisible: true,
    cast: [{ id: 'absent', actor: 'guard', x: 2048, y: 2048, facing: 'west', visible: false, unpositioned: true, inheritPosition: true }] },
    { signal, skipSignal: signal });
  const camera = run.stage.cameras.main as unknown as { scrollX: number; scrollY: number };
  const before = { x: camera.scrollX, y: camera.scrollY };
  // 原版对找不到的角色什么都不做；照做会把镜头摇到场外坐标 (2048,2048)，姿态则对着看不见的人做动作。
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      run.presenter.execute({ type: 'camera', target: 'absent', motion: 'cut' }, { signal, skipSignal: signal }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('镜头动作没有结束')), 300); }),
    ]);
    await run.presenter.execute({ type: 'pose', target: 'absent', pose: 'idle', durationMs: 0 }, { signal, skipSignal: signal });
  } finally { clearTimeout(timer); }
  assert.deepEqual([camera.scrollX, camera.scrollY], [before.x, before.y], '镜头停在原处，没有摇到场外');
});

test('a current-map performance never loads its preview map or restarts the formal world',async()=>{
  const run=harness(),signal=new AbortController().signal;
  await run.presenter.begin(signal);
  await run.presenter.execute({type:'stage',map:'preview',mapFromWorld:true,x:70,y:90,facing:'east',playerVisible:true,cast:[]},
    {signal,skipSignal:signal});
  assert.equal(run.stage.map!.id,'home');
  assert.deepEqual([run.stage.player!.container.x,run.stage.player!.container.y],[70,90]);
  assert.equal(run.world.map!.id,'home');
  assert.equal(run.presenter.getStageState()!.mapFromWorld,undefined);
});

test('an emote is not drawn for a character that is not on screen', async () => {
  const run = harness(), signal = new AbortController().signal;
  await run.presenter.begin(signal);
  await run.presenter.execute({ type: 'stage', map: 'home', x: 10, y: 20, facing: 'south', playerVisible: true,
    cast: [{ id: 'hidden', actor: 'guard', x: 80, y: 90, facing: 'south', visible: false }] },
    { signal, skipSignal: signal });
  // 隐藏角色身上的表情不再单独绘制；素材缺失也不会因此报错。
  await assert.doesNotReject(run.presenter.execute({ type: 'effect', target: 'hidden', effect: 'story-startle' },
    { signal, skipSignal: signal }));
  await run.presenter.finish(true, signal);
});

test('failed construction destroys every newly created character before exposing a partial scene',async()=>{
  const {drawStoryCharacters}=await import('../src/rendering/story-map-view.ts');
  const containers:{scene?:object;destroy():void}[]=[];
  const scene={add:{container(){const container={scene:{} as object|undefined,setDepth(){return this;},setVisible(){return this;},setAlpha(){return this;},destroy(){this.scene=undefined;}};
    containers.push(container);return container;}}};
  const actors=[{id:'first',actor:'good',x:1,y:2,facing:'south' as const,visible:true},
    {id:'second',actor:'bad',x:3,y:4,facing:'south' as const,visible:true}];
  const appearances=new Map([['first',{id:'good',clips:{}} as ActorDefinition],
    ['second',{id:'bad',clips:{'idle-east':{}}} as ActorDefinition]]);
  assert.throws(()=>drawStoryCharacters(scene as never,actors,appearances),/角色动作缺少资源/);
  assert.equal(containers.length,2);assert.ok(containers.every(container=>!container.scene));
});

test('committed scene changes are acknowledged once and restoring a stable snapshot clears failed changes',async()=>{
  const run=harness(),signal=new AbortController().signal;
  await run.presenter.begin(signal);
  await run.presenter.execute({type:'stage',map:'hall',x:30,y:40,facing:'east',playerVisible:true,
    cast:[{id:'guard',worldEntityId:'persistent-guard',actor:'guard',x:60,y:70,facing:'west',visible:true}]},{signal,skipSignal:signal});
  assert.equal(run.presenter.getWorldChanges().length,1);
  run.presenter.committed();assert.deepEqual(run.presenter.getWorldChanges(),[]);
  const stable=run.presenter.captureStage()!;
  await run.presenter.execute({type:'face',target:'guard',facing:'north'},{signal,skipSignal:signal});
  assert.equal(run.presenter.getWorldChanges()[0].facing,'north');
  await run.presenter.restoreStage(stable,signal);
  assert.deepEqual(run.presenter.getWorldChanges(),[]);
  assert.equal(run.presenter.captureStage()!.cast[0].facing,'west');
});

test('on-demand object assets retain the original and override textures and discard late cancelled loads',async()=>{
  for(const cancellation of ['abort','release']){
    const events=new EventEmitter(),frames=new Set<string>(),pending:string[]=[];
    const load=Object.assign(new EventEmitter(),{image:(key:string)=>pending.push(key),spritesheet:(key:string)=>pending.push(key),start(){}});
    const definition=(id:string)=>({id,clips:{'idle-south':{frameWidth:8,frameHeight:8,frames:1,originX:0,originY:0,frameRate:10,mirrorX:false,
      layers:[{key:id,file:id+'.png',blend:'normal'}]}}} as ActorDefinition);
    const app={world:{actors:{gate:definition('gate'),glow:definition('glow')}},session:{storyWorld:{actorAppearance:()=> 'glow'}}} as unknown as StoryContext;
    const scene=new StoryStageScene(app);
    Object.assign(scene,{events,load,sys:{isActive:()=>true},
      textures:{exists:(key:string)=>frames.has(key),get:()=>({has:()=>true}),remove:(key:string)=>frames.delete(key)},
      anims:{exists:()=>false}});
    const abort=new AbortController(),running=scene.prepareActorAssets('gate',abort.signal);
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(pending.sort(),['gate','glow']);
    if(cancellation==='abort')abort.abort();else scene.releaseStage();
    const rejected=assert.rejects(running,{name:'AbortError'});
    if(cancellation==='abort')await rejected;
    for(const key of pending)frames.add(key);
    load.emit('complete');await rejected;await new Promise(resolve=>setImmediate(resolve));
    assert.equal(frames.size,0);
  }
});

test('scene reconstruction restores held animation frames on every character layer',async()=>{
  const {drawStoryCharacters}=await import('../src/rendering/story-map-view.ts');
  const clip={frameWidth:8,frameHeight:8,frames:4,originX:0,originY:0,frameRate:10,mirrorX:false,
    layers:[{key:'body',file:'body.png',blend:'normal'},{key:'weapon',file:'weapon.png',blend:'normal'}]};
  const appearance={id:'hero',clips:{'idle-south':clip,'die-south':clip}} as ActorDefinition;
  const scene={anims:{exists:()=>true},add:{
    container(x:number,y:number){return {x,y,scene:{},setDepth(){return this;},setVisible(){return this;},setAlpha(){return this;},addAt(){},destroy(){}};},
    sprite(){return {anims:{progress:0,isPlaying:false,timeScale:1,accumulator:0,setProgress(value:number){this.progress=value;},stop(){this.isPlaying=false;}},
      setOrigin(){return this;},setBlendMode(){return this;},setScale(){return this;},play(){this.anims.isPlaying=true;},destroy(){}};}
  }};
  const characters=drawStoryCharacters(scene as never,[{id:'player',actor:'hero',x:10,y:20,facing:'south',visible:true,
    clip:'die-south',animationProgress:1,animationPlaying:false}],new Map([['player',appearance]]));
  const visual=characters.get('player')!;
  assert.equal(visual.clipName,'die-south');assert.equal(visual.layers.length,2);
  for(const layer of visual.layers){assert.equal((layer.anims as unknown as {progress:number}).progress,1);assert.equal(layer.anims.isPlaying,false);}
});

test('normal and skipped poses settle on identical held or idle animation frames',async()=>{
  const {drawStoryCharacters}=await import('../src/rendering/story-map-view.ts');
  const run=async(skip:boolean,hold:boolean)=>{
    const clip={frameWidth:8,frameHeight:8,frames:4,originX:0,originY:0,frameRate:10,mirrorX:false,
      layers:[{key:'body',file:'body.png',blend:'normal'}]};
    const appearance={id:'guard',clips:{'idle-south':clip,'fall-down-south':clip}} as ActorDefinition;
    const scene={anims:{exists:()=>true},add:{
      container(x:number,y:number){return {x,y,scene:{},setDepth(){return this;},setVisible(){return this;},setAlpha(){return this;},addAt(){},destroy(){}};},
      sprite(){return Object.assign(new EventEmitter(),{anims:{progress:0,isPlaying:false,timeScale:1,accumulator:0,setProgress(value:number){this.progress=value;},stop(){this.isPlaying=false;}},
        setOrigin(){return this;},setBlendMode(){return this;},setScale(){return this;},play(){this.anims.isPlaying=true;},destroy(){}});}
    }};
    const visual=drawStoryCharacters(scene as never,[{id:'entity:guard',actor:'guard',x:10,y:20,facing:'south',visible:true}],new Map([['entity:guard',appearance]])).get('entity:guard')!;
    const presenter=new StoryPresenter({} as never,()=>({} as never),()=>scene as never);
    Object.assign(presenter,{delay:async()=>{},state:{bindings:[['guard','entity:guard']]},actors:new Map([['entity:guard',{visual,facing:'south'}]])});
    const signal=new AbortController().signal,skipping=new AbortController();if(skip)skipping.abort();
    await presenter.execute({type:'pose',target:'guard',pose:'fall-down',durationMs:100,hold},{signal,skipSignal:skipping.signal});
    return {clip:visual.clipName,frames:visual.layers.map(layer=>({progress:(layer.anims as unknown as {progress:number}).progress,playing:layer.anims.isPlaying}))};
  };
  for(const hold of [false,true]){
    const normal=await run(false,hold),skipped=await run(true,hold);
    assert.deepEqual(normal,skipped);
    assert.deepEqual(normal,{clip:hold?'fall-down-south':'idle-south',frames:[{progress:hold?1:0,playing:!hold}]});
  }
});

test('restoring a scene on map B retains prepared map A objects and positions for the return trip',async()=>{
  const signal=new AbortController().signal,run=harness();
  const sceneCache=(run.presenter as unknown as {scenes:Map<string,import('../src/domain/scene-snapshot.ts').SceneSnapshot>}).scenes;
  sceneCache.get('hall')!.actors.push({id:'entity:portal',worldEntityId:'portal',actor:'guard',x:140,y:180,facing:'south',visible:true});
  await run.presenter.begin(signal);
  const declaration:StoryStage={type:'stage',map:'hall',x:30,y:40,facing:'east',playerVisible:true,
    cast:[{id:'guard',worldEntityId:'persistent-guard',actor:'guard',x:60,y:70,facing:'west',visible:true}]};
  await run.presenter.execute(declaration,{signal,skipSignal:signal});
  await run.presenter.execute({type:'appear',target:'guard',x:72,y:80,facing:'north',mode:'reuse'},{signal,skipSignal:signal});
  const sceneA=run.presenter.captureStage()!.scene;
  await run.presenter.execute({type:'stage',map:'remote',x:10,y:20,facing:'south',playerVisible:true,cast:[]},{signal,skipSignal:signal});
  const saved=JSON.parse(JSON.stringify(run.presenter.captureStage()!)) as StoryStageSnapshot;
  assert.ok(saved.scenes?.some(scene=>scene.map==='hall'));
  const restored=harness();
  await restored.presenter.begin(signal,saved);
  await restored.presenter.execute({...declaration,cast:declaration.cast.map(member=>({...member,binding:'world'}))},{signal,skipSignal:signal});
  const returned=restored.presenter.captureStage()!.scene;
  const objects=(scene:typeof returned)=>scene.actors.filter(actor=>actor.id!=='player').map(actor=>[actor.id,actor.worldEntityId,actor.x,actor.y,actor.visible]);
  assert.deepEqual(objects(returned),objects(sceneA));
});

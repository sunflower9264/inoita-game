import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import type Phaser from 'phaser';

const hook = registerHooks({resolve(specifier, context, next) {
  return specifier === 'phaser'
    ? {url:'data:text/javascript,export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}}}',shortCircuit:true}
    : next(specifier, context);
}});
const { WorldScene } = await import('../src/scenes/world-scene.ts');
const { QuestMarker, QUEST_MARKER_DEPTH } = await import('../src/rendering/quest-marker.ts');
hook.deregister();
const invoke = (host: object, name: string, ...args: unknown[]) => Reflect.get(WorldScene.prototype, name).call(host, ...args);

/** 头顶标记只暴露换图和销毁两件事；位置、缩放和显隐由人物容器带过去。 */
interface Marker {
  setFile(file: string | undefined): void;
  retryTexture(): void;
  position(x: number, y: number): void;
  setAlpha(alpha: number): void;
  setVisible(visible: boolean): void;
  destroy(): void;
}

function markerScene(textures: Record<string, boolean> = {}) {
  const image = {
    x: 0, y: 0, depth: 0, visible: false, alpha: 1, destroyed: false, texture: { key: '' },
    setName() { return image; },
    setDepth(value: number) { image.depth = value; return image; },
    setVisible(value: boolean) { image.visible = value; return image; },
    setPosition(x: number, y: number) { image.x = x; image.y = y; return image; },
    setAlpha(value: number) { image.alpha = value; return image; },
    setTexture(key: string) { image.texture = { key }; return image; },
    destroy() { image.destroyed = true; },
  };
  const scene = {
    add: { image: () => image },
    textures: { exists: (file: string) => !!textures[file] },
  };
  return { image, scene: scene as unknown as Phaser.Scene };
}

test('a quest marker is created when a quest becomes available after the map is already loaded', () => {
  type Status = 'available' | 'active' | 'ready' | null;
  let status: Status = null, marked = false, version = 0;
  let markerFile: string | undefined;
  const created: unknown[] = [], taskLists: unknown[][] = [];
  const container = {
    visible: true, x: 120, y: 80, children: [] as unknown[],
    setVisible(value: boolean) { container.visible = value; },
    add(child: unknown) { container.children.push(child); },
  };
  const character = {
    entity: { id: 'npc-1', actor: 'elder', characterId: 'npc-1' },
    actor: { id: 'elder' }, container, marker: undefined as Marker | undefined,
  };
  const session = {
    questBook: { version }, storyWorld: { revision: 0, actorVisible: () => true },
    chests: { revision: 0 }, legendaryWeapons: { revision: 0 },
    runtimeState: { sequence: 0 }, restorationVersion: 0,
    marker: () => status, markerActor: () => marked, visible: () => true,
  };
  const host = Object.assign(Object.create(WorldScene.prototype), {
    app: { session, storyInterface: { assets: {
      'minimap-available': 'available.png', 'minimap-active': 'active.png', 'minimap-ready': 'ready.png' } } },
    characters: [character],
    map: { id: 'map' },
    player: { container: { x: 0, y: 0 } },
    minimap: { updatePlayer() {}, updateTasks(tasks: unknown[]) { taskLists.push(tasks); },
    updateInteractions() {} },
    refreshLoadout() {}, noticeQuestChanges() {},
    chestOpened: () => false, legendarySwordConsumed: () => false,
    movement: { setEnabled() {} },
    createQuestMarker(target: typeof character) {
      created.push(target);
      target.marker = { setFile(file) { markerFile = file; }, retryTexture() {}, position() {}, setAlpha() {}, setVisible() {}, destroy() {} };
    },
  });

  invoke(host, 'refreshState');
  assert.equal(created.length, 0, '任务尚不可接取，不创建头顶标记');

  // 前置任务完成：当前地图和角色没有重建，只是任务状态变为可接取。
  status = 'available'; marked = true; version += 1; session.questBook.version = version;
  invoke(host, 'refreshState');
  assert.equal(created.length, 1, '任务变为可接取后补建头顶标记');
  assert.equal(markerFile, 'available.png', '头顶标记用原版可接取图标');
  assert.deepEqual(taskLists.at(-1), [{ id: 'npc-1', x: 120, y: 80, status: 'available' }]);

  // 同一状态没有变化时不再刷新；状态再变也复用已有标记，不重复创建。
  invoke(host, 'refreshState');
  assert.equal(created.length, 1);
  version += 1; session.questBook.version = version;
  invoke(host, 'refreshState');
  assert.equal(created.length, 1);
});

test('the minimap receives quest characters on the first refresh after it is created', () => {
  const taskLists: unknown[][] = [];
  const container = {
    visible: true, x: 64, y: 96, children: [] as unknown[],
    setVisible(value: boolean) { container.visible = value; },
  };
  const marker: Marker = { setFile() {}, retryTexture() {}, position() {}, setAlpha() {}, setVisible() {}, destroy() {} };
  const character = {
    entity: { id: 'npc-1', actor: 'elder', characterId: 'npc-1' },
    actor: { id: 'elder' }, container, marker,
  };
  const session = {
    questBook: { version: 1 }, storyWorld: { revision: 0, actorVisible: () => true },
    chests: { revision: 0 }, legendaryWeapons: { revision: 0 },
    runtimeState: { sequence: 0 }, restorationVersion: 0,
    marker: () => 'available', markerActor: () => true, visible: () => true,
  };
  const host = Object.assign(Object.create(WorldScene.prototype), {
    app: { session, storyInterface: { assets: {
      'minimap-available': 'available.png', 'minimap-active': 'active.png', 'minimap-ready': 'ready.png' } } },
    characters: [character], map: { id: 'map' },
    player: { container: { x: 0, y: 0 } },
    refreshLoadout() {}, noticeQuestChanges() {},
    chestOpened: () => false, legendarySwordConsumed: () => false,
    movement: { setEnabled() {} },
  });
  // 进图流程里，第一次刷新发生在小地图创建之前；此时标记列表无人接收。
  invoke(host, 'refreshState');
  // 小地图就绪后，即使会话状态没变，也要完整刷新一次并把任务人物交过去。
  host.minimap = {
    updatePlayer() {},
    updateTasks(tasks: unknown[]) { taskLists.push(tasks); },
    updateInteractions() {},
  };
  invoke(host, 'refreshState');
  assert.deepEqual(taskLists, [[{ id: 'npc-1', x: 64, y: 96, status: 'available' }]]);
});

test('journal-external ready deliveries still light the overhead marker and the minimap', () => {
  type Status = 'available' | 'ready';
  let status: Status = 'available', marked = true, version = 1;
  let markerFile: string | undefined = 'available.png';
  const created: unknown[] = [], taskLists: unknown[][] = [];
  const container = {
    visible: true, x: 32, y: 48,
    setVisible(value: boolean) { container.visible = value; },
  };
  const character = {
    entity: { id: 'npc-journal-external', actor: 'well', characterId: 'npc-137' },
    actor: { id: 'well' }, container, marker: undefined as Marker | undefined,
  };
  const session = {
    questBook: { version }, storyWorld: { revision: 0, actorVisible: () => true },
    chests: { revision: 0 }, legendaryWeapons: { revision: 0 },
    runtimeState: { sequence: 0 }, restorationVersion: 0,
    marker: () => status, markerActor: () => marked, visible: () => true,
  };
  const host = Object.assign(Object.create(WorldScene.prototype), {
    app: { session, storyInterface: { assets: {
      'minimap-available': 'available.png', 'minimap-active': 'active.png', 'minimap-ready': 'ready.png' } } },
    characters: [character], map: { id: 'map' },
    player: { container: { x: 0, y: 0 } },
    minimap: { updatePlayer() {}, updateTasks(tasks: unknown[]) { taskLists.push(tasks); },
    updateInteractions() {} },
    refreshLoadout() {}, noticeQuestChanges() {},
    chestOpened: () => false, legendarySwordConsumed: () => false,
    movement: { setEnabled() {} },
    createQuestMarker(target: typeof character) {
      created.push(target);
      target.marker = { setFile(file) { markerFile = file; }, retryTexture() {}, position() {}, setAlpha() {}, setVisible() {}, destroy() {} };
    },
  });

  invoke(host, 'refreshState');
  assert.equal(created.length, 1);
  assert.equal(markerFile, 'available.png', '普通任务仍显示头顶标记');

  // 日志外任务只是不进任务日志；待交付时头顶和小地图仍要提示交付对象。
  status = 'ready'; marked = true; version += 1; session.questBook.version = version;
  invoke(host, 'refreshState');
  assert.equal(markerFile, 'ready.png', '日志外待交付仍显示头顶图标');
  assert.deepEqual(taskLists.at(-1), [{ id: 'npc-journal-external', x: 32, y: 48, status: 'ready' }], '小地图也显示日志外待交付');
});

test('quest markers live in their own high-depth layer and follow the character', () => {
  const f = markerScene({ 'available.png': true });
  const marker = new QuestMarker(f.scene);
  assert.equal(marker.depth, QUEST_MARKER_DEPTH);
  assert.ok(marker.depth > 10000, '图标必须画在树冠之上');
  marker.position(120, 80);
  assert.equal(f.image.x, 120);
  assert.equal(f.image.y, 30, '图标中心停在脚点上方 50 像素');
  marker.setVisible(true);
  marker.setFile('available.png');
  assert.equal(f.image.texture.key, 'available.png');
  assert.equal(f.image.visible, true);
  marker.setAlpha(.4);
  assert.equal(f.image.alpha, .4);
  marker.setVisible(false);
  assert.equal(f.image.visible, false);
});

test('a marker whose texture arrives later becomes visible without a quest state change', () => {
  const textures: Record<string, boolean> = {};
  const f = markerScene(textures);
  const marker = new QuestMarker(f.scene);
  marker.setVisible(true);
  marker.setFile('ready.png');
  assert.equal(f.image.visible, false, '纹理未到先隐藏');
  textures['ready.png'] = true;
  marker.retryTexture();
  assert.equal(f.image.texture.key, 'ready.png');
  assert.equal(f.image.visible, true);
});

test('creating a marker does not add it to the character container', () => {
  const f = markerScene({ 'available.png': true });
  const host = Object.assign(Object.create(WorldScene.prototype), {
    add: f.scene.add, textures: f.scene.textures,
    questMarkerCharacters: new Set(), stageOccluded: false,
  });
  const container = {
    x: 120, y: 80, visible: true, alpha: 1, children: [] as unknown[],
  };
  const character = { container, marker: undefined as Marker | undefined };
  invoke(host, 'createQuestMarker', character);
  assert.equal(container.children.length, 0, '图标不再挂进人物容器');
  assert.equal(f.image.depth, QUEST_MARKER_DEPTH);
  assert.equal(f.image.x, 120);
  assert.equal(f.image.y, 30);
  assert.ok(host.questMarkerCharacters.has(character));
  container.x = 140; container.alpha = .5;
  invoke(host, 'updateQuestMarkerPositions');
  assert.equal(f.image.x, 140);
  assert.equal(f.image.alpha, .5);
  host.stageOccluded = true;
  invoke(host, 'updateQuestMarkerPositions');
  assert.equal(f.image.visible, false, '舞台遮挡时隐藏');
  invoke(host, 'removeQuestMarker', character);
  assert.equal(host.questMarkerCharacters.has(character), false);
  assert.equal(f.image.destroyed, true);
});

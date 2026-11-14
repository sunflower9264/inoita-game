import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

const hook = registerHooks({resolve(specifier, context, next) {
  return specifier === 'phaser'
    ? {url:'data:text/javascript,export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}}}',shortCircuit:true}
    : next(specifier, context);
}});
const { WorldScene } = await import('../src/scenes/world-scene.ts');
hook.deregister();
const invoke = (host: object, name: string, ...args: unknown[]) => Reflect.get(WorldScene.prototype, name).call(host, ...args);

interface Point { id: string; x: number; y: number }
interface Marker {
  setFile(file: string | undefined): void;
  retryTexture(): void;
  position(x: number, y: number): void;
  setAlpha(alpha: number): void;
  setVisible(visible: boolean): void;
  destroy(): void;
}

test('minimap interaction markers follow the original NPC ring and skip opened or quest-marked characters', () => {
  const opened = new Set(['opened-chest']), pulled = new Set(['pulled-sword']), emptySprings = new Set(['empty-spring']);
  const hidden = new Set(['hidden-chest']);
  const interactionLists: Point[][] = [], taskLists: unknown[][] = [];
  const marker: Marker = {setFile() {}, retryTexture() {}, position() {}, setAlpha() {}, setVisible() {}, destroy() {}};
  const character = (id: string, actor: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    entity: {id, actor: id, characterId: id, ...extra},
    actor: {id, ...actor},
    container: {
      visible: true, x: 32, y: 48,
      setVisible(value: boolean) { this.visible = value; }
    },
    marker: id === 'quest-shop' ? marker : undefined,
  });
  const characters = [
    character('chest', {chest: 'ordinary'}),
    character('opened-chest', {chest: 'ordinary'}),
    character('hidden-chest', {chest: 'ordinary'}),
    character('spring', {}, {spring: true}),
    character('empty-spring', {}, {spring: true}),
    character('shop', {}),
    character('quest-shop', {}),
    character('inn', {service: 'innkeeper'}),
    character('fusion', {service: 'fusion-machine'}),
    character('sword', {service: 'legendary-sword'}),
    character('pulled-sword', {service: 'legendary-sword'}),
    character('story-npc', {description: '只讲剧情，不是交互点'}),
  ];
  const session = {
    questBook: {version: 0}, storyWorld: {revision: 0, actorVisible: (_map: string, actor: string) => !hidden.has(actor)},
    chests: {revision: 0}, legendaryWeapons: {revision: 0}, runtimeState: {sequence: 0}, restorationVersion: 0,
    marker: (actor: string) => actor === 'quest-shop' ? 'available' : null,
    markerActor: (actor: string) => actor === 'quest-shop',
    visible: () => true,
    springs: {isEmpty: (_map: string, id: string) => emptySprings.has(id)},
  };
  const host = Object.assign(Object.create(WorldScene.prototype), {
    app: {session, storyInterface: {assets: {}}, shops: {shops: {shop: {}, 'quest-shop': {}}}},
    characters, map: {id: 'map'}, player: {container: {x: 0, y: 0}}, chestFades: new Map(),
    minimap: {
      updatePlayer() {},
      updateTasks(tasks: unknown[]) { taskLists.push(tasks); },
      updateInteractions(list: Point[]) { interactionLists.push(list); },
    },
    refreshLoadout() {}, noticeQuestChanges() {}, syncQuestMarker() {},
    chestOpened: (target: typeof characters[number]) => opened.has(target.entity.id),
    legendarySwordConsumed: (target: typeof characters[number]) => pulled.has(target.entity.id),
    movement: {setEnabled() {}},
  });

  invoke(host, 'refreshState');
  assert.deepEqual(interactionLists.at(-1)!.map(point => point.id).sort(),
    ['chest', 'fusion', 'inn', 'shop', 'spring', 'sword'],
    '宝箱、泉水、商店、旅店、融合器和未拔出的古剑都画交互圆环');
  assert.deepEqual(taskLists.at(-1), [{id: 'quest-shop', x: 32, y: 48, status: 'available'}],
    '同一角色有任务图标时只画任务标记，不再叠交互圆环');

  opened.add('chest');
  invoke(host, 'refreshMinimapInteractions');
  assert.ok(!interactionLists.at(-1)!.some(point => point.id === 'chest'), '宝箱开启后圆环立即移除');

  emptySprings.add('spring');
  invoke(host, 'refreshMinimapInteractions');
  assert.ok(!interactionLists.at(-1)!.some(point => point.id === 'spring'), '泉水喝空后圆环立即移除');
});

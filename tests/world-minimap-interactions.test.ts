import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTestWorldScene, loadWorldSceneClass } from './support/world-scene-fixture.ts';

const WorldScene = await loadWorldSceneClass();

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
    questBook: {version: 0}, storyWorld: {revision: 0, actorVisible: (_map: string, actor: string) => !hidden.has(actor), isPlaced: () => false},
    chests: {revision: 0, isOpened: (_map: string, id: string) => opened.has(id)},
    legendaryWeapons: {revision: 0, isPulled: (_map: string, id: string) => pulled.has(id)},
    runtimeState: {sequence: 0}, restorationVersion: 0,
    marker: (actor: string) => actor === 'quest-shop' ? 'available' : null,
    markerActor: (actor: string) => actor === 'quest-shop',
    visible: () => true,
    springs: {isEmpty: (_map: string, id: string) => emptySprings.has(id)},
  };
  const scene = buildTestWorldScene(WorldScene, {
    app: {session, storyInterface: {assets: {}}, shops: {shops: {shop: {}, 'quest-shop': {}}}} as never,
    characters,
    map: {id: 'map'},
    player: {container: {x: 0, y: 0}},
    worldHud: {minimap: {
      updatePlayer() {},
      updateTasks(tasks: unknown[]) { taskLists.push(tasks); },
      updateInteractions(list: Point[]) { interactionLists.push(list); },
    }},
    movement: {setEnabled() {}},
    sceneOverrides: {
      refreshLoadout() {},
      noticeQuestChanges() {},
      syncQuestMarker() {},
    },
  });

  scene.refreshState();
  assert.deepEqual(interactionLists.at(-1)!.map(point => point.id).sort(),
    ['chest', 'fusion', 'inn', 'shop', 'spring', 'sword'],
    '宝箱、泉水、商店、旅店、融合器和未拔出的古剑都画交互圆环');
  assert.deepEqual(taskLists.at(-1), [{id: 'quest-shop', x: 32, y: 48, status: 'available'}],
    '同一角色有任务图标时只画任务标记，不再叠交互圆环');

  opened.add('chest');
  scene.refreshMinimapInteractions();
  assert.ok(!interactionLists.at(-1)!.some(point => point.id === 'chest'), '宝箱开启后圆环立即移除');

  emptySprings.add('spring');
  scene.refreshMinimapInteractions();
  assert.ok(!interactionLists.at(-1)!.some(point => point.id === 'spring'), '泉水喝空后圆环立即移除');
});

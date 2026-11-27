import assert from 'node:assert/strict';
import test from 'node:test';
import { nearInteractive, SHOP_COUNTER_GAP } from '../src/domain/chests.ts';
import type { CollisionBox } from '../src/domain/content.ts';
import { InteractionTargetIndex } from '../src/scenes/interaction-index.ts';
import { buildTestWorldScene, loadWorldSceneClass } from './support/world-scene-fixture.ts';

const WorldScene = await loadWorldSceneClass();

interface FakeContainer {
  x: number; y: number; visible: boolean;
  setAlpha(value: number): FakeContainer;
  setVisible(value: boolean): FakeContainer;
}
interface FakeCharacter {
  entity: { id: string; actor: string; flip?: boolean; spring?: boolean };
  actor: { id: string; description?: string; collision?: CollisionBox };
  container: FakeContainer;
  rank?: number;
}

function box(x: number, y: number, visible = true): FakeContainer {
  const value: FakeContainer = {
    x, y, visible,
    setAlpha() { return value; },
    setVisible(next) { value.visible = next; return value; },
  };
  return value;
}

function subject(id: string, x: number, y: number,
  options: { rank?: number; collision?: CollisionBox; visible?: boolean } = {}): FakeCharacter {
  return {
    entity: { id, actor: id },
    actor: { id, description: options.rank === undefined || options.rank <= 2 ? 'talk' : undefined, collision: options.collision },
    container: box(x, y, options.visible ?? true),
    rank: options.rank,
  };
}

function scene(characters: FakeCharacter[], playerX = 0, playerY = 0) {
  const byId = new Map(characters.map(character => [character.entity.id, character]));
  return buildTestWorldScene(WorldScene, {
    app: {
      session: {
        questBook: { version: 0 },
        storyWorld: { revision: 0, isPlaced: () => false },
        chests: { revision: 0, isOpened: () => false },
        legendaryWeapons: { revision: 0, isPulled: () => false },
        springs: { isEmpty: () => false },
        restorationVersion: 0,
        npcQuestSlot: () => undefined,
        canInteract: (_actor: string, id: string) => byId.get(id)?.rank === 0,
        status: () => 'locked' as const,
        markerActor: (actor: string) => byId.get(actor)?.rank === 1,
      },
    },
    map: { id: 'map' },
    player: { container: { x: playerX, y: playerY } },
    characters,
    movement: {
      placeAll(placements: { visual: FakeCharacter; position: { x: number; y: number } }[]) {
        for (const placement of placements) Object.assign(placement.visual.container, placement.position);
      },
    },
    sceneOverrides: {
      setClip() {},
      refreshMinimapInteractions() {},
    },
  }) as unknown as Omit<InstanceType<typeof WorldScene>, 'player' | 'characters'> & {
    player: { container: { x: number; y: number } };
    characters: FakeCharacter[];
  };
}

test('only the player cell is queried, so distant characters do not take part', () => {
  const near = subject('near', 10, 0), far = subject('far', 500, 0);
  let farReads = 0;
  Object.defineProperty(far, 'container', { get() { farReads++; return box(500, 0); } });
  const host = scene([near, far]);
  host.updateInteractionTarget();
  assert.equal(host.near, near, '近处目标仍然选中');
  farReads = 0;
  host.player.container.x = 8;
  host.updateInteractionTarget();
  assert.equal(host.near, near, '玩家在同一格内移动不影响结果');
  assert.equal(farReads, 0, '远处实体没有进入候选，也没有读取位置');
});

test('a target covering several cells appears once in the queried cell', () => {
  const index = new InteractionTargetIndex<FakeCharacter>();
  const huge = subject('huge', 0, 0, { collision: { x: -64, y: -64, width: 128, height: 128 } });
  index.rebuild([huge]);
  assert.deepEqual(index.near(0, 0), [huge], '同一目标在一个桶里只登记一次');
});

test('every position accepted by nearInteractive is present in the index candidates', () => {
  const cases: { target: FakeCharacter; x: number; y: number; reach?: number }[] = [
    { target: subject('plain', 0, 24), x: 0, y: 0 },
    { target: subject('shop', 0, 40, { collision: { x: -8, y: -8, width: 16, height: 16 } }),
      x: 0, y: 0, reach: SHOP_COUNTER_GAP },
    { target: subject('flipped', 12, 8, { collision: { x: -8, y: -8, width: 16, height: 16 } }), x: 0, y: 0 },
    { target: subject('large', -60, 0, { collision: { x: 0, y: -20, width: 80, height: 40 } }), x: 0, y: 0 },
  ];
  for (const entry of cases) {
    entry.target.entity.flip = entry.target.entity.id === 'flipped';
    const accepted = nearInteractive({ x: entry.x, y: entry.y }, entry.target.container,
      entry.target.actor.collision, !!entry.target.entity.flip, entry.reach);
    assert.equal(accepted, true, `${entry.target.entity.id} 应满足 nearInteractive`);
    const index = new InteractionTargetIndex<FakeCharacter>();
    index.rebuild([entry.target]);
    assert.ok(index.near(entry.x, entry.y).includes(entry.target), `${entry.target.entity.id} 应进入索引候选`);
  }
});

test('a large collision box is indexed from the positions it can reach', () => {
  const counter = subject('counter', 0, -80, { collision: { x: 0, y: 0, width: 16, height: 160 } });
  const host = scene([counter]);
  host.updateInteractionTarget();
  assert.equal(host.near, counter, '碰撞盒覆盖玩家脚底时，脚点再远也能交互');
});

test('same distance still ranks task targets first and keeps original list order on ties', () => {
  const plain = subject('plain', 0, 20, { rank: 2 });
  const task = subject('task', 0, 20, { rank: 1 });
  const ranked = scene([plain, task]);
  ranked.updateInteractionTarget();
  assert.equal(ranked.near, task, '同距离时任务目标优先');

  const first = subject('first', 0, 20, { rank: 2 });
  const second = subject('second', 0, 20, { rank: 2 });
  const tied = scene([first, second]);
  tied.updateInteractionTarget();
  assert.equal(tied.near, first, '档位和距离都相同时保留原列表顺序');
});

test('moving a character through scene restore rebuilds the index', () => {
  const npc = subject('npc', 10, 0);
  const host = scene([npc]);
  host.updateInteractionTarget();
  assert.equal(host.near, npc);
  host.restoreScenePositions({
    map: 'map', actors: [{ id: 'npc', actor: 'npc', worldEntityId: 'npc', x: 500, y: 0, facing: 'south', visible: true }],
  });
  host.updateInteractionTarget();
  assert.equal(host.near, null, '角色移走后索引跟随新位置');
  host.restoreScenePositions({
    map: 'map', actors: [{ id: 'npc', actor: 'npc', worldEntityId: 'npc', x: 10, y: 0, facing: 'south', visible: true }],
  });
  host.updateInteractionTarget();
  assert.equal(host.near, npc, '角色移回来后重新选中');
});

test('a direct position change is caught when either revision advances', () => {
  const first = subject('first', 500, 0);
  const interaction = scene([first]);
  interaction.updateInteractionTarget();
  first.container.x = 10;
  interaction.interactionRevision++;
  interaction.updateInteractionTarget();
  assert.equal(interaction.near, first, 'interactionRevision 变化时重建索引');

  const second = subject('second', 500, 0);
  const characters = scene([second]);
  characters.updateInteractionTarget();
  second.container.x = 10;
  characters.charactersRevision++;
  characters.player.container.x = 1;
  characters.updateInteractionTarget();
  assert.equal(characters.near, second, 'charactersRevision 变化时重建索引');
});

test('replacing the map character list rebuilds the index for the new map', () => {
  const previous = subject('previous', 10, 0);
  const host = scene([previous]);
  host.updateInteractionTarget();
  assert.equal(host.near, previous);
  const current = subject('current', 10, 0);
  host.characters = [current];
  host.charactersRevision++;
  host.interactionRevision++;
  host.updateInteractionTarget();
  assert.equal(host.near, current, '旧地图的角色不留在候选里');
});

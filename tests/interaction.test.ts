import assert from 'node:assert/strict';
import test from 'node:test';
import {
  interactionCandidateRank,
  pickNearestInteractionTarget,
  resolveInteraction,
  withinInteractionRange,
  type InteractionSessionReader,
  type InteractionTarget,
} from '../src/domain/interaction.ts';

const base: InteractionTarget = {
  chest: false, spring: false,
  objective: false, questSlot: false, shop: false,
};

test('chests and springs win over services and story', () => {
  assert.deepEqual(resolveInteraction({ ...base, chest: true }), { kind: 'chest' });
  assert.deepEqual(resolveInteraction({ ...base, chest: true, spring: true }), { kind: 'chest' },
    '宝箱判定在泉水之前');
  assert.deepEqual(resolveInteraction({ ...base, spring: true, service: 'innkeeper' }), { kind: 'spring' },
    '泉水判定在 NPC 服务之前');
});

test('each service maps to its own action when no quest slot is taken', () => {
  assert.deepEqual(resolveInteraction({ ...base, service: 'fusion-machine' }), { kind: 'crafting' });
  assert.deepEqual(resolveInteraction({ ...base, service: 'soul-healer' }), { kind: 'soul-healer' });
  assert.deepEqual(resolveInteraction({ ...base, service: 'legendary-sword' }), { kind: 'legendary-sword' });
  assert.deepEqual(resolveInteraction({ ...base, service: 'innkeeper' }), { kind: 'innkeeper' });
});

test('a service NPC holding a quest slot plays the story instead of its panel', () => {
  for (const service of ['fusion-machine', 'soul-healer', 'legendary-sword', 'innkeeper'] as const) {
    assert.deepEqual(resolveInteraction({ ...base, service, questSlot: true }), { kind: 'story' },
      `${service} 的任务槽优先于功能面板`);
  }
});

test('shops open only without a quest objective or quest slot, otherwise story wins', () => {
  assert.deepEqual(resolveInteraction({ ...base, shop: true }), { kind: 'shop' });
  assert.deepEqual(resolveInteraction({ ...base, shop: true, objective: true }), { kind: 'story' },
    '带任务目标的实体走剧情');
  assert.deepEqual(resolveInteraction({ ...base, shop: true, questSlot: true }), { kind: 'story' },
    '占用任务槽时走剧情');
  assert.deepEqual(resolveInteraction({ ...base, service: 'innkeeper', shop: true }), { kind: 'innkeeper' },
    'NPC 服务先于商店判定');
});

test('everything else falls back to ordinary story interaction', () => {
  assert.deepEqual(resolveInteraction(base), { kind: 'story' });
  assert.deepEqual(resolveInteraction({ ...base, objective: true }), { kind: 'story' });
  assert.deepEqual(resolveInteraction({ ...base, questSlot: true }), { kind: 'story' });
});

test('withinInteractionRange enforces 24px chest/sword, 32px shop/innkeeper counter, and 8px body-adjacent reach', () => {
  const col = { x: -8, y: -16, width: 16, height: 16 };
  // 宝箱与传说古剑只认曼哈顿 24px，不走碰撞盒外扩
  assert.equal(withinInteractionRange({ x: 0, y: 0 }, { x: 0, y: 24 }, { chest: 'ordinary', collision: col }), true);
  assert.equal(withinInteractionRange({ x: 0, y: 0 }, { x: 0, y: 25 }, { chest: 'ordinary', collision: col }), false);
  assert.equal(withinInteractionRange({ x: 0, y: 0 }, { x: 0, y: 25 }, { service: 'legendary-sword', collision: col }), false);
  // 普通 NPC 贴身一格（碰撞盒间隙 8px），隔柜台 32px 够不着
  assert.equal(withinInteractionRange({ x: 0, y: 24 }, { x: 0, y: 0 }, { collision: col }, false, false), true);
  assert.equal(withinInteractionRange({ x: 0, y: 40 }, { x: 0, y: 0 }, { collision: col }, false, false), false);
  // 商店与旅店老板可隔柜台（碰撞盒间隙 32px），但超过 32px 仍不可达
  assert.equal(withinInteractionRange({ x: 0, y: 40 }, { x: 0, y: 0 }, { collision: col }, false, true), true);
  assert.equal(withinInteractionRange({ x: 0, y: 40 }, { x: 0, y: 0 }, { service: 'innkeeper', collision: col }, false, false), true);
  assert.equal(withinInteractionRange({ x: 0, y: 56 }, { x: 0, y: 0 }, { collision: col }, false, true), false);
});

test('pickNearestInteractionTarget prioritizes Manhattan distance first, then candidate rank 0 < 1 < 2, and skips null rank', () => {
  const fakeSession: InteractionSessionReader = {
    npcQuestSlot: (_actor, charId) => (charId === 'ready-npc' ? ({ id: 'q-ready' } as ReturnType<InteractionSessionReader['npcQuestSlot']>) : undefined),
    canInteract: (_actor, id) => id === 'goal-ent',
    status: id => (id === 'q-ready' ? 'ready' : 'active'),
    markerActor: (_actor, charId) => charId === 'marker-npc',
  };
  const col = { x: -8, y: -16, width: 16, height: 16 };
  const plainProp = { entity: { id: 'prop', actor: 'rock' }, actor: { description: '', collision: col }, container: { x: 50, y: 50, visible: true } };
  const rank2Npc = { entity: { id: 'villager', actor: 'villager' }, actor: { description: '你好', collision: col }, container: { x: 50, y: 50, visible: true } };
  const rank1Npc = { entity: { id: 'giver', actor: 'giver', characterId: 'marker-npc' }, actor: { description: '', collision: col }, container: { x: 50, y: 50, visible: true } };
  const rank0Obj = { entity: { id: 'goal-ent', actor: 'switch' }, actor: { description: '', collision: col }, container: { x: 50, y: 50, visible: true } };

  assert.equal(interactionCandidateRank(plainProp.entity, plainProp.actor, fakeSession, false), null);
  // 同坐标重叠：0 档（任务目标）胜过排在前面的无资格摆设、2 档村民与 1 档标记人物
  const pickedSameSpot = pickNearestInteractionTarget({ x: 50, y: 66 }, [plainProp, rank2Npc, rank1Npc, rank0Obj], fakeSession);
  assert.equal(pickedSameSpot?.entity.id, 'goal-ent');

  // 距离更近的 2 档对象优先于稍远的 0 档对象（曼哈顿距离优先，只有同距离才比档位）
  const closerVillager = { ...rank2Npc, container: { x: 50, y: 58, visible: true } };
  const pickedByDist = pickNearestInteractionTarget({ x: 50, y: 66 }, [rank0Obj, closerVillager], fakeSession);
  assert.equal(pickedByDist?.entity.id, 'villager');
});

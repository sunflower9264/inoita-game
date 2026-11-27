import assert from 'node:assert/strict';
import test from 'node:test';
import type { BattleCatalog } from '../src/domain/battle.ts';
import { BattleCharacter } from '../src/domain/character-stats.ts';
import type { ActorDefinition, AnimationClip, WorldMap } from '../src/domain/content.ts';
import { Session } from '../src/domain/session.ts';
import {
  SummonLifecycle, advanceSummonLifetime, releasesSummonVitals, summonDurationMs,
  summonLifetimeExpired, summonedChildren,
} from '../src/domain/summon-lifecycle.ts';
import {
  loadBattleCatalog,
  loadCampaignCatalog,
  loadCharacterStatsCatalog,
  loadCompanionCatalog,
  loadItemCatalog,
} from './support/combat-test-harness.ts';
import { createFakePhaserScene, createTestWorldCombat } from './support/world-combat-fixture.ts';

test('summon groups follow ownership, replacement and removal', () => {
  const life = new SummonLifecycle();
  assert.deepEqual(life.beginSummon('player'), [], '首次召唤没有旧单位');
  life.register('player', 'soldier-a');
  life.register('player', 'soldier-b');
  life.register('ally', 'soldier-c');
  assert.deepEqual(life.capture(), [['player', ['soldier-a', 'soldier-b']], ['ally', ['soldier-c']]]);

  assert.deepEqual(life.beginSummon('player'), ['soldier-a', 'soldier-b'], '同主人召唤顶替全部旧单位');
  assert.deepEqual(life.capture(), [['player', []], ['ally', ['soldier-c']]], '顶替后保留空的归属分组');

  life.remove('soldier-c');
  assert.deepEqual(life.capture(), [['player', []], ['ally', []]], '移除的单位从所有分组消失');

  life.register('player', 'soldier-d');
  assert.deepEqual(life.removeOwner('player'), ['soldier-d'], '主人离队/阵亡返回名下召唤');
  assert.deepEqual(life.capture(), [['ally', []]]);
  life.clear();
  assert.deepEqual(life.capture(), []);
});

test('summon groups round-trip through checkpoint state', () => {
  const life = new SummonLifecycle();
  life.register('player', 'old');
  life.restore([['player', ['restored']], ['ally', []]]);
  assert.deepEqual(life.capture(), [['player', ['restored']], ['ally', []]], '恢复替换旧分组而不是叠加');
});

test('summon lifetime uses rank duration or owner-derived logic frames', () => {
  assert.equal(summonDurationMs(1500), 1500);
  assert.equal(summonDurationMs(1500, 10), (10 + 1) * 60, '帧数换算保留最后一帧');
  assert.equal(advanceSummonLifetime(120), 60);
  assert.equal(advanceSummonLifetime(30, 120), -90);
  assert.equal(summonLifetimeExpired(undefined), false, '没有寿命的召唤不会自然消失');
  assert.equal(summonLifetimeExpired(60), false);
  assert.equal(summonLifetimeExpired(0), true);
  assert.equal(summonLifetimeExpired(-60), true);
});

test('only summons release their session vitals, and checkpoint restore keeps them', () => {
  assert.equal(releasesSummonVitals('player', false), true);
  assert.equal(releasesSummonVitals('player', true), false, '检查点重建同一批召唤物时保留状态');
  assert.equal(releasesSummonVitals(undefined, false), false, '普通敌人不清理召唤状态');
});

test('removing a summon also lists the summons it owns', () => {
  const arena = [
    { key: 'owner', summonedBy: 'player' },
    { key: 'child-a', summonedBy: 'owner' },
    { key: 'child-b', summonedBy: 'owner' },
    { key: 'other', summonedBy: 'player' },
  ];
  assert.deepEqual(summonedChildren(arena, 'owner'), ['child-a', 'child-b']);
  assert.deepEqual(summonedChildren(arena, 'player'), ['owner', 'other']);
});

function stripActorFiles(actor: ActorDefinition): ActorDefinition {
  const clips: ActorDefinition['clips'] = {};
  for (const [name, clip] of Object.entries(actor.clips) as [keyof ActorDefinition['clips'], AnimationClip | undefined][]) {
    if (!clip) continue;
    clips[name] = { ...clip, layers: clip.layers.map(layer => ({ ...layer, file: '' })) };
  }
  return { ...actor, clips };
}

function completePhaserScene() {
  const base = createFakePhaserScene();
  const baseAdd = base.add as unknown as { sprite: (...args: unknown[]) => Record<string, unknown> };
  const baseTweens = base.tweens as unknown as Record<string, unknown>;
  return createFakePhaserScene({
    tweens: { ...baseTweens, killTweensOf: () => {}, getTweensOf: () => [] },
    add: {
      ...baseAdd,
      sprite: (...args: unknown[]) => {
        const sprite = baseAdd.sprite(...args);
        const anims = sprite.anims as Record<string, unknown>;
        Object.assign(anims, {
          isPlaying: false,
          getProgress: () => 0,
          create: (config: unknown) => { anims.currentAnim = config; return config; },
        });
        return Object.assign(sprite, {
          setTexture() { return sprite; },
          play() { anims.isPlaying = true; return sprite; },
        });
      },
    },
  });
}

function localBattleCatalog(base = loadBattleCatalog()): BattleCatalog {
  return {
    ...base,
    classes: base.classes.map(entry => ({ ...entry, actor: stripActorFiles(entry.actor) })),
    enemies: base.enemies.map(entry => ({ ...entry, actor: stripActorFiles(entry.actor) })),
  };
}

async function summonWorld(withOrdinary = false) {
  const battleCatalog = localBattleCatalog();
  const items = loadItemCatalog();
  const statsCatalog = loadCharacterStatsCatalog();
  const campaign = loadCampaignCatalog();
  const companions = loadCompanionCatalog();
  const hero = new BattleCharacter('warlock', statsCatalog, items);
  const session = new Session(campaign, undefined, undefined, items, hero, battleCatalog, statsCatalog, companions);
  session.skills.maxAll();
  session.skills.bar().assign(0, 1, { kind: 'skill', id: 'hell-s-pawn' });
  const map: WorldMap = {
    id: 'summon-test',
    name: 'summon-test',
    width: 320,
    height: 320,
    tileSize: 16,
    columns: 20,
    rows: 20,
    blocked: Array<boolean>(400).fill(false),
    ground: '',
    canopy: '',
    features: [],
    entities: [],
    exits: [],
    enemySpawns: withOrdinary
      ? [{ id: 'ordinary', enemyId: 'enemy-snake-1', x: 256, y: 256 }]
      : [],
  };
  const world = await createTestWorldCombat({ phaserScene: completePhaserScene(), hero, session, map, battleCatalog, items, characterStats: statsCatalog });
  await world.combat.start();
  world.combat.attack('hell-s-pawn');
  for (let i = 0; i < 30; i++) {
    world.combat.update(60, true);
    if (world.combat.captureState().roster.enemies.some(enemy => enemy.summonedBy === 'player')) break;
  }
  const summon = world.combat.captureState().roster.enemies.find(enemy => enemy.summonedBy === 'player');
  assert.ok(summon, '应成功召唤出友方召唤物');
  return { world, summonKey: summon.key };
}

test('destroying or clearing a summon forgets its session vitals', async t => {
  const { world, summonKey } = await summonWorld(true);
  const forgotten: string[] = [];
  const cooldowns: string[] = [];
  t.mock.method(world.session, 'forgetEnemyVitals', (key: string) => { forgotten.push(key); });
  t.mock.method(world.session.cooldowns, 'removeActor', (key: string) => { cooldowns.push(key); });

  world.combat.removeEnemy(summonKey);
  world.combat.removeEnemy('ordinary');

  assert.deepEqual(forgotten, [summonKey], '只有召唤物清理会话状态');
  assert.deepEqual(cooldowns, [summonKey, 'ordinary']);
  world.combat.destroy();
});

test('checkpoint restore clears visuals while keeping the summon states it will rebuild', async t => {
  const { world, summonKey } = await summonWorld(false);
  const snapshot = world.combat.captureState();
  const forgotten: string[] = [];
  const cooldowns: string[] = [];
  t.mock.method(world.session, 'forgetEnemyVitals', (key: string) => { forgotten.push(key); });
  t.mock.method(world.session.cooldowns, 'removeActor', (key: string) => { cooldowns.push(key); });

  await world.combat.restoreState(snapshot);
  assert.deepEqual(forgotten, [], '检查点恢复保留即将重建的召唤物状态');
  assert.deepEqual(cooldowns, [], '恢复路径保留冷却');
  assert.equal(world.combat.captureState().enemies.some(enemy => enemy.id === summonKey), true, '重建后的召唤物仍在场上');

  world.combat.finishMapVisit();
  assert.deepEqual(forgotten, [summonKey], '正常销毁会清理召唤物状态');
  world.combat.destroy();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import type { BattleCatalog } from '../src/domain/battle.ts';
import { BattleCharacter } from '../src/domain/character-stats.ts';
import type { ActorDefinition, AnimationClip, WorldMap } from '../src/domain/content.ts';
import { Session } from '../src/domain/session.ts';
import { WorldEnemyRoster } from '../src/domain/world-enemies.ts';
import {
  loadBattleCatalog,
  loadCampaignCatalog,
  loadCharacterStatsCatalog,
  loadItemCatalog,
} from './support/combat-test-harness.ts';
import { createFakePhaserScene, createTestWorldCombat } from './support/world-combat-fixture.ts';

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

test('roster refresh only syncs the arena projection and keeps the new roster identity', async t => {
  const battleCatalog = localBattleCatalog();
  const items = loadItemCatalog();
  const statsCatalog = loadCharacterStatsCatalog();
  const campaign = loadCampaignCatalog();
  const hero = new BattleCharacter('dark-knight', statsCatalog, items);
  const session = new Session(campaign, undefined, undefined, items, hero, battleCatalog, statsCatalog);

  const map = {
    id: 'breakable-map',
    name: 'breakable-map',
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
    breakableSpawn: 'jar',
    enemySpawns: [{ id: 'slot', enemyId: 'enemy-snake-1', x: 128, y: 128, breakableEligible: true }],
  } as unknown as WorldMap;

  let questIds = new Set<string>();
  const roster = new WorldEnemyRoster(
    session,
    map,
    [],
    hero.level,
    { snapshot: () => ({ revision: questIds.size, ids: questIds }) },
    () => 0,
  );
  assert.equal(roster.source('slot')?.enemyId, 'enemy-jar-1');

  const world = await createTestWorldCombat({
    phaserScene: completePhaserScene(),
    map,
    hero,
    session,
    roster,
    battleCatalog,
    items,
    characterStats: statsCatalog,
  });
  await world.combat.start();
  assert.equal(world.combat.captureStoryActors().find(actor => actor.enemyKey === 'slot')?.enemyId, 'enemy-jar-1');

  const removed: string[] = [];
  const spawned: string[] = [];
  const movement = world.scene.movement!;
  const origRemove = movement.remove.bind(movement);
  const origRegister = movement.register.bind(movement);
  t.mock.method(movement, 'remove', (visual: Parameters<typeof movement.remove>[0]) => {
    removed.push(visual.entity.id);
    return origRemove(visual);
  });
  t.mock.method(movement, 'register', (...args: Parameters<typeof movement.register>) => {
    spawned.push(args[0].entity.actor);
    return origRegister(...args);
  });

  // 任务关键敌人出现：breakableSpawnFor 把同 key 从罐子换回原怪。
  questIds = new Set(['enemy-snake-1']);
  world.combat.syncChestEnemies();

  assert.deepEqual(removed, ['slot'], '旧场景实例要被销毁');
  assert.deepEqual(spawned, ['enemy-snake-1'], '新身份要重新建场景实例');
  assert.equal(world.combat.captureStoryActors().find(actor => actor.enemyKey === 'slot')?.enemyId, 'enemy-snake-1');
  assert.equal(
    roster.enemies.find(enemy => enemy.key === 'slot')?.enemyId,
    'enemy-snake-1',
    '消费 refresh diff 时不能把刚加回的名册条目再删掉',
  );
  world.combat.destroy();
});

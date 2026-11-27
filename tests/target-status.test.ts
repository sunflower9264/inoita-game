import assert from 'node:assert/strict';
import test from 'node:test';
import type { BattleCatalog } from '../src/domain/battle.ts';
import { BattleCharacter } from '../src/domain/character-stats.ts';
import type { ActorDefinition, AnimationClip, WorldMap } from '../src/domain/content.ts';
import { Session } from '../src/domain/session.ts';
import {
  loadBattleCatalog,
  loadCampaignCatalog,
  loadCharacterStatsCatalog,
  loadCompanionCatalog,
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
  const scene = createFakePhaserScene({
    tweens: { ...baseTweens, killTweensOf: () => {}, getTweensOf: () => [] },
    add: {
      ...baseAdd,
      sprite: (...args: unknown[]) => {
        const sprite = baseAdd.sprite(...args);
        const anims = sprite.anims as Record<string, unknown>;
        Object.assign(anims, {
          isPlaying: false,
          getProgress: () => 0,
          create: (config: unknown) => { const anim = { ...(config as object), destroy: () => {} }; anims.currentAnim = anim; return anim; },
        });
        return Object.assign(sprite, {
          scene,
          texture: sprite.texture ?? { key: '' },
          setTexture() { return sprite; },
          play() { anims.isPlaying = true; return sprite; },
        });
      },
    },
  });
  return scene;
}

function localBattleCatalog(base = loadBattleCatalog()): BattleCatalog {
  return {
    ...base,
    classes: base.classes.map(entry => ({ ...entry, actor: stripActorFiles(entry.actor) })),
    enemies: base.enemies.map(entry => ({ ...entry, actor: stripActorFiles(entry.actor) })),
  };
}

async function statusWorld(spawns: { id: string; x: number; y: number }[]) {
  const battleCatalog = localBattleCatalog();
  const items = loadItemCatalog();
  const statsCatalog = loadCharacterStatsCatalog();
  const campaign = loadCampaignCatalog();
  const companions = loadCompanionCatalog();
  const hero = new BattleCharacter('dark-knight', statsCatalog, items);
  const session = new Session(campaign, undefined, undefined, items, hero, battleCatalog, statsCatalog, companions);
  session.bag.add('mercenary-emblem-black-knight');
  const ally = session.party!.recruit(session.bag.entries.find(entry => entry.item === 'mercenary-emblem-black-knight')!.id, () => 0).member;
  session.party!.deployFirstAvailable(ally.id);
  const dkActor = battleCatalog.classes.find(entry => entry.id === 'dark-knight')!.actor;
  const map: WorldMap = {
    id: 'target-status-map',
    name: 'target-status-map',
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
    enemySpawns: spawns.map(spawn => ({ ...spawn, enemyId: 'enemy-snake-1' })),
  };
  const world = await createTestWorldCombat({
    phaserScene: completePhaserScene(),
    hero,
    session,
    map,
    battleCatalog,
    items,
    characterStats: statsCatalog,
    appOverrides: {
      world: { actors: { [ally.definition.actor]: dkActor, [dkActor.id]: dkActor } } as never,
    },
  });
  await world.combat.start();
  return world;
}

test('the top enemy panel follows a companion into combat when the operator has no target', async () => {
  const world = await statusWorld([{ id: 'slot', x: 80, y: 64 }]);
  world.combat.selectEnemy('slot');
  world.combat.update(60, true);
  world.combat.followControlled();
  assert.equal(world.combat.targetId, undefined);
  assert.equal(world.combat.targetStatus()?.id, 'slot');
  world.combat.destroy();
});

test('the operator target stays authoritative when both are set', async () => {
  const world = await statusWorld([{ id: 'slot-a', x: 80, y: 64 }, { id: 'slot-b', x: 104, y: 64 }]);
  world.combat.selectEnemy('slot-b');
  world.combat.update(60, true);
  world.combat.selectEnemy('slot-a');
  assert.equal(world.combat.targetStatus()?.id, 'slot-a');
  world.combat.destroy();
});

test('an idle party keeps the top enemy panel hidden', async () => {
  const world = await statusWorld([{ id: 'slot', x: 280, y: 280 }]);
  world.combat.update(60, true);
  assert.equal(world.combat.targetStatus(), undefined);
  world.combat.destroy();
});

test('a defeated target does not fall back to the panel', async t => {
  t.mock.method(Math, 'random', () => 0.99);
  const world = await statusWorld([{ id: 'slot', x: 80, y: 64 }]);
  world.session.setOneHitKill('player', true);
  world.combat.selectEnemy('slot');
  world.combat.attack();
  for (let i = 0; i < 20; i++) {
    world.combat.update(60, true);
    if (world.combat.diagnostics().enemies?.some(enemy => enemy.id === 'slot' && enemy.pendingDefeat)) break;
  }
  assert.equal(world.combat.diagnostics().enemies?.some(enemy => enemy.id === 'slot' && enemy.pendingDefeat), true);
  assert.equal(world.combat.targetStatus(), undefined);
  world.combat.destroy();
});

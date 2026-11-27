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
import { createFakePhaserScene, createTestWorldCombat, installPhaserStubHooks } from './support/world-combat-fixture.ts';

const phaserHook = installPhaserStubHooks();
const { TargetFocus } = await import('../src/rendering/target-focus.ts');
phaserHook.deregister();

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

async function focusWorld(t: test.TestContext, options: { withCompanion?: boolean } = {}) {
  const battleCatalog = localBattleCatalog();
  const items = loadItemCatalog();
  const statsCatalog = loadCharacterStatsCatalog();
  const campaign = loadCampaignCatalog();
  const companions = loadCompanionCatalog();
  const hero = new BattleCharacter('dark-knight', statsCatalog, items);
  const session = new Session(campaign, undefined, undefined, items, hero, battleCatalog, statsCatalog, companions);
  session.skills.maxAll();
  const dkActor = battleCatalog.classes.find(entry => entry.id === 'dark-knight')!.actor;
  const actors: Record<string, unknown> = { [dkActor.id]: dkActor };
  if (options.withCompanion) {
    session.bag.add('mercenary-emblem-black-knight');
    const ally = session.party!.recruit(session.bag.entries.find(entry => entry.item === 'mercenary-emblem-black-knight')!.id, () => 0).member;
    session.party!.deployFirstAvailable(ally.id);
    ally.skills.maxAll(battleCatalog, ally.classId);
    actors[ally.definition.actor] = dkActor;
  }
  const map: WorldMap = {
    id: 'focus-map',
    name: 'focus-map',
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
    enemySpawns: [{ id: 'slot', enemyId: 'enemy-snake-1', x: 80, y: 64 }],
  };
  const calls: unknown[][] = [];
  const originalUpdate = TargetFocus.prototype.update;
  t.mock.method(TargetFocus.prototype, 'update', function (this: InstanceType<typeof TargetFocus>, ...args: Parameters<InstanceType<typeof TargetFocus>['update']>) {
    calls.push(args);
    return originalUpdate.apply(this, args);
  });
  const world = await createTestWorldCombat({
    phaserScene: completePhaserScene(),
    hero,
    session,
    map,
    battleCatalog,
    items,
    characterStats: statsCatalog,
    appOverrides: { world: { actors } as never },
  });
  await world.combat.start();
  const playerPos = () => world.combat.captureState().party.find(member => member.id === 'player')!.position;
  const enemyPos = () => {
    const enemy = world.combat.captureState().roster.enemies.find(entry => entry.key === 'slot')!;
    return { x: enemy.x, y: enemy.y };
  };
  return { world, calls, playerPos, enemyPos };
}

test('operator target keeps the ring', async t => {
  const { world, calls, playerPos, enemyPos } = await focusWorld(t, { withCompanion: true });
  world.combat.selectEnemy('slot');
  world.combat.update(16, true);
  assert.deepEqual(calls.at(-1), [playerPos(), enemyPos(), 'slot', true, 16]);
  world.combat.destroy();
});

test('companion target keeps the ring after the operator clears selection', async t => {
  const { world, calls, playerPos, enemyPos } = await focusWorld(t, { withCompanion: true });
  world.combat.selectEnemy('slot');
  world.combat.update(60, true);
  world.combat.followControlled();
  assert.equal(world.combat.targetId, undefined);
  world.combat.update(16, true);
  assert.deepEqual(calls.at(-1), [playerPos(), enemyPos(), 'slot', true, 16]);
  world.combat.destroy();
});

test('a running action target keeps the ring after selection clears', async t => {
  const { world, calls, playerPos, enemyPos } = await focusWorld(t);
  world.combat.selectEnemy('slot');
  world.combat.attack('dark-strike');
  world.combat.update(60, true);
  world.combat.focusTarget(undefined);
  world.combat.clearTarget();
  assert.equal(world.combat.targetId, undefined);
  world.combat.update(16, true);
  assert.deepEqual(calls.at(-1), [playerPos(), enemyPos(), 'slot', true, 16]);
  world.combat.destroy();
});

test('focus target is the last fallback', async t => {
  const { world, calls, playerPos, enemyPos } = await focusWorld(t);
  world.combat.focusTarget('slot');
  assert.equal(world.combat.targetId, undefined);
  world.combat.update(16, true);
  assert.deepEqual(calls.at(-1), [playerPos(), enemyPos(), 'slot', true, 16]);
  world.combat.destroy();
});

test('a pending defeat hides the ring', async t => {
  t.mock.method(Math, 'random', () => 0.99);
  const { world, calls, playerPos } = await focusWorld(t, { withCompanion: true });
  world.session.setOneHitKill('player', true);
  world.combat.selectEnemy('slot');
  world.combat.attack();
  for (let i = 0; i < 20; i++) {
    world.combat.update(60, true);
    if (world.combat.diagnostics().enemies?.some(enemy => enemy.id === 'slot' && enemy.pendingDefeat)) break;
  }
  assert.equal(world.combat.diagnostics().enemies?.some(enemy => enemy.id === 'slot' && enemy.pendingDefeat), true);
  world.combat.update(16, true);
  assert.deepEqual(calls.at(-1), [playerPos(), undefined, undefined, true, 16]);
  world.combat.destroy();
});

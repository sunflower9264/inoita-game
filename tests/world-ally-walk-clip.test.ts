import assert from 'node:assert/strict';
import test from 'node:test';
import { BattleCharacter } from '../src/domain/character-stats.ts';
import type { ActorDefinition, AnimationClip, WorldMap } from '../src/domain/content.ts';
import { NavigationWorld } from '../src/domain/navigation-world.ts';
import { Session } from '../src/domain/session.ts';
import {
  loadBattleCatalog,
  loadCampaignCatalog,
  loadCharacterStatsCatalog,
  loadCompanionCatalog,
  loadItemCatalog,
} from './support/combat-test-harness.ts';
import { createFakeMovementWorld, createFakePhaserScene, createTestWorldCombat } from './support/world-combat-fixture.ts';

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
          create: (config: unknown) => { anims.currentAnim = config; return config; },
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

async function setupAllyClipWorld(moving: boolean) {
  const battleCatalog = loadBattleCatalog();
  const items = loadItemCatalog();
  const statsCatalog = loadCharacterStatsCatalog();
  const campaign = loadCampaignCatalog();
  const companions = loadCompanionCatalog();
  const hero = new BattleCharacter('dark-knight', statsCatalog, items);
  const session = new Session(campaign, undefined, undefined, items, hero, battleCatalog, statsCatalog, companions);
  session.bag.add('mercenary-emblem-black-knight');
  const ally = session.party!.recruit(session.bag.entries.find(entry => entry.item === 'mercenary-emblem-black-knight')!.id, () => 0).member;
  session.party!.deployFirstAvailable(ally.id);

  const requested: string[] = [];
  const dkClips = battleCatalog.classes.find(entry => entry.id === 'dark-knight')!.actor.clips;
  const makeClip = (key: string) => ({
    frameWidth: 16,
    frameHeight: 16,
    frames: 1,
    originX: 0.5,
    originY: 1,
    frameRate: 1,
    mirrorX: false,
    layers: [{ key, file: '', blend: 'normal' as const }],
  });
  const baseClips: Record<string, AnimationClip> = {};
  for (const [name, clip] of Object.entries(dkClips)) {
    if (!clip) continue;
    baseClips[name] = { ...clip, layers: clip.layers.map(layer => ({ ...layer, file: '' })) };
  }
  baseClips['idle-south'] = makeClip('idle-south');
  baseClips['walk-south'] = makeClip('walk-south');
  const clips: ActorDefinition['clips'] = { ...(baseClips as ActorDefinition['clips']) };
  for (const key of ['idle-south', 'walk-south'] as const) {
    const clip = baseClips[key]!;
    Object.defineProperty(clips, key, {
      enumerable: true,
      get() {
        requested.push(key);
        return clip;
      },
    });
  }
  const allyActor: ActorDefinition = {
    id: ally.definition.actor,
    name: ally.definition.actor,
    description: '',
    portrait: null,
    collision: { x: -8, y: -8, width: 16, height: 16 },
    clips,
  };

  const map: WorldMap = {
    id: 'ally-clip-map',
    name: 'ally-clip-map',
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
    enemySpawns: [],
  };
  const movement = createFakeMovementWorld(new NavigationWorld(map));
  const baseRegister = movement.register.bind(movement);
  movement.register = (visual, canMove, selfHeal, faction) => {
    const body = baseRegister(visual, canMove, selfHeal, faction);
    Object.assign(body, {
      deltaXFinal: () => (visual.entity.id === ally.id && moving ? 2 : 0),
      deltaYFinal: () => 0,
    });
    return body;
  };

  const world = await createTestWorldCombat({
    phaserScene: completePhaserScene(),
    hero,
    session,
    map,
    movement,
    battleCatalog,
    items,
    characterStats: statsCatalog,
    appOverrides: {
      world: { actors: { [ally.definition.actor]: allyActor } } as never,
    },
  });
  await world.combat.start();
  requested.length = 0;
  return { world, allyId: ally.id, requested };
}

test('跟随中的伙伴按物理位移选择行走动作', async () => {
  const { world, allyId, requested } = await setupAllyClipWorld(true);
  world.combat.afterMovement();
  assert.ok(requested.includes('walk-south'), `期望 walk-south，实际 ${requested.join(',')}`);
  assert.equal(world.combat.captureStoryActors().find(actor => actor.memberId === allyId)?.clip, 'walk-south');
  world.combat.destroy();
});

test('停下的伙伴回到待机动作', async () => {
  const { world, allyId, requested } = await setupAllyClipWorld(false);
  world.combat.afterMovement();
  assert.ok(requested.includes('idle-south'), `期望 idle-south，实际 ${requested.join(',')}`);
  assert.equal(world.combat.captureStoryActors().find(actor => actor.memberId === allyId)?.clip, 'idle-south');
  world.combat.destroy();
});

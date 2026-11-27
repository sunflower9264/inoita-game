import assert from 'node:assert/strict';
import test from 'node:test';
import { BattleCharacter } from '../src/domain/character-stats.ts';
import type { ActorDefinition, WorldMap } from '../src/domain/content.ts';
import { CombatConditions } from '../src/domain/combat-conditions.ts';
import type { BattleBuffEffect, BattleCatalog } from '../src/domain/battle.ts';
import { Session } from '../src/domain/session.ts';
import { WorldEnemyRoster } from '../src/domain/world-enemies.ts';
import type { CharacterVisual } from '../src/rendering/characters.ts';
import { CHARACTER_ATLAS_ALIASES } from '../tools/character-atlas-aliases.ts';
import {
  createCombatTestHarness,
  createTestEnemy,
  createTestMember,
  loadBattleCatalog,
  loadCampaignCatalog,
  loadCharacterStatsCatalog,
  loadCompanionCatalog,
  loadItemCatalog,
} from './support/combat-test-harness.ts';
import { createFakeContainer, createTestWorldCombat, installPhaserStubHooks } from './support/world-combat-fixture.ts';

const phaserHook = installPhaserStubHooks();
const { enemyTapRect } = await import('../src/rendering/combat-status-visuals.ts');
phaserHook.deregister();

function normalizeActorClips(actor: ActorDefinition): void {
  for (const clip of Object.values(actor.clips)) {
    for (const layer of clip?.layers ?? []) {
      if (layer.file) layer.file = CHARACTER_ATLAS_ALIASES[layer.file] ?? layer.file;
    }
  }
}

function normalizeBattleCatalog(raw: BattleCatalog): BattleCatalog {
  const copy = structuredClone(raw);
  for (const cls of copy.classes) normalizeActorClips(cls.actor);
  for (const enemy of copy.enemies) normalizeActorClips(enemy.actor);
  return copy;
}

const catalog = normalizeBattleCatalog(loadBattleCatalog());

test('scene applies the actual state source and rejects weak buff refresh without interrupting the target', () => {
  const conditions = new CombatConditions(), applied: string[][] = [];
  const ally = createTestMember({ id: 'ally' });
  const enemy = createTestEnemy({ key: 'enemy', definition: catalog.enemies[0] });
  const harness = createCombatTestHarness({
    battleCatalog: catalog,
    conditions,
    members: new Map([['ally', ally]]),
    enemies: new Map([['enemy', enemy]]),
    activeParty: () => ['ally'],
    settlementOverrides: {
      onStateConsequences: (_id, states) => applied.push([...states]),
    },
  });
  const state = { effect: 'state' as const, state: 'stun' as const, ranks: [{ chanceThreshold: 1000, durationMs: 2000 }] };
  const event = { casterId: 'enemy', targetId: 'ally', cueIndex: 0, skill: { id: 'test', action: { combatUnits: [state] } } };
  harness.settlement.skillUnit(event as never);
  assert.equal(conditions.snapshot('ally')[0].sourceId, 'enemy');
  assert.deepEqual(applied, [['stun']]);
  const effect: BattleBuffEffect = { durationMs: 1000, tickMs: 0, states: ['immobilized'], modifiers: [], periodic: [] };
  conditions.applyBuff('ally', 'net-shackles', 10, effect, 'stronger');
  applied.length = 0;
  harness.settlement.skillUnit({
    ...event,
    skill: {
      id: 'net-shackles',
      action: { combatUnits: [{ effect: 'buff', buff: 'net-shackles', ranks: [{ strength: 1, chanceThreshold: 1000, effect }] }] },
    },
  } as never);
  assert.equal(applied.length, 0);
  assert.equal(conditions.snapshot('ally').find(entry => entry.kind === 'buff')?.sourceId, 'stronger');
});

test('state entry stops the current actor and stealth immediately clears hostile trackers only', async t => {
  const items = loadItemCatalog();
  const statsCatalog = loadCharacterStatsCatalog();
  const campaign = loadCampaignCatalog();
  const companions = loadCompanionCatalog();
  const hero = new BattleCharacter('dark-knight', statsCatalog, items);
  const session = new Session(campaign, undefined, undefined, items, hero, catalog, statsCatalog, companions);
  session.bag.add('mercenary-emblem-black-knight');
  const ally = session.party!.recruit(session.bag.entries.find(entry => entry.item === 'mercenary-emblem-black-knight')!.id, () => 0).member;
  session.party!.deployFirstAvailable(ally.id);
  const actor = catalog.classes.find(entry => entry.id === 'dark-knight')!.actor;
  const enemyDef = catalog.enemies.find(entry => !!entry.basicAttack)!;
  const map: WorldMap = {
    id: 'stealth-map', name: 'stealth-map', width: 320, height: 320, tileSize: 16, columns: 20, rows: 20,
    blocked: Array<boolean>(400).fill(false), ground: '', canopy: '', features: [], entities: [], exits: [],
    enemySpawns: [{ id: 'enemy', enemyId: enemyDef.id, x: 96, y: 64 }],
  };
  const roster = new WorldEnemyRoster(session, map, [], hero.level);
  roster.refresh();
  const layer = { alpha: 1, setAlpha(alpha: number) { this.alpha = alpha; return this; }, anims: { pause() {}, resume() {}, stop() {} } };
  const container = createFakeContainer(64, 64);
  container.alpha = 0.8;
  const playerVisual = { entity: { id: 'player', actor: actor.id, x: 64, y: 64, flip: false }, actor, layers: [layer], container } as unknown as CharacterVisual;
  const world = await createTestWorldCombat({
    battleCatalog: catalog, map, hero, session, roster, playerVisual,
    appOverrides: { world: { actors: { [ally.definition.actor]: actor, [actor.id]: actor } } as never },
  });
  await world.combat.start();

  const events: string[] = [];
  const partyControllers = Reflect.get(world.combat, 'partyControllers') as Map<string, { cancel(clearTarget?: boolean): void; targetRemoved(id: string): void }>;
  const heroAi = Reflect.get(world.combat, 'heroAi') as { disable(): void };
  const arena = Reflect.get(world.combat, 'arena') as { key: string; controller?: { targetRemoved(id: string): void } }[];
  const conditions = Reflect.get(world.combat, 'conditions') as CombatConditions;
  const settlement = Reflect.get(world.combat, 'settlement') as { applyActorBuff: (...args: unknown[]) => boolean };

  t.mock.method(partyControllers.get('player')!, 'cancel', () => events.push('cancel-player'));
  t.mock.method(partyControllers.get(ally.id)!, 'targetRemoved', () => events.push('forget-ally'));
  t.mock.method(world.scene.movement!, 'stop', (visual: CharacterVisual) => { if (visual === playerVisual) events.push('stop-player'); });
  t.mock.method(heroAi, 'disable', () => events.push('disable-player'));
  t.mock.method(arena[0]!.controller!, 'targetRemoved', (id: string) => events.push(`forget-enemy:${id}`));

  const whist = catalog.skills['whist'].action!.combatUnits![0];
  assert.equal(whist?.effect, 'buff');
  settlement.applyActorBuff('player', 'whist', whist.ranks[0].strength, whist.ranks[0].effect, 'caster');

  assert.deepEqual(events, ['cancel-player', 'stop-player', 'disable-player', 'forget-enemy:player']);
  assert.equal(layer.alpha, 0.5);
  assert.equal(playerVisual.container.alpha, 0.8);
  assert.equal(conditions.canAct('player'), true);
  assert.equal(conditions.canMove('player'), true);
  world.combat.destroy();
});

test('scene movement checks distinguish root from disabled actions and failed selection cannot set focus', async t => {
  const items = loadItemCatalog();
  const statsCatalog = loadCharacterStatsCatalog();
  const campaign = loadCampaignCatalog();
  const hero = new BattleCharacter('dark-knight', statsCatalog, items);
  const session = new Session(campaign, undefined, undefined, items, hero, catalog);
  const enemyDef = catalog.enemies[0];
  const map: WorldMap = {
    id: 'state-check-map', name: 'state-check-map', width: 320, height: 320, tileSize: 16, columns: 20, rows: 20,
    blocked: Array<boolean>(400).fill(false), ground: '', canopy: '', features: [], entities: [], exits: [],
    enemySpawns: [{ id: 'hidden', enemyId: enemyDef.id, x: 96, y: 64 }],
  };
  const roster = new WorldEnemyRoster(session, map, [], hero.level);
  roster.refresh();
  const world = await createTestWorldCombat({ battleCatalog: catalog, map, hero, session, roster });
  await world.combat.start();
  const conditions = Reflect.get(world.combat, 'conditions') as CombatConditions;
  conditions.applyState('player', 'immobilized', 1000);
  conditions.applyState('hidden', 'stealthed', 1000);
  assert.equal(world.combat.playerCannotMove(), true);
  assert.equal(world.combat.playerCannotAct(), false);
  const focusMock = t.mock.method(world.combat, 'focusTarget', () => assert.fail('failed selection set focus'));
  const refreshMock = t.mock.method(world.scene, 'refreshCombatTarget', () => assert.fail('failed selection changed HUD'));
  world.combat.selectEnemy('hidden');
  focusMock.mock.restore();
  refreshMock.mock.restore();
  world.combat.destroy();
});

test('damage immunity returns before damage feedback or health writes without affecting targetability', () => {
  const conditions = new CombatConditions();
  conditions.applyState('ally', 'damage-immune', 1000);
  const ally = createTestMember({ id: 'ally' });
  const origSetHealth = ally.setHealth.bind(ally);
  ally.setHealth = (value: number) => {
    void origSetHealth;
    void value;
    assert.fail('immune damage reached health mutation');
  };
  const harness = createCombatTestHarness({
    battleCatalog: catalog,
    conditions,
    members: new Map([['ally', ally]]),
    settlementOverrides: {
      onShowHit: () => assert.fail('immune damage displayed feedback'),
    },
  });
  harness.settlement.settleHit({ casterId: 'enemy', targetId: 'ally' }, { kind: 'hit', damage: 100 });
  assert.equal(conditions.canTarget('ally'), true);
});

test('enemy tap area covers the drawn idle frame instead of the feet collision box', () => {
  const clip = { frameWidth: 32, frameHeight: 40, originX: .625, originY: .675 };
  const actor = { collision: { x: -8, y: -8, width: 16, height: 16 }, clips: { 'idle-south': clip, 'idle-north': clip, 'idle-east': clip, 'idle-west': clip } };
  const rect = enemyTapRect(actor as never);
  assert.deepEqual(rect, { x: -20, y: -27, width: 32, height: 40 });
  assert.ok(rect.x <= actor.collision.x && rect.y <= actor.collision.y);
  assert.ok(rect.x + rect.width >= actor.collision.x + actor.collision.width);
  assert.ok(rect.y + rect.height >= actor.collision.y + actor.collision.height);
  const facingOnly = { ...actor, clips: { 'idle-south': clip, 'idle-east': { ...clip, frameWidth: 48, originX: .5 } } };
  assert.deepEqual(enemyTapRect(facingOnly as never), { x: -24, y: -27, width: 48, height: 40 });
});

test('enemy tap area falls back to the collision box when the catalog has no idle clip', () => {
  const actor = { collision: { x: -8, y: -8, width: 16, height: 16 }, clips: {} };
  assert.deepEqual(enemyTapRect(actor as never), { x: -8, y: -8, width: 16, height: 16 });
});

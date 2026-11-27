import assert from 'node:assert/strict';
import test from 'node:test';
import { BattleCharacter } from '../src/domain/character-stats.ts';
import { CombatConditions } from '../src/domain/combat-conditions.ts';
import { CombatHitResolution } from '../src/domain/combat-hit-resolution.ts';
import { CombatThreatSystem, type CombatThreatActor } from '../src/domain/combat-threat-system.ts';
import {
  createCombatTestHarness,
  loadBattleCatalog,
  loadCharacterStatsCatalog,
  loadItemCatalog,
} from './support/combat-test-harness.ts';
import { createTestWorldCombat } from './support/world-combat-fixture.ts';

function lifeFixture() {
  const hero = new BattleCharacter('dark-knight', loadCharacterStatsCatalog(), loadItemCatalog());
  hero.setHealth(30);
  const hitResolution = new CombatHitResolution();
  const events: string[] = [];
  const fallen = new Set<string>();
  const harness = createCombatTestHarness({
    conditions: new CombatConditions(),
    hitResolution,
    hero,
    members: new Map([['player', hero]]),
    activeParty: () => ['player'],
    settlementOverrides: {
      isFallen: id => fallen.has(id),
      threat: { damage: () => events.push(`threat:awaiting=${hitResolution.isAwaitingDefeat('player')}`) } as never,
      onShowHit: () => events.push('feedback'),
      onMemberDefeated: id => {
        if (fallen.has(id)) return;
        fallen.add(id);
        events.push(`defeat:${id}`);
      },
    },
  });
  harness.stats.partyPassives = () => [];
  hero.subscribe(() => {
    events.push('refresh');
    if (hero.player.health === 0) {
      hitResolution.deferDefeat('player', () => {
        if (hero.player.health === 0 && !fallen.has('player')) {
          fallen.add('player');
          events.push('defeat:player');
        }
      });
    }
  });
  const damage = () => harness.settlement.settleHit({ casterId: 'enemy', targetId: 'player' }, { kind: 'hit', damage: 50 });
  return { harness, hero, hitResolution, events, fallen, damage };
}

test('real hero subscription registers pending death before threat and permits recovery in the same hit chain', () => {
  const f = lifeFixture();
  f.hitResolution.run(() => {
    f.damage();
    assert.equal(f.hero.player.health, 0);
    assert.equal(f.hitResolution.isAwaitingDefeat('player'), true);
    assert.equal(f.fallen.has('player'), false);
    assert.ok(f.events.includes('threat:awaiting=true'));
    f.harness.settlement.restoreHealth('player', 10);
    assert.equal(f.hero.player.health, 10);
  });
  assert.equal(f.fallen.has('player'), false);
  assert.equal(f.events.some(event => event.startsWith('defeat:')), false);
  assert.equal(f.hitResolution.isAwaitingDefeat('player'), false);
});

test('real hero subscription and lethal damage share one final death check after the hit chain', () => {
  const f = lifeFixture();
  f.hitResolution.run(() => {
    f.damage();
    assert.equal(f.fallen.has('player'), false);
    f.events.push('remaining-hit-work');
  });
  assert.equal(f.hero.player.health, 0);
  assert.equal(f.fallen.has('player'), true);
  assert.deepEqual(
    f.events.filter(event => event.startsWith('defeat:')),
    ['defeat:player'],
  );
  assert.equal(f.events.at(-1), 'defeat:player');
});

test('a direct hero health change outside a hit chain still starts defeat immediately', () => {
  const f = lifeFixture();
  f.hero.setHealth(0);
  assert.equal(f.fallen.has('player'), true);
  assert.equal(f.hitResolution.isAwaitingDefeat('player'), false);
  assert.deepEqual(f.events, ['refresh', 'defeat:player']);
});

test('host actor departure clears the current enemy target without deleting its third-party threat', async () => {
  const actor = (id: string, team: string): CombatThreatActor => ({
    id,
    team,
    active: true,
    level: 1,
    tracksThreat: team === 'hostile',
    sightRangeUnits: 10,
    position: { x: 0, y: 0 },
    bounds: { x: 0, y: 0, width: 8, height: 8 },
  });
  const actors = new Map([actor('player', 'party'), actor('departing', 'party'), actor('watcher', 'hostile')].map(value => [value.id, value]));
  let current: string | undefined = 'departing';
  const threat = new CombatThreatSystem({
    actor: id => actors.get(id),
    actors: () => [...actors.values()],
    currentTarget: () => current,
    logicTick: () => 1,
    generationRate: () => 1000,
    reductionRate: () => 0,
    normalDamage: () => ({ physical: 10, magic: 0 }),
    tauntSource: () => undefined,
    applyTaunt: () => {},
  });
  threat.restoreState({
    entries: [
      { ownerId: 'watcher', sourceId: 'departing', score: 100, updatedTick: 1 },
      { ownerId: 'watcher', sourceId: 'player', score: 80, updatedTick: 1 },
      { ownerId: 'departing', sourceId: 'player', score: 20, updatedTick: 1 },
    ],
  });
  actors.delete('departing');
  threat.removeActor('departing');
  current = undefined;
  assert.deepEqual(threat.captureState().entries, [{ ownerId: 'watcher', sourceId: 'player', score: 80, updatedTick: 1 }]);
  assert.equal(threat.select('watcher', current), 'player');

  const catalog = loadBattleCatalog();
  const shin = catalog.enemies.find(entry => entry.id === 'enemy-shin-1')!;
  const pawn = catalog.enemies.find(entry => entry.id === 'enemy-hell-s-pawn-1')!;
  const quietWatcher = { ...shin, behavior: { ...shin.behavior, aggression: 'none' as const } };
  const quietSummon = { ...pawn, actor: { ...pawn.actor, clips: shin.actor.clips }, behavior: { ...pawn.behavior, aggression: 'none' as const } };
  const battleCatalog = {
    ...catalog,
    enemies: catalog.enemies.map(entry => (entry.id === quietWatcher.id ? quietWatcher : entry.id === quietSummon.id ? quietSummon : entry)),
  };
  const world = await createTestWorldCombat({ battleCatalog });
  const departing = world.roster.placeEnemy(quietSummon.id, 80, 64);
  departing.summonedBy = 'player';
  const watcher = world.roster.placeEnemy(quietWatcher.id, 96, 64);
  await world.combat.start();
  const saved = world.combat.captureState();
  saved.summonGroups = [['player', [departing.key]]];
  saved.threat.entries = [
    { ownerId: watcher.key, sourceId: departing.key, score: 100, updatedTick: world.session.combatTick },
    { ownerId: watcher.key, sourceId: 'player', score: 80, updatedTick: world.session.combatTick },
    { ownerId: departing.key, sourceId: 'player', score: 20, updatedTick: world.session.combatTick },
  ];
  await world.combat.restoreState(saved);
  world.combat.removeEnemy(departing.key);
  const after = world.combat.captureState().threat.entries;
  assert.ok(after.some(entry => entry.ownerId === watcher.key && entry.sourceId === 'player' && entry.score === 80));
  assert.equal(after.some(entry => entry.ownerId === departing.key || entry.sourceId === departing.key), false);
  world.combat.destroy();
});

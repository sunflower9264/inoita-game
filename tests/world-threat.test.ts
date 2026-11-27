import assert from 'node:assert/strict';
import test from 'node:test';
import type { BattleStateKey, BattleStatKey } from '../src/domain/battle-semantics.ts';
import { CombatConditions } from '../src/domain/combat-conditions.ts';
import { CombatHitResolution } from '../src/domain/combat-hit-resolution.ts';
import { type CombatThreatActor } from '../src/domain/combat-threat-system.ts';
import type { SkillUnitHit } from '../src/domain/combat.ts';
import type { Combatant } from '../src/domain/combat.ts';
import type { CombatArenaEnemy } from '../src/domain/combat-settlement.ts';
import { refreshCombatActors } from '../src/domain/combat-actor-lookup.ts';
import type { ActorDefinition } from '../src/domain/content.ts';
import {
  createCombatTestHarness,
  createTestEnemy,
  createTestMember,
  loadBattleCatalog,
  type TestMemberFixture,
} from './support/combat-test-harness.ts';

const catalog = loadBattleCatalog();
const actor = (id: string, team: string): CombatThreatActor => ({
  id,
  team,
  active: true,
  level: 10,
  sightRangeUnits: 20,
  tracksThreat: team === 'hostile',
  position: { x: 0, y: 0 },
  bounds: { x: -4, y: -4, width: 8, height: 8 },
});

function fixture() {
  const conditions = new CombatConditions();
  const hitResolution = new CombatHitResolution();
  const events: string[] = [];
  const makeMember = (id: string): TestMemberFixture => {
    const member = createTestMember({
      id,
      level: 10,
      panel: { maxHealth: 100, maxMana: 0, attributes: { strength: 0, dexterity: 0, vitality: 0, intelligence: 0, mentality: 0 } },
      health: 80,
      maxHealth: 100,
      mana: 0,
      maxMana: 0,
    });
    const origSetHealth = member.setHealth.bind(member);
    member.setHealth = (value: number) => {
      origSetHealth(value);
      events.push(`hp:${id}:${member.player.health}`);
    };
    return member;
  };
  const members = new Map<string, TestMemberFixture>(['caster', 'ally'].map(id => [id, makeMember(id)]));
  const actors = new Map([actor('caster', 'party'), actor('ally', 'party'), actor('enemy', 'hostile')].map(value => [value.id, value]));
  const enemyDefinition = {
    ...catalog.enemies[0],
    behavior: { awarenessRangeUnits: 8, canMove: true, canTurn: true, moveSpeedPxPerSecond: 0, aggression: 'none' as const },
  };
  const enemy = createTestEnemy({ key: 'enemy', definition: enemyDefinition, health: 100, maxHealth: 100, level: 10, targetId: 'ally' });
  const enemies = new Map([['enemy', enemy]]);
  const enemyState = enemy;
  const attributes = {
    physicalAttack: 20,
    magicAttack: 10,
    maxHealth: 100,
    maxMana: 0,
    physicalDamageRate: 0,
    magicDamageRate: 0,
    stealthDamageRate: 0,
    primaryAttributes: { strength: 0, dexterity: 0, vitality: 0, intelligence: 0, mentality: 0 },
  };
  let reactionTargetId: string | undefined;
  const enemyTargets = new Map<string, string | undefined>([['enemy', 'ally']]);
  let customCombatant: ((id: string) => Combatant | undefined) | undefined;
  let customHasDisplay: ((id: string) => boolean) | undefined;
  let customMemberDefinition: ((id: string) => ActorDefinition | undefined) | undefined;
  let customMemberOf: ((id: string) => TestMemberFixture | undefined) | undefined;
  let customStateRequest: ((source: string, target: string, state: BattleStateKey) => { state: BattleStateKey; sourceRelation: 'hostile'; rules?: Record<string, unknown> }) = (
    _source,
    _target,
    state,
  ) => ({ state, sourceRelation: 'hostile' });
  let enemyThreatListeners = new Map<string, () => void>([['enemy', () => events.push('threat')]]);
  let useSyntheticThreatActor = true;

  const harness = createCombatTestHarness({
    battleCatalog: catalog,
    conditions,
    hitResolution,
    hero: members.get('caster'),
    members,
    enemies,
    activeParty: () => ['caster', 'ally'],
    withThreat: false,
    memberActorDefinition: id => customMemberDefinition?.(id),
    combatant: id => (customCombatant ? customCombatant(id) : actors.get(id)),
    settlementOverrides: {
      memberOf: id => (customMemberOf ? customMemberOf(id) : members.get(id)) as never,
      hasDisplay: id => (customHasDisplay ? customHasDisplay(id) : !!enemies.get(id)?.hasDisplay || !!members.get(id)),
      currentTargetOf: () => reactionTargetId,
      enemyTarget: id => enemyTargets.get(id),
      onThreatCombatStarted: key => {
        enemyThreatListeners.get(key)?.();
      },
      setEnemyHealth: (_id, value) => {
        enemyState.health = Math.max(0, Math.min(100, value));
      },
      onShowHit: () => events.push('feedback'),
      onMemberDefeated: id => events.push(`death:${id}`),
      onStateConsequences: () => {},
    },
  });
  harness.setCombatTick(31);
  harness.stats.partyPassives = () => [];
  harness.stats.partyFighter = () => ({}) as never;
  harness.stats.actorAttributes = () => attributes;
  harness.stats.actorAttribute = (_id: string, key: BattleStatKey) =>
    key === 'physicalAttack' ? attributes.physicalAttack : key === 'threatGenerationRate' || key === 'healingPowerRate' ? 1000 : 0;

  const engineThreatActor = harness.settlement.threatActor.bind(harness.settlement);
  harness.settlement.threatActor = (id: string) => {
    if (!useSyntheticThreatActor) return engineThreatActor(id);
    const value = actors.get(id);
    return value && { ...value, states: conditions.activeStates(id) };
  };
  harness.settlement.stateApplicationRequest = (source, target, state) => customStateRequest(source, target, state) as never;
  const threat = harness.settlement.createThreatSystem();
  harness.settlement.setThreatSystem(threat);

  const skill = (unit: object, targetId = 'enemy') =>
    harness.settlement.skillUnit({ casterId: 'caster', targetId, cueIndex: 0, skill: { id: 'probe', action: { combatUnits: [unit] } } } as SkillUnitHit);
  return {
    harness,
    conditions,
    hitResolution,
    events,
    members,
    actors,
    enemies,
    enemy,
    enemyState,
    attributes,
    skill,
    threat,
    engineThreatActor,
    setUseSyntheticThreatActor: (value: boolean) => {
      useSyntheticThreatActor = value;
    },
    setCustomCombatant: (fn: typeof customCombatant) => {
      customCombatant = fn;
    },
    setCustomHasDisplay: (fn: typeof customHasDisplay) => {
      customHasDisplay = fn;
    },
    setCustomMemberDefinition: (fn: typeof customMemberDefinition) => {
      customMemberDefinition = fn;
    },
    setCustomMemberOf: (fn: typeof customMemberOf) => {
      customMemberOf = fn;
    },
    setStateRequest: (fn: typeof customStateRequest) => {
      customStateRequest = fn;
    },
    setEnemyTarget: (id: string, targetId: string | undefined) => {
      enemyTargets.set(id, targetId);
    },
    setReactionTargetId: (id: string | undefined) => {
      reactionTargetId = id;
    },
    onThreatAdded: (key: string, fn: () => void) => {
      enemyThreatListeners.set(key, fn);
    },
  };
}

test('accepted damage updates HP, then full overkill threat, then feedback, before deferred defeat', () => {
  const f = fixture();
  f.actors.get('ally')!.tracksThreat = true;
  f.conditions.applyState('ally', 'sleep', 1000);
  f.onThreatAdded('ally', () => f.events.push('threat'));
  f.hitResolution.run(() => f.harness.settlement.settleHit({ casterId: 'caster', targetId: 'ally' }, { kind: 'hit', damage: 500 }));
  assert.deepEqual(f.events, ['hp:ally:0', 'threat', 'feedback', 'death:ally']);
  assert.equal(f.conditions.hasState('ally', 'sleep'), false);
  assert.equal(f.threat.captureState().entries.find(entry => entry.ownerId === 'ally')?.score, 500);
  f.events.length = 0;
  f.conditions.applyState('ally', 'damage-immune', 1000);
  f.harness.settlement.settleHit({ casterId: 'caster', targetId: 'ally' }, { kind: 'hit', damage: 10 });
  assert.equal(f.events.length, 0);
});

test('ordinary action healing submits actual HP delta and creates a zero entry at full health', () => {
  const f = fixture();
  const heal = {
    effect: 'heal',
    source: 'physicalAttack',
    attributeWeights: f.attributes.primaryAttributes,
    ranks: [{ fixedAddition: 0, operation: { kind: 'multiply-thousandth', ratePerThousand: 10000 } }],
  };
  f.members.get('ally')!.player.health = 1;
  assert.equal(f.skill(heal, 'ally'), 'success');
  assert.equal(f.members.get('ally')!.player.health, 100);
  assert.equal(f.threat.captureState().entries[0].score, 1);
  f.threat.clear();
  assert.equal(f.skill(heal, 'ally'), 'success');
  assert.equal(f.threat.captureState().entries[0].score, 0);
  f.threat.clear();
  f.harness.settlement.restoreHealth('ally', 100);
  assert.equal(f.threat.captureState().entries.length, 0);
});

test('only successful direct action states create state threat', () => {
  const f = fixture();
  const state = { effect: 'state', state: 'stun', ranks: [{ chanceThreshold: 1000, durationMs: 1000 }] };
  assert.equal(f.skill(state), 'success');
  assert.equal(f.threat.captureState().entries[0].score, 20);
  f.threat.clear();
  f.setStateRequest(() => ({ state: 'stun', sourceRelation: 'hostile', rules: { immuneToAllStates: true } }));
  assert.equal(f.skill(state), 'failure');
  assert.equal(f.threat.captureState().entries.length, 0);
});

test('healing threat follows a reaction-selected current target rather than the previous AI decision', () => {
  const f = fixture();
  f.setEnemyTarget('enemy', 'caster');
  f.threat.heal('ally', 'ally', 100);
  assert.equal(f.threat.captureState().entries.length, 0);
  f.threat.heal('ally', 'caster', 100);
  assert.equal(f.threat.captureState().entries[0].sourceId, 'ally');
});

test('taunt adds normal physical plus magical damage, gates other sources, and leaves current AI target alone', () => {
  const f = fixture();
  assert.equal(f.skill({ effect: 'taunt' }), 'success');
  assert.equal(f.threat.captureState().entries[0].score, 30);
  assert.equal(f.conditions.snapshot('enemy').find(state => state.id === 'taunted')?.sourceId, 'caster');
  assert.equal(f.enemy.targetId, 'ally');
  f.threat.damage('ally', 'enemy', 100);
  assert.equal(f.threat.has('enemy', 'ally'), false);
  f.conditions.update(32 * 60);
  assert.equal(f.conditions.hasState('enemy', 'taunted'), false);
  f.threat.damage('ally', 'enemy', 100);
  assert.equal(f.threat.has('enemy', 'ally'), true);
});

test('taunt state rejection retains its preceding numerical threat and successful Direct result', () => {
  const f = fixture();
  f.setStateRequest(() => ({ state: 'taunted', sourceRelation: 'hostile', rules: { immuneToAllStates: true } }));
  assert.equal(f.skill({ effect: 'taunt' }), 'success');
  assert.equal(f.threat.captureState().entries[0].score, 30);
  assert.equal(f.conditions.hasState('enemy', 'taunted'), false);
  f.setStateRequest(() => ({ state: 'taunted', sourceRelation: 'hostile', rules: { durationScale: 0.5 } }));
  f.skill({ effect: 'taunt' });
  f.conditions.update(16 * 60);
  assert.equal(f.conditions.hasState('enemy', 'taunted'), true);
  f.conditions.update(60);
  assert.equal(f.conditions.hasState('enemy', 'taunted'), false);
});

test('hostile damage immunity rejects taunt before numerical threat and state application', () => {
  const f = fixture();
  f.conditions.applyState('enemy', 'damage-immune', 1000);
  assert.equal(f.skill({ effect: 'taunt' }), 'failure');
  assert.equal(f.threat.captureState().entries.length, 0);
  assert.equal(f.conditions.hasState('enemy', 'taunted'), false);
});

test('resource pulses decay threat once after all actors have recovered', () => {
  const events: string[] = [];
  const harness = createCombatTestHarness({
    activeParty: () => [],
    withThreat: false,
    settlementOverrides: {
      recoveryPulseDue: () => true,
      recoverCombatResources: () => [{ atMs: 0, amounts: [{ actorId: 'a', healthAmount: 1, manaAmount: 2 }] }, { atMs: 60, amounts: [] }],
      advanceRecoveryClock: () => {},
      threat: { decay: () => events.push('decay') } as never,
    },
  });
  harness.settlement.restoreHealth = () => events.push('health');
  harness.settlement.restoreMana = () => events.push('mana');
  harness.settlement.recoverResources();
  assert.deepEqual(events, ['health', 'mana', 'decay', 'decay']);
});

test('world actor records retain inactive party sources and use the live combat eligibility for zero HP', () => {
  const f = fixture();
  f.setUseSyntheticThreatActor(false);
  const bounds = { x: -4, y: -4, width: 8, height: 8 };
  f.setCustomHasDisplay(id => f.actors.has(id));
  f.setCustomMemberDefinition(id => (f.actors.has(id) ? ({ collision: bounds } as ActorDefinition) : undefined));
  f.setCustomCombatant(() => undefined);
  f.members.get('ally')!.player.health = 0;
  const inactive = f.engineThreatActor('ally') as CombatThreatActor;
  assert.equal(inactive.active, false);
  assert.equal(inactive.tracksThreat, false);
  assert.equal(inactive.team, 'party');
  f.setCustomCombatant(() => f.actors.get('ally'));
  assert.equal((f.engineThreatActor('ally') as CombatThreatActor).active, true);
  assert.equal(f.engineThreatActor('departed'), undefined);
});

test('world actor records classify player, member, summon and enemy roles', () => {
  const f = fixture();
  f.setUseSyntheticThreatActor(false);
  const bounds = { x: -4, y: -4, width: 8, height: 8 };
  f.setCustomHasDisplay(id => f.actors.has(id) || id === 'summon' || id === 'player');
  f.setCustomMemberDefinition(id => (f.actors.has(id) || id === 'player' ? ({ collision: bounds } as ActorDefinition) : undefined));
  f.setCustomMemberOf(id => (id === 'player' ? ({ ...f.members.get('caster')!, id: 'player' } as TestMemberFixture) : f.members.get(id)));
  f.setCustomCombatant(() => f.actors.get('ally'));
  assert.equal((f.engineThreatActor('player') as CombatThreatActor).role, 'player');
  assert.equal((f.engineThreatActor('ally') as CombatThreatActor).role, 'member');
  const summon = createTestEnemy({ key: 'summon', definition: f.enemy.definition, summonedBy: 'caster', targetId: 'player' });
  f.enemies.set('summon', summon);
  refreshCombatActors([...f.enemies.values()] as CombatArenaEnemy[]);
  assert.equal((f.engineThreatActor('summon') as CombatThreatActor).role, 'summon');
  assert.equal((f.engineThreatActor('enemy') as CombatThreatActor).role, 'enemy');
});

test('positive physical and magical success wakes sleep while misses and nonpositive hits retain it', () => {
  const conditions = new CombatConditions();
  const harness = createCombatTestHarness({
    conditions,
    activeParty: () => [],
  });
  harness.settlement.reactToBuff = () => {};
  harness.settlement.react = () => {};
  harness.settlement.attackProc = () => {};
  harness.settlement.holySacrificeTransfer = () => {};
  harness.settlement.physicalSuccessEquipmentProcs = () => {};
  harness.settlement.instantRecoveryOnMiss = () => {};
  for (const kind of ['physical', 'magic'] as const) {
    for (const [outcome, damage, wakes] of [
      ['hit', 1, true],
      ['miss', 1, false],
      ['hit', 0, false],
    ] as const) {
      conditions.applyState('target', 'sleep', 1000);
      harness.settlement.resolveHitReactions({ casterId: 'caster', targetId: 'target' }, { kind: outcome, damage }, kind, 'probe');
      assert.equal(conditions.hasState('target', 'sleep'), !wakes);
    }
  }
});

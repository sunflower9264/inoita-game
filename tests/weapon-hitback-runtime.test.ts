import assert from 'node:assert/strict';
import test from 'node:test';
import type { ActionDispatchDefinition, BattleBuffEffect } from '../src/domain/battle.ts';
import { CombatConditions } from '../src/domain/combat-conditions.ts';
import { CombatCooldownStore } from '../src/domain/combat-cooldowns.ts';
import { CombatHitResolution } from '../src/domain/combat-hit-resolution.ts';
import { CombatController, type AttackContact, type Combatant, type CombatPort, type SkillUnitHit } from '../src/domain/combat.ts';
import type { CombatActorAttributes } from '../src/domain/combat-damage-source.ts';
import type { EnemySnapshot } from '../src/domain/enemy-stats.ts';
import type { PhysicalFighter, PhysicalHit } from '../src/domain/physical-hit.ts';
import { dispatchFrame } from './support/combat-driver.ts';
import { createCombatTestHarness, createTestEnemy, createTestMember, loadBattleCatalog } from './support/combat-test-harness.ts';

const catalog = loadBattleCatalog();
const skill = catalog.skills['weapon-hitback'], action = skill.action!;
const enemyDefinition = { ...catalog.enemies.find(enemy => enemy.acceptsBuffs !== false)!, stateRules: undefined };
const buffUnit = action.combatUnits!.find(unit => unit.effect === 'buff')!;
assert.ok(buffUnit?.effect === 'buff');
const actor = (id: string, x = 16, y = 0, team = 'enemy'): Combatant => ({
  id,
  team,
  position: { x, y },
  bounds: { x: -4, y: -4, width: 8, height: 8 },
});
const base = {
  level: 10,
  physicalAttack: 101,
  magicAttack: 203,
  baseDefense: 0,
  defense: 0,
  defenseRate: 0,
  physicalResistance: 0,
  physicalResistanceBonus: 0,
  magicResistance: 0,
  baseMagicResistance: 0,
  maxHealth: 10000,
  maxMana: 100,
  hitBase: 100,
  hitBonus: 0,
  hitRate: 100,
  evasionBase: 0,
  evasionBonus: 0,
  evasionRate: 0,
  criticalRate: 0,
  criticalResistance: 0,
  criticalDamage: 0,
  criticalDamageResistance: 0,
  weaponBlock: 0,
  shieldBlock: 0,
  attributes: { strength: 11, dexterity: 17, vitality: 0, intelligence: 0, mentality: 0 },
};

function fixture(targets: Combatant[] = []) {
  const caster = actor('player', 0, 0, 'party');
  const actors = new Map([caster, ...targets].map(value => [value.id, value]));
  const conditions = new CombatConditions();
  const resolution = new CombatHitResolution();
  const fallen = new Set<string>();
  const stats = new Map<string, EnemySnapshot>(
    targets.map(value => [
      value.id,
      {
        ...structuredClone(base),
        id: enemyDefinition.id,
        name: enemyDefinition.name,
        sceneLevel: false,
        elite: false,
        partySize: 1,
        baseExperience: 0,
        experience: 0,
        health: 10000,
        mana: 100,
      },
    ]),
  );
  const enemies = new Map(
    targets
      .filter(value => value.team === 'enemy')
      .map(value => [value.id, createTestEnemy({ key: value.id, definition: enemyDefinition, level: 10, health: 10000, maxHealth: 10000 })]),
  );
  const order: string[] = [];
  const attempts: SkillUnitHit[] = [];
  const hits: { event: SkillUnitHit; hit: PhysicalHit }[] = [];
  const member = createTestMember({
    id: 'player',
    classId: 'warrior',
    level: 10,
    panel: structuredClone(base),
    health: 10000,
    maxHealth: 10000,
    mana: 100,
    maxMana: 100,
  });
  const visuals = new Map([...actors].map(([id, value]) => [id, { container: { active: true, ...value.position }, layers: [{ setAlpha: () => {} }] }]));
  let afterHit: (event: SkillUnitHit, hit: PhysicalHit) => void = () => {};
  let onMemberDefeated: (id: string) => void = () => {};
  const combatantOf = (id: string) => {
    const value = actors.get(id);
    return value && !fallen.has(id) ? { ...value, states: conditions.activeStates(id) } : undefined;
  };
  const harness = createCombatTestHarness({
    battleCatalog: catalog,
    conditions,
    hitResolution: resolution,
    hero: member,
    members: new Map([['player', member]]),
    enemies,
    activeParty: () => ['player'],
    combatant: combatantOf,
    combatants: () =>
      [...actors.keys()].flatMap(id => {
        const value = combatantOf(id);
        return value ? [value] : [];
      }),
    statsOverrides: {
      enemySnapshot: id => stats.get(id),
    },
    settlementOverrides: {
      isFallen: id => fallen.has(id),
      isPendingDefeat: () => false,
      enemySnapshot: id => stats.get(id),
      setEnemyHealth: (id, value) => {
        const s = stats.get(id);
        if (s) s.health = value;
      },
      onActionSound: (_id, name) => order.push(`sound:${name}`),
      onActionShake: () => assert.fail('Weapon Hitback has no shake'),
      onDropMana: () => {},
      onShowHit: (event, hit) => {
        hits.push({ event: event as SkillUnitHit, hit });
        order.push(`hit:${event.targetId}:${hit.kind}:${hit.damage}`);
        afterHit(event as SkillUnitHit, hit);
      },
      onMemberDefeated: id => onMemberDefeated(id),
      onStateConsequences: () => {},
    },
  });
  harness.settlement.resolveHitReactions = () => {};
  const baseApplyBuff = harness.settlement.applyActorBuff.bind(harness.settlement);
  harness.settlement.applyActorBuff = (targetId, key, priority, effect, sourceId) => {
    const accepted = baseApplyBuff(targetId, key, priority, effect, sourceId);
    if (accepted) order.push(`buff:${targetId}`);
    return accepted;
  };
  const presenter = {
    pose: () => {},
    visual: (id: string) => visuals.get(id),
    candidates: () =>
      [...actors.keys()].flatMap(id => {
        const value = combatantOf(id);
        return value ? [value] : [];
      }),
    visualEffect: (effect: { effect: string }, variant: string, target: Combatant) => {
      if (visuals.get(target.id)?.container.active) order.push(`effect:${effect.effect}:${variant}`);
    },
  };
  let frame = (_index: number) => {};
  let spent = 0;
  let moves = 0;
  const cooldowns = new CombatCooldownStore(() => 0).forActor('player');
  const port: CombatPort = {
    cooldowns,
    actor: combatantOf,
    candidates: () => presenter.candidates(),
    facing: () => 'east',
    moveToward: () => {
      moves++;
    },
    stop: () => {},
    canStand: () => true,
    relocate: () => {
      moves++;
    },
    clearEffects: () => {},
    canSpendMana: cost => member.player.mana >= cost,
    spendMana: cost => {
      spent += cost;
      member.player.mana -= cost;
      return true;
    },
    play: (_playback, onFrame) => {
      frame = onFrame;
      return () => {};
    },
    frame: (playback, index, contact, ready, area) =>
      resolution.run(() =>
        dispatchFrame(
          presenter,
          playback,
          index,
          contact,
          ready,
          undefined,
          (definition: ActionDispatchDefinition, work: () => void, after?: () => void) =>
            harness.settlement.runActionDispatch(playback, definition, work, after),
          area,
        ),
      ),
    prepareUnit: event => harness.settlement.prepareSkillUnit(event),
    runUnitSequence: work => resolution.run(work),
    unit: hit => {
      attempts.push(hit);
      return harness.settlement.skillUnit(hit);
    },
    unitFeedback: () => {},
  };
  const combat = new CombatController('player', null, port);
  const apply = (targetId: string, rank = 1, sourceId = 'player') => {
    const row = buffUnit.ranks[rank - 1];
    return harness.settlement.applyActorBuff(targetId, buffUnit.buff, row.strength, row.effect, sourceId);
  };
  const unit = (casterId: string, targetId: string, cueIndex: number, rank = 1) =>
    harness.settlement.skillUnit({
      casterId,
      targetId,
      cueIndex,
      skill: { id: skill.id, action, level: rank, manaCost: 44 },
    } satisfies SkillUnitHit);
  return {
    caster,
    actors,
    conditions,
    resolution,
    fallen,
    stats,
    order,
    attempts,
    hits,
    member,
    visuals,
    harness,
    combat,
    apply,
    unit,
    start: () => combat.requestManualSkill({ id: skill.id, action, level: 1, manaCost: 44 }),
    frame: (index: number) => frame(index),
    counts: () => ({ spent, moves }),
    afterHit: (callback: typeof afterHit) => {
      afterHit = callback;
    },
    setOnMemberDefeated: (callback: typeof onMemberDefeated) => {
      onMemberDefeated = callback;
    },
  };
}

test('an empty cast charges mana and cooldown once without approach and emits sound before both independent waves', () => {
  const f = fixture();
  assert.equal(f.start(), 'started');
  assert.equal(f.combat.snapshot().state, 'attacking');
  assert.deepEqual(f.counts(), { spent: 44, moves: 0 });
  assert.equal(f.member.player.mana, 56);
  assert.deepEqual(f.combat.snapshot().cooldowns[skill.id], { remainingMs: 7200, durationMs: 7200 });
  f.frame(1);
  assert.equal(f.order.length, 0);
  f.frame(2);
  f.frame(2);
  assert.deepEqual(f.order, ['sound:Wa_Defense', 'effect:hitback-wave:east', 'effect:hitback-wave:default']);
  assert.equal(f.attempts.length, 0);
  assert.deepEqual(f.counts(), { spent: 44, moves: 0 });
});

test('the real frame dispatch damages the whole group before applying its debuff group and playing the tail', t => {
  t.mock.method(Math, 'random', () => 0.2);
  const f = fixture([actor('first'), actor('second')]);
  assert.equal(f.start(), 'started');
  f.frame(2);
  assert.deepEqual(
    f.attempts.map(hit => [hit.cueIndex, hit.targetId]),
    [[0, 'first'], [0, 'second'], [1, 'first'], [1, 'second']],
  );
  assert.deepEqual(f.order, [
    'hit:first:hit:330',
    'hit:second:hit:330',
    'buff:first',
    'buff:second',
    'sound:Wa_Defense',
    'effect:hitback-wave:east',
    'effect:hitback-wave:default',
  ]);
  for (const id of ['first', 'second']) {
    assert.equal(f.stats.get(id)!.health, 9670);
    assert.equal(f.conditions.hasBuff(id, 'weapon-hitback'), true);
  }
  assert.equal(f.conditions.hasBuff('player', 'weapon-hitback'), false);
});

test('area targeting uses exact octagonal boundaries and reuses the captured group after movement or stealth', t => {
  t.mock.method(Math, 'random', () => 0.2);
  const f = fixture([
    actor('axis-in', 47),
    actor('axis-out', 48),
    actor('diagonal-in', 34, 34),
    actor('diagonal-out', 35, 35),
    actor('ally', 16, 0, 'party'),
    actor('hidden'),
  ]);
  f.conditions.applyState('hidden', 'stealthed', 10000);
  f.afterHit(event => {
    if (event.targetId === 'axis-in') {
      f.actors.get('diagonal-in')!.position = { x: 1000, y: 1000 };
      f.conditions.applyState('diagonal-in', 'stealthed', 10000);
      f.actors.get('axis-out')!.position.x = 16;
    }
  });
  assert.equal(f.start(), 'started');
  f.frame(2);
  assert.deepEqual(
    f.attempts.map(hit => [hit.cueIndex, hit.targetId]),
    [[0, 'axis-in'], [0, 'diagonal-in'], [1, 'axis-in'], [1, 'diagonal-in']],
  );
  assert.equal(f.conditions.hasBuff('diagonal-in', 'weapon-hitback'), true);
  for (const id of ['axis-out', 'diagonal-out', 'ally', 'hidden']) {
    assert.equal(f.conditions.hasBuff(id, 'weapon-hitback'), false, id);
  }
});

test('the sixteen-target cap includes immune failures and does not backfill the skipped buff slot', t => {
  t.mock.method(Math, 'random', () => 0.2);
  const targets = Array.from({ length: 17 }, (_, index) => actor(`enemy-${index}`));
  const f = fixture(targets);
  f.conditions.applyState('enemy-0', 'damage-immune', 10000);
  assert.equal(f.start(), 'started');
  f.frame(2);
  assert.deepEqual(
    f.attempts.filter(hit => hit.cueIndex === 0).map(hit => hit.targetId),
    targets.slice(0, 16).map(value => value.id),
  );
  assert.deepEqual(
    f.attempts.filter(hit => hit.cueIndex === 1).map(hit => hit.targetId),
    targets.slice(1, 16).map(value => value.id),
  );
  assert.equal(f.stats.get('enemy-0')!.health, 10000);
  assert.equal(f.stats.get('enemy-16')!.health, 10000);
  assert.equal(f.conditions.hasBuff('enemy-0', 'weapon-hitback'), false);
  assert.equal(f.conditions.hasBuff('enemy-16', 'weapon-hitback'), false);
});

test('misses and final zero damage skip the buff while positive weapon and shield blocks continue', t => {
  t.mock.method(Math, 'random', () => 0.2);
  for (const outcome of ['miss', 'zero', 'weapon-block', 'shield-block'] as const) {
    const f = fixture([actor('enemy')]);
    const target = f.stats.get('enemy')!;
    if (outcome === 'miss') target.evasionBonus = 750;
    else if (outcome === 'zero') target.physicalResistanceBonus = 1000;
    else if (outcome === 'weapon-block') target.weaponBlock = 500;
    else target.shieldBlock = 500;
    assert.equal(f.start(), 'started');
    f.frame(2);
    const positive = outcome === 'weapon-block' || outcome === 'shield-block';
    assert.deepEqual(
      f.hits.map(value => value.hit),
      [{ kind: outcome === 'zero' ? 'hit' : outcome, damage: outcome === 'weapon-block' ? 231 : outcome === 'shield-block' ? 68 : 0 }],
    );
    assert.deepEqual(
      f.attempts.map(hit => hit.cueIndex),
      positive ? [0, 1] : [0],
      outcome,
    );
    assert.equal(f.conditions.hasBuff('enemy', 'weapon-hitback'), positive);
    assert.deepEqual(f.order.slice(-3), ['sound:Wa_Defense', 'effect:hitback-wave:east', 'effect:hitback-wave:default']);
  }
});

test('member and monster consumers halve raw physical and magic sources once before independent unit additions', t => {
  t.mock.method(Math, 'random', () => 0.2);
  const f = fixture([actor('enemy')]);
  assert.equal(f.start(), 'started');
  f.frame(2);
  assert.equal(f.unit('enemy', 'player', 1), 'success');
  for (const id of ['player', 'enemy']) {
    const attributes = f.harness.stats.actorAttributes(id) as CombatActorAttributes;
    assert.equal(attributes.physicalAttack, 50);
    assert.equal(attributes.magicAttack, 101);
    assert.equal(f.harness.stats.actorAttribute(id, 'physicalAttack'), 50);
    assert.equal(f.harness.stats.actorAttribute(id, 'magicAttack'), 101);
    assert.equal(f.harness.stats.actorAttribute(id, 'bestNormalDamage'), 101);
    const fighter = (
      id === 'player' ? f.harness.stats.partyFighter(id) : f.harness.stats.enemyFighter(id, enemyDefinition, 10)
    ) as PhysicalFighter;
    assert.equal(fighter.physicalAttack, 50);
    assert.equal(fighter.magicAttack, 101);
  }
  f.hits.length = 0;
  assert.equal(f.unit('player', 'enemy', 0), 'success');
  assert.equal(f.hits[0].hit.damage, 202, 'trunc((50 + trunc((11*10 + 17*12)/10))*2500/1000), not 330/2');
  assert.equal(f.unit('enemy', 'player', 0), 'success');
  assert.equal(f.hits[1].hit.damage, 125, 'monster source 50 has no member primary-attribute addition');
  assert.deepEqual(f.member.panel.attributes, base.attributes);
  assert.equal(f.member.panel.physicalAttack, 101);
  assert.equal(f.stats.get('enemy')!.physicalAttack, 101);
  assert.equal(f.stats.get('enemy')!.magicAttack, 203);
});

test('newest-first buff operations preserve older additions instead of applying a final damage-halving pass', () => {
  const f = fixture([actor('enemy')]);
  // Isolate shared modifier order; this synthetic probe is not a claim about Guardian's actual attributes.
  const addition: BattleBuffEffect = {
    durationMs: 10000,
    tickMs: 0,
    states: [],
    periodic: [],
    modifiers: [
      { attribute: 'physicalAttack', operation: { kind: 'add', amount: 10 } },
      { attribute: 'magicAttack', operation: { kind: 'add', amount: 10 } },
    ],
  };
  f.conditions.applyBuff('enemy', 'guardian-of-darkness', 1, addition, 'ordering-probe');
  f.apply('enemy');
  assert.equal(f.harness.stats.actorAttribute('enemy', 'physicalAttack'), 60);
  assert.equal(f.harness.stats.actorAttribute('enemy', 'magicAttack'), 111);
  f.conditions.removeBuff('enemy', 'guardian-of-darkness');
  f.conditions.applyBuff('enemy', 'guardian-of-darkness', 1, addition, 'ordering-probe');
  assert.equal(f.harness.stats.actorAttribute('enemy', 'physicalAttack'), 55);
  assert.equal(f.harness.stats.actorAttribute('enemy', 'magicAttack'), 106);
});

test('the real buff host rejects weaker refreshes and removes a refreshed single stack on its sixty-second processing', () => {
  const f = fixture([actor('enemy')]);
  assert.equal(f.apply('enemy', 4, 'first'), true);
  f.conditions.update(30 * 60);
  const before = f.conditions.snapshot('enemy');
  assert.equal(f.apply('enemy', 3, 'weaker'), false);
  assert.deepEqual(f.conditions.snapshot('enemy'), before);
  assert.equal(f.apply('enemy', 4, 'equal'), true);
  assert.deepEqual(f.conditions.snapshot('enemy'), [
    { kind: 'buff', id: 'weapon-hitback', strength: 4009, remainingMs: 3720, sourceId: 'equal', stackCount: 1 },
  ]);
  f.conditions.update(20 * 60);
  assert.equal(f.apply('enemy', 8, 'stronger'), true);
  assert.deepEqual(f.conditions.snapshot('enemy'), [
    { kind: 'buff', id: 'weapon-hitback', strength: 4013, remainingMs: 3720, sourceId: 'stronger', stackCount: 1 },
  ]);
  f.conditions.update(61 * 60);
  assert.equal(f.conditions.hasBuff('enemy', 'weapon-hitback'), true);
  assert.equal(f.harness.stats.actorAttribute('enemy', 'physicalAttack'), 50);
  f.conditions.update(60);
  assert.equal(f.conditions.hasBuff('enemy', 'weapon-hitback'), false);
  assert.equal(f.harness.stats.actorAttribute('enemy', 'physicalAttack'), 101);
  assert.equal(f.harness.stats.actorAttribute('enemy', 'magicAttack'), 203);
});

test('reflected lethal damage waits for both same-frame waves after the complete damage and buff groups', t => {
  t.mock.method(Math, 'random', () => 0.2);
  const f = fixture([actor('first'), actor('second')]);
  f.member.player.health = 30;
  f.conditions.applyState('player', 'stealthed', 10000);
  f.harness.settlement.resolveHitReactions = (event: AttackContact) => {
    if (event.targetId === 'first') {
      f.harness.settlement.settleHit({ casterId: 'first', targetId: 'player' }, { kind: 'hit', damage: 30 });
      assert.equal(f.member.player.health, 0);
      assert.equal(f.resolution.isAwaitingDefeat('player'), true);
    }
  };
  f.setOnMemberDefeated(id => {
    f.order.push(`defeat:${id}`);
    f.fallen.add(id);
    f.visuals.get(id)!.container.active = false;
  });
  const remove = f.conditions.removeState.bind(f.conditions);
  f.conditions.removeState = (id, key) => {
    if (id === 'player' && key === 'stealthed') f.order.push('break-stealth');
    return remove(id, key);
  };
  // No Dark Sense is learned by this warrior; its dispatch hook still runs before sound.
  f.harness.settlement.react = () => {};
  assert.equal(f.start(), 'started');
  f.frame(2);
  assert.deepEqual(f.order, [
    'hit:player:hit:30',
    'hit:first:hit:330',
    'hit:second:hit:330',
    'buff:first',
    'buff:second',
    'break-stealth',
    'sound:Wa_Defense',
    'effect:hitback-wave:east',
    'effect:hitback-wave:default',
    'defeat:player',
  ]);
  assert.equal(f.fallen.has('player'), true);
  const completed = [...f.order];
  f.frame(13);
  assert.deepEqual(f.order, completed);
  assert.equal(f.combat.snapshot().state, 'idle');
  assert.deepEqual(
    f.attempts.map(hit => hit.cueIndex),
    [0, 0, 1, 1],
  );
});

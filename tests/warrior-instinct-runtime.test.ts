import assert from 'node:assert/strict';
import test from 'node:test';
import { CombatController, type CombatPort, type Combatant } from '../src/domain/combat.ts';
import { CombatCooldownStore } from '../src/domain/combat-cooldowns.ts';
import { CombatResourceRecovery } from '../src/domain/combat-resources.ts';
import type { PhysicalHit } from '../src/domain/physical-hit.ts';
import {
  createCombatTestHarness,
  createTestMember,
  loadBattleCatalog,
  loadItemCatalog,
  type TestMemberFixture,
} from './support/combat-test-harness.ts';

const catalog = loadBattleCatalog();
const items = loadItemCatalog();

function fixture() {
  let rank = 1;
  let allyRank = 0;
  let revengeRank = 0;
  let revision = 0;
  const equipment: Record<string, string> = {};
  const equip = (kind: string, slot = 'main-hand') => {
    const id = Object.keys(items.items).find(key => items.items[key].kind === kind && items.items[key].equipment);
    assert.ok(id);
    equipment[slot] = id;
    revision++;
  };
  equip('longsword');
  const configuration = (value: () => number, revenge = () => 0) => ({
    get version() {
      return value() * 100 + revenge();
    },
    resetVersion: 0,
    draft: () => ({ levels: { 'warrior-s-instinct': value(), 'revenge-incarnate': revenge() } }),
  });
  const makeMember = (id: string, value: () => number, revenge?: () => number): TestMemberFixture => {
    const member = createTestMember({
      id,
      classId: 'warrior',
      level: 10,
      panel: { physicalAttack: 100, magicAttack: 50, maxHealth: 1000, maxMana: 100 },
      health: 500,
      maxHealth: 1000,
      mana: 100,
      maxMana: 100,
      bag: {
        get revision() {
          return revision;
        },
        equipmentFor: () => equipment,
        equipmentItems: itemMap => itemMap,
        get: () => undefined,
      },
    });
    member.skills = configuration(value, revenge) as unknown as TestMemberFixture['skills'];
    return member;
  };
  const hero = makeMember('player', () => rank);
  const ally = makeMember('ally', () => allyRank, () => revengeRank);
  const members = new Map([
    ['player', hero],
    ['ally', ally],
  ]);
  const cooldowns = new CombatCooldownStore(() => 25);
  const recovery = new CombatResourceRecovery();
  recovery.advanceToFrame(25, []);
  const partyControllers = new Map<string, CombatController>();
  const harness = createCombatTestHarness({
    battleCatalog: catalog,
    items,
    hero,
    members,
    activeParty: () => ['player', 'ally'],
    party: () => ({ groupModifiers: () => ({}) }) as never,
    settlementOverrides: {
      resetActorCooldowns: id => {
        const controller = partyControllers.get(id);
        if (controller) controller.resetSkillCooldowns();
        else cooldowns.resetActor(id);
      },
      onStateConsequences: () => {},
    },
  });
  harness.settlement.attackProc = () => {};

  const contact = (source = 'player', kind: PhysicalHit['kind'] = 'hit', damageKind: 'physical' | 'magic' = 'physical') =>
    harness.settlement.resolveHitReactions(
      { casterId: source, targetId: source === 'player' ? 'ally' : 'player' },
      { kind, damage: 0 },
      damageKind,
      'basic-attack',
    );
  const seed = (id = 'player') => {
    cooldowns.forActor(id).start('armor-penetration', 100);
    cooldowns.forActor(id).start('blood-thirst', 200);
  };
  return {
    harness,
    hero,
    ally,
    equipment,
    equip,
    conditions: harness.conditions,
    cooldowns,
    recovery,
    partyControllers,
    contact,
    seed,
    learn: (value: number) => {
      rank = value;
    },
    learnAlly: (value: number) => {
      allyRank = value;
    },
    learnRevenge: (value: number) => {
      revengeRank = value;
    },
  };
}

test('all learned ranks use live main-hand two-handed flags and preserve strict thresholds', t => {
  const f = fixture();
  let roll = 1;
  let rolls = 0;
  t.mock.method(Math, 'random', () => {
    rolls++;
    return (roll - 0.5) / 999;
  });
  for (const [index, chance] of [10, 20, 30, 40, 50, 50, 60, 60].entries()) {
    f.learn(index + 1);
    assert.equal(f.harness.stats.actorAttribute('player', 'cooldownResetChance'), chance);
    for (const kind of ['longsword', 'dagger', 'axe', 'mace', 'two-handed', 'bow', 'crossbow', 'staff', 'orb']) {
      f.equip(kind);
      const twoHanded = items.items[f.equipment['main-hand']].equipment!.twoHanded;
      const threshold = twoHanded ? Math.trunc((chance * 15) / 10) : chance;
      // 一次是本项自己的抽签，另一次是残影的无条件抽签。
      f.seed();
      roll = threshold;
      const before = rolls;
      f.contact();
      assert.equal(rolls, before + 2);
      assert.equal(f.cooldowns.forActor('player').isReady('armor-penetration'), false, kind);
      roll = threshold - 1;
      f.contact();
      assert.deepEqual(f.cooldowns.forActor('player').snapshot(), {}, kind);
    }
  }
  f.learn(1);
  delete f.equipment['main-hand'];
  f.equip('two-handed', 'off-hand');
  f.seed();
  roll = 10;
  f.contact();
  assert.equal(f.cooldowns.forActor('player').isReady('armor-penetration'), false);
  roll = 9;
  f.contact();
  assert.deepEqual(f.cooldowns.forActor('player').snapshot(), {});
});

test('the physical success gate and current member attributes isolate cooldown resets', t => {
  for (const damageKind of ['physical', 'magic'] as const) {
    for (const outcome of ['hit', 'critical', 'weapon-block', 'shield-block', 'miss'] as const) {
      const f = fixture();
      f.seed();
      f.seed('ally');
      let rolls = 0;
      t.mock.method(Math, 'random', () => {
        rolls++;
        return 0;
      });
      f.contact('player', outcome, damageKind);
      const accepts = damageKind === 'physical' && outcome !== 'miss';
      // 物理成功还会消耗残影那一次无条件抽签。
      assert.equal(rolls, accepts ? 2 : 0);
      assert.equal(f.cooldowns.forActor('player').isReady('blood-thirst'), accepts);
      assert.equal(f.cooldowns.forActor('ally').isReady('blood-thirst'), false);
    }
  }
  const f = fixture();
  f.learn(0);
  f.learnAlly(8);
  f.seed();
  f.seed('ally');
  t.mock.method(Math, 'random', () => 0);
  f.contact();
  assert.equal(f.cooldowns.forActor('player').isReady('blood-thirst'), false);
  f.contact('ally');
  assert.deepEqual(f.cooldowns.forActor('ally').snapshot(), {});
  f.conditions.setTemporaryAttribute('player', 'cooldownResetChance', 1000);
  f.contact();
  assert.deepEqual(f.cooldowns.forActor('player').snapshot(), {});
});

test('a real multi-hit controller continues its action and publishes cleared cooldowns without repaying mana or moving the recovery clock', t => {
  const f = fixture();
  f.seed();
  f.seed('ally');
  t.mock.method(Math, 'random', () => 0);
  const actors: Combatant[] = [
    { id: 'player', team: 'party', position: { x: 0, y: 0 }, bounds: { x: -4, y: -4, width: 8, height: 8 } },
    { id: 'ally', team: 'enemy', position: { x: 16, y: 0 }, bounds: { x: -4, y: -4, width: 8, height: 8 } },
  ];
  let frame = (_index: number) => {};
  let finish = () => {};
  let cancelled = false;
  let currentFrame = 0;
  let paid = 0;
  const hits: number[] = [];
  const updates: unknown[] = [];
  const port: CombatPort = {
    cooldowns: f.cooldowns.forActor('player'),
    actor: id => actors.find(actor => actor.id === id),
    candidates: () => actors,
    facing: () => 'east',
    moveToward: () => {},
    stop: () => {},
    canStand: () => true,
    relocate: () => {},
    clearEffects: () => {},
    canSpendMana: cost => f.hero.player.mana >= cost,
    spendMana: cost => {
      paid += cost;
      f.hero.player.mana -= cost;
      return true;
    },
    play: (_play, onFrame, onFinish) => {
      frame = onFrame;
      finish = onFinish;
      return () => {
        cancelled = true;
      };
    },
    frame: (play, index, _contact, ready) => {
      currentFrame = index;
      for (const event of play.skill!.action.events) {
        if (event.kind === 'units' && event.frame === index) ready({ event });
      }
    },
    unit: () => {
      hits.push(currentFrame);
      f.contact();
      return 'success';
    },
  };
  const controller = new CombatController('player', null, port);
  f.partyControllers.set('player', controller);
  controller.subscribe(snapshot => updates.push(snapshot));
  const skill = { id: 'swirling-storm', level: 1, manaCost: 60, action: catalog.skills['swirling-storm'].action! };
  const recovery = f.recovery.captureState();
  assert.equal(controller.requestManualSkill(skill, 'ally'), 'started');
  assert.equal(paid, 60);
  frame(3);
  assert.deepEqual(hits, [3]);
  assert.deepEqual(controller.snapshot(), { state: 'attacking', targetId: 'ally', cooldowns: {} });
  assert.deepEqual(updates.at(-1), controller.snapshot());
  assert.equal(controller.requestManualSkill(skill, 'ally'), 'busy');
  frame(15);
  assert.deepEqual(hits, [3, 6, 9, 12, 15]);
  assert.equal(cancelled, false);
  assert.equal(f.hero.player.mana, 40);
  assert.equal(paid, 60);
  assert.deepEqual(f.recovery.captureState(), recovery);
  assert.equal(f.cooldowns.forActor('ally').isReady('blood-thirst'), false);
  finish();
  assert.equal(controller.snapshot().state, 'idle');
  assert.deepEqual(controller.snapshot().cooldowns, {});
});

test('revenge applies before the attacker reset and reflection sees the cleared cooldowns', t => {
  const f = fixture();
  f.learnRevenge(1);
  f.seed();
  const order: string[] = [];
  f.conditions.setTemporaryAttribute('ally', 'moltenReflectionPerThousand', 100);
  t.mock.method(Math, 'random', () => {
    order.push('roll');
    return 0;
  });
  const apply = f.harness.settlement.applyActorBuff.bind(f.harness.settlement);
  f.harness.settlement.applyActorBuff = (targetId, key, rankPriority, effect, sourceId) => {
    order.push(String(key));
    return apply(targetId, key, rankPriority, effect, sourceId);
  };
  const reset = f.cooldowns.resetActor.bind(f.cooldowns);
  f.cooldowns.resetActor = id => {
    order.push(`reset:${id}`);
    reset(id);
  };
  f.harness.settlement.moltenReflection = () => {
    assert.deepEqual(f.cooldowns.forActor('player').snapshot(), {});
    order.push('reflection');
  };
  // 残影的抽签排在防守方复仇之前（原版 17c98c 早于复仇判定）。
  f.contact();
  assert.deepEqual(order, ['roll', 'roll', 'revenge-incarnate', 'roll', 'reset:player', 'reflection']);
});

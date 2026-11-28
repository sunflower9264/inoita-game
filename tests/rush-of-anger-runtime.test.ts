import { dispatchFrame } from './support/combat-driver.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ActionDispatchDefinition, EnemyPlayableSkill } from '../src/domain/battle.ts';
import { BattleCharacter } from '../src/domain/character-stats.ts';
import { CombatConditions } from '../src/domain/combat-conditions.ts';
import { CombatCooldownStore } from '../src/domain/combat-cooldowns.ts';
import { CombatHitResolution } from '../src/domain/combat-hit-resolution.ts';
import { CombatController, type ActionPlayback, type Combatant, type CombatPort, type SkillUnitHit } from '../src/domain/combat.ts';
import type { EquipmentSlot } from '../src/domain/items.ts';
import { NavigationWorld } from '../src/domain/navigation-world.ts';
import type { PhysicalFighter, PhysicalHit } from '../src/domain/physical-hit.ts';
import { Session } from '../src/domain/session.ts';
import { costumeRecipe } from '../src/domain/wardrobe.ts';
import { WorldEnemyRoster } from '../src/domain/world-enemies.ts';
import {
  createCombatTestHarness,
  createTestEnemy,
  createTestMember,
  loadBattleCatalog,
  loadCampaignCatalog,
  loadCharacterStatsCatalog,
  loadCompanionCatalog,
  loadItemCatalog,
  loadWardrobeCatalog,
  type TestMemberBag,
} from './support/combat-test-harness.ts';
import {
  createFakeMovementWorld,
  createFakePhaserScene,
  createTestWorldCombat,
} from './support/world-combat-fixture.ts';

const catalog = loadBattleCatalog();
const wardrobe = loadWardrobeCatalog();
const items = loadItemCatalog();
const skill = catalog.skills['rush-of-anger'];
const primary = { strength: 13, dexterity: 0, vitality: 0, intelligence: 0, mentality: 0 };
const base: PhysicalFighter = {
  level: 10,
  physicalAttack: 101,
  magicAttack: 0,
  maxHealth: 10000,
  hitBase: 100,
  hitBonus: 0,
  evasionBase: 0,
  evasionBonus: 0,
  criticalRate: 0,
  criticalResistance: 0,
  criticalDamage: 0,
  criticalDamageResistance: 0,
  weaponBlock: 0,
  shieldBlock: 0,
  physicalResistance: 0,
  magicResistance: 0,
};
type Entry = 'manual' | 'ai';
type Weapon = 'longsword' | 'two-handed';
// ACT65 公式641：一级 a=1，主角 b=1、佣兵 b=2；STR权重先截断。
const firstRankDamage = (entry: Entry) =>
  Math.trunc(((101 + Math.trunc((13 * 12) / 10)) * Math.trunc((4000 + (1 + 20 * (entry === 'manual' ? 1 : 2)) * 10) / 2)) / 1000);

function fixture(entry: Entry, weapon: Weapon, canStand: (position: { x: number; y: number }) => boolean = () => true) {
  const casterId = entry === 'manual' ? 'player' : 'ally';
  const weaponId = Object.keys(items.items).find(id => items.items[id].kind === weapon && wardrobe.equipment[id]);
  assert.ok(weaponId, `missing ${weapon} equipment source`);
  const equipment: Partial<Record<EquipmentSlot, string>> = { 'main-hand': weaponId };
  const recipe = costumeRecipe(wardrobe, items, equipment, 'warrior');
  const caster: Combatant = { id: casterId, team: 'party', position: { x: 0, y: 0 }, bounds: { x: -4, y: -4, width: 8, height: 8 } };
  const target: Combatant = { ...caster, id: 'enemy', team: 'hostile', position: { x: 16, y: 0 } };
  const actors = new Map([caster, target].map(actor => [actor.id, actor]));
  const conditions = new CombatConditions();
  const resolution = new CombatHitResolution();
  const targetFighter = { ...base };
  const hits: PhysicalHit[] = [];
  const attempts: SkillUnitHit[] = [];
  const played: ActionPlayback[] = [];
  const events: string[] = [];
  const sounds: string[] = [];
  const relocations: { x: number; y: number }[] = [];
  const configuration = {
    version: 1,
    resetVersion: 0,
    isEquipped: (id: string) => id === skill.id,
    draft: () => ({ levels: { [skill.id]: 1 } }),
  };
  const bag: TestMemberBag = {
    revision: 0,
    equipmentFor: () => equipment as Record<string, string | undefined>,
    equipmentItems: (value = equipment) => value as Record<string, string | undefined>,
    get: (id: string) => ({ id, item: id, quantity: 1, enhancement: 0, gems: [] }),
  };
  const member = createTestMember({
    id: casterId,
    classId: 'warrior',
    level: 10,
    health: 10000,
    maxHealth: 10000,
    mana: 100,
    maxMana: 100,
    panel: { ...base, baseDefense: 0, defenseRate: 0, baseMagicResistance: 0, attributes: primary },
    bag,
  });
  Object.assign(member, { skills: configuration });
  // The AI member owns its attributes; the controlled hero has deliberately different damage.
  const hero =
    entry === 'manual'
      ? member
      : createTestMember({
          id: 'player',
          classId: 'warrior',
          level: 10,
          health: 10000,
          maxHealth: 10000,
          mana: 100,
          maxMana: 100,
          panel: { ...base, baseDefense: 0, defenseRate: 0, baseMagicResistance: 0, physicalAttack: 999, attributes: { ...primary, strength: 99 } },
          bag,
        });
  const normalEnemy = catalog.enemies.find(entry => entry.acceptsBuffs !== false && !entry.stateRules?.immuneToAllStates)!;
  const enemy = createTestEnemy({
    key: 'enemy',
    definition: normalEnemy,
    health: 10000,
    maxHealth: 10000,
    level: 10,
  });
  const harness = createCombatTestHarness({
    battleCatalog: catalog,
    wardrobe,
    items,
    conditions,
    hitResolution: resolution,
    hero,
    members: new Map([[casterId, member]]),
    enemies: new Map([['enemy', enemy]]),
    activeParty: () => (entry === 'manual' ? ['player'] : ['player', 'ally']),
    controlledId: () => casterId,
    sessionSkills: () => configuration as never,
    party: () => ({ groupModifiers: () => ({}), groupModifierVersion: 0 }) as never,
    combatants: () => [...actors.values()],
    combatant: id => actors.get(id),
    settlementOverrides: {
      onActionShake: () => events.push('shake'),
      onActionSound: (_id, name) => {
        sounds.push(name);
        events.push(`sound:${name}`);
      },
      onStateConsequences: (id, states) => events.push(`state:${id}:${states.join(',')}`),
      onShowHit: (_hit, value) => {
        hits.push(value);
        events.push(`hit:${value.kind}:${value.damage}`);
      },
    },
  });
  harness.stats.enemyFighter = () => targetFighter;
  harness.settlement.resolveHitReactions = () => {};
  harness.settlement.settleHit = (_hit, value) => {
    hits.push(value);
    events.push(`hit:${value.kind}:${value.damage}`);
  };
  const presenter = {
    pose: () => {},
    candidates: () => [...actors.values()],
    visual: (id: string) => {
      const actor = actors.get(id);
      return actor ? { container: { active: true, ...actor.position } } : undefined;
    },
    placedEffect: () => {},
    scene: {
      events: {
        emit: (name: string, event: { name: string; recipientId: string }) => {
          if (name === 'skill-effect') events.push(`effect:${event.name}:${event.recipientId}`);
        },
      },
    },
  };
  const showUnitFeedback = (hit: SkillUnitHit, outcome: 'success' | 'failure' | 'skipped', cue: { unitFeedbackPolicy?: string; effects: readonly { effect: string; recipient: string }[] }) => {
    if (outcome === 'skipped' || (outcome === 'failure' && cue.unitFeedbackPolicy !== 'always')) return;
    for (const visual of cue.effects) {
      const recipientId = visual.recipient === 'caster' ? hit.casterId : hit.targetId;
      if (actors.has(recipientId)) events.push(`effect:${visual.effect}:${recipientId}`);
    }
  };
  let frame = (_index: number) => {};
  let spent = 0;
  const port: CombatPort = {
    cooldowns: new CombatCooldownStore(() => 0).forActor(casterId),
    actor: id => actors.get(id),
    candidates: () => [...actors.values()],
    facing: () => 'east',
    moveToward: () => assert.fail('nearby target should not require approach'),
    stop: () => {},
    canStand,
    // 位移技能只认整盒判定；夹具把同一谓词当作整盒可站性。
    canPlaceBody: canStand,
    relocate: position => {
      relocations.push({ ...position });
      caster.position = { ...position };
    },
    clearEffects: () => {},
    canSpendMana: cost => member.player.mana >= cost,
    spendMana: cost => {
      spent += cost;
      member.player.mana -= cost;
      return true;
    },
    play: (action, onFrame) => {
      played.push(action);
      frame = onFrame;
      return () => {};
    },
    frame: (action, index, contact, ready, area) =>
      dispatchFrame(
        presenter,
        action,
        index,
        contact,
        ready,
        () => {},
        (definition: ActionDispatchDefinition, work: () => void, after?: () => void) =>
          harness.settlement.runActionDispatch(action, definition, work, after),
        area,
      ),
    prepareUnit: event => harness.settlement.prepareSkillUnit(event),
    runUnitSequence: work => resolution.run(work),
    unit: hit => {
      attempts.push(hit);
      return harness.settlement.skillUnit(hit);
    },
    unitFeedback: (hit, outcome, cue) => showUnitFeedback(hit, outcome, cue),
  };
  const combat = new CombatController(casterId, null, port);
  const start = () => {
    if (entry === 'manual') {
      const selected = recipe.actions[skill.id] ?? skill.action!;
      const action = {
        ...selected,
        hitEffectStyle: skill.action!.hitEffectStyle,
        usesSkillDamageBuff: skill.action!.usesSkillDamageBuff,
        combatUnits: skill.action!.combatUnits,
        repeat: skill.action!.repeat
          ? { ...skill.action!.repeat, restartAfterFrame: selected.repeat?.restartAfterFrame ?? skill.action!.repeat.restartAfterFrame }
          : undefined,
      };
      const manaCost = harness.stats.skillManaCost(casterId, skill.id, 1);
      assert.equal(combat.requestManualSkill({ id: skill.id, action, level: 1, manaCost }, 'enemy'), 'started');
    } else {
      const available = harness.stats.partySkillsFor(casterId) as EnemyPlayableSkill[];
      const selected = available.find(value => value.id === skill.id);
      assert.ok(selected);
      assert.equal(combat.request(selected, 'enemy'), 'started');
    }
    assert.equal(combat.snapshot().state, 'attacking');
    assert.equal(played.length, 1);
  };
  return {
    entry,
    weapon,
    casterId,
    recipe,
    conditions,
    target,
    targetFighter,
    hits,
    attempts,
    played,
    events,
    sounds,
    relocations,
    combat,
    member,
    start,
    fire: () => {
      frame(3);
      frame(3);
    },
    spent: () => spent,
    injectSkillBonus: () => {
      // Controlled assembly probe: this does not claim a warrior can normally learn Dark Strike.
      const unit = catalog.skills['dark-strike'].action!.combatUnits!.find(unitEntry => unitEntry.effect === 'buff');
      assert.ok(unit?.effect === 'buff');
      const rank = unit.ranks[0];
      conditions.applyBuff(casterId, 'dark-strike', rank.strength, rank.effect, 'test-probe');
    },
  };
}

function quietWarriorWorldSetup(weapon: Weapon = 'longsword') {
  const characterStats = loadCharacterStatsCatalog();
  const campaign = loadCampaignCatalog();
  const companions = loadCompanionCatalog();
  const baseEnemy = catalog.enemies.find(e => e.acceptsBuffs !== false && !e.stateRules?.immuneToAllStates && e.level === 10 && !!e.actor.collision)!;
  const quietEnemy = {
    ...baseEnemy,
    actor: { ...baseEnemy.actor, clips: {} },
    basicAttack: null,
    skills: [],
    behavior: { ...baseEnemy.behavior, aggression: 'none' as const, canMove: false, wander: undefined },
  };
  const quietCatalog = {
    ...catalog,
    enemies: catalog.enemies.map(e => (e.id === quietEnemy.id ? quietEnemy : e)),
  };
  const weaponId = Object.keys(items.items).find(id => items.items[id].kind === weapon && wardrobe.equipment[id]);
  assert.ok(weaponId, `missing ${weapon} equipment source`);
  const hero = new BattleCharacter('warrior', characterStats, items);
  hero.restoreState({ ...hero.captureState(), level: 10 });
  hero.recover();
  hero.bag.addEquipped(weaponId, 'main-hand', 'player', 'warrior');
  const session = new Session(campaign, undefined, undefined, items, hero, quietCatalog, characterStats, companions);
  session.skills.restoreState({ loadouts: [['warrior', { levels: { [skill.id]: 1 } }]], pages: [] });
  session.skills.bar().assign(0, 1, { kind: 'skill', id: skill.id });
  const map = {
    id: 'test-map',
    name: 'test-map',
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
  const roster = new WorldEnemyRoster(session, map, []);
  const placed = roster.placeEnemy(quietEnemy.id, 88, 64);
  return { quietCatalog, hero, session, map, roster, placed };
}

function feedbackPhaserScene() {
  const phaserScene = createFakePhaserScene({
    cameras: { main: { width: 640, height: 360, zoomX: 1, zoomY: 1, worldView: undefined, followOffset: { x: 0, y: 0 }, setFollowOffset() {} } },
    tweens: { add: () => ({ stop() {}, pause() {}, resume() {} }), getTweensOf: () => [], killTweensOf: () => {} },
  });
  const baseSprite = phaserScene.add.sprite;
  phaserScene.add.sprite = ((...args: Parameters<typeof baseSprite>) => {
    const sprite = baseSprite(...args);
    sprite.scene = phaserScene;
    return sprite;
  }) as typeof baseSprite;
  return phaserScene;
}

test('manual and AI equipment entries resolve Rush of Anger damage, target aura and stun through the real dispatch', t => {
  t.mock.method(Math, 'random', () => 0.2);
  for (const entry of ['manual', 'ai'] as const) {
    for (const weapon of ['longsword', 'two-handed'] as const) {
      const f = fixture(entry, weapon);
      f.start();
      const action = f.played[0].skill!.action;
      assert.equal(action.usesSkillDamageBuff, true);
      if (entry === 'manual') assert.deepEqual(action.events, (f.recipe.actions[skill.id] ?? skill.action!).events);
      assert.equal(f.spent(), 40);
      assert.equal(f.member.player.mana, 60);
      assert.equal(f.combat.snapshot().cooldowns[skill.id].remainingMs, 3600);
      f.fire();
      assert.deepEqual(f.hits, [{ kind: 'hit', damage: firstRankDamage(entry) }], `${entry}/${weapon}`);
      assert.deepEqual(
        f.attempts.map(hit => [hit.cueIndex, hit.casterId, hit.targetId]),
        [
          [0, f.casterId, 'enemy'],
          [1, f.casterId, 'enemy'],
        ],
      );
      assert.equal(f.conditions.hasState('enemy', 'stun'), true);
      assert.equal(f.conditions.hasState(f.casterId, 'stun'), false);
      assert.deepEqual(f.events.slice(0, 3), [`hit:hit:${firstRankDamage(entry)}`, 'effect:rage-aura:enemy', 'state:enemy:stun']);
      // 佣兵和主角同属玩家阵营：技能派发音效不只给当前操控角色。
      assert.deepEqual(f.sounds, ['Wa_Anger_Rush']);
    }
  }
});

test('equipment merges retain and consume the skill bonus for both manual and AI paths', t => {
  t.mock.method(Math, 'random', () => 0.2);
  for (const entry of ['manual', 'ai'] as const) {
    for (const weapon of ['longsword', 'two-handed'] as const) {
      const f = fixture(entry, weapon);
      f.injectSkillBonus();
      f.start();
      f.fire();
      assert.equal(f.played[0].skill!.action.usesSkillDamageBuff, true);
      assert.deepEqual(
        f.hits,
        [{ kind: 'hit', damage: Math.trunc((firstRankDamage(entry) * 1210) / 1000) }],
        `${entry}/${weapon}: own growth then 210-per-thousand probe bonus`,
      );
      assert.equal(f.conditions.hasBuff(f.casterId, 'dark-strike'), false);
    }
  }
});

test('misses and non-miss zero damage skip Rush of Anger aura and the later stun', t => {
  t.mock.method(Math, 'random', () => 0.2);
  for (const entry of ['manual', 'ai'] as const) {
    for (const outcome of ['miss', 'zero'] as const) {
      const f = fixture(entry, entry === 'manual' ? 'longsword' : 'two-handed');
      f.injectSkillBonus();
      if (outcome === 'miss') f.targetFighter.evasionBonus = 750;
      else f.targetFighter.physicalResistance = 1000;
      f.start();
      f.fire();
      assert.deepEqual(f.hits, [{ kind: outcome === 'miss' ? 'miss' : 'hit', damage: 0 }]);
      assert.deepEqual(
        f.attempts.map(hit => hit.cueIndex),
        [0],
      );
      assert.equal(f.conditions.hasState('enemy', 'stun'), false);
      assert.equal(
        f.events.some(event => event.startsWith('effect:')),
        false,
      );
      assert.equal(f.conditions.hasBuff(f.casterId, 'dark-strike'), outcome === 'miss');
      assert.ok(f.events.includes('shake'));
    }
  }
});

test('positive weapon and shield blocks still emit the target aura and apply stun', t => {
  t.mock.method(Math, 'random', () => 0.2);
  for (const block of ['weapon-block', 'shield-block'] as const) {
    const f = fixture(block === 'weapon-block' ? 'manual' : 'ai', block === 'weapon-block' ? 'longsword' : 'two-handed');
    if (block === 'weapon-block') f.targetFighter.weaponBlock = 500;
    else f.targetFighter.shieldBlock = 500;
    f.start();
    f.fire();
    // 佣兵基础 255，盾挡减伤 floor(1000*1000/1260)=793‰，得到 52。
    assert.deepEqual(f.hits, [{ kind: block, damage: block === 'weapon-block' ? 170 : 52 }]);
    assert.deepEqual(
      f.attempts.map(hit => hit.cueIndex),
      [0, 1],
    );
    assert.equal(f.conditions.hasState('enemy', 'stun'), true);
    assert.ok(f.events.includes('effect:rage-aura:enemy'));
  }
});

test('a second active skill input is ignored before it reaches the runtime while the first is playing', async t => {
  t.mock.method(Math, 'random', () => 0.2);
  const { quietCatalog, hero, session, map, roster, placed } = quietWarriorWorldSetup('longsword');
  const sounds: string[] = [];
  const emittedEffects: string[] = [];
  const world = await createTestWorldCombat({
    battleCatalog: quietCatalog,
    hero,
    session,
    map,
    roster,
    phaserScene: feedbackPhaserScene(),
    appOverrides: {
      audio: {
        prepareCombat: async () => {},
        effect: (name: string) => sounds.push(name),
        playerSkill: () => {},
        playerHit: () => {},
        shieldBlock: () => {},
        monsterAttack: () => {},
        monsterDeath: () => {},
        periodicDamage: () => {},
        playerLevelUp: () => {},
        ui: () => {},
      } as never,
    },
  });
  world.phaserScene.events.on('skill-effect', (ev: { name: string; recipientId: string }) => {
    emittedEffects.push(`${ev.name}:${ev.recipientId}`);
  });
  await world.combat.start();
  world.combat.selectEnemy(placed.key);
  const manaBefore = hero.player.mana;
  const request = t.mock.method(CombatController.prototype, 'requestManualSkill');
  world.combat.attack(skill.id);
  assert.equal(world.combat.castingSkill, true);
  assert.equal(world.combat.cooldowns[skill.id].remainingMs, 3600);
  assert.equal(request.mock.callCount(), 1);
  world.combat.attack(skill.id);
  assert.equal(request.mock.callCount(), 1, '技能播放期间不再提交第二个技能请求');

  for (let i = 0; i < 3; i++) world.combat.update(60, true);
  assert.equal(hero.player.mana, manaBefore - 40);
  assert.equal(world.combat.cooldowns[skill.id].remainingMs, 3420);
  assert.ok(emittedEffects.includes('rage-aura:enemy-1'));
  assert.deepEqual(sounds, ['Wa_Anger_Rush']);
  world.combat.destroy();
});

test('a close charge advances to the farthest standable point before the obstacle', t => {
  t.mock.method(Math, 'random', () => 0.2);
  // 8px 冲刺的终点被挡住，但前方 5px 还能站：冲到 5px 停下，而不是整段跳过。
  const f = fixture('manual', 'longsword', position => position.x <= 5);
  assert.doesNotThrow(() => {
    f.start();
    f.fire();
  });
  // 到达帧仍按原样落到保存的目的地 (0,0)。
  assert.deepEqual(f.relocations, [
    { x: 5, y: 0 },
    { x: 0, y: 0 },
  ]);
  assert.deepEqual(f.hits, [{ kind: 'hit', damage: firstRankDamage('manual') }]);
  assert.ok(f.played.length === 1);
});

test('a close charge whose whole lunge path is blocked stays in place instead of throwing', t => {
  t.mock.method(Math, 'random', () => 0.2);
  const f = fixture('manual', 'longsword', position => position.x === 0 && position.y === 0);
  assert.doesNotThrow(() => {
    f.start();
    f.fire();
  });
  assert.deepEqual(f.relocations, [{ x: 0, y: 0 }]);
  assert.deepEqual(f.hits, [{ kind: 'hit', damage: firstRankDamage('manual') }]);
});

test('a skill relocation blocked for the whole body stays put instead of teleporting elsewhere', async t => {
  t.mock.method(Math, 'random', () => 0.2);
  const { quietCatalog, hero, session, map, roster, placed } = quietWarriorWorldSetup('longsword');
  const navigation = new NavigationWorld(map);
  const movement = createFakeMovementWorld(navigation);
  let blockOriginReturn = false;
  const baseCanPlaceBody = navigation.canPlaceBody.bind(navigation);
  navigation.canPlaceBody = (shape, point, ignore, extra) => {
    if (blockOriginReturn && point.x === 64 && point.y === 64) return false;
    return baseCanPlaceBody(shape, point, ignore, extra);
  };
  const world = await createTestWorldCombat({
    battleCatalog: quietCatalog,
    hero,
    session,
    map,
    roster,
    movement,
  });
  await world.combat.start();
  world.combat.selectEnemy(placed.key);
  world.combat.attack(skill.id);
  const lunged = movement.position(world.playerVisual);
  assert.deepEqual(lunged, { x: 72, y: 64 });

  blockOriginReturn = true;
  const movesBeforeArrival = movement.moved.length;
  world.combat.update(60, true);
  world.combat.update(60, true);
  assert.equal(movement.moved.length, movesBeforeArrival, '整盒站不下时保持原位，不到目标点附近迁就');
  assert.deepEqual(movement.position(world.playerVisual), { x: 72, y: 64 });
  assert.deepEqual(world.combat.diagnostics().relocationFailures, [{ id: 'player', position: { x: 64, y: 64 } }]);

  const saved = world.combat.captureState();
  saved.party[0]!.position = { x: 67, y: 68 };
  await world.combat.restoreState(saved);
  assert.deepEqual(movement.position(world.playerVisual), { x: 67, y: 68 }, '复核通过的保底落点仍然生效');
  world.combat.destroy();
});

test('the current target remains the recipient when it moves beyond the cue range after charge starts', t => {
  t.mock.method(Math, 'random', () => 0.2);
  const f = fixture('manual', 'longsword');
  f.start();
  f.target.position = { x: 1000, y: 0 };
  f.fire();
  assert.deepEqual(f.hits, [{ kind: 'hit', damage: 244 }]);
  assert.deepEqual(
    f.attempts.map(hit => hit.targetId),
    ['enemy', 'enemy'],
  );
  assert.equal(f.conditions.hasState('enemy', 'stun'), true);
  assert.ok(f.events.includes('effect:rage-aura:enemy'));
});

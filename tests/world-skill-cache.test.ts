import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { BattleCharacter } from '../src/domain/character-stats.ts';
import { CombatConditions } from '../src/domain/combat-conditions.ts';
import { resolveHitReactionPipeline, type HitReactionPort } from '../src/domain/combat-reaction-pipeline.ts';
import { NavigationWorld } from '../src/domain/navigation-world.ts';
import { Session } from '../src/domain/session.ts';
import type { SkillReactionEvent } from '../src/domain/skill-reactions.ts';
import { playerCombatAssets } from '../src/rendering/combat-assets.ts';
import { loadSceneAssets, missingSceneAssets } from '../src/rendering/scene-assets.ts';
import {
  createCombatTestHarness,
  createTestMember,
  loadBattleCatalog,
  loadCampaignCatalog,
  loadCharacterStatsCatalog,
  loadCompanionCatalog,
  loadItemCatalog,
  loadWardrobeCatalog,
} from './support/combat-test-harness.ts';
import {
  createFakeContainer,
  createFakeMovementWorld,
  createFakePhaserScene,
  createTestWorldCombat,
  installPhaserStubHooks,
} from './support/world-combat-fixture.ts';

const phaserHook = installPhaserStubHooks();
const { CombatSkillAssetManager } = await import('../src/scenes/combat-skill-assets.ts');
const { CombatStatusVisuals } = await import('../src/rendering/combat-status-visuals.ts');
const { StateMarkers } = await import('../src/rendering/state-markers.ts');
const { StatusColorRenderer } = await import('../src/rendering/status-color.ts');
phaserHook.deregister();

function domainFixture() {
  const battle = loadBattleCatalog();
  const items = loadItemCatalog();
  const statsCatalog = loadCharacterStatsCatalog();
  const campaign = loadCampaignCatalog();
  const hero = new BattleCharacter('dark-knight', statsCatalog, items);
  const session = new Session(campaign, undefined, undefined, items, hero, battle);
  const harness = createCombatTestHarness({
    battleCatalog: battle,
    characterStats: statsCatalog,
    items,
    hero,
    members: new Map([['player', hero]]),
    sessionSkills: () => session.skills,
    activeParty: () => ['player'],
  });
  return { session, hero, harness };
}

test('mercenary skill reset cancels only its actor and refreshes prepared skills', async () => {
  const battle = loadBattleCatalog();
  const items = loadItemCatalog();
  const statsCatalog = loadCharacterStatsCatalog();
  const campaign = loadCampaignCatalog();
  const companions = loadCompanionCatalog();
  const hero = new BattleCharacter('dark-knight', statsCatalog, items);
  const session = new Session(campaign, undefined, undefined, items, hero, battle, statsCatalog, companions);
  const recruit = () => {
    session.bag.add('mercenary-emblem-black-knight');
    return session.party!.recruit(session.bag.entries.find(entry => entry.item === 'mercenary-emblem-black-knight')!.id, () => 0).member;
  };
  const first = recruit();
  const second = recruit();
  session.party!.deployFirstAvailable(first.id);
  session.party!.deployFirstAvailable(second.id);

  first.skills.maxAll(battle, first.classId);
  hero.grantSkillPoint();
  session.skills.maxAll();
  const navigation = new NavigationWorld({ name: 'reset-map', tileSize: 16, columns: 20, rows: 20, blocked: Array<boolean>(400).fill(false) });
  const movement = createFakeMovementWorld(navigation);
  const actor = battle.classes.find(entry => entry.id === 'dark-knight')!.actor;
  const preparedMembers: string[] = [];
  let preparePlayerCalls = 0;
  const world = await createTestWorldCombat({
    hero,
    session,
    movement,
    appOverrides: {
      world: {
        actors: { [first.definition.actor]: actor, [second.definition.actor]: actor, [actor.id]: actor },
      } as never,
    },
    sceneOverrides: {
      preparePlayerAppearance: async () => { preparePlayerCalls++; },
      preparePartyMember: async id => { preparedMembers.push(id); },
    },
  });
  await world.combat.start();
  const initialPlayerPrepared = preparePlayerCalls;
  const initialMembersCount = preparedMembers.length;
  // 清掉某一名佣兵的技能配置，验证只刷对应成员，不波及另一名未改动的佣兵。
  first.skills.reset();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(preparedMembers.slice(initialMembersCount), [first.id]);
  first.skills.reset();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(preparedMembers.slice(initialMembersCount).length, 1, '同一初始化不重复刷新');
  session.skills.reset();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(preparePlayerCalls, initialPlayerPrepared + 1);
  world.combat.destroy();
});

test('equipment effects share one read per member and follow changes to socketed gems', t => {
  const { hero, harness } = domainFixture();
  const bag = hero.bag;
  const weapon = bag.equipment['main-hand']!;
  const reads = t.mock.method(bag, 'equipmentFor');
  const first = harness.stats.equipmentEffects('player');
  assert.equal(harness.stats.combatProcs('player'), first.combat);
  assert.equal(harness.stats.equipmentRecovery('player'), first.recovery);
  assert.equal(reads.mock.callCount(), 1);
  const state = bag.captureState();
  const entry = state.instances.find(item => item.id === weapon)!;
  entry.numbers!.gemModifiers = [...entry.numbers!.gemModifiers, { stat: 'fire', value: 7 }];
  bag.restoreUnchecked(state);
  const next = harness.stats.equipmentEffects('player');
  assert.equal(next.attack.fireSplashChance, first.attack.fireSplashChance + 7);
  assert.equal(harness.stats.equipmentEffects('player'), next);
});

test('party passives are reused until a real input changes', t => {
  const { session, hero, harness } = domainFixture();
  const equipment = t.mock.method(hero.bag, 'equipmentItems');
  const before = session.skills.draftCalls;
  const first = harness.stats.partyPassives('player');
  const afterFirst = session.skills.draftCalls;
  assert.equal(afterFirst, before + 1, '第一次计算要读一次技能配置');
  assert.equal(equipment.mock.callCount(), 1);

  const second = harness.stats.partyPassives('player');
  assert.equal(session.skills.draftCalls, afterFirst, '输入没变时不再克隆技能配置');
  assert.equal(second, first, '命中缓存时返回同一份只读结果');
  assert.equal(equipment.mock.callCount(), 1, '缓存命中时不重新整理装备');

  t.mock.method(harness.conditions, 'hasState', () => true);
  harness.stats.partyPassives('player');
  assert.equal(session.skills.draftCalls, afterFirst + 1, '潜行状态变化会失效一次');
  assert.equal(equipment.mock.callCount(), 2);

  hero.bag.add('healing-potion-s');
  harness.stats.partyPassives('player');
  assert.equal(equipment.mock.callCount(), 3, '背包变化后重新检查装备');
});

test('ordinary hit reactions reuse one skill description without cloning buff snapshots', t => {
  const battle = loadBattleCatalog();
  const items = loadItemCatalog();
  const statsCatalog = loadCharacterStatsCatalog();
  const campaign = loadCampaignCatalog();
  const hero = new BattleCharacter('dark-knight', statsCatalog, items);
  const session = new Session(campaign, undefined, undefined, items, hero, battle);
  const conditions = new CombatConditions();
  const harness = createCombatTestHarness({
    battleCatalog: battle,
    characterStats: statsCatalog,
    items,
    hero,
    members: new Map([['player', hero]]),
    sessionSkills: () => session.skills,
    conditions,
    activeParty: () => ['player'],
  });
  t.mock.method(conditions, 'buffReactions', () => assert.fail('命中结算只读内部视图，不生成隔离副本'));
  let draws = 0;
  t.mock.method(Math, 'random', () => { draws++; return 0.999; });
  const no = () => {};
  const port: HitReactionPort = {
    conditions,
    actorAttribute: () => 0,
    react: event => harness.settlement.react(event),
    reactToBuff: event => harness.settlement.reactToBuff(event),
    lightningOfHellReaction: no,
    godOfJusticeReaction: no,
    summonOwnerReactions: no,
    disturbanceReaction: no,
    partySide: () => false,
    activePartySlots: () => ['player'],
    partyRevengeReactions: no,
    equipmentRecovery: () => ({ lifeDrainPerThousand: 0 }),
    physicalSuccessEquipmentProcs: no,
    instantRecoveryOnMiss: no,
    isTwoHanded: () => false,
    moltenReflection: no,
    holySacrificeTransfer: no,
    attackProc: no,
  };
  const before = session.skills.draftCalls;
  const hit = () => resolveHitReactionPipeline({ casterId: 'player', targetId: 'enemy' }, { kind: 'hit', damage: 12 }, 'physical', 'basic-attack', port);
  hit();
  assert.equal(session.skills.draftCalls, before + 1, '一击的三个技能反应阶段共用一份配置');
  for (let index = 0; index < 10; index++) hit();
  assert.equal(session.skills.draftCalls, before + 1, '后续命中没有配置变化时继续复用');
  assert.equal(draws, 11, '未学残影的每次物理命中仍按原顺序消耗一次随机数');
});

test('reaction skill descriptions follow configuration and asset readiness rather than health or stealth', t => {
  const prepared = new Map<string, Set<string>>();
  const { session, hero, harness } = (() => {
    const battle = loadBattleCatalog();
    const items = loadItemCatalog();
    const statsCatalog = loadCharacterStatsCatalog();
    const campaign = loadCampaignCatalog();
    const h = new BattleCharacter('dark-knight', statsCatalog, items);
    const s = new Session(campaign, undefined, undefined, items, h, battle);
    const initial = s.skills.draft(battle, 'dark-knight');
    prepared.set('player', new Set(Object.keys(initial.levels)));
    const c = createCombatTestHarness({
      battleCatalog: battle,
      characterStats: statsCatalog,
      items,
      hero: h,
      members: new Map([['player', h]]),
      sessionSkills: () => s.skills,
      preparedSkills: id => prepared.get(id),
      requiresPreparedSkills: true,
    });
    return { session: s, hero: h, harness: c };
  })();

  const catalog = harness.battleCatalog;
  const initial = session.skills.draft(catalog, 'dark-knight');
  const first = harness.stats.reactionSkills('player')!;
  const before = session.skills.draftCalls;
  hero.setHealth(Math.max(1, hero.player.health - 1));
  t.mock.method(harness.conditions, 'hasState', () => true);
  assert.equal(harness.stats.reactionSkills('player'), first);
  assert.equal(session.skills.draftCalls, before, '生命和潜行不会重建静态反应定义');

  const learned = { levels: { ...initial.levels, 'soul-sword': 1, 'dark-strike': 1 } };
  prepared.set('player', new Set(['guardian-of-darkness']));
  session.skills.restoreState({ loadouts: [['dark-knight', learned]], pages: [] });
  const waiting = harness.stats.reactionSkills('player')!;
  assert.equal(waiting.loadout.levels['soul-sword'], 0);
  assert.equal(waiting.reactions.some(reaction => reaction.kind === 'soul-sword'), false);
  prepared.set('player', new Set(Object.keys(learned.levels)));
  const ready = harness.stats.reactionSkills('player')!;
  assert.equal(ready.loadout.levels['soul-sword'], 1);
  assert.ok(ready.reactions.some(reaction => reaction.kind === 'soul-sword'));
  assert.equal(session.skills.draft(catalog, 'dark-knight').levels['soul-sword'], 1, '素材过滤没有改写真实技能进度');
  assert.equal(harness.stats.reactionSkills('player'), ready);

  session.skills.reset();
  assert.equal(harness.stats.reactionSkills('player')!.loadout.levels['soul-sword'], 0);
  session.skills.restoreState({ loadouts: [['dark-knight', learned]], pages: [] });
  assert.equal(harness.stats.reactionSkills('player')!.loadout.levels['soul-sword'], 1);
  const old = harness.stats.reactionSkills('player');
  harness.stats.forgetMemberCaches('player');
  assert.notEqual(harness.stats.reactionSkills('player'), old, '成员离场清掉持有的定义');
});

test('cached reactions read a child buff rank after the probability draw', t => {
  const { session, harness } = (() => {
    const battle = loadBattleCatalog();
    const items = loadItemCatalog();
    const statsCatalog = loadCharacterStatsCatalog();
    const campaign = loadCampaignCatalog();
    const h = new BattleCharacter('dark-knight', statsCatalog, items);
    const s = new Session(campaign, undefined, undefined, items, h, battle);
    const initial = s.skills.draft(battle, 'dark-knight');
    const levels = { ...initial.levels, 'soul-sword': 1, 'dark-strike': 1 };
    s.skills.restoreState({ loadouts: [['dark-knight', { levels }]], pages: [] });
    const prepared = new Map([['player', new Set(Object.keys(levels))]]);
    const c = createCombatTestHarness({
      battleCatalog: battle,
      characterStats: statsCatalog,
      items,
      hero: h,
      members: new Map([['player', h]]),
      sessionSkills: () => s.skills,
      preparedSkills: prepared,
      requiresPreparedSkills: true,
    });
    return { session: s, harness: c };
  })();
  const catalog = harness.battleCatalog;
  const initial = session.skills.draft(catalog, 'dark-knight');
  const levels = { ...initial.levels, 'soul-sword': 1, 'dark-strike': 1 };
  const applied: Array<{ priority: number; effect: unknown }> = [];
  t.mock.method(harness.settlement, 'applyActorBuff', (_target: string, _key: string, priority: number, effect: unknown) => {
    applied.push({ priority, effect });
    return true;
  });
  t.mock.method(Math, 'random', () => {
    session.skills.restoreState({ loadouts: [['dark-knight', { levels: { ...levels, 'dark-strike': 8 } }]], pages: [] });
    return 0;
  });
  harness.settlement.react({
    kind: 'attack-success',
    ownerId: 'player',
    opponentId: 'enemy',
    damageKind: 'physical',
    outcome: 'hit',
    hitDamage: 10,
    otherLifeDrainPerThousand: 0,
  });
  const unit = catalog.skills['dark-strike'].action!.combatUnits!.find(entry => entry.effect === 'buff');
  assert.ok(unit?.effect === 'buff');
  assert.deepEqual(applied, [{ priority: unit.ranks[7].strength, effect: unit.ranks[7].effect }]);
});

test('skill asset refresh uses cheap gates and ignores health changes', async t => {
  const battle = loadBattleCatalog();
  const items = loadItemCatalog();
  const wardrobe = loadWardrobeCatalog();
  const statsCatalog = loadCharacterStatsCatalog();
  const campaign = loadCampaignCatalog();
  const hero = new BattleCharacter('dark-knight', statsCatalog, items);
  const session = new Session(campaign, undefined, undefined, items, hero, battle);
  const phaserScene = createFakePhaserScene();
  const actor = battle.classes.find(entry => entry.id === 'dark-knight')!.actor;
  const manager = new CombatSkillAssetManager({
    phaserScene,
    now: 0,
    battleCatalog: battle,
    wardrobe,
    items,
    hero,
    skills: session.skills,
    party: () => session.party,
    activeParty: () => ['player'],
    playerActor: () => actor,
    actorForMember: () => actor,
    isClosed: () => false,
    preparePlayerAppearance: async () => {},
    preparePartyMember: async () => {},
    onBeforeRefresh: () => {},
    onReleaseAllyVisualLease: () => {},
    scheduleDelayed: () => ({ remove() {} }),
  });

  const calls: Array<readonly [string | undefined, string, readonly unknown[]]> = [];
  t.mock.method(manager, 'refreshSkillAssets', (signature: string | undefined, gate: string, allies: readonly unknown[]) => {
    calls.push([signature, gate, allies]);
    return Promise.resolve();
  });
  const settle = () => new Promise(resolve => setImmediate(resolve));

  manager.scheduleRefresh();
  await settle();
  assert.equal(calls.length, 1, '第一次发现签名变化时补载一次');

  // 通过真实准备一次来固化当前签名与门控
  (manager.refreshSkillAssets as unknown as { mock: { restore(): void } }).mock.restore();
  const textures = new Set<string>();
  phaserScene.textures = { exists: () => true, get: () => ({ has: () => true }), remove: (k: string) => textures.delete(k) } as never;
  await manager.prepareInitialPlayer();

  const secondCalls: Array<readonly [string | undefined, string, readonly unknown[]]> = [];
  t.mock.method(manager, 'refreshSkillAssets', (signature: string | undefined, gate: string, allies: readonly unknown[]) => {
    secondCalls.push([signature, gate, allies]);
    return Promise.resolve();
  });

  manager.scheduleRefresh();
  await settle();
  assert.equal(secondCalls.length, 0, '门控和签名都没变时不重复补载');

  hero.setMana(1);
  hero.setHealth(hero.player.maxHealth - 1);
  manager.scheduleRefresh();
  await settle();
  assert.equal(secondCalls.length, 0, '掉血回蓝不触发补载');

  const ring = Object.entries(items.items).find(([, item]) => item.equipment?.slot === 'ring' && !item.equipment.locked)![0];
  hero.bag.addEquipped(ring, 'ring', 'player', hero.classId);
  manager.scheduleRefresh();
  await settle();
  assert.equal(secondCalls.length, 0, '饰品属性变化不重新准备技能贴图');

  hero.bag.addEquipped('basic-dagger', 'main-hand', 'player', hero.classId);
  manager.scheduleRefresh();
  await settle();
  assert.equal(secondCalls.length, 1, '换武器才补载');
});

test('learning guardian while a companion owns its textures survives companion departure', async () => {
  const battle = loadBattleCatalog();
  const items = loadItemCatalog();
  const wardrobe = loadWardrobeCatalog();
  const statsCatalog = loadCharacterStatsCatalog();
  const campaign = loadCampaignCatalog();
  const hero = new BattleCharacter('dark-knight', statsCatalog, items);
  const session = new Session(campaign, undefined, undefined, items, hero, battle);
  const actor = battle.classes.find(entry => entry.id === 'dark-knight')!.actor;
  const learned = new Set(['dark-strike', 'guardian-of-darkness']);
  session.skills.draft = () => ({ levels: Object.fromEntries([...learned].map(id => [id, 1])) });
  const plan = playerCombatAssets({ catalog: battle, wardrobe, items, hero, actor, learnedSkills: learned });
  const textures = new Set(plan.map(asset => asset.key));
  const phaserScene = createFakePhaserScene({
    events: new EventEmitter(),
    textures: { exists: (key: string) => textures.has(key), get: () => ({ has: () => true }), remove: (key: string) => textures.delete(key) },
    anims: { exists: () => false, remove() {} },
    load: { start() { throw new Error('cached textures must not download again'); } },
  });
  const companion = await loadSceneAssets(phaserScene, plan, { progress: () => {} });
  let finishAppearance!: () => void;
  const manager = new CombatSkillAssetManager({
    phaserScene,
    now: 0,
    battleCatalog: battle,
    wardrobe,
    items,
    hero,
    skills: session.skills,
    party: () => session.party,
    activeParty: () => ['player'],
    playerActor: () => actor,
    actorForMember: () => actor,
    isClosed: () => false,
    preparePlayerAppearance: () => new Promise<void>(resolve => { finishAppearance = resolve; }),
    preparePartyMember: async () => {},
    onBeforeRefresh: () => {},
    onReleaseAllyVisualLease: () => {},
    scheduleDelayed: () => ({ remove() {} }),
  });

  manager.recordPreparedAlly('player', new Set(['dark-strike']), '', '');
  const refreshing = manager.refreshSkillAssets(manager.playerSkillSignatureNow(), manager.playerSkillGateNow(), []);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(manager.preparedSkillsFor('player')?.has('guardian-of-darkness'), false, '新动作合成完成前不能使用新技能');
  finishAppearance();
  await refreshing;
  assert.equal(manager.preparedSkillsFor('player')?.has('guardian-of-darkness'), true);
  companion.release();
  assert.equal(missingSceneAssets(phaserScene, plan).length, 0, '主角必须独立持有已由佣兵下载的完整素材');
  manager.releaseSkillLeases('player');
  assert.equal(textures.size, 0, '最后一名使用者释放后回收贴图');
});

test('pending new skills cannot start while previously prepared skills remain available', () => {
  const battle = loadBattleCatalog();
  const items = loadItemCatalog();
  const statsCatalog = loadCharacterStatsCatalog();
  const campaign = loadCampaignCatalog();
  const hero = new BattleCharacter('dark-knight', statsCatalog, items);
  const session = new Session(campaign, undefined, undefined, items, hero, battle);
  const prepared = new Map<string, Set<string>>([['player', new Set(['dark-strike'])]]);
  const harness = createCombatTestHarness({
    battleCatalog: battle,
    characterStats: statsCatalog,
    items,
    hero,
    members: new Map([['player', hero]]),
    sessionSkills: () => session.skills,
    preparedSkills: id => prepared.get(id),
    requiresPreparedSkills: true,
  });
  const action = battle.skills['dark-strike'].action!;
  const mana = hero.player.mana;
  assert.equal(harness.stats.canSelectSkill('player', { id: 'guardian-of-darkness', action }), false);
  assert.equal(harness.stats.canSelectSkill('player', { id: 'dark-strike', action }), true);
  assert.equal(hero.player.mana, mana);
  prepared.get('player')!.add('guardian-of-darkness');
  assert.equal(harness.stats.canSelectSkill('player', { id: 'guardian-of-darkness', action }), true);
});

test('combat sound preparation replaces the complete current learned skill and weapon range', async () => {
  const battle = loadBattleCatalog();
  const items = loadItemCatalog();
  const statsCatalog = loadCharacterStatsCatalog();
  const campaign = loadCampaignCatalog();
  const hero = new BattleCharacter('dark-knight', statsCatalog, items);
  const session = new Session(campaign, undefined, undefined, items, hero, battle);
  session.skills.draft = () => ({ levels: { 'dark-strike': 1 } });
  let prepared: { skills: string[]; weapons: string[]; enemies: string[] } | undefined;
  const world = await createTestWorldCombat({
    hero,
    session,
    appOverrides: {
      audio: {
        prepareCombat: (skills: Iterable<string>, _sounds: Iterable<string>, options: { weaponKinds: Iterable<string>; enemyIds: Iterable<string> }) => {
          prepared = { skills: [...skills], weapons: [...options.weaponKinds], enemies: [...options.enemyIds] };
          return Promise.resolve();
        },
      } as never,
    },
  });
  await world.combat.start();
  assert.deepEqual(prepared!.skills, ['dark-strike']);
  const equipped = hero.bag.equipmentItems(hero.bag.equipmentFor('player'));
  assert.ok(prepared!.weapons.includes(items.items[equipped['main-hand']!].kind));
  assert.deepEqual(prepared!.enemies, []);
  session.skills.draft = () => ({ levels: { 'guardian-of-darkness': 1 } });
  session.skills.restoreState({ loadouts: [['dark-knight', { levels: { 'guardian-of-darkness': 1 } }]], pages: [] });
  hero.setHealth(hero.player.health - 1);
  assert.deepEqual(prepared!.skills, ['guardian-of-darkness']);
  world.combat.destroy();
});

test('departed owners clear failed retries even without a completed asset lease', async () => {
  const battle = loadBattleCatalog();
  const items = loadItemCatalog();
  const wardrobe = loadWardrobeCatalog();
  const statsCatalog = loadCharacterStatsCatalog();
  const campaign = loadCampaignCatalog();
  const companions = loadCompanionCatalog();
  const hero = new BattleCharacter('dark-knight', statsCatalog, items);
  const session = new Session(campaign, undefined, undefined, items, hero, battle, statsCatalog, companions);
  const actor = battle.classes.find(entry => entry.id === 'dark-knight')!.actor;
  session.bag.add('mercenary-emblem-black-knight');
  const departed = session.party!.recruit(session.bag.entries.find(entry => entry.item === 'mercenary-emblem-black-knight')!.id, () => 0).member;
  session.party!.deployFirstAvailable(departed.id);

  let timers = 0;
  let shouldFail = true;
  const phaserScene = createFakePhaserScene({
    textures: { exists: () => { if (shouldFail) throw new Error('download failure'); return true; }, get: () => ({ has: () => true }), remove() {} },
  });
  const manager = new CombatSkillAssetManager({
    phaserScene,
    now: 0,
    battleCatalog: battle,
    wardrobe,
    items,
    hero,
    skills: session.skills,
    party: () => session.party,
    activeParty: () => session.party!.activeIds,
    playerActor: () => actor,
    actorForMember: () => actor,
    isClosed: () => false,
    preparePlayerAppearance: async () => {},
    preparePartyMember: async () => {},
    onBeforeRefresh: () => {},
    onReleaseAllyVisualLease: () => {},
    scheduleDelayed: () => { timers++; return { remove() {} }; },
  });

  manager.recordPreparedAlly(departed.id, new Set(['heal']), 'old', 'g');
  manager.releaseSkillLeases(departed.id);
  assert.equal(manager.preparedSkillsFor(departed.id), undefined);

  // 制造一次失败后让该队员离队，再触发一次无变更的 refresh 检查是否仍调度重连定时器
  await manager.refreshSkillAssets(undefined, '', [{
    id: departed.id,
    member: departed,
    signature: manager.allySkillSignatureNow(departed),
    gate: manager.allySkillGateNow(departed),
  }]);
  timers = 0;
  shouldFail = false;
  session.party!.reserve(departed.id);
  manager.scheduleRefresh();
  assert.equal(timers, 0, '离队的失败记录不会持续产生零延迟定时器');
});

test('blood thirst waits for its reaction assets before applying recovery and effects', () => {
  const prepared = new Map<string, Set<string>>([['player', new Set<string>()]]);
  const harness = createCombatTestHarness({
    hero: createTestMember(),
    members: new Map([['player', createTestMember()]]),
    preparedSkills: prepared,
    requiresPreparedSkills: true,
  });
  const healing: number[] = [];
  harness.stats.actorAttribute = () => 10;
  harness.settlement.restoreHealth = (_id, value) => healing.push(value);
  harness.settlement.restoreMana = () => {};
  const event: SkillReactionEvent = {
    kind: 'blood-thirst',
    ownerId: 'player',
    opponentId: 'enemy',
    damageKind: 'physical',
    outcome: 'hit',
    hitDamage: 1000,
    chanceThreshold: 1000,
  };
  harness.settlement.react(event);
  assert.equal(harness.log.effects.length, 0);
  assert.equal(healing.length, 0);
  prepared.get('player')!.add('blood-thirst');
  harness.settlement.react(event);
  assert.deepEqual(
    harness.log.effects.flatMap(entry => entry.effects.map(item => item.effect)),
    ['life-drain', 'mana-recovery'],
  );
  assert.deepEqual(healing, [10]);
});

test('ally new skills stay unavailable until the appearance recomposition completes', async () => {
  const battle = loadBattleCatalog();
  const items = loadItemCatalog();
  const wardrobe = loadWardrobeCatalog();
  const statsCatalog = loadCharacterStatsCatalog();
  const campaign = loadCampaignCatalog();
  const companions = loadCompanionCatalog();
  const hero = new BattleCharacter('dark-knight', statsCatalog, items);
  const session = new Session(campaign, undefined, undefined, items, hero, battle, statsCatalog, companions);
  session.bag.add('mercenary-emblem-black-knight');
  const ally = session.party!.recruit(session.bag.entries.find(entry => entry.item === 'mercenary-emblem-black-knight')!.id, () => 0).member;
  session.party!.deployFirstAvailable(ally.id);
  const actor = battle.classes.find(value => value.id === ally.classId)!.actor;

  let finish!: () => void;
  const phaserScene = createFakePhaserScene();
  const manager = new CombatSkillAssetManager({
    phaserScene,
    now: 0,
    battleCatalog: battle,
    wardrobe,
    items,
    hero,
    skills: session.skills,
    party: () => session.party,
    activeParty: () => session.party!.activeIds,
    playerActor: () => actor,
    actorForMember: () => actor,
    isClosed: () => false,
    preparePlayerAppearance: async () => {},
    preparePartyMember: () => new Promise<void>(resolve => { finish = resolve; }),
    onBeforeRefresh: () => {},
    onReleaseAllyVisualLease: () => {},
    scheduleDelayed: () => ({ remove() {} }),
  });

  manager.recordPreparedAlly(ally.id, new Set(['dark-strike']), '', '');
  ally.skills.maxAll(battle, ally.classId);
  const refreshing = manager.refreshSkillAssets(undefined, '', [{
    id: ally.id,
    member: ally,
    signature: manager.allySkillSignatureNow(ally),
    gate: manager.allySkillGateNow(ally),
  }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(manager.preparedSkillsFor(ally.id)?.has('guardian-of-darkness'), false, '外观合成完成前不能使用新技能');
  finish();
  await refreshing;
  assert.equal(manager.preparedSkillsFor(ally.id)?.has('guardian-of-darkness'), true);
});

test('a failed ally request cannot revive retries after that ally leaves', async () => {
  const battle = loadBattleCatalog();
  const items = loadItemCatalog();
  const wardrobe = loadWardrobeCatalog();
  const statsCatalog = loadCharacterStatsCatalog();
  const campaign = loadCampaignCatalog();
  const companions = loadCompanionCatalog();
  const hero = new BattleCharacter('dark-knight', statsCatalog, items);
  const session = new Session(campaign, undefined, undefined, items, hero, battle, statsCatalog, companions);
  session.bag.add('mercenary-emblem-black-knight');
  const ally = session.party!.recruit(session.bag.entries.find(entry => entry.item === 'mercenary-emblem-black-knight')!.id, () => 0).member;
  session.party!.deployFirstAvailable(ally.id);
  const actor = battle.classes.find(value => value.id === ally.classId)!.actor;

  let retries = 0;
  const phaserScene = createFakePhaserScene({
    textures: {
      exists: () => {
        session.party!.reserve(ally.id);
        throw new Error('late download failure');
      },
      get: () => ({ has: () => true }),
      remove() {},
    },
  });
  const manager = new CombatSkillAssetManager({
    phaserScene,
    now: 0,
    battleCatalog: battle,
    wardrobe,
    items,
    hero,
    skills: session.skills,
    party: () => session.party,
    activeParty: () => session.party!.activeIds,
    playerActor: () => actor,
    actorForMember: () => actor,
    isClosed: () => false,
    preparePlayerAppearance: async () => {},
    preparePartyMember: async () => {},
    onBeforeRefresh: () => {},
    onReleaseAllyVisualLease: () => {},
    scheduleDelayed: () => { retries++; return { remove() {} }; },
  });

  await manager.refreshSkillAssets(undefined, '', [{
    id: ally.id,
    member: ally,
    signature: manager.allySkillSignatureNow(ally),
    gate: manager.allySkillGateNow(ally),
  }]);
  assert.equal(retries, 0);
});

test('equipment changed during initial ally preparation defers spawning until a fresh plan', async () => {
  const battle = loadBattleCatalog();
  const items = loadItemCatalog();
  const statsCatalog = loadCharacterStatsCatalog();
  const campaign = loadCampaignCatalog();
  const companions = loadCompanionCatalog();
  const hero = new BattleCharacter('dark-knight', statsCatalog, items);
  const session = new Session(campaign, undefined, undefined, items, hero, battle, statsCatalog, companions);
  session.bag.add('mercenary-emblem-black-knight');
  const ally = session.party!.recruit(session.bag.entries.find(entry => entry.item === 'mercenary-emblem-black-knight')!.id, () => 0).member;
  session.party!.deployFirstAvailable(ally.id);
  const actor = battle.classes.find(value => value.id === ally.classId)!.actor;
  const navigation = new NavigationWorld({ name: 'ally-prepare', tileSize: 16, columns: 20, rows: 20, blocked: Array<boolean>(400).fill(false) });
  const movement = createFakeMovementWorld(navigation);
  let swapped = false;
  const world = await createTestWorldCombat({
    hero,
    session,
    movement,
    appOverrides: {
      world: { actors: { [ally.definition.actor]: actor, [actor.id]: actor } } as never,
      ui: { showInstant() {}, toast(msg: string) { throw new Error(msg); } } as never,
    },
    sceneOverrides: {
      preparePartyMember: async id => {
        if (!swapped) {
          swapped = true;
          hero.bag.addEquipped('basic-dagger', 'main-hand', id, ally.classId);
        }
      },
    },
  });
  await world.combat.projectStoryEnemies(new AbortController().signal);
  assert.equal(world.combat.captureState().party.filter(p => p.id === ally.id).length, 0, '旧清单不能启动新装备的攻击控制器');
  // 推进时钟跨过 100ms 退避窗口后重跑同步，队友使用新装备落场。
  (world.phaserScene.time as { now: number }).now = 100;
  world.combat.update(16, true);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(world.combat.captureState().party.some(p => p.id === ally.id), true);
  world.combat.destroy();
});

test('restore waits for all current party skill leases and rejects incomplete preparation', async t => {
  const battle = loadBattleCatalog();
  const items = loadItemCatalog();
  const wardrobe = loadWardrobeCatalog();
  const statsCatalog = loadCharacterStatsCatalog();
  const campaign = loadCampaignCatalog();
  const hero = new BattleCharacter('dark-knight', statsCatalog, items);
  const session = new Session(campaign, undefined, undefined, items, hero, battle);
  const actor = battle.classes.find(entry => entry.id === 'dark-knight')!.actor;
  const manager = new CombatSkillAssetManager({
    phaserScene: createFakePhaserScene(),
    now: 0,
    battleCatalog: battle,
    wardrobe,
    items,
    hero,
    skills: session.skills,
    party: () => session.party,
    activeParty: () => ['player'],
    playerActor: () => actor,
    actorForMember: () => actor,
    isClosed: () => false,
    preparePlayerAppearance: async () => {},
    preparePartyMember: async () => {},
    onBeforeRefresh: () => {},
    onReleaseAllyVisualLease: () => {},
    scheduleDelayed: () => ({ remove() {} }),
  });

  let allowFinish!: () => void;
  t.mock.method(manager, 'refreshSkillAssets', async () => {
    await new Promise<void>(resolve => { allowFinish = resolve; });
  });
  let rejected = false;
  const pending = manager.prepareRestoredSkills().catch(() => { rejected = true; });
  await Promise.resolve();
  assert.equal(rejected, false);
  allowFinish();
  await pending;
  assert.equal(rejected, true, '未建立玩家技能租约时必须拒绝完成恢复');

  (manager.refreshSkillAssets as unknown as { mock: { restore(): void } }).mock.restore();
  await manager.prepareRestoredSkills();
  assert.equal(manager.hasLease('player'), true);
});

test('failed restored skill preparation leaves current combat state untouched', async () => {
  const world = await createTestWorldCombat({
    sceneOverrides: {
      preparePlayerAppearance: async () => { throw new Error('asset failure'); },
    },
  });
  const snapshot = world.combat.captureState();
  await assert.rejects(world.combat.restoreState(snapshot), /恢复技能素材失败/);
  assert.equal(world.combat.paused, false);
  world.combat.destroy();
});

test('restored allies must own their prepared skill assets before restore can finish', async t => {
  const battle = loadBattleCatalog();
  const items = loadItemCatalog();
  const wardrobe = loadWardrobeCatalog();
  const statsCatalog = loadCharacterStatsCatalog();
  const campaign = loadCampaignCatalog();
  const companions = loadCompanionCatalog();
  const hero = new BattleCharacter('dark-knight', statsCatalog, items);
  const session = new Session(campaign, undefined, undefined, items, hero, battle, statsCatalog, companions);
  session.bag.add('mercenary-emblem-black-knight');
  const ally = session.party!.recruit(session.bag.entries.find(entry => entry.item === 'mercenary-emblem-black-knight')!.id, () => 0).member;
  session.party!.deployFirstAvailable(ally.id);
  const actor = battle.classes.find(value => value.id === ally.classId)!.actor;

  const manager = new CombatSkillAssetManager({
    phaserScene: createFakePhaserScene(),
    now: 0,
    battleCatalog: battle,
    wardrobe,
    items,
    hero,
    skills: session.skills,
    party: () => session.party,
    activeParty: () => session.party!.activeIds,
    playerActor: () => actor,
    actorForMember: () => actor,
    isClosed: () => false,
    preparePlayerAppearance: async () => {},
    preparePartyMember: async () => {},
    onBeforeRefresh: () => {},
    onReleaseAllyVisualLease: () => {},
    scheduleDelayed: () => ({ remove() {} }),
  });

  // 仅给主角加载而跳过队友时拒绝完成恢复
  await manager.prepareInitialPlayer();
  const mockRefresh = t.mock.method(manager, 'refreshSkillAssets', async () => {});
  await assert.rejects(manager.prepareRestoredSkills(), /恢复技能素材失败/);
  mockRefresh.mock.restore();
  await manager.prepareRestoredSkills();
  assert.equal(manager.hasLease(ally.id), true);
});

test('condition rendering skips unaffected actors and refreshes only changed states or layers', t => {
  const catalog = loadBattleCatalog();
  const phaserScene = createFakePhaserScene();
  const visuals = new Map(['one', 'two'].map(id => [id, { layers: [], container: createFakeContainer(0, 0) }]));
  let reads = 0;
  const visualOf = (id: string) => { reads++; return visuals.get(id) as never; };
  const markers: string[] = [];
  const removed: string[] = [];
  t.mock.method(StateMarkers.prototype, 'sync', (id: string) => markers.push(id));
  t.mock.method(StateMarkers.prototype, 'remove', (id: string) => { removed.push(id); });
  t.mock.method(StatusColorRenderer.prototype, 'paint', () => {});

  const statusVisuals = new CombatStatusVisuals(phaserScene, catalog);
  const conditions = new CombatConditions();
  statusVisuals.syncStateMarkers(true, 0, conditions.activeAppearances(), visualOf, () => false);
  statusVisuals.syncStateMarkers(true, 0, conditions.activeAppearances(), visualOf, () => false);
  assert.equal(reads, 0, '无表现角色不查外观');

  conditions.applyState('one', 'stun', 1000);
  conditions.applyState('two', 'sleep', 1000);
  statusVisuals.syncStateMarkers(true, 0, conditions.activeAppearances(), visualOf, () => false);
  assert.deepEqual(markers, ['one', 'two']);

  markers.length = 0;
  statusVisuals.syncStateMarkers(true, 0, conditions.activeAppearances(), visualOf, () => false);
  assert.deepEqual(markers, []);

  conditions.applyState('one', 'stun', 1200);
  statusVisuals.syncStateMarkers(true, 0, conditions.activeAppearances(), visualOf, () => false);
  assert.deepEqual(markers, ['one']);

  markers.length = 0;
  visuals.get('two')!.container.visible = false;
  statusVisuals.syncStateMarkers(true, 0, conditions.activeAppearances(), visualOf, () => false);
  assert.deepEqual(markers, ['two']);

  markers.length = 0;
  visuals.get('two')!.container.visible = true;
  statusVisuals.syncStateMarkers(true, 0, conditions.activeAppearances(), visualOf, () => false);
  assert.deepEqual(markers, ['two']);

  markers.length = 0;
  visuals.get('one')!.layers = [];
  statusVisuals.syncStateMarkers(true, 0, conditions.activeAppearances(), visualOf, () => false);
  assert.deepEqual(markers, ['one']);

  conditions.clear();
  statusVisuals.syncStateMarkers(true, 0, conditions.activeAppearances(), visualOf, () => false);
  assert.deepEqual(removed.sort(), ['one', 'two']);
});

test('condition colors use the combat clock while pause, defeat and restore invalidate presentation', t => {
  const catalog = loadBattleCatalog();
  const phaserScene = createFakePhaserScene();
  const visual = { layers: [], container: createFakeContainer(0, 0) };
  const frames: number[] = [];
  const shown: boolean[] = [];
  t.mock.method(StatusColorRenderer.prototype, 'paint', (_visual: unknown, _colors: unknown, frame: number) => frames.push(frame));
  t.mock.method(StateMarkers.prototype, 'sync', (_id: string, _visual: unknown, _states: unknown, visible: boolean) => shown.push(visible));

  const statusVisuals = new CombatStatusVisuals(phaserScene, catalog);
  const conditions = new CombatConditions();
  let tick = 0;
  const pending = new Set<string>();

  conditions.applyBuff('player', 'dark-strike', 1, {
    durationMs: 1000,
    tickMs: 0,
    states: ['stun'],
    modifiers: [],
    periodic: [],
    appearanceColors: [{ red: 10, green: 0, blue: 0 }],
  });
  statusVisuals.syncStateMarkers(true, tick, conditions.activeAppearances(), () => visual as never, id => pending.has(id));
  statusVisuals.syncStateMarkers(true, tick, conditions.activeAppearances(), () => visual as never, id => pending.has(id));
  assert.deepEqual(frames, [0]);

  tick = 1;
  statusVisuals.syncStateMarkers(true, tick, conditions.activeAppearances(), () => visual as never, id => pending.has(id));
  assert.deepEqual(frames, [0, 1]);

  statusVisuals.syncStateMarkers(false, tick, conditions.activeAppearances(), () => visual as never, id => pending.has(id));
  const paused = frames.length;
  statusVisuals.syncStateMarkers(false, tick, conditions.activeAppearances(), () => visual as never, id => pending.has(id));
  assert.equal(frames.length, paused);
  assert.equal(shown.at(-1), false);

  pending.add('player');
  statusVisuals.syncStateMarkers(false, tick, conditions.activeAppearances(), () => visual as never, id => pending.has(id));
  assert.equal(frames.length, paused);

  pending.clear();
  statusVisuals.syncStateMarkers(true, tick, conditions.activeAppearances(), () => visual as never, id => pending.has(id));
  assert.equal(frames.length, paused + 1);

  const saved = conditions.captureState();
  conditions.restoreState(saved);
  statusVisuals.syncStateMarkers(true, tick, conditions.activeAppearances(), () => visual as never, id => pending.has(id));
  assert.equal(frames.length, paused + 2, '读档后即使逻辑帧相同仍重新应用颜色');
});

test('AI mana costs are reused until equipment, conditions or temporary attributes change', () => {
  const { hero, harness } = domainFixture();
  let temporary = false;
  (harness.conditions as { cachedAttribute(id: string, key: string): number | undefined }).cachedAttribute = (_id, key) =>
    key === 'manaCostRate' && temporary ? 1000 : undefined;
  let computed = 0;
  harness.stats.skillManaCost = () => { computed++; return 10; };
  const skills = [{ id: 'dark-strike', level: 1 }] as never;
  const first = harness.stats.aiSkillCosts('player', hero, skills)!;
  assert.equal(harness.stats.cachedAiSkillCost(first, 'player', skills[0]), 10);
  assert.equal(harness.stats.cachedAiSkillCost(first, 'player', skills[0]), 10);
  assert.equal(computed, 1, '同一组输入只算一次蓝耗');

  hero.bag.add('healing-potion-s');
  const afterBag = harness.stats.aiSkillCosts('player', hero, skills)!;
  harness.stats.cachedAiSkillCost(afterBag, 'player', skills[0]);
  assert.equal(computed, 2, '背包变化后重算');

  harness.conditions.applyState('player', 'stun', 100);
  const afterState = harness.stats.aiSkillCosts('player', hero, skills)!;
  harness.stats.cachedAiSkillCost(afterState, 'player', skills[0]);
  assert.equal(computed, 3, '状态/增益变化后重算');

  temporary = true;
  assert.equal(harness.stats.aiSkillCosts('player', hero, skills), undefined, '临时蓝耗属性存在时不做缓存');
});

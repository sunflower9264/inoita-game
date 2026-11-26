import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  parseBattle,
  parseCampaign,
  parseCharacterStats,
  parseCompanions,
  parseItemCatalog,
  parseMenuPanels,
  parseStoryClasses,
  parseWardrobe,
  parseWorld,
} from '../src/application/content-validation.ts';
import { resolveBasicAttack } from '../src/domain/basic-attack.ts';
import { BattleCharacter } from '../src/domain/character-stats.ts';
import { CombatActionDispatcher } from '../src/domain/combat-action-dispatcher.ts';
import { CombatConditions } from '../src/domain/combat-conditions.ts';
import { CombatCooldownStore } from '../src/domain/combat-cooldowns.ts';
import { CombatEffectExecutor, type CombatEffectPort } from '../src/domain/combat-effect-executor.ts';
import { CombatRuntime } from '../src/domain/combat-runtime.ts';
import { CombatController, resolveCueTargets, type Combatant } from '../src/domain/combat.ts';
import type { Facing } from '../src/domain/content.ts';
import { calculateEnemy } from '../src/domain/enemy-stats.ts';
import { passiveModifiers } from '../src/domain/passive-skills.ts';
import { learnedSkillReactions, resolveSkillReactions } from '../src/domain/skill-reactions.ts';
import { newStorySession, visibleStoryClasses } from '../src/domain/story-class.ts';
import { costumeRecipe } from '../src/domain/wardrobe.ts';
import { registerHooks } from 'node:module';

const phaserHook = registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'phaser'
      ? { url: 'data:text/javascript,export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}}}', shortCircuit: true }
      : next(specifier, context);
  },
});
const { CombatPresenter } = await import('../src/rendering/combat-presenter.ts');
const { WorldCombat } = await import('../src/scenes/world-combat.ts');
phaserHook.deregister();

const read = (file: string) => JSON.parse(fs.readFileSync(new URL('../public/content/' + file, import.meta.url), 'utf8'));

const storyClasses = parseStoryClasses(read('story-classes.json'));
const items = parseItemCatalog(read('items.json'));
const stats = parseCharacterStats(read('character-stats.json'));
const wardrobe = parseWardrobe(read('wardrobe.json'));
const battle = parseBattle(read('battle.json'), wardrobe);
const campaign = parseCampaign(read('campaign.json'));
const world = parseWorld(read('world.json'));
const companions = parseCompanions(read('companions.json'));
const menuPanels = parseMenuPanels(read('menu-panels.json'));

const BOX = { x: -8, y: -8, width: 16, height: 16 } as const;

function actorAt(id: string, x: number, y: number, team = 'hostile', facing: Facing = 'south'): Combatant {
  return { id, team, position: { x, y }, bounds: BOX, facing };
}

test('lancer class is hidden in normal mode and exposed only in debug mode without leaking into normal loot/shops', () => {
  const normal = visibleStoryClasses(storyClasses, false);
  const debug = visibleStoryClasses(storyClasses, true);

  assert.deepEqual(
    normal.map(entry => entry.id),
    ['dark-knight', 'assassin', 'warlock', 'priest', 'ranger', 'warrior'],
  );
  assert.equal(debug.length, 7);
  const lancer = debug.find(entry => entry.id === 'lancer');
  assert.ok(lancer);
  assert.equal(lancer.debugOnly, true);
  assert.equal(lancer.name, '龙枪武士');

  // 普通商店、随机掉落与佣兵招募池均不混入调试期长枪内容
  for (const spearId of ['basic-spear', 'dragon-fang-spear']) {
    assert.equal(items.items[spearId]?.storeListed, false, spearId);
  }
  assert.equal(
    Object.values(companions.definitions).some(def => def.classId === 'lancer'),
    false,
    '正式佣兵池不应刷出未开放的调试长枪佣兵',
  );
  assert.ok(menuPanels.classes.lancer);
  assert.ok(menuPanels.character.classPortraits.lancer);
  assert.ok(menuPanels.assets['party-class-lancer']);
});

test('starting a debug story as lancer equips basic-spear, applies 650‰ spear strength scaling and keeps story poses', () => {
  const hero = world.actors[campaign.start.actor]!;
  const lancer = storyClasses.classes.find(entry => entry.id === 'lancer')!;
  const session = newStorySession(campaign, hero, lancer, items, stats, battle, companions);

  assert.equal(session.character?.classId, 'lancer');
  assert.deepEqual(session.bag.equipmentItems(), { 'main-hand': 'basic-spear' });
  assert.ok(session.character?.appearance.clips['lie-side-south']);

  // 验证长枪 650‰ 力量系数：力量 12 * 650 / 1000 = 7，敏捷 13 / 2 = 6
  const fighter = new BattleCharacter('lancer', stats, items);
  assert.ok(fighter.panel.physicalAttack >= 20);
});

test('wardrobe composes spear combat carry, town back-slung carry and multi-style weapon swap', () => {
  const combatRecipe = costumeRecipe(wardrobe, items, { 'main-hand': 'basic-spear' }, 'lancer', undefined, undefined, false);
  assert.equal(combatRecipe.variants.spear, 'spear-style-1');
  assert.equal(combatRecipe.poses['idle-south'], 'spear-idle-south');
  assert.equal(combatRecipe.poses['walk-north'], 'spear-walk-north');
  assert.equal(combatRecipe.poses['town-idle-south'], undefined, '内部城镇键不应直接混入运行时动画列表');

  const townRecipe = costumeRecipe(wardrobe, items, { 'main-hand': 'basic-spear' }, 'lancer', undefined, undefined, true);
  assert.equal(townRecipe.poses['idle-south'], 'spear-town-idle-south');
  assert.equal(townRecipe.poses['walk-north'], 'spear-town-walk-north');

  const dragonRecipe = costumeRecipe(wardrobe, items, { 'main-hand': 'dragon-fang-spear' }, 'lancer', undefined, undefined, false);
  assert.equal(dragonRecipe.variants.spear, 'spear-style-2');

  // 原版职业在城镇仍保持徒手城镇姿态不变
  const warriorTown = costumeRecipe(wardrobe, items, { 'main-hand': 'basic-greatsword' }, 'warrior', undefined, undefined, true);
  assert.equal(warriorTown.poses['idle-south'], wardrobe.stances['unarmed:empty']?.['idle-south']);
});

test('directional line, sector and front-circle hitboxes match spear reach across all 4 facings without hitting behind', () => {
  const vectors: Record<Facing, [number, number]> = {
    east: [1, 0],
    west: [-1, 0],
    south: [0, 1],
    north: [0, -1],
  };

  for (const facing of ['east', 'west', 'south', 'north'] as const) {
    const [fx, fy] = vectors[facing];
    const px = -fy;
    const py = fx;
    const caster = actorAt('player', 200, 200, 'party', facing);

    const nearFront = actorAt('near-front', 200 + fx * 32, 200 + fy * 32);
    const midFront = actorAt('mid-front', 200 + fx * 58 + px * 10, 200 + fy * 58 + py * 10);
    const farFront = actorAt('far-front', 200 + fx * 86, 200 + fy * 86);
    const flankLeft = actorAt('flank-left', 200 + fx * 18 + px * 44, 200 + fy * 18 + py * 44);
    const behind = actorAt('behind', 200 - fx * 24, 200 - fy * 24);
    const pool = [caster, farFront, flankLeft, behind, midFront, nearFront];

    // 1. 狂龙穿心破：72px 直线走廊且上限 2 名目标（farFront 超距、即使不超距也截断为最近 2 个）
    const dragonCue = battle.skills['dragon-pierce']!.action!.events.find(e => e.kind === 'units')!;
    assert.equal(dragonCue.kind, 'units');
    const extraMid = actorAt('mid-2', 200 + fx * 46, 200 + fy * 46);
    const pierceHits = resolveCueTargets(dragonCue.cues[0]!, caster, undefined, [...pool, extraMid]).map(a => a.id);
    assert.deepEqual(pierceHits, ['near-front', 'mid-2'], `pierce cap facing ${facing}`);

    // 2. 连环点枪终结段：80px 直线走廊贯穿，不打背后与宽侧翼
    const flurryUnits = battle.skills['flurry-thrust']!.action!.events.filter(e => e.kind === 'units');
    const flurryFinisherCue = flurryUnits[2]!;
    assert.equal(flurryFinisherCue.kind, 'units');
    const lineHits = resolveCueTargets(flurryFinisherCue.cues[0]!, caster, undefined, pool).map(a => a.id);
    assert.deepEqual(lineHits, ['near-front', 'mid-front'], `line facing ${facing}`);

    // 3. 虬龙扫暴阵终结段：前方 190° 宽扇形（68px），扫中近前、中前及侧前方 flankLeft，但不打背后与 86px 远敌
    const sweepUnits = battle.skills['whirl-sweep']!.action!.events.filter(e => e.kind === 'units');
    const galeSweepCue = sweepUnits[2]!;
    assert.equal(galeSweepCue.kind, 'units');
    const sweepHits = resolveCueTargets(galeSweepCue.cues[0]!, caster, undefined, pool).map(a => a.id);
    assert.deepEqual(sweepHits, ['near-front', 'flank-left', 'mid-front'], `sector facing ${facing}`);

    // 4. 伏龙震：身前 30px 落点圆（半径 36px），命中 near-front 与 mid-front，不打背后与超远敌
    const slamCue = battle.skills['dragon-slam']!.action!.events.find(e => e.kind === 'units')!;
    assert.equal(slamCue.kind, 'units');
    const slamHits = resolveCueTargets(slamCue.cues[0]!, caster, undefined, pool).map(a => a.id);
    assert.deepEqual(slamHits, ['near-front', 'mid-front'], `front-circle facing ${facing}`);
  }
});

test('sovereign-pierce executes 3-act dome pulses, full-screen 4-way cross shockwaves and explicit directional visuals without tinting', () => {
  const skill = battle.skills['sovereign-pierce']!;
  const action = skill.action!;
  assert.equal(action.requiresTarget, false);

  const unitEvents = action.events.filter(e => e.kind === 'units');
  assert.deepEqual(unitEvents.map(e => e.frame), [3, 6, 9, 17, 19]);

  // Act 1 扣地半球能量罩触碰伤害（F3 / F6 / F9，半径 56px 全周身）
  const caster = actorAt('player', 400, 400, 'party', 'south');
  const domeTouch = actorAt('dome-touch', 400 + 48, 400 - 20); // ~52px，触碰罩面
  const farEast = actorAt('far-east', 400 + 300, 400 + 12);    // 东向全屏走廊内
  const farWest = actorAt('far-west', 400 - 290, 400 - 10);    // 西向全屏走廊内
  const farSouth = actorAt('far-south', 400 + 8, 400 + 215);   // 南向全屏走廊内
  const farNorth = actorAt('far-north', 400 - 12, 400 - 210);  // 北向全屏走廊内
  const diagCorner = actorAt('diag-corner', 400 + 110, 400 + 110); // 斜对角空隙，不应被十字波打中
  const pool = [caster, farEast, farWest, farSouth, farNorth, diagCorner, domeTouch];

  for (const domeEvent of unitEvents.slice(0, 3)) {
    const domeHits = resolveCueTargets(domeEvent.cues[0]!, caster, undefined, pool).map(a => a.id);
    assert.deepEqual(domeHits, ['dome-touch']);
  }

  // Act 3 全屏四向十字冲击波（F17 / F19）：同时命中东/西 320px、南/北 230px 四路目标，且不伤斜角空位
  for (const crossEvent of unitEvents.slice(3)) {
    assert.equal(crossEvent.cues[0]!.areaShape?.kind, 'cross');
    const crossHits = resolveCueTargets(crossEvent.cues[0]!, caster, undefined, pool).map(a => a.id);
    assert.deepEqual(new Set(crossHits), new Set(['dome-touch', 'far-north', 'far-south', 'far-west', 'far-east']));
    assert.equal(crossHits.includes('diag-corner'), false);
  }

  // 确认四向全屏特效尺寸及调度器在 F0 / F12 / F16 精确派发全部分层与四向变体
  assert.ok(battle.attackEffects['spear-sovereign-beam']!.clips.west!.frameWidth >= 320);
  assert.ok(battle.attackEffects['spear-sovereign-beam']!.clips.south!.frameHeight >= 220);
  assert.ok(battle.attackEffects['spear-sovereign-dome-back']!.clips.default);
  assert.ok(battle.attackEffects['spear-sovereign-dome']!.clips.default);
  assert.ok(battle.attackEffects['spear-sovereign-charge']!.clips.default);

  const spawned: { name: string; variant: string; placement?: string }[] = [];
  const dispatcher = new CombatActionDispatcher({
    runtime: new CombatRuntime(() => 0),
    catalog: battle,
    actor: id => (id === caster.id ? caster : undefined),
    candidates: () => pool,
    random: () => 0.5,
    viewport: () => ({ width: 320, height: 213 }),
    pose: () => {},
    effect: (name, variant, _pos, placement) => { spawned.push({ name, variant, placement }); },
    flight: () => {},
    screen: () => {},
    notify: () => {},
    canSummonAt: () => true,
    nearestSummonSpot: (_p, _b, pref) => pref,
    beginSummons: () => {},
    summon: () => undefined,
  });

  const playback = { caster, basicAttack: null, skill: { id: 'sovereign-pierce', level: 1, action }, facing: 'west' as Facing };
  dispatcher.frame(playback, 0);
  dispatcher.frame(playback, 12);
  dispatcher.frame(playback, 16);

  assert.ok(spawned.some(e => e.name === 'spear-sovereign-dome-back' && e.variant === 'default' && e.placement === 'ground'));
  assert.ok(spawned.some(e => e.name === 'spear-sovereign-dome' && e.variant === 'default' && e.placement === 'above-characters'));
  assert.ok(spawned.some(e => e.name === 'spear-sovereign-charge' && e.variant === 'default'));
  assert.ok(spawned.some(e => e.name === 'spear-sovereign-beam' && e.variant === 'north' && e.placement === 'ground'));
  assert.ok(spawned.some(e => e.name === 'spear-sovereign-beam' && e.variant === 'west' && e.placement === 'above-characters'));
  assert.ok(spawned.some(e => e.name === 'spear-sovereign-beam' && e.variant === 'east' && e.placement === 'above-characters'));
  assert.ok(spawned.some(e => e.name === 'spear-sovereign-beam' && e.variant === 'south' && e.placement === 'above-characters'));

  // 角色 28 帧完整技能动画，且不附带任何变色 buff；龙枪全职业仅保留伏龙震 F4 与万圣龙王破 F17 共 2 次克制震屏
  const lancerClass = battle.classes.find(c => c.id === 'lancer')!;
  for (const facing of ['south', 'west', 'north', 'east'] as const) {
    assert.equal(lancerClass.actor.clips[`skill-sovereign-pierce-${facing}`]?.frames, 28, facing);
  }
  assert.equal(action.combatUnits!.some(u => u.effect === 'buff'), false, '万圣龙王破不应附带令角色变色的 buff');

  const shakeSummary: Record<string, number[]> = {};
  for (const sid of lancerClass.skills) {
    const sk = battle.skills[sid]!;
    if (!sk.action) continue;
    const frames = sk.action.events
      .filter(ev => (ev.kind === 'feedback' && ev.shake) || (ev.kind === 'units' && ev.dispatch?.shake))
      .map(ev => ev.frame);
    if (frames.length) shakeSummary[sid] = frames;
  }
  assert.deepEqual(shakeSummary, { 'dragon-slam': [4], 'sovereign-pierce': [17] });
});

test('spear passive polearm-reach extends directional hitbox reach only when wielding a spear', () => {
  const loadout = { levels: { 'spear-mastery': 4, 'polearm-reach': 4 } };
  const withSpear = passiveModifiers(battle, 'lancer', loadout, 'spear');
  const withSword = passiveModifiers(battle, 'lancer', loadout, 'longsword');
  assert.ok(withSpear.some(m => m.attribute === 'attackRangeBonusUnits'));
  assert.equal(withSword.length, 0);

  const bonusUnits = 2; // +16px
  const caster = actorAt('player', 100, 100, 'party', 'east');
  const edgeEnemy = actorAt('edge-enemy', 184, 100); // 距离 84px：基础 72px 打不到，+16px (=88px) 后可命中
  const dragonCue = battle.skills['dragon-pierce']!.action!.events.find(e => e.kind === 'units')!;
  assert.equal(dragonCue.kind, 'units');
  assert.deepEqual(resolveCueTargets(dragonCue.cues[0]!, caster, undefined, [caster, edgeEnemy], [], 0), []);
  assert.deepEqual(
    resolveCueTargets(dragonCue.cues[0]!, caster, undefined, [caster, edgeEnemy], [], bonusUnits).map(a => a.id),
    ['edge-enemy'],
  );
});

test('spear 3-hit basic attack combo chains mid-range thrust into 180-degree sweep and forward lift', () => {
  const lancerClass = battle.classes.find(c => c.id === 'lancer')!;
  const step0 = resolveBasicAttack(battle, lancerClass, undefined, 0);
  const step1 = resolveBasicAttack(battle, lancerClass, undefined, 1);
  const step2 = resolveBasicAttack(battle, lancerClass, undefined, 2);

  assert.equal(step0.approachDistanceUnits, 6);
  assert.equal(step0.targeting, undefined);
  assert.equal(step1.targeting?.areaShape?.kind, 'sector');
  assert.equal(step2.targeting?.areaShape?.kind, 'sector');

  const caster = actorAt('player', 100, 100, 'party', 'east');
  const frontA = actorAt('front-a', 148, 100); // 48px 正东（超出单手剑距离，但在长枪 6 格内）
  const frontB = actorAt('front-b', 132, 128); // 右前侧翼
  const behind = actorAt('behind', 72, 100);   // 西侧背后
  const combatants = [caster, frontA, frontB, behind];

  let nowFrame = 0;
  let playFrame: ((index: number) => void) | undefined;
  let playComplete: (() => void) | undefined;
  const hitLog: string[][] = [];
  const cooldowns = new CombatCooldownStore(() => nowFrame);

  const controller = new CombatController('player', step0, {
    cooldowns: cooldowns.forActor('player'),
    actor: id => combatants.find(c => c.id === id),
    candidates: () => combatants,
    facing: () => 'east',
    moveToward: () => { throw new Error('长枪在 48px 中距离应直接出枪无需继续贴脸'); },
    stop: () => {},
    canStand: () => true,
    relocate: () => {},
    selectBasicAttack: (_normal, step) => resolveBasicAttack(battle, lancerClass, undefined, step),
    play: (_action, onFrame, onComplete) => {
      playFrame = onFrame;
      playComplete = onComplete;
      return () => {};
    },
    frame: (action, index, contact, _unitsReady, areaContact) => {
      if (!action.basicAttack || index !== action.basicAttack.strikeFrame) return;
      if (action.basicAttack.targeting) areaContact?.();
      else if (action.target) contact(action.target.id);
    },
    contact: event => { hitLog.push([event.targetId]); },
    areaContact: event => {
      const targets = resolveCueTargets(
        event.basicAttack.targeting!,
        { ...caster, facing: event.facing ?? caster.facing },
        undefined,
        combatants,
      );
      hitLog.push(targets.map(t => t.id));
    },
    clearEffects: () => {},
  });
  controller.useClock(() => nowFrame);

  // 第 1 段：48px 中距离直接单点轻刺命中 front-a
  assert.equal(controller.requestTarget('front-a'), 'started');
  playFrame!(step0.strikeFrame);
  nowFrame += step0.effectiveCycleFrames;
  playComplete!();
  assert.deepEqual(hitLog[0], ['front-a']);

  // 第 2 段（连击窗口内）：180° 前方横扫同时命中 front-b 与 front-a，不伤 behind
  assert.equal(controller.requestTarget('front-a'), 'started');
  playFrame!(step1.strikeFrame);
  nowFrame += step1.effectiveCycleFrames;
  playComplete!();
  assert.deepEqual(new Set(hitLog[1]), new Set(['front-a', 'front-b']));
  assert.equal(hitLog[1]!.includes('behind'), false);

  // 第 3 段（连击窗口内）：前方 96° 窄扇形上挑命中正前与斜前（上限 2），不伤 behind
  assert.equal(controller.requestTarget('front-a'), 'started');
  playFrame!(step2.strikeFrame);
  nowFrame += step2.effectiveCycleFrames;
  playComplete!();
  assert.deepEqual(new Set(hitLog[2]), new Set(['front-a', 'front-b']));
  assert.equal(hitLog[2]!.includes('behind'), false);
});

test('CombatEffectExecutor reads passive skillDamageBonus via port.attribute rather than buffs-only conditions', () => {
  const conditions = new CombatConditions();
  const baseFighter = {
    level: 10, physicalAttack: 100, defense: 0, defenseRate: 0, physicalResistanceBonus: 0,
    magicAttack: 100, maxHealth: 500, hitBase: 1000, hitBonus: 0, evasionBase: 0, evasionBonus: 0,
    criticalRate: 0, criticalResistance: 1000, criticalDamage: 1500, criticalDamageResistance: 0,
    weaponBlock: 0, shieldBlock: 0, physicalResistance: 0, magicResistance: 0,
  };
  const runWithSkillDamageBonus = (passiveBonus: number): number => {
    let dealt = 0;
    const port: CombatEffectPort = {
      conditions,
      random: () => 0.5,
      run: work => work(),
      available: () => true,
      partySide: id => id === 'player',
      fighter: () => baseFighter,
      position: () => ({ x: 0, y: 0 }),
      vitals: () => ({ health: 500, mana: 100, maxMana: 100 }),
      attribute: (_id, key) => (key === 'skillDamageBonus' ? passiveBonus : key === 'physicalAttack' ? 100 : 0),
      valueSourceId: id => id,
      prepare: () => ({ source: 'physicalAttack', weightedAddition: 0, fixedAddition: 0, operation: { kind: 'multiply-thousandth', ratePerThousand: 1000 } }),
      applyBuff: () => true,
      stateRequest: (_s, _t, state) => ({ state, sourceRelation: 'hostile' }),
      stateAccepted: () => {},
      commandSummons: () => 'success',
      summon: () => 'success',
      restoreHealth: () => {},
      setMana: () => {},
      healAccepted: () => {},
      learnedBuff: () => undefined,
      rearBonus: () => 0,
      reactions: () => {},
      hit: (_ev, hit) => { dealt = hit.damage; },
      dropMana: () => {},
      showHit: () => {},
    };
    const executor = new CombatEffectExecutor(port);
    const unit = battle.skills['dragon-pierce']!.action!.combatUnits![0]!;
    executor.execute({
      casterId: 'player',
      targetId: 'enemy',
      cueIndex: 0,
      skill: {
        id: 'dragon-pierce',
        level: 1,
        action: { ...battle.skills['dragon-pierce']!.action!, combatUnits: [unit] },
      },
    });
    return dealt;
  };

  const withoutPassive = runWithSkillDamageBonus(0);
  const withDragonSpirit = runWithSkillDamageBonus(270); // +27% passive skillDamageBonus
  assert.ok(withDragonSpirit > withoutPassive, `被动技能增伤应提高伤害：${withoutPassive} -> ${withDragonSpirit}`);
});

test('CombatActionDispatcher and CombatPresenter honor explicit visual effect variants across all dispatch paths', () => {
  const caster = actorAt('player', 100, 100, 'party', 'east');
  const target = actorAt('enemy', 140, 100, 'hostile', 'west');
  const spawned: { name: string; variant: string; recipientId?: string }[] = [];
  const dispatcher = new CombatActionDispatcher({
    runtime: new CombatRuntime(() => 0),
    catalog: battle,
    actor: id => (id === 'player' ? caster : id === 'enemy' ? target : undefined),
    candidates: () => [caster, target],
    random: () => 0.5,
    viewport: () => ({ width: 320, height: 213 }),
    pose: () => {},
    effect: (name, variant, _pos, _placement, recipientId) => { spawned.push({ name, variant, recipientId }); },
    flight: () => {},
    screen: () => {},
    notify: () => {},
    canSummonAt: () => true,
    nearestSummonSpot: (_p, _b, pref) => pref,
    beginSummons: () => {},
    summon: () => undefined,
  });

  // 1. basicAttack.targetEffects & dispatch.casterEffects
  const basic = {
    ...resolveBasicAttack(battle, battle.classes[0]!),
    strikeFrame: 0,
    swingFrame: null,
    targetEffects: [{ effect: 'spear-sovereign-beam', recipient: 'target' as const, placement: 'above-characters' as const, variant: 'south' as const }],
    dispatch: {
      breaksStealth: true,
      casterEffects: [{ effect: 'spear-sovereign-beam', recipient: 'caster' as const, placement: 'ground' as const, variant: 'north' as const }],
    },
  };
  dispatcher.frame({ caster, target, basicAttack: basic, facing: 'east' }, 0);

  // 2. units dispatch.casterEffects & summon dispatch.casterEffects
  const syntheticAction = {
    ...battle.skills['sovereign-pierce']!.action!,
    events: [
      {
        kind: 'units' as const,
        frame: 0,
        cues: [],
        dispatch: {
          breaksStealth: true,
          casterEffects: [{ effect: 'spear-sovereign-beam', recipient: 'caster' as const, placement: 'above-characters' as const, variant: 'west' as const }],
        },
      },
      {
        kind: 'summon' as const,
        frame: 1,
        creatures: [],
        placement: { searchGapPx: 8, searchExtentPx: 16, offsetChoices: [{ x: 0, y: 0 }], jitterPx: 0 },
        effect: 'impact-spark',
        dispatch: {
          breaksStealth: false,
          casterEffects: [{ effect: 'spear-sovereign-beam', recipient: 'caster' as const, placement: 'above-characters' as const, variant: 'east' as const }],
        },
      },
    ],
  };
  dispatcher.frame({ caster, target, basicAttack: null, skill: { id: 'test', level: 1, action: syntheticAction }, facing: 'east' }, 0);
  dispatcher.frame({ caster, target, basicAttack: null, skill: { id: 'test', level: 1, action: syntheticAction }, facing: 'east' }, 1);

  assert.deepEqual(
    spawned.map(s => `${s.variant}:${s.recipientId}`),
    ['south:enemy', 'north:player', 'west:player', 'east:player'],
  );

  // 3. CombatPresenter.showEffects & showUnitFeedback
  const presenterCalls: { name: string; variant: string }[] = [];
  const fakePresenter = Object.setPrototypeOf({
    candidates: () => [caster, target],
    visualEffect: (visual: { effect: string }, variant: string) => { presenterCalls.push({ name: visual.effect, variant }); },
  }, CombatPresenter.prototype) as InstanceType<typeof CombatPresenter>;

  fakePresenter.showEffects('player', [{ effect: 'spear-sovereign-beam', recipient: 'caster', placement: 'ground', variant: 'north' }]);
  fakePresenter.showUnitFeedback(
    { casterId: 'player', targetId: 'enemy', cueIndex: 0, skill: { id: 'test', level: 1, action: syntheticAction } },
    'success',
    { target: 'area', targetRangePx: 80, effects: [{ effect: 'spear-sovereign-beam', recipient: 'target', placement: 'above-characters', variant: 'west' }] },
  );
  assert.deepEqual(presenterCalls, [
    { name: 'spear-sovereign-beam', variant: 'north' },
    { name: 'spear-sovereign-beam', variant: 'west' },
  ]);
});

test('WorldCombat.learnedReactionBuff resolves armor-penetration from learned class passive reactions when prepared', () => {
  const fakeBuff = {
    key: 'armor-break' as const,
    rankPriority: 1900,
    effect: { durationMs: 3660, tickMs: 0, states: [], maxStacks: 1, modifiers: [], periodic: [] },
  };
  let prepared: Map<string, Set<string>> | undefined = new Map([['player', new Set(['piercing-momentum'])]]);
  const host = Object.setPrototypeOf({
    get preparedSkillIds() { return prepared; },
    memberOf: () => ({ id: 'player', classId: 'lancer' }),
    reactionSkills: () => ({
      loadout: { levels: { 'piercing-momentum': 1 } },
      reactions: prepared?.get('player')?.has('piercing-momentum') ? [{ kind: 'armor-penetration', buff: fakeBuff }] : [],
    }),
    app: { battleCatalog: battle },
  }, WorldCombat.prototype);
  const read = Reflect.get(WorldCombat.prototype, 'learnedReactionBuff') as (this: unknown, id: string, skillId: string) => unknown;
  assert.deepEqual(read.call(host, 'player', 'armor-penetration'), fakeBuff);

  // 素材尚未就绪时（reactionSkills 过滤后不含该反应），不得提前触发。
  prepared = new Map([['player', new Set()]]);
  assert.equal(read.call(host, 'player', 'armor-penetration'), undefined);
});

test('dragon-pierce armor shred reduces real enemy physicalResistance and displays 6.0s duration', () => {
  const skill = battle.skills['dragon-pierce']!;
  const rank1 = skill.ranks[0]!;
  assert.ok(rank1.details?.some(d => d.label === '持续时间：' && d.value === '6.0秒'));

  const buffUnit = skill.action!.combatUnits!.find(u => u.effect === 'buff');
  assert.ok(buffUnit && buffUnit.effect === 'buff');
  const enemy = battle.enemies.find(e => e.attributes.physicalResistanceBonus > 100)!;
  assert.ok(enemy, 'should find a real enemy with positive physicalResistanceBonus');

  const conditions = new CombatConditions();
  const baseFighter = calculateEnemy(enemy);
  const before = conditions.fighter('enemy', baseFighter).physicalResistance;
  conditions.applyBuff('enemy', buffUnit.buff, buffUnit.ranks[0]!.strength, buffUnit.ranks[0]!.effect, 'player');
  const after = conditions.fighter('enemy', baseFighter).physicalResistance;
  assert.ok(after < before, `狂龙穿心破破甲应降低怪物物理抗性：${before} -> ${after}`);
});

test('piercing-momentum declares 8-rank armor-penetration reactions and triggers armor-break on physical hit', () => {
  const skill = battle.skills['piercing-momentum']!;
  assert.equal(skill.reactionsByRank?.length, 8);
  assert.equal(skill.companion?.reactionsByRank?.length, 8);
  assert.ok(skill.description.includes('物理攻击'));

  const loadout = { levels: { 'piercing-momentum': 4 } };
  const reactions = learnedSkillReactions(battle, 'lancer', loadout, 'hero');
  const armorPen = reactions.find(r => r.kind === 'armor-penetration');
  assert.ok(armorPen && armorPen.kind === 'armor-penetration');

  const host = Object.setPrototypeOf({
    preparedSkillIds: new Map([['player', new Set(['piercing-momentum'])]]),
    memberOf: () => ({ id: 'player', classId: 'lancer' }),
    reactionSkills: () => ({ loadout, reactions }),
    app: { battleCatalog: battle },
  }, WorldCombat.prototype);
  const read = Reflect.get(WorldCombat.prototype, 'learnedReactionBuff') as (this: unknown, id: string, skillId: string) => unknown;

  const commands = resolveSkillReactions(
    reactions,
    { kind: 'physical-attack-effects', ownerId: 'player', opponentId: 'enemy', damageKind: 'physical', outcome: 'hit', armorBreakChance: 120 },
    {
      random: () => 0.01,
      learnedBuff: (id, sid) => read.call(host, id, sid) as never,
    },
  );
  assert.equal(commands.length, 1);
  assert.equal(commands[0]!.kind, 'apply-buff');
  if (commands[0]!.kind === 'apply-buff') {
    assert.equal(commands[0]!.buff.key, 'armor-break');
    assert.equal(commands[0]!.buff.effect.applicationEffect, 'armor-break-impact');
  }
});

test('wardrobe spear stance excludes die poses and lancer preview wears dragon-scale-armor', () => {
  const spearStance = wardrobe.stances['spear:empty']!;
  for (const facing of ['south', 'west', 'north', 'east'] as const) {
    assert.equal(spearStance[`die-${facing}` as keyof typeof spearStance], undefined);
  }
  const previewPng = fs.readFileSync(new URL('../asset-source/assets/characters/story-preview-lancer/idle-south-normal.png', import.meta.url));
  const battlePng = fs.readFileSync(new URL('../asset-source/assets/characters/battle-lancer/idle-south-normal.png', import.meta.url));
  assert.equal(previewPng.equals(battlePng), false, '龙枪选职预览应身着龙鳞板甲，与无甲战斗默认图不同');
});

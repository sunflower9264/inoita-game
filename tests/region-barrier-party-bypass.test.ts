import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { BattleCatalog } from '../src/domain/battle.ts';
import { BattleCharacter } from '../src/domain/character-stats.ts';
import type { ActorDefinition, TravelDestination, WorldMap } from '../src/domain/content.ts';
import { parseMap } from '../src/application/content-validation.ts';
import { overlapsFootRect, segmentOverlapsFootRect, ExitTrigger, type GameRectangle, type Point } from '../src/domain/navigation.ts';
import { NavigationWorld } from '../src/domain/navigation-world.ts';
import { choosePartyLanding } from '../src/domain/party-placement.ts';
import { Session } from '../src/domain/session.ts';
import { storyCommitCommands } from '../src/domain/story-commit.ts';
import { StoryDirector } from '../src/domain/story-director.ts';
import type { StoryPresentationPort, StoryStageSnapshot } from '../src/domain/story-performance.ts';
import { applyStorySceneAction, resolveStoryScene } from '../src/domain/story-scene.ts';
import { WorldTriggerCoordinator } from '../src/scenes/world-triggers.ts';
import { CHARACTER_ATLAS_ALIASES } from '../tools/character-atlas-aliases.ts';
import { headlessContent } from './helpers/story-playthrough.ts';
import { stageSnapshot } from './helpers/story-stage.ts';
import {
  loadBattleCatalog,
  loadCampaignCatalog,
  loadCharacterStatsCatalog,
  loadCompanionCatalog,
  loadItemCatalog,
} from './support/combat-test-harness.ts';
import {
  createFakeContainer,
  createFakeMovementWorld,
  createFakePhaserScene,
  createTestWorldCombat,
} from './support/world-combat-fixture.ts';
import { buildTestWorldScene, loadWorldSceneClass } from './support/world-scene-fixture.ts';

const WorldScene = await loadWorldSceneClass();

function normalizeBattleCatalog(raw: BattleCatalog): BattleCatalog {
  const copy = structuredClone(raw);
  const fix = (actor: ActorDefinition) => {
    for (const clip of Object.values(actor.clips)) {
      for (const layer of clip?.layers ?? []) {
        if (layer.file) layer.file = CHARACTER_ATLAS_ALIASES[layer.file] ?? layer.file;
      }
    }
  };
  for (const cls of copy.classes) fix(cls.actor);
  for (const enemy of copy.enemies) fix(enemy.actor);
  return copy;
}

test('segmentOverlapsFootRect 与区域触发协调器支持单帧跨 16px 薄条带扫掠，并在离开或回退后即时解除占用', () => {
  const thinStrip: GameRectangle = { x: 144, y: 368, width: 192, height: 16 };
  assert.equal(overlapsFootRect({ x: 216, y: 350 }, thinStrip), false);
  assert.equal(overlapsFootRect({ x: 216, y: 398 }, thinStrip), false);
  assert.equal(segmentOverlapsFootRect({ x: 216, y: 350 }, { x: 216, y: 398 }, thinStrip), true, '垂直跨过 16px 薄条带命中');
  assert.equal(segmentOverlapsFootRect({ x: 100, y: 350 }, { x: 120, y: 398 }, thinStrip), false, '完全从条带左侧掠过不误判');

  const coordinator = new WorldTriggerCoordinator();
  const map = { id: 'border-gateway-67e044a2' };
  const campaign = {
    ...headlessContent.campaign,
    events: [
      {
        id: 'thin-gate',
        source: 'region' as const,
        map: map.id,
        key: 'thin-gate',
        script: 'event-422',
        region: thinStrip,
        repeat: true,
      },
    ],
  };
  const entered: string[] = [];
  const step = (previousPos: Point, pos: Point, moving = true) =>
    coordinator.stepAfterMovement({
      map,
      campaign,
      session: { storyWorld: { exitEnabled: () => true }, evaluateCondition: () => true } as never,
      director: {
        allowsAutomaticEvent: () => true,
        runtime: { eventStatus: () => (entered.length ? 'completed' : 'idle') } as never,
        enterRegion: async id => {
          entered.push(id);
          return true;
        },
      },
      characters: [],
      previousPos,
      pos,
      moving,
      playStory: work => work(),
      onExit: () => {},
    });

  assert.equal(step({ x: 216, y: 350 }, { x: 216, y: 398 }), 'region', '单帧跨过 16px 窄条带触发区域事件');
  assert.deepEqual(entered, ['thin-gate']);
  assert.equal(coordinator.occupiedTriggers.has('thin-gate'), true);

  // 角色从条带内 (216, 376) 退回外侧 (216, 396) 的当帧立即解除占用，下一帧再次踩入立刻重触发
  coordinator.occupiedTriggers.add('thin-gate');
  assert.equal(step({ x: 216, y: 376 }, { x: 216, y: 396 }), 'none');
  assert.equal(coordinator.occupiedTriggers.has('thin-gate'), false, '退回外侧当帧立即释放占用');
  assert.equal(step({ x: 216, y: 396 }, { x: 216, y: 380 }), 'region', '紧接着下一帧重入即可再次触发');
  assert.equal(entered.length, 2);

  coordinator.pruneOccupiedRegions({ x: 216, y: 408 }, campaign, map.id, []);
  assert.equal(coordinator.occupiedTriggers.has('thin-gate'), false, '剧情回退同步位置后立即清理过期占用');
});

test('国境关口及 16px 窄条带前调整主角站位、转身、收拢或复活时，佣兵绝不踏入或跨过待触发区域', async () => {
  const battleCatalog = normalizeBattleCatalog(loadBattleCatalog());
  const items = loadItemCatalog();
  const statsCatalog = loadCharacterStatsCatalog();
  const campaign = loadCampaignCatalog();
  const companions = loadCompanionCatalog();

  const rawBorder = JSON.parse(
    readFileSync(new URL('../public/content/maps/border-gateway-67e044a2.json', import.meta.url), 'utf8'),
  );
  const map: WorldMap = parseMap(rawBorder);
  const borderGate: GameRectangle = { x: 304, y: 112, width: 128, height: 112 };
  const southCorridorGate: GameRectangle = { x: 0, y: 232, width: 480, height: 16 };
  let activeGates: GameRectangle[] = [borderGate];

  const navigation = new NavigationWorld(map);
  const movement = createFakeMovementWorld(navigation);
  const hero = new BattleCharacter('warlock', statsCatalog, items);
  const session = new Session(campaign, undefined, undefined, items, hero, battleCatalog, statsCatalog, companions);
  session.bag.add('mercenary-emblem-black-knight');
  session.bag.add('mercenary-emblem-ranger');
  const emblemId = () => session.bag.entries.find(e => e.item.startsWith('mercenary-emblem-'))!.id;
  const first = session.party!.recruit(emblemId(), () => 0).member;
  const second = session.party!.recruit(emblemId(), () => 0).member;
  session.party!.deployFirstAvailable(first.id);
  session.party!.deployFirstAvailable(second.id);

  const heroActor = battleCatalog.classes.find(c => c.id === hero.classId)!.actor;
  const meleeActor = battleCatalog.classes.find(c => c.id === first.classId)!.actor;
  const rangedActor = battleCatalog.classes.find(c => c.id === second.classId)!.actor;
  const playerVisual = {
    entity: { id: 'player', actor: heroActor.id, x: 280, y: 216, flip: false },
    actor: heroActor,
    layers: [],
    container: createFakeContainer(280, 216),
  } as never;
  const phaserScene = createFakePhaserScene({
    cameras: { main: { width: 640, height: 360, zoomX: 1, zoomY: 1, worldView: undefined, followOffset: { x: 0, y: 0 }, setFollowOffset() {} } },
    tweens: { add: () => ({ stop() {}, pause() {}, resume() {} }), getTweensOf: () => [], killTweensOf: () => {} },
  });
  const world = await createTestWorldCombat({
    hero,
    session,
    map,
    movement,
    phaserScene,
    playerVisual,
    battleCatalog,
    sceneOverrides: {
      facing: 'west',
      activeStoryRegions: (excludeAt?: Point) =>
        activeGates.filter(rect => !excludeAt || !overlapsFootRect(excludeAt, rect)),
    },
    appOverrides: {
      world: {
        actors: {
          [first.definition.actor]: meleeActor,
          [second.definition.actor]: rangedActor,
          [meleeActor.id]: meleeActor,
          [rangedActor.id]: rangedActor,
        },
      } as never,
    },
  });
  await world.combat.start();

  const findVisual = (id: string) => {
    for (const visual of movement.positions.keys()) if (visual.entity.id === id) return visual;
    return undefined;
  };
  const posOf = (id: string) => movement.position(id === 'player' ? world.playerVisual : findVisual(id)!);

  // 1. 复现国境关口回退点 (280, 216) 朝西收拢：原本后排侧位 (316, 192) 会把佣兵直接塞进 borderGate 内
  movement.place(world.playerVisual, { x: 280, y: 216 });
  world.scene.facing = 'west';
  world.combat.regroupPartyAroundHero();
  for (const id of [first.id, second.id]) {
    assert.equal(overlapsFootRect(posOf(id), borderGate), false, `朝西收拢后 ${id} 不能落进国境石门触发区`);
  }

  // 2. 主角贴近触发区边缘 (294, 192) 在四个朝向反复调整并推进 PartyFollow 寻路：近战前排与远程后排都不能踏入 borderGate
  movement.place(world.playerVisual, { x: 294, y: 192 });
  for (const facing of ['east', 'west', 'north', 'south'] as const) {
    world.scene.facing = facing;
    for (let step = 0; step < 25; step++) {
      world.combat.update(60, true);
      for (const id of [first.id, second.id]) {
        assert.equal(overlapsFootRect(posOf(id), borderGate), false, `主角朝 ${facing} 微调时 ${id} 不能踏入触发区`);
      }
    }
  }

  // 3. 16px 窄横向封锁条带 (y=232..248)：主角站在北侧 (296, 220) 朝北时，后排偏移 (+36px 南) 会落到条带南侧 y=256；
  //    regroup 与 PartyFollow 都绝不能把佣兵跨过 16px 封锁带送到 y >= 232 一侧
  activeGates = [borderGate, southCorridorGate];
  movement.place(world.playerVisual, { x: 288, y: 216 });
  world.scene.facing = 'north';
  world.combat.regroupPartyAroundHero();
  for (const id of [first.id, second.id]) {
    const p = posOf(id);
    assert.equal(overlapsFootRect(p, southCorridorGate), false, `${id} 不能压在 16px 封锁条带上`);
    assert.equal(overlapsFootRect(p, borderGate), false);
    assert.ok(p.y < southCorridorGate.y, `${id} 不能跨过 16px 封锁条带落到南侧 (实际 y=${p.y})`);
  }
  for (let step = 0; step < 30; step++) {
    world.combat.update(60, true);
    for (const id of [first.id, second.id]) {
      const p = posOf(id);
      assert.equal(overlapsFootRect(p, southCorridorGate), false);
      assert.ok(p.y < southCorridorGate.y, `跟随期间 ${id} 不能跨过 16px 封锁条带 (实际 y=${p.y})`);
    }
  }

  // 4. 若某个条件区域刚生效时佣兵恰好站在触发区内，剧情收尾 settleFriendlyUnitsAroundHero 会将其拉回主角安全侧
  movement.place(findVisual(first.id)!, { x: 320, y: 184 });
  assert.equal(world.combat.hasAllyInBlockedStoryRegion(), true);
  world.combat.settleFriendlyUnitsAroundHero();
  assert.equal(world.combat.hasAllyInBlockedStoryRegion(), false, '收尾后站在触发区内的闲置佣兵被拉回主角安全侧');

  world.combat.destroy();
});

test('重复区域阻拦连续触发与操控佣兵踩入阻拦区（含主角存活未动、主角 0 血倒地）均切回主角并拉回退点安全侧', async () => {
  const battleCatalog = normalizeBattleCatalog(loadBattleCatalog());
  const items = loadItemCatalog();
  const statsCatalog = loadCharacterStatsCatalog();
  const campaign = loadCampaignCatalog();
  const companions = loadCompanionCatalog();

  const rawBorder = JSON.parse(
    readFileSync(new URL('../public/content/maps/border-gateway-67e044a2.json', import.meta.url), 'utf8'),
  );
  const map: WorldMap = parseMap(rawBorder);
  const borderGate: GameRectangle = { x: 304, y: 112, width: 128, height: 112 };

  const navigation = new NavigationWorld(map);
  const movement = createFakeMovementWorld(navigation);
  const hero = new BattleCharacter('warlock', statsCatalog, items);
  const session = new Session(campaign, undefined, undefined, items, hero, battleCatalog, statsCatalog, companions);
  session.applyStoryCommands([
    { type: 'travel', destination: { map: map.id, x: 186, y: 210, facing: 'east' } },
  ]);
  session.bag.add('mercenary-emblem-black-knight');
  const emblemEntry = session.bag.entries.find(e => e.item === 'mercenary-emblem-black-knight')!;
  const ally = session.party!.recruit(emblemEntry.id, () => 0).member;
  session.party!.deployFirstAvailable(ally.id);

  const heroActor = battleCatalog.classes.find(c => c.id === hero.classId)!.actor;
  const allyActor = battleCatalog.classes.find(c => c.id === ally.classId)!.actor;
  const playerVisual = {
    entity: { id: 'player', actor: heroActor.id, x: 186, y: 210, flip: false },
    actor: heroActor,
    layers: [],
    container: createFakeContainer(186, 210),
  } as never;
  const phaserScene = createFakePhaserScene({
    cameras: { main: { width: 640, height: 360, zoomX: 1, zoomY: 1, worldView: undefined, followOffset: { x: 0, y: 0 }, setFollowOffset() {} } },
    tweens: { add: () => ({ stop() {}, pause() {}, resume() {} }), getTweensOf: () => [], killTweensOf: () => {} },
  });

  let worldScene!: InstanceType<typeof WorldScene>;
  const combatHarness = await createTestWorldCombat({
    hero,
    session,
    map,
    movement,
    phaserScene,
    playerVisual,
    battleCatalog,
    sceneOverrides: {
      activeStoryRegions: (excludeAt?: Point) => (worldScene ? worldScene.activeStoryRegions(excludeAt) : []),
      syncControlledCharacter: (reset?: boolean) => worldScene?.syncControlledCharacter(reset),
    },
    appOverrides: {
      world: { actors: { [ally.definition.actor]: allyActor, [allyActor.id]: allyActor } } as never,
    },
  });
  await combatHarness.combat.start();

  // 轻量逻辑舞台表现端口：真实捕获正式世界主角起点并执行 event-422 的 walk/face 动作
  let baselineLocation: TravelDestination | undefined;
  let currentStage: StoryStageSnapshot | undefined;
  const presentation: StoryPresentationPort = {
    begin(_signal, declared) {
      const p = movement.position(playerVisual);
      baselineLocation = { map: map.id, x: p.x, y: p.y, facing: worldScene.facing };
      currentStage = stageSnapshot({
        type: 'stage',
        map: declared?.map ?? map.id,
        x: declared?.retainPlayerPosition ? p.x : (declared?.x ?? p.x),
        y: declared?.retainPlayerPosition ? p.y : (declared?.y ?? p.y),
        facing: declared?.retainPlayerPosition ? worldScene.facing : (declared?.facing ?? worldScene.facing),
        playerVisible: true,
        retainPlayerPosition: declared?.retainPlayerPosition,
        cast: [],
      });
    },
    async execute(action) {
      if (action.type === 'stage') {
        const p = movement.position(playerVisual);
        currentStage = stageSnapshot({
          ...action,
          x: action.retainPlayerPosition ? p.x : action.x,
          y: action.retainPlayerPosition ? p.y : action.y,
          facing: action.retainPlayerPosition ? worldScene.facing : action.facing,
        });
      } else if (action.type === 'walk' && action.target === 'player' && currentStage) {
        currentStage = stageSnapshot({ ...currentStage, x: action.x, y: action.y });
      } else if (action.type === 'face' && action.target === 'player' && currentStage) {
        currentStage = stageSnapshot({ ...currentStage, facing: action.facing });
      }
    },
    async finish() {},
    getStageState: () => currentStage,
    getBaselineLocation: () => baselineLocation,
    getWorldChanges: () => [],
    release() {
      baselineLocation = undefined;
      currentStage = undefined;
    },
  };

  let director!: StoryDirector;
  worldScene = buildTestWorldScene(WorldScene, {
    map,
    player: playerVisual,
    characters: [],
    loadingWorld: false,
    destroyed: false,
    movement,
    combat: combatHarness.combat,
    app: {
      get director() { return director; },
      campaign,
      session,
      world: headlessContent.world,
      ui: { setWorldRebuildCover() {} },
    },
    sceneOverrides: {
      worldReady: () => true,
      loadAssets: async () => ({ release() {} }),
      projectEquipment: async () => {},
      refreshState() {},
      syncHud() {},
      setClip() {},
      cameras: { main: { startFollow() {} } },
    },
  });
  (worldScene as unknown as { lastProjectedLocation: string }).lastProjectedLocation =
    `rev:${session.storyWorld.locationRevision}:${JSON.stringify(session.storyWorld.currentLocation)}`;

  director = new StoryDirector(
    campaign,
    session,
    {
      dialogue: async () => {},
      choice: async (_p, options) => options[0]!,
      questPopup: async () => {},
      closeDialogue() {},
      skipDialogue() {},
    },
    () => {},
    presentation,
    {
      normalize: signal => worldScene.normalizeForStory(signal),
      capture: () => ({ location: session.storyWorld.currentLocation }),
      restore: async () => {},
      project: (stage, signal) => worldScene.projectStoryWorld(stage, signal),
      checkpoint() {},
      settle: () => worldScene.settleStoryPlayback(),
    },
  );

  const allyVisual = [...movement.positions.keys()].find(v => v.entity.id === ally.id)!;
  const xy = (visual: typeof playerVisual) => {
    const p = movement.position(visual);
    return { x: p.x, y: p.y };
  };

  try {
    // 1. 连续第 1、2、3 次踩入 event-422：自由移动不改 storyWorld.currentLocation，第 2、3 次也必须 100% 拉回 (280, 216)
    for (let attempt = 1; attempt <= 3; attempt++) {
      movement.place(playerVisual, { x: 312, y: 200 });
      worldScene.facing = 'east';
      worldScene.triggers.occupiedTriggers.add('event-422');
      const played = await director.enterRegion('event-422', map.id);
      assert.equal(played, true, `第 ${attempt} 次应成功触发 event-422`);
      assert.deepEqual(xy(playerVisual), { x: 280, y: 216 }, `第 ${attempt} 次阻拦后主角必须被拉回 (280, 216)`);
      assert.equal(worldScene.facing, 'west');
      assert.equal(worldScene.triggers.occupiedTriggers.has('event-422'), false, `第 ${attempt} 次回退后占用立即释放`);
      assert.equal(overlapsFootRect(movement.position(allyVisual), borderGate), false, `第 ${attempt} 次回退后佣兵不得落入触发区`);
    }

    // 2. 主角原地停在 (280, 216, west) 一动不动，玩家切换操控到佣兵并把佣兵走进 event-422 (320, 180)：
    //    事件结束后必须切回主角操控，并把佣兵从触发区内部拉回主角安全侧
    assert.equal(combatHarness.combat.switchControl(ally.id), true);
    assert.equal(session.party!.controlledId, ally.id);
    movement.place(allyVisual, { x: 320, y: 180 });
    worldScene.triggers.occupiedTriggers.add('event-422');
    await director.enterRegion('event-422', map.id);

    assert.equal(session.party!.controlledId, 'player', '剧情事件结束后操控权按原版归还主角');
    assert.equal(combatHarness.combat.controlledId, 'player');
    assert.deepEqual(xy(playerVisual), { x: 280, y: 216 });
    assert.equal(overlapsFootRect(movement.position(allyVisual), borderGate), false, '佣兵从阻拦区内部被收拢回安全侧');
    assert.equal(worldScene.triggers.occupiedTriggers.has('event-422'), false);

    // 3. 主角 0 血阵亡倒地、玩家操控独活佣兵踩入阻拦事件（及含显式 party-control: player 的事件）：
    //    按原版以 10% 生命复苏主角并切回主角操控，不抛错、不原地位移偏离退点
    hero.setHealth(0);
    for (let tick = 0; tick < 12; tick++) combatHarness.combat.update(60, true);
    assert.equal(session.party!.controlledId, ally.id, '主角倒地结算后自动切到存活佣兵');
    movement.place(allyVisual, { x: 320, y: 180 });
    await director.enterRegion('event-422', map.id);

    assert.equal(hero.player.health, Math.max(1, Math.floor(hero.player.maxHealth * 0.1)), '倒地主角按原版 10% 生命复苏');
    assert.equal(session.party!.controlledId, 'player', '复苏后操控权顺利切回主角且不报错');
    assert.deepEqual(xy(playerVisual), { x: 280, y: 216 }, '复苏主角保持在剧情退点原位');
    assert.equal(overlapsFootRect(movement.position(allyVisual), borderGate), false);

    // 4. 校验 storyCommitCommands 对显式含 party-control: player 的节点（如雪原 event-288）同样在主角 0 血时前置 10% 复苏命令
    const explicitCommands = storyCommitCommands(
      {
        commands: [{ type: 'party-control', member: 'player' }],
        checkpoint: {
          ...director.runtime.snapshot(),
          runs: [{
            id: 'r1',
            script: 'event-288',
            occurrence: 'region:1',
            cursor: { script: 'event-288', node: 'scene-1' },
            status: 'completed',
          }],
        },
        node: { script: 'event-288', node: 'scene-1' },
        runId: 'r1',
        stage: stageSnapshot({ type: 'stage', map: 'snowfield-2-669b8e3a', x: 280, y: 520, facing: 'south', playerVisible: true, cast: [] }),
      },
      session.storyWorld,
      [],
      () => true,
      { controlledMemberId: ally.id, heroHealth: { health: 0, maxHealth: 3520 } },
    );
    const healthIdx = explicitCommands.findIndex(c => c.type === 'health' && c.member === 'player');
    const controlIdx = explicitCommands.findIndex(c => c.type === 'party-control' && c.member === 'player');
    assert.ok(healthIdx >= 0 && healthIdx < controlIdx, '10% 生命复苏命令必须排在 party-control 之前');

    // 5. 多节点剧情在早先节点已让唯一存活伙伴离队（party-leave 已先把 controlledId 退回 0 血主角）时，收尾交还仍须合成 10% 生命复苏
    const soleSurvivorLeaveCommands = storyCommitCommands(
      {
        commands: [],
        checkpoint: {
          ...director.runtime.snapshot(),
          runs: [{
            id: 'r2',
            script: 'event-113',
            occurrence: 'region:2',
            cursor: { script: 'event-113', node: 'scene-5' },
            status: 'completed',
          }],
        },
        node: { script: 'event-113', node: 'scene-5' },
        runId: 'r2',
        stage: stageSnapshot({ type: 'stage', map: map.id, x: 280, y: 216, facing: 'west', playerVisible: true, cast: [] }),
      },
      session.storyWorld,
      [],
      () => false,
      { controlledMemberId: 'player', heroHealth: { health: 0, maxHealth: 2400 } },
    );
    assert.deepEqual(
      soleSurvivorLeaveCommands.filter(c => c.type === 'health'),
      [{ type: 'health', member: 'player', value: 240 }],
      '唯一存活同伴提前离队后收尾仍复苏 0 血主角，防止交还瞬间全灭',
    );
  } finally {
    director.dispose();
    combatHarness.combat.destroy();
  }
});

test('AI 位移技能、追近途中切人、操控佣兵复活倒地主角、狭小口袋叠站、无舞台收尾与读档同步均不越界或误扫掠', async () => {
  const battleCatalog = normalizeBattleCatalog(loadBattleCatalog());
  const items = loadItemCatalog();
  const statsCatalog = loadCharacterStatsCatalog();
  const campaign = loadCampaignCatalog();
  const companions = loadCompanionCatalog();

  const rawBorder = JSON.parse(
    readFileSync(new URL('../public/content/maps/border-gateway-67e044a2.json', import.meta.url), 'utf8'),
  );
  const map: WorldMap = parseMap(rawBorder);
  const borderGate: GameRectangle = { x: 304, y: 112, width: 128, height: 112 };
  const southCorridorGate: GameRectangle = { x: 0, y: 232, width: 480, height: 16 };
  const activeGates: GameRectangle[] = [borderGate, southCorridorGate];

  const navigation = new NavigationWorld(map);
  const movement = createFakeMovementWorld(navigation);
  const hero = new BattleCharacter('warlock', statsCatalog, items);
  const session = new Session(campaign, undefined, undefined, items, hero, battleCatalog, statsCatalog, companions);
  session.bag.add('mercenary-emblem-assassin');
  session.bag.add('mercenary-emblem-priest');
  session.bag.add('resurrection-scroll', 3);
  const emblemId = () => session.bag.entries.find(e => e.item.startsWith('mercenary-emblem-'))!.id;
  const assassin = session.party!.recruit(emblemId(), () => 0).member;
  const templar = session.party!.recruit(emblemId(), () => 0).member;
  session.party!.deployFirstAvailable(assassin.id);
  session.party!.deployFirstAvailable(templar.id);

  const heroActor = battleCatalog.classes.find(c => c.id === hero.classId)!.actor;
  const assassinActor = battleCatalog.classes.find(c => c.id === assassin.classId)!.actor;
  const templarActor = battleCatalog.classes.find(c => c.id === templar.classId)!.actor;
  const playerVisual = {
    entity: { id: 'player', actor: heroActor.id, x: 288, y: 216, flip: false },
    actor: heroActor,
    layers: [],
    container: createFakeContainer(288, 216),
  } as never;
  const phaserScene = createFakePhaserScene({
    cameras: { main: { width: 640, height: 360, zoomX: 1, zoomY: 1, worldView: undefined, followOffset: { x: 0, y: 0 }, setFollowOffset() {} } },
    tweens: { add: () => ({ stop() {}, pause() {}, resume() {} }), getTweensOf: () => [], killTweensOf: () => {} },
  });

  let syncedPositions: Point[] = [];
  const world = await createTestWorldCombat({
    hero,
    session,
    map,
    movement,
    phaserScene,
    playerVisual,
    battleCatalog,
    sceneOverrides: {
      facing: 'south',
      activeStoryRegions: (excludeAt?: Point) =>
        activeGates.filter(rect => !excludeAt || !overlapsFootRect(excludeAt, rect)),
      syncControlledCharacter: () => {
        const controlled = world.combat.controlledVisual ?? playerVisual;
        syncedPositions.push({ ...movement.position(controlled) });
      },
    },
    appOverrides: {
      world: {
        actors: {
          [assassin.definition.actor]: assassinActor,
          [templar.definition.actor]: templarActor,
          [assassinActor.id]: assassinActor,
          [templarActor.id]: templarActor,
        },
      } as never,
    },
  });
  await world.combat.start();

  const findVisual = (id: string) => [...movement.positions.keys()].find(v => v.entity.id === id)!;
  const assassinVisual = findVisual(assassin.id);
  const templarVisual = findVisual(templar.id);

  try {
    // 1. 刺客 AI 的 canRelocateReach / relocate 严禁跨过 16px 窄封锁带 (y=232..248) 瞬移到南侧敌人背后
    movement.place(playerVisual, { x: 288, y: 216 });
    movement.place(assassinVisual, { x: 288, y: 216 });
    const internals = world.combat as unknown as {
      allies: { id: string; ai: { port: { canRelocateReach(p: Point): boolean; relocate(p: Point): boolean; moveToward(p: Point): void } }; controller: { actionState(): string; requestTarget(targetId: string): string } }[];
    };
    const assassinEntry = internals.allies.find(a => a.id === assassin.id)!;
    assert.equal(assassinEntry.ai.port.canRelocateReach({ x: 288, y: 264 }), false, '非受控刺客不能跨过 16px 封锁条带判定可达');
    assert.equal(assassinEntry.ai.port.relocate({ x: 288, y: 264 }), false, '非受控刺客不能跨过 16px 封锁条带瞬移落位');
    assert.ok(movement.position(assassinVisual).y < southCorridorGate.y);

    // 2. 追近敌人途中 (approaching) 按 Q 切人：原角色的手动追近立即取消，且非受控 moveToward 遇到触发边界立即刹停
    const placedEnemy = world.roster.placeEnemy(battleCatalog.enemies[0]!.id, 336, 180);
    (world.combat as unknown as { spawnEnemy(p: unknown): void }).spawnEnemy(placedEnemy);
    assert.equal(world.combat.switchControl(assassin.id), true);
    assert.equal(assassinEntry.controller.requestTarget(placedEnemy.key), 'started');
    assert.equal(assassinEntry.controller.actionState(), 'approaching');
    assert.equal(world.combat.switchControl('player'), true);
    assert.equal(assassinEntry.controller.actionState(), 'idle', '切走操控后未出手的 approaching 立即取消，不盲目直穿禁区');
    movement.place(assassinVisual, { x: 294, y: 180 });
    assassinEntry.ai.port.moveToward({ x: 336, y: 180 });
    for (let step = 0; step < 10; step++) world.combat.update(60, true);
    assert.equal(overlapsFootRect(movement.position(assassinVisual), borderGate), false, '非受控 moveToward 在触发区边缘刹停');

    // 3. 主角 0 血阵亡、玩家操控刺客贴在 16px 封锁条带北侧 (288, 222) 用复活卷轴复活主角：非受控主角绝不能被推过 16px 条带或推进 borderGate
    hero.setHealth(0);
    for (let tick = 0; tick < 12; tick++) world.combat.update(60, true);
    assert.equal(world.combat.controlledId, assassin.id);
    movement.place(assassinVisual, { x: 288, y: 222 });
    movement.place(templarVisual, { x: 272, y: 222 });
    const scrollEntry = session.bag.entries.find(e => e.item === 'resurrection-scroll')!;
    world.combat.revive('player', scrollEntry.id);
    assert.equal(world.combat.controlledId, assassin.id, '操控存活佣兵用复活卷轴复活主角后仍保持操控该佣兵');
    const revivedHeroPos = movement.position(playerVisual);
    assert.equal(overlapsFootRect(revivedHeroPos, borderGate), false);
    assert.equal(overlapsFootRect(revivedHeroPos, southCorridorGate), false);
    assert.ok(revivedHeroPos.y < southCorridorGate.y, `非受控复活主角不能跨过 16px 封锁条带 (y=${revivedHeroPos.y})`);

    // 4. 无舞台交互/交付收尾 settleFriendlyUnitsAroundHero：当操控佣兵远离主角（甚至主角 0 血倒在远处）时，绝不把受控佣兵拉回主角身边
    hero.setHealth(0);
    for (let tick = 0; tick < 12; tick++) world.combat.update(60, true);
    movement.place(playerVisual, { x: 80, y: 200 });
    movement.place(assassinVisual, { x: 260, y: 200 });
    movement.place(templarVisual, { x: 244, y: 200 });
    world.combat.settleFriendlyUnitsAroundHero();
    assert.deepEqual(
      { x: movement.position(assassinVisual).x, y: movement.position(assassinVisual).y },
      { x: 260, y: 200 },
      '无舞台脚本收尾绝不把当前受控佣兵拉回远处倒地主角尸体旁',
    );

    // 5. 狭小安全口袋被队友占满时，choosePartyLanding 放宽队友重叠限制，仍落在安全侧而非返回 undefined 把佣兵留在禁区内
    const pocketBox: GameRectangle = { x: 260, y: 180, width: 60, height: 60 };
    const onlyPocketAllowed = (p: Point) =>
      p.x >= 276 && p.x <= 292 && p.y >= 208 && p.y <= 220 && !overlapsFootRect(p, pocketBox);
    const crampedAllowed = (p: Point) => p.x >= 276 && p.x <= 292 && p.y >= 208 && p.y <= 220;
    const stackedLanding = choosePartyLanding(
      navigation,
      { collision: assassinActor.collision },
      { x: 284, y: 214 },
      undefined,
      [{ x: 280, y: 212 }, { x: 288, y: 212 }, { x: 284, y: 218 }],
      { allowed: crampedAllowed },
    );
    assert.ok(stackedLanding && crampedAllowed(stackedLanding), '狭小安全侧被队友占满时放宽重叠落在安全侧，不留人在禁区');
    void onlyPocketAllowed;

    // 6. 读档 restoreState 恢复受控佣兵远端坐标后才触发 syncControlledCharacter，避免从旧出生点拉出全图虚假扫掠线段
    syncedPositions = [];
    const savedState = world.combat.captureState();
    movement.place(assassinVisual, { x: 96, y: 200 });
    await world.combat.restoreState(savedState);
    assert.deepEqual(
      syncedPositions.at(-1),
      { x: 260, y: 200 },
      'restoreState 在队员移回存档坐标后才同步受控者参考起点',
    );

    // 7. ExitTrigger.syncPosition 切人不累计虚假行走距离；阵亡渐隐 alpha=0 的主角进剧情舞台立即恢复不透明
    const exit = { x: 0, y: 192, width: 16, height: 32, target: 'other', spawn: { x: 32, y: 32 } };
    const exitTrigger = new ExitTrigger([exit], { x: 8, y: 208 }, true);
    exitTrigger.syncPosition({ x: 64, y: 208 });
    exitTrigger.syncPosition({ x: 8, y: 208 });
    assert.equal(exitTrigger.update({ x: 8, y: 208 }, true), null, '反复按 Q 切人不会累计 80px 提前解锁出口保护');

    const fadedStage = resolveStoryScene(
      { type: 'stage', map: map.id, x: 280, y: 216, facing: 'west', playerVisible: true, retainPlayerPosition: true, cast: [] },
      {
        map: map.id,
        actors: [{ id: 'player', actor: heroActor.id, memberId: 'player', x: 280, y: 216, facing: 'west', visible: true, alpha: 0 }],
      },
    );
    assert.equal(fadedStage.scene.actors[0]!.alpha, undefined, '阵亡渐隐 alpha=0 的主角进剧情舞台恢复不透明');
    const hiddenThenShown = applyStorySceneAction(
      {
        ...fadedStage,
        scene: {
          ...fadedStage.scene,
          actors: [{ id: 'player', actor: heroActor.id, memberId: 'player', x: 280, y: 216, facing: 'west', visible: false, alpha: 0 }],
        },
      },
      { type: 'show', target: 'player' },
    );
    assert.equal(hiddenThenShown.scene.actors[0]!.alpha, undefined, 'show 动作同样清掉残留 alpha=0');
  } finally {
    world.combat.destroy();
  }
});

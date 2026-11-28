import assert from 'node:assert/strict';
import { captureSessionSave, prepareSavedGame } from '../../src/application/saved-game.ts';
import type { SaveWorldResult, StoryWorldViewSnapshot } from '../../src/application/world-snapshot.ts';
import type { CampaignQuest } from '../../src/domain/campaign.ts';
import { nearInteractive } from '../../src/domain/chests.ts';
import type {
  ActorDefinition,
  ChoiceOption,
  EntityPlacement,
  QuestRewardReceipt,
  QuestStatus,
  TravelDestination,
} from '../../src/domain/content.ts';
import { groundLootFor } from '../../src/domain/ground-loot.ts';
import {
  interactionCandidateRank,
  pickNearestInteractionTarget,
  resolveInteraction,
  withinInteractionRange,
} from '../../src/domain/interaction.ts';
import { overlapsFootRect, type Point } from '../../src/domain/navigation.ts';
import { QuestEnemyWatch } from '../../src/domain/quest-enemies.ts';
import type { SaveGame } from '../../src/domain/save-game.ts';
import type { Session } from '../../src/domain/session.ts';
import { Storefront } from '../../src/domain/shop.ts';
import { newStorySession } from '../../src/domain/story-class.ts';
import { storyConditionReferences, type StoryCondition } from '../../src/domain/story-condition.ts';
import { StoryDirector, type StoryWorldPort } from '../../src/domain/story-director.ts';
import type { StoryEvent } from '../../src/domain/story-graph.ts';
import type { PerformanceAction } from '../../src/domain/story-performance.ts';
import { buildStoryTriggerIndex } from '../../src/domain/story-trigger-index.ts';
import { claimStoryTrigger } from '../../src/domain/story-trigger-occupancy.ts';
import { storyExitId } from '../../src/domain/story-world.ts';
import { applyStoryEnemyRemovals, encounterSpawnId, WorldEnemyRoster } from '../../src/domain/world-enemies.ts';
import { applyQuestStartPlan, planQuestStart } from '../../src/debug/quest-jump.ts';
import { GameUI } from '../../src/ui/game-ui.ts';
import { questNotices, type QuestNoticeState } from '../../src/ui/quest-progress.ts';
import {
  buildCampaignIndexes,
  buildContentSourceIndexes,
  extractChoiceCondition,
  extractFlagExpectations,
  extractQuestStatuses,
  loadOfficialQuestContent,
  type QuestHarnessContent,
} from './quest-e2e-indexes.ts';
import { createQuestNavigation, type ObstacleTarget } from './quest-e2e-navigation.ts';
import { createStoryPresentationPorts } from './quest-e2e-stage.ts';

export { buildCampaignIndexes, loadOfficialQuestContent, type QuestHarnessContent };
export { runContinuousCampaignPlaythrough, type ContinuousPlaythroughReport } from './quest-e2e-playthrough.ts';

export interface PopupRecord {
  kind: 'start' | 'complete';
  questId: string;
  reward?: QuestRewardReceipt;
  statusAtOpen: QuestStatus;
  deferredHeldAtOpen: boolean;
}

export interface QuestHarnessOptions {
  classId?: string;
  targetQuestId?: string;
  saved?: SaveGame<StoryWorldViewSnapshot>;
  validateStages?: boolean;
  /** 是否允许单任务闭环按条件树反推前置事件/子任务；一镜到底连贯通关设为 false，强制 100% 自然前向推进。 */
  allowRecursiveConditionSolve?: boolean;
  chooseOption?: (
    options: ChoiceOption[],
    context: { choiceKey?: string; casesMap?: Record<string, { script: string; node: string }> },
  ) => ChoiceOption | undefined;
  onPopupOpen?: (kind: 'start' | 'complete', quest: CampaignQuest, reward: QuestRewardReceipt | undefined, ui: GameUI) => void | Promise<void>;
  onStageAction?: (action: PerformanceAction) => void | Promise<void>;
}

const flushTurn = () => new Promise<void>(resolve => setImmediate(resolve));

/**
 * 纯状态机任务闭环底座：不加载 Phaser、不模拟小人寻路跑图，
 * 直接连接真实 Session + StoryDirector + GameUI + 正式格式 1 存读档。
 */
export function createQuestE2EHarness(content: QuestHarnessContent, options: QuestHarnessOptions = {}) {
  const indexes = buildCampaignIndexes(content.campaign);
  const sources = buildContentSourceIndexes(content);
  const kiyanActor = content.world.actors[content.campaign.start.actor] ?? content.world.actors.kiyan!;
  const validateStages = options.validateStages ?? true;
  const allowRecursiveSolve = options.allowRecursiveConditionSolve ?? true;
  const chosenClass = options.classId
    ? content.storyClasses.classes.find(entry => entry.id === options.classId) ?? content.storyClasses.classes[0]!
    : content.storyClasses.classes[0]!;

  let session: Session;
  let triggerContacts: { regions: string[]; characters: string[]; nearEvents: string[] } = {
    regions: [],
    characters: [],
    nearEvents: [],
  };

  if (options.saved) {
    const prepared = prepareSavedGame(options.saved, {
      campaign: content.campaign,
      world: content.world,
      storyClasses: content.storyClasses,
      items: content.items,
      characterStats: content.stats,
      battleCatalog: content.battle,
      companions: content.companions,
    });
    session = prepared.session;
    if (prepared.world.triggerContacts) {
      triggerContacts = structuredClone(prepared.world.triggerContacts);
    }
  } else {
    session = newStorySession(
      content.campaign,
      content.world.actors[content.campaign.start.actor]!,
      chosenClass,
      content.items,
      content.stats,
      content.battle,
      content.companions,
    );
    session.applyStoryCommands([{ type: 'travel', destination: { ...content.campaign.start, facing: 'south' } }]);
  }

  const questEnemies = new QuestEnemyWatch(session, content.drops.questItems);
  const nav = createQuestNavigation(content, sources, session, kiyanActor, {
    enforceOneShotRegionGates: !allowRecursiveSolve,
  });
  const {
    currentMapObj,
    visibleEntities,
    reachableMapsFrom,
    pickBestReachableEntrance,
    isEnemySpawnReachable,
    canStaticallyWalkBetween,
    hasFormalStoryBridgeToIsland,
    reachableCellsWithDynamicObstacles,
    assertRegionReachable,
    assertEntityApproachable,
    findBlockingUnlockEvents,
  } = nav;

  const ui = new GameUI();
  ui.setMode('game');
  ui.loaded();

  let targetQuestId = options.targetQuestId;
  let phaseMode: 'admit' | 'complete' = 'complete';
  const choiceQueue: string[] = [];
  let pausePopupKind: 'start' | 'complete' | 'any' | undefined;
  let pausedPopupConfirm: (() => void) | undefined;
  let pauseDialogue = false;
  let expectErrors = false;

  const log = {
    dialogues: [] as { speaker: string; text: string }[],
    popups: [] as PopupRecord[],
    instants: [] as string[],
    shopsOpened: [] as string[],
    servicesOpened: [] as string[],
    eventsCompleted: [] as string[],
    skipPhases: [] as string[],
    crossIslandTransfers: [] as { questId?: string; from: string; to: string; reason: string }[],
    errors: [] as { error: unknown; retry: () => Promise<boolean> }[],
  };

  let questStatuses = new Map<string, QuestNoticeState>();
  let questStatusVersion = -1;
  let questNoticesArmed = false;

  const syncQuestNotices = () => {
    const version = session.questBook.version;
    if (version === questStatusVersion) return;
    const { snapshot, completions, progress } = questNotices(
      questStatuses,
      session.quests,
      id => session.definition(id),
    );
    questStatuses = snapshot;
    questStatusVersion = version;
    if (!questNoticesArmed) {
      questNoticesArmed = true;
      return;
    }
    for (const msg of completions) {
      ui.showInstant(msg);
      log.instants.push(msg);
    }
    if (!completions.length && progress) {
      ui.showInstant(progress);
      log.instants.push(progress);
    }
  };
  syncQuestNotices();
  session.subscribe(() => syncQuestNotices());

  const presentation = createStoryPresentationPorts({
    content,
    session,
    validateStages,
    onStageAction: options.onStageAction,
  });

  let activeTriggerMap = session.storyWorld.currentLocation?.map ?? content.campaign.start.map;
  const occupiedRegions = new Set<string>(triggerContacts.regions);
  const occupiedCharacters = new Set<string>(triggerContacts.characters);
  const occupiedNearEvents = new Set<string>(triggerContacts.nearEvents);
  const syncTriggerContacts = () => {
    triggerContacts = {
      regions: [...occupiedRegions],
      characters: [...occupiedCharacters],
      nearEvents: [...occupiedNearEvents],
    };
  };
  const resetMapTriggerContacts = (nextMapId: string) => {
    if (activeTriggerMap !== nextMapId) {
      activeTriggerMap = nextMapId;
      occupiedRegions.clear();
      occupiedCharacters.clear();
      occupiedNearEvents.clear();
      syncTriggerContacts();
    }
  };

  let worldBaseline: { location?: TravelDestination } = {};
  const worldPort: StoryWorldPort = {
    capture: () => ({ location: session.storyWorld.currentLocation ? { ...session.storyWorld.currentLocation } : undefined }),
    restore: async snapshot => {
      worldBaseline = (snapshot as typeof worldBaseline) ?? {};
      if (worldBaseline.location) {
        resetMapTriggerContacts(worldBaseline.location.map);
        session.storyWorld.apply({ kind: 'travel', destination: worldBaseline.location });
      }
    },
    project: async () => {
      const loc = session.storyWorld.currentLocation;
      if (loc && content.maps.has(loc.map)) {
        resetMapTriggerContacts(loc.map);
        const m = content.maps.get(loc.map)!;
        session.enterMap(m.id, m.questItemSpawns ?? [], m, m.enemySpawns);
      }
    },
    checkpoint: () => {},
  };

  /** 从脚本定义本身自动评估哪个选项能推进目标任务（零任务 ID 硬编码）。 */
  const pickOptionForGoal = (optionsList: ChoiceOption[]): ChoiceOption => {
    while (choiceQueue.length > 0) {
      const queued = choiceQueue.shift()!;
      const hit = optionsList.find(o => o.value === queued);
      if (hit) return hit;
    }
    const runs = director.runtime.snapshot().runs;
    let choiceKey: string | undefined;
    let casesMap: Record<string, { script: string; node: string }> | undefined;
    for (const run of runs) {
      const script = content.campaign.scripts[run.cursor.script];
      const node = script?.nodes.find(n => n.id === run.cursor.node);
      if (node?.exit.type === 'choice') {
        choiceKey = node.exit.choice;
        casesMap = node.exit.cases;
        break;
      }
    }
    if (options.chooseOption) {
      const custom = options.chooseOption(optionsList, { choiceKey, casesMap });
      if (custom && optionsList.includes(custom)) return custom;
    }
    if (!choiceKey) return optionsList[0]!;

    let best = optionsList[0]!;
    let bestScore = -Infinity;
    for (const opt of optionsList) {
      let score = 0;
      const cEvents = indexes.choiceEvents.get(`${choiceKey}=${opt.value}`) ?? [];
      const cmds = cEvents.flatMap(ev => indexes.scriptQuestCommands.get(ev.script) ?? []);
      if (casesMap?.[opt.value]) {
        const targetNode = content.campaign.scripts[casesMap[opt.value]!.script]?.nodes.find(
          n => n.id === casesMap[opt.value]!.node,
        );
        for (const cmd of targetNode?.commands ?? []) {
          if (cmd.type === 'quest') cmds.push(cmd.command);
        }
      }
      for (const qc of cmds) {
        if ('quest' in qc && targetQuestId && qc.quest === targetQuestId) {
          if (qc.type === 'accept' || qc.type === 'script-ready') {
            score += 1000;
          } else if (qc.type === 'complete' || qc.type === 'script-complete') {
            score += phaseMode === 'admit' ? -400 : 1000;
          }
        } else if ('quest' in qc) {
          if ((qc.type === 'complete' || qc.type === 'script-complete') && ['active', 'ready'].includes(session.status(qc.quest))) {
            score += 200;
          }
          if (qc.type === 'accept' && session.status(qc.quest) === 'available') {
            score += 150;
          }
        }
      }
      for (const ev of cEvents) {
        if (!ev.repeat) score += 80;
        if (indexes.scriptHasTrap.get(ev.script)) score -= 500;
      }
      if (cEvents.length === 0 && cmds.length === 0) score -= 20;
      if (score > bestScore) {
        bestScore = score;
        best = opt;
      }
    }
    return best;
  };

  let handlingUi = false;
  let seenDialogueObj: unknown;
  let seenChoicesObj: unknown;
  let seenQuestObj: unknown;

  const pumpUi = () => {
    if (handlingUi) return;
    handlingUi = true;
    queueMicrotask(async () => {
      try {
        if (ui.dialogueLine && ui.dialogueState && ui.dialogueState !== seenDialogueObj) {
          seenDialogueObj = ui.dialogueState;
          log.dialogues.push({ speaker: ui.dialogueLine.speaker, text: ui.dialogueLine.text });
        }
        if (!pauseDialogue && ui.pending !== null) {
          while (ui.pending !== null && !pauseDialogue) ui.advance();
        }
        if (ui.choices && ui.choices !== seenChoicesObj) {
          seenChoicesObj = ui.choices;
          const currentChoices = ui.choices;
          const picked = pickOptionForGoal(currentChoices.options);
          currentChoices.choose(picked);
        }
        if (ui.quest && ui.quest !== seenQuestObj) {
          seenQuestObj = ui.quest;
          const currentPopup = ui.quest;
          const qid = currentPopup.definition.id;
          assert.notEqual(currentPopup.definition.journal, false, `日志外任务 ${qid} 不应弹出任务窗口`);
          const record: PopupRecord = {
            kind: currentPopup.kind,
            questId: qid,
            reward: currentPopup.reward,
            statusAtOpen: session.status(qid),
            deferredHeldAtOpen: director.runtime.busy === false && log.eventsCompleted.length >= 0,
          };
          log.popups.push(record);
          let popupHookError: unknown;
          try {
            await options.onPopupOpen?.(currentPopup.kind, currentPopup.definition, currentPopup.reward, ui);
          } catch (hookErr) {
            popupHookError = hookErr;
            log.errors.push({ error: hookErr, retry: () => director.retry() });
          }
          if (!popupHookError && (pausePopupKind === 'any' || pausePopupKind === currentPopup.kind)) {
            pausedPopupConfirm = () => {
              pausedPopupConfirm = undefined;
              pausePopupKind = undefined;
              currentPopup.confirm();
            };
          } else {
            currentPopup.confirm();
          }
        }
      } catch (err) {
        log.errors.push({ error: err, retry: () => director.retry() });
      } finally {
        handlingUi = false;
        if ((!pauseDialogue && ui.pending !== null) || (ui.choices && ui.choices !== seenChoicesObj) || (ui.quest && ui.quest !== seenQuestObj)) {
          pumpUi();
        }
      }
    });
  };

  ui.view = {
    sync() {
      pumpUi();
    },
    renderText() {},
    paginate(_ui, text) {
      return [{ text, end: text.length }];
    },
    async portrait() {},
  };

  const director = new StoryDirector(
    content.campaign,
    session,
    ui,
    locked => ui.lock(locked, 'story'),
    presentation,
    worldPort,
  );
  director.onEventCompleted = id => log.eventsCompleted.push(id);
  director.onSkipProgress = phase => log.skipPhases.push(phase);
  director.onError = (error, retry) => {
    log.errors.push({ error, retry });
    const message = error instanceof Error ? error.message : String(error);
    ui.error(message, () => {
      void retry();
    });
  };

  const loc0 = session.storyWorld.currentLocation;
  if (loc0 && content.maps.has(loc0.map)) {
    const m0 = content.maps.get(loc0.map)!;
    session.enterMap(m0.id, m0.questItemSpawns ?? [], m0, m0.enemySpawns);
  }

  /** 等待所有异步微任务、对白、弹窗与关联事件收尾；有未声明异常时立即抛出。 */
  const settle = async (): Promise<void> => {
    for (let micro = 0; micro < 12; micro++) {
      pumpUi();
      await Promise.resolve();
      if (!expectErrors && log.errors.length > 0) {
        throw log.errors[0]!.error;
      }
      if (pausedPopupConfirm || pauseDialogue) return;
      if (!handlingUi && !director.busy && !ui.pending && !ui.choices && !ui.quest) {
        await Promise.resolve();
        if (!handlingUi && !director.busy && !ui.pending && !ui.choices && !ui.quest) {
          if (!expectErrors && log.errors.length > 0) throw log.errors[0]!.error;
          return;
        }
      }
    }
    for (let step = 0; step < 600; step++) {
      pumpUi();
      await flushTurn();
      if (!expectErrors && log.errors.length > 0) {
        throw log.errors[0]!.error;
      }
      if (pausedPopupConfirm || pauseDialogue) return;
      if (!handlingUi && !director.busy && !ui.pending && !ui.choices && !ui.quest) {
        await flushTurn();
        if (!handlingUi && !director.busy && !ui.pending && !ui.choices && !ui.quest) {
          if (!expectErrors && log.errors.length > 0) throw log.errors[0]!.error;
          return;
        }
      }
    }
    throw new Error(`任务闭环在限定调度轮次内未静止（目标任务：${targetQuestId ?? '无'}）`);
  };

  /**
   * 普通同岛换图：严格校验目标地图必须沿当前已开启的静态出口可达（严禁穿墙跨过锁死出口或偷跑跨岛），
   * 并一律落到目标地图真实入口坐标，严禁瞬移到目标脸上掩盖动态路障；同时对齐正式 WorldScene 重置触发占用并派发进图事件。
   */
  const travelToMapEntrance = (mapId: string, targetHint?: Point) => {
    const curMap = session.storyWorld.currentLocation?.map;
    if (curMap === mapId && !targetHint) return;
    if (curMap === mapId && targetHint) {
      const curCells = reachableCellsWithDynamicObstacles(mapId).cells;
      if (curCells.some(pt => Math.hypot(pt.x - targetHint.x, pt.y - targetHint.y) <= 48)) return;
      const alt = pickBestReachableEntrance(mapId, curMap, targetHint);
      if (alt) {
        session.applyStoryCommands([{ type: 'travel', destination: { map: mapId, x: alt.x, y: alt.y, facing: 'south' } }]);
      }
      return;
    }
    const map = content.maps.get(mapId);
    assert.ok(map, `切换目标地图不存在：${mapId}`);
    if (curMap) {
      assert.equal(
        reachableMapsFrom(curMap).has(mapId),
        true,
        `禁止穿墙换图：从 ${curMap} 沿当前已开启且未被动态路障封锁的出口无法到达 ${mapId}`,
      );
    }
    const entrance =
      (curMap ? pickBestReachableEntrance(mapId, curMap, targetHint) : undefined) ??
      sources.upstreamIncomingExits.get(mapId)?.[0]?.point ??
      sources.mapEntrances.get(mapId)?.[0];
    const destX = entrance?.x ?? 64;
    const destY = entrance?.y ?? 64;
    resetMapTriggerContacts(mapId);
    session.applyStoryCommands([{ type: 'travel', destination: { map: mapId, x: destX, y: destY, facing: 'south' } }]);
    session.enterMap(map.id, map.questItemSpawns ?? [], map, map.enemySpawns);
    if (!director.busy) {
      void director.enterMap(map.id);
    }
  };

  /**
   * 跨岛任务专用切图通道（独立于同岛步行，带三道硬门禁并全程记账）：
   * 1. 若同岛已连通，直接走正常同岛换图；
   * 2. 若两图物理上同属一片静态出口大陆（只是门被 exitRules/exitEnabled 锁住），立刻报错拒绝，严禁借跨岛通道穿墙；
   * 3. 目标岛必须存在正式剧情 stage/travel 切图桥接（拒绝无桥接的孤立死岛），并记入 log.crossIslandTransfers 接受审计。
   */
  const crossIslandToMap = (mapId: string, reason: string) => {
    const curMap = session.storyWorld.currentLocation?.map;
    if (!curMap || curMap === mapId || reachableMapsFrom(curMap).has(mapId)) {
      travelToMapEntrance(mapId);
      return;
    }
    const map = content.maps.get(mapId);
    assert.ok(map, `跨岛目标地图不存在：${mapId}`);
    assert.equal(
      canStaticallyWalkBetween(curMap, mapId),
      false,
      `同岛出口被锁死，严禁当作跨岛任务穿墙：${curMap} -> ${mapId}（原因：${reason}）`,
    );
    assert.equal(
      hasFormalStoryBridgeToIsland(mapId),
      true,
      `目标地图 ${mapId} 所在岛屿没有任何正式剧情切图桥接，严禁跨岛（来自 ${curMap}，原因：${reason}）`,
    );
    log.crossIslandTransfers.push({ questId: targetQuestId, from: curMap, to: mapId, reason });
    const entrance = sources.mapEntrances.get(mapId)?.[0];
    const destX = entrance?.x ?? 64;
    const destY = entrance?.y ?? 64;
    resetMapTriggerContacts(mapId);
    session.applyStoryCommands([{ type: 'travel', destination: { map: mapId, x: destX, y: destY, facing: 'south' } }]);
    session.enterMap(map.id, map.questItemSpawns ?? [], map, map.enemySpawns);
    if (!director.busy) {
      void director.enterMap(map.id);
    }
  };

  /** GM 跳转落点：仅在初始化任务起点承接 plan.destination 时按精确落点就位；若落点压在门栓/障碍体上，对齐地图主通道侧站位而不卡进上锁牢房内侧。 */
  const placeAtDestination = (destination: TravelDestination) => {
    const map = content.maps.get(destination.map);
    assert.ok(map, `GM 跳转落点地图不存在：${destination.map}`);
    resetMapTriggerContacts(destination.map);
    let destX = destination.x;
    let destY = destination.y;
    const entranceSeeds = [
      ...(sources.upstreamIncomingExits.get(destination.map)?.map(e => e.point) ?? []),
      ...(sources.mapEntrances.get(destination.map) ?? []),
    ];
    if (entranceSeeds.length > 0) {
      const corridorCells = reachableCellsWithDynamicObstacles(destination.map, { extraStarts: entranceSeeds }).cells;
      const standsInCorridor = corridorCells.some(pt => Math.hypot(pt.x - destX, pt.y - destY) <= 12);
      if (!standsInCorridor) {
        let bestCell: Point | undefined;
        let bestDist = Infinity;
        for (const pt of corridorCells) {
          const d = Math.hypot(pt.x - destX, pt.y - destY);
          if (d <= 36 && d < bestDist) {
            bestDist = d;
            bestCell = pt;
          }
        }
        if (bestCell) {
          destX = bestCell.x;
          destY = bestCell.y;
        }
      }
    }
    session.applyStoryCommands([
      {
        type: 'travel',
        destination: {
          map: destination.map,
          x: destX,
          y: destY,
          facing: destination.facing ?? 'south',
        },
      },
    ]);
    session.enterMap(map.id, map.questItemSpawns ?? [], map, map.enemySpawns);
  };

  let cachedEntitiesRev = -1;
  let cachedStoryEntities: ReturnType<typeof session.storyWorld.captureState>['entities'] = [];
  const currentStoryEntities = () => {
    const rev = session.storyWorld.revision;
    if (rev !== cachedEntitiesRev) {
      cachedEntitiesRev = rev;
      cachedStoryEntities = session.storyWorld.captureState().entities;
    }
    return cachedStoryEntities;
  };

  /** 仅从当前会话真实投影出的 visibleEntities 中定位实体（零原始地图兜底、零无条件摆放兜底、零虚拟实体）。 */
  const tryLocateVisibleEntity = (
    actorOrCharId: string,
    characterId?: string,
    preferredMaps: readonly string[] = [],
  ): { mapId: string; entity: EntityPlacement; actor: ActorDefinition } | undefined => {
    const currentId = session.storyWorld.currentLocation?.map ?? content.campaign.start.map;
    const candidateMaps: string[] = [];
    const addCand = (mid: string | undefined) => {
      if (mid && content.maps.has(mid) && !candidateMaps.includes(mid)) candidateMaps.push(mid);
    };
    addCand(currentId);
    for (const mid of preferredMaps) addCand(mid);
    for (const st of currentStoryEntities()) {
      if (st.map && !st.removed && ((characterId && st.characterId === characterId) || st.actor === actorOrCharId || st.characterId === actorOrCharId || st.id === actorOrCharId)) {
        addCand(st.map);
      }
    }
    if (characterId) {
      for (const mid of sources.mapsByChar.get(characterId) ?? []) addCand(mid);
    }
    for (const mid of sources.mapsByActor.get(actorOrCharId) ?? []) addCand(mid);
    for (const mid of sources.mapsByChar.get(actorOrCharId) ?? []) addCand(mid);

    const reachable = reachableMapsFrom();
    const searchWith = (pred: (e: EntityPlacement) => boolean): { mapId: string; entity: EntityPlacement; actor: ActorDefinition } | undefined => {
      // 严禁穿墙定位不可达地图上的人物或机关：仅在当前图与当前静态出口可达地图内查找
      const reachableCands = candidateMaps.filter(mid => mid === currentId || reachable.has(mid));
      for (const mid of reachableCands) {
        const needsEntryPlace =
          mid !== session.storyWorld.currentLocation?.map &&
          (content.campaign.mapEntryPlacements ?? []).some(
            p => p.map === mid && pred(p) && session.evaluateCondition(p.condition),
          );
        if (needsEntryPlace) travelToMapEntrance(mid);
        const hit = visibleEntities(mid).find(pred);
        if (hit) {
          const actor = content.world.actors[hit.actor];
          assert.ok(actor, `可见实体角色定义缺失：${hit.actor}`);
          return { mapId: mid, entity: hit, actor };
        }
      }
      return undefined;
    };

    if (characterId) {
      return searchWith(e => e.characterId === characterId);
    }
    return searchWith(
      e => e.actor === actorOrCharId || e.characterId === actorOrCharId || e.id === actorOrCharId || e.objective === actorOrCharId,
    );
  };

  /** 严格定位真实在场可见实体；找不到直接判失败。 */
  const locateEntity = (
    actorOrCharId: string,
    characterId?: string,
    preferredMaps: readonly string[] = [],
  ): { mapId: string; entity: EntityPlacement; actor: ActorDefinition } => {
    const found = tryLocateVisibleEntity(actorOrCharId, characterId, preferredMaps);
    assert.ok(
      found,
      `在真实可见实体投影 visibleEntities 中找不到目标角色：actor=${actorOrCharId} characterId=${characterId ?? '无'} currentMap=${session.storyWorld.currentLocation?.map ?? '无'} preferredMaps=[${preferredMaps.join(',')}]`,
    );
    return found;
  };

  let onBeforeDirectorInteract: (() => void) | undefined;

  /** 对齐 WorldScene.updateInteractionTarget：在指定地图坐标从全部可见对象中挑选正式游戏唯一选中的交互目标。 */
  const selectInteractionTargetAt = (mapId: string, pos: Point) => {
    const candidates = visibleEntities(mapId).map(ent => ({
      entity: ent,
      actor: content.world.actors[ent.actor]!,
      container: { x: ent.x, y: ent.y, visible: true },
    }));
    return pickNearestInteractionTarget(pos, candidates, session, {
      hasShop: actorId => content.shopActors?.has(actorId) ?? false,
      isUnavailable: candidate =>
        (!!candidate.actor.chest &&
          session.chests.isOpened(mapId, candidate.entity.id, session.storyWorld.isPlaced(candidate.entity.id))) ||
        (candidate.actor.service === 'legendary-sword' && session.legendaryWeapons.isPulled(mapId, candidate.entity.id)) ||
        !!(candidate.entity.spring && session.springs.isEmpty(mapId, candidate.entity.id)),
    });
  };

  /** 通过真实 pickNearestInteractionTarget + resolveInteraction + StoryDirector.interact 执行一次角色/机关交互（附带静态可达与同点选人竞争核验）。 */
  const interactWithEntity = async (
    entity: EntityPlacement,
    mapId?: string,
    visitedQuests = new Set<string>(),
  ): Promise<string> => {
    const targetMap = mapId ?? currentMapObj().id;
    travelToMapEntrance(targetMap);
    await settle();
    assert.ok(
      visibleEntities(targetMap).some(e => e.id === entity.id),
      `交互实体 ${entity.actor}(${entity.id}) 在地图 ${targetMap} 当前不可见`,
    );
    try {
      assertEntityApproachable(targetMap, entity, `interact:${entity.actor}(${entity.characterId ?? entity.id})`);
    } catch (approachErr) {
      const unlocked = await tryUnlockMapObstacles(targetMap, { kind: 'entity', entity }, visitedQuests);
      if (!unlocked) throw approachErr;
      travelToMapEntrance(targetMap);
      await settle();
      assert.ok(
        visibleEntities(targetMap).some(e => e.id === entity.id),
        `解锁障碍后交互实体 ${entity.actor}(${entity.id}) 在地图 ${targetMap} 不再可见`,
      );
      assertEntityApproachable(targetMap, entity, `interact:${entity.actor}(${entity.characterId ?? entity.id})`);
    }
    const curEntity = visibleEntities(targetMap).find(e => e.id === entity.id) ?? entity;
    const actor = content.world.actors[curEntity.actor];
    assert.ok(actor, `角色定义缺失：${curEntity.actor}`);
    const hasShop = content.shopActors?.has(curEntity.actor) ?? false;
    const candidateRank = interactionCandidateRank(curEntity, actor, session, hasShop);
    assert.notEqual(
      candidateRank,
      null,
      `交互实体 ${curEntity.actor}(${curEntity.characterId ?? curEntity.id}) 在地图 ${targetMap} 当前无任何正式交互资格（interactionCandidateRank=null）`,
    );
    const { cells } = reachableCellsWithDynamicObstacles(targetMap);
    const inRangeCells = cells.filter(pt => withinInteractionRange(pt, curEntity, actor, !!curEntity.flip, hasShop));
    const standPos = inRangeCells.find(pt => selectInteractionTargetAt(targetMap, pt)?.entity.id === curEntity.id);
    if (!standPos) {
      const winners = [
        ...new Set(
          inRangeCells.map(pt => {
            const w = selectInteractionTargetAt(targetMap, pt);
            return w ? `${w.entity.actor}(${w.entity.characterId ?? w.entity.id})` : 'null';
          }),
        ),
      ];
      assert.fail(
        `交互实体 ${curEntity.actor}(${curEntity.characterId ?? curEntity.id}) 在地图 ${targetMap} 的全部可达交互格均被其他高优先级对象抢占（实际选中=[${winners.join(', ')}]）`,
      );
    }
    session.storyWorld.apply({
      kind: 'travel',
      destination: {
        map: targetMap,
        x: standPos.x,
        y: standPos.y,
        facing: session.storyWorld.currentLocation?.facing ?? 'south',
      },
    });
    const questInSlot = session.npcQuestSlot(curEntity.actor, curEntity.characterId);
    const questSlot = !!questInSlot && ['available', 'ready'].includes(session.status(questInSlot.id));
    const action = resolveInteraction({
      chest: false,
      spring: false,
      service: actor.service,
      objective: !!curEntity.objective && session.canInteract(curEntity.objective, curEntity.id),
      questSlot,
      shop: hasShop,
    });
    if (action.kind === 'shop') {
      log.shopsOpened.push(curEntity.actor);
      return 'shop';
    }
    if (action.kind !== 'story') {
      log.servicesOpened.push(`${action.kind}:${curEntity.actor}`);
      return action.kind;
    }
    onBeforeDirectorInteract?.();
    await director.interact(curEntity, actor);
    await settle();
    return 'story';
  };

  const interactByIdentity = async (
    actorOrCharId: string,
    characterId?: string,
    preferredMaps: readonly string[] = [],
    visitedQuests = new Set<string>(),
  ): Promise<string> => {
    let found = tryLocateVisibleEntity(actorOrCharId, characterId, preferredMaps);
    if (!found) {
      const candidateMaps = [
        ...preferredMaps,
        ...(characterId ? sources.mapsByChar.get(characterId) ?? [] : []),
        ...(sources.mapsByActor.get(actorOrCharId) ?? []),
        ...(sources.mapsByChar.get(actorOrCharId) ?? []),
      ];
      for (const m of candidateMaps) {
        if (await tryEnsureMapReachable(m, visitedQuests)) {
          found = tryLocateVisibleEntity(actorOrCharId, characterId, preferredMaps);
          if (found) break;
        }
      }
    }
    const located = found ?? locateEntity(actorOrCharId, characterId, preferredMaps);
    return interactWithEntity(located.entity, located.mapId, visitedQuests);
  };

  /** 结算当前活跃剧情遭遇（击败遭遇生成的全部怪物并上报遭遇胜利）。 */
  const settleActiveEncounters = async (): Promise<void> => {
    let guard = 0;
    while (session.storyWorld.activeEncounters.length > 0 && guard++ < 20) {
      const enc = session.storyWorld.activeEncounters[0]!;
      travelToMapEntrance(enc.map);
      const map = currentMapObj();
      const roster = new WorldEnemyRoster(
        session,
        map,
        (content.campaign.enemyPlacements ?? []).filter(ep => ep.map === map.id),
        questEnemies,
      );

      for (const sp of enc.spawns) {
        const key = encounterSpawnId(enc.id, sp.id);
        const enemyDef = content.battle.enemies.find(e => e.id === sp.enemyId);
        assert.ok(enemyDef, `遭遇敌人定义缺失：${sp.enemyId}`);

        const hasLowHealthEvent = content.campaign.events.some(
          ev =>
            ev.source === 'battle' &&
            ev.key === `health-below-30:${sp.enemyId}` &&
            director.runtime.eventStatus(ev.id) === 'idle' &&
            (!ev.condition || session.evaluateCondition(ev.condition)),
        );
        if (hasLowHealthEvent) {
          director.healthChanged(sp.enemyId, 100, 25, 100, { id: key, map: map.id, x: sp.x, y: sp.y });
          await settle();
          applyStoryEnemyRemovals(session, map.id, roster.enemies, k => roster.removeEnemy(k));
          continue;
        }

        const spawnSource = roster.source(key) ?? { id: key, enemyId: sp.enemyId, x: sp.x, y: sp.y, respawn: false as const };
        const res = session.settleEnemyDefeat({
          key,
          spawn: spawnSource,
          enemy: enemyDef,
          map: map.id,
          x: sp.x,
          y: sp.y,
          lootLevel: map.lootLevel ?? 1,
          enemyLevel: enemyDef.level ?? 1,
          elite: false,
          earnsExperience: true,
          pressureMode: false,
          drops: content.drops,
          stats: content.stats,
          random: () => 0,
          landing: (lx, ly) => ({ x: lx, y: ly }),
        });
        res?.notify();
        collectAllGroundLootOnMap(map.id);
        await settle();
      }

      const completed = roster.completedEncounters();
      for (const done of completed) {
        await director.encounterResult(done.id, 'won', `e2e:${done.id}:won`);
        await settle();
      }
      if (session.storyWorld.encounter(enc.id)?.status === 'active') {
        await director.encounterResult(enc.id, 'won', `e2e:${enc.id}:won`);
        await settle();
      }
    }
  };

  /**
   * 尝试在当前活跃遭遇或可达地图的真实 WorldEnemyRoster 中定位真实在场敌人实例（严禁捏造虚拟刷怪点、严禁跨锁死出口穿墙）。
   * 若同图可刷新刷怪点处于死亡冷却中，通过正式时钟推进 + roster.refresh() 合法续刷；
   * 若同图全部静态刷怪点在本轮访问内都已被捕捉占用，通过正式相邻地图出口离图重进释放上轮捕捉状态。
   */
  const tryLocateSpawnedEnemy = (
    enemyId: string,
    preferredMaps: readonly string[] = [],
  ): {
    found?: { mapId: string; key: string; x: number; y: number; spawn: NonNullable<ReturnType<WorldEnemyRoster['source']>>; roster: WorldEnemyRoster };
    candidateMaps: string[];
  } => {
    const enemyDef = content.battle.enemies.find(e => e.id === enemyId);
    assert.ok(enemyDef, `敌人定义缺失：${enemyId}`);

    // 1. 优先检查当前活跃剧情遭遇
    for (const enc of session.storyWorld.activeEncounters) {
      const sp = enc.spawns.find(s => s.enemyId === enemyId && session.enemyVitals(encounterSpawnId(enc.id, s.id)).deadUntil === undefined);
      if (!sp) continue;
      travelToMapEntrance(enc.map);
      const map = currentMapObj();
      const roster = new WorldEnemyRoster(
        session,
        map,
        (content.campaign.enemyPlacements ?? []).filter(ep => ep.map === map.id),
        questEnemies,
      );
      const key = encounterSpawnId(enc.id, sp.id);
      const src = roster.source(key) ?? { id: key, enemyId: sp.enemyId, x: sp.x, y: sp.y, respawn: false as const };
      return { found: { mapId: enc.map, key, x: sp.x, y: sp.y, spawn: src, roster }, candidateMaps: [enc.map] };
    }

    // 2. 严格限定当前地图与真实可达地图（严禁穿墙访问被 exitRules/exitEnabled 封锁的地图）
    const reachable = reachableMapsFrom();
    const candidateMaps: string[] = [];
    const curMapId = session.storyWorld.currentLocation?.map;
    const addReachableCand = (mid: string | undefined) => {
      if (mid && content.maps.has(mid) && (mid === curMapId || reachable.has(mid)) && !candidateMaps.includes(mid)) {
        candidateMaps.push(mid);
      }
    };
    if (curMapId && session.storyWorld.enemySpawns(curMapId).some(sp => sp.enemyId === enemyId)) {
      addReachableCand(curMapId);
    }
    for (const mid of preferredMaps) addReachableCand(mid);
    addReachableCand(curMapId);
    for (const el of session.storyWorld.captureState().enemyLocations ?? []) {
      if (el.enemyId === enemyId) addReachableCand(el.map);
    }
    for (const mid of sources.mapsByEnemy.get(enemyId) ?? []) {
      addReachableCand(mid);
    }

    for (const mid of candidateMaps) {
      const map = content.maps.get(mid)!;
      const mapPlacements = (content.campaign.enemyPlacements ?? []).filter(ep => ep.map === mid);
      const hasAnyPotential =
        (map.enemySpawns ?? []).some(sp => sp.enemyId === enemyId) ||
        mapPlacements.some(ep => ep.enemyId === enemyId) ||
        session.storyWorld.enemySpawns(mid).some(sp => sp.enemyId === enemyId);
      if (!hasAnyPotential) continue;

      travelToMapEntrance(mid);
      let roster = new WorldEnemyRoster(session, map, mapPlacements, questEnemies);
      const matchesReachableEnemy = (e: WorldEnemyRoster['enemies'][number]) =>
        e.enemyId === enemyId && isEnemySpawnReachable(mid, enemyDef.actor.id, e);
      let placed = roster.enemies.find(matchesReachableEnemy);
      if (!placed) {
        const hasRespawnable = roster.spawns.some(sp => sp.enemyId === enemyId && sp.respawn !== false);
        if (hasRespawnable) {
          session.advanceGameTime(65_000);
          roster.refresh();
          placed = roster.enemies.find(matchesReachableEnemy);
        }
      }
      if (!placed) {
        const hasCapturedSlots = roster.spawns.some(
          sp => sp.enemyId === enemyId && session.enemyVitals(sp.id).capture !== undefined,
        );
        if (hasCapturedSlots) {
          const neighbor = map.exits.find(ex => {
            if (ex.destination === mid || !content.maps.has(ex.destination)) return false;
            const eid = storyExitId(mid, ex);
            const ruleCond = sources.exitRuleByKey.get(`${mid}\0${eid}`);
            const ruleOk = !ruleCond || session.evaluateCondition(ruleCond);
            if (!ruleOk || !session.storyWorld.exitEnabled(mid, ex)) return false;
            return reachableMapsFrom(mid).has(ex.destination) && reachableMapsFrom(ex.destination).has(mid);
          })?.destination;
          if (neighbor) {
            travelToMapEntrance(neighbor);
            travelToMapEntrance(mid);
            roster = new WorldEnemyRoster(session, map, mapPlacements, questEnemies);
            placed = roster.enemies.find(matchesReachableEnemy);
          }
        }
      }
      if (placed) {
        const src = roster.source(placed.key);
        assert.ok(src, `在场敌人 ${placed.key} 缺少名册来源`);
        return { found: { mapId: mid, key: placed.key, x: placed.x, y: placed.y, spawn: src, roster }, candidateMaps };
      }
    }

    return { candidateMaps };
  };

  /** 严格定位真实在场敌人实例；找不到直接判失败。 */
  const locateSpawnedEnemy = (
    enemyId: string,
    preferredMaps: readonly string[] = [],
  ): { mapId: string; key: string; x: number; y: number; spawn: NonNullable<ReturnType<WorldEnemyRoster['source']>>; roster: WorldEnemyRoster } => {
    const res = tryLocateSpawnedEnemy(enemyId, preferredMaps);
    if (!res.found) {
      assert.fail(
        `在当前活跃遭遇与全部可达候选地图的真实 WorldEnemyRoster 中均找不到已启用的敌人：${enemyId}（当前地图=${session.storyWorld.currentLocation?.map ?? '无'}，可达候选地图=[${res.candidateMaps.join(',')}]）`,
      );
    }
    return res.found;
  };

  /** 对真实在场敌人执行一次正式击败结算，并立即拾取该地图地面掉落；若敌人由剧情遭遇/位置事件生成，先走正式事件。 */
  const defeatRealEnemy = async (
    enemyId: string,
    preferredMaps: readonly string[] = [],
    visitedQuests = new Set<string>(),
  ): Promise<{ mapId: string; key: string; droppedItems: string[] }> => {
    let attempt = tryLocateSpawnedEnemy(enemyId, preferredMaps);
    if (!attempt.found) {
      const potentialMaps = [...new Set([...preferredMaps, ...(sources.mapsByEnemy.get(enemyId) ?? [])])];
      for (const m of potentialMaps) {
        if (await tryEnsureMapReachable(m, visitedQuests)) {
          attempt = tryLocateSpawnedEnemy(enemyId, preferredMaps);
          if (attempt.found) break;
        }
        if (reachableMapsFrom().has(m)) {
          const map = content.maps.get(m)!;
          const mapPlacements = (content.campaign.enemyPlacements ?? []).filter(ep => ep.map === m);
          const roster = new WorldEnemyRoster(session, map, mapPlacements, questEnemies);
          const blockedEnemy = roster.enemies.find(e => e.enemyId === enemyId);
          if (blockedEnemy) {
            travelToMapEntrance(m);
            await settle();
            const unlocked = await tryUnlockMapObstacles(
              m,
              { kind: 'region', region: { x: blockedEnemy.x - 16, y: blockedEnemy.y - 16, width: 32, height: 32 } },
              visitedQuests,
            );
            if (unlocked) {
              attempt = tryLocateSpawnedEnemy(enemyId, [m, ...preferredMaps]);
              if (attempt.found) break;
            }
          }
        }
      }
    }
    if (!attempt.found && !activeSpawningEnemies.has(enemyId)) {
      const spawnerEvs = (sources.eventsSpawningEnemy.get(enemyId) ?? []).filter(
        ev =>
          (ev.repeat || director.runtime.eventStatus(ev.id) !== 'completed') &&
          (allowRecursiveSolve || !ev.condition || session.evaluateCondition(ev.condition)),
      );
      if (spawnerEvs.length > 0) {
        const readyEv = spawnerEvs.find(ev => !ev.condition || session.evaluateCondition(ev.condition)) ?? spawnerEvs[0]!;
        let defeatedDuringEvent = false;
        const unsub = session.subscribeDefeats(id => {
          if (id === enemyId) defeatedDuringEvent = true;
        });
        const defeatGoalTotal = (): number => {
          if (!targetQuestId) return 0;
          const q = indexes.questById.get(targetQuestId);
          const prog = session.quests.get(targetQuestId);
          if (!q || !prog) return 0;
          let total = 0;
          for (const g of q.goals) {
            if (g.kind === 'defeat' && g.target === enemyId) total += prog.goals[g.id] ?? 0;
          }
          return total;
        };
        const beforeQuestStatus = targetQuestId ? session.status(targetQuestId) : undefined;
        const beforeQuestCycles = targetQuestId ? session.questBook.completedCycles(targetQuestId) : 0;
        const beforeDefeatGoal = defeatGoalTotal();
        activeSpawningEnemies.add(enemyId);
        try {
          if (readyEv.condition && !session.evaluateCondition(readyEv.condition)) {
            await satisfyEventCondition(readyEv.condition, visitedQuests);
          }
          await fireStoryEvent(readyEv, visitedQuests);
        } finally {
          activeSpawningEnemies.delete(enemyId);
          unsub();
        }
        const questProgressed =
          !!targetQuestId &&
          (session.status(targetQuestId) !== beforeQuestStatus ||
            session.questBook.completedCycles(targetQuestId) > beforeQuestCycles);
        const defeatGoalAdvanced = defeatGoalTotal() > beforeDefeatGoal;
        if (defeatedDuringEvent || defeatGoalAdvanced || questProgressed) {
          return { mapId: currentMapObj().id, key: `encounter:${readyEv.id}:${enemyId}`, droppedItems: [] };
        }
        attempt = tryLocateSpawnedEnemy(enemyId, [currentMapObj().id, ...preferredMaps]);
      }
    }
    const found = attempt.found ?? locateSpawnedEnemy(enemyId, preferredMaps);
    const enemyDef = content.battle.enemies.find(e => e.id === enemyId)!;
    const map = content.maps.get(found.mapId)!;
    const beforeDropIds = new Set(groundLootFor(session).dropsOnMap(found.mapId).map(d => d.id));
    const res = session.settleEnemyDefeat({
      key: found.key,
      spawn: found.spawn,
      enemy: enemyDef,
      map: found.mapId,
      x: found.x,
      y: found.y,
      lootLevel: map.lootLevel ?? 1,
      enemyLevel: enemyDef.level ?? 1,
      elite: false,
      earnsExperience: true,
      pressureMode: false,
      drops: content.drops,
      stats: content.stats,
      random: () => 0,
      landing: (lx, ly) => ({ x: lx, y: ly }),
    });
    assert.ok(res, `真实敌人 ${enemyId} (${found.key}) 结算击败返回空`);
    res.notify();
    const droppedItems = groundLootFor(session)
      .dropsOnMap(found.mapId)
      .filter(d => !beforeDropIds.has(d.id) && d.reward.kind === 'item')
      .map(d => (d.reward.kind === 'item' ? d.reward.item : ''));
    collectAllGroundLootOnMap(found.mapId);
    await settle();
    await settleActiveEncounters();
    return { mapId: found.mapId, key: found.key, droppedItems };
  };

  const placesToMaps = (place: StoryEvent['place']): string[] => {
    if (!place) return [];
    if (place.type === 'fixed') return [place.map];
    if (place.type === 'alternatives') return place.spots.map(s => s.map);
    return [];
  };

  /**
   * 对齐 WorldScene.afterMovement 的地图自动触发竞争：
   * 构建本图 buildStoryTriggerIndex，按「区域优先于近身、idle 新剧情优先于可重复旧剧情」选出唯一触发项并更新占用集合。
   */
  const buildMapTriggerContext = (mapId: string) => {
    const characters = visibleEntities(mapId).map(entity => ({
      entity,
      actor: content.world.actors[entity.actor]!,
      container: { x: entity.x, y: entity.y, visible: true },
    }));
    const triggerIndex = buildStoryTriggerIndex(content.campaign, mapId, characters);
    const availability = (ev: StoryEvent) => {
      if (!director.allowsAutomaticEvent(ev) || (ev.condition && !session.evaluateCondition(ev.condition))) return undefined;
      return director.runtime.eventStatus(ev.id);
    };
    return { triggerIndex, availability };
  };

  /** 仅同步玩家移动到某点后的触发器脱离状态（用于玩家真实退开触发框或人物身边后释放占用）。 */
  const releaseTriggerContactsAt = (mapId: string, pos: Point) => {
    resetMapTriggerContacts(mapId);
    const { triggerIndex } = buildMapTriggerContext(mapId);
    for (const ev of triggerIndex.regionEvents) {
      if (!ev.region || !overlapsFootRect(pos, ev.region)) {
        occupiedRegions.delete(ev.id);
      }
    }
    const touching = ({ character }: (typeof triggerIndex.nearCharacters)[number]) =>
      character.container.visible && nearInteractive(pos, character.container, character.actor.collision, !!character.entity.flip);
    for (const group of triggerIndex.nearCharacters) {
      if (!touching(group)) {
        occupiedCharacters.delete(group.id);
      }
    }
    for (const id of [...occupiedNearEvents]) {
      if (!triggerIndex.nearCharacters.some(group => group.events.some(ev => ev.id === id) && touching(group))) {
        occupiedNearEvents.delete(id);
      }
    }
    syncTriggerContacts();
  };

  const stepWorldTriggersAt = async (
    mapId: string,
    pos: Point,
  ): Promise<{ kind: 'region' | 'near'; eventId: string; played: boolean } | null> => {
    resetMapTriggerContacts(mapId);
    session.storyWorld.apply({
      kind: 'travel',
      destination: {
        map: mapId,
        x: pos.x,
        y: pos.y,
        facing: session.storyWorld.currentLocation?.facing ?? 'south',
      },
    });
    const { triggerIndex, availability } = buildMapTriggerContext(mapId);
    const region = claimStoryTrigger(
      triggerIndex.regionEvents,
      occupiedRegions,
      ev => !!ev.region && overlapsFootRect(pos, ev.region),
      ev => {
        const status = availability(ev);
        return status === 'idle' || (status === 'completed' && ev.repeat) ? status : false;
      },
      status => status === 'idle',
    );
    syncTriggerContacts();

    if (region) {
      const played = await director.enterRegion(region.event.id, region.event.map!);
      if (!played) {
        occupiedRegions.delete(region.event.id);
        syncTriggerContacts();
      }
      await settle();
      return { kind: 'region', eventId: region.event.id, played };
    }
    return null;
  };

  /** 按事件自身的真实触发源与正式地图触发索引派发事件（严禁 director.trigger 或跳过触发竞争直接点名）。 */
  const fireStoryEvent = async (event: StoryEvent, visitedQuests = new Set<string>()): Promise<boolean> => {
    const spotMaps = placesToMaps(event.place);
    const candMaps = [...new Set([event.map, ...spotMaps].filter((m): m is string => !!m))];
    const spot =
      event.place?.type === 'fixed'
        ? event.place
        : event.place?.type === 'alternatives'
          ? event.place.spots[0]
          : undefined;
    const mapId = event.map ?? spot?.map ?? session.storyWorld.currentLocation?.map ?? content.campaign.start.map;

    const moveToEventMap = async (destMapId: string) => {
      const curMap = session.storyWorld.currentLocation?.map;
      if (!curMap || curMap === destMapId || reachableMapsFrom(curMap).has(destMapId)) {
        travelToMapEntrance(destMapId);
      } else if (!canStaticallyWalkBetween(curMap, destMapId)) {
        // 仅在真正跨岛（两岛间物理无步行静态出口）时走独立跨岛通道；若同岛锁门则落入 travelToMapEntrance 直接报错拦截
        crossIslandToMap(destMapId, `event:${event.id}`);
      } else {
        await tryEnsureMapReachable(destMapId, visitedQuests);
        travelToMapEntrance(destMapId);
      }
    };

    let fired = false;
    switch (event.source) {
      case 'start':
        await moveToEventMap(mapId);
        await settle();
        fired = await director.start();
        break;
      case 'region': {
        assert.ok(event.map && event.region, `区域事件 ${event.id} 缺少 map 或 region`);
        await moveToEventMap(event.map);
        await settle();
        if (!event.repeat && director.runtime.eventStatus(event.id) === 'completed') {
          fired = true;
          break;
        }
        try {
          assertRegionReachable(event.map, event.region, `event:${event.id}`);
        } catch (regionErr) {
          const unlocked = await tryUnlockMapObstacles(event.map, { kind: 'region', region: event.region }, visitedQuests);
          if (!unlocked) throw regionErr;
          await moveToEventMap(event.map);
          await settle();
          assertRegionReachable(event.map, event.region, `event:${event.id}`);
        }

        for (let attempt = 0; attempt < 6; attempt++) {
          if (session.storyWorld.currentLocation?.map !== event.map) {
            await moveToEventMap(event.map);
            await settle();
          }
          if (!event.repeat && director.runtime.eventStatus(event.id) === 'completed') {
            fired = true;
            break;
          }
          const { cells } = reachableCellsWithDynamicObstacles(event.map);
          const { triggerIndex, availability } = buildMapTriggerContext(event.map);
          const inTargetCells = cells.filter(pt => overlapsFootRect(pt, event.region!));
          assert.ok(inTargetCells.length > 0, `区域事件 ${event.id} 在地图 ${event.map} 无可达触发格`);
          const cleanPos =
            inTargetCells.find(
              pt =>
                !triggerIndex.regionEvents.some(
                  other =>
                    other.id !== event.id &&
                    !!other.region &&
                    overlapsFootRect(pt, other.region) &&
                    availability(other) !== undefined,
                ),
            ) ?? inTargetCells[0]!;
          if (occupiedRegions.has(event.id)) {
            const outsideCell = cells.find(pt => !overlapsFootRect(pt, event.region!));
            if (outsideCell) releaseTriggerContactsAt(event.map, outsideCell);
          }
          const stepped = await stepWorldTriggersAt(event.map, cleanPos);
          await settleActiveEncounters();
          if (stepped?.kind === 'region' && stepped.eventId === event.id) {
            fired = stepped.played;
            break;
          }
          if (!stepped) {
            const eligibleNow =
              director.allowsAutomaticEvent(event) &&
              (!event.condition || session.evaluateCondition(event.condition)) &&
              (event.repeat || director.runtime.eventStatus(event.id) === 'idle');
            if (!eligibleNow) {
              fired = false;
              break;
            }
            assert.fail(`正式地图触发索引在 ${event.map}@(${cleanPos.x},${cleanPos.y}) 未选中区域事件 ${event.id}`);
          }
        }
        break;
      }
      case 'map-entry': {
        const completedBefore = log.eventsCompleted.length;
        await moveToEventMap(mapId);
        await settle();
        if (
          log.eventsCompleted.slice(completedBefore).includes(event.id) ||
          (!event.repeat && director.runtime.eventStatus(event.id) === 'completed')
        ) {
          fired = true;
        } else {
          fired = await director.enterMap(event.key ?? mapId);
        }
        break;
      }
      case 'near': {
        assert.ok(event.near || event.entity, `近身事件 ${event.id} 缺少 near/entity 标识`);
        if (event.nearCharacterId) {
          await ensureRegisteredNpcPlaced(event.nearCharacterId, visitedQuests);
          if (!event.repeat && director.runtime.eventStatus(event.id) === 'completed') {
            fired = true;
            break;
          }
          if (event.repeat && !tryLocateVisibleEntity(event.entity ?? event.near!, event.entity ? undefined : event.nearCharacterId, candMaps)) {
            fired = false;
            break;
          }
        }
        for (const m of candMaps) {
          if (!reachableMapsFrom().has(m)) {
            await tryEnsureMapReachable(m, visitedQuests);
          }
        }
        const located = event.entity
          ? locateEntity(event.entity, undefined, candMaps)
          : locateEntity(event.near!, event.nearCharacterId, candMaps);
        travelToMapEntrance(located.mapId);
        await settle();
        if (!event.repeat && director.runtime.eventStatus(event.id) === 'completed') {
          fired = true;
          break;
        }
        try {
          assertEntityApproachable(located.mapId, located.entity, `near:${event.id}`);
        } catch (approachErr) {
          const unlocked = await tryUnlockMapObstacles(located.mapId, { kind: 'entity', entity: located.entity }, visitedQuests);
          if (!unlocked) throw approachErr;
          travelToMapEntrance(located.mapId);
          await settle();
          assertEntityApproachable(located.mapId, located.entity, `near:${event.id}`);
        }

        for (let attempt = 0; attempt < 6; attempt++) {
          if (session.storyWorld.currentLocation?.map !== located.mapId) {
            travelToMapEntrance(located.mapId);
            await settle();
          }
          if (!event.repeat && director.runtime.eventStatus(event.id) === 'completed') {
            fired = true;
            break;
          }
          const curTarget =
            visibleEntities(located.mapId).find(e => e.id === located.entity.id) ??
            (event.entity
              ? locateEntity(event.entity, undefined, [located.mapId]).entity
              : locateEntity(event.near!, event.nearCharacterId, [located.mapId]).entity);
          const curActor = content.world.actors[curTarget.actor]!;
          const { cells } = reachableCellsWithDynamicObstacles(located.mapId);
          const { triggerIndex, availability } = buildMapTriggerContext(located.mapId);
          const nearCells = cells.filter(pt => nearInteractive(pt, curTarget, curActor.collision, !!curTarget.flip));
          assert.ok(nearCells.length > 0, `近身事件 ${event.id} 目标 ${curTarget.actor}(${curTarget.id}) 在 ${located.mapId} 无可达贴身格`);
          const cleanPos =
            nearCells.find(
              pt =>
                !triggerIndex.regionEvents.some(
                  reg => !!reg.region && overlapsFootRect(pt, reg.region) && availability(reg) !== undefined,
                ) &&
                !triggerIndex.nearCharacters.some(
                  grp =>
                    grp.id !== curTarget.id &&
                    nearInteractive(pt, grp.character.container, grp.character.actor.collision, !!grp.character.entity.flip) &&
                    grp.events.some(ev => availability(ev) !== undefined),
                ),
            ) ??
            nearCells.find(
              pt =>
                !triggerIndex.regionEvents.some(
                  reg => !!reg.region && overlapsFootRect(pt, reg.region) && availability(reg) !== undefined,
                ),
            ) ??
            nearCells[0]!;
          const stepped = await stepWorldTriggersAt(located.mapId, cleanPos);
          await settleActiveEncounters();
          if (stepped) {
            continue;
          }
          const eligibleNow =
            director.allowsAutomaticEvent(event) &&
            (!event.condition || session.evaluateCondition(event.condition)) &&
            (event.repeat || director.runtime.eventStatus(event.id) === 'idle');
          if (!eligibleNow) {
            fired = false;
            break;
          }
          assert.equal(
            session.nearEvent(curTarget, located.mapId)?.id,
            event.id,
            `近身事件 ${event.id} 在 ${located.mapId}@(${cleanPos.x},${cleanPos.y}) 应由 session.nearEvent 命中目标 ${curTarget.actor}(${curTarget.id})`,
          );
          fired = await director.interact(curTarget, curActor);
          await settle();
          await settleActiveEncounters();
          if (fired) break;
        }
        break;
      }
      case 'interaction': {
        const located = locateEntity(event.key ?? '', undefined, candMaps);
        travelToMapEntrance(located.mapId);
        try {
          assertEntityApproachable(located.mapId, located.entity, `interaction:${event.id}`);
        } catch (approachErr) {
          const unlocked = await tryUnlockMapObstacles(located.mapId, { kind: 'entity', entity: located.entity }, visitedQuests);
          if (!unlocked) throw approachErr;
          travelToMapEntrance(located.mapId);
          assertEntityApproachable(located.mapId, located.entity, `interaction:${event.id}`);
        }
        fired = await director.interact(located.entity, located.actor);
        break;
      }
      case 'battle': {
        const key = event.key ?? '';
        if (key.startsWith('health-below-30:')) {
          const enemyId = key.slice('health-below-30:'.length);
          let found = tryLocateSpawnedEnemy(enemyId, candMaps).found;
          if (!found) {
            const spawnerEv = (sources.eventsSpawningEnemy.get(enemyId) ?? []).find(
              ev => ev.id !== event.id && (ev.repeat || director.runtime.eventStatus(ev.id) !== 'completed'),
            );
            if (spawnerEv) {
              if (spawnerEv.condition && !session.evaluateCondition(spawnerEv.condition)) {
                await satisfyEventCondition(spawnerEv.condition, visitedQuests);
              }
              await fireStoryEvent(spawnerEv, visitedQuests);
              if (!event.repeat && director.runtime.eventStatus(event.id) === 'completed') {
                fired = true;
                break;
              }
              found = tryLocateSpawnedEnemy(enemyId, [currentMapObj().id, ...candMaps]).found;
            }
          }
          const live = found ?? locateSpawnedEnemy(enemyId, candMaps);
          fired = director.healthChanged(enemyId, 100, 25, 100, {
            id: live.key,
            map: live.mapId,
            x: live.x,
            y: live.y,
          });
        } else if (key.startsWith('defeat:')) {
          const enemyId = key.slice('defeat:'.length);
          await defeatRealEnemy(enemyId, candMaps, visitedQuests);
          fired = true;
        } else {
          travelToMapEntrance(mapId);
          fired = await director.notify('battle', key, mapId);
        }
        break;
      }
      case 'choice': {
        const choiceCond = extractChoiceCondition(event.condition);
        const choiceKey = event.key ?? choiceCond?.choice;
        const choiceVal = choiceCond?.value;
        const parents = choiceKey
          ? (sources.choiceParentEvents.get(choiceKey) ?? []).filter(
              pe => pe.id !== event.id && (pe.repeat || director.runtime.eventStatus(pe.id) !== 'completed'),
            )
          : [];
        const parent =
          parents.find(pe => !pe.condition || session.evaluateCondition(pe.condition)) ?? parents[0];
        if (parent && choiceVal && !activeChoiceEvents.has(event.id) && (!event.condition || !session.evaluateCondition(event.condition))) {
          activeChoiceEvents.add(event.id);
          try {
            if (parent.condition && !session.evaluateCondition(parent.condition)) {
              await satisfyEventCondition(parent.condition, visitedQuests);
            }
            choiceQueue.push(choiceVal);
            fired = await fireStoryEvent(parent, visitedQuests);
          } finally {
            activeChoiceEvents.delete(event.id);
          }
        } else {
          travelToMapEntrance(mapId);
          fired = await director.notify('choice', event.key, mapId);
        }
        break;
      }
      case 'quest':
      case 'inventory':
      case 'event':
        travelToMapEntrance(mapId);
        fired = await director.notify(event.source, event.key, mapId);
        break;
    }
    await settle();
    await settleActiveEncounters();
    return fired;
  };

  /** 判断某物品是否属于当前任意进行中任务所需（任务道具、招募徽章或交接物品），优先保障背包空间不被普通杂物塞满。 */
  const isNeededByRunningQuest = (itemId: string): boolean => {
    if (content.items.items[itemId]?.category === 'quest') return true;
    for (const qid of session.questBook.runningQuestIds) {
      const q = indexes.questById.get(qid);
      if (!q) continue;
      if (q.goals.some(g => (g.kind === 'item' || g.kind === 'recruit') && g.target === itemId)) return true;
      if (q.handoverItems?.some(h => h.item === itemId)) return true;
    }
    return false;
  };

  /** 单趟 O(N) 拾取当前地图地面战利品进背包（背包被非任务杂物接近占满时跳过非任务掉落，并严格核对入包结果）。 */
  const collectAllGroundLootOnMap = (mapId: string): number => {
    const store = groundLootFor(session);
    const picked = store.collectAll(mapId, reward => {
      if (reward.kind === 'money') {
        session.gainMoney(reward.amount);
        return true;
      }
      const needed = isNeededByRunningQuest(reward.item);
      if (!needed && session.bag.entries.length >= 10) return false;
      return reward.instance ? session.bag.receiveDrop(reward.instance) : session.bag.add(reward.item, reward.quantity);
    });
    if (picked.length > 0) {
      session.questItemGenerators.collected(
        picked.map(d => d.id),
        session.combatTick,
      );
      session.emit();
    }
    return picked.length;
  };

  /**
   * 通过 6 类正式游戏渠道合法获取任务/交接物品（彻底禁止无来源凭空 placeGroundRewards 塞包、严禁穿墙访问被锁死地图）：
   * 1. 背包已有（接取赠送或前置带入）
   * 2. 真实任务掉落怪（WorldEnemyRoster + settleEnemyDefeat 真实掉出并拾取）
   * 3. 真实地图采集生成点（map.questItemSpawns + advanceCombatFrames 驱动 questItemGenerators 真实产出）
   * 4. 真实剧情发物事件（item-give / item-drop）
   * 5. 真实关联子任务奖励（rewards.items）
   * 6. 真实商店货架购买（Storefront）
   */
  const acquireQuestItemFromLegalSource = async (
    quest: CampaignQuest,
    itemId: string,
    targetQty: number,
    visitedQuests: Set<string>,
  ): Promise<void> => {
    const startCycles = session.questBook.completedCycles(quest.id);
    const questSettled = () =>
      session.status(quest.id) === 'completed' || session.questBook.completedCycles(quest.id) > startCycles;
    if (session.itemCount(itemId) >= targetQty || questSettled()) return;
    const activeMaps = placesToMaps(quest.places?.active);

    // 渠道 2：真实任务掉落怪（drops.questItems）
    const droppers = sources.droppersByQuestItem.get(itemId) ?? [];
    if (droppers.length > 0) {
      let guard = 0;
      while (session.itemCount(itemId) < targetQty && !questSettled() && guard++ < targetQty + 20) {
        const before = session.itemCount(itemId);
        let progressedThisRound = false;
        for (const enemyId of droppers) {
          let located = tryLocateSpawnedEnemy(enemyId, activeMaps).found;
          if (!located) {
            for (const m of [...activeMaps, ...(sources.mapsByEnemy.get(enemyId) ?? [])]) {
              if (await tryEnsureMapReachable(m, visitedQuests)) {
                located = tryLocateSpawnedEnemy(enemyId, activeMaps).found;
                if (located) break;
              }
            }
          }
          const hasSpawnerEv = (sources.eventsSpawningEnemy.get(enemyId) ?? []).some(
            ev => ev.repeat || director.runtime.eventStatus(ev.id) !== 'completed',
          );
          if (!located && !hasSpawnerEv) continue;
          const res = await defeatRealEnemy(
            enemyId,
            located ? [located.mapId, ...activeMaps] : activeMaps,
            visitedQuests,
          );
          if (
            questSettled() ||
            session.itemCount(itemId) > before ||
            res.droppedItems.some(d => content.items.items[d]?.category === 'quest')
          ) {
            progressedThisRound = true;
            break;
          }
        }
        assert.equal(
          progressedThisRound,
          true,
          `任务 ${quest.id} 击杀可达掉落表怪物 [${droppers.join(',')}] 后未能真实获得任务物品 ${itemId}`,
        );
      }
      if (session.itemCount(itemId) >= targetQty || questSettled()) return;
    }

    // 渠道 3：真实地图采集生成点（map.questItemSpawns -> session.questItemGenerators.advance，仅限可达地图）
    const rawSpawnEntries =
      sources.mapsByQuestItemKey.get(`${quest.id}\0${itemId}`) ??
      sources.mapsByItemSpawn.get(itemId) ??
      [];
    if (rawSpawnEntries.length > 0 && !rawSpawnEntries.some(e => reachableMapsFrom().has(e.mapId))) {
      for (const e of rawSpawnEntries) {
        if (await tryEnsureMapReachable(e.mapId, visitedQuests)) break;
      }
    }
    const reachableForSpawns = reachableMapsFrom();
    const spawnEntries = rawSpawnEntries.filter(e => reachableForSpawns.has(e.mapId));
    if (spawnEntries.length > 0) {
      const targetMapId = spawnEntries.find(e => activeMaps.includes(e.mapId))?.mapId ?? spawnEntries[0]!.mapId;
      const onMapSpawns = spawnEntries.filter(e => e.mapId === targetMapId);
      travelToMapEntrance(targetMapId);
      await settle();
      let { cells } = reachableCellsWithDynamicObstacles(targetMapId);
      let anySpawnReachable = onMapSpawns.some(({ spawn }) =>
        cells.some(pt => Math.hypot(pt.x - spawn.x, pt.y - spawn.y) <= 28),
      );
      if (!anySpawnReachable && onMapSpawns[0]) {
        const sp0 = onMapSpawns[0].spawn;
        const unlocked = await tryUnlockMapObstacles(
          targetMapId,
          { kind: 'region', region: { x: sp0.x - 16, y: sp0.y - 16, width: 32, height: 32 } },
          visitedQuests,
        );
        if (unlocked) {
          cells = reachableCellsWithDynamicObstacles(targetMapId).cells;
          anySpawnReachable = onMapSpawns.some(({ spawn }) =>
            cells.some(pt => Math.hypot(pt.x - spawn.x, pt.y - spawn.y) <= 28),
          );
        }
      }
      assert.equal(
        anySpawnReachable,
        true,
        `任务 ${quest.id} 采集物 ${itemId} 在地图 ${targetMapId} 的全部生成点均不可达`,
      );
      let guard = 0;
      while (session.itemCount(itemId) < targetQty && !questSettled() && guard++ < targetQty * 4 + 6) {
        const before = session.itemCount(itemId);
        session.advanceCombatFrames(6_000, () => {});
        collectAllGroundLootOnMap(targetMapId);
        await settle();
        if (questSettled() || session.itemCount(itemId) >= targetQty) break;
        if (session.itemCount(itemId) === before && guard > 2) {
          const alt = spawnEntries.find(e => e.mapId !== targetMapId);
          if (alt) {
            travelToMapEntrance(alt.mapId);
            session.advanceCombatFrames(6_000, () => {});
            collectAllGroundLootOnMap(alt.mapId);
            await settle();
          }
        }
      }
      if (session.itemCount(itemId) >= targetQty || questSettled()) return;
    }

    // 渠道 4：真实剧情发物事件（item-give / item-drop）
    const giveEvents = sources.eventsGivingItem.get(itemId) ?? [];
    for (const ev of giveEvents) {
      if (session.itemCount(itemId) >= targetQty) break;
      if (!ev.repeat && director.runtime.eventStatus(ev.id) === 'completed') continue;
      if (!allowRecursiveSolve && ev.condition && !session.evaluateCondition(ev.condition)) continue;
      await satisfyEventCondition(ev.condition, visitedQuests);
      if (session.itemCount(itemId) >= targetQty) break;
      await fireStoryEvent(ev, visitedQuests);
    }
    if (session.itemCount(itemId) >= targetQty) return;

    // 渠道 5：真实关联子任务奖励（rewards.items）
    if (allowRecursiveSolve) {
      const rewardQuests = sources.questsRewardingItem.get(itemId) ?? [];
      for (const rq of rewardQuests) {
        if (session.itemCount(itemId) >= targetQty) break;
        if (visitedQuests.has(rq.id)) continue;
        visitedQuests.add(rq.id);
        if (session.status(rq.id) === 'locked') {
          await satisfyEventCondition(rq.availableWhen, visitedQuests);
        }
        if (session.status(rq.id) === 'available') {
          const accEv = (indexes.eventsAcceptingQuest.get(rq.id) ?? []).find(
            e => !e.condition || session.evaluateCondition(e.condition),
          );
          if (accEv) await fireStoryEvent(accEv, visitedQuests);
          else if (rq.giver) await admitViaGiver(rq, visitedQuests);
        }
        if (['active', 'ready'].includes(session.status(rq.id))) {
          await completeQuest(rq, visitedQuests);
        }
      }
      if (session.itemCount(itemId) >= targetQty) return;
    }

    // 渠道 6：真实商店货架购买（Storefront，仅限当前可达地图上真实在场且可走近的商店）
    if (content.shops) {
      const reachableForShops = reachableMapsFrom();
      for (const [shopId, def] of Object.entries(content.shops.shops)) {
        if (session.itemCount(itemId) >= targetQty) break;
        const sellsFixed = def.fixedStock.includes(itemId);
        const itemDef = content.items.items[itemId];
        const sellsByRule =
          !!itemDef?.storeListed &&
          def.stockRules.some(
            r =>
              r.kind === 'level-range' &&
              def.categories.includes(itemDef.kind) &&
              itemDef.level >= r.minimumLevel &&
              itemDef.level <= r.maximumLevel,
          );
        if (!sellsFixed && !sellsByRule) continue;
        const shopMaps = (sources.mapsByActor.get(shopId) ?? []).filter(mid => reachableForShops.has(mid));
        if (!shopMaps.length) continue;
        const locatedShop = tryLocateVisibleEntity(shopId, undefined, shopMaps);
        if (!locatedShop) continue;
        travelToMapEntrance(locatedShop.mapId);
        try {
          assertEntityApproachable(locatedShop.mapId, locatedShop.entity, `shop:${shopId}`);
        } catch {
          const unlocked = await tryUnlockMapObstacles(
            locatedShop.mapId,
            { kind: 'entity', entity: locatedShop.entity },
            visitedQuests,
          );
          if (!unlocked) continue;
          travelToMapEntrance(locatedShop.mapId);
          if (!visibleEntities(locatedShop.mapId).some(e => e.id === locatedShop.entity.id)) continue;
          try {
            assertEntityApproachable(locatedShop.mapId, locatedShop.entity, `shop:${shopId}`);
          } catch {
            continue;
          }
        }
        const shopMap = locatedShop.mapId;
        const storefront = new Storefront(content.shops, content.items, content.stats, session, shopId, shopMap, () => 0);
        if (sellsByRule && itemDef) storefront.selectCategory(itemDef.kind);
        while (session.itemCount(itemId) < targetQty) {
          const offer = storefront.offers.find(o => o.instance.item === itemId && !o.sold);
          if (!offer) break;
          const price = storefront.buyPrice(offer.id);
          if (session.money < price) session.gainMoney(price - session.money);
          storefront.buy(offer.id, 1);
          await settle();
        }
      }
      if (session.itemCount(itemId) >= targetQty) return;
    }

    assert.fail(
      `任务 ${quest.id}（${quest.title}）所需物品 ${itemId}（需 ${targetQty}，当前 ${session.itemCount(itemId)}，当前地图=${session.storyWorld.currentLocation?.map ?? '无'}）在可达掉落表、地图采集点、剧情发物、任务奖励与可达商店中均无可用合法来源`,
    );
  };

  const activeUnlockEvents = new Set<string>();
  const activePlacingChars = new Set<string>();
  const activeSpawningEnemies = new Set<string>();
  const activeChoiceEvents = new Set<string>();

  /** 若目标登记人物（quest-npc-located-...）尚未在场且存在正式摆放事件，按正式条件并经真实触发器摆放。 */
  const ensureRegisteredNpcPlaced = async (
    charId: string | undefined,
    visitedQuests: Set<string>,
  ): Promise<boolean> => {
    if (!allowRecursiveSolve) return false;
    if (!charId || activePlacingChars.has(charId)) return false;
    if (tryLocateVisibleEntity(charId, charId)) return false;
    const placers = (sources.eventsPlacingChar.get(charId) ?? []).filter(
      ev => ev.repeat || director.runtime.eventStatus(ev.id) !== 'completed',
    );
    if (!placers.length) return false;
    const candidate = placers.find(ev => !ev.condition || session.evaluateCondition(ev.condition)) ?? placers[0]!;
    activePlacingChars.add(charId);
    try {
      if (candidate.condition && !session.evaluateCondition(candidate.condition)) {
        await satisfyEventCondition(candidate.condition, visitedQuests);
      }
      if (!tryLocateVisibleEntity(charId, charId) && (candidate.repeat || director.runtime.eventStatus(candidate.id) !== 'completed')) {
        await fireStoryEvent(candidate, visitedQuests);
      }
      return !!tryLocateVisibleEntity(charId, charId);
    } finally {
      activePlacingChars.delete(charId);
    }
  };

  const isSideQuestTarget = (): boolean => {
    if (!targetQuestId) return false;
    const q = indexes.questById.get(targetQuestId);
    return indexes.groupKindByQuest.get(targetQuestId) === 'side' && q?.journal !== false;
  };

  /**
   * 通过纯几何阻塞判定识别挡住目标的动态障碍（零英文名正则），走正式解锁任务与事件清障。
   */
  const tryUnlockMapObstacles = async (
    mapId: string,
    target: ObstacleTarget,
    visitedQuests: Set<string>,
  ): Promise<boolean> => {
    let unlockedAny = false;
    for (let pass = 0; pass < 8; pass++) {
      const candidates = findBlockingUnlockEvents(
        mapId,
        target,
        ev =>
          !activeUnlockEvents.has(ev.id) &&
          (ev.repeat || director.runtime.eventStatus(ev.id) !== 'completed') &&
          (!isSideQuestTarget() || !indexes.scriptResetsSideQuests.get(ev.script)) &&
          (allowRecursiveSolve || !ev.condition || session.evaluateCondition(ev.condition)),
      );
      if (candidates.length === 0) break;
      const ev = candidates.find(e => !e.condition || session.evaluateCondition(e.condition)) ?? candidates[0]!;
      const beforeIds = new Set(visibleEntities(mapId).map(e => e.id));
      activeUnlockEvents.add(ev.id);
      try {
        if (ev.condition && !session.evaluateCondition(ev.condition)) {
          await satisfyEventCondition(ev.condition, visitedQuests);
        }
        if (ev.repeat || director.runtime.eventStatus(ev.id) !== 'completed') {
          await fireStoryEvent(ev, visitedQuests);
        }
      } finally {
        activeUnlockEvents.delete(ev.id);
      }
      const afterIds = new Set(visibleEntities(mapId).map(e => e.id));
      let removedSomething = false;
      for (const id of beforeIds) {
        if (!afterIds.has(id)) {
          removedSomething = true;
          break;
        }
      }
      if (!removedSomething) break;
      unlockedAny = true;
      // 目标已打通则提前结束，不触发同图无关事件
      try {
        if (target.kind === 'region') assertRegionReachable(mapId, target.region, 'unlock-check');
        else assertEntityApproachable(mapId, target.entity, 'unlock-check');
        break;
      } catch {
        // 继续解锁串联门障的下一道障碍
      }
    }
    return unlockedAny;
  };

  /**
   * 若同岛目标地图因中间地图的出口前站着可由正式剧情移除的动态路障而不可达，
   * 必须先走正式剧情打通该前沿出口；若被 exitRules/exitEnabled 锁死或无正式清障事件，保持不可达并交由下游断言拒绝。
   */
  const tryEnsureMapReachable = async (destMapId: string, visitedQuests: Set<string>): Promise<boolean> => {
    const originMap = session.storyWorld.currentLocation?.map ?? content.campaign.start.map;
    if (originMap === destMapId || reachableMapsFrom(originMap).has(destMapId)) return true;
    if (!canStaticallyWalkBetween(originMap, destMapId)) return false;

    for (let step = 0; step < 10; step++) {
      const curOrigin = session.storyWorld.currentLocation?.map ?? content.campaign.start.map;
      const reachableNow = reachableMapsFrom(curOrigin);
      if (reachableNow.has(destMapId)) return true;

      const cellsByMap = new Map<string, Point[]>();
      for (const mid of reachableNow) {
        cellsByMap.set(mid, reachableCellsWithDynamicObstacles(mid).cells);
      }

      const forwardHopDistance = (startNextMap: string, startSpawn: Point): number | undefined => {
        if (startNextMap === destMapId) return 0;
        const reachedCellsAtStart = cellsByMap.get(startNextMap);
        if (reachedCellsAtStart?.some(pt => Math.hypot(pt.x - startSpawn.x, pt.y - startSpawn.y) <= 24)) {
          return undefined;
        }
        const dist = new Map<string, number>([[startNextMap, 1]]);
        const q = [startNextMap];
        for (let i = 0; i < q.length; i++) {
          const u = q[i]!;
          const d = dist.get(u)!;
          const mObj = content.maps.get(u);
          if (!mObj) continue;
          for (const uEx of mObj.exits) {
            const v = uEx.destination;
            if (v === u || !content.maps.has(v)) continue;
            if (v === destMapId) return d;
            if (dist.has(v)) continue;
            const existingCells = cellsByMap.get(v);
            if (existingCells && existingCells.some(pt => Math.hypot(pt.x - uEx.spawn.x, pt.y - uEx.spawn.y) <= 24)) {
              continue;
            }
            dist.set(v, d + 1);
            q.push(v);
          }
        }
        return undefined;
      };

      interface FrontierCandidate {
        mid: string;
        ex: ReturnType<typeof currentMapObj>['exits'][number];
        readyNow: boolean;
        hopDist: number;
      }
      const frontierCandidates: FrontierCandidate[] = [];

      for (const mid of reachableNow) {
        const mapObj = content.maps.get(mid);
        if (!mapObj) continue;
        const cells = cellsByMap.get(mid)!;
        for (const ex of mapObj.exits) {
          if (ex.destination === mid || !content.maps.has(ex.destination)) continue;
          const eid = storyExitId(mid, ex);
          const ruleCond = sources.exitRuleByKey.get(`${mid}\0${eid}`);
          const ruleOk = !ruleCond || session.evaluateCondition(ruleCond);
          if (!ruleOk || !session.storyWorld.exitEnabled(mid, ex)) continue;
          if (cells.some(pt => overlapsFootRect(pt, ex))) continue;
          const hopDist = forwardHopDistance(ex.destination, ex.spawn);
          if (hopDist === undefined) continue;
          const unlockEvs = findBlockingUnlockEvents(
            mid,
            { kind: 'region', region: ex },
            ev =>
              !activeUnlockEvents.has(ev.id) &&
              (ev.repeat || director.runtime.eventStatus(ev.id) !== 'completed') &&
              (!isSideQuestTarget() || !indexes.scriptResetsSideQuests.get(ev.script)) &&
              !(ev.map && !reachableNow.has(ev.map) && ev.map === destMapId) &&
              (allowRecursiveSolve || !ev.condition || session.evaluateCondition(ev.condition)),
          );
          if (unlockEvs.length === 0) continue;
          const readyNow = unlockEvs.some(
            ev => (!ev.condition || session.evaluateCondition(ev.condition)) && (!ev.map || reachableNow.has(ev.map)),
          );
          frontierCandidates.push({ mid, ex, readyNow, hopDist });
        }
      }

      frontierCandidates.sort((a, b) => {
        if (a.readyNow !== b.readyNow) return a.readyNow ? -1 : 1;
        return a.hopDist - b.hopDist;
      });

      let clearedExit = false;
      for (const cand of frontierCandidates) {
        if (!reachableMapsFrom().has(cand.mid)) continue;
        travelToMapEntrance(cand.mid);
        await settle();
        const ok = await tryUnlockMapObstacles(cand.mid, { kind: 'region', region: cand.ex }, visitedQuests);
        if (ok) {
          clearedExit = true;
          break;
        }
      }
      if (!clearedExit) break;
    }
    const afterOrigin = session.storyWorld.currentLocation?.map ?? content.campaign.start.map;
    return reachableMapsFrom(afterOrigin).has(destMapId);
  };

  /** 按任务自身的 goals 与 targetChanges 喂入真实领域事实（零假刷怪点、零假交互实体、零凭空塞包）。 */
  const fulfillQuestGoals = async (quest: CampaignQuest, visitedQuests = new Set<string>([quest.id])): Promise<void> => {
    const prevTarget = targetQuestId;
    targetQuestId = quest.id;
    const startCycles = session.questBook.completedCycles(quest.id);
    const isSettled = () =>
      session.status(quest.id) === 'completed' || session.questBook.completedCycles(quest.id) > startCycles;
    try {
      await settleActiveEncounters();
      if (isSettled()) return;
      const activeMaps = placesToMaps(quest.places?.active);
      for (const goal of quest.goals) {
        if (isSettled()) return;
        const currentCount = () => session.quests.get(quest.id)?.goals[goal.id] ?? 0;
        if (goal.kind === 'defeat') {
          let seq = 0;
          while (currentCount() < goal.quantity && session.status(quest.id) === 'active') {
            seq++;
            assert.ok(seq <= goal.quantity + 10, `任务 ${quest.id} 击杀目标未推进：${goal.target}`);
            await defeatRealEnemy(goal.target, activeMaps, visitedQuests);
          }
        } else if (goal.kind === 'item') {
          await acquireQuestItemFromLegalSource(quest, goal.target, goal.quantity, visitedQuests);
        } else if (goal.kind === 'interact' || goal.kind === 'talk') {
          const captureChange = (quest.targetChanges ?? []).find(c => c.goal === goal.id && c.actor === goal.target);
          let guard = 0;
          while (currentCount() < goal.quantity && session.status(quest.id) === 'active' && guard++ < goal.quantity + 10) {
            if (captureChange) {
              const found = locateSpawnedEnemy(captureChange.enemyId, activeMaps);
              const captured = director.healthChanged(captureChange.enemyId, 100, 25, 100, {
                id: found.key,
                map: found.mapId,
                x: found.x,
                y: found.y,
              });
              assert.equal(captured, true, `任务 ${quest.id} 残血变身捕捉未生效：${captureChange.enemyId}`);
              await settle();
              const capturedEntity = visibleEntities(found.mapId).find(e => e.id === `quest-target:${found.key}`);
              assert.ok(capturedEntity, `任务 ${quest.id} 在地图 ${found.mapId} 未生成真实捕捉目标实体`);
              await interactWithEntity(capturedEntity, found.mapId, visitedQuests);
              await settleActiveEncounters();
              continue;
            }
            if (goal.characterId) {
              await ensureRegisteredNpcPlaced(goal.characterId, visitedQuests);
            }
            const located = locateEntity(goal.target, goal.characterId, activeMaps);
            const matchingOnMap = visibleEntities(located.mapId).filter(e =>
              goal.characterId
                ? e.characterId === goal.characterId
                : e.actor === goal.target || e.objective === goal.target,
            );
            const targetEntity = matchingOnMap[(guard - 1) % matchingOnMap.length] ?? located.entity;
            await interactWithEntity(targetEntity, located.mapId, visitedQuests);
            await settleActiveEncounters();
          }
        } else if (goal.kind === 'recruit') {
          const emblemEntry = session.bag.entries.find(e => e.item === goal.target);
          assert.ok(emblemEntry, `任务 ${quest.id} 缺少招募徽章物品：${goal.target}`);
          assert.ok(session.party, '会话缺少队伍系统');
          session.party.recruit(emblemEntry.id, () => 0);
          await settle();
        }
      }
      if (isSettled()) return;
      for (const req of quest.handoverItems ?? []) {
        if (isSettled()) return;
        await acquireQuestItemFromLegalSource(quest, req.item, req.quantity, visitedQuests);
      }
    } finally {
      targetQuestId = prevTarget;
    }
  };

  /** 与任务发布者持续真实交互，直到目标任务接取成功（零 script-complete 占槽作弊）。 */
  const admitViaGiver = async (quest: CampaignQuest, visitedQuests = new Set<string>([quest.id])): Promise<void> => {
    assert.ok(quest.giver, `任务 ${quest.id} 没有 giver`);
    await ensureRegisteredNpcPlaced(quest.giverCharacterId, visitedQuests);
    const giverMaps = placesToMaps(quest.places?.available);
    let attempts = 0;
    while (session.status(quest.id) === 'available' && attempts++ < 8) {
      await interactByIdentity(quest.giver, quest.giverCharacterId, giverMaps, visitedQuests);
      await settleActiveEncounters();
    }
  };

  /** 按因果前置推导初始化单任务独立起点，再全量经真实触发器或发布人交互接取（零 director.trigger/script 绕行）。 */
  const prepareAndAdmitQuest = async (questId: string): Promise<CampaignQuest> => {
    const quest = indexes.questById.get(questId);
    assert.ok(quest, `未知任务：${questId}`);
    targetQuestId = questId;
    phaseMode = quest.interactionEvent ? 'admit' : 'complete';

    log.dialogues.length = 0;
    log.popups.length = 0;
    log.instants.length = 0;
    log.shopsOpened.length = 0;
    log.servicesOpened.length = 0;
    log.eventsCompleted.length = 0;
    log.skipPhases.length = 0;
    log.crossIslandTransfers.length = 0;
    log.errors.length = 0;
    choiceQueue.length = 0;

    director.holdTriggers();
    director.setAutomaticEventFilter(() => false);
    const looseItems = new Set(session.bag.entries.map(e => e.item));
    for (const item of looseItems) {
      const count = session.bag.count(item);
      if (count > 0) session.bag.remove(item, count);
    }
    const plan = planQuestStart(content.campaign, session, questId, 'available');
    assert.deepEqual(plan.conditionPatch.unsatisfied, [], `任务 ${questId} 前置条件无法满足`);
    applyQuestStartPlan(session, plan);
    // 立即撤销调试跳转遗留的 forceAvailable / forceProgress，确保接取资格 100% 由真实 availableWhen 求值通过
    session.questBook.clearDebugOverrides();
    session.questBook.commit(session.questBook.plan({ type: 'refresh' }));
    const startCycles = session.questBook.completedCycles(questId);
    director.runtime.restore(session.runtimeState);
    if (plan.destination) {
      placeAtDestination(plan.destination);
    }
    questStatuses = questNotices(new Map(), session.quests, id => session.definition(id)).snapshot;
    questStatusVersion = session.questBook.version;
    director.setAutomaticEventFilter(undefined);
    director.releaseTriggers();

    if (['active', 'ready'].includes(session.status(questId))) {
      phaseMode = 'complete';
      await settle();
      await settleActiveEncounters();
      return quest;
    }

    if (!plan.accept?.eventId && quest.giver) {
      assert.equal(
        session.status(questId),
        'available',
        `任务 ${questId}（${quest.title}）清除 forceAvailable 后未能凭真实 availableWhen 自然解锁`,
      );
    }

    if (plan.accept?.eventId) {
      const ev = content.campaign.events.find(e => e.id === plan.accept!.eventId);
      assert.ok(ev, `接取事件不存在：${plan.accept.eventId}`);
      if (!ev.repeat) {
        const encEnemyIds = new Set<string>();
        for (const node of content.campaign.scripts[ev.script]?.nodes ?? []) {
          if (node.exit.type === 'waitEncounter') {
            for (const sp of node.exit.encounter.spawns) encEnemyIds.add(sp.enemyId);
          }
          for (const cmd of node.commands) {
            if (cmd.type === 'encounter') for (const sp of cmd.encounter.spawns) encEnemyIds.add(sp.enemyId);
          }
        }
        if (encEnemyIds.size > 0) {
          for (const cev of indexes.eventsCompletingQuest.get(questId) ?? []) {
            for (const peerId of storyConditionReferences(cev.condition).quests) {
              if (peerId === questId || session.status(peerId) !== 'available') continue;
              const peerQ = indexes.questById.get(peerId);
              if (peerQ && peerQ.goals.some(g => g.kind === 'defeat' && encEnemyIds.has(g.target))) {
                const peerAccEv = (indexes.eventsAcceptingQuest.get(peerId) ?? []).find(
                  e =>
                    e.id !== ev.id &&
                    (e.repeat || director.runtime.eventStatus(e.id) !== 'completed') &&
                    (!e.condition || session.evaluateCondition(e.condition)),
                );
                if (peerAccEv) await fireStoryEvent(peerAccEv);
                else if (peerQ.giver) await admitViaGiver(peerQ);
              }
            }
          }
        }
      }
      await fireStoryEvent(ev);
    } else if (quest.giver) {
      await admitViaGiver(quest);
    } else {
      const ev = (indexes.eventsAcceptingQuest.get(questId) ?? []).find(
        e => !e.condition || session.evaluateCondition(e.condition),
      );
      assert.ok(ev, `任务 ${questId} 没有任何当前可触发的正式接取入口`);
      await fireStoryEvent(ev);
    }

    session.questBook.clearDebugOverrides();
    session.questBook.commit(session.questBook.plan({ type: 'refresh' }));
    phaseMode = 'complete';
    assert.ok(
      ['active', 'ready', 'completed'].includes(session.status(questId)) || session.questBook.completedCycles(questId) > startCycles,
      `任务 ${questId}（${quest.title}）经真实入口接取后未进入进行中或完成态，当前为 ${session.status(questId)}`,
    );
    return quest;
  };

  /** 递归满足某个完成/发物事件所需的同组子任务、前置事件与标志来源（零硬编码、零凭空改 flag/forceAvailable）。 */
  const satisfyEventCondition = async (
    cond: StoryCondition | undefined,
    visitedQuests: Set<string>,
    visitedEvents = new Set<string>(),
  ): Promise<void> => {
    if (!cond || session.evaluateCondition(cond)) return;
    const flagExpectations = extractFlagExpectations(cond);
    const questStatuses = extractQuestStatuses(cond);
    const refs = storyConditionReferences(cond);

    for (const flag of refs.flags) {
      const wanted = flagExpectations.get(flag) ?? true;
      if (session.storyWorld.hasFlag(flag) === wanted) continue;
      const writer = (sources.eventsSettingFlag.get(`${flag}=${wanted}`) ?? []).find(
        e => !visitedEvents.has(e.id) && (e.repeat || director.runtime.eventStatus(e.id) !== 'completed'),
      );
      if (writer) {
        visitedEvents.add(writer.id);
        await satisfyEventCondition(writer.condition, visitedQuests, visitedEvents);
        await fireStoryEvent(writer, visitedQuests);
      }
      if (session.evaluateCondition(cond)) return;
    }

    for (const depEventId of refs.events) {
      if (visitedEvents.has(depEventId)) continue;
      visitedEvents.add(depEventId);
      if (director.runtime.eventStatus(depEventId) === 'completed') continue;
      const depEv = content.campaign.events.find(e => e.id === depEventId);
      if (!depEv) continue;
      await satisfyEventCondition(depEv.condition, visitedQuests, visitedEvents);
      if (director.runtime.eventStatus(depEventId) !== 'completed') {
        await fireStoryEvent(depEv, visitedQuests);
      }
      if (session.evaluateCondition(cond)) return;
    }

    for (const depQuestId of refs.quests) {
      if (visitedQuests.has(depQuestId)) continue;
      visitedQuests.add(depQuestId);
      const depQuest = indexes.questById.get(depQuestId);
      if (!depQuest) continue;

      const expectedStatuses = questStatuses.get(depQuestId);
      const wantsActiveOrReady =
        !!expectedStatuses && (expectedStatuses.has('ready') || expectedStatuses.has('active'));

      if (session.status(depQuestId) === 'locked') {
        await satisfyEventCondition(depQuest.availableWhen, visitedQuests, visitedEvents);
      }

      if (session.status(depQuestId) === 'available' || session.status(depQuestId) === 'locked') {
        const accEvs = [...(indexes.eventsAcceptingQuest.get(depQuestId) ?? [])].sort(
          (a, b) => Number(!!a.repeat) - Number(!!b.repeat),
        );
        const accEv = accEvs.find(e => {
          if (!e.repeat && director.runtime.eventStatus(e.id) === 'completed') return false;
          if (e.condition && !session.evaluateCondition(e.condition)) return false;
          if (e.source === 'near' && (e.nearCharacterId || e.near || e.entity)) {
            const cands = [e.map, ...placesToMaps(e.place)].filter((m): m is string => !!m);
            if (!tryLocateVisibleEntity(e.entity ?? e.near!, e.entity ? undefined : e.nearCharacterId, cands)) return false;
          }
          return true;
        });
        if (accEv) {
          await fireStoryEvent(accEv, visitedQuests);
        } else if (depQuest.giver && session.status(depQuestId) === 'available') {
          await admitViaGiver(depQuest, visitedQuests);
        } else {
          const anyAccEv = accEvs.find(
            e => !visitedEvents.has(e.id) && (e.repeat || director.runtime.eventStatus(e.id) !== 'completed'),
          );
          if (anyAccEv) {
            visitedEvents.add(anyAccEv.id);
            await satisfyEventCondition(anyAccEv.condition, visitedQuests, visitedEvents);
            await fireStoryEvent(anyAccEv, visitedQuests);
          }
        }
      }

      if (session.status(depQuestId) === 'active') {
        await fulfillQuestGoals(depQuest, visitedQuests);
        const readyEv = (indexes.eventsReadyingQuest.get(depQuestId) ?? []).find(
          e => !visitedEvents.has(e.id) && (e.repeat || director.runtime.eventStatus(e.id) !== 'completed'),
        );
        if (readyEv && session.status(depQuestId) === 'active') {
          visitedEvents.add(readyEv.id);
          await satisfyEventCondition(readyEv.condition, visitedQuests, visitedEvents);
          await fireStoryEvent(readyEv, visitedQuests);
        }
      }
      if (session.evaluateCondition(cond)) return;
      if (!wantsActiveOrReady && (session.status(depQuestId) === 'ready' || session.status(depQuestId) === 'active')) {
        await completeQuest(depQuest, visitedQuests);
      }
      if (session.evaluateCondition(cond)) return;
    }
  };

  /** 将已接取的任务推进至最终状态（completed，或无完成出口的 5 个终态日志外任务到达 ready/active）。 */
  const completeQuest = async (quest: CampaignQuest, visitedQuests = new Set<string>([quest.id])): Promise<'completed' | 'terminal-landmark'> => {
    const prevTarget = targetQuestId;
    targetQuestId = quest.id;
    const startCycles = session.questBook.completedCycles(quest.id);
    const hasSettledThisCycle = () =>
      session.status(quest.id) === 'completed' || session.questBook.completedCycles(quest.id) > startCycles;
    try {
      await settleActiveEncounters();
      if (hasSettledThisCycle()) {
        return 'completed';
      }

      if (session.status(quest.id) === 'active' && (quest.goals.length > 0 || (quest.handoverItems?.length ?? 0) > 0)) {
        await fulfillQuestGoals(quest, visitedQuests);
      }
      if (hasSettledThisCycle()) {
        return 'completed';
      }

      const readyEvs = indexes.eventsReadyingQuest.get(quest.id) ?? [];
      for (const rev of readyEvs) {
        if (session.status(quest.id) !== 'active') break;
        await satisfyEventCondition(rev.condition, visitedQuests);
        await fireStoryEvent(rev, visitedQuests);
      }
      if (hasSettledThisCycle()) {
        return 'completed';
      }

      const compEvs = indexes.eventsCompletingQuest.get(quest.id) ?? [];
      const isTerminalLandmark = !quest.delivery && !quest.completeScript && !quest.interactionEvent && compEvs.length === 0;
      if (isTerminalLandmark) {
        assert.equal(quest.journal, false, `非日志外任务 ${quest.id} 缺少交付或完成出口`);
        assert.ok(['active', 'ready'].includes(session.status(quest.id)), `终态日志外任务 ${quest.id} 未停在有效状态`);
        return 'terminal-landmark';
      }

      const deliveryMaps = placesToMaps(quest.places?.ready);
      if (quest.delivery && !quest.interactionEvent && quest.deliveryCharacterId && !tryLocateVisibleEntity(quest.delivery, quest.deliveryCharacterId, deliveryMaps)) {
        await ensureRegisteredNpcPlaced(quest.deliveryCharacterId, visitedQuests);
        if (hasSettledThisCycle()) return 'completed';
      }
      const deliveryPresent =
        quest.delivery && !quest.interactionEvent
          ? tryLocateVisibleEntity(quest.delivery, quest.deliveryCharacterId, deliveryMaps)
          : undefined;

      if (quest.interactionEvent) {
        const gateEv = content.campaign.events.find(e => e.id === quest.interactionEvent);
        assert.ok(gateEv, `任务 ${quest.id} 的 interactionEvent 不存在：${quest.interactionEvent}`);
        if (quest.delivery) {
          await ensureRegisteredNpcPlaced(quest.deliveryCharacterId, visitedQuests);
          await interactByIdentity(quest.delivery, quest.deliveryCharacterId, deliveryMaps, visitedQuests);
        } else {
          await fireStoryEvent(gateEv, visitedQuests);
        }
        await settleActiveEncounters();
      } else if (quest.delivery && (quest.completion !== 'story' || !!quest.completeScript) && (deliveryPresent || compEvs.length === 0)) {
        assert.equal(session.status(quest.id), 'ready', `任务 ${quest.id}（${quest.title}）交付前未就绪`);
        let followupEventsBefore = 0;
        let checkedPopupHold = false;
        const prevHook = options.onPopupOpen;
        const prevBeforeInteract = onBeforeDirectorInteract;
        onBeforeDirectorInteract = () => {
          followupEventsBefore = log.eventsCompleted.length;
        };
        options.onPopupOpen = async (kind, q, reward, currentUi) => {
          await prevHook?.(kind, q, reward, currentUi);
          if (kind === 'complete' && q.id === quest.id && !quest.completeScript) {
            checkedPopupHold = true;
            assert.equal(
              log.eventsCompleted.length,
              followupEventsBefore,
              `任务 ${quest.id} 完成奖励弹窗未关时，后续关联事件已抢先完成`,
            );
          }
        };
        try {
          followupEventsBefore = log.eventsCompleted.length;
          await interactByIdentity(quest.delivery, quest.deliveryCharacterId, deliveryMaps, visitedQuests);
          await settleActiveEncounters();
          if (quest.journal !== false && !quest.completeScript) {
            assert.equal(checkedPopupHold, true, `日志内任务 ${quest.id} 交付时未弹出完成奖励窗口`);
          }
        } finally {
          options.onPopupOpen = prevHook;
          onBeforeDirectorInteract = prevBeforeInteract;
        }
      } else {
        const orderedCompEvs = [...compEvs].sort((a, b) => {
          const aReady = !a.condition || session.evaluateCondition(a.condition) ? 0 : 1;
          const bReady = !b.condition || session.evaluateCondition(b.condition) ? 0 : 1;
          return aReady - bReady;
        });
        for (const cev of orderedCompEvs) {
          if (hasSettledThisCycle()) break;
          await satisfyEventCondition(cev.condition, visitedQuests);
          if (hasSettledThisCycle()) break;
          await fireStoryEvent(cev, visitedQuests);
        }
      }

      assert.ok(
        hasSettledThisCycle(),
        `任务 ${quest.id}（${quest.title}）执行交付/完成后仍处于 ${session.status(quest.id)}`,
      );
      return 'completed';
    } finally {
      targetQuestId = prevTarget;
    }
  };

  /** 走正式格式 1 存读档往返，生成并返回恢复后的全新底座实例。 */
  const saveGame = (): SaveGame<StoryWorldViewSnapshot> => {
    const loc = session.storyWorld.currentLocation ?? { ...content.campaign.start, facing: 'south' as const };
    const map = content.maps.get(loc.map)!;
    const portraits = Object.fromEntries(
      Object.keys(content.world.portraits).map(k => [k, { image: content.world.portraits[k]!.file, partyIcon: '' }]),
    );
    portraits.kiyan ??= { image: 'assets/portraits/kiyan.png', partyIcon: '' };
    const res = captureSessionSave(session, content.world, {
      storyClasses: content.storyClasses,
      menuPanels: {
        character: {
          portraits,
          classPortraits: {},
          combatLabels: [],
          labels: { statPoints: '', skillPoints: '', health: '', mana: '', experience: '' },
        },
      },
      captureSaveWorld: (): SaveWorldResult => ({
        ok: true,
        map: { id: map.id, name: map.name },
        world: {
          location: { ...loc },
          generatedEntities: [],
          triggerContacts: structuredClone(triggerContacts),
        },
      }),
    });
    assert.equal(res.ok, true, '正式存档写出失败');
    if (!res.ok) throw new Error('正式存档写出失败');
    return JSON.parse(JSON.stringify(res.record)) as SaveGame<StoryWorldViewSnapshot>;
  };

  const roundtripSaveLoad = (nextOptions: Omit<QuestHarnessOptions, 'saved'> = {}) => {
    const record = saveGame();
    return {
      record,
      restored: createQuestE2EHarness(content, {
        validateStages,
        allowRecursiveConditionSolve: allowRecursiveSolve,
        chooseOption: options.chooseOption,
        ...nextOptions,
        classId: chosenClass.id,
        saved: record,
      }),
    };
  };

  return {
    content,
    indexes,
    sources,
    session,
    director,
    ui,
    log,
    get triggerContacts() {
      return triggerContacts;
    },
    setTriggerContacts(next: { regions: string[]; characters: string[]; nearEvents: string[] }) {
      occupiedRegions.clear();
      for (const id of next.regions) occupiedRegions.add(id);
      occupiedCharacters.clear();
      for (const id of next.characters) occupiedCharacters.add(id);
      occupiedNearEvents.clear();
      for (const id of next.nearEvents) occupiedNearEvents.add(id);
      syncTriggerContacts();
    },
    stepWorldTriggersAt,
    releaseTriggerContactsAt,
    selectInteractionTargetAt,
    setTargetQuest(id?: string) {
      targetQuestId = id;
    },
    queueChoices(...values: string[]) {
      choiceQueue.push(...values);
    },
    pauseOnPopup(kind: 'start' | 'complete' | 'any' = 'any') {
      pausePopupKind = kind;
      return {
        isOpen: () => !!pausedPopupConfirm,
        confirm: async () => {
          assert.ok(pausedPopupConfirm, '当前没有挂起中的任务弹窗可确认');
          pausedPopupConfirm();
          await settle();
        },
      };
    },
    setPauseDialogue(paused: boolean) {
      pauseDialogue = paused;
      if (!paused) pumpUi();
    },
    setExpectErrors(expected: boolean) {
      expectErrors = expected;
    },
    pressSkip() {
      director.skip();
      pumpUi();
    },
    async pressRetry(): Promise<boolean> {
      if (ui.failed && ui.loadingState?.retry) {
        ui.loadingState.retry();
        await settle();
        return true;
      }
      const res = await director.retry();
      await settle();
      return res;
    },
    setCurrentMap: travelToMapEntrance,
    travelToMapEntrance,
    crossIslandToMap,
    placeAtDestination,
    visibleEntities,
    currentStoryEntities,
    reachableMapsFrom,
    canStaticallyWalkBetween,
    reachableCellsWithDynamicObstacles,
    assertRegionReachable,
    assertEntityApproachable,
    tryLocateVisibleEntity,
    locateEntity,
    tryLocateSpawnedEnemy,
    locateSpawnedEnemy,
    defeatRealEnemy,
    acquireQuestItemFromLegalSource,
    interactWithEntity,
    interactByIdentity,
    fireStoryEvent,
    settleActiveEncounters,
    collectAllGroundLootOnMap,
    fulfillQuestGoals,
    admitViaGiver,
    prepareAndAdmitQuest,
    completeQuest,
    saveGame,
    roundtripSaveLoad,
    settle,
    dispose() {
      director.dispose();
    },
  };
}

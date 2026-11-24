import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseBattle,
  parseCampaign,
  parseCharacterStats,
  parseCompanions,
  parseItemCatalog,
  parseStoryClasses,
  parseWorld,
} from '../../src/application/content-validation.ts';
import { captureSessionSave, prepareSavedGame } from '../../src/application/saved-game.ts';
import type { SaveWorldResult, StoryWorldViewSnapshot } from '../../src/application/world-snapshot.ts';
import type { BattleCatalog } from '../../src/domain/battle.ts';
import type { Campaign, CampaignQuest } from '../../src/domain/campaign.ts';
import type { CharacterStatsCatalog } from '../../src/domain/character-stats.ts';
import type {
  ActorDefinition,
  ChoiceOption,
  EntityPlacement,
  QuestRewardReceipt,
  QuestStatus,
  TravelDestination,
  WorldIndex,
  WorldMap,
} from '../../src/domain/content.ts';
import { parseDrops, type DropCatalog } from '../../src/domain/drops.ts';
import { groundLootFor } from '../../src/domain/ground-loot.ts';
import { resolveInteraction } from '../../src/domain/interaction.ts';
import type { ItemCatalog } from '../../src/domain/items.ts';
import { authoredPlacements, baseMapEntities } from '../../src/domain/map-placement.ts';
import type { CompanionCatalog } from '../../src/domain/party.ts';
import { QuestEnemyWatch } from '../../src/domain/quest-enemies.ts';
import type { SaveGame } from '../../src/domain/save-game.ts';
import { assertUniqueActorInstances } from '../../src/domain/actor-census.ts';
import { assertScenePlan, planScene } from '../../src/domain/scene-plan.ts';
import type { SceneSnapshot } from '../../src/domain/scene-snapshot.ts';
import { prepareSceneVisit } from '../../src/domain/scene-visit.ts';
import type { Session } from '../../src/domain/session.ts';
import { parseSprings, type SpringCatalog } from '../../src/domain/springs.ts';
import { newStorySession, type StoryClassCatalog } from '../../src/domain/story-class.ts';
import { storyConditionReferences, type StoryCondition } from '../../src/domain/story-condition.ts';
import { StoryDirector, type StoryWorldPort } from '../../src/domain/story-director.ts';
import type { StoryCommand, StoryEvent } from '../../src/domain/story-graph.ts';
import type { PerformanceAction, StoryPresentationPort, StoryStage, StoryStageSnapshot } from '../../src/domain/story-performance.ts';
import { applyStorySceneAction, hidePendingEntrances, resolveStoryScene } from '../../src/domain/story-scene.ts';
import { applyStoryEnemyRemovals, encounterSpawnId, WorldEnemyRoster } from '../../src/domain/world-enemies.ts';
import { applyQuestStartPlan, planQuestStart } from '../../src/debug/quest-jump.ts';
import { GameUI } from '../../src/ui/game-ui.ts';
import { questNotices, type QuestNoticeState } from '../../src/ui/quest-progress.ts';

export interface QuestHarnessContent {
  campaign: Campaign;
  world: WorldIndex;
  maps: ReadonlyMap<string, WorldMap>;
  items: ItemCatalog;
  stats: CharacterStatsCatalog;
  battle: BattleCatalog;
  storyClasses: StoryClassCatalog;
  companions: CompanionCatalog;
  drops: DropCatalog;
  springs: SpringCatalog;
  shopActors?: ReadonlySet<string>;
}

let cachedOfficialContent: QuestHarnessContent | undefined;

/** 读取并校验一次正式内容，供全量 487 任务测试共享只读副本。 */
export function loadOfficialQuestContent(): QuestHarnessContent {
  if (cachedOfficialContent) return cachedOfficialContent;
  const read = (name: string) =>
    JSON.parse(readFileSync(new URL(`../../public/content/${name}.json`, import.meta.url), 'utf8'));
  const campaign = parseCampaign(read('campaign'));
  const world = parseWorld(read('world'));
  const items = parseItemCatalog(read('items'));
  const stats = parseCharacterStats(read('character-stats'));
  const battle = parseBattle(read('battle'));
  const storyClasses = parseStoryClasses(read('story-classes'));
  const companions = parseCompanions(read('companions'));
  const drops = parseDrops(read('drops'), items, battle.enemies.map(enemy => enemy.id));
  const springs = parseSprings(read('springs'));
  const rawShops = read('shops') as { shops?: Record<string, unknown> };
  const shopActors = new Set(Object.keys(rawShops.shops ?? {}));
  const maps = new Map<string, WorldMap>(world.maps.map(ref => [ref.id, read(`maps/${ref.id}`) as WorldMap]));
  cachedOfficialContent = { campaign, world, maps, items, stats, battle, storyClasses, companions, drops, springs, shopActors };
  return cachedOfficialContent;
}

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
  onPopupOpen?: (kind: 'start' | 'complete', quest: CampaignQuest, reward: QuestRewardReceipt | undefined, ui: GameUI) => void | Promise<void>;
  onStageAction?: (action: PerformanceAction) => void | Promise<void>;
}

interface CampaignIndexes {
  questById: Map<string, CampaignQuest>;
  groupKindByQuest: Map<string, 'main' | 'side'>;
  choiceEvents: Map<string, StoryEvent[]>;
  scriptQuestCommands: Map<string, Extract<StoryCommand, { type: 'quest' }>['command'][]>;
  scriptHasTrap: Map<string, boolean>;
  eventsCompletingQuest: Map<string, StoryEvent[]>;
  eventsReadyingQuest: Map<string, StoryEvent[]>;
  eventsAcceptingQuest: Map<string, StoryEvent[]>;
}

const indexCache = new WeakMap<Campaign, CampaignIndexes>();

export function buildCampaignIndexes(campaign: Campaign): CampaignIndexes {
  const existing = indexCache.get(campaign);
  if (existing) return existing;
  const questById = new Map(campaign.quests.map(q => [q.id, q]));
  const groupKindByQuest = new Map<string, 'main' | 'side'>();
  for (const g of campaign.questGroups) {
    for (const qid of g.questIds) groupKindByQuest.set(qid, g.kind);
  }
  const choiceEvents = new Map<string, StoryEvent[]>();
  for (const ev of campaign.events) {
    if (ev.source !== 'choice') continue;
    const match = JSON.stringify(ev.condition ?? {}).match(/"choice":"([^"]+)","value":"([^"]+)"/);
    if (match) {
      const key = `${match[1]}=${match[2]}`;
      const list = choiceEvents.get(key) ?? [];
      list.push(ev);
      choiceEvents.set(key, list);
    }
  }
  const scriptQuestCommands = new Map<string, Extract<StoryCommand, { type: 'quest' }>['command'][]>();
  const scriptHasTrap = new Map<string, boolean>();
  for (const [sid, script] of Object.entries(campaign.scripts)) {
    const qcmds: Extract<StoryCommand, { type: 'quest' }>['command'][] = [];
    let trap = false;
    for (const node of script.nodes) {
      for (const cmd of node.commands) {
        if (cmd.type === 'quest') qcmds.push(cmd.command);
        if (cmd.type === 'world' && cmd.command.kind === 'party-buff' && cmd.command.buff === 'story-trap') trap = true;
      }
    }
    scriptQuestCommands.set(sid, qcmds);
    scriptHasTrap.set(sid, trap);
  }
  const eventsCompletingQuest = new Map<string, StoryEvent[]>();
  const eventsReadyingQuest = new Map<string, StoryEvent[]>();
  const eventsAcceptingQuest = new Map<string, StoryEvent[]>();
  const push = (map: Map<string, StoryEvent[]>, qid: string, ev: StoryEvent) => {
    const list = map.get(qid) ?? [];
    if (!list.includes(ev)) list.push(ev);
    map.set(qid, list);
  };
  for (const ev of campaign.events) {
    const direct = scriptQuestCommands.get(ev.script) ?? [];
    const viaChoice: Extract<StoryCommand, { type: 'quest' }>['command'][] = [];
    for (const node of campaign.scripts[ev.script]?.nodes ?? []) {
      if (node.exit.type === 'choice') {
        for (const opt of Object.keys(node.exit.cases)) {
          for (const cev of choiceEvents.get(`${node.exit.choice}=${opt}`) ?? []) {
            viaChoice.push(...(scriptQuestCommands.get(cev.script) ?? []));
          }
        }
      }
    }
    for (const qc of [...direct, ...viaChoice]) {
      if ('quest' in qc) {
        if (qc.type === 'complete' || qc.type === 'script-complete') push(eventsCompletingQuest, qc.quest, ev);
        else if (qc.type === 'script-ready') push(eventsReadyingQuest, qc.quest, ev);
        else if (qc.type === 'accept') push(eventsAcceptingQuest, qc.quest, ev);
      }
    }
  }
  const built: CampaignIndexes = {
    questById,
    groupKindByQuest,
    choiceEvents,
    scriptQuestCommands,
    scriptHasTrap,
    eventsCompletingQuest,
    eventsReadyingQuest,
    eventsAcceptingQuest,
  };
  indexCache.set(campaign, built);
  return built;
}

const flushTurn = () => new Promise<void>(resolve => setImmediate(resolve));

/**
 * 纯状态机任务闭环底座：不加载 Phaser、不模拟小人寻路跑图，
 * 直接连接真实 Session + StoryDirector + GameUI + 正式格式 1 存读档。
 */
export function createQuestE2EHarness(content: QuestHarnessContent, options: QuestHarnessOptions = {}) {
  const indexes = buildCampaignIndexes(content.campaign);
  const validateStages = options.validateStages ?? true;
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
    toasts: [] as string[],
    shopsOpened: [] as string[],
    servicesOpened: [] as string[],
    eventsCompleted: [] as string[],
    skipPhases: [] as string[],
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

  let stage: StoryStageSnapshot | undefined;
  const scenes = new Map<string, SceneSnapshot>();
  const committedScenes = new Map<string, SceneSnapshot>();
  const remember = () => {
    if (stage) scenes.set(stage.map, structuredClone(stage.scene));
  };

  const currentMapObj = (): WorldMap => {
    const mapId = session.storyWorld.currentLocation?.map ?? content.campaign.start.map;
    const found = content.maps.get(mapId);
    assert.ok(found, `地图不存在：${mapId}`);
    return found;
  };

  const captureScene = (declaration?: StoryStage): SceneSnapshot => {
    const location = session.storyWorld.currentLocation ?? { ...content.campaign.start, facing: 'south' as const };
    const mapId = declaration && !declaration.mapFromWorld ? declaration.map : location.map;
    const map = content.maps.get(mapId);
    assert.ok(map, `舞台地图不存在：${mapId}`);
    const player = mapId === location.map ? location : declaration!;
    return prepareSceneVisit(
      { session, campaign: content.campaign, world: content.world, battleCatalog: content.battle, drops: content.drops, springs: content.springs },
      map,
      { id: 'player', actor: content.campaign.start.actor, x: player.x, y: player.y, facing: player.facing, visible: true },
      () => 0.5,
    );
  };

  const resolveStage = (declaration: StoryStage): StoryStageSnapshot => {
    remember();
    const sameMap = stage && (declaration.mapFromWorld || declaration.map === stage.map) && !declaration.resetActors;
    const mapId = declaration.mapFromWorld ? stage?.map ?? session.storyWorld.currentLocation?.map ?? content.campaign.start.map : declaration.map;
    const scene = sameMap
      ? stage!.scene
      : !declaration.resetActors && scenes.has(mapId)
        ? scenes.get(mapId)!
        : captureScene(declaration);
    if (!committedScenes.has(mapId) || declaration.resetActors) committedScenes.set(mapId, structuredClone(scene));
    return resolveStoryScene(declaration, scene);
  };

  const fastPresentation: StoryPresentationPort = {
    begin() {},
    async execute(action) {
      await options.onStageAction?.(action);
    },
    async restoreStage() {},
    getStageState: () => undefined,
    getWorldChanges: () => [],
    committed() {},
    async finish() {},
    async flushStage() {},
    release() {},
  };

  const presentation: StoryPresentationPort = !validateStages ? fastPresentation : {
    begin(_signal, restored) {
      stage = undefined;
      scenes.clear();
      committedScenes.clear();
      const loc = session.storyWorld.currentLocation ?? { ...content.campaign.start, facing: 'south' as const };
      stage = restored && 'scene' in restored
        ? structuredClone(restored)
        : resolveStage(restored ?? { type: 'stage', ...loc, playerVisible: true, cast: [] });
      remember();
      committedScenes.set(stage.map, structuredClone(stage.scene));
      if (validateStages) {
        assertUniqueActorInstances(stage.scene.actors, `舞台 ${stage.map}/begin`);
        assertScenePlan(planScene(stage.scene, stage.bindings));
      }
    },
    async execute(action, _playback, pendingEntrances) {
      await options.onStageAction?.(action);
      if (action.type === 'stage') {
        stage = resolveStage(action);
        if (pendingEntrances?.length) stage = hidePendingEntrances(stage, action, pendingEntrances);
      } else if (stage) {
        stage = applyStorySceneAction(stage, action);
      }
      if (stage && validateStages) {
        assertUniqueActorInstances(stage.scene.actors, `舞台 ${stage.map}/${action.type}`);
        assertScenePlan(planScene(stage.scene, stage.bindings));
      }
    },
    async restoreStage(saved) {
      stage = structuredClone(saved);
      scenes.clear();
      for (const s of saved.scenes ?? []) scenes.set(s.map, structuredClone(s));
      scenes.set(saved.map, structuredClone(saved.scene));
      committedScenes.clear();
      for (const [m, s] of scenes) committedScenes.set(m, structuredClone(s));
      if (validateStages) {
        assertUniqueActorInstances(stage.scene.actors, `舞台 ${stage.map}/restore`);
        assertScenePlan(planScene(stage.scene, stage.bindings));
      }
    },
    getStageState() {
      return stage ? structuredClone(stage) : undefined;
    },
    getWorldChanges() {
      remember();
      return [...scenes].flatMap(([map, scene]) =>
        scene.actors.flatMap(actor => {
          if (!actor.worldEntityId || actor.unpositioned || actor.stageHidden) return [];
          const previous = committedScenes.get(map)?.actors.find(value => value.id === actor.id);
          if (
            previous &&
            previous.worldEntityId === actor.worldEntityId &&
            previous.actor === actor.actor &&
            previous.x === actor.x &&
            previous.y === actor.y &&
            previous.facing === actor.facing &&
            previous.visible === actor.visible
          ) {
            return [];
          }
          return [
            {
              id: actor.worldEntityId,
              map,
              actor: actor.actor,
              characterId: actor.characterId,
              x: actor.x,
              y: actor.y,
              facing: actor.facing,
              visible: actor.visible,
            },
          ];
        }),
      );
    },
    committed() {
      remember();
      committedScenes.clear();
      for (const [m, s] of scenes) committedScenes.set(m, structuredClone(s));
    },
    async finish() {},
    async flushStage() {},
    release() {
      stage = undefined;
      scenes.clear();
      committedScenes.clear();
    },
  };

  let worldBaseline: { location?: TravelDestination } = {};
  const worldPort: StoryWorldPort = {
    capture: () => ({ location: session.storyWorld.currentLocation ? { ...session.storyWorld.currentLocation } : undefined }),
    restore: async snapshot => {
      worldBaseline = (snapshot as typeof worldBaseline) ?? {};
      if (worldBaseline.location) {
        session.storyWorld.apply({ kind: 'travel', destination: worldBaseline.location });
      }
    },
    project: async () => {
      const loc = session.storyWorld.currentLocation;
      if (loc && content.maps.has(loc.map)) {
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
          await options.onPopupOpen?.(currentPopup.kind, currentPopup.definition, currentPopup.reward, ui);
          if (pausePopupKind === 'any' || pausePopupKind === currentPopup.kind) {
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

  const rawToast = ui.toast.bind(ui);
  ui.toast = (message: string) => {
    log.toasts.push(message);
    rawToast(message);
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

  /** 当前地图可见实体列表（合并地图自带静态实体与剧情摆放）。 */
  const visibleEntities = (mapId?: string): EntityPlacement[] => {
    const map = mapId ? content.maps.get(mapId)! : currentMapObj();
    const authored = authoredPlacements(map, content.campaign);
    const base = baseMapEntities(map, content.campaign, entity => session.visible(entity));
    return session.storyWorld
      .projectEntities(map.id, [...base, ...authored], content.campaign.placements)
      .filter(
        entity =>
          session.storyWorld.visible(entity.id) &&
          (!('condition' in entity) || session.evaluateCondition(entity.condition as StoryCondition)),
      );
  };

  /** 在指定地图或全图配置中解析某个角色实体（传入 characterId 时严格优先匹配该角色实例，避免同外观不同编号 NPC 串槽）。 */
  const locateEntity = (actorOrCharId: string, characterId?: string): { mapId: string; entity: EntityPlacement; actor: ActorDefinition } => {
    const searchWith = (pred: (e: EntityPlacement) => boolean): { mapId: string; entity: EntityPlacement; actor: ActorDefinition } | undefined => {
      const currentId = session.storyWorld.currentLocation?.map ?? content.campaign.start.map;
      const onCurrent = visibleEntities(currentId).find(pred);
      if (onCurrent) {
        return { mapId: currentId, entity: onCurrent, actor: content.world.actors[onCurrent.actor]! };
      }
      for (const p of content.campaign.placements) {
        if (pred(p) && (!p.condition || session.evaluateCondition(p.condition))) {
          return { mapId: p.map, entity: p, actor: content.world.actors[p.actor]! };
        }
      }
      for (const p of content.campaign.mapEntryPlacements ?? []) {
        if (pred(p) && (!p.condition || session.evaluateCondition(p.condition))) {
          return { mapId: p.map, entity: { id: p.id, actor: p.actor, characterId: p.characterId, x: p.x, y: p.y }, actor: content.world.actors[p.actor]! };
        }
      }
      for (const m of content.maps.values()) {
        const hit = m.entities.find(pred);
        if (hit) return { mapId: m.id, entity: hit, actor: content.world.actors[hit.actor]! };
      }
      for (const p of content.campaign.placements) {
        if (pred(p)) return { mapId: p.map, entity: p, actor: content.world.actors[p.actor]! };
      }
      return undefined;
    };

    if (characterId) {
      const byChar = searchWith(e => e.characterId === characterId);
      if (byChar) return byChar;
    }
    const byActor = searchWith(e => e.actor === actorOrCharId || e.characterId === actorOrCharId || e.id === actorOrCharId);
    if (byActor) return byActor;

    const currentId = session.storyWorld.currentLocation?.map ?? content.campaign.start.map;
    const actorDef = content.world.actors[actorOrCharId];
    assert.ok(actorDef, `找不到交互角色定义：${actorOrCharId} (${characterId ?? ''})`);
    return {
      mapId: currentId,
      entity: { id: `synthetic:${characterId ?? actorOrCharId}`, actor: actorOrCharId, characterId, x: 64, y: 64 },
      actor: actorDef,
    };
  };

  const setCurrentMap = (mapId: string, x = 64, y = 64) => {
    if (session.storyWorld.currentLocation?.map === mapId) return;
    const map = content.maps.get(mapId);
    assert.ok(map, `切换目标地图不存在：${mapId}`);
    session.applyStoryCommands([{ type: 'travel', destination: { map: mapId, x, y, facing: 'south' } }]);
    session.enterMap(map.id, map.questItemSpawns ?? [], map, map.enemySpawns);
  };

  /** 通过真实 resolveInteraction + StoryDirector.interact 执行一次角色/机关交互。 */
  const interactWithEntity = async (entity: EntityPlacement, mapId?: string): Promise<string> => {
    if (mapId) setCurrentMap(mapId, entity.x, entity.y);
    const actor = content.world.actors[entity.actor];
    assert.ok(actor, `角色定义缺失：${entity.actor}`);
    const questInSlot = session.npcQuestSlot(entity.actor, entity.characterId);
    const questSlot = !!questInSlot && ['available', 'ready'].includes(session.status(questInSlot.id));
    const hasShop = content.shopActors?.has(entity.actor) ?? false;
    const action = resolveInteraction({
      chest: false,
      spring: false,
      service: actor.service,
      objective: !!entity.objective && session.canInteract(entity.objective, entity.id),
      questSlot,
      shop: hasShop,
    });
    if (action.kind === 'shop') {
      log.shopsOpened.push(entity.actor);
      return 'shop';
    }
    if (action.kind !== 'story') {
      log.servicesOpened.push(`${action.kind}:${entity.actor}`);
      return action.kind;
    }
    await director.interact(entity, actor);
    await settle();
    return 'story';
  };

  const interactByIdentity = async (actorOrCharId: string, characterId?: string): Promise<string> => {
    const located = locateEntity(actorOrCharId, characterId);
    return interactWithEntity(located.entity, located.mapId);
  };

  /** 结算当前活跃剧情遭遇（击败遭遇生成的全部怪物并上报遭遇胜利）。 */
  const settleActiveEncounters = async (): Promise<void> => {
    let guard = 0;
    while (session.storyWorld.activeEncounters.length > 0 && guard++ < 20) {
      const enc = session.storyWorld.activeEncounters[0]!;
      setCurrentMap(enc.map);
      const map = currentMapObj();
      const roster = new WorldEnemyRoster(session, map, [], session.hero?.level ?? 1, questEnemies);

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

        const spawnSource = roster.source(key) ?? { id: key, enemyId: sp.enemyId, x: sp.x, y: sp.y, respawn: false };
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

  /** 按事件自身的触发源触发一次真实事件派发，并自动结清其衍生的剧情遭遇。 */
  const fireStoryEvent = async (event: StoryEvent): Promise<boolean> => {
    const spot =
      event.place?.type === 'fixed'
        ? event.place
        : event.place?.type === 'alternatives'
          ? event.place.spots[0]
          : undefined;
    const mapId = event.map ?? spot?.map ?? session.storyWorld.currentLocation?.map ?? content.campaign.start.map;
    setCurrentMap(mapId, spot?.x ?? 64, spot?.y ?? 64);

    let fired = false;
    switch (event.source) {
      case 'start':
        fired = await director.start();
        break;
      case 'region':
        fired = await director.enterRegion(event.id, mapId);
        break;
      case 'map-entry':
        fired = await director.enterMap(event.key ?? mapId);
        break;
      case 'near': {
        const actorKey = event.near!;
        const entity: EntityPlacement = {
          id: event.entity ?? `near:${event.id}`,
          actor: actorKey,
          characterId: event.nearCharacterId,
          x: spot?.x ?? 64,
          y: spot?.y ?? 64,
        };
        fired = await director.approach(event, entity, mapId);
        break;
      }
      case 'interaction': {
        const located = locateEntity(event.key ?? '');
        fired = await director.interact(located.entity, located.actor);
        break;
      }
      case 'battle': {
        const key = event.key ?? '';
        if (key.startsWith('health-below-30:')) {
          const enemyId = key.slice('health-below-30:'.length);
          fired = director.healthChanged(enemyId, 100, 25, 100, { id: `boss:${enemyId}`, map: mapId, x: 64, y: 64 });
        } else if (key.startsWith('defeat:')) {
          const enemyId = key.slice('defeat:'.length);
          const enemyDef = content.battle.enemies.find(e => e.id === enemyId)!;
          const res = session.settleEnemyDefeat({
            key: `battle:${event.id}:${enemyId}`,
            spawn: { id: `battle:${event.id}:${enemyId}`, enemyId, x: 64, y: 64 },
            enemy: enemyDef,
            map: mapId,
            x: 64,
            y: 64,
            lootLevel: 1,
            enemyLevel: enemyDef?.level ?? 1,
            elite: false,
            earnsExperience: true,
            pressureMode: false,
            drops: content.drops,
            stats: content.stats,
            random: () => 0,
            landing: (lx, ly) => ({ x: lx, y: ly }),
          });
          res?.notify();
          fired = true;
        } else {
          fired = await director.notify('battle', key, mapId);
        }
        break;
      }
      case 'quest':
      case 'inventory':
      case 'event':
      case 'choice':
        fired = await director.notify(event.source, event.key, mapId);
        break;
    }
    await settle();
    await settleActiveEncounters();
    return fired;
  };

  /** 拾取当前地图地面战利品进背包。 */
  const collectAllGroundLootOnMap = (mapId: string): number => {
    const store = groundLootFor(session);
    let collectedCount = 0;
    for (const drop of [...store.forMap(mapId)]) {
      const picked = store.collectNearby(mapId, drop.x, drop.y, reward => {
        if (reward.kind === 'money') {
          session.gainMoney(reward.amount);
          return;
        }
        if (reward.instance) session.bag.receiveDrop(reward.instance);
        else session.bag.add(reward.item, reward.quantity);
      });
      if (picked.length > 0) {
        collectedCount += picked.length;
        session.questItemGenerators.collected(
          picked.map(d => d.id),
          session.combatTick,
        );
      }
    }
    if (collectedCount > 0) session.emit();
    return collectedCount;
  };

  /** 按任务自身的 goals 与 targetChanges 喂入真实领域事实，不作弊改任务簿计数。 */
  const fulfillQuestGoals = async (quest: CampaignQuest): Promise<void> => {
    const prevTarget = targetQuestId;
    targetQuestId = quest.id;
    try {
      await settleActiveEncounters();
      for (const goal of quest.goals) {
        const currentCount = () => session.quests.get(quest.id)?.goals[goal.id] ?? 0;
        if (goal.kind === 'defeat') {
          const change = (quest.targetChanges ?? []).find(c => c.goal === goal.id && c.enemyId === goal.target);
          const mapId =
            quest.places?.active?.type === 'fixed'
              ? quest.places.active.map
              : quest.places?.active?.type === 'alternatives'
                ? quest.places.active.spots[0]?.map ?? currentMapObj().id
                : currentMapObj().id;
          setCurrentMap(mapId);
          const enemyDef = content.battle.enemies.find(e => e.id === goal.target);
          assert.ok(enemyDef, `任务 ${quest.id} 击杀目标敌人不存在：${goal.target}`);

          let seq = 0;
          while (currentCount() < goal.quantity && session.status(quest.id) === 'active') {
            seq++;
            assert.ok(seq <= goal.quantity + 5, `任务 ${quest.id} 击杀目标未推进：${goal.target}`);
            const spawnId = `e2e:${quest.id}:${goal.id}:${seq}`;
            if (change) {
              const weakened = session.weakenQuestTarget(goal.target, { id: spawnId, map: mapId, x: 80, y: 80 });
              assert.equal(weakened, true, `任务 ${quest.id} 残血变身捕捉未生效：${goal.target}`);
              const capturedEntity = visibleEntities(mapId).find(e => e.id === `quest-target:${spawnId}`);
              assert.ok(capturedEntity, `任务 ${quest.id} 未生成捕捉目标实体`);
              await interactWithEntity(capturedEntity, mapId);
            } else {
              const res = session.settleEnemyDefeat({
                key: spawnId,
                spawn: { id: spawnId, enemyId: goal.target, x: 80, y: 80 },
                enemy: enemyDef,
                map: mapId,
                x: 80,
                y: 80,
                lootLevel: currentMapObj().lootLevel ?? 1,
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
              collectAllGroundLootOnMap(mapId);
              await settle();
              await settleActiveEncounters();
            }
          }
        } else if (goal.kind === 'item') {
          const mapId =
            quest.places?.active?.type === 'fixed'
              ? quest.places.active.map
              : quest.places?.active?.type === 'alternatives'
                ? quest.places.active.spots[0]?.map ?? currentMapObj().id
                : currentMapObj().id;
          setCurrentMap(mapId);

          // 优先尝试从掉落该任务物品的真实怪物结算掉落并拾取；若是地图采集物/剧情物则经地面战利品拾取入包。
          const dropperEntry = Object.entries(content.drops.questItems).find(([, entries]) =>
            entries.some(d => d.item === goal.target),
          );
          let guard = 0;
          while (session.itemCount(goal.target) < goal.quantity && guard++ < goal.quantity + 10) {
            if (dropperEntry) {
              const [enemyId] = dropperEntry;
              const enemyDef = content.battle.enemies.find(e => e.id === enemyId);
              if (enemyDef) {
                const spawnId = `e2e:drop:${quest.id}:${goal.id}:${guard}`;
                const res = session.settleEnemyDefeat({
                  key: spawnId,
                  spawn: { id: spawnId, enemyId, x: 96, y: 96 },
                  enemy: enemyDef,
                  map: mapId,
                  x: 96,
                  y: 96,
                  lootLevel: currentMapObj().lootLevel ?? 1,
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
                collectAllGroundLootOnMap(mapId);
                await settle();
                continue;
              }
            }
            const missing = goal.quantity - session.itemCount(goal.target);
            session.placeGroundRewards(
              mapId,
              96,
              96,
              Array.from({ length: missing }, () => ({ kind: 'item' as const, item: goal.target, quantity: 1 as const })),
            );
            collectAllGroundLootOnMap(mapId);
            await settle();
          }
        } else if (goal.kind === 'interact' || goal.kind === 'talk') {
          const captureChange = (quest.targetChanges ?? []).find(c => c.goal === goal.id && c.actor === goal.target);
          let guard = 0;
          while (currentCount() < goal.quantity && session.status(quest.id) === 'active' && guard++ < goal.quantity + 5) {
            if (captureChange) {
              const mapId = currentMapObj().id;
              const spawnId = `e2e:capture:${quest.id}:${goal.id}:${guard}`;
              const captured = director.healthChanged(captureChange.enemyId, 100, 25, 100, {
                id: spawnId,
                map: mapId,
                x: 80,
                y: 80,
              });
              assert.equal(captured, true, `任务 ${quest.id} 残血变身捕捉未生效：${captureChange.enemyId}`);
              await settle();
              const capturedEntity = visibleEntities(mapId).find(e => e.id === `quest-target:${spawnId}`);
              assert.ok(capturedEntity, `任务 ${quest.id} 未生成捕捉目标实体`);
              await interactWithEntity(capturedEntity, mapId);
              await settleActiveEncounters();
              continue;
            }
            const located = locateEntity(goal.target, goal.characterId);
            const entity: EntityPlacement =
              goal.kind === 'interact' && !located.entity.objective
                ? { ...located.entity, id: `e2e:interact:${quest.id}:${goal.id}:${guard}` }
                : { ...located.entity, id: `${located.entity.id}:${guard}` };
            await director.interact(entity, located.actor);
            await settle();
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
      for (const req of quest.handoverItems ?? []) {
        const missing = req.quantity - session.itemCount(req.item);
        if (missing > 0) {
          const mapId = currentMapObj().id;
          session.placeGroundRewards(
            mapId,
            96,
            96,
            Array.from({ length: missing }, () => ({ kind: 'item' as const, item: req.item, quantity: 1 as const })),
          );
          collectAllGroundLootOnMap(mapId);
          await settle();
        }
      }
    } finally {
      targetQuestId = prevTarget;
    }
  };

  /** 与任务发布者持续交互，自动跨过同一 NPC 身上排在前面的其他槽位任务，直到目标任务接取成功。 */
  const admitViaGiver = async (quest: CampaignQuest): Promise<void> => {
    assert.ok(quest.giver, `任务 ${quest.id} 没有 giver`);
    let attempts = 0;
    while (session.status(quest.id) === 'available' && attempts++ < 8) {
      const slot = session.npcQuestSlot(quest.giver, quest.giverCharacterId);
      if (slot && slot.id !== quest.id && session.status(slot.id) === 'ready' && slot.interactionEvent) {
        session.applyStoryCommands([{ type: 'quest', command: { type: 'script-complete', quest: slot.id } }]);
        await settle();
        continue;
      }
      await interactByIdentity(quest.giver, quest.giverCharacterId);
      await settleActiveEncounters();
    }
  };
  /** 按因果前置推导初始化单任务独立起点，再走真实接取入口使任务激活。 */
  const prepareAndAdmitQuest = async (questId: string): Promise<CampaignQuest> => {
    const quest = indexes.questById.get(questId);
    assert.ok(quest, `未知任务：${questId}`);
    targetQuestId = questId;
    phaseMode = quest.interactionEvent ? 'admit' : 'complete';

    log.dialogues.length = 0;
    log.popups.length = 0;
    log.instants.length = 0;
    log.toasts.length = 0;
    log.shopsOpened.length = 0;
    log.servicesOpened.length = 0;
    log.eventsCompleted.length = 0;
    log.skipPhases.length = 0;
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
    const startCycles = session.questBook.completedCycles(questId);
    director.runtime.restore(session.runtimeState);
    if (plan.destination) {
      setCurrentMap(plan.destination.map, plan.destination.x, plan.destination.y);
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

    if (plan.accept?.eventId) {
      const ev = content.campaign.events.find(e => e.id === plan.accept!.eventId);
      assert.ok(ev, `接取事件不存在：${plan.accept.eventId}`);
      await director.trigger({ id: ev.id, script: ev.script });
      await settle();
      await settleActiveEncounters();
    } else if (plan.accept?.script) {
      await director.script(plan.accept.script);
      await settle();
      await settleActiveEncounters();
    } else if (quest.giver) {
      await admitViaGiver(quest);
    } else {
      const ev = (indexes.eventsAcceptingQuest.get(questId) ?? [])[0];
      assert.ok(ev, `任务 ${questId} 没有任何可用接取途径`);
      await director.trigger({ id: ev.id, script: ev.script });
      await settle();
      await settleActiveEncounters();
    }

    phaseMode = 'complete';
    assert.ok(
      ['active', 'ready', 'completed'].includes(session.status(questId)) || session.questBook.completedCycles(questId) > startCycles,
      `任务 ${questId}（${quest.title}）接取后未进入进行中或完成态，当前为 ${session.status(questId)}`,
    );
    return quest;
  };

  /** 递归满足某个完成事件所需的同组/子任务与前置事件条件（零硬编码驱动复合完成事件）。 */
  const satisfyEventCondition = async (
    cond: StoryCondition | undefined,
    visitedQuests: Set<string>,
    visitedEvents = new Set<string>(),
  ): Promise<void> => {
    if (!cond || session.evaluateCondition(cond)) return;
    const condJson = JSON.stringify(cond);
    const refs = storyConditionReferences(cond);
    for (const flag of refs.flags) {
      if (condJson.includes(`"flag":"${flag}","value":false`)) {
        session.applyStoryCommands([{ type: 'flag', flag, value: false }]);
      } else if (!session.storyWorld.hasFlag(flag)) {
        session.applyStoryCommands([{ type: 'flag', flag, value: true }]);
      }
    }
    if (session.evaluateCondition(cond)) {
      await settle();
      return;
    }
    for (const depEventId of refs.events) {
      if (visitedEvents.has(depEventId)) continue;
      visitedEvents.add(depEventId);
      if (director.runtime.eventStatus(depEventId) === 'completed') continue;
      const depEv = content.campaign.events.find(e => e.id === depEventId);
      if (!depEv) continue;
      await satisfyEventCondition(depEv.condition, visitedQuests, visitedEvents);
      if (director.runtime.eventStatus(depEventId) !== 'completed') {
        await fireStoryEvent(depEv);
      }
      if (session.evaluateCondition(cond)) return;
    }
    for (const depQuestId of refs.quests) {
      if (visitedQuests.has(depQuestId)) continue;
      visitedQuests.add(depQuestId);
      const depQuest = indexes.questById.get(depQuestId);
      if (!depQuest) continue;

      const wantsActiveOrReady =
        condJson.includes(`"quest":"${depQuestId}","status":"ready"`) ||
        condJson.includes(`"quest":"${depQuestId}","status":"active"`);

      // 若条件要求某个轮回子任务处于 active/ready，而它此前已完成过，重置并重接一轮
      if (session.status(depQuestId) === 'completed' && wantsActiveOrReady) {
        session.applyStoryCommands([
          { type: 'quest', command: { type: 'reset', quest: depQuestId } },
          { type: 'quest', command: { type: 'accept', quest: depQuestId } },
        ]);
        await settle();
      }

      if (session.status(depQuestId) === 'locked' && !wantsActiveOrReady) {
        session.applyStoryCommands([{ type: 'quest', command: { type: 'script-complete', quest: depQuestId } }]);
        await settle();
        await settleActiveEncounters();
        if (session.evaluateCondition(cond)) return;
      }

      if (session.status(depQuestId) === 'locked') {
        await satisfyEventCondition(depQuest.availableWhen, visitedQuests, visitedEvents);
        if (session.status(depQuestId) === 'locked') {
          session.questBook.forceAvailable(depQuestId, true);
        }
      }

      if (session.status(depQuestId) === 'available') {
        const accEv = (indexes.eventsAcceptingQuest.get(depQuestId) ?? []).find(
          e => !e.condition || session.evaluateCondition(e.condition),
        );
        if (accEv) await fireStoryEvent(accEv);
        else if (depQuest.giver) {
          await interactByIdentity(depQuest.giver, depQuest.giverCharacterId);
        } else {
          session.applyStoryCommands([{ type: 'quest', command: { type: 'accept', quest: depQuestId } }]);
          await settle();
        }
      }
      if (session.status(depQuestId) === 'active') {
        await fulfillQuestGoals(depQuest);
        const readyEv = (indexes.eventsReadyingQuest.get(depQuestId) ?? [])[0];
        if (readyEv && session.status(depQuestId) === 'active') await fireStoryEvent(readyEv);
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

      if (session.status(quest.id) === 'active' && quest.goals.length > 0) {
        await fulfillQuestGoals(quest);
      }
      if (hasSettledThisCycle()) {
        return 'completed';
      }

      const readyEvs = indexes.eventsReadyingQuest.get(quest.id) ?? [];
      for (const rev of readyEvs) {
        if (session.status(quest.id) !== 'active') break;
        await satisfyEventCondition(rev.condition, visitedQuests);
        await fireStoryEvent(rev);
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

      if (quest.interactionEvent) {
        const gateEv = content.campaign.events.find(e => e.id === quest.interactionEvent);
        assert.ok(gateEv, `任务 ${quest.id} 的 interactionEvent 不存在：${quest.interactionEvent}`);
        if (quest.delivery) {
          await interactByIdentity(quest.delivery, quest.deliveryCharacterId);
        } else {
          await fireStoryEvent(gateEv);
        }
        await settleActiveEncounters();
      } else if (quest.delivery && (quest.completion !== 'story' || !!quest.completeScript)) {
        assert.equal(session.status(quest.id), 'ready', `任务 ${quest.id}（${quest.title}）交付前未就绪`);
        let followupEventsBefore = 0;
        let checkedPopupHold = false;
        const prevHook = options.onPopupOpen;
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
          await interactByIdentity(quest.delivery, quest.deliveryCharacterId);
          await settleActiveEncounters();
          if (quest.journal !== false && !quest.completeScript) {
            assert.equal(checkedPopupHold, true, `日志内任务 ${quest.id} 交付时未弹出完成奖励窗口`);
          }
        } finally {
          options.onPopupOpen = prevHook;
        }
      } else {
        for (const cev of compEvs) {
          if (hasSettledThisCycle()) break;
          await satisfyEventCondition(cev.condition, visitedQuests);
          if (hasSettledThisCycle()) break;
          if (cev.source === 'choice') {
            const m = JSON.stringify(cev.condition ?? {}).match(/"choice":"([^"]+)"/);
            const parent = m
              ? content.campaign.events.find(pe =>
                  content.campaign.scripts[pe.script]?.nodes.some(n => n.exit.type === 'choice' && n.exit.choice === m[1]),
                )
              : undefined;
            if (parent) {
              await satisfyEventCondition(parent.condition, visitedQuests);
              await fireStoryEvent(parent);
            } else {
              await fireStoryEvent(cev);
            }
          } else {
            await fireStoryEvent(cev);
          }
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
    return { record, restored: createQuestE2EHarness(content, { ...nextOptions, classId: chosenClass.id, saved: record }) };
  };

  return {
    content,
    indexes,
    session,
    director,
    ui,
    log,
    get triggerContacts() {
      return triggerContacts;
    },
    setTriggerContacts(next: { regions: string[]; characters: string[]; nearEvents: string[] }) {
      triggerContacts = structuredClone(next);
    },
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
    setCurrentMap,
    visibleEntities,
    locateEntity,
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

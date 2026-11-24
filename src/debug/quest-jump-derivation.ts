import type { Campaign, CampaignQuest } from '../domain/campaign.ts';
import type { Facing, QuestStatus, TravelDestination } from '../domain/content.ts';
import { evaluateStoryCondition, type StoryCondition } from '../domain/story-condition.ts';
import { storyExitTargets, type StoryCommand, type StoryEvent, type StoryNode, type StoryNodeRef, type StoryScript } from '../domain/story-graph.ts';
import type { StoryWorldCommand } from '../domain/story-world.ts';

export type QuestJumpMode = 'available' | 'active' | 'ready';

export interface ReplayedPlacement {
  characterId?: string;
  actor?: string;
  entityId: string;
  map: string;
  x: number;
  y: number;
  facing?: Facing;
}

export interface DerivedHistory {
  intake: { event?: string; script?: string };
  progress: Map<string, QuestStatus>;
  completedQuests: Set<string>;
  completedEvents: Set<string>;
  choices: Map<string, string>;
  items: Map<string, number>;
  world: StoryCommand[];
  intakeCommands: StoryCommand[];
  stageMap: string;
  destination?: TravelDestination;
  placements: ReplayedPlacement[];
  warnings: string[];
}

interface Producer {
  kind: 'event' | 'script' | 'synth';
  event?: StoryEvent;
  script?: string;
  after?: string;
}

interface EventInfo {
  event: StoryEvent;
  index: number;
  commands: StoryCommand[];
  hasQuestCommands: boolean;
}

interface ChoiceWriter {
  eventId: string;
  values: string[];
}

interface ContentIndex {
  quests: Map<string, CampaignQuest>;
  events: Map<string, EventInfo>;
  eventOrder: EventInfo[];
  nodes: Map<string, Map<string, StoryNode>>;
  acceptors: Map<string, Producer[]>;
  completers: Map<string, Producer[]>;
  readyProducers: Map<string, Producer[]>;
  choiceWriters: Map<string, ChoiceWriter[]>;
  startEvents: StoryEvent[];
  itemIds: Set<string>;
  companions: Set<string>;
  equipmentCleanup: Map<string, StoryCommand>;
}

interface PlanNode {
  id: string;
  kind: 'event' | 'script' | 'accept' | 'ready' | 'deliver';
  order: number;
  event?: StoryEvent;
  script?: string;
  quest?: string;
  optional: boolean;
  deps: Set<string>;
}

interface StageLanding {
  map: string;
  x: number;
  y: number;
  facing: Facing;
}

interface HistoryState {
  status: Map<string, QuestStatus>;
  opened: Set<string>;
  ready: Set<string>;
  delivered: Set<string>;
  completedEvents: Set<string>;
  choices: Map<string, string>;
  flags: Map<string, boolean>;
  items: Map<string, number>;
  world: StoryCommand[];
  currentMap: string;
  placements: Map<string, ReplayedPlacement>;
  warnings: string[];
}

const SOURCE_RANK: Record<string, number> = {
  quest: 0, region: 1, near: 2, interaction: 3, choice: 4,
  'map-entry': 5, battle: 6, inventory: 7, event: 8, start: 9,
};

const MAX_WALK_NODES = 4096;

const indexes = new WeakMap<Campaign, ContentIndex>();

function indexFor(campaign: Campaign): ContentIndex {
  const cached = indexes.get(campaign);
  if (cached) return cached;
  const index = buildIndex(campaign);
  indexes.set(campaign, index);
  return index;
}

function buildIndex(campaign: Campaign): ContentIndex {
  const quests = new Map(campaign.quests.map(quest => [quest.id, quest]));
  const nodes = new Map(Object.entries(campaign.scripts).map(([name, script]) =>
    [name, new Map(script.nodes.map(node => [node.id, node]))]));
  const commandCache = new Map<string, StoryCommand[]>();
  const commandsFor = (script: string): StoryCommand[] => {
    const cached = commandCache.get(script);
    if (cached) return cached;
    const commands = reachableCommands(campaign.scripts, nodes, script);
    commandCache.set(script, commands);
    return commands;
  };

  const events = new Map<string, EventInfo>();
  const eventOrder: EventInfo[] = [];
  campaign.events.forEach((event, order) => {
    const commands = commandsFor(event.script);
    const info: EventInfo = {
      event, index: order, commands,
      hasQuestCommands: commands.some(command => command.type === 'quest'),
    };
    events.set(event.id, info);
    eventOrder.push(info);
  });

  const eventScripts = new Set(campaign.events.map(event => event.script));
  const acceptors = new Map<string, Producer[]>();
  const completers = new Map<string, Producer[]>();
  const readyProducers = new Map<string, Producer[]>();
  const choiceWriters = new Map<string, ChoiceWriter[]>();

  for (const info of eventOrder) {
    for (const command of info.commands) {
      if (command.type === 'quest' && 'quest' in command.command) {
        const id = command.command.quest;
        if (command.command.type === 'accept'
          && !conditionRequiresQuest(info.event.condition, id)) pushMap(acceptors, id, { kind: 'event', event: info.event });
        if ((command.command.type === 'complete' || command.command.type === 'script-complete')
          && !conditionRequiresQuest(info.event.condition, id, new Set(['completed', 'settled'])))
          pushMap(completers, id, { kind: 'event', event: info.event });
        if (command.command.type === 'script-ready') pushMap(readyProducers, id, { kind: 'event', event: info.event });
      }
    }
    const writers = new Map<string, string[]>();
    for (const node of campaign.scripts[info.event.script].nodes) {
      if (node.exit.type === 'choice') for (const value of Object.keys(node.exit.cases))
        pushMap(writers, node.exit.choice, value);
      for (const command of node.commands)
        if (command.type === 'choice') pushMap(writers, command.choice, command.value);
    }
    for (const [choice, values] of writers) pushMap(choiceWriters, choice, { eventId: info.event.id, values });
  }

  for (const script of Object.keys(campaign.scripts)) {
    if (eventScripts.has(script)) continue;
    const commands = commandsFor(script);
    for (const command of commands) {
      if (command.type !== 'quest' || !('quest' in command.command)) continue;
      const id = command.command.quest;
      if (command.command.type === 'accept') pushMap(acceptors, id, { kind: 'script', script, after: nextAfter(script, id) });
      if (command.command.type === 'complete' || command.command.type === 'script-complete')
        pushMap(completers, id, { kind: 'script', script });
      if (command.command.type === 'script-ready') pushMap(readyProducers, id, { kind: 'script', script });
    }
  }

  for (const [id, producers] of acceptors) acceptors.set(id, sortProducers(producers, quests.get(id)));
  for (const [id, producers] of completers) completers.set(id, sortProducers(producers, quests.get(id)));
  for (const [id, producers] of readyProducers) readyProducers.set(id, sortProducers(producers, quests.get(id)));
  for (const [choice, writers] of choiceWriters)
    choiceWriters.set(choice, [...writers].sort((left, right) =>
      (events.get(left.eventId)?.index ?? 0) - (events.get(right.eventId)?.index ?? 0)));

  const itemIds = new Set<string>();
  for (const quest of campaign.quests) {
    for (const entry of [...quest.onAcceptItems ?? [], ...quest.handoverItems ?? []]) itemIds.add(entry.item);
  }
  for (const commands of commandCache.values()) for (const command of commands) {
    if (command.type === 'item-give' || command.type === 'item-take') itemIds.add(command.item);
  }
  const companions = new Set<string>();
  const equipmentCleanup = new Map<string, StoryCommand>();
  for (const commands of commandCache.values()) for (const command of commands) {
    if (command.type === 'party-join' || command.type === 'party-leave') companions.add(command.companion);
    if (command.type === 'equip') equipmentCleanup.set(command.member + '/' + command.item,
      { type: 'unequip-destroy', member: command.member, item: command.item, ifPresent: true });
  }

  return {
    quests, events, eventOrder, nodes,
    acceptors, completers, readyProducers, choiceWriters,
    startEvents: campaign.events.filter(event => event.source === 'start'),
    itemIds, companions, equipmentCleanup,
  };
}

function nextAfter(script: string, questId: string): string | undefined {
  const match = /^next:([^:]+):(.+)$/.exec(script);
  return match?.[2] === questId ? match[1] : undefined;
}

function sortProducers(producers: Producer[], quest: CampaignQuest | undefined): Producer[] {
  return [...producers].sort((left, right) => {
    if (quest?.offerScript) {
      if (left.script === quest.offerScript) return -1;
      if (right.script === quest.offerScript) return 1;
    }
    const leftRank = left.kind === 'event'
      ? SOURCE_RANK[left.event!.source] ?? 99
      : 100 + scriptRank(left.script, quest);
    const rightRank = right.kind === 'event'
      ? SOURCE_RANK[right.event!.source] ?? 99
      : 100 + scriptRank(right.script, quest);
    if (leftRank !== rightRank) return leftRank - rightRank;
    if (left.kind === 'event' && right.kind === 'event')
      return left.event!.id.localeCompare(right.event!.id, undefined, { numeric: true });
    return (left.script ?? '').localeCompare(right.script ?? '');
  });
}

/** `next:A:B` 是接 B 的正式入口；`complete:A` 只是分支里顺带接取。 */
function scriptRank(script: string | undefined, quest: CampaignQuest | undefined): number {
  if (!script) return 9;
  if (quest && script.startsWith('next:') && script.endsWith(':' + quest.id)) return 0;
  if (script.startsWith('next:') || script.startsWith('offer:')) return 1;
  if (script.startsWith('complete:')) return 2;
  return 3;
}

function reachableCommands(scripts: Record<string, StoryScript>,
  nodes: Map<string, Map<string, StoryNode>>, name: string): StoryCommand[] {
  const commands: StoryCommand[] = [];
  const seen = new Set<string>();
  const stack: StoryNodeRef[] = [{ script: name, node: scripts[name].entry }];
  while (stack.length) {
    const cursor = stack.pop()!;
    const key = cursor.script + '/' + cursor.node;
    if (seen.has(key)) continue;
    seen.add(key);
    const node = nodes.get(cursor.script)?.get(cursor.node);
    if (!node) continue;
    commands.push(...node.commands);
    for (const target of storyExitTargets(node.exit)) stack.push(target);
  }
  return commands;
}

function pushMap<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key) ?? [];
  list.push(value);
  map.set(key, list);
}

function conditionRequiresQuest(condition: StoryCondition | undefined, questId: string,
  statuses: Set<string> = new Set(['active', 'ready', 'completed', 'settled'])): boolean {
  let found = false;
  visitCondition(condition, value => {
    if (value.type === 'quest' && value.quest === questId && statuses.has(value.status)) found = true;
  });
  return found;
}

function visitCondition(condition: StoryCondition | undefined, visit: (value: StoryCondition) => void): void {
  if (!condition) return;
  visit(condition);
  switch (condition.type) {
    case 'all': case 'any': condition.conditions.forEach(child => visitCondition(child, visit)); break;
    case 'not': visitCondition(condition.condition, visit); break;
    default: break;
  }
}

function positiveQuestRefs(condition: StoryCondition | undefined, insideNot = false): { quest: string; status: string }[] {
  if (!condition) return [];
  switch (condition.type) {
    case 'all': case 'any': return condition.conditions.flatMap(child => positiveQuestRefs(child, insideNot));
    case 'not': return positiveQuestRefs(condition.condition, true);
    case 'quest': return insideNot ? [] : [{ quest: condition.quest, status: condition.status }];
    default: return [];
  }
}

function eventRefs(condition: StoryCondition | undefined, insideNot = false): { event: string; status: string }[] {
  if (!condition) return [];
  switch (condition.type) {
    case 'all': case 'any': return condition.conditions.flatMap(child => eventRefs(child, insideNot));
    case 'not': return eventRefs(condition.condition, true);
    case 'event': return insideNot ? [] : [{ event: condition.event, status: condition.status }];
    default: return [];
  }
}

function choiceRefs(condition: StoryCondition | undefined): { choice: string; value: string }[] {
  if (!condition) return [];
  switch (condition.type) {
    case 'all': case 'any': return condition.conditions.flatMap(choiceRefs);
    case 'not': return choiceRefs(condition.condition);
    case 'choice': return [{ choice: condition.choice, value: condition.value }];
    default: return [];
  }
}

function entryChoices(condition: StoryCondition | undefined): Extract<StoryCommand, { type: 'choice' }>[] {
  return choiceRefs(condition).map(ref => ({ type: 'choice', choice: ref.choice, value: ref.value }));
}

function conditionReferencesFlag(condition: StoryCondition | undefined, flag: string): boolean {
  let found = false;
  visitCondition(condition, value => {
    if (value.type === 'flag' && value.flag === flag) found = true;
  });
  return found;
}

/** 折返是一次新的进图。只重建离开地图之后仍然生效的摆放、机关和清场。 */
export function persistentWorldCommand(command: StoryWorldCommand, map: string): StoryWorldCommand | undefined {
  switch (command.kind) {
    case 'place':
      if (command.scope === 'visit') return undefined;
      return command.mapFromStage ? { ...command, entity: { ...command.entity, map } } : command;
    case 'remove-character':
      if (!command.all) return undefined;
      return command.mapFromStage ? { ...command, map } : command;
    case 'enemy-location':
      if (command.scope === 'visit') return undefined;
      return command.mapFromStage && command.location ? { ...command, location: { ...command.location, map } } : command;
    case 'remove-enemy': return { ...command, map: command.map ?? map };
    case 'actor-visibility': case 'enemy-availability': case 'actor-appearance':
    case 'exit': case 'flag': case 'choice': case 'remove': case 'show': case 'hide': return command;
    default: return undefined;
  }
}

export function deriveQuestJumpHistory(campaign: Campaign, questId: string, mode: QuestJumpMode): DerivedHistory {
  try {
    return new Planner(campaign, questId, mode).run();
  } catch (error) {
    return fallbackHistory(campaign, questId, error);
  }
}

class Planner {
  campaign: Campaign;
  index: ContentIndex;
  questId: string;
  mode: QuestJumpMode;
  target: CampaignQuest;
  nodes: Map<string, PlanNode>;
  nodeCounter: number;
  producers: Map<string, string>;
  choicePins: Map<string, string>;
  flagPins: Map<string, boolean>;
  plannedStatus: Map<string, QuestStatus>;
  plannedEvents: Set<string>;
  warnings: string[];
  targetAccept: Producer | undefined;
  acceptNodeId: string | undefined;
  readyPostLanding: StageLanding | undefined;

  constructor(campaign: Campaign, questId: string, mode: QuestJumpMode) {
    this.campaign = campaign;
    this.index = indexFor(campaign);
    this.questId = questId;
    this.mode = mode;
    const target = this.index.quests.get(questId);
    if (!target) throw new Error('未找到任务：' + questId);
    this.target = target;
    this.nodes = new Map();
    this.nodeCounter = 0;
    this.producers = new Map();
    this.choicePins = new Map();
    this.flagPins = new Map();
    this.plannedStatus = new Map();
    this.plannedEvents = new Set();
    this.warnings = [];
    this.targetAccept = this.acceptProducer();
  }

  run(): DerivedHistory {
    for (const event of this.index.startEvents) this.ensureEvent(event.id);
    if (this.mode === 'available') this.planAvailable();
    else {
      this.acceptNodeId = this.ensureAccepted(this.questId, undefined, undefined);
      if (this.mode === 'ready') this.planReady();
    }
    const state = this.replayAndAuto();
    this.ensureVisibilityAndPassageEvents(state);
    this.fillIntakeCommands(state);
    return this.historyResult(state);
  }

  replayAndAuto(): HistoryState {
    const order = this.topologicalOrder();
    const state = this.replay(order);
    this.appendAutoWorldEvents(state);
    return state;
  }

  /**
   * 补齐三类未写在任务条件里、但直接影响当前现场可达性的世界状态命令（仅投影正式事件里的对应世界命令，不把无关章节事件塞进 completedEvents）：
   * 1. 目标任务的发布人/交付人/交互目标被前序事件设成 actor-visibility=false 时，投影最早将其显形的正式 actor-visibility 命令；
   * 2. 目标任务的发布人（非 available 模式下含交付人与交互目标）属于 flag 门控的登记人物且尚未放置时，投影前置正式事件的 place + flag 命令；
   * 3. 目标接取或完成事件为地图区域触发框，且更早章节的清障事件负责移除该图路障/打开通道出口时，投影对应的 actor-visibility 命令。
   */
  ensureVisibilityAndPassageEvents(state: HistoryState): void {
    const visibility = new Map<string, { map: string; actor: string; characterId?: string; visible: boolean }>();
    for (const cmd of state.world) {
      if (cmd.type === 'world' && cmd.command.kind === 'actor-visibility') {
        const key = `${cmd.command.map}\0${cmd.command.actor}\0${cmd.command.characterId ?? ''}`;
        visibility.set(key, {
          map: cmd.command.map,
          actor: cmd.command.actor,
          characterId: cmd.command.characterId,
          visible: cmd.command.visible,
        });
      }
    }

    const targetAcceptId = this.targetAccept?.kind === 'event' ? this.targetAccept.event!.id : undefined;

    const eventTouchesTargetQuest = (info: EventInfo): boolean => {
      if (positiveQuestRefs(info.event.condition).some(ref => ref.quest === this.questId)) return true;
      return info.commands.some(cmd => cmd.type === 'quest' && 'quest' in cmd.command && cmd.command.quest === this.questId);
    };

    const targetCharIds = new Set<string>(
      [
        this.target.giverCharacterId,
        this.target.deliveryCharacterId,
        ...this.target.goals.map(g => g.characterId),
      ].filter((id): id is string => !!id),
    );
    const targetActorIds = new Set<string>(
      [
        this.target.giver,
        this.target.delivery,
        ...this.target.goals.filter(g => g.kind === 'interact' || g.kind === 'talk').map(g => g.target),
      ].filter((id): id is string => !!id),
    );
    const matchesTargetNpc = (entry: { actor: string; characterId?: string }): boolean =>
      (entry.characterId !== undefined && targetCharIds.has(entry.characterId)) ||
      (entry.characterId === undefined && targetActorIds.has(entry.actor));

    // 1. 恢复被前序事件隐藏的目标任务发布人/交付人/交互目标
    for (const entry of visibility.values()) {
      if (entry.visible || !matchesTargetNpc(entry)) continue;
      for (const info of this.index.eventOrder) {
        if (info.event.id === targetAcceptId || state.completedEvents.has(info.event.id)) continue;
        if (info.event.repeat || this.conditionConflicts(info.event.condition) || eventTouchesTargetQuest(info)) continue;
        const cmd = info.commands.find(
          c =>
            c.type === 'world' &&
            c.command.kind === 'actor-visibility' &&
            c.command.visible === true &&
            c.command.map === entry.map &&
            c.command.actor === entry.actor &&
            (entry.characterId === undefined || c.command.characterId === entry.characterId),
        );
        if (cmd) {
          state.world.push(cmd);
          entry.visible = true;
          break;
        }
      }
    }

    // 2. 补齐目标任务相关角色所需的前置登记摆放（仅针对受 flag 门控且尚未在历史中退场的角色）
    const acceptScriptFlags = new Set<string>();
    const acceptScriptName = this.targetAccept?.kind === 'event' ? this.targetAccept.event!.script : this.targetAccept?.script;
    if (acceptScriptName) {
      const acceptCmds = targetAcceptId ? (this.index.events.get(targetAcceptId)?.commands ?? []) : [];
      for (const cmd of acceptCmds) {
        if (cmd.type === 'flag' && (cmd.value ?? true)) acceptScriptFlags.add(cmd.flag);
        if (cmd.type === 'world' && cmd.command.kind === 'flag' && cmd.command.value) acceptScriptFlags.add(cmd.command.id);
      }
    }
    const lastFlagFalseIndex = new Map<string, number>();
    for (const evId of state.completedEvents) {
      const info = this.index.events.get(evId);
      if (!info) continue;
      for (const cmd of info.commands) {
        if (cmd.type === 'flag' && cmd.value === false) {
          lastFlagFalseIndex.set(cmd.flag, Math.max(lastFlagFalseIndex.get(cmd.flag) ?? -1, info.index));
        }
        if (cmd.type === 'world' && cmd.command.kind === 'flag' && !cmd.command.value) {
          lastFlagFalseIndex.set(cmd.command.id, Math.max(lastFlagFalseIndex.get(cmd.command.id) ?? -1, info.index));
        }
      }
    }
    const placementCharIds = new Set<string>(
      [
        this.target.giverCharacterId,
        this.target.deliveryCharacterId,
        ...this.target.goals.map(g => g.characterId),
      ].filter((id): id is string => !!id),
    );
    for (const charId of placementCharIds) {
      const placements = this.campaign.placements.filter(p => p.characterId === charId);
      if (!placements.length) continue;
      const hasUnconditional = placements.some(p => !p.condition || (p.condition.type === 'always' && p.condition.value));
      if (hasUnconditional) continue;
      for (const p of placements) {
        if (p.condition?.type !== 'flag') continue;
        const flag = p.condition.flag;
        if (state.flags.get(flag) || acceptScriptFlags.has(flag)) continue;
        const placer = this.index.eventOrder.find(info => {
          if (info.event.id === targetAcceptId || state.completedEvents.has(info.event.id)) return false;
          if (info.event.repeat || this.conditionConflicts(info.event.condition) || eventTouchesTargetQuest(info)) return false;
          if ((lastFlagFalseIndex.get(flag) ?? -1) > info.index) return false;
          return info.commands.some(
            cmd =>
              (cmd.type === 'flag' && cmd.flag === flag && (cmd.value ?? true)) ||
              (cmd.type === 'world' && cmd.command.kind === 'flag' && cmd.command.id === flag && cmd.command.value),
          );
        });
        if (!placer) continue;
        for (const cmd of placer.commands) {
          if (cmd.type === 'world' && cmd.command.kind === 'place' && cmd.command.scope !== 'visit' && cmd.command.entity.characterId === charId) {
            state.world.push(cmd);
            this.recordPlacement(state, cmd.command.entity);
          } else if (cmd.type === 'flag' && cmd.flag === flag && (cmd.value ?? true)) {
            state.flags.set(flag, true);
            state.world.push(cmd);
          } else if (cmd.type === 'world' && cmd.command.kind === 'flag' && cmd.command.id === flag && cmd.command.value) {
            state.flags.set(flag, true);
            state.world.push(cmd);
          }
        }
      }
    }

    // 3. 目标接取或完成事件为 region 触发框时，投影更早章节清除该图路障/打开通道出口的 actor-visibility 命令
    const targetRegionEvents: StoryEvent[] = [];
    if (this.targetAccept?.kind === 'event' && this.targetAccept.event!.source === 'region' && this.targetAccept.event!.map) {
      targetRegionEvents.push(this.targetAccept.event!);
    }
    for (const comp of this.index.completers.get(this.questId) ?? []) {
      if (comp.kind === 'event' && comp.event!.source === 'region' && comp.event!.map && !targetRegionEvents.includes(comp.event!)) {
        targetRegionEvents.push(comp.event!);
      }
    }
    if (targetRegionEvents.length > 0) {
      const maxCompletedIndex = Math.max(
        -1,
        ...[...state.completedEvents].map(id => this.index.events.get(id)?.index ?? -1),
      );
      const lastVisWriteIndex = new Map<string, number>();
      for (const evId of state.completedEvents) {
        const info = this.index.events.get(evId);
        if (!info) continue;
        for (const cmd of info.commands) {
          if (cmd.type === 'world' && cmd.command.kind === 'actor-visibility') {
            const key = `${cmd.command.map}\0${cmd.command.actor}\0${cmd.command.characterId ?? ''}`;
            lastVisWriteIndex.set(key, Math.max(lastVisWriteIndex.get(key) ?? -1, info.index));
          }
        }
      }
      const appliedPassageKeys = new Set<string>();
      for (const regEv of targetRegionEvents) {
        const targetIndex = this.index.events.get(regEv.id)?.index ?? -1;
        if (targetIndex <= 0) continue;
        for (const info of this.index.eventOrder) {
          if (info.index >= targetIndex) continue;
          const isUnconditional =
            !info.event.condition ||
            (info.event.condition.type === 'all' && info.event.condition.conditions.length === 0);
          if (info.index >= maxCompletedIndex && !isUnconditional) continue;
          if (info.event.repeat || state.completedEvents.has(info.event.id)) continue;
          if (this.conditionConflicts(info.event.condition) || eventTouchesTargetQuest(info)) continue;
          for (const cmd of info.commands) {
            if (cmd.type !== 'world' || cmd.command.kind !== 'actor-visibility') continue;
            if (cmd.command.map !== regEv.map) continue;
            const key = `${cmd.command.map}\0${cmd.command.actor}\0${cmd.command.characterId ?? ''}`;
            if ((lastVisWriteIndex.get(key) ?? -1) > info.index) continue;
            if (appliedPassageKeys.has(key)) continue;
            const clearsExit =
              cmd.command.visible === true &&
              visibility.get(key)?.visible === false &&
              cmd.command.actor.startsWith('map-exit');
            const clearsObstacle =
              cmd.command.visible === false &&
              (cmd.command.actor.includes('barricade') || cmd.command.actor.includes('boulder-obstacle'));
            if (clearsExit || clearsObstacle) {
              state.world.push(cmd);
              appliedPassageKeys.add(key);
            }
          }
        }
      }
    }

    // 4. 目标任务活动地图上的剧情常驻敌怪摆放（enemy-location）：若放置它的事件依赖的前置任务已在历史中完成，投影其 enemy-location 命令
    const activePlace = this.target.places?.active;
    const activeMaps = new Set<string>(
      activePlace?.type === 'fixed'
        ? [activePlace.map]
        : activePlace?.type === 'alternatives'
          ? activePlace.spots.map(s => s.map)
          : [],
    );
    if (activeMaps.size > 0) {
      const placedEnemies = new Set<string>();
      for (const cmd of state.world) {
        if (cmd.type === 'world' && cmd.command.kind === 'enemy-location' && cmd.command.location) {
          placedEnemies.add(`${cmd.command.location.map}\0${cmd.command.enemyId}`);
        }
      }
      for (const info of this.index.eventOrder) {
        if (info.event.id === targetAcceptId || info.event.repeat || state.completedEvents.has(info.event.id)) continue;
        if (this.conditionConflicts(info.event.condition) || eventTouchesTargetQuest(info)) continue;
        const refs = positiveQuestRefs(info.event.condition);
        if (!refs.length || !refs.every(ref => state.delivered.has(ref.quest))) continue;
        for (const cmd of info.commands) {
          if (cmd.type !== 'world' || cmd.command.kind !== 'enemy-location') continue;
          if (cmd.command.scope === 'visit' || !cmd.command.location) continue;
          if (!activeMaps.has(cmd.command.location.map)) continue;
          const key = `${cmd.command.location.map}\0${cmd.command.enemyId}`;
          if (placedEnemies.has(key)) continue;
          state.world.push(cmd);
          placedEnemies.add(key);
        }
      }
    }
  }

  acceptProducer(): Producer | undefined {
    const candidates = this.index.acceptors.get(this.questId) ?? [];
    if (this.target.offerScript) {
      const offered = candidates.find(candidate => candidate.script === this.target.offerScript);
      if (offered) return offered;
    }
    const presupposesOwnCompletion = (candidate: Producer): boolean => {
      if (candidate.kind !== 'event' || !candidate.event?.condition) return false;
      for (const ref of positiveQuestRefs(candidate.event.condition)) {
        if (ref.status !== 'completed' && ref.status !== 'settled') continue;
        const depCompleters = this.index.completers.get(ref.quest) ?? [];
        const primary = depCompleters[0];
        if (primary?.kind === 'event' && primary.event) {
          const cmds = this.index.events.get(primary.event.id)?.commands ?? [];
          if (
            cmds.some(
              cmd =>
                cmd.type === 'quest' &&
                'quest' in cmd.command &&
                cmd.command.quest === this.questId &&
                (cmd.command.type === 'complete' || cmd.command.type === 'script-complete'),
            )
          ) {
            return true;
          }
        }
      }
      return false;
    };
    return candidates.find(candidate => !presupposesOwnCompletion(candidate)) ?? candidates[0];
  }

  planAvailable(): void {
    this.resolveCondition(this.target.availableWhen, undefined, undefined);
    const accept = this.targetAccept;
    if (!accept) return;
    if (accept.kind === 'event') {
      this.resolveCondition(accept.event!.condition, undefined, accept.event!.id);
      this.analyzeScriptCommands(accept.event!.script, accept.event!.id);
    } else if (accept.script) {
      if (accept.after) this.ensureCompleted(accept.after, undefined, undefined);
      this.analyzeScriptCommands(accept.script, undefined);
    }
  }

  planReady(): void {
    if (this.target.completion === 'talk') return;
    if (this.target.completion === 'all') {
      this.ensureReady(this.questId, undefined, undefined);
      this.addActiveBeats();
      return;
    }
    const readyProducers = this.index.readyProducers.get(this.questId) ?? [];
    if (readyProducers.length) {
      this.ensureReady(this.questId, undefined, undefined);
      this.addActiveBeats();
      return;
    }
    const completers = this.index.completers.get(this.questId) ?? [];
    const completer = completers.find(candidate => candidate.event?.id !== this.targetAccept?.event?.id);
    if (completer?.kind === 'event') this.resolveCondition(completer.event!.condition, undefined, completer.event!.id);
    else if (completer?.kind === 'script') this.analyzeScriptCommands(completer.script!, undefined);
    this.ensureReady(this.questId, undefined, undefined, true);
    this.addActiveBeats();
  }

  addActiveBeats(): void {
    if (this.mode !== 'ready') return;
    const acceptId = this.acceptNodeId;
    if (!acceptId) return;
    let previous = acceptId;
    for (const info of this.index.eventOrder) {
      const event = info.event;
      if (event.repeat || event.id === this.targetAccept?.event?.id) continue;
      if (!simpleActiveBeat(event.condition, this.questId)) continue;
      const node = this.ensureEvent(event.id, true);
      if (!node) continue;
      this.edge(previous, node.id);
      previous = node.id;
    }
    const ready = this.producers.get(this.questId + ':ready');
    if (ready && ready !== previous) this.edge(previous, ready);
  }

  analyzeScriptCommands(script: string, consumerEventId: string | undefined, consumerNodeId?: string): void {
    const seen = new Set<string>();
    const stack: StoryNodeRef[] = [];
    let cursor: StoryNodeRef | undefined = { script, node: this.campaign.scripts[script].entry };
    for (let count = 0; cursor; count++) {
      if (count >= MAX_WALK_NODES) {
        this.warnings.push('接取脚本未结束：' + script);
        break;
      }
      const key = cursor.script + '/' + cursor.node;
      if (seen.has(key)) {
        this.warnings.push('接取脚本出现循环：' + key);
        break;
      }
      seen.add(key);
      const node: StoryNode | undefined = this.index.nodes.get(cursor.script)?.get(cursor.node);
      if (!node) {
        this.warnings.push('接取脚本节点缺失：' + key);
        break;
      }
      for (const command of node.commands) {
        if (command.type !== 'quest' || !('quest' in command.command)) continue;
        const id = command.command.quest;
        if (id === this.questId) {
          if (command.command.type === 'accept') this.markPlannedAccepted(id);
          continue;
        }
        if (command.command.type === 'complete') {
          this.ensureReady(id, consumerNodeId, consumerEventId);
          this.plannedStatus.set(id, 'completed');
        } else if (command.command.type === 'script-complete') {
          this.ensureAccepted(id, consumerNodeId, consumerEventId);
          this.plannedStatus.set(id, 'completed');
        } else if (command.command.type === 'script-ready') {
          this.ensureAccepted(id, consumerNodeId, consumerEventId);
          this.plannedStatus.set(id, 'ready');
        } else if (command.command.type === 'accept') {
          this.resolveCondition(this.index.quests.get(id)?.availableWhen, consumerNodeId, consumerEventId);
          this.markPlannedAccepted(id);
        }
      }
      const exit: StoryNode['exit'] = node.exit;
      switch (exit.type) {
        case 'next': cursor = exit.target; break;
        case 'call': stack.push(exit.then); cursor = exit.target; break;
        case 'branch': cursor = this.plannedConditionHolds(exit.condition) ? exit.then : exit.otherwise; break;
        case 'choice': {
          const pinned = this.choicePins.get(exit.choice);
          const value = pinned && exit.cases[pinned] ? pinned : Object.keys(exit.cases)[0];
          cursor = value ? exit.cases[value] : exit.otherwise;
          break;
        }
        case 'waitEncounter': cursor = exit.outcomes.won ?? Object.values(exit.outcomes)[0]; break;
        case 'end': cursor = stack.pop(); break;
        case 'defer': cursor = undefined; break;
      }
    }
  }

  plannedConditionHolds(condition: StoryCondition | undefined): boolean {
    return evaluateStoryCondition(condition, {
      questStatus: id => this.plannedStatus.get(id) ?? 'available',
      questCompletedCycles: id => this.plannedStatus.get(id) === 'completed' ? 1 : 0,
      eventStatus: id => this.plannedEvents.has(id) ? 'completed' : 'idle',
      choice: id => this.choicePins.get(id),
      flag: id => this.flagPins.get(id) ?? false,
      world: () => undefined,
    });
  }

  /** 条件要求的选择值与已经固定的值相反时，这个事件/入口不能再用。 */
  conditionConflicts(condition: StoryCondition | undefined): boolean {
    if (!condition) return false;
    switch (condition.type) {
      case 'all': return condition.conditions.some(child => this.conditionConflicts(child));
      case 'any': return condition.conditions.every(child => this.conditionConflicts(child));
      case 'not': return false;
      case 'choice': {
        const target = this.targetChoiceValues.get(condition.choice);
        if (target !== undefined) return target !== condition.value;
        const pinned = this.choicePins.get(condition.choice);
        return pinned !== undefined && pinned !== condition.value;
      }
      default: return false;
    }
  }

  resolveCondition(condition: StoryCondition | undefined, consumerNodeId: string | undefined,
    consumerEventId: string | undefined): void {
    if (!condition) return;
    switch (condition.type) {
      case 'always': return;
      case 'all':
        for (const child of condition.conditions) this.resolveCondition(child, consumerNodeId, consumerEventId);
        return;
      case 'any': {
        const branch = condition.conditions.find(child => this.satisfiable(child, consumerEventId)) ?? condition.conditions[0];
        if (branch) this.resolveCondition(branch, consumerNodeId, consumerEventId);
        return;
      }
      case 'not':
        this.resolveNegative(condition.condition);
        return;
      case 'quest': {
        if (condition.status === 'accepted' || condition.status === 'active')
          this.ensureAccepted(condition.quest, consumerNodeId, consumerEventId);
        else if (condition.status === 'ready')
          this.ensureReady(condition.quest, consumerNodeId, consumerEventId);
        else if (condition.status === 'completed' || condition.status === 'settled')
          this.ensureCompleted(condition.quest, consumerNodeId, consumerEventId);
        return;
      }
      case 'event':
        if (condition.status === 'completed') this.ensureEvent(condition.event, false, consumerNodeId);
        return;
      case 'choice':
        this.ensureChoice(condition.choice, condition.value, consumerNodeId, consumerEventId);
        return;
      case 'flag':
        this.flagPins.set(condition.flag, condition.value ?? true);
        return;
      case 'world':
        this.warnings.push('不支持世界条件：' + condition.key);
        return;
    }
  }

  resolveNegative(condition: StoryCondition): void {
    if (condition.type === 'flag') {
      this.flagPins.set(condition.flag, !(condition.value ?? true));
      return;
    }
    if (condition.type === 'quest') {
      const produced = this.producers.get(condition.quest + ':accepted');
      if (produced && (condition.status === 'accepted' || condition.status === 'active'))
        this.warnings.push('否定条件与历史冲突：' + condition.quest + ' 已接取');
      return;
    }
    if (condition.type === 'event') {
      if (this.nodes.has('event:' + condition.event))
        this.warnings.push('否定条件与历史冲突：' + condition.event + ' 已进入历史');
      return;
    }
    this.warnings.push('无法处理的否定条件：' + condition.type);
  }

  satisfiable(condition: StoryCondition | undefined, consumerEventId: string | undefined): boolean {
    if (!condition) return true;
    switch (condition.type) {
      case 'always': return condition.value;
      case 'all': return condition.conditions.every(child => this.satisfiable(child, consumerEventId));
      case 'any': return condition.conditions.some(child => this.satisfiable(child, consumerEventId));
      case 'not': return true;
      case 'quest': return true;
      case 'event': return this.index.events.has(condition.event);
      case 'choice': return true;
      case 'flag': return true;
      case 'world': return false;
    }
    return false;
  }

  choiceResolving = new Set<string>();
  targetChoiceNames = new Set<string>();
  targetChoiceValues = new Map<string, string>();
  prerequisiteChoiceNames = new Set<string>();

  ensureChoice(choice: string, value: string, consumerNodeId: string | undefined,
    consumerEventId: string | undefined): void {
    const targetValue = this.targetChoiceValues.get(choice);
    if (targetValue !== undefined) {
      if (targetValue !== value) this.warnings.push('选择值冲突：' + choice + ' 目标要求 ' + targetValue + '，前置要求 ' + value);
      return;
    }
    const pinned = this.choicePins.get(choice);
    if (pinned && pinned !== value) this.warnings.push('选择值冲突：' + choice + ' 需要 ' + pinned + ' 和 ' + value);
    this.choicePins.set(choice, value);
    if (consumerEventId && consumerEventId === this.targetAccept?.event?.id) {
      this.targetChoiceNames.add(choice);
      this.targetChoiceValues.set(choice, value);
      return;
    }
    this.prerequisiteChoiceNames.add(choice);
    if (this.choiceResolving.has(choice)) return;
    const writers = (this.index.choiceWriters.get(choice) ?? [])
      .filter(writer => writer.values.includes(value) && writer.eventId !== consumerEventId
        && !this.conditionConflicts(this.index.events.get(writer.eventId)?.event.condition));
    if (!writers.length) return;
    this.choiceResolving.add(choice);
    try {
      this.ensureEvent(writers[0].eventId, false, consumerNodeId);
    } finally {
      this.choiceResolving.delete(choice);
    }
  }

  ensureEvent(eventId: string, optional = false, consumerNodeId?: string): PlanNode | undefined {
    const info = this.index.events.get(eventId);
    const id = 'event:' + eventId;
    let node = this.nodes.get(id);
    if (!node) {
      if (!info) {
        this.warnings.push('缺少事件：' + eventId);
        return undefined;
      }
      if (this.conditionConflicts(info.event.condition)) {
        this.warnings.push('事件条件与已固定选择冲突：' + eventId);
        return undefined;
      }
      node = { id, kind: 'event', order: info.index, event: info.event, optional, deps: new Set() };
      this.nodes.set(id, node);
      this.plannedEvents.add(eventId);
      this.resolveCondition(info.event.condition, id, eventId);
      this.analyzeScriptCommands(info.event.script, eventId, id);
    } else if (!optional) node.optional = false;
    if (consumerNodeId) this.edge(id, consumerNodeId);
    return node;
  }

  ensureScript(script: string, producerOf: 'accepted' | 'ready' | 'completed', questId: string,
    consumerNodeId?: string): PlanNode | undefined {
    if (!this.campaign.scripts[script]) {
      this.warnings.push('缺少脚本：' + script);
      return undefined;
    }
    const id = 'script:' + script + ':' + producerOf + ':' + questId;
    let node = this.nodes.get(id);
    if (!node) {
      node = { id, kind: 'script', order: Number.MAX_SAFE_INTEGER - 4, script, quest: questId, optional: false, deps: new Set() };
      this.nodes.set(id, node);
      this.analyzeScriptCommands(script, undefined, id);
    }
    if (consumerNodeId) this.edge(id, consumerNodeId);
    return node;
  }

  ensureAccepted(questId: string, consumerNodeId?: string, consumerEventId?: string): string | undefined {
    if (questId === this.questId && this.mode === 'available') return undefined;
    const key = questId + ':accepted';
    const existing = this.producers.get(key);
    if (existing) {
      this.markPlannedAccepted(questId);
      if (consumerNodeId) this.edge(existing, consumerNodeId);
      return existing;
    }
    const quest = this.index.quests.get(questId);
    if (!quest) {
      this.warnings.push('缺少任务：' + questId);
      return undefined;
    }
    const candidates = (this.index.acceptors.get(questId) ?? [])
      .filter(candidate => candidate.kind !== 'event'
        || (candidate.event!.id !== consumerEventId && !this.conditionConflicts(candidate.event!.condition)));
    const candidate = quest.offerScript
      ? candidates.find(entry => entry.script === quest.offerScript) ?? candidates[0]
      : candidates[0];
    let node: PlanNode | undefined;
    if (candidate?.kind === 'event') {
      this.producers.set(key, 'event:' + candidate.event!.id);
      node = this.ensureEvent(candidate.event!.id);
    } else if (candidate?.script) {
      this.producers.set(key, 'script:' + candidate.script + ':accepted:' + questId);
      node = this.ensureScript(candidate.script, 'accepted', questId);
    }
    if (!node) {
      node = this.synthetic('accept', questId);
      this.producers.set(key, node.id);
      this.resolveCondition(quest.availableWhen, node.id, undefined);
    }
    this.markPlannedAccepted(questId);
    if (consumerNodeId) this.edge(node.id, consumerNodeId);
    return node.id;
  }

  markPlannedAccepted(questId: string): void {
    const quest = this.index.quests.get(questId);
    this.plannedStatus.set(questId, quest?.completion === 'talk' ? 'ready' : 'active');
  }

  ensureReady(questId: string, consumerNodeId?: string, consumerEventId?: string, forceSynthetic = false): string | undefined {
    const key = questId + ':ready';
    const existing = this.producers.get(key);
    if (existing) {
      this.plannedStatus.set(questId, 'ready');
      if (consumerNodeId) this.edge(existing, consumerNodeId);
      return existing;
    }
    const accept = this.ensureAccepted(questId, undefined, consumerEventId);
    const quest = this.index.quests.get(questId);
    if (!quest || !accept) return accept;
    if (quest.completion === 'talk') {
      this.producers.set(key, accept);
      this.plannedStatus.set(questId, 'ready');
      if (consumerNodeId) this.edge(accept, consumerNodeId);
      return accept;
    }
    if (!forceSynthetic && quest.completion === 'story') {
      const candidates = (this.index.readyProducers.get(questId) ?? [])
        .filter(candidate => candidate.kind !== 'event'
          || (candidate.event!.id !== consumerEventId && !this.conditionConflicts(candidate.event!.condition)));
      const candidate = candidates[0];
      if (candidate) {
        if (candidate.kind === 'event') this.producers.set(key, 'event:' + candidate.event!.id);
        else this.producers.set(key, 'script:' + candidate.script + ':ready:' + questId);
        const node = candidate.kind === 'event'
          ? this.ensureEvent(candidate.event!.id)
          : this.ensureScript(candidate.script!, 'ready', questId);
        if (node) {
          this.edge(accept, node.id);
          this.plannedStatus.set(questId, 'ready');
          if (consumerNodeId) this.edge(node.id, consumerNodeId);
          return node.id;
        }
      }
    }
    const node = this.synthetic('ready', questId);
    this.edge(accept, node.id);
    this.producers.set(key, node.id);
    this.plannedStatus.set(questId, 'ready');
    if (consumerNodeId) this.edge(node.id, consumerNodeId);
    return node.id;
  }

  ensureCompleted(questId: string, consumerNodeId?: string, consumerEventId?: string): string | undefined {
    const key = questId + ':completed';
    const existing = this.producers.get(key);
    if (existing) {
      this.plannedStatus.set(questId, 'completed');
      if (consumerNodeId) this.edge(existing, consumerNodeId);
      return existing;
    }
    const quest = this.index.quests.get(questId);
    if (!quest) {
      this.warnings.push('缺少任务：' + questId);
      return undefined;
    }
    const accept = this.ensureAccepted(questId, undefined, consumerEventId);
    if (!accept) return undefined;
    const candidates = (this.index.completers.get(questId) ?? [])
      .filter(candidate => candidate.kind !== 'event'
        || (candidate.event!.id !== consumerEventId && !this.conditionConflicts(candidate.event!.condition)));
    const explicit = quest.completeScript && this.campaign.scripts[quest.completeScript]
      ? { kind: 'script' as const, script: quest.completeScript } : undefined;
    const candidate = explicit ?? candidates[0];
    if (candidate) {
      if (candidate.kind === 'event') this.producers.set(key, 'event:' + candidate.event!.id);
      else this.producers.set(key, 'script:' + candidate.script + ':completed:' + questId);
      const node = candidate.kind === 'event'
        ? this.ensureEvent(candidate.event!.id)
        : this.ensureScript(candidate.script!, 'completed', questId);
      if (node) {
        this.edge(accept, node.id);
        this.plannedStatus.set(questId, 'completed');
        if (consumerNodeId) this.edge(node.id, consumerNodeId);
        return node.id;
      }
    }
    const ready = this.ensureReady(questId, undefined, consumerEventId, true);
    const node = this.synthetic('deliver', questId);
    if (ready) this.edge(ready, node.id);
    else this.edge(accept, node.id);
    this.producers.set(key, node.id);
    this.plannedStatus.set(questId, 'completed');
    if (consumerNodeId) this.edge(node.id, consumerNodeId);
    return node.id;
  }

  synthetic(kind: 'accept' | 'ready' | 'deliver', questId: string): PlanNode {
    const id = 'synth:' + kind + ':' + questId + ':' + (++this.nodeCounter);
    const node: PlanNode = {
      id, kind, order: Number.MAX_SAFE_INTEGER - 3 + this.nodeCounter / 1000,
      quest: questId, optional: false, deps: new Set(),
    };
    this.nodes.set(id, node);
    return node;
  }

  edge(from: string, to: string | undefined): void {
    if (!to || from === to) return;
    const node = this.nodes.get(to);
    if (node) node.deps.add(from);
  }

  topologicalOrder(): PlanNode[] {
    const remaining = new Map<string, Set<string>>();
    for (const [id, node] of this.nodes) remaining.set(id, new Set(node.deps));
    for (const deps of remaining.values()) for (const dep of [...deps]) if (!this.nodes.has(dep)) deps.delete(dep);
    const result: PlanNode[] = [];
    const ready: PlanNode[] = [];
    const pushReady = (node: PlanNode) => {
      ready.push(node);
      ready.sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
    };
    for (const [id, deps] of remaining) if (!deps.size) pushReady(this.nodes.get(id)!);
    while (ready.length) {
      const node = ready.shift()!;
      result.push(node);
      remaining.delete(node.id);
      for (const [id, deps] of remaining) if (deps.delete(node.id) && !deps.size) pushReady(this.nodes.get(id)!);
    }
    if (remaining.size) {
      this.warnings.push('历史依赖存在环，已按内容顺序处理：' + [...remaining.keys()].slice(0, 6).join('、'));
      const rest = [...remaining.keys()].map(id => this.nodes.get(id)!).sort((left, right) => left.order - right.order);
      result.push(...rest);
    }
    return result;
  }

  replay(order: PlanNode[]): HistoryState {
    this.acceptMap = undefined;
    const state: HistoryState = {
      status: new Map(), opened: new Set(), ready: new Set(), delivered: new Set(),
      completedEvents: new Set(), choices: new Map(this.choicePins), flags: new Map(this.flagPins),
      items: new Map([...this.index.itemIds].map(id => [id, 0])),
      world: [], currentMap: this.campaign.start.map,
      placements: new Map(), warnings: this.warnings,
    };
    const equipment = new Map<string, StoryCommand>(this.index.equipmentCleanup);
    const inParty = new Set<string>();
    const readyProducerId = this.producers.get(this.questId + ':ready');
    for (const node of order) {
      if (node.kind === 'event' && node.event) {
        if (node.optional && !conditionHolds(node.event.condition, state)) continue;
        const map = this.triggerMap(node.event, state);
        state.currentMap = map;
        const result = this.replayScript(node.event.script, state, node.event.condition, map, equipment, inParty);
        const landingMap = result.landing?.map ?? map;
        this.nodeMaps.set(node.id, landingMap);
        this.eventMap.set(node.event.id, landingMap);
        state.currentMap = landingMap;
        state.completedEvents.add(node.event.id);
        if (this.acceptNodeId === node.id) this.acceptMap = map;
        if (readyProducerId === node.id && result.landing) this.readyPostLanding = result.landing;
      } else if (node.kind === 'script' && node.script) {
        const map = state.currentMap;
        const result = this.replayScript(node.script, state, undefined, map, equipment, inParty);
        const landingMap = result.landing?.map ?? map;
        this.nodeMaps.set(node.id, landingMap);
        state.currentMap = landingMap;
        if (this.acceptNodeId === node.id) this.acceptMap = map;
        if (readyProducerId === node.id && result.landing) this.readyPostLanding = result.landing;
      } else if (node.kind === 'accept') {
        this.applyAccept(state, node.quest!);
        this.nodeMaps.set(node.id, state.currentMap);
        if (this.acceptNodeId === node.id) this.acceptMap = state.currentMap;
      } else if (node.kind === 'ready') {
        this.applyReady(state, node.quest!);
        this.nodeMaps.set(node.id, state.currentMap);
      } else if (node.kind === 'deliver') {
        this.applyDeliver(state, node.quest!);
        this.nodeMaps.set(node.id, state.currentMap);
      }
    }
    for (const companion of this.index.companions)
      state.world.push({ type: inParty.has(companion) ? 'party-join' : 'party-leave', companion });
    state.world.push(...equipment.values());
    if (!this.acceptMap) this.acceptMap = this.mode === 'available' ? this.acceptMapForAvailable(state) : state.currentMap;
    if (this.acceptMap) state.currentMap = this.acceptMap;
    return state;
  }

  acceptMap: string | undefined;

  replayScript(script: string, state: HistoryState, condition: StoryCondition | undefined,
    entryMap: string, equipment: Map<string, StoryCommand>, inParty: Set<string>):
    { commands: StoryCommand[]; landing?: StageLanding } {
    const commands: StoryCommand[] = [];
    const nodes: Map<string, Map<string, StoryNode>> = this.index.nodes;
    const start: StoryScript | undefined = this.campaign.scripts[script];
    if (!start) {
      this.warnings.push('缺少脚本：' + script);
      return { commands };
    }
    for (const choice of entryChoices(condition)) this.applyChoice(state, choice, commands);
    let map = entryMap;
    let landing: StageLanding | undefined;
    let afterReady = false;
    let readyLanding: StageLanding | undefined;
    const stack: StoryNodeRef[] = [];
    let cursor: StoryNodeRef | undefined = { script, node: start.entry };
    const seen = new Set<string>();
    for (let count = 0; cursor; count++) {
      if (count >= MAX_WALK_NODES) {
        this.warnings.push('脚本未结束：' + script);
        break;
      }
      const key = cursor.script + '/' + cursor.node;
      if (seen.has(key)) {
        this.warnings.push('脚本出现循环：' + key);
        break;
      }
      seen.add(key);
      const node: StoryNode | undefined = nodes.get(cursor.script)?.get(cursor.node);
      if (!node) {
        this.warnings.push('脚本节点缺失：' + key);
        break;
      }
      for (const action of node.presentation) {
        if (action.type !== 'stage') continue;
        if (!action.mapFromWorld) map = action.map;
        landing = { map, x: action.x, y: action.y, facing: action.facing ?? 'south' };
        if (afterReady) readyLanding = landing;
      }
      for (const command of node.commands) {
        if (command.type === 'quest' && 'quest' in command.command) {
          this.applyQuestCommand(state, command.command);
          if (command.command.type === 'script-ready') afterReady = true;
        } else if (command.type === 'world') {
          const resolved = persistentWorldCommand(command.command, map);
          if (resolved) {
            const action = { type: 'world' as const, command: resolved };
            commands.push(action);
            state.world.push(action);
            this.applyWorldSideEffect(state, resolved);
            if (resolved.kind === 'place') this.recordPlacement(state, resolved.entity);
          }
          if (command.command.kind === 'place'
            && (command.command.scope === 'visit' || !command.command.mapFromStage)) {
            const placeMap = command.command.mapFromStage ? map : command.command.entity.map;
            this.recordPlacement(state, { ...command.command.entity, map: placeMap });
          }
        } else if (command.type === 'flag') {
          state.flags.set(command.flag, command.value ?? true);
          commands.push(command);
          state.world.push(command);
        } else if (command.type === 'choice') {
          this.applyChoice(state, command, commands);
        } else if (command.type === 'item-give' || command.type === 'item-take') {
          const delta = command.type === 'item-give' ? command.quantity : -command.quantity;
          state.items.set(command.item, Math.max(0, (state.items.get(command.item) ?? 0) + delta));
          commands.push(command);
        } else if (command.type === 'party-join') {
          inParty.add(command.companion);
          commands.push(command);
        } else if (command.type === 'party-leave') {
          inParty.delete(command.companion);
          commands.push(command);
        } else if (command.type === 'equip' || command.type === 'unequip-destroy') {
          equipment.set(command.member + '/' + command.item, command);
        } else if (command.type === 'travel') {
          map = command.destination.map;
          landing = { ...command.destination, facing: command.destination.facing ?? 'south' };
        }
      }
      const exit: StoryNode['exit'] = node.exit;
      switch (exit.type) {
        case 'next': cursor = exit.target; break;
        case 'call': stack.push(exit.then); cursor = exit.target; break;
        case 'branch': cursor = conditionHolds(exit.condition, state) ? exit.then : exit.otherwise; break;
        case 'choice': {
          const pinned = this.choicePins.get(exit.choice);
          const current = state.choices.get(exit.choice);
          const value = (pinned && exit.cases[pinned] ? pinned : undefined)
            ?? (current && exit.cases[current] ? current : undefined)
            ?? Object.keys(exit.cases)[0];
          if (value) {
            this.applyChoice(state, { type: 'choice', choice: exit.choice, value }, commands);
            cursor = exit.cases[value] ?? exit.otherwise;
          } else cursor = exit.otherwise;
          break;
        }
        case 'waitEncounter': cursor = exit.outcomes.won ?? Object.values(exit.outcomes)[0]; break;
        case 'end': cursor = stack.pop(); break;
        case 'defer': cursor = undefined; break;
      }
    }
    if (afterReady && readyLanding) landing = readyLanding;
    return { commands, landing };
  }

  applyQuestCommand(state: HistoryState, command: Extract<StoryCommand, { type: 'quest' }>['command']): void {
    if (!('quest' in command)) return;
    const id = command.quest;
    const quest = this.index.quests.get(id);
    const status = state.status.get(id) ?? 'available';
    if (command.type === 'accept') {
      if (quest?.completion === 'talk') this.applyReady(state, id);
      else this.applyAccept(state, id);
      if (!state.opened.has(id)) state.opened.add(id);
      return;
    }
    if (command.type === 'script-ready') {
      if (!state.opened.has(id)) this.applyAccept(state, id);
      this.applyReady(state, id);
      return;
    }
    if (command.type === 'complete' || command.type === 'script-complete') {
      if (command.type === 'complete' && status !== 'ready' && status !== 'active')
        this.warnings.push('完成命令前任务未接取：' + id);
      if (!state.opened.has(id)) this.applyAccept(state, id);
      if (command.type === 'complete' && !state.ready.has(id)) this.applyReady(state, id);
      this.applyDeliver(state, id);
      return;
    }
    if (command.type === 'reset') {
      state.status.set(id, 'available');
      return;
    }
    if (command.type === 'reset-side-quests') {
      for (const [qid, value] of state.status) if (value === 'active' || value === 'ready') {
        const q = this.index.quests.get(qid);
        if (q && q.journal !== false && q.completion !== 'internal') state.status.set(qid, 'available');
      }
      return;
    }
    if (command.type === 'fact' || command.type === 'refresh') return;
  }

  applyAccept(state: HistoryState, id: string): void {
    const quest = this.index.quests.get(id);
    if (!quest) return;
    const before = state.status.get(id) ?? 'available';
    if (before === 'available' || before === 'locked') {
      const status: QuestStatus = quest.completion === 'talk' ? 'ready' : 'active';
      state.status.set(id, status);
      state.opened.add(id);
      if (status === 'ready') state.ready.add(id);
      if (before === 'available') for (const entry of quest.onAcceptItems ?? [])
        state.items.set(entry.item, (state.items.get(entry.item) ?? 0) + entry.quantity);
    } else {
      state.opened.add(id);
    }
  }

  applyReady(state: HistoryState, id: string): void {
    if (!state.opened.has(id)) state.opened.add(id);
    state.status.set(id, 'ready');
    state.ready.add(id);
  }

  applyDeliver(state: HistoryState, id: string): void {
    const quest = this.index.quests.get(id);
    if (!quest) return;
    if (!state.opened.has(id)) state.opened.add(id);
    state.status.set(id, quest.repeat ? 'available' : 'completed');
    state.delivered.add(id);
    for (const entry of quest.handoverItems ?? []) {
      if (entry.removal === 'all-matching') state.items.set(entry.item, 0);
      else state.items.set(entry.item, Math.max(0, (state.items.get(entry.item) ?? 0) - entry.quantity));
    }
    for (const entry of quest.rewards?.items ?? [])
      if (this.index.itemIds.has(entry.item)) state.items.set(entry.item, (state.items.get(entry.item) ?? 0) + entry.quantity);
  }

  applyChoice(state: HistoryState, command: Extract<StoryCommand, { type: 'choice' }>, commands: StoryCommand[]): void {
    state.choices.set(command.choice, command.value);
    commands.push(command);
  }

  applyWorldSideEffect(state: HistoryState, command: StoryWorldCommand): void {
    if (command.kind === 'flag') state.flags.set(command.id, command.value);
    if (command.kind === 'choice') state.choices.set(command.id, command.value);
    if (command.kind === 'travel') state.currentMap = command.destination.map;
  }

  recordPlacement(state: HistoryState, entity: { id: string; map: string; x: number; y: number; facing?: Facing; characterId?: string; actor?: string }): void {
    state.placements.set(entity.id, {
      entityId: entity.id, characterId: entity.characterId, actor: entity.actor,
      map: entity.map, x: entity.x, y: entity.y, facing: entity.facing,
    });
  }

  triggerMap(event: StoryEvent, state: HistoryState): string {
    if (event.map) return event.map;
    if (event.place?.type === 'fixed') return event.place.map;
    if (event.place?.type === 'alternatives') {
      const firstStage = this.firstStageMap(event.script);
      return event.place.spots.find(spot => spot.map === state.currentMap)?.map
        ?? event.place.spots.find(spot => spot.map === firstStage)?.map
        ?? event.place.spots[0]?.map
        ?? state.currentMap;
    }
    if (event.place?.type !== 'current') {
      const firstStage = this.firstStageMap(event.script);
      if (firstStage) return firstStage;
    }
    if (event.source === 'start') return this.campaign.start.map;
    if (event.source === 'quest') {
      for (const ref of positiveQuestRefs(event.condition)) {
        const quest = this.index.quests.get(ref.quest);
        const identities = [quest?.deliveryCharacterId, quest?.delivery, quest?.giverCharacterId, quest?.giver]
          .filter((value): value is string => !!value);
        for (const placement of state.placements.values())
          if (identities.some(id => placement.characterId === id || placement.actor === id)) return placement.map;
        for (const stage of ['ready', 'active', 'available'] as const) {
          const place = quest?.places?.[stage];
          if (place?.type === 'fixed') return place.map;
          if (place?.type === 'alternatives') return place.spots[0].map;
        }
      }
    }
    if (event.source === 'event') {
      for (const ref of eventRefs(event.condition)) {
        const map = this.eventMap.get(ref.event);
        if (map) return map;
      }
    }
    if (event.source === 'choice') {
      for (const ref of choiceRefs(event.condition)) {
        const writer = this.index.choiceWriters.get(ref.choice)?.[0];
        const map = writer && this.eventMap.get(writer.eventId);
        if (map) return map;
      }
    }
    return this.firstStageMap(event.script) ?? state.currentMap;
  }

  eventMap = new Map<string, string>();

  firstStageMap(script: string): string | undefined {
    const definition = this.campaign.scripts[script];
    if (!definition) return undefined;
    for (const node of definition.nodes)
      for (const action of node.presentation)
        if (action.type === 'stage') return action.map;
    return undefined;
  }

  acceptMapForAvailable(state: HistoryState): string | undefined {
    const accept = this.targetAccept;
    if (accept?.kind === 'event') return this.triggerMap(accept.event!, state);
    const places = this.target.places?.available;
    if (places?.type === 'fixed') return places.map;
    if (places?.type === 'alternatives') return places.spots[0]?.map;
    return state.currentMap;
  }

  appendAutoWorldEvents(state: HistoryState): void {
    const targets = this.targetIdentities();
    if (!targets.size) return;
    const autoState = cloneState(state);
    for (const choice of this.targetChoiceNames)
      if (!this.prerequisiteChoiceNames.has(choice)) autoState.choices.delete(choice);
    for (const info of this.index.eventOrder) {
      const event = info.event;
      if (event.repeat || state.completedEvents.has(event.id)) continue;
      if (event.source !== 'event' && event.source !== 'quest' && event.source !== 'choice' && event.source !== 'start') continue;
      if (info.hasQuestCommands) continue;
      if (!conditionHolds(event.condition, autoState)) continue;
      if (!this.eventAffects(event, targets)) continue;
      const map = this.triggerMap(event, autoState);
      const previousMap = state.currentMap;
      const beforeChoices = new Map(state.choices);
      const beforeFlags = new Map(state.flags);
      state.currentMap = map;
      this.replayScript(event.script, state, event.condition, map, new Map(), new Set());
      state.currentMap = previousMap;
      state.completedEvents.add(event.id);
      autoState.completedEvents.add(event.id);
      for (const [key, value] of state.choices) if (beforeChoices.get(key) !== value) autoState.choices.set(key, value);
      for (const [key, value] of state.flags) if (beforeFlags.get(key) !== value) autoState.flags.set(key, value);
    }
  }

  targetIdentities(): Set<string> {
    const identities = new Set<string>();
    for (const value of [this.target.giverCharacterId, this.target.deliveryCharacterId,
      this.target.giver, this.target.delivery]) if (value) identities.add(value);
    const accept = this.targetAccept;
    const script = accept?.kind === 'event' ? accept.event!.script : accept?.script;
    if (script) {
      for (const node of this.campaign.scripts[script]?.nodes ?? [])
        for (const action of node.presentation) if (action.type === 'stage')
          for (const cast of action.cast) for (const value of [cast.worldEntityId, cast.characterId, cast.id])
            if (value) identities.add(value);
    }
    return identities;
  }

  eventAffects(event: StoryEvent, identities: Set<string>): boolean {
    for (const command of this.index.events.get(event.id)?.commands ?? []) {
      if (command.type !== 'world') continue;
      const value = command.command;
      if (value.kind === 'place' && (identities.has(value.entity.id)
        || (value.entity.characterId !== undefined && identities.has(value.entity.characterId))
        || (value.entity.actor !== undefined && identities.has(value.entity.actor)))) return true;
      if (value.kind === 'remove-character' && identities.has(value.characterId)) return true;
      if (value.kind === 'show' || value.kind === 'hide' || value.kind === 'remove') {
        if (identities.has(value.id)) return true;
      }
    }
    const targetPlacements = [...this.campaign.placements, ...this.campaign.mapEntryPlacements ?? []]
      .filter(placement => this.placementCoversTarget(placement));
    for (const command of this.index.events.get(event.id)?.commands ?? []) {
      if (command.type === 'flag') {
        for (const placement of targetPlacements)
          if (conditionReferencesFlag(placement.condition, command.flag)) return true;
      }
      if (command.type === 'world' && command.command.kind === 'flag') {
        for (const placement of targetPlacements)
          if (conditionReferencesFlag(placement.condition, command.command.id)) return true;
      }
    }
    return false;
  }

  placementCoversTarget(placement: { id: string; characterId?: string; actor?: string }): boolean {
    return (placement.characterId !== undefined
      && (placement.characterId === this.target.giverCharacterId
        || placement.characterId === this.target.deliveryCharacterId))
      || (placement.actor !== undefined
        && (placement.actor === this.target.giver || placement.actor === this.target.delivery));
  }

  fillIntakeCommands(state: HistoryState): void {
    if (this.acceptNodeId) return;
    const accept = this.targetAccept;
    if (!accept) {
      this.intakeCommands = [];
      return;
    }
    const script = accept.kind === 'event' ? accept.event!.script : accept.script!;
    const clone = cloneState(state);
    clone.currentMap = this.acceptMap ?? this.acceptMapForAvailable(clone) ?? clone.currentMap;
    const equipment = new Map<string, StoryCommand>();
    const party = new Set<string>();
    const result = this.replayScript(script, clone, accept.kind === 'event' ? accept.event!.condition : undefined,
      clone.currentMap, equipment, party);
    this.intakeCommands = result.commands;
  }

  intakeCommands: StoryCommand[] = [];

  historyResult(state: HistoryState): DerivedHistory {
    const accept = this.targetAccept;
    const intake: { event?: string; script?: string } = accept?.kind === 'event'
      ? { event: accept.event!.id, script: accept.event!.script }
      : { script: accept?.script };
    const stageMap = this.mode === 'ready'
      ? this.readyMap(state)
      : this.acceptMap ?? this.acceptMapForAvailable(state) ?? state.currentMap;
    return {
      intake,
      progress: state.status,
      completedQuests: state.delivered,
      completedEvents: state.completedEvents,
      choices: state.choices,
      items: state.items,
      world: state.world,
      intakeCommands: this.intakeCommands,
      stageMap,
      destination: this.mode === 'ready' ? this.readyPostLanding : undefined,
      placements: [...state.placements.values()],
      warnings: [...new Set(state.warnings)],
    };
  }

  readyMap(state: HistoryState): string {
    const ready = this.producers.get(this.questId + ':ready');
    if (ready && this.nodeMaps.has(ready)) return this.nodeMaps.get(ready)!;
    return this.acceptMap ?? this.acceptMapForAvailable(state) ?? state.currentMap;
  }

  nodeMaps = new Map<string, string>();
}

function cloneState(state: HistoryState): HistoryState {
  return {
    status: new Map(state.status), opened: new Set(state.opened), ready: new Set(state.ready),
    delivered: new Set(state.delivered), completedEvents: new Set(state.completedEvents),
    choices: new Map(state.choices), flags: new Map(state.flags), items: new Map(state.items),
    world: [...state.world], currentMap: state.currentMap,
    placements: new Map(state.placements), warnings: [...state.warnings],
  };
}

function conditionHolds(condition: StoryCondition | undefined, state: HistoryState): boolean {
  return evaluateStoryCondition(condition, {
    questStatus: id => state.status.get(id) ?? 'available',
    questCompletedCycles: id => state.delivered.has(id) ? 1 : 0,
    eventStatus: id => state.completedEvents.has(id) ? 'completed' : 'idle',
    choice: id => state.choices.get(id),
    flag: id => state.flags.get(id) ?? false,
    world: () => undefined,
  });
}

function simpleActiveBeat(condition: StoryCondition | undefined, questId: string): boolean {
  if (!condition) return false;
  if (condition.type === 'all')
    return condition.conditions.length > 0
      && condition.conditions.every(child => simpleActiveBeat(child, questId));
  return condition.type === 'quest' && condition.quest === questId
    && (condition.status === 'accepted' || condition.status === 'active');
}

function fallbackHistory(campaign: Campaign, questId: string, error: unknown): DerivedHistory {
  const quest = campaign.quests.find(entry => entry.id === questId);
  const message = error instanceof Error ? error.message : String(error);
  const place = quest?.places?.available;
  const map = place?.type === 'fixed' ? place.map
    : place?.type === 'alternatives' ? place.spots[0]?.map : campaign.start.map;
  let intake: { event?: string; script?: string } = {};
  try {
    const candidate = indexFor(campaign).acceptors.get(questId)?.[0];
    if (candidate?.kind === 'event') intake = { event: candidate.event!.id, script: candidate.event!.script };
    else if (candidate?.script) intake = { script: candidate.script };
  } catch {
    // 索引本身不可用时保持空接取入口，由既有条件补齐逻辑兜底。
  }
  return {
    intake, progress: new Map(), completedQuests: new Set(), completedEvents: new Set(),
    choices: new Map(), items: new Map(), world: [], intakeCommands: [], stageMap: map,
    placements: [], warnings: ['无法推导跳转历史：' + message],
  };
}

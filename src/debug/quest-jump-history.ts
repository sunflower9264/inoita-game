import type { Campaign, CampaignQuest, StoryProgressionStep } from '../domain/campaign.ts';
import type { QuestStatus, TravelDestination } from '../domain/content.ts';
import { evaluateStoryCondition, type StoryCondition, type StoryConditionContext } from '../domain/story-condition.ts';
import type { StoryCommand, StoryNode, StoryNodeRef } from '../domain/story-graph.ts';
import type { StoryWorldCommand } from '../domain/story-world.ts';

interface HistoryStep {
  definition: StoryProgressionStep;
  commands: StoryCommand[];
  map: string;
  landing?: TravelDestination;
}

interface QuestBoundary {
  accept: number;
  ready?: number;
  deliver?: number;
}

interface HistoryIndex {
  steps: HistoryStep[];
  boundaries: Map<string, QuestBoundary>;
  quests: Map<string, CampaignQuest>;
  itemIds: Set<string>;
  companions: Set<string>;
  outfits: Map<string, Extract<StoryCommand, {type:'unequip-destroy'}>>;
}

const timelines = new WeakMap<Campaign, HistoryIndex>();

/** 折返是一次新的进图。只重建离开地图之后仍然生效的摆放、机关和清场。 */
function persistentWorldCommand(command: StoryWorldCommand, map: string): StoryWorldCommand | undefined {
  switch (command.kind) {
    case 'place':
      if (command.scope === 'visit') return;
      return command.mapFromStage ? { ...command, entity: { ...command.entity, map } } : command;
    case 'remove-character':
      if (!command.all) return;
      return command.mapFromStage ? { ...command, map } : command;
    case 'enemy-location':
      if (command.scope === 'visit') return;
      return command.mapFromStage && command.location ? { ...command, location: { ...command.location, map } } : command;
    case 'remove-enemy': return { ...command, map: command.map ?? map };
    case 'actor-visibility': case 'enemy-availability': case 'actor-appearance':
    case 'exit': case 'flag': case 'choice': case 'remove': case 'show': case 'hide': return command;
    default: return;
  }
}

/** 沿选中的剧情节点取持久结果。战斗走胜利出口，选择使用内容指定的答案。 */
function sceneHistory(campaign: Campaign, source: string, step: StoryProgressionStep, entryMap: string,
  nodes: Map<string, Map<string, StoryNode>>, context: StoryConditionContext): HistoryStep {
  const commands: StoryCommand[] = [];
  const localQuests = new Map<string, QuestStatus>(), localFlags = new Map<string, boolean>();
  const choices = new Map<string, string>();
  const branch = { ...context, questStatus: (id: string) => localQuests.get(id) ?? context.questStatus(id),
    flag: (id: string) => localFlags.get(id) ?? context.flag(id), choice: (id: string) => choices.get(id) ?? context.choice(id) };
  let cursor: StoryNodeRef | undefined = { script: source, node: campaign.scripts[source].entry };
  const stack: StoryNodeRef[] = [];
  let map = entryMap, landing: TravelDestination | undefined;
  for (let count = 0; cursor; count++) {
    if (count >= 4096) throw new Error('剧情顺序中的演出未结束：' + source);
    const node: StoryNode = nodes.get(cursor.script)!.get(cursor.node)!;
    for (const action of node.presentation) if (action.type === 'stage') {
      if (!action.mapFromWorld) map = action.map;
      landing = { map, x: action.x, y: action.y, facing: action.facing ?? 'south' };
    }
    for (const action of node.commands) {
      if (action.type === 'quest' && 'quest' in action.command) {
        const { type, quest } = action.command;
        if (type === 'accept') localQuests.set(quest, 'active');
        if (type === 'complete' || type === 'script-complete') localQuests.set(quest, 'completed');
        if (type === 'script-ready') localQuests.set(quest, 'ready');
        if (type === 'reset') localQuests.set(quest, 'available');
        if (type === 'reset' || (type === 'accept' && !step.accept?.includes(quest))) commands.push(action);
      } else if (action.type === 'world') {
        const command = persistentWorldCommand(action.command, map);
        if (command) commands.push({ type: 'world', command });
      } else if (action.type === 'flag') {
        localFlags.set(action.flag, action.value ?? true);
        commands.push(action);
      } else if (action.type === 'choice') {
        choices.set(action.choice, action.value);
        commands.push(action);
      } else if (action.type === 'item-give' || action.type === 'item-take' || action.type === 'party-join'
        || action.type === 'party-leave' || (action.type === 'equip' && action.create) || action.type === 'unequip-destroy') commands.push(action);
    }
    const exit = node.exit;
    switch (exit.type) {
      case 'next': cursor = exit.target; break;
      case 'call': stack.push(exit.then); cursor = exit.target; break;
      case 'branch': cursor = evaluateStoryCondition(exit.condition, branch) ? exit.then : exit.otherwise; break;
      case 'choice': {
        const value = step.choices?.[exit.choice];
        if (!value) throw new Error('剧情顺序缺少选择：' + source + ' ' + exit.choice);
        choices.set(exit.choice, value);
        commands.push({ type: 'choice', choice: exit.choice, value });
        cursor = exit.cases[value] ?? exit.otherwise;
        break;
      }
      case 'waitEncounter': cursor = exit.outcomes.won; break;
      case 'end': cursor = stack.pop(); break;
      case 'defer': cursor = undefined; break;
    }
  }
  return { definition: step, map: entryMap, commands, landing };
}

/** 同一选择可以回到选择地重选；进了哪个分支，就保存进入它时的答案。 */
function entryChoices(condition: StoryCondition | undefined): Extract<StoryCommand, {type:'choice'}>[] {
  if (condition?.type === 'all') return condition.conditions.flatMap(entryChoices);
  return condition?.type === 'choice' ? [{ type: 'choice', choice: condition.choice, value: condition.value }] : [];
}

function historyIndex(campaign: Campaign): HistoryIndex {
  const cached = timelines.get(campaign);
  if (cached) return cached;
  const quests = new Map(campaign.quests.map(q => [q.id, q]));
  const events = new Map(campaign.events.map(e => [e.id, e]));
  const nodes = new Map(Object.entries(campaign.scripts).map(([name, script]) =>
    [name, new Map(script.nodes.map(node => [node.id, node]))]));
  const boundaries = new Map<string, QuestBoundary>(), steps: HistoryStep[] = [], itemIds = new Set<string>();
  const companions = new Set<string>(), outfits: HistoryIndex['outfits'] = new Map();
  const progress = new Map<string, QuestStatus>(), flags = new Map<string, boolean>(), choices = new Map<string, string>();
  const past = new Set<string>();
  const context: StoryConditionContext = {
    questStatus: id => progress.get(id) ?? 'available', flag: id => flags.get(id) ?? false, choice: id => choices.get(id),
    eventStatus: id => past.has(id) ? 'completed' : 'idle', world: () => undefined,
  };
  let map = campaign.start.map;
  for (const definition of campaign.storyProgression?.steps ?? []) {
    const index = steps.length, event = definition.event ? events.get(definition.event) : undefined;
    const source = event?.script ?? definition.script;
    const at = quests.get(definition.deliver?.[0] ?? '')?.places?.ready
      ?? quests.get(definition.accept?.[0] ?? '')?.places?.available;
    map = definition.map ?? event?.map ?? (event?.place?.type === 'fixed' ? event.place.map : undefined)
      ?? (at?.type === 'fixed' ? at.map : map);
    const answers = entryChoices(event?.condition);
    for (const answer of answers) choices.set(answer.choice, answer.value);
    const step: HistoryStep = source ? sceneHistory(campaign, source, definition, map, nodes, context) : { definition, map, commands: [] };
    step.commands.unshift(...answers);
    if (step.landing) map = step.landing.map;
    for (const command of step.commands) {
      if (command.type === 'flag') flags.set(command.flag, command.value ?? true);
      if (command.type === 'choice') choices.set(command.choice, command.value);
      if (command.type === 'item-give' || command.type === 'item-take') itemIds.add(command.item);
      if (command.type === 'party-join' || command.type === 'party-leave') companions.add(command.companion);
      if (command.type === 'equip') outfits.set(command.member + '/' + command.item,
        {type:'unequip-destroy', member:command.member, item:command.item, ifPresent:true});
    }
    for (const id of definition.accept ?? []) {
      boundaries.set(id, { accept: index });
      progress.set(id, quests.get(id)!.completion === 'talk' ? 'ready' : 'active');
    }
    for (const id of definition.ready ?? []) { boundaries.get(id)!.ready = index + 1; progress.set(id, 'ready'); }
    for (const id of definition.deliver ?? []) {
      boundaries.get(id)!.deliver = index;
      progress.set(id, quests.get(id)!.repeat ? 'available' : 'completed');
    }
    for (const action of step.commands) if (action.type === 'quest' && 'quest' in action.command) {
      const id = action.command.quest;
      progress.set(id, action.command.type === 'reset' ? 'available' : quests.get(id)!.completion === 'talk' ? 'ready' : 'active');
    }
    if (event) past.add(event.id);
    steps.push(step);
  }
  for (const quest of quests.values()) {
    for (const entry of [...quest.onAcceptItems ?? [], ...quest.handoverItems ?? []]) itemIds.add(entry.item);
  }
  const index = { steps, boundaries, quests, itemIds, companions, outfits };
  timelines.set(campaign, index);
  return index;
}

export function questJumpHistory(campaign: Campaign, id: string, mode: 'available' | 'active' | 'ready') {
  const { steps, boundaries, quests, itemIds, companions, outfits } = historyIndex(campaign);
  const boundary = boundaries.get(id);
  if (!boundary) throw new Error('剧情顺序缺少任务：' + id);
  const intake = steps[boundary.accept].definition;
  const cut = mode === 'available' ? boundary.accept : mode === 'active' ? boundary.accept + 1
    : boundary.ready ?? boundary.deliver ?? boundary.accept + 1;
  const progress = new Map<string, QuestStatus>(), completedEvents = new Set<string>(), completedQuests = new Set<string>();
  const world: StoryCommand[] = [], choices = new Map<string, string>(), items = new Map<string, number>();
  const inParty = new Set<string>(), equipment = new Map<string, StoryCommand>(outfits);
  for (const key of itemIds) items.set(key, 0);
  const addItem = (key: string, quantity: number) => items.set(key, Math.max(0, (items.get(key) ?? 0) + quantity));
  for (let i = 0; i < cut; i++) {
    const { definition, commands } = steps[i];
    for (const key of definition.accept ?? []) {
      const quest = quests.get(key)!;
      progress.set(key, quest.completion === 'talk' ? 'ready' : 'active');
      for (const entry of quest.onAcceptItems ?? []) addItem(entry.item, entry.quantity);
    }
    for (const key of definition.ready ?? []) progress.set(key, 'ready');
    for (const key of definition.deliver ?? []) {
      const quest = quests.get(key)!;
      completedQuests.add(key);
      progress.set(key, quest.repeat ? 'available' : 'completed');
      for (const entry of quest.handoverItems ?? [])
        if (entry.removal === 'all-matching') items.set(entry.item, 0); else addItem(entry.item, -entry.quantity);
      for (const entry of quest.rewards?.items ?? []) if (itemIds.has(entry.item)) addItem(entry.item, entry.quantity);
    }
    if (definition.event) completedEvents.add(definition.event);
    for (const action of commands) {
      if (action.type === 'choice') choices.set(action.choice, action.value);
      else if (action.type === 'item-give') addItem(action.item, action.quantity);
      else if (action.type === 'item-take') addItem(action.item, -action.quantity);
      else if (action.type === 'party-join') inParty.add(action.companion);
      else if (action.type === 'party-leave') inParty.delete(action.companion);
      else if (action.type === 'equip' || action.type === 'unequip-destroy') equipment.set(action.member + '/' + action.item, action);
      else if (action.type === 'quest' && 'quest' in action.command) {
        const key = action.command.quest, quest = quests.get(key)!;
        if (action.command.type === 'reset') progress.set(key, 'available');
        else {
          if (!['active', 'ready'].includes(progress.get(key) ?? ''))
            for (const entry of quest.onAcceptItems ?? []) addItem(entry.item, entry.quantity);
          progress.set(key, quest.completion === 'talk' ? 'ready' : 'active');
        }
      } else world.push(action);
    }
  }
  const previous = steps[cut - 1];
  for (const companion of companions) world.push({type:inParty.has(companion) ? 'party-join' : 'party-leave', companion});
  world.push(...equipment.values());
  return { intake, progress, completedQuests, completedEvents, choices, items, world,
    intakeCommands: steps[boundary.accept].commands,
    stageMap: steps[mode === 'ready' && boundary.deliver !== undefined ? boundary.deliver : boundary.accept].map,
    destination: mode === 'ready' && previous?.definition.resumeAfterStage === id ? previous.landing : undefined };
}

/** 接取演出可能先把镜头切到另一张图。按那一幕的出场名单找角色在该图的正式摆放。 */
export function prepareIntakeCast(campaign: Campaign, script: string, destination: TravelDestination | undefined,
  history: ReturnType<typeof questJumpHistory>): void {
  const sources = [...history.world, ...history.intakeCommands].reverse();
  const placed = new Set<string>();
  for (const node of campaign.scripts[script].nodes) {
    const stages = node.presentation.filter(action => action.type === 'stage');
    if (node.stage) stages.unshift(node.stage);
    for (const stage of stages) for (const actor of stage.cast) {
      if (actor.memberId || actor.enemyId) continue;
      const map = stage.mapFromWorld ? destination?.map : stage.map;
      const source = sources.find(action => action.type === 'world' && action.command.kind === 'place'
        && action.command.entity.map === map && (actor.worldEntityId ? action.command.entity.id === actor.worldEntityId
          : actor.characterId && action.command.entity.characterId === actor.characterId));
      if (source?.type !== 'world' || source.command.kind !== 'place') continue;
      const entity = source.command.entity;
      if (placed.has(entity.id)) continue;
      placed.add(entity.id);
      history.world.push(source);
      const flag = sources.find(action => action.type === 'flag' && action.flag === entity.id);
      if (flag?.type === 'flag' && flag.value !== false) history.world.push(flag);
    }
  }
}

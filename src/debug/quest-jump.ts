import { prepareIntakeCast, questJumpHistory } from './quest-jump-history.ts';
import type { Campaign, CampaignQuest } from '../domain/campaign.ts';
import type { Facing, QuestStatus, TravelDestination } from '../domain/content.ts';
import type { QuestBookState, QuestProgress, QuestRules } from '../domain/quest-book.ts';
import { evaluateStoryCondition, type StoryCondition } from '../domain/story-condition.ts';
import type { StoryCommand, StoryEvent, StoryPlace } from '../domain/story-graph.ts';
import type { Session } from '../domain/session.ts';
import { encounterSpawnId } from '../domain/world-enemies.ts';
import { storyEquipmentAcquisitionIds } from '../domain/items.ts';

export type QuestStartMode = 'available' | 'active' | 'ready';

const soloInfiltrationStages: readonly { mode: QuestStartMode; label: string }[] = [
  { mode: 'available', label: '独自进城救人' },
  { mode: 'ready', label: '已救出圣女，返回与莱曼汇合' },
];

export function questJumpStages(questId: string): readonly { mode: QuestStartMode; label: string }[] {
  return questId === 'quest-40' ? soloInfiltrationStages : [];
}

export interface QuestAcceptCandidate {
  script: string;
  eventId?: string;
}

export interface QuestStatusChange {
  id: string;
  title: string;
  from: QuestStatus;
  to: QuestStatus;
}

export interface QuestConditionPatch {
  completedQuests: string[];
  quests: { id: string; status: QuestStatus }[];
  choices: { choice: string; value: string }[];
  flags: { flag: string; value: boolean }[];
  completedEvents: string[];
  removedEvents: string[];
  unsatisfied: string[];
}

export interface QuestStartPlan {
  questId: string;
  quest: CampaignQuest;
  mode: QuestStartMode;
  changedQuests: QuestStatusChange[];
  accept?: QuestAcceptCandidate;
  acceptAlternatives: QuestAcceptCandidate[];
  conditionPatch: QuestConditionPatch;
  /** 所选时间点的人物、机关、剧情伙伴和剧情伪装。 */
  worldCommands: StoryCommand[];
  storyItems: { item: string; quantity: number }[];
  destination?: TravelDestination;
  warnings: string[];
  /** 请求可接取，但目标没有接取入口，实际按进行中开始。 */
  fallback: boolean;
}

interface AcceptCandidate extends QuestAcceptCandidate {
  event?: StoryEvent;
}

interface Spot {
  map: string;
  x: number;
  y: number;
  facing?: Facing;
}

const SOURCE_RANK: Record<string, number> = {
  quest: 0, region: 1, near: 2, interaction: 3, choice: 4,
  'map-entry': 5, battle: 6, inventory: 7, event: 8, start: 9,
};

const emptyPatch = (): QuestConditionPatch => ({
  quests: [], choices: [], flags: [], completedQuests: [], completedEvents: [], removedEvents: [], unsatisfied: [],
});

const clonePatch = (patch: QuestConditionPatch): QuestConditionPatch => ({
  quests: patch.quests.map(entry => ({ ...entry })),
  choices: patch.choices.map(entry => ({ ...entry })),
  flags: patch.flags.map(entry => ({ ...entry })),
  completedQuests: [...patch.completedQuests],
  completedEvents: [...patch.completedEvents],
  removedEvents: [...patch.removedEvents],
  unsatisfied: [...patch.unsatisfied],
});

function placementCovers(placement: Campaign['placements'][number], quest: CampaignQuest): boolean {
  return (placement.characterId !== undefined
    && (placement.characterId === quest.giverCharacterId || placement.characterId === quest.deliveryCharacterId))
    || (placement.actor !== undefined
      && (placement.actor === quest.giver || placement.actor === quest.delivery));
}

/** 发布者/交付者可能出现的地图；任务地点有多个候选时优先能放下 NPC 的那张。 */
function npcMaps(campaign: Campaign, quest: CampaignQuest): ReadonlySet<string> {
  return new Set(campaign.placements
    .filter(placement => placementCovers(placement, quest))
    .map(placement => placement.map));
}

function questOf(campaign: Campaign, questId: string): CampaignQuest | undefined {
  return campaign.quests.find(quest => quest.id === questId);
}

const intakeIndexes = new WeakMap<Campaign, Map<string, AcceptCandidate[]>>();

function questIntakes(campaign: Campaign): Map<string, AcceptCandidate[]> {
  const cached = intakeIndexes.get(campaign);
  if (cached) return cached;
  const index = new Map<string, AcceptCandidate[]>();
  const eventsByScript = new Map<string, StoryEvent[]>();
  for (const event of campaign.events) {
    const entries = eventsByScript.get(event.script) ?? [];
    entries.push(event);
    eventsByScript.set(event.script, entries);
  }
  for (const [name, script] of Object.entries(campaign.scripts)) {
    const accepted = new Set<string>();
    for (const node of script.nodes) for (const command of node.commands)
      if (command.type === 'quest' && command.command.type === 'accept') accepted.add(command.command.quest);
    if (!accepted.size) continue;
    const events = eventsByScript.get(name);
    const sources = events?.map(event => ({ script: name, eventId: event.id, event })) ?? [{ script: name }];
    for (const id of accepted) {
      const candidates = index.get(id) ?? [];
      candidates.push(...sources);
      index.set(id, candidates);
    }
  }
  intakeIndexes.set(campaign, index);
  return index;
}

function acceptCandidates(campaign: Campaign, session: Session, questId: string): AcceptCandidate[] {
  const candidates = [...(questIntakes(campaign).get(questId) ?? [])];
  return candidates.sort((left, right) => {
    const leftReady = left.event ? (!left.event.condition || session.evaluateCondition(left.event.condition)) : false;
    const rightReady = right.event ? (!right.event.condition || session.evaluateCondition(right.event.condition)) : false;
    if (leftReady !== rightReady) return leftReady ? -1 : 1;
    const leftSource = left.event ? SOURCE_RANK[left.event.source] ?? 99 : 100;
    const rightSource = right.event ? SOURCE_RANK[right.event.source] ?? 99 : 100;
    if (leftSource !== rightSource) return leftSource - rightSource;
    const leftIndex = left.event ? campaign.events.indexOf(left.event) : Number.MAX_SAFE_INTEGER;
    const rightIndex = right.event ? campaign.events.indexOf(right.event) : Number.MAX_SAFE_INTEGER;
    if (leftIndex !== rightIndex) return leftIndex - rightIndex;
    return left.script.localeCompare(right.script);
  });
}

function pushQuestPatch(patch: QuestConditionPatch, id: string, status: QuestStatus): void {
  const existing = patch.quests.findIndex(entry => entry.id === id);
  if (existing >= 0) patch.quests[existing] = { id, status };
  else patch.quests.push({ id, status });
}

function plannedContext(session: Session, patch: QuestConditionPatch) {
  const original = session.conditionContext();
  return {
    ...original,
    questStatus: (id: string) => patch.quests.find(entry => entry.id === id)?.status ?? original.questStatus(id),
    questCompletedCycles: (id: string) => Number(patch.completedQuests.includes(id)),
    choice: (id: string) => patch.choices.find(entry => entry.choice === id)?.value,
    flag: (id: string) => patch.flags.find(entry => entry.flag === id)?.value ?? false,
    eventStatus: (id: string) => patch.removedEvents.includes(id) ? 'idle' as const
      : patch.completedEvents.includes(id) ? 'completed' as const : original.eventStatus(id),
  };
}

/** 逐叶补接取剧情自己的条件；只补这一段剧情需要的任务/选择/标志/事件。 */
function satisfyCondition(condition: StoryCondition | undefined, session: Session, patch: QuestConditionPatch): boolean {
  if (!condition) return true;
  const context = plannedContext(session, patch);
  if (evaluateStoryCondition(condition, context)) return true;
  switch (condition.type) {
    case 'always':
      if (condition.value) return true;
      patch.unsatisfied.push('always=false');
      return false;
    case 'all': {
      let ok = true;
      for (const child of condition.conditions) if (!satisfyCondition(child, session, patch)) ok = false;
      return ok;
    }
    case 'any': {
      for (const child of condition.conditions) {
        const trial = clonePatch(patch);
        if (satisfyCondition(child, session, trial)) { Object.assign(patch, trial); return true; }
      }
      patch.unsatisfied.push('any 没有可满足的分支');
      return false;
    }
    case 'not': {
      const child = condition.condition;
      if (child.type === 'flag') return satisfyCondition({ ...child, value: !(child.value ?? true) }, session, patch);
      patch.unsatisfied.push(`无法让否定条件成立：${condition.type}`);
      return false;
    }
    case 'quest': {
      const current = context.questStatus(condition.quest);
      if (condition.status === 'accepted') {
        if (['active', 'ready', 'completed'].includes(current)) return true;
        pushQuestPatch(patch, condition.quest, 'active');
        return true;
      }
      if (condition.status === 'settled') {
        if (current === 'completed' || (context.questCompletedCycles?.(condition.quest) ?? 0) > 0) return true;
        pushQuestPatch(patch, condition.quest, 'completed');
        return true;
      }
      if (current === condition.status) return true;
      if (condition.status === 'locked') {
        patch.unsatisfied.push(`任务 ${condition.quest} 需要保持锁定`);
        return false;
      }
      pushQuestPatch(patch, condition.quest, condition.status);
      return true;
    }
    case 'choice': {
      const current = context.choice(condition.choice);
      if (current === condition.value) return true;
      const existing = patch.choices.findIndex(entry => entry.choice === condition.choice);
      if (existing >= 0) patch.choices[existing] = { choice: condition.choice, value: condition.value };
      else patch.choices.push({ choice: condition.choice, value: condition.value });
      return true;
    }
    case 'flag': {
      const value = condition.value ?? true;
      if (context.flag(condition.flag) === value) return true;
      const existing = patch.flags.findIndex(entry => entry.flag === condition.flag);
      if (existing >= 0) patch.flags[existing] = { flag: condition.flag, value };
      else patch.flags.push({ flag: condition.flag, value });
      return true;
    }
    case 'event': {
      const current = context.eventStatus(condition.event);
      if (current === condition.status) return true;
      if (condition.status === 'completed') {
        patch.removedEvents = patch.removedEvents.filter(id => id !== condition.event);
        if (!patch.completedEvents.includes(condition.event)) patch.completedEvents.push(condition.event);
        return true;
      }
      if (condition.status === 'idle') {
        patch.completedEvents = patch.completedEvents.filter(id => id !== condition.event);
        if (!patch.removedEvents.includes(condition.event)) patch.removedEvents.push(condition.event);
        return true;
      }
      patch.unsatisfied.push(`事件 ${condition.event} 需要处于 ${condition.status}`);
      return false;
    }
    case 'world':
      patch.unsatisfied.push(`不支持世界条件：${condition.key}`);
      return false;
  }
}

function spotOf(place: StoryPlace | undefined,
  current: { map: string; x: number; y: number; facing: Facing } | undefined,
  preferredMaps?: ReadonlySet<string>): Spot | undefined {
  if (!place) return undefined;
  if (place.type === 'fixed') return { map: place.map, x: place.x, y: place.y };
  if (place.type === 'alternatives') {
    const spots = place.spots;
    const preferred = spots.filter(spot => preferredMaps?.has(spot.map));
    return preferred.find(spot => spot.map === current?.map)
      ?? preferred[0]
      ?? spots.find(spot => spot.map === current?.map)
      ?? spots[0];
  }
  if (place.type === 'current') return current ? { ...current } : undefined;
  return undefined;
}

function giverSpot(campaign: Campaign, session: Session, quest: CampaignQuest): Spot | undefined {
  const placements = campaign.placements.filter(placement => placementCovers(placement, quest));
  const visible = placements.find(placement => session.evaluateCondition(placement.condition)) ?? placements[0];
  return visible ? { map: visible.map, x: visible.x, y: visible.y, facing: visible.facing } : undefined;
}

function resolveDestination(campaign: Campaign, session: Session, quest: CampaignQuest,
  accept: AcceptCandidate | undefined, mode: QuestStartMode, stageMap?: string): TravelDestination | undefined {
  const current = session.storyWorld.currentLocation;
  const place = accept?.event?.place;
  const location = current ? { ...current } : undefined;
  // 接取事件的 `place` 常是 `current`（它继承前置任务完成时的位置），不能拿它当任务起点；
  // 这种情况下优先用任务自己的阶段地点，只有任务也没有具体地点时才留在当前图。
  const eventSpot = place?.type === 'current' ? undefined : place?.type === 'alternatives'
    ? place.spots.find(spot => spot.map === stageMap) : spotOf(place, location);
  const stagePlace = mode === 'available'
    ? quest.places?.available
    : mode === 'ready' ? quest.places?.ready ?? quest.places?.active : quest.places?.active;
  const stageSpot = (stagePlace?.type === 'alternatives' ? stagePlace.spots.find(spot => spot.map === stageMap) : undefined)
    ?? spotOf(stagePlace, stagePlace?.type === 'current' ? location : undefined, npcMaps(campaign, quest));
  const spot: Spot | undefined = eventSpot ?? stageSpot ?? (place?.type === 'current' ? location : undefined)
    ?? giverSpot(campaign, session, quest);
  if (!spot) {
    // `places.available.type === 'current'`：留在当前地图。
    if (current) return { map: current.map, x: current.x, y: current.y, facing: current.facing };
    return undefined;
  }
  return { map: spot.map, x: spot.x, y: spot.y, facing: spot.facing ?? 'south' };
}

/** 目的地确定后，把同图发布者/交付者 placement 的显示条件补进计划；flag 驱动的 NPC 才会出现。 */
function satisfyNpcPlacements(campaign: Campaign, session: Session, quest: CampaignQuest,
  destination: TravelDestination | undefined, patch: QuestConditionPatch): void {
  if (!destination) return;
  for (const placement of campaign.placements) {
    if (placement.map !== destination.map || !placementCovers(placement, quest)) continue;
    satisfyCondition(placement.condition, session, patch);
  }
}

/** 规划一次“从可接取开始”的剧情跳转；只读，不改会话。 */
export function planQuestStart(campaign: Campaign, session: Session, questId: string,
  requestedMode: QuestStartMode = 'available'): QuestStartPlan {
  const quest = questOf(campaign, questId);
  if (!quest) throw new Error(`未找到任务：${questId}`);
  const candidates = acceptCandidates(campaign, session, questId);
  const internal = quest.completion === 'internal';
  const place = quest.places?.available;
  const fallback = requestedMode === 'available' && (internal || (!candidates.length && (!place || place.type === 'unavailable')));
  let mode: QuestStartMode = fallback ? 'active' : requestedMode;
  if (mode === 'active' && quest.completion === 'talk') mode = 'ready';
  const history = questJumpHistory(campaign, questId, mode);
  const intake = candidates.find(entry => history.intake.event ? entry.eventId === history.intake.event
    : entry.script === history.intake.script);
  const accept = mode === 'available' ? intake : undefined;
  const destination = history.destination ?? resolveDestination(campaign, session, quest, accept, mode, history.stageMap);
  if (accept) prepareIntakeCast(campaign, accept.script, destination, history);
  const conditionPatch = emptyPatch();
  conditionPatch.completedQuests = [...history.completedQuests];
  conditionPatch.completedEvents = [...history.completedEvents];
  conditionPatch.removedEvents = campaign.events.filter(event => !history.completedEvents.has(event.id)).map(event => event.id);
  conditionPatch.choices = [...history.choices].map(([choice, value]) => ({ choice, value }));
  const flags = new Map<string, boolean>();
  for (const command of history.world) if (command.type === 'flag') flags.set(command.flag, command.value ?? true);
  conditionPatch.flags = [...flags].map(([flag, value]) => ({ flag, value }));
  conditionPatch.quests = campaign.quests.map(q => ({ id: q.id, status: history.progress.get(q.id) ?? 'available' }));
  const context = plannedContext(session, conditionPatch);
  for (const [index, entry] of conditionPatch.quests.entries()) {
    const q = campaign.quests[index];
    if (entry.status === 'available' && (q.completion === 'internal' || !evaluateStoryCondition(q.availableWhen, context)))
      entry.status = 'locked';
  }
  if (mode === 'available') {
    satisfyCondition(quest.availableWhen, session, conditionPatch);
    satisfyCondition(accept?.event?.condition, session, conditionPatch);
  }
  satisfyNpcPlacements(campaign, session, quest, destination, conditionPatch);
  const warnings: string[] = [];
  if (mode === 'available') {
    const final = clonePatch(conditionPatch);
    pushQuestPatch(final, questId, 'available');
    const atEntry = plannedContext(session, final);
    if (!evaluateStoryCondition(quest.availableWhen, atEntry) || !evaluateStoryCondition(accept?.event?.condition, atEntry))
      conditionPatch.unsatisfied.push('合并任务与现场状态后，正式接取条件仍未满足');
  }
  if (fallback) warnings.push('没有可接取入口，已从任务开始后的阶段进入');
  if (conditionPatch.unsatisfied.length) warnings.push('接取剧情有无法自动补齐的条件：' + conditionPatch.unsatisfied.join('，'));
  if (!destination) warnings.push('没有找到任务开始位置');
  const changedQuests: QuestStatusChange[] = [];
  for (const [index, entry] of conditionPatch.quests.entries()) {
    const to = entry.id === questId ? mode : entry.status;
    const from = session.status(entry.id);
    if (to !== from) changedQuests.push({ id: entry.id, title: campaign.quests[index].title, from, to });
  }
  const storyItems = [...history.items].filter(([item]) => session.bag.catalog.items[item]?.category === 'quest')
    .map(([item, quantity]) => ({ item, quantity }));
  return { questId, quest, mode, changedQuests, accept: accept && { script: accept.script, eventId: accept.eventId },
    acceptAlternatives: (intake ? [intake, ...candidates.filter(candidate => candidate !== intake)] : candidates)
      .map(({ script, eventId }) => ({ script, eventId })),
    conditionPatch, worldCommands: history.world,
    storyItems, destination, warnings, fallback };
}

function zeroGoals(quest: QuestRules): Record<string, number> {
  return Object.fromEntries(quest.goals.map(goal => [goal.id, 0]));
}

function fullGoals(quest: QuestRules): Record<string, number> {
  return Object.fromEntries(quest.goals.map(goal => [goal.id, goal.quantity]));
}

function patchedProgress(quest: QuestRules, current: QuestProgress, status: QuestStatus, delivered: boolean): QuestProgress {
  const completedCycles = delivered ? Math.max(1, current.completedCycles) : 0;
  const cycle = delivered && status !== 'completed' ? Math.max(1, current.cycle + Number(current.status === 'completed'))
    : current.cycle + (current.completedCycles > 0 && !delivered ? 1 : 0);
  return { status, cycle, completedCycles, goals: status === 'completed' || status === 'ready' ? fullGoals(quest) : zeroGoals(quest) };
}

/**
 * 把计划写进会话：任务簿、选择/标志和运行时事件。
 * 这里不切图、不开演；调用方负责先暂停触发，再传送和播放。
 */
export function applyQuestStartPlan(session: Session, plan: QuestStartPlan): void {
  const { quest, mode, conditionPatch } = plan;
  const currentWorld = session.storyWorld.captureState();
  const completedEvents = new Set(conditionPatch.completedEvents);
  for (const event of session.campaign.events) if (event.source === 'start') completedEvents.add(event.id);
  if (plan.accept?.eventId) completedEvents.delete(plan.accept.eventId);
  // 导演的等待节点引用战斗实例。先结束旧时间点的运行，再一起撤下实例与死亡记录。
  session.runtimeState = { ...session.runtimeState, completedEvents: [...completedEvents],
    runs: [], pendingOccurrences: [], handledOccurrences: [], occurrenceSequences: [], encounterResults: [] };
  for (const encounter of currentWorld.encounters) for (const spawn of encounter.spawns)
    session.forgetEnemyVitals(encounterSpawnId(encounter.id, spawn.id));
  for (const entity of currentWorld.entities) if (entity.removed) session.forgetEnemyVitals(entity.id);
  for (const enemy of currentWorld.enemyLocations ?? []) session.forgetEnemyVitals(enemy.id);
  session.storyWorld.restoreState({ location: currentWorld.location, mapVisit: currentWorld.mapVisit,
    entities: [], flags: [], choices: [], exits: [], encounters: [] });

  session.questBook.clearDebugOverrides();
  const delivered = new Set(conditionPatch.completedQuests);
  delivered.delete(quest.id);
  session.retainQuestSettlements(delivered);
  const current = session.questBook.captureState();
  const desired = new Map(conditionPatch.quests.map(entry => [entry.id, entry.status]));
  desired.set(quest.id, quest.completion === 'internal' ? 'locked' : 'available');
  const runningQuestIds: string[] = [];
  const states: QuestBookState['quests'] = current.quests.map(([id, previous]) => {
    const status = desired.get(id)!;
    if (status === 'active' || status === 'ready') runningQuestIds.push(id);
    return [id, patchedProgress(session.questBook.definition(id)!, previous, status, delivered.has(id))];
  });
  session.questBook.installTrustedState({ ...current, quests: states, runningQuestIds });
  if (quest.completion !== 'internal') session.questBook.forceAvailable(quest.id, true);

  const commands: StoryCommand[] = [...plan.worldCommands.filter(action => {
    if (action.type === 'party-join' || action.type === 'party-leave')
      return session.party && !!session.party.get('story-' + action.companion) !== (action.type === 'party-join');
    if (action.type === 'equip' || action.type === 'unequip-destroy') {
      if (!storyEquipmentAcquisitionIds(session.bag.catalog).has(action.item)) return false;
      const wearing = Object.values(session.bag.equipmentItems(session.bag.equipmentFor(action.member))).includes(action.item);
      return wearing !== (action.type === 'equip');
    }
    return true;
  }),
    ...conditionPatch.flags.map(entry => ({ type: 'flag' as const, flag: entry.flag, value: entry.value })),
    ...conditionPatch.choices.map(entry => ({ type: 'choice' as const, choice: entry.choice, value: entry.value })),
  ];
  if (commands.length) session.applyStoryCommands(commands);
  if (mode !== 'available') {
    session.applyStoryCommands([{ type: 'quest', command: { type: 'accept', quest: quest.id,
      ...(quest.completion === 'internal' ? { source: 'script' as const } : {}) } }]);
  }
  // 剧情专用道具恢复到实际数量，普通素材只补此次交接确实要交出的部分。
  for (const { item, quantity } of plan.storyItems) {
    const delta = quantity - session.bag.count(item);
    if (delta > 0) session.bag.add(item, delta);
    if (delta < 0) session.bag.remove(item, -delta);
  }
  const ready = conditionPatch.quests.filter(entry => entry.status === 'ready' && entry.id !== quest.id).map(entry => entry.id);
  if (mode === 'ready') ready.push(quest.id);
  for (const id of ready) {
    const definition = session.questBook.definition(id)!;
    const required = [...definition.handoverItems ?? [],
      ...definition.goals.filter(goal => goal.kind === 'item').map(goal => ({ item: goal.target, quantity: goal.quantity }))];
    for (const entry of required) {
      const missing = entry.quantity - session.bag.count(entry.item);
      if (missing > 0) session.bag.add(entry.item, missing);
    }
  }
  if (mode === 'ready' && session.status(quest.id) !== 'ready') {
    if (quest.completion === 'all') {
      const snapshot = session.questBook.captureState();
      const entry = snapshot.quests.find(([id]) => id === quest.id)!;
      entry[1] = patchedProgress(quest, entry[1], 'ready', false);
      session.questBook.installTrustedState(snapshot);
    } else session.applyStoryCommands([{ type: 'quest', command: { type: 'script-ready', quest: quest.id } }]);
  }
  for (const entry of conditionPatch.quests) {
    if (entry.id === quest.id || (entry.status !== 'active' && entry.status !== 'ready')) continue;
    const state = states.find(([id]) => id === entry.id)![1];
    session.questBook.forceProgress(entry.id, state);
  }
  session.questBook.commit(session.questBook.plan({ type: 'refresh' }));
  session.emit();
}

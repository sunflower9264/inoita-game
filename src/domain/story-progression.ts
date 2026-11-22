import type { Campaign, CampaignQuest, StoryProgressionStep } from './campaign.ts';
import type { QuestStatus } from './content.ts';
import type { StoryCondition } from './story-condition.ts';
import { evaluateStoryCondition } from './story-condition.ts';
import type { StoryCommand, StoryEvent, StoryNode, StoryNodeRef, StoryPlace, StoryScript } from './story-graph.ts';

/**
 * 调试跳转需要的正式游玩顺序。
 *
 * 这里不维护任何手写时间线：顺序、接取、待交付和交付都从任务定义和剧情脚本推导。
 * 推导过程按内容里的实际控制流走一遍：满足条件的自动事件先演，区域／近身事件按内容顺序补演，
 * 没有剧情入口的任务在发布者或交付对象处接取和交付。推导结果只服务调试跳转，正式游玩不读取。
 */
export interface StoryProgression { steps: StoryProgressionStep[]; ongoing: string[] }

interface GenState {
  status: Map<string, QuestStatus>;
  completedEvents: Set<string>;
  choices: Map<string, string>;
  /** 一个任务只在第一次接取／待交付／交付时记边界，重复周期沿用第一次的时间点。 */
  opened: Set<string>;
  ready: Set<string>;
  delivered: Set<string>;
}

interface StageLanding { map: string; x: number; y: number }

interface WalkResult {
  ok: boolean;
  reason?: string;
  state: GenState;
  accept: string[];
  ready: string[];
  deliver: string[];
  choices: Record<string, string>;
  landing?: StageLanding;
}

interface TransitionNode {
  kind: 'accept' | 'deliver';
  quest: string;
  script?: string;
  /** `next:A:B` 只能在 A 交付后接取 B。 */
  after?: string;
}

const MAX_WALK_NODES = 4096;

export function deriveStoryProgression(campaign: Campaign, trace?: (message: string) => void): StoryProgression {
  const quests = new Map(campaign.quests.map(quest => [quest.id, quest]));
  const events = new Map(campaign.events.map(event => [event.id, event]));
  const eventIndex = new Map(campaign.events.map((event, index) => [event.id, index]));
  const questIndex = new Map(campaign.quests.map((quest, index) => [quest.id, index]));
  const scripts = campaign.scripts;

  const staticCommands = memo((name: string) => reachableCommands(scripts, name));
  const acceptors = new Map<string, Set<string>>();
  const completers = new Map<string, Set<string>>();
  for (const event of campaign.events) {
    for (const command of staticCommands(event.script)) {
      if (command.type !== 'quest' || !('quest' in command.command)) continue;
      const type = command.command.type;
      const questId = command.command.quest;
      if (type === 'accept' && !conditionRequiresQuest(event.condition, questId))
        addSet(acceptors, questId, event.id);
      if ((type === 'complete' || type === 'script-complete')
        && !conditionRequiresQuest(event.condition, questId, new Set(['completed', 'settled'])))
        addSet(completers, questId, event.id);
    }
  }
  /** 有任务命令的事件会真正推进故事，条件按准确状态判断；纯演出事件可以补演。 */
  const eventHasQuestCommands = new Set<string>();
  for (const event of campaign.events) {
    if (staticCommands(event.script).some(command => command.type === 'quest'))
      eventHasQuestCommands.add(event.id);
  }
  const strictEvent = (eventId: string): boolean =>
    events.get(eventId)!.repeat === true || eventHasQuestCommands.has(eventId);

  const sharedAccepts = new Map<string, string[]>();
  for (const name of Object.keys(scripts)) {
    if (name.startsWith('event-')) continue;
    for (const command of staticCommands(name)) {
      if (command.type === 'quest' && command.command.type === 'accept' && 'quest' in command.command)
        pushMap(sharedAccepts, command.command.quest, name);
    }
  }
  const completionCounts = new Map<string, number>();
  for (const event of campaign.events) {
    let count = 0;
    for (const command of staticCommands(event.script))
      if (command.type === 'quest' && (command.command.type === 'complete' || command.command.type === 'script-complete')) count++;
    completionCounts.set(event.id, count);
  }
  const acceptCounts = new Map<string, number>();
  for (const event of campaign.events) {
    let count = 0;
    for (const command of staticCommands(event.script))
      if (command.type === 'quest' && command.command.type === 'accept') count++;
    acceptCounts.set(event.id, count);
  }

  // 条件里写明的选择值需要有剧情真正写出这个值；否则事件永远不会触发。
  const acceptSets = new Map<string, Set<string>>(), completeSets = new Map<string, Set<string>>();
  for (const event of campaign.events) {
    for (const command of staticCommands(event.script)) {
      if (command.type !== 'quest' || !('quest' in command.command)) continue;
      if (command.command.type === 'accept') addSet(acceptSets, event.id, command.command.quest);
      if (command.command.type === 'complete' || command.command.type === 'script-complete')
        addSet(completeSets, event.id, command.command.quest);
    }
  }
  const choiceWriters = new Map<string, Map<string, string[]>>();
  for (const event of campaign.events) {
    for (const command of staticCommands(event.script)) {
      if (command.type !== 'choice') continue;
      let values = choiceWriters.get(command.choice) ?? new Map<string, string[]>();
      pushMap(values, command.value, event.id);
      choiceWriters.set(command.choice, values);
    }
    for (const exit of staticChoiceExits(scripts[event.script]))
      for (const value of Object.keys(exit.cases)) {
        let values = choiceWriters.get(exit.choice) ?? new Map<string, string[]>();
        pushMap(values, value, event.id);
        choiceWriters.set(exit.choice, values);
      }
  }
  /** 写选择的事件若要求“消费者自己才创建的任务状态”，它只能发生在消费者之后，不能当铺垫。 */
  function writerRunsAfter(writer: string, consumer: StoryEvent): boolean {
    const accepted = acceptSets.get(consumer.id) ?? new Set<string>();
    const completed = completeSets.get(consumer.id) ?? new Set<string>();
    return positiveQuestReferences(events.get(writer)!.condition).some(ref => {
      if (accepted.has(ref.quest) && ['active', 'ready', 'accepted'].includes(ref.status)) return true;
      if (completed.has(ref.quest) && ['completed', 'settled'].includes(ref.status)) return true;
      return false;
    });
  }

  const ongoing = new Set<string>();
  for (const quest of campaign.quests) {
    const hasCompleter = completers.has(quest.id) || !!quest.completeScript;
    if (!hasCompleter && quest.completion === 'story' && quest.journal === false
      && !quest.delivery && !quest.deliveryCharacterId) ongoing.add(quest.id);
  }

  /** 一次性事件全演；重复事件只在能补上接取／交付或解锁所需选择时加入。 */
  const requiredEvents = new Set<string>();
  for (const event of campaign.events) if (!event.repeat) requiredEvents.add(event.id);

  /** 战后事件要等对应遭遇被剧情准备出来；否则会在一开场就“打完”首领。 */
  const encounterEvents = new Map<string, Set<string>>();
  for (const event of campaign.events) {
    for (const enemyId of reachableEncounterEnemies(scripts, event.script))
      addSet(encounterEvents, enemyId, event.id);
  }
  const battlePrerequisites = new Map<string, Set<string>>();
  for (const event of campaign.events) {
    if (event.source !== 'battle' || !event.key) continue;
    const enemyId = battleEnemyId(event.key);
    if (!enemyId) continue;
    const candidates = [...encounterEvents.get(enemyId) ?? []].filter(id => id !== event.id);
    if (!candidates.length) continue;
    const first = bestEvent(candidates, id => eventIndex.get(id) ?? 0);
    const set = battlePrerequisites.get(event.id) ?? new Set<string>();
    set.add(first);
    battlePrerequisites.set(event.id, set);
    if (!event.repeat) requiredEvents.add(first);
  }
  for (const quest of campaign.quests) {
    // 接取／交付入口不能依赖更靠后的任务，否则会形成先有鸡还是先有蛋的循环。
    // 例如记忆关卡里，批量接取事件要求后面几个小任务已经完成，真正先发生的是各分支的接取事件。
    const acceptCandidates = [...acceptors.get(quest.id) ?? []];
    if (acceptCandidates.length) {
      const best = bestEvent(acceptCandidates, event => downstreamScore(events.get(event)!.condition, quest.id),
        event => acceptCounts.get(event) ?? 0, event => eventIndex.get(event) ?? 0);
      requiredEvents.add(best);
    }
    if (ongoing.has(quest.id)) continue;
    const completeCandidates = [...completers.get(quest.id) ?? []];
    if (completeCandidates.length) {
      const best = bestEvent(completeCandidates, event => downstreamScore(events.get(event)!.condition, quest.id),
        event => completionCounts.get(event) ?? 0, event => eventIndex.get(event) ?? 0);
      requiredEvents.add(best);
    }
  }
  // 重复任务的收尾重置：完成一轮后把任务放回可接取，供下一轮使用。
  for (const event of campaign.events) {
    if (!event.repeat || eventReferences(event.condition).length) continue;
    const resets = staticCommands(event.script).some(command => command.type === 'quest'
      && command.command.type === 'reset');
    if (resets) requiredEvents.add(event.id);
  }
  // 事件条件里的选择值由这一步自己写入（和历史重放一致），不需要额外找“写选择”的事件。
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of [...requiredEvents]) {
      const event = events.get(id)!;
      for (const ref of eventReferences(event.condition)) {
        if (!requiredEvents.has(ref)) { requiredEvents.add(ref); changed = true; }
      }
      for (const ref of battlePrerequisites.get(id) ?? []) {
        if (!requiredEvents.has(ref)) { requiredEvents.add(ref); changed = true; }
      }
      for (const ref of choiceReferences(event.condition)) {
        const writers = choiceWriters.get(ref.choice)?.get(ref.value) ?? [];
        if (writers.some(writer => requiredEvents.has(writer))) continue;
        const viable = writers.filter(writer => !writerRunsAfter(writer, event));
        const add = bestEvent(viable, writer => downstreamScore(events.get(writer)!.condition, ''),
          writer => acceptCounts.get(writer) ?? 0, writer => eventIndex.get(writer) ?? 0);
        if (add && !requiredEvents.has(add)) { requiredEvents.add(add); changed = true; }
      }
    }
  }

  const nextAccepts: TransitionNode[] = [];
  for (const [questId, names] of sharedAccepts) {
    if (acceptors.has(questId)) continue;
    const quest = quests.get(questId)!;
    const script = quest.offerScript && names.includes(quest.offerScript) ? quest.offerScript
      : names.find(name => name.startsWith('next:') && name.endsWith(':' + questId)) ?? names[0];
    const match = /^next:([^:]+):(.+)$/.exec(script);
    nextAccepts.push({ kind: 'accept', quest: questId, script, after: match?.[2] === questId ? match[1] : undefined });
  }
  const standaloneAccepts: TransitionNode[] = [];
  const deliverNodes: TransitionNode[] = [];
  for (const quest of campaign.quests) {
    if (!acceptors.has(quest.id) && !sharedAccepts.has(quest.id))
      standaloneAccepts.push({ kind: 'accept', quest: quest.id });
    if (ongoing.has(quest.id)) continue;
    const talkToNpc = quest.completion === 'talk' && !!(quest.delivery || quest.deliveryCharacterId);
    const eventCompleters = [...completers.get(quest.id) ?? []];
    const eventCovers = !talkToNpc && eventCompleters.some(id => requiredEvents.has(id));
    if (!eventCovers) {
      if (quest.completeScript && !talkToNpc) deliverNodes.push({ kind: 'deliver', quest: quest.id, script: quest.completeScript });
      else if (!eventCompleters.length || talkToNpc) deliverNodes.push({ kind: 'deliver', quest: quest.id });
    }
  }

  // 初始状态：所有普通任务可接取，内部任务锁定；未接取前不假定任何剧情已经发生。
  const initial: GenState = {
    status: new Map(campaign.quests.map(quest => [quest.id, quest.completion === 'internal' ? 'locked' : 'available'])),
    completedEvents: new Set(),
    choices: new Map(),
    opened: new Set(),
    ready: new Set(),
    delivered: new Set(),
  };

  const steps: StoryProgressionStep[] = [];
  const boundaries = new Map<string, { accept: number; ready?: number; deliver?: number }>();
  const processedEvents = new Set<string>();
  const completedAccepts = new Set<string>();
  const completedDelivers = new Set<string>();
  let state = initial;
  const allQuestsOpened = (): boolean => campaign.quests.every(quest => state.opened.has(quest.id));
  const allDelivered = (): boolean => campaign.quests.every(quest => ongoing.has(quest.id) || state.delivered.has(quest.id));
  const allEventsSeen = (): boolean => campaign.events.every(event => event.repeat || processedEvents.has(event.id));

  for (let guard = 0; guard < 20000; guard++) {
    if (allQuestsOpened() && allDelivered() && allEventsSeen()) break;

    let entry = chooseStep();
    if (!entry) {
      // 所有入口都被任务状态挡住时，先把真正卡住后续步骤的已接取任务补成待交付。
      if (insertReady()) continue;
      // 任务推进仍卡住时，补演条件里写明选择值的剧情分支。
      entry = choosePinned();
      if (!entry) throw new Error('无法从正式内容推导调试游玩顺序：' + blockedSummary());
    }
    if (entry.kind === 'event') { trace?.('步骤 ' + steps.length + ' 事件 ' + entry.eventId); processEvent(entry.eventId); }
    else if (entry.kind === 'ready') { trace?.('步骤 ' + steps.length + ' 待交付 ' + entry.questId); processReady(entry.questId); }
    else if (entry.kind === 'accept') { trace?.('步骤 ' + steps.length + ' 接取 ' + entry.node.quest + (entry.node.script ? ' @' + entry.node.script : '')); processAccept(entry.node); }
    else { trace?.('步骤 ' + steps.length + ' 交付 ' + entry.node.quest + (entry.node.script ? ' @' + entry.node.script : '')); processDeliver(entry.node); }
  }

  const result: StoryProgression = {
    steps,
    ongoing: [...ongoing],
  };
  return result;

  // ---- 选择下一步 ----

  interface EventCandidate { kind: 'event'; eventId: string; index: number; walk: WalkResult }
  interface NodeCandidate { kind: 'accept' | 'deliver'; node: TransitionNode; index: number; walk?: WalkResult }
  interface ReadyCandidate { kind: 'ready'; questId: string; index: number }
  type Candidate = EventCandidate | NodeCandidate | ReadyCandidate;

  /** 最后一招：任务推进都卡住时，补演条件里写明选择值的剧情（记忆关卡的重看分支）。 */
  function choosePinned(): Candidate | undefined {
    const pendingNeeds = pendingStrictNeeds();
    const activeNeeds = pendingActiveNeeds();
    const blocked = (walk: WalkResult, selfEventId: string): boolean =>
      [...walk.ready, ...walk.deliver].some(questId => {
        if (pendingActiveBlocks(questId, selfEventId, activeNeeds)) return true;
        if (!walk.deliver.includes(questId)) return false;
        return (pendingNeeds.get(questId) ?? []).some(need => need.eventId !== selfEventId
          && (need.status === 'active' || need.status === 'ready'));
      });
    let best: Candidate | undefined;
    for (const eventId of requiredEvents) {
      if (processedEvents.has(eventId)) continue;
      const event = events.get(eventId)!;
      if (!coarseCondition(event.condition, state, !strictEvent(eventId), true)) continue;
      if ([...battlePrerequisites.get(eventId) ?? []].some(id => !processedEvents.has(id))) continue;
      const walk = probeScript(event.script, state, pinChoices(event.condition));
      if (!walk.ok || blocked(walk, eventId)) continue;
      const index = eventIndex.get(eventId)!;
      if (!best || index < best.index) best = { kind: 'event', eventId, index, walk };
    }
    return best;
  }

  function chooseStep(): Candidate | undefined {
    // 开场事件永远先演，后面的自动事件再按状态接上。
    const start = campaign.events.find(event => event.source === 'start');
    if (start && !processedEvents.has(start.id)) {
      const walk = probeEvent(start, start.id);
      if (walk.ok) return { kind: 'event', eventId: start.id, index: -1, walk };
    }
    const candidates: Candidate[] = [];
    const pendingNeeds = pendingStrictNeeds();
    const activeNeeds = pendingActiveNeeds();
    const blockedByLaterEvent = (walk: WalkResult, selfEventId?: string): boolean =>
      [...walk.ready, ...walk.deliver].some(questId => {
        if (pendingActiveBlocks(questId, selfEventId, activeNeeds)) return true;
        if (!walk.deliver.includes(questId)) return false;
        return (pendingNeeds.get(questId) ?? []).some(need => need.eventId !== selfEventId
          && (need.status === 'active' || need.status === 'ready'));
      });
    for (const eventId of requiredEvents) {
      if (processedEvents.has(eventId)) continue;
      const event = events.get(eventId)!;
      if (!coarseCondition(event.condition, state, !strictEvent(eventId))) continue;
      if ([...battlePrerequisites.get(eventId) ?? []].some(id => !processedEvents.has(id))) continue;
      const walk = probeEvent(event, eventId);
      if (!walk.ok) trace?.('事件不可演 ' + eventId + '：' + walk.reason);
      if (walk.ok && !blockedByLaterEvent(walk, eventId))
        candidates.push({ kind: 'event', eventId, index: eventIndex.get(eventId)!, walk });
    }
    for (const node of standaloneAccepts) {
      if (completedAccepts.has(node.quest) || state.opened.has(node.quest)) continue;
      const quest = quests.get(node.quest)!;
      if (!conditionHolds(quest.availableWhen, state)) continue;
      candidates.push({ kind: 'accept', node, index: questIndex.get(node.quest)! });
    }
    for (const node of nextAccepts) {
      if (completedAccepts.has(node.quest) || state.opened.has(node.quest)) continue;
      if (node.after && !state.delivered.has(node.after)) continue;
      const quest = quests.get(node.quest)!;
      if (!conditionHolds(quest.availableWhen, state)) continue;
      const walk = probeScript(node.script!, state, undefined);
      if (walk.ok && !blockedByLaterEvent(walk))
        candidates.push({ kind: 'accept', node, index: questIndex.get(node.quest)!, walk });
    }
    for (const node of deliverNodes) {
      if (completedDelivers.has(node.quest) || state.delivered.has(node.quest)) continue;
      const quest = quests.get(node.quest)!;
      if (!state.opened.has(node.quest)) continue;
      if (!deliverable(quest, state)) continue;
      const walk = node.script ? probeScript(node.script, state, undefined) : undefined;
      if (walk && !walk.ok) continue;
      if (walk && blockedByLaterEvent(walk)) continue;
      if (pendingActiveBlocks(node.quest, undefined, activeNeeds)) continue;
      const needs = pendingNeeds.get(node.quest) ?? [];
      if (needs.some(need => need.status === 'active' || need.status === 'ready')) continue;
      candidates.push({ kind: 'deliver', node, index: questIndex.get(node.quest)!, walk });
    }
    const ready = bestTransitionCandidate();
    if (!candidates.length) return ready;
    // 状态变化直接触发的剧情先演；其余按内容里的任务／事件顺序推进。
    const hot = candidates.filter(candidate => candidate.kind === 'event'
      && ['event', 'quest', 'choice'].includes(events.get(candidate.eventId)!.source));
    const pool = hot.length ? hot : candidates;
    pool.sort((a, b) => a.index - b.index);
    if (ready && (!pool.length || ready.index <= pool[0].index)) return ready;
    return pool[0];
  }

  function probeEvent(event: StoryEvent, _eventId: string): WalkResult {
    return probeScript(event.script, state, event.condition);
  }

  function probeScript(name: string, from: GenState, condition: StoryCondition | undefined): WalkResult {
    const entryState = cloneState(from);
    for (const ref of choiceReferences(condition)) entryState.choices.set(ref.choice, ref.value);
    return walkScript(campaign, quests, name, entryState, (choice, values) =>
      chooseCase(choice, values, name));
  }

  function pendingActiveNeeds(): Map<string, string[]> {
    const needs = new Map<string, string[]>();
    for (const eventId of requiredEvents) {
      if (processedEvents.has(eventId)) continue;
      for (const ref of questReferences(events.get(eventId)!.condition)) {
        if (ref.status !== 'active') continue;
        const list = needs.get(ref.quest) ?? [];
        list.push(eventId);
        needs.set(ref.quest, list);
      }
    }
    return needs;
  }

  function pendingStrictNeeds(): Map<string, { eventId: string; status: string }[]> {
    const needs = new Map<string, { eventId: string; status: string }[]>();
    for (const eventId of requiredEvents) {
      if (processedEvents.has(eventId) || !strictEvent(eventId)) continue;
      for (const ref of questReferences(events.get(eventId)!.condition)) {
        const list = needs.get(ref.quest) ?? [];
        list.push({ eventId, status: ref.status });
        needs.set(ref.quest, list);
      }
    }
    return needs;
  }

  /** 还有演出要求这个任务保持进行中时，先不要把它改成待交付或已交付。 */
  function pendingActiveBlocks(questId: string, selfEventId: string | undefined,
    activeNeeds: Map<string, string[]>): boolean {
    // talk 任务接取即待交付，不存在“进行中”阶段，不能拿 active 条件挡住。
    if (quests.get(questId)?.completion === 'talk') return false;
    return (activeNeeds.get(questId) ?? []).some(eventId => eventId !== selfEventId);
  }

  /**
   * 有任务在等待交付、或有后续演出要求它处于某个状态时，提前补上待交付或交付。
   * 这样被挡住的低编号剧情不会因为后面一直有别的支线可演而一直等下去。
   */
  function bestTransitionCandidate(): Candidate | undefined {
    const activeNeeds = pendingActiveNeeds();
    const strictNeeds = pendingStrictNeeds();
    let best: Candidate | undefined;
    for (const quest of campaign.quests) {
      const status = state.status.get(quest.id);
      if ((status !== 'active' && status !== 'ready') || state.delivered.has(quest.id)) continue;
      if (pendingActiveBlocks(quest.id, undefined, activeNeeds)) continue;
      const node = deliverNodes.find(entry => entry.quest === quest.id && !completedDelivers.has(entry.quest));
      const readyNeeds = (strictNeeds.get(quest.id) ?? []).filter(need => need.status === 'ready');
      // 有演出要求待交付时，先把 active 补成 ready；它演完之后才轮到交付。
      if (status === 'active' && readyNeeds.length) {
        const candidate: Candidate = { kind: 'ready', questId: quest.id,
          index: Math.min(...readyNeeds.map(need => eventIndex.get(need.eventId)!)) };
        if (!best || candidate.index < best.index) best = candidate;
        continue;
      }
      if (!node) continue;
      // 其他演出还要先看这个任务的待交付状态时，先让它们演。
      if (readyNeeds.length) continue;
      let index = questIndex.get(quest.id)! + 0.5;
      for (const need of strictNeeds.get(quest.id) ?? [])
        if (need.status === 'completed' || need.status === 'settled')
          index = Math.min(index, eventIndex.get(need.eventId)!);
      const candidate: Candidate = status === 'ready' || quest.completion === 'story'
        ? { kind: 'deliver', node, index }
        : { kind: 'ready', questId: quest.id, index };
      if (!best || candidate.index < best.index) best = candidate;
    }
    return best;
  }

  // ---- 选择分支选项 ----

  /**
   * 选择出口的答案：优先选能立刻推动下一条必需剧情的选项。
   * 例如同一段记忆演出可以重看不同分支，就按待演事件的接取／交付依赖来选。
   */
  function chooseCase(choice: string, values: string[], owner: string): string | undefined {
    let best: { value: string; index: number } | undefined;
    for (const value of values) {
      const tentative = cloneState(state);
      tentative.choices.set(choice, value);
      for (const eventId of requiredEvents) {
        if (processedEvents.has(eventId) || eventId === owner) continue;
        const event = events.get(eventId)!;
        if (!coarseCondition(event.condition, tentative, !strictEvent(eventId))) continue;
        if (!choiceReferences(event.condition).some(ref => ref.choice === choice && ref.value === value)) continue;
        const walk = walkScript(campaign, quests, event.script, cloneState(tentative),
          (inner, innerValues) => chooseCase(inner, innerValues, event.script));
        if (!walk.ok) continue;
        const index = eventIndex.get(eventId)!;
        if (!best || index < best.index) best = { value, index };
      }
      if (best) break;
    }
    return best?.value ?? values[0];
  }

  // ---- 应用一步 ----

  function processEvent(eventId: string): void {
    const event = events.get(eventId)!;
    const walk = probeEvent(event, eventId);
    if (!walk.ok) throw new Error('调试顺序推导无法播放事件 ' + eventId + '：' + (walk.reason ?? '未知原因'));
    state = walk.state;
    state.completedEvents.add(eventId);
    processedEvents.add(eventId);
    const index = steps.length;
    const step: StoryProgressionStep = { event: eventId };
    applyBoundaries(step, walk, index);
    assignStepMap(step, walk, event);
    if (Object.keys(walk.choices).length) step.choices = walk.choices;
    steps.push(step);
  }

  function processReady(questId: string): void {
    const next = cloneState(state);
    next.status.set(questId, 'ready');
    next.ready.add(questId);
    state = next;
    const boundary = boundaryFor(questId);
    if (boundary.ready === undefined) boundary.ready = steps.length + 1;
    steps.push({ ready: [questId] });
  }

  function processAccept(node: TransitionNode): void {
    const walk = node.script ? probeScript(node.script, state, undefined)
      : acceptStandalone(node.quest);
    if (!walk.ok) throw new Error('调试顺序推导无法接取 ' + node.quest + '：' + (walk.reason ?? '未知原因'));
    state = walk.state;
    completedAccepts.add(node.quest);
    const index = steps.length;
    const step: StoryProgressionStep = node.script ? { script: node.script } : {};
    applyBoundaries(step, walk, index);
    if (Object.keys(walk.choices).length) step.choices = walk.choices;
    const map = placeMapFor(quests.get(node.quest)!, 'accept');
    if (map) step.map = map;
    assignStepMap(step, walk, undefined);
    steps.push(step);
  }

  function acceptStandalone(questId: string): WalkResult {
    const next = cloneState(state);
    const quest = quests.get(questId)!;
    const before: QuestStatus = next.status.get(questId) ?? 'available';
    const result: WalkResult = { ok: true, state: next, accept: [], ready: [], deliver: [], choices: {} };
    if (before === 'locked') return { ...result, ok: false, reason: '任务锁定' };
    if (next.status.get(questId) !== 'active' && next.status.get(questId) !== 'ready') {
      next.status.set(questId, quest.completion === 'talk' ? 'ready' : 'active');
      if (!next.opened.has(questId)) { next.opened.add(questId); result.accept.push(questId); }
      if (quest.completion === 'talk') next.ready.add(questId);
    }
    return result;
  }

  function processDeliver(node: TransitionNode): void {
    const quest = quests.get(node.quest)!;
    const walk = deliverStandalone(node.quest);
    if (!walk.ok) throw new Error('调试顺序推导无法交付 ' + node.quest + '：' + (walk.reason ?? '未知原因'));
    state = walk.state;
    completedDelivers.add(node.quest);
    const index = steps.length;
    const step: StoryProgressionStep = {};
    applyBoundaries(step, walk, index);
    const map = placeMapFor(quest, 'deliver');
    if (map) step.map = map;
    assignStepMap(step, walk, undefined);
    steps.push(step);
  }

  function deliverStandalone(questId: string): WalkResult {
    const quest = quests.get(questId)!;
    const next = cloneState(state);
    const result: WalkResult = { ok: true, state: next, accept: [], ready: [], deliver: [], choices: {} };
    if (!next.opened.has(questId)) return { ...result, ok: false, reason: '任务尚未接取' };
    if (!deliverable(quest, next)) return { ...result, ok: false, reason: '任务尚未待交付' };
    next.status.set(questId, quest.repeat ? 'available' : 'completed');
    if (!next.delivered.has(questId)) { next.delivered.add(questId); result.deliver.push(questId); }
    return result;
  }

  /** 多候选地点优先选发布者／交付人真正站着的那张图。 */
  function placeMapFor(quest: CampaignQuest, phase: 'accept' | 'deliver'): string | undefined {
    const place = phase === 'accept' ? quest.places?.available : quest.places?.ready ?? quest.places?.active;
    if (place?.type !== 'alternatives') return undefined;
    const npc = phase === 'accept' ? quest.giverCharacterId ?? quest.giver : quest.deliveryCharacterId ?? quest.delivery;
    if (npc) {
      const entity = [...campaign.placements, ...(campaign.mapEntryPlacements ?? [])].find(candidate =>
        candidate.characterId === npc || candidate.id === npc || candidate.actor === npc);
      if (entity && place.spots.some(spot => spot.map === entity.map)) return entity.map;
    }
    return place.spots[0]?.map;
  }

  function assignStepMap(step: StoryProgressionStep, walk: WalkResult | undefined,
    event: StoryEvent | undefined): void {
    if (step.map) return;
    const places: StoryPlace[] = [];
    for (const questId of step.accept ?? []) { const place = quests.get(questId)?.places?.available; if (place) places.push(place); }
    for (const questId of [...step.ready ?? [], ...step.deliver ?? []]) {
      const place = quests.get(questId)?.places?.ready; if (place) places.push(place);
    }
    const alternatives = places.filter((place): place is Extract<StoryPlace, { type: 'alternatives' }> =>
      place.type === 'alternatives').map(place => new Set(place.spots.map(spot => spot.map)));
    if (event?.place?.type === 'alternatives')
      alternatives.push(new Set(event.place.spots.map(spot => spot.map)));
    if (!alternatives.length) return;
    const needsMap = !event?.map && event?.place?.type !== 'fixed' && alternatives.some(maps => maps.size > 1);
    if (!needsMap) return;
    const common = [...alternatives[0]].filter(map => alternatives.every(maps => maps.has(map)));
    if (!common.length) return;
    const fixed = event?.place?.type === 'fixed' ? event.place.map : undefined;
    step.map = common.includes(walk?.landing?.map ?? '') ? walk!.landing!.map
      : fixed && common.includes(fixed) ? fixed : common[0];
  }

  function applyBoundaries(step: StoryProgressionStep, walk: WalkResult, index: number): void {
    if (walk.accept.length) step.accept = walk.accept;
    if (walk.ready.length) step.ready = walk.ready;
    if (walk.deliver.length) step.deliver = walk.deliver;
    for (const quest of walk.accept) {
      const boundary = boundaryFor(quest);
      if (boundary.accept === undefined) boundary.accept = index;
    }
    for (const quest of walk.ready) {
      const boundary = boundaryFor(quest);
      if (boundary.ready === undefined) boundary.ready = index + 1;
    }
    for (const quest of walk.deliver) {
      const boundary = boundaryFor(quest);
      if (boundary.deliver === undefined) boundary.deliver = index;
    }
    if (step.ready && walk.landing && walk.landing.map)
      step.resumeAfterStage = step.ready[0];
  }

  function boundaryFor(questId: string): { accept: number; ready?: number; deliver?: number } {
    let boundary = boundaries.get(questId);
    if (!boundary) { boundary = { accept: 0 }; boundaries.set(questId, boundary); }
    return boundary;
  }

  function insertReady(): boolean {
    const active = campaign.quests.filter(quest => {
      const status = state.status.get(quest.id);
      return (status === 'active') && !state.ready.has(quest.id) && !state.delivered.has(quest.id);
    });
    if (!active.length) return false;
    // 还有后续演出要求这个任务保持进行中时，不能提前改成待交付。
    const activeNeeds = pendingActiveNeeds();
    const needsActive = (questId: string): boolean => pendingActiveBlocks(questId, undefined, activeNeeds);
    // 只补真正卡住后续步骤的任务：交付节点或要求 ready 的演出。
    const wanted = active.find(quest => !needsActive(quest.id)
      && (deliverNodes.some(node => node.quest === quest.id)
        || [...requiredEvents].some(id => !processedEvents.has(id)
          && eventReferencesToQuest(events.get(id)!, quest.id, 'ready'))));
    if (!wanted) return false;
    const quest = wanted;
    const next = cloneState(state);
    next.status.set(quest.id, 'ready');
    if (!next.ready.has(quest.id)) next.ready.add(quest.id);
    state = next;
    const step: StoryProgressionStep = { ready: [quest.id] };
    const boundary = boundaryFor(quest.id);
    if (boundary.ready === undefined) boundary.ready = steps.length + 1;
    steps.push(step);
    return true;
  }

  function blockedSummary(): string {
    const pendingEvents = [...requiredEvents].filter(id => !processedEvents.has(id)).slice(0, 12);
    const pendingQuests = campaign.quests.filter(quest => !state.opened.has(quest.id)).slice(0, 12);
    return '待演事件 ' + pendingEvents.join('、') + '；待接取任务 '
      + pendingQuests.map(quest => quest.id + '(' + (state.status.get(quest.id) ?? '?') + ')').join('、')
      + '；关键状态 ' + ['quest-46', 'quest-22', 'grafton-mission', 'quest-9', 'quest-10', 'quest-11', 'quest-12', 'quest-336', 'quest-335', 'quest-106', 'quest-107', 'quest-108', 'quest-109']
        .map(id => id + '=' + (state.status.get(id) ?? '?')).join(' ');
  }
}

// ---- 脚本控制流 ----

function walkScript(campaign: Campaign, quests: Map<string, CampaignQuest>, name: string, from: GenState,
  resolveChoice: (choice: string, values: string[]) => string | undefined): WalkResult {
  const result: WalkResult = {
    ok: true, state: from, accept: [], ready: [], deliver: [], choices: {},
  };
  const scripts = campaign.scripts;
  const nodes = new Map<string, Map<string, StoryNode>>(Object.entries(scripts).map(([scriptName, script]) =>
    [scriptName, new Map<string, StoryNode>(script.nodes.map(node => [node.id, node]))]));
  const seen = new Set<string>();
  const stack: StoryNodeRef[] = [];
  let cursor: StoryNodeRef | undefined = { script: name, node: scripts[name].entry };
  let landing: StageLanding | undefined;
  for (let count = 0; cursor; count++) {
    if (count >= MAX_WALK_NODES) return fail('剧情未结束：' + name);
    const key = cursor.script + '/' + cursor.node;
    if (seen.has(key)) return fail('剧情出现循环：' + key);
    seen.add(key);
    const node: StoryNode | undefined = nodes.get(cursor.script)?.get(cursor.node);
    if (!node) return fail('剧情节点缺失：' + key);
    for (const action of node.presentation) {
      if (action.type !== 'stage' || !action.map) continue;
      landing = { map: action.map, x: action.x, y: action.y };
    }
    for (const command of node.commands) {
      const problem = applyCommand(result.state, quests, command, result);
      if (problem) return fail(problem);
    }
    const exit: StoryNode['exit'] = node.exit;
    switch (exit.type) {
      case 'next': cursor = exit.target; break;
      case 'call': stack.push(exit.then); cursor = exit.target; break;
      case 'branch': cursor = conditionHolds(exit.condition, result.state) ? exit.then : exit.otherwise; break;
      case 'choice': {
        const value = resolveChoice(exit.choice, Object.keys(exit.cases));
        if (!value || !exit.cases[value]) return fail('剧情选择没有可用分支：' + exit.choice);
        result.state.choices.set(exit.choice, value);
        result.choices[exit.choice] = value;
        cursor = exit.cases[value];
        break;
      }
      case 'waitEncounter': cursor = exit.outcomes.won; break;
      case 'end': cursor = stack.pop(); break;
      case 'defer': cursor = undefined; break;
    }
  }
  result.landing = landing;
  return result;

  function fail(reason: string): WalkResult {
    return { ...result, ok: false, reason };
  }
}

function applyCommand(state: GenState, quests: Map<string, CampaignQuest>, command: StoryCommand,
  result: WalkResult): string | undefined {
  if (command.type === 'choice') { state.choices.set(command.choice, command.value); return; }
  if (command.type !== 'quest') return;
  const questCommand = command.command;
  if (!('quest' in questCommand)) return;
  const questId = questCommand.quest;
  const definition = quests.get(questId);
  const status: QuestStatus = state.status.get(questId) ?? 'available';
  switch (questCommand.type) {
    case 'accept': {
      if (status === 'locked') return '任务尚不可接取：' + questId;
      if (status === 'active' || status === 'ready') return;
      if (!state.opened.has(questId) && definition && !conditionHolds(definition.availableWhen, state))
        return '任务前置未满足：' + questId;
      // talk 任务接取后立即待交付，和任务簿的正式行为一致。
      state.status.set(questId, definition?.completion === 'talk' ? 'ready' : 'active');
      if (!state.opened.has(questId)) {
        state.opened.add(questId);
        result.accept.push(questId);
        if (definition?.completion === 'talk') state.ready.add(questId);
      }
      return;
    }
    case 'script-ready': {
      if (status === 'ready') return;
      if (!state.opened.has(questId)) return '任务尚未接取：' + questId;
      state.status.set(questId, 'ready');
      if (!state.ready.has(questId)) { state.ready.add(questId); result.ready.push(questId); }
      return;
    }
    case 'complete': {
      if (status !== 'ready') return '任务目标尚未达成：' + questId;
      finish();
      return;
    }
    case 'script-complete': {
      if (status === 'active' || status === 'ready') finish();
      else if (status !== 'completed') return '任务尚未接取：' + questId;
      return;
    }
    case 'reset': {
      state.status.set(questId, 'available');
      return;
    }
    default: return;
  }

  function finish(): void {
    if (state.status.get(questId) === 'completed') return;
    // 重复任务交付后回到可接取，供下一轮使用；一次性任务记为已完成。
    state.status.set(questId, definition?.repeat ? 'available' : 'completed');
    if (!state.delivered.has(questId)) { state.delivered.add(questId); result.deliver.push(questId); }
  }
}

function cloneState(state: GenState): GenState {
  return {
    status: new Map(state.status),
    completedEvents: new Set(state.completedEvents),
    choices: new Map(state.choices),
    opened: new Set(state.opened),
    ready: new Set(state.ready),
    delivered: new Set(state.delivered),
  };
}

// ---- 条件与地点 ----

function conditionHolds(condition: StoryCondition | undefined, state: GenState): boolean {
  return evaluateStoryCondition(condition, {
    questStatus: id => state.status.get(id) ?? 'available',
    flag: () => false,
    choice: id => state.choices.get(id),
    eventStatus: id => state.completedEvents.has(id) ? 'completed' : 'idle',
    world: () => undefined,
  });
}

/** 事件能不能演：选择条件允许由这一步自己写入，任务和事件条件必须已经满足。 */
function coarseCondition(condition: StoryCondition | undefined, state: GenState, loose = false, pinChoices = false): boolean {
  if (!condition) return true;
  switch (condition.type) {
    case 'always': return condition.value;
    case 'all': return condition.conditions.every(value => coarseCondition(value, state, loose, pinChoices));
    case 'any': return condition.conditions.some(value => coarseCondition(value, state, loose, pinChoices));
    case 'not': return !coarseCondition(condition.condition, state, loose, pinChoices);
    case 'quest': {
      const status = state.status.get(condition.quest) ?? 'available';
      if (condition.status === 'accepted') return status === 'active' || status === 'ready' || status === 'completed';
      if (condition.status === 'settled') return status === 'completed';
      // 一次性事件的记录来自实际游玩：任务可能已经从 active 走到 ready/完成。
      // 只要任务已经接取（或已经完成），这条事件就能补演，不能让状态细节把它永远挡在外面。
      if (loose && (condition.status === 'active' || condition.status === 'ready'))
        return status === 'active' || status === 'ready' || status === 'completed';
      return status === condition.status;
    }
    case 'event': return state.completedEvents.has(condition.event) === (condition.status === 'completed');
    case 'choice': return pinChoices || state.choices.get(condition.choice) === condition.value;
    case 'flag': case 'world': return true;
  }
}

function deliverable(quest: CampaignQuest, state: GenState): boolean {
  const status = state.status.get(quest.id);
  if (quest.completion === 'story' || quest.completion === 'internal') return status === 'active' || status === 'ready';
  return status === 'ready';
}

/** 事件已经要求这个任务处于某状态时，它就不是首次接取／交付的入口。 */
function conditionRequiresQuest(condition: StoryCondition | undefined, questId: string,
  statuses: Set<string> = new Set(['active', 'ready', 'completed', 'settled'])): boolean {
  if (!condition) return false;
  switch (condition.type) {
    case 'all': case 'any': return condition.conditions.some(value => conditionRequiresQuest(value, questId, statuses));
    case 'not': return conditionRequiresQuest(condition.condition, questId, statuses);
    case 'quest': return condition.quest === questId && statuses.has(condition.status);
    default: return false;
  }
}

/** 把事件条件里写明的选择值当成这一步的前置答案。 */
function pinChoices(condition: StoryCondition | undefined): StoryCondition | undefined {
  if (!condition) return undefined;
  return { type: 'all', conditions: choiceReferences(condition).map(ref => ({ type: 'choice', ...ref })) };
}

function choiceReferences(condition: StoryCondition | undefined): { choice: string; value: string }[] {
  if (!condition) return [];
  switch (condition.type) {
    case 'all': case 'any': return condition.conditions.flatMap(choiceReferences);
    case 'not': return choiceReferences(condition.condition);
    case 'choice': return [{ choice: condition.choice, value: condition.value }];
    default: return [];
  }
}

function eventReferences(condition: StoryCondition | undefined): string[] {
  if (!condition) return [];
  switch (condition.type) {
    case 'all': case 'any': return condition.conditions.flatMap(eventReferences);
    case 'not': return eventReferences(condition.condition);
    case 'event': return [condition.event];
    default: return [];
  }
}

function eventReferencesToQuest(event: { condition?: StoryCondition }, questId: string, status: string): boolean {
  if (!event.condition) return false;
  switch (event.condition.type) {
    case 'all': case 'any':
      return event.condition.conditions.some(value => eventReferencesToQuest({ condition: value }, questId, status));
    case 'not': return eventReferencesToQuest({ condition: event.condition.condition }, questId, status);
    case 'quest': return event.condition.quest === questId && event.condition.status === status;
    default: return false;
  }
}

// ---- 静态脚本扫描 ----

function battleEnemyId(key: string): string | undefined {
  if (key.startsWith('defeat:')) return key.slice('defeat:'.length);
  if (key.startsWith('health-below-30:')) return key.slice('health-below-30:'.length);
  return undefined;
}

function reachableEncounterEnemies(scripts: Record<string, StoryScript>, name: string): Set<string> {
  const nodes = new Map<string, Map<string, StoryNode>>(Object.entries(scripts).map(([scriptName, script]) =>
    [scriptName, new Map<string, StoryNode>(script.nodes.map(node => [node.id, node]))]));
  const enemies = new Set<string>();
  const seen = new Set<string>();
  const stack = [{ script: name, node: scripts[name].entry }];
  while (stack.length) {
    const cursor = stack.pop()!;
    const key = cursor.script + '/' + cursor.node;
    if (seen.has(key)) continue;
    seen.add(key);
    const node = nodes.get(cursor.script)?.get(cursor.node);
    if (!node) continue;
    const exit = node.exit;
    if (exit.type === 'waitEncounter') {
      for (const spawn of exit.encounter.spawns) enemies.add(spawn.enemyId);
      for (const outcome of Object.values(exit.outcomes)) stack.push(outcome);
    } else {
      switch (exit.type) {
        case 'next': stack.push(exit.target); break;
        case 'call': stack.push(exit.then, exit.target); break;
        case 'branch': stack.push(exit.then, exit.otherwise); break;
        case 'choice': stack.push(...Object.values(exit.cases)); break;
        default: break;
      }
    }
  }
  return enemies;
}

function reachableCommands(scripts: Record<string, StoryScript>, name: string): StoryCommand[] {
  const nodes = new Map<string, Map<string, StoryNode>>(Object.entries(scripts).map(([scriptName, script]) =>
    [scriptName, new Map<string, StoryNode>(script.nodes.map(node => [node.id, node]))]));
  const commands: StoryCommand[] = [];
  const seen = new Set<string>();
  const stack = [{ script: name, node: scripts[name].entry }];
  while (stack.length) {
    const cursor = stack.pop()!;
    const key = cursor.script + '/' + cursor.node;
    if (seen.has(key)) continue;
    seen.add(key);
    const node = nodes.get(cursor.script)?.get(cursor.node);
    if (!node) continue;
    commands.push(...node.commands);
    const exit = node.exit;
    switch (exit.type) {
      case 'next': stack.push(exit.target); break;
      case 'call': stack.push(exit.then, exit.target); break;
      case 'branch': stack.push(exit.then, exit.otherwise); break;
      case 'choice': stack.push(...Object.values(exit.cases)); break;
      case 'waitEncounter': stack.push(...Object.values(exit.outcomes)); break;
      default: break;
    }
  }
  return commands;
}

interface StaticChoiceExit { choice: string; cases: Record<string, StoryNodeRef> }

function staticChoiceExits(script: StoryScript): StaticChoiceExit[] {
  const exits: StaticChoiceExit[] = [];
  for (const node of script.nodes)
    if (node.exit.type === 'choice') exits.push({ choice: node.exit.choice, cases: node.exit.cases });
  return exits;
}

// ---- 小工具 ----

/** 事件条件引用了比目标任务更靠后的任务时，说明它不是首演入口，分数越高越晚。 */
function downstreamScore(condition: StoryCondition | undefined, questId: string): number {
  let score = 0;
  for (const ref of questReferences(condition)) if (ref.quest !== questId) score++;
  return score;
}

/** 只看正向要求；`not` 里的状态是消费者之后反而更容易满足，不算前置。 */
function positiveQuestReferences(condition: StoryCondition | undefined): { quest: string; status: string }[] {
  if (!condition) return [];
  switch (condition.type) {
    case 'all': case 'any': return condition.conditions.flatMap(positiveQuestReferences);
    case 'not': return [];
    case 'quest': return [{ quest: condition.quest, status: condition.status }];
    default: return [];
  }
}

function questReferences(condition: StoryCondition | undefined): { quest: string; status: string }[] {
  if (!condition) return [];
  switch (condition.type) {
    case 'all': case 'any': return condition.conditions.flatMap(questReferences);
    case 'not': return questReferences(condition.condition);
    case 'quest': return [{ quest: condition.quest, status: condition.status }];
    default: return [];
  }
}

function bestEvent(ids: string[], ...keys: ((id: string) => number)[]): string {
  return [...ids].sort((a, b) => {
    for (const key of keys) {
      const delta = key(a) - key(b);
      if (delta) return delta;
    }
    return 0;
  })[0];
}

function addSet(map: Map<string, Set<string>>, key: string, value: string): void {
  const set = map.get(key) ?? new Set<string>();
  set.add(value);
  map.set(key, set);
}

function pushMap<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key) ?? [];
  list.push(value);
  map.set(key, list);
}

function memo<T>(make: (key: string) => T): (key: string) => T {
  const cache = new Map<string, T>();
  return key => {
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const value = make(key);
    cache.set(key, value);
    return value;
  };
}

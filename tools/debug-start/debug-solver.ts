import {canonicalJson, contentDigest} from '../../src/application/content-hash.ts';
import type {Campaign, CampaignQuest} from '../../src/domain/campaign.ts';
import type {EntityPlacement, TravelDestination, WorldIndex, WorldMap} from '../../src/domain/content.ts';
import type {ItemCatalog} from '../../src/domain/items.ts';
import type {StoryCondition} from '../../src/domain/story-condition.ts';
import type {StoryEvent, StoryNodeRef, StoryScript} from '../../src/domain/story-graph.ts';
import type {SessionState} from '../../src/domain/session.ts';
import type {
  StoryDebugCatalog, StoryDebugGap, StoryDebugPlay, StoryDebugStartTable, StoryDebugTask,
} from '../../src/domain/story-debug.ts';
import type {HeadlessContent} from '../../src/debug/headless-story.ts';
import {createHeadlessStory, type BattleDecision, type ChoiceDecision, type HeadlessStory} from '../../src/debug/headless-story.ts';

const MAX_DEPTH = 256;
const INTERPRETER_VERSION = 3;
const SEMANTICS_VERSION = 3;

export class GapError extends Error {
  readonly kind: string;
  readonly detail: string;
  readonly quest?: string;
  readonly fixHint?: string;

  constructor(kind: string, detail: string, quest?: string, fixHint?: string) {
    super(detail);
    this.kind = kind;
    this.detail = detail;
    this.quest = quest;
    this.fixHint = fixHint;
  }
}

export interface DebugInputs {
  content: Omit<HeadlessContent, 'campaign'> & {campaign: Campaign};
  itemsRaw: {items?: Record<string, {category?: string}>};
  routes: {stages?: {id: string; before?: string[]; entry?: DebugEntry}[]};
  contexts: {
    events?: Record<string, {map?: string; before?: string[]; entry?: {x: number; y: number}}>;
    choices?: Record<string, {basis?: string}>;
  };
  draft: {
    scripts?: Record<string, StoryScript>;
    choicePoints?: Record<string, {node: string; choice: string; converged?: boolean;
      options?: {value: string; branchEvents?: number[]; evidence?: string}[]}[]>;
    mapEvidence?: Record<string, string>;
    mapEvidenceNotes?: Record<string, {map?: string}>;
    triggerSkips?: {event: number}[];
  };
  sourceMap: {maps?: Record<string, number>};
}

interface DebugEntry {type: 'fixed'; map: string; x: number; y: number; source?: string}
interface Candidate {script: string; node: string; action: 'accept' | 'script-ready' | 'complete' | 'script-complete'; quest: string}
interface Trace {kind: string; [key: string]: unknown}

export const digest = contentDigest;
export const stableString = canonicalJson;

/** 把原版脚本图上的候选入口、前置链和固定差点位整理成可回放的时间线。 */
export class DebugTaskBuilder {
  private readonly campaign: Campaign;
  private readonly headless: HeadlessStory;
  private readonly routes: Map<string, {id: string; before: string[]; entry?: DebugEntry}>;
  private readonly contexts: DebugInputs['contexts'];
  private readonly draft: DebugInputs['draft'];
  private readonly sourceMap: DebugInputs['sourceMap'];
  private readonly items: DebugInputs['itemsRaw'];
  private readonly events: Map<string, StoryEvent>;
  private readonly eventsByScript = new Map<string, StoryEvent>();
  private readonly transitions = new Map<string, Candidate[]>();
  private readonly completions = new Map<string, Candidate[]>();
  private readonly flagWrites = new Map<string, {script: string; value: boolean}[]>();
  private readonly parents = new Map<string, Set<string>>();
  private readonly placements: EntityPlacement[];
  private readonly mapByNumber = new Map<string, string>();
  private readonly triggerSkips: Set<string>;
  private readonly choiceEvidence = new Map<string, string>();
  private readonly choiceConverged = new Map<string, string>();
  private readonly choicePoints: NonNullable<DebugInputs['draft']['choicePoints']>;
  private readonly base: SessionState;
  private afterOpening!: SessionState;
  private trace: Trace[] = [];
  private replaying = new Set<string>();
  private ensuring = new Set<string>();
  private choices: ChoiceDecision[] = [];
  private battles: BattleDecision[] = [];
  private bagBaseline = new Map<string, number>();
  private timelineBlocked = false;
  private currentTask?: string;

  private constructor(inputs: DebugInputs) {
    this.campaign = inputs.content.campaign;
    this.headless = createHeadlessStory(inputs.content);
    this.routes = new Map((inputs.routes.stages ?? []).map(stage =>
      [stage.id, {id: stage.id, before: stage.before ?? [], ...(stage.entry ? {entry: stage.entry} : {})}]));
    this.contexts = inputs.contexts;
    this.draft = inputs.draft;
    this.sourceMap = inputs.sourceMap;
    for (const [name, number] of Object.entries(this.sourceMap.maps ?? {}))
      this.mapByNumber.set(String(number), name);
    this.items = inputs.itemsRaw;
    this.events = new Map(this.campaign.events.map(event => [event.id, event]));
    for (const event of this.campaign.events) if (!this.eventsByScript.has(event.script)) this.eventsByScript.set(event.script, event);
    this.placements = this.campaign.placements;
    this.triggerSkips = new Set((this.draft.triggerSkips ?? []).map(row => `event-${row.event}`));
    this.choicePoints = this.draft.choicePoints ?? {};
    for (const [script, graph] of Object.entries(this.campaign.scripts)) {
      for (const node of graph.nodes) {
        for (const command of node.commands) {
          if (command.type === 'quest') {
            if (command.command.type === 'accept' || command.command.type === 'script-ready') {
              const list = this.transitions.get(command.command.quest) ?? [];
              list.push({script, node: node.id, action: command.command.type, quest: command.command.quest});
              this.transitions.set(command.command.quest, list);
            } else if (command.command.type === 'complete' || command.command.type === 'script-complete') {
              const list = this.completions.get(command.command.quest) ?? [];
              list.push({script, node: node.id, action: command.command.type, quest: command.command.quest});
              this.completions.set(command.command.quest, list);
            }
          } else if (command.type === 'flag') {
            const list = this.flagWrites.get(command.flag) ?? [];
            list.push({script, value: command.value !== false});
            this.flagWrites.set(command.flag, list);
          }
        }
        for (const ref of exitTargets(node.exit)) {
          if (ref.script && ref.script !== script) {
            const set = this.parents.get(ref.script) ?? new Set<string>();
            set.add(script); this.parents.set(ref.script, set);
          }
        }
      }
    }
    for (const [number, row] of Object.entries(this.contexts.choices ?? {})) {
      const event = this.events.get(`event-${number}`);
      if (!event) continue;
      const nodes = (this.campaign.scripts[event.script]?.nodes ?? []).filter(node => node.exit.type === 'choice');
      if (nodes.length !== 1) continue;
      const match = /option-\d+/.exec(row.basis ?? '');
      if (match && nodes[0]!.exit.type === 'choice') this.choiceEvidence.set(nodes[0]!.exit.choice, match[0]);
    }
    for (const points of Object.values(this.choicePoints)) {
      for (const point of points) {
        if (point.converged && point.options?.[0]) this.choiceConverged.set(point.choice, point.options[0].value);
      }
    }
    this.base = this.headless.capture();
  }

  static async create(inputs: DebugInputs): Promise<DebugTaskBuilder> {
    const builder = new DebugTaskBuilder(inputs);
    await builder.replayOpening();
    return builder;
  }

  async buildAll(only?: string[]): Promise<{tasks: StoryDebugTask[]; gaps: StoryDebugGap[]}> {
    const tasks: StoryDebugTask[] = [];
    const gaps: StoryDebugGap[] = [];
    for (const quest of this.eligible(only)) {
      try {
        tasks.push(await this.build(quest));
      } catch (error) {
        const gap = error instanceof GapError ? error : new GapError('internal', String(error));
        gaps.push({quest, kind: gap.kind, detail: gap.detail, ...(gap.fixHint ? {fixHint: gap.fixHint} : {})});
      }
    }
    return {tasks, gaps};
  }

  private async replayOpening(): Promise<void> {
    this.headless.restore(this.base);
    for (const event of this.campaign.events.filter(row => row.source === 'start')) {
      const result = await this.headless.replayEvent(event, {choices: {evidence: Object.fromEntries(this.choiceEvidence)}});
      if (result.status !== 'completed' && result.status !== 'waiting')
        throw new GapError('opening', `${event.id} 没有正常结束（${result.status}）`);
      if (result.status === 'completed') this.headless.recordOccurrence(event, 1);
    }
    this.afterOpening = this.headless.capture();
  }

  private eligible(only?: string[]): string[] {
    const transition = new Set(this.transitions.keys());
    const givers = new Set(this.campaign.quests.filter(quest => quest.giverCharacterId).map(quest => quest.id));
    return this.campaign.quests.map(quest => quest.id)
      .filter(id => transition.has(id) || givers.has(id))
      .filter(id => !only || only.includes(id));
  }

  private async build(quest: string): Promise<StoryDebugTask> {
    this.currentTask = quest;
    this.headless.restore(this.afterOpening);
    this.trace = [];
    this.choices = [];
    this.battles = [];
    this.replaying.clear();
    this.ensuring.clear();
    this.bagBaseline = this.bagCounts();
    const candidates = [...(this.transitions.get(quest) ?? [])]
      .sort((left, right) => this.candidateKey(left, quest) - this.candidateKey(right, quest));
    let last: GapError | undefined;
    for (const candidate of candidates) {
      try {
        return await this.buildCandidate(quest, candidate);
      } catch (error) {
        const gap = this.asGap(error);
        if (!last || gap.stackDepth >= last.stackDepth) last = gap;
      }
    }
    const giver = this.giver(quest);
    if (giver) {
      try { return await this.buildGiver(quest, giver); }
      catch (error) { const gap = this.asGap(error); if (!last || gap.stackDepth >= last.stackDepth) last = gap; }
    }
    throw last ?? new GapError('condition', `${quest} 没有接取证据`, quest);
  }

  /** 候选优先级只看驱动策略：accept 优先、有事件的优先、前置短的优先。 */
  private candidateKey(candidate: Candidate, quest: string): number {
    const root = this.resolveRoot(candidate.script);
    const event = this.eventsByScript.get(root);
    const route = this.routes.get(root);
    return (candidate.action === 'accept' ? 0 : 1) * 1_000_000
      + (event ? 0 : 1) * 100_000 + (route?.before.length ?? 99) * 100
      + (candidate.script === quest ? 0 : 1);
  }

  private async buildCandidate(quest: string, candidate: Candidate): Promise<StoryDebugTask> {
    const root = this.resolveRoot(candidate.script);
    const event = this.eventsByScript.get(root);
    // 目标就由整局开场接取时，时点在开场之前，不能用「开场已发生」的快照。
    this.headless.restore(event?.source === 'start' ? this.base : this.afterOpening);
    // 发布人/交付人的阶段切换事件必须发生在任务之前，先放回时间线再建任务状态。
    const performance = this.hasPerformance(root);
    await this.prepareQuestContacts(quest);
    const before = this.chainBefore(root, event);
    // 目标任务先处于可接取状态，它的 availableWhen 也是现场表的一部分。
    await this.ensureAvailable(quest, 1);
    for (const eventId of before) {
      const saved = this.headless.capture();
      try {
        await this.replayEvent(eventId, 0, undefined);
        const status = this.status(quest);
        if (performance && status !== 'available') {
          this.headless.restore(saved);
          this.trace.push({kind: 'skip-before-after-accept', id: eventId, status});
        }
      } catch (error) {
        this.headless.restore(saved);
        // 前置链里可能混入接取后的收尾事件；它们的任务命令在当前时点不能执行。
        // 这类运行时拒绝只回退该事件并记录，不把整条任务判死。
        if (!(error instanceof GapError)) {
          this.trace.push({kind: 'skip-before-failed', id: eventId,
            error: error instanceof Error ? error.message : String(error)});
          continue;
        }
        throw error;
      }
    }
    if (event?.condition) {
      await this.ensureCondition(event.condition, 1);
      this.headless.session.refresh();
    }
    const entry = this.entryFor(root, event, quest);
    if (!entry) throw new GapError('map', `${quest} 的入口缺少落点`, root);
    if (performance) {
      this.travelTo(entry);
      this.ensureOpeningPlacements(root);
      await this.probeOpening(quest, root, event);
      const play: StoryDebugPlay = {script: root, node: this.campaign.scripts[root]!.entry, cut: 'before-opening',
        ...(event ? {event: event.id} : {})};
      return this.finish(quest, 'available', play, entry, 'routes', before, event);
    }
    this.travelTo(entry);
    const outcome = await this.replayScript(root, undefined, 0);
    if (outcome.status !== 'completed' && outcome.status !== 'waiting')
      throw new GapError('script', `${root} 没有正常结束（${outcome.status}）`, root);
    await this.dispatchChoiceBranches(outcome.choices, root, 1);
    this.headless.session.refresh();
    if (!['active', 'ready'].includes(this.status(quest)))
      throw new GapError('state', `${quest} 没有进入进行中（${this.status(quest)}）`, root);
    return this.finish(quest, 'active', undefined, entry, 'routes', before, event);
  }

  private async probeOpening(quest: string, root: string, event: StoryEvent | undefined): Promise<void> {
    const saved = this.headless.capture();
    try {
      const outcome = await this.replayScript(root, event?.id, 1);
      if (outcome.status !== 'completed' && outcome.status !== 'waiting')
        throw new GapError('script', `${quest} 的开幕演出没有正常结束（${outcome.status}）`, root);
      this.headless.session.refresh();
      // 有些开幕本身就是「接取 → 连续战斗 → 完成」一整段；停在 completed 也是正常结束。
      if (!['active', 'ready', 'completed'].includes(this.status(quest)))
        throw new GapError('state', `${quest} 的开幕演出没有接取任务（${this.status(quest)}）`, root);
    } finally {
      this.headless.restore(saved);
    }
  }

  /** 开幕舞台用 world 绑定时，摆放点的条件标记必须在现场世界里成立。 */
  private ensureOpeningPlacements(root: string): void {
    const graph = this.campaign.scripts[root];
    if (!graph) return;
    const stages: {map?: string; mapFromWorld?: boolean; cast?: {worldEntityId?: string; characterId?: string}[]}[] = [];
    const collect = (actions: {type: string; actions?: unknown[]; [key: string]: unknown}[]) => {
      for (const action of actions) {
        if (action.type === 'stage') stages.push(action as never);
        else if (action.type === 'parallel') collect((action.actions ?? []) as never[]);
      }
    };
    for (const node of graph.nodes) collect(node.presentation as never[]);
    for (const stage of stages) {
      for (const member of stage.cast ?? []) {
        if (!member.worldEntityId && !member.characterId) continue;
        // 开幕可能跨图：按摆放点自己的地图找条件标记，而不是只看落点地图。
        const placement = this.placements.find(row =>
          (member.worldEntityId && row.id === member.worldEntityId)
          || (member.characterId && row.characterId === member.characterId));
        const condition = (placement as {condition?: StoryCondition} | undefined)?.condition;
        if (condition?.type === 'flag' && !this.flag(condition.flag)) {
          this.command({type: 'world', command: {kind: 'flag', id: condition.flag, value: true}});
          this.trace.push({kind: 'placement-flag', flag: condition.flag, entity: member.worldEntityId ?? member.characterId});
        }
      }
    }
  }

  /**
   * 任务的发布人/交付人必须在该时点可见。
   *
   * 两类原因分别处理：摆放点的条件标记没建立，就补标记；角色被早期事件隐藏
   * （例如训练场的 npc-593 被开场隐藏、完成相关剧情后才由 event-55 换出来），
   * 就找到真正把它显示出来的事件并回放。这样同一地图不同时期的任务会落在各自的阶段。
   */
  private async prepareQuestContacts(questId: string): Promise<void> {
    const quest = this.quest(questId);
    const contacts: {characterId: string; placement: EntityPlacement}[] = [];
    for (const characterId of new Set([quest.giverCharacterId, quest.deliveryCharacterId])) {
      if (!characterId) continue;
      const placement = this.placements.find(row => row.characterId === characterId);
      if (placement) contacts.push({characterId, placement});
    }
    for (const {characterId, placement} of contacts) {
      const condition = (placement as {condition?: StoryCondition}).condition;
      if (condition?.type === 'flag' && !this.flag(condition.flag)) {
        this.command({type: 'world', command: {kind: 'flag', id: condition.flag, value: true}});
        this.trace.push({kind: 'placement-flag', flag: condition.flag, entity: characterId});
      }
    }
    for (const {characterId, placement} of contacts) {
      const key = JSON.stringify(['absent-actor', placement.map, characterId]);
      if (!this.headless.session.storyWorld.flagIds.has(key)) continue;
      const beforeStatus = this.status(questId);
      const candidates = this.showEventsFor(placement.map, characterId);
      let fixed = false;
      let lastError = '';
      for (const showId of candidates) {
        const show = this.events.get(showId);
        const hosts = show?.source === 'battle' ? this.battleHostsFor(showId) : [];
        // 战斗事件必须回到触发它的战斗里；没有宿主时才直接重放显示事件。
        const attempts: {id: string; branch: boolean}[][] = hosts.length
          ? hosts.map(host => [{id: host, branch: false}])
          : [[{id: showId, branch: true}]];
        for (const attempt of attempts) {
          const saved = this.headless.capture();
          try {
            for (const step of attempt) await this.replayEvent(step.id, 0, false, step.branch);
            // 阶段事件不能替目标任务把剧情演完：那说明接入的事件晚于任务本身。
            const afterStatus = this.status(questId);
            if (afterStatus === 'completed' && beforeStatus !== 'completed') {
              this.headless.restore(saved);
              continue;
            }
            if (!this.headless.session.storyWorld.flagIds.has(key)) {
              fixed = true;
              this.trace.push({kind: 'contact-stage', event: showId,
                via: attempt.map(step => step.id).join(',')});
              break;
            }
          } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
            if (!(error instanceof GapError)) { this.headless.restore(saved); throw error; }
          }
          this.headless.restore(saved);
        }
        if (fixed) break;
      }
      if (!fixed)
        throw new GapError('contact', `${questId} 的联系人 ${characterId} 在 ${placement.map} 不可见` +
          `（候选 ${candidates.join(',') || '无'}${lastError ? `；${lastError}` : ''}）`, questId);
    }
  }

  /** 找到会生成某个敌人、从而能触发该战斗事件的宿主事件。 */
  private battleHostsFor(eventId: string): string[] {
    const event = this.events.get(eventId);
    if (!event || event.source !== 'battle' || !event.key) return [];
    const enemy = event.key.replace(/^(defeat|health-below-30):/, '');
    const hosts = new Set<string>();
    for (const [script, graph] of Object.entries(this.campaign.scripts)) {
      const host = this.eventsByScript.get(script);
      if (!host) continue;
      for (const node of graph.nodes) {
        if (node.exit.type !== 'waitEncounter') continue;
        if ((node.exit.encounter.spawns ?? []).some(spawn => spawn.enemyId === enemy)) hosts.add(host.id);
      }
    }
    const numberOf = (id: string) => Number(id.split('-').at(-1) ?? 0);
    return [...hosts].sort((left, right) => numberOf(left) - numberOf(right));
  }

  /** 把某个角色在某张图显示出来的事件；业务上等价于原版可见性写点。 */
  private showEventsFor(map: string, characterId: string): string[] {
    const ids = new Set<string>();
    for (const [script, graph] of Object.entries(this.campaign.scripts)) {
      const event = this.eventsByScript.get(script);
      if (!event) continue;
      for (const node of graph.nodes) for (const command of node.commands) {
        if (command.type !== 'world') continue;
        const world = command.command;
        if (world.kind === 'actor-visibility' && world.map === map
          && world.characterId === characterId && world.visible) ids.add(event.id);
        else if (world.kind === 'place' && world.entity.map === map
          && world.entity.characterId === characterId && world.entity.visible !== false) ids.add(event.id);
      }
    }
    const numberOf = (id: string) => Number(id.split('-').at(-1) ?? 0);
    return [...ids].sort((left, right) => numberOf(left) - numberOf(right));
  }

  private async buildGiver(quest: string, giver: {characterId: string; actor?: string; placement?: EntityPlacement; entry?: DebugEntry}): Promise<StoryDebugTask> {
    this.headless.restore(this.afterOpening);
    await this.prepareQuestContacts(quest);
    await this.acceptFromGiver(quest, giver);
    if (!giver.entry) throw new GapError('map', `${quest} 的接取人没有落点`, giver.characterId);
    this.travelTo(giver.entry);
    return this.finish(quest, 'active', undefined, giver.entry, 'giver', [], undefined, giver);
  }

  private async acceptFromGiver(quest: string, giver: {characterId: string; placement?: EntityPlacement; entry?: DebugEntry}): Promise<void> {
    const definition = this.quest(quest);
    await this.ensureCondition(definition.availableWhen, 1);
    this.headless.session.refresh();
    const status = this.status(quest);
    // 前置回放可能已经把这个任务推进到进行中；此时不需要也不能再走一次接取。
    if (status === 'active' || status === 'ready') return;
    if (status === 'completed')
      throw new GapError('state', `${quest} 在接取前已经完成`, quest);
    if (status !== 'available')
      throw new GapError('condition', `${quest} 不是可接取状态，NPC 菜单不会列出`, quest);
    if (giver.entry) this.travelTo(giver.entry);
    const condition = (giver.placement as {condition?: StoryCondition} | undefined)?.condition;
    if (condition?.type === 'flag')
      this.command({type: 'world', command: {kind: 'flag', id: condition.flag, value: true}});
    this.command({type: 'quest', command: {type: 'accept', quest, source: 'interaction'}});
    this.headless.session.refresh();
    if (!['active', 'ready'].includes(this.status(quest)))
      throw new GapError('state', `${quest} 无法进入进行中`, quest);
  }

  // --------------------------------------------------------------- 回放

  private async replayEvent(eventId: string, depth: number, useBefore: boolean | undefined, branch = false): Promise<void> {
    if (depth > MAX_DEPTH) throw new GapError('budget', `前置链深度超过 ${MAX_DEPTH}`, eventId);
    const event = this.events.get(eventId);
    if (!event) { this.trace.push({kind: 'skip-missing-event', id: eventId}); return; }
    if (this.triggerSkips.has(eventId)) { this.trace.push({kind: 'skip-unreachable-event', id: eventId}); return; }
    if (this.completed(eventId) && !event.repeat) return;
    if (this.replaying.has(eventId)) return;
    if (useBefore === undefined) useBefore = event.condition === undefined;
    this.replaying.add(eventId);
    try {
      if (useBefore) for (const before of this.chainBefore(event.script, event)) await this.replayEvent(before, depth + 1, undefined);
      if (event.condition) {
        this.timelineBlocked = false;
        try {
          await this.ensureCondition(event.condition, depth + 1);
        } catch (error) {
          if (this.timelineBlocked) {
            this.trace.push({kind: 'skip-past-condition', id: eventId});
            return;
          }
          const gap = this.asGap(error);
          throw new GapError(gap.kind, `${eventId}: ${gap.detail}`, eventId, gap.fixHint);
        }
      }
      if (event.condition && !this.evaluate(event.condition)) {
        // 历史已经越过这个事件需要的状态（例如任务已完成、事件却要求进行中），
        // 不再强行回退，也不再重放它；否则会重复结算奖励或把任务拉回旧阶段。
        this.trace.push({kind: 'skip-unsatisfied-event', id: eventId});
        return;
      }
      // 选择分支事件在原版里紧跟父事件当前场景；用它的调试落点另开一张图会伪造世界命令。
      const branchContext = branch || (event.source === 'choice' && event.place?.type === 'current');
      if (!branchContext) {
        const entry = this.entryFor(event.script, event);
        if (entry) this.travelTo(entry);
      }
      const outcome = await this.replayScript(event.script, event.id, 1, branchContext);
      if (outcome.status !== 'completed' && outcome.status !== 'waiting')
        throw new GapError('script', `${eventId} 没有正常结束（${outcome.status}）`, eventId);
      this.trace.push({kind: 'event', id: eventId, script: event.script});
      await this.dispatchChoiceBranches(outcome.choices, event.script, depth + 1);
      if (outcome.status === 'completed') this.headless.recordOccurrence(event, 1);
    } finally {
      this.replaying.delete(eventId);
    }
  }

  private async replayScript(script: string, eventId: string | undefined, _depth: number, branch = false) {
    const result = await this.headless.replayScript(script, {
      ...(eventId ? {eventId} : {}),
      choices: {forced: Object.fromEntries(this.choiceEvidence), evidence: {},
        converged: Object.fromEntries(this.choiceConverged)},
      honorDeclaredMap: branch,
      script,
    });
    this.choices.push(...result.choices);
    this.battles.push(...result.battles);
    return result;
  }

  /** 选项点亮的分支事件由原版触发索引派发，运行时不会自动重放。 */
  private async dispatchChoiceBranches(decisions: ChoiceDecision[], script: string, depth: number): Promise<void> {
    for (const decision of decisions) {
      const point = (this.choicePoints[script] ?? []).find(row => row.choice === decision.choice && row.node === decision.node);
      const option = point?.options?.find(row => row.value === decision.value);
      for (const number of option?.branchEvents ?? []) {
        const eventId = `event-${number}`;
        if (eventId !== this.currentEvent(script) && this.events.has(eventId))
          await this.replayEvent(eventId, depth, false, true);
      }
    }
  }

  private currentEvent(script: string): string | undefined {
    return this.eventsByScript.get(script)?.id;
  }

  // ---------------------------------------------------------- 条件求解

  private async ensureCondition(condition: StoryCondition | undefined, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) throw new GapError('budget', '条件求解深度超过上限');
    if (!condition || this.evaluate(condition)) return;
    switch (condition.type) {
      case 'always':
        throw new GapError('condition', '内容里的 always 条件不成立');
      case 'all':
        for (const child of condition.conditions) await this.ensureCondition(child, depth + 1);
        if (!this.evaluate(condition)) throw new GapError('condition', `无法建立条件 ${canonicalJson(condition).slice(0, 120)}`);
        return;
      case 'any': {
        let last: GapError | undefined;
        for (const child of condition.conditions) {
          const saved = this.headless.capture();
          try {
            await this.ensureCondition(child, depth + 1);
            if (this.evaluate(condition)) return;
            this.headless.restore(saved);
          } catch (error) { last = this.asGap(error); this.headless.restore(saved); }
        }
        throw last ?? new GapError('condition', 'any 条件没有可建立的子项');
      }
      case 'not':
        throw new GapError('condition', '无法在正向链里建立 not 条件', undefined, '检查该条件是否本就应当不成立');
      case 'quest':
        if ((condition.status === 'completed' || condition.status === 'settled')
          && await this.completeNaturally(condition.quest, depth + 1)) return;
        this.forceQuest(condition.quest, condition.status);
        return;
      case 'event':
        if (condition.status !== 'completed')
          throw new GapError('condition', `无法把事件建立为 ${condition.status} 状态`, condition.event);
        await this.replayEvent(condition.event, depth + 1, undefined);
        return;
      case 'choice':
        this.command({type: 'world', command: {kind: 'choice', id: condition.choice, value: condition.value}});
        this.trace.push({kind: 'choice-direct', choice: condition.choice, value: condition.value});
        return;
      case 'flag':
        this.command({type: 'world', command: {kind: 'flag', id: condition.flag, value: condition.value !== false}});
        this.trace.push({kind: 'flag-direct', flag: condition.flag, value: condition.value !== false});
        return;
      case 'world':
        throw new GapError('condition', `无法建立世界条件 ${condition.key}`);
      default:
        throw new GapError('condition', `未知条件类型 ${(condition as {type: string}).type}`);
    }
  }

  private evaluate(condition: StoryCondition | undefined): boolean {
    return this.headless.session.evaluateCondition(condition as never);
  }

  /**
   * 尽量按原版完成事件把任务推到 completed，而不是直接改状态。
   * 这样奖励只结算一次，事件的世界效果也落在正确的时间点。
   */
  private async completeNaturally(quest: string, depth: number): Promise<boolean> {
    if (this.status(quest) === 'completed') return true;
    const key = `${quest}:natural-complete`;
    if (this.ensuring.has(key)) return false;
    this.ensuring.add(key);
    const choices = this.choices.length, battles = this.battles.length;
    try {
      const candidates = [...(this.completions.get(quest) ?? [])]
        .sort((left, right) => this.candidateKey(left, quest) - this.candidateKey(right, quest));
      // 完成脚本要求任务处于待交付；先补齐目标/运行池，再由脚本真正结算。
      this.forceQuest(quest, 'ready');
      for (const candidate of candidates) {
        const saved = this.headless.capture();
        try {
          // 完成脚本本身就是要按顺序执行的节点，不能沿父图回溯成接取事件。
          const root = candidate.script;
          const event = this.eventsByScript.get(root);
          const taskBefore = this.currentTask ? this.status(this.currentTask) : undefined;
          if (event?.condition) await this.ensureCondition(event.condition, depth + 1);
          const entry = this.entryFor(root, event, quest);
          if (entry) this.travelTo(entry);
          const outcome = await this.replayScript(root, event?.id, 1);
          if (outcome.status !== 'completed' && outcome.status !== 'waiting')
            throw new GapError('script', `${root} 没有正常结束（${outcome.status}）`, root);
          await this.dispatchChoiceBranches(outcome.choices, root, depth + 1);
          this.headless.session.refresh();
          // 完成前置任务的事件如果顺带把目标任务的开幕也演了，就不能在这里用；
          // 目标的开幕必须留给现场表演出。退回直接补状态。
          if (this.currentTask && taskBefore !== undefined
            && this.status(this.currentTask) !== taskBefore) {
            this.headless.restore(saved);
            this.choices.length = choices; this.battles.length = battles;
            continue;
          }
          if (this.status(quest) === 'completed') {
            this.trace.push({kind: 'quest-natural', quest, script: root});
            return true;
          }
        } catch (error) {
          if (!(error instanceof GapError)) throw error;
        }
        this.headless.restore(saved);
        this.choices.length = choices; this.battles.length = battles;
      }
      return false;
    } finally {
      this.ensuring.delete(key);
    }
  }

  private forceQuest(quest: string, wanted: string): void {
    const definition = this.quest(quest);
    const key = `${quest}:${wanted}`;
    if (this.ensuring.has(key)) throw new GapError('cycle', `任务前置 ${key} 形成循环`, quest);
    this.ensuring.add(key);
    try {
      const rank: Record<string, number> = {locked: 0, available: 1, active: 2, accepted: 2, ready: 3, completed: 4, settled: 4};
      const current = this.status(quest);
      // 剧情时间只能往前走：已经完成的任务不能为了满足旧条件退回进行中或可接取。
      if ((rank[wanted] ?? 0) < (rank[current] ?? 0)) {
        this.timelineBlocked = true;
        this.trace.push({kind: 'skip-rewind', quest, wanted, current});
        return;
      }
      // 物品目标先把数量补进背包，`refresh` 才能把任务簿推到 ready/completed。
      if (wanted === 'ready' || wanted === 'completed' || wanted === 'settled') {
        for (const goal of definition.goals) {
          if (goal.kind !== 'item') continue;
          const missing = Math.max(0, goal.quantity - this.headless.session.bag.count(goal.target));
          if (missing) this.headless.session.bag.add(goal.target, missing);
        }
        for (const row of definition.handoverItems ?? []) {
          const missing = Math.max(0, row.quantity - this.headless.session.bag.count(row.item));
          if (missing) this.headless.session.bag.add(row.item, missing);
        }
      } else if (wanted === 'active' || wanted === 'accepted') {
        for (const row of definition.onAcceptItems ?? [])
          this.headless.session.bag.add(row.item, row.quantity);
      }
      // 能走真实结算命令就先走：交接物品、奖励与周期记账都由任务簿完成。
      if (wanted === 'completed' || wanted === 'settled') {
        try {
          this.command({type: 'quest', command: {type: 'script-complete', quest}});
          this.headless.session.refresh();
          if (this.status(quest) === 'completed') {
            this.trace.push({kind: 'quest-settle', quest});
            return;
          }
        } catch {
          // 战斗/对话目标没有可结算事实，退回直接补状态并在下面清理交接物品。
        }
      }
      if (wanted === 'completed' || wanted === 'settled') {
        for (const row of definition.handoverItems ?? [])
          this.headless.session.bag.remove(row.item, row.quantity);
      }
      const state = this.headless.capture();
      const progress = state.questBook.quests.find(([id]) => id === quest)?.[1];
      if (!progress) throw new GapError('condition', `前置任务不存在：${quest}`, quest);
      const full = definition.goals.map(goal => [goal.id, goal.quantity] as [string, number]);
      const zero = definition.goals.map(goal => [goal.id, 0] as [string, number]);
      if (wanted === 'completed' || wanted === 'settled') {
        progress.status = 'completed';
        progress.completedCycles = Math.max(1, progress.completedCycles);
        progress.goals = Object.fromEntries(full);
        state.questBook.runningQuestIds = state.questBook.runningQuestIds.filter(id => id !== quest);
      } else if (wanted === 'ready') {
        progress.status = 'ready';
        progress.goals = Object.fromEntries(full);
        if (!state.questBook.runningQuestIds.includes(quest)) state.questBook.runningQuestIds.push(quest);
      } else if (wanted === 'active' || wanted === 'accepted') {
        progress.status = definition.completion === 'talk' ? 'ready' : 'active';
        progress.goals = Object.fromEntries(zero);
        if (!state.questBook.runningQuestIds.includes(quest)) state.questBook.runningQuestIds.push(quest);
      } else if (wanted === 'available') {
        if (['active', 'ready', 'completed'].includes(progress.status)) progress.cycle += 1;
        progress.status = 'available';
        progress.goals = Object.fromEntries(zero);
        state.questBook.runningQuestIds = state.questBook.runningQuestIds.filter(id => id !== quest);
      } else if (wanted === 'locked') {
        progress.status = 'locked';
        progress.goals = Object.fromEntries(zero);
        state.questBook.runningQuestIds = state.questBook.runningQuestIds.filter(id => id !== quest);
      } else {
        throw new GapError('condition', `未知任务状态 ${wanted}`, quest);
      }
      this.headless.session.restoreState(state);
      this.headless.syncRuntime();
      this.headless.session.refresh();
      this.trace.push({kind: 'quest-force', quest, wanted});
    } finally {
      this.ensuring.delete(key);
    }
  }

  private async ensureAvailable(quest: string, depth: number): Promise<void> {
    if (['available', 'active', 'ready', 'completed'].includes(this.status(quest))) return;
    await this.ensureCondition(this.quest(quest).availableWhen, depth + 1);
    this.headless.session.refresh();
    if (!['available', 'active', 'ready', 'completed'].includes(this.status(quest)))
      throw new GapError('condition', `${quest} 无法进入可接取状态`, quest);
  }

  // ------------------------------------------------------------ 路线读取

  private resolveRoot(script: string): string {
    if (this.eventsByScript.has(script)) return script;
    const seen = new Set([script]);
    const queue: [string, number][] = [[script, 0]];
    const candidates: {distance: number; isEvent: number; script: string}[] = [];
    while (queue.length) {
      const [current, distance] = queue.shift()!;
      for (const parent of this.parents.get(current) ?? []) {
        if (seen.has(parent)) continue;
        seen.add(parent); queue.push([parent, distance + 1]);
        candidates.push({distance: distance + 1, isEvent: this.eventsByScript.has(parent) ? 0 : 1, script: parent});
      }
    }
    candidates.sort((left, right) => right.distance - left.distance || left.isEvent - right.isEvent || left.script.localeCompare(right.script));
    return candidates[0]?.script ?? script;
  }

  private chainBefore(script: string, event: StoryEvent | undefined): string[] {
    const route = this.routes.get(script);
    let before = route?.before ?? [];
    const context = event ? this.contexts.events?.[this.eventNumber(event)] : undefined;
    if (context && context.before) before = context.before;
    return [...new Set(before)].filter(id => !this.triggerSkips.has(id) && this.events.has(id));
  }

  private eventNumber(event: StoryEvent): string {
    return event.id.split('-').at(-1) ?? event.id;
  }

  private entryFor(script: string, event: StoryEvent | undefined, quest?: string): DebugEntry | undefined {
    const routeEntry = this.routes.get(script)?.entry;
    const context = event ? this.contexts.events?.[this.eventNumber(event)] : undefined;
    if (context?.entry) {
      const map = this.mapName(context.map ?? routeEntry?.map ?? this.eventMap(event));
      if (map) return {type: 'fixed', map, x: context.entry.x, y: context.entry.y, source: 'debug-trigger-context'};
    }
    if (routeEntry) return {...routeEntry};
    const place = event?.place;
    if (place?.type === 'fixed') return {type: 'fixed', map: place.map, x: place.x, y: place.y, source: place.source ?? 'event-place'};
    const noteMap = event ? this.draft.mapEvidenceNotes?.[event.id]?.map : undefined;
    if (noteMap && routeEntry) return {...routeEntry, map: noteMap, source: 'map-evidence'};
    if (quest) {
      const questPlace = this.campaign.quests.find(row => row.id === quest)?.places;
      for (const phase of ['available', 'active'] as const) {
        const placeValue = questPlace?.[phase];
        if (placeValue?.type === 'fixed')
          return {type: 'fixed', map: placeValue.map, x: placeValue.x, y: placeValue.y, source: placeValue.source ?? 'quest-place'};
        if (placeValue?.type === 'alternatives') {
          const spot = placeValue.spots?.[0];
          if (spot) return {type: 'fixed', map: spot.map, x: spot.x, y: spot.y, source: spot.source ?? 'quest-place'};
        }
      }
    }
    return undefined;
  }

  private eventMap(event: StoryEvent | undefined): string | undefined {
    if (!event) return undefined;
    if (event.place?.type === 'fixed' && event.place.map) return this.mapName(event.place.map);
    if ('map' in event && typeof event.map === 'string') return this.mapName(event.map);
    return this.mapName(this.draft.mapEvidenceNotes?.[event.id]?.map);
  }

  private mapName(value: string | number | undefined): string | undefined {
    if (value === undefined) return undefined;
    return this.mapByNumber.get(String(value)) ?? String(value);
  }

  private hasPerformance(script: string): boolean {
    return !!this.campaign.scripts[script]?.nodes.some(node => node.presentation.length > 0);
  }

  private giver(questId: string): {characterId: string; actor?: string; placement?: EntityPlacement; entry?: DebugEntry} | undefined {
    const quest = this.quest(questId);
    if (!quest.giverCharacterId) return undefined;
    const placement = this.placements.find(row => row.characterId === quest.giverCharacterId);
    let entry = this.entryFor('', undefined, questId);
    if (placement) entry = {type: 'fixed', map: placement.map, x: placement.x, y: placement.y, source: 'quest-giver-placement'};
    return {characterId: quest.giverCharacterId, actor: quest.giver, ...(placement ? {placement} : {}), ...(entry ? {entry} : {})};
  }

  // ------------------------------------------------------------ 状态操作

  private travelTo(entry: DebugEntry): void {
    this.headless.travel({map: entry.map, x: entry.x, y: entry.y, facing: 'south'});
    this.trace.push({kind: 'travel', map: entry.map, x: entry.x, y: entry.y, source: entry.source});
  }

  private command(command: Parameters<HeadlessStory['session']['applyStoryCommands']>[0][number]): void {
    this.headless.session.applyStoryCommands([command]);
  }

  private status(quest: string): string {
    return this.headless.session.status(quest);
  }

  private completed(eventId: string): boolean {
    return this.headless.session.runtimeState.completedEvents.includes(eventId);
  }

  private flag(name: string): boolean {
    return this.headless.session.storyWorld.hasFlag(name);
  }

  private quest(id: string): CampaignQuest {
    const quest = this.campaign.quests.find(row => row.id === id);
    if (!quest) throw new GapError('condition', `任务不存在：${id}`, id);
    return quest;
  }

  private asGap(error: unknown): GapError & {stackDepth: number} {
    const gap = error instanceof GapError ? error : new GapError('internal', String(error));
    const depth = this.replaying.size + this.ensuring.size;
    return Object.assign(gap, {stackDepth: depth});
  }

  // -------------------------------------------------------------- 压缩

  private finish(quest: string, phase: 'available' | 'active', play: StoryDebugPlay | undefined,
    entry: DebugEntry, source: string, before: string[], opening: StoryEvent | undefined,
    giver?: {characterId: string; actor?: string; placement?: EntityPlacement}): StoryDebugTask {
    const start = this.compress(quest);
    const scripts = new Set<string>();
    if (opening) scripts.add(opening.script);
    for (const eventId of this.headless.session.runtimeState.completedEvents) {
      const event = this.events.get(eventId);
      if (event) scripts.add(event.script);
    }
    if (play) scripts.add(play.script);
    const task: StoryDebugTask = {
      quest, phase, entry, start, scripts: [...scripts].sort(),
      ...(play ? {play} : {}),
      basis: {
        source, before,
        opening: play ? {script: play.script, node: play.node ?? '', cut: play.cut, ...(play.event ? {event: play.event} : {})} : null,
        openingLocation: entry,
        steps: this.trace.slice(-24),
        choices: this.choices.slice(-24),
        battles: this.battles.slice(-24),
        ...(giver ? {giver} : {}),
      } as StoryDebugTask['basis'],
      sourceHash: '',
    };
    task.sourceHash = digest({quest, phase, start, play: play ?? null, before,
      interpreter: INTERPRETER_VERSION, semantics: SEMANTICS_VERSION});
    this.validate(task);
    return task;
  }

  private compress(quest: string): StoryDebugStartTable {
    const state = this.headless.capture();
    const base = this.base;
    const baseQuests = new Map(base.questBook.quests);
    const quests: NonNullable<StoryDebugStartTable['quests']> = [];
    for (const definition of this.campaign.quests) {
      const current = state.questBook.quests.find(([id]) => id === definition.id)?.[1];
      const original = baseQuests.get(definition.id);
      if (!current || !original) continue;
      const same = current.status === original.status && current.cycle === original.cycle
        && current.completedCycles === original.completedCycles
        && definition.goals.every(goal => (current.goals[goal.id] ?? 0) === (original.goals[goal.id] ?? 0));
      if (same) continue;
      const goals = Object.fromEntries(Object.entries(current.goals).filter(([, value]) => value));
      quests.push({id: definition.id, status: current.status,
        ...(current.cycle ? {cycle: current.cycle} : {}),
        ...(current.completedCycles ? {completedCycles: current.completedCycles} : {}),
        ...(Object.keys(goals).length ? {goals} : {})});
    }
    const world: NonNullable<StoryDebugStartTable['world']> = {
      location: state.storyWorld.location!,
      entities: state.storyWorld.entities,
      flags: [...state.storyWorld.flags],
      choices: [...state.storyWorld.choices],
      exits: [...state.storyWorld.exits],
      encounters: state.storyWorld.encounters,
      mapVisit: state.storyWorld.mapVisit,
      ...(state.storyWorld.enemyRemovals?.length ? {enemyRemovals: state.storyWorld.enemyRemovals} : {}),
      ...(state.storyWorld.enemyLocations?.length ? {enemyLocations: state.storyWorld.enemyLocations} : {}),
      ...(state.storyWorld.appearances?.length ? {appearances: state.storyWorld.appearances} : {}),
      ...(state.storyWorld.partyBuffs?.length ? {partyBuffs: state.storyWorld.partyBuffs} : {}),
    };
    const items = this.scenarioItems(quest);
    const itemIds = new Set(items.map(row => row.item));
    const reset = [...this.bagCounts()].filter(([item, quantity]) => quantity !== (this.bagBaseline.get(item) ?? 0))
      .map(([item]) => item).filter(item => !itemIds.has(item)).sort();
    const start: StoryDebugStartTable = {
      ...(quests.length ? {quests} : {}),
      running: [...state.questBook.runningQuestIds],
      world,
      ...(items.length ? {items} : {}),
      ...(reset.length ? {itemReset: reset} : {}),
      ...(state.runtime.completedEvents.length ? {completedEvents: state.runtime.completedEvents.map(id => ({id}))} : {}),
      ...(state.runtime.occurrenceSequences.length ? {occurrenceSequences: [...state.runtime.occurrenceSequences]} : {}),
      ...(state.factSequences.length ? {factSequences: [...state.factSequences]} : {}),
    };
    return start;
  }

  private scenarioItems(quest: string): {item: string; quantity: number}[] {
    const referenced = new Set<string>();
    for (const [id, progress] of this.headless.session.questBook.captureState().quests) {
      if (progress.status === 'locked' || progress.status === 'available') continue;
      const definition = this.quest(id);
      for (const goal of definition.goals) if (goal.kind === 'item') referenced.add(goal.target);
      for (const row of definition.handoverItems ?? []) referenced.add(row.item);
    }
    const target = this.quest(quest);
    for (const goal of target.goals) if (goal.kind === 'item') referenced.add(goal.target);
    for (const row of target.handoverItems ?? []) referenced.add(row.item);
    const bag = this.headless.session.bag;
    const items: {item: string; quantity: number}[] = [];
    for (const item of Object.keys(bag.catalog.items).sort()) {
      const category = this.items.items?.[item]?.category;
      if (!referenced.has(item) && category !== 'quest' && category !== 'material') continue;
      const quantity = bag.count(item);
      if (quantity > 0) items.push({item, quantity});
    }
    return items;
  }

  private bagCounts(): Map<string, number> {
    const bag = this.headless.session.bag;
    return new Map(Object.keys(bag.catalog.items).map(item => [item, bag.count(item)]));
  }

  private validate(task: StoryDebugTask): void {
    const state = this.headless.session.captureState();
    if (!state.storyWorld.location) throw new GapError('internal', '现场表缺少世界落点', task.quest);
    const elsewhere = new Map<string, string>();
    for (const definition of this.campaign.quests) {
      const progress = state.questBook.quests.find(([id]) => id === definition.id)?.[1];
      if (!progress) continue;
      if (['active', 'ready'].includes(progress.status) !== state.questBook.runningQuestIds.includes(definition.id))
        throw new GapError('state', `运行池与任务状态不一致：${definition.id}`, task.quest);
      if (progress.status === 'locked' || progress.status === 'available') continue;
      for (const goal of definition.goals) if (goal.kind === 'item')
        elsewhere.set(goal.target, `${definition.id}/${goal.id}`);
    }
    const phase = task.phase === 'available' ? ['available', 'active', 'ready', 'completed'] : ['active', 'ready'];
    if (!phase.includes(this.status(task.quest)))
      throw new GapError('state', `${task.quest} 起始状态是 ${this.status(task.quest)}`, task.quest);
  }
}

export function exitTargets(exit: StoryNodeRef | undefined | {type: string; [key: string]: unknown}): StoryNodeRef[] {
  if (!exit) return [];
  const value = exit as {type: string; target?: StoryNodeRef; then?: StoryNodeRef; otherwise?: StoryNodeRef;
    cases?: Record<string, StoryNodeRef>; outcomes?: Record<string, StoryNodeRef>};
  const refs: StoryNodeRef[] = [];
  for (const ref of [value.target, value.then, value.otherwise]) if (ref && typeof ref === 'object' && 'script' in ref) refs.push(ref);
  for (const ref of [...Object.values(value.cases ?? {}), ...Object.values(value.outcomes ?? {})])
    if (ref && typeof ref === 'object' && 'script' in ref) refs.push(ref);
  return refs;
}

export function catalogMeta(sources: Record<string, string>, coverage: StoryDebugCatalog['meta']['coverage']) {
  return {generator: 'story_debug_start.ts', interpreterVersion: INTERPRETER_VERSION,
    semanticsVersion: SEMANTICS_VERSION, sourceHash: digest(sources), generatedAt: '', sources, coverage};
}

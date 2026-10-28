import { validateStoryGraph } from './story-graph.ts';
import { STORY_TRIGGER_SOURCES } from './story-graph.ts';
import type { StoryCommand, StoryEvent, StoryGraph, StoryNode, StoryNodeRef, StoryTriggerSource } from './story-graph.ts';
import type { StoryCondition } from './story-condition.ts';
import { validateStoryStageSnapshot, type StoryStage, type StoryStageSnapshot } from './story-performance.ts';

export interface StoryOccurrence { id: string; sequence: number; source: StoryTriggerSource; key?: string; map?: string; mapVisit?: number; entity?: string }
interface StoryRun {
  id: string;
  script?: string;
  eventId?: string;
  occurrence: string;
  occurrenceSource?: StoryTriggerSource;
  occurrenceSequence?: number;
  cursor: StoryNodeRef;
  stack?: StoryNodeRef[];
  status: 'running' | 'waiting' | 'deferred' | 'completed';
  stage?: StoryStageSnapshot;
  waiting?: { encounter: string; outcomes: Record<string, StoryNodeRef> };
}
interface StoryPendingOccurrence { occurrence: StoryOccurrence; nextEventIndex: number }
export interface StoryRuntimeSnapshot {
  /** 2 = 运行中的完整快照；3 = 存档检查点，演员外观已剥离。 */
  version: 2 | 3;
  sequence: number;
  runs: StoryRun[];
  completedEvents: string[];
  handledOccurrences: [string, string][];
  encounterResults: string[];
  pendingOccurrences: StoryPendingOccurrence[];
  occurrenceSequences: [string, number][];
}
export interface StoryPlaybackContext {
  signal: AbortSignal;
  epoch: number;
  runId: string;
  stage?: StoryStage | StoryStageSnapshot;
}
export interface StoryNodeCommit {
  commands: StoryCommand[];
  checkpoint: StoryRuntimeSnapshot;
  eventId?: string;
  node: StoryNodeRef;
  runId: string;
  stage?: StoryStageSnapshot;
}
/** commit 同步原子写入领域状态和 checkpoint；prepare 只预备资源，不修改游戏状态。 */
export interface StoryRuntimePort {
  prepare(node: StoryNode, context: StoryPlaybackContext): Promise<void>;
  capture(): unknown;
  currentMap?():string|undefined;
  present(node: StoryNode, context: StoryPlaybackContext): Promise<{ choice?: string; stage?: StoryStageSnapshot }>;
  finish(context: StoryPlaybackContext): Promise<void>;
  commit(commit: StoryNodeCommit): void;
  afterCommit?(commit: StoryNodeCommit, context: StoryPlaybackContext): Promise<void>;
  recover?(context: StoryPlaybackContext): Promise<void>;
  checkpoint?(snapshot: StoryRuntimeSnapshot): void;
  rollback(baseline: unknown, context: StoryPlaybackContext): void;
  evaluate(condition: StoryCondition, pendingCommands?: readonly StoryCommand[]): boolean;
  validOccurrence?(occurrence: StoryOccurrence): boolean;
  onBusy?(busy: boolean): void;
}
interface PendingWork { work: (signal: AbortSignal, epoch: number) => Promise<boolean>; resolve: (value: boolean) => void; reject: (error: unknown) => void }
const emptySnapshot = (): StoryRuntimeSnapshot => ({ version: 2, sequence: 0, runs: [], completedEvents: [], handledOccurrences: [], encounterResults: [], pendingOccurrences: [], occurrenceSequences: [] });
const clone = <T>(value: T): T => structuredClone(value);

/** 一个前台导演；提交后的节点与等待遭遇都可以独立恢复。 */
export class StoryRuntime {
  private readonly graph: StoryGraph;
  private readonly port: StoryRuntimePort;
  private readonly nodes = new Map<string, StoryNode>();
  private readonly eventIndex = new Map<StoryTriggerSource, StoryEvent[]>();
  private state: StoryRuntimeSnapshot = emptySnapshot();
  private queue: PendingWork[] = [];
  private controller = new AbortController();
  private epoch = 0;
  private draining = false;
  /**
   * 「这次 drain 真的接过游戏」——只有确认要执行节点时才为真。
   *
   * 入队的通知大多筛不到事件（每只普通怪死亡都会报一次 `defeat:`，而内容里只有十几条
   * 击败事件），队列非空并不等于剧情要接管。上锁会重置输入、停移动、把主角切回待机并隐藏
   * 操作界面，所以它必须跟着「要播」走，而不是跟着「有活干」走。
   */
  private playing = false;
  private active?: { baseline: unknown; context: StoryPlaybackContext };
  private pending?: { work: PendingWork; epoch: number };
  private static nodeKey(ref: StoryNodeRef): string { return JSON.stringify([ref.script, ref.node]); }
  constructor(graph: StoryGraph, port: StoryRuntimePort) {
    validateStoryGraph(graph); this.graph = clone({version:graph.version,scripts:graph.scripts,events:graph.events}); this.port = port;
    for (const [script, definition] of Object.entries(this.graph.scripts))
      for (const node of definition.nodes) this.nodes.set(StoryRuntime.nodeKey({ script, node: node.id }), node);
    this.graph.events.forEach(event => {
      const list = this.eventIndex.get(event.source) ?? [];
      list.push(event); this.eventIndex.set(event.source, list);
    });
    for (const list of this.eventIndex.values()) list.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  }
  get busy(): boolean { return this.playing; }
  /**
   * 进入「接管游戏」状态。筛选阶段不调用；只有确定要执行节点时才调用。
   * 一次 drain 至多进入一次，因此队列里几经反复也只有一对 `onBusy`。
   */
  private enterPlayback(): void {
    if (this.playing) return;
    this.playing = true;
    this.port.onBusy?.(true);
  }
  /**
   * 退出「接管游戏」状态。**必须先翻标志再回调**：端口回调（`StoryDirector.release`）
   * 会读 `runtime.busy` 决定要不要真的解锁，顺序反了锁就永远放不掉。
   */
  private leavePlayback(): void {
    if (!this.playing) return;
    this.playing = false;
    this.port.onBusy?.(false);
  }
  eventStatus(id: string): 'completed' | 'running' | 'waiting' | 'idle' {
    const run = [...this.state.runs].reverse().find(run => run.eventId === id && ['running', 'waiting'].includes(run.status));
    if (run) return run.status as 'running' | 'waiting';
    return this.state.completedEvents.includes(id) ? 'completed' : 'idle';
  }
  snapshot(): StoryRuntimeSnapshot { return clone(this.state); }
  /** 这个运行当前走到哪个脚本；供演出提前准备它可能跨到的地图。 */
  runScript(id: string): string | undefined { return this.state.runs.find(run => run.id === id)?.cursor.script; }
  prepareRestore(snapshot: StoryRuntimeSnapshot): StoryRuntimeSnapshot {
    const result = clone(snapshot);
    if ((result.version !== 2 && result.version !== 3) || !Number.isSafeInteger(result.sequence) || result.sequence < 0) throw new Error('剧情检查点版本或序号无效');
    const ids = new Set<string>();
    const activeEvents = new Set<string>();
    for (const run of result.runs) {
      if (!run.id || ids.has(run.id) || !['running', 'waiting', 'deferred', 'completed'].includes(run.status)) throw new Error('剧情运行标识或状态无效');
      ids.add(run.id);
      if (!this.nodes.has(StoryRuntime.nodeKey(run.cursor))) throw new Error(`剧情检查点节点不存在：${run.cursor.script}/${run.cursor.node}`);
      if (run.script && !this.graph.scripts[run.script]) throw new Error(`剧情检查点入口脚本不存在：${run.script}`);
      if (run.stack) {
        if(run.stack.length>32)throw new Error('剧情调用层级超过限制');
        for(const reference of run.stack)if(!this.nodes.has(StoryRuntime.nodeKey(reference)))throw new Error('剧情返回节点不存在');
      }
      if (run.eventId && !this.graph.events.some(event => event.id === run.eventId)) throw new Error(`剧情检查点事件不存在：${run.eventId}`);
      if (run.eventId && ['running', 'waiting'].includes(run.status)) {
        if (activeEvents.has(run.eventId)) throw new Error('剧情检查点事件重复运行：'+run.eventId);
        activeEvents.add(run.eventId);
      }
      if (run.occurrenceSequence !== undefined && (!Number.isSafeInteger(run.occurrenceSequence) || run.occurrenceSequence < 0)) throw new Error('剧情运行发生序号无效');
      if (run.stage) validateStoryStageSnapshot(run.stage);
      if (run.status === 'waiting' && (!run.waiting || !run.waiting.encounter)) throw new Error('等待战斗的剧情缺少遭遇实例');
      if (run.waiting) {
        if (run.status !== 'waiting' || !Object.keys(run.waiting.outcomes).length) throw new Error('剧情等待状态与结果不一致');
        for (const ref of Object.values(run.waiting.outcomes)) if (!this.nodes.has(StoryRuntime.nodeKey(ref))) throw new Error('遭遇恢复节点不存在');
      }
    }
    for (const pending of result.pendingOccurrences) {
      if (!pending.occurrence.id || !(STORY_TRIGGER_SOURCES as readonly string[]).includes(pending.occurrence.source)
        || pending.occurrence.mapVisit !== undefined && (!Number.isSafeInteger(pending.occurrence.mapVisit) || pending.occurrence.mapVisit < 0)
        || !Number.isSafeInteger(pending.occurrence.sequence) || pending.occurrence.sequence < 0 || !Number.isSafeInteger(pending.nextEventIndex) || pending.nextEventIndex < 0
        || pending.nextEventIndex > (this.eventIndex.get(pending.occurrence.source)?.length ?? 0)) throw new Error('剧情待处理候选无效');
    }
    if (new Set(result.pendingOccurrences.map(value=>this.occurrenceKey(value.occurrence))).size !== result.pendingOccurrences.length) throw new Error('剧情待处理发生标识重复');
    for (const [event, occurrence] of result.handledOccurrences) if (!occurrence || !this.graph.events.some(value => value.id === event)) throw new Error('剧情触发记账引用不存在');
    if (result.encounterResults.length > 64 || result.encounterResults.some(id => !id)) throw new Error('剧情遭遇结果记账无效');
    if (new Set(result.occurrenceSequences.map(([key]) => key)).size !== result.occurrenceSequences.length
      || result.occurrenceSequences.some(([key, sequence]) => !key || !Number.isSafeInteger(sequence) || sequence < 0)) throw new Error('剧情触发发生序号无效');
    for (const id of result.completedEvents) if (!this.graph.events.some(event => event.id === id)) throw new Error(`已完成事件不存在：${id}`);
    if (new Set(result.completedEvents).size !== result.completedEvents.length || new Set(result.encounterResults).size !== result.encounterResults.length) throw new Error('剧情检查点记账重复');
    return result;
  }
  restore(snapshot: StoryRuntimeSnapshot): void {
    const next = this.prepareRestore(snapshot);
    // Explicit restoration replaces the old baseline; cancel only its pending playback.
    this.active = undefined; this.cancel(); this.state = next;
  }
  cancel(): void {
    const active = this.active; this.active = undefined;
    this.controller.abort();
    try { if (active) this.port.rollback(active.baseline, active.context); }
    finally {
      this.pending?.work.resolve(false); this.pending = undefined;
      this.epoch++; this.controller = new AbortController();
      for (const pending of this.queue.splice(0)) pending.resolve(false);
      // `leavePlayback` 只在真的在播放时才通知端口，因此取消一次纯筛选不会放掉别人的锁。
      this.draining = false; this.leavePlayback();
    }
  }
  private enqueue(work: PendingWork['work']): Promise<boolean> {
    const result = new Promise<boolean>((resolve, reject) => this.queue.push({ work, resolve, reject }));
    void this.drain(); return result;
  }
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    const epoch = this.epoch, signal = this.controller.signal;
    try {
      while (this.queue.length && this.current(epoch, signal)) {
        const pending = this.queue.shift()!; this.pending = { work: pending, epoch };
        try { pending.resolve(await pending.work(signal, epoch)); }
        catch (error) {
          if (!this.current(epoch, signal) || this.isAbort(error)) pending.resolve(false);
          else {
            pending.reject(error);
            // Keep occurrences in the checkpoint; recovery first resumes the failed node.
            for (const queued of this.queue.splice(0)) queued.resolve(false);
            break;
          }
        }
        finally { if (this.pending?.epoch === epoch) this.pending = undefined; }
      }
    } finally {
      if (this.epoch === epoch) {
        this.draining = false;
        try { this.port.checkpoint?.(this.snapshot()); } finally { this.leavePlayback(); }
      }
    }
  }
  private current(epoch: number, signal: AbortSignal): boolean { return epoch === this.epoch && !signal.aborted; }
  private isAbort(error: unknown): boolean { return error instanceof DOMException && error.name === 'AbortError'; }
  private guard(epoch: number, signal: AbortSignal): void { if (!this.current(epoch, signal)) throw new DOMException('剧情已取消', 'AbortError'); }
  private handled(event: StoryEvent, occurrence: Pick<StoryOccurrence, 'id' | 'source'> & { sequence?: number }): boolean {
    const watermark = this.state.occurrenceSequences.find(([key]) => key === JSON.stringify([event.id, occurrence.source]))?.[1];
    return (occurrence.sequence !== undefined && watermark !== undefined && occurrence.sequence <= watermark)
      || this.state.handledOccurrences.some(([id, source]) => id === event.id && source === occurrence.id)
      || (!event.repeat && this.state.completedEvents.includes(event.id))
      || this.state.runs.some(run => run.eventId === event.id && ['running', 'waiting'].includes(run.status));
  }
  private occurrenceKey(occurrence: StoryOccurrence): string { return JSON.stringify([occurrence.source, occurrence.id]); }
  dispatch(occurrence: StoryOccurrence): Promise<boolean> {
    if (!occurrence.id || !Number.isSafeInteger(occurrence.sequence) || occurrence.sequence < 0) return Promise.reject(new Error('剧情触发必须有本次发生的标识和递增序号')); 
    const key = this.occurrenceKey(occurrence);
    if (!this.state.pendingOccurrences.some(pending => this.occurrenceKey(pending.occurrence) === key))
      this.state.pendingOccurrences.push({ occurrence: clone(occurrence), nextEventIndex: 0 });
    return this.enqueue((signal, epoch) => this.processOccurrence(key, signal, epoch));
  }
  private async processOccurrence(key: string, signal: AbortSignal, epoch: number): Promise<boolean> {
    const pending = this.state.pendingOccurrences.find(pending => this.occurrenceKey(pending.occurrence) === key);
    if (!pending) return false;
    const occurrence = pending.occurrence, events = this.eventIndex.get(occurrence.source) ?? [];
    let played = false;
    for (let index = pending.nextEventIndex; index < events.length; index++) {
      this.guard(epoch, signal);
      if (this.port.validOccurrence?.(occurrence) === false) break;
      const event = events[index];
      // 存储剩余候选；当前节点由 runs 独立恢复。
      const current = this.state.pendingOccurrences.find(pending => this.occurrenceKey(pending.occurrence) === key)!;
      current.nextEventIndex = index + 1;
      const expectedKey=event.key??(event.source==='near'?event.nearCharacterId??event.near:event.source==='region'?event.id:undefined);
      if ((expectedKey !== undefined && expectedKey !== occurrence.key) || (event.map !== undefined && event.map !== occurrence.map)
        || (event.entity !== undefined && event.entity !== occurrence.entity) || this.handled(event, occurrence)
        || (event.condition && !this.port.evaluate(event.condition))) continue;
      // 走到这里说明这次通知真的匹配到了事件：从这一刻起剧情要接管游戏。
      this.enterPlayback();
      const run = this.createRun(event.script, event.id, occurrence.id, occurrence);
      played = await this.execute(run.id, signal, epoch) || played;
    }
    this.state.pendingOccurrences = this.state.pendingOccurrences.filter(pending => this.occurrenceKey(pending.occurrence) !== key);
    return played;
  }
  /** `node` 只给调试入口用：从任意节点强制开演，正常触发始终从脚本 entry 开始。 */
  start(script: string, eventId?: string, occurrence = `manual:${this.state.sequence + 1}`, node?: string): Promise<boolean> {
    const graph = this.graph.scripts[script];
    if (!graph) return Promise.reject(new Error(`未找到剧情：${script}`));
    if (node !== undefined && !graph.nodes.some(entry => entry.id === node))
      return Promise.reject(new Error(`未找到剧情节点：${script}/${node}`));
    return this.enqueue(async (signal, epoch) => {
      const event = eventId ? this.graph.events.find(event => event.id === eventId) : undefined;
      if (eventId && !event) throw new Error(`未找到剧情事件：${eventId}`);
      const recovering = this.state.runs.find(run => run.status === 'running' && (run.script ?? run.cursor.script) === script && run.eventId === eventId);
      if (recovering) { this.enterPlayback(); return this.execute(recovering.id, signal, epoch); }
      if (event && this.handled(event, { id: occurrence, source: event.source })) return false;
      this.enterPlayback();
      return this.execute(this.createRun(script, eventId, occurrence, undefined, node).id, signal, epoch);
    });
  }
  resume(): Promise<boolean> {
    return this.enqueue(async (signal, epoch) => {
      // 只有真的有节点在跑才需要接管（重试失败节点就是这种情况）。空恢复——比如读档进场——
      // 不该闪一次锁；待处理的候选由下面的 `processOccurrence` 在自己匹配时进入。
      if (this.state.runs.some(run => run.status === 'running')) this.enterPlayback();
      await this.port.recover?.({ signal, epoch, runId: 'recovery' }); this.guard(epoch, signal);
      let played = false;
      for (const run of [...this.state.runs]) if (run.status === 'running') played = await this.execute(run.id, signal, epoch) || played;
      for (const pending of [...this.state.pendingOccurrences]) played = await this.processOccurrence(this.occurrenceKey(pending.occurrence), signal, epoch) || played;
      return played;
    });
  }
  private createRun(script: string, eventId: string | undefined, occurrence: string, source?: StoryOccurrence, entryNode?: string): StoryRun {
    let id = `story:${++this.state.sequence}`;
    while (this.state.runs.some(run => run.id === id)) id = `story:${++this.state.sequence}`;
    const run: StoryRun = { id, script, eventId, occurrence, occurrenceSource: source?.source, occurrenceSequence: source?.sequence,
      cursor: { script, node: entryNode ?? this.graph.scripts[script].entry }, status: 'running' };
    this.state.runs.push(run); return run;
  }
  private publish(commit: StoryNodeCommit): void { this.port.commit(clone(commit)); this.state = commit.checkpoint; }
  private async execute(id: string, signal: AbortSignal, epoch: number): Promise<boolean> {
    let committed = false;
    // 内容环仍受执行预算约束；有出口的循环也可能因条件配置永远走回原处。
    for (let steps = 0; steps < 1000; steps++) {
      this.guard(epoch, signal);
      const run = this.state.runs.find(run => run.id === id)!;
      if (run.status !== 'running') return committed;
      const node = this.nodes.get(StoryRuntime.nodeKey(run.cursor))!;
      const context: StoryPlaybackContext = { signal, epoch, runId: id, stage: clone(node.stage ?? run.stage) };
      await this.port.prepare(node, context); this.guard(epoch, signal);
      const baseline = this.port.capture(); this.active = { baseline, context };
      try {
        const result = await this.port.present(node, context); this.guard(epoch, signal);
        await this.port.finish(context); this.guard(epoch, signal);
        const next = clone(this.state), nextRun = next.runs.find(run => run.id === id)!;
        if (result.stage) validateStoryStageSnapshot(result.stage);
        nextRun.stage = clone(result.stage ?? run.stage);
        const commands = clone(node.commands);
        for(const command of commands)if(command.type==='world'&&(command.command.kind==='place'||command.command.kind==='remove-character'||command.command.kind==='enemy-location')&&command.command.mapFromStage){
          const map=nextRun.stage?.map??this.port.currentMap?.();
          if(!map)throw new Error('剧情物件缺少当前地图');
          if(command.command.kind==='place')command.command.entity.map=map;
          else if(command.command.kind==='enemy-location'){if(command.command.location)command.command.location.map=map;}
          else command.command.map=map;
          delete command.command.mapFromStage;
        }
        switch (node.exit.type) {
          case 'next': nextRun.cursor = clone(node.exit.target); break;
          case 'call': {
            nextRun.stack = [...nextRun.stack ?? [], clone(node.exit.then)];
            if (nextRun.stack.length > 32) throw new Error('剧情调用层级超过限制');
            nextRun.cursor = clone(node.exit.target); break;
          }
          case 'branch': nextRun.cursor = clone(this.port.evaluate(node.exit.condition, commands) ? node.exit.then : node.exit.otherwise); break;
          case 'choice': {
            if (result.choice === undefined) throw new Error('剧情选择没有返回结果');
            const target = node.exit.cases[result.choice] ?? node.exit.otherwise;
            if (!target) throw new Error(`剧情选择未配置出口：${result.choice}`);
            commands.push({ type: 'choice', choice: node.exit.choice, value: result.choice }); nextRun.cursor = clone(target); break;
          }
          case 'waitEncounter': {
            const encounter = clone(node.exit.encounter);
            if(encounter.mapFromStage){encounter.map=nextRun.stage?.map??this.port.currentMap?.()??encounter.map;delete encounter.mapFromStage;}
            encounter.definitionId ??= encounter.id;
            encounter.id = `${id}:${node.id}:${encounter.id}`; encounter.status = 'active';
            commands.push({ type: 'encounter', encounter });
            nextRun.status = 'waiting'; nextRun.waiting = { encounter: encounter.id, outcomes: clone(node.exit.outcomes) }; break;
          }
          case 'defer': nextRun.status = 'deferred'; break;
          case 'end': {
            const returning = nextRun.stack?.pop();
            if (returning) { nextRun.cursor = returning; break; }
            nextRun.status = 'completed';
            if (run.eventId && !next.completedEvents.includes(run.eventId)) next.completedEvents.push(run.eventId); break;
          }
        }
        if (run.eventId && nextRun.status !== 'running' && !next.handledOccurrences.some(([event, occurrence]) => event === run.eventId && occurrence === run.occurrence))
          { next.handledOccurrences = next.handledOccurrences.filter(([event]) => event !== run.eventId); next.handledOccurrences.push([run.eventId, run.occurrence]); }
        if (run.eventId && run.occurrenceSource !== undefined && run.occurrenceSequence !== undefined && nextRun.status !== 'running') {
          const sourceKey = JSON.stringify([run.eventId, run.occurrenceSource]);
          next.occurrenceSequences = next.occurrenceSequences.filter(([key]) => key !== sourceKey);
          next.occurrenceSequences.push([sourceKey, run.occurrenceSequence]);
        }
        if (nextRun.status === 'completed' || nextRun.status === 'deferred') next.runs = next.runs.filter(candidate =>
          candidate.id === id || candidate.status === 'running' || candidate.status === 'waiting'
          || (run.eventId ? candidate.eventId !== run.eventId : candidate.eventId !== undefined || candidate.cursor.script !== nextRun.cursor.script));
        const stage = clone(nextRun.stage);
        if (nextRun.status !== 'running' || commands.some(command => command.type === 'travel' || command.type === 'world' && command.command.kind === 'travel')) delete nextRun.stage;
        const commit = { commands, checkpoint: next, eventId: run.eventId, node: clone(run.cursor), runId: id, stage };
        this.publish(commit);
        this.active = undefined; committed = true;
        await this.port.afterCommit?.(commit, context); this.guard(epoch, signal);
      } catch (error) {
        if (this.current(epoch, signal) && this.active) { this.active = undefined; this.port.rollback(baseline, context); }
        throw error;
      }
    }
    throw new Error('剧情连续节点超过执行预算，请检查条件循环');
  }
  encounterResult(encounter: string, outcome: string, resultId: string): Promise<boolean> {
    if (!resultId) return Promise.reject(new Error('剧情遭遇结果必须有本次发生的标识'));
    return this.enqueue(async (signal, epoch) => {
      if (this.state.encounterResults.includes(resultId)) return false;
      const run = this.state.runs.find(run => run.status === 'waiting' && run.waiting?.encounter === encounter);
      if (!run) return false;
      const target = run.waiting!.outcomes[outcome];
      if (!target) throw new Error(`剧情遭遇未配置结果：${outcome}`);
      const next = clone(this.state), nextRun = next.runs.find(candidate => candidate.id === run.id)!;
      nextRun.cursor = clone(target); nextRun.status = 'running'; delete nextRun.waiting; next.encounterResults.push(resultId); next.encounterResults = next.encounterResults.slice(-64);
      const commands: StoryCommand[] = outcome === 'won' || outcome === 'lost' ? [{ type: 'world', command: { kind: 'encounter-result', id: encounter, result: outcome } }] : [];
      this.enterPlayback();
      this.publish({ commands, checkpoint: next, eventId: run.eventId, node: clone(run.cursor), runId: run.id });
      return this.execute(run.id, signal, epoch);
    });
  }
}

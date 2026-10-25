import { storyCommitCommands } from './story-commit.ts';
import type { ActorDefinition, ChoiceOption, DialogueLine, EntityPlacement, QuestRewardReceipt, StoryTrigger, TravelDestination } from './content.ts';
import type { Campaign, CampaignQuest } from './campaign.ts';
import type { PerformanceAction, StoryPresentationPort, StoryStage, StoryStageSnapshot } from './story-performance.ts';
import type { Session, SessionState } from './session.ts';
import { StoryRuntime } from './story-runtime.ts';
import type { StoryNodeCommit, StoryOccurrence, StoryPlaybackContext } from './story-runtime.ts';
import type { StoryCommand, StoryEvent, StoryNode, StoryTriggerSource } from './story-graph.ts';
import { healerRevivalQuote } from './party-revival.ts';

export interface StoryUI {
  dialogue(line: DialogueLine, signal?: AbortSignal): Promise<void>;
  choice(prompt: string, options: ChoiceOption[], description?: string, signal?: AbortSignal): Promise<ChoiceOption>;
  questPopup(kind: 'start' | 'complete', quest: CampaignQuest, reward?: QuestRewardReceipt, signal?: AbortSignal): Promise<void>;
  toast(message: string): void;
  closeDialogue(): void;
  skipDialogue(): void;
}

/** 世界负责把已经提交的游戏状态投影到 Phaser 场景。 */
export interface StoryWorldPort {
  normalize?(signal: AbortSignal): void | Promise<void>;
  prepare?(commands: readonly StoryCommand[], signal: AbortSignal, stage?: StoryStage): Promise<void>;
  /** 演出前确认脚本可能经过的地图素材；缺则显示加载页等齐，保证演出结束后不再加载。 */
  prefetch?(scripts: readonly string[], signal: AbortSignal): void | Promise<void>;
  capture(): unknown;
  restore(snapshot: unknown, signal: AbortSignal): Promise<void>;
  project(stage: StoryStageSnapshot | undefined, signal: AbortSignal): Promise<void>;
  checkpoint(): void;
}
interface PlaybackBaseline { session: SessionState; world?: unknown; stage?: StoryStageSnapshot }

/** 节点先完成表现，再一次提交状态；场景重建失败可以从已提交节点继续。 */
export class StoryDirector {
  private readonly campaign: Campaign;
  private readonly session: Session;
  private readonly ui: StoryUI;
  private readonly onLock: (locked: boolean) => void;
  private readonly presentation?: StoryPresentationPort;
  private readonly world?: StoryWorldPort;
  readonly runtime: StoryRuntime;
  private manualBusy = false;
  private manual = new AbortController();
  private manualSettled: Promise<void> = Promise.resolve();
  private debugJumpPending = false;
  private skipping = false;
  private choosing = false;
  private confirming = false;
  private presenting = false;
  private presentationStarted = false;
  /** 手动播放（交付、对话）期间产生的会话变化，等这次播放完全收起后再开演。 */
  private readonly deferredTriggers: (()=>void)[] = [];
  private skipRequest = new AbortController();
  private context?: StoryPlaybackContext;
  private locked = false;
  private cleanup: Promise<void> = Promise.resolve();
  private recovery?: PlaybackBaseline;
  private restoring = false;
  private restorationVersion: number;
  private disposed = false;
  private unsubscribe: () => void;
  private projectionPending = false;
  private rollbackPresentation = false;
  private projectionStage?: StoryStageSnapshot;
  private travelPending?: TravelDestination;
  /** 转场已经落到正式世界；投影失败重试时只重做投影，不重复建图与切音乐。 */
  private travelApplied = false;
  private unsubscribeDefeats: () => void;
  /** 本次运行已经交给世界预取过的脚本；换一个 run 重新确认。 */
  private readonly prefetchedScripts = new Set<string>();
  private prefetchedRun?: string;
  private observedEvents = new Set<string>();
  private observedQuests = new Map<string, string>();
  private observedQuestVersion?: number;
  private observedItems = new Map<string, number>();
  private observedBagRevision?: number;
  /** 事件按 source/key 预索引：受击与会话派发不必再扫全部事件表。 */
  private readonly eventsByKey = new Map<string, StoryEvent[]>();
  private readonly keylessEvents = new Map<string, StoryEvent[]>();
  private observedChoices = new Map<string, string>();
  private observedEncounters = new Map<string, string>();
  onTravel?: (destination: TravelDestination, signal: AbortSignal) => void | Promise<void>;
  onError?: (error: unknown, retry: () => Promise<boolean>) => void;
  /** 本次播出的第一段画面已经画出；进图加载界面据此收起，避免先露一帧地图。 */
  onPresentationStarted?: () => void;
  /**
   * 一个剧情事件播完（不是每个节点）。世界投影已经结束才会回调，所以这时候
   * 会话和世界是同一份状态，自动存档可以安全地抓快照。
   */
  onEventCompleted?: (eventId: string) => void;

  constructor(campaign: Campaign, session: Session, ui: StoryUI,
    onLock: (locked: boolean) => void, presentation?: StoryPresentationPort, world?: StoryWorldPort) {
    this.campaign = campaign; this.session = session; this.ui = ui; this.onLock = onLock; this.presentation = presentation; this.world = world;
    this.restorationVersion = session.restorationVersion;
    this.runtime = new StoryRuntime(campaign, {
      currentMap:()=>this.session.storyWorld.currentLocation?.map,
      prepare: (node, context) => this.prepare(node, context),
      capture: () => {
        this.session.runtimeState = this.runtime.snapshot();
        return { session: this.session.captureState(), world: this.world?.capture(), stage: this.presentation?.getStageState?.() } satisfies PlaybackBaseline;
      },
      present: (node, context) => this.present(node, context),
      finish: async context => { if (this.presenting) await this.presentation!.finish(true, context.signal); },
      commit: commit => this.commit(commit),
      afterCommit: async (commit, context) => {
        await this.project(context.signal);
        const run = commit.checkpoint.runs.find(candidate => candidate.id === commit.runId);
        if (commit.eventId && run?.status === 'completed') this.onEventCompleted?.(commit.eventId);
      },
      recover: context => this.recover(context.signal),
      checkpoint: snapshot => { this.session.runtimeState = snapshot; },
      rollback: baseline => {
        this.restoring = true;
        try { this.session.restoreState((baseline as PlaybackBaseline).session); }
        finally { this.restorationVersion = this.session.restorationVersion; this.restoring = false; }
        this.recovery = baseline as PlaybackBaseline;
        this.rollbackPresentation = this.presenting;
      },
      evaluate: (condition, commands) => this.session.evaluateCondition(condition, commands),
      validOccurrence: occurrence => (!occurrence.map || !this.session.storyWorld.currentLocation || occurrence.map === this.session.storyWorld.currentLocation.map)
        && (occurrence.mapVisit === undefined || occurrence.mapVisit === this.session.storyWorld.visit),
      onBusy: busy => {
        if (busy) { if (!this.manualBusy) this.resetPlayback(); this.setLocked(true); }
        else if (!this.manualBusy) this.release();
      },
    });
    this.unsubscribeDefeats = session.subscribeDefeats(enemy => {
      void this.notify('battle', 'defeat:' + enemy, session.storyWorld.currentLocation?.map).catch(error => {
        if (this.onError) this.onError(error, () => this.retry()); else console.error(error);
      });
    });
    this.runtime.restore(session.runtimeState);
    this.projectionPending = session.runtimeState.runs.length > 0;
    for (const event of campaign.events) {
      const key = `${event.source}\0${event.key ?? ''}`;
      const list = this.eventsByKey.get(key);
      if (list) list.push(event); else this.eventsByKey.set(key, [event]);
      if (event.key === undefined) {
        const sourceList = this.keylessEvents.get(event.source);
        if (sourceList) sourceList.push(event); else this.keylessEvents.set(event.source, [event]);
      }
    }
    this.observeChanges(false);
    this.unsubscribe = session.subscribe(() => {
      if (this.restoring || this.restorationVersion !== session.restorationVersion) {
        if (!this.restoring) {
          this.restorationVersion = session.restorationVersion;
          this.runtime.restore(session.runtimeState); this.recovery = undefined; this.projectionPending = true;
        }
        this.observeChanges(false); return;
      }
      this.observeChanges(true);
    });
  }
  private observeChanges(dispatch: boolean): void {
    const changes: { source: StoryTriggerSource; key: string }[] = [];
    // 任务簿版本没动就说明任务状态没动：逐条序列化 505 条状态只在版本变化时才值得做，
    // 而 `emit` 的频率远高于任务真正变化的频率。
    const questVersion = this.session.questBook.version;
    if (questVersion !== this.observedQuestVersion) {
      const quests = new Map([...this.session.quests].map(([id, state]) => [id, JSON.stringify(state)]));
      for (const [id, state] of quests) if (this.observedQuests.get(id) !== state) changes.push({ source: 'quest', key: id });
      this.observedQuests = quests; this.observedQuestVersion = questVersion;
    }
    // 背包版本没动就说明物品没动：全包深拷贝 + 逐件计数是 O(n²)，而掉血/恢复的 emit 远多于拾取。
    const bagRevision = this.session.bag.revision;
    if (bagRevision !== this.observedBagRevision) {
      const items = new Map<string, number>(this.session.bag.counts);
      for (const id of new Set([...items.keys(), ...this.observedItems.keys()])) if ((items.get(id) ?? 0) !== (this.observedItems.get(id) ?? 0)) changes.push({ source: 'inventory', key: id });
      this.observedItems = items; this.observedBagRevision = bagRevision;
    }
    const storyWorld = this.session.storyWorld.captureState(), choices = new Map(storyWorld.choices);
    const encounters = new Map(storyWorld.encounters.map(encounter => [encounter.id, encounter.status]));
    for (const [id, value] of choices) if (this.observedChoices.get(id) !== value) changes.push({ source: 'choice', key: id });
    for (const encounter of storyWorld.encounters) if (['won','lost'].includes(encounter.status) && this.observedEncounters.get(encounter.id) !== encounter.status)
      changes.push({ source: 'battle', key: encounter.definitionId ?? encounter.id });
    const completedEvents = new Set(this.session.runtimeState.completedEvents);
    for (const id of completedEvents) if (!this.observedEvents.has(id)) changes.push({ source: 'event', key: id });
    this.observedEvents = completedEvents;
    this.observedChoices = choices;
    this.observedEncounters = encounters;
    if (!dispatch || !changes.length) return;
    const version = this.session.restorationVersion;
    // Session publishes while the runtime is still finishing its synchronous commit.
    queueMicrotask(() => {
      if (this.disposed || this.session.restorationVersion !== version) return;
      for (const change of changes) if (this.eventCandidates(change.source, change.key).length) {
        this.triggerAfterManual(() => {
          void this.notify(change.source, change.key, change.source==='choice'?undefined:this.session.storyWorld.currentLocation?.map).catch(error => {
            if (this.onError) this.onError(error, () => this.retry()); else console.error(error);
          });
        });
      }
    });
  }
  get busy(): boolean { return this.manualBusy || this.runtime.busy || this.locked; }
  get canSkip(): boolean { return this.busy && !this.choosing && !this.confirming && !(this.context?.signal ?? this.manual.signal).aborted; }
  skip(): void { if (this.canSkip) { this.skipping = true; this.skipRequest.abort(); this.ui.skipDialogue(); } }
  private resetPlayback(): void { this.skipping = false; this.skipRequest = new AbortController(); }
  private setLocked(value: boolean): void { if (this.locked !== value) { this.locked = value; this.onLock(value); } }
  private release(): void {
    this.cleanup = this.cleanup.catch(() => {}).then(async () => {
      try {
        if (this.rollbackPresentation) { this.rollbackPresentation = false; await this.presentation?.finish(false); }
      } finally {
        try { await this.presentation?.release?.(); }
        finally {
          this.presenting = false;
          if (!this.runtime.busy && !this.manualBusy && !this.debugJumpPending) {
            this.context = undefined; this.choosing = false; this.confirming = false;
            this.ui.closeDialogue(); this.setLocked(false);
          }
        }
      }
    });
    // Keep cleanup observable by request(), without an unhandled rejection on cancellation.
    void this.cleanup.catch(() => {});
  }
  async debugJump<T>(work:()=>Promise<T>):Promise<T> {
    this.debugJumpPending = true;
    this.deferredTriggers.length = 0;
    this.setLocked(true);
    try {
      this.cancel();
      await this.manualSettled;
      await this.cleanup;
      this.context = undefined; this.choosing = false; this.confirming = false;
      this.recovery=undefined;this.projectionStage=undefined;this.travelPending=undefined;this.travelApplied=false;
      this.prefetchedScripts.clear();this.prefetchedRun=undefined;
      return await work();
    } finally {
      this.debugJumpPending = false;
      if(!this.runtime.busy && !this.manualBusy)this.setLocked(false);
    }
  }

  cancel(): void {
    this.manual.abort(); this.runtime.cancel(); this.ui.closeDialogue();
    if (!this.runtime.busy && !this.manualBusy) this.release();
  }
  dispose(): void { this.disposed = true; this.deferredTriggers.length = 0; this.unsubscribe(); this.unsubscribeDefeats(); this.cancel(); }
  private async request(result: Promise<boolean>): Promise<boolean> {
    this.presentationStarted = false;
    try { const played = await result; await this.cleanup; return played; }
    catch (error) { try { await this.cleanup; } catch {} throw error; }
  }
  private async prepare(node: StoryNode, context: StoryPlaybackContext): Promise<void> {
    await this.cleanup.catch(() => {}); context.signal.throwIfAborted(); this.context = context;
    // 演出前确认这条脚本会经过的地图素材；缺则先加载，避免演出结束后再等。
    if (this.prefetchedRun !== context.runId) {
      this.prefetchedRun = context.runId;
      this.prefetchedScripts.clear();
    }
    const script = this.runtime.runScript(context.runId);
    if (script && !this.prefetchedScripts.has(script)) {
      await this.world?.prefetch?.([script], context.signal);
      context.signal.throwIfAborted();
      this.prefetchedScripts.add(script);
    }
    await this.recover(context.signal);
    await this.world?.normalize?.(context.signal);
    await this.world?.prepare?.(node.commands, context.signal, context.stage);
    if (context.stage && (node.stage || !this.presenting)) {
      await this.presentation?.begin(context.signal, context.stage); this.presenting = !!this.presentation;
      // `begin` 已经把这一幕画出来了；进图加载页到这里就可以收。
      if (this.presenting) this.markPresentationStarted();
    }
  }
  private async recover(signal: AbortSignal): Promise<void> {
    await this.cleanup.catch(() => {}); signal.throwIfAborted();
    if (this.recovery) {
      const recovery = this.recovery;
      if (recovery.world !== undefined) await this.world?.restore(recovery.world, signal);
      if (recovery.stage) { await this.presentation?.restoreStage?.(recovery.stage, signal); this.presenting = true; }
      this.recovery = undefined;
    }
    await this.project(signal);
  }
  private async dialogue(line: DialogueLine, signal = this.context?.signal ?? this.manual.signal): Promise<void> {
    signal.throwIfAborted(); if (!this.skipping) await this.ui.dialogue(line, signal);
  }
  private async choice(prompt: string, options: ChoiceOption[], description?: string, signal = this.context?.signal ?? this.manual.signal): Promise<ChoiceOption> {
    signal.throwIfAborted(); this.skipping = false; this.skipRequest = new AbortController(); this.choosing = true;
    try { const option = await this.ui.choice(prompt, options, description, signal); signal.throwIfAborted(); return option; }
    finally { this.choosing = false; }
  }
  private async perform(action: PerformanceAction, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted(); if (!this.presentation) throw new Error('剧情演出尚未装配');
    let drawingFirstStage = false;
    if (!this.presenting && action.type !== 'sound' && action.type !== 'music') {
      // 首幕一律交给随后的 `execute` 画：继承当前地图时也不该先按正式世界画一遍基线，
      // 否则同一张图、同一批角色会构建两次，`enterMap` 也会重复切一次音乐。
      const firstStage = action.type === 'stage';
      // `mapFromWorld` 的 `map` 只是预览值，不能拿它判断幕布；`begin` 用正式世界现场做基线。
      const declaredStage = firstStage && !action.mapFromWorld ? action : undefined;
      await this.presentation.begin(signal, declaredStage,
        action.type === 'fade' && action.opacity === 1 && action.durationMs === 0 ? { opacity: action.opacity, color: action.color } : undefined,
        firstStage);
      this.presenting = true;
      drawingFirstStage = firstStage;
      // 首幕由紧随其后的 `execute` 画出；其它动作在 `begin` 里已经画出基线画面。
      if (!drawingFirstStage) this.markPresentationStarted();
    }
    this.ui.closeDialogue();
    const playback = { signal, skipSignal: this.skipRequest.signal };
    if (action.type === 'parallel') {
      if (this.presentation.parallel) await this.presentation.parallel(action.actions, playback);
      else await Promise.all(action.actions.map(child => this.perform(child, signal)));
    } else await this.presentation.execute(action, playback);
    if (drawingFirstStage) this.markPresentationStarted();
  }
  /** 只回调一次：第一段画面出现即可收起进图加载页。 */
  private markPresentationStarted(): void {
    if (this.presentationStarted) return;
    this.presentationStarted = true;
    this.onPresentationStarted?.();
  }
  private async present(node: StoryNode, context: StoryPlaybackContext): Promise<{ choice?: string; stage?: StoryStageSnapshot }> {
    let value: string | undefined;
    for (const action of node.presentation) {
      context.signal.throwIfAborted();
      if (action.type === 'dialogue') { this.markPresentationStarted(); await this.dialogue(action, context.signal); }
      else if (action.type === 'choice') {
        this.markPresentationStarted();
        const option = await this.choice(action.prompt, action.options, action.description, context.signal); value = option.value;
        for (const line of option.lines ?? []) await this.dialogue(line, context.signal);
      } else if (action.type === 'quest-popup') {
        const quest = this.session.definition(action.quest); if (!quest) throw new Error(`任务不存在：${action.quest}`);
        // 隐藏任务不进日志、不挂标记，也不占一次面板；生成的脚本里即使残留面板动作也在这里跳过。
        if (quest.hidden) continue;
        this.markPresentationStarted();
        const receipt = action.kind === 'complete' ? this.session.rewardReceiptFor(quest.id) : undefined;
        if (action.kind === 'complete' && !receipt) throw new Error(`任务尚未结算，无法展示奖励：${quest.id}`);
        this.confirming = true;
        try { await this.ui.questPopup(action.kind, quest, receipt, context.signal); }
        finally { this.confirming = false; }
      } else await this.perform(action, context.signal);
    }
    return { choice: value, stage: this.presenting ? this.presentation?.getStageState?.() : undefined };
  }
  private commit(commit: StoryNodeCommit): void {
    const commands=storyCommitCommands(commit,this.session.storyWorld,this.presenting?this.presentation?.getWorldChanges?.()??[]:[]);
    const run=commit.checkpoint.runs.find(candidate=>candidate.id===commit.runId);
    const stage=commit.stage??run?.stage;
    const explicitTravel=commit.commands.flatMap(command=>command.type==='travel'?[command.destination]
      :command.type==='world'&&command.command.kind==='travel'?[command.command.destination]:[])[0];
    this.session.applyStoryCommands(commands, commit.checkpoint);
    this.presentation?.committed?.();
    this.projectionStage = stage;
    if (commands.some(command => ['world', 'travel', 'encounter', 'party-join', 'party-leave', 'party-control', 'equip', 'unequip-destroy', 'health', 'mana'].includes(command.type))) this.projectionPending = true;
    if (explicitTravel) {
      this.travelPending = explicitTravel; this.travelApplied = false;
      // The formal travel becomes the new baseline for following nodes.
    }
  }
  private async project(signal: AbortSignal): Promise<void> {
    if (!this.projectionPending && !this.travelPending) return;
    signal.throwIfAborted();
    // `onTravel` 成功之后就记下来：随后 `world.project` 失败时，重试只重做投影。
    // 否则重试会把同一张图再重建一次，并重复切一次地图音乐。
    if (this.travelPending && !this.travelApplied) {
      await this.onTravel?.(this.travelPending, signal);
      this.travelApplied = true;
    }
    await this.world?.project(this.projectionStage, signal); signal.throwIfAborted();
    if (this.travelPending && this.presenting) { await this.presentation?.release?.(); this.presenting = false; }
    this.world?.checkpoint(); this.projectionPending = false; this.travelPending = undefined; this.travelApplied = false;
  }
  private occurrence(source: StoryTriggerSource, key?: string, map?: string, entity?: string): StoryOccurrence {
    const state = this.runtime.snapshot();
    const sequence = Math.max(state.sequence, ...state.occurrenceSequences.map(([, value]) => value), ...state.pendingOccurrences.map(value => value.occurrence.sequence), 0) + 1;
    return { id: `${source}:${sequence}`, sequence, source, key, map, entity, ...(map ? { mapVisit: this.session.storyWorld.visit } : {}) };
  }
  /** 某个 trigger 的候选事件：精确 key 的事件在前，无 key 的通配事件在后。 */
  private eventCandidates(source: StoryTriggerSource, key?: string): StoryEvent[] {
    const exact = this.eventsByKey.get(`${source}\0${key ?? ''}`) ?? [];
    const keyless = key === undefined ? undefined : this.keylessEvents.get(source);
    return keyless?.length ? [...exact, ...keyless] : exact;
  }
  /** 原版在伤害跨过 30% 生命值时先检查演出，并让触发者至少保留 1 点生命。 */
  healthChanged(enemy: string, before: number, after: number, maximum: number, source?:{id:string;map:string;x:number;y:number}): boolean {
    if (this.disposed || after >= before || maximum <= 0) return false;
    const threshold = Math.trunc(maximum * 3 / 10);
    if(source&&before>threshold&&after<=threshold&&this.session.weakenQuestTarget(enemy,source)){
      this.projectionPending=true;
      if(this.manual.signal.aborted)this.manual=new AbortController();
      this.cleanup=this.cleanup.catch(()=>{}).then(()=>this.project(this.manual.signal));
      void this.cleanup.catch(error=>{if(this.onError)this.onError(error,()=>this.retry());else console.error(error);});
      return true;
    }
    const key = 'health-below-30:' + enemy;
    const currentMap = this.session.storyWorld.currentLocation?.map;
    const event = (this.eventsByKey.get(`battle\0${key}`) ?? []).find(event => (!event.map || !currentMap || event.map === currentMap)
      && (!event.condition || this.session.evaluateCondition(event.condition))
      && (this.runtime.eventStatus(event.id) !== 'completed' || event.repeat));
    if (!event) return false;
    const status = this.runtime.eventStatus(event.id);
    if (status === 'running') return true;
    if (status === 'waiting' || before <= threshold || after > threshold) return false;
    void this.notify('battle', key, this.session.storyWorld.currentLocation?.map).catch(error => {
      if (this.onError) this.onError(error, () => this.retry()); else console.error(error);
    });
    return true;
  }
  /**
   * 会话变化可能在一次手动播放内部发生（交付任务时写 completed 就会触发后续事件）。
   * 这时不能立刻开演第二段：两个播放器会抢同一个舞台、对白和输入锁，奖励弹窗还压在上面，
   * 演出等于在弹窗背后跑完。排到这次手动播放完全收起之后再派发。
   */
  private triggerAfterManual(run: () => void): void {
    if (this.debugJumpPending) return;
    if (!this.manualBusy) { run(); return; }
    this.deferredTriggers.push(run);
  }
  private flushDeferredTriggers(): void {
    for (const run of this.deferredTriggers.splice(0)) run();
  }
  notify(source: StoryTriggerSource, key?: string, map?: string, entity?: string): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    return this.request(this.runtime.dispatch(this.occurrence(source, key, map, entity)));
  }
  start(): Promise<boolean> { return this.notify('start'); }
  enterMap(map: string): Promise<boolean> { return this.notify('map-entry', undefined, map); }
  /**
   * 近身触发：原版 `near_npc_field` 的判据是「玩家身边那个对象正是它」，而「身边」由
   * `PLAYER_DoCheckNearNPC` 按曼哈顿 24 px 判定（findings 94）。相邻判定在场景侧算，
   * 这里只把「玩家靠近了某个角色」上报给运行时的触发索引。
   */
  approach(actor: string, map?: string, characterId?:string): Promise<boolean> { return this.notify('near', characterId??actor, map); }
  enterRegion(id: string, map: string): Promise<boolean> { return this.notify('region', this.campaign.events.find(event=>event.id===id)?.key ?? id, map); }
  retry(): Promise<boolean> { return this.request(this.runtime.resume()); }
  encounterResult(id: string, outcome: string, resultId: string): Promise<boolean> {
    const waiting = this.runtime.snapshot().runs.some(run=>run.status==='waiting'&&run.waiting?.encounter===id);
    if (waiting) return this.request(this.runtime.encounterResult(id, outcome, resultId));
    const encounter = this.session.storyWorld.encounter(id);
    if (encounter?.status !== 'active' || outcome !== 'won' && outcome !== 'lost') return Promise.resolve(false);
    this.session.applyStoryCommands([{type:'world',command:{kind:'encounter-result',id,result:outcome}}]);
    return Promise.resolve(true);
  }
  trigger(trigger: Pick<StoryTrigger, 'id' | 'script'> & Partial<StoryTrigger>): Promise<boolean> {
    if (this.busy || this.session.flags.has(trigger.id)) return Promise.resolve(false);
    const event = this.campaign.events.find(event => event.id === trigger.id);
    if (event) return this.request(this.runtime.start(event.script, event.id));
    return this.request(this.runtime.start(trigger.script)).then(played => { if (played) this.session.mark(trigger.id); return played; });
  }
  /** `node` 只给调试入口用：从指定节点开始，正常触发始终从脚本 entry 开始。 */
  async script(name?: string | null, node?: string): Promise<void> { if (name) await this.request(this.runtime.start(name, undefined, undefined, node)); }
  async run(work: () => Promise<void>): Promise<boolean> {
    if (this.busy || this.disposed) return false;
    let settled!: () => void;
    this.manualSettled = new Promise<void>(resolve => { settled = resolve; });
    this.manual = new AbortController(); this.manualBusy = true; this.resetPlayback(); this.setLocked(true);
    try { await work(); this.manual.signal.throwIfAborted(); return true; }
    catch (error) { if (this.manual.signal.aborted || error instanceof DOMException && error.name === 'AbortError') return false; throw error; }
    finally {
      this.manualBusy = false; this.release();
      try { await this.cleanup; }
      // 即使收尾报错，排队的触发也要落地：它的错误走 onError，而不是留一个永远不演的队列。
      finally { try { this.flushDeferredTriggers(); } finally { settled(); } }
    }
  }
  visitHealer(actor: ActorDefinition, revive: () => void): Promise<boolean> {
    return this.run(async () => {
      const quote = healerRevivalQuote(this.session);
      if (!quote.memberIds.length) { await this.dialogue({ actor: actor.id, speaker: actor.name, text: '现在没有需要复活的同伴。' }); return; }
      const answer = await this.choice(actor.name, [{ label: '复活同伴', value: 'revive' }, { label: '离开', value: 'cancel' }], `${actor.description}\n\n复活费用：${quote.cost} 金币`);
      if (answer.value !== 'revive') return;
      if (this.session.money < healerRevivalQuote(this.session).cost) { await this.dialogue({ actor: actor.id, speaker: actor.name, text: '金币不足，无法治疗受伤的灵魂。' }); return; }
      revive();
    });
  }
  interact(entity: EntityPlacement, actor: ActorDefinition): Promise<boolean> {
    return this.run(async () => {
      // 上报「交互发生在哪个对象上」时用对象自己的角色键，事件侧就能按角色匹配：原版的
      // `current_object` 条件（EVTSYSTEM_nObjectType/nObjectID）正是这个意思。条件那一侧还没接
      // （复刻里这些交互对象尚未落地，见 findings 117），这里先把对象身份如实带上。
      if (await this.notify('interaction', entity.actor, this.session.storyWorld.currentLocation?.map, entity.id)) return;
      if (entity.objective) {
        if (!this.session.canInteract(entity.objective, entity.id)) await this.dialogue({ actor: entity.actor, speaker: actor.name, text: '现在没有需要在这里完成的任务。' });
        else if (entity.afterInteractScript) await this.script(entity.afterInteractScript);
        else this.session.interact(entity.objective, entity.id);
        return;
      }
      await this.talk(entity, actor);
      // 说完这句话交互本身就算数：进行中任务里指到这个 NPC（它的 `actor`）的对话／交互目标
      // 各记一次。中途取消或失败抛出的这一行到不了，目标不会被提前消耗。
      this.session.interact(entity.actor, entity.id, entity.characterId);
      if(entity.id.startsWith('quest-target:')){this.projectionPending=true;await this.project(this.manual.signal);}
    });
  }
  /** 跟一个 NPC 说话：有任务按发布者状态走接取／交付／追进度，没有就说一句闲话。 */
  private async talk(entity: EntityPlacement, actor: ActorDefinition): Promise<void> {
    // 原版 NPC 交互只执行任务槽 0：待交付独占，其次第一条可接主线，再次支线，最后进行中。
    // 不提供任务选择列表（`NPCSYSTEM_MakeFunctionList` 命中即返回，`ExeCurrentNpcTask` 只读槽 0）。
    const quest = this.session.npcQuestSlot(entity.actor, entity.characterId);
    if (!quest) {
      await this.dialogue({ actor: entity.actor, speaker: entity.name ?? actor.name, text: entity.hint || actor.description || '一路小心。' });
      return;
    }
    const status = this.session.status(quest.id);
    if (status === 'available') {
      if (quest.offerScript) await this.script(quest.offerScript);
      else { this.session.accept(quest.id); await this.notice('start', quest); }
    } else if (status === 'ready') {
      await this.settle(quest);
      // 有交付脚本时由脚本里的 quest-popup 负责提示，避免同一个窗弹两次。
      if (!quest.completeScript) await this.notice('complete', quest);
    } else await this.dialogue({ actor: entity.actor, speaker: actor.name, text: quest.progressText });
  }
  /** 剧情脚本之外的接取/交付提示：与 `present()` 的 quest-popup 动作同一套窗口。 */
  private async notice(kind: 'start' | 'complete', quest: CampaignQuest): Promise<void> {
    // 隐藏任务照常结算，但不弹任务面板；它们本来就不出现在日志和场景标记里。
    if (quest.hidden) return;
    const signal = this.context?.signal ?? this.manual.signal;
    signal.throwIfAborted();
    this.confirming = true;
    try { await this.ui.questPopup(kind, quest, kind === 'complete' ? this.session.rewardReceiptFor(quest.id) : undefined, signal); }
    finally { this.confirming = false; }
  }
  /**
   * 交付一个待交付的任务。批量接入的任务没有交付演出，交互一次就直接结算，否则它们永远停在
   * 待交付状态——演出只是包装，任务状态本身才是玩家能推进的东西。
   */
  private async settle(quest: CampaignQuest): Promise<void> {
    if (quest.completeScript) await this.script(quest.completeScript);
    else this.session.complete(quest.id);
  }
}

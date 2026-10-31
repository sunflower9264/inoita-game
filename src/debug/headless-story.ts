import type {ActorDefinition, EntityPlacement, WorldIndex, WorldMap} from '../domain/content.ts';
import type {BattleCatalog} from '../domain/battle.ts';
import type {Campaign} from '../domain/campaign.ts';
import type {CharacterStatsCatalog} from '../domain/character-stats.ts';
import type {ItemCatalog} from '../domain/items.ts';
import type {CompanionCatalog} from '../domain/party.ts';
import type {SceneSnapshot} from '../domain/scene-snapshot.ts';
import type {StoryClassCatalog} from '../domain/story-class.ts';
import type {StoryEvent, StoryNode, StoryTriggerSource} from '../domain/story-graph.ts';
import type {PerformanceAction, StoryStage, StoryStageSnapshot} from '../domain/story-performance.ts';
import type {StoryEntityState} from '../domain/story-world.ts';
import type {StoryNodeCommit, StoryPlaybackContext, StoryRuntimePort} from '../domain/story-runtime.ts';
import {Session, type SessionState} from '../domain/session.ts';
import {authoredPlacements, baseMapEntities} from '../domain/map-placement.ts';
import {applyStorySceneAction, resolveStoryScene} from '../domain/story-scene.ts';
import {assertUniqueActorInstances} from '../domain/actor-census.ts';
import {assertScenePlan,planScene} from '../domain/scene-plan.ts';
import {storyCommitCommands} from '../domain/story-commit.ts';
import {newStorySession} from '../domain/story-class.ts';
import {StoryRuntime} from '../domain/story-runtime.ts';

/** 无头回放需要的全部内容；全部是游戏目录里的解析结果，不读文件。 */
export interface HeadlessContent {
  campaign: Campaign;
  world: WorldIndex;
  maps: ReadonlyMap<string, WorldMap>;
  items: ItemCatalog;
  battle: BattleCatalog;
  stats: CharacterStatsCatalog;
  companions: CompanionCatalog;
  storyClasses: StoryClassCatalog;
}

export interface ChoiceDecision {
  choice: string;
  script: string;
  node: string;
  value: string;
  basis: string;
}

/** 生成期的选择策略；没有决定就报错，不默认选第一项。 */
export interface ChoicePolicy {
  forced?: Readonly<Record<string, string>>;
  evidence?: Readonly<Record<string, string>>;
  converged?: Readonly<Record<string, string>>;
  onDecision?: (decision: ChoiceDecision) => void;
}

export interface BattleDecision {
  encounter: string;
  script: string;
  node: string;
  result: string;
  basis: string;
}

export interface ReplayOptions {
  eventId?: string;
  node?: string;
  choices?: ChoicePolicy;
  /** 遭遇战的结算策略；缺省按正常推进打赢。 */
  battle?: (info: {encounter: string; script: string; node: string}) => {result: string; basis: string};
  /** 分支事件按舞台声明的地图继续，而不是沿用触发时必须所在的当前图。 */
  honorDeclaredMap?: boolean;
  /** 只用于把选择决定写回证据；不影响回放。 */
  script?: string;
}

export interface ReplayResult {
  script: string;
  eventId?: string;
  status: 'completed' | 'waiting' | 'deferred' | 'skipped';
  choices: ChoiceDecision[];
  battles: BattleDecision[];
}

/**
 * 用真实 `Session` + `StoryRuntime` 在 Node 里跑剧情，不启动 Phaser。
 * 状态变更全部经过 `storyCommitCommands` / `session.applyStoryCommands`；
 * 生成器只负责决定「回放哪些事件、选择哪个选项、战斗谁赢」。
 */
export class HeadlessStory {
  readonly session: Session;
  readonly runtime: StoryRuntime;
  private readonly campaign: Campaign;
  private readonly world: WorldIndex;
  private readonly maps: ReadonlyMap<string, WorldMap>;
  private readonly initialLocation: {map: string; x: number; y: number; facing: 'north' | 'south' | 'east' | 'west'};
  private readonly scenes = new Map<string, SceneSnapshot>();
  private readonly committedScenes = new Map<string, SceneSnapshot>();
  private stage?: StoryStageSnapshot;
  private choicePolicy?: ChoicePolicy;
  private choiceScript = '';
  private honorDeclaredMap = false;
  private decisionSink: ChoiceDecision[] = [];
  private battleSink: BattleDecision[] = [];
  private encounterCounter = 0;

  constructor(content: HeadlessContent) {
    const hero = content.world.actors[content.campaign.start.actor];
    if (!hero) throw new Error(`主角外观不存在：${content.campaign.start.actor}`);
    this.campaign = content.campaign;
    this.world = content.world;
    this.maps = content.maps;
    this.initialLocation = {map: content.campaign.start.map, x: content.campaign.start.x,
      y: content.campaign.start.y, facing: content.campaign.start.facing === 'any' ? 'south' : content.campaign.start.facing};
    this.session = newStorySession(content.campaign, hero,
      content.storyClasses.classes[0]!, content.items, content.stats, content.battle, content.companions);
    this.runtime = new StoryRuntime(content.campaign, this.port());
    this.runtime.restore(this.session.runtimeState);
  }

  capture(): SessionState {
    return this.session.captureState();
  }

  /** 生成期换图：与正式游玩一样走旅行命令，保留访问计数与场景缓存。 */
  travel(destination: import('../domain/content.ts').TravelDestination): void {
    this.session.applyStoryCommands([{type: 'travel', destination}]);
    this.stage = undefined;
  }

  /** 回到某个快照，同时重置剧情运行时，避免上一个任务残留游标。 */
  restore(state: SessionState): void {
    this.session.restoreState(state);
    this.runtime.restore(this.session.runtimeState);
    this.scenes.clear();
    this.committedScenes.clear();
    this.stage = undefined;
  }

  /** 开场第一幕可能在会话落点写入之前执行，此时按新游戏起点算当前地图。 */
  private currentMap(): string {
    return this.session.storyWorld.currentLocation?.map ?? this.initialLocation.map;
  }

  async replayEvent(event: StoryEvent, options: ReplayOptions = {}): Promise<ReplayResult> {
    return this.replayScript(event.script, {...options, eventId: event.id});
  }

  async replayScript(script: string, options: ReplayOptions = {}): Promise<ReplayResult> {
    this.choicePolicy = options.choices;
    this.choiceScript = options.script ?? script;
    this.honorDeclaredMap = options.honorDeclaredMap === true;
    this.decisionSink = [];
    this.battleSink = [];
    const occurrence = options.eventId ? `build:${options.eventId}:${this.session.runtimeState.sequence + 1}` : undefined;
    const started = await this.runtime.start(script, options.eventId, occurrence, options.node);
    const result: ReplayResult = {script, eventId: options.eventId, status: started ? 'waiting' : 'skipped',
      choices: [], battles: []};
    if (!started) return result;
    const dispatched = new Set<string>();
    for (let guard = 0; guard < 64; guard++) {
      const waiting = this.waitingRun();
      const encounter = waiting?.waiting?.encounter;
      if (!waiting || !encounter) break;
      const definition = this.session.storyWorld.encounter(encounter);
      const enemies = (definition?.spawns ?? []).map(spawn => spawn.enemyId);
      const map = definition?.map ?? this.session.storyWorld.currentLocation?.map;
      // 战斗打到 30% 以下时原版会派发阶段事件；这里在结算前派发，保持它发生在战斗中途。
      for (const enemy of enemies) await this.dispatchOnce(dispatched, `health-below-30:${enemy}`, map);
      const info = {encounter, script: waiting.cursor.script, node: waiting.cursor.node};
      const decided = options.battle?.(info) ?? {result: 'won', basis: 'default-normal-progression'};
      this.battleSink.push({...info, ...decided});
      await this.runtime.encounterResult(encounter, decided.result, `${encounter}:${++this.encounterCounter}`);
      if (decided.result === 'won')
        for (const enemy of enemies) await this.dispatchOnce(dispatched, `defeat:${enemy}`, map);
    }
    let status: ReplayResult['status'] = 'completed';
    const runs = this.session.runtimeState.runs.filter(run => options.eventId ? run.eventId === options.eventId : run.occurrence === occurrence);
    if (runs.some(run => run.status === 'waiting')) status = 'waiting';
    else if (runs.some(run => run.status === 'deferred')) status = 'deferred';
    result.status = status;
    result.choices = this.decisionSink;
    result.battles = this.battleSink;
    return result;
  }

  /** 按真实触发索引派发一次事件发生；没有匹配内容时返回 false。 */
  async dispatch(source: StoryTriggerSource, key: string, map?: string): Promise<boolean> {
    const state = this.session.runtimeState;
    const sequence = Math.max(state.sequence, ...state.occurrenceSequences.map(([, value]) => value), 0) + 1;
    return this.runtime.dispatch({id: `build:${source}:${sequence}`, sequence, source, key,
      ...(map ? {map, mapVisit: this.session.storyWorld.visit} : {})});
  }

  private async dispatchOnce(seen: Set<string>, key: string, map?: string): Promise<void> {
    const identity = `${key}|${map ?? ''}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    await this.dispatch('battle', key, map);
  }

  /** 把一次回放的事件发生水位写进运行时；重复事件和后续触发靠它抑制。 */
  recordOccurrence(event: StoryEvent, sequence: number): void {
    const key = JSON.stringify([event.id, event.source]);
    const state = this.session.runtimeState;
    const current = state.occurrenceSequences.find(([name]) => name === key)?.[1] ?? 0;
    state.occurrenceSequences = state.occurrenceSequences.filter(([name]) => name !== key)
      .concat([[key, Math.max(current, sequence)]]);
    this.session.runtimeState = state;
    this.syncRuntime();
  }

  /** 手工改过 `runtimeState` 后让运行时看到同一份记账；下一次回放会以它为准。 */
  syncRuntime(): void {
    this.runtime.restore(this.session.runtimeState);
  }

  private waitingRun(eventId?: string) {
    return this.session.runtimeState.runs.find(run => run.status === 'waiting'
      && (!eventId || run.eventId === eventId));
  }

  private port(): StoryRuntimePort {
    return {
      currentMap: () => this.currentMap(),
      prepare: async () => {},
      capture: () => this.session.captureState(),
      present: (node, context) => this.present(node, context),
      finish: async () => {},
      commit: commit => this.commit(commit),
      checkpoint: snapshot => { this.session.runtimeState = snapshot; },
      rollback: baseline => { this.session.restoreState(baseline as SessionState); },
      evaluate: (condition, commands) => this.session.evaluateCondition(condition, commands),
      onBusy: () => {},
    };
  }

  private async present(node: StoryNode, context: StoryPlaybackContext): Promise<{choice?: string; stage?: StoryStageSnapshot}> {
    let value: string | undefined;
    for (const action of node.presentation) {
      context.signal.throwIfAborted();
      if (action.type === 'dialogue' || action.type === 'quest-popup') continue;
      if (action.type === 'choice') {
        value = this.choose(node, action);
        continue;
      }
      if (action.type === 'stage') {
        this.stage = this.resolveStage(action);
        assertUniqueActorInstances(this.stage.scene.actors, `无头舞台 ${this.stage.map}/stage`);
        assertScenePlan(planScene(this.stage.scene,this.stage.bindings));
        continue;
      }
      if (this.stage) this.stage = applyStorySceneAction(this.stage, action as PerformanceAction);
      if (this.stage) {
        assertUniqueActorInstances(this.stage.scene.actors, `无头舞台 ${this.stage.map}/${action.type}`);
        assertScenePlan(planScene(this.stage.scene,this.stage.bindings));
      }
    }
    return {choice: value, stage: this.stage};
  }

  private choose(node: StoryNode, action: Extract<StoryNode['presentation'][number], {type: 'choice'}>): string {
    if (node.exit.type !== 'choice') throw new Error(`节点 ${node.id} 有选项动作但出口不是 choice`);
    const choice = node.exit.choice;
    const options = action.options.map(option => option.value);
    const policy = this.choicePolicy ?? {};
    const pick = policy.forced?.[choice] ?? policy.converged?.[choice]
      ?? (options.length === 1 ? options[0] : policy.evidence?.[choice]);
    if (!pick || !options.includes(pick)) {
      throw new Error(`选择 ${choice}（${node.exit.choice}）没有证据：${options.join(' / ')}`);
    }
    const basis = policy.forced?.[choice] === pick ? 'forced'
      : policy.evidence?.[choice] === pick ? 'evidence'
        : policy.converged?.[choice] === pick ? 'converged' : 'single-option';
    const decision = {choice, script: this.choiceScript, node: node.id, value: pick, basis};
    this.decisionSink.push(decision);
    policy.onDecision?.(decision);
    return pick;
  }

  private resolveStage(declaration: StoryStage): StoryStageSnapshot {
    if (this.stage) this.scenes.set(this.stage.map, this.stage.scene);
    const map = declaration.mapFromWorld
      ? this.honorDeclaredMap && declaration.map && declaration.map !== this.currentMap()
        ? declaration.map
        : this.stage?.map ?? this.currentMap()
      : declaration.map;
    if (!map) throw new Error('剧情舞台缺少地图');
    const sameMap = !!this.stage && (declaration.mapFromWorld || declaration.map === this.stage.map)
      && !declaration.resetActors && !(this.honorDeclaredMap && this.stage.map !== map);
    const scene = sameMap ? this.stage!.scene
      : !declaration.resetActors && this.scenes.has(map) ? this.scenes.get(map)!
        : this.buildScene(map);
    if (!this.committedScenes.has(map) || declaration.resetActors)
      this.committedScenes.set(map, structuredClone(scene));
    return resolveStoryScene(declaration, scene);
  }

  private commit(commit: StoryNodeCommit): void {
    const commands = storyCommitCommands(commit, this.session.storyWorld, this.getWorldChanges(),
      memberId=>!!this.session.party?.get(memberId));
    this.session.applyStoryCommands(commands, commit.checkpoint);
    this.committed();
  }

  private committed(): void {
    if (!this.stage) return;
    this.scenes.set(this.stage.map, this.stage.scene);
    for (const [map, scene] of this.scenes) this.committedScenes.set(map, structuredClone(scene));
  }

  /** 与正式 presenter 相同：只回写带世界实例的演员，且位置/可见性发生变化时。 */
  private getWorldChanges(): readonly StoryEntityState[] {
    if (this.stage) this.scenes.set(this.stage.map, this.stage.scene);
    const changes: StoryEntityState[] = [];
    for (const [map, scene] of this.scenes) {
      const before = this.committedScenes.get(map);
      for (const actor of scene.actors) {
        if (!actor.worldEntityId || actor.unpositioned) continue;
        const original = before?.actors.find(previous => previous.id === actor.id);
        if (original && original.worldEntityId === actor.worldEntityId && original.actor === actor.actor
          && original.x === actor.x && original.y === actor.y && original.facing === actor.facing
          && original.visible === actor.visible) continue;
        changes.push({id: actor.worldEntityId, map, actor: actor.actor,
          ...(actor.characterId ? {characterId: actor.characterId} : {}),
          x: actor.x, y: actor.y, facing: actor.facing, visible: actor.visible});
      }
    }
    return changes;
  }

  private buildScene(mapId: string): SceneSnapshot {
    const map = this.maps.get(mapId);
    if (!map) throw new Error(`地图不存在：${mapId}`);
    const location = this.session.storyWorld.currentLocation ?? this.initialLocation;
    const authored = authoredPlacements(map, this.campaign);
    const base = baseMapEntities(map, this.campaign, entity => this.session.visible(entity));
    const entities = this.session.storyWorld.projectEntities(mapId, [...base, ...authored], this.campaign.placements)
      .filter(entity => this.session.storyWorld.visible(entity.id)
        && (!('condition' in entity) || this.session.evaluateCondition(entity.condition as never)));
    const player: ActorDefinition | undefined = this.world.actors[this.campaign.start.actor];
    return {
      map: mapId,
      actors: [
        {id: 'player', actor: this.campaign.start.actor, x: location.map === mapId ? location.x : map.width / 2,
          y: location.map === mapId ? location.y : map.height / 2,
          facing: location.map === mapId ? location.facing : 'south', visible: true,
          ...(player ? {appearance: player} : {})},
        ...entities.map(entity => this.sceneActor(entity)),
      ],
    };
  }

  private sceneActor(entity: EntityPlacement): SceneSnapshot['actors'][number] {
    const actor = this.world.actors[entity.actor];
    return {
      id: `entity:${entity.id}`, actor: entity.actor, worldEntityId: entity.id,
      ...(entity.characterId ? {characterId: entity.characterId} : {}),
      x: entity.x, y: entity.y, facing: 'south', visible: true,
      ...(actor ? {appearance: actor} : {}),
    };
  }
}

export function createHeadlessStory(content: HeadlessContent): HeadlessStory {
  return new HeadlessStory(content);
}

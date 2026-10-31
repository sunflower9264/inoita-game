import type { Campaign, CampaignQuest } from './campaign.ts';
import type { QuestStatus, TravelDestination } from './content.ts';
import type { StorySpot } from './story-graph.ts';

/**
 * 任务级调试入口。只保留算得出固定落点的任务；算不出的任务不进入目录，
 * 面板和命令行都不显示。默认起点由导出层决定：有接取人的任务落在 available，
 * 没有接取人的任务落在 active。
 */
export interface StoryDebugTask {
  quest: string;
  phase: 'available' | 'active';
  entry: { type: 'fixed' } & StorySpot;
  /** 与任务相关的剧情脚本；导出器重算依赖时使用，运行时不读。 */
  scripts?: string[];
  /** 原版证据推演出的任务起点现场表；新目录运行时读这个。 */
  start?: StoryDebugStartTable;
  /** 进入任务后直接开演的开幕演出。 */
  play?: StoryDebugPlay;
  /** 现场表与导出输入的对应版本。 */
  sourceHash?: string;
  /** 证据链摘要，供审计/面板展示。 */
  basis?: Record<string, unknown>;
}

export interface StoryDebugCatalog {
  schema?: 1;
  meta?: StoryDebugMeta;
  tasks: StoryDebugTask[];
  gaps?: StoryDebugGap[];
}
export interface StoryDebugTarget { quest: string }

/** 导出器版本与覆盖率；hash 不一致时现场表必须重新导出。 */
export interface StoryDebugMeta {
  interpreterVersion: number;
  semanticsVersion: number;
  sourceHash: string;
  generatedAt: string;
  coverage: {
    eligible: number;
    verified: number;
    gaps: number;
    excludedNoIntake: number;
    excludedUnreachableEvents: number;
    unreachableNodes: number;
    byGapKind: Record<string, number>;
  };
}

/** 进入任务后直接开演的开幕演出；没有演出的任务省略。 */
export interface StoryDebugPlay {
  script: string;
  node?: string;
  event?: string;
  cut: 'before-opening' | 'after-accept' | 'event-end';
}

/**
 * 原版证据推演出的任务起点现场表。只存与干净会话不同的部分；
 * 运行时展开成完整 SessionState，再走真实 restoreState 校验。
 */
export interface StoryDebugStartTable {
  quests?: {
    id: string;
    status: QuestStatus;
    cycle?: number;
    completedCycles?: number;
    /** 只存非零目标，其余按任务定义补零。 */
    goals?: Record<string, number>;
  }[];
  running?: string[];
  world?: Omit<Partial<import('./story-world.ts').StoryWorldSnapshot>, 'location'> & {
    location: TravelDestination;
    /**
     * 结构化缺场登记。世界状态里没有独立字段——缺场是 flags 里的
     * `["absent-actor",map,characterId]` 标记；运行时在套表时展开。
     */
    absentActors?: { map: string; actor: string; characterId?: string }[];
    /** 同上，展开成 `["absent-enemy",map,enemyId]`。 */
    absentEnemies?: { map: string; enemyId: string }[];
  };
  items?: { item: string; quantity: number }[];
  /** 运行时先清掉的场景控制物品 id。 */
  itemReset?: string[];
  party?: { join?: string[]; leave?: string[]; control?: string };
  /** 任务路径上用到的已完成事件；整局开场（`source: 'start'`）由安装器补全，见 story-jump。 */
  completedEvents?: { id: string }[];
  occurrenceSequences?: [string, number][];
  factSequences?: [string, number][];
  /** 消耗玩家已有资源的先决条件；不足时明确失败，不伪造。 */
  requiresProfile?: {
    items?: { item: string; quantity: number }[];
    money?: number;
  };
}

/** 现场表里的一条任务差量。 */
export type StoryDebugStartQuest = NonNullable<StoryDebugStartTable['quests']>[number];

/** 证据不足、不能进入调试目录的任务。 */
export interface StoryDebugGap {
  quest: string;
  title?: string;
  kind: string;
  detail: string;
  evidence?: string;
  fixHint?: string;
}

export function debugTask(campaign: Campaign, target: StoryDebugTarget): StoryDebugTask {
  const task = campaign.debugStory?.tasks.find(task => task.quest === target.quest);
  if (!task) throw new Error('这个任务没有调试入口');
  return task;
}

/** 任务的缺口；没有现场表时，面板与命令行据此说明缺哪条证据。 */
export function debugGaps(campaign: Campaign, quest?: string): StoryDebugGap[] {
  return (campaign.debugStory?.gaps ?? []).filter(gap => !quest || gap.quest === quest);
}

export function debugGapFor(campaign: Campaign, quest: string): StoryDebugGap | undefined {
  return debugGaps(campaign, quest)[0];
}

/**
 * 这条任务的证据条数：导出器记在 `basis` 里的前置事件、推演步骤、选择与战斗。
 * 面板与命令行显示「证据 N 条」用。
 */
export function storyDebugEvidenceCount(task: StoryDebugTask): number {
  const start = task.start;
  if (!start) return 0;
  let count = 0;
  const basis = task.basis as {
    before?: unknown[]; steps?: unknown[]; choices?: unknown[]; battles?: unknown[];
    opening?: unknown; giver?: unknown;
  } | undefined;
  if (basis) {
    count += basis.before?.length ?? 0;
    count += basis.steps?.length ?? 0;
    count += basis.choices?.length ?? 0;
    count += basis.battles?.length ?? 0;
    if (basis.opening) count += 1;
    if (basis.giver) count += 1;
  }
  return count;
}

const QUEST_STATUSES: readonly QuestStatus[] = ['locked', 'available', 'active', 'ready', 'completed'];
const RUNNING_STATUSES: readonly QuestStatus[] = ['active', 'ready'];
const PLAY_CUTS: readonly StoryDebugPlay['cut'][] = ['before-opening', 'after-accept', 'event-end'];
const FACINGS = ['north', 'south', 'east', 'west'];

const require = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message);
};
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const isPositive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export function validateStoryDebug(campaign: Campaign): void {
  const catalog = campaign.debugStory;
  if (!catalog) return;
  const tasks = catalog.tasks;
  require(Array.isArray(tasks), '剧情调试目录缺少任务');
  if (catalog.schema !== undefined) require(catalog.schema === 1, '剧情调试目录版本不支持');
  if (catalog.meta) validateMeta(catalog.meta);
  const quests = new Map(campaign.quests.map(quest => [quest.id, quest]));
  const events = new Set(campaign.events.map(event => event.id));
  const seen = new Set<string>();
  for (const task of tasks) {
    if (!task.quest || seen.has(task.quest)) throw new Error('剧情调试任务标识无效');
    seen.add(task.quest);
    if (!quests.has(task.quest)) throw new Error('剧情调试任务引用未知任务');
    if (!['available', 'active'].includes(task.phase)) throw new Error('剧情调试任务起点无效');
    const entry = task.entry;
    if (!entry || entry.type !== 'fixed' || !entry.map || !Number.isFinite(entry.x)
      || !Number.isFinite(entry.y) || !entry.source) throw new Error('剧情调试任务落点无效');
    for (const script of task.scripts ?? [])
      if (!campaign.scripts[script]) throw new Error('剧情调试任务引用未知脚本');
    require(!!task.start, `剧情调试任务 ${task.quest} 缺少现场表`);
    require(nonEmpty(task.sourceHash), `剧情调试任务 ${task.quest} 的现场表缺少来源 hash`);
    validateStartTable(task.start!, quests, events, `debug:${task.quest}`);
    if (task.play) validatePlay(task.play, campaign, events, task.quest);
    if (task.basis !== undefined) require(isObject(task.basis), `剧情调试任务 ${task.quest} 的证摘要无效`);
  }
  const gapSeen = new Set<string>();
  for (const gap of catalog.gaps ?? []) {
    require(isObject(gap), '剧情调试缺口无效');
    require(nonEmpty(gap.quest) && quests.has(gap.quest), `剧情调试缺口引用未知任务 ${String(gap.quest)}`);
    require(nonEmpty(gap.kind), `剧情调试缺口缺少类型 ${gap.quest}`);
    require(nonEmpty(gap.detail), `剧情调试缺口缺少说明 ${gap.quest}`);
    for (const value of [gap.title, gap.evidence, gap.fixHint])
      require(value === undefined || typeof value === 'string', `剧情调试缺口字段无效 ${gap.quest}`);
    const key = JSON.stringify([gap.quest, gap.kind, gap.detail]);
    require(!gapSeen.has(key), `剧情调试缺口重复 ${gap.quest}`);
    gapSeen.add(key);
  }
}

function validateMeta(meta: StoryDebugMeta): void {
  require(isObject(meta), '剧情调试目录摘要无效');
  require(isPositive(meta.interpreterVersion), '剧情调试解释器版本无效');
  require(isPositive(meta.semanticsVersion), '剧情调试语义版本无效');
  require(nonEmpty(meta.sourceHash), '剧情调试目录缺少来源 hash');
  require(nonEmpty(meta.generatedAt) && !Number.isNaN(Date.parse(meta.generatedAt)), '剧情调试目录生成时间无效');
  const coverage = meta.coverage;
  require(isObject(coverage), '剧情调试覆盖率无效');
  for (const key of ['eligible', 'verified', 'gaps', 'excludedNoIntake', 'excludedUnreachableEvents', 'unreachableNodes'] as const)
    require(isCount(coverage[key]), `剧情调试覆盖率无效：${key}`);
  require(isObject(coverage.byGapKind), '剧情调试缺口分类无效');
  for (const [kind, value] of Object.entries(coverage.byGapKind))
    require(nonEmpty(kind) && isCount(value), `剧情调试缺口分类无效：${kind}`);
}

function validatePlay(play: StoryDebugPlay, campaign: Campaign, events: Set<string>, owner: string): void {
  require(isObject(play), `剧情调试任务 ${owner} 的开幕演出无效`);
  require(nonEmpty(play.script), `剧情调试任务 ${owner} 的开幕演出缺少脚本`);
  const graph = campaign.scripts[play.script];
  require(!!graph, `剧情调试任务 ${owner} 的开幕演出引用未知脚本 ${play.script}`);
  if (play.node !== undefined)
    require(!!graph!.nodes.some(node => node.id === play.node), `剧情调试任务 ${owner} 的开幕演出引用未知节点 ${play.node}`);
  if (play.event !== undefined) require(events.has(play.event), `剧情调试任务 ${owner} 的开幕演出引用未知事件 ${play.event}`);
  require(PLAY_CUTS.includes(play.cut), `剧情调试任务 ${owner} 的开幕切点无效`);
}

function validateStartTable(start: StoryDebugStartTable, quests: Map<string, CampaignQuest>, events: Set<string>, owner: string): void {
  require(isObject(start), `${owner}: 现场表需要对象`);
  const declared = new Map<string, StoryDebugStartQuest>();
  for (const entry of start.quests ?? []) {
    require(isObject(entry) && nonEmpty(entry.id), `${owner}: 现场表任务无效`);
    const definition = quests.get(entry.id);
    require(!!definition, `${owner}: 现场表引用未知任务 ${entry.id}`);
    require(!declared.has(entry.id), `${owner}: 现场表任务重复 ${entry.id}`);
    declared.set(entry.id, entry);
    require(QUEST_STATUSES.includes(entry.status), `${owner}: 任务 ${entry.id} 状态无效`);
    for (const value of [entry.cycle, entry.completedCycles])
      require(value === undefined || isCount(value), `${owner}: 任务 ${entry.id} 数值无效`);
    for (const [goalId, count] of Object.entries(entry.goals ?? {})) {
      const goal = definition!.goals.find(value => value.id === goalId);
      require(!!goal, `${owner}: 任务 ${entry.id} 引用未知目标 ${goalId}`);
      require(isCount(count) && count <= goal!.quantity, `${owner}: 任务 ${entry.id} 目标 ${goalId} 进度无效`);
    }
  }
  const running = new Set<string>();
  for (const id of start.running ?? []) {
    require(nonEmpty(id) && !running.has(id), `${owner}: 现场表运行池标识无效 ${id}`);
    const entry = declared.get(id);
    require(!!entry && RUNNING_STATUSES.includes(entry.status), `${owner}: 现场表运行池引用未接取任务 ${id}`);
    running.add(id);
  }
  for (const [id, entry] of declared)
    require(!RUNNING_STATUSES.includes(entry.status) || running.has(id), `${owner}: 现场表运行池缺少任务 ${id}`);

  const world = start.world;
  require(isObject(world) && isObject(world.location), `${owner}: 现场表缺少世界落点`);
  const location = world!.location;
  require(nonEmpty(location.map) && Number.isFinite(location.x) && Number.isFinite(location.y), `${owner}: 现场表落点无效`);
  require(FACINGS.includes(location.facing), `${owner}: 现场表落点朝向无效`);
  for (const entity of world!.entities ?? []) {
    require(isObject(entity) && nonEmpty(entity.id), `${owner}: 现场表人物标识无效`);
    require(entity.map === undefined || nonEmpty(entity.map), `${owner}: 现场表人物地图无效 ${entity.id}`);
    require(entity.actor === undefined || nonEmpty(entity.actor), `${owner}: 现场表人物角色无效 ${entity.id}`);
    require((entity.x === undefined || Number.isFinite(entity.x)) && (entity.y === undefined || Number.isFinite(entity.y)),
      `${owner}: 现场表人物坐标无效 ${entity.id}`);
    require(entity.visible === undefined || typeof entity.visible === 'boolean', `${owner}: 现场表人物可见状态无效 ${entity.id}`);
    require(entity.removed === undefined || typeof entity.removed === 'boolean', `${owner}: 现场表人物移除状态无效 ${entity.id}`);
    require(entity.mapVisit === undefined || isCount(entity.mapVisit), `${owner}: 现场表人物访问版本无效 ${entity.id}`);
  }
  for (const flag of world!.flags ?? []) require(nonEmpty(flag), `${owner}: 现场表标记无效`);
  for (const [choice, value] of world!.choices ?? [])
    require(nonEmpty(choice) && typeof value === 'string', `${owner}: 现场表选择无效`);
  for (const [id, enabled] of world!.exits ?? [])
    require(nonEmpty(id) && typeof enabled === 'boolean', `${owner}: 现场表出口无效`);
  for (const encounter of world!.encounters ?? []) {
    require(isObject(encounter) && nonEmpty(encounter.id) && nonEmpty(encounter.map), `${owner}: 现场表遭遇无效`);
    require(['prepared', 'active', 'won', 'lost'].includes(encounter.status), `${owner}: 现场表遭遇状态无效 ${encounter.id}`);
  }
  require(world!.mapVisit === undefined || isCount(world!.mapVisit), `${owner}: 现场表访问版本无效`);
  for (const removal of world!.enemyRemovals ?? [])
    require(isObject(removal) && nonEmpty(removal.enemyId) && typeof removal.all === 'boolean', `${owner}: 现场表敌人移除无效`);
  for (const spawn of world!.enemyLocations ?? [])
    require(isObject(spawn) && nonEmpty(spawn.id) && nonEmpty(spawn.enemyId) && nonEmpty(spawn.map)
      && Number.isFinite(spawn.x) && Number.isFinite(spawn.y), `${owner}: 现场表敌人位置无效`);
  for (const appearance of world!.appearances ?? [])
    require(Array.isArray(appearance) && nonEmpty(appearance[0]) && nonEmpty(appearance[1]), `${owner}: 现场表外观替换无效`);
  for (const absent of world!.absentActors ?? [])
    require(isObject(absent) && nonEmpty(absent.map) && nonEmpty(absent.actor)
      && (absent.characterId === undefined || nonEmpty(absent.characterId)), `${owner}: 现场表缺场人物无效`);
  for (const absent of world!.absentEnemies ?? [])
    require(isObject(absent) && nonEmpty(absent.map) && nonEmpty(absent.enemyId), `${owner}: 现场表缺场敌人无效`);

  const items = new Set<string>();
  for (const item of start.items ?? []) {
    require(isObject(item) && nonEmpty(item.item), `${owner}: 现场表物品无效`);
    require(!items.has(item.item), `${owner}: 现场表物品重复 ${item.item}`);
    items.add(item.item);
    require(isPositive(item.quantity), `${owner}: 现场表物品数量无效 ${item.item}`);
  }
  const reset = new Set<string>();
  for (const id of start.itemReset ?? []) {
    require(nonEmpty(id) && !reset.has(id), `${owner}: 现场表待清物品无效 ${id}`);
    reset.add(id);
  }
  if (start.party) {
    require(isObject(start.party), `${owner}: 现场表伙伴变化无效`);
    for (const id of [...start.party.join ?? [], ...start.party.leave ?? []])
      require(nonEmpty(id), `${owner}: 现场表伙伴标识无效`);
    require(start.party.control === undefined || nonEmpty(start.party.control), `${owner}: 现场表操控伙伴无效`);
  }
  const completed = new Set<string>();
  for (const entry of start.completedEvents ?? []) {
    require(isObject(entry) && nonEmpty(entry.id), `${owner}: 现场表完成事件无效`);
    require(events.has(entry.id), `${owner}: 现场表完成事件不存在 ${entry.id}`);
    require(!completed.has(entry.id), `${owner}: 现场表完成事件重复 ${entry.id}`);
    completed.add(entry.id);
  }
  for (const [label, sequences] of [['剧情', start.occurrenceSequences], ['任务', start.factSequences]] as const) {
    const sources = new Set<string>();
    for (const pair of sequences ?? []) {
      require(Array.isArray(pair) && pair.length === 2 && nonEmpty(pair[0]) && isPositive(pair[1]),
        `${owner}: 现场表${label}序号无效`);
      require(!sources.has(pair[0]), `${owner}: 现场表${label}来源重复 ${pair[0]}`);
      sources.add(pair[0]);
    }
  }
  if (start.requiresProfile) {
    require(isObject(start.requiresProfile), `${owner}: 现场表玩家资源先决条件无效`);
    for (const item of start.requiresProfile.items ?? []) {
      require(isObject(item) && nonEmpty(item.item) && isPositive(item.quantity), `${owner}: 现场表玩家物品先决条件无效`);
    }
    require(start.requiresProfile.money === undefined || isCount(start.requiresProfile.money),
      `${owner}: 现场表玩家金币先决条件无效`);
  }
}

import type { Campaign } from '../domain/campaign.ts';
import type { QuestStatus } from '../domain/content.ts';
import type { QuestBookState } from '../domain/quest-book.ts';
import type { Session, SessionState } from '../domain/session.ts';
import {
  debugTask, storyDebugEvidenceCount, type StoryDebugPlay,
  type StoryDebugStartTable, type StoryDebugTarget, type StoryDebugTask,
} from '../domain/story-debug.ts';
import type { StoryRuntimeSnapshot } from '../domain/story-runtime.ts';
import type { StoryWorldSnapshot } from '../domain/story-world.ts';
import { Bag } from '../domain/bag.ts';

export interface StoryDebugScene {
  map: string;
  x: number;
  y: number;
}

export interface StoryDebugPreview {
  quest: string;
  phase: 'available' | 'active';
  location: StoryDebugScene;
  sourceHash?: string;
  play?: StoryDebugPlay;
  /** 现场表里指向证据台账的引用条数。 */
  evidence?: number;
}

const QUEST_STATUS_LABELS: Record<QuestStatus, string> = {
  locked: '未解锁', available: '可接取', active: '进行中', ready: '待交付', completed: '已完成',
};
const RUNNING_STATUSES: readonly QuestStatus[] = ['active', 'ready'];
const describe = (error: unknown): string => error instanceof Error ? error.message : String(error);

/**
 * 按任务准备一个可开演的会话副本。
 *
 * 只套现场表：干净沙箱 + 任务簿差量 + 世界差量 + 物品；主角成长、技能、金币、游戏时间、
 * 伙伴与普通背包从当前会话合并。整局开场（`source: 'start'`）属于会话级事实，
 * 由安装器补记为已完成。准备过程始终在隔离沙箱里完成，调用方拿到的 `SessionState`
 * 可以直接 `restoreState` 安装。
 */
export async function prepareTaskStart(source: Session, target: StoryDebugTarget): Promise<SessionState> {
  const task = debugTask(source.campaign, target);
  const session = source.createStorySandbox();
  if (!task.start) throw new Error(`任务 ${task.quest} 的调试目录缺少现场表`);
  return prepareFromStartTable(source, session, task);
}

/** 套用现场表：展开成完整的任务簿/世界/运行时/背包，安装到沙箱后按表复核固定点。 */
function prepareFromStartTable(source: Session, session: Session, task: StoryDebugTask): SessionState {
  const start = task.start!;
  const quest = session.definition(task.quest);
  if (!quest) throw new Error(`任务不存在：${task.quest}`);
  const profile = source.captureState();
  const base = session.captureState();

  // 0. 需要玩家已有资源的先决条件先查：不足就明确失败，不伪造物品和金币。
  for (const item of start.requiresProfile?.items ?? []) {
    const owned = source.bag.count(item.item);
    if (owned < item.quantity)
      throw new Error(`调试现场需要已有物品 ${item.item} ×${item.quantity}，当前只有 ${owned}`);
  }
  const requiredMoney = start.requiresProfile?.money ?? 0;
  if (source.money < requiredMoney)
    throw new Error(`调试现场需要已有金币 ${requiredMoney}，当前只有 ${source.money}`);

  // 1. 任务簿：干净状态上应用差量，未写到的目标补零。
  const questStates = new Map(base.questBook.quests);
  for (const entry of start.quests ?? []) {
    const definition = session.definition(entry.id);
    if (!definition) throw new Error(`现场表引用未知任务：${entry.id}`);
    const current = questStates.get(entry.id);
    if (!current) throw new Error(`现场表引用未知任务：${entry.id}`);
    for (const goalId of Object.keys(entry.goals ?? {}))
      if (!definition.goals.some(goal => goal.id === goalId))
        throw new Error(`现场表任务 ${entry.id} 引用未知目标 ${goalId}`);
    questStates.set(entry.id, {
      status: entry.status,
      cycle: entry.cycle ?? current.cycle,
      completedCycles: entry.completedCycles ?? current.completedCycles,
      goals: Object.fromEntries(definition.goals.map(goal => [goal.id, entry.goals?.[goal.id] ?? 0])),
    });
  }
  const running = start.running ? [...start.running] : [...questStates]
    .filter(([, state]) => RUNNING_STATUSES.includes(state.status)).map(([id]) => id);
  for (const id of running) {
    const state = questStates.get(id);
    if (!state) throw new Error(`现场表运行池引用未知任务：${id}`);
    if (!RUNNING_STATUSES.includes(state.status)) throw new Error(`现场表运行池引用未接取任务：${id}`);
  }
  for (const [id, state] of questStates) {
    if (RUNNING_STATUSES.includes(state.status) && !running.includes(id))
      throw new Error(`现场表运行池缺少任务：${id}`);
  }
  const factSequences = (start.factSequences ?? base.questBook.factSequences)
    .map(([source, sequence]) => [source, sequence] as [string, number]);
  const questBook: QuestBookState = {
    version: 5, quests: [...questStates], runningQuestIds: running, factSequences,
  };

  // 2. 剧情运行时：从干净快照出发，保留现场表声明的完成事件、序号与整局开场。
  //    现场表只描述任务入口，不记录整局开场；调试跳转直达任务现场，隐含开场已经发生。
  //    不补记的话，第一次普通切图时 `openingPending()` 会重新成立并重播开场。
  const openingEvents = session.campaign.events
    .filter(event => event.source === 'start').map(event => event.id);
  const declaredEvents = (start.completedEvents ?? []).map(entry => entry.id);
  const runtime: StoryRuntimeSnapshot = {
    ...base.runtime,
    runs: [], pendingOccurrences: [], handledOccurrences: [], encounterResults: [],
    completedEvents: [...new Set([...openingEvents, ...declaredEvents])],
    occurrenceSequences: (start.occurrenceSequences ?? []).map(([source, sequence]) => [source, sequence] as [string, number]),
  };
  runtime.sequence = Math.max(0, ...runtime.occurrenceSequences.map(([, sequence]) => sequence));

  // 3. 世界：套用现场落点。`cut === 'before-opening'` 时落点是开幕事件的开场图，
  //    与旧目录里的 `entry` 不一定相同，所以这里只信现场表。
  const rawWorld = structuredClone(start.world);
  if (!rawWorld) throw new Error('现场表缺少世界落点');
  const flags = new Set<string>(rawWorld.flags ?? base.storyWorld.flags);
  for (const absent of rawWorld.absentActors ?? [])
    flags.add(JSON.stringify(['absent-actor', absent.map, absent.characterId ?? absent.actor]));
  for (const absent of rawWorld.absentEnemies ?? [])
    flags.add(JSON.stringify(['absent-enemy', absent.map, absent.enemyId]));
  const snapshot = rawWorld as Record<string, unknown>;
  delete snapshot.absentActors; delete snapshot.absentEnemies;
  const world: StoryWorldSnapshot = {
    ...base.storyWorld,
    ...(snapshot as Omit<Partial<StoryWorldSnapshot>, 'location'>),
    flags: [...flags],
    location: {
      map: rawWorld.location.map, x: rawWorld.location.x, y: rawWorld.location.y,
      facing: rawWorld.location.facing,
    },
  };

  // 4. 背包：普通背包来自当前会话；场景物品先清后取绝对值。
  const bag = new Bag(() => {}, source.bag.catalog, source.hero?.classId ?? source.character?.classId ?? '');
  bag.restoreState(profile.bag);
  for (const id of start.itemReset ?? []) {
    const owned = bag.count(id);
    if (owned) bag.remove(id, owned);
  }
  for (const entry of start.items ?? []) {
    const owned = bag.count(entry.item);
    if (owned) bag.remove(entry.item, owned);
    if (entry.quantity > 0) bag.add(entry.item, entry.quantity);
  }

  // 5. 组装：主角成长、技能、金币、游戏时间、伙伴与普通背包保留；剧情现场只来自现场表。
  const state: SessionState = {
    ...base,
    questBook,
    storyWorld: world,
    runtime,
    factSequences,
    receipts: [],
    trackedQuest: task.quest,
    debugFocusQuest: task.quest,
    player: profile.player,
    money: profile.money,
    gameTimeMs: profile.gameTimeMs,
    hero: profile.hero,
    skills: profile.skills,
    party: profile.party,
    bag: bag.captureState(),
    enemies: [],
  };

  session.restoreState(state);
  if (start.party) applyPartyChanges(session, start.party);
  session.refresh();
  verifyPrepared(session, task, start, world);
  return session.captureState();
}

/** 伙伴变化在安装后用真实名册应用：加入的剧情伙伴按目录生成，上阵位空着时自动上阵。 */
function applyPartyChanges(session: Session, party: NonNullable<StoryDebugStartTable['party']>): void {
  const roster = session.party;
  if (!roster) throw new Error('当前会话没有队伍系统，无法套用现场表里的伙伴变化');
  for (const id of party.leave ?? []) {
    // 现场表是绝对状态：干净沙箱里本来就不在队的伙伴，离队是幂等的。
    if (!roster.get(`story-${id}`)) continue;
    if (!roster.leaveStory(id)) throw new Error(`现场表无法移除伙伴：${id}`);
  }
  for (const id of party.join ?? []) {
    try { roster.joinStory(id); }
    catch (error) { throw new Error(`现场表无法加入伙伴 ${id}：${describe(error)}`); }
  }
  if (party.control && !roster.switchControl(party.control))
    throw new Error(`现场表无法操控伙伴：${party.control}`);
}

/** 安装后复核：目标状态、运行池、世界、物品、伙伴与固定点，任何一项不符都给出具体原因。 */
function verifyPrepared(session: Session, task: StoryDebugTask, start: StoryDebugStartTable,
  world: StoryWorldSnapshot): void {
  const declared = start.quests?.find(entry => entry.id === task.quest);
  const status = session.status(task.quest);
  if (declared) {
    if (status !== declared.status)
      throw new Error(`现场表任务状态不是固定点：${task.quest} 期望 ${QUEST_STATUS_LABELS[declared.status]}，安装后是 ${QUEST_STATUS_LABELS[status]}`);
  } else if (!['available', 'active', 'ready'].includes(status)) {
    throw new Error(`现场表没有给出任务起点，安装后任务处于${QUEST_STATUS_LABELS[status]}`);
  }
  for (const id of start.running ?? []) {
    if (!session.questBook.runningQuestIds.includes(id))
      throw new Error(`现场表运行池没有安装：${id}`);
  }
  for (const [id, state] of session.questBook.captureState().quests) {
    if (RUNNING_STATUSES.includes(state.status) && !session.questBook.runningQuestIds.includes(id))
      throw new Error(`现场表运行池缺少任务：${id}`);
  }

  const installed = session.captureState();
  // 整局开场由安装器补记；缺了它，玩家第一次从普通出口换图就会重播开场。
  for (const event of session.campaign.events)
    if (event.source === 'start' && !installed.runtime.completedEvents.includes(event.id))
      throw new Error(`现场表没有补上整局开场事件：${event.id}`);
  const location = installed.storyWorld.location;
  if (!location || location.map !== world.location!.map || location.x !== world.location!.x
    || location.y !== world.location!.y || location.facing !== world.location!.facing)
    throw new Error(`现场表落点没有安装：${world.location!.map}(${world.location!.x},${world.location!.y})`);
  const installedFlags = new Set(installed.storyWorld.flags);
  for (const flag of world.flags) if (!installedFlags.has(flag)) throw new Error(`现场表标记没有安装：${flag}`);
  for (const [choice, value] of world.choices)
    if (installed.storyWorld.choices.find(([id]) => id === choice)?.[1] !== value)
      throw new Error(`现场表选择没有安装：${choice}`);
  for (const entity of world.entities) {
    const saved = installed.storyWorld.entities.find(value => value.id === entity.id);
    if (!saved || saved.map !== entity.map || saved.x !== entity.x || saved.y !== entity.y)
      throw new Error(`现场表人物没有安装：${entity.id}`);
  }
  for (const entry of start.items ?? []) {
    const count = session.itemCount(entry.item);
    if (count !== entry.quantity)
      throw new Error(`现场表物品没有安装：${entry.item} 期望 ${entry.quantity}，实际 ${count}`);
  }
  for (const id of start.itemReset ?? []) {
    // 先清后取：同一件物品又出现在 `items` 里时，最终数量由绝对值那一条决定。
    if ((start.items ?? []).some(entry => entry.item === id)) continue;
    if (session.itemCount(id) !== 0) throw new Error(`现场表物品没有清空：${id}`);
  }
  for (const id of start.party?.join ?? []) {
    if (!session.party?.get(`story-${id}`)) throw new Error(`现场表伙伴没有加入：${id}`);
  }
  for (const id of start.party?.leave ?? []) {
    if (session.party?.get(`story-${id}`)) throw new Error(`现场表伙伴没有移除：${id}`);
  }
  if (start.party?.control && session.party?.controlledId !== start.party.control)
    throw new Error(`现场表操控伙伴没有生效：${start.party.control}`);

  // 固定点：refresh 之后任务簿必须原样不动，否则下次刷新会改写调试现场。
  const before = session.questBook.captureState();
  session.refresh();
  const after = session.questBook.captureState();
  for (const [id, state] of after.quests) {
    const prior = before.quests.find(([candidate]) => candidate === id)?.[1];
    if (prior && prior.status !== state.status)
      throw new Error(`现场表不是固定点：任务 ${id} 从${QUEST_STATUS_LABELS[prior.status]}变成${QUEST_STATUS_LABELS[state.status]}`);
  }
  if (JSON.stringify(after.runningQuestIds) !== JSON.stringify(before.runningQuestIds))
    throw new Error('现场表不是固定点：任务运行池在刷新后改变');
}

/** 预览与跳转读取同一份准备结果；落点就是安装后的现场落点，阶段读安装后的真实状态。 */
export function storyTaskPreview(campaign: Campaign, target: StoryDebugTarget, state: SessionState): StoryDebugPreview {
  const task = debugTask(campaign, target);
  const location = state.storyWorld.location;
  if (!location) throw new Error('任务准备没有产生落点');
  const progress = state.questBook.quests.find(([id]) => id === task.quest)?.[1];
  return {
    quest: task.quest,
    phase: progress?.status === 'available' ? 'available' : 'active',
    location: { map: location.map, x: location.x, y: location.y },
    ...(task.sourceHash ? { sourceHash: task.sourceHash } : {}),
    ...(task.play ? { play: task.play } : {}),
    evidence: storyDebugEvidenceCount(task),
  };
}

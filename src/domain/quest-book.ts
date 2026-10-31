import type { QuestGroupDefinition, QuestReward, QuestRewardReceipt, QuestStatus } from './content.ts';
import { evaluateStoryCondition, storyConditionReferences, type StoryCondition, type StoryConditionContext } from './story-condition.ts';
import { moneyGain } from './economy.ts';

/**
 * 已接取的三个状态。`QuestBook.accepted` 与任务日志的过滤共用这一份，
 * 免得改一处而另一处仍在用旧口径。
 */
export const ACCEPTED_QUEST_STATUSES: readonly QuestStatus[] = ['active', 'ready', 'completed'];

/**
 * 内容里的支线任务标识。原版的章节切换会「清空全部支线」（事件命令 `0x4a`，见
 * `work/findings/119_quest_group_reset_2026-10-15.md`），复刻按任务组的 `kind` 取这批任务。
 */
export function sideQuestIds(groups: readonly QuestGroupDefinition[]): ReadonlySet<string> {
  return new Set(groups.filter(group => group.kind === 'side').flatMap(group => group.questIds));
}

/**
 * 任务定义本身要不要出现在玩家眼前：隐藏任务与内部任务都不出现。
 * 与有没有进度无关——`QuestBook.visible` 与任务日志的过滤都从这里取这一条。
 */
export function questIsVisible(definition: QuestRules): boolean {
  return !definition.hidden && definition.completion !== 'internal';
}

interface QuestItemAmount { item: string; quantity: number }
interface QuestHandoverItem extends QuestItemAmount { removal?: 'quantity' | 'all-matching' }
interface QuestGoal {
  id: string;
  kind: 'talk' | 'item' | 'interact' | 'defeat' | 'recruit';
  target: string;
  characterId?: string;
  quantity: number;
  label?: string;
}
/** QuestDefinition adds presentation fields to this single set of domain rules. */
export interface QuestRules {
  id: string;
  goals: QuestGoal[];
  availableWhen?: StoryCondition;
  completion: 'talk' | 'all' | 'story' | 'internal';
  hidden?: boolean;
  repeat?: boolean;
  onAcceptItems?: QuestItemAmount[];
  handoverItems?: QuestHandoverItem[];
  rewards?: QuestReward;
  itemCompletion?: 'all' | 'equipped-item-shortcut';
}
export interface QuestContext extends StoryConditionContext {
  itemCount(item: string): number;
  equippedItemCount?(item: string): number;
  classId?: string;
}
export interface QuestProgress {
  status: QuestStatus;
  cycle: number;
  completedCycles: number;
  goals: Record<string, number>;
}
const QUEST_BOOK_STATE_VERSION = 5;
export interface QuestBookState {
  version: typeof QUEST_BOOK_STATE_VERSION;
  quests: [string, QuestProgress][];
  /** 接取时追加，完成或重置时由尾项补位；包含进行中与待交付任务。 */
  runningQuestIds: string[];
  /** Each producer emits facts in ascending order; history takes one number per producer. */
  factSequences: [string, number][];
  /**
   * GM 调试兜底：这些已接取任务在 refresh 时强制保持 active。
   * 只由调试准备产生，玩家存档在 `capturePersistentState` 里剥除。
   */
  debugPins?: string[];
}
export interface QuestFact {
  kind: 'talk' | 'interact' | 'defeat' | 'recruit';
  target: string;
  characterId?: string;
  quantity?: number;
  occurrence: { source: string; sequence: number };
}
export type QuestCommand =
  | { type: 'accept'; quest: string; cycle?: number; source?: 'interaction' | 'script' }
  | { type: 'complete' | 'script-ready' | 'script-complete' | 'reset'; quest: string; cycle?: number }
  | { type: 'fact'; fact: QuestFact }
  /** GM 调试：把已接取任务钉在进行中，refresh 不再把它提升为待交付。 */
  | { type: 'pin-active' | 'unpin-active'; quest: string }
  /** 把所有已接取的支线任务重置：收回它要收集的物品并把状态写回未接取。原版事件命令 `0x4a`。 */
  | { type: 'reset-side-quests' }
  | { type: 'refresh' };
export interface QuestSettlement { quest: string; cycle: number; reward: QuestRewardReceipt }
interface QuestPlan {
  readonly baseRevision: number;
  readonly changed: boolean;
  readonly nextState: QuestBookState;
  readonly itemGrants: readonly QuestItemAmount[];
  readonly itemRemovals: readonly QuestItemAmount[];
  readonly rewards: readonly QuestSettlement[];
}
interface QuestRestorePlan { readonly baseRevision: number; readonly nextState: QuestBookState }
/** 批次回滚基线：只记状态根，条目不可变所以不需要复制。 */
export interface QuestBookCheckpoint {
  readonly states: ReadonlyMap<string, QuestProgress>;
  readonly runningIds: readonly string[];
  readonly factSequences: ReadonlyMap<string, number>;
  readonly debugPins: ReadonlySet<string>;
}

function integer(value: number, minimum: number, description: string): void {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${description}无效`);
}
/**
 * 冻结一条任务进度。条目一旦建成就不可原地修改：`plan` 改状态靠换一个新对象。
 *
 * 这是写时复制的前提——未改动的条目可以在批次之间、以及在预演沙盒与真实任务簿之间按
 * **对象身份**共享，不必克隆。共享的是不可变对象，所以不是别名。
 */
function frozenProgress(progress: QuestProgress): QuestProgress {
  return Object.freeze({ ...progress, goals: Object.freeze({ ...progress.goals }) });
}
function initialProgress(quest: QuestRules): QuestProgress {
  return frozenProgress({ status: 'locked', cycle: 0, completedCycles: 0, goals: Object.fromEntries(quest.goals.map(goal => [goal.id, 0])) });
}
/** 两条进度是否逐字段相等；`goals` 按值比较。`plan` 用它判断一批有没有真的改动。 */
function sameProgress(a: Readonly<QuestProgress>, b: Readonly<QuestProgress>): boolean {
  if (a === b) return true;
  if (a.status !== b.status || a.cycle !== b.cycle || a.completedCycles !== b.completedCycles) return false;
  const keys = Object.keys(a.goals);
  return keys.length === Object.keys(b.goals).length && keys.every(key => a.goals[key] === b.goals[key]);
}
/** 运行池按顺序比较：顺序是原生语义（完成时由尾项补位）。 */
function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
function sameNumbers(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) if (b.get(key) !== value) return false;
  return true;
}
function sameStringSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}
/** 计划内部的私有状态；提交时由 `commit` 接管。 */
interface PlanEntry {
  states: Map<string, QuestProgress>;
  runningIds: string[];
  factSequences: Map<string, number>;
  debugPins: Set<string>;
  changed: boolean;
  snapshot?: QuestBookState;
}
/**
 * 递归冻结；已冻结的子树不再往下走。
 *
 * 短路依赖「冻结总是自底向上」：本文件里 `frozenProgress`、`preparedDefinitions` 与
 * `nextState` 的物化都先把子对象冻好再冻父对象，所以父对象冻结 ⇒ 整棵子树已冻结。
 */
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    if (Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** 任务定义的只读副本，按传入的内容数组身份复用。 */
const definitionCache = new WeakMap<readonly QuestRules[], ReadonlyMap<string, QuestRules>>();

/**
 * 克隆、深冻结并校验任务定义；同一份内容数组只做一次。
 *
 * 每次 `new QuestBook` 都重做这遍（505 条定义）是死亡结算里最贵的一项，而定义建成之后只被
 * 读取——`definition(id)` 返回冻结对象、`plan` 只迭代——所以跨实例共享安全。前提是**调用方
 * 不原地修改传入的数组**：内容加载器按文件名缓存，`campaign.quests` 的身份是稳定的。
 * 校验失败不缓存，重复构造仍会重新报错。
 */
function preparedDefinitions(definitions: readonly QuestRules[]): ReadonlyMap<string, QuestRules> {
  const cached = definitionCache.get(definitions);
  if (cached) return cached;
  const prepared = new Map(definitions.map(quest => [quest.id, freeze(structuredClone(quest))]));
  if (prepared.size !== definitions.length) throw new Error('任务标识重复');
  for (const quest of prepared.values()) {
    if (!quest.id) throw new Error('任务标识为空');
    if (new Set(quest.goals.map(goal => goal.id)).size !== quest.goals.length) throw new Error(`任务 ${quest.id} 目标标识重复`);
    if (quest.completion === 'all' && !quest.goals.length) throw new Error(`任务 ${quest.id} 缺少完成目标`);
    if (quest.itemCompletion === 'equipped-item-shortcut' && (quest.completion !== 'all' || quest.goals.some(goal => goal.kind !== 'item')))
      throw new Error('装备判定捷径只适用于物品目标任务');
    if (quest.completion === 'talk' && quest.goals.length) throw new Error('对话任务的说明对象应放在 descriptionTargets');
    for (const goal of quest.goals) {
      if (!goal.id || !goal.target) throw new Error(`任务 ${quest.id} 目标标识为空`);
      integer(goal.quantity, 1, '目标数量');
    }
    for (const item of [...quest.onAcceptItems ?? [], ...quest.handoverItems ?? [], ...quest.rewards?.items ?? []]) {
      if (!item.item) throw new Error('物品标识为空');
      integer(item.quantity, 1, '物品数量');
    }
    if (quest.rewards) { integer(quest.rewards.experience, 0, '经验奖励'); integer(quest.rewards.money, 0, '金币奖励'); }
    for (const referenced of storyConditionReferences(quest.availableWhen).quests)
      if (!prepared.has(referenced)) throw new Error(`任务 ${quest.id} 引用未知任务 ${referenced}`);
  }
  definitionCache.set(definitions, prepared);
  return prepared;
}

/** Plans game changes without mutating inventory; the session commits the entire batch synchronously. */
export class QuestBook {
  private readonly definitions: ReadonlyMap<string, QuestRules>;
  /** 定义来源数组；`fork` 要用同一份身份去复用 `definitionCache`。 */
  private readonly definitionSource: readonly QuestRules[];
  /** 条目不可变（见 `frozenProgress`）；写入一律换对象，所以未改动的条目可以安全共享。 */
  private states: Map<string, QuestProgress>;
  private runningIds: string[] = [];
  private factSequences = new Map<string, number>();
  /** GM 调试钉住的任务：只影响调试准备态，正常玩法不会写入。 */
  private debugPins = new Set<string>();
  private revision = 0;
  /** 计划内部的私有状态，提交时由 `commit` 接管；`nextState` 从这里按需物化。 */
  private readonly plans = new WeakMap<QuestPlan, PlanEntry>();
  private readonly restores = new WeakMap<QuestRestorePlan, QuestBookState>();
  private readonly context: () => QuestContext;
  private readonly sideQuests: ReadonlySet<string>;

  constructor(definitions: readonly QuestRules[], context: () => QuestContext, sideQuests: ReadonlySet<string>,
    options?: { state?: QuestBookState; shareFrom?: QuestBook }) {
    this.context = context;
    this.sideQuests = sideQuests;
    this.definitionSource = definitions;
    this.definitions = preparedDefinitions(definitions);
    // 派生沙盒：与来源共享同一份不可变状态根，不克隆、也不跑初始 refresh。
    const source = options?.shareFrom;
    if (source) { this.states = source.states; this.runningIds = [...source.runningIds]; this.factSequences = new Map(source.factSequences); this.debugPins = new Set(source.debugPins); this.revision = source.revision; return; }
    this.states = new Map([...this.definitions].map(([id, quest]) => [id, initialProgress(quest)]));
    // 已知初态时直接安装：调用方（预演沙盒）拿的就是本类产出的状态，不必再刷新一遍。
    if (options?.state) { this.installTrustedState(options.state); return; }
    this.commit(this.plan({ type: 'refresh' }));
  }
  get version(): number { return this.revision; }
  definition(id: string): QuestRules | undefined { return this.definitions.get(id); }
  /** 单条进度；条目本身已冻结，直接交出去即可，不必克隆。 */
  state(id: string): Readonly<QuestProgress> | undefined { return this.states.get(id); }
  /** 全部进度的只读投影，供调用方按需遍历而不物化整份快照。 */
  progressEntries(): ReadonlyMap<string, Readonly<QuestProgress>> { return this.states; }
  /** 事实序号的只读投影，供提交侧镜像到会话级。 */
  factSequenceEntries(): readonly (readonly [string, number])[] { return [...this.factSequences]; }
  status(id: string): QuestStatus { return this.states.get(id)?.status ?? 'locked'; }
  /** 该任务是否被 GM 调试钉在进行中。 */
  pinned(id: string): boolean { return this.debugPins.has(id); }
  /** GM 调试专用：让已接取任务保持进行中，直到显式解除或脚本结算。 */
  pinDebug(id: string): void { this.commit(this.plan({ type: 'pin-active', quest: id })); }
  unpinDebug(id: string): void { this.commit(this.plan({ type: 'unpin-active', quest: id })); }
  accepted(id: string): boolean { return ACCEPTED_QUEST_STATUSES.includes(this.status(id)); }
  completedCycles(id: string): number { return this.states.get(id)?.completedCycles ?? 0; }
  visible(id: string): boolean { const definition=this.definitions.get(id); return !!definition && questIsVisible(definition); }
  get runningQuestIds(): readonly string[] { return [...this.runningIds]; }
  captureState(): QuestBookState {
    return structuredClone({ version: QUEST_BOOK_STATE_VERSION, quests: [...this.states], runningQuestIds: this.runningIds,
      factSequences: [...this.factSequences], ...(this.debugPins.size ? { debugPins: [...this.debugPins].sort() } : {}) });
  }
  /** 某个来源已经记到的事实序号。比 `captureState()` 克隆整本任务簿再读一个数字便宜得多。 */
  factSequence(source: string): number { return this.factSequences.get(source) ?? 0; }
  /** 批次回滚用的 O(1) 检查点：只记状态根，不复制条目。 */
  checkpoint(): QuestBookCheckpoint {
    return { states: this.states, runningIds: [...this.runningIds], factSequences: new Map(this.factSequences), debugPins: new Set(this.debugPins) };
  }
  /**
   * 换回检查点记下的状态根。
   *
   * 这里**推进** `revision` 而不是回写旧值：`commit` 用 `baseRevision` 判断计划是否失效，
   * 版本能倒退会让一个已经作废的计划重新变成有效；`Session` 与导演的投影缓存也都以版本
   * 单调为前提。
   */
  rollbackTo(checkpoint: QuestBookCheckpoint): void {
    this.states = new Map(checkpoint.states); this.runningIds = [...checkpoint.runningIds];
    this.factSequences = new Map(checkpoint.factSequences); this.debugPins = new Set(checkpoint.debugPins); this.revision++;
  }

  plan(command: QuestCommand | readonly QuestCommand[]): QuestPlan {
    // 写时复制：只拷容器、不拷条目。条目不可变，所以未改动的部分在批次之间按身份共享，
    // 成本从「O(任务数) 的深拷贝」降到「O(改动) 的换条目」。
    const states = new Map(this.states), runningIds = [...this.runningIds], factSequences = new Map(this.factSequences);
    const debugPins = new Set(this.debugPins);
    const actions = Array.isArray(command) ? command : [command];
    const context = this.context();
    const dirty = new Set<string>();
    /** 值级写入：字段真的不同才换条目并记脏；`goals` 按值比较。 */
    const write = (id: string, patch: Partial<QuestProgress>): void => {
      const current = states.get(id)!;
      const merged = { ...current, ...patch };
      if (sameProgress(current, merged)) return;
      states.set(id, frozenProgress(merged));
      dirty.add(id);
    };
    const grants = new Map<string, number>(), removals = new Map<string, number>();
    const balances = new Map<string, number>(), rewards: QuestSettlement[] = [];
    const removeRunning = (id: string): void => {
      const index = runningIds.indexOf(id);
      if (index < 0) return;
      const last = runningIds.pop()!;
      if (index < runningIds.length) runningIds[index] = last;
    };
    const count = (item: string): number => {
      const value = balances.get(item) ?? context.itemCount(item); integer(value, 0, '背包物品数量'); return value;
    };
    const add = (map: Map<string, number>, item: string, quantity: number): void => {
      const value = (map.get(item) ?? 0) + quantity;
      integer(value, 0, '物品总量'); map.set(item, value);
    };
    const grant = (item: string, quantity: number): void => { add(grants, item, quantity); const value = count(item) + quantity; integer(value, 0, '物品总量'); balances.set(item, value); };
    const conditionContext: StoryConditionContext = {
      questStatus: id => states.get(id)?.status ?? 'locked', questCompletedCycles: id => states.get(id)?.completedCycles ?? 0,
      eventStatus: id => context.eventStatus(id), choice: id => context.choice(id), flag: id => context.flag(id), world: key => context.world(key) };
    const refresh = (): void => {
      // Unlocking can depend on another quest becoming available in the same batch.
      for (let pass = 0; pass <= states.size; pass++) {
        let availabilityChanged = false;
        for (const [id, quest] of this.definitions) {
          const state = states.get(id)!;
          const available = quest.completion !== 'internal' && evaluateStoryCondition(quest.availableWhen, conditionContext);
          // 只有「可接取 ⇄ 锁定」的翻转才需要再跑一轮：别的任务的条件可能读了它。
          let status = state.status;
          if (status === 'available' && !available) { status = 'locked'; availabilityChanged = true; }
          else if (status === 'locked' && available) { status = 'available'; availabilityChanged = true; }
          // 目标进度先在本地的 `goals` 上算，真的变了才复制一层；`state.goals` 是共享的不可变对象。
          let goals = state.goals;
          if (['active', 'ready'].includes(status) && quest.completion === 'all') {
            for (const goal of quest.goals) if (goal.kind === 'item') {
              const value = Math.min(goal.quantity, count(goal.target));
              if (goals[goal.id] === value) continue;
              if (goals === state.goals) goals = { ...goals };
              goals[goal.id] = value;
            }
            let ready = true;
            for (const goal of quest.goals) {
              if (goals[goal.id] >= goal.quantity) continue;
              if (goal.kind === 'item' && quest.itemCompletion === 'equipped-item-shortcut' && (context.equippedItemCount?.(goal.target) ?? 0) > 0) break;
              ready = false; break;
            }
            status = ready ? 'ready' : 'active';
            // GM 调试钉住：目标已满足也留在进行中；脚本结算命令会在批次开始时先解除。
            if (debugPins.has(id)) status = 'active';
          }
          if (status === state.status && goals === state.goals) continue;
          write(id, { status, goals });
        }
        if (!availabilityChanged) break;
      }
    };
    const settle = (quest: QuestRules, state: QuestProgress): void => {
      const required = new Map<string, number>();
      for (const item of quest.handoverItems ?? []) {
        const amount = item.removal === 'all-matching' ? count(item.item) : item.quantity;
        add(required, item.item, amount);
      }
      for (const [item, quantity] of required) if (count(item) < quantity) throw new Error(`交付物品 ${item} 不足`);
      for (const [item, quantity] of required) { balances.set(item, count(item) - quantity); add(removals, item, quantity); }
      const reward = quest.rewards;
      const receipt: QuestRewardReceipt = { experience: reward?.experience ?? 0, money: moneyGain(reward?.money ?? 0),
        items: (reward?.items ?? []).filter(item => !item.classIds || !!context.classId && item.classIds.includes(context.classId))
          .map(({ item, quantity }) => ({ item, quantity })) };
      rewards.push({ quest: quest.id, cycle: state.cycle, reward: receipt });
      receipt.items.forEach(item => grant(item.item, item.quantity));
      integer(state.completedCycles + 1, 0, '任务完成周期');
      removeRunning(quest.id);
      if (quest.repeat) {
        integer(state.cycle + 1, 0, '任务周期');
        write(quest.id, { completedCycles: state.completedCycles + 1, cycle: state.cycle + 1, status: 'locked', goals: initialProgress(quest).goals });
      } else write(quest.id, { completedCycles: state.completedCycles + 1, status: 'completed' });
    };
    // 结算/重置命令先解除调试钉住，再让 refresh 按真实目标重算状态；
    // 否则 `complete` 看到的是 pinned active，永远过不了 ready 检查。
    for (const action of actions) {
      if (action.type === 'reset-side-quests') {
        for (const id of debugPins) if (this.sideQuests.has(id)) debugPins.delete(id);
      } else if (action.type === 'complete' || action.type === 'script-ready' || action.type === 'script-complete' || action.type === 'reset') {
        debugPins.delete(action.quest);
      }
    }
    refresh();
    for (const action of actions) {
      if (action.type === 'refresh') { refresh(); continue; }
      if (action.type === 'fact') {
        const fact = action.fact, { source, sequence } = fact.occurrence;
        if (!source || !fact.target) throw new Error('任务事实缺少来源或目标');
        integer(sequence, 1, '事实序号'); integer(fact.quantity ?? 1, 1, '事实数量');
        if (sequence <= (factSequences.get(source) ?? 0)) continue;
        factSequences.set(source, sequence);
        for (const [id, quest] of this.definitions) {
          const state = states.get(id)!;
          if (state.status !== 'active' || quest.completion !== 'all') continue;
          let goals = state.goals;
          for (const goal of quest.goals) if (goal.kind === fact.kind && (fact.characterId !== undefined && goal.characterId !== undefined
            ? goal.characterId === fact.characterId : goal.target === fact.target)) {
            const value = Math.min(goal.quantity, goals[goal.id] + (fact.quantity ?? 1));
            if (goals[goal.id] === value) continue;
            if (goals === state.goals) goals = { ...goals };
            goals[goal.id] = value;
          }
          if (goals !== state.goals) write(id, { goals });
        }
        refresh(); continue;
      }
      if (action.type === 'reset-side-quests') {
        // 原版按运行池清支线；移除后重看当前槽，处理搬来的尾项（findings 119、157）。
        for (let index = 0; index < runningIds.length;) {
          const id = runningIds[index];
          if (!this.sideQuests.has(id)) { index++; continue; }
          const quest = this.definitions.get(id)!, state = states.get(id)!;
          for (const item of quest.handoverItems ?? []) {
            const held = count(item.item);
            const quantity = item.removal === 'all-matching' ? held : Math.min(held, item.quantity);
            if (!quantity) continue;
            balances.set(item.item, held - quantity); add(removals, item.item, quantity);
          }
          integer(state.cycle + 1, 0, '任务周期');
          write(id, { cycle: state.cycle + 1, status: 'locked', goals: initialProgress(quest).goals });
          removeRunning(id);
        }
        refresh(); continue;
      }
      if (action.type === 'pin-active') {
        const quest = this.definitions.get(action.quest), state = states.get(action.quest);
        if (!quest || !state) throw new Error(`未知任务 ${action.quest}`);
        if (quest.completion !== 'all') throw new Error('只有目标计数任务能钉住进行中');
        if (!['active', 'ready'].includes(state.status)) throw new Error('只能钉住已接取的任务');
        if (!debugPins.has(action.quest)) { debugPins.add(action.quest); refresh(); }
        continue;
      }
      if (action.type === 'unpin-active') {
        if (!this.definitions.has(action.quest)) throw new Error(`未知任务 ${action.quest}`);
        if (debugPins.delete(action.quest)) refresh();
        continue;
      }
      const quest = this.definitions.get(action.quest), state = states.get(action.quest);
      if (!quest || !state) throw new Error(`未知任务 ${action.quest}`);
      if (action.cycle !== undefined && action.cycle !== state.cycle) throw new Error(`任务 ${action.quest} 周期已改变`);
      switch (action.type) {
        // 原版写的是绝对状态（`QUESTSYSTEM_ChangeQuestState@0x1c0ac8`），只跳过「已经就是目标状态」，
        // 不拒绝回头路：已交付的任务被重新接取时，原版照常清空计数、重新进运行池并再发接取物品
        // （状态 1 分支只对「当前状态 2」特判成仅改状态）。记忆关卡的重复挑战依赖这条回头路。
        case 'accept': {
          if (quest.completion === 'internal' && action.source !== 'script') throw new Error('内部任务只能由剧情授予');
          if (state.status === 'active') break;
          if (state.status === 'ready') { write(quest.id, { status: 'active' }); break; }
          const goals = state.status === 'completed' ? initialProgress(quest).goals : state.goals;
          if (state.status !== 'completed' && state.status !== 'available'
            && !(quest.completion === 'internal' && action.source === 'script' && state.status === 'locked'))
            throw new Error('任务尚不可接取');
          const cycle=state.cycle+(state.status==='completed'?1:0);
          integer(cycle,0,'任务周期');
          write(quest.id, { status: 'active', goals, cycle });
          if (!runningIds.includes(quest.id)) runningIds.push(quest.id);
          for (const item of quest.onAcceptItems ?? []) grant(item.item, item.quantity);
          // 原版新建运行池条目后立即调用 IsComplete；类型 0 直接满足（findings/234）。
          if (quest.completion === 'talk') write(quest.id, { status: 'ready' });
          break;
        }
        case 'complete': if (state.status !== 'ready') throw new Error('任务目标尚未达成'); settle(quest, state); break;
        case 'script-ready': {
          if (state.status === 'ready') break;
          if (quest.completion === 'all') throw new Error('常规任务通过目标进度达成');
          // 原版状态 2 分支只在任务不在运行池时新建一条计数记录，已有的计数保持不变。
          const started = !['active', 'ready'].includes(state.status);
          const goals = started ? initialProgress(quest).goals : state.goals;
          if (started && !runningIds.includes(quest.id)) runningIds.push(quest.id);
          const cycle=state.cycle+(state.status==='completed'?1:0);
          integer(cycle,0,'任务周期');
          write(quest.id, { status: 'ready', goals, cycle }); break;
        }
        case 'script-complete':
          if (state.status === 'completed') break;
          settle(quest, state); break;
        case 'reset': integer(state.cycle + 1, 0, '任务周期');
          write(quest.id, { cycle: state.cycle + 1, status: 'locked', goals: initialProgress(quest).goals });
          removeRunning(quest.id); break;
      }
      refresh();
    }
    // 变更判断改为结构比较：只逐字段比「被写过的条目」，不做全量序列化。
    // 写成 no-op 的条目（同批先改后改回）最终与批前相等，所以这里仍会判成没变。
    const changed = !sameList(runningIds, this.runningIds) || !sameNumbers(factSequences, this.factSequences)
      || !sameStringSet(debugPins, this.debugPins)
      || [...dirty].some(id => !sameProgress(states.get(id)!, this.states.get(id)!));
    const delta = new Map([...new Set([...grants.keys(), ...removals.keys()])].map(item => [item, (grants.get(item) ?? 0) - (removals.get(item) ?? 0)]));
    const entry: PlanEntry = { states, runningIds, factSequences, debugPins, changed };
    // 计划对象浅冻即可：条目自己已冻结，`nextState` 是 getter，递归冻结会把它提前物化。
    const plan: QuestPlan = Object.freeze({ baseRevision: this.revision, changed,
      itemGrants: Object.freeze([...delta].filter(([, quantity]) => quantity > 0).map(([item, quantity]) => Object.freeze({ item, quantity }))),
      itemRemovals: Object.freeze([...delta].filter(([, quantity]) => quantity < 0).map(([item, quantity]) => Object.freeze({ item, quantity: -quantity }))),
      rewards: Object.freeze(rewards.map(reward => Object.freeze(reward))),
      get nextState(): QuestBookState {
        return entry.snapshot ??= freeze({ version: QUEST_BOOK_STATE_VERSION, quests: [...states], runningQuestIds: [...runningIds], factSequences: [...factSequences],
          ...(debugPins.size ? { debugPins: [...debugPins].sort() } : {}) });
      } });
    this.plans.set(plan, entry); return plan;
  }
  commit(plan: QuestPlan): void {
    const entry = this.plans.get(plan);
    if (!entry || plan.baseRevision !== this.revision) throw new Error('任务计划已失效');
    this.plans.delete(plan);
    if (!entry.changed) return;
    // 直接接管计划那份容器：条目不可变，所以没有「谁还会再写它」的问题，连浅拷贝都不用做。
    this.states = entry.states; this.runningIds = entry.runningIds;
    this.factSequences = entry.factSequences; this.debugPins = entry.debugPins; this.revision++;
  }
  /**
   * 派生一个**共享同一份不可变状态根**的沙盒：不克隆状态、也不跑初始 refresh。
   *
   * 两边都可以照常 `plan`/`commit`——写入是换条目而不是改条目，所以沙盒的预演不会碰到
   * 来源簿的状态。提交侧用 `adopt` 把沙盒的结果拿回去。
   */
  fork(context: () => QuestContext): QuestBook {
    return new QuestBook(this.definitionSource, context, this.sideQuests, { shareFrom: this });
  }
  /** 接管另一个（同一份任务定义）任务簿的状态根；对方此后的提交与本次接管互不影响。 */
  adopt(other: QuestBook): void {
    if (other.definitions !== this.definitions) throw new Error('任务定义不同，不能接管状态');
    this.states = other.states; this.runningIds = [...other.runningIds];
    this.factSequences = new Map(other.factSequences); this.debugPins = new Set(other.debugPins); this.revision++;
  }
  prepareRestore(input: QuestBookState): QuestRestorePlan {
    const next = structuredClone(input);
    if (next.version !== QUEST_BOOK_STATE_VERSION) throw new Error('任务快照版本不支持');
    if (new Set(next.quests.map(([id]) => id)).size !== next.quests.length) throw new Error('任务快照标识重复');
    const states = new Map(next.quests);
    for (const [id, state] of states) {
      const quest = this.definitions.get(id);
      if (!quest) throw new Error(`任务快照引用未知任务 ${id}`);
      if (!['locked', 'available', 'active', 'ready', 'completed'].includes(state.status)) throw new Error('任务快照状态无效');
      integer(state.cycle, 0, '任务周期'); integer(state.completedCycles, 0, '任务完成周期');
      for (const goal of Object.keys(state.goals)) if (!quest.goals.some(value => value.id === goal)) throw new Error(`任务快照引用未知目标 ${goal}`);
      for (const goal of quest.goals) {
        const count = state.goals[goal.id];
        if (count === undefined) throw new Error(`任务快照缺少目标 ${goal.id}`);
        integer(count, 0, '任务目标进度'); if (count > goal.quantity) throw new Error('任务目标进度超出数量');
      }
    }
    for (const [id, quest] of this.definitions) if (!states.has(id)) states.set(id, initialProgress(quest));
    if (!Array.isArray(next.runningQuestIds) || new Set(next.runningQuestIds).size !== next.runningQuestIds.length)
      throw new Error('任务运行池标识重复或结构无效');
    const running = new Set(next.runningQuestIds);
    for (const id of running) if (!states.has(id) || !['active', 'ready'].includes(states.get(id)!.status))
      throw new Error(`任务运行池引用无效：${id}`);
    for (const [id, state] of states) if (['active', 'ready'].includes(state.status) && !running.has(id))
      throw new Error(`任务运行池缺少任务：${id}`);
    if (new Set(next.factSequences.map(([source]) => source)).size !== next.factSequences.length) throw new Error('任务事实来源重复');
    for (const [source, sequence] of next.factSequences) { if (!source) throw new Error('任务事实来源为空'); integer(sequence, 1, '事实序号'); }
    const pins = next.debugPins ?? [];
    if (!Array.isArray(pins) || new Set(pins).size !== pins.length) throw new Error('任务快照调试钉住无效');
    for (const id of pins) {
      const quest = this.definitions.get(id), state = states.get(id);
      if (!quest || !state) throw new Error(`任务快照调试钉住引用未知任务 ${id}`);
      if (quest.completion !== 'all') throw new Error('任务快照调试钉住只适用于目标计数任务');
      if (!['active', 'ready'].includes(state.status)) throw new Error(`任务快照调试钉住引用未接取任务 ${id}`);
    }
    if (pins.length) next.debugPins = [...pins].sort(); else delete next.debugPins;
    next.quests = [...states];
    // `next` 已经是入参的私有克隆，`freeze` 会连它一起冻住，不必再克隆一次。
    const plan: QuestRestorePlan = freeze({ baseRevision: this.revision, nextState: next });
    this.restores.set(plan, next); return plan;
  }
  /**
   * 安装一份**由本类 `captureState()` 产出、且出自同一份任务定义**的状态。
   *
   * 预演（`Session.planStoryCommands`）与提交（`applyStoryCommands`）之间传的就是这种状态，
   * 逐任务逐目标重校验一遍只是重复劳动。**外部输入——读档、检查点、回滚——必须继续走
   * `prepareRestore`**，那里的校验是防篡改的。这里保留 O(任务数) 的「未知任务」断言，
   * 作为「同源」这条前提的最低保障。传入的状态归本对象所有，调用方不得再改它。
   */
  installTrustedState(state: QuestBookState): void {
    if (state.version !== QUEST_BOOK_STATE_VERSION) throw new Error('任务快照版本不支持');
    const states = new Map(state.quests);
    for (const id of states.keys()) if (!this.definitions.has(id)) throw new Error(`任务快照引用未知任务 ${id}`);
    for (const [id, quest] of this.definitions) if (!states.has(id)) states.set(id, initialProgress(quest));
    // 就地把条目冻上：安装进来的对象此后归本对象所有，冻结是「共享而非别名」这条不变量的闭合点。
    for (const progress of states.values()) freeze(progress);
    this.states = states; this.runningIds = [...state.runningQuestIds];
    this.factSequences = new Map(state.factSequences); this.debugPins = new Set(state.debugPins ?? []); this.revision++;
  }
  commitRestore(plan: QuestRestorePlan): void {
    const next = this.restores.get(plan);
    if (!next || plan.baseRevision !== this.revision) throw new Error('任务恢复计划已失效');
    this.restores.delete(plan);
    const states = new Map(structuredClone(next.quests));
    for (const progress of states.values()) freeze(progress);
    this.states = states; this.runningIds = [...next.runningQuestIds];
    this.factSequences = new Map(next.factSequences); this.debugPins = new Set(next.debugPins ?? []); this.revision++;
  }
  restoreState(state: QuestBookState): void { this.commitRestore(this.prepareRestore(state)); }
}

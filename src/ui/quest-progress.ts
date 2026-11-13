import type { CampaignQuest } from '../domain/campaign.ts';
import type { QuestStatus } from '../domain/content.ts';

/** 上一次通知时的任务状态；只有进行中/待交付才保留目标数字。 */
export interface QuestNoticeState {
  status: QuestStatus;
  goals?: Readonly<Record<string, number>>;
}

export interface QuestNotices {
  /** 下一次比较用的快照。 */
  snapshot: Map<string, QuestNoticeState>;
  /** 本次进入待交付的任务，已完成文案。 */
  completions: string[];
  /** 本次数字增加的目标，已拼成一条屏幕提示。 */
  progress?: string;
}

export interface QuestView {
  readonly status: QuestStatus;
  readonly goals: Readonly<Record<string, number>>;
}

const sameGoals = (a: Readonly<Record<string, number>> | undefined, b: Readonly<Record<string, number>> | undefined): boolean => {
  if (a === b) return true;
  if (!a || !b) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every(key => a[key] === b[key]);
};

/**
 * 比较两次任务簿快照，给出屏幕提示。
 *
 * 只处理 `completion: 'all'` 且进任务日志的任务；日志外任务照常计数，但不在这里提示。
 * 数字减少（卖出、用掉、重置）不提示；任务进入待交付时只发完成文案，不再发进度。
 */
/** 屏幕提示按 24px 单行估算的汉字预算：960×640 界面约放得下 32 个。 */
const PROGRESS_LINE_BUDGET = 32;
/** 单个目标标签最多保留的字数；后面还要接数量和省略号。 */
const PROGRESS_LABEL_MAX = 20;
/** 一次提示最多列出的目标数。 */
const PROGRESS_MAX_ITEMS = 3;

export function questNotices(
  previous: ReadonlyMap<string, QuestNoticeState>,
  quests: ReadonlyMap<string, QuestView>,
  definition: (id: string) => CampaignQuest | undefined,
): QuestNotices {
  const snapshot = new Map<string, QuestNoticeState>();
  const completions: string[] = [];
  const changes: string[] = [];

  for (const [id, state] of quests) {
    const quest = definition(id);
    if (!quest || quest.completion !== 'all' || quest.journal === false) continue;

    const tracked = state.status === 'active' || state.status === 'ready';
    const goals = tracked ? state.goals : undefined;
    const before = previous.get(id);
    const unchanged = before?.status === state.status && sameGoals(before.goals, goals);
    snapshot.set(id, unchanged ? before : { status: state.status, goals: goals ? { ...goals } : undefined });

    if (!before) continue;
    if (state.status === 'ready') {
      if (before.status !== 'ready') completions.push(`任务完成：${quest.title}`);
      continue;
    }
    // 新接取的任务没有上一次的计数，避免把接取瞬间背包里已有的物品当成刚捡到。
    if (state.status !== 'active' || before.status !== 'active' || !before.goals) continue;
    for (const goal of quest.goals) {
      const count = Math.min(goal.quantity, state.goals[goal.id] ?? 0);
      const old = Math.min(goal.quantity, before.goals[goal.id] ?? 0);
      if (count <= old) continue;
      const raw = goal.label ?? quest.guidance.counterLabel ?? goal.target;
      const label = raw.length > PROGRESS_LABEL_MAX ? `${raw.slice(0, PROGRESS_LABEL_MAX - 1)}…` : raw;
      changes.push(`${label} ${count}/${goal.quantity}`);
    }
  }

  if (!changes.length) return { snapshot, completions };
  // 屏幕提示是 24px 单行，960×640 界面约放得下 32 个汉字。标签先截到 20 字，
  // 保证首项连同数量和省略号也不超过预算；其余项放不下就少列。
  const prefix = '任务进度：';
  const shown: string[] = [];
  let width = prefix.length;
  for (const change of changes) {
    if (shown.length >= PROGRESS_MAX_ITEMS) break;
    const addition = change.length + (shown.length ? 1 : 0);
    if (shown.length && width + addition + 1 > PROGRESS_LINE_BUDGET) break;
    shown.push(change);
    width += addition;
  }
  return {
    snapshot,
    completions,
    progress: `${prefix}${shown.join('、')}${shown.length < changes.length ? '…' : ''}`,
  };
}

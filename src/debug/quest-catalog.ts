import type { Campaign, CampaignQuest } from '../domain/campaign.ts';
import type { QuestGroupDefinition, QuestStatus } from '../domain/content.ts';
import type { QuestProgress } from '../domain/quest-book.ts';
import { storyConditionReferences } from '../domain/story-condition.ts';

/** 任务目录里的静态任务：内容定义加上 GM 面板要显示的日志外/内部标记。 */
export interface QuestCatalogQuest {
  quest: CampaignQuest;
  /** `journal: false`：不显示在玩家的任务日志里。 */
  hidden: boolean;
  /** `completion: 'internal'`：只由剧情脚本推进。 */
  internal: boolean;
}

/** 一组任务的静态顺序和支线解锁锚点，按 `campaign` 对象构建一次后复用。 */
export interface QuestCatalogIndexGroup {
  definition: QuestGroupDefinition;
  kind: QuestGroupDefinition['kind'];
  quests: readonly QuestCatalogQuest[];
  /** 支线组：`availableWhen` 引用的剧情位置最靠后的主线组标题。 */
  anchorMainGroupTitle?: string;
}

/** 内容派生的任务目录索引：组顺序、组内顺序和支线锚点都已完成。 */
export interface QuestCatalogIndex {
  groups: readonly QuestCatalogIndexGroup[];
}

/** 当前状态投影后的一行任务。 */
export interface QuestCatalogEntry {
  quest: CampaignQuest;
  progress: Readonly<QuestProgress>;
  status: QuestStatus;
  hidden: boolean;
  internal: boolean;
}

/** 一组任务的状态计数，供 GM 面板显示「已完成数/总数」和标签。 */
export interface QuestCatalogSummary {
  total: number;
  journalVisible: number;
  hidden: number;
  available: number;
  active: number;
  ready: number;
  completed: number;
}

/** 当前状态投影后的任务组。 */
export interface QuestCatalogGroup {
  definition: QuestGroupDefinition;
  kind: QuestGroupDefinition['kind'];
  entries: QuestCatalogEntry[];
  summary: QuestCatalogSummary;
  /** 组内任意任务待交付。 */
  ready: boolean;
  /** 组内任意任务进行中或待交付。 */
  current: boolean;
  /** 支线组解锁时参考的主线组标题；没有主线引用时为空。 */
  anchorMainGroupTitle?: string;
}

interface OrderedGroup {
  definition: QuestGroupDefinition;
  kind: QuestGroupDefinition['kind'];
  quests: QuestCatalogQuest[];
  storyPosition: number;
  sourcePosition: number;
  anchorMainGroupTitle?: string;
}

/**
 * 构建全量任务目录：包含所有任务组和任务，不按主线/支线分栏，也不隐藏日志外任务。
 * 组顺序取 `questIds[0]` 在 `campaign.quests` 里的位置，也就是故事顺序；同位置时保持原数组顺序。
 */
export function buildQuestCatalog(campaign: Campaign): QuestCatalogIndex {
  const quests = new Map(campaign.quests.map(quest => [quest.id, quest]));
  const questPosition = new Map(campaign.quests.map((quest, position) => [quest.id, position]));
  const groupByQuestId = new Map<string, QuestGroupDefinition>();
  for (const group of campaign.questGroups) {
    for (const questId of group.questIds) groupByQuestId.set(questId, group);
  }

  const ordered: OrderedGroup[] = campaign.questGroups.map((definition, sourcePosition) => ({
    definition,
    kind: definition.kind,
    quests: definition.questIds.flatMap(questId => {
      const quest = quests.get(questId);
      return quest
        ? [{ quest, hidden: quest.journal === false, internal: quest.completion === 'internal' }]
        : [];
    }),
    storyPosition: questPosition.get(definition.questIds[0]) ?? Number.MAX_SAFE_INTEGER,
    sourcePosition,
  }));

  for (const group of ordered) {
    if (group.kind === 'side') {
      group.anchorMainGroupTitle = sideGroupAnchorTitle(group, questPosition, groupByQuestId);
    }
  }

  ordered.sort((left, right) =>
    left.storyPosition - right.storyPosition || left.sourcePosition - right.sourcePosition);

  // 没有直接可用主线引用的支线，归到它前面最近的主线组，避免出现没有进度归属的支线。
  let previousMainTitle: string | undefined;
  for (const group of ordered) {
    if (group.kind === 'main') previousMainTitle = group.definition.title;
    else if (!group.anchorMainGroupTitle) group.anchorMainGroupTitle = previousMainTitle;
  }

  return {
    groups: ordered.map(group => ({
      definition: group.definition,
      kind: group.kind,
      quests: group.quests,
      anchorMainGroupTitle: group.anchorMainGroupTitle,
    })),
  };
}

/**
 * 把当前任务状态套到静态目录上。组顺序、组内顺序和支线锚点都直接复用索引，不重新计算内容顺序。
 */
export function projectQuestCatalog(
  index: QuestCatalogIndex,
  quests: ReadonlyMap<string, QuestProgress>,
): QuestCatalogGroup[] {
  return index.groups.map(group => {
    const entries = group.quests.map((staticQuest): QuestCatalogEntry => {
      const progress = quests.get(staticQuest.quest.id) ?? lockedProgress(staticQuest.quest);
      return {
        quest: staticQuest.quest,
        progress,
        status: progress.status,
        hidden: staticQuest.hidden,
        internal: staticQuest.internal,
      };
    });
    const summary = summarize(entries);
    return {
      definition: group.definition,
      kind: group.kind,
      entries,
      summary,
      ready: summary.ready > 0,
      current: summary.active > 0 || summary.ready > 0,
      anchorMainGroupTitle: group.anchorMainGroupTitle,
    };
  });
}

/**
 * 支线的「解锁于」锚点：在所有组内任务的 `availableWhen` 引用里，取故事位置最靠后的跨组主线任务，
 * 显示它所属的主线组标题。没有引用主线组时返回 `undefined`。
 */
function sideGroupAnchorTitle(
  group: OrderedGroup,
  questPosition: ReadonlyMap<string, number>,
  groupByQuestId: ReadonlyMap<string, QuestGroupDefinition>,
): string | undefined {
  const ownQuestIds = new Set(group.definition.questIds);
  let anchor: { position: number; title: string } | undefined;
  for (const { quest } of group.quests) {
    for (const referencedId of storyConditionReferences(quest.availableWhen).quests) {
      if (ownQuestIds.has(referencedId)) continue;
      const referencedGroup = groupByQuestId.get(referencedId);
      const position = questPosition.get(referencedId);
      if (!referencedGroup || referencedGroup.kind !== 'main' || position === undefined) continue;
      if (!anchor || position > anchor.position) {
        anchor = { position, title: referencedGroup.title };
      }
    }
  }
  return anchor?.title;
}

/** 任务状态表里没有这个任务时，按未解锁显示，避免调试页漏掉内容。 */
function lockedProgress(quest: CampaignQuest): QuestProgress {
  return {
    status: 'locked',
    cycle: 0,
    completedCycles: 0,
    goals: Object.fromEntries(quest.goals.map(goal => [goal.id, 0])),
  };
}

function summarize(entries: readonly QuestCatalogEntry[]): QuestCatalogSummary {
  const summary: QuestCatalogSummary = {
    total: entries.length,
    journalVisible: 0,
    hidden: 0,
    available: 0,
    active: 0,
    ready: 0,
    completed: 0,
  };
  for (const entry of entries) {
    if (!entry.hidden && !entry.internal) summary.journalVisible++;
    if (entry.hidden) summary.hidden++;
    switch (entry.status) {
      case 'locked': break;
      case 'available': summary.available++; break;
      case 'active': summary.active++; break;
      case 'ready': summary.ready++; break;
      case 'completed': summary.completed++; break;
    }
  }
  return summary;
}

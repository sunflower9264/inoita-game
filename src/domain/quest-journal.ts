import type { QuestGroupDefinition } from './content.ts';
import type { Campaign, CampaignQuest } from './campaign.ts';
import { ACCEPTED_QUEST_STATUSES, questIsVisible, type QuestProgress } from './quest-book.ts';

interface QuestJournalEntry {
  quest: CampaignQuest;
  state: Readonly<QuestProgress>;
}

interface QuestJournalGroup {
  definition: QuestGroupDefinition;
  ready: boolean;
  entries: QuestJournalEntry[];
}

/**
 * 运行中的任务组保留同组已交付的步骤，整组离开运行池后不再显示。
 * `focus` 是 GM 任务调试的焦点：只显示这一条任务，不管它所在组是否还有其他进展，
 * 也覆盖隐藏/内部任务规则——现场表可能停在开幕演出之前，此时任务还是「可接取」，
 * 任务日志仍要显示它，演出接取后自然变成进行中。
 */
export function questJournal(campaign: Campaign, states: ReadonlyMap<string, Readonly<QuestProgress>>,
  focus?: string): QuestJournalGroup[] {
  const definitions = new Map(campaign.quests.map(quest => [quest.id, quest]));
  const progression = new Map(campaign.quests.map((quest, index) => [quest.id, index]));
  const groupIndex = (definition: QuestGroupDefinition): number =>
    Math.min(...definition.questIds.map(id => progression.get(id) ?? Number.MAX_SAFE_INTEGER));
  return campaign.questGroups.flatMap(definition => {
    const entries = definition.questIds.flatMap(id => {
      const state = states.get(id), quest = definitions.get(id);
      if (!quest || !state) return [];
      if (focus) return id === focus && state.status !== 'locked' ? [{ quest, state }] : [];
      return questIsVisible(quest) && ACCEPTED_QUEST_STATUSES.includes(state.status) ? [{ quest, state }] : [];
    }).reverse();
    if (!entries.length) return [];
    if (!focus && !entries.some(entry => entry.state.status === 'active' || entry.state.status === 'ready')) return [];
    return [{ definition, entries, ready: entries.some(entry => entry.state.status === 'ready') }];
  }).sort((a, b) => {
    const byKind = Number(b.definition.kind === 'main') - Number(a.definition.kind === 'main');
    return byKind || groupIndex(a.definition) - groupIndex(b.definition);
  });
}

/** 完成段锁定为灰色；进行中的目标使用当前玩法状态，不改任务结算。 */
export function questJournalText(group: QuestJournalGroup, actorName: (id: string) => string): string {
  return group.entries.map(({ quest, state }) => {
    if (state.status === 'completed') return `&C$G[完成]&N${quest.description}&C`;
    if(quest.completion==='talk') {
      const targets=quest.descriptionTargets?.map(target=>target.label??actorName(target.target));
      const delivery=quest.delivery??quest.giver;
      const description=targets?.length?targets.join('、'):delivery?actorName(delivery):undefined;
      return `${quest.description}${state.status==='ready'?'$S':'$R'}&N${description?`与${description}进行对话`:quest.guidance.active}$B`;
    }
    if(!quest.goals.length)return `${quest.description}${state.status==='ready'?'$S':'$R'}&N${quest.guidance.active}$B`;
    const progress=quest.goals.map(goal=>{
      const count=Math.min(state.goals[goal.id]??0,goal.quantity),complete=count>=goal.quantity;
      const label=goal.label??quest.guidance.counterLabel??(goal.kind==='talk'?actorName(goal.target):goal.target);
      return `${complete?'$S':'$R'}&N${label}: ${count}/${goal.quantity}$B`;
    }).join('');
    return quest.description+progress;
  }).join('&N$G-----------------------------------------$B&N');
}

import type { StoryCommand } from '../domain/story-graph.ts';
import type { Campaign } from '../domain/campaign.ts';

/**
 * 任务道具「发多少」与「要多少」的对照。
 *
 * 一条任务的交付需求是固定的（`handoverItems` 每项写清数量）。道具的来路有两处：
 * 接取时的 `onAcceptItems`，以及剧情脚本里的 `item-give` 命令。两边加起来超过需求，
 * 交完就会剩下一件：任务类道具既不能丢也不能卖，会一直占着背包格。
 *
 * 原版对完成条件为物品的任务（类型 2）在接取时会把「完成列表」里的物品也发一遍，
 * 于是剧情已经发过的那一件就重复了；同一件道具同时出现在 PREPARE 与 COMPLETE 两张表里时
 * 也会发两份。这些是原版自己也带着的毛病，这里不复刻。
 */
interface GrantAmount { item: string; quantity: number }
/** 只需要任务与剧情脚本里跟发放有关的那几个字段，测试可以喂最小对象进来。 */
export interface QuestGrantSource {
  quests: readonly { id: string; onAcceptItems?: readonly GrantAmount[]; handoverItems?: readonly GrantAmount[] }[];
  scripts: Readonly<Record<string, { nodes: readonly { commands: readonly StoryCommand[] }[] }>>;
}

export interface QuestItemOverflow {
  quest: string;
  item: string;
  /** 接取发放 + 剧情发放。 */
  granted: number;
  /** 交付需求。 */
  required: number;
}

/**
 * 剧情脚本里每种物品的净发放量（给出减去收回），按物品标识累计。
 * 递交演出常见「先给一件再收回一件」，净额是 0，不算发过。
 */
export function storyItemNetGrants(campaign: QuestGrantSource): Map<string, number> {
  const grants = new Map<string, number>();
  for (const script of Object.values(campaign.scripts))
    for (const node of script.nodes)
      for (const command of node.commands)
        if (command.type === 'item-give' || command.type === 'item-take')
          grants.set(command.item, (grants.get(command.item) ?? 0)
            + (command.type === 'item-give' ? command.quantity : -command.quantity));
  return grants;
}

/** 列出所有「发放量超过交付需求」的任务道具。 */
export function questItemOverflows(campaign: QuestGrantSource): QuestItemOverflow[] {
  const story = storyItemNetGrants(campaign);
  const overflows: QuestItemOverflow[] = [];
  for (const quest of campaign.quests) {
    for (const handover of quest.handoverItems ?? []) {
      const accepted = (quest.onAcceptItems ?? [])
        .filter(record => record.item === handover.item)
        .reduce((total, record) => total + record.quantity, 0);
      const granted = accepted + Math.max(0, story.get(handover.item) ?? 0);
      if (granted > handover.quantity)
        overflows.push({ quest: quest.id, item: handover.item, granted, required: handover.quantity });
    }
  }
  return overflows;
}

/** 类型层面的自检：真实的战役内容必须能直接喂进来。 */
export type CampaignIsQuestGrantSource = Campaign extends QuestGrantSource ? true : never;

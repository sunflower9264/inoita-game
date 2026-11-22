import type { EntityPlacement, Facing, QuestGuidance, QuestGroupDefinition, StartPlacement, CampaignEnemyPlacement } from './content.ts';
import type { QuestRules } from './quest-book.ts';
import type { StoryGraph } from './story-graph.ts';
import type { StoryCondition } from './story-condition.ts';

/** 任务的接取方式：走到发布者面前自动接取，或等玩家确认。 */
type QuestAcceptance = 'automatic' | 'optional';

/** 剧情出口规则：条件成立时开放某张图的出口。 */
interface ExitRule { id:string; map:string; condition:StoryCondition }

export interface CampaignQuest extends QuestRules {
  title:string;
  description:string;
  /** 详情中说明的对话对象，不参与完成计数。 */
  descriptionTargets?:{target:string;characterId?:string;label?:string}[];
  giver?:string;
  giverCharacterId?:string;
  /** 原版 NPC 菜单字段指定的交付对象，缺省为 giver。 */
  delivery?:string;
  deliveryCharacterId?:string;
  /** 可接取／进行中／待交付各自的地点；由导出层按原版证据填，缺的阶段就是没证据。 */
  places?:import('./story-graph.ts').QuestPlaces;
  targetChanges?:{goal:string;enemyId:string;actor:string;removeAfterInteraction:boolean;changedText:string;interactText:string}[];
  guidance:QuestGuidance;
  acceptance?:QuestAcceptance;
  offerScript?:string|null;
  completeScript?:string|null;
  progressText:string;
  completeText:string;
}
export interface CampaignPlacement extends EntityPlacement {
  map:string;
  facing?:Facing;
  /** 必填：常显写成 `{type:'always',value:true}`，漏写会在校验阶段报错，不再静默变成常显。 */
  condition:StoryCondition;
}
export interface Campaign extends StoryGraph {
  contentVersion:number;
  start:StartPlacement;
  quests:CampaignQuest[];
  questGroups:QuestGroupDefinition[];
  placements:CampaignPlacement[];
  /** 条件在本次进图时采样；已出现的角色保留到离开这张地图。 */
  mapEntryPlacements?:CampaignPlacement[];
  enemyPlacements?:CampaignEnemyPlacement[];
  exitRules?:ExitRule[];
}

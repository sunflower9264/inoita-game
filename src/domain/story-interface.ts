export const MINIMAP_ASSETS = ['minimap-edge-horizontal', 'minimap-edge-vertical',
  'minimap-corner-nw', 'minimap-corner-ne', 'minimap-corner-sw', 'minimap-corner-se',
  'minimap-player', 'minimap-exit', 'minimap-available', 'minimap-active', 'minimap-ready',
  'minimap-special', 'minimap-interact'] as const;

export interface StoryPlayerState {
  level: number;
  health: number;
  maxHealth: number;
  mana: number;
  maxMana: number;
  experience: number;
  nextLevelExperience: number;
}

export const ITEM_CATEGORIES = ['equipment', 'consumable', 'material', 'quest'] as const;
export type ItemCategory = typeof ITEM_CATEGORIES[number];

export interface StoryItem {
  name: string;
  description: string;
  category: ItemCategory;
  icon: string;
}

/** 故事界面使用的原版触屏素材及初始人物状态。 */
export interface StoryInterface {
  assets: Record<string, string>;
  portraits: Record<string, string>;
  player: StoryPlayerState;
}

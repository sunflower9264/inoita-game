import type { EffectClip } from './content.ts';
import type { StoryItem } from './story-interface.ts';
import type { ItemNotice } from './item-application.ts';
import type { ItemNumbers } from './character-stats.ts';
import type { DescriptionTextPart } from './description-text.ts';

export const EQUIPMENT_SLOTS = ['head', 'hands', 'back', 'body', 'feet', 'main-hand', 'off-hand', 'neck', 'ring', 'accessory'] as const;
export type EquipmentSlot = typeof EQUIPMENT_SLOTS[number];
/**
 * 装备槽在界面上的次序。原版按表 `0xbbad6` 把界面位置映射到装备编号
 * `[0,7,8,9,3,2,5,6,1,4]`，所以界面次序不是装备编号次序——首行是头/项链/戒指/饰品，
 * 第二行是身体/披风，第三行是主手/副手，末行是手部/脚部。这里直接用槽位名表达，
 * `content/menu-panels.json` 的 `equipmentSlots` 必须与之同序。
 */
export const EQUIPMENT_SLOT_ORDER: readonly EquipmentSlot[] =
  ['head','neck','ring','accessory','body','back','main-hand','off-hand','hands','feet'];
export const ITEM_USES = ['recover-health', 'consume', 'enchant', 'socket', 'purify', 'pack', 'box', 'unseal', 'learn', 'regenerate',
  'reset-skills', 'recruit', 'merchant', 'revive', 'recipe', 'dungeon'] as const;
export type ItemUseKind = typeof ITEM_USES[number];
export interface ItemReward { item: string; quantity: number }
export interface GroundItemSprite {
  file: string;
  width: number;
  height: number;
  anchorX: number;
  anchorY: number;
}
/**
 * 一次性回复。原版 `ITEMRECOVERBASE` 的标志位 bit3 把两种算法分开：
 * `amount` 在区间内随机一次、全队同一数值（四档治疗药水）；`rate` 各按自己的上限算比例
 * （元气恢复药水是 100%，同时回魔法）。
 */
export type ItemRecovery =
  | { mode:'amount'; minHealth:number; maxHealth:number; restoresMana:boolean; cooldownMs:number }
  | { mode:'rate'; ratePercent:number; restoresMana:boolean; cooldownMs:number };

/**
 * 持续回复：时限内每次资源回复脉冲额外恢复的点数。
 * 数值来自原版 `ITEMBUFFBASE` → `BUFFDATABASE` → `BUFFUNITBASE` 两级查表。
 */
export interface ItemRegeneration { durationMs:number; healthRecoveryPerPulse:number; manaRecoveryPerPulse:number }

interface ItemUse {
  kind: ItemUseKind;
  recovery?: ItemRecovery;
  regenerate?: ItemRegeneration;
  rewards?: ItemReward[];
  classId?: string;
  elite?: boolean;
  recipes?: string[];
  target?: 'weapon' | 'armor';
  maxLevel?: number;
  requiresEnhanced?: boolean;
}
export interface ManaPickup {
  kind: 'party-mana';
  percentOfCollectorMaxMana:number;
  hitDrop:{rollMaximum:number;skillThreshold:number;weaponThresholds:Record<string,number>;jitterPx:number;
    directions:{name:string;x:number;y:number;clip:EffectClip}[]};
}
export interface ItemDefinition extends StoryItem {
  descriptionParts?: DescriptionTextPart[];
  pickup?:ManaPickup;
  groundSprite: GroundItemSprite;
  kind: string;
  typeName: string;
  stackable: boolean;
  discardable: boolean;
  sellable?: boolean;
  priceKind?: 'weapon' | 'armor' | 'accessory' | 'fixed';
  pricePremium?: boolean;
  shortcut: boolean;
  level: number;
  /** Original fixed coin price; equipment derives its value from its rolled attributes. */
  basePrice: number;
  storeListed: boolean;
  equipment?: {
    slot: EquipmentSlot;
    classes: string[];
    twoHanded: boolean;
    dualWield: boolean;
    locked: boolean;
    socketCapacity: number;
    enchantable: boolean;
    description?: { showEnhancementUses: boolean; attackSpeed?: string; classAttributes: DescriptionTextPart[] };
  };
  use?: ItemUse;
}
export interface ItemRecipe {
  name: string;
  result: string;
  materials: ItemReward[];
  cost: number;
  /** 配方书配方只有学会后才出现在融合器列表里。 */
  book: boolean;
}
export interface ItemCatalog {
  items: Record<string, ItemDefinition>;
  startingEquipment: Record<string, Partial<Record<EquipmentSlot, string>>>;
  startingInventory: ItemReward[];
  startingShortcut: string;
  dualWieldClasses: string[];
  merchantItems: string[];
  classSkills: Record<string,string[]>;
  skillDescriptions?: Record<string,{name:string;className:string}>;
  recipes: Record<string,ItemRecipe>;
}
export interface ItemInstance {
  numbers?: ItemNumbers;
  id: string;
  item: string;
  quantity: number;
  enhancement: number;
  gems: string[];
  skill?: string;
}
export type Equipment = Partial<Record<EquipmentSlot, string>>;
export interface ItemResult {
  notice?: ItemNotice;
  kind: ItemUseKind | 'discard';
  title: string;
  message: string;
  rewards: ItemReward[];
  target?: string;
  classId?: string;
  skill?: string;
  recipe?: string;
  item?: string;
}

export const USE_LABELS: Record<ItemUseKind, string> = {
  'recover-health': '使用',
  consume: '使用', enchant: '强化', socket: '镶嵌', purify: '净化', pack: '打开礼盒', box: '打开宝箱', unseal: '解除封印',
  learn: '使用技能书', regenerate: '使用', 'reset-skills': '初始化技能',
  recruit: '使用徽章', merchant: '召唤神灯商人', revive: '复活', recipe: '打开合成套装', dungeon: '使用符文'
};

/**
 * 卓越灵药。它是唯一按物品 id 认领的可用物品：`kind` 是导出器的兜底值 `consume`，
 * 效果「获得 1 个技能点」实现在 `story-skills.applyItem`。使用限制、说明面板和技能进度
 * 都引用这个名字，不再各写一份字符串。
 */
export const SKILL_POINT_ITEM = 'supreme-elixir';

/**
 * `consume` 是导出器的兜底 kind：原版标了「可用」，但凡用途还没逆出来的都落到它
 * （见 `work/tools/game_content/items.py`）。下面这些是真的实现了用途的，其余一律判为未实现。
 */
export const IMPLEMENTED_CONSUMABLES: readonly string[] = [SKILL_POINT_ITEM];

/** 用途还没逆出来的物品被拒时给玩家看的话。界面与 `Bag.use` 用同一句。 */
export const USE_NOT_IMPLEMENTED = '此物品的用途尚未实现，暂不能使用';
/** 回血、招募、复活由队伍界面的专门入口结算，背包的直接使用不该受理。 */
export const USE_INTERFACE_ONLY = '此物品要在队伍或商店界面中使用';

/**
 * `Bag.use` 遇到每种用途该怎么办。
 *
 * 这张表是「漏接一种 kind」的编译期保证：新增 `ItemUseKind` 时不在下面补一行，
 * `Record` 的穷尽性就会让编译失败。在补上这道保证之前，漏接的后果是物品被静默销毁——
 * `Bag.use` 走到最后无条件 `consume(id)`，玩家点「使用」，看到「已使用XX」，
 * 东西没了、效果没有。
 *
 * `bag.ts` 里的 `switch` 另有 `never` 兜底，两处都必须补全才会通过编译。
 */
export const USE_HANDLING: Record<ItemUseKind, 'bag' | 'ui' | 'pending'> = {
  'recover-health': 'ui',
  // 与回血药水同一条队伍结算路径：都是对全队生效的消耗品。
  regenerate: 'ui',
  recruit: 'ui', revive: 'ui',
  // 消耗由 `Bag.use` 完成，界面在它返回后接着开商店，所以不算界面层独有。
  merchant: 'bag',
  // 兜底 kind，另有一层物品级把关：只有 IMPLEMENTED_CONSUMABLES 里的能过。
  consume: 'bag',
  dungeon: 'pending',
  enchant: 'bag', socket: 'bag', purify: 'bag', pack: 'bag', box: 'bag', unseal: 'bag',
  recipe: 'bag', learn: 'bag', 'reset-skills': 'bag',
};

/**
 * 这件物品的用途还没实现？是就给出原因，不是返回 undefined。
 *
 * 背包界面拿它禁用「使用」，`Bag.use` 拿它拒绝，判断只有这一份。
 * 「由界面层结算」不算在这一类里——回血、招募、复活是**能用**的，
 * 只是入口在队伍界面，`Bag.use` 另按 `USE_HANDLING` 拒绝。
 */
export function unimplementedItemUse(itemId: string, definition: ItemDefinition): string | undefined {
  const use = definition.use;
  if (!use) return undefined;
  if (USE_HANDLING[use.kind] === 'pending') return USE_NOT_IMPLEMENTED;
  if (use.kind === 'consume' && !IMPLEMENTED_CONSUMABLES.includes(itemId)) return USE_NOT_IMPLEMENTED;
  return undefined;
}

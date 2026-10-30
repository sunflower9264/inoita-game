import type { ChaosTier } from '../domain/chaos-equipment.ts';
import type { EquipmentNumbers, ItemNumbers } from '../domain/character-stats.ts';
/** 原版像素颜色按低字节 R、G、B 存储；稀有度 0 使用控件基础色。 */
const RARITY_COLORS = ['#4eff00', '#00b4ff', '#ffe600', '#9c00ff'];
/** 实例没掷品级时，原版按品级 2（蓝色）取色。 */
const DEFAULT_GRADE = 2;
/** 品质色对应的格子边框图，键见 `public/content/menu-panels.json` 的 assets。 */
const SLOT_FRAMES: Record<string, string> = {
  '#4eff00': 'inventory-slot-rarity-1',
  '#00b4ff': 'inventory-slot-rarity-2',
  '#ffe600': 'inventory-slot-rarity-3',
  '#9c00ff': 'inventory-slot-rarity-4',
  '#0000ff': 'inventory-slot-chaos',
  '#ff6c00': 'inventory-slot-epic-chaos'
};

export function itemNameColor(rarity: number | undefined, chaosTier?: ChaosTier): string | undefined {
  if (chaosTier === 'chaos') return '#0000ff';
  if (chaosTier === 'epic-chaos') return '#ff6c00';
  return rarity === undefined ? undefined : RARITY_COLORS[rarity - 1];
}

/** 装备品级：实例掷出的优先，其次模板默认品级，最后是原版默认的 2。 */
export function equipmentGrade(numbers: ItemNumbers | undefined, definition: EquipmentNumbers | undefined): number {
  return numbers?.grade ?? definition?.defaultGrade ?? DEFAULT_GRADE;
}

/** 装备品质色：格子边框与说明标题共用这一套取色口径。 */
export function equipmentColor(numbers: ItemNumbers | undefined, definition: EquipmentNumbers | undefined,
  grades: readonly { rarity: number }[] | undefined): string | undefined {
  return itemNameColor(grades?.[equipmentGrade(numbers, definition)]?.rarity, numbers?.chaos?.tier);
}

/** 装备格子的边框图；非装备返回 undefined，调用方沿用默认格子图。 */
export function equipmentSlotFrame(item: { equipment?: unknown } | undefined, numbers: ItemNumbers | undefined,
  definition: EquipmentNumbers | undefined, grades: readonly { rarity: number }[] | undefined): string | undefined {
  if (!item?.equipment) return undefined;
  const color = equipmentColor(numbers, definition, grades);
  return color === undefined ? undefined : SLOT_FRAMES[color];
}

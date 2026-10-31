import type { ChaosTier } from '../domain/chaos-equipment.ts';
import type { EquipmentNumbers, ItemNumbers } from '../domain/character-stats.ts';
interface QualityStyle {
  /** 品级 1–4；混沌档位没有品级。 */
  rarity?: number;
  /** 混沌档位；普通品质没有。 */
  chaosTier?: ChaosTier;
  color: string;
  frame: string;
}

/**
 * 品级与混沌档位共用一张取色表：每项同时给出说明文字颜色和格子边框图。
 * 原版像素颜色按低字节 R、G、B 存储；稀有度 0 使用控件基础色。
 * 边框图键见 `public/content/menu-panels.json` 的 assets。
 */
const QUALITY_STYLES: readonly QualityStyle[] = [
  { rarity: 1, color: '#4eff00', frame: 'inventory-slot-rarity-1' },
  { rarity: 2, color: '#00b4ff', frame: 'inventory-slot-rarity-2' },
  { rarity: 3, color: '#ffe600', frame: 'inventory-slot-rarity-3' },
  { rarity: 4, color: '#9c00ff', frame: 'inventory-slot-rarity-4' },
  { chaosTier: 'chaos', color: '#0000ff', frame: 'inventory-slot-chaos' },
  { chaosTier: 'epic-chaos', color: '#ff6c00', frame: 'inventory-slot-epic-chaos' }
];
/** 实例没掷品级时，原版按品级 2（蓝色）取色。 */
const DEFAULT_GRADE = 2;

export function itemNameColor(rarity: number | undefined, chaosTier?: ChaosTier): string | undefined {
  if (chaosTier) return QUALITY_STYLES.find(style => style.chaosTier === chaosTier)?.color;
  return rarity === undefined ? undefined : QUALITY_STYLES.find(style => style.rarity === rarity)?.color;
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
  return color === undefined ? undefined : QUALITY_STYLES.find(style => style.color === color)?.frame;
}

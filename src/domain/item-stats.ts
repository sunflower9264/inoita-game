import type { EquipmentChaos } from './chaos-equipment.ts';

export const PRIMARY_STATS = ['strength', 'dexterity', 'vitality', 'intelligence', 'mentality'] as const;
/** 装备没有写默认品级时使用的档位。 */
export const DEFAULT_EQUIPMENT_GRADE = 2;
export type PrimaryStat = typeof PRIMARY_STATS[number];
export type PrimaryAttributes = Record<PrimaryStat, number>;

/** 把按 PRIMARY_STATS 逐项算出的结果收回成固定字段的属性对象。 */
export function primaryAttributesFrom(source: Readonly<Record<string, number>>): PrimaryAttributes {
  return {
    strength: source.strength,
    dexterity: source.dexterity,
    vitality: source.vitality,
    intelligence: source.intelligence,
    mentality: source.mentality,
  };
}

export interface Modifier { stat: string; value: number }
export interface ModifierRange { stat: string; min: number; max: number }
/** `bonusChance` 是「再升一级」判定阈值的加成，只有特级卷轴有（原版 `+0x12c`）。 */
export interface EnhancementRule { step: number; threshold: number; extra: number; bonusChance?: number }
export interface EquipmentGradeSeed {
  grade: number; gradeName: string; attack: number; defense: number; optionCount: number; socketLimit: number;
}

export interface ItemNumbers {
  baseAttack?: number; baseDefense?: number; gradeName?: string; grade?: number;
  modifiers: Modifier[]; gemModifiers: Modifier[]; magicPercent: number;
  sockets: number; enhancementUses: number; enhancementRule?: EnhancementRule; enhancementScroll?: string;
  chaos?: EquipmentChaos;
}

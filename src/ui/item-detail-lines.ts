import { equipmentLevel } from '../domain/chaos-equipment.ts';
import { enhancementBonus, equipmentPower, type CharacterStatsCatalog, type EquipmentNumbers, type Modifier } from '../domain/character-stats.ts';
import type { ItemDefinition, ItemInstance } from '../domain/items.ts';
import type { ShopCatalog } from '../domain/shop.ts';
import type { DescriptionTextPart } from '../domain/description-text.ts';
import { equipmentColor, equipmentGrade } from './item-name-color.ts';
import { TEXT_COLORS } from './text-style.ts';

/** 物品说明按词条来源取色，保留原版 UIDesc_AddOption 的配色。 */
const GEM_MODIFIER_COLOR = TEXT_COLORS.gemModifier;
const EQUIPMENT_MODIFIER_COLOR = '#7878ff';
const DESCRIPTION_COLOR = '#00b4ff';

export type ItemDescriptionRow = { parts: DescriptionTextPart[] };
interface ItemDescriptionBody {
  title: string;
  color?: string;
  rows: ItemDescriptionRow[];
}

/** 原版 UIDesc_AddOption 按词条来源选色，并使用原有的冒号及十分之一百分比。 */
function equipmentAttributeLines(catalog: CharacterStatsCatalog, entry: ItemInstance,
  standaloneGem = false, gemNames?: (string | undefined)[]): DescriptionTextPart[] {
  const result: DescriptionTextPart[] = [];
  const add = (modifiers: Modifier[], color: string) => {
    for (const modifier of modifiers) {
      const descriptor = catalog.modifiers[modifier.stat];
      const value = descriptor.percent ? `${(modifier.value / 10).toFixed(1)}%` : String(modifier.value);
      if (result.length) result.push({text:'\n'});
      result.push({text:`${descriptor.label}: ${value}`, color});
    }
  };
  if (standaloneGem) {
    add(entry.numbers?.modifiers ?? [], GEM_MODIFIER_COLOR);
    return result;
  }
  add(entry.numbers?.modifiers ?? [], EQUIPMENT_MODIFIER_COLOR);
  const gems = entry.numbers?.gemModifiers ?? [];
  if ((entry.gems?.length ?? 0) !== gems.length) {
    if (result.length) result.push({text:'\n'});
    result.push({text:'宝石数据不完整', color:TEXT_COLORS.danger});
    return result;
  }
  if (!gems.length) return result;
  if (result.length) result.push({text:'\n'});
  result.push({text:'镶嵌效果', color:TEXT_COLORS.white});
  gems.forEach((modifier, index) => {
    const descriptor = catalog.modifiers[modifier.stat];
    const value = descriptor.percent ? `${(modifier.value / 10).toFixed(1)}%` : String(modifier.value);
    const signed = modifier.value > 0 ? `+${value}` : value;
    const name = gemNames?.[index];
    result.push({text:'\n'});
    result.push({text:`${name ? `${name}：` : ''}${descriptor.label} ${signed}`, color:GEM_MODIFIER_COLOR});
  });
  return result;
}

/** 商品、背包物品和穿戴装备使用相同的实例、成员条件及原版说明顺序。 */
export function itemDescriptionBody(options: {
  item: ItemDefinition;
  entry: ItemInstance;
  numbers: EquipmentNumbers | undefined;
  catalog: CharacterStatsCatalog;
  grades: ShopCatalog['grades'];
  member?: { classId: string; level: number };
  /** 职业 id → 显示名；提供时在详情里列出适用职业。 */
  classNames?: Record<string, string>;
  /** 与 `entry.gems` 同序的宝石显示名；没有时只显示词条。 */
  gemNames?: (string | undefined)[];
  skill?: { name: string; className: string };
  concealed?: boolean;
}): ItemDescriptionBody {
  const {item, entry, numbers, catalog, grades, member, classNames, gemNames, skill} = options;
  if (options.concealed) return {title:`${item.typeName}（未鉴定）`, color:TEXT_COLORS.muted, rows:[]};
  const equipment = item.equipment, grade = equipmentGrade(entry.numbers, numbers);
  const prefix = equipment && grade !== 2 ? item.priceKind === 'weapon' ? grades[grade]?.name : grades[grade]?.armorName ?? grades[grade]?.name : '';
  const title = `${prefix ? prefix + ' ' : ''}${item.name}${equipment && entry.enhancement ? '+' + entry.enhancement : ''}`;
  const color = equipment ? equipmentColor(entry.numbers, numbers, grades) : undefined;
  const parts: DescriptionTextPart[] = [];
  if (equipment) {
    parts.push({text:item.typeName, color:member && !equipment.classes.includes(member.classId) ? TEXT_COLORS.requirementUnmet : TEXT_COLORS.white},
      {text:'\n等级 '}, {text:String(equipmentLevel(item,entry)), color:member && member.level < equipmentLevel(item,entry) ? TEXT_COLORS.requirementUnmet : TEXT_COLORS.white});
    if (classNames) {
      const all = Object.keys(classNames);
      const universal = all.length > 0 && equipment.classes.length === all.length
        && all.every(id => equipment.classes.includes(id));
      parts.push({text:`\n适合职业：${universal ? '全部职业' : equipment.classes.map(id => classNames[id] ?? id).join('、')}`});
    }
    if (equipment.description?.showEnhancementUses ?? (item.priceKind === 'weapon' || item.priceKind === 'armor'))
      parts.push({text:`\n强化耐久度 ${entry.numbers?.enhancementUses ?? 0}`});
    parts.push({text:`\n宝石孔数量 ${entry.numbers?.sockets ?? 0}`});
    if (equipment.description?.attackSpeed) parts.push({text:`\n${equipment.description.attackSpeed}`});
    if (numbers) {
      const power = equipmentPower(numbers, entry);
      if (item.priceKind === 'weapon') parts.push({text:`\n\n物理攻击 ${power.attack}\n魔法攻击 ${power.magicAttack}`});
      else if (item.priceKind === 'armor') parts.push({text:`\n\n防御力 ${power.defense}`});
    }
    if (entry.enhancement > 0 && entry.numbers?.enhancementRule) {
      const stat = item.priceKind === 'weapon' ? '攻击' : item.priceKind === 'armor' ? '防御' : undefined;
      if (stat) parts.push({text:`\n强化效果：+${entry.enhancement}（${stat} +${enhancementBonus(entry)}）`});
    }
    if (equipment.description?.classAttributes.length)
      parts.push({text:'\n'}, ...equipment.description.classAttributes);
  }
  const attributes = equipmentAttributeLines(catalog, entry, item.use?.kind === 'socket', gemNames);
  if (attributes.length) {
    if (parts.length) parts.push({text:'\n\n'});
    parts.push(...attributes);
  }
  if (skill) {
    if (parts.length) parts.push({text:'\n'});
    parts.push({text:`${skill.name}(${skill.className})`});
  }
  const description = item.descriptionParts ?? (item.description ? [{text:item.description, color:DESCRIPTION_COLOR}] : []);
  if (description.length) {
    if (parts.length) parts.push({text:'\n\n'});
    parts.push(...description);
  }
  return {title, color, rows:parts.length ? [{parts}] : []};
}

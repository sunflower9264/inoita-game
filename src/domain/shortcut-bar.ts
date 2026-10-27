import type { Bag } from './bag.ts';

/**
 * 原版快捷栏每组六格、共两组，`PLAYER_PutShortcut @0x1be43c` 按 `page*6 + slot` 寻址，
 * 而且**不校验槽位与类型的搭配**——技能和物品都能放进任意一格，所以这十二格是通用的。
 * 屏幕上的坐标、登记屏的表现与写入路径见 `work/findings/shortcut-screen-2026-10-13.md`。
 */
export const SHORTCUT_SLOT_COUNT = 6;
export const SHORTCUT_PAGE_COUNT = 2;
export const SHORTCUT_ENTRY_COUNT = SHORTCUT_SLOT_COUNT * SHORTCUT_PAGE_COUNT;
/** 每组前五格排技能，第六格是消耗品位——原版 HUD 的消耗品按钮就是这一排的第六个。 */
const SHORTCUT_SKILL_SLOTS = SHORTCUT_SLOT_COUNT - 1;

/** 一格快捷里的东西。技能与物品共用同一排槽，用 `kind` 分派。 */
export interface ShortcutEntry { kind: 'skill' | 'item'; id: string }
export type ShortcutRow = (ShortcutEntry | null)[];

export const emptyShortcutRow = (): ShortcutRow => Array<ShortcutEntry | null>(SHORTCUT_ENTRY_COUNT).fill(null);

/**
 * 同一技能只保留最后一次登记：从行末往前扫，后出现的副本优先。
 * 旧档没有登记时间，页 2/高槽位视为更新；物品沿用原来的“可占多格”规则。
 */
export function dedupeSkillShortcuts(row:ShortcutRow):ShortcutRow {
  const result=row.map(entry=>entry?{...entry}:null),seen=new Set<string>();
  for(let index=result.length-1;index>=0;index--){
    const entry=result[index];
    if(entry?.kind!=='skill')continue;
    if(seen.has(entry.id))result[index]=null;else seen.add(entry.id);
  }
  return result;
}

/** 默认快捷栏：已学会的主动技能按职业次序排前五格，消耗品放第一组第六格。 */
export function defaultShortcutRow(learnedActive: readonly string[], startingItem?: string): ShortcutRow {
  const row = emptyShortcutRow();
  learnedActive.forEach((id, index) => {
    const page = Math.floor(index / SHORTCUT_SKILL_SLOTS);
    if (page < SHORTCUT_PAGE_COUNT) row[page * SHORTCUT_SLOT_COUNT + index % SHORTCUT_SKILL_SLOTS] = { kind: 'skill', id };
  });
  if (startingItem) row[SHORTCUT_SKILL_SLOTS] = { kind: 'item', id: startingItem };
  return row;
}

/**
 * 一位成员的快捷栏。角色还没登记过时按默认内容铺开一次，之后这一行就是权威数据，
 * 所以后来学会的技能不会自己跳上快捷栏（原版学习技能也不动快捷栏），得在这一屏里登记。
 */
export class ShortcutBar {
  private readonly bag: Bag;
  private readonly owner: string;
  private readonly defaults: ShortcutRow;
  private constructor(bag: Bag, owner: string, defaults: ShortcutRow) { this.bag = bag; this.owner = owner; this.defaults = defaults; }
  static for(bag: Bag, owner: string, learnedActive: readonly string[], startingItem?: string): ShortcutBar {
    return new ShortcutBar(bag, owner, defaultShortcutRow(learnedActive, startingItem));
  }
  private check(page: number): void {
    if (!Number.isInteger(page) || page < 0 || page >= SHORTCUT_PAGE_COUNT) throw new Error('技能组无效');
  }
  /** 整行十二格。 */
  row(): ShortcutRow { return this.bag.ensureShortcuts(this.owner, this.defaults); }
  /** 某一组的六格，次序与屏幕上的按钮一致。 */
  page(page: number): ShortcutRow {
    this.check(page); return this.row().slice(page * SHORTCUT_SLOT_COUNT, (page + 1) * SHORTCUT_SLOT_COUNT);
  }
  /** 落一格。已占用即覆盖，没有确认步骤，对应原版的 `PLAYER_PutShortcut`。 */
  assign(page: number, slot: number, entry: ShortcutEntry | null): void {
    this.check(page);
    if (!Number.isInteger(slot) || slot < 0 || slot >= SHORTCUT_SLOT_COUNT) throw new Error('快捷位无效');
    const row = this.row(), start = page * SHORTCUT_SLOT_COUNT;
    // 一个技能只能占一格；写到新槽时把旧槽一起清掉，目标槽随后写入（最后一次登记生效）。
    if(entry?.kind==='skill')for(let index=0;index<row.length;index++)
      if(row[index]?.kind==='skill'&&row[index]!.id===entry.id)row[index]=null;
    row[start + slot] = entry;
    this.bag.setShortcuts(this.owner, row);
  }
  /** 该对象是否登记在任意一组。两处「取消快捷键」用它决定按钮文案。 */
  assigned(kind: ShortcutEntry['kind'], id: string): boolean {
    return this.row().some(entry => entry?.kind === kind && entry.id === id);
  }
  /** 把该对象从两组里一次清掉，对应原版的 `PLAYER_RemoveShortcutAll(char, type, id)`。 */
  clearObject(kind: ShortcutEntry['kind'], id: string): void {
    this.bag.setShortcuts(this.owner, this.row().map(entry => entry?.kind === kind && entry.id === id ? null : entry));
  }
}

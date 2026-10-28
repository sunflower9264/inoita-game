import { ITEM_CATEGORIES, type ItemCategory, type StoryItem } from './story-interface.ts';

/** 带装备位置的最小形状：判定武器与防具只看槽位，不引入装备模块的类型。 */
type FilterableItem = StoryItem & { equipment?: { slot: string } };

/**
 * 商品与内容校验沿用的分类口径。`equipment` 是内容层的四类之一，保留给整体筛选与校验；
 * 背包袋位另把装备按左右手位置拆成武器与防具，见 `pouchFor`。
 */
export type InventoryFilter = 'all' | ItemCategory | 'weapon' | 'armor';
export const INVENTORY_LABELS: Record<InventoryFilter, string> = {
  all: '全部', equipment: '装备', weapon: '武器', armor: '防具', consumable: '消耗', material: '材料', quest: '任务'
};
/**
 * 背包袋位：原版右侧那几个背包袋里的五个分类袋。每个袋各记自己的一套格位，物品之间可以留空位，
 * 见 `Bag.pouchCells`；武器与防具从装备里按左右手位置拆出来。次序即袋位次序。
 */
export const INVENTORY_POUCHES = ['weapon', 'armor', 'consumable', 'material', 'quest'] as const;
export type InventoryPouch = (typeof INVENTORY_POUCHES)[number];
/** 侧边六个页面各自保存排列，共享物品实例。 */
export type InventoryView = 'all' | InventoryPouch;
export const INVENTORY_SIDE_FILTERS: readonly InventoryView[] = ['all', ...INVENTORY_POUCHES];
export const INVENTORY_COLUMNS = 4;
const names = new Intl.Collator('zh-CN', { numeric: true });

/** 武器按原版的左右手位置分：主手与副手是武器，其余装备槽是防具。 */
const isHandSlot = (item: FilterableItem): boolean =>
  item.equipment?.slot === 'main-hand' || item.equipment?.slot === 'off-hand';

export function matchesFilter(item: FilterableItem, filter: InventoryFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'weapon' || filter === 'armor') {
    if (item.category !== 'equipment') return false;
    return filter === 'weapon' ? isHandSlot(item) : !isHandSlot(item);
  }
  return item.category === filter;
}

/**
 * 每个物品分类归属哪个袋。装备特殊：还要按左右手位置拆成武器与防具，所以标成 `by-hand`。
 *
 * `Record<ItemCategory, …>` 是这里的编译期保证：新增一个物品分类而没有给它安排袋位，
 * 编译就失败。原先靠 `INVENTORY_POUCHES.find(…matchesFilter…) ?? 'quest'` 兜底，
 * 漏安排时新袋永远为空、新分类的物品静默落进任务袋，两边都不报错。
 */
const POUCH_OF_CATEGORY: Record<ItemCategory, InventoryPouch | 'by-hand'> = {
  equipment: 'by-hand', consumable: 'consumable', material: 'material', quest: 'quest',
};

/**
 * 物品属于哪个袋。物品定义直接决定归属，实例不会换袋。
 *
 * 目录里查不到这件物品时归入任务袋——内容校验保证正式内容不会缺定义，只有不带物品目录构造的会话会走到这里。
 */
export function pouchFor(item: FilterableItem | undefined): InventoryPouch {
  if (!item) return 'quest';
  const pouch = POUCH_OF_CATEGORY[item.category];
  return pouch === 'by-hand' ? (isHandSlot(item) ? 'weapon' : 'armor') : pouch;
}

/** 界面要画的一格：物品格或可接收拖动的空格，格号属于当前页面。 */
type InventorySlot<T> =
  | { kind: 'item'; entry: T; view: InventoryView; cell: number }
  | { kind: 'cell'; view: InventoryView; cell: number };

/** 这个袋用到第几格：袋尾的空格不算，否则一次远距离落格会把滚动区永久撑长。 */
function usedCells(cells: readonly unknown[]): number {
  for (let index = cells.length - 1; index >= 0; index -= 1) if (cells[index] !== undefined) return index + 1;
  return 0;
}

/**
 * 每个页面直接读取自己的格位，保留内部空位，至少显示 16 格并在末尾留一行空格。
 * 全部页面的格位独立于分类页面，分类交界处与其他位置使用相同的连续网格。
 */
export function inventoryView<T extends { item: string }>(
  layouts: Readonly<Record<InventoryView, readonly (T | undefined)[]>>,
  view: InventoryView,
): { slots: InventorySlot<T>[]; slotCount: number } {
  const slots: InventorySlot<T>[] = [];
  const cells = layouts[view];
  const slotCount = Math.max(16, (Math.ceil(usedCells(cells) / INVENTORY_COLUMNS) + 1) * INVENTORY_COLUMNS);
  for (let cell = 0; cell < slotCount; cell += 1) {
    const entry = cells[cell];
    slots.push(entry ? { kind: 'item', entry, view, cell } : { kind: 'cell', view, cell });
  }
  return { slots, slotCount };
}

export function organizedInventory(inventory: ReadonlyMap<string, number>, items: Readonly<Record<string, StoryItem>>) {
  return [...inventory].sort(([left], [right]) => {
    const a = items[left], b = items[right];
    return ITEM_CATEGORIES.indexOf(a.category) - ITEM_CATEGORIES.indexOf(b.category) ||
      names.compare(a.name, b.name) || (left < right ? -1 : left > right ? 1 : 0);
  });
}

type OrderableItem = StoryItem & { kind?: string; level?: number };

/** 调试发放列表：装备按种类首次出现顺序分组，同组内等级从低到高；其它类别保持原顺序。 */
export function organizedDebugInventory(inventory: ReadonlyMap<string, number>,
  items: Readonly<Record<string, OrderableItem>>): [string, number][] {
  const kindOrder = new Map<string, number>();
  for (const item of Object.values(items))
    if (item.category === 'equipment' && item.kind && !kindOrder.has(item.kind)) kindOrder.set(item.kind, kindOrder.size);
  return organizedInventory(inventory, items).sort(([left], [right]) => {
    const a = items[left], b = items[right];
    const category = ITEM_CATEGORIES.indexOf(a.category) - ITEM_CATEGORIES.indexOf(b.category);
    if (category || a.category !== 'equipment') return category;
    return (kindOrder.get(a.kind ?? '') ?? kindOrder.size) - (kindOrder.get(b.kind ?? '') ?? kindOrder.size)
      || (a.level ?? 0) - (b.level ?? 0);
  });
}

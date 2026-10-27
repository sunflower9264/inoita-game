import { equipmentLevel, type EquipmentChaos } from './chaos-equipment.ts';
import { ItemApplicationError, ITEM_NOTICE_TEXT, type ItemNotice } from './item-application.ts';
import { SHORTCUT_ENTRY_COUNT, dedupeSkillShortcuts, type ShortcutRow } from './shortcut-bar.ts';
import { INVENTORY_POUCHES, organizedInventory, pouchFor, type InventoryPouch, type InventoryView } from './inventory.ts';
import type { StoryItem } from './story-interface.ts';
import { EQUIPMENT_SLOTS, USE_LABELS, USE_HANDLING, USE_INTERFACE_ONLY, USE_NOT_IMPLEMENTED, unimplementedItemUse, type Equipment, type EquipmentSlot, type ItemCatalog, type ItemInstance, type ItemResult } from './items.ts';

const emptyCatalog: ItemCatalog = { items: {}, startingEquipment: {}, startingInventory: [], startingShortcut: '', dualWieldClasses: [], merchantItems: [], classSkills: {}, recipes: {} };
/** 混沌合成写入的比例上限；等级偏移沿用原版有符号字节的存储范围。 */
const CHAOS_VALUE_PERCENT_MAX = 200;
const CHAOS_LEVEL_OFFSET_LIMIT = 127;
const copy = (entry: ItemInstance): ItemInstance => structuredClone(entry);
export interface BagRules {
  initialize(entry:ItemInstance,drop?:{grade?:import('./character-stats.ts').EquipmentGradeSeed;sockets?:boolean}):void;
  equipProblem(entry:ItemInstance):string|undefined;
  targetProblem(source:ItemInstance,target:ItemInstance):ItemNotice|undefined;
  applyUse(source:ItemInstance,target:ItemInstance|undefined,skill?:string):string|void;
  /**
   * 强化结算。原版有成败与概率，随机源由调用方给，界面只读结果。
   * 缺省时按「必定 +1」处理，方便不需要概率的场景。
   */
  enchant?:(source:ItemInstance,target:ItemInstance,random:()=>number)=>{level:number;message:string;notice?:ItemNotice};
}

export interface BagState {
  instances: ItemInstance[];
  /** 五个背包袋各自的格位：下标是该袋自己的格位号，空格是显式 undefined。 */
  pouches: Record<InventoryPouch, (string | undefined)[]>;
  /** 全部页面独立保存格位，与分类页面共享物品实例。 */
  allCells: (string | undefined)[];
  worn: Equipment;
  companionEquipment: [string, Equipment][];
  serial: number;
  /** 每个角色一份十二格快捷栏：技能与物品共用，见 `shortcut-bar.ts`。 */
  shortcuts: [string, ShortcutRow][];
  recipes: string[];
}

/**
 * 一份背包状态是否自洽。
 *
 * 这是「全部页与分类袋各存一套格位」这套手工纪律的**唯一机器检查**：同一批物品的落位分两处
 * 保存，`put`、`clearCells`、`placeInCell`、`organize` 每次都要同时维护。将来多出任何一条
 * 绕过它们的写入路径，两套数组就会悄悄分叉；加上这道检查之前，这种分叉要到下一次恢复检查点
 * 才报错，届时已经难定位是哪条路径写坏的。
 *
 * 三处调用：`captureState`（坏状态不许出站）、`restoreState`（不许把坏存档灌进来）、
 * `verifyConsistency`（测试显式自检）。**不能只挂在 `notify()` 上**——
 * `add` 与 `consume` 都不通知变化，挂在那里会漏掉最常见的两条写入路径。
 *
 * 只覆盖背包自己判得了的事实。「装备与快捷栏的拥有者是真实队员」「快捷栏引用的技能存在」
 * 要队伍名单和技能表，留在 `Session.validateInventoryState`。
 */
export function verifyBagState(state: BagState, catalog: ItemCatalog): void {
  const knownItems = Object.keys(catalog.items).length > 0;
  if (!Number.isSafeInteger(state.serial) || state.serial < 0) throw new Error('背包物品序号无效');
  const ids = new Set<string>();
  for (const entry of state.instances) {
    if (!entry.id || ids.has(entry.id) || !entry.item || knownItems && !catalog.items[entry.item] || !Number.isSafeInteger(entry.quantity) || entry.quantity <= 0) throw new Error('背包物品引用或数量无效');
    ids.add(entry.id);
    for (const gem of entry.gems) if (knownItems && !catalog.items[gem]) throw new Error('背包宝石引用无效');
  }
  const loose = new Set<string>();
  for (const row of Object.values(state.pouches)) for (const id of row) if (id != null) {
    if (!ids.has(id) || loose.has(id)) throw new Error('背包格位引用无效');
    loose.add(id);
  }
  const all = state.allCells.filter((id): id is string => id != null);
  if (new Set(all).size !== all.length || all.some(id => !loose.has(id)) || all.length !== loose.size) throw new Error('全部页与分类袋的物品不一致');
  const equipped = new Set<string>();
  for (const equipment of [state.worn, ...state.companionEquipment.map(([, equipment]) => equipment)]) for (const id of Object.values(equipment)) if (id !== undefined) {
    if (!ids.has(id) || loose.has(id) || equipped.has(id)) throw new Error('背包装备引用无效');
    equipped.add(id);
  }
  if (ids.size !== loose.size + equipped.size) throw new Error('背包存在无归属的物品');
  for (const recipe of state.recipes) if (knownItems && !catalog.recipes[recipe]) throw new Error('背包配方引用不存在');
}

/** Inventory transactions own both loose items and equipped instances. */
export class Bag {
  readonly catalog: ItemCatalog;
  readonly classId: string;
  private readonly instances = new Map<string, ItemInstance>();
  /**
   * 五个背包袋各自的格位：下标是该袋自己的格位号，空格写成显式 undefined。
   * 每个分类保留自己的空位，格子随物品增加，靠「整理」收拢。
   * 袋里只放散装物品；穿在身上的实例不在任何袋里。
   */
  private pouches: Record<InventoryPouch, (string | undefined)[]> = { weapon: [], armor: [], consumable: [], material: [], quest: [] };
  private all: (string | undefined)[] = [];
  private worn: Equipment = {};
  private readonly companionEquipment = new Map<string, Equipment>();
  private serial = 0;
  private changed: () => void;
  private readonly shortcuts = new Map<string, ShortcutRow>();
  revision = 0;
  private recipeBook = new Set<string>();
  get learnedRecipes(): string[] { return [...this.recipeBook]; }
  lastResult?: Readonly<ItemResult>;
  private rules?:BagRules;
  private countsCache?:{revision:number;value:ReadonlyMap<string,number>};

  constructor(changed: () => void, catalog: ItemCatalog = emptyCatalog, classId = '', seed: 'none' | 'game' = 'none', rules?:BagRules) {
    this.catalog = catalog; this.classId = classId; this.changed = changed;this.rules=rules;
    if (seed !== 'none') {
      for(const entry of catalog.startingInventory)this.add(entry.item,entry.quantity);
      this.all = this.orderedIds();
      for (const [slot, item] of Object.entries(catalog.startingEquipment[classId] ?? {})) {
        const entry = this.create(item!); this.worn[slot as EquipmentSlot] = entry.id;
      }
    }
  }
  /** 显式自检：测试用它确认当前背包自洽。正常流程由 `captureState`/`restoreState` 两个边界自动调用。 */
  verifyConsistency(): void { verifyBagState(this.snapshot(),this.catalog); }
  captureState(): BagState {
    const state=this.snapshot();
    // 出站自检：坏状态不该离开背包，否则要等到下一次恢复检查点才暴露，届时已难定位。
    verifyBagState(state,this.catalog);
    return state;
  }
  /** 内部回滚路径专用：跳过校验，免得错误处理本身再抛错、把真正的异常盖掉。 */
  restoreUnchecked(state: BagState): void { this.writeState(structuredClone(state)); }
  restoreState(state: BagState): void {
    const restored=structuredClone(state);
    // 先验克隆体再覆盖：抛错时现有背包原样保留，不会留下改了一半的状态。
    verifyBagState(restored,this.catalog);
    this.writeState(restored);
  }
  private snapshot(): BagState {
    return structuredClone({instances:[...this.instances.values()],pouches:this.pouches,allCells:this.all,worn:this.worn,
      companionEquipment:[...this.companionEquipment],serial:this.serial,shortcuts:[...this.shortcuts],recipes:[...this.recipeBook]});
  }
  private writeState(restored: BagState): void {
    this.instances.clear();for(const entry of restored.instances)this.instances.set(entry.id,entry);
    this.pouches=Object.fromEntries(Object.entries(restored.pouches).map(([view,cells])=>[view,cells.map(id=>id??undefined)])) as BagState['pouches'];
    this.all=restored.allCells.map(id=>id??undefined);this.worn=restored.worn;this.serial=restored.serial;
    this.companionEquipment.clear();for(const [owner,equipment] of restored.companionEquipment)this.companionEquipment.set(owner,equipment);
    this.shortcuts.clear();for(const [owner,row] of restored.shortcuts)this.shortcuts.set(owner,dedupeSkillShortcuts(row));
    this.recipeBook=new Set(restored.recipes);this.lastResult=undefined;
    // Invalidate equipment operations prepared before the checkpoint was restored.
    this.revision++;
  }
  /** 实例所在袋的格位表。实例不存在时没有袋；穿在身上的实例有袋但不在格里，见 `cellOf`。 */
  private cellsOf(id: string): (string | undefined)[] | undefined {
    const entry = this.instances.get(id);
    return entry ? this.pouches[pouchFor(this.catalog.items[entry.item])] : undefined;
  }
  /** 实例在它自己袋里的格位号；不在背包里（未知实例或穿在身上）返回 -1。 */
  private cellOf(id: string): number { return this.cellsOf(id)?.indexOf(id) ?? -1; }
  /** 去掉袋尾多余的空格：格数只由最大已用格位决定，否则一次远距离落格会把滚动区永久撑长。 */
  private trim(cells: (string | undefined)[]): void {
    while (cells.length && cells[cells.length - 1] === undefined) cells.pop();
  }
  /** 全部与所属分类分别填第一个空位；没有空位就接到末尾。 */
  private put(id: string): void {
    for (const cells of [this.all, this.cellsOf(id)!]) {
      const free = cells.indexOf(undefined);
      if (free < 0) cells.push(id); else cells[free] = id;
    }
  }
  /** 物品离开背包时，两套格位都留空，其他物品保持位置。 */
  private clearCells(id: string): void {
    for (const cells of [this.all, this.cellsOf(id)]) {
      const cell = cells?.indexOf(id) ?? -1;
      if (cells && cell >= 0) { cells[cell] = undefined; this.trim(cells); }
    }
  }
  /** 五个袋依次拼接的紧凑 id 列表，即背包里所有散装物品的次序。 */
  private orderedIds(): string[] {
    return INVENTORY_POUCHES.flatMap(pouch => this.pouches[pouch].filter((id): id is string => id !== undefined));
  }
  get entries(): ItemInstance[] { return this.orderedIds().map(id => copy(this.instances.get(id)!)); }
  get allCells(): (ItemInstance | undefined)[] {
    return this.all.map(id => id === undefined ? undefined : copy(this.instances.get(id)!));
  }
  /** 五个袋各自的格位视图：下标是该袋自己的格位号，空格是 undefined。界面逐格读它。 */
  get pouchCells(): Record<InventoryPouch, (ItemInstance | undefined)[]> {
    const view=(cells:(string|undefined)[])=>cells.map(id=>{const entry=id?this.instances.get(id):undefined;return entry?copy(entry):undefined;});
    return { weapon:view(this.pouches.weapon), armor:view(this.pouches.armor), consumable:view(this.pouches.consumable),
      material:view(this.pouches.material), quest:view(this.pouches.quest) };
  }
  get equipment(): Equipment { return {...this.worn}; }
  equipmentFor(owner = 'player'): Equipment { return {...(owner === 'player' ? this.worn : this.companionEquipment.get(owner) ?? {})}; }
  addEquipped(item: string, slot: EquipmentSlot, owner: string): string {
    if (!this.catalog.items[item]?.equipment) throw new Error('初始装备不存在');
    const entry=this.create(item);
    const next=this.equipmentFor(owner);next[slot]=entry.id;
    if(owner==='player')this.worn=next;else this.companionEquipment.set(owner,next);
    this.notify();return entry.id;
  }
  removeOwner(owner: string, returnEquipment: boolean): void {
    if(owner==='player')throw new Error('主角不能移出队伍');
    const equipment=this.companionEquipment.get(owner);
    this.shortcuts.delete(owner);
    if(!equipment){this.notify();return;}
    this.companionEquipment.delete(owner);
    for(const id of Object.values(equipment)){
      if(!id)continue;
      if(returnEquipment)this.put(id);else this.instances.delete(id);
    }
    this.notify();
  }
  /**
   * 该角色的十二格快捷栏。这一行还不存在时用 `defaults` 铺开并记下来——铺开前后的可见内容
   * 完全一样，所以这里不通知订阅者；默认值只在第一次读到时算一次，之后这一行就是权威数据。
   * 读取与落格都由 `shortcut-bar.ts` 的 `ShortcutBar` 经手，界面不直接拿它。
   */
  ensureShortcuts(owner:string,defaults:ShortcutRow):ShortcutRow {
    const existing=this.shortcuts.get(owner);
    if(existing)return structuredClone(existing);
    const row=structuredClone(defaults);this.shortcuts.set(owner,row);return structuredClone(row);
  }
  /** 写入整行快捷栏并通知订阅者。 */
  setShortcuts(owner:string,row:ShortcutRow):void {
    if(row.length!==SHORTCUT_ENTRY_COUNT)throw new Error('快捷栏格数无效');
    this.shortcuts.set(owner,dedupeSkillShortcuts(row));this.notify();
  }
  /**
   * 分类计数按 revision 缓存：背包没变时同一份 Map 直接复用。
   * `count()` 和 `observeChanges` 会在一次通知里按物品反复读它，重建整张 Map 是 O(n²) 的根。
   */
  get counts(): ReadonlyMap<string, number> {
    const cached = this.countsCache;
    if (cached && cached.revision === this.revision) return cached.value;
    const value = new Map<string, number>();
    for (const id of this.orderedIds()) { const entry = this.instances.get(id)!; value.set(entry.item, (value.get(entry.item) ?? 0) + entry.quantity); }
    this.countsCache = { revision: this.revision, value };
    return value;
  }
  count(item: string): number { return this.counts.get(item) ?? 0; }
  get(id: string): ItemInstance | undefined { const entry=this.instances.get(id); return entry && copy(entry); }
  private create(item: string, skill?: string): ItemInstance {
    if(this.catalog.items[item]?.pickup)throw new Error('该物品在地面拾取时生效');
    const entry: ItemInstance = {id:`owned-${++this.serial}`, item, quantity:1, enhancement:0, gems:[], ...(skill ? {skill} : {})};
    this.rules?.initialize(entry);
    this.instances.set(entry.id,entry); return entry;
  }
  /** Called by the session's pickup/quest transaction; notification belongs to its caller. */
  add(item: string, quantity = 1, skill?: string): void {
    if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new Error('物品数量必须为正整数');
    if(Object.keys(this.catalog.items).length&&!this.catalog.items[item])throw new Error('物品定义不存在');
    if(this.catalog.items[item]?.pickup)throw new Error('该物品在地面拾取时生效');
    this.revision++;
    const stackable = this.catalog.items[item]?.stackable ?? true;
    if (stackable && !skill) {
      const existing=this.orderedIds().map(id=>this.instances.get(id)!).find(entry=>entry.item===item&&!entry.skill);
      if(existing){existing.quantity+=quantity;return;}
      const entry=this.create(item);entry.quantity=quantity;this.put(entry.id);
    } else for(let index=0;index<quantity;index++)this.put(this.create(item,skill).id);
  }
  /** Resolve a ground item's modifiers when it drops; collecting it keeps this result. */
  prepareDrop(item:string,drop?:{grade?:import('./character-stats.ts').EquipmentGradeSeed;sockets?:boolean}):ItemInstance {
    if(!this.catalog.items[item])throw new Error('物品定义不存在');
    const entry:ItemInstance={id:`ground-${++this.serial}`,item,quantity:1,enhancement:0,gems:[]};
    this.rules?.initialize(entry,drop);
    return copy(entry);
  }
  receiveDrop(prepared:ItemInstance):void {
    if(!this.catalog.items[prepared.item]||this.catalog.items[prepared.item].pickup||prepared.quantity!==1)throw new Error('地面物品无效');
    if(this.catalog.items[prepared.item].stackable&&!prepared.numbers){this.add(prepared.item);return;}
    const entry={...copy(prepared),id:`owned-${++this.serial}`};
    this.instances.set(entry.id,entry);this.put(entry.id);this.revision++;
  }
  remove(item: string, quantity: number): boolean {
    if (!Number.isSafeInteger(quantity) || quantity <= 0 || this.count(item) < quantity) return false;
    for (const entry of this.entries.filter(entry=>entry.item===item)) {
      const used=Math.min(quantity,entry.quantity);this.consume(entry.id,used);quantity-=used;if(!quantity)break;
    }
    return true;
  }
  private consume(id: string, quantity = 1): void {
    this.revision++;
    const entry=this.instances.get(id)!;entry.quantity-=quantity;
    if(!entry.quantity){
      this.clearCells(id);
      this.instances.delete(id);
    }
    // 库存见底就把快捷栏里的这瓶药水一起撤掉，只清物品格，技能格不动。
    if(!this.count(entry.item))for(const row of this.shortcuts.values())
      row.forEach((slot,index)=>{if(slot?.kind==='item'&&slot.id===entry.item)row[index]=null;});
  }
  private notify(): void { this.revision++; this.changed(); }
  /**
   * 同时整理六个页面：按分类及中文自然名称排序，收拢空位。
   * 顺序与空位都没变就不通知更新。
   */
  organize(items: Readonly<Record<string, StoryItem>> = this.catalog.items): void {
    const ranks=new Map(organizedInventory(this.counts,items).map(([item],index)=>[item,index]));
    let changed=false;
    for(const target of ['all', ...INVENTORY_POUCHES] as const){
      const cells=target==='all'?this.all:this.pouches[target],current=cells.filter((id):id is string => id !== undefined);
      const sorted=[...current].sort((a,b)=>{
        const left=this.instances.get(a)!.item,right=this.instances.get(b)!.item;
        return INVENTORY_POUCHES.indexOf(pouchFor(this.catalog.items[left]))-INVENTORY_POUCHES.indexOf(pouchFor(this.catalog.items[right])) ||
          ranks.get(left)!-ranks.get(right)!;
      });
      // 有空格时即使序已排好也要压缩，否则「整理」对空位不起作用。
      if(current.length===cells.length&&sorted.every((id,index)=>id===current[index]))continue;
      if(target==='all')this.all=sorted;else this.pouches[target]=sorted;
      changed=true;
    }
    if(changed)this.notify();
  }
  /**
   * 拖动的唯一落格动作，对应原版 `UIEquip_InvenItemControlEventProc @0x149f28`：清空来源格 →
   * `INVEN_MoveItem` → 目标格原有物品被写回来源格。目标格空着就是「搬进那一格、原格留空」，
   * 有物品就是「交换」。
   *
   * 全部页面的物品可以自由交换；分类页面只接受该分类的物品。每次只修改目标页面的格位。
   * 返回是否真的换了位置；没换就不出声、不重绘。
   */
  placeInCell(id: string, view: InventoryView, cell: number): boolean {
    const entry=this.instances.get(id);
    if(!entry)return false;
    const own=pouchFor(this.catalog.items[entry.item]);
    if(view!=='all'&&own!==view)return false;
    const cells=view==='all'?this.all:this.pouches[view],from=cells.indexOf(id);
    if(from<0||!Number.isInteger(cell)||cell<0)return false;
    if(from===cell)return false;
    while(cells.length<=cell)cells.push(undefined);
    const occupant=cells[cell];
    cells[cell]=id;cells[from]=occupant;
    this.trim(cells);
    this.notify();return true;
  }
  slotsFor(id: string, classId = this.classId): EquipmentSlot[] {
    const entry=this.instances.get(id), rule=entry&&this.catalog.items[entry.item]?.equipment;
    if(!rule || rule.locked || !rule.classes.includes(classId))return [];
    const slots=[rule.slot];
    if(rule.dualWield&&this.catalog.dualWieldClasses.includes(classId))slots.push('off-hand');
    if(rule.slot==='ring')slots.push('accessory');
    return slots;
  }
  /**
   * 只读的装备判定：可以装备时返回 undefined，否则返回不能装备的原因。
   * 与 `planEquip` 共用同一次计算，界面用它禁用按钮并显示原因，不复制规则。
   * 人物等级限制由 `rules.equipProblem` 给出；伙伴没有规则对象，改用 `level` 参数。
   */
  equipProblem(id: string, slot: EquipmentSlot, owner = 'player', classId = this.classId, level?: number): string | undefined {
    return this.planEquipStep(id,slot,owner,classId,level).problem;
  }
  private planEquipStep(id: string, slot: EquipmentSlot, owner: string, classId: string, level?: number): { next?: Equipment; problem?: string } {
    const entry=this.instances.get(id);
    if(!entry || this.cellOf(id)<0 || !this.slotsFor(id,classId).includes(slot))return { problem:'该物品不能装备在此位置' };
    const problem=owner==='player'?this.rules?.equipProblem(entry):
      level!==undefined&&equipmentLevel(this.catalog.items[entry.item],entry)>level?`需要等级 ${equipmentLevel(this.catalog.items[entry.item],entry)}`:undefined;
    if(problem)return { problem };
    const rule=this.catalog.items[entry.item].equipment!;
    const next={...this.equipmentFor(owner),[slot]:id};
    if(slot==='main-hand'&&rule.twoHanded)delete next['off-hand'];
    if(slot==='off-hand'&&rule.dualWield&&!next['main-hand'])return { problem:'请先装备一件单手主武器' };
    if(slot==='off-hand'&&next['main-hand']) {
      const main=this.catalog.items[this.instances.get(next['main-hand']!)!.item];
      if(main.equipment?.twoHanded)delete next['main-hand'];
      if(rule.dualWield && !next['main-hand'])return { problem:'请先装备一件单手主武器' };
    }
    return { next };
  }
  planEquip(id: string, slot: EquipmentSlot, owner = 'player', classId = this.classId, level?: number): Equipment {
    const step=this.planEquipStep(id,slot,owner,classId,level);
    if(step.problem)throw new Error(step.problem);
    return step.next!;
  }
  planUnequip(slot: EquipmentSlot, owner = 'player'): Equipment {
    const current=this.equipmentFor(owner);
    if(!current[slot])throw new Error('此装备槽为空');
    const next={...current};delete next[slot];
    if(slot==='main-hand'&&next['off-hand']) {
      const off=this.catalog.items[this.instances.get(next['off-hand']!)!.item];
      if(off.equipment?.dualWield)delete next['off-hand'];
    }
    return next;
  }
  equip(id: string, slot: EquipmentSlot, owner = 'player', classId = this.classId, level?: number): void { this.commitEquipment(this.planEquip(id,slot,owner,classId,level),owner); }
  unequip(slot: EquipmentSlot, owner = 'player'): void { this.commitEquipment(this.planUnequip(slot,owner),owner); }
  private commitEquipment(next: Equipment, owner = 'player'): void {
    const oldIds=new Set(Object.values(this.equipmentFor(owner))), newIds=new Set(Object.values(next));
    // 先让新穿上的离开格位、再让换下的回包，换下来的装备就落进新装备腾出的那一格。
    for(const id of newIds){
      if(!id)continue;
      this.clearCells(id);
    }
    for(const id of oldIds)if(id&&!newIds.has(id))this.put(id);
    if(owner==='player')this.worn=next;else this.companionEquipment.set(owner,next);this.notify();
  }
  /** 原版先检查这对物品能否应用，再决定应用或交换；耐久与孔数属于应用结果。 */
  canApply(sourceId:string,targetId:string):boolean {
    const source=this.instances.get(sourceId),target=this.instances.get(targetId);
    if(!source||this.cellOf(sourceId)<0||!target||sourceId===targetId)return false;
    const use=this.catalog.items[source.item].use,definition=this.catalog.items[target.item],equipment=definition.equipment;
    if(!use||!equipment)return false;
    if(use.kind==='enchant')return equipment.enchantable&&((use.target==='weapon')===(definition.priceKind==='weapon'||equipment.slot==='main-hand'));
    if(use.kind==='socket')return !equipment.locked;
    if(use.kind==='purify')return !!target.numbers?.chaos;
    return false;
  }
  applicationProblem(sourceId:string,targetId:string):ItemNotice|undefined {
    const source=this.instances.get(sourceId)!,target=this.instances.get(targetId)!,use=this.catalog.items[source.item].use!,definition=this.catalog.items[target.item];
    if(use.kind==='enchant') {
      if(use.maxLevel&&definition.level>use.maxLevel)return 'enchant-level';
      if(use.requiresEnhanced&&!target.enhancement)return 'enchant-first';
    }
    if(use.kind==='socket') {
      if(target.gems.length>=(target.numbers?.sockets??definition.equipment!.socketCapacity))return 'socket-full';
    }
    return this.rules?.targetProblem(source,target);
  }
  targetProblem(sourceId:string,targetId:string):string|undefined {
    if(!this.canApply(sourceId,targetId))return '请选择可应用的装备';
    const problem=this.applicationProblem(sourceId,targetId);
    return problem?ITEM_NOTICE_TEXT[problem]:undefined;
  }
  /** 合成在原装备实例上写入混沌属性，保留格位、强化、词条和宝石。 */
  applyChaos(id:string,chaos:EquipmentChaos,expectedRevision:number):void {
    const entry=this.instances.get(id),item=entry?this.catalog.items[entry.item]:undefined;
    if(this.revision!==expectedRevision||!entry?.numbers||this.cellOf(id)<0||!item?.equipment||!['weapon','armor'].includes(item.priceKind??''))throw new Error('合成装备已变化');
    if(!['chaos','epic-chaos'].includes(chaos.tier)||!Number.isInteger(chaos.valuePercent)||chaos.valuePercent<0||chaos.valuePercent>CHAOS_VALUE_PERCENT_MAX||!Number.isInteger(chaos.levelOffset)||Math.abs(chaos.levelOffset)>CHAOS_LEVEL_OFFSET_LIMIT)throw new Error('混沌数值无效');
    entry.numbers.chaos={...chaos};this.notify();
  }
  use(id: string, target?: string, skill?: string, random: () => number = Math.random): ItemResult {
    const source=this.instances.get(id);
    if(!source||this.cellOf(id)<0)throw new Error('物品已不在背包中');
    const definition=this.catalog.items[source.item], use=definition.use;
    if(!use)throw new Error('此物品不能直接使用');
    // 两类物品在这里拦下，都不消耗：入口在界面层的（回血、招募、复活）、
    // 以及用途还没实现的（骰子、符文和多数 consume）。玩家能看到原因，
    // 而不是拿到一句「已使用XX」却发现没效果。
    if(USE_HANDLING[use.kind]==='ui')throw new Error(USE_INTERFACE_ONLY);
    const unimplemented=unimplementedItemUse(source.item,definition);
    if(unimplemented)throw new Error(unimplemented);
    if(['enchant','socket','purify'].includes(use.kind)) {
      if(!target||!this.canApply(id,target))throw new Error('请选择可应用的装备');
      const problem=this.applicationProblem(id,target);
      if(problem)throw new ItemApplicationError(problem);
    }
    const pick=<T>(choices:T[]):T=>{
      const value=random();
      if(!choices.length||!Number.isFinite(value)||value<0||value>=1)throw new Error('随机结果无效');
      return choices[Math.floor(value*choices.length)];
    };
    const learnedSkill=source.skill||skill;
    if(use.kind==='learn'&&(!learnedSkill||!this.catalog.classSkills[this.classId]?.includes(learnedSkill)))throw new Error('请选择本职业的技能');
    const result:ItemResult={kind:use.kind,title:USE_LABELS[use.kind],message:`已使用${definition.name}`,rewards:[],target,item:source.item};
    const enchantOutcome=use.kind==='enchant'?this.rules?.enchant?.(source,this.instances.get(target!)!,random):undefined;
    const useMessage=this.rules?.applyUse(source,target?this.instances.get(target):undefined,learnedSkill);
    if(useMessage)result.message=useMessage;
    // 每种用途都要有一个 case：新增 ItemUseKind 时，`default` 的 `never` 兜底会在这里编译失败。
    switch(use.kind) {
      // consume 与技能点类的结算由上面的 applyUse 完成；神灯只消耗物品，开商店是界面的事。
      case 'consume': case 'reset-skills': case 'merchant': break;
      case 'enchant': {
        const entry=this.instances.get(target!)!,outcome=enchantOutcome;
        if(outcome){entry.enhancement=outcome.level;result.message=outcome.message;result.notice=outcome.notice;}
        else{entry.enhancement++;result.message=`${this.catalog.items[entry.item].name} 强化 +${entry.enhancement}`;}
        break;
      }
      case 'socket': {const entry=this.instances.get(target!)!;entry.gems.push(source.item);result.message=`${this.catalog.items[entry.item].name}已镶嵌${definition.name}`;break;}
      case 'purify': {delete this.instances.get(target!)!.numbers!.chaos;result.message='';break;}
      case 'pack': result.rewards=use.rewards!.map(reward=>({...reward}));break;
      case 'box': case 'unseal': {
        result.rewards=[{...pick(use.rewards!)}];
        if(use.kind==='unseal'){result.classId=use.classId;result.skill=pick(this.catalog.classSkills[use.classId!]??[]);}
        break;
      }
      case 'recipe': result.recipe=pick(use.recipes!);break;
      case 'learn': result.skill=learnedSkill;break;
      // 上面已按 USE_HANDLING 拒绝，走不到这几行；列出来只为让 switch 保持穷尽。
      case 'recover-health': case 'regenerate': case 'recruit': case 'revive': throw new Error(USE_INTERFACE_ONLY);
      case 'dungeon': throw new Error(USE_NOT_IMPLEMENTED);
      default: {const missing:never=use.kind;throw new Error(`未处理的物品用途：${missing}`);}
    }
    this.consume(id);
    for(const reward of result.rewards)this.add(reward.item,reward.quantity,use.kind==='unseal'?result.skill:undefined);
    if(result.recipe)this.recipeBook.add(result.recipe);
    this.lastResult=result;this.notify();return result;
  }
  discard(id: string, quantity: number): void {
    const entry=this.instances.get(id);
    if(!entry||this.cellOf(id)<0||!this.catalog.items[entry.item].discardable)throw new Error('此物品不能丢弃');
    if(!Number.isSafeInteger(quantity)||quantity<=0||quantity>entry.quantity)throw new Error('丢弃数量无效');
    this.consume(id,quantity);this.notify();
  }
  /** Remove a selected loose instance after a shop transaction has validated it. */
  take(id:string, quantity:number, notify=true):void {
    const entry=this.instances.get(id);
    if(!entry||this.cellOf(id)<0||!Number.isSafeInteger(quantity)||quantity<1||quantity>entry.quantity)
      throw new Error('物品数量已变化');
    this.consume(id,quantity);if(notify)this.notify();
  }
  equipmentItems(equipment: Equipment = this.worn): Partial<Record<EquipmentSlot,string>> {
    return Object.fromEntries(EQUIPMENT_SLOTS.flatMap(slot=>equipment[slot]?[[slot,this.instances.get(equipment[slot]!)!.item]]:[]));
  }
}

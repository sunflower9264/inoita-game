import { equipmentPower, rollEquipmentNumbers, type CharacterStatsCatalog } from './character-stats.ts';
import type { ItemCatalog, ItemInstance } from './items.ts';
import type { Session } from './session.ts';

type StockRule =
  | { kind: 'level-range'; minimumLevel: number; maximumLevel: number; category: 'weapons' | 'armor' }
  | { kind: 'random-stock'; attempts: number; levelRadius: number; profile: 'black-market' | 'lamp' }
  | { kind: 'rare-equipment'; attempts: number };
interface ShopDefinition { name: string; priceRatePercent: number; fixedStock: string[]; categories: string[]; stockRules: StockRule[] }
export interface WeightedItem { weight: number; item?: string | null; tiers?: { item: string | null; level: number }[] }
type RandomCategory = 'generic' | 'equipment' | 'consumable' | 'upgrade' | 'crafting' | 'misc';
export interface ShopCatalog {
  shops: Record<string, ShopDefinition>; lampShop: string;
  categories: Record<string, {name: string; group: 'weapons' | 'armor'}>;
  assets: Record<string, string>; mapShopLevels: Record<string, number>;
  profiles: Record<string, {pools: Record<string, WeightedItem[]>; chances: Record<RandomCategory, number>; uniqueChanceByLevel: number[]}>;
  equipment: Record<string, {defaultGrade: number; randomGrade: boolean; dropLevel: number;
    randomGroup: 'weapon' | 'armor' | 'accessory' | 'none'; randomListed: boolean; uniqueListed: boolean;
    variants: {attack: number; defense: number; gradeName: string; optionCount: number; socketLimit: number}[]; concealedPrices: number[]}>;
  grades: {name: string; armorName?: string; rarity: number; weight: number}[];
  rarityWeights: {ordinary: number[]; rare: number[]};
}
interface ShopOffer { id: string; instance: ItemInstance; limited: boolean; concealed: boolean; sold: boolean }
export interface ShopVisitsState { mapId?:string; stock:[string,ShopOffer[]][]; serial:number }
const whole = (value: number) => Math.max(0, Math.trunc(value));

export function itemValue(items: ItemCatalog, stats: CharacterStatsCatalog, id: string, instance?: ItemInstance): number {
  const item = items.items[id];
  if (!item) throw new Error('物品不存在');
  if (!item.equipment) return item.basePrice;
  const source = stats.equipment[id];
  if (!source) throw new Error('装备数值不存在');
  const power = equipmentPower(source, instance ?? { id: 'quote', item: id, quantity: 1, enhancement: 0, gems: [] });
  const level = item.level;
  const kind = item.priceKind ?? (source.attack ? 'weapon' : source.defense ? 'armor' : 'accessory');
  const options = instance?.numbers?.modifiers.length ?? source.optionCount + source.fixedOptions.length;
  const value = kind === 'weapon' ? whole(power.attack * (level + 140) / 10) : kind === 'armor' ? whole(power.defense * (level + 140) / 50) :
    whole((level + 5) * (level + 140 + options * 50) / 40);
  return item.pricePremium ? value * 8 + 30000 : value;
}
export function saleValue(value: number): number { return value ? Math.floor(value * 2 / 11) + 1 : 0; }

/** Limited stock occupies up to sixteen slots across merchants until the map changes. */
export class ShopVisits {
  mapId?: string;
  private stock = new Map<string, ShopOffer[]>();
  private serial = 0;
  captureState():ShopVisitsState { return structuredClone({mapId:this.mapId,stock:[...this.stock],serial:this.serial}); }
  restoreState(state:ShopVisitsState):void {
    const restored=structuredClone(state);this.mapId=restored.mapId;this.stock=new Map(restored.stock);this.serial=restored.serial;
  }
  enterMap(map: string): void { if (map !== this.mapId) { this.stock.clear(); this.mapId = map; } }
  identity(): string { return `merchandise-${++this.serial}`; }
  open(id: string, create: (capacity: number) => ShopOffer[]): ShopOffer[] {
    let offers = this.stock.get(id);
    if (!offers) {
      const occupied = [...this.stock.values()].reduce((total, entries) => total + entries.length, 0);
      offers = create(Math.max(0, 16 - occupied)); this.stock.set(id, offers);
    }
    return offers;
  }
}

export class Storefront {
  readonly shop: ShopDefinition;
  category?: string;
  private stock: ShopOffer[] = [];
  private readonly catalog: ShopCatalog;
  private readonly session: Session;
  private readonly items: ItemCatalog;
  private readonly stats: CharacterStatsCatalog;
  private readonly random: () => number;
  constructor(catalog: ShopCatalog, items: ItemCatalog, stats: CharacterStatsCatalog, session: Session,
    shopId: string, mapId: string, random: () => number = Math.random) {
    const shop = catalog.shops[shopId];
    if (!shop) throw new Error('商店不存在');
    this.shop = shop; this.catalog = catalog; this.items = items; this.stats = stats; this.session = session; this.random = random;
    session.shops.enterMap(mapId || session.shops.mapId || session.campaign.start.map);
    if (shop.categories.length) this.selectCategory(shop.categories[0]);
    else {
      this.stock = shop.fixedStock.filter(id => items.items[id] && !items.items[id].pickup).map(id => this.createOffer(id, false));
      const rules = shop.stockRules.filter(rule => rule.kind !== 'level-range');
      if (rules.length) this.stock.push(...session.shops.open(shopId, capacity => {
        const offers: ShopOffer[] = [];
        for (const rule of rules) {
          const range = rule.kind === 'rare-equipment' ? this.rareRange() : undefined;
          for (let attempt = 0; attempt < rule.attempts && offers.length < capacity; attempt++) {
            const offer = rule.kind === 'rare-equipment' ? this.rareOffer(range!) : this.randomOffer(rule);
            if (offer) offers.push(offer);
          }
        }
        return offers;
      }));
      this.stock = this.stock.slice(0, 48);
    }
  }
  /** Sold slots stay in place; the native shelf displays its first sixteen positions. */
  get offers(): readonly ShopOffer[] { return this.stock.slice(0, 16); }
  /** 说明面板要按同一份装备数值算出攻击／防御，报价与详情因此不会各算一套。 */
  get characterStats(): CharacterStatsCatalog { return this.stats; }
  selectCategory(category: string): void {
    if (!this.shop.categories.includes(category)) throw new Error('商品分类不存在');
    if (this.category === category) return;
    this.category = category; this.stock = [];
    for (const rule of this.shop.stockRules) if (rule.kind === 'level-range') {
      for (const [id, item] of Object.entries(this.items.items)) {
        if (item.kind === category && item.storeListed && item.level >= rule.minimumLevel && item.level <= rule.maximumLevel)
          this.stock.push(this.createOffer(id, false));
        if (this.stock.length >= 48) break;
      }
    }
  }
  private roll(min: number, max: number): number {
    const value = this.random();
    if (!Number.isFinite(value) || value < 0 || value >= 1) throw new Error('随机结果无效');
    return min + Math.floor(value * (max - min + 1));
  }
  private weighted(weights: number[], total = weights.reduce((sum, weight) => sum + weight, 0)): number {
    if (!total) return -1;
    let draw = this.roll(0, total - 1);
    return weights.findIndex(weight => { draw -= weight; return draw < 0; });
  }
  private grade(mode: 'ordinary' | 'rare'): number {
    const rarity = this.weighted(this.catalog.rarityWeights[mode]);
    return this.weighted(this.catalog.grades.map(grade => grade.rarity === rarity ? grade.weight : 0));
  }
  private createOffer(item: string, limited: boolean, grade?: number, concealed = false, withSockets = true): ShopOffer {
    const id = this.session.shops.identity();
    const instance: ItemInstance = {id, item, quantity: 1, enhancement: 0, gems: []};
    const template = this.catalog.equipment[item];
    if (template) {
      const selectedGrade = grade ?? (limited && template.randomGrade ? this.grade('ordinary') : template.defaultGrade);
      const variant = template.variants[selectedGrade],
        // 选中的品级要写进 definition 本身：商店模板的变体只带 `gradeName`，不带 `defaultGrade`，
        // 而 `rollEquipmentNumbers` 是按 `defaultGrade` 写实例品级的。不写的话它会用主模板的原生
        // 品级，然后这里再覆盖一次——品级因此有两个写入点，改一处不影响另一处，也没有报错。
        definition = {...this.stats.equipment[item], ...variant, defaultGrade: selectedGrade, optionCount: limited ? variant.optionCount : 0};
      instance.numbers = {...rollEquipmentNumbers(definition, (min, max) => this.roll(min, max), limited && withSockets),
        baseAttack: variant.attack, baseDefense: variant.defense};
    } else {
      // Gems and other instance-specific goods use the same initializer as ground items.
      const prepared = this.session.bag.prepareDrop(item);
      if (prepared.numbers) instance.numbers = prepared.numbers;
    }
    return {id, instance, limited, concealed, sold: false};
  }
  private equipmentOffer(minimum: number, maximum: number, grade?: number, concealed = false): ShopOffer | undefined {
    const draw = this.roll(0, 99), group = draw < 20 ? 'weapon' : draw < 70 ? 'armor' : 'accessory';
    const candidates = Object.keys(this.catalog.equipment).filter(id => {
      const item = this.catalog.equipment[id];
      return item.randomListed && item.randomGroup === group && item.dropLevel >= minimum && item.dropLevel <= maximum;
    }).slice(0, 64);
    if (!candidates.length) return;
    return this.createOffer(candidates[this.roll(0, candidates.length - 1)], true, grade, concealed);
  }
  private uniqueOffer(level: number, concealed = false): ShopOffer | undefined {
    const candidates = Object.keys(this.catalog.equipment).filter(id => this.catalog.equipment[id].uniqueListed && this.items.items[id].level <= level);
    if (!candidates.length) return;
    return this.createOffer(candidates[this.roll(0, candidates.length - 1)], true, 10, concealed, false);
  }
  private rareRange(): [number, number] {
    const level = this.session.player?.level ?? 1, lower = Math.max(level, 6) - 5;
    const average = Math.floor((this.roll(lower, level + 5) + this.roll(lower, level + 5)) / 2);
    const minimum = Math.max(average, 6) - 5;
    return [minimum, Math.max(average + 2, minimum)];
  }
  private rareOffer([minimum, maximum]: [number, number]): ShopOffer | undefined {
    const grade = this.grade('rare');
    return grade === 10 ? this.uniqueOffer(maximum, true) : this.equipmentOffer(minimum, maximum, grade, true);
  }
  private randomOffer(rule: Extract<StockRule, {kind: 'random-stock'}>): ShopOffer | undefined {
    const profile = this.catalog.profiles[rule.profile];
    const level = rule.profile === 'lamp' ? this.session.player?.level ?? 1 : this.catalog.mapShopLevels[this.session.shops.mapId!] ?? 0;
    const minimum = Math.max(1, level - rule.levelRadius), maximum = level + rule.levelRadius;
    for (const category of ['generic', 'equipment', 'consumable', 'upgrade', 'crafting', 'misc'] as const) {
      if (this.roll(0, 9999) >= profile.chances[category]) continue;
      for (let attempt = 0; attempt < 100; attempt++) {
        if (category === 'equipment') { const offer = this.equipmentOffer(minimum, maximum); if (offer) return offer; }
        else {
          const pool = profile.pools[category], choice = pool[this.weighted(pool.map(entry => entry.weight), 10000)];
          const id = choice?.tiers ? choice.tiers.find(tier => tier.level <= level)?.item : choice?.item;
          if (id && this.items.items[id] && !this.items.items[id].pickup) return this.createOffer(id, true);
        }
      }
    }
    if (this.roll(0, 9999) < profile.uniqueChanceByLevel[Math.min(127, level)]) return this.uniqueOffer(level);
  }
  private offer(id: string): ShopOffer {
    const offer = this.offers.find(offer => offer.id === id);
    if (!offer || offer.sold) throw new Error('这件商品已不在货架上');
    return offer;
  }
  buyPrice(id: string): number {
    const offer = this.offer(id);
    const price=offer.concealed?this.catalog.equipment[offer.instance.item].concealedPrices[Math.min(127, this.session.player?.level ?? 1)]:
      whole(itemValue(this.items, this.stats, offer.instance.item, offer.instance) * this.shop.priceRatePercent / 100);
    const discount=this.session.party?.groupModifiers()['buy-discount']??0;
    return price-whole(price*discount/1000);
  }
  sellPrice(entry: ItemInstance): number {
    const item = this.items.items[entry.item];
    if (!item || item.category === 'quest' || item.sellable === false) return 0;
    const price=saleValue(itemValue(this.items, this.stats, entry.item, entry));
    return price+whole(price*(this.session.party?.groupModifiers()['sell-price']??0)/1000);
  }
  buy(id: string, quantity: number): number {
    const offer = this.offer(id), item = this.items.items[offer.instance.item];
    const maximum = !offer.limited && item.stackable ? 99 : 1;
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > maximum) throw new Error('购买数量无效');
    const total = this.buyPrice(id) * quantity;
    if (!Number.isSafeInteger(total) || total < 1) throw new Error('商品价格无效');
    if (this.session.money < total) throw new Error('金币不足');
    for (let i = 0; i < quantity; i++) this.session.bag.receiveDrop(offer.instance);
    if (offer.limited) offer.sold = true;
    this.session.spendMoney(total);
    return total;
  }
  sell(entryId: string, quantity: number): number {
    const entry = this.session.bag.get(entryId);
    if (!entry || !this.session.bag.entries.some(item => item.id === entryId)) throw new Error('请先卸下装备，或重新选择物品');
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > entry.quantity) throw new Error('出售数量无效');
    const total = this.sellPrice(entry) * quantity;
    if (!Number.isSafeInteger(total) || total < 1 || this.session.money + total > Number.MAX_SAFE_INTEGER) throw new Error('此物品无法出售');
    this.session.bag.take(entryId, quantity, false);
    this.session.gainMoney(total);
    return total;
  }
  /** 批量出售：先整批校验，再一次性扣物品、只通知一次；任意一件无效则整批不落地。 */
  sellMany(entries: readonly { id: string; quantity: number }[]): number {
    if (!entries.length) throw new Error('请选择要出售的物品');
    const ids = new Set<string>();
    let total = 0;
    for (const { id, quantity } of entries) {
      if (ids.has(id)) throw new Error('出售数量无效');
      ids.add(id);
      const entry = this.session.bag.get(id);
      if (!entry || !this.session.bag.entries.some(item => item.id === id)) throw new Error('请先卸下装备，或重新选择物品');
      if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > entry.quantity) throw new Error('出售数量无效');
      const price = this.sellPrice(entry) * quantity;
      if (!Number.isSafeInteger(price) || price < 1) throw new Error('此物品无法出售');
      total += price;
      if (!Number.isSafeInteger(total) || this.session.money + total > Number.MAX_SAFE_INTEGER) throw new Error('此物品无法出售');
    }
    for (const { id, quantity } of entries) this.session.bag.take(id, quantity, false);
    this.session.gainMoney(total);
    return total;
  }
}

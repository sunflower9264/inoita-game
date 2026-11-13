import { blockedNormalAcquisitionIds, reservedAcquisitionIds, type ItemCatalog, type ItemInstance } from './items.ts';
import type { ChestKind } from './content.ts';
import type { CharacterStatsCatalog, EquipmentGradeSeed } from './character-stats.ts';
import { rollGrade, staticGrade, MAX_RANDOM_EQUIPMENT_GRADE, type GradeProfile } from './equipment-grade.ts';
import { moneyGain } from './economy.ts';
import { RARITY_EPIC, type LootPityConfig } from './loot-pity.ts';

/** 掉落概率以万分之一为单位，10000 表示必中。 */
const DROP_CHANCE_UNIT = 10_000;
/** 原版普通掉落掷点是 1..9999。 */
const NATIVE_DROP_ROLL_MAX = 9_999;
/** 固定掉落权重总和固定为 1000。 */
const FIXED_DROP_WEIGHT_TOTAL = 1_000;
/** 装备掉率加成按千分比缩放。 */
const ITEM_CHANCE_PER_MILLE = 1_000;
/** 宝箱品质词条：1..999 掷点不超过 49 时换成幸运宝箱。 */
const NATIVE_PERCENT_ROLL_MAX = 999;
const FORTUNATE_BOX_MAX_ROLL = 49;
/** 「被选择的英雄」额外独特装备权重按 1000 为满值。 */
const UNIQUE_BONUS_WEIGHT = 1_000;

type DropCategory = 'consumable' | 'upgrade' | 'crafting' | 'misc';
type DropChance = 'money' | 'equipment' | DropCategory | 'unique' | 'fixed';
/** Absolute additions to the native 1..9999 roll, after level scaling. */
export type DropModifiers = Partial<Record<'equipment-drop'|'scroll-drop'|'material-drop'|'chest-quality',number>>;
export const BREAKABLE_ENEMY_IDS = {
  bush: 'enemy-bush-1',
  jar: 'enemy-jar-1',
  box: 'enemy-box-1'
} as const;
type BreakableKind = keyof typeof BREAKABLE_ENEMY_IDS;
const BREAKABLE_KIND_BY_ENEMY = new Map<string, BreakableKind>(
  Object.entries(BREAKABLE_ENEMY_IDS).map(([kind, enemyId]) => [enemyId, kind as BreakableKind])
);
export function breakableKindOf(enemyId: string): BreakableKind | undefined {
  return BREAKABLE_KIND_BY_ENEMY.get(enemyId);
}
interface DropChoice { weight:number; item?:string|null; tiers?:{item:string|null;level:number}[] }
export interface EnemyDropRule {
  level:number;
  pool:string;
  rolls:number;
  /** 体验版来源分层：普通/精英/Boss；推导稀有度 profile 与首杀保底。 */
  threat?:'normal'|'elite'|'boss';
  /** 原版 MONDATABASE.u16@0x1b bit4：死亡时不走 CHARSYSTEM_DropItem，任务掉落仍保留。 */
  noNormalDrops?:boolean;
  /** 低等级小 Boss/精英的付费掉落资格；不改变原来的威胁等级和普通掉落。 */
  paidDropEligible?:boolean;
  chances:Record<DropChance,number>;
  fixed:{item:string;weight:number}[];
}
interface ChapterBand {
  id:string;
  minLevel:number;
  maxLevel:number;
  maxItemLevel:number;
  rarityScale:number[];
  luck:number;
  profiles:Record<'normal'|'elite'|'boss',string>;
}
export interface PityConfig extends LootPityConfig {
  bossGuarantee:{equipment:boolean;minRarity:number};
}
/** 独立紫装判定：没有这个配置时紫装随机路径完全关闭。 */
interface EpicDropsConfig {
  enemyChance:number;
  chestChance:number;
}
interface QuestItemDropRule { item:string; threshold:number }
export interface QuestDropRequirement { item:string; quantity:number; owned:number }
type ReservedDropSource = 'elite'|'boss';
interface ReservedDropEntry {
  item:string;
  minPlayerLevel:number;
  maxPlayerLevel:number;
  sources:ReservedDropSource[];
  weight:number;
  once:boolean;
  /** 超过建议等级后权重衰减但不归零，避免一次性道具永久错过。 */
  softMax?:boolean;
}
export interface ReservedDropConfig {
  version:1;
  sources:Record<ReservedDropSource,{chancePer10000:number}>;
  pity:{unlockGuaranteeAfter:number};
  entries:ReservedDropEntry[];
}
export interface ReservedDropState { unlockMisses:number; claimed:string[] }
export interface DropCatalog {
  version:2|3;
  questItems:Record<string,QuestItemDropRule[]>;
  chests:Record<'ordinary'|'improved',ChestDropRule>&{boss?:ChestDropRule};
  breakables?:Record<BreakableKind|'fortunate-box',ChestDropRule>;
  enemies:Record<string,EnemyDropRule>;
  pools:Record<string,Partial<Record<DropCategory,DropChoice[]>>>;
  equipment:Record<'weapon'|'armor'|'special'|'unique'|'epic',{item:string;dropLevel:number}[]>;
  uniqueWeapons?:{item:string;dropLevel:number}[];
  itemCatalog?:ItemCatalog;
  rarityProfiles?:Record<string,number[]>;
  chapterBands?:ChapterBand[];
  pity?:PityConfig;
  epicDrops?:EpicDropsConfig;
  /** 付费道具的独立掉落通道：只有精英/Boss 来源，普通池不参与。 */
  reservedDrops?:ReservedDropConfig;
}
interface ChestDropRule extends Omit<EnemyDropRule,'level'|'threat'|'noNormalDrops'> {
  uniqueChance: {numerator:number;levelOffset:number};
  spawn?: {enemyId:string;chance:number};
  rarityProfile?:string;
  minRarity?:number;
}
export interface ChestOpenResult { rewards:DropReward[]; enemies:string[] }
export interface DropRoll extends EquipmentGradeSeed { rarity:number; sockets:boolean }
export type DropReward =
  | {kind:'item';item:string;quantity:1;instance?:ItemInstance;roll?:DropRoll;lootLevel?:number}
  | {kind:'money';amount:number};
const chanceKinds:readonly DropChance[]=['money','equipment','consumable','upgrade','crafting','misc','unique','fixed'];
const poolKinds:readonly DropCategory[]=['consumable','upgrade','crafting','misc'];

/** The source files are parsed offline; the game only sees named enemies and items. */
const parsedDropCatalogs = new WeakMap<object, WeakMap<ItemCatalog, WeakMap<readonly { id: string }[], DropCatalog>>>();

export function cachedDropCatalog(value: unknown, items: ItemCatalog, enemies: readonly { id: string }[]): DropCatalog {
  if (!value || typeof value !== 'object') return parseDrops(value, items, enemies.map(enemy => enemy.id));
  let byItems = parsedDropCatalogs.get(value);
  if (!byItems) { byItems = new WeakMap(); parsedDropCatalogs.set(value, byItems); }
  let byEnemies = byItems.get(items);
  if (!byEnemies) { byEnemies = new WeakMap(); byItems.set(items, byEnemies); }
  let catalog = byEnemies.get(enemies);
  if (!catalog) {
    catalog = parseDrops(value, items, enemies.map(enemy => enemy.id));
    byEnemies.set(enemies, catalog);
  }
  return catalog;
}

export function parseDrops(value:unknown,items:ItemCatalog,enemyIds:readonly string[]):DropCatalog {
  if(!value||typeof value!=='object')throw new Error('掉落目录无效');
  const catalog=value as DropCatalog;
  if((catalog.version!==2&&catalog.version!==3)||!catalog.enemies||!catalog.pools||!catalog.equipment||!catalog.chests||!catalog.questItems)throw new Error('掉落目录版本或结构无效');
  const itemExists=(item:string|null|undefined)=>item===null||!!item&&!!items.items[item];
  for(const [enemyId,rules] of Object.entries(catalog.questItems)){
    if(!enemyIds.includes(enemyId)||!Array.isArray(rules)||rules.some(rule=>!rule||!items.items[rule.item]||
      !Number.isSafeInteger(rule.threshold)||rule.threshold<1||rule.threshold>100)||
      new Set(rules.map(rule=>rule.item)).size!==rules.length)throw new Error(`任务掉落无效：${enemyId}`);
  }
  for(const kind of ['weapon','armor','special','unique','epic'] as const){
    if(kind==='epic'&&catalog.version===2)continue;
    if(!Array.isArray(catalog.equipment[kind])||catalog.equipment[kind].some(choice=>
      !choice||typeof choice.item!=='string'||!items.items[choice.item]||
      (kind!=='special'&&items.items[choice.item].category!=='equipment')||
      !Number.isSafeInteger(choice.dropLevel)||choice.dropLevel<1))
      throw new Error(`装备掉落池无效：${kind}`);
  }
  if(catalog.epicDrops){
    const epic=catalog.epicDrops;
    if(!Number.isSafeInteger(epic.enemyChance)||epic.enemyChance<0||epic.enemyChance>10000||
      !Number.isSafeInteger(epic.chestChance)||epic.chestChance<0||epic.chestChance>10000||
      !Array.isArray(catalog.equipment.epic)||!catalog.equipment.epic.length||
      new Set(catalog.equipment.epic.map(choice=>choice.item)).size!==catalog.equipment.epic.length)
      throw new Error('紫装掉落配置无效');
  }
  for(const enemyId of enemyIds.filter(id=>!['enemy-bush-1','enemy-jar-1','enemy-box-1'].includes(id))) {
    const rule=catalog.enemies[enemyId];
    if(!rule||!Number.isSafeInteger(rule.level)||rule.level<1||!catalog.pools[rule.pool]||!Number.isSafeInteger(rule.rolls)||rule.rolls<1||rule.rolls>3)throw new Error(`敌人掉落规则缺失：${enemyId}`);
    for(const kind of chanceKinds)if(!Number.isSafeInteger(rule.chances[kind])||rule.chances[kind]<0)throw new Error(`敌人掉率无效：${enemyId}.${kind}`);
    if(!Array.isArray(rule.fixed)||rule.fixed.some(choice=>!itemExists(choice.item)||!Number.isSafeInteger(choice.weight)||choice.weight<1))throw new Error(`固定掉落无效：${enemyId}`);
    if(rule.fixed.length&&rule.fixed.reduce((sum,entry)=>sum+entry.weight,0)!==1000)throw new Error(`固定掉落权重无效：${enemyId}`);
    if(rule.noNormalDrops!==undefined&&typeof rule.noNormalDrops!=='boolean')throw new Error(`敌人无掉落标志无效：${enemyId}`);
    if(rule.paidDropEligible!==undefined&&typeof rule.paidDropEligible!=='boolean')throw new Error(`敌人付费掉落标志无效：${enemyId}`);
  }
  for(const kind of ['ordinary','improved','boss'] as const){
    const rule=catalog.chests[kind];
    if(kind==='boss'&&!rule)continue;
    if(!rule||!catalog.pools[rule.pool]||rule.rolls!==(kind==='ordinary'?1:3)||!rule.chances||
      chanceKinds.some(slot=>!Number.isSafeInteger(rule.chances[slot])||rule.chances[slot]<0)||
      !Array.isArray(rule.fixed)||rule.fixed.length||!rule.uniqueChance||
      !Number.isSafeInteger(rule.uniqueChance.numerator)||rule.uniqueChance.numerator<0||
      !Number.isSafeInteger(rule.uniqueChance.levelOffset)||rule.uniqueChance.levelOffset<1||
      (rule.spawn&&(!enemyIds.includes(rule.spawn.enemyId)||!Number.isSafeInteger(rule.spawn.chance)||rule.spawn.chance<0)))
      throw new Error(`宝箱掉落规则无效：${kind}`);
  }
  for(const [kind,rule] of Object.entries(catalog.breakables??{})){
    if(!['bush','jar','box','fortunate-box'].includes(kind)||!rule||!catalog.pools[rule.pool]||rule.rolls!==1||
      !rule.chances||chanceKinds.some(slot=>!Number.isSafeInteger(rule.chances[slot])||rule.chances[slot]<0)||
      !rule.uniqueChance||!Number.isSafeInteger(rule.uniqueChance.numerator)||rule.uniqueChance.numerator<0||
      !Number.isSafeInteger(rule.uniqueChance.levelOffset)||rule.uniqueChance.levelOffset<1||
      (rule.spawn&&(!enemyIds.includes(rule.spawn.enemyId)||!Number.isSafeInteger(rule.spawn.chance)||rule.spawn.chance<0)))
      throw new Error(`景物掉落规则无效：${kind}`);
  }
  for(const [name,pool] of Object.entries(catalog.pools))for(const kind of poolKinds)for(const choice of pool[kind]??[]) {
    if(!Number.isSafeInteger(choice.weight)||choice.weight<1||choice.weight>10000||
       (!!choice.tiers===!!Object.hasOwn(choice,'item'))||
       (choice.tiers ? !choice.tiers.length||choice.tiers.some(tier=>!itemExists(tier.item)||!Number.isSafeInteger(tier.level)||tier.level<0) : !itemExists(choice.item)))
      throw new Error(`随机掉落池无效：${name}.${kind}`);
  }
  for(const [name,pool] of Object.entries(catalog.pools))for(const kind of poolKinds){
    if((pool[kind]??[]).reduce((sum,choice)=>sum+choice.weight,0)>10000)throw new Error(`随机掉落权重无效：${name}.${kind}`);
  }
  if(catalog.version===3){
    if(!catalog.rarityProfiles||!catalog.chapterBands?.length||!catalog.pity)throw new Error('掉落目录缺少 v3 配置');
    const rate=(pair?:{stepPermille:number;capPermille:number})=>!!pair&&Number.isSafeInteger(pair.stepPermille)
      &&pair.stepPermille>=0&&pair.stepPermille<=10000&&Number.isSafeInteger(pair.capPermille)
      &&pair.capPermille>=0&&pair.capPermille<=10000&&pair.stepPermille<=pair.capPermille;
    const pity=catalog.pity;
    const guarantee=(pair?:{guaranteeAfter?:unknown})=>!!pair&&Number.isSafeInteger(pair.guaranteeAfter)&&(pair.guaranteeAfter as number)>=1;
    if(!rate(pity.equipment)||!rate(pity.unique)||!rate(pity.epic)||
      !guarantee(pity.unique)||!guarantee(pity.epic)||
      !Number.isSafeInteger(pity.levelWindow)||pity.levelWindow<0||
      typeof pity.bossGuarantee?.equipment!=='boolean'||!Number.isSafeInteger(pity.bossGuarantee.minRarity)||
      pity.bossGuarantee.minRarity<0||pity.bossGuarantee.minRarity>4)throw new Error('保底配置无效');
    for(const [name,weights] of Object.entries(catalog.rarityProfiles))
      if(!Array.isArray(weights)||weights.length!==5||weights.some(value=>!Number.isSafeInteger(value)||value<0))
        throw new Error(`稀有度权重无效：${name}`);
    let nextLevel=1;
    for(const band of catalog.chapterBands){
      if(band.minLevel!==nextLevel||band.maxLevel<band.minLevel||band.maxItemLevel<1||
        band.rarityScale.length!==5||band.rarityScale.some(value=>!Number.isSafeInteger(value)||value<0)||
        !Number.isSafeInteger(band.luck)||band.luck<0)
        throw new Error(`章节带无效：${band.id}`);
      for(const profile of Object.values(band.profiles))if(!catalog.rarityProfiles[profile])throw new Error(`章节带引用未知稀有度：${profile}`);
      nextLevel=band.maxLevel+1;
    }
    for(const [owner,rule] of Object.entries(catalog.chests))
      if((rule.rarityProfile&&!catalog.rarityProfiles[rule.rarityProfile])||
        (rule.minRarity!==undefined&&(!Number.isSafeInteger(rule.minRarity)||rule.minRarity<0||rule.minRarity>4)))
        throw new Error(`宝箱稀有度无效：${owner}`);
  }
  if(catalog.reservedDrops)validateReservedDrops(catalog.reservedDrops,items);
  const filtered={...filterReservedDrops(catalog,blockedNormalAcquisitionIds(items))};
  filtered.uniqueWeapons=filtered.equipment.unique.filter(choice=>items.items[choice.item]?.equipment?.slot==='main-hand');
  filtered.itemCatalog=items;
  return filtered;
}

function validateReservedDrops(config:ReservedDropConfig,items:ItemCatalog):void {
  const blocked=reservedAcquisitionIds(items);
  if(config.version!==1||!config.sources||!config.pity||!Array.isArray(config.entries))throw new Error('保留掉落配置无效');
  for(const source of ['elite','boss'] as const){
    const rate=config.sources[source];
    if(!rate||!Number.isSafeInteger(rate.chancePer10000)||rate.chancePer10000<0||rate.chancePer10000>10000)
      throw new Error(`保留掉落概率无效：${source}`);
  }
  if(!Number.isSafeInteger(config.pity.unlockGuaranteeAfter)||config.pity.unlockGuaranteeAfter<1)
    throw new Error('保留掉落保底无效');
  const seen=new Set<string>();
  for(const entry of config.entries){
    if(!entry||typeof entry.item!=='string'||!items.items[entry.item]||!blocked.has(entry.item))
      throw new Error(`保留掉落物品无效：${String(entry?.item)}`);
    if(seen.has(entry.item))throw new Error(`保留掉落物品重复：${entry.item}`);
    seen.add(entry.item);
    if(!Number.isSafeInteger(entry.minPlayerLevel)||entry.minPlayerLevel<1||entry.minPlayerLevel>105||
      !Number.isSafeInteger(entry.maxPlayerLevel)||entry.maxPlayerLevel<entry.minPlayerLevel||entry.maxPlayerLevel>105)
      throw new Error(`保留掉落等级无效：${entry.item}`);
    if(!Array.isArray(entry.sources)||!entry.sources.length||new Set(entry.sources).size!==entry.sources.length||
      entry.sources.some(source=>source!=='elite'&&source!=='boss'))
      throw new Error(`保留掉下来源无效：${entry.item}`);
    if(!Number.isSafeInteger(entry.weight)||entry.weight<1||entry.weight>10000)
      throw new Error(`保留掉落权重无效：${entry.item}`);
    if(typeof entry.once!=='boolean'||(entry.softMax!==undefined&&typeof entry.softMax!=='boolean'))
      throw new Error(`保留掉落标记无效：${entry.item}`);
  }
  if(blocked.size&&(seen.size!==blocked.size||[...blocked].some(item=>!seen.has(item))))
    throw new Error('保留掉落表必须覆盖全部保留道具');
}

/** 保留道具等待单独获取设计；解析后从所有随机掉落入口移除，池子权重保持原样。 */
function filterReservedDrops(catalog:DropCatalog,reserved:ReadonlySet<string>):DropCatalog {
  if(!reserved.size)return catalog;
  const filtered=structuredClone(catalog);
  for(const pool of Object.values(filtered.pools))for(const kind of poolKinds){
    const choices=pool[kind];if(!choices)continue;
    pool[kind]=choices.flatMap(choice=>{
      if(choice.item&&reserved.has(choice.item))return [];
      if(!choice.tiers)return [choice];
      const tiers=choice.tiers.filter(tier=>!tier.item||!reserved.has(tier.item));
      return tiers.length?[{...choice,tiers}]:[];
    });
  }
  for(const kind of ['weapon','armor','special','unique','epic'] as const)
    filtered.equipment[kind]=filtered.equipment[kind].filter(choice=>!reserved.has(choice.item));
  for(const rule of Object.values(filtered.enemies))
    rule.fixed=rule.fixed.filter(choice=>!reserved.has(choice.item));
  for(const rule of Object.values(filtered.chests))
    if(rule)rule.fixed=rule.fixed.filter(choice=>!reserved.has(choice.item));
  for(const rule of Object.values(filtered.breakables??{}))
    rule.fixed=rule.fixed.filter(choice=>!reserved.has(choice.item));
  for(const rules of Object.values(filtered.questItems))
    for(const rule of rules)
      if(reserved.has(rule.item))throw new Error(`任务掉落不能是保留道具：${rule.item}`);
  return filtered;
}

function draw(random:()=>number,max:number):number {
  const value=random();
  if(!Number.isFinite(value)||value<0||value>=1)throw new Error('掉落随机值无效');
  return Math.floor(value*max);
}

function success(base:number,monsterLevel:number,playerLevel:number,random:()=>number,bonus=0,itemChance=0):boolean {
  // 普通加成不能开启基础为 0 的槽位；保底/首杀的 10000 加值是明确的必中。
  if(!base&&bonus<DROP_CHANCE_UNIT)return false;
  const rate=Math.floor(Math.floor(2*base*monsterLevel/(monsterLevel+playerLevel))*(ITEM_CHANCE_PER_MILLE+itemChance)/ITEM_CHANCE_PER_MILLE);
  if(rate+bonus>=DROP_CHANCE_UNIT)return true;
  return rate>0&&draw(random,NATIVE_DROP_ROLL_MAX)+1<rate+bonus;
}

function pickPool(choices:readonly DropChoice[],level:number,random:()=>number):string|null|undefined {
  const roll=draw(random,10000);
  let weight=0;
  for(const choice of choices){
    weight+=choice.weight;
    if(roll>=weight)continue;
    if(!choice.tiers)return choice.item;
    return choice.tiers.find(tier=>tier.level<=level)?.item??choice.tiers.at(-1)?.item;
  }
  return undefined;
}

function pickEquipment(catalog:DropCatalog,level:number,random:()=>number,_maxItemLevel?:number):string|undefined {
  const classRoll=draw(random,100);
  const kind=classRoll<20?'weapon':classRoll<70?'armor':'special';
  return pickFromPool(catalog.equipment[kind],level,random)
    ?? pickFromPool([...catalog.equipment.weapon,...catalog.equipment.armor,...catalog.equipment.special],level,random);
}

function pickFromPool(pool:readonly {item:string;dropLevel:number}[],cap:number,random:()=>number):string|undefined {
  cap=Math.max(1,Math.min(105,cap));
  const options=pool.filter(choice=>choice.dropLevel>=Math.max(1,cap-15)&&choice.dropLevel<=cap);
  if(!options.length)return;
  return options[weightedIndex(options.map(choice=>choice.dropLevel>cap-5?3:1),random)]?.item;
}

function pickUnique(catalog:DropCatalog,cap:number,random:()=>number):string|undefined {
  return pickFromPool(catalog.equipment.unique,cap,random);
}

interface LegendaryReward {
  item:string;
  grade:EquipmentGradeSeed;
  sockets:boolean;
  unique:boolean;
}

function weightedIndex(weights:readonly number[],random:()=>number):number {
  const total=weights.reduce((sum,weight)=>sum+weight,0);
  let roll=draw(random,total);
  for(let index=0;index<weights.length;index+=1){
    roll-=weights[index]!;
    if(roll<0)return index;
  }
  return weights.length-1;
}

function pickLegendaryWeapon(catalog:DropCatalog,mapLevel:number,random:()=>number):string|undefined {
  return pickFromPool(catalog.equipment.weapon,mapLevel,random);
}

function uniqueLegendaryReward(catalog:DropCatalog,stats:CharacterStatsCatalog,mapLevel:number,random:()=>number):LegendaryReward|undefined {
  const item=pickFromPool(catalog.uniqueWeapons??[],mapLevel,random);
  if(!item)return undefined;
  const equipment=stats.equipment[item];
  const rolled=equipment?staticGrade(stats,equipment):undefined;
  if(!rolled)return undefined;
  return {item,grade:rolled,sockets:false,unique:true};
}

/** 原版 `ITEMSYSTEM_GenerateGrade` 模式 6 的基础分布。 */
function baseLegendaryReward(catalog:DropCatalog,stats:CharacterStatsCatalog,mapLevel:number,random:()=>number):LegendaryReward|undefined {
  const tier=weightedIndex([95,570,285,50],random);
  if(tier>=3)return undefined;
  const grade=tier===0?weightedIndex([383,233,134,250],random):
    tier===1?4+weightedIndex([300,500,200],random):
    7+weightedIndex([300,500,200],random);
  if(grade>=10)return undefined;
  if(grade===3)return uniqueLegendaryReward(catalog,stats,mapLevel,random);
  const item=pickLegendaryWeapon(catalog,mapLevel,random);
  if(!item)return undefined;
  const equipment=stats.equipment[item];
  if(!equipment?.gradeVariants?.length)return undefined;
  let index=grade;
  while(index>0&&!equipment.gradeVariants[index])index-=1;
  const variant=equipment.gradeVariants[index];
  if(!variant)return undefined;
  return {item,grade:{grade:index,gradeName:variant.name,attack:variant.attack,defense:variant.defense,optionCount:variant.optionCount,socketLimit:variant.socketLimit},sockets:true,unique:false};
}

/**
 * 组队技能 122「被选择的英雄」：原版把 30 点权重加到会被装备构造拒绝的 10 级档，
 * 和“传说装备 +3%”的描述对不上。体验版按描述实现：基础结果后再掷一次，
 * 普通装备或空手失败命中就升级为唯一物品；已经是唯一物品则不重复判定。
 */
export function rollLegendaryWeapon(catalog:DropCatalog,stats:CharacterStatsCatalog,mapLevel:number,random:()=>number,uniqueBonus=0):LegendaryReward|undefined {
  const base=baseLegendaryReward(catalog,stats,mapLevel,random);
  if(base?.unique)return base;
  const bonus=Math.max(0,Math.min(UNIQUE_BONUS_WEIGHT,uniqueBonus));
  if(bonus<=0)return base;
  if(draw(random,UNIQUE_BONUS_WEIGHT)<bonus)return uniqueLegendaryReward(catalog,stats,mapLevel,random)??base;
  return base;
}

function pickEpic(catalog:DropCatalog,cap:number,random:()=>number):string|undefined {
  return pickFromPool(catalog.equipment.epic,cap,random);
}

function itemLevelCap(level:number,_playerLevel:number,_maxItemLevel?:number):number {
  return Math.max(1,Math.min(level,105));
}

interface ReservedDropRollOptions {
  source:ReservedDropSource;
  heroLevel:number;
  sourceLevel?:number;
  pending?:ReadonlySet<string>;
  claimed?:ReadonlySet<string>;
  unlockMisses?:number;
  random?:()=>number;
}
interface ReservedDropRollResult {
  rewards:DropReward[];
  unlockMisses:number;
  forced:boolean;
  item?:string;
}

/**
 * 保留道具每次全队击杀只结算一次。装备及礼盒按怪物等级筛选，其他道具按主角等级筛选。
 */
export function rollReservedDrops(catalog:DropCatalog,stats:CharacterStatsCatalog,options:ReservedDropRollOptions):ReservedDropRollResult {
  const config=catalog.reservedDrops;
  const misses=options.unlockMisses??0;
  if(!config)return {rewards:[],unlockMisses:misses,forced:false};
  if(!Number.isSafeInteger(options.heroLevel)||options.heroLevel<1)throw new Error('保留掉落玩家等级无效');
  const pending=options.pending??new Set<string>();
  const claimed=options.claimed??new Set<string>();
  const level=Math.min(105,options.sourceLevel??options.heroLevel);
  const entryLevel=(entry:ReservedDropEntry)=>{
    const item=catalog.itemCatalog?.items[entry.item];
    const equipmentPack=item?.use?.kind==='pack'&&item.use.rewards?.some(reward=>catalog.itemCatalog?.items[reward.item]?.equipment);
    return item?.equipment||item?.use?.kind==='box'||equipmentPack?level:options.heroLevel;
  };
  const weight=(entry:ReservedDropEntry)=>entry.softMax&&entryLevel(entry)>entry.maxPlayerLevel?Math.max(1,Math.floor(entry.weight/5)):entry.weight;
  const candidates=config.entries.filter(entry=>entry.sources.includes(options.source)&&
    entryLevel(entry)>=entry.minPlayerLevel&&(entryLevel(entry)<=entry.maxPlayerLevel||entry.softMax===true)&&
    (()=>{
      const item=catalog.itemCatalog?.items[entry.item];
      if(!item)return true;
      const inRange=(value:number)=>value>=Math.max(1,level-15)&&value<=level;
      if(item.category==='equipment')return inRange(item.level);
      if(item.use?.kind==='box')return (item.use.rewards??[]).some(reward=>inRange(catalog.itemCatalog!.items[reward.item]?.level??0));
      if(item.use?.kind==='pack')return (item.use.rewards??[]).every(reward=>{
        const result=catalog.itemCatalog!.items[reward.item];
        return !result?.equipment||inRange(result.level);
      });
      return true;
    })()&&
    (!entry.once||(!claimed.has(entry.item)&&!pending.has(entry.item))));
  if(!candidates.length)return {rewards:[],unlockMisses:misses,forced:false};
  const unlockCandidates=candidates.filter(entry=>entry.once);
  const nextMisses=unlockCandidates.length?Math.min(config.pity.unlockGuaranteeAfter,misses+1):misses;
  const forced=unlockCandidates.length>0&&nextMisses>=config.pity.unlockGuaranteeAfter;
  const random=options.random??Math.random;
  if(!forced&&draw(random,10000)>=config.sources[options.source].chancePer10000)
    return {rewards:[],unlockMisses:nextMisses,forced:false};
  const pool=forced?unlockCandidates:candidates;
  const index=weightedIndex(pool.map(weight),random);
  if(index<0)return {rewards:[],unlockMisses:nextMisses,forced};
  const entry=pool[index]!;
  const equipment=stats.equipment[entry.item];
  const grade=equipment?staticGrade(stats,equipment):undefined;
  const lootLevel=catalog.itemCatalog?.items[entry.item]?.use?.kind==='box'?level:undefined;
  const reward:DropReward={kind:'item',item:entry.item,quantity:1,...(grade?{roll:{...grade,sockets:false}}:{}),...(lootLevel?{lootLevel}:{})};
  return {rewards:[reward],unlockMisses:nextMisses,forced,item:entry.item};
}

interface SpecialDropEligibility { cap:number; withinWindow:boolean; unique:boolean; epic:boolean }

/**
 * 黄装/紫装的候选范围按来源等级决定，withinWindow 决定本次是否累计保底。
 */
export function specialDropEligibility(catalog:DropCatalog,playerLevel:number,contentLevel:number,chapterLevel:number):SpecialDropEligibility {
  const band=chapterBand(catalog,chapterLevel);
  const cap=itemLevelCap(contentLevel,playerLevel,band?.maxItemLevel);
  const withinWindow=!catalog.pity||contentLevel>=playerLevel-catalog.pity.levelWindow;
  const unique=catalog.equipment.unique.some(choice=>choice.dropLevel>=Math.max(1,cap-15)&&choice.dropLevel<=cap);
  const epicDrops=catalog.epicDrops;
  const epic=!!epicDrops&&
    Array.isArray(catalog.equipment.epic)&&catalog.equipment.epic.some(choice=>choice.dropLevel>=Math.max(1,cap-15)&&choice.dropLevel<=cap);
  return {cap,withinWindow,unique,epic};
}

/** One task item at most, using the native inclusive 1..99 roll and strict threshold. */
export function rollQuestDrops(catalog:DropCatalog,enemyId:string,quests:readonly (readonly QuestDropRequirement[])[],random:()=>number=Math.random):DropReward[] {
  const rules=catalog.questItems[enemyId]??[];
  for(const goals of quests)for(const goal of goals){
    const rule=rules.find(rule=>rule.item===goal.item);
    if(!rule||rule.threshold<1)continue;
    if(goal.owned<goal.quantity&&draw(random,99)+1<rule.threshold)return [{kind:'item',item:goal.item,quantity:1}];
    break;
  }
  return [];
}

/** 景物掉落和宝箱共用属性目录：装备奖励要写入品级快照，不能只按纯规则返回值。 */
/**
 * 容器（宝箱、可破坏物）按自身等级结算。
 *
 * 原版公式 `2×基础×容器等级/(容器等级+玩家等级)` 会让高等级玩家开低等级容器时
 * 把所有槽位压到接近 0，满级角色在早期地图实际只能开出空箱。体验版把参与容器
 * 结算的玩家等级封顶到容器等级；敌人掉落仍保留原版的等级修正。
 */
function containerScaleLevel(level:number,playerLevel:number):number {
  return level>0?Math.min(playerLevel,level):playerLevel;
}

export function rollBreakableLoot(catalog:DropCatalog,stats:CharacterStatsCatalog,kind:BreakableKind,level:number,
  playerLevel:number,random:()=>number=Math.random,modifiers:DropModifiers={},options:{equipmentBonus?:number}={}):ChestOpenResult {
  if(!Number.isSafeInteger(level)||level<0||level>255)throw new Error('景物掉落等级无效');
  const selected=kind==='box'&&modifiers['chest-quality']&&draw(random,NATIVE_PERCENT_ROLL_MAX)+1<=FORTUNATE_BOX_MAX_ROLL?'fortunate-box':kind;
  const rule=catalog.breakables?.[selected];
  if(!rule)throw new Error('景物掉落规则缺失');
  const band=chapterBand(catalog,level);
  const eligibility=specialDropEligibility(catalog,playerLevel,level,level);
  return rollDropRule(catalog,{...rule,level,chances:{...rule.chances,
    unique:Math.floor(rule.uniqueChance.numerator/(level+rule.uniqueChance.levelOffset))}},containerScaleLevel(level,playerLevel),random,rule.spawn,modifiers,
    {stats,profile:profileFor(catalog,band,'normal',rule.minRarity,rule.rarityProfile),maxItemLevel:band?.maxItemLevel,
      equipmentBonus:options.equipmentBonus,
      epic:selected==='fortunate-box'&&eligibility.epic&&catalog.epicDrops?{chance:catalog.epicDrops.chestChance}:undefined,
      epicCap:eligibility.cap});
}

/** 首杀保底只在配置显式打开时生效；关闭时仍由普通 pity 计算加成。 */
export function firstBossGuarantee(pity:PityConfig|undefined,firstDefeat:boolean):{equipmentBonus:number;minRarity?:number} {
  if(!firstDefeat||!pity?.bossGuarantee.equipment)return {equipmentBonus:0};
  return {equipmentBonus:DROP_CHANCE_UNIT,minRarity:pity.bossGuarantee.minRarity};
}

interface LootContext {
  stats: CharacterStatsCatalog;
  profile: GradeProfile;
  maxItemLevel?: number;
  equipmentBonus?: number;
  uniqueBonus?: number;
  /** 下一次黄装槽是否必中。 */
  uniqueGuarantee?: boolean;
  /** v3 敌人：每个击杀只判定一次黄装槽。 */
  uniqueOncePerKill?: boolean;
  /** v3 黄装的物品等级上限；不传时沿用旧的 min(level,maxItemLevel)。 */
  uniqueCap?: number;
  /** 独立紫装判定；没有该字段时紫装路径关闭。 */
  epic?: { chance:number; bonus?:number; guaranteed?:boolean };
  epicCap?: number;
  /** 队伍物品掉率乘数（千分比），只放大槽位命中率。 */
  itemChance?: number;
}

const equipmentOf=(context:LootContext|undefined,item:string|undefined)=>item?context?.stats?.equipment?.[item]:undefined;

/** 装备实例的品级快照：随机装备按稀有度抽，固定/unique 用静态品级。 */
function gradeFor(context:LootContext|undefined,item:string|undefined,random:()=>number,sockets:boolean,staticOnly=false):DropRoll|undefined {
  const equipment=equipmentOf(context,item);
  if(!context?.stats||!equipment?.gradeVariants)return undefined;
  const rolled=staticOnly?staticGrade(context.stats,equipment):rollGrade(context.stats,equipment,context.profile,random);
  return rolled?{...rolled,sockets}:undefined;
}

function rollDropRule(catalog:DropCatalog,rule:EnemyDropRule,playerLevel:number,random:()=>number,spawn?:ChestDropRule['spawn'],modifiers:DropModifiers={},loot?:LootContext):ChestOpenResult {
  const result:ChestOpenResult={rewards:[],enemies:[]};
  const add=(item:string|null|undefined,sockets=true,staticOnly=false)=>{
    if(!item)return;
    const roll=gradeFor(loot,item,random,sockets,staticOnly);
    if(roll){
      const previous=result.rewards.findIndex(reward=>reward.kind==='item'&&!!reward.roll);
      if(previous>=0){
        const old=result.rewards[previous];
        if(old.kind==='item'&&old.roll&&old.roll.rarity>=roll.rarity)return;
        result.rewards.splice(previous,1);
      }
    }
    result.rewards.push({kind:'item',item,quantity:1,...(roll?{roll}:{})});
  };
  const level=rule.level,pool=catalog.pools[rule.pool];
  const epicCap=loot?.epicCap??itemLevelCap(level,playerLevel,loot?.maxItemLevel);
  const uniqueCap=loot?.uniqueCap??Math.min(level,105);
  const uniqueOnce=loot?.uniqueOncePerKill??false;
  for(let repeat=0;repeat<rule.rolls;repeat++)for(const kind of chanceKinds){
    if(repeat>0&&(kind==='equipment'||kind==='unique'))continue;
    // 宝箱怪位于材料槽之后、稀有装备槽之前，保留原表随机抽取次序。
    if(kind==='unique'&&spawn&&success(spawn.chance,level,playerLevel,random))result.enemies.push(spawn.enemyId);
    // v3 敌人：黄装槽每个击杀只判定第一轮，避免三连怪重复吃黄装概率。
    if(kind==='unique'&&uniqueOnce&&repeat>0)continue;
    const baseBonus=kind==='equipment'?modifiers['equipment-drop']:kind==='upgrade'?modifiers['scroll-drop']:kind==='crafting'?modifiers['material-drop']:0;
    const uniqueExtra=kind==='unique'
      ?(uniqueOnce?(repeat===0?(loot?.uniqueBonus??0)+(loot?.uniqueGuarantee?DROP_CHANCE_UNIT:0):0):(loot?.uniqueBonus??0))
      :0;
    const bonus=(baseBonus??0)+(kind==='equipment'?loot?.equipmentBonus??0:kind==='unique'?uniqueExtra:0);
    if(!success(rule.chances[kind],level,kind==='equipment'||kind==='unique'?level:playerLevel,random,bonus??0,loot?.itemChance??0))continue;
    if(kind==='money'){
      const percent=50+draw(random,51);
      result.rewards.push({kind:'money',amount:moneyGain(Math.max(1,3+Math.floor(4*level*percent/500)))});
    }else if(kind==='equipment')add(pickEquipment(catalog,level,random,loot?.maxItemLevel),true,false);
    else if(kind==='unique')add(pickUnique(catalog,uniqueCap,random),false,true);
    else if(kind==='fixed'){
      const roll=draw(random,FIXED_DROP_WEIGHT_TOTAL);let sum=0;
      for(const choice of rule.fixed){sum+=choice.weight;if(roll<sum){add(choice.item,false,true);break;}}
    }else add(pickPool(pool[kind]??[],level,random));
  }
  // 独立紫装判定：每个击杀/每次开箱最多一次，放在普通 8 槽循环之后。
  if(loot?.epic&&!result.rewards.some(reward=>reward.kind==='item'&&reward.roll?.rarity===RARITY_EPIC)){
    const epic=loot.epic;
    if(epic.guaranteed||success(epic.chance,level,level,random,epic.bonus??0,loot.itemChance??0))
      add(pickEpic(catalog,epicCap,random),false,true);
  }
  return result;
}

/** 章节带：按物品等级找到稀有度缩放与装备等级上限。 */
export function chapterBand(catalog:DropCatalog,level:number):ChapterBand|undefined {
  return catalog.chapterBands?.find(band=>level>=band.minLevel&&level<=band.maxLevel);
}

function profileFor(catalog:DropCatalog,band:ChapterBand|undefined,threat:'normal'|'elite'|'boss',minRarity?:number,explicit?:string):GradeProfile {
  const name=explicit??band?.profiles[threat]??'original';
  const weights=catalog.rarityProfiles?.[name]??catalog.rarityProfiles?.original??[1000,0,0,0,0];
  return {weights,rarityScale:band?.rarityScale,minRarity,maxGrade:MAX_RANDOM_EQUIPMENT_GRADE,luck:band?.luck};
}

/** 怪物掉落：来源等级决定装备范围，品级在掉落前生成。 */
interface EnemyLootOptions {
  sourceLevel?: number;
  firstDefeat?: boolean;
  /** 温和保底：装备槽的绝对加值（万分比）。 */
  equipmentBonus?: number;
  /** 温和保底：黄装槽的绝对加值。 */
  uniqueBonus?: number;
  /** 下一次合格击杀的黄装槽必中。 */
  uniqueGuarantee?: boolean;
  /** 温和保底：紫装判定的绝对加值。 */
  epicBonus?: number;
  /** 下一次合格击杀的紫装判定必中。 */
  epicGuarantee?: boolean;
  /** Boss 首杀/宝箱品质下限。 */
  minRarity?: number;
  /** 队伍物品掉率乘数（千分比），0 表示与基础掉率一致。 */
  itemChance?: number;
}
export function rollEnemyLoot(catalog:DropCatalog,stats:CharacterStatsCatalog,enemyId:string,playerLevel:number,chapterLevel:number,random:()=>number=Math.random,modifiers:DropModifiers={},options:EnemyLootOptions={}):ChestOpenResult {
  const original=catalog.enemies[enemyId];if(!original||original.noNormalDrops)return {rewards:[],enemies:[]};
  const rule={...original,level:options.sourceLevel??original.level};
  const band=chapterBand(catalog,Math.min(rule.level,105));
  const eligibility=specialDropEligibility(catalog,playerLevel,rule.level,chapterLevel);
  const epic=eligibility.epic&&catalog.epicDrops
    ?{chance:catalog.epicDrops.enemyChance,bonus:options.epicBonus,guaranteed:options.epicGuarantee}
    :undefined;
  const result=rollDropRule(catalog,rule,playerLevel,random,undefined,modifiers,
    {stats,profile:profileFor(catalog,band,rule.threat??'normal',options.minRarity),maxItemLevel:band?.maxItemLevel,
      equipmentBonus:options.equipmentBonus,
      uniqueBonus:eligibility.unique?options.uniqueBonus:undefined,
      uniqueGuarantee:eligibility.unique&&options.uniqueGuarantee,
      uniqueOncePerKill:!!catalog.pity?.unique,
      uniqueCap:catalog.pity?.unique?eligibility.cap:undefined,
      epic,epicCap:eligibility.cap,itemChance:options.itemChance});
  if(options.firstDefeat&&!options.epicGuarantee){
    const candidates=rule.fixed.filter(choice=>!!catalog.itemCatalog?.items[choice.item]?.equipment);
    if(candidates.length){
      const item=candidates[weightedIndex(candidates.map(choice=>choice.weight),random)]!.item;
      const equipment=stats.equipment[item];
      const grade=equipment?staticGrade(stats,equipment):undefined;
      if(grade){
        result.rewards=result.rewards.filter(reward=>reward.kind!=='item'||!reward.roll);
        result.rewards.push({kind:'item',item,quantity:1,roll:{...grade,sockets:false}});
      }
    }
  }
  return result;
}

/** 宝箱掉落：有效等级由地图导出时补齐，品质下限只影响装备槽成功后的品级。 */
export function rollChestLoot(catalog:DropCatalog,stats:CharacterStatsCatalog,kind:ChestKind,level:number,playerLevel:number,random:()=>number=Math.random,modifiers:DropModifiers={},options:{equipmentBonus?:number}={}):ChestOpenResult {
  if(!Number.isSafeInteger(level)||level<1||level>255)throw new Error('宝箱掉落等级无效');
  const rule=catalog.chests[kind];if(!rule)throw new Error(`宝箱掉落规则缺失：${kind}`);
  const band=chapterBand(catalog,level);
  const scaledPlayer=containerScaleLevel(level,playerLevel);
  const eligibility=specialDropEligibility(catalog,scaledPlayer,level,level);
  return rollDropRule(catalog,{...rule,level,chances:{...rule.chances,
    unique:Math.floor(rule.uniqueChance.numerator/(level+rule.uniqueChance.levelOffset))}},scaledPlayer,random,rule.spawn,modifiers,
    {stats,profile:profileFor(catalog,band,'normal',rule.minRarity,rule.rarityProfile),maxItemLevel:band?.maxItemLevel,
      equipmentBonus:options.equipmentBonus,
      epic:eligibility.epic&&catalog.epicDrops?{chance:catalog.epicDrops.chestChance}:undefined,
      epicCap:eligibility.cap});
}

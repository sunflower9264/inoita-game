import type { ItemCatalog, ItemInstance } from './items.ts';
import type { ChestKind } from './content.ts';
import type { CharacterStatsCatalog, EquipmentGradeSeed } from './character-stats.ts';
import { rollGrade, staticGrade, type GradeProfile } from './equipment-grade.ts';
import { moneyGain } from './economy.ts';
import type { LootPityConfig } from './loot-pity.ts';

type DropCategory = 'consumable' | 'upgrade' | 'crafting' | 'misc';
type DropChance = 'money' | 'equipment' | DropCategory | 'unique' | 'fixed';
/** Absolute additions to the native 1..9999 roll, after level scaling. */
export type DropModifiers = Partial<Record<'equipment-drop'|'scroll-drop'|'material-drop'|'chest-quality',number>>;
export const BREAKABLE_ENEMY_IDS = {
  bush: 'enemy-bush-1',
  jar: 'enemy-jar-1',
  box: 'enemy-box-1'
} as const;
export type BreakableKind = keyof typeof BREAKABLE_ENEMY_IDS;
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
  chances:Record<DropChance,number>;
  fixed:{item:string;weight:number}[];
}
export interface ChapterBand {
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
export interface EpicDropsConfig {
  minLevel:number;
  enemyChance:number;
  chestChance:number;
}
export interface QuestItemDropRule { item:string; threshold:number }
export interface QuestDropRequirement { item:string; quantity:number; owned:number }
export interface DropCatalog {
  version:2|3;
  questItems:Record<string,QuestItemDropRule[]>;
  chests:Record<'ordinary'|'improved',ChestDropRule>&{boss?:ChestDropRule};
  breakables?:Record<BreakableKind|'fortunate-box',ChestDropRule>;
  enemies:Record<string,EnemyDropRule>;
  pools:Record<string,Partial<Record<DropCategory,DropChoice[]>>>;
  equipment:Record<'weapon'|'armor'|'special'|'unique'|'epic',{item:string;dropLevel:number}[]>;
  rarityProfiles?:Record<string,number[]>;
  chapterBands?:ChapterBand[];
  pity?:PityConfig;
  epicDrops?:EpicDropsConfig;
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
  | {kind:'item';item:string;quantity:1;instance?:ItemInstance;roll?:DropRoll}
  | {kind:'money';amount:number};
const chanceKinds:readonly DropChance[]=['money','equipment','consumable','upgrade','crafting','misc','unique','fixed'];
const poolKinds:readonly DropCategory[]=['consumable','upgrade','crafting','misc'];

/** The source files are parsed offline; the game only sees named enemies and items. */
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
    if(!Number.isSafeInteger(epic.minLevel)||epic.minLevel<1||epic.minLevel>255||
      !Number.isSafeInteger(epic.enemyChance)||epic.enemyChance<0||epic.enemyChance>10000||
      !Number.isSafeInteger(epic.chestChance)||epic.chestChance<0||epic.chestChance>10000||
      !Array.isArray(catalog.equipment.epic)||!catalog.equipment.epic.length||
      new Set(catalog.equipment.epic.map(choice=>choice.item)).size!==catalog.equipment.epic.length||
      catalog.equipment.epic.some(choice=>choice.dropLevel<epic.minLevel))
      throw new Error('紫装掉落配置无效');
  }
  for(const enemyId of enemyIds.filter(id=>!['enemy-bush-1','enemy-jar-1','enemy-box-1'].includes(id))) {
    const rule=catalog.enemies[enemyId];
    if(!rule||!Number.isSafeInteger(rule.level)||rule.level<1||!catalog.pools[rule.pool]||!Number.isSafeInteger(rule.rolls)||rule.rolls<1||rule.rolls>3)throw new Error(`敌人掉落规则缺失：${enemyId}`);
    for(const kind of chanceKinds)if(!Number.isSafeInteger(rule.chances[kind])||rule.chances[kind]<0)throw new Error(`敌人掉率无效：${enemyId}.${kind}`);
    if(!Array.isArray(rule.fixed)||rule.fixed.some(choice=>!itemExists(choice.item)||!Number.isSafeInteger(choice.weight)||choice.weight<1))throw new Error(`固定掉落无效：${enemyId}`);
    if(rule.fixed.length&&rule.fixed.reduce((sum,entry)=>sum+entry.weight,0)!==1000)throw new Error(`固定掉落权重无效：${enemyId}`);
    if(rule.noNormalDrops!==undefined&&typeof rule.noNormalDrops!=='boolean')throw new Error(`敌人无掉落标志无效：${enemyId}`);
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
  return catalog;
}

function draw(random:()=>number,max:number):number {
  const value=random();
  if(!Number.isFinite(value)||value<0||value>=1)throw new Error('掉落随机值无效');
  return Math.floor(value*max);
}

function success(base:number,monsterLevel:number,playerLevel:number,random:()=>number,bonus=0,itemChance=0):boolean {
  // 普通加成不能开启基础为 0 的槽位；保底/首杀的 10000 加值是明确的必中。
  if(!base&&bonus<10000)return false;
  const rate=Math.floor(Math.floor(2*base*monsterLevel/(monsterLevel+playerLevel))*(1000+itemChance)/1000);
  if(rate+bonus>=10000)return true;
  return rate>0&&draw(random,9999)+1<rate+bonus;
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

function pickEquipment(catalog:DropCatalog,level:number,random:()=>number,maxItemLevel?:number):string|undefined {
  const lowest=level<10?1:Math.max(1,Math.floor(level*3/10));
  const first=lowest+draw(random,level-lowest+1);
  const second=lowest+draw(random,level-lowest+1);
  const cap=maxItemLevel??level;
  const top=Math.min(Math.floor((first+second)/2)+2,cap);
  const bottom=Math.max(1,Math.max(top,6)-5);
  const classRoll=draw(random,100);
  const kind=classRoll<20?'weapon':classRoll<70?'armor':'special';
  const inWindow=(choice:{dropLevel:number})=>choice.dropLevel>=bottom&&choice.dropLevel<=top;
  let options=catalog.equipment[kind].filter(inWindow);
  // 某个类别在这个等级窗口没有候选（武器池有断档）时，换到任意装备类别；
  // 仍然没有就取最接近窗口上限的一件，不能因为类别掷点让成功的槽位掉空。
  if(!options.length)options=(['weapon','armor','special'] as const).flatMap(name=>catalog.equipment[name].filter(inWindow));
  if(!options.length){
    const nearest=[...catalog.equipment.weapon,...catalog.equipment.armor,...catalog.equipment.special]
      .filter(choice=>choice.dropLevel<=cap).sort((left,right)=>Math.abs(left.dropLevel-top)-Math.abs(right.dropLevel-top));
    if(!nearest.length)return;
    return nearest[0]!.item;
  }
  return options[draw(random,options.length)]?.item;
}

function pickFromPool(pool:readonly {item:string;dropLevel:number}[],cap:number,random:()=>number):string|undefined {
  const options=pool.filter(choice=>choice.dropLevel<=cap);
  if(!options.length)return;
  return options[draw(random,options.length)]?.item;
}

function pickUnique(catalog:DropCatalog,cap:number,random:()=>number):string|undefined {
  return pickFromPool(catalog.equipment.unique,cap,random);
}

export interface LegendaryReward {
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
  if(mapLevel<1)return undefined;
  const lowBase=mapLevel<10?1:Math.floor(mapLevel*157287/262144);
  const span=mapLevel-lowBase+1;
  const first=lowBase+draw(random,span),second=lowBase+draw(random,span);
  const base=Math.max(6,Math.trunc((first+second)/2));
  const low=base-5,high=base+2;
  const options=catalog.equipment.weapon.filter(choice=>choice.dropLevel>=low&&choice.dropLevel<=high);
  if(options.length)return options[draw(random,options.length)]?.item;
  const nearest=[...catalog.equipment.weapon].sort((left,right)=>Math.abs(left.dropLevel-base)-Math.abs(right.dropLevel-base));
  return nearest[0]?.item;
}

function uniqueLegendaryReward(catalog:DropCatalog,stats:CharacterStatsCatalog,mapLevel:number,random:()=>number):LegendaryReward|undefined {
  const item=pickUnique(catalog,mapLevel,random);
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
  const bonus=Math.max(0,Math.min(1000,uniqueBonus));
  if(bonus<=0)return base;
  if(draw(random,1000)<bonus)return uniqueLegendaryReward(catalog,stats,mapLevel,random)??base;
  return base;
}

function pickEpic(catalog:DropCatalog,cap:number,random:()=>number):string|undefined {
  return pickFromPool(catalog.equipment.epic,cap,random);
}

function itemLevelCap(level:number,playerLevel:number,maxItemLevel?:number):number {
  return Math.max(1,Math.min(level,playerLevel,maxItemLevel??level));
}

export interface SpecialDropEligibility { cap:number; withinWindow:boolean; unique:boolean; epic:boolean }

/**
 * 黄装/紫装的等级与保底资格。cap 是物品等级上限：人物、内容、章节上限三者取小。
 * 池内没有候选时对应资格为 false，调用方不判定、不累计、不触发硬保底。
 */
export function specialDropEligibility(catalog:DropCatalog,playerLevel:number,contentLevel:number,chapterLevel:number):SpecialDropEligibility {
  const band=chapterBand(catalog,chapterLevel);
  const cap=itemLevelCap(contentLevel,playerLevel,band?.maxItemLevel);
  const withinWindow=!catalog.pity||contentLevel>=playerLevel-catalog.pity.levelWindow;
  const unique=withinWindow&&catalog.equipment.unique.some(choice=>choice.dropLevel<=cap);
  const epicDrops=catalog.epicDrops;
  const epic=!!epicDrops&&withinWindow&&playerLevel>=epicDrops.minLevel&&cap>=epicDrops.minLevel&&
    Array.isArray(catalog.equipment.epic)&&catalog.equipment.epic.some(choice=>choice.dropLevel<=cap);
  return {cap,withinWindow,unique,epic};
}

/** One call per defeated map enemy. A returned item can be empty after a successful pool roll. */
export function rollEnemyDrops(catalog:DropCatalog,enemyId:string,playerLevel:number,random:()=>number=Math.random,modifiers:DropModifiers={}):DropReward[] {
  const rule=catalog.enemies[enemyId];if(!rule||rule.noNormalDrops)return [];
  return rollDropRule(catalog,rule,playerLevel,random,undefined,modifiers).rewards;
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
  const selected=kind==='box'&&modifiers['chest-quality']&&draw(random,999)+1<=49?'fortunate-box':kind;
  const rule=catalog.breakables?.[selected];
  if(!rule)throw new Error('景物掉落规则缺失');
  const band=chapterBand(catalog,level);
  return rollDropRule(catalog,{...rule,level,chances:{...rule.chances,
    unique:Math.floor(rule.uniqueChance.numerator/(level+rule.uniqueChance.levelOffset))}},containerScaleLevel(level,playerLevel),random,rule.spawn,modifiers,
    {stats,profile:profileFor(catalog,band,'normal',rule.minRarity,rule.rarityProfile),maxItemLevel:band?.maxItemLevel,
      equipmentBonus:options.equipmentBonus});
}

/** 首杀保底只在配置显式打开时生效；关闭时仍由普通 pity 计算加成。 */
export function firstBossGuarantee(pity:PityConfig|undefined,firstDefeat:boolean):{equipmentBonus:number;minRarity?:number} {
  if(!firstDefeat||!pity?.bossGuarantee.equipment)return {equipmentBonus:0};
  return {equipmentBonus:10000,minRarity:pity.bossGuarantee.minRarity};
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
    result.rewards.push({kind:'item',item,quantity:1,...(roll?{roll}:{})});
  };
  const level=rule.level,pool=catalog.pools[rule.pool];
  const epicCap=loot?.epicCap??itemLevelCap(level,playerLevel,loot?.maxItemLevel);
  const uniqueCap=loot?.uniqueCap??Math.min(level,loot?.maxItemLevel??level);
  const uniqueOnce=loot?.uniqueOncePerKill??false;
  for(let repeat=0;repeat<rule.rolls;repeat++)for(const kind of chanceKinds){
    // 宝箱怪位于材料槽之后、稀有装备槽之前，保留原表随机抽取次序。
    if(kind==='unique'&&spawn&&success(spawn.chance,level,playerLevel,random))result.enemies.push(spawn.enemyId);
    // v3 敌人：黄装槽每个击杀只判定第一轮，避免三连怪重复吃黄装概率。
    if(kind==='unique'&&uniqueOnce&&repeat>0)continue;
    const baseBonus=kind==='equipment'?modifiers['equipment-drop']:kind==='upgrade'?modifiers['scroll-drop']:kind==='crafting'?modifiers['material-drop']:0;
    const uniqueExtra=kind==='unique'
      ?(uniqueOnce?(repeat===0?(loot?.uniqueBonus??0)+(loot?.uniqueGuarantee?10000:0):0):(loot?.uniqueBonus??0))
      :0;
    const bonus=(baseBonus??0)+(kind==='equipment'?loot?.equipmentBonus??0:kind==='unique'?uniqueExtra:0);
    if(!success(rule.chances[kind],level,playerLevel,random,bonus??0,loot?.itemChance??0))continue;
    if(kind==='money'){
      const percent=50+draw(random,51);
      result.rewards.push({kind:'money',amount:moneyGain(Math.max(1,3+Math.floor(4*level*percent/500)))});
    }else if(kind==='equipment')add(pickEquipment(catalog,level,random,loot?.maxItemLevel),true,false);
    else if(kind==='unique')add(pickUnique(catalog,uniqueCap,random),false,true);
    else if(kind==='fixed'){
      const roll=draw(random,1000);let sum=0;
      for(const choice of rule.fixed){sum+=choice.weight;if(roll<sum){add(choice.item,false,true);break;}}
    }else add(pickPool(pool[kind]??[],level,random));
  }
  // 独立紫装判定：每个击杀/每次开箱最多一次，放在普通 8 槽循环之后。
  if(loot?.epic&&!result.rewards.some(reward=>reward.kind==='item'&&reward.roll?.rarity===4)){
    const epic=loot.epic;
    if(epic.guaranteed||success(epic.chance,level,playerLevel,random,epic.bonus??0,loot.itemChance??0))
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
  return {weights,rarityScale:band?.rarityScale,minRarity,maxGrade:9,luck:band?.luck};
}

/** 怪物掉落：基础槽位判定与原版一致，槽位成功后按稀有度/章节/品级生成实例快照。 */
export interface EnemyLootOptions {
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
  const rule=catalog.enemies[enemyId];if(!rule||rule.noNormalDrops)return {rewards:[],enemies:[]};
  const band=chapterBand(catalog,chapterLevel);
  const eligibility=specialDropEligibility(catalog,playerLevel,rule.level,chapterLevel);
  const epic=eligibility.epic&&catalog.epicDrops
    ?{chance:catalog.epicDrops.enemyChance,bonus:options.epicBonus,guaranteed:options.epicGuarantee}
    :undefined;
  return rollDropRule(catalog,rule,playerLevel,random,undefined,modifiers,
    {stats,profile:profileFor(catalog,band,rule.threat??'normal',options.minRarity),maxItemLevel:band?.maxItemLevel,
      equipmentBonus:options.equipmentBonus,
      uniqueBonus:eligibility.unique?options.uniqueBonus:undefined,
      uniqueGuarantee:eligibility.unique&&options.uniqueGuarantee,
      uniqueOncePerKill:!!catalog.pity?.unique,
      uniqueCap:catalog.pity?.unique?eligibility.cap:undefined,
      epic,epicCap:eligibility.cap,itemChance:options.itemChance});
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

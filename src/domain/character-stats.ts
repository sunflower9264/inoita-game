import { equipmentLevel, type EquipmentChaos } from './chaos-equipment.ts';
import type { ItemNotice } from './item-application.ts';
import { boundedHealth } from './status-hud.ts';
import { Bag, type BagRules } from './bag.ts';
import type { ItemCatalog, ItemInstance } from './items.ts';
import { calculateEffectiveDefense,calculateMagicResistance } from './physical-hit.ts';

export const PRIMARY_STATS = ['strength','dexterity','vitality','intelligence','mentality'] as const;
/** 装备没有写默认品级时使用的档位。 */
export const DEFAULT_EQUIPMENT_GRADE = 2;
export type PrimaryStat = typeof PRIMARY_STATS[number];
export type PrimaryAttributes = Record<PrimaryStat,number>;

/** 把按 PRIMARY_STATS 逐项算出的结果收回成固定字段的属性对象。 */
export function primaryAttributesFrom(source: Readonly<Record<string,number>>): PrimaryAttributes {
  return { strength:source.strength, dexterity:source.dexterity, vitality:source.vitality,
    intelligence:source.intelligence, mentality:source.mentality };
}
export interface Modifier { stat: string; value: number }
export interface ModifierRange { stat: string; min: number; max: number }
/** `bonusChance` 是「再升一级」判定阈值的加成，只有特级卷轴有（原版 `+0x12c`）。 */
export interface EnhancementRule { step: number; threshold: number; extra: number; bonusChance?: number }
export interface EquipmentGradeSeed {
  grade: number; gradeName: string; attack: number; defense: number; optionCount: number; socketLimit: number;
}
export interface EquipmentGradeVariant {
  attack: number; defense: number; name: string; rarity: number; optionCount: number; socketLimit: number;
}
export interface EquipmentNumbers {
  attack: number; defense: number; gradeName: string; magicPercent: number[];
  defaultGrade?: number; defaultRarity?: number; gradeVariants?: EquipmentGradeVariant[];
  criticalRate: number; hitBonus: number; magicAttackRate: number; shieldBlock: number;
  fixedOptions: ModifierRange[]; randomOptions: ModifierRange[]; optionCount: number;
  socketLimit: number; enhancementUses: number[]; fixedEnhancementUses:number|null;
}
export interface GradeDefinition { index: number; name: string; rarity: number; weight: number }
export interface CharacterStatsCatalog {
  maxLevel: number; statPointsPerLevel: number; skillPointsPerLevel: number;
  grades?: GradeDefinition[];
  experience: (number|null)[]; classes: Record<string,PrimaryAttributes>;
  modifiers: Record<string,{label:string;percent:boolean}>;
  equipment: Record<string,EquipmentNumbers>;
  gems: Record<string,ModifierRange[][]>;
  enchantments: Record<string,Record<string,EnhancementRule>>;
}
export interface ItemNumbers {
  baseAttack?: number; baseDefense?: number; gradeName?: string; grade?: number;
  modifiers: Modifier[]; gemModifiers: Modifier[]; magicPercent: number;
  sockets: number; enhancementUses: number; enhancementRule?: EnhancementRule;enhancementScroll?:string;
  chaos?: EquipmentChaos;
}
export interface CharacterPanel {
  attributes: PrimaryAttributes; maxHealth: number; maxMana: number;
  physicalAttack: number; magicAttack: number; criticalRate: number; hitRate: number;
  /** 装备与体力合计的原始防御；defense 保留面板上的有效防御。 */
  baseDefense:number;
  /** 装备魔抗的有符号合计，供战斗合并被动与Buff后再限制上界。 */
  baseMagicResistance:number;
  criticalDamage: number; defense: number; defenseRate:number; physicalResistance: number; magicResistance: number;
  evasionRate: number; weaponBlock: number; shieldBlock: number;
  /** 实际副手物品是盾；原版盾挡属性只在这种情况给出数值。 */
  offhandShield: boolean;
  hitBase:number; hitBonus:number; evasionBase:number; evasionBonus:number;
  criticalResistance:number; criticalDamageResistance:number;
}
const emptyAttributes = (): PrimaryAttributes => ({strength:0,dexterity:0,vitality:0,intelligence:0,mentality:0});
const trunc = Math.trunc;

/*
 * 面板公式与原版常量。依据 `work/findings/37_stat_engine.md:221-225` 与
 * `work/findings/character-stats-2026-10-09.md:39-47`，与代码逐项吻合。
 */
/** 千分比满额，同时是各加成式的分母。 */
const PER_MILLE=1000;
/** 武器类型给力量的加成率（千分比）：双手 700、长剑／斧／锤 600、其余武器 500。 */
const STRENGTH_RATE_TWO_HANDED=700,STRENGTH_RATE_MARTIAL=600,STRENGTH_RATE_OTHER=500;
/** 法杖与宝珠给智力的加成率（千分比）：法杖 600、宝珠 700，其余武器满额。 */
const INTELLIGENCE_RATE_STAFF=600,INTELLIGENCE_RATE_ORB=700;
/** 法杖与宝珠给精力的加成率（千分比），其余武器满额。 */
const MENTALITY_RATE_CASTING=600;
/** 敏捷对物攻的贡献折半。 */
const DEXTERITY_ATTACK_DIVISOR=2;
/** 最大生命 = 基础值 + 等级 × 每级 + 体力 × 每点。 */
const BASE_HEALTH=640,HEALTH_PER_LEVEL=72,HEALTH_PER_VITALITY=80;
/** 最大魔法的基础值，其余来自加成。 */
const BASE_MAX_MANA=200;
/** 命中基础 = 该系数 ×（敏捷 + 精力）。 */
const HIT_BASE_PER_POINT=4;
/** 回避加成与回避显示的千分比上限。 */
const RATE_CAP=750;
/** 默认暴击率、暴击伤害与武器格挡（千分比）。 */
const DEFAULT_CRITICAL_RATE=30,DEFAULT_CRITICAL_DAMAGE=1000,DEFAULT_WEAPON_BLOCK=30;
/** 命中显示 =（1000 × 命中基础 + 分子）/（命中基础 + 等级 + 偏移）+ 加成 + 常数项，千分比。 */
const HIT_NUMERATOR=20000,HIT_LEVEL_OFFSET=35,HIT_DISPLAY_BONUS=100;
/** 物理减伤 = 1000 × 防御 /（防御 + 每级权重 ×（等级 + 偏移）），千分比。 */
const DEFENSE_WEIGHT_PER_LEVEL=20,DEFENSE_LEVEL_OFFSET=3;
/** 回避显示 = min(750, 1000 + 加成 −（等级系数 × 等级 + 常数）/（每级除数 × 等级 + 敏捷 + 偏移））。 */
const EVASION_LEVEL_FACTOR=5000,EVASION_CONSTANT=1000000,EVASION_LEVEL_DIVISOR=5,EVASION_DEXTERITY_OFFSET=1200;

/*
 * 强化与镶嵌的原版常量。依据 `work/findings/enchant-2026-10-12.md:52-55` 与
 * `work/findings/character-stats-2026-10-09.md:67`。
 */
/** 判定区间上界：原版取 `MATH_GetRandom(1, 998)`，小于阈值即成功。 */
const ENHANCEMENT_ROLL_MAX=998;
const MAX_ENHANCEMENT_LEVEL=30;
/** 混沌卷轴第一次判定阈值 `T1 = 50000 / (10 + 等级²)`，失败降一级。 */
const CHAOS_CHANCE_NUMERATOR=50000,CHAOS_CHANCE_BASE=10;
/** 第二次判定阈值 `T2 = 1500 / (L + 6)`，L 已加一；通过再升一级。 */
const SECOND_CHANCE_NUMERATOR=1500,SECOND_CHANCE_OFFSET=5;
/** 开槽先过 80% 判断，再按权重依次累加决定孔数。 */
const SOCKET_CHANCE_PERCENT=80,SOCKET_WEIGHTS=[35,30,20,15];

/** 固定种子只决定物品实例的初次掷骰；重算面板不会重新生成词条。 */
function itemRandom(identity:string): (min:number,max:number)=>number {
  let seed=2166136261;
  for(const char of identity)seed=Math.imul(seed^char.charCodeAt(0),16777619)>>>0;
  return (min,max)=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return min+Math.floor(seed/4294967296*(max-min+1));};
}
export function equipmentPower(definition:EquipmentNumbers, entry:ItemInstance) {
  const rule=entry.numbers?.enhancementRule;
  const bonus=rule?entry.enhancement*rule.step+Math.max(0,entry.enhancement-rule.threshold+1)*rule.extra:0;
  const baseAttack=entry.numbers?.baseAttack??definition.attack,baseDefense=entry.numbers?.baseDefense??definition.defense;
  const rate=entry.numbers?.chaos?.valuePercent??100;
  const attack=baseAttack?(entry.numbers?.chaos?Math.max(1,trunc((baseAttack+bonus)*rate/100)):baseAttack+bonus):0;
  return {attack,magicAttack:trunc(attack*(entry.numbers?.magicPercent??0)/100),defense:baseDefense?trunc((baseDefense+bonus)*rate/100):0};
}

export function calculateCharacter(catalog:CharacterStatsCatalog, items:ItemCatalog, classId:string, level:number,
  allocated:PrimaryAttributes, equipped:Partial<Record<string,ItemInstance>>):CharacterPanel {
  const base=catalog.classes[classId];if(!base)throw new Error('职业数值不存在');
  const attributes=emptyAttributes();for(const key of PRIMARY_STATS)attributes[key]=base[key]+allocated[key];
  const bonuses:Record<string,number>={};let attack=0,magic=0,defense=0;
  const add=(key:string,value:number)=>{bonuses[key]=(bonuses[key]??0)+value;};
  for(const [slot,entry] of Object.entries(equipped)) {
    if(!entry)continue;const definition=catalog.equipment[entry.item];
    if(!definition)throw new Error('装备数值不存在');
    const power=equipmentPower(definition,entry);
    if(slot==='main-hand'){attack+=power.attack;magic+=power.magicAttack;}
    defense+=power.defense;
    for(const key of ['criticalRate','hitBonus','magicAttackRate','shieldBlock'] as const)add(key,definition[key]);
    for(const modifier of [...entry.numbers?.modifiers??[],...entry.numbers?.gemModifiers??[]]) {
      if(PRIMARY_STATS.includes(modifier.stat as PrimaryStat))attributes[modifier.stat as PrimaryStat]+=modifier.value;
      else add(modifier.stat,modifier.value);
    }
  }
  const main=equipped['main-hand'],weapon=main?items.items[main.item].kind:'unarmed';
  const strengthRate=weapon==='two-handed'?STRENGTH_RATE_TWO_HANDED:['longsword','axe','mace'].includes(weapon)?STRENGTH_RATE_MARTIAL:STRENGTH_RATE_OTHER;
  const intelligenceRate=weapon==='unarmed'?0:weapon==='staff'?INTELLIGENCE_RATE_STAFF:weapon==='orb'?INTELLIGENCE_RATE_ORB:PER_MILLE;
  const mentalityRate=weapon==='unarmed'?0:['staff','orb'].includes(weapon)?MENTALITY_RATE_CASTING:PER_MILLE;
  const bonusOf=(key:string)=>bonuses[key]??0;
  const physicalAttack=Math.max(0,trunc((attack+trunc(attributes.strength*strengthRate/PER_MILLE)+trunc(attributes.dexterity/DEXTERITY_ATTACK_DIVISOR))*(PER_MILLE+bonusOf('physicalAttackRate'))/PER_MILLE));
  const magicAttack=Math.max(0,trunc((magic+trunc(attributes.intelligence*intelligenceRate/PER_MILLE)+trunc(attributes.mentality*mentalityRate/PER_MILLE))*(PER_MILLE+bonusOf('magicAttackRate'))/PER_MILLE));
  const baseDefense=defense+attributes.vitality,defenseRate=bonusOf('defenseRate');
  defense=calculateEffectiveDefense(baseDefense,defenseRate);
  const hitBase=HIT_BASE_PER_POINT*(attributes.dexterity+attributes.mentality);
  return {attributes,maxHealth:BASE_HEALTH+HEALTH_PER_LEVEL*level+HEALTH_PER_VITALITY*attributes.vitality,maxMana:BASE_MAX_MANA+bonusOf('maxMana'),
    physicalAttack,magicAttack,hitBase,hitBonus:Math.max(0,bonusOf('hitBonus')),evasionBase:attributes.dexterity,
    evasionBonus:Math.max(0,Math.min(RATE_CAP,bonusOf('evasionBonus'))),
    criticalResistance:Math.max(0,bonusOf('criticalResistance')),criticalDamageResistance:Math.max(0,bonusOf('criticalDamageResistance')),
    criticalRate:Math.max(0,DEFAULT_CRITICAL_RATE+bonusOf('criticalRate')),
    hitRate:trunc((hitBase*PER_MILLE+HIT_NUMERATOR)/(hitBase+level+HIT_LEVEL_OFFSET))+Math.max(0,bonusOf('hitBonus'))+HIT_DISPLAY_BONUS,
    criticalDamage:Math.max(0,DEFAULT_CRITICAL_DAMAGE+bonusOf('criticalDamage')),baseDefense,defense,defenseRate,
    physicalResistance:trunc(PER_MILLE*defense/(defense+DEFENSE_WEIGHT_PER_LEVEL*(level+DEFENSE_LEVEL_OFFSET))),baseMagicResistance:bonusOf('magicResistance'),
    magicResistance:calculateMagicResistance(bonusOf('magicResistance')),
    evasionRate:Math.min(RATE_CAP,PER_MILLE+Math.max(0,Math.min(RATE_CAP,bonusOf('evasionBonus')))-trunc((EVASION_LEVEL_FACTOR*level+EVASION_CONSTANT)/(EVASION_LEVEL_DIVISOR*level+attributes.dexterity+EVASION_DEXTERITY_OFFSET))),
    weaponBlock:Math.max(0,DEFAULT_WEAPON_BLOCK+bonusOf('weaponBlock')),shieldBlock:Math.max(0,bonusOf('shieldBlock')),
    offhandShield:equipped['off-hand']!==undefined&&items.items[equipped['off-hand']!.item]?.kind==='shield'};
}

/** 主角的等级、已分配属性与物品实例，共同属于当前游戏会话。 */
export interface BattleCharacterState {
  level:number;
  allocation:PrimaryAttributes;
  health:number;
  mana:number;
  resourceLimits:{maxHealth:number;maxMana:number}|null;
  experience:number;
  bonusSkillPoints:number;
  spentSkillPoints:number;
}

export class BattleCharacter {
  readonly classId:string;
  readonly bag:Bag;
  readonly catalog:CharacterStatsCatalog;
  private currentLevel=1;
  private allocation=emptyAttributes();
  private health=0;
  private mana=0;
  private combatResourceLimits:{maxHealth:number;maxMana:number}|null=null;
  private experience=0;
  private bonusSkillPoints=0;
  private spentSkillPoints=0;
  private skillUseHandler?: (item:string,skill?:string)=>string|undefined;
  private listeners=new Set<()=>void>();
  /** 面板缓存：数值、装备或等级没变时，`hero.player` 不该每次都重算全套属性。 */
  private panelCache?:{bagRevision:number;level:number;panelRevision:number;panel:CharacterPanel};
  private panelRevision=0;
  constructor(classId:string,catalog:CharacterStatsCatalog,items:ItemCatalog) {
    if(!catalog.classes[classId])throw new Error('职业数值不存在');
    this.classId=classId;this.catalog=catalog;
    const rules:BagRules={
      initialize:(entry,drop)=>this.initializeItem(entry,drop),
      equipProblem:entry=>equipmentLevel(items.items[entry.item],entry)>this.level?`需要等级 ${equipmentLevel(items.items[entry.item],entry)}，当前等级 ${this.level}`:undefined,
      targetProblem:(source,target)=>this.targetProblem(source,target,items),
      enchant:(source,target,random)=>{
        const name=items.items[target.item].name,level=target.enhancement;
        // 混沌卷轴先判定成败，失败降一级且不再往下走（原版 0x1a7214–0x1a730c；阈值公式见 enchant-2026-10-12.md:52）。
        if(items.items[source.item].use?.requiresEnhanced&&!enhancementSucceeds(random,CHAOS_CHANCE_NUMERATOR/(CHAOS_CHANCE_BASE+level*level)))
          return {level:Math.max(0,level-1),message:`${name} 强化失败，降为 +${Math.max(0,level-1)}`};
        // 第二次判定对所有卷轴生效，通过再升一级（总 +2）；特级卷轴的阈值加 300。
        const raised=level+1,rule=catalog.enchantments[source.item]?.[items.items[target.item].kind];
        return enhancementSucceeds(random,SECOND_CHANCE_NUMERATOR/(raised+SECOND_CHANCE_OFFSET)+(rule?.bonusChance??0))
          ?{level:raised+1,message:`${name} 强化大成功 +${raised+1}`,notice:'enchant-double' as const}
          :{level:raised,message:`${name} 强化 +${raised}`};
      },
      applyUse:(source,target,skill)=>{
        const use=items.items[source.item].use!;
        if(use.kind==='enchant'&&target?.numbers){
          const rule=catalog.enchantments[source.item]?.[items.items[target.item].kind];
          target.numbers.enhancementRule??=rule;
          if(!use.requiresEnhanced){target.numbers.enhancementScroll??=source.item;target.numbers.enhancementUses--;}
        }
        if(use.kind==='socket'&&target?.numbers)target.numbers.gemModifiers.push(...source.numbers!.modifiers.map(m=>({...m})));
        return this.skillUseHandler?.(source.item,skill);
      }
    };
    this.bag=new Bag(()=>this.changed(),items,classId,'game',rules);
    this.refill();
  }
  captureState():BattleCharacterState {
    return structuredClone({level:this.currentLevel,allocation:this.allocation,health:this.health,mana:this.mana,
      resourceLimits:this.combatResourceLimits,experience:this.experience,bonusSkillPoints:this.bonusSkillPoints,spentSkillPoints:this.spentSkillPoints});
  }
  restoreState(state:BattleCharacterState):void {
    const restored=structuredClone(state);
    this.currentLevel=restored.level;this.allocation=restored.allocation;this.health=restored.health;this.mana=restored.mana;
    this.combatResourceLimits=restored.resourceLimits;this.experience=restored.experience;
    this.bonusSkillPoints=restored.bonusSkillPoints;this.spentSkillPoints=restored.spentSkillPoints;
    this.panelRevision++;
  }
  get level(){return this.currentLevel;}
  get allocated():PrimaryAttributes{return {...this.allocation};}
  get statPoints(){return (this.level-1)*this.catalog.statPointsPerLevel-Object.values(this.allocation).reduce((a,b)=>a+b,0);}
  get skillPoints(){return (this.level-1)*this.catalog.skillPointsPerLevel+this.bonusSkillPoints-this.spentSkillPoints;}
  setSkillUseHandler(handler:(item:string,skill?:string)=>string|undefined):void {this.skillUseHandler=handler;}
  spendSkillPoints(amount:number):void {
    if(!Number.isSafeInteger(amount)||amount<=0||amount>this.skillPoints)throw new Error('技能点不足');
    this.spentSkillPoints+=amount;this.changed();
  }
  grantSkillPoint():void {this.bonusSkillPoints++;this.changed();}
  resetSkillPoints():void {this.bonusSkillPoints=0;this.spentSkillPoints=0;this.changed();}
  get panel():CharacterPanel {
    const cached=this.panelCache;
    if(cached&&cached.bagRevision===this.bag.revision&&cached.level===this.currentLevel&&cached.panelRevision===this.panelRevision)return cached.panel;
    const panel=calculateCharacter(this.catalog,this.bag.catalog,this.classId,this.level,this.allocation,
      Object.fromEntries(Object.entries(this.bag.equipment).map(([slot,id])=>[slot,this.bag.get(id!)])));
    this.panelCache={bagRevision:this.bag.revision,level:this.currentLevel,panelRevision:this.panelRevision,panel};
    return panel;
  }
  get player(){const p=this.panel,limits=this.combatResourceLimits??p;return {level:this.level,health:this.health,maxHealth:limits.maxHealth,mana:this.mana,maxMana:limits.maxMana,experience:this.experience,nextLevelExperience:this.catalog.experience[this.level-1]??0};}
  subscribe(listener:()=>void):()=>void {this.listeners.add(listener);return ()=>{this.listeners.delete(listener);};}
  setHealth(value:number):void {this.health=boundedHealth(value,this.player.maxHealth);for(const listener of this.listeners)listener();}
  setMana(value:number):void {this.mana=boundedHealth(value,this.player.maxMana);for(const listener of this.listeners)listener();}
  setCombatResourceLimits(maxHealth:number,maxMana:number):void {
    const next={maxHealth:Math.max(0,Math.trunc(maxHealth)),maxMana:Math.max(0,Math.trunc(maxMana))};
    if(this.combatResourceLimits?.maxHealth===next.maxHealth&&this.combatResourceLimits.maxMana===next.maxMana)return;
    this.combatResourceLimits=next;
    for(const listener of this.listeners)listener();
  }
  setCombatResourceCapacity(key:'maxHealth'|'maxMana',value:number):void {
    const before=this.player,next=Math.max(0,Math.trunc(value));
    const current=key==='maxHealth'?this.health:this.mana,clamped=boundedHealth(current,next);
    if(before[key]===next&&current===clamped)return;
    this.combatResourceLimits={maxHealth:before.maxHealth,maxMana:before.maxMana,[key]:next};
    if(key==='maxHealth')this.health=clamped;else this.mana=clamped;
    for(const listener of this.listeners)listener();
  }
  clearCombatResourceLimits():void {if(this.combatResourceLimits){this.combatResourceLimits=null;this.changed();}}
  spendMana(cost:number):boolean {
    if(!Number.isSafeInteger(cost))throw new Error('技能消耗无效');
    if(this.mana<cost)return false;
    this.mana-=cost;for(const listener of this.listeners)listener();return true;
  }
  private changed(){this.panelRevision++;const p=this.player;this.health=Math.min(this.health,p.maxHealth);this.mana=Math.min(this.mana,p.maxMana);for(const listener of this.listeners)listener();}
  private refill(){const p=this.player;this.health=p.maxHealth;this.mana=p.maxMana;}
  recover():void {this.refill();this.changed();}
  addExperience(amount:number):number {
    if(!Number.isSafeInteger(amount)||amount<0)throw new Error('经验奖励无效');
    if(this.level>=this.catalog.maxLevel||amount===0)return 0;
    this.experience+=amount;
    let gained=0;
    while(this.level<this.catalog.maxLevel){
      const needed=this.catalog.experience[this.level-1]!;
      if(this.experience<needed)break;
      this.experience-=needed;this.currentLevel++;gained++;
    }
    if(this.level===this.catalog.maxLevel)this.experience=0;
    if(gained)this.refill();
    this.changed();return gained;
  }
  commitAllocation(delta:PrimaryAttributes):void {
    if(!delta||Object.keys(delta).length!==PRIMARY_STATS.length||
      PRIMARY_STATS.some(stat=>!Number.isSafeInteger(delta[stat])||delta[stat]<0))throw new Error('属性操作无效');
    const total=PRIMARY_STATS.reduce((sum,stat)=>sum+delta[stat],0);
    if(!Number.isSafeInteger(total)||total>this.statPoints)throw new Error('没有足够的能力点');
    if(total===0)return;
    for(const stat of PRIMARY_STATS)this.allocation[stat]+=delta[stat];
    this.changed();
  }
  allocate(stat:PrimaryStat,delta:1|-1):void {
    if(!PRIMARY_STATS.includes(stat)||(delta!==1&&delta!==-1))throw new Error('属性操作无效');
    if(delta===1&&this.statPoints<1)throw new Error('没有可分配的属性点');
    if(delta===-1&&this.allocation[stat]<1)throw new Error('该属性没有已分配的点数');
    this.allocation[stat]+=delta;this.changed();
  }
  resetAttributes():void {this.allocation=emptyAttributes();this.changed();}
  private initializeItem(entry:ItemInstance,drop?:{grade?:EquipmentGradeSeed;sockets?:boolean}):void {
    const random=itemRandom(`battle:${this.classId}:${entry.item}:${entry.id}`);
    const roll=(range:ModifierRange):Modifier=>({stat:range.stat,value:random(range.min,range.max)});
    const definition=this.catalog.equipment[entry.item],gem=this.catalog.gems[entry.item];
    if(!definition&&!gem)return;
    const numbers:ItemNumbers={modifiers:[],gemModifiers:[],magicPercent:0,sockets:0,enhancementUses:0};entry.numbers=numbers;
    if(gem){const choices=gem[random(0,gem.length-1)];numbers.modifiers=[roll(choices[random(0,choices.length-1)])];return;}
    entry.numbers=rollEquipmentNumbers(definition,random,drop?.sockets!==false,drop?.grade);
  }
  private targetProblem(source:ItemInstance,target:ItemInstance,items:ItemCatalog):ItemNotice|undefined {
    const use=items.items[source.item].use!,numbers=target.numbers;
    if(!numbers)return 'socket-incompatible';
    if(use.kind==='socket'&&target.gems.length>=numbers.sockets)return 'socket-full';
    if(use.kind==='enchant'){
      if(use.requiresEnhanced&&numbers.enhancementUses!==0)return 'enchant-chaos-durability';
      if(!use.requiresEnhanced&&numbers.enhancementUses<1)return 'enchant-durability';
      if(target.enhancement>=MAX_ENHANCEMENT_LEVEL)return 'enchant-max';
      const next=this.catalog.enchantments[source.item]?.[items.items[target.item].kind];
      if(!next)return 'enchant-rule';
      if(!use.requiresEnhanced&&numbers.enhancementScroll&&numbers.enhancementScroll!==source.item){
        // 原版只把顶级与特级配成一对可互换的同类卷轴（ITEMENCHANTBASE 19↔946 武器、24↔947 防具），其余必须沿用同一张。
        const original=items.items[numbers.enhancementScroll]?.use;
        const sameTierPair=!!original&&!original.maxLevel&&!original.requiresEnhanced&&original.target===use.target&&!use.maxLevel;
        if(!sameTierPair)return 'enchant-rule';
      }
      if(!use.requiresEnhanced&&numbers.enhancementRule&&['step','threshold','extra'].some(key=>numbers.enhancementRule![key as keyof EnhancementRule]!==next[key as keyof EnhancementRule]))return 'enchant-rule';
    }
    return undefined;
  }
}

/** Roll once; shop previews and owned copies share these resolved attributes. */
/** 原版的一次强化判定：`MATH_GetRandom(1, 998)` 小于阈值即成功（`0x1a7244`–`0x1a7258`）。 */
const enhancementSucceeds=(random:()=>number,threshold:number):boolean=>{
  const value=random();
  if(!Number.isFinite(value)||value<0||value>=1)throw new Error('随机结果无效');
  return 1+Math.floor(value*ENHANCEMENT_ROLL_MAX)<Math.trunc(threshold);
};

export function rollEquipmentNumbers(definition:EquipmentNumbers,random:(min:number,max:number)=>number,withSockets=true,grade?:EquipmentGradeSeed):ItemNumbers {
  const roll=(range:ModifierRange):Modifier=>({stat:range.stat,value:random(range.min,range.max)});
  const numbers:ItemNumbers={modifiers:[],gemModifiers:[],magicPercent:0,sockets:0,enhancementUses:0};
  numbers.grade=grade?.grade??definition.defaultGrade??DEFAULT_EQUIPMENT_GRADE;numbers.gradeName=grade?.gradeName??definition.gradeName;
  if(grade){numbers.baseAttack=grade.attack;numbers.baseDefense=grade.defense;}
  numbers.magicPercent=trunc((random(definition.magicPercent[0],definition.magicPercent[1])+random(definition.magicPercent[0],definition.magicPercent[1]))/2);
  numbers.enhancementUses=definition.fixedEnhancementUses??random(...definition.enhancementUses as [number,number])+random(...definition.enhancementUses as [number,number])+1;
  numbers.modifiers=definition.fixedOptions.map(roll);
  const choices=[...definition.randomOptions];
  const optionCount=grade?.optionCount??definition.optionCount;
  for(let i=0;i<optionCount&&choices.length;i++)numbers.modifiers.push(roll(choices.splice(random(0,choices.length-1),1)[0]));
  if(withSockets&&random(0,99)<SOCKET_CHANCE_PERCENT){
    const roll=random(0,99);let threshold=0;
    const socketLimit=grade?.socketLimit??definition.socketLimit;
    for(let i=0;i<socketLimit;i++){threshold+=SOCKET_WEIGHTS[i];if(roll<threshold){numbers.sockets=i+1;break;}}
  }
  return numbers;
}

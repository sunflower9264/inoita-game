import { boundedHealth } from './status-hud.ts';
import { calculateCharacter, experienceAfterReward, previewGemPanel, PRIMARY_STATS, primaryAttributesFrom, type CharacterPanel, type CharacterStatsCatalog, type Modifier, type PrimaryAttributes, type BattleCharacter } from './character-stats.ts';
import type { SkillConfigurationState } from './skill-configuration.ts';
import { CompanionSkillProgression, generateCompanion, MERCENARY_CLASS_ORDER, randomInteger, weightedIndex, type CompanionGenerationRules, type CompanionGroupEffect, type CompanionGroupSkill, type GeneratedCompanion, type MercenarySkillPoints } from './companion-progression.ts';
export type { CompanionGroupEffect } from './companion-progression.ts';
const MERCENARY_SLOT_COUNT=18;
/** 普通复活卷轴只恢复一成生命和法力。 */
const REVIVE_RECOVERY_RATE=0.1;
import type { ItemCatalog, ItemResult } from './items.ts';
import type { Bag } from './bag.ts';
import type { BattleCatalog } from './battle.ts';
import { emptyShortcutRow } from './shortcut-bar.ts';
import type { SpringPartyResources } from './springs.ts';

export interface CompanionDefinition {
  defaultShield?:boolean;
  id: string;
  name: string;
  actor: string;
  classId: string;
  elite: boolean;
  source?: 'mercenary' | 'story';
  quality?: number;
  recruitable?: boolean;
  fixedSkills?: string[];
}
export const PARTY_SKILL_USES = ['heal','defend','control','damage','buff','summon'] as const;
export type PartySkillUse = typeof PARTY_SKILL_USES[number];

export interface CompanionCatalog {
  definitions: Record<string,CompanionDefinition>;
  /** Each row is a level's five base attributes, from level 1 through 105. */
  growth: Record<string,PrimaryAttributes[]>;
  generation: CompanionGenerationRules;
  groupSkills:Record<CompanionGroupEffect,CompanionGroupSkill>;
  autoSkills:Record<string,{uses:PartySkillUse[]}>;
}
export interface PartySnapshot {
  active: readonly string[];
  living:readonly string[];
  rosterSlots:readonly (string|null)[];
  reserves: readonly string[];
  controlled: string;
  members: readonly CompanionSnapshot[];
}
/** HUD 只读上阵队员的轻量快照；不包含名册、技能和成长等菜单字段。 */
interface PartyActiveMember {
  id: string;
  level: number;
  health: number;
  maxHealth: number;
  mana: number;
  maxMana: number;
  experience: number;
  nextLevelExperience: number;
}
export interface PartyActiveSnapshot {
  active: readonly string[];
  living: readonly string[];
  controlled: string;
  members: readonly PartyActiveMember[];
}
interface CompanionSnapshot {
  id: string;
  definitionId: string;
  skillLevels:Record<string,number>;
  skillCaps:Record<string,number>;
  groupSkills:readonly CompanionGroupEffect[];
  quality:number;
  name: string;
  classId: string;
  source: 'story' | 'mercenary';
  elite: boolean;
  level: number;
  health: number;
  maxHealth: number;
  mana: number;
  maxMana: number;
  experience: number;
  nextLevelExperience: number;
}
interface CompanionState {
  id:string;definitionId:string;source:'story'|'mercenary';generated:GeneratedCompanion;
  level:number;health:number;mana:number;experience:number;skills:SkillConfigurationState;
  combatResourceLimits:{maxHealth:number;maxMana:number}|null;
  aiFrequency:[string,number][];
  allocationBaseLevel?:number; allocation?:PrimaryAttributes;
  skillBookLevels?:Record<string,number>;
  unlockedSkills?:Record<string,number>;
  skillPoints?:MercenarySkillPoints;
}
interface PartyState {
  members:CompanionState[];rosterSlots:(string|null)[];slots:(string|null)[];selected:string;serial:number;
  heroAiFrequency:[string,number][];
  /** 当前存档永久开放的佣兵技能，现有和未来同职业佣兵共用。 */
  sharedUnlockedSkills:string[];
}


export class CompanionMember {
  readonly id:string;
  readonly definition:CompanionDefinition;
  readonly source:'story'|'mercenary';
  readonly skills:CompanionSkillProgression;
  readonly generated:GeneratedCompanion;
  readonly aiFrequency=new Map<string,number>();
  private readonly stats:CharacterStatsCatalog;
  private readonly items:ItemCatalog;
  readonly bag:Bag;
  private readonly growth:PrimaryAttributes[];
  private readonly changed:()=>void;
  /** 升级后通知名册推进修订号；直接调用 `addExperience` 的调试入口也会走到这里。 */
  private readonly onLevelUp?:()=>void;
  private readonly bonusSkillPointsPerLevel?:()=>number;
  private currentLevel:number;
  private allocationBaseLevel=1;
  private allocation:PrimaryAttributes=primaryAttributesFrom({strength:0,dexterity:0,vitality:0,intelligence:0,mentality:0});
  private currentHealth=0;
  private currentMana=0;
  private currentExperience=0;
  private combatResourceLimits:{maxHealth:number;maxMana:number}|null=null;
  constructor(id:string,definition:CompanionDefinition,source:'story'|'mercenary',level:number,
    stats:CharacterStatsCatalog,items:ItemCatalog,bag:Bag,growth:PrimaryAttributes[],changed:()=>void,generated:GeneratedCompanion,
    training:CompanionGenerationRules['training'],onLevelUp?:()=>void,battleCatalog?:BattleCatalog,bonusSkillPointsPerLevel?:()=>number){
    if(!stats.classes[definition.classId]||growth.length<stats.maxLevel)throw new Error('伙伴职业成长数据缺失');
    this.id=id;this.definition=definition;this.source=source;this.stats=stats;this.items=items;this.bag=bag;
    this.growth=growth;this.changed=changed;this.onLevelUp=onLevelUp;this.bonusSkillPointsPerLevel=bonusSkillPointsPerLevel;this.currentLevel=Math.min(stats.maxLevel,Math.max(1,level));
    this.generated=structuredClone(generated);this.skills=new CompanionSkillProgression(generated.skillCaps,training,source==='mercenary'?{
      classId:definition.classId,catalog:battleCatalog,pointsPerLevel:stats.skillPointsPerLevel,changed,
      clearShortcuts:()=>bag.setShortcuts(id,emptyShortcutRow()),
    }:undefined);
    this.skills.updateLevel(this.currentLevel);
    this.currentHealth=this.panel.maxHealth;this.currentMana=this.panel.maxMana;
  }
  get classId():string{return this.definition.classId;}
  get level():number{return this.currentLevel;}
  get allocated():PrimaryAttributes{return {...this.allocation};}
  get statPoints():number{return this.source==='mercenary'?(this.level-this.allocationBaseLevel)*this.stats.statPointsPerLevel-PRIMARY_STATS.reduce((n,k)=>n+this.allocation[k],0):0;}
  commitAllocation(delta:PrimaryAttributes):void {
    if(this.source!=='mercenary'||PRIMARY_STATS.some(k=>!Number.isSafeInteger(delta[k])||delta[k]<0)||PRIMARY_STATS.reduce((n,k)=>n+delta[k],0)>this.statPoints)throw new Error('能力点不足');
    for(const k of PRIMARY_STATS)this.allocation[k]+=delta[k];this.panelCache=undefined;this.changed();
  }
  resetAttributes():void {if(this.source!=='mercenary')return;this.allocationBaseLevel=1;this.allocation=primaryAttributesFrom({strength:0,dexterity:0,vitality:0,intelligence:0,mentality:0});this.panelCache=undefined;this.currentHealth=boundedHealth(this.currentHealth,this.player.maxHealth);this.currentMana=boundedHealth(this.currentMana,this.player.maxMana);this.changed();}
  private get effectiveAllocation():PrimaryAttributes{
    const base=this.stats.classes[this.definition.classId],total=this.growth[(this.source==='mercenary'?this.allocationBaseLevel:this.currentLevel)-1]!;
    return primaryAttributesFrom(Object.fromEntries(PRIMARY_STATS.map(stat=>[stat,total[stat]-2*base[stat]+this.generated.baseAttributes[stat]+(this.source==='mercenary'?this.allocation[stat]:0)])));
  }
  private panelCache?:{revision:number;level:number;panel:CharacterPanel};
  get panel():CharacterPanel{
    // 战斗每个逻辑帧会多次读面板（技能频率、HP/MP 上限）；只在等级或背包实例变化时重算。
    const cached=this.panelCache;
    if(cached&&cached.revision===this.bag.revision&&cached.level===this.currentLevel)return cached.panel;
    const allocated=this.effectiveAllocation;
    const equipped=this.bag.equipmentFor(this.id);
    const panel=calculateCharacter(this.stats,this.items,this.definition.classId,this.currentLevel,allocated,
      Object.fromEntries(Object.entries(equipped).map(([slot,item])=>[slot,this.bag.get(item!)])));
    this.panelCache={revision:this.bag.revision,level:this.currentLevel,panel};
    return panel;
  }
  /** 预览把目标的宝石词条换成 `gemModifiers` 后的面板；目标未穿戴且没有空槽时返回 undefined。 */
  previewGemChange(targetId:string,gemModifiers:Modifier[]):CharacterPanel|undefined {
    const equipped=this.bag.equipmentFor(this.id),worn=Object.values(equipped).includes(targetId);
    const emptySlot=worn?undefined:this.bag.emptyEquipSlot(targetId,this.id,this.definition.classId,this.currentLevel);
    if(!worn&&!emptySlot)return undefined;
    return previewGemPanel({catalog:this.stats,items:this.items,classId:this.definition.classId,level:this.currentLevel,
      allocated:this.effectiveAllocation,equipped,bag:this.bag,targetId,gemModifiers,emptySlot});
  }
  get player(){const panel=this.panel,limits=this.combatResourceLimits??panel;return {level:this.level,health:this.currentHealth,maxHealth:limits.maxHealth,
    mana:this.currentMana,maxMana:limits.maxMana,experience:this.currentExperience,
    nextLevelExperience:this.stats.experience[this.level-1]??0};}
  get alive():boolean{return this.currentHealth>0;}
  setHealth(value:number):void{this.currentHealth=boundedHealth(value,this.player.maxHealth);this.changed();}
  setMana(value:number):void{this.currentMana=boundedHealth(value,this.player.maxMana);this.changed();}
  spendMana(cost:number):boolean{
    if(!Number.isSafeInteger(cost))throw new Error('技能消耗无效');
    if(this.currentMana<cost)return false;this.currentMana-=cost;this.changed();return true;
  }
  setCombatResourceLimits(maxHealth:number,maxMana:number):void{
    const health=Math.max(0,Math.trunc(maxHealth)),mana=Math.max(0,Math.trunc(maxMana));
    if(this.combatResourceLimits?.maxHealth===health&&this.combatResourceLimits.maxMana===mana)return;
    this.combatResourceLimits={maxHealth:health,maxMana:mana};this.changed();
  }
  setCombatResourceCapacity(key:'maxHealth'|'maxMana',value:number):void{
    const before=this.player,next=Math.max(0,Math.trunc(value));
    const current=key==='maxHealth'?this.currentHealth:this.currentMana,clamped=boundedHealth(current,next);
    if(before[key]===next&&current===clamped)return;
    this.combatResourceLimits={maxHealth:before.maxHealth,maxMana:before.maxMana,[key]:next};
    if(key==='maxHealth')this.currentHealth=clamped;else this.currentMana=clamped;
    this.changed();
  }
  clearCombatResourceLimits():void{this.combatResourceLimits=null;this.currentHealth=boundedHealth(this.currentHealth,this.panel.maxHealth);this.currentMana=boundedHealth(this.currentMana,this.panel.maxMana);this.changed();}
  recover():void{this.currentHealth=this.player.maxHealth;this.currentMana=this.player.maxMana;this.changed();}
  addExperience(amount:number):number {
    const next=experienceAfterReward(this.stats,this.currentLevel,this.currentExperience,amount);
    if(!next)return 0;
    this.currentLevel=next.level;this.currentExperience=next.experience;
    if(next.gained){
      this.skills.updateLevel(next.level);
      const extra=this.bonusSkillPointsPerLevel?.()??0;
      if(Number.isSafeInteger(extra)&&extra>0)this.skills.grantBonusPoints(next.gained*extra);
      this.onLevelUp?.();
    }
    if(next.gained&&this.alive)this.recover();else this.changed();
    return next.gained;
  }
  snapshot():CompanionSnapshot{const player=this.player;return {id:this.id,definitionId:this.definition.id,
    skillLevels:this.skills.skillLevels(),skillCaps:{...this.generated.skillCaps},groupSkills:[...this.generated.groupSkills],quality:this.definition.quality??0,
    name:this.definition.name,classId:this.definition.classId,source:this.source,elite:this.definition.elite,...player};}
  captureState():CompanionState{return structuredClone({id:this.id,definitionId:this.definition.id,source:this.source,
    generated:this.generated,level:this.currentLevel,health:this.currentHealth,mana:this.currentMana,experience:this.currentExperience,
    combatResourceLimits:this.combatResourceLimits,skills:this.skills.captureState(),aiFrequency:[...this.aiFrequency],allocationBaseLevel:this.allocationBaseLevel,allocation:this.allocation,skillBookLevels:this.skills.bookState(),unlockedSkills:this.skills.unlockedState(),skillPoints:this.skills.pointsState()});}
  restoreState(state:CompanionState):void{
    this.allocationBaseLevel=state.allocationBaseLevel??state.level;this.allocation=state.allocation??primaryAttributesFrom({strength:0,dexterity:0,vitality:0,intelligence:0,mentality:0});this.panelCache=undefined;
    this.currentLevel=state.level;this.currentHealth=state.health;this.currentMana=state.mana;this.currentExperience=state.experience;
    this.combatResourceLimits=state.combatResourceLimits?{...state.combatResourceLimits}:null;this.skills.restoreBooks(state.skillBookLevels??{},this.currentLevel);this.skills.restoreUnlocked(state.unlockedSkills??{});this.skills.restorePoints(state.skillPoints);this.skills.restoreState(state.skills);
    this.aiFrequency.clear();for(const [id,value] of state.aiFrequency)this.aiFrequency.set(id,value);
  }

}

/**
 * 在存活成员列表里找相邻的一个，越界回绕。
 * 当前操控者已经不在列表里（刚阵亡的瞬间）时，正向取第一个、反向取最后一个。
 */
export function adjacentLivingMember(ids: readonly string[], current: string, direction: -1 | 1): string | undefined {
  if (!ids.length) return undefined;
  const index = ids.indexOf(current);
  if (index < 0) return direction > 0 ? ids[0] : ids[ids.length - 1];
  return ids[(index + direction + ids.length) % ids.length];
}

/** One hero, up to two deployed companions, and an owned reserve roster. */
export class PartyRoster {
  readonly hero:BattleCharacter;
  readonly bag:Bag;
  readonly catalog:CompanionCatalog;
  private readonly battleCatalog?:BattleCatalog;
  private readonly bonusSkillPointsPerLevel?:()=>number;
  readonly heroAiFrequency=new Map<string,number>();
  private readonly stats:CharacterStatsCatalog;
  private readonly items:ItemCatalog;
  private readonly changed:()=>void;
  private readonly onMemberRemoved?:(id:string)=>void;
  private readonly onRecruited?:(sourceItem:string,memberId:string)=>void;
  /** 招募会同时改名册、背包和任务事实，由会话层提供的 `atomic` 包成一次全成全退。 */
  private readonly atomic?:<T>(operation:()=>T)=>T;
  private readonly owned=new Map<string,CompanionMember>();
  private readonly sharedUnlockedSkills=new Set<string>();
  private slots:(string|undefined)[]=[undefined,undefined];
  private selected='player';
  private serial=0;
  private rosterSlots:(string|null)[]=Array.from({length:MERCENARY_SLOT_COUNT},()=>null);
  private groupModifierVersionValue=0;
  /** 队伍成员或槽位写入的版本；供战斗层判断是否需要重新同步队友。 */
  private activeRevisionValue=0;
  private activeIdsCache?:readonly string[];
  /**
   * 队伍光环/组队被动的输入版本：只在成员加入、离队、成员升级和读档时推进。
   * 换位、切人、掉血/回蓝都不改变 `groupModifiers()` 的结果。
   */
  get groupModifierVersion():number{return this.groupModifierVersionValue;}
  constructor(hero:BattleCharacter,stats:CharacterStatsCatalog,items:ItemCatalog,catalog:CompanionCatalog,changed:()=>void,onMemberRemoved?:(id:string)=>void,
    onRecruited?:(sourceItem:string,memberId:string)=>void,atomic?:<T>(operation:()=>T)=>T,battleCatalog?:BattleCatalog,bonusSkillPointsPerLevel?:()=>number){
    this.hero=hero;this.bag=hero.bag;this.stats=stats;this.items=items;this.catalog=catalog;this.changed=changed;this.onMemberRemoved=onMemberRemoved;
    this.onRecruited=onRecruited;this.atomic=atomic;this.battleCatalog=battleCatalog;this.bonusSkillPointsPerLevel=bonusSkillPointsPerLevel;
  }

  hasSharedSkill(skill:string):boolean{return this.sharedUnlockedSkills.has(skill);}
  unlockSharedSkill(skill:string):void{
    if(!this.battleCatalog?.skills[skill]||!Object.values(this.items.classSkills).some(skills=>skills.includes(skill)))throw new Error('佣兵技能不存在');
    if(this.hasSharedSkill(skill))throw new Error('该技能已永久解锁');
    this.sharedUnlockedSkills.add(skill);
    for(const member of this.owned.values())this.applySharedSkills(member);
    this.changed();
  }
  private applySharedSkills(member:CompanionMember):void{
    if(member.source!=='mercenary'||!this.battleCatalog)return;
    const skills=this.items.classSkills[member.classId]??[];
    for(const id of this.sharedUnlockedSkills){
      if(skills.includes(id)&&!member.skills.available(id))member.skills.unlockSkill(id,this.battleCatalog);
    }
  }
  /** 成员集合或成员等级变化：组队被动版本推进。 */
  private bumpGroupModifiers():void{this.groupModifierVersionValue++;}
  get controlledId():string{return this.selected;}
  /** 队伍成员或槽位写入的版本；`create/remove/deploy/reserve/restoreState` 都会推进。 */
  get activeRevision():number{return this.activeRevisionValue;}
  /**
   * 上阵成员顺序：主角固定第一，其后是槽位 0、1。
   * 结果缓存成冻结数组，版本不变时所有调用方共用同一份；需要可变副本时请自行复制。
   */
  get activeIds():readonly string[]{
    const cached=this.activeIdsCache;
    if(cached)return cached;
    const value=Object.freeze(['player',...this.slots.filter((id):id is string=>!!id)]);
    this.activeIdsCache=value;return value;
  }
  private invalidateActiveIds():void{this.activeRevisionValue++;this.activeIdsCache=undefined;}
  /** 全部已拥有成员（含候补），供技能资源规划使用。 */
  ownedMembers():CompanionMember[]{return [...this.owned.values()];}
  /** 上阵队员的资源读写入口，顺序为主角、上阵槽；候补名册不在内。 */
  get activeMembers():SpringPartyResources[]{
    return this.activeIds.flatMap(id=>{
      if(id==='player'){const hero=this.hero;return [{id,get player(){return hero.player;},
        setHealth:(value:number)=>hero.setHealth(value),setMana:(value:number)=>hero.setMana(value),
        grantSkillPoint:()=>hero.grantSkillPoint()}];}
      const member=this.owned.get(id);
      // 槽位引用了已不在名册的成员时跳过，别把不变量错误变成读取 undefined 的 TypeError。
      if(!member)return [];
      return [{id,get player(){return member.player;},setHealth:(value:number)=>member.setHealth(value),setMana:(value:number)=>member.setMana(value)}];
    });
  }
  /**
   * 跟随站位：按当前操控者重新排左右，而不是沿用固定名册槽位。
   * 上阵顺序保持主角、槽位 0、槽位 1；去掉操控者后，剩下的跟随者一人一侧。
   * 主角不在名册槽里，跟随侧位不能由主角在 slots 中的位置决定。
   */
  followSlotOf(leaderId:string,id:string):0|1|undefined {
    const followers=this.activeIds.filter(active=>active!==leaderId);
    const index=followers.indexOf(id);
    return index<0?undefined:(index%2===0?0:1);
  }
  get livingIds():string[]{return this.activeIds.filter(id=>this.alive(id));}
  get activeSize():number{return this.activeIds.length;}
  get(id:string):CompanionMember|undefined{return this.owned.get(id);}
  aiFrequency(id:string):Map<string,number>{return id==='player'?this.heroAiFrequency:this.owned.get(id)?.aiFrequency??new Map();}
  setAiFrequency(id:string,skill:string,frequency:number):void{
    if(!Number.isInteger(frequency)||frequency<0||frequency>2)throw new Error('技能频率需要是 0–2');
    if(id!=='player'&&!this.owned.has(id))throw new Error('伙伴不存在');
    this.aiFrequency(id).set(skill,frequency);this.changed();
  }
  alive(id:string):boolean{return id==='player'?this.hero.player.health>0:this.owned.get(id)?.alive??false;}
  snapshot():PartySnapshot{const active=this.activeIds;return {active,living:this.livingIds,rosterSlots:[...this.rosterSlots],reserves:[...this.owned.keys()].filter(id=>!active.includes(id)),
    controlled:this.selected,members:[...this.owned.values()].map(member=>member.snapshot())};}
  /** HUD 只读上阵队员的轻量快照；不遍历候补名册，也不生成技能和成长字段。 */
  activeSnapshot():PartyActiveSnapshot {
    const active=this.activeIds,members:PartyActiveMember[]=[];
    for(const id of active){
      if(id==='player')continue;
      const member=this.owned.get(id);if(!member)continue;
      const values=member.player;
      members.push({id,level:values.level,health:values.health,maxHealth:values.maxHealth,
        mana:values.mana,maxMana:values.maxMana,experience:values.experience,
        nextLevelExperience:values.nextLevelExperience});
    }
    return {active,living:this.livingIds,controlled:this.selected,members};
  }
  private create(definition:CompanionDefinition,source:'story'|'mercenary',id:string,generated:GeneratedCompanion):CompanionMember{
    if(!this.catalog.growth[definition.classId])throw new Error('伙伴成长数据缺失');
    const member=new CompanionMember(id,definition,source,generated.level,this.stats,this.items,this.bag,
      this.catalog.growth[definition.classId],this.changed,generated,this.catalog.generation.training,()=>this.bumpGroupModifiers(),this.battleCatalog,this.bonusSkillPointsPerLevel);
    this.applySharedSkills(member);
    const gear=this.items.startingEquipment[definition.classId]??{},
      retired=source==='story'?this.bag.takeRetiredEquipment(id):undefined;
    try {
      // 剧情伙伴离队时装备退回背包并留下实例记录；归队先穿回同一批，避免再造一套同样的装备。
      for(const [slot,instanceId] of Object.entries(retired??{})) {
        if(!instanceId||!this.bag.get(instanceId))continue;
        try{this.bag.equip(instanceId,slot as import('./items.ts').EquipmentSlot,id,definition.classId,generated.level);}
        catch{
          // 角色自己的初始装备穿不上就丢掉；玩家给的其它装备留在背包里。
          if(gear[slot as import('./items.ts').EquipmentSlot])this.bag.take(instanceId,1);
        }
      }
      for(const [slot,item] of Object.entries(gear)) {
        const slotName=slot as import('./items.ts').EquipmentSlot,
          previous=retired?.[slotName];
        if(previous&&this.bag.equipmentFor(id)[slotName]===previous)continue;
        this.bag.addEquipped(item!,slotName,id,definition.classId,generated.level);
      }
    }
    catch(error){this.bag.removeOwner(id,false);throw error;}
    // Initial equipment may change maximum life. A recruit begins at full resources.
    member.recover();this.owned.set(id,member);
    if(source==='mercenary')this.rosterSlots[this.rosterSlots.indexOf(null)]=id;
    else {const slot=this.slots.findIndex(value=>!value);if(slot>=0)this.slots[slot]=id;}
    this.invalidateActiveIds();
    this.bumpGroupModifiers();this.changed();return member;
  }
  recruit(itemInstanceId:string,random:()=>number=Math.random):{member:CompanionMember;result:ItemResult}{
    return this.atomic?this.atomic(()=>this.recruitMember(itemInstanceId,random)):this.recruitMember(itemInstanceId,random);
  }
  private recruitMember(itemInstanceId:string,random:()=>number):{member:CompanionMember;result:ItemResult}{
    const entry=this.bag.get(itemInstanceId);
    if(!entry||!this.bag.entries.some(value=>value.id===itemInstanceId))throw new Error('招募徽章已不在背包中');
    const use=this.items.items[entry.item]?.use;
    if(use?.kind!=='recruit')throw new Error('该物品不能招募伙伴');
    if(!this.rosterSlots.includes(null))throw new Error('佣兵名册已满');
    const rule=this.catalog.generation.emblems[entry.item];if(!rule)throw new Error('招募徽章规则缺失');
    const classId=rule.classId??MERCENARY_CLASS_ORDER[randomInteger(random,0,MERCENARY_CLASS_ORDER.length-1)];
    const weights=[...rule.qualityWeights];
    if(!rule.guaranteedRare&&this.groupModifiers()['rare-recruit-chance']){weights[0]-=2;weights[2]+=2;}
    const quality=weightedIndex(random,weights);
    const pool=Object.values(this.catalog.definitions).filter(definition=>
      (definition.source??'mercenary')==='mercenary'&&definition.quality===quality&&definition.classId===classId&&definition.recruitable!==false);
    if(!pool.length)throw new Error('招募角色数据缺失');
    const definition=pool[randomInteger(random,0,pool.length-1)]!;
    const generated=generateCompanion(this.catalog.generation,definition,this.hero.level,random);
    const member=this.create(definition,'mercenary',`companion-${this.serial+1}`,generated);this.serial++;
    this.bag.take(itemInstanceId,1);
    this.onRecruited?.(entry.item,member.id);
    const result:ItemResult={kind:'recruit',message:`${member.definition.name}加入队伍`,rewards:[],classId:definition.classId};
    this.changed();return {member,result};
  }
  revive(id:string,itemInstanceId:string):ItemResult{
    const entry=this.bag.get(itemInstanceId),use=entry&&this.items.items[entry.item]?.use;
    if(!entry||!this.bag.entries.some(value=>value.id===itemInstanceId)||use?.kind!=='revive')throw new Error('复活道具不可用');
    if(!this.livingIds.length)throw new Error('全队阵亡时请返回检查点或读取存档');
    if(!this.activeIds.includes(id)||this.alive(id))throw new Error('请选择已倒下的上阵队员');
    const member=id==='player'?this.hero:this.owned.get(id)!;
    const full=entry.item==='improved-resurrection-scroll';
    member.clearCombatResourceLimits();
    member.setHealth(Math.floor(member.player.maxHealth*(full?1:REVIVE_RECOVERY_RATE)));
    member.setMana(Math.floor(member.player.maxMana*(full?1:REVIVE_RECOVERY_RATE)));
    this.bag.take(itemInstanceId,1);this.changed();
    return {kind:'revive',message:`${id==='player'?'主角':this.owned.get(id)!.definition.name}已复活`,rewards:[]};
  }
  joinStory(definitionId:string):CompanionMember{
    const definition=this.catalog.definitions[definitionId];
    if(!definition||definition.source!=='story')throw new Error(`剧情伙伴不存在：${definitionId}`);
    const id=`story-${definitionId}`;const existing=this.owned.get(id);if(existing)return existing;
    // 剧情伙伴只要进入名册就够了：上阵位满了就留在候补，由玩家自己换人，
    // 不因为队伍已满中断剧情。
    const training=this.catalog.generation.training;
    const generated:GeneratedCompanion={level:this.hero.level,baseAttributes:{...this.stats.classes[definition.classId]},
      skillCaps:Object.fromEntries(Object.entries(training).filter(([,skill])=>skill.classId===definition.classId).map(([key,skill])=>[key,skill.maxLevel])),groupSkills:[]};
    return this.create(definition,'story',id,generated);
  }
  leaveStory(definitionId:string):boolean{
    const id=`story-${definitionId}`,member=this.owned.get(id);if(!member||member.source!=='story')return false;
    // 装备退回背包，同时记下实例 ID；归队时穿回同一批，剧本反复离队、归队不会再复制装备。
    this.remove(id,true,true);return true;
  }
  dismiss(id:string):void{
    const member=this.owned.get(id);if(!member||member.source!=='mercenary')throw new Error('只能放逐佣兵');
    if(this.activeIds.includes(id))throw new Error('请先将佣兵移出队伍');
    this.remove(id,false);
  }
  private remove(id:string,returnEquipment:boolean,retireEquipment=false):void{
    this.owned.delete(id);this.onMemberRemoved?.(id);this.rosterSlots=this.rosterSlots.map(value=>value===id?null:value);this.slots=this.slots.map(value=>value===id?undefined:value);
    this.invalidateActiveIds();
    if(this.selected===id)this.selected=this.livingIds[0]??'player';
    this.bag.removeOwner(id,returnEquipment,retireEquipment);this.bumpGroupModifiers();this.changed();
  }
  deploy(id:string,slot:1|2):void{
    if(!this.owned.has(id))throw new Error('伙伴不存在');
    const index=slot-1,previous=this.slots[index],current=this.slots.indexOf(id);
    if(current===index)return;
    if(!this.alive(id))throw new Error('阵亡佣兵需要先复活');
    if(previous&&current<0)throw new Error('上阵位置已占用，请先移出队员');
    if(current>=0)this.slots[current]=previous;
    this.slots[index]=id;
    this.invalidateActiveIds();
    if(previous&&current<0&&this.selected===previous)this.selected=this.livingIds[0]??'player';
    this.changed();
  }
  deployFirstAvailable(id:string):void{
    if(this.activeIds.includes(id))return;
    const slot=this.slots.findIndex(value=>!value);
    if(slot<0)throw new Error('上阵位置已满，请先将一名队员退至候补');
    this.deploy(id,(slot+1) as 1|2);
  }
  reserve(id:string):void{
    if(!this.owned.has(id)||!this.slots.includes(id))throw new Error('伙伴未上阵');
    if(!this.alive(id))throw new Error('阵亡队员无法移出队伍');
    this.slots=this.slots.map(value=>value===id?undefined:value);
    this.invalidateActiveIds();
    if(this.selected===id)this.selected=this.livingIds[0]??'player';
    this.changed();
  }
  switchControl(id:string):boolean{
    if(!this.activeIds.includes(id)||!this.alive(id))return false;
    if(this.selected===id)return true;this.selected=id;this.changed();return true;
  }
  onDefeat(id:string):boolean{
    if(this.selected===id){const order=['player',...this.slots],start=order.indexOf(id);
      for(let offset=1;offset<=order.length;offset++){const next=order[(start+offset)%order.length];if(next&&this.alive(next)){this.selected=next;break;}}this.changed();}
    return this.livingIds.length===0;
  }
  addExperience(amount:number):void{
    if(!Number.isSafeInteger(amount)||amount<0)throw new Error('经验奖励无效');
    const heroLevel=this.hero.level,reward=Math.floor(amount*(1000+(this.groupModifiers().experience??0))/1000);
    if(this.alive('player'))this.hero.addExperience(reward);
    for(const [id,member] of this.owned)if(!this.activeIds.includes(id)||(member.alive&&member.level<=heroLevel))member.addExperience(reward);
  }
  groupModifiers():Partial<Record<CompanionGroupEffect,number>>{
    const result:Partial<Record<CompanionGroupEffect,number>>={};
    for(const member of this.owned.values())for(const id of member.generated.groupSkills){
      const skill=this.catalog.groupSkills[id];if(skill)result[skill.effect]=skill.value;
    }
    return result;
  }
  captureState():PartyState{return structuredClone({members:[...this.owned.values()].map(member=>member.captureState()),
    rosterSlots:this.rosterSlots,slots:this.slots.map(value=>value??null),selected:this.selected,serial:this.serial,
    heroAiFrequency:[...this.heroAiFrequency],sharedUnlockedSkills:[...this.sharedUnlockedSkills]});}
  restoreState(state:PartyState):void {
    this.restoreRoster(state,new Map());
  }
  /** 局部回滚保留原成员及技能对象，让已装配的战斗和血条继续读取同一实例。 */
  checkpoint():()=>void {
    const state=this.captureState(),members=new Map(this.owned);
    return ()=>this.restoreRoster(state,members);
  }
  private restoreRoster(state:PartyState,members:ReadonlyMap<string,CompanionMember>):void {
    const saved=structuredClone(state);this.owned.clear();
    this.sharedUnlockedSkills.clear();for(const id of saved.sharedUnlockedSkills??[])this.sharedUnlockedSkills.add(id);
    for(const entry of saved.members){
      const definition=this.catalog.definitions[entry.definitionId];if(!definition)throw new Error('检查点中的伙伴不存在');
      const member=members.get(entry.id)??new CompanionMember(entry.id,definition,entry.source,entry.level,this.stats,this.items,this.bag,
        this.catalog.growth[definition.classId],this.changed,entry.generated,this.catalog.generation.training,()=>this.bumpGroupModifiers(),this.battleCatalog,this.bonusSkillPointsPerLevel);
      member.restoreState(entry);this.applySharedSkills(member);this.owned.set(entry.id,member);
    }
    this.rosterSlots=saved.rosterSlots;this.slots=saved.slots.map(value=>value??undefined);this.selected=saved.selected;this.serial=saved.serial;
    this.invalidateActiveIds();
    this.heroAiFrequency.clear();for(const [id,value] of saved.heroAiFrequency)this.heroAiFrequency.set(id,value);
    this.bumpGroupModifiers();
  }

}

import { boundedHealth } from './status-hud.ts';
import { calculateCharacter, previewGemPanel, PRIMARY_STATS, primaryAttributesFrom, type CharacterPanel, type CharacterStatsCatalog, type Modifier, type PrimaryAttributes, type BattleCharacter } from './character-stats.ts';
import type { SkillConfigurationState } from './skill-configuration.ts';
import type { CounterattackMode } from './party-ai.ts';
import { CompanionSkillProgression, generateCompanion, MERCENARY_CLASS_ORDER, randomInteger, weightedIndex, type CompanionGenerationRules, type CompanionGroupEffect, type CompanionGroupSkill, type GeneratedCompanion } from './companion-progression.ts';
export type { CompanionGroupEffect, CompanionGroupSkill } from './companion-progression.ts';
const MERCENARY_SLOT_COUNT=18;
import type { ItemCatalog, ItemResult } from './items.ts';
import type { Bag } from './bag.ts';

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
export interface CompanionCatalog {
  definitions: Record<string,CompanionDefinition>;
  /** Each row is a level's five base attributes, from level 1 through 105. */
  growth: Record<string,PrimaryAttributes[]>;
  generation: CompanionGenerationRules;
  groupSkills:Record<CompanionGroupEffect,CompanionGroupSkill>;
  autoSkills:Record<string,{kind:'chance'|'combat-chance'|'heal'|'ally-combat'|'emergency-heal'}>;
}
export interface PartySnapshot {
  active: readonly string[];
  living:readonly string[];
  rosterSlots:readonly (string|null)[];
  reserves: readonly string[];
  controlled: string;
  members: readonly CompanionSnapshot[];
}
interface CompanionSnapshot {
  id: string;
  definitionId: string;
  rosterSlot:number|null;
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
  aiFrequency:[string,number][];counterattack:CounterattackMode;
}
interface PartyState {
  members:CompanionState[];rosterSlots:(string|null)[];slots:(string|null)[];selected:string;serial:number;
  heroAiFrequency:[string,number][];heroCounterattack:CounterattackMode;
}


export class CompanionMember {
  readonly id:string;
  readonly definition:CompanionDefinition;
  readonly source:'story'|'mercenary';
  readonly skills:CompanionSkillProgression;
  readonly generated:GeneratedCompanion;
  readonly aiFrequency=new Map<string,number>();
  counterattack:CounterattackMode=2;
  private readonly stats:CharacterStatsCatalog;
  private readonly items:ItemCatalog;
  readonly bag:Bag;
  private readonly growth:PrimaryAttributes[];
  private readonly changed:()=>void;
  private currentLevel:number;
  private currentHealth=0;
  private currentMana=0;
  private currentExperience=0;
  private combatResourceLimits:{maxHealth:number;maxMana:number}|null=null;
  constructor(id:string,definition:CompanionDefinition,source:'story'|'mercenary',level:number,
    stats:CharacterStatsCatalog,items:ItemCatalog,bag:Bag,growth:PrimaryAttributes[],changed:()=>void,generated:GeneratedCompanion,training:CompanionGenerationRules['training']){
    if(!stats.classes[definition.classId]||growth.length<stats.maxLevel)throw new Error('伙伴职业成长数据缺失');
    this.id=id;this.definition=definition;this.source=source;this.stats=stats;this.items=items;this.bag=bag;
    this.growth=growth;this.changed=changed;this.currentLevel=Math.min(stats.maxLevel,Math.max(1,level));
    this.generated=structuredClone(generated);this.skills=new CompanionSkillProgression(generated.skillCaps,training);
    this.skills.updateLevel(this.currentLevel);
    this.currentHealth=this.panel.maxHealth;this.currentMana=this.panel.maxMana;
  }
  get classId():string{return this.definition.classId;}
  get level():number{return this.currentLevel;}
  private get allocated():PrimaryAttributes{
    const base=this.stats.classes[this.definition.classId],total=this.growth[this.currentLevel-1]!;
    return primaryAttributesFrom(Object.fromEntries(PRIMARY_STATS.map(stat=>[stat,total[stat]-2*base[stat]+this.generated.baseAttributes[stat]])));
  }
  private panelCache?:{revision:number;level:number;panel:CharacterPanel};
  get panel():CharacterPanel{
    // 战斗每个逻辑帧会多次读面板（技能频率、HP/MP 上限）；只在等级或背包实例变化时重算。
    const cached=this.panelCache;
    if(cached&&cached.revision===this.bag.revision&&cached.level===this.currentLevel)return cached.panel;
    const allocated=this.allocated;
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
      allocated:this.allocated,equipped,bag:this.bag,targetId,gemModifiers,emptySlot});
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
    const next={maxHealth:Math.max(0,Math.trunc(maxHealth)),maxMana:Math.max(0,Math.trunc(maxMana))};
    if(this.combatResourceLimits?.maxHealth===next.maxHealth&&this.combatResourceLimits.maxMana===next.maxMana)return;
    this.combatResourceLimits=next;this.changed();
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
  addExperience(amount:number):number{
    if(!Number.isSafeInteger(amount)||amount<0)throw new Error('经验奖励无效');
    if(!amount||this.currentLevel>=this.stats.maxLevel)return 0;
    this.currentExperience+=amount;let levels=0;
    while(this.currentLevel<this.stats.maxLevel&&this.currentExperience>=(this.stats.experience[this.currentLevel-1]??Infinity)){
      this.currentExperience-=this.stats.experience[this.currentLevel-1]!;this.currentLevel++;levels++;
    }
    if(this.currentLevel===this.stats.maxLevel)this.currentExperience=0;
    if(levels){this.skills.updateLevel(this.currentLevel);if(this.alive)this.recover();else this.changed();}else this.changed();return levels;
  }
  setAiFrequency(skillId:string,frequency:number):void{
    if(!Number.isInteger(frequency)||frequency<0||frequency>2)throw new Error('技能频率需要是 0–2');
    this.aiFrequency.set(skillId,frequency);this.changed();
  }
  snapshot(rosterSlot:number|null=null):CompanionSnapshot{const player=this.player;return {id:this.id,definitionId:this.definition.id,rosterSlot,
    skillLevels:this.skills.skillLevels(),skillCaps:{...this.generated.skillCaps},groupSkills:[...this.generated.groupSkills],quality:this.definition.quality??0,
    name:this.definition.name,classId:this.definition.classId,source:this.source,elite:this.definition.elite,...player};}
  captureState():CompanionState{return structuredClone({id:this.id,definitionId:this.definition.id,source:this.source,
    generated:this.generated,level:this.currentLevel,health:this.currentHealth,mana:this.currentMana,experience:this.currentExperience,
    combatResourceLimits:this.combatResourceLimits,skills:this.skills.captureState(),aiFrequency:[...this.aiFrequency],counterattack:this.counterattack});}
  restoreState(state:CompanionState):void{
    this.currentLevel=state.level;this.currentHealth=state.health;this.currentMana=state.mana;this.currentExperience=state.experience;
    this.combatResourceLimits=state.combatResourceLimits?{...state.combatResourceLimits}:null;this.skills.updateLevel(this.currentLevel);this.skills.restoreState(state.skills);
    this.aiFrequency.clear();for(const [id,value] of state.aiFrequency)this.aiFrequency.set(id,value);this.counterattack=state.counterattack;
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
  readonly heroAiFrequency=new Map<string,number>();
  heroCounterattack:CounterattackMode=2;
  private readonly stats:CharacterStatsCatalog;
  private readonly items:ItemCatalog;
  private readonly changed:()=>void;
  private readonly onMemberRemoved?:(id:string)=>void;
  private readonly onRecruited?:(sourceItem:string,memberId:string)=>void;
  private readonly transaction?:<T>(operation:()=>T)=>T;
  private readonly owned=new Map<string,CompanionMember>();
  private slots:(string|undefined)[]=[undefined,undefined];
  private selected='player';
  private serial=0;
  private rosterSlots:(string|null)[]=Array.from({length:MERCENARY_SLOT_COUNT},()=>null);
  constructor(hero:BattleCharacter,stats:CharacterStatsCatalog,items:ItemCatalog,catalog:CompanionCatalog,changed:()=>void,onMemberRemoved?:(id:string)=>void,
    onRecruited?:(sourceItem:string,memberId:string)=>void,transaction?:<T>(operation:()=>T)=>T){
    this.hero=hero;this.bag=hero.bag;this.stats=stats;this.items=items;this.catalog=catalog;this.changed=changed;this.onMemberRemoved=onMemberRemoved;
    this.onRecruited=onRecruited;this.transaction=transaction;
  }
  get controlledId():string{return this.selected;}
  get activeIds():string[]{return ['player',...this.slots.filter((id):id is string=>!!id)];}
  get livingIds():string[]{return this.activeIds.filter(id=>this.alive(id));}
  get activeSize():number{return this.activeIds.length;}
  get(id:string):CompanionMember|undefined{return this.owned.get(id);}
  aiFrequency(id:string):Map<string,number>{return id==='player'?this.heroAiFrequency:this.owned.get(id)?.aiFrequency??new Map();}
  counterattack(id:string):CounterattackMode{return id==='player'?this.heroCounterattack:this.owned.get(id)?.counterattack??0;}
  setCounterattack(id:string,mode:CounterattackMode):void{
    if(mode!==0&&mode!==1&&mode!==2)throw new Error('反击档位需要是 0–2');
    if(id==='player')this.heroCounterattack=mode;else{const member=this.owned.get(id);if(!member)throw new Error('伙伴不存在');member.counterattack=mode;}this.changed();
  }
  setAiFrequency(id:string,skill:string,frequency:number):void{
    if(!Number.isInteger(frequency)||frequency<0||frequency>2)throw new Error('技能频率需要是 0–2');
    if(id!=='player'&&!this.owned.has(id))throw new Error('伙伴不存在');
    this.aiFrequency(id).set(skill,frequency);this.changed();
  }
  alive(id:string):boolean{return id==='player'?this.hero.player.health>0:this.owned.get(id)?.alive??false;}
  snapshot():PartySnapshot{const active=this.activeIds;return {active,living:this.livingIds,rosterSlots:[...this.rosterSlots],reserves:[...this.owned.keys()].filter(id=>!active.includes(id)),
    controlled:this.selected,members:[...this.owned.values()].map(member=>{const slot=this.rosterSlots.indexOf(member.id);return member.snapshot(slot<0?null:slot);})};}
  private create(definition:CompanionDefinition,source:'story'|'mercenary',id:string,generated:GeneratedCompanion):CompanionMember{
    if(!this.catalog.growth[definition.classId])throw new Error('伙伴成长数据缺失');
    const member=new CompanionMember(id,definition,source,generated.level,this.stats,this.items,this.bag,
      this.catalog.growth[definition.classId],this.changed,generated,this.catalog.generation.training);
    const gear=this.items.startingEquipment[definition.classId]??{};
    try {for(const [slot,item] of Object.entries(gear))this.bag.addEquipped(item!,slot as import('./items.ts').EquipmentSlot,id);}
    catch(error){this.bag.removeOwner(id,false);throw error;}
    // Initial equipment may change maximum life. A recruit begins at full resources.
    member.recover();this.owned.set(id,member);
    if(source==='mercenary')this.rosterSlots[this.rosterSlots.indexOf(null)]=id;
    else {const slot=this.slots.findIndex(value=>!value);if(slot>=0)this.slots[slot]=id;}
    this.changed();return member;
  }
  recruit(itemInstanceId:string,random:()=>number=Math.random):{member:CompanionMember;result:ItemResult}{
    return this.transaction?this.transaction(()=>this.recruitMember(itemInstanceId,random)):this.recruitMember(itemInstanceId,random);
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
    const result:ItemResult={kind:'recruit',title:'招募成功',message:`${member.definition.name}加入队伍`,rewards:[],classId:definition.classId};
    this.changed();return {member,result};
  }
  revive(id:string,itemInstanceId:string):ItemResult{
    const entry=this.bag.get(itemInstanceId),use=entry&&this.items.items[entry.item]?.use;
    if(!entry||!this.bag.entries.some(value=>value.id===itemInstanceId)||use?.kind!=='revive')throw new Error('复活道具不可用');
    if(entry.item==='resurrection-prayer'){
      const fallen=this.activeIds.filter(member=>!this.alive(member));
      if(this.livingIds.length||!fallen.length)throw new Error('复活圣文只能在全队阵亡时使用');
      for(const memberId of fallen){const member=memberId==='player'?this.hero:this.owned.get(memberId)!;
        member.clearCombatResourceLimits();member.setHealth(member.player.maxHealth);member.setMana(member.player.maxMana);
      }
      this.bag.take(itemInstanceId,1);this.changed();
      return {kind:'revive',title:'队伍复活',message:'队伍成员已复活',rewards:[]};
    }
    if(!this.livingIds.length)throw new Error('全队阵亡时需要复活圣文');
    if(!this.activeIds.includes(id)||this.alive(id))throw new Error('请选择已倒下的上阵队员');
    const member=id==='player'?this.hero:this.owned.get(id)!;
    const full=entry.item==='improved-resurrection-scroll';
    member.clearCombatResourceLimits();
    member.setHealth(Math.floor(member.player.maxHealth*(full?1:.1)));
    member.setMana(Math.floor(member.player.maxMana*(full?1:.1)));
    this.bag.take(itemInstanceId,1);this.changed();
    return {kind:'revive',title:'复活成功',message:`${id==='player'?'主角':this.owned.get(id)!.definition.name}已复活`,rewards:[]};
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
    this.remove(id,true);return true;
  }
  dismiss(id:string):void{
    const member=this.owned.get(id);if(!member||member.source!=='mercenary')throw new Error('只能放逐佣兵');
    if(this.activeIds.includes(id))throw new Error('请先将佣兵移出队伍');
    this.remove(id,false);
  }
  private remove(id:string,returnEquipment:boolean):void{
    this.owned.delete(id);this.onMemberRemoved?.(id);this.rosterSlots=this.rosterSlots.map(value=>value===id?null:value);this.slots=this.slots.map(value=>value===id?undefined:value);
    if(this.selected===id)this.selected=this.livingIds[0]??'player';
    this.bag.removeOwner(id,returnEquipment);this.changed();
  }
  deploy(id:string,slot:1|2):void{
    if(!this.owned.has(id))throw new Error('伙伴不存在');
    const index=slot-1,previous=this.slots[index],current=this.slots.indexOf(id);
    if(current===index)return;
    if(!this.alive(id))throw new Error('阵亡佣兵需要先复活');
    if(previous&&current<0)throw new Error('上阵位置已占用，请先移出队员');
    if(current>=0)this.slots[current]=previous;
    this.slots[index]=id;
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
  recover():void{this.hero.recover();for(const id of this.activeIds.slice(1))this.owned.get(id)?.recover();this.selected='player';this.changed();}
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
    heroAiFrequency:[...this.heroAiFrequency],heroCounterattack:this.heroCounterattack});}
  restoreState(state:PartyState):void{
    const saved=structuredClone(state);this.owned.clear();
    for(const entry of saved.members){
      const definition=this.catalog.definitions[entry.definitionId];if(!definition)throw new Error('检查点中的伙伴不存在');
      const member=new CompanionMember(entry.id,definition,entry.source,entry.level,this.stats,this.items,this.bag,
        this.catalog.growth[definition.classId],this.changed,entry.generated,this.catalog.generation.training);
      member.restoreState(entry);this.owned.set(entry.id,member);
    }
    this.rosterSlots=saved.rosterSlots;this.slots=saved.slots.map(value=>value??undefined);this.selected=saved.selected;this.serial=saved.serial;
    this.heroAiFrequency.clear();for(const [id,value] of saved.heroAiFrequency)this.heroAiFrequency.set(id,value);this.heroCounterattack=saved.heroCounterattack;
  }

}

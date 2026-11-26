import type { BattleCatalog, SkillLoadout } from './battle.ts';
import type { PrimaryAttributes } from './character-stats.ts';
import { PRIMARY_STATS, primaryAttributesFrom } from './character-stats.ts';
import { SkillConfiguration } from './skill-configuration.ts';
import { investedSkillPoints, skillLearningRequirements, skillLearningProblem } from './skill-learning.ts';

export type CompanionGroupEffect = 'low-health-resistance'|'sword-damage'|'plate-defense'|'ancient-legendary-chance'|
  'sell-price'|'critical-stun-chance'|'leather-physical-damage'|'chest-quality'|'magic-damage'|'cloth-magic-damage'|
  'magic-resistance'|'scroll-drop'|'buy-discount'|'blunt-stun-chance'|'experience'|'rare-recruit-chance'|
  'potion-recovery'|'bow-damage'|'critical-damage'|'material-drop'|'status-resistance'|'two-hand-damage'|
  'potion-cooldown-ms'|'equipment-drop';
export interface CompanionGroupSkill {id:CompanionGroupEffect;effect:CompanionGroupEffect;name:string;description:string;icon:string;value:number;unit:'drop-ten-thousandth'|'milliseconds'|'percent'|'flag'|'per-thousand';}
interface CompanionTraining {classId:string;position:number;maxLevel:number;requiredLevels:number[];}
export interface CompanionGenerationRules {
  emblems:Record<string,{classId:string|null;qualityWeights:number[];guaranteedRare:boolean}>;
  training:Record<string,CompanionTraining>;
  skillChoices:number[][];
  skillCountWeights:number[][][];
  statDice:Record<string,{ordinary:{sides:number;count:number}[];rare:{sides:number;count:number}[]}>;
  groupPools:Record<string,CompanionGroupEffect[]>;
}
export interface GeneratedCompanion {level:number;baseAttributes:PrimaryAttributes;skillCaps:Record<string,number>;groupSkills:CompanionGroupEffect[];}
export const MERCENARY_CLASS_ORDER=['dark-knight','assassin','warlock','priest','ranger','warrior'] as const;

/** 品质 2 起算稀有佣兵：使用固定技能、稀有属性骰，并多带一个组队技能。 */
const RARE_COMPANION_QUALITY=2;
/** 随机技能上限：4..7 个保持满上限，接着 2..6 个降 1 级，其余降 2 级。 */
const FULL_CAP_SKILL_MIN_COUNT=4;
const FULL_CAP_SKILL_MAX_COUNT=7;
const REDUCED_CAP_SKILL_MIN_COUNT=2;
const REDUCED_CAP_SKILL_MAX_COUNT=6;
const SKILL_CAP_REDUCTION_STEP=1;
const MAX_SKILL_CAP_REDUCTION=2;
export function randomInteger(random:()=>number,minimum:number,maximum:number):number{
  const value=random();
  if(!Number.isFinite(value)||value<0||value>=1)throw new Error('招募随机值无效');
  return minimum+Math.floor(value*(maximum-minimum+1));
}
export function weightedIndex(random:()=>number,weights:readonly number[]):number{
  let roll=randomInteger(random,0,99);
  for(let index=0;index<weights.length;index++){roll-=weights[index];if(roll<0)return index;}
  return weights.length;
}
function drawWithoutReplacement<T>(pool:T[],random:()=>number):T{
  const index=randomInteger(random,0,pool.length-1),result=pool[index]!;
  pool[index]=pool[pool.length-1]!;pool.pop();return result;
}
export function generateCompanion(rules:CompanionGenerationRules,definition:{classId:string;quality?:number;fixedSkills?:string[]},heroLevel:number,random:()=>number):GeneratedCompanion{
  const quality=definition.quality??0, classId=definition.classId;
  const level=Math.max(1,randomInteger(random,heroLevel-3,heroLevel));
  const training=Object.entries(rules.training).filter(([,skill])=>skill.classId===classId);
  const selected:string[]=[];
  if(quality<RARE_COMPANION_QUALITY){
    rules.skillChoices.forEach((positions,index)=>{
      const count=weightedIndex(random,rules.skillCountWeights[quality][index])+1;
      if(count>3)return;
      const pool=training.filter(([,skill])=>positions.includes(skill.position)).map(([id])=>id);
      for(let n=0;n<count&&pool.length;n++)selected.push(drawWithoutReplacement(pool,random));
    });
  }else selected.push(...(definition.fixedSkills??[]));
  const caps=Object.fromEntries(selected.map(id=>[id,rules.training[id].maxLevel]));
  const fullCount=randomInteger(random,FULL_CAP_SKILL_MIN_COUNT,FULL_CAP_SKILL_MAX_COUNT),
    reducedCount=randomInteger(random,REDUCED_CAP_SKILL_MIN_COUNT,REDUCED_CAP_SKILL_MAX_COUNT),pool=[...selected];
  for(let index=0;pool.length;index++){
    const id=drawWithoutReplacement(pool,random);
    const reduction=index<fullCount?0:index<fullCount+reducedCount?SKILL_CAP_REDUCTION_STEP:MAX_SKILL_CAP_REDUCTION;
    caps[id]=Math.max(1,caps[id]-reduction);
  }
  const groupPool=[...rules.groupPools[classId]],groupSkills:CompanionGroupEffect[]=[];
  for(let i=0;i<(quality<RARE_COMPANION_QUALITY?1:2)&&groupPool.length;i++)groupSkills.push(drawWithoutReplacement(groupPool,random));
  const dice=rules.statDice[classId][quality<RARE_COMPANION_QUALITY?'ordinary':'rare'];
  const baseAttributes=primaryAttributesFrom(Object.fromEntries(PRIMARY_STATS.map((stat,index)=>{
    const {sides,count}=dice[index];let value=0;
    for(let roll=0;roll<count;roll++)value+=randomInteger(random,1,sides);
    return [stat,value];
  })));
  return {level,baseAttributes,skillCaps:caps,groupSkills};
}

/** 每名佣兵独立记录普通分配、实际花费和历史补点。 */
export interface MercenarySkillPoints {
  allocations:Record<string,number>;
  spentPoints:number;
  legacyBonusPoints:number;
}
export interface MercenarySkillContext {
  classId:string;
  catalog?:BattleCatalog;
  pointsPerLevel:number;
  changed:()=>void;
  clearShortcuts:()=>void;
}

/** 训练表按角色等级算出的自然技能等级。 */
function autoSkillLevel(training:CompanionGenerationRules['training'],id:string,cap:number,level:number):number {
  return training[id]?.requiredLevels.slice(0,cap).filter(required=>level>=required).length??0;
}

export class CompanionSkillProgression extends SkillConfiguration {
  private levels:Record<string,number>={};
  private bookLevels:Record<string,number>={};
  /** 剧情伙伴保存解锁等级，手动培养的佣兵只保存开放资格。 */
  private unlocked:Record<string,number>={};
  private pointState:MercenarySkillPoints={allocations:{},spentPoints:0,legacyBonusPoints:0};
  private characterLevel=1;
  private resetRevision=0;
  get resetVersion():number{return this.resetRevision;}
  get manual():boolean{return !!this.context;}
  readonly caps:Record<string,number>;
  private readonly training:Record<string,CompanionTraining>;
  private readonly context?:MercenarySkillContext;
  constructor(caps:Record<string,number>,training:Record<string,CompanionTraining>,context?:MercenarySkillContext){
    super();this.caps={...caps};this.training=training;this.context=context;
  }
  updateLevel(level:number):void{
    this.characterLevel=level;
    if(!this.manual)this.levels=Object.fromEntries(Object.entries(this.caps).map(([id,cap])=>[id,
      autoSkillLevel(this.training,id,cap,level)+(this.bookLevels[id]??0)]));
    this.markChanged();
  }
  skillLevels():Record<string,number>{
    if(this.manual)return Object.fromEntries([...new Set([...Object.keys(this.caps),...Object.keys(this.unlocked)])]
      .map(id=>[id,(this.pointState.allocations[id]??0)+(this.bookLevels[id]??0)]));
    return {...this.levels,...this.unlocked};
  }
  nextAutomaticLevel(id:string):number|undefined{
    if(this.manual||this.unlocked[id]!==undefined)return undefined;
    const cap=this.caps[id];
    if(cap===undefined)return undefined;
    const natural=(this.levels[id]??0)-(this.bookLevels[id]??0);
    return natural<cap?this.training[id]?.requiredLevels[natural]:undefined;
  }
  private skill(id:string){
    const skill=this.context?.catalog?.skills[id],character=this.context?.catalog?.classes.find(value=>value.id===this.context?.classId);
    if(!skill||!character?.skills.includes(id))throw new Error('请选择本职业的技能');
    return skill;
  }
  available(id:string):boolean{return this.caps[id]!==undefined||this.unlocked[id]!==undefined;}
  normalMaximum(id:string,catalog:BattleCatalog):number{
    return Math.min(this.caps[id]??(this.unlocked[id]!==undefined?catalog.skills[id].normalMaxLevel:0),catalog.skills[id].normalMaxLevel);
  }
  level(id:string):number{this.skill(id);return this.skillLevels()[id]??0;}
  points():number{return this.manual?(this.characterLevel-1)*this.context!.pointsPerLevel+this.pointState.legacyBonusPoints-this.pointState.spentPoints:0;}
  /** 仅给手动培养佣兵补充额外技能点（写入历史补点字段，便于存档校验与重置保留）。 */
  grantBonusPoints(amount:number):void{
    if(!this.manual||!Number.isSafeInteger(amount)||amount<=0)return;
    this.pointState.legacyBonusPoints+=amount;this.markChanged();
  }
  investedPoints():number{
    return this.context?.catalog?investedSkillPoints(this.context.catalog,this.context.classId,this.skillLevels()):0;
  }
  learningRequirements(id:string){
    const skill=this.skill(id);
    return skillLearningRequirements(skill,this.level(id),this.points(),this.investedPoints(),this.normalMaximum(id,this.context!.catalog!));
  }
  learningProblem(id:string):string|undefined{
    this.skill(id);
    if(!this.available(id))return '该佣兵未开放此技能';
    return skillLearningProblem(this.learningRequirements(id));
  }
  learn(id:string):number{
    const problem=this.learningProblem(id);if(problem)throw new Error(problem);
    const next=this.level(id)+1,cost=this.skill(id).ranks[next-1].pointCost;
    this.pointState.allocations[id]=(this.pointState.allocations[id]??0)+1;
    this.pointState.spentPoints+=cost;this.markChanged();this.context!.changed();return next;
  }
  reset():void{
    if(!this.context)throw new Error('该伙伴不能初始化技能');
    this.pointState={allocations:{},spentPoints:0,legacyBonusPoints:this.pointState.legacyBonusPoints};
    this.bookLevels={};this.levels={};this.loadouts.delete(this.context.classId);
    this.resetRevision++;this.setShortcutPage(this.context.classId,0);
    this.context.clearShortcuts();this.context.changed();
  }
  pointsState():MercenarySkillPoints|undefined{return this.manual?structuredClone(this.pointState):undefined;}
  restorePoints(state:MercenarySkillPoints|undefined):void{
    if(!this.context)return;
    if(!state||!state.allocations||!Number.isSafeInteger(state.spentPoints)||state.spentPoints<0||
      !Number.isSafeInteger(state.legacyBonusPoints)||state.legacyBonusPoints<0||
      state.spentPoints>(this.characterLevel-1)*this.context.pointsPerLevel+state.legacyBonusPoints)throw new Error('佣兵技能点记录无效');
    const catalog=this.context.catalog;
    let minimumSpent=0,maximumSpent=0;
    for(const [id,value] of Object.entries(state.allocations)){
      if(!Number.isSafeInteger(value)||value<0||!this.available(id)||
        catalog&&(!catalog.classes.find(entry=>entry.id===this.context!.classId)?.skills.includes(id)||
        value>this.normalMaximum(id,catalog)))throw new Error('佣兵技能分配无效');
      if(catalog){
        // 普通加点和技能书提升共用等级，且加点的先后无法从终态还原：
        // 没有技能书时花费固定；有技能书时只能校验可能区间的上下限。
        const books=this.bookLevels[id]??0,
          costs=catalog.skills[id].ranks.slice(0,value+books).map(rank=>rank.pointCost).sort((a,b)=>a-b);
        minimumSpent+=costs.slice(0,value).reduce((sum,cost)=>sum+cost,0);
        maximumSpent+=costs.slice(costs.length-value).reduce((sum,cost)=>sum+cost,0);
      }
    }
    if(catalog&&(state.spentPoints<minimumSpent||state.spentPoints>maximumSpent))throw new Error('佣兵技能点花费无效');
    for(const [id,value] of Object.entries(this.unlocked)){
      if(value!==0||catalog&&!catalog.classes.find(entry=>entry.id===this.context!.classId)?.skills.includes(id))throw new Error('佣兵技能解锁记录无效');
    }
    for(const id of new Set([...Object.keys(this.caps),...Object.keys(state.allocations),...Object.keys(this.bookLevels)])){
      const books=this.bookLevels[id]??0,rank=(state.allocations[id]??0)+books,skill=catalog?.skills[id];
      if(!Number.isSafeInteger(books)||books<0||!this.available(id)||
        catalog&&(!skill||rank>(skill.companion?.ranks.length??skill.ranks.length)))throw new Error('佣兵技能书记录无效');
    }
    this.pointState=structuredClone(state);this.markChanged();
  }
  bookState():Record<string,number>{return {...this.bookLevels};}
  unlockedState():Record<string,number>{return {...this.unlocked};}
  restoreBooks(books:Record<string,number>,level:number):void{this.bookLevels={...books};this.updateLevel(level);}
  restoreUnlocked(unlocked:Record<string,number>):void{this.unlocked={...unlocked};this.markChanged();}
  bookProblem(id:string,catalog:BattleCatalog):string|undefined{
    const skill=catalog.skills[id],rank=this.skillLevels()[id]??0;
    if(!skill)return '技能不存在';
    const maximum=skill.companion?.ranks.length??skill.ranks.length;
    if(this.manual){
      if(!this.available(id))return '该佣兵未开放此技能';
      const cap=this.normalMaximum(id,catalog);
      if(rank<cap)return `技能达到 ${cap} 级后才能使用技能书`;
    }else if(this.unlocked[id]===undefined){
      if(!this.caps[id])return '该伙伴未开放此技能';
      if(rank<this.caps[id])return `技能达到 ${this.caps[id]} 级后才能使用技能书`;
    }
    if(rank>=maximum)return '技能已达到最高等级';
  }
  book(id:string,catalog:BattleCatalog):number{
    const problem=this.bookProblem(id,catalog);if(problem)throw new Error(problem);
    if(!this.manual&&this.unlocked[id]!==undefined){
      this.unlocked[id]++;this.markChanged();return this.unlocked[id];
    }
    this.bookLevels[id]=(this.bookLevels[id]??0)+1;
    if(!this.manual)this.levels[id]++;
    this.markChanged();return this.skillLevels()[id];
  }
  unlockSkill(id:string,catalog:BattleCatalog):number{
    const skill=catalog.skills[id];
    if(!skill)throw new Error('技能不存在');
    if(this.manual?this.available(id):(this.skillLevels()[id]??0)>0||this.unlocked[id]!==undefined)throw new Error('该佣兵已开放此技能');
    if((skill.companion?.ranks.length??skill.ranks.length)<1)throw new Error('技能已达到最高等级');
    this.unlocked[id]=this.manual?0:1;this.markChanged();return this.unlocked[id];
  }
  /** GM 调试提升独立记录为免费等级，初始化时清除，不计入可返还的普通技能点。 */
  maxAll(catalog:BattleCatalog,classId:string):{learned:number;maxed:number}{
    const character=catalog.classes.find(entry=>entry.id===classId);if(!character)throw new Error('职业不存在');
    const before=this.skillLevels();let learned=0,maxed=0;
    for(const id of character.skills){
      const skill=catalog.skills[id];if(!skill)continue;
      const from=before[id]??0,to=skill.companion?.ranks.length??skill.ranks.length;
      if(to<=from)continue;
      if(from===0)learned++;else maxed++;
      if(this.manual){
        this.unlocked[id]=0;this.bookLevels[id]=to-(this.pointState.allocations[id]??0);
      }else{this.levels[id]=to;this.unlocked[id]=to;}
    }
    this.markChanged();return {learned,maxed};
  }
  override draft(catalog:BattleCatalog,classId:string):SkillLoadout{
    this.draftCallCount++;
    const character=catalog.classes.find(entry=>entry.id===classId);if(!character)throw new Error('职业不存在');
    const levels=this.skillLevels();return {levels:Object.fromEntries(character.skills.map(id=>[id,levels[id]??0]))};
  }
  override save(catalog:BattleCatalog,classId:string,draft:SkillLoadout):void{
    const expected=this.draft(catalog,classId),character=catalog.classes.find(entry=>entry.id===classId);
    if(!character||Object.keys(draft.levels).some(id=>!character.skills.includes(id))||
      character.skills.some(id=>draft.levels[id]!==expected.levels[id]))throw new Error('技能等级只能通过学习改变');
    this.loadouts.set(classId,structuredClone(draft));this.markChanged();
  }
}

import type { BattleCatalog, SkillLoadout } from './battle.ts';
import type { PrimaryAttributes } from './character-stats.ts';
import { PRIMARY_STATS, primaryAttributesFrom } from './character-stats.ts';
import { SkillConfiguration } from './skill-configuration.ts';

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

/** Mercenaries acquire generated skills through character levels, without spending hero skill points. */
export class CompanionSkillProgression extends SkillConfiguration {
  private levels:Record<string,number>={};
  private bookLevels:Record<string,number>={};
  /** 被封印技能书解锁的技能等级；不参与角色等级自然成长。 */
  private unlocked:Record<string,number>={};
  readonly caps:Record<string,number>;
  private readonly training:Record<string,CompanionTraining>;
  constructor(caps:Record<string,number>,training:Record<string,CompanionTraining>){super();this.caps={...caps};this.training=training;}
  updateLevel(level:number):void{
    this.levels=Object.fromEntries(Object.entries(this.caps).map(([id,cap])=>[id,
      (this.training[id]?.requiredLevels.slice(0,cap).filter(required=>level>=required).length??0)+(this.bookLevels[id]??0)]));
    this.markChanged();
  }
  skillLevels():Record<string,number>{
    const levels={...this.levels};
    // 解锁技能不随角色等级自然成长；有效等级以解锁记录为准。
    for(const [id,level] of Object.entries(this.unlocked))levels[id]=level;
    return levels;
  }
  bookState():Record<string,number>{return {...this.bookLevels};}
  unlockedState():Record<string,number>{return {...this.unlocked};}
  restoreBooks(books:Record<string,number>,level:number):void{
    this.bookLevels={...books};this.updateLevel(level);
  }
  restoreUnlocked(unlocked:Record<string,number>):void{
    this.unlocked={...unlocked};this.markChanged();
  }
  bookProblem(id:string,catalog:BattleCatalog):string|undefined{
    const skill=catalog.skills[id],cap=this.caps[id],rank=this.skillLevels()[id]??0;
    if(!skill)return '技能不存在';
    const maximum=skill.companion?.ranks.length??skill.ranks.length;
    if(this.unlocked[id]===undefined){
      if(!cap)return '该佣兵未开放此技能';
      if(rank<cap)return `技能达到 ${cap} 级后才能使用技能书`;
    }
    if(rank>=maximum)return '技能已达到最高等级';
  }
  book(id:string,catalog:BattleCatalog):number{
    const problem=this.bookProblem(id,catalog);if(problem)throw new Error(problem);
    if(this.unlocked[id]!==undefined){
      const rank=(this.unlocked[id]??0)+1;
      if(rank>(catalog.skills[id].companion?.ranks.length??catalog.skills[id].ranks.length))throw new Error('技能已达到最高等级');
      this.unlocked[id]=rank;this.markChanged();return rank;
    }
    this.bookLevels[id]=(this.bookLevels[id]??0)+1;
    this.levels[id]++;this.markChanged();return this.levels[id];
  }
  /** 用封印技能书让佣兵学会初始技能表外的技能，从 1 级开始。 */
  unlockSkill(id:string,catalog:BattleCatalog):number{
    const skill=catalog.skills[id];
    if(!skill)throw new Error('技能不存在');
    if((this.skillLevels()[id]??0)>0||this.unlocked[id]!==undefined)throw new Error('该佣兵已学会此技能');
    const maximum=skill.companion?.ranks.length??skill.ranks.length;
    if(maximum<1)throw new Error('技能已达到最高等级');
    this.unlocked[id]=1;this.markChanged();return 1;
  }
  /**
   * GM 调试：把佣兵本职业的全部技能直接学会并升到最高等级，不改变角色等级。
   * 最高等级取该技能的伙伴成长表（`companion.ranks`）长度；没有伙伴成长表时退回普通表长度。
   * 不写技能书等级，也不改变招募时生成的自然上限。
   */
  maxAll(catalog:BattleCatalog,classId:string): { learned: number; maxed: number } {
    const character=catalog.classes.find(entry=>entry.id===classId);
    if(!character)throw new Error('职业不存在');
    const before=this.skillLevels();
    let learned=0,maxed=0;
    for(const id of character.skills){
      const skill=catalog.skills[id];
      if(!skill)continue;
      const from=before[id]??0,to=skill.companion?.ranks.length??skill.ranks.length;
      if(to<=from)continue;
      if(from===0)learned++;else maxed++;
      this.levels[id]=to;
      // 职业技能里的未解锁技能也要在自然成长重建后保留满级。
      this.unlocked[id]=Math.max(this.unlocked[id]??0,to);
    }
    this.markChanged();
    return {learned,maxed};
  }
  override draft(catalog:BattleCatalog,classId:string):SkillLoadout{
    this.draftCallCount++;
    const character=catalog.classes.find(entry=>entry.id===classId);if(!character)throw new Error('职业不存在');
    const levels=this.skillLevels();
    return {levels:Object.fromEntries(character.skills.map(id=>[id,levels[id]??0]))};
  }
  override save(catalog:BattleCatalog,classId:string,draft:SkillLoadout):void{
    const expected=this.draft(catalog,classId),character=catalog.classes.find(entry=>entry.id===classId);
    if(!character)throw new Error('技能配置无效');
    if(Object.keys(draft.levels).some(id=>!character.skills.includes(id))||
      character.skills.some(id=>draft.levels[id]!==expected.levels[id]))throw new Error('佣兵技能随角色等级成长');
    this.loadouts.set(classId,structuredClone(draft));this.markChanged();
  }
}

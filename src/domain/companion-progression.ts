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
  readonly caps:Record<string,number>;
  private readonly training:Record<string,CompanionTraining>;
  constructor(caps:Record<string,number>,training:Record<string,CompanionTraining>){super();this.caps={...caps};this.training=training;}
  updateLevel(level:number):void{
    this.levels=Object.fromEntries(Object.entries(this.caps).map(([id,cap])=>[id,
      this.training[id]?.requiredLevels.slice(0,cap).filter(required=>level>=required).length??0]));
    this.markChanged();
  }
  skillLevels():Record<string,number>{return {...this.levels};}
  /**
   * GM 调试：把佣兵自己这套技能直接拉到各自上限，不改变角色等级。
   * 佣兵技能本来只随等级成长，普通玩法不会调用这里。
   */
  maxAll(): { learned: number; maxed: number } {
    let learned=0,maxed=0;
    for(const [id,cap] of Object.entries(this.caps)){
      const from=this.levels[id]??0,to=Math.max(0,cap);
      if(to<=from)continue;
      if(from===0)learned++;else maxed++;
      this.levels[id]=to;
    }
    this.markChanged();
    return {learned,maxed};
  }
  override draft(catalog:BattleCatalog,classId:string):SkillLoadout{
    this.draftCallCount++;
    const character=catalog.classes.find(entry=>entry.id===classId);if(!character)throw new Error('职业不存在');
    return {levels:Object.fromEntries(character.skills.map(id=>[id,this.levels[id]??0]))};
  }
  override save(catalog:BattleCatalog,classId:string,draft:SkillLoadout):void{
    const expected=this.draft(catalog,classId),character=catalog.classes.find(entry=>entry.id===classId);
    if(!character)throw new Error('技能配置无效');
    if(Object.keys(draft.levels).some(id=>!character.skills.includes(id))||
      character.skills.some(id=>draft.levels[id]!==expected.levels[id]))throw new Error('佣兵技能随角色等级成长');
    this.loadouts.set(classId,structuredClone(draft));this.markChanged();
  }
}

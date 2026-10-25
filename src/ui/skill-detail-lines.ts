import type { SkillDetail, SkillDisplayRow, SkillRank } from '../domain/battle.ts';
import type { DescriptionTextPart } from '../domain/description-text.ts';
import type { StorySkillProgression } from '../domain/story-skills.ts';
import type { SkillDefinition } from '../domain/battle.ts';
import { skillDetailEntries, type SkillDetailEntry } from '../domain/skill-display.ts';

type SkillKind = SkillDefinition['kind'];
type RankLike = Pick<SkillRank, 'manaCost' | 'details' | 'displayValues'>;

function skillDetailLabel(detail: Pick<SkillDetailEntry, 'label' | 'valueSpacing'>, index: number, kind: SkillKind): string {
  return `${detail.label}${kind === 'active' && index < 2 ? ': ' : detail.valueSpacing ? ' ' : ''}`;
}

export function skillDetailText(detail: SkillDetail, index: number, kind: SkillKind): string {
  return `${skillDetailLabel(detail,index,kind)}${detail.value}`;
}

export function skillDescriptionParts(skill: SkillDefinition, level: number, companionMaximum?: number): DescriptionTextPart[] {
  const rank=skill.ranks[Math.max(0,level-1)],parts:DescriptionTextPart[]=[{text:`${skill.name} (LV ${Math.max(1,level)})\n`}];
  if(companionMaximum!==undefined)parts.push({text:`最高等级： LV ${companionMaximum}\n`});
  parts.push(...(skill.descriptionParts??[{text:skill.description}]),{text:'\n'});
  skillDetailEntries(skill,rank!).forEach((entry,index)=>{
    parts.push({text:skillDetailLabel(entry,index,skill.kind)},...entry.parts,{text:'\n'});
  });
  return parts;
}

export function skillLearningParts(name: string, level: number,
  requirements: ReturnType<StorySkillProgression['learningRequirements']> | undefined,
  companionLearningLevel?: number): DescriptionTextPart[] {
  const parts:DescriptionTextPart[]=[{text:`${name} (LV ${level+1})\n`}];
  if(companionLearningLevel!==undefined)parts.push({text:`学习级别： LV ${companionLearningLevel}`,color:'#ff0000'});
  else if(requirements)parts.push(
    {text:`条件：投入${requirements.requiredInvested}技能点\n`,color:requirements.conditionMet?'#ffffff':'#ff0000'},
    {text:`需要技能点数： ${requirements.cost}`,color:requirements.pointsAvailable?'#ffffff':'#ff0000'});
  return parts;
}

interface SkillPreviewRow { label: string; from: string; to: string; kind: 'mana' | 'effect' }

/** 按原版列魔耗及全部有效效果；普通学习上限决定页面是否显示整段预览。 */
export function skillNextLevelPreview(ranks: RankLike[], level: number, kind: SkillKind,
  maximumLearningLevel = ranks.length, display?: SkillDisplayRow[]): SkillPreviewRow[] {
  if(level>=maximumLearningLevel||!ranks[level])return [];
  const current=level>0?ranks[level-1]:undefined;
  const key=(entry:SkillDetailEntry,index:number)=>entry.kind==='effect'?`effect-${entry.effectIndex??index}`:String(index);
  const before=new Map((current?skillDetailEntries({display},current):[]).map((entry,index)=>[key(entry,index),entry.text]));
  return skillDetailEntries({display},ranks[level]!).flatMap((entry,index)=>{
    const rowKind=entry.kind??(kind==='active'&&index<2?(index===0?'mana':'cooldown'):'effect');
    if(rowKind==='cooldown')return [];
    return [{label:entry.label,from:before.get(key(entry,index))??entry.zeroText,to:entry.text,kind:rowKind}];
  });
}

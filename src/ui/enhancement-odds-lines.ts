import type { EnhancementOdds } from '../domain/enhancement.ts';

export type EnhancementOutcomeTone='loss'|'single'|'double';

export interface EnhancementOutcomeRow {
  result:string;
  chance:string;
  tone:EnhancementOutcomeTone;
}

export interface EnhancementOddsView {
  /** 普通卷轴用一句完整结果；混沌卷轴为空。 */
  sentence?:string;
  /** 混沌卷轴的当前等级标题；普通卷轴为空。 */
  current?:string;
  rows:EnhancementOutcomeRow[];
  cost:string;
  /** 消耗行纵坐标；由这里算好，面板只负责画。 */
  costY:number;
}

export const ENHANCEMENT_ODDS_TOP=214;
export const ENHANCEMENT_ODDS_ROW_TOP=238;
export const ENHANCEMENT_ODDS_ROW_STRIDE=24;

const clamp=(value:number):number=>Number.isFinite(value)?Math.min(1,Math.max(0,value)):0;

export function percentText(value:number):string {
  const percent=clamp(value)*100;
  const rounded=Math.round(percent);
  return `${rounded===0&&percent>0?Math.round(percent*10)/10:rounded}%`;
}

export function enhancementOddsView(odds:EnhancementOdds,currentLevel:number,durability:number|undefined):EnhancementOddsView {
  const current=Number.isFinite(currentLevel)?Math.max(0,Math.trunc(currentLevel)):0;
  const cost=odds.losesLevel
    ?'不消耗耐久'
    :durability!==undefined&&durability>0
      ?`消耗 1 点耐久（${durability} → ${durability-1}）`
      :'消耗 1 点耐久';
  if(!odds.losesLevel){
    const double=clamp(odds.double),single=clamp(1-double);
    const sentence=double<=0
      ?`当前 +${current}：100% 到 +${current+1}`
      :single<=0
        ?`当前 +${current}：100% 到 +${current+2}`
        :`当前 +${current}：${percentText(single)} 到 +${current+1}，${percentText(double)} 到 +${current+2}`;
    return {sentence,rows:[],cost,costY:ENHANCEMENT_ODDS_ROW_TOP};
  }
  const rows:EnhancementOutcomeRow[]=[];
  const row=(chance:number,result:number,tone:EnhancementOutcomeTone)=>{
    const value=clamp(chance);
    if(value<=0)return;
    rows.push({result:`→ +${result}`,chance:percentText(value),tone});
  };
  row(odds.failure,Math.max(0,current-1),'loss');
  row(odds.success-odds.double,current+1,'single');
  row(odds.double,current+2,'double');
  return {
    current:`当前 +${current}`,
    rows,
    cost,
    costY:rows.length?ENHANCEMENT_ODDS_ROW_TOP+rows.length*ENHANCEMENT_ODDS_ROW_STRIDE:ENHANCEMENT_ODDS_ROW_TOP
  };
}

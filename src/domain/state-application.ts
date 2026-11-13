import {passesChanceThreshold} from './action-state.ts';
import type {BattleStateKey} from './battle-semantics.ts';
import type {StateDurationProfile} from './battle.ts';

type StateDurationScale=1|0.5;

/** 抗性判定按千分制掷 1..999；结果严格小于抗性阈值才算抵抗成功。 */
const RESISTANCE_ROLL_MAX=999;

/** 目标的固有状态规则；装备免疫和实时抵抗数值由调用方另行提供。 */
export interface StateApplicationRules<State extends string=BattleStateKey> {
  immuneToAllStates?:boolean;
  immuneStates?:readonly State[];
  durationScale?:StateDurationScale;
  buffDurationScaleByState?:Partial<Record<State,StateDurationScale>>;
  frameDurationScale?:StateDurationScale;
}

export type StateApplicationRequest<State extends string=BattleStateKey> = {
  state:State;
  sourceRelation:'hostile'|'friendly'|'none';
  rules?:StateApplicationRules<State>;
  specificImmunityValue?:number;
  resistanceThreshold?:number;
} & ({kind:'action';chanceThreshold:number}|{kind:'buff'});

/** 三个缩短阶段分别取整，调用方用已编译的年龄方案选择寿命。 */
type StateApplicationDecision =
  | {allowed:false;reason:'missing-source'|'chance'|'immune'|'resisted'}
  | {allowed:true;durationScale:StateDurationScale;buffDurationScale:StateDurationScale;frameDurationScale:StateDurationScale};

/** 只决定能否进入状态创建；刷新、来源关联和节点分配由状态容器负责。 */
export function resolveStateApplication<State extends string>(request:StateApplicationRequest<State>,
  random:()=>number=Math.random):StateApplicationDecision {
  if(request.kind==='action'){
    if(request.sourceRelation==='none')return {allowed:false,reason:'missing-source'};
    if(!passesChanceThreshold(request.chanceThreshold,random))return {allowed:false,reason:'chance'};
  }
  const rules=request.rules;
  if(rules?.immuneToAllStates||rules?.immuneStates?.includes(request.state)||(request.specificImmunityValue??0)>0)
    return {allowed:false,reason:'immune'};
  const resistance=request.resistanceThreshold??0;
  if(request.sourceRelation==='hostile'&&resistance>0&&1+Math.floor(random()*RESISTANCE_ROLL_MAX)<resistance)
    return {allowed:false,reason:'resisted'};
  return {allowed:true,durationScale:rules?.durationScale??1,
    buffDurationScale:request.kind==='buff'?rules?.buffDurationScaleByState?.[request.state]??1:1,
    frameDurationScale:rules?.frameDurationScale??1};
}

/** 原版状态寿命换算：先按 15/10 截断，缩短分支先把原值折半再换算。 */
export function frameStateDurationProfile(raw:number):StateDurationProfile {
  const age=(value:number)=>Math.trunc(value*15/10);
  return {normal:{lastActiveFrame:age(raw)},targetShortened:{lastActiveFrame:age(raw>>1)}};
}

/** 导出阶段已保留各次取整；运行时只选择目标规则对应的最终帧龄。 */
export function selectStateDurationProfile(profile:StateDurationProfile,
  decision:Extract<StateApplicationDecision,{allowed:true}>):{lastActiveFrame:number} {
  const branch=decision.buffDurationScale===0.5
    ?decision.durationScale===0.5?'buffAndTargetShortened':'buffShortened'
    :decision.durationScale===0.5?'targetShortened':'normal';
  const timing=profile[branch];
  if(!timing)throw new Error(`状态持续方案缺少 ${branch}`);
  return {lastActiveFrame:Math.trunc(timing.lastActiveFrame*decision.frameDurationScale)};
}

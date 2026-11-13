import type {PlacedRect} from './rect-distance.ts';
import {rectDistance} from './rect-distance.ts';

export interface HealCandidate extends PlacedRect {id:string;team:string}

export interface HealSlot<T extends HealCandidate> {
  actor:T;
  /** 原版 situation 1：仍在场上；HP 归零但还在等判定的也算。 */
  active:boolean;
  /** 有显示形态才参与候选。 */
  hasDisplay:boolean;
  /** 原版评分，越低越优先；省略表示这个槽不参与治疗候选。 */
  score?:number;
}

/** 治疗评分以生命百分比为基数。 */
const HEALTH_PERCENT_SCALE = 100;
/** 打出过伤害的角色权重放大到 13/10，优先于只受过伤的角色。 */
const DAMAGED_TARGET_WEIGHT = 13;
const UNDAMAGED_TARGET_WEIGHT = 10;
const TARGET_SCORE_DIVISOR = 10;
/** 没有候选时使用；任何真实评分都比它低。 */
const NO_CANDIDATE_SCORE = Number.POSITIVE_INFINITY;

/** 原版治疗选人评分：生命百分比，打出过伤害的角色按 13/10 放大。 */
export function healTargetScore(health:number,maxHealth:number,hasDealtDamage:boolean):number {
  if(maxHealth===0)return 0;
  return Math.trunc(Math.trunc(health*HEALTH_PERCENT_SCALE/maxHealth)*(hasDealtDamage?DAMAGED_TARGET_WEIGHT:UNDAMAGED_TARGET_WEIGHT)/TARGET_SCORE_DIVISOR);
}

/**
 * 原版 CHAR_SelectHealTarget：枚举角色池里同阵营、在场上、有显示形态、矩形格距 +2 ≤ 范围的角色，
 * 取评分最低者，相等保留先遇到的；一个都没有时回到施法者自己。候选池由调用方按原版顺序给出。
 */
export function selectHealTarget<T extends HealCandidate>(caster:T,
  slots:readonly (HealSlot<T>|undefined)[],rangeUnits:number):T {
  let best:T|undefined,bestScore=NO_CANDIDATE_SCORE;
  for(const slot of slots){
    if(!slot?.active||!slot.hasDisplay||slot.actor.team!==caster.team)continue;
    if(slot.score===undefined)continue;
    if(rectDistance(caster,slot.actor)+2>rangeUnits)continue;
    if(slot.score<bestScore){best=slot.actor;bestScore=slot.score;}
  }
  return best??caster;
}

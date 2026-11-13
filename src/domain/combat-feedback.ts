import type { PhysicalHit } from './physical-hit.ts';
import type { Point } from './navigation.ts';

export type HitEffectStyle='weapon'|'skill';
export interface CombatFeedbackDefinition {
  digits:Record<'enemy'|'enemyCritical'|'party'|'partyCritical'|'miss',string[]>;
  normalImpacts:string[];skillImpact:string;criticalImpact:string;criticalRing:string;
  criticalBursts:string[];missEffect:string;shakeOffsets:Point[];
}
export interface CombatHitFeedback {
  hit:PhysicalHit;style:HitEffectStyle;periodic:boolean;
  casterControlled:boolean;targetFriendly:boolean;targetParty:boolean;
  /** 当前操控角色或其召唤物是攻击者或目标。 */
  involvesControlled:boolean;
}
export function feedbackEffects(definition:CombatFeedbackDefinition):string[] {
  return [...Object.values(definition.digits).flat(),...definition.normalImpacts,definition.skillImpact,
    definition.criticalImpact,definition.criticalRing,...definition.criticalBursts,definition.missEffect];
}

/** 命中时可能出现的装饰特效（不含伤害数字），供进战斗时预热。 */
export function feedbackImpactEffects(definition:CombatFeedbackDefinition):string[] {
  return [...new Set([...definition.normalImpacts,definition.skillImpact,definition.criticalImpact,
    definition.criticalRing,...definition.criticalBursts,definition.missEffect])];
}
export interface CombatFeedbackPlan {
  digits:boolean;
  digitStyle:'enemy'|'enemyCritical'|'party'|'partyCritical'|'miss';
  impact:'miss'|'normal'|'critical'|null;
  flash:boolean;
  shake:boolean;
}
/** 一次命中只算一遍，选择素材、闪光和数字都读同一份计划。 */
export function feedbackPlan(event:CombatHitFeedback):CombatFeedbackPlan {
  const {hit}=event;
  const visible=event.involvesControlled||event.targetParty;
  const critical=hit.kind==='critical';
  return {
    digits:visible&&(hit.kind==='miss'||hit.damage>0),
    digitStyle:hit.kind==='miss'?'miss':event.targetFriendly?(critical?'partyCritical':'party'):(critical?'enemyCritical':'enemy'),
    impact:hit.kind==='miss'?(visible?'miss':null):hit.damage<=0||event.periodic?null:
      critical?(event.involvesControlled?'critical':null):hit.kind==='hit'?'normal':null,
    flash:hit.damage>0,
    shake:hit.damage>0&&critical&&event.casterControlled&&!event.periodic
  };
}
export interface CombatFeedbackSelection {
  impacts:{name:string;attached:boolean}[];
  digitEffect?:string;
}
/** Resolve shared combat randomness before rendering visibility or digit-pool capacity can reject an effect. */
export function selectFeedbackAssets(event:CombatHitFeedback,definition:CombatFeedbackDefinition,
  random:()=>number=Math.random,criticalDecorations=true,plan:CombatFeedbackPlan=feedbackPlan(event)):CombatFeedbackSelection {
  const selection:CombatFeedbackSelection={impacts:[]};
  const choose=(values:readonly string[])=>values.length===1?values[0]!:values[Math.floor(random()*values.length)]!;
  if(plan.impact==='miss')selection.impacts.push({name:definition.missEffect,attached:true});
  if(plan.impact==='normal')selection.impacts.push({name:event.style==='skill'?definition.skillImpact:choose(definition.normalImpacts),attached:true});
  if(plan.impact==='critical'){
    // 关闭装饰也先抽一次爆闪，保证后续战斗随机序列与开启时一致。
    const burst=choose(definition.criticalBursts);
    selection.impacts.push({name:event.style==='skill'?definition.skillImpact:definition.criticalImpact,attached:true});
    if(criticalDecorations)selection.impacts.push(
      {name:definition.criticalRing,attached:true},{name:burst,attached:false});
  }
  if(plan.digits)selection.digitEffect=choose(definition.digits[plan.digitStyle]);
  return selection;
}
/** 数字使用固定世界落点，后续不跟随受击者移动。 */
export function damageDigits(damage:number,miss=false) {
  const digits=miss?[10]:String(Math.max(0,Math.trunc(damage))).split('').map(Number);
  return digits.map((digit,index)=>({digit,x:miss?0:-digits.length*4+index*8,y:miss?0:(index%2)*2,
    delayMs:index*60,holdFrames:digits.length-1-index}));
}
/** 数字素材的第 5 帧（下标 4）是保持帧，重复 holdFrames 次。 */
const DIGIT_HOLD_FRAME = 4;
/** 帧序列只由帧数和保持帧数决定；按「帧数:保持帧数」缓存后每次命中不再重建小数组。 */
const digitSequences=new Map<string,readonly number[]>();
export function digitSequence(frames:number,holdFrames:number):readonly number[] {
  const key=`${frames}:${holdFrames}`;
  let sequence=digitSequences.get(key);
  if(!sequence){
    sequence=Array.from({length:frames},(_,frame)=>Array(frame===DIGIT_HOLD_FRAME?holdFrames+1:1).fill(frame)).flat();
    digitSequences.set(key,sequence);
  }
  return sequence;
}

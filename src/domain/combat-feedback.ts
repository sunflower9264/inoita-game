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
export function feedbackPlan(event:CombatHitFeedback) {
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
  } as const;
}
export interface CombatFeedbackSelection {
  impacts:{name:string;attached:boolean}[];
  digitEffect?:string;
}
/** Resolve shared combat randomness before rendering visibility or digit-pool capacity can reject an effect. */
export function selectFeedbackAssets(event:CombatHitFeedback,definition:CombatFeedbackDefinition,
  random:()=>number=Math.random,criticalDecorations=true):CombatFeedbackSelection {
  const plan=feedbackPlan(event),selection:CombatFeedbackSelection={impacts:[]};
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
export function digitSequence(frames:number,holdFrames:number):number[] {
  return Array.from({length:frames},(_,frame)=>Array(frame===4?holdFrames+1:1).fill(frame)).flat();
}
/** 原版满池时替换进度最大的项；尚未开始或仍在首帧的项不能被替换。 */
export function reusableDigit(progress:readonly number[]):number {
  let chosen=-1,maximum=0;
  for(let i=0;i<progress.length;i++)if(progress[i]>maximum){chosen=i;maximum=progress[i];}
  return chosen;
}

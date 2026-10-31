/**
 * 强化与镶嵌的概率规则。
 *
 * 结算是整数判定（`enhancementSucceeds`），界面展示是同一组阈值换算出的概率；
 * 把常量与阈值放在这里，避免界面复制公式后和结算漂移。
 */
export const ENHANCEMENT_ROLL_MAX=998;
const CHAOS_CHANCE_NUMERATOR=50000,CHAOS_CHANCE_BASE=10;
const SECOND_CHANCE_NUMERATOR=1500,SECOND_CHANCE_OFFSET=5;

export interface EnhancementOdds {
  /** 本次不降级的概率。 */
  success:number;
  /** 最终 +2 的概率；混沌卷轴是两次判定的联合概率。 */
  double:number;
  /** 失败降 1 级的概率；普通卷轴为 0。 */
  failure:number;
  losesLevel:boolean;
}

/** 阈值换算成概率：原版 `1 + floor(random * 998) < trunc(threshold)`。 */
export function enhancementChance(threshold:number):number {
  if(!Number.isFinite(threshold))return 0;
  const value=Math.trunc(threshold);
  return Math.min(ENHANCEMENT_ROLL_MAX,Math.max(0,value-1))/ENHANCEMENT_ROLL_MAX;
}

/** 混沌卷轴第一次判定：失败降 1 级。 */
export function chaosThreshold(level:number):number {
  return CHAOS_CHANCE_NUMERATOR/(CHAOS_CHANCE_BASE+level*level);
}

/** 第二次判定：`raised` 是已经 +1 的等级。 */
export function doubleThreshold(raised:number,bonusChance=0):number {
  return SECOND_CHANCE_NUMERATOR/(raised+SECOND_CHANCE_OFFSET)+bonusChance;
}

/** 一次强化的完整概率；普通卷轴不会降级，混沌卷轴先过第一次判定。 */
export function enhancementOdds(level:number,requiresEnhanced:boolean,bonusChance=0):EnhancementOdds {
  const double=enhancementChance(doubleThreshold(level+1,bonusChance));
  if(!requiresEnhanced)return {success:1,double,failure:0,losesLevel:false};
  const success=enhancementChance(chaosThreshold(level));
  return {success,double:success*double,failure:1-success,losesLevel:true};
}

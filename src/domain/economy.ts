/** 体验版金币获取倍率：掉落与任务奖励统一放大，缩短攒钱时间。 */
export const MONEY_GAIN_MULTIPLIER = 10;

/** 把作者态的金币数量换算成实际发放数量；调用方保证传入非负整数。 */
export function moneyGain(base: number): number {
  return base * MONEY_GAIN_MULTIPLIER;
}

/** 概率按千分比记录：1000 必定成功；其余对 1–999 的随机整数做严格小于比较。 */
const CERTAIN_CHANCE_PER_THOUSAND=1000;
const CHANCE_ROLL_MAX=999;

export function passesChanceThreshold(threshold:number,random:()=>number=Math.random):boolean {
  return threshold===CERTAIN_CHANCE_PER_THOUSAND||Math.floor(random()*CHANCE_ROLL_MAX)+1<threshold;
}

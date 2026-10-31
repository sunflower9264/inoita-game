/** 阈值为 1000 时必成；其余情况对 1–999 的随机整数做严格小于比较。 */
export function passesChanceThreshold(threshold:number,random:()=>number=Math.random):boolean {
  return threshold===1000||Math.floor(random()*999)+1<threshold;
}

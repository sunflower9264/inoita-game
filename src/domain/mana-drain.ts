/** 吸收量按公式计算；目标魔力不足只限制扣除量，施法者仍获得完整吸收量。 */
export function drainMana(amount:number,targetMana:number,casterMana:number,casterMaxMana:number){
  const gain=Math.max(0,Math.trunc(amount));
  return {targetMana:Math.max(0,targetMana-gain),casterMana:Math.min(casterMaxMana,casterMana+gain)};
}

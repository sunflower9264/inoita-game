import type { CharacterStatsCatalog, PrimaryAttributes, PrimaryStat } from './character-stats.ts';
import { rollLegendaryWeapon } from './drops.ts';
import type { DropCatalog } from './drops.ts';
import { groundLootFor } from './ground-loot.ts';
import type { ItemInstance } from './items.ts';
import type { Session } from './session.ts';

export interface LegendaryWeaponsState { used:string[] }

export class LegendaryWeapons {
  private readonly used = new Set<string>();
  private key(mapId:string,entityId:string):string { return `${mapId}:${entityId}`; }
  captureState():LegendaryWeaponsState { return { used:[...this.used].sort() }; }
  restoreState(state?:LegendaryWeaponsState):void { if(!state)return; this.used.clear(); for(const key of state.used)this.used.add(key); }
  isPulled(mapId:string,entityId:string):boolean { return this.used.has(this.key(mapId,entityId)); }
  markPulled(mapId:string,entityId:string):void { this.used.add(this.key(mapId,entityId)); }
}

export interface LegendaryPullResult { success:boolean; message:string; item?:ItemInstance; unique?:boolean; }

const LEGENDARY_STATS=['strength','dexterity','intelligence'] as const;

function draw(random:()=>number,max:number):number {
  const value=random();
  if(!Number.isFinite(value)||value<0||value>=1)throw new Error('拔剑随机值无效');
  return Math.floor(value*max);
}

/**
 * 原版 `CAL_Calculate(EXPRESSBASE[20], {stat, level})` 的整数判定：
 * `threshold = 100 * sdiv(stat, 2*level)`，1..99 的掷点只在 threshold >=100 时成功。
 * 等价于 `mapLevel > 0 && stat >= 2*mapLevel`；地图等级 0 时原版除以 0，判失败。
 */
export function legendaryStatGate(attributes:PrimaryAttributes,mapLevel:number,random:()=>number):{stat:PrimaryStat;value:number;success:boolean} {
  const stat:PrimaryStat=LEGENDARY_STATS[draw(random,LEGENDARY_STATS.length)]!;
  const value=attributes[stat]??0;
  return {stat,value,success:mapLevel>0&&value>=2*mapLevel};
}

export function pullLegendaryWeapon(session:Session,stats:CharacterStatsCatalog,catalog:DropCatalog,mapId:string,entityId:string,mapLevel:number,random:()=>number,position:{x:number;y:number},uniqueBonus=0):LegendaryPullResult {
  // 原版先 CHAR_SetSituation(...,5) 再判定：失败也会消耗。
  session.legendaryWeapons.markPulled(mapId,entityId);
  const hero=session.hero;
  if(!hero)return {success:false,message:'能力不足，无法获得武器。'};
  // 体验版兜底：地图等级 0 按 1 处理，避免原版除零让这把剑永远拔不出。
  const level=Math.max(1,mapLevel);
  const gate=legendaryStatGate(hero.panel.attributes,level,random);
  if(!gate.success)return {success:false,message:'能力不足，无法获得武器。'};
  const reward=rollLegendaryWeapon(catalog,stats,level,random,uniqueBonus);
  if(!reward)return {success:false,message:'能力不足，无法获得武器。'};
  let prepared:ItemInstance|undefined;
  try {
    prepared=session.bag.prepareDrop(reward.item,{grade:reward.grade,sockets:reward.sockets});
    session.bag.receiveDrop(prepared);
  } catch {
    // 体验版背包无限，正常走不到这里；保留原版“掉在剑的位置”的兜底。
    if(prepared)groundLootFor(session).add(mapId,position.x,position.y,[{kind:'item',item:reward.item,quantity:1,instance:prepared}]);
    else return {success:false,message:'能力不足，无法获得武器。'};
  }
  return {success:true,message:reward.unique?'获得了传说中的武器。':'成功获得武器。',item:prepared,unique:reward.unique};
}

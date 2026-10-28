/** 全局账本容量：3 人上阵加各自召唤物时，单敌最多约 6 条存在仇恨；256 留出伤害来源的余量。 */
export const THREAT_CAPACITY=256;

/** 超过这个矩形距离，伤害和治疗仇恨按远程权重折算。 */
const REMOTE_THREAT_RANGE_UNITS=30;
/** 远程伤害仇恨按 80% 计，近身保持 100%。 */
const REMOTE_DAMAGE_THREAT_PERCENT=80;
const NEARBY_DAMAGE_THREAT_PERCENT=100;
/** 治疗仇恨权重：逐单位治疗量先乘权重，再除以一百万。 */
const REMOTE_HEALING_THREAT_WEIGHT=15;
const NEARBY_HEALING_THREAT_WEIGHT=20;
const HEALING_THREAT_DIVISOR=1_000_000;
/** 状态仇恨：施法者等级 × 200，再除以十万。 */
const STATE_THREAT_PER_LEVEL=200;
const STATE_THREAT_DIVISOR=100_000;
/** 新目标要超过当前目标 110% 才切换，避免分数接近时反复改目标。 */
const THREAT_SWITCH_PERCENT=110;
/** 嘲讽把同阵营竞争者压到施法者分数的 80%。 */
const TAUNT_RIVAL_CEILING_PERCENT=80;
/** 超出视距后，每次资源脉冲先减半，再扣固定值。 */
const DECAY_FLAT_PENALTY=10;

interface ThreatEntry {
  ownerId:string;
  sourceId:string;
  /** 仇恨分数保留有符号整数，零值与负值等到共用脉冲时清理。 */
  score:number;
  /** 最后一次接受新增仇恨的共用战斗逻辑帧。 */
  updatedTick:number;
}

export interface ThreatLedgerState {entries:ThreatEntry[];}

interface ThreatAdditionRules {
  /** 来源角色的千分比减率；正值才生效，可超过1000。 */
  sourceReductionRate?:number;
  /** 嘲讽状态节点的来源；省略表示当前没有来源限制。 */
  allowedSourceId?:string;
}

interface ThreatRate {generationRate?:number;}
interface DamageThreatInput extends ThreatRate {damage:number;rectangleDistanceUnits:number;}
interface HealingThreatInput extends ThreatRate {actualHealing:number;rectangleDistanceUnits:number;}
interface StateThreatInput extends ThreatRate {casterLevel:number;}

function integer(value:number,name:string):number {
  if(!Number.isInteger(value)||value<-2147483648||value>2147483647)
    throw new Error(`${name}必须是32位有符号整数`);
  return value;
}

function distance(value:number):number {
  if(integer(value,'矩形距离')<0)throw new Error('矩形距离必须非负');
  return value;
}

function actorId(value:string):void {
  if(typeof value!=='string'||!value.length)throw new Error('仇恨角色标识不能为空');
}

function logicTick(value:number):void {
  if(!Number.isSafeInteger(value)||value<0)throw new Error('仇恨更新时间必须是非负安全整数');
}

function generationRate(value=1000):number {return Math.max(0,integer(value,'仇恨生成倍率'));}
function divide(value:number,divisor:number):number {return Math.trunc(value/divisor)||0;}

/** 统一新增入口的减率；负增量同样修正，不把结果夹到零。 */
export function reduceThreat(amount:number,reductionRate=0):number {
  integer(amount,'仇恨增量');integer(reductionRate,'仇恨减率');
  return reductionRate>0?(amount-divide(Math.imul(amount,reductionRate),1000))|0:amount;
}

/** 传入实际 AddDamage 的伤害，包含过量伤害；矩形距离不含近身的两个单位。 */
export function calculateDamageThreat(input:DamageThreatInput):number {
  const damage=integer(input.damage,'伤害'),range=distance(input.rectangleDistanceUnits);
  const rate=generationRate(input.generationRate);
  if(damage<1)return 0;
  const percent=range>REMOTE_THREAT_RANGE_UNITS?REMOTE_DAMAGE_THREAT_PERCENT:NEARBY_DAMAGE_THREAT_PERCENT;
  const adjusted=divide(Math.imul(damage,percent),100);
  return divide(Math.imul(adjusted,rate),1000);
}

/** 只用于动作治疗的实际 HP 变化；宿主先筛当前锁定被治疗者的敌人。 */
export function calculateHealingThreat(input:HealingThreatInput):number {
  const healing=integer(input.actualHealing,'实际治疗量'),range=distance(input.rectangleDistanceUnits);
  const weight=range>REMOTE_THREAT_RANGE_UNITS?REMOTE_HEALING_THREAT_WEIGHT:NEARBY_HEALING_THREAT_WEIGHT;
  return divide(Math.imul(Math.imul(healing,weight),generationRate(input.generationRate)),HEALING_THREAT_DIVISOR);
}

/** 宿主仅在直接动作状态成功且双方敌对时调用；Buff状态与嘲讽不走此入口。 */
export function calculateStateThreat(input:StateThreatInput):number {
  const level=integer(input.casterLevel,'施法者等级');
  if(level<0)throw new Error('施法者等级必须非负');
  return divide(Math.imul(Math.imul(level,STATE_THREAT_PER_LEVEL),generationRate(input.generationRate)),STATE_THREAT_DIVISOR);
}

/** 全部敌方角色共用的有序账本；世界负责关系、目标有效性和共用脉冲。 */
export class ThreatLedger {
  private records:ThreatEntry[]=[];

  add(ownerId:string,sourceId:string,amount:number,tick:number,rules:ThreatAdditionRules={}):boolean {
    actorId(ownerId);actorId(sourceId);integer(amount,'仇恨增量');logicTick(tick);
    if(rules.allowedSourceId!==undefined&&rules.allowedSourceId!==sourceId)return false;
    const increment=reduceThreat(amount,rules.sourceReductionRate);
    const entry=this.ensureEntry(ownerId,sourceId,tick);
    entry.score=(entry.score+increment)|0;
    entry.updatedTick=tick;
    return true;
  }

  /** 该 owner 下满足条件的最高分；没有条目时返回 undefined。 */
  highest(ownerId:string,isEligible:(sourceId:string)=>boolean):number|undefined {
    let maximum:number|undefined;
    for(const entry of this.records)
      if(entry.ownerId===ownerId&&isEligible(entry.sourceId)&&(maximum===undefined||entry.score>maximum))
        maximum=entry.score;
    return maximum;
  }

  /**
   * 只升不降地把 (owner,source) 抬到 floor，用于召唤物登场确定性地抢仇恨。
   * 不经过生成减率；来源门由调用方先判定。分数已不低于 floor 时不刷新 updatedTick。
   */
  raiseTo(ownerId:string,sourceId:string,floor:number,tick:number):boolean {
    actorId(ownerId);actorId(sourceId);integer(floor,'仇恨下限');logicTick(tick);
    if(floor<0)throw new Error('仇恨下限必须非负');
    let entry=this.records.find(record=>record.ownerId===ownerId&&record.sourceId===sourceId);
    if(entry&&entry.score>=floor)return false;
    if(!entry)entry=this.ensureEntry(ownerId,sourceId,tick);
    entry.score=floor;entry.updatedTick=tick;
    return true;
  }

  score(ownerId:string,sourceId:string):number|undefined {
    return this.records.find(entry=>entry.ownerId===ownerId&&entry.sourceId===sourceId)?.score;
  }

  entries(ownerId?:string):Readonly<ThreatEntry>[] {
    return this.records.filter(entry=>ownerId===undefined||entry.ownerId===ownerId).map(entry=>({...entry}));
  }

  clearOwner(ownerId:string):void {this.removeWhere(entry=>entry.ownerId===ownerId);}
  removeActor(id:string):void {this.removeWhere(entry=>entry.ownerId===id||entry.sourceId===id);}
  clear():void {this.records=[];}

  /** 在每次资源恢复后调用一次；越距判断使用角色矩形距离与自身视距。 */
  decay(isBeyondSight:(ownerId:string,sourceId:string)=>boolean):void {
    for(let index=0;index<this.records.length;){
      const entry=this.records[index];
      if(isBeyondSight(entry.ownerId,entry.sourceId))entry.score=(entry.score>>1)-DECAY_FLAT_PENALTY;
      if(entry.score<1)this.removeAt(index);
      else index++;
    }
  }

  /** 最大值候选由宿主筛 active、敌对及隐身；当前目标失效由宿主先清理。 */
  select(ownerId:string,currentSourceId:string|undefined,isEligible:(sourceId:string)=>boolean):string|undefined {
    let maximum:ThreatEntry|undefined;
    for(const entry of this.records){
      if(entry.ownerId!==ownerId||!isEligible(entry.sourceId))continue;
      if(!maximum||entry.score>maximum.score)maximum=entry;
    }
    if(!maximum)return currentSourceId;
    const current=currentSourceId===undefined?undefined:this.score(ownerId,currentSourceId);
    if(current!==undefined&&maximum.score<divide(Math.imul(current,THREAT_SWITCH_PERCENT),100))return currentSourceId;
    return maximum.sourceId;
  }

  /** 嘲讽先压低竞争者，再由宿主尝试状态；这一步不走新增减率或更新时间。 */
  clampCompetitors(ownerId:string,casterId:string,isSameCasterFaction:(sourceId:string)=>boolean):boolean {
    const casterScore=this.score(ownerId,casterId);
    if(casterScore===undefined)return false;
    const ceiling=divide(Math.imul(casterScore,TAUNT_RIVAL_CEILING_PERCENT),100);
    for(const entry of this.records)
      if(entry.ownerId===ownerId&&entry.sourceId!==casterId&&entry.score>ceiling&&isSameCasterFaction(entry.sourceId))
        entry.score=ceiling;
    return true;
  }

  captureState():ThreatLedgerState {return {entries:this.records.map(entry=>({...entry}))};}

  restoreState(state:ThreatLedgerState):void {
    if(!Array.isArray(state.entries)||state.entries.length>THREAT_CAPACITY)throw new Error('仇恨快照超过全局容量');
    const restored:ThreatEntry[]=[];
    for(const entry of state.entries){
      actorId(entry.ownerId);actorId(entry.sourceId);integer(entry.score,'仇恨分数');logicTick(entry.updatedTick);
      if(restored.some(previous=>previous.ownerId===entry.ownerId&&previous.sourceId===entry.sourceId))
        throw new Error('仇恨快照包含重复来源');
      restored.push({ownerId:entry.ownerId,sourceId:entry.sourceId,score:entry.score,updatedTick:entry.updatedTick});
    }
    this.records=restored;
  }

  private ensureEntry(ownerId:string,sourceId:string,tick:number):ThreatEntry {
    const existing=this.records.find(record=>record.ownerId===ownerId&&record.sourceId===sourceId);
    if(existing)return existing;
    if(this.records.length===THREAT_CAPACITY){
      let oldest=0;
      for(let index=1;index<this.records.length;index++)
        if(this.records[index].updatedTick<this.records[oldest].updatedTick)oldest=index;
      this.removeAt(oldest);
    }
    const entry={ownerId,sourceId,score:0,updatedTick:tick};
    this.records.push(entry);
    return entry;
  }

  private removeWhere(predicate:(entry:ThreatEntry)=>boolean):void {
    for(let index=0;index<this.records.length;)
      if(predicate(this.records[index]))this.removeAt(index);else index++;
  }

  private removeAt(index:number):void {
    const last=this.records.pop()!;
    if(index<this.records.length)this.records[index]=last;
  }
}

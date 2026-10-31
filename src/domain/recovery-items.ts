import type { Bag } from './bag.ts';
import { LOGIC_FRAME_MS } from './battle.ts';

interface RecoveryMember {
  id: string;
  player: Readonly<{health:number;maxHealth:number;mana:number;maxMana:number}>;
  setHealth(value:number):void;
  setMana(value:number):void;
}
interface RecoveryModifiers {
  sleeping?: boolean;
  potionSickness?: boolean;
  weakened?: boolean;
  recoveryBonus?: boolean;
  cooldownReductionMs?: number;
}
export type RecoveryResult = {used:false;reason:'unavailable'|'blocked'|'cooldown'|'full-health'} |
  {used:true;amount:number;healed:string[];effects:string[]};

/**
 * 持续回复的剩余时间与每脉冲加成。数值来自物品自身的用时数据
 * （原版 `ITEMBUFFBASE` → `BUFFDATABASE` → `BUFFUNITBASE`），加在既有的资源回复脉冲上。
 */
export interface RegenerationState { remainingMs:number; healthRecoveryPerPulse:number; manaRecoveryPerPulse:number }
export interface RecoveryItemsState { elapsedMs:number; nextTick:number; durationMs:number; regeneration?:RegenerationState }

/** One party-wide clock, advanced only by active gameplay. */
export class RecoveryItems {
  private elapsedMs = 0;
  private nextTick = -1;
  private durationMs = 9900;
  private regeneration?:RegenerationState;
  /** 当前生效的持续回复；没有或已到时返回 undefined。资源回复读取它加每脉冲点数。 */
  get activeRegeneration():Readonly<RegenerationState>|undefined {
    return this.regeneration&&this.regeneration.remainingMs>0?this.regeneration:undefined;
  }
  captureState():RecoveryItemsState {
    return {elapsedMs:this.elapsedMs,nextTick:this.nextTick,durationMs:this.durationMs,
      regeneration:this.regeneration?{...this.regeneration}:undefined};
  }
  restoreState(state:RecoveryItemsState):void {
    this.elapsedMs=state.elapsedMs;this.nextTick=state.nextTick;this.durationMs=state.durationMs;
    this.regeneration=state.regeneration?{...state.regeneration}:undefined;
  }
  advance(deltaMs:number):void {
    if(!Number.isFinite(deltaMs)||deltaMs<=0)return;
    this.elapsedMs+=deltaMs;
    if(this.regeneration)this.regeneration.remainingMs=Math.max(0,this.regeneration.remainingMs-deltaMs);
  }
  private get tick():number { return Math.floor(this.elapsedMs/LOGIC_FRAME_MS); }
  get cooldown():{remainingMs:number;durationMs:number;cooling:boolean} {
    return {remainingMs:Math.max(0,(this.nextTick-this.tick)*LOGIC_FRAME_MS),durationMs:this.durationMs,cooling:this.tick<=this.nextTick};
  }
  use(bag:Bag,entryId:string,members:readonly RecoveryMember[],userId:string,modifiers:RecoveryModifiers={},random= Math.random):RecoveryResult {
    const entry=bag.get(entryId),use=entry&&bag.catalog.items[entry.item].use;
    const user=members.find(member=>member.id===userId),kind=use?.kind;
    const usable=kind==='recover-health'&&use?.recovery||kind==='regenerate'&&use?.regenerate;
    if(!entry||!bag.entries.some(item=>item.id===entryId)||!usable||!user||user.player.health<=0)
      return {used:false,reason:'unavailable'};
    if(modifiers.sleeping)return {used:false,reason:'blocked'};
    // 持续回复与一次性回复各有各的门槛：它没有共用冷却，靠自身时限与物品消耗约束。
    if(kind==='regenerate'){
      const regeneration=use!.regenerate!;
      this.regeneration={remainingMs:regeneration.durationMs,healthRecoveryPerPulse:regeneration.healthRecoveryPerPulse,
        manaRecoveryPerPulse:regeneration.manaRecoveryPerPulse};
      bag.take(entryId,1);
      return {used:true,amount:0,healed:[],effects:members.filter(member=>member.player.health>0).map(member=>member.id)};
    }
    // 药水病只影响一次性恢复，再生药水已经在上面返回。
    if(modifiers.potionSickness)return {used:false,reason:'blocked'};
    if(this.tick<=this.nextTick)return {used:false,reason:'cooldown'};
    const recovery=use!.recovery!;
    // amount：在区间内随机**一次**，全队同一数值。rate：各按自己的上限算，所以逐人计算。
    const rolled=recovery.mode==='amount'
      ? recovery.minHealth+Math.floor(Math.max(0,Math.min(1-Number.EPSILON,random()))*(recovery.maxHealth-recovery.minHealth+1))
      : 0;
    const scaled=(amount:number):number=>{
      let value=amount;
      if(modifiers.weakened)value=Math.floor(value/2);
      if(modifiers.recoveryBonus)value+=Math.floor(value/10);
      return value;
    };
    const healed:string[]=[],effects:string[]=[],changes:{member:RecoveryMember;health:number;mana:number}[]=[];
    for(const member of members){
      const {health,maxHealth,mana,maxMana}=member.player;
      if(health<=0)continue;
      const healthAmount=scaled(recovery.mode==='amount'?rolled:Math.trunc(maxHealth*recovery.ratePercent/100));
      const manaAmount=recovery.restoresMana?scaled(recovery.mode==='amount'?rolled:Math.trunc(maxMana*recovery.ratePercent/100)):0;
      const nextHealth=Math.min(maxHealth,health+healthAmount);
      const nextMana=manaAmount>0?Math.min(maxMana,mana+manaAmount):mana;
      if((healthAmount>0&&nextHealth>health)||nextMana>mana){
        healed.push(member.id);changes.push({member,health:nextHealth,mana:nextMana});
      }
      // 队伍按槽位顺序处理；出现实际回复后，后续存活队员也播放恢复效果。
      if(healed.length)effects.push(member.id);
    }
    if(!healed.length)return {used:false,reason:'full-health'};
    this.durationMs=recovery.cooldownMs;
    this.nextTick=this.tick+Math.floor(Math.max(0,recovery.cooldownMs-(modifiers.cooldownReductionMs??0))/LOGIC_FRAME_MS);
    bag.take(entryId,1);
    for(const change of changes){change.member.setHealth(change.health);if(change.mana!==change.member.player.mana)change.member.setMana(change.mana);}
    // 报告的是实际生效的数值：弱点减半与佣兵团加成之后的那一个（比例式回复逐人计算，没有单值可报）。
    return {used:true,amount:recovery.mode==='amount'?scaled(rolled):0,healed,effects};
  }
}

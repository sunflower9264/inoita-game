import {ATTACK_DISTANCE_BASE_UNITS,attackDistance} from './basic-attack.ts';
import type {Combatant} from './combat.ts';
import {combatStateCapabilities} from './combat-state.ts';
import {ThreatLedger,calculateDamageThreat,calculateHealingThreat,calculateStateThreat} from './combat-threat.ts';
import type {ThreatLedgerState} from './combat-threat.ts';

export type CombatThreatRole='player'|'member'|'summon'|'enemy';

/** 存在仇恨权重：主角 10 为基准，召唤物天然更高，佣兵更低。 */
const PRESENCE_WEIGHT:Record<CombatThreatRole,number>={player:10,member:6,summon:15,enemy:10};
/** 召唤物在敌人已接战后登场，抬到当前最高分的 120%，确定性抢走目标。 */
const SUMMON_ARRIVAL_RATE=120;
const MAX_THREAT_SCORE=2147483647;
/** 狮子吼重分配：攻击者保留旧分并加上 3 倍本次伤害，同阵营其他来源的旧分减半。 */
const REDISTRIBUTION_ATTACKER_DAMAGE_WEIGHT=3;
const REDISTRIBUTION_RIVAL_SCORE_PERCENT=50;
/** 存在仇恨 = (角色等级 + 10) × 角色权重 ÷ 10。 */
const PRESENCE_LEVEL_OFFSET=10;
const PRESENCE_WEIGHT_BASE=10;

export interface CombatThreatActor extends Combatant {
  /** 仍处于活动角色阶段，包含同一动作链内等待死亡结算的零HP角色。 */
  active:boolean;
  level:number;
  sightRangeUnits:number;
  /** 当前玩家友方使用独立统计，本账本只记录设为true的角色。 */
  tracksThreat:boolean;
  /** 来源分类；世界适配层负责填充，缺省按玩家权重处理。 */
  role?:CombatThreatRole;
}

export interface CombatThreatPort {
  /** 返回地图中仍存在的角色；倒地角色可保留位置和阵营，但active为false。 */
  actor(id:string):CombatThreatActor|undefined;
  actors():readonly CombatThreatActor[];
  currentTarget(ownerId:string):string|undefined;
  logicTick():number;
  generationRate(sourceId:string):number;
  reductionRate(sourceId:string):number;
  normalDamage(sourceId:string):{physical:number;magic:number};
  tauntSource(ownerId:string):string|undefined;
  applyTaunt(sourceId:string,targetId:string):void;
  combatStarted?(ownerId:string):void;
}

export type CombatThreatSystemState=ThreatLedgerState;

/** 协调已结算效果与敌方账本；动作选择时机、HP写入、状态节点和时钟由宿主负责。 */
export class CombatThreatSystem {
  private readonly ledger=new ThreatLedger();
  private readonly port:CombatThreatPort;

  constructor(port:CombatThreatPort){this.port=port;}

  /** 每次正数AddDamage在HP写入后调用，保留过量伤害和真正的伤害来源。 */
  damage(sourceId:string,targetId:string,damage:number):void {
    if(damage<1)return;
    const source=this.port.actor(sourceId),target=this.port.actor(targetId);
    if(!source||!target||!combatStateCapabilities(target.states??[]).canReceiveDamage)return;
    this.add(target,source,calculateDamageThreat({damage,
      rectangleDistanceUnits:attackDistance(source.position,source.bounds,target.position,target.bounds)-ATTACK_DISTANCE_BASE_UNITS,
      generationRate:this.port.generationRate(sourceId)}));
  }

  /** 仅动作治疗调用；实际HP变化由宿主在SetHealth之后读取，满血的零变化也要传入。 */
  heal(sourceId:string,targetId:string,actualHealing:number):void {
    const source=this.port.actor(sourceId),target=this.port.actor(targetId);
    if(!source||!target)return;
    const generationRate=this.port.generationRate(sourceId);
    for(const owner of this.port.actors()){
      if(!owner.active||owner.team===target.team||this.port.currentTarget(owner.id)!==targetId)continue;
      this.add(owner,source,calculateHealingThreat({actualHealing,generationRate,
        rectangleDistanceUnits:attackDistance(source.position,source.bounds,owner.position,owner.bounds)-ATTACK_DISTANCE_BASE_UNITS}));
    }
  }

  /** 调用方已确认直接动作状态成功；Buff附带状态与嘲讽不调用此方法。 */
  state(sourceId:string,targetId:string):void {
    const source=this.port.actor(sourceId),target=this.port.actor(targetId);
    if(!source||!target||source.team===target.team)return;
    this.add(target,source,calculateStateThreat({casterLevel:source.level,
      generationRate:this.port.generationRate(sourceId)}));
  }

  /** 狮子吼减益的攻击者命中后，按被击者已有账目重新分配同阵营来源的仇恨。 */
  redistributeAfterPhysicalHit(attackerId:string,targetId:string,damage:number):void {
    const attacker=this.port.actor(attackerId),owner=this.port.actor(targetId);
    if(!attacker||!owner)return;
    for(const entry of this.ledger.entries(targetId)){
      const source=this.port.actor(entry.sourceId);
      if(!source||source.team!==attacker.team)continue;
      // 本人的旧分数属于新增量的一部分；所有新增量仍经过来源减率与嘲讽来源门。
      const amount=source.id===attackerId?(entry.score+Math.imul(damage,REDISTRIBUTION_ATTACKER_DAMAGE_WEIGHT))|0:
        Math.trunc(Math.imul(entry.score,-REDISTRIBUTION_RIVAL_SCORE_PERCENT)/100);
      this.add(owner,source,amount);
    }
  }

  taunt(sourceId:string,targetId:string):void {
    const source=this.port.actor(sourceId),target=this.port.actor(targetId);
    if(!source||!target||source.id===target.id)return;
    if(!this.has(targetId,sourceId)){
      const normal=this.port.normalDamage(sourceId);
      this.add(target,source,(normal.physical+normal.magic)|0);
    }
    if(!this.has(targetId,sourceId))return;
    this.ledger.clampCompetitors(targetId,sourceId,id=>this.port.actor(id)?.team===source.team);
    this.port.applyTaunt(sourceId,targetId);
  }

  /**
   * 敌人发现一个来源时记录存在仇恨；同一来源只加一次，避免全图 Boss 每帧重复叠加。
   * 召唤物被发现的瞬间就抬到当前最高分的 120%：开战前在场的召唤物也优先，
   * 不依赖它先造成伤害。
   */
  notice(ownerId:string,sourceId:string):void {
    const owner=this.port.actor(ownerId),source=this.port.actor(sourceId);
    if(!owner||!source||!owner.tracksThreat)return;
    if(this.has(ownerId,sourceId))return;
    const role=source.role??(source.team==='hostile'?'enemy':'player');
    const presence=this.presence(owner,role);
    this.add(owner,source,presence);
    // 嘲讽门拒绝时不会建条目；门解除后下一次候选扫描会重新 notice 并抬分。
    if(role==='summon'&&this.has(ownerId,sourceId)){
      const highest=this.ledger.highest(ownerId,id=>id!==sourceId&&this.eligible(owner,id));
      const hold=highest===undefined?0:Math.min(MAX_THREAT_SCORE,Math.ceil(highest*SUMMON_ARRIVAL_RATE/100));
      this.ledger.raiseTo(ownerId,sourceId,Math.max(presence,hold),this.port.logicTick());
    }
  }

  /** 新动作决策点调用；不更改已在攻击或接近中的动作目标。 */
  select(ownerId:string,currentSourceId:string|undefined):string|undefined {
    const owner=this.port.actor(ownerId);
    if(!owner)return undefined;
    if(!owner.tracksThreat)return currentSourceId;
    return this.ledger.select(ownerId,currentSourceId,id=>this.eligible(owner,id));
  }

  private presence(owner:CombatThreatActor,role:CombatThreatRole):number {
    return Math.trunc(Math.imul((owner.level+PRESENCE_LEVEL_OFFSET)|0,PRESENCE_WEIGHT[role])/PRESENCE_WEIGHT_BASE);
  }

  private eligible(owner:CombatThreatActor,sourceId:string):boolean {
    const source=this.port.actor(sourceId);
    return !!source?.active&&source.team!==owner.team&&combatStateCapabilities(source.states??[]).canTarget;
  }

  has(ownerId:string,sourceId:string):boolean {return this.ledger.score(ownerId,sourceId)!==undefined;}
  clearOwner(ownerId:string):void {this.ledger.clearOwner(ownerId);}
  removeActor(actorId:string):void {this.ledger.removeActor(actorId);}
  clear():void {this.ledger.clear();}

  /** 由共用资源脉冲在恢复之后调用；倒地、隐身不另加删除门。 */
  decay():void {
    this.ledger.decay((ownerId,sourceId)=>{
      // 当前目标不衰减：接战后要一直追，不能因为追出视距就把账目减没。
      if(this.port.currentTarget(ownerId)===sourceId)return false;
      const owner=this.port.actor(ownerId),source=this.port.actor(sourceId);
      return !!owner&&!!source&&attackDistance(owner.position,owner.bounds,source.position,source.bounds)>owner.sightRangeUnits;
    });
  }

  captureState():CombatThreatSystemState {return this.ledger.captureState();}
  restoreState(state:CombatThreatSystemState):void {this.ledger.restoreState(state);}

  private add(owner:CombatThreatActor,source:CombatThreatActor,amount:number):void {
    if(!owner.tracksThreat)return;
    const allowedSourceId=this.port.tauntSource(owner.id);
    if(allowedSourceId!==undefined&&allowedSourceId!==source.id)return;
    const sourceReductionRate=this.port.reductionRate(source.id);
    if(this.ledger.add(owner.id,source.id,amount,this.port.logicTick(),{
      allowedSourceId,sourceReductionRate}))this.port.combatStarted?.(owner.id);
  }
}

import {targetDistance} from './basic-attack.ts';
import type {Point} from './navigation.ts';
import {ACTIVE_PARTY_SLOT_COUNT} from './party-slots.ts';

interface PartyBuffActor {team:string;position:Point}

/** 按队伍槽顺序提供；显示资格与隐身状态各自独立。 */
export interface PartyBuffSlot<T extends PartyBuffActor> {
  actor:T;
  /** 仍参与战斗；同一动作链内等待死亡结算的成员仍为active。 */
  active:boolean;
  hasDisplay:boolean;
}

/** 范围单位为8像素的离散近似距离，0表示不限制距离。 */
export function partyBuffTargets<T extends PartyBuffActor>(caster:PartyBuffActor,
  slots:readonly (PartyBuffSlot<T>|undefined)[],rangeUnits:number):T[] {
  return slots.slice(0,ACTIVE_PARTY_SLOT_COUNT).flatMap(slot=>{
    if(!slot?.active||!slot.hasDisplay||slot.actor.team!==caster.team)return [];
    return rangeUnits<1||Math.floor(targetDistance(caster.position,slot.actor.position)/8)<=rangeUnits?[slot.actor]:[];
  });
}

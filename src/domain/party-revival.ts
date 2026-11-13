import type { Session } from './session.ts';

interface HealerRevivalQuote { cost:number; memberIds:string[] }

/** 治疗师复活的基础费用，只收一次。 */
const REVIVAL_BASE_COST = 10;
/** 每名阵亡队员再按等级累加的费用。 */
const REVIVAL_COST_PER_LEVEL = 2;

/** 治疗师按本次上阵的阵亡队员统一报价，基础费用只收一次。 */
export function healerRevivalQuote(session:Session):HealerRevivalQuote {
  const party=session.party;
  if(!party)return {cost:0,memberIds:[]};
  const members=party.activeIds.flatMap(id=>{
    const member=id==='player'?session.hero:party.get(id);
    return member&&member.player.health<=0?[{id,level:member.player.level}]:[];
  });
  return {cost:members.length?REVIVAL_BASE_COST+REVIVAL_COST_PER_LEVEL*members.reduce((sum,member)=>sum+member.level,0):0,memberIds:members.map(member=>member.id)};
}

/** The scene places these members beside the healer visitor and clears their combat state. */
export function reviveAtHealer(session:Session):HealerRevivalQuote {
  const quote=healerRevivalQuote(session),party=session.party;
  if(!party||!quote.memberIds.length)throw new Error('没有需要复活的队员');
  if(!party.livingIds.length)throw new Error('全队阵亡时请返回检查点或读取存档');
  if(session.money<quote.cost)throw new Error('金币不足');
  session.batchNotifications(()=>{
    session.spendMoney(quote.cost);
    for(const id of quote.memberIds){
      const member=id==='player'?session.hero!:party.get(id)!;
      member.clearCombatResourceLimits();member.recover();
    }
    party.switchControl('player');
  });
  return quote;
}

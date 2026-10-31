import type { Session } from './session.ts';

export interface InnRestQuote { cost:number; members:string[] }

/** 原版 PARTY_GetRestCost：存活出战成员数 × 主角等级，死亡成员不计入费用。 */
export function innRestQuote(session:Session):InnRestQuote {
  const party=session.party;
  const members=party?party.livingIds:(session.hero&&session.hero.player.health>0?['player']:[]);
  const level=session.hero?.level??1;
  return {cost:members.length*level,members};
}

/** 只回满存活成员；不复活、不清状态。原版 PARTY_ApplyRest 只对 situation=1 的成员加满 HP/MP。 */
export function restAtInn(session:Session,quote:InnRestQuote):void {
  for(const id of quote.members){
    if(id==='player'){
      const hero=session.hero;
      if(hero&&hero.player.health>0){hero.setHealth(hero.player.maxHealth);hero.setMana(hero.player.maxMana);}
      continue;
    }
    const member=session.party?.get(id);
    if(member&&member.player.health>0){member.setHealth(member.player.maxHealth);member.setMana(member.player.maxMana);}
  }
}

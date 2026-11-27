import {skillForMember,memberSkillGrowth,type BattleCatalog,type SkillLoadout,type SkillAction,type SkillTransition} from './battle.ts';
import {learnedSkillReactions} from './skill-reactions.ts';
import type {Combatant} from './combatant.ts';
import type {CombatRuntime} from './combat-runtime.ts';
import type {Point} from './navigation.ts';

export interface CombatFollowUpPort {
  catalog:BattleCatalog;runtime:CombatRuntime;
  loadout(id:string):{classId:string;skills:SkillLoadout}|undefined;
  random():number;active():boolean;actor(id:string):Combatant|undefined;
  casterStrikes(id:string,strikes:NonNullable<SkillTransition['casterStrikes']>):void;
  flight:Parameters<CombatRuntime['transition']>[4];
  execute(casterId:string,targetId:string|undefined,skillId:string,level:number,action:SkillAction,origin:Point|undefined):void;
}

/** 私有追击沿原版顺序抽样；其延迟与主动作分开持有，不再消耗蓝量和冷却。 */
export function combatFollowUp(kind:'god-of-justice'|'lightning-of-hell',casterId:string,targetId:string,port:CombatFollowUpPort):void {
  const learned=port.loadout(casterId);if(!learned)return;
  const reaction=learnedSkillReactions(port.catalog,learned.classId,learned.skills,memberSkillGrowth(casterId)).find(reaction=>reaction.kind===kind);
  const chance=reaction&&'chanceThreshold' in reaction?reaction.chanceThreshold:0;
  if(!(chance>0)||Math.floor(port.random()*999)+1>=chance)return;
  const skillId=kind==='god-of-justice'?'celestial-lightning':'lightning-of-hell';
  const level=kind==='god-of-justice'?learned.skills.levels[skillId]:1;if(!level)return;
  const definition=skillForMember(port.catalog,casterId,skillId);
  const action=kind==='god-of-justice'?definition?.action:definition?.followUpAction;
  if(!action||kind==='god-of-justice'&&!action.combatUnits?.length)return;
  const settle=()=>{if(!port.active())return;const target=port.actor(targetId);
    port.execute(casterId,target?.id,skillId,level,action,target?{...target.position}:undefined);};
  if(kind==='god-of-justice'){
    if(action.transition?.casterStrikes)port.casterStrikes(casterId,action.transition.casterStrikes);
    const delay=action.transition?.switchFrame??0;if(delay>0)port.runtime.schedule(casterId,delay,settle);else settle();
  }else if(action.transition){
    const caster=port.actor(casterId);if(caster)port.runtime.transition(casterId,action.transition,port.actor(targetId),caster.position,port.flight,()=>settle());
  }else settle();
}

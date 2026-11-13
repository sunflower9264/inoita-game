import {attackDistance,PIXELS_PER_DISTANCE_UNIT,targetDistance,targetScore} from './basic-attack.ts';
import type {Combatant} from './combat.ts';
import type {Point} from './navigation.ts';
import {MAX_SKILL_TARGETS} from './skill-unit-sequence.ts';

/** 单次范围攻击最多扫描 100 个候选，避免把全图角色都纳入评分。 */
const MAX_SPLASH_CANDIDATES = 100;

const hostileVisible=(source:Combatant,target:Combatant)=>source.team!==target.team&&!target.states?.includes('stealthed');

/** The current target is checked for reach; only a missing target starts a scored search. */
export function selectAttackSplashCenter(source:Combatant,candidates:readonly Combatant[],
  rangeUnits:number,selection:{currentTargetId?:string}={}):{center:Point;targetId?:string} {
  let target=candidates.find(value=>value.id===selection.currentTargetId);
  if(!target){
    let score=0;
    const origin={x:Math.trunc(source.position.x),y:Math.trunc(source.position.y)};
    for(const candidate of candidates.slice(0,MAX_SPLASH_CANDIDATES)){
      if(!hostileVisible(source,candidate))continue;
      const position={x:Math.trunc(candidate.position.x),y:Math.trunc(candidate.position.y)};
      const value=targetScore(origin,position,source.facing??'south',rangeUnits*PIXELS_PER_DISTANCE_UNIT);
      if(value>score){target=candidate;score=value;}
    }
  }
  if(target&&attackDistance(source.position,source.bounds,target.position,target.bounds)<=rangeUnits)
    return {center:target.position,targetId:target.id};
  return {center:source.position};
}

/** 按角色池顺序收集敌方脚点范围，免伤目标仍占用名额。 */
export function attackSplashTargets(source:Combatant,center:Point,candidates:readonly Combatant[],rangeUnits:number):Combatant[] {
  const selected:Combatant[]=[];
  for(const candidate of candidates.slice(0,MAX_SPLASH_CANDIDATES)){
    if(!hostileVisible(source,candidate)||Math.floor(targetDistance(center,candidate.position)/PIXELS_PER_DISTANCE_UNIT)>rangeUnits)continue;
    selected.push(candidate);
    if(selected.length===MAX_SKILL_TARGETS)break;
  }
  return selected;
}

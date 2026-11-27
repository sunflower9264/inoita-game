import { attackDistance, PIXELS_PER_DISTANCE_UNIT, targetDistance } from './basic-attack.ts';
import type { CombatUnit, EnemyPlayableSkill, SkillAction, SkillEffectCue } from './battle.ts';
import { areaShapeMaxReachPx, canTargetCombatant, chargeLanding, rearLanding, resolveCueTargets, type SkillMovementPort, type Combatant, type CombatController } from './combat.ts';
import { attackRangeQueryRadius, awarenessRangeQueryRadius } from './combat-spatial-index.ts';
import type { PartySkillUse } from './party.ts';
import type { PartyPort } from './party-port.ts';
import { rectDistance } from './rect-distance.ts';
import { needsTarget } from './skill-action.ts';
import { MAX_SKILL_TARGETS } from './skill-unit-sequence.ts';

export type PartyAction = {skill:EnemyPlayableSkill;targetId?:string;urgent?:boolean} | {rescue:Combatant;range:number};
type TacticsPort = SkillMovementPort & Pick<PartyPort,'skills'|'skillUses'|'vitals'|'actor'|'targetOf'|'attacking'|'attackRange'|'candidates'
  |'nearbyCandidates'|'partySlots'|'healScore'|'healCandidates'|'rangeBonusUnits'|'canSpendMana'
  |'ownedSummons'|'isBoss'|'hasBuff'>;
type Readiness = Pick<CombatController,'skillReady'|'canSelectSkill'>;

interface Effect {cue:SkillEffectCue;unit:CombatUnit}
interface SkillProfile {effects:Effect[];enemyRequired:boolean;radius:number;costsHealth:boolean}
const profiles = new WeakMap<SkillAction,SkillProfile>();

function skillProfile(action:SkillAction):SkillProfile {
  const previous=profiles.get(action);
  if(previous)return previous;
  const effects:Effect[]=[];
  let radius=0;
  // 连斩等动作可多次执行同一组单元，覆盖人数只计算一次。
  for(const event of action.events){
    if(event.kind!=='units')continue;
    let search:SkillEffectCue|undefined;
    for(const [index,cue] of event.cues.entries()){
      if(cue.targetSelection!=='reuse-previous'||!search)search=cue;
      const usedCue=search,unit=action.combatUnits?.[index];
      if(!unit||effects.some(effect=>effect.unit===unit&&effect.cue.target===usedCue.target
        &&effect.cue.targetRangePx===usedCue.targetRangePx&&effect.cue.targetRangeMetric===usedCue.targetRangeMetric
        &&JSON.stringify(effect.cue.areaShape)===JSON.stringify(usedCue.areaShape)&&effect.cue.maxTargets===usedCue.maxTargets))continue;
      effects.push({cue:usedCue,unit});
      radius=Math.max(radius,areaShapeMaxReachPx(usedCue.areaShape,usedCue.targetRangePx));
    }
  }
  const result={effects,enemyRequired:needsTarget(action),radius,costsHealth:effects.some(({unit})=>unit.effect==='self-damage')};
  profiles.set(action,result);
  return result;
}

function healthFraction(port:TacticsPort,id:string):number {
  const hp=port.vitals(id);
  return hp&&hp.health>0&&hp.maxHealth>0?hp.health/hp.maxHealth:1;
}

function impactCaster(actor:Combatant,target:Combatant|undefined,action:SkillAction,port:SkillMovementPort):Combatant|undefined {
  if(!action.charge&&!action.rearTeleport)return actor;
  if(!target)return;
  if(action.charge){
    const plan=chargeLanding(actor,target,action.charge,port);
    // 冲锋命中帧在抵达之后；近身突进此时已回到保存的起点。
    return plan && {...actor,position:plan.destination};
  }
  const position=rearLanding(actor,target,port);
  if(position)return {...actor,position};
}

/** 同一技能的连续打击共享这次覆盖人数，不会把同一敌人算成一群。 */
function attackValue(uses:readonly PartySkillUse[], effect:Effect, hostiles:Combatant[], port:TacticsPort, boss:boolean, level:number):number {
  const {unit,cue}=effect;
  const pulses=unit.effect==='buff'?unit.ranks[level-1]?.effect.periodic:undefined;
  const lastingDamage=pulses?.some(p=>p.kind==='magic-curse'||p.kind==='attack-damage');
  const recipients=unit.effect==='buff'?hostiles.filter(enemy=>!port.hasBuff?.(enemy.id,unit.buff)):hostiles;
  let damage=0,control=0;
  if(uses.includes('damage')&&recipients.length&&(unit.effect==='physical'||unit.effect==='magic'||lastingDamage)){
    const single=cue.target==='current'||cue.target==='enemy';
    damage=2+(single?1:0)+Math.min(recipients.length-1,3)*5+(boss?5:0);
  }
  if(uses.includes('control')&&(unit.effect==='buff'||unit.effect==='state'||unit.effect==='taunt')){
    // 只有敌人确实在攻击我方时，缴械或减速才产生保护收益。
    const attackingParty=recipients.filter(enemy=>{
      const victim=port.targetOf?.(enemy.id);
      const victimActor=victim?port.actor(victim):undefined;
      return victimActor&&victimActor.team!==enemy.team
        && !(unit.effect==='state'&&enemy.states?.includes(unit.state));
    });
    if(attackingParty.length)control=8+Math.min(attackingParty.length-1,3)*3;
  }
  return Math.max(damage,control);
}

function healingValue(affected:Combatant[], port:TacticsPort, unit:CombatUnit, threshold:number, local:boolean, periodic:boolean, boosts:boolean):number {
  let wounded=0,lowest=1;
  for(const ally of affected){
    if(unit.effect==='buff'&&port.hasBuff?.(ally.id,unit.buff))continue;
    const fraction=healthFraction(port,ally.id);
    // 持续增益等接战再开启；带即时治疗的复合技能在危急时仍可救人。
    if(!local && (periodic || (boosts && fraction>=0.35)))continue;
    if(fraction<threshold){lowest=Math.min(lowest,fraction);wounded++;}
  }
  return wounded?(periodic?20:30)+20*(1-lowest)+4*(wounded-1):0;
}

function summonCanHit(actor:Combatant,target:Combatant|undefined,port:TacticsPort):boolean {
  return port.ownedSummons?.(actor.id).some(summon=>{
    if(!summon.commandAction)return false;
    const profile=skillProfile(summon.commandAction);
    const bonus=port.rangeBonusUnits?.(summon.id)??0;
    const radius=awarenessRangeQueryRadius(Math.ceil(profile.radius/PIXELS_PER_DISTANCE_UNIT)+bonus);
    const candidates=port.nearbyCandidates?.([{...summon.position,radius}])??port.candidates();
    const selected=port.actor(port.targetOf?.(summon.id)??'');
    return profile.effects.some(({cue})=>resolveCueTargets(cue,summon,selected,candidates,[],bonus)
      .slice(0,MAX_SKILL_TARGETS).some(enemy=>enemy.team!==summon.team &&
        (enemy.id===target?.id || enemy.id===selected?.id || port.actor(port.targetOf?.(enemy.id)??'')?.team===actor.team)));
  })??false;
}

/** 普攻的基准收益为 5。多个动作同分时保留技能表中靠前的一项。 */
export function choosePartyAction(actor:Combatant,target:Combatant|undefined,port:TacticsPort,combat:Readiness):PartyAction|undefined {
  const skills=port.skills();
  if(!skills.length)return;
  let reserve=Infinity,range=port.attackRange(),radius=0;
  const bonus=port.rangeBonusUnits?.(actor.id)??0;
  const available=skills.filter(skill=>{
    if(skill.frequency===0||!combat.canSelectSkill(skill))return false;
    const uses=port.skillUses(skill.id);
    const cost=skill.manaCost??0;
    if(uses.includes('heal'))reserve=Math.min(reserve,cost);
    if(!combat.skillReady(skill.id)||port.canSpendMana?.(cost)===false)return false;
    if(uses.includes('damage'))range=Math.max(range,skill.action.approachDistanceUnits+bonus);
    radius=Math.max(radius,skillProfile(skill.action).radius);
    return true;
  });
  if(!available.length)return;
  const queryRadius=attackRangeQueryRadius(Math.max(range,Math.ceil(radius/PIXELS_PER_DISTANCE_UNIT)+bonus),actor.bounds);
  const circles=[{...actor.position,radius:queryRadius}];
  if(target)circles.push({...target.position,radius:queryRadius});
  const nearby=port.nearbyCandidates?.(circles)??port.candidates();
  const enemies=nearby.filter(enemy=>enemy.team!==actor.team&&canTargetCombatant(actor,enemy)&&
    (enemy.id===target?.id||port.actor(port.targetOf?.(enemy.id)??'')?.team===actor.team));
  const distance=(enemy:Combatant)=>attackDistance(actor.position,actor.bounds,enemy.position,enemy.bounds);
  const enemyIds=new Set(enemies.map(enemy=>enemy.id));
  const local=enemies.filter(enemy=>distance(enemy)<=range);
  const attackers=local.filter(enemy=>port.targetOf?.(enemy.id)===actor.id);
  const boss=local.some(enemy=>port.isBoss?.(enemy.id));
  const pressured=boss||local.length>=2;
  const slots=port.partySlots?.()??nearby.filter(a=>a.team===actor.team).map(actor=>({actor,active:true,hasDisplay:true}));
  let healCandidates:ReturnType<NonNullable<TacticsPort['healCandidates']>>|undefined;
  let bestScore=5,best:PartyAction|undefined;
  for(const skill of available){
    const uses=port.skillUses(skill.id),action=skill.action,profile=skillProfile(action);
    if(profile.enemyRequired&&(!target||distance(target)>action.approachDistanceUnits+bonus))continue;
    const high=skill.frequency===2;
    const cost=skill.manaCost??0;
    const self=port.vitals(actor.id);
    if(profile.costsHealth&&(!self||healthFraction(port,actor.id)<0.6||
      self.mana===undefined||!self.maxMana||self.mana>self.maxMana*0.5))continue;
    const caster=impactCaster(actor,target,action,port);
    if(!caster)continue;
    let offense=0,support=0,defense=0,healing=0;
    for(const {cue,unit} of profile.effects){
      if(unit.effect==='visual'||unit.effect==='set-attribute'||unit.effect==='clear-attribute')continue;
      if(cue.target==='ally-heal'&&!healCandidates){
        healCandidates=port.healCandidates?.()??slots.flatMap(slot=>slot?[{...slot,score:port.healScore?.(slot.actor.id)
          ??Math.round(100*healthFraction(port,slot.actor.id))}]:[]);
      }
      const affected=resolveCueTargets(cue,caster,target,nearby,slots,cue.target==='target-area'?0:bonus,
        port.healScore,healCandidates).slice(0,MAX_SKILL_TARGETS);
      const periodicHeal=unit.effect==='buff'&&unit.ranks[(skill.level??1)-1]?.effect.periodic.some(p=>p.kind==='healing');
      if((unit.effect==='heal'||periodicHeal)&&uses.includes('heal')){
        const healRange=Math.floor(cue.targetRangePx/PIXELS_PER_DISTANCE_UNIT)+bonus;
        const engaged=periodicHeal ? enemies.some(enemy=>
          Math.floor(targetDistance(caster.position,enemy.position)/PIXELS_PER_DISTANCE_UNIT)<=healRange) : local.length>0;
        healing=Math.max(healing,healingValue(affected,port,unit,high?0.7:0.5,engaged,periodicHeal===true,uses.includes('buff')));
        if(cue.target==='ally-heal'){
          const reach=Math.floor(cue.targetRangePx/PIXELS_PER_DISTANCE_UNIT)+bonus;
          for(const slot of slots){
            if(!slot?.active||!slot.hasDisplay)continue;
            const fraction=healthFraction(port,slot.actor.id),gap=rectDistance(actor,slot.actor)+2-reach;
            const urgency=29+10*(1-fraction);
            if(fraction<0.35&&gap>0&&gap<=4&&urgency>bestScore){
              best={rescue:slot.actor,range:reach};bestScore=urgency;
            }
          }
        }
      }
      if(target)offense=Math.max(offense,attackValue(uses,{cue,unit},affected.filter(a=>enemyIds.has(a.id)),port,boss,skill.level??1));
      if(unit.effect==='buff'){
        for(const ally of affected){
          if(ally.team!==actor.team||port.hasBuff?.(ally.id,unit.buff))continue;
          if(uses.includes('buff')){
            const foe=ally.id===actor.id?target:port.actor(port.targetOf?.(ally.id)??'');
            const inReach=(enemy:Combatant)=>attackDistance(ally.position,ally.bounds,enemy.position,enemy.bounds)<=port.attackRange(ally.id);
            const fighting=foe && foe.team!==ally.team
              ? inReach(foe) && (distance(foe)<=range && enemyIds.has(foe.id) || (port.attacking(ally.id) && distance(foe)<=range+2))
              : local.some(inReach);
            if(fighting)
              support=Math.max(support,profile.costsHealth?10:pressured?8:3);
          }
          if(uses.includes('defend')&&local.some(enemy=>port.targetOf?.(enemy.id)===ally.id))
            defense=Math.max(defense,12+(healthFraction(port,ally.id)<0.5?5:0));
        }
      }
    }
    if(uses.includes('summon')&&local.length&&!port.ownedSummons?.(actor.id).length)support=Math.max(support,pressured?10:4);
    if(action.requiresActiveSummon&&summonCanHit(actor,target,port))offense=Math.max(offense,9);
    const score=Math.max(offense,support,defense,healing)+(high?4:0);
    if(!healing&&!pressured&&!attackers.length&&Number.isFinite(reserve)&&port.canSpendMana?.(cost+reserve)===false)continue;
    if(score>bestScore){bestScore=score;best={skill,targetId:target?.id,urgent:Math.max(defense,healing)>Math.max(offense,support)};}
  }
  return best;
}

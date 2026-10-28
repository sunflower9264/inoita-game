import {resolveCueTargets,type CombatPort,type SkillUnitStart,type SkillUnitHit} from './combat.ts';
import type {SkillEffectCue} from './battle.ts';
import type {Point} from './navigation.ts';
import {attackSplashTargets,selectAttackSplashCenter} from './attack-splash.ts';
import {MAX_SKILL_TARGETS,resolveSkillUnitSequence,type ResolvedSkillUnit} from './skill-unit-sequence.ts';
import type {PreparedActionDamage} from './action-damage.ts';

export interface SkillExecution extends SkillUnitStart {
  cues:readonly SkillEffectCue[];
  origin?:Point;
  selectedTargetId?:string;
}
export interface SkillExecutionPort extends Pick<CombatPort,'actor'|'candidates'|'partySlots'|'rangeBonusUnits'|'healScore'|'healCandidates'|'prepareUnit'|'unit'|'unitFeedback'|'runUnitSequence'> {
  currentTargetId?():string|undefined;
  selectTarget?(id:string):void;
  resolved?(hit:SkillUnitHit):void;
}

/** 主动释放与追加释放使用同一份目标、预备数值和失败历史。 */
export function executeSkillUnits(request:Omit<SkillExecution,'cueIndex'>,port:SkillExecutionPort):ResolvedSkillUnit[] {
  const {casterId,cues}=request;
  const skill={...request.skill,level:request.skill.level??1};
  const position=request.origin??port.actor(casterId)?.position;
  const origin=position?{...position}:undefined;
  const selectedTargetId=request.selectedTargetId;
  let targets:readonly string[]=[],preparedDamage:PreparedActionDamage|undefined;
  let results:ResolvedSkillUnit[]=[];
  const work=()=>{
    results=resolveSkillUnitSequence(cues.map((_,index)=>skill.action.combatUnits?.[index]??{effect:'visual' as const}),{
      targets:cueIndex=>{
        const cue=cues[cueIndex];
        if(cue.targetSelection==='reuse-previous')return targets;
        const caster=port.actor(casterId);
        if(!caster||!origin)return targets=[];
        const source={...caster,position:origin};
        if(cue.target==='target-area'){
          const id=port.currentTargetId?.()??selectedTargetId;
          const current=id?port.actor(id):undefined;
          const candidates=port.candidates();
          const selection=selectAttackSplashCenter(caster,current?[current]:candidates,Math.floor(cue.targetRangePx/8),{currentTargetId:current?.id});
          if(selection.targetId)port.selectTarget?.(selection.targetId);
          return targets=attackSplashTargets(caster,selection.targetId?selection.center:origin,candidates,Math.floor(cue.targetRangePx/8)).map(actor=>actor.id);
        }
        const selected=selectedTargetId?port.actor(selectedTargetId):undefined;
        return targets=cue.target==='none'?[casterId]:resolveCueTargets(cue,source,selected,port.candidates(),
          cue.target==='party'||cue.target==='party-ally'?port.partySlots?.():undefined,
          port.rangeBonusUnits?.(casterId),id=>port.healScore?.(id),port.healCandidates?.()).slice(0,MAX_SKILL_TARGETS).map(actor=>actor.id);
      },
      prepare:cueIndex=>{preparedDamage=port.prepareUnit?.({casterId,skill,cueIndex});},
      unit:(cueIndex,targetId)=>port.actor(targetId)?port.unit?.({casterId,skill,cueIndex,targetId,preparedDamage})??'skipped':'skipped',
      resolved:({cueIndex,targetId,outcome})=>{
        const hit={casterId,skill,cueIndex,targetId,preparedDamage};
        port.unitFeedback?.(hit,outcome,cues[cueIndex]);
        if(outcome!=='skipped')port.resolved?.(hit);
      },
    });
  };
  if(port.runUnitSequence)port.runUnitSequence(work);else work();
  return results;
}

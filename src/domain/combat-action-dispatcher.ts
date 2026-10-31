import type {ActionPlayback,Combatant,SkillUnitsReady} from './combat.ts';
import {resolveCueTargets} from './combat.ts';
import {type ActionDispatchDefinition,type AttackPlacement,type BattleCatalog,type SkillEvent,type SkillFeedbackEvent,type SkillVisualEffect} from './battle.ts';
import {basicAttackEvents,basicAttackStrikesAtFrame,type BasicAttackHand} from './basic-attack.ts';
import {skillPlaybackEvents} from './skill-action.ts';
import {planSummonSpot} from './skill-geometry.ts';
import type {Point} from './navigation.ts';
import type {CollisionBox} from './content.ts';
import {CombatRuntime,type FlightEvent} from './combat-runtime.ts';

export type ActionDispatchRunner=(definition:ActionDispatchDefinition,work:()=>void,after?:()=>void)=>void;
export interface CombatActionPort {
  runtime:CombatRuntime;
  catalog:BattleCatalog;
  actor(id:string):Combatant|undefined;
  candidates():Combatant[];
  random():number;
  viewport():{width:number;height:number};
  pose(action:ActionPlayback,index:number):void;
  visualEffect?(effect:SkillVisualEffect,variant:string,actor:Combatant):void;
  effect(name:string,variant:string,position:Point,placement?:AttackPlacement,recipientId?:string):void;
  flight(event:FlightEvent):void;
  screen(transparency:number):void;
  notify(name:string,data:Record<string,unknown>):void;
  canSummonAt(position:Point,bounds:CollisionBox):boolean;
  /** 召唤落点：preferred 可达就原样使用，否则从主人位置找最近的整盒可站点。 */
  nearestSummonSpot(position:Point,bounds:CollisionBox,preferred?:Point):Point|undefined;
  beginSummons(ownerId:string):void;
  summon(ownerId:string,enemyId:string,position:Point):string|undefined;
}

/** 在逻辑帧中派发动作；投射物抵达由运行器决定，表现接口只接收输出。 */
export class CombatActionDispatcher {
  private readonly port:CombatActionPort;
  constructor(port:CombatActionPort){this.port=port;}
  private visual(effect:SkillVisualEffect,variant:string,actor:Combatant):void {
    if(this.port.visualEffect)this.port.visualEffect(effect,variant,actor);else this.port.effect(effect.effect,variant,actor.position,effect.placement,actor.id);
    this.port.notify('skill-effect',{name:effect.effect,variant,recipientId:actor.id,placement:effect.placement});
  }
  private transition(action:ActionPlayback,target:Combatant|undefined,arrive:(spot:Point)=>void):void {
    const port=this.port;
    port.runtime.transition(action.caster.id,action.skill!.action.transition!,target,action.caster.position,{
      actor:id=>port.actor(id),emit:event=>port.flight(event),
      effect:(name,spot)=>{port.effect(name,'default',spot);port.notify('skill-effect',{name,variant:'default'});},
    },arrive);
  }
  casterStrikes(casterId:string,strikes:{effect:string;offsets:Point[]}):void {
    strikes.offsets.forEach((offset,index)=>{
      const strike=()=>{const caster=this.port.actor(casterId);if(caster)this.port.effect(strikes.effect,'default',
        {x:caster.position.x+offset.x,y:caster.position.y+offset.y});};
      if(index===0)strike();else this.port.runtime.schedule(casterId,index,strike);
    });
  }
  frame(action:ActionPlayback,index:number,contact:(id:string,hand?:BasicAttackHand)=>void=()=>{},ready:SkillUnitsReady=()=>[],
    feedback:(event:SkillFeedbackEvent)=>void=()=>{},dispatch:ActionDispatchRunner=(_definition,work,after)=>{work();after?.();},area:()=>void=()=>{}):void {
    const p=this.port,{caster,target,skill,basicAttack,facing}=action;
    p.pose(action,index);
    if(!skill){
      if(!basicAttack)return;
      const events=basicAttackEvents(basicAttack,index);
      const swing=()=>{if(events.swing)for(const name of basicAttack.swings)
        p.effect(name,facing,caster.position,basicAttack.swingPlacement??'world',caster.id);};
      if(basicAttack.swingOrder!=='after-strike')swing();
      const strikes=basicAttackStrikesAtFrame(basicAttack,index);
      for(const [ordinal,hand] of strikes.entries()){
        const detail=basicAttack.strikes?{hand}:{};
        p.notify('basic-attack-strike',{casterId:caster.id,targetId:target?.id,...detail});
        const work=()=>{
          if(basicAttack.targeting)area();
          else if(target){
            const arrive=()=>{
              const live=p.actor(target.id);if(!live)return;
              for(const effect of basicAttack.targetEffects??[]){const recipient=effect.recipient==='caster'?p.actor(caster.id):live;if(recipient)this.visual(effect,'default',recipient);}
              p.notify('basic-attack-impact',{casterId:caster.id,targetId:target.id,...detail});contact(target.id,hand);
            };
            if(basicAttack.projectile){const flight=basicAttack.projectile;
              p.runtime.fly({ownerId:caster.id,effect:flight.effect,position:{x:caster.position.x+(facing==='east'?flight.offsetX:-flight.offsetX),y:caster.position.y+flight.offsetY},
                targetId:target.id,kind:'trace',stepDistancePx:flight.stepDistancePx,stepDurationMs:flight.stepDurationMs,aboveCharacters:basicAttack.projectilePlacement==='above-characters'},
                {actor:id=>p.actor(id),emit:event=>p.flight(event)},arrive);
            }else if(basicAttack.transition)p.runtime.transition(caster.id,basicAttack.transition,target,caster.position,
              {actor:id=>p.actor(id),emit:event=>p.flight(event),effect:(name,spot)=>p.effect(name,'default',spot)},arrive);
            else arrive();
          }
          for(const effect of basicAttack.dispatch?.casterEffects??[])this.visual(effect,'default',caster);
        };
        const after=basicAttack.swingOrder==='after-strike'&&ordinal===strikes.length-1?swing:undefined;
        if(basicAttack.dispatch)dispatch(basicAttack.dispatch,work,after);else{work();after?.();}
      }
      if(!strikes.length&&basicAttack.swingOrder==='after-strike')swing();
      return;
    }
    for(const event of skillPlaybackEvents(skill.action,index,skill.level,action.repeatState)){
      switch(event.kind){
      case 'feedback':feedback(event);break;
      case 'cast':this.visual(event.effect,'default',caster);break;
      case 'units':{
        const work=()=>{
          const executeAt=(selectedTargetId?:string)=>{
            const arrival={event,selectedTargetId,impactCenter:undefined as Point|undefined};let executed=false;
            return (center?:Point)=>{
              if(executed)return;executed=true;arrival.impactCenter=center;
              const results=ready(arrival);
              if(center&&!results.length)for(const effect of skill.action.transition?.missEffects??[])
                p.effect(effect.effect,'default',center,effect.placement,caster.id);
            };
          };
          if(skill.action.transition?.casterStrikes)this.casterStrikes(caster.id,skill.action.transition.casterStrikes);
          if(skill.action.transition){
            const anchor=skill.action.transition.anchor==='caster'?caster:target;
            if(action.capturedTargets)for(const captured of action.capturedTargets)
              this.transition(action,{...(target??caster),id:captured.id,position:captured.position},executeAt(captured.id));
            else this.transition(action,anchor,executeAt(anchor?.id));
          }else executeAt(target?.id)();
          for(const effect of event.dispatch?.casterEffects??[])this.visual(effect,'default',caster);
        };
        if(event.dispatch)dispatch(event.dispatch,work);else work();break;
      }
      case 'capture-targets':break;
      case 'captured-effect':for(const captured of action.capturedTargets??[])p.effect(event.effect,'default',captured.position,event.placement,caster.id);break;
      case 'summon':{
        const work=()=>{this.summon(action,event);for(const effect of event.dispatch?.casterEffects??[])this.visual(effect,'default',caster);};
        if(event.dispatch)dispatch(event.dispatch,work);else work();break;
      }
      case 'caster':for(const effect of event.effects)this.visual(effect,'default',caster);break;
      case 'swing':for(const effect of event.effects)for(const recipient of effect.recipient==='caster'?[caster]:target?[target]:[])
        this.visual(effect,effect.recipient==='caster'?facing:'default',recipient);break;
      case 'impact':for(const recipient of resolveCueTargets({target:event.target,targetRangePx:Infinity},caster,target,p.candidates()))this.visual(event.effect,'default',recipient);break;
      case 'spawn':{
        const view=p.viewport(),x=Math.max(0,Math.floor(view.width/2)-event.marginPx),y=Math.max(0,Math.floor(view.height/2)-event.marginPx);
        const between=(span:number)=>Math.floor(p.random()*(span*2+1))-span;
        between(x);between(y);p.effect(event.effect,'default',{x:caster.position.x+between(x),y:caster.position.y+between(y)},event.placement,caster.id);break;
      }
      case 'screen':p.screen(event.fillTransparency);break;
      }
    }
  }
  private summon(action:ActionPlayback,event:Extract<SkillEvent,{kind:'summon'}>):void {
    const p=this.port;let count=0;p.beginSummons(action.caster.id);
    for(const creature of event.creatures){
      const definition=p.catalog.enemies.find(enemy=>enemy.id===creature.enemyId);
      const bounds=definition?.actor.collision;
      if(!bounds)continue;
      const placement=event.placement,offset=placement.offsetChoices[Math.floor(p.random()*placement.offsetChoices.length)];
      const base=planSummonSpot(action.caster.position,action.caster.bounds,action.facing,placement,point=>p.canSummonAt(point,bounds));
      const jitter=()=>Math.floor(p.random()*(placement.jitterPx*2+1))-placement.jitterPx;
      // 位移候选点要复核，不过关就退回搜索带给出的点。
      const candidate=base&&{x:base.x+offset.x+jitter(),y:base.y+offset.y+jitter()};
      const preferred=candidate&&p.canSummonAt(candidate,bounds)?candidate:base;
      // 最终落点必须从主人处走到；preferred 只在可达时保留，否则在可达区域里就近兜底。
      const spot=p.nearestSummonSpot(action.caster.position,bounds,preferred);
      if(!spot)continue;
      const id=p.summon(action.caster.id,creature.enemyId,spot);
      if(id){count++;p.effect(event.effect,'default',spot,'attached',id);}
    }
    p.notify('skill-summon',{casterId:action.caster.id,skillId:action.skill!.id,count});
  }
}

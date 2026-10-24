import {LOGIC_FRAME_MS,type SkillTransition} from './battle.ts';
import {CombatController,type ActionPlayback,type Combatant,type CombatSnapshot} from './combat.ts';
import type {Point} from './navigation.ts';
import {skillSequence,skillRepeatSkippedFrames} from './skill-action.ts';
import {attackCycleFrames} from './combat-tempo.ts';
import {projectileStep,projectileHeading} from './basic-attack.ts';
import {positionTransitionStep} from './skill-geometry.ts';

interface ScheduledWork {id:number;ownerId:string;dueFrame:number;work():void}
export type CombatRequestResult={kind:'started'|'approaching'}|{kind:'rejected';reason:Exclude<ReturnType<CombatController['request']>,'started'>};
export interface CombatRuntimeState {actors:[string,CombatSnapshot][]}
export interface ActionTiming {sourceFrames:number;frameDurationMs:number}
interface RunningAction {
  id:number;ownerId:string;startedFrame:number;action:ActionPlayback;timing:ActionTiming;
  elapsedMs:number;frame:number;frames:number;frameWork(index:number):void;complete():void;
}
export type FlightEvent=
  | {kind:'start';id:number;effect:string;position:Point;heading:number;directional:boolean;aboveCharacters:boolean}
  | {kind:'step';id:number;position:Point;heading:number;durationMs:number}
  | {kind:'end';id:number};
export interface FlightPort {actor(id:string):Combatant|undefined;emit(event:FlightEvent):void}
export interface FlightRequest {
  ownerId:string;effect:string;position:Point;targetId?:string;targetPosition?:Point;
  kind:'trace'|'position';stepDistancePx:number;stepDurationMs:number;
  switchFrame?:number;directional?:boolean;aboveCharacters?:boolean;
}

/** 一份世界实例的动作与在途攻击。画面只消费进度，不提交抵达或伤害。 */
export class CombatRuntime {
  private readonly now:()=>number;
  private serial=0;
  private lastFrame:number;
  private closed=false;
  private readonly pauses=new Set<string>();
  private readonly controllers=new Map<string,CombatController>();
  private readonly tasks=new Map<number,ScheduledWork>();
  private readonly actions=new Map<number,RunningAction>();
  private readonly flights=new Map<number,{ownerId:string;cancel():void}>();

  constructor(now:()=>number){this.now=now;this.lastFrame=now();}
  get paused():boolean{return this.pauses.size>0;}
  /** 谁把运行时冻住了：卡住时先看这里（`control` 是全局暂停，`combat-*` 等在途动作）。 */
  get pauseOwners():readonly string[]{return [...this.pauses];}
  get idle():boolean{return this.actions.size===0&&this.tasks.size===0&&this.flights.size===0;}
  get pendingCount():number{return this.tasks.size;}
  hasPendingBasicStrike(ownerId:string):boolean {
    for(const track of this.actions.values()){
      if(track.ownerId!==ownerId||track.action.skill||!track.action.basicAttack)continue;
      const strikeFrame=track.action.basicAttack.strikes?.length
        ?Math.max(...track.action.basicAttack.strikes.map(strike=>strike.frame))
        :track.action.basicAttack.strikeFrame;
      if(track.frame<strikeFrame)return true;
    }
    return false;
  }
  setPaused(owner:string,paused:boolean):void{if(paused)this.pauses.add(owner);else this.pauses.delete(owner);}

  registerActor(id:string,controller:CombatController):void {
    const previous=this.controllers.get(id);if(previous&&previous!==controller){previous.cancel(true);this.cancel(id);}
    this.controllers.set(id,controller);
  }
  removeActor(id:string):void{this.controllers.get(id)?.cancel(true);this.cancel(id);this.controllers.delete(id);}
  request(command:{actorId:string;skill?:ActionPlayback['skill'];targetId?:string;mode?:'manual'|'normal'|'triggered'}):CombatRequestResult {
    if(this.paused||this.closed)return {kind:'rejected',reason:'busy'};
    const actor=this.controllers.get(command.actorId);if(!actor)return {kind:'rejected',reason:'no-target'};
    const result=command.skill&&command.mode==='manual'?actor.requestManualSkill(command.skill,command.targetId):
      command.skill&&command.mode==='triggered'?actor.requestTriggeredAction(command.skill,command.targetId):actor.request(command.skill,command.targetId);
    return result==='started'?{kind:actor.snapshot().state==='approaching'?'approaching':'started'}:{kind:'rejected',reason:result};
  }
  captureState():CombatRuntimeState{return {actors:[...this.controllers].map(([id,controller])=>[id,controller.snapshot()])};}
  restoreState(state:CombatRuntimeState):void {
    const copy=structuredClone(state);
    if(!Array.isArray(copy.actors)||new Set(copy.actors.map(([id])=>id)).size!==copy.actors.length||copy.actors.some(([id])=>!this.controllers.has(id)))throw new Error('战斗角色快照无效');
    this.reset();for(const [id,snapshot] of copy.actors)this.controllers.get(id)!.restoreState(snapshot);
  }
  schedule(ownerId:string,delayFrames:number,work:()=>void):()=>void {
    if(!Number.isSafeInteger(delayFrames)||delayFrames<0)throw new Error('战斗延迟帧无效');
    if(this.closed)return ()=>{};
    const id=++this.serial;
    this.tasks.set(id,{id,ownerId,dueFrame:this.now()+delayFrames,work});
    return ()=>{this.tasks.delete(id);};
  }

  play(action:ActionPlayback,timing:ActionTiming,frame:(index:number)=>void,complete:()=>void):()=>void {
    if(this.closed)throw new Error('战斗运行实例已关闭');
    if(!Number.isInteger(timing.sourceFrames)||timing.sourceFrames<1||!Number.isFinite(timing.frameDurationMs)||timing.frameDurationMs<=0)
      throw new Error('战斗动作周期无效');
    const id=++this.serial;
    const frames=action.basicAttackWait?.durationFrames??(action.skill
      ?skillSequence(action.skill.action,action.skill.level??1,timing.sourceFrames).length
      :action.basicAttack!.effectiveCycleFrames);
    this.actions.set(id,{id,ownerId:action.caster.id,startedFrame:this.now(),action,timing,elapsedMs:0,frame:0,frames,frameWork:frame,complete});
    return ()=>{this.actions.delete(id);};
  }

  step(frame:number):void {
    if(this.closed||this.paused)return;
    if(!Number.isSafeInteger(frame)||frame<this.lastFrame)throw new Error('战斗推进帧无效');
    if(frame===this.lastFrame)return;
    if(frame!==this.lastFrame+1)throw new Error('战斗运行实例必须逐逻辑帧推进');
    this.lastFrame=frame;
    for(const track of [...this.actions.values()]){
      if(track.startedFrame>=frame)continue;
      track.elapsedMs+=LOGIC_FRAME_MS;
      while(this.actions.has(track.id)&&track.elapsedMs>=track.timing.frameDurationMs){
        track.elapsedMs-=track.timing.frameDurationMs;
        const next=track.frame+1,attack=track.action.basicAttack;
        const duration=attack&&attack.timing!=='fixed-animation'&&!track.action.skill&&!track.action.basicAttackWait
          ?attackCycleFrames(attack.cycleFrames,track.action.getAttackSpeedRate?.()??1000,attack.strikeFrame)
          :track.frames-(track.action.skill?skillRepeatSkippedFrames(track.action.skill.action,track.action.skill.level??1,track.action.repeatState):0);
        if(next>=duration){this.actions.delete(track.id);track.complete();break;}
        track.frame=next;if(!track.action.basicAttackWait)track.frameWork(next);
        if(this.paused||this.closed)break;
      }
      if(this.paused||this.closed)break;
    }
    // 先移除再执行，嵌套任务及取消可安全改变这一集合。
    let budget=4096;
    while(!this.paused&&!this.closed){
      const due=[...this.tasks.values()].filter(task=>task.dueFrame<=frame).sort((a,b)=>a.dueFrame-b.dueFrame||a.id-b.id);
      if(!due.length)break;
      for(const task of due){
        if(!this.tasks.delete(task.id))continue;
        if(--budget<0)throw new Error('同帧战斗任务超过执行上限');
        task.work();
        if(this.paused||this.closed)break;
      }
    }
  }

  fly(request:FlightRequest,port:FlightPort,arrive:(position:Point)=>void):void {
    if(!Number.isFinite(request.stepDistancePx)||request.stepDistancePx<=0||!Number.isFinite(request.stepDurationMs)||request.stepDurationMs<=0||
      request.switchFrame!==undefined&&(!Number.isSafeInteger(request.switchFrame)||request.switchFrame<0))throw new Error('战斗弹道参数无效');
    const target=request.targetPosition??(request.targetId?port.actor(request.targetId)?.position:undefined);
    if(!target||this.closed)return;
    const id=++this.serial,spot={...target};let position={...request.position},steps=0;
    let cancelStep=()=>{};
    const cancel=()=>{cancelStep();this.flights.delete(id);port.emit({kind:'end',id});};
    this.flights.set(id,{ownerId:request.ownerId,cancel});
    port.emit({kind:'start',id,effect:request.effect,position,heading:projectileHeading(position,spot),
      directional:request.directional!==false,aboveCharacters:request.aboveCharacters??false});
    const advance=()=>{
      if(!this.flights.has(id))return;
      const live=request.kind==='trace'&&request.targetId?port.actor(request.targetId):undefined;
      if(request.kind==='trace'&&!live){cancel();return;}
      const destination=live?.position??spot;
      const next=request.kind==='position'
        ?positionTransitionStep(position,destination,request.stepDistancePx,steps++,request.switchFrame??0)
        :projectileStep(position,destination,request.stepDistancePx);
      port.emit({kind:'step',id,position:next.position,heading:projectileHeading(position,destination),durationMs:request.stepDurationMs});
      cancelStep=this.schedule(request.ownerId,Math.max(1,Math.ceil(request.stepDurationMs/LOGIC_FRAME_MS)),()=>{
        position={...next.position};
        if(next.arrived){
          const exists=request.kind!=='trace'||!!request.targetId&&!!port.actor(request.targetId);
          cancel();if(exists)arrive(position);
        }else advance();
      });
    };
    advance();
  }

  transition(ownerId:string,definition:SkillTransition,target:Combatant|undefined,position:Point,
    port:FlightPort&{effect(name:string,position:Point):void},arrive:(position:Point)=>void):void {
    const finish=(spot:Point)=>{if(definition.actionEffect)port.effect(definition.actionEffect,spot);arrive(spot);};
    if(definition.kind==='stationary'&&definition.effect){
      if(!target)return;
      const spot={...target.position};port.effect(definition.effect,spot);
      if(definition.switchFrame===0)finish(spot);else this.schedule(ownerId,definition.switchFrame,()=>finish(spot));
      return;
    }
    if(definition.effect&&target&&(definition.kind==='trace'||definition.kind==='position')){
      this.fly({ownerId,effect:definition.effect,position:{x:position.x+definition.offsetX,y:position.y+definition.offsetY},
        targetId:target.id,targetPosition:definition.kind==='position'?target.position:undefined,kind:definition.kind,
        stepDistancePx:definition.stepDistancePx,stepDurationMs:LOGIC_FRAME_MS,switchFrame:definition.switchFrame,
        directional:definition.kind==='trace'&&definition.directional!==false,aboveCharacters:definition.kind==='position'},port,finish);
      return;
    }
    const finishLive=()=>{const live=target?port.actor(target.id):undefined;if(target&&!live)return;finish(live?.position??position);};
    if(definition.kind==='trace'||definition.switchFrame===0)finishLive();else this.schedule(ownerId,definition.switchFrame,finishLive);
  }

  cancel(ownerId:string):void {
    for(const [id,track] of this.actions)if(track.ownerId===ownerId)this.actions.delete(id);
    for(const [id,task] of this.tasks)if(task.ownerId===ownerId)this.tasks.delete(id);
    for(const flight of [...this.flights.values()])if(flight.ownerId===ownerId)flight.cancel();
  }
  reset():void {
    this.actions.clear();this.tasks.clear();
    for(const flight of [...this.flights.values()])flight.cancel();
    this.lastFrame=this.now();
  }
  dispose():void{this.reset();this.controllers.clear();this.closed=true;this.pauses.clear();}
}

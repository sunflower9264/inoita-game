import {LOGIC_FRAME_MS} from './battle.ts';

export interface Cooldown {remainingMs:number;durationMs:number}

export interface ActorCooldownPort {
  isReady(skillId:string):boolean;
  start(skillId:string,baseFrames:number,ratePerThousand?:number):void;
  reset():void;
  snapshot():Record<string,Cooldown>;
}

interface CooldownDeadline {readyFrame:number;durationFrames:number}
export interface CombatCooldownState {actors:Array<[string,Array<[string,CooldownDeadline]>]>}

function requireFrame(value:number,name:string):number {
  if(!Number.isInteger(value)||value<0)throw new RangeError(`${name} must be a finite nonnegative integer`);
  return value;
}

/** 保存角色技能的绝对截止帧；时钟推进及角色生命周期由宿主负责。 */
export class CombatCooldownStore {
  private readonly currentFrame:()=>number;
  private actors=new Map<string,Map<string,CooldownDeadline>>();
  /** 调试开关：这些角色不记冷却，也不读时钟。刻意不进入 `CombatCooldownState`，不写存档。 */
  private readonly freeActors=new Set<string>();

  constructor(currentFrame:()=>number){this.currentFrame=currentFrame;}

  /** GM 用：开启后该角色技能始终就绪；关闭后从下一次施放开始恢复计时。 */
  setFree(actorId:string,free:boolean):void {
    if(free)this.freeActors.add(actorId);else this.freeActors.delete(actorId);
  }
  isFree(actorId:string):boolean {return this.freeActors.has(actorId);}

  forActor(actorId:string):ActorCooldownPort {
    return {
      isReady:skillId=>this.isReady(actorId,skillId),
      start:(skillId,baseFrames,ratePerThousand=1000)=>this.start(actorId,skillId,baseFrames,ratePerThousand),
      reset:()=>this.resetActor(actorId),
      snapshot:()=>this.snapshot(actorId),
    };
  }

  /** 清掉当前冷却但保留「无冷却」开关：复活等流程不应该顺手关掉调试开关。 */
  resetActor(actorId:string):void {this.actors.delete(actorId);}
  /** 角色离开队伍：连同开关一起清掉。 */
  removeActor(actorId:string):void {this.actors.delete(actorId);this.freeActors.delete(actorId);}

  checkpointActor(actorId:string):()=>void {
    const deadlines=new Map(this.actors.get(actorId)),free=this.isFree(actorId);
    return ()=>{
      if(deadlines.size)this.actors.set(actorId,deadlines);else this.actors.delete(actorId);
      this.setFree(actorId,free);
    };
  }

  captureState():CombatCooldownState {
    return {actors:[...this.actors].map(([actorId,skills])=>[
      actorId,[...skills].map(([skillId,deadline])=>[skillId,{...deadline}]),
    ])};
  }

  restoreState(state:CombatCooldownState):void {
    const actors=new Map<string,Map<string,CooldownDeadline>>();
    for(const [actorId,records] of state.actors){
      const skills=new Map<string,CooldownDeadline>();
      for(const [skillId,deadline] of records)skills.set(skillId,{
        readyFrame:requireFrame(deadline.readyFrame,'readyFrame'),
        durationFrames:requireFrame(deadline.durationFrames,'durationFrames'),
      });
      if(skills.size)actors.set(actorId,skills);
    }
    this.actors=actors;
  }

  private now():number {return requireFrame(this.currentFrame(),'currentFrame');}

  private isReady(actorId:string,skillId:string):boolean {
    if(this.freeActors.has(actorId))return true;
    const now=this.now(),deadline=this.actors.get(actorId)?.get(skillId);
    return !deadline||now>=deadline.readyFrame;
  }

  private start(actorId:string,skillId:string,baseFrames:number,ratePerThousand:number):void {
    requireFrame(baseFrames,'baseFrames');
    if(!Number.isFinite(ratePerThousand))throw new RangeError('ratePerThousand must be finite');
    if(this.freeActors.has(actorId))return;
    const durationFrames=requireFrame(Math.trunc(baseFrames*Math.max(0,ratePerThousand)/1000),'durationFrames');
    const readyFrame=requireFrame(this.now()+durationFrames,'readyFrame');
    if(durationFrames===0){
      const skills=this.actors.get(actorId);
      skills?.delete(skillId);
      if(skills?.size===0)this.actors.delete(actorId);
      return;
    }
    let skills=this.actors.get(actorId);
    if(!skills){skills=new Map();this.actors.set(actorId,skills);}
    skills.set(skillId,{readyFrame,durationFrames});
  }

  private snapshot(actorId:string):Record<string,Cooldown> {
    if(this.freeActors.has(actorId))return {};
    const now=this.now();
    return Object.fromEntries([...(this.actors.get(actorId)??[])].filter(([,deadline])=>deadline.readyFrame>now)
      .map(([skillId,deadline])=>[skillId,{
        remainingMs:(deadline.readyFrame-now)*LOGIC_FRAME_MS,
        durationMs:deadline.durationFrames*LOGIC_FRAME_MS,
      }]));
  }
}

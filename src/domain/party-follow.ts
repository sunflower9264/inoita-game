import type { Facing } from './content.ts';
import type { Point } from './navigation.ts';
import { canTraverse, createPathSearch } from './pathfinding.ts';
import { followOffset, narrowFollowOffset, type CompanionStance } from './party-placement.ts';
import type { Combatant } from './combat.ts';
import type { PartyPort } from './party-ai.ts';

const distance=(a:Point,b:Point)=>Math.hypot(a.x-b.x,a.y-b.y);

/** 跟随状态不存档；跨图、读档和控制者变化后从当前人物位置重建。 */
export class PartyFollow {
  private clock=0;
  private nextDecision=0;
  private search?:ReturnType<typeof createPathSearch>;
  /** 本次跨帧搜索已经花掉的时间起点；暂停等待不累计。 */
  private searchSince?:number;
  private path:Point[]=[];
  private routeAroundActors=false;
  private goal?:Point;
  private progress?:Point;
  private stalled=0;
  private attemptStalled=0;
  private failures=0;
  private nextRetry=0;
  private nextRescue=0;
  private softSince?:number;
  private hardSince?:number;
  private nearSince?:number;
  private returning=false;
  private settled=false;
  private lastLeader='';
  private lastLeaderPoint?:Point;
  private stanceFacing:Facing='south';
  private leaderTowardsAlly=false;
  readonly diagnostics={searches:0,expanded:0,recoveries:0,rescues:0,reason:''};
  private readonly id:string;
  private readonly port:PartyPort;
  constructor(id:string,port:PartyPort){this.id=id;this.port=port;}
  get destination():Point|undefined{return this.goal?{...this.goal}:undefined;}
  get leader():string|undefined{return this.goal?this.lastLeader:undefined;}
  reset():void {
    this.path=[];this.search=undefined;this.searchSince=undefined;this.goal=undefined;this.progress=undefined;this.stalled=0;
    this.routeAroundActors=false;
    this.attemptStalled=0;
    this.failures=0;this.returning=false;this.softSince=this.hardSince=this.nearSince=undefined;
    this.nextDecision=0;this.settled=false;this.lastLeader='';this.lastLeaderPoint=undefined;this.stanceFacing='south';this.leaderTowardsAlly=false;
  }
  tick(actor:Combatant,leader:Combatant,delta:number):boolean {
    this.clock+=delta;
    const jumped=this.lastLeaderPoint!==undefined&&distance(this.lastLeaderPoint,leader.position)>128;
    if(this.lastLeader!==leader.id||jumped){
      if(jumped&&this.lastLeader===leader.id&&distance(actor.position,leader.position)>320&&this.port.regroup?.()===true){
        this.diagnostics.rescues++;this.diagnostics.reason='leader-relocated';
      }
      this.path=[];this.search=undefined;this.searchSince=undefined;this.goal=undefined;this.nextDecision=0;this.stalled=0;
      this.routeAroundActors=false;
      this.attemptStalled=0;
      this.returning=false;this.softSince=this.hardSince=this.nearSince=undefined;this.leaderTowardsAlly=false;
      this.lastLeader=leader.id;
    }
    const previous=this.lastLeaderPoint;
    if(previous===undefined){
      this.stanceFacing=this.port.leaderFacing?.()??this.stanceFacing;
    }else{
      const dx=leader.position.x-previous.x,dy=leader.position.y-previous.y;
      const moved=Math.hypot(dx,dy)>.5;
      const towards=dx*(actor.position.x-leader.position.x)+dy*(actor.position.y-leader.position.y)>0;
      this.leaderTowardsAlly=moved&&towards;
      if(moved&&!this.leaderTowardsAlly)this.stanceFacing=this.port.leaderFacing?.()??this.stanceFacing;
    }
    this.lastLeaderPoint={...leader.position};
    const gap=distance(actor.position,leader.position);
    this.softSince=gap>192?(this.softSince??this.clock):undefined;
    this.hardSince=gap>320?(this.hardSince??this.clock):undefined;
    if(this.softSince!==undefined&&this.clock-this.softSince>=900||
      this.hardSince!==undefined&&this.clock-this.hardSince>=600)this.returning=true;
    this.nearSince=gap<=112?(this.nearSince??this.clock):undefined;
    if(this.nearSince!==undefined&&this.clock-this.nearSince>=600)this.returning=false;
    return this.returning;
  }
  suspend():void {
    this.progress=undefined;
    this.stalled=0;
    this.attemptStalled=0;
    // 暂停或不能移动期间的等待不算无进展；下次继续搜索时重新计时。
    this.searchSince=undefined;
  }
  move(actor:Combatant,leader:Combatant,stance:CompanionStance,delta:number):void {
    // 队长朝伙伴走来时原地等待；该让路的是队长，伙伴不迎上去也不重新找站位。
    if(this.leaderTowardsAlly&&!this.returning){
      this.routeAroundActors=false;
      this.attemptStalled=0;
      this.progress=undefined;this.stalled=0;this.path=[];this.search=undefined;this.goal=undefined;this.port.stop();return;
    }
    const free=(p:Point)=>(this.port.followCanStand??this.port.canStand)(p);
    if(!this.progress||distance(actor.position,this.progress)>=4){
      this.progress={...actor.position};
      this.stalled=0;
      this.attemptStalled=0;
      this.failures=0;
    }else if(!this.search){
      this.stalled+=delta;
      this.attemptStalled+=delta;
    }
    // 先结束走不动的旧路线，再给下一次恢复完整的移动机会。
    if(this.attemptStalled>=1000&&!this.search&&this.clock>=this.nextRetry){
      this.path=[];
      this.routeAroundActors=true;
      this.nextDecision=0;
      this.nextRetry=this.clock+120;
      this.attemptStalled=0;
      this.failures++;
      this.diagnostics.recoveries++;
    }
    if(this.clock>=this.nextDecision){
      this.nextDecision=this.clock+120;
      const slot=this.port.followSlot?.()??0;
      const offset=followOffset(this.stanceFacing,stance,slot);
      const preferred={x:leader.position.x+offset.x,y:leader.position.y+offset.y};
      // 职业站位只能选队长走得到的点，墙内目标退回队长附近。
      const preferredOk=free(preferred)&&canTraverse(leader.position,preferred,free);
      let goal:Point;
      if(this.returning)goal=leader.position;
      else if(preferredOk)goal=preferred;
      else {
        // 站位点放不下时按槽位在队长身后前后错开，窄道里也不会挤成一个点。
        const narrowOffset=narrowFollowOffset(this.stanceFacing,slot);
        const narrow={x:leader.position.x+narrowOffset.x,y:leader.position.y+narrowOffset.y};
        goal=free(narrow)&&canTraverse(leader.position,narrow,free)?narrow:leader.position;
      }
      const gap=distance(actor.position,goal),stop=goal===leader.position?24:12;
      if(gap<=stop||this.settled&&gap<=24){
        this.routeAroundActors=false;
        this.attemptStalled=0;
        this.settled=true;this.path=[];this.search=undefined;this.progress=undefined;this.stalled=0;this.port.stop();return;
      }
      this.settled=false;
      if(!this.search&&this.clock>=this.nextRetry){
        const waypoint=this.next();
        const blocked=this.path.length>0&&waypoint===undefined;
        if(blocked)this.routeAroundActors=true;
        if(!this.path.length||!this.goal||distance(this.goal,goal)>=8||blocked){
          this.goal={...goal};
          if(canTraverse(actor.position,goal,free)){
            this.path=[{...goal}];
            this.routeAroundActors=false;
          }else{
            // 迈不出去时把当前挡路的人物纳入这次搜索，后续重试重新取占位。
            const snapshot=this.routeAroundActors
              ?this.port.navigationSnapshot?.()
              :(this.port.followNavigationSnapshot??this.port.navigationSnapshot)?.();
            const canStand=snapshot?.canStand??free;
            this.search=createPathSearch(actor.position,{
              bounds:snapshot?.bounds??this.port.navigationBounds(),
              canStand,
              canStandXY:snapshot?.canStandXY,
              isGoal:p=>distance(p,goal)<=12&&canStand(p),
              heuristic:p=>Math.max(0,distance(p,goal)-12),
            });
            this.diagnostics.searches++;
          }
        }
      }
    }
    if(this.search){
      // 搜索仍在进行时算“等待寻路”，不累计无进展；第一次推进时开始计时。
      this.searchSince??=this.clock;
      const allowance=this.port.pathBudget?.take(this.id,48)??384;
      if(allowance>0){
        const result=this.search.step(allowance);this.diagnostics.expanded+=result.expanded;
        if(result.status!=='pending'){
          this.search=undefined;
          const elapsed=this.searchSince===undefined?0:this.clock-this.searchSince;
          this.searchSince=undefined;
          if(result.status==='found'){let closest=0;for(let i=1;i<result.path.length;i++){if(distance(actor.position,result.path[i]!)>=distance(actor.position,result.path[closest]!))break;closest=i;}this.path=result.path.slice(closest);}
          else{
            this.failures++;
            // 人物占位只属于这次搜索；旧路线仍逐步查实时碰撞，挡路者移开后可以继续走。
            if(!this.routeAroundActors)this.path=[];
            // 失败前的搜索时间同样是没走动的真实时间，计入累计无进展；
            // 本次恢复仍从零开始，旧路线保留到真正迈不动时再清理。
            this.stalled+=elapsed;
            this.attemptStalled=0;
            this.nextRetry=this.clock+600;
            this.diagnostics.recoveries++;
          }
        }
      }
    }
    if(this.stalled>=4000&&this.failures>=2&&this.clock>=this.nextRescue){
      if(this.port.regroup?.()===true){this.diagnostics.rescues++;this.diagnostics.reason='recovery-failed';this.reset();this.nextRescue=this.clock+5000;return;}
      this.nextRescue=this.clock+600;
    }
    if(this.next()){
      const gap=distance(actor.position,leader.position),scale=1+Math.min(.25,Math.max(0,(gap-96)/256));
      this.port.followPath(this.next,scale);
    }else this.port.stop();
  }
  private readonly next=():Point|undefined=>{
    const actor=this.port.actor(this.id);if(!actor)return;
    while(this.path.length&&distance(actor.position,this.path[0]!)<1)this.path.shift();
    const goal=this.path[0];if(!goal)return;
    const d=distance(actor.position,goal),fraction=Math.min(1,16/d);
    const step={x:actor.position.x+(goal.x-actor.position.x)*fraction,y:actor.position.y+(goal.y-actor.position.y)*fraction};
    return canTraverse(actor.position,step,p=>(this.port.followCanStand??this.port.canStand)(p))?step:undefined;
  };
}

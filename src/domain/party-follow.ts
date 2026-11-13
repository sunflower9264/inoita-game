import type { Facing } from './content.ts';
import type { Point } from './navigation.ts';
import { canTraverse, createPathSearch } from './pathfinding.ts';
import { followOffset, type CompanionStance } from './party-placement.ts';
import type { Combatant } from './combat.ts';
import type { PartyPort } from './party-ai.ts';

const distance=(a:Point,b:Point)=>Math.hypot(a.x-b.x,a.y-b.y);
/** 整队共享已走过的路；固定上限，不随游玩时间增长。 */
export class PartyTrail {
  private points:{point:Point;time:number}[]=[];
  private leaderId='';
  private clock=0;
  private movedAt=0;
  private last?:Point;
  facing:Facing='south';
  revision=0;
  discontinuity=0;
  reset():void {this.points=[];this.last=undefined;this.leaderId='';this.revision++;}
  record(id:string,point:Point,delta:number,facing:Facing):void {
    this.clock+=delta;
    if(id!==this.leaderId||this.last&&distance(this.last,point)>128){
      this.reset();this.leaderId=id;this.facing=facing;this.discontinuity++;
    }
    const previous=this.last;
    if(previous&&distance(previous,point)>.5){
      this.movedAt=this.clock;
      const dx=point.x-previous.x,dy=point.y-previous.y;
      this.facing=Math.abs(dx)>Math.abs(dy)?dx>0?'east':'west':dy>0?'south':'north';
    }
    const tail=this.points.at(-1);
    if(!tail||distance(tail.point,point)>=8||previous&&this.points.length>1&&
      Math.abs((point.x-previous.x)*(previous.y-tail.point.y)-(point.y-previous.y)*(previous.x-tail.point.x))>1){
      this.points.push({point:{...point},time:this.clock});if(this.points.length>128)this.points.shift();this.revision++;
    }
    this.last={...point};
  }
  get moving():boolean{return this.points.length>1&&this.clock-this.movedAt<600;}
  get size():number{return this.points.length;}
  get departureOrigin():Point|undefined {
    return this.points.find(value=>value.time>=this.clock-1200)?.point??this.last;
  }
  /** 找到队员附近的路段，再向队长方向看最多 32px，保持转弯顺序。 */
  waypoint(position:Point,lag:number):Point|undefined {
    if(!this.last||!this.points.length)return;
    let end=this.points.length-1,remaining=distance(this.last,this.points[end]!.point);
    while(end>0&&remaining<lag){remaining+=distance(this.points[end]!.point,this.points[end-1]!.point);end--;}
    let nearest=0,best=Infinity;
    for(let i=0;i<=end;i++){const d=distance(position,this.points[i]!.point);if(d<best){best=d;nearest=i;}}
    let ahead=0;
    while(nearest<end&&ahead<32){ahead+=distance(this.points[nearest]!.point,this.points[nearest+1]!.point);nearest++;}
    return this.points[nearest]!.point;
  }
}

/** 跟随状态不存档；跨图、读档和控制者变化后从当前人物位置重建。 */
export class PartyFollow {
  readonly localTrail=new PartyTrail();
  private clock=0;
  private nextDecision=0;
  private search?:ReturnType<typeof createPathSearch>;
  private path:Point[]=[];
  private goal?:Point;
  private progress?:Point;
  private stalled=0;
  private failures=0;
  private nextRetry=0;
  private nextRescue=0;
  private softSince?:number;
  private hardSince?:number;
  private nearSince?:number;
  private returning=false;
  private settled=false;
  private trailVersion=-1;
  private lastLeader='';
  readonly diagnostics={searches:0,expanded:0,recoveries:0,rescues:0,reason:''};
  private readonly id:string;
  private readonly port:PartyPort;
  constructor(id:string,port:PartyPort){this.id=id;this.port=port;}
  get destination():Point|undefined{return this.goal?{...this.goal}:undefined;}
  get leader():string|undefined{return this.goal?this.lastLeader:undefined;}
  reset():void {
    this.path=[];this.search=undefined;this.goal=undefined;this.progress=undefined;this.stalled=0;
    this.failures=0;this.returning=false;this.softSince=this.hardSince=this.nearSince=undefined;
    this.nextDecision=0;this.settled=false;this.localTrail.reset();this.lastLeader='';
  }
  tick(actor:Combatant,leader:Combatant,delta:number):boolean {
    this.clock+=delta;
    if(!this.port.followTrail)this.localTrail.record(leader.id,leader.position,delta,this.port.leaderFacing?.()??'south');
    const trail=this.port.followTrail??this.localTrail;
    if(this.lastLeader!==leader.id||this.trailVersion!==trail.discontinuity){
      const teleported=this.lastLeader===leader.id&&this.trailVersion!==trail.discontinuity&&distance(actor.position,leader.position)>320;
      if(teleported&&this.port.regroup?.()===true){this.diagnostics.rescues++;this.diagnostics.reason='leader-relocated';}
      this.path=[];this.search=undefined;this.goal=undefined;this.nextDecision=0;this.stalled=0;
      this.returning=false;this.softSince=this.hardSince=this.nearSince=undefined;
      this.lastLeader=leader.id;this.trailVersion=trail.discontinuity;
    }
    const gap=distance(actor.position,leader.position),origin=trail.departureOrigin;
    const departing=!!origin&&distance(origin,leader.position)>=48&&gap-distance(actor.position,origin)>=32;
    this.softSince=gap>192?(this.softSince??this.clock):undefined;
    this.hardSince=gap>320?(this.hardSince??this.clock):undefined;
    if(this.softSince!==undefined&&this.clock-this.softSince>=900&&departing||
      this.hardSince!==undefined&&this.clock-this.hardSince>=600)this.returning=true;
    this.nearSince=gap<=112?(this.nearSince??this.clock):undefined;
    if(this.nearSince!==undefined&&this.clock-this.nearSince>=600)this.returning=false;
    return this.returning;
  }
  suspend():void {this.progress=undefined;this.stalled=0;}
  move(actor:Combatant,leader:Combatant,stance:CompanionStance,delta:number):void {
    const trail=this.port.followTrail??this.localTrail;
    const free=(p:Point)=>(this.port.followCanStand??this.port.canStand)(p);
    if(!this.progress||distance(actor.position,this.progress)>=4){this.progress={...actor.position};this.stalled=0;this.failures=0;}
    else if(!this.search)this.stalled+=delta;
    if(this.clock>=this.nextDecision){
      this.nextDecision=this.clock+120;
      const slot=this.port.followSlot?.()??0;
      let goal=trail.moving?trail.waypoint(actor.position,slot===0?32:48):undefined;
      if(!goal){
        const offset=followOffset(trail.facing,stance,slot);
        const preferred={x:leader.position.x+offset.x,y:leader.position.y+offset.y};
        // 职业站位只能选队长走得到的点，墙内目标退回队长附近。
        goal=free(preferred)&&canTraverse(leader.position,preferred,free)?preferred:leader.position;
      }
      if(!free(goal))goal=leader.position;
      const gap=distance(actor.position,goal),stop=goal===leader.position?24:12;
      if(gap<=stop||this.settled&&gap<=24){
        this.settled=true;this.path=[];this.search=undefined;this.progress=undefined;this.stalled=0;this.port.stop();return;
      }
      this.settled=false;
      if(!this.search&&this.clock>=this.nextRetry&&(!this.path.length||!this.goal||distance(this.goal,goal)>=8||!this.next())){
        this.goal={...goal};
        if(canTraverse(actor.position,goal,free)){this.path=[{...goal}];}
        else {
          const snapshot=(this.port.followNavigationSnapshot??this.port.navigationSnapshot)?.();
          const canStand=snapshot?.canStand??free;
          this.search=createPathSearch(actor.position,{bounds:snapshot?.bounds??this.port.navigationBounds(),canStand,canStandXY:snapshot?.canStandXY,
            isGoal:p=>distance(p,goal)<=12&&canStand(p),heuristic:p=>Math.max(0,distance(p,goal)-12)});
          this.diagnostics.searches++;
        }
      }
    }
    if(this.search){
      const allowance=this.port.pathBudget?.take(this.id,48)??384;
      if(allowance>0){
        const result=this.search.step(allowance);this.diagnostics.expanded+=result.expanded;
        if(result.status!=='pending'){
          this.search=undefined;
          if(result.status==='found'){let closest=0;for(let i=1;i<result.path.length;i++){if(distance(actor.position,result.path[i]!)>=distance(actor.position,result.path[closest]!))break;closest=i;}this.path=result.path.slice(closest);}
          else{this.failures++;this.path=[];this.nextRetry=this.clock+600;this.diagnostics.recoveries++;}
        }
      }
    }
    if(this.stalled>=1000&&!this.search&&this.clock>=this.nextRetry){
      this.path=[];this.nextDecision=0;this.nextRetry=this.clock+120;this.failures++;this.diagnostics.recoveries++;
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

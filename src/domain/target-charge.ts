import type { SkillCharge } from './battle.ts';
import type { Combatant } from './combat.ts';
import type { Point } from './navigation.ts';
import { attackDistance } from './basic-attack.ts';

const MAX_PATH_SEARCH_STEPS = 101;
const MAX_VERIFY_ATTEMPTS = 2;
/** 格子键的坐标偏移与步长：偏移大于地图尺寸，步长大于两倍坐标范围，保证不同格子不撞键。 */
const CELL_KEY_OFFSET = 1_000_000;
const CELL_KEY_STRIDE = CELL_KEY_OFFSET * 2 + 1;

export interface ChargePlan { destination: Point; close: boolean }

/** 查找可达的近敌落点。场景提供物理世界的占用查询，规则只处理网格路径。 */
export function planCharge(caster: Combatant, target: Combatant, charge: SkillCharge,
  canStand: (point: Point) => boolean,
  canReach: (point: Point) => boolean = () => true,
  verify: (point: Point) => boolean = () => true): ChargePlan | undefined {
  if (attackDistance(caster.position,caster.bounds,target.position,target.bounds)-2 < charge.closeDistanceUnits) {
    return {destination:{...caster.position},close:true};
  }
  const size=charge.gridSizePx;
  const start={x:Math.floor(caster.position.x/size),y:Math.floor(caster.position.y/size)};
  const goal={x:Math.floor(target.position.x/size),y:Math.floor(target.position.y/size)};
  const distance=(node:{x:number;y:number})=>Math.abs(node.x-goal.x)+Math.abs(node.y-goal.y);
  // 格子编号用整数，避免每个节点拼字符串；偏移量远大于地图尺寸，不会撞键。
  const key=(x:number,y:number)=>(y+CELL_KEY_OFFSET)*CELL_KEY_STRIDE+(x+CELL_KEY_OFFSET);
  const standable=new Map<number,boolean>();
  const reachable=new Map<number,boolean>();
  const canStandCell=(x:number,y:number)=>{
    const cell=key(x,y);
    let value=standable.get(cell);
    if(value===undefined){value=canStand({x:x*size,y:y*size});standable.set(cell,value);}
    return value;
  };
  const canReachCell=(x:number,y:number)=>{
    const cell=key(x,y);
    let value=reachable.get(cell);
    if(value===undefined){value=canReach({x:x*size,y:y*size});reachable.set(cell,value);}
    return value;
  };
  interface Node {x:number;y:number;cost:number;order:number}
  const open:Node[]=[{...start,cost:0,order:0}];
  let nextOrder=1;
  const compare=(first:Node,second:Node)=>first.cost+distance(first)-(second.cost+distance(second))||first.order-second.order;
  const push=(node:Node)=>{
    open.push(node);
    let index=open.length-1;
    while(index>0){
      const parent=(index-1)>>1;
      if(compare(open[parent]!,node)<=0)break;
      open[index]=open[parent]!;index=parent;
    }
    open[index]=node;
  };
  const pop=()=>{
    const first=open[0]!;
    const last=open.pop()!;
    if(open.length){
      let index=0;
      while(index*2+1<open.length){
        let child=index*2+1;
        if(child+1<open.length&&compare(open[child+1]!,open[child]!)<0)child++;
        if(compare(last,open[child]!)<=0)break;
        open[index]=open[child]!;index=child;
      }
      open[index]=last;
    }
    return first;
  };
  const costs=new Map<number,number>([[key(start.x,start.y),0]]);
  let verifyAttempts=0;
  for(let visited=0;open.length&&visited<MAX_PATH_SEARCH_STEPS;visited++){
    const current=pop();
    if(current.cost!==costs.get(key(current.x,current.y)))continue;
    const destination={x:current.x*size,y:current.y*size};
    if(distance(current)<=charge.stoppingDistanceUnits&&canStandCell(current.x,current.y)&&canReachCell(current.x,current.y)){
      // 搜索中即时复核：通过就用这个点，不通过就继续找下一个。
      if(verifyAttempts>=MAX_VERIFY_ATTEMPTS)break;
      verifyAttempts++;
      if(verify(destination))return {destination,close:false};
    }
    for(const [dx,dy] of [[-1,0],[0,-1],[0,1],[1,0]] as const){
      const nextX=current.x+dx,nextY=current.y+dy,cost=current.cost+1;
      const cell=key(nextX,nextY);
      if(cost>=(costs.get(cell)??Infinity))continue;
      if(!canStandCell(nextX,nextY)||!canReachCell(nextX,nextY))continue;
      costs.set(cell,cost);
      push({x:nextX,y:nextY,cost,order:nextOrder++});
    }
  }
  return forwardFallback(caster,target,canStand,canReach,verify);
}

/** 朝目标方向逐格退到最远的可站点；原地也站不住时返回 undefined。 */
function forwardFallback(caster: Combatant, target: Combatant,
  canStand: (point: Point) => boolean, canReach: (point: Point) => boolean,
  verify: (point: Point) => boolean): ChargePlan | undefined {
  if(!canStand(caster.position))return undefined;
  const dx=target.position.x-caster.position.x, dy=target.position.y-caster.position.y;
  const distance=Math.hypot(dx,dy);
  if(distance<=0)return {destination:{...caster.position},close:false};
  const steps=Math.floor(distance);
  let landing={...caster.position};
  for(let index=1;index<=steps;index++){
    const point={x:caster.position.x+dx/distance*index,y:caster.position.y+dy/distance*index};
    if(!canStand(point)||!canReach(point)||!verify(point))break;
    landing=point;
  }
  return {destination:landing,close:false};
}

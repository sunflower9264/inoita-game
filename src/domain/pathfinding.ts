import type { GameRectangle, Point } from './navigation.ts';

export const PATH_GRID_SIZE = 8;

export interface PathQuery {
  bounds: GameRectangle;
  canStand(position: Point): boolean;
  isGoal(position: Point): boolean;
  /** 到任意可接受终点的距离下界，单位为像素。 */
  heuristic(position: Point): number;
}

export type PathSearchResult = (
  {status:'pending'} | {status:'unreachable'} | {status:'found';path:Point[]}
) & {
  /** 本次取出的搜索节点数，包含已过期的队列项；不超过本次预算。 */
  expanded:number;
};

export interface PathSearch {
  /** 跨帧调用时，查询函数必须始终读取创建任务时的同一份地图与目标快照。 */
  step(maxExpanded:number):PathSearchResult;
}

interface Node { key: string; point: Point; cost: number; score: number; parent?: Node }

/** 路段沿途检查实体范围；斜行还检查两个相邻方向，禁止从障碍角穿过。 */
export function canTraverse(from: Point, to: Point, canStand: (point: Point) => boolean): boolean {
  const dx=to.x-from.x,dy=to.y-from.y;
  const steps=Math.max(1,Math.ceil(Math.max(Math.abs(dx),Math.abs(dy))/4));
  for(let i=1;i<=steps;i++) {
    const point={x:from.x+dx*i/steps,y:from.y+dy*i/steps};
    const previous={x:from.x+dx*(i-1)/steps,y:from.y+dy*(i-1)/steps};
    if(!canStand(point))return false;
    if(dx&&dy&&(!canStand({x:point.x,y:previous.y})||!canStand({x:previous.x,y:point.y})))return false;
  }
  return true;
}

/** 八邻接 A*。每次保留搜索前沿，预算耗尽时等待下一步，不能视为无路。 */
export function createPathSearch(start:Point,query:PathQuery):PathSearch {
  const bounds={...query.bounds};
  // 缓存属于这一次查询；跨帧任务由调用方提供完整冻结的占位查询。
  const standability=new Map<string,boolean>();
  const canStand=(point:Point)=>{
    const key=`${point.x},${point.y}`;
    let result=standability.get(key);
    if(result===undefined){result=query.canStand(point);standability.set(key,result);}
    return result;
  };
  const heap: Node[]=[];
  const push=(node:Node)=>{
    heap.push(node);let index=heap.length-1;
    while(index>0){const parent=(index-1)>>1;if(heap[parent].score<=node.score)break;heap[index]=heap[parent];index=parent;}
    heap[index]=node;
  };
  const pop=()=>{
    const first=heap[0],last=heap.pop()!;
    if(heap.length){let index=0;while(index*2+1<heap.length){let child=index*2+1;if(child+1<heap.length&&heap[child+1].score<heap[child].score)child++;if(last.score<=heap[child].score)break;heap[index]=heap[child];index=child;}heap[index]=last;}
    return first;
  };
  const key=(point:Point)=>`${Math.round((point.x-bounds.x)/PATH_GRID_SIZE)},${Math.round((point.y-bounds.y)/PATH_GRID_SIZE)}`;
  const inBounds=(point:Point)=>point.x>=bounds.x&&point.y>=bounds.y&&point.x<=bounds.x+bounds.width&&point.y<=bounds.y+bounds.height;
  const column=(start.x-bounds.x)/PATH_GRID_SIZE,row=(start.y-bounds.y)/PATH_GRID_SIZE;
  const aligned=Number.isInteger(column)&&Number.isInteger(row);
  const origin:Node={key:aligned?key(start):'start',point:{...start},cost:0,score:query.heuristic(start)};
  const costs=new Map<string,number>([[origin.key,0]]);
  push(origin);
  let completed:{status:'unreachable'}|{status:'found';path:Point[]}|undefined;
  const result=(expanded:number):PathSearchResult=>completed?.status==='found'
    ?{status:'found',path:completed.path.map(point=>({...point})),expanded}
    :{status:completed?.status??'pending',expanded};
  return {step(maxExpanded){
    if(maxExpanded!==Infinity&&(!Number.isSafeInteger(maxExpanded)||maxExpanded<0))throw new RangeError('寻路节点预算必须是非负整数');
    if(completed)return result(0);
    let expanded=0;
    while(heap.length&&expanded<maxExpanded){
      const current=pop();expanded++;
      if(current.cost!==costs.get(current.key))continue;
      if(query.isGoal(current.point)){
        const path:Point[]=[];let node:Node|undefined=current;
        while(node?.parent){path.push(node.point);node=node.parent;}
        completed={status:'found',path:path.reverse()};
        return result(expanded);
      }
      const neighbors=current===origin&&!aligned
        ? [...new Set([Math.floor(column),Math.ceil(column)])].flatMap(col=>
          [...new Set([Math.floor(row),Math.ceil(row)])].map(row=>({x:bounds.x+col*PATH_GRID_SIZE,y:bounds.y+row*PATH_GRID_SIZE})))
        : [[0,-1],[-1,0],[1,0],[0,1],[-1,-1],[1,-1],[-1,1],[1,1]].map(([dx,dy])=>
          ({x:current.point.x+dx*PATH_GRID_SIZE,y:current.point.y+dy*PATH_GRID_SIZE}));
      for(const point of neighbors){
        const dx=point.x-current.point.x,dy=point.y-current.point.y;
        if(dx&&dy&&(!canStand({x:point.x,y:current.point.y})||!canStand({x:current.point.x,y:point.y})))continue;
        if(!inBounds(point)||!canTraverse(current.point,point,canStand))continue;
        const cost=current.cost+Math.hypot(dx,dy),k=key(point);
        if(cost>=(costs.get(k)??Infinity))continue;
        costs.set(k,cost);push({key:k,point,cost,score:cost+query.heuristic(point),parent:current});
      }
    }
    if(!heap.length)completed={status:'unreachable'};
    return result(expanded);
  }};
}

/** 同步查询沿用同一搜索核、枚举顺序与斜角检查，一次完成全部搜索。 */
export function findPath(start:Point,query:PathQuery,maxExpanded=Infinity):Point[]|null {
  const result=createPathSearch(start,query).step(maxExpanded);
  return result.status==='found'?result.path:null;
}

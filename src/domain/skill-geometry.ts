import type { CollisionBox, Facing } from './content.ts';
import type { SummonPlacement } from './battle.ts';
import type { Point } from './navigation.ts';
import { projectileStep } from './basic-attack.ts';

const DIRECTIONS: readonly Facing[] = ['south', 'west', 'north', 'east'];
/** 落点搜索顺序：正后方 → 两侧 → 正前方。 */
const SEARCH_TURN_ORDER = [0, 1, 3, 2] as const;
/** 落点按 8 像素网格逐格尝试。 */
const SEARCH_GRID_PX = 8;

/** 固定落点的过渡最多前进 switchFrame + 1 次，最后一次强制抵达。 */
export function positionTransitionStep(start:Point,target:Point,stepPx:number,completedSteps:number,switchFrame:number){
  return completedSteps>=switchFrame ? {position:{...target},arrived:true} : projectileStep(start,target,stepPx);
}

/**
 * 原版搜索带几何；按八像素网格挑第一个可站位置。
 * 找不到就返回 `undefined`：落点必须由调用方另找一个合法位置，不再拿主人坐标冒充落点。
 */
export function planSummonSpot(position:Point,box:CollisionBox,facing:Facing,placement:SummonPlacement,
  canStand:(point:Point)=>boolean):Point|undefined{
  const start=DIRECTIONS.indexOf(facing);
  const gap=placement.searchGapPx,extent=placement.searchExtentPx;
  for(const turn of SEARCH_TURN_ORDER){
    const direction=(start+turn)%DIRECTIONS.length;
    for(let forward=0;forward<=extent;forward+=SEARCH_GRID_PX)for(let side=-extent;side<=extent;side+=SEARCH_GRID_PX){
      const point=direction===0?{x:position.x+side,y:position.y+box.y+box.height+gap+forward}
        :direction===1?{x:position.x+box.x-gap-forward,y:position.y+side}
        :direction===2?{x:position.x+side,y:position.y+box.y-gap-forward}
        :{x:position.x+box.x+box.width+gap+forward,y:position.y+side};
      if(canStand(point))return point;
    }
  }
  return undefined;
}

import type {Point} from './navigation.ts';

/** 脚底碰撞框：x/y 是相对角色的左上角偏移。 */
interface RectBounds {x:number;y:number;width:number;height:number}
export interface PlacedRect {position:Point;bounds:RectBounds}

/** 原版一个格距对应的像素数。 */
const PIXELS_PER_DISTANCE_UNIT = 8;

function axisGap(aMin:number,aMax:number,bMin:number,bMax:number):number {
  return Math.max(0,Math.max(aMin-bMax,bMin-aMax));
}

/**
 * 原版 UTIL_GetRectDistance：两个轴的矩形间隙各自整除 8 后相加，重叠时为 0。
 * 返回值是原版格距，不是像素。
 */
export function rectDistance(a:PlacedRect,b:PlacedRect):number {
  const gapX=axisGap(a.position.x+a.bounds.x,a.position.x+a.bounds.x+a.bounds.width,
                    b.position.x+b.bounds.x,b.position.x+b.bounds.x+b.bounds.width);
  const gapY=axisGap(a.position.y+a.bounds.y,a.position.y+a.bounds.y+a.bounds.height,
                    b.position.y+b.bounds.y,b.position.y+b.bounds.y+b.bounds.height);
  return Math.floor(gapY/PIXELS_PER_DISTANCE_UNIT)+Math.floor(gapX/PIXELS_PER_DISTANCE_UNIT);
}

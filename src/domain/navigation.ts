/** 玩家实体半径，单位为世界像素。 */
const PLAYER_RADIUS = 8;

export interface Point {
  x: number;
  y: number;
}

export interface GameRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 地图的地形通行网格。 */
export interface CollisionMap {
  name: string;
  tileSize: number;
  columns: number;
  rows: number;
  blocked: boolean[];
  /** 水格索引（row * columns + col）；脚点落在水格时移动速度减半。 */
  water?: readonly number[];
}

/** 矩形覆盖到的地形格子是否都存在且可站。 */
export function canStandInRect(map: CollisionMap, rect: GameRectangle): boolean {
  const epsilon = 1e-7;
  const left = Math.floor((rect.x + epsilon) / map.tileSize), right = Math.floor((rect.x + rect.width - epsilon) / map.tileSize);
  const top = Math.floor((rect.y + epsilon) / map.tileSize), bottom = Math.floor((rect.y + rect.height - epsilon) / map.tileSize);
  for (let row = top; row <= bottom; row++) for (let col = left; col <= right; col++) {
    if (col < 0 || row < 0 || col >= map.columns || row >= map.rows || map.blocked[row * map.columns + col]) return false;
  }
  return true;
}

/** 以点为心、半径为边长的方形足底；行走与寻路仍用这个窄范围。 */
export function canStandOnTerrain(map: CollisionMap, x: number, y: number, terrainRadius = 4): boolean {
  return canStandInRect(map, { x: x - terrainRadius, y: y - terrainRadius, width: terrainRadius * 2, height: terrainRadius * 2 });
}

export function within(point: Point, rectangle: GameRectangle): boolean {
  return point.x >= rectangle.x && point.x < rectangle.x + rectangle.width && point.y >= rectangle.y && point.y < rectangle.y + rectangle.height;
}

/**
 * 脚底矩形与矩形相交。原版按角色的碰撞盒判定（findings 49：`0x176bf4` 取 `(x-8, y-8, 16, 16)`），
 * 所以「站在格子旁边、身体探进格子」就算碰到——出口格落在不可站立的边缘时只能这样触发
 * （`session.test.ts` 的「blocked edge exit」用例外），出生防回跳也因此覆盖相邻出口格。
 *
 * 出口与事件地理条件共用它：营门口两者压在同一格上（findings 96），粒度不一致时
 * 贴边走近只有出口成立，演出和它接的任务会被一起跳过。
 */
export function overlapsFootRect(point: Point, rectangle: GameRectangle): boolean {
  return point.x + PLAYER_RADIUS > rectangle.x && point.x - PLAYER_RADIUS < rectangle.x + rectangle.width
    && point.y + PLAYER_RADIUS > rectangle.y && point.y - PLAYER_RADIUS < rectangle.y + rectangle.height;
}

/**
 * 进图后要先真正离开到达出口，再走回来，出口才会触发。
 * 只判断“当前没压住”不够：落点常常只离回程出口一两像素，走一步就会弹回上一张图。
 */
export const EXIT_REARM_DISTANCE = 24;

/** 落点是否仍处在出口的重新武装范围内；距离按脚点中心算。 */
export function nearExit(point: Point, exit: GameRectangle, distance = EXIT_REARM_DISTANCE): boolean {
  return point.x > exit.x - distance && point.x < exit.x + exit.width + distance
    && point.y > exit.y - distance && point.y < exit.y + exit.height + distance;
}

export class ExitTrigger<T extends GameRectangle = GameRectangle> {
  private readonly exits: T[];
  /** 到达缓冲区模式：逐出口记录是否已离开落点附近。 */
  private readonly guarded: boolean;
  private readonly blocked: Set<T>;
  /** 兼容模式（无头剧情走位）沿用旧的“整组出口一起武装”状态。 */
  private armed: boolean;
  constructor(exits: T[], spawn: Point, arrivalGuard = true) {
    this.exits = exits;
    this.guarded = arrivalGuard;
    this.blocked = new Set(arrivalGuard ? exits.filter(exit => nearExit(spawn, exit)) : []);
    this.armed = !arrivalGuard && !exits.some(exit => overlapsFootRect(spawn, exit));
  }
  update(position: Point, moving: boolean, available: (exit:T)=>boolean = ()=>true): T | null {
    if (!this.guarded) {
      const exit = this.exits.find(exit => available(exit)&&overlapsFootRect(position, exit));
      if (!exit) { this.armed = true; return null; }
      if (!this.armed || !moving) return null;
      this.armed = false; return exit;
    }
    for (const exit of this.blocked) if (!nearExit(position, exit)) this.blocked.delete(exit);
    const exit = this.exits.find(exit => !this.blocked.has(exit) && available(exit) && overlapsFootRect(position, exit));
    if (!exit || !moving) return null;
    // 整簇门洞都锁上，避免旁边相邻的出口格在同一位置接着触发。
    for (const other of this.exits) if (nearExit(position, other)) this.blocked.add(other);
    return exit;
  }
}

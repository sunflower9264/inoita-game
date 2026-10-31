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
 * 进图后要先走过这段距离，出口才会触发。
 * 落点常常贴着回程出口，走一步就会弹回上一张图；改成累计实际走过的距离后，
 * 在走满之前任何出口都不触发，走满之后才按脚底接触判定。
 */
export const EXIT_REARM_DISTANCE = 80;

export class ExitTrigger<T extends GameRectangle = GameRectangle> {
  private readonly exits: T[];
  /** 到达缓冲区模式：进图后累计走过的距离。 */
  private readonly guarded: boolean;
  /** 兼容模式（无头剧情走位）沿用旧的“整组出口一起武装”状态。 */
  private armed: boolean;
  private walked = 0;
  private last: Point;
  constructor(exits: T[], spawn: Point, arrivalGuard = true) {
    this.exits = exits;
    this.guarded = arrivalGuard;
    this.last = { x: spawn.x, y: spawn.y };
    this.armed = !arrivalGuard && !exits.some(exit => overlapsFootRect(spawn, exit));
  }
  update(position: Point, moving: boolean, available: (exit:T)=>boolean = ()=>true): T | null {
    if (!this.guarded) {
      const exit = this.exits.find(exit => available(exit)&&overlapsFootRect(position, exit));
      if (!exit) { this.armed = true; return null; }
      if (!this.armed || !moving) return null;
      this.armed = false; return exit;
    }
    this.walked += Math.hypot(position.x - this.last.x, position.y - this.last.y);
    this.last = { x: position.x, y: position.y };
    if (this.walked < EXIT_REARM_DISTANCE) return null;
    const exit = this.exits.find(exit => available(exit) && overlapsFootRect(position, exit));
    if (!exit || !moving) return null;
    // 触发后重新计数，避免在同一位置连续触发。
    this.walked = 0; return exit;
  }
}

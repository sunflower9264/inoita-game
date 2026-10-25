import { canStandInRect, canStandOnTerrain, type CollisionMap, type GameRectangle, type Point } from './navigation.ts';
import { canTraverse, findPath, PATH_GRID_SIZE } from './pathfinding.ts';

const TERRAIN_RADIUS = 4;
const COLLISION_EPSILON = 1e-7;
export interface NavigationShape { collision?: GameRectangle }
/** 通行阵营：玩家、佣兵和友方召唤物同属 party，彼此不占位；敌人与中立 NPC 保持实体碰撞。 */
export type NavigationFaction = 'party' | 'hostile' | 'neutral';
export interface NavigationActor {
  shape(): NavigationShape;
  position(): Point;
  enabled(): boolean;
  faction?(): NavigationFaction;
  /** 演出角色按脚本走位：只受地形约束，不被其他人物或机关的占位挡住。 */
  ghost?(): boolean;
  /**
   * 由移动层驱动的队伍单位（主角、佣兵、友方召唤物）。这类单位即使位置没变、或当前隐藏，
   * 落位也要通过整盒校验；内容实体与敌人不设此标记，保持内容坐标的可信语义。
   */
  strictTerrain?(): boolean;
}
export interface Placement { actor: NavigationActor; position: Point; enabled?: boolean }

/** 同属 party 的单位互不阻挡；其他组合保持实体碰撞。 */
export function blocksActor(first: NavigationActor, second: NavigationActor): boolean {
  return !(first.faction?.() === 'party' && second.faction?.() === 'party');
}

export interface NavigationQuerySnapshot {
  readonly bounds:GameRectangle;
  readonly start:Point;
  canStand(point:Point):boolean;
  terrainFree(point:Point):boolean;
}

function terrainFreeAt(bounds:GameRectangle,terrain:CollisionMap|undefined,point:Point):boolean {
  const r=TERRAIN_RADIUS;
  if(point.x-r<bounds.x-COLLISION_EPSILON||point.y-r<bounds.y-COLLISION_EPSILON||
    point.x+r>bounds.x+bounds.width+COLLISION_EPSILON||point.y+r>bounds.y+bounds.height+COLLISION_EPSILON)return false;
  return !terrain||canStandOnTerrain(terrain,point.x,point.y,r);
}

/** 整盒版地形判定：`rect` 是已经加上锚点的世界矩形。 */
function bodyFreeAt(bounds:GameRectangle,terrain:CollisionMap|undefined,rect:GameRectangle):boolean {
  if(rect.x<bounds.x-COLLISION_EPSILON||rect.y<bounds.y-COLLISION_EPSILON||
    rect.x+rect.width>bounds.x+bounds.width+COLLISION_EPSILON||rect.y+rect.height>bounds.y+bounds.height+COLLISION_EPSILON)return false;
  return !terrain||canStandInRect(terrain,rect);
}

export function collisionAt(shape: NavigationShape, point: Point): GameRectangle | undefined {
  const box = shape.collision;
  return box && { ...box, x: point.x + box.x, y: point.y + box.y };
}
export function overlaps(a: GameRectangle, b: GameRectangle): boolean {
  return a.x < b.x + b.width - COLLISION_EPSILON && a.x + a.width > b.x + COLLISION_EPSILON &&
    a.y < b.y + b.height - COLLISION_EPSILON && a.y + a.height > b.y + COLLISION_EPSILON;
}
/** 与 `overlaps(collisionAt(shape,point), other)` 等价，但不为每次比较分配矩形。 */
function overlapsAt(shape: GameRectangle, point: Point, other: GameRectangle): boolean {
  const x = point.x + shape.x, y = point.y + shape.y;
  return x < other.x + other.width - COLLISION_EPSILON && x + shape.width > other.x + COLLISION_EPSILON &&
    y < other.y + other.height - COLLISION_EPSILON && y + shape.height > other.y + COLLISION_EPSILON;
}
export function mirroredCollision(box: GameRectangle | undefined, flip = false): GameRectangle | undefined {
  return box && { ...box, x: flip ? -box.x - box.width : box.x };
}

/** 通行查询读当前占位；同一次批量落位先检查整组结果，再由调用方提交。 */
export class NavigationWorld {
  readonly bounds: GameRectangle;
  readonly name: string;
  private readonly terrain?: CollisionMap;
  private readonly actors = new Set<NavigationActor>();
  constructor(terrain: CollisionMap | { name: string; bounds: GameRectangle }) {
    this.name = terrain.name;
    this.terrain = 'tileSize' in terrain ? terrain : undefined;
    this.bounds = 'bounds' in terrain ? { ...terrain.bounds } : { x: 0, y: 0, width: terrain.columns * terrain.tileSize, height: terrain.rows * terrain.tileSize };
  }
  register(actor: NavigationActor): () => void { this.actors.add(actor); return () => this.actors.delete(actor); }
  terrainFree(point: Point): boolean {
    return terrainFreeAt(this.bounds,this.terrain,point);
  }
  /** 分帧搜索读取同一时刻的完整通行状态；执行路径时仍使用实时 canStand 检查。 */
  captureStandability(actor:NavigationActor):NavigationQuerySnapshot {
    const bounds=Object.freeze({...this.bounds}),start=Object.freeze({...actor.position()});
    const source=actor.shape().collision,collision=source?{...source}:undefined;
    const terrain=this.terrain?{...this.terrain,blocked:[...this.terrain.blocked]}:undefined;
    const occupied:GameRectangle[]=[];
    for(const other of this.actors){
      if(other===actor||!other.enabled()||actor.ghost?.()||other.ghost?.()||!blocksActor(actor,other))continue;
      const box=collisionAt(other.shape(),other.position());
      if(box)occupied.push(box);
    }
    const terrainFree=(point:Point)=>terrainFreeAt(bounds,terrain,point);
    return {bounds,start,terrainFree,canStand(point){
      return !collision||terrainFree(point)&&!occupied.some(other=>overlapsAt(collision,point,other));
    }};
  }
  canPlace(shape: NavigationShape, point: Point, ignore?: NavigationActor, placements: readonly Placement[] = []): boolean {
    // 没有实体范围的角色不参与通行判定：这类角色在原版也没有足底范围（地图出口、三盏神灯、
    // 次元之门、桥），位置本来就常贴在墙上或地图边界。
    const box = collisionAt(shape, point);
    if (!box) return true;
    return this.terrainFree(point) && !this.blockedByActors(box, ignore, placements);
  }
  /**
   * 召唤落点用的落位判定：与 `canPlace` 同一套实体重叠规则，只把地形那一步从窄足底换成
   * **整个碰撞盒**。凭空出现的生物不该把身体压在墙里或伸出地图边界，而行走、寻路和普通
   * 摆放继续走窄足底口径——这个不对称是有意的，别为了「统一」把它扩散到移动上。
   */
  canPlaceBody(shape: NavigationShape, point: Point, ignore?: NavigationActor, placements: readonly Placement[] = []): boolean {
    const box = collisionAt(shape, point);
    if (!box) return true;
    return bodyFreeAt(this.bounds, this.terrain, box) && !this.blockedByActors(box, ignore, placements);
  }
  /** 只问地形：身体整盒是否压在阻挡格或地图外。诊断用它把「嵌墙」与「被人挡住」分开。 */
  bodyTerrainFree(shape: NavigationShape, point: Point): boolean {
    const box = collisionAt(shape, point);
    return !box || bodyFreeAt(this.bounds, this.terrain, box);
  }
  private blockedByActors(box: GameRectangle, ignore?: NavigationActor, placements: readonly Placement[] = []): boolean {
    // 绝大多数查询没有瞬移/落位覆盖；空 placements 时别为每个查询建一张 Map。
    const replacements = placements.length ? new Map(placements.map(p => [p.actor, p])) : undefined;
    for (const actor of this.actors) {
      if (actor === ignore) continue;
      if (ignore?.ghost?.() || actor.ghost?.()) continue;
      if (ignore && !blocksActor(ignore, actor)) continue;
      const replacement = replacements?.get(actor);
      if (!(replacement?.enabled ?? actor.enabled())) continue;
      const other = actor.shape().collision;
      if (other && overlapsAt(other, replacement?.position ?? actor.position(), box)) return true;
    }
    return false;
  }
  /**
   * 移动与寻路用的可站判定。地形对**任何**角色都成立：脚点不能落在阻挡格，不阻挡别人的角色
   * 也不能穿墙——原版 NPCINFOBASE 的 0x80 位只说明它不挡人，移动仍受地形约束，`settleStep`
   * 也按同一口径把脚点挤进阻挡格的位移退回。人物重叠只对有实体范围的角色成立。
   * 摆放校验走 `canPlace`：没有实体范围的角色允许贴墙站着，两者的差别就在这里。
   */
  canStand(actor: NavigationActor, point: Point): boolean {
    if (!this.terrainFree(point)) return false;
    // `canPlace` 会再查一次地形和碰撞盒；这里已经查过地形，只补人物占位。
    const box = collisionAt(actor.shape(), point);
    return !box || !this.blockedByActors(box, actor);
  }
  /**
   * 整组落位是否都站得住，**包括没动的那些**。判定「一次挪动之后这一组是否成立」用它。
   * 与 `canSettleAll` 的区别就在这里：地图自带实体保持原位时允许贴墙或与相邻实体重叠，
   * 那种位置过不了这一关——想校验「重放地图数据是否成立」要用 `canSettleAll`。
   */
  canPlaceAll(placements: readonly Placement[]): boolean {
    return placements.every(p => !(p.enabled ?? p.actor.enabled()) || this.canPlace(p.actor.shape(), p.position, p.actor, placements));
  }
  /**
   * 只校验位置真正变了的落位。地图自带实体（火把、泉水、宝箱、按阶段显隐的人物）保持原位时，
   * 位置来自地图数据本身，本来就允许贴在墙上、摆在阻挡格或与相邻实体重叠；重放它们不该失败。
   * 队伍单位（`strictTerrain`）例外：位置没变或当前隐藏也要求整盒落点成立，堵住
   * 「隐藏时写入非法坐标，再显示出来就永久卡墙」的路径。
   */
  canSettleAll(placements: readonly Placement[]): boolean {
    return placements.every(p => {
      const strict = p.actor.strictTerrain?.() === true;
      if (!(p.enabled ?? p.actor.enabled()) && !strict) return true;
      const current = p.actor.position();
      if (!strict && current.x === p.position.x && current.y === p.position.y) return true;
      if (strict) return this.canPlaceBody(p.actor.shape(), p.position, p.actor, placements) && this.terrainFree(p.position);
      return this.canPlace(p.actor.shape(), p.position, p.actor, placements);
    });
  }
  /**
   * 权威落位：`placements` 的位置必须成立，被它们压住的角色就近让开。
   * 剧情把人物登记到正式地图时用这个——那里位置来自内容，玩家的走动或转场落点不该把它
   * 顶掉，也不该让整组落位失败。不在 `placements` 里的现有角色一律让位；目标角色本身
   * 只有在列进 `displaceable`（主角这类权威性低于剧情角色的）时才让位。
   */
  evictionsFor(placements: readonly Placement[], displaceable: ReadonlySet<NavigationActor> = new Set()):
    { actor: NavigationActor; position: Point; enabled: boolean }[] {
    const settled = new Map<NavigationActor, { position: Point; enabled: boolean }>(
      placements.map(p => [p.actor, { position: p.position, enabled: p.enabled ?? p.actor.enabled() }]));
    const evicted: { actor: NavigationActor; position: Point; enabled: boolean }[] = [];
    for (const actor of this.actors) {
      if (!actor.enabled()) continue;
      const target = settled.get(actor);
      if (target && !displaceable.has(actor)) continue;
      const point = target?.position ?? actor.position();
      const others = [...settled].filter(([other]) => other !== actor).map(([other, value]) => ({ actor: other, position: value.position, enabled: value.enabled }));
      const strict = actor.strictTerrain?.() === true;
      if (strict
        ? this.terrainFree(point) && this.canPlaceBody(actor.shape(), point, actor, others)
        : this.canPlace(actor.shape(), point, actor, others)) continue;
      // 队伍单位要让位的点也必须过整盒 + 脚点两关，否则 placeAll 收尾仍会判它非法。
      const position = strict
        ? this.nearestSettledBody(actor.shape(), point, actor, others) ?? point
        : this.nearest(actor.shape(), point, actor, others);
      evicted.push({ actor, position, enabled: true }); settled.set(actor, { position, enabled: true });
    }
    return evicted;
  }
  /** 就近找一个能落脚的点。落位允许没有实体范围的角色贴在墙上，落脚不行，所以这里额外要求地形可站。 */
  nearest(shape: NavigationShape, point: Point, ignore?: NavigationActor, placements: readonly Placement[] = []): Point {
    const best = this.scanNearest(p => this.terrainFree(p) && this.canPlace(shape, p, ignore, placements), point);
    if (!best) throw new Error(`地图没有可通行区域：${this.name}`);
    return best;
  }
  /** 整盒版就近落点：整个碰撞盒站得住，且不与现有实体重叠；地图上没有这样的位置时返回 undefined。 */
  nearestBody(shape: NavigationShape, point: Point, ignore?: NavigationActor, placements: readonly Placement[] = []): Point | undefined {
    if (!shape.collision) return undefined;
    return this.scanNearest(p => this.canPlaceBody(shape, p, ignore, placements), point);
  }
  /**
   * 队伍单位落位用的就近点：整盒可站之外还要求脚点地形可站。
   *
   * `canSettleAll` 对 `strictTerrain` 角色同时检查 `canPlaceBody` 与 `terrainFree(脚点)`；
   * 只用 `nearestBody` 选点会在矩形边界附近选出「整盒通过、脚点仍压阻挡格」的位置，
   * 前面的修正看着成功，最后整组校验却失败。这里把两个条件合成同一个候选谓词。
   */
  nearestSettledBody(shape: NavigationShape, point: Point, ignore?: NavigationActor, placements: readonly Placement[] = []): Point | undefined {
    if (!shape.collision) return undefined;
    return this.scanNearest(p => this.terrainFree(p) && this.canPlaceBody(shape, p, ignore, placements), point);
  }
  /**
   * 召唤落点：`preferred` 整盒可站、且能从 `origin` 沿地形走到时原样返回；否则用
   * Dijkstra 找按可走路径长度最近的整盒可站点；地图上没有这样的位置时返回 undefined。
   *
   * 连通性只按地形判定，和移动的窄足底口径一致；不把当前人物占位当成永久隔断。
   * 落点本身仍走 `canPlaceBody`，出生瞬间不能把身体压进墙里或叠在别人身上。
   */
  nearestReachableBody(shape: NavigationShape, origin: Point, preferred?: Point,
    ignore?: NavigationActor, placements: readonly Placement[] = []): Point | undefined {
    if (!shape.collision) return undefined;
    if (preferred && this.canPlaceBody(shape, preferred, ignore, placements) && this.terrainRoute(origin, preferred))
      return { ...preferred };
    let landing: Point | undefined;
    const free = (point: Point) => this.terrainFree(point);
    const path = findPath(origin, {
      bounds: this.bounds,
      canStand: free,
      isGoal: point => {
        if (!this.canPlaceBody(shape, point, ignore, placements)) return false;
        landing = { ...point };
        return true;
      },
      heuristic: () => 0,
    });
    return path === null || !landing ? undefined : landing;
  }
  /** 地形连通性：与移动使用的窄足底口径一致。 */
  private terrainRoute(from: Point, to: Point): boolean {
    const free = (point: Point) => this.terrainFree(point);
    if (!free(from) || !free(to)) return false;
    return findPath(from, {
      bounds: this.bounds,
      canStand: free,
      isGoal: point => Math.hypot(point.x - to.x, point.y - to.y) <= PATH_GRID_SIZE && canTraverse(point, to, free),
      heuristic: point => Math.max(0, Math.hypot(point.x - to.x, point.y - to.y) - PATH_GRID_SIZE),
    }) !== null;
  }
  private scanNearest(standable: (point: Point) => boolean, point: Point): Point | undefined {
    if (standable(point)) return { ...point };
    let best: Point | undefined, distance = Infinity;
    const b = this.bounds;
    // 半格步长：位移技能按 8px 栅格选点，只扫 16px 瓦片中心会漏掉一半合法落点。
    const step = Math.max(4, Math.floor((this.terrain?.tileSize ?? PATH_GRID_SIZE) / 2));
    for (let y = b.y + step / 2; y < b.y + b.height; y += step) for (let x = b.x + step / 2; x < b.x + b.width; x += step) {
      const d = (x - point.x) ** 2 + (y - point.y) ** 2;
      if (d < distance && standable({ x, y })) { best = { x, y }; distance = d; }
    }
    return best;
  }
  path(actor: NavigationActor, destination: Point, maxExpanded = Infinity): Point[] | null {
    if (!this.canStand(actor, destination)) return null;
    const free = (p: Point) => this.canStand(actor, p);
    const path = findPath(actor.position(), { bounds: this.bounds, canStand: free,
      isGoal: p => Math.hypot(p.x - destination.x, p.y - destination.y) <= PATH_GRID_SIZE && canTraverse(p, destination, free),
      heuristic: p => Math.max(0, Math.hypot(p.x - destination.x, p.y - destination.y) - PATH_GRID_SIZE) }, maxExpanded);
    if (path && (!path.length || Math.hypot(path.at(-1)!.x - destination.x, path.at(-1)!.y - destination.y) > .01)) path.push({ ...destination });
    return path;
  }
  /** 限制地形位移，人物碰撞仍由物理引擎分离。小步查询防止跨过薄墙。 */
  constrainTerrain(from: Point, dx: number, dy: number): Point {
    return this.constrain(from, dx, dy, p => this.terrainFree(p), 3);
  }
  /** 速度足以跨过人物时，先查询整段占位，避免离散碰撞漏掉薄实体。 */
  constrainMotion(actor: NavigationActor, from: Point, dx: number, dy: number): Point {
    const box = actor.shape().collision;
    return this.constrain(from, dx, dy, p => this.canStand(actor, p), box ? Math.min(3, box.width, box.height) : 3);
  }
  private constrain(from: Point, dx: number, dy: number, free: (point: Point) => boolean, step: number): Point {
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / step));
    let x = from.x, y = from.y;
    for (let i = 0; i < steps; i++) {
      if (free({ x: x + dx / steps, y })) x += dx / steps;
      if (free({ x, y: y + dy / steps })) y += dy / steps;
    }
    return { x, y };
  }
}

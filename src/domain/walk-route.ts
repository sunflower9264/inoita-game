import type { Point } from './navigation.ts';
import { NavigationWorld, type NavigationActor } from './navigation-world.ts';
import { canTraverse, createPathSearch, PATH_GRID_SIZE, type PathSearch } from './pathfinding.ts';

/** 重拍时每帧最多展开的寻路节点；一次完整搜索会分到多帧，避免同步卡住渲染。 */
const SEARCH_BUDGET_PER_FRAME = 128;
/** 首次找路多给一档预算：减少“说完台词先愣一下”的起步等待，又不把后续重拍放大。 */
const FIRST_SEARCH_BUDGET = 256;
/** 首次找路与重新找路各自的时限；超过后按失败处理，交给演出/移动层收尾。 */
const SEARCH_DEADLINE_MS = 3000;
/** 被挡后重试的间隔；和旧实现的 250 ms 保持一致。 */
const REPATH_INTERVAL_MS = 250;

/** 走到指定脚点的路线；动态阻挡时限频重算，失败由播放流程处理。 */
export class WalkRoute {
  readonly destination: Point;
  state: 'walking' | 'arrived' | 'failed' = 'walking';
  error?: Error;
  private readonly navigation: NavigationWorld;
  private readonly actor: NavigationActor;
  private readonly speed: number;
  private path: Point[] = [];
  private search?: PathSearch;
  private searchStarted = 0;
  private searchIsRepath = false;
  private elapsed = 0;
  private nextSearch = 0;
  private lastProgress = 0;
  private progressPosition: Point;
  private timeout = 0;

  constructor(navigation: NavigationWorld, actor: NavigationActor, destination: Point, speed: number) {
    this.navigation = navigation; this.actor = actor; this.speed = speed;
    this.destination = { ...destination };
    this.progressPosition = { ...actor.position() };
    this.beginSearch(false);
  }

  /**
   * 把一次寻路拆到多帧执行。同步 `navigation.path()` 在 50×57 的地图上最坏要几十毫秒，
   * 剧情走位、召唤和落点查询会因此丢帧；这里冻结当次占位后逐帧推进 A*。
   */
  private beginSearch(repath: boolean): void {
    this.searchIsRepath = repath;
    this.searchStarted = this.elapsed;
    this.path = [];
    try {
      const snapshot = this.navigation.captureStandability(this.actor);
      this.search = createPathSearch(snapshot.start, {
        bounds: snapshot.bounds,
        canStand: point => snapshot.canStand(point),
        isGoal: point => Math.hypot(point.x - this.destination.x, point.y - this.destination.y) <= PATH_GRID_SIZE
          && canTraverse(point, this.destination, snapshot.canStand),
        heuristic: point => Math.max(0, Math.hypot(point.x - this.destination.x, point.y - this.destination.y) - PATH_GRID_SIZE)
      });
    } catch (error) {
      this.search = undefined;
      this.state = 'failed';
      this.error = error instanceof Error ? error : new Error(String(error));
    }
  }

  /** 推进一步搜索；返回后 `search` 为空表示这次搜索已经有结论。 */
  private advanceSearch(): void {
    if (!this.search) return;
    const result = this.search.step(this.searchIsRepath ? SEARCH_BUDGET_PER_FRAME : FIRST_SEARCH_BUDGET);
    if (result.status === 'pending') return;
    this.search = undefined;
    if (result.status === 'unreachable') {
      this.path = [];
      // 首次就不可达是永久失败；走起来后被挡则继续按 250 ms 重试，和旧行为一致。
      if (!this.searchIsRepath) {
        this.state = 'failed';
        this.error = new Error('道路不可达');
      }
      return;
    }
    const path = result.path.map(point => ({ ...point }));
    if (!path.length || Math.hypot(path.at(-1)!.x - this.destination.x, path.at(-1)!.y - this.destination.y) > .01)
      path.push({ ...this.destination });
    this.path = path;
    let previous = this.actor.position(), distance = 0;
    for (const point of path) { distance += Math.hypot(point.x - previous.x, point.y - previous.y); previous = point; }
    this.timeout = this.elapsed + distance / this.speed * 1000 + 3000;
    // 分帧搜索可能已经花掉几百毫秒；从找到路径这一刻重新计时，避免刚找到就按“久未前进”重拍。
    this.lastProgress = this.elapsed;
  }

  next(deltaMs: number): Point | undefined {
    if (this.state !== 'walking') return;
    this.elapsed += deltaMs;
    const current = this.actor.position();
    if (Math.hypot(current.x - this.destination.x, current.y - this.destination.y) <= .01) { this.state = 'arrived'; return; }
    if (this.search) {
      if (this.elapsed - this.searchStarted > SEARCH_DEADLINE_MS) {
        this.state = 'failed'; this.error = new Error('道路搜索超时'); return;
      }
      this.advanceSearch();
      if (this.state !== 'walking') return;
      if (this.search) return;
    }
    if (this.timeout && this.elapsed > this.timeout) { this.state = 'failed'; this.error = new Error('人物未能到达'); return; }
    while (this.path.length && Math.hypot(current.x - this.path[0].x, current.y - this.path[0].y) <= .01) this.path.shift();
    if (Math.hypot(current.x - this.progressPosition.x, current.y - this.progressPosition.y) >= .5) {
      this.lastProgress = this.elapsed; this.progressPosition = { ...current };
    }
    const traversable = (point: Point) => this.navigation.canStand(this.actor, point);
    const blocked = !this.path.length || !canTraverse(current, this.path[0], traversable);
    if (this.elapsed >= this.nextSearch && (blocked || this.elapsed - this.lastProgress >= REPATH_INTERVAL_MS)) {
      this.nextSearch = this.elapsed + REPATH_INTERVAL_MS;
      this.lastProgress = this.elapsed;
      this.beginSearch(true);
      return;
    }
    return this.path.length && canTraverse(current, this.path[0], traversable) ? this.path[0] : undefined;
  }
}

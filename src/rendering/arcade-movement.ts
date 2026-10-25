import type Phaser from 'phaser';
import type { Point, GameRectangle } from '../domain/navigation.ts';
import { NavigationWorld, type NavigationActor, type NavigationShape } from '../domain/navigation-world.ts';
import { WalkRoute } from '../domain/walk-route.ts';

/** 结算位移在没有新物理步的绘制帧间保留，且包含碰撞分离。 */
export function isBodyWalking(body: Pick<Phaser.Physics.Arcade.Body, 'deltaXFinal' | 'deltaYFinal'>): boolean {
  return Math.hypot(body.deltaXFinal(), body.deltaYFinal()) > .01;
}

/** 注入引擎的 Body 类，浏览器与 Node 物理测试使用同一个适配器。 */
export function movementBodyClass(Base: typeof Phaser.Physics.Arcade.Body) {
  return class MovementBody extends Base {
    private navigation!: NavigationWorld;
    private actor!: NavigationActor;
    private collision: GameRectangle = { x: -4, y: -4, width: 8, height: 8 };
    private intention?: { velocity: Point } | { destination: Point; speed: number } | { route: Pick<WalkRoute, 'next'>; speed: number };
    private stepStart?: Point;
    private suspended=false;
    private resumeImmovable=false;
    /** 注册意图：由移动层驱动的角色（true）还是内容摆放的实体（false）。 */
    private movable=true;
    noclip=false;
    /** 是否允许在脚点非法时按整盒落点自愈；主角、佣兵与友方召唤物开启。 */
    private terrainRecovery=true;
    get recoversTerrain():boolean{return this.terrainRecovery;}
    /** 被物理分离挤进阻挡格后拉回来的次数与最近一次的前后位置；卡墙排查用。 */
    private wallRecoveries=0;
    private lastWallRecovery?: { from: Point; to: Point };
    /** 找不到合法落点时别每帧全图扫描：隔 500ms 再试。 */
    private wallRetryAt=0;
    /** 队伍单位带着非法脚点起跑的次数：第一次非法写入的旁证。 */
    private illegalStarts=0;
    setPaused(paused:boolean):void {
      if(this.suspended===paused)return;
      this.suspended=paused;
      if(paused){this.resumeImmovable=this.immovable;this.setImmovable(true);this.stop();}
      else this.setImmovable(this.resumeImmovable);
    }
    initialize(navigation: NavigationWorld, actor: NavigationActor, movable=true, terrainRecovery=movable): void {
      this.navigation = navigation; this.actor = actor;
      this.movable=movable; this.terrainRecovery=terrainRecovery;
      this.setAllowGravity(false); this.pushable = false;
    }
    /** 重新注册时同步意图；`immovable` 会被剧情走位临时改写，不能当作这个用途。 */
    setMovable(movable:boolean, terrainRecovery=movable):void{this.movable=movable;this.terrainRecovery=terrainRecovery;}
    shape(shape: NavigationShape): void {
      const position = this.footPosition();
      this.collision = shape.collision ?? { x: -4, y: -4, width: 8, height: 8 };
      const box = this.collision;
      this.setSize(box.width, box.height, false).setOffset(box.x, box.y);
      this.reset(position.x, position.y); this.updateFromGameObject();
    }
    footPosition(): Point { return { x: this.x - this.collision.x, y: this.y - this.collision.y }; }
    drive(axis: Point, speed: number): void {
      const length = Math.hypot(axis.x, axis.y);
      this.intention = { velocity: { x: axis.x / (length || 1) * speed, y: axis.y / (length || 1) * speed } };
    }
    toward(destination: Point, speed: number): void { this.intention = { destination: { ...destination }, speed }; }
    walk(route: Pick<WalkRoute, 'next'>, speed: number): void { this.intention = { route, speed }; }
    halt(): void { this.intention = undefined; this.stop(); }
    override update(delta: number): void {
      if(this.suspended){this.stop();return;}
      if (!this.navigation || !this.actor.enabled()) { this.stop(); super.update(delta); return; }
      // 内容摆放的机关、门和宝箱不会自己移动；没有移动意图时不必每步做地形约束。
      if(!this.movable&&!this.intention){this.resetFlags();this.setVelocity(0,0);super.update(delta);return;}
      const start = this.footPosition(); this.stepStart = start;
      if (this.terrainRecovery && !this.navigation.terrainFree(start)) this.illegalStarts += 1;
      let dx = 0, dy = 0;
      if (this.intention && 'velocity' in this.intention) {
        dx = this.intention.velocity.x * delta; dy = this.intention.velocity.y * delta;
      } else if (this.intention) {
        const target = 'route' in this.intention ? this.intention.route.next(delta * 1000) : this.intention.destination;
        if (target) {
          const distance = Math.hypot(target.x - start.x, target.y - start.y);
          const fraction = distance ? Math.min(1, this.intention.speed * delta / distance) : 0;
          dx = (target.x - start.x) * fraction; dy = (target.y - start.y) * fraction;
        }
      }
      if (this.noclip) {
        this.resetFlags();
        this.setVelocity(dx / delta, dy / delta);
        super.update(delta);
        return;
      }
      const allowed = Math.max(Math.abs(dx), Math.abs(dy)) > Math.min(this.collision.width, this.collision.height) / 2
        ? this.navigation.constrainMotion(this.actor, start, dx, dy) : this.navigation.constrainTerrain(start, dx, dy);
      this.resetFlags();
      this.setVelocity((allowed.x - start.x) / delta, (allowed.y - start.y) / delta);
      super.update(delta);
      if (Math.abs(allowed.x - start.x - dx) > 1e-7) { this.blocked.none = false; this.blocked[dx < 0 ? 'left' : 'right'] = true; }
      if (Math.abs(allowed.y - start.y - dy) > 1e-7) { this.blocked.none = false; this.blocked[dy < 0 ? 'up' : 'down'] = true; }
    }
    /** 分离人物后校验地形，防止碰撞修正把脚点挤入阻挡格。 */
    settleStep(): void {
      // 固定内容体不会被碰撞分离推动；没有移动意图时无需每步重复校验地形。
      if ((!this.movable && !this.intention) || this.noclip || !this.stepStart) return;
      if (this.navigation.terrainFree(this.footPosition())) return;
      const pushed = this.footPosition();
      const displaced = pushed.x !== this.stepStart.x || pushed.y !== this.stepStart.y;
      // 物理分离把脚点推进了阻挡格：先退回这一物理步的起点。
      // 对本来就站在阻挡格上的内容实体，起点与当前坐标相同，等于原地写回，不改内容坐标。
      this.position.set(this.stepStart.x + this.collision.x, this.stepStart.y + this.collision.y);
      this.updateCenter(); this.stop();
      if (displaced) {
        this.wallRecoveries += 1;
        this.lastWallRecovery = { from: { ...pushed }, to: { ...this.stepStart } };
      }
      if (this.navigation.terrainFree(this.footPosition())) return;
      // 起点本身也不合法。主角、佣兵与友方召唤物允许搬迁，且只接受整盒落点——窄足底兜底会重新
      // 制造「脚点合法、身体压墙」的状态。内容实体与敌人保持原位。
      if (!this.terrainRecovery) return;
      if (Date.now() < this.wallRetryAt) return;
      const landing = this.nearestLanding();
      if (landing) {
        this.reset(landing.x, landing.y); this.updateFromGameObject();
        this.lastWallRecovery = { from: pushed, to: { ...landing } };
        this.wallRetryAt = 0;
      } else this.wallRetryAt = Date.now() + 500;
    }
    private nearestLanding(): Point | undefined {
      if (!this.stepStart) return undefined;
      return this.navigation.nearestBody(this.actor.shape(), this.stepStart, this.actor);
    }
    /** 诊断：卡住时先看这里——是暂停、被固定、还是仍在推进某个意图。 */
    describe(): { enabled: boolean; suspended: boolean; immovable: boolean; movable: boolean; terrainRecovery: boolean;
      velocity: Point; collision: GameRectangle; foot: Point; intention: 'velocity' | 'route' | 'destination' | null;
      wallRecoveries: number; illegalStarts: number; lastWallRecovery?: { from: Point; to: Point } } {
      const intention = this.intention ? ('velocity' in this.intention ? 'velocity' : 'route' in this.intention ? 'route' : 'destination') : null;
      return { enabled: this.enable, suspended: this.suspended, immovable: this.immovable,
        movable: this.movable, terrainRecovery: this.terrainRecovery,
        velocity: { x: this.velocity.x, y: this.velocity.y }, collision: { ...this.collision },
        foot: this.footPosition(), intention, wallRecoveries: this.wallRecoveries, illegalStarts: this.illegalStarts,
        ...(this.lastWallRecovery ? { lastWallRecovery: this.lastWallRecovery } : {}) };
    }
  };
}

export type MovementBody = InstanceType<ReturnType<typeof movementBodyClass>>;

import Phaser from 'phaser';
import { NavigationWorld, blocksActor, mirroredCollision, type NavigationFaction, type Placement } from '../domain/navigation-world.ts';
import type { Point } from '../domain/navigation.ts';
import type { CharacterVisual } from './characters.ts';
import { movementBodyClass, type MovementBody } from './arcade-movement.ts';
import { WalkRoute } from '../domain/walk-route.ts';
import { MovementInterpolation } from './movement-interpolation.ts';

const Body = movementBodyClass(Phaser.Physics.Arcade.Body);
interface Registration { body: MovementBody; actor: Placement['actor']; ghost:{value:boolean}; unregister(): void; destroy(): void }

/** 每个场景持有一个移动世界，所有人物共享同一个持久碰撞关系。 */
export class MovementWorld {
  readonly navigation: NavigationWorld;
  private readonly scene: Phaser.Scene;
  private readonly group: Phaser.GameObjects.Group;
  private readonly collider: Phaser.Physics.Arcade.Collider;
  private readonly registrations = new Map<CharacterVisual, Registration>();
  private readonly bodyRegistrations = new WeakMap<object,Registration>();
  private readonly interpolation = new MovementInterpolation();
  /** 最近被整盒校验改正的队伍单位落位；诊断用，正常流程应为空。 */
  private readonly corrections: { id: string; from: Point; to: Point }[] = [];
  get terrainCorrections(): readonly { id: string; from: Point; to: Point }[] { return this.corrections; }
  setNoclip(visual: CharacterVisual, enabled: boolean): void {
    const reg = this.registrations.get(visual);
    if (reg) {
      reg.body.noclip = enabled;
      reg.ghost.value = enabled;
    }
  }
  constructor(scene: Phaser.Scene, navigation: NavigationWorld) {
    this.scene = scene; this.navigation = navigation;
    this.group = scene.add.group();
    this.collider = scene.physics.add.collider(this.group, this.group, undefined, (a, b) => {
      const first = 'body' in a ? a.body : a, second = 'body' in b ? b.body : b;
      const firstActor=first?this.bodyRegistrations.get(first)?.actor:undefined;
      const secondActor=second?this.bodyRegistrations.get(second)?.actor:undefined;
      if(!firstActor||!secondActor)return false;
      // 演出角色按脚本走位，不参与单位碰撞；地形仍由移动层约束。
      if(firstActor.ghost?.()||secondActor.ghost?.())return false;
      // 同队单位之间不碰撞：伙伴和友方召唤物不会把玩家堵住。
      return firstActor.enabled()&&!!firstActor.shape().collision&&secondActor.enabled()&&!!secondActor.shape().collision
        &&blocksActor(firstActor,secondActor);
    });
    scene.physics.world.on('worldstep', this.settleStep, this);
    scene.events.on(Phaser.Scenes.Events.PRE_UPDATE, this.beginFrame, this);
    scene.events.on(Phaser.Scenes.Events.POST_UPDATE, this.syncDepth, this);
    scene.events.on(Phaser.Scenes.Events.PRE_RENDER, this.renderPositions, this);
    scene.events.on(Phaser.Scenes.Events.RENDER, this.restorePositions, this);
  }
  register(visual: CharacterVisual, movable = true, terrainRecovery = movable, faction?: NavigationFaction): MovementBody {
    const current = this.registrations.get(visual);
    if (current) {
      current.actor.faction = faction ? () => faction : undefined;
      current.body.setMovable(movable, terrainRecovery); current.body.setImmovable(!movable); return current.body;
    }
    const body = new Body(this.scene.physics.world, visual.container);
    visual.container.body = body;
    const ghost={value:false};
    const actor = {
      shape: () => ({ collision: mirroredCollision(visual.actor.collision, visual.entity.flip) }),
      position: () => body.footPosition(),
      enabled: () => body.enable && visual.container.active && visual.container.visible,
      faction: faction ? () => faction : undefined,
      ghost: () => ghost.value,
      // 主角、佣兵与友方召唤物在落位时要求整盒合法；内容实体保持可信的内容坐标。
      strictTerrain: () => body.recoversTerrain
    };
    body.initialize(this.navigation, actor, movable, terrainRecovery);
    // 构造时容器坐标已经是脚点，先同步再设置实体偏移。
    body.setSize(8, 8, false).setOffset(-4, -4); body.updateFromGameObject();
    body.shape(actor.shape()); body.setImmovable(!movable);
    const unregister = this.navigation.register(actor);
    const destroy = () => this.remove(visual);
    const registration={body,actor,ghost,unregister,destroy};
    this.registrations.set(visual,registration);this.bodyRegistrations.set(body,registration);
    this.interpolation.register(visual.container, actor.position, actor.enabled);
    this.scene.physics.world.add(body); this.group.add(visual.container);
    visual.container.once('destroy', destroy);
    return body;
  }
  actor(visual: CharacterVisual): Placement['actor'] { const r = this.registrations.get(visual); if (!r) throw new Error('人物未接入移动世界'); return r.actor; }
  private visualOf(actor: Placement['actor']): CharacterVisual {
    for (const [visual, registration] of this.registrations) if (registration.actor === actor) return visual;
    throw new Error('让位角色未接入移动世界');
  }
  body(visual: CharacterVisual): MovementBody { return this.registrations.get(visual)!.body; }
  refreshShape(visual: CharacterVisual): void {
    this.restorePositions();
    this.body(visual).shape(this.actor(visual).shape()); this.interpolation.reset(visual.container);
  }
  setEnabled(visual: CharacterVisual, enabled: boolean): void {
    const body = this.body(visual), changed = body.enable !== enabled;
    if (!enabled) body.halt(); body.enable = enabled;
    if (changed) this.interpolation.reset(visual.container);
  }
  /** 演出走位：开启后不与其他人或机关发生物理碰撞，寻路也只按地形。 */
  setGhost(visual: CharacterVisual, ghost: boolean): void {
    const registration = this.registrations.get(visual);
    if (registration) registration.ghost.value = ghost;
  }
  setPaused(visual:CharacterVisual,paused:boolean):void {this.body(visual).setPaused(paused);}
  stop(visual: CharacterVisual): void { this.registrations.get(visual)?.body.halt(); }
  position(visual: CharacterVisual): Point { return this.body(visual).footPosition(); }
  displayPosition(visual: CharacterVisual): Point { return this.interpolation.position(visual.container); }
  drive(visual: CharacterVisual, axis: Point, speed: number): void { this.body(visual).drive(axis, speed); }
  toward(visual: CharacterVisual, point: Point, speed: number): void { this.body(visual).toward(point, speed); }
  followPath(visual: CharacterVisual, nextWaypoint: () => Point | undefined, speed: number): void {
    this.body(visual).walk({ next: nextWaypoint }, speed);
  }
  walkTo(visual: CharacterVisual, point: Point, speed: number): WalkRoute {
    const route = new WalkRoute(this.navigation, this.actor(visual), point, speed);
    this.body(visual).walk(route, speed); return route;
  }
  canStand(visual: CharacterVisual, point: Point): boolean { return this.navigation.canStand(this.actor(visual), point); }
  /** 移动体诊断：暂停、固定、速度、脚点与当前意图（走路/被驱赶/追目标）。 */
  state(visual: CharacterVisual): ReturnType<MovementBody['describe']> | undefined {
    return this.registrations.get(visual)?.body.describe();
  }
  /**
   * `evictOccupied` 用于权威位置（剧情登记到正式地图的人物）：位置来自内容，被它压住的现有
   * 角色就近让开，而不是让整组落位失败；`displaceable` 额外声明目标角色里权威性较低的
   * （如主角），它们被压住时同样让位。默认严格模式仍用于演出走位，重叠即报错。
   */
  /** 场景机关按内容坐标摆放；门可以占据阻挡格，不参与人物落脚点修正。 */
  placeContent(visual: CharacterVisual, position: Point, enabled: boolean): void {
    this.restorePositions();
    this.stop(visual);
    this.body(visual).reset(position.x, position.y);
    this.body(visual).updateFromGameObject();
    visual.container.setVisible(enabled);
    this.setEnabled(visual, enabled);
    this.interpolation.reset(visual.container);
    visual.container.setDepth(position.y + .5);
  }
  placeAll(placements: { visual: CharacterVisual; position: Point; enabled?: boolean }[], options: { evictOccupied?: boolean; displaceable?: readonly CharacterVisual[] } = {}): void {
    this.restorePositions();
    let settled = placements;
    if (options.evictOccupied || options.displaceable?.length) {
      const queries = placements.map(p => ({ actor: this.actor(p.visual), position: p.position, enabled: p.enabled }));
      const displaceable = new Set((options.displaceable ?? []).map(visual => this.actor(visual)));
      const merged = new Map(settled.map(p => [p.visual, p]));
      for (const e of this.navigation.evictionsFor(queries, displaceable)) merged.set(this.visualOf(e.actor), { visual: this.visualOf(e.actor), position: e.position, enabled: e.enabled });
      settled = [...merged.values()];
    }
    let queries = settled.map(p => ({ actor: this.actor(p.visual), position: p.position, enabled: p.enabled }));
    // 队伍单位的目标位置必须整盒成立；内容给出的非法坐标在这里就近改正，而不是等角色
    // 显形后永久卡在墙里。内容实体（非 strict）完全不受影响。
    const corrected = settled.map((p, index) => {
      const actor = queries[index]!.actor, strict = actor.strictTerrain?.() === true;
      const current = actor.position();
      // 内容实体保持原位时允许站在阻挡格；只有真的移动过的内容实体才需要重新落位。
      if (!strict && current.x === p.position.x && current.y === p.position.y) return p;
      const valid = strict
        ? this.navigation.terrainFree(p.position) && this.navigation.canPlaceBody(actor.shape(), p.position, actor, queries)
        : this.navigation.canPlace(actor.shape(), p.position, actor, queries);
      if (valid) return p;
      // 队伍单位要同时满足整盒与脚点；内容实体按窄足底就近找可站点，避免整段演出因一个走位落点中断。
      const landing = strict
        ? this.navigation.nearestSettledBody(actor.shape(), p.position, actor, queries)
        : this.navigation.nearest(actor.shape(), p.position, actor, queries);
      if (!landing) {
        globalThis.storyDiagnostics?.record('placement-blocked', {
          map: this.navigation.name, actor: p.visual.entity.id, from: { ...p.position }, reason: strict ? 'no-settled-body' : 'no-standable'
        });
        return p;
      }
      this.corrections.push({ id: p.visual.entity.id, from: { ...p.position }, to: { ...landing } });
      if (this.corrections.length > 8) this.corrections.shift();
      return { ...p, position: landing };
    });
    if (corrected.some((p, index) => p !== settled[index])) {
      settled = corrected; queries = settled.map(p => ({ actor: this.actor(p.visual), position: p.position, enabled: p.enabled }));
    }
    // 落位是表现层的软约束：内容或走位给出的点可能仍互相压住。先多轮修正，
    // 仍不成立时保留当前位置并记录现场，绝不因为一个角色挡路中断剧情或战斗。
    for (let attempt = 0; attempt < 4 && !this.navigation.canSettleAll(queries); attempt++) {
      let changed = false;
      for (let index = 0; index < settled.length; index++) {
        if (this.navigation.canSettleAll([queries[index]!])) continue;
        const placement = settled[index]!, actor = queries[index]!.actor;
        const strict = actor.strictTerrain?.() === true;
        let landing: Point | undefined;
        try {
          landing = strict
            ? this.navigation.nearestSettledBody(actor.shape(), placement.position, actor, queries)
            : this.navigation.nearest(actor.shape(), placement.position, actor, queries);
        } catch { landing = undefined; }
        if (!landing || (landing.x === placement.position.x && landing.y === placement.position.y)) continue;
        settled[index] = { ...placement, position: landing };
        queries[index] = { actor, position: landing, enabled: placement.enabled };
        this.corrections.push({ id: placement.visual.entity.id, from: { ...placement.position }, to: { ...landing } });
        if (this.corrections.length > 8) this.corrections.shift();
        changed = true;
      }
      if (!changed) break;
    }
    if (!this.navigation.canSettleAll(queries)) {
      const blocked = settled.filter((_entry, index) => !this.navigation.canSettleAll([queries[index]!]))
        .map(p => ({ actor: p.visual.entity.id, position: { ...p.position }, enabled: p.enabled }));
      globalThis.storyDiagnostics?.record('placement-blocked', {
        map: this.navigation.name, reason: 'settle-check', blocked
      });
    }
    for (const p of settled) {
      this.stop(p.visual); this.body(p.visual).reset(p.position.x, p.position.y); this.body(p.visual).updateFromGameObject();
      if (p.enabled !== undefined) { p.visual.container.setVisible(p.enabled); this.setEnabled(p.visual, p.enabled); }
      this.interpolation.reset(p.visual.container);
      p.visual.container.setDepth(p.position.y + .5);
    }
  }
  place(visual: CharacterVisual, position: Point): void { this.placeAll([{ visual, position, enabled: visual.container.visible }]); }
  remove(visual: CharacterVisual): void {
    const r = this.registrations.get(visual); if (!r) return;
    this.interpolation.remove(visual.container);
    this.registrations.delete(visual);this.bodyRegistrations.delete(r.body); r.unregister(); visual.container.off('destroy', r.destroy);
    if (this.group.scene) this.group.remove(visual.container);
    r.body.halt(); r.body.destroy(); visual.container.body = null;
  }
  private beginFrame(_time: number, delta: number): void {
    const world = this.scene.physics.world;
    if (!world.isPaused && world.bodies.size) this.interpolation.beginFrame(delta);
  }
  private settleStep(delta: number): void {
    for (const r of this.registrations.values()) if (r.actor.enabled()) r.body.settleStep();
    this.interpolation.completeStep(delta * 1000 * this.scene.physics.world.timeScale);
  }
  /** 物理暂停时没有新步进，插值坐标不会变化；只保留 restore，避免把容器留在临时坐标。 */
  private renderPositions(): void { if (!this.scene.physics.world.isPaused) this.interpolation.apply(); }
  private restorePositions(): void { this.interpolation.restore(); }
  private syncDepth(): void {
    if (this.scene.physics.world.isPaused) return;
    for (const visual of this.registrations.keys()) {
      if (!visual.container.active) continue;
      const depth = visual.container.y + .5;
      // Phaser 的 setDepth 每次都会把 display list 标脏并重排；值没变就别写。
      if (visual.container.depth !== depth) visual.container.setDepth(depth);
    }
  }
  destroy(): void {
    this.interpolation.destroy();
    this.scene.physics.world?.off('worldstep', this.settleStep, this);
    this.scene.events.off(Phaser.Scenes.Events.PRE_UPDATE, this.beginFrame, this);
    this.scene.events.off(Phaser.Scenes.Events.POST_UPDATE, this.syncDepth, this);
    this.scene.events.off(Phaser.Scenes.Events.PRE_RENDER, this.renderPositions, this);
    this.scene.events.off(Phaser.Scenes.Events.RENDER, this.restorePositions, this);
    this.collider.destroy();
    for (const visual of [...this.registrations.keys()]) this.remove(visual);
    this.group.destroy();
  }
}

import { applyStorySceneAction, hideUnboundStageActors, resolveStoryScene, syncStoryScene } from '../domain/story-scene.ts';
import { prepareSceneVisit } from '../domain/scene-visit.ts';
import { assertScenePlan, planScene } from '../domain/scene-plan.ts';
import { diffSceneActors } from '../domain/scene-delta.ts';
import { parseDrops } from '../domain/drops.ts';
import type { SceneSnapshot } from '../domain/scene-snapshot.ts';
import { SCENE_KEYS } from '../application/scene-keys.ts';
import Phaser from 'phaser';
import type { StoryContext } from '../application/ports.ts';
import type { ActorDefinition, Facing, TravelDestination } from '../domain/content.ts';
import type { PerformanceAction, PerformancePlayback, StoryCurtain, StoryPresentationPort, StoryStage, StoryStageSnapshot } from '../domain/story-performance.ts';
import { cameraDuration, mapEffectTone } from '../domain/story-performance.ts';
import { faceTarget } from '../domain/basic-attack.ts';
import { characterAnimationState, setCharacterClip } from './characters.ts';
import type { CharacterVisual } from './characters.ts';
import { createEffect } from './effects.ts';
import type { WorldScene } from '../scenes/world-scene.ts';
import type { StoryStageScene } from '../scenes/story-stage-scene.ts';
import type { StoryEntityState } from '../domain/story-world.ts';

interface Performer { visual: CharacterVisual; facing: Facing; worldEntityId?: string; unpositioned?:boolean }
type VisualAction = Exclude<PerformanceAction, { type: 'parallel' }>;

/** 独立舞台只产生语义结果，由运行时提交到正式世界。 */
export class StoryPresenter implements StoryPresentationPort {
  private readonly world: () => WorldScene;
  private readonly scene: () => StoryStageScene;
  private readonly app: StoryContext;
  private actors = new Map<string, Performer>();
  private appearance?: ActorDefinition;
  private baseline?: StoryStageSnapshot;
  private finalStage?: StoryStageSnapshot;
  private state?: StoryStageSnapshot;
  private scenes = new Map<string, SceneSnapshot>();
  private committedScenes = new Map<string, SceneSnapshot>();
  private epoch = 0;
  private closing?: Promise<void>;
  private curtain?: Phaser.GameObjects.Rectangle;
  private opacity = 0;
  private color = 0;
  private effects = new Set<Phaser.GameObjects.Container>();
  private groundEffects?: Phaser.GameObjects.Layer;
  private topEffects?: Phaser.GameObjects.Layer;
  private toneFilter?: Phaser.Filters.ColorMatrix;
  constructor(app: StoryContext, world: () => WorldScene, stage?: () => StoryStageScene) {
    this.app = app; this.world = world;
    this.scene = stage ?? (() => world().scene.get(SCENE_KEYS.storyStage) as StoryStageScene);
  }
  prefetchMap(map: string): void { this.world().prefetchMap(map); }
  async begin(signal?: AbortSignal, restored?: StoryStage | StoryStageSnapshot, initialCurtain?: StoryCurtain, deferFirstStage = false): Promise<void> {
    if (!signal) throw new Error('剧情舞台需要导演的取消信号');
    signal.throwIfAborted();
    const world = this.world(), player = world.player;
    if (!player || !world.map) throw new Error('正式地图尚未准备好');
    this.appearance = player.actor;
    const source = world.captureStoryScene();
    const current = this.captureStage() ?? resolveStoryScene({
      type: 'stage', map: source.map, x: player.container.x, y: player.container.y,
      facing: world.facing, playerVisible: source.actors.find(actor => actor.id === 'player')!.visible, retainPlayerPosition: true, cast: []
    }, source);
    const stage = restored ?? current;
    this.baseline = structuredClone(current); this.finalStage = undefined;
    this.rememberScene(current.scene);
    const curtain = initialCurtain ?? (stage.map !== world.map.id ? { opacity: 1, color: 0 } : undefined);
    if (curtain) { this.opacity = curtain.opacity; this.color = curtain.color; }
    await this.ready(signal, curtain);
    if (deferFirstStage) return;
    await this.stage(stage, signal);
    const camera = this.scene().cameras.main;
    if (!restored && !stage.camera && stage.map === world.map.id) camera.setScroll(world.cameras.main.scrollX, world.cameras.main.scrollY);
    this.baseline = this.captureStage();
  }
  private async ready(signal: AbortSignal, initialCurtain?: StoryCurtain): Promise<void> {
    if (this.closing) await this.closing;
    signal.throwIfAborted();
    const stage = this.scene();
    if (stage.sys.isActive()) { if (initialCurtain) stage.showInitialCurtain?.(initialCurtain); return; }
    return new Promise((resolve, reject) => {
      const clean = () => { signal.removeEventListener('abort', abort); };
      const abort = () => { clean(); reject(signal.reason); };
      const created = () => { clean(); if (signal.aborted) reject(signal.reason); else resolve(); };
      signal.addEventListener('abort', abort, { once: true });
      this.world().scene.launch(SCENE_KEYS.storyStage, { signal, onReady: created, initialCurtain });
      this.world().scene.moveAbove('world', 'story-stage');
    });
  }
  captureStage(): StoryStageSnapshot | undefined {
    const scene = this.scene();
    if (!scene.map || !this.state || !this.actors.has('player')) return this.finalStage ? structuredClone(this.finalStage) : undefined;
    const snapshot = structuredClone(this.state);
    for (const actor of snapshot.scene.actors) {
      const performer = this.actors.get(actor.id);
      if (!performer) continue;
      const visual = performer.visual;
      const position = scene.movement?.position?.(visual) ?? visual.container;
      Object.assign(actor, { x: position.x, y: position.y, facing: performer.facing,
        visible: visual.container.visible, unpositioned: performer.unpositioned,
        clip: visual.clipName ?? undefined, alpha: visual.container.alpha, appearance: structuredClone(visual.actor) });
      const animation = visual.layers[0]?.anims;
      if (animation?.currentAnim) {
        const state = characterAnimationState(visual);
        // 单帧动画的 Phaser 进度是 NaN，快照只保存有限值。
        actor.animationProgress = state.progress;
        actor.animationPlaying = state.playing;
      }
    }
    const camera = scene.cameras.main;
    // Phaser 的镜头中点就是 `scrollX + width / 2`，与 zoom 无关（BaseCamera.centerOnX 与
    // Camera.preRender 都不除 zoom）；多除一次会在 zoom != 1 时把恢复的镜头甩到地图边缘。
    const center = { x: camera.scrollX + camera.width / 2, y: camera.scrollY + camera.height / 2 };
    if (Number.isFinite(center.x) && Number.isFinite(center.y)) snapshot.camera = center;
    snapshot.curtain = { opacity: this.opacity, color: this.color };
    if (this.app.audio) snapshot.audio = this.app.audio.captureStoryAudio();
    snapshot.scenes = [...this.scenes.values()].filter(visited => visited.map !== snapshot.map).map(visited => structuredClone(visited));
    return syncStoryScene(snapshot);
  }
  getStageState(): StoryStageSnapshot | undefined { return this.captureStage(); }
  getWorldChanges(): readonly StoryEntityState[] {
    const current = this.captureStage();
    if (current) this.scenes.set(current.map, current.scene);
    const changes: StoryEntityState[] = [];
    for (const [map, scene] of this.scenes) {
      const before = this.committedScenes.get(map);
      for (const change of diffSceneActors(before, scene).changes) {
        if (change.kind === 'remove' || !change.after) continue;
        const actor = change.after;
        // 舞台为了不画重复演员而临时隐藏的副本不属于正式世界改动。
        if (!actor.worldEntityId || actor.unpositioned || actor.stageHidden) continue;
        if (change.before && change.before.worldEntityId === actor.worldEntityId
          && change.before.actor === actor.actor && change.before.x === actor.x && change.before.y === actor.y
          && change.before.facing === actor.facing && change.before.visible === actor.visible) continue;
        changes.push({ id: actor.worldEntityId, map, actor: actor.actor,
          ...(actor.characterId ? { characterId: actor.characterId } : {}),
          ...(actor.authority ? { authority: actor.authority } : {}),
          x: actor.x, y: actor.y, facing: actor.facing, visible: actor.visible });
      }
    }
    return changes;
  }
  committed(): void {
    const current = this.captureStage();
    if (current) this.scenes.set(current.map, current.scene);
    this.committedScenes = new Map([...this.scenes].map(([map, scene]) => [map, structuredClone(scene)]));
  }
  private rememberScene(scene: SceneSnapshot): void {
    this.scenes.set(scene.map, structuredClone(scene));
    if (!this.committedScenes.has(scene.map)) this.committedScenes.set(scene.map, structuredClone(scene));
  }
  async restoreStage(stage: StoryStageSnapshot, signal: AbortSignal): Promise<void> {
    await this.ready(signal);
    await this.stage(stage, signal);
    this.scenes = new Map((stage.scenes ?? []).map(scene => [scene.map, structuredClone(scene)]));
    this.scenes.set(stage.map, structuredClone(stage.scene));
  }
  private actor(id: string): Performer {
    const canonical = this.state?.bindings.find(([alias]) => alias === id)?.[1] ?? id;
    const actor = this.actors.get(canonical);
    if (!actor) throw new Error('剧情人物未出场：' + id);
    return actor;
  }
  /**
   * 「这一刻在这张图上」的演员；位置未知（`unpositioned`，停在哨兵坐标）时返回 undefined。
   *
   * 原版对找不到的角色，任何指向它的命令都什么都不做（findings 105），`walk` 早就是这么做的。
   * 镜头和特效若照做，会摇到场外坐标、打在空处；姿态则是对一个看不见的人做动作。判据与
   * `walk` 的跳过同一条：世界投影里接得到位置的演员早就不是 `unpositioned`（findings 189），
   * 所以这条只挡「真的还没到场」的人。
   */
  private present(id: string): Performer | undefined {
    const canonical = this.state?.bindings.find(([alias]) => alias === id)?.[1] ?? id;
    const actor = this.actors.get(canonical);
    return actor?.unpositioned ? undefined : actor;
  }
  private resetActors(preserveCurtain = false): void {
    this.actors.clear();
    for (const effect of this.effects) if (effect.scene) effect.destroy();
    this.effects.clear();
    if (!preserveCurtain) { this.curtain?.destroy(); this.curtain = undefined; }
  }
  /** 地点特效的两个固定层：地面层在底图之上，顶层在角色之上、树冠之下。 */
  private effectLayer(ground: boolean): Phaser.GameObjects.Layer {
    const existing = ground ? this.groundEffects : this.topEffects;
    if (existing?.scene) return existing;
    const layer = this.scene().add.layer().setDepth(ground ? -9999 : 9999);
    if (ground) this.groundEffects = layer; else this.topEffects = layer;
    return layer;
  }
  /**
   * 地图效果开关：原版 `0x32`／`0x33` 写 `MAP_nBaseEffect`，它决定世界层每帧要不要走
   * `GRP_AddColorTone(2,0)`。复刻用舞台相机上的颜色矩阵滤镜表达同一件事；原版这个开关不随
   * 切图复位，所以重建舞台时不清理它，只在剧情结束时随舞台相机一起消失。
   */
  private applyMapEffect(enabled: boolean): void {
    const filters = this.scene().cameras.main.filters;
    if (!this.toneFilter) {
      if (!enabled || !filters) return;
      this.toneFilter = filters.internal.addColorMatrix();
      this.toneFilter.colorMatrix.set(mapEffectTone);
    }
    this.toneFilter.setActive(enabled);
  }
  private async stage(declaration: StoryStage | StoryStageSnapshot, signal: AbortSignal): Promise<void> {
    const epoch = ++this.epoch;
    const current = this.captureStage() ?? this.baseline;
    if (current) this.scenes.set(current.map, structuredClone(current.scene));
    const map = declaration.mapFromWorld ? current?.map ?? this.world().map!.id : declaration.map;
    if (map !== this.world().map?.id) this.prefetchMap(map);
    let snapshot: StoryStageSnapshot;
    if ('scene' in declaration) {
      snapshot = structuredClone(declaration);
      for (const visited of snapshot.scenes ?? []) this.rememberScene(visited);
      this.rememberScene(snapshot.scene);
    }
    else {
      let source = !declaration.resetActors ? this.scenes.get(map) : undefined;
      if (declaration.retainPlayerPosition && map === this.world().map?.id && this.scene().map?.id !== map && !declaration.resetActors)
        source = this.world().captureStoryScene();
      if (!source && map === this.world().map?.id && !declaration.resetActors) source = this.world().captureStoryScene();
      if (!source) {
        const reference = this.app.world.maps.find(reference => reference.id === map);
        if (!reference) throw new Error('这片区域的资源尚未准备好');
        const [worldMap, drops, springs] = await Promise.all([
          this.app.content.map(reference.file, signal), this.app.content.drops(), this.app.content.springs()
        ]);
        signal.throwIfAborted();
        const player = current?.scene.actors.find(actor => actor.id === 'player')
          ?? this.world().captureStoryScene().actors.find(actor => actor.id === 'player');
        if (!player) throw new Error('剧情玩家尚未准备好');
        source = prepareSceneVisit({ session: this.app.session, campaign: this.app.campaign, world: this.app.world,
          battleCatalog: this.app.battleCatalog, drops: parseDrops(drops, this.app.items, this.app.battleCatalog.enemies.map(enemy => enemy.id)), springs, partyActors: current?.scene.actors },
          worldMap, { ...player, x: declaration.x, y: declaration.y, facing: declaration.facing });
      }
      this.rememberScene(source);
      snapshot = resolveStoryScene({ ...declaration, map }, source);
    }
    const party = this.app.session?.party;
    const storyMembers = new Set(party ? party.activeIds.filter(id => party.get(id)?.source === 'story') : []);
    snapshot = hideUnboundStageActors(snapshot, storyMembers);
    assertScenePlan(planScene(snapshot.scene, snapshot.bindings));
    if (!this.appearance) throw new Error('剧情玩家外观尚未准备好');
    await this.scene().showStage(snapshot, signal, this.appearance);
    signal.throwIfAborted();
    if (epoch !== this.epoch) throw new DOMException('演出实例已更新', 'AbortError');
    this.scene().clearEarlyCurtain();
    this.resetActors(true);
    this.state = snapshot;
    const scene = this.scene();
    scene.cameras.main.stopFollow();
    for (const actor of snapshot.scene.actors) {
      const visual = scene.characters.get(actor.id);
      if (!visual) throw new Error('剧情场景对象未绘制：' + actor.id);
      this.actors.set(actor.id, { visual, facing: actor.facing,
        worldEntityId: actor.worldEntityId, unpositioned: actor.unpositioned });
    }
    if (snapshot.camera) scene.cameras.main.centerOn(snapshot.camera.x, snapshot.camera.y);
    if (snapshot.curtain) { this.opacity = snapshot.curtain.opacity; this.color = snapshot.curtain.color; }
    if (snapshot.audio) this.app.audio?.restoreStoryAudio(snapshot.audio);
    this.drawCurtain();
  }
  async travel(destination: TravelDestination, signal: AbortSignal): Promise<void> {
    await this.stage({ type: 'stage', ...destination, playerVisible: true, cast: [] }, signal);
  }
  private face(actor: Performer, facing: Facing): void {
    actor.facing = facing;
    setCharacterClip(this.scene(), actor.visual, `idle-${facing}`);
    if (actor.visual === this.scene().player) this.scene().facing = facing;
  }
  private drawCurtain(): void {
    const scene = this.scene();
    if (!this.curtain?.scene) this.curtain = scene.add.rectangle(0, 0, 1, 1, this.color).setOrigin(0).setScrollFactor(0).setDepth(20000);
    // 画面遮罩也会受镜头倍率影响，向四边留足覆盖范围。
    this.curtain.setPosition(-scene.scale.width, -scene.scale.height).setSize(scene.scale.width * 3, scene.scale.height * 3)
      .setFillStyle(this.color).setAlpha(this.opacity).setVisible(this.opacity > 0);
    scene.clearEarlyCurtain();
  }
  /** 每个等待都由场景时钟推进；暂停、跳过、取消使用同一条清理路径。 */
  private wait(playback: PerformancePlayback, start: (complete: () => void) => () => void, settle: () => void = () => {}): Promise<void> {
    playback.signal.throwIfAborted();
    if (playback.skipSignal.aborted) { settle(); return Promise.resolve(); }
    return new Promise((resolve, reject) => {
      let done = false, clean = () => {};
      const finish = (aborted = false) => {
        if (done) return; done = true; clean();
        playback.signal.removeEventListener('abort', abort);
        playback.skipSignal.removeEventListener('abort', skip);
        if (aborted) reject(playback.signal.reason ?? new DOMException('cancelled', 'AbortError'));
        else { try { settle(); resolve(); } catch (error) { reject(error); } }
      };
      const abort = () => finish(true), skip = () => finish();
      playback.signal.addEventListener('abort', abort, { once: true });
      playback.skipSignal.addEventListener('abort', skip, { once: true });
      try { clean = start(() => finish()); if (done) clean(); }
      catch (error) { done = true; playback.signal.removeEventListener('abort', abort); playback.skipSignal.removeEventListener('abort', skip); clean(); reject(error); }
    });
  }
  private delay(duration: number, playback: PerformancePlayback): Promise<void> {
    if (!duration) return Promise.resolve();
    return this.wait(playback, complete => {
      const timer = this.scene().time.delayedCall(duration, complete); return () => timer.remove();
    });
  }
  private async pan(x: number, y: number, motion: 'pan' | 'cut', playback: PerformancePlayback): Promise<void> {
    const camera = this.scene().cameras.main;
    camera.stopFollow();
    const scroll = camera.getScroll(x, y);
    const duration = motion === 'cut' ? 0 : cameraDuration(Math.hypot(scroll.x - camera.scrollX, scroll.y - camera.scrollY));
    if (!duration) { camera.centerOn(x, y); return; }
    await this.wait(playback, complete => {
      camera.once(Phaser.Cameras.Scene2D.Events.PAN_COMPLETE, complete);
      camera.pan(x, y, duration, 'Linear', true);
      return () => { camera.off(Phaser.Cameras.Scene2D.Events.PAN_COMPLETE, complete); camera.panEffect.reset(); };
    }, () => camera.centerOn(x, y));
  }
  private async walk(action: Extract<VisualAction, {type:'walk'}>, playback: PerformancePlayback, batch = false): Promise<void> {
    const scene = this.scene(), actor = this.actor(action.target), visual = actor.visual, movement = scene.movement!;
    if(actor.unpositioned)return;
    const destination = { x: action.x, y: action.y };
    const finalFacing = faceTarget(movement.position(visual), destination);
    // 停用的角色不会被移动世界推进：`MovementBody.update` 在 `!actor.enabled()` 时提前返回，而
    // `WalkRoute` 的状态只在 `next()` 里推进，等它到站就是永远等——演出卡在这一条上，只能靠玩家
    // 跳过解开。看不见的角色走位只影响位置（原版照走，只是没画出来），所以落点照写、过程省略。
    if (!movement.actor(visual).enabled()) {
      if (!batch) movement.place(visual, destination);
      this.face(actor, finalFacing);
      if (action.followCamera) scene.cameras.main.centerOn(destination.x, destination.y);
      return;
    }
    const body = movement.body(visual);
    const immovable = body.immovable;
    if (action.followCamera) scene.cameras.main.startFollow(visual.container, true, 1, 1);
    const settle = () => {
      movement.stop(visual); body.setImmovable(immovable);
      if (!batch || !playback.skipSignal.aborted) movement.place(visual, destination);
      this.face(actor, playback.skipSignal.aborted ? finalFacing : actor.facing);
      if (action.followCamera) { scene.cameras.main.stopFollow(); scene.cameras.main.centerOn(destination.x, destination.y); }
    };
    if (playback.skipSignal.aborted) { settle(); return; }
    body.setImmovable(false);
    const route = movement.walkTo(visual, destination, action.speedPxPerSecond);
    let failed = route.state === 'failed';
    try {
      await this.wait(playback, complete => {
        const update = () => {
          if (route.state === 'failed') { failed = true; complete(); return; }
          if (route.state === 'arrived') { complete(); return; }
          const dx = body.velocity.x, dy = body.velocity.y;
          if (Math.hypot(dx, dy) > .01) {
            actor.facing = Math.abs(dx) > Math.abs(dy) ? dx < 0 ? 'west' : 'east' : dy < 0 ? 'north' : 'south';
            setCharacterClip(scene, visual, `walk-${actor.facing}`);
          } else this.face(actor, actor.facing);
        };
        scene.events.on(Phaser.Scenes.Events.POST_UPDATE, update); update();
        return () => { scene.events.off(Phaser.Scenes.Events.POST_UPDATE, update); movement.stop(visual); body.setImmovable(immovable); };
      }, () => { if (!failed) settle(); });
      if (failed) throw new Error(`剧情${route.error?.message ?? '道路不可达'}：${action.target} → (${action.x}, ${action.y})`);
    } finally { movement.stop(visual); body.setImmovable(immovable); }
  }
  async parallel(actions: PerformanceAction[], playback: PerformancePlayback): Promise<void> {
    const flatten = (action: PerformanceAction): VisualAction[] => action.type === 'parallel' ? action.actions.flatMap(flatten) : [action];
    const flat = actions.flatMap(flatten);
    await Promise.all(flat.map(action => this.executeAction(action, playback)));
    // 每个动作结束时只按当时的位置单独落位；整组走完后再按最终站位统一落一次，
    // 让同时移动的角色作为一组互相校验，而不是按到达先后各自占位。
    const movement = this.scene().movement;
    if (!movement) return;
    const placements = flat.flatMap(action => {
      if (action.type !== 'walk' && action.type !== 'appear' && action.type !== 'leave') return [];
      const bound = this.state?.bindings.find(([alias]) => alias === action.target)?.[1];
      const performer = this.actors.get(bound ?? action.target);
      if (!performer || action.type === 'walk' && performer.unpositioned) return [];
      return [{ visual: performer.visual,
        position: action.type === 'leave' ? movement.position(performer.visual) : { x: action.x, y: action.y },
        enabled: action.type === 'appear' || action.type === 'walk' && performer.visual.container.visible }];
    });
    if (placements.length) movement.placeAll(placements);
  }
  private applySceneAction(action: PerformanceAction): void {
    const previous = this.captureStage();
    if (!previous) throw new Error('剧情场景尚未准备好');
    const next = applyStorySceneAction(previous, action);
    const scene = this.scene();
    scene.ensureActors(next);
    this.state = next;
    // `appear` 在朝向没变时也要重设一次待机姿态。这里用新状态里的别名绑定查目标实例，
    // 不经过 `this.actor()`：`create` 刚追加的实例还没在本轮循环里登记进 `this.actors`。
    const appearing = action.type === 'appear'
      ? next.bindings.find(([alias]) => alias === action.target)?.[1] : undefined;
    const placements: {visual: CharacterVisual; position: {x:number;y:number}; enabled: boolean}[] = [];
    for (const actor of next.scene.actors) {
      const visual = scene.characters.get(actor.id);
      if (!visual) throw new Error('剧情场景对象未绘制：' + actor.id);
      const before = previous.scene.actors.find(candidate => candidate.id === actor.id);
      let performer = this.actors.get(actor.id);
      if (!performer || performer.visual !== visual) {
        performer = {visual, facing:actor.facing,worldEntityId:actor.worldEntityId,unpositioned:actor.unpositioned};
        this.actors.set(actor.id, performer);
      }
      performer.worldEntityId = actor.worldEntityId; performer.unpositioned = actor.unpositioned;
      if (!before || actor.x !== before.x || actor.y !== before.y || actor.visible !== before.visible) {
        placements.push({visual, position:actor, enabled:actor.visible && !actor.unpositioned});
        visual.container.setVisible(actor.visible && !actor.unpositioned);
      }
      if (!before || actor.facing !== before.facing || actor.id === appearing) this.face(performer, actor.facing);
    }
    if (action.type === 'world-object') {
      for (const placement of placements) scene.movement!.placeContent(placement.visual, placement.position, placement.enabled);
    } else if (placements.length) scene.movement!.placeAll(placements);
  }
  async execute(action: VisualAction, playback: PerformancePlayback): Promise<void> { await this.executeAction(action, playback); }
  private async executeAction(action: VisualAction, playback: PerformancePlayback, batch = false): Promise<void> {
    playback.signal.throwIfAborted();
    const scene = this.scene();
    switch (action.type) {
      case 'instant-message': this.app.ui.showInstant(action.text);return;
      case 'refresh-appearance': {
        const stage=this.captureStage();
        if(stage){
          const changed = new Set((this.app.session.storyWorld.captureState().appearances ?? []).map(([actor]) => actor));
          for(const actor of stage.scene.actors) if (actor.id === 'player' || actor.memberId || changed.has(actor.actor)) delete actor.appearance;
          await this.stage(stage,playback.signal);
        }
        return;
      }
      case 'stage': await this.stage(action, playback.signal); return;
      case 'world-object':
        if (action.command.kind === 'place') await scene.prepareActorAssets(action.command.entity.actor, playback.signal);
        playback.signal.throwIfAborted();
        this.applySceneAction(action); return;
      case 'appear': {
        this.applySceneAction(action); return;
      }
      case 'show': {
        // 原版走位前会 `CHARSYSTEM_Revive`：人物已经在台上、只是没画出来。
        // 这里只开显示，不挪位置——位置仍由舞台或之前的走位决定。
        this.applySceneAction(action); return;
      }
      case 'leave': {
        const target = this.actor(action.target).visual.container;
        // 退场只隐藏人物，已经开始的特效留在原地播完。
        for (const effect of this.effects) if (effect.parentContainer === target) {
          const x = target.x + effect.x, y = target.y + effect.y;
          target.remove(effect); scene.add.existing(effect); effect.setPosition(x, y).setDepth(target.depth + 1);
        }
        this.applySceneAction(action); return;
      }
      case 'face': this.applySceneAction(action); return;
      case 'walk': {
        const actor=this.actor(action.target);
        const facing=faceTarget(scene.movement!.position(actor.visual),action);
        await this.walk(action, playback, batch);
        if (!actor.unpositioned) {this.applySceneAction(action);this.face(actor,facing);}
        return;
      }
      case 'pose': {
        const actor = this.present(action.target);
        if (!actor) return;
        if (!playback.skipSignal.aborted) {
          const clip = `${action.pose}-${actor.facing}` as const;
          setCharacterClip(scene, actor.visual, clip, true);
          // 原版按 `ACTDATABASE +4` 决定动作播完要不要排收尾：等于 1 的动作停在末帧保持姿势
          // （114／115／147／149），其余回待机。待机自己循环，不需要收尾事件。
          if (action.pose !== 'idle' && !action.hold) actor.visual.layers[0]?.once('animationcomplete', () => {
            if (actor.visual.container.scene && actor.visual.clipName === clip) this.face(actor, actor.facing);
          });
        }
        await this.delay(action.durationMs, playback);
        if (action.hold && action.pose !== 'idle') {
          const clip = `${action.pose}-${actor.facing}` as const;
          setCharacterClip(scene, actor.visual, clip);
          for (const layer of actor.visual.layers) { layer.anims.setProgress(1); layer.anims.stop(); }
        } else this.face(actor, actor.facing);
        return;
      }
      case 'camera': {
        const actor = this.present(action.target);
        if (!actor) return;
        const target = actor.visual.container;
        await this.pan(target.x, target.y, action.motion, playback); return;
      }
      case 'camera-point': await this.pan(action.x, action.y, action.motion, playback); return;
      case 'effect': {
        if (playback.skipSignal.aborted) return;
        const performer = this.present(action.target);
        if (!performer) return;
        const visual = performer.visual;
        const target = visual.container;
        // 表情属于角色本人：角色不在画面上时不要让它单独浮在地图上。
        // event-4 在 `show player` 之前对隐藏的玩家放 `story-attention`，以前会在
        // 地图入口留下一个没有人的感叹号。
        if (!target.visible) return;
        const clip = this.app.world.storyEffects?.[action.effect]?.clips.default;
        if (!clip) throw new Error('剧情特效缺失：' + action.effect);
        const anchor = visual.actor.effectAnchor ?? { x: 0, y: 0 };
        const effect = createEffect(scene, clip, anchor.x, anchor.y);
        target.add(effect);
        this.effects.add(effect); effect.once('destroy', () => this.effects.delete(effect)); return;
      }
      case 'location-effect': {
        if (playback.skipSignal.aborted) return;
        const placed = this.app.world.storyEffects?.[action.effect];
        if (!placed) throw new Error('剧情特效缺失：' + action.effect);
        const effect = createEffect(scene, placed.clips.default, action.x, action.y);
        this.effectLayer(placed.placement === 'ground').add(effect);
        this.effects.add(effect); effect.once('destroy', () => this.effects.delete(effect)); return;
      }
      case 'map-effect': this.applyMapEffect(action.enabled); return;
      case 'wait': await this.delay(action.durationMs, playback); return;
      case 'sound': if (!playback.skipSignal.aborted) this.app.audio?.effect(action.sound); return;
      case 'stop-audio': this.app.audio?.stopStoryAudio(); return;
      case 'music': this.app.audio?.setStoryMusic(action.sound); return;
      case 'fade': {
        this.color = action.color;
        const settle = () => { this.opacity = action.opacity; this.drawCurtain(); };
        if (!action.durationMs) { settle(); return; }
        await this.wait(playback, complete => {
          const tween = scene.tweens.add({ targets: this, opacity: action.opacity, duration: action.durationMs, onUpdate: () => this.drawCurtain(), onComplete: complete });
          return () => tween.remove();
        }, settle); return;
      }
    }
  }
  async finish(completed: boolean, signal?: AbortSignal): Promise<void> {
    if (completed) {
      signal?.throwIfAborted();
      this.finalStage = this.captureStage();
      for (const actor of this.actors.values()) this.scene().movement?.stop(actor.visual);
      return;
    }
    // 节点取消时正式世界尚未修改；恢复舞台由运行时提供仍有效的信号。
    this.epoch++;
    if (signal && !signal.aborted && this.baseline) await this.restoreStage(this.baseline, signal);
    else {
      if (this.baseline?.audio) this.app.audio?.restoreStoryAudio(this.baseline.audio);
      await this.release();
    }
  }
  async release(): Promise<void> {
    if (this.closing) return this.closing;
    this.epoch++;
    this.resetActors(); this.opacity = 0; this.finalStage = undefined; this.baseline = undefined;
    this.state = undefined; this.scenes.clear(); this.committedScenes.clear();
    this.groundEffects = undefined; this.topEffects = undefined; this.toneFilter = undefined;
    const scene = this.scene();
    if (scene.sys.isActive() || scene.sys.isPaused() || scene.sys.isSleeping?.()) {
      scene.releaseStage();
      const closing = new Promise<void>(resolve => {
        scene.events.once(Phaser.Scenes.Events.SHUTDOWN, resolve);
        scene.scene.stop();
      });
      this.closing = closing;
      try { await closing; } finally { if (this.closing === closing) this.closing = undefined; }
    }
    // 舞台切过别的图之后，音乐停在那一幕的配置上。原版每 255 帧按当前地图重新
    // 调用 `SOUNDSYSTEM_Play_BGM_AMBIENT_CURRENT`，回到正式世界时地图会重新成为
    // 当前地图；这里在演出交还操作权时补同一次应用，255 的地图仍按原版保留当前曲目。
    // 回主菜单时 `ui.mode` 已经切走，不能再把地图音乐盖到菜单主题上。
    const world = this.world();
    if (this.app.ui?.mode === 'game' && world.map) this.app.audio?.enterMap(world.map.id);
  }
}

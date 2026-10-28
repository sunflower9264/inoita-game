import { SCENE_KEYS } from '../application/scene-keys.ts';
import Phaser from 'phaser';
import type { StoryContext } from '../application/ports.ts';
import type { AssetLease } from '../application/assets.ts';
import type { ActorDefinition, Facing, WorldMap } from '../domain/content.ts';
import { validateStoryStageSnapshot, type StoryCurtain, type StoryStageSnapshot } from '../domain/story-performance.ts';
import { assertScenePlan,planScene } from '../domain/scene-plan.ts';
import { NavigationWorld } from '../domain/navigation-world.ts';
import { MovementWorld } from '../rendering/movement-world.ts';
import { characterAssets, type CharacterVisual } from '../rendering/characters.ts';
import { effectAssets } from '../rendering/effects.ts';
import { loadSceneAssets, type PendingAsset } from '../rendering/scene-assets.ts';
import { drawStoryCharacters, drawStoryMap } from '../rendering/story-map-view.ts';
import { mapSurfaceAssets } from '../rendering/map-layers.ts';
import { worldZoom } from '../ui/viewport.ts';
import { Wardrobe } from '../rendering/wardrobe.ts';

/** 舞台画出地图后用来盖住下方正式世界的底色；与 WorldScene 相机底色一致（world-scene.ts:171）。 */
export const STAGE_BACKDROP_COLOR = '#000000';
export const STAGE_TRANSPARENT_COLOR = 'rgba(0,0,0,0)';

function cancellable<T>(work: Promise<T>, signal: AbortSignal, late?: (value: T) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let finished = false;
    const cancel = () => { if (!finished) { finished = true; reject(signal.reason); } };
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    work.then(value => {
      signal.removeEventListener('abort', cancel);
      if (finished) { late?.(value); return; }
      finished = true; resolve(value);
    }, error => {
      signal.removeEventListener('abort', cancel);
      if (!finished) { finished = true; reject(error); }
    });
  });
}

/** 独立演出世界：正式地图的访问记录、战斗和摆放点均由 WorldScene 保留。 */
export class StoryStageScene extends Phaser.Scene {
  readonly app: StoryContext;
  map?: WorldMap;
  player?: CharacterVisual;
  readonly characters = new Map<string, CharacterVisual>();
  facing: Facing = 'south';
  movement?: MovementWorld;
  private lease?: AssetLease;
  private readonly actorLeases = new Set<AssetLease>();
  private clearMap?: () => void;
  private revision = 0;
  /** 舞台是否已经用不透明底色完全盖住正式世界。 */
  private covered = false;
  private readonly wardrobes = new Map<string, Wardrobe>();
  private earlyCurtain?: Phaser.GameObjects.Rectangle;
  constructor(app: StoryContext) {
    super({ key: SCENE_KEYS.storyStage, physics: { default: 'arcade', arcade: { gravity: { x: 0, y: 0 }, debug: false } } });
    this.app = app;
  }
  create(options?: { signal?: AbortSignal; onReady?: () => void; initialCurtain?: StoryCurtain }): void {
    // 首幕/淡入阶段舞台还没有地图，保持透明让正式世界可见；
    // 第一次成功画出舞台地图后由 showStage 切换为不透明。
    this.setWorldCovered(false);
    this.input.enabled = false;
    if (options?.initialCurtain && !options.signal?.aborted) this.showInitialCurtain(options.initialCurtain);
    this.scale.on('resize', this.resizeView, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.revision++;
      this.scale.off('resize', this.resizeView, this);
      this.releaseStage();
      this.wardrobes.clear();
    });
    this.events.once(Phaser.Scenes.Events.CREATE, () => {
      if (!options?.signal?.aborted) options?.onReady?.();
    });
  }
  showInitialCurtain(curtain: StoryCurtain): void {
    this.clearEarlyCurtain();
    this.earlyCurtain = this.add.rectangle(-this.scale.width, -this.scale.height, this.scale.width * 3, this.scale.height * 3, curtain.color)
      .setOrigin(0).setScrollFactor(0).setDepth(20001).setAlpha(curtain.opacity);
  }
  clearEarlyCurtain(): void { this.earlyCurtain?.destroy(); this.earlyCurtain = undefined; }
  /**
   * 舞台一旦有自己的地图，就用不透明相机底色完全盖住下方仍在渲染的正式世界。
   * 还没画舞台地图（首幕淡入/lead-in）时保持透明，让玩家仍能看到世界。
   *
   * 相机背景先于本场景所有对象铺满整个视口，所以地图比视口小时四周显示黑边，
   * 而不是透出下面的旧地图。场景 SHUTDOWN 时 CameraManager 可能已经销毁主相机，
   * 这里用可选链避免清理路径抛错。
   */
  private setWorldCovered(covered: boolean): void {
    this.covered = covered;
    this.cameras?.main?.setBackgroundColor(covered ? STAGE_BACKDROP_COLOR : STAGE_TRANSPARENT_COLOR);
    // 正式世界保留 RUNNING（Loader 和 scene.restart 都要用），只停掉看不见的更新和绘制。
    const world = this.scene?.get?.(SCENE_KEYS.world) as { setStageOccluded?(value: boolean): void } | undefined;
    world?.setStageOccluded?.(covered);
  }
  /** 舞台画面是否已经完全不透明地盖住正式世界。 */
  get worldCovered(): boolean { return this.covered; }
  /** 新地图加载完成前保留上一幅画面；迟到的加载只释放自己的租约。 */
  async showStage(stage: StoryStageSnapshot, signal: AbortSignal, playerAppearance?: ActorDefinition): Promise<void> {
    signal.throwIfAborted(); validateStoryStageSnapshot(stage);
    const plan=planScene(stage.scene,stage.bindings);assertScenePlan(plan);
    const actors=plan.actors.map(entry=>entry.actor);
    const revision = ++this.revision;
    const reference = this.app.world.maps.find(map => map.id === stage.map);
    if (!reference) throw new Error('这片区域的资源尚未准备好');
    const map = this.map?.id === stage.map ? this.map : await this.app.content.map(reference.file, signal);
    signal.throwIfAborted();
    const appearances = new Map<string, ActorDefinition>();
    const needed: PendingAsset[] = [...mapSurfaceAssets(map, this.app.world.props), ...effectAssets(this.app.world.storyEffects ?? {})];
    for (const actor of actors) {
      const appearance = actor.appearance ?? (actor.id === 'player' ? playerAppearance : undefined)
        ?? this.app.world.actors[this.app.session.storyWorld.actorAppearance(actor.actor)];
      if (!appearance) throw new Error('角色资源缺失：' + actor.actor);
      appearances.set(actor.id, appearance);
      needed.push(...characterAssets(appearance).filter(asset => asset.file));
    }
    for (const member of stage.cast) {
      const actor = this.app.world.actors[member.actor];
      if (actor) needed.push(...characterAssets(actor).filter(asset => asset.file));
    }
    needed.push(...this.app.wardrobe.textures.map(texture => ({ kind: 'image' as const, ...texture })));
    const lease = await cancellable(loadSceneAssets(this, needed, () => {}, true), signal, value => value.release());
    const guard = () => {
      signal.throwIfAborted();
      if (revision !== this.revision || !this.sys.isActive()) throw new DOMException('演出舞台已更新', 'AbortError');
    };
    const outfits: { wardrobe: Wardrobe; outfit: Awaited<ReturnType<Wardrobe['prepare']>> }[] = [];
    const createdWardrobes = new Map<string, Wardrobe>();
    let nextLayers: (() => void) | undefined;
    let nextMovement: MovementWorld | undefined;
    let nextCharacters = new Map<string, CharacterVisual>();
    try {
      guard();
      for (const actor of actors) {
        const memberId = actor.id === 'player' ? 'player' : actor.memberId;
        if (!memberId) continue;
        const member = memberId === 'player' ? undefined : this.app.session.party?.get(memberId);
        const character = memberId === 'player' ? this.app.session.character : undefined;
        const base = character?.appearance ?? (member && this.app.world.actors[member.definition.actor]);
        if (!base) continue;
        let wardrobe = createdWardrobes.get(memberId) ?? this.wardrobes.get(memberId);
        if (!wardrobe) {
          wardrobe = new Wardrobe(this, this.app.wardrobe, this.app.items, (ids, signal) => this.app.content.wardrobePoses(ids, signal));
          createdWardrobes.set(memberId, wardrobe);
        }
        const bag = this.app.session.bag;
        const equipment = member ? bag.equipmentItems(bag.equipmentFor(memberId)) : bag.equipmentItems();
        const outfit = await cancellable(wardrobe.prepare(base, equipment, character?.classId ?? member?.classId), signal);
        guard(); appearances.set(actor.id, outfit.actor); outfits.push({ wardrobe, outfit });
      }
      nextLayers = drawStoryMap(this, map);
      nextMovement = new MovementWorld(this, new NavigationWorld(map));
      nextCharacters = drawStoryCharacters(this, actors, appearances);
      const bound = new Set(stage.bindings.map(([, id]) => id));
      for (const actor of actors) {
        const visual = nextCharacters.get(actor.id)!;
        const controlled = bound.has(actor.id);
        nextMovement.register(visual, controlled, false, actor.id === 'player' || actor.memberId || actor.summonedBy ? 'party' : undefined);
        nextMovement.setGhost(visual, controlled);
        nextMovement.setEnabled(visual, actor.visible && !actor.unpositioned);
      }
      guard();
    } catch (error) {
      nextMovement?.destroy();
      for (const visual of nextCharacters.values()) if (visual.container.scene) visual.container.destroy();
      nextLayers?.();
      for (const [id, wardrobe] of createdWardrobes) {
        wardrobe.destroy();
        if (this.wardrobes.get(id) === wardrobe) this.wardrobes.delete(id);
      }
      lease.release(); throw error;
    }
    this.releaseStage(true);
    this.lease = lease; this.map = map; this.clearMap = nextLayers; this.movement = nextMovement;
    for (const [id, visual] of nextCharacters) this.characters.set(id, visual);
    this.player = this.characters.get('player'); this.facing = stage.facing;
    for (const [id, wardrobe] of createdWardrobes) this.wardrobes.set(id, wardrobe);
    for (const { wardrobe, outfit } of outfits) wardrobe.activate(outfit);
    this.resizeView(); this.cameras.main.centerOn(stage.x, stage.y);
    this.setWorldCovered(true);
    this.app.audio?.enterMap(stage.map);
  }
  resizeView(): void {
    if (!this.map) return;
    const camera = this.cameras.main, zoom = worldZoom(this);
    camera.setZoom(zoom).setRoundPixels(true);
    const width = Math.max(this.map.width, this.scale.width / zoom), height = Math.max(this.map.height, this.scale.height / zoom);
    camera.setBounds((this.map.width - width) / 2, (this.map.height - height) / 2, width, height);
  }
  /** 无演员声明的物件动作按需准备贴图，租约跟随当前舞台释放。 */
  async prepareActorAssets(actorId: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const revision = this.revision;
    const actors = [...new Set([actorId, this.app.session.storyWorld.actorAppearance(actorId)])]
      .map(id => this.app.world.actors[id]);
    if (actors.some(actor => !actor)) throw new Error('角色资源缺失：' + actorId);
    const needed = actors.flatMap(actor => characterAssets(actor).filter(asset => asset.file));
    const lease = await cancellable(loadSceneAssets(this, needed, () => {}, true), signal, value => value.release());
    if (signal.aborted || revision !== this.revision || !this.sys.isActive()) {
      lease.release(); signal.throwIfAborted(); throw new DOMException('演出舞台已更新', 'AbortError');
    }
    this.actorLeases.add(lease);
  }
  /** 动作中新增对象只补对象，不重建地图、镜头或正在播放的动作。 */
  ensureActors(stage: StoryStageSnapshot): void {
    if (!this.movement || this.map?.id !== stage.map) throw new Error('演出对象与当前舞台地图不一致');
    const plan=planScene(stage.scene,stage.bindings);assertScenePlan(plan);
    const actors=plan.actors.map(entry=>entry.actor);
    const bound = new Set(stage.bindings.map(([, id]) => id));
    const created = new Map<string, CharacterVisual>();
    try {
      for (const actor of actors) {
        const existing = this.characters.get(actor.id);
        const appearance = actor.appearance ?? this.app.world.actors[this.app.session.storyWorld.actorAppearance(actor.actor)];
        const equipped = actor.id === 'player' || !!actor.memberId;
        if (existing && existing.entity.actor === actor.actor && (equipped || !appearance
          || existing.actor.id === appearance.id && JSON.stringify(existing.actor.clips) === JSON.stringify(appearance.clips))) continue;
        if (!appearance) throw new Error('角色资源缺失：' + actor.actor);
        const visual = drawStoryCharacters(this, [actor], new Map([[actor.id, appearance]])).get(actor.id)!;
        created.set(actor.id, visual);
        const controlled = bound.has(actor.id);
        this.movement.register(visual, controlled, false, equipped || actor.summonedBy ? 'party' : undefined);
        this.movement.setGhost(visual, controlled);
        this.movement.setEnabled(visual, actor.visible && !actor.unpositioned);
      }
    } catch (error) {
      for (const visual of created.values()) {
        this.movement.remove(visual);
        if (visual.container.scene) visual.container.destroy();
      }
      throw error;
    }
    const ids = new Set(actors.map(actor => actor.id));
    for (const [id, visual] of this.characters) if (!ids.has(id) || created.has(id)) {
      this.movement.remove(visual);
      if (visual.container.scene) visual.container.destroy();
      this.characters.delete(id);
    }
    for (const [id, visual] of created) this.characters.set(id, visual);
    this.player = this.characters.get('player');
    for (const actor of actors) {
      const visual = this.characters.get(actor.id)!;
      this.movement.register(visual, bound.has(actor.id), false, actor.id === 'player' || actor.memberId || actor.summonedBy ? 'party' : undefined);
      this.movement.setGhost(visual, bound.has(actor.id));
    }
  }
  releaseStage(preserveEarlyCurtain = false): void {
    // 最终释放时先恢复世界渲染，再到场景 stop 之间露出下面已经切换好的世界，避免黑帧。
    // 换幕重建（preserveEarlyCurtain）仍由旧舞台盖着，不能中途解除遮挡。
    if (!preserveEarlyCurtain) this.setWorldCovered(false);
    this.revision++;
    if (!preserveEarlyCurtain) this.clearEarlyCurtain();
    this.movement?.destroy(); this.movement = undefined;
    for (const character of this.characters.values()) if (character.container.scene) character.container.destroy();
    this.characters.clear();
    this.player = undefined;
    if (!preserveEarlyCurtain) {
      for (const wardrobe of this.wardrobes.values()) wardrobe.destroy();
      this.wardrobes.clear();
    }
    this.clearMap?.(); this.clearMap = undefined;
    this.lease?.release(); this.lease = undefined; this.map = undefined;
    for (const lease of this.actorLeases) lease.release();
    this.actorLeases.clear();
  }
}

import Phaser from 'phaser';
import type { EffectClip, EffectLayer } from '../domain/content.ts';
import { EFFECT_ATLAS_BY_FILE, EFFECT_ATLAS_PAGES } from '../generated/effect-atlas.ts';
import { backdropApproximation, layerDraw } from './effect-colors.ts';
import { blendModeOf } from './blend-modes.ts';
import { currentAnimationFrame, rememberEffectAnimation } from './effect-animations.ts';
import { EFFECT_DEPTH_OFFSET } from './depths.ts';
import {retainLoadedSceneAssets} from './scene-assets.ts';
import type {AssetLease} from '../application/assets.ts';

const effectLeases=new WeakMap<Phaser.GameObjects.Container,AssetLease>();

/**
 * 共用特效渲染器：普攻和技能都从这里建特效、播放、释放。
 *
 * 绝大多数层的结果只由它自己和背景的仿射关系决定，按 Phaser 的混合模式直接画。
 * `backdrop` 层的运算结果依赖背景像素本身（颜色减淡要按背景截顶），导出阶段已经
 * 把它们单独标出来，但游戏里还没有读背景的合成路径，暂时按最接近的混合模式画，
 * 差异记在 `work/findings/56_effect_color_operations.md`。
 *
 * 素材描述符由 `combat-asset-descriptors.ts` 提供，运行时预载和构建期校验共用。
 */
export { effectAssets } from './combat-asset-descriptors.ts';

/**
 * 图集特效动画的身份：文件、页和帧参数都参与，避免同一个 layer key 在不同内容里
 * 指向不同文件或帧数时静默复用旧动画。
 */
export function effectAtlasAnimationKey(layer: EffectLayer, clip: EffectClip, pages: readonly string[]): string {
  return `${layer.file}#${pages.join('+')}#clip:${clip.frames}:${clip.frameRate}`;
}

/** 一个静态特效层在 clip 帧数内用到的图集页；映射或页缺失时直接失败。 */
function effectLayerPages(layer: EffectLayer, clip: EffectClip): { frameRefs: readonly { page: number; frame: string }[]; pages: string[] } {
  const atlas = EFFECT_ATLAS_BY_FILE[layer.file];
  if (!atlas) throw new Error(`特效图集缺少文件映射：${layer.file}`);
  const frameRefs = atlas.slice(0, clip.frames);
  if (frameRefs.length !== clip.frames)
    throw new Error(`特效图集帧不足：${layer.file} 需要 ${clip.frames} 帧，只映射了 ${frameRefs.length} 帧`);
  const pages = [...new Set(frameRefs.map(ref => {
    const page = EFFECT_ATLAS_PAGES[ref.page];
    if (!page) throw new Error(`特效图集页缺失：${ref.page}（${layer.file}）`);
    return page.key;
  }))];
  return { frameRefs, pages };
}

/** 一层特效最终按什么方式混合；伤害数字和普通特效共用同一份判定。 */
export function effectLayerBlendMode(layer: EffectLayer): Phaser.BlendModes {
  const draw = layerDraw(layer);
  return blendModeOf(draw.kind === 'backdrop' ? backdropApproximation(layer.operations) : draw.blend);
}

export function createEffect(scene: Phaser.Scene, clip: EffectClip, x: number, y: number, loop = false): Phaser.GameObjects.Container {
  const effect = scene.add.container(x, y).setDepth(y + EFFECT_DEPTH_OFFSET);
  setEffectClip(scene, effect, clip, loop);
  return effect;
}

/** 投射物转向时更换方向素材，保留动画帧和帧内进度。 */
export function setEffectClip(scene: Phaser.Scene, effect: Phaser.GameObjects.Container, clip: EffectClip, loop: boolean): void {
  leaseEffect(scene, effect, clip);
  const previous = (effect.list[0] as Phaser.GameObjects.Sprite | undefined)?.anims;
  const startFrame = previous?.currentFrame ? currentAnimationFrame(previous) % clip.frames : 0;
  const elapsed = previous?.accumulator ?? 0;
  buildEffectLayers(scene, effect, clip, loop, startFrame, elapsed, () => effect.destroy());
}

function leaseEffect(scene: Phaser.Scene, effect: Phaser.GameObjects.Container, clip: EffectClip): void {
  if(!scene.textures)return;
  // 页纹理缺失不能静默跳过：缺页的层不会播放，留下的画面就不再是这个特效。
  const keys = clip.layers.flatMap(layer => effectLayerPages(layer, clip).pages);
  const missing = keys.find(key => !scene.textures.exists(key));
  if (missing) throw new Error(`特效图集页纹理未加载：${missing}`);
  const lease=retainLoadedSceneAssets(scene,keys);
  const old=effectLeases.get(effect);
  effectLeases.set(effect,lease);
  if(!old)effect.once('destroy',()=>{effectLeases.get(effect)?.release();effectLeases.delete(effect);});
  old?.release();
}

/** 按 clip 重画所有图层并开播；`onComplete` 由调用方决定是销毁还是回收。 */
function buildEffectLayers(
  scene: Phaser.Scene,
  effect: Phaser.GameObjects.Container,
  clip: EffectClip,
  loop: boolean,
  startFrame: number,
  elapsed: number,
  onComplete: () => void,
): string[] {
  effect.removeAll(true);
  const animations: string[] = [];
  for (const layer of clip.layers) {
    const { frameRefs, pages } = effectLayerPages(layer, clip);
    if (scene.textures) {
      const missing = pages.find(key => !scene.textures.exists(key));
      if (missing) {
        globalThis.storyDiagnostics?.record('effect-texture-missing', { key: missing, file: layer.file });
        throw new Error(`特效图集页纹理未加载：${missing}（${layer.file}）`);
      }
    }
    const textureKey = EFFECT_ATLAS_PAGES[frameRefs[0]!.page]!.key;
    const sprite = scene.add.sprite(0, 0, textureKey, frameRefs[0]!.frame).setOrigin(clip.originX, clip.originY)
      .setScale(clip.mirrorX ? -1 : 1, 1);
    const animationKey = effectAtlasAnimationKey(layer, clip, pages);
    // 页纹理可能在上一次地图关闭时被释放，而动画还留在全局表里；帧已失效就重建，不能直接播放。
    const existing = typeof scene.anims?.get === 'function' && scene.anims.exists(animationKey)
      ? scene.anims.get(animationKey) : undefined;
    const stale = !!existing?.frames.some(frame => {
      const textureFrame = (frame as unknown as { frame?: { texture?: unknown } }).frame;
      return !!textureFrame && typeof textureFrame === 'object' && !textureFrame.texture;
    });
    if (existing && (!existing.frames.length || stale)) {
      globalThis.storyDiagnostics?.record('stale-effect-animation', { key: animationKey, texture: textureKey });
      scene.anims.remove(animationKey);
    }
    if (!scene.anims.exists(animationKey)) {
      const frames = frameRefs.map(ref => ({ key: EFFECT_ATLAS_PAGES[ref.page]!.key, frame: ref.frame }));
      scene.anims.create({ key: animationKey, frames, frameRate: clip.frameRate });
    }
    rememberEffectAnimation(scene, animationKey, pages);
    sprite.setBlendMode(effectLayerBlendMode(layer));
    effect.add(sprite);
    animations.push(animationKey);
    if (effect.length === 1 && !loop) sprite.once('animationcomplete', onComplete);
    sprite.play({ key: animationKey, startFrame: Math.max(0, Math.min(startFrame, clip.frames - 1)), repeat: loop ? -1 : 0 });
    sprite.anims.accumulator = elapsed;
  }
  if (!effect.length && !loop && scene.time) {
    scene.time.delayedCall(0, () => { if (effect.scene) onComplete(); });
  }
  return animations;
}

/** 同一个 clip 从第 0 帧重播，不重建图层。 */
function replayEffect(scene: Phaser.Scene, effect: Phaser.GameObjects.Container, animations: string[], onComplete: () => void): void {
  // 素材当时没加载到、一层都没建成：和首次播放一样下一拍就回收，不能留在场上等不到结束事件。
  if (!animations.length) {
    scene.time?.delayedCall(0, () => { if (effect.scene) onComplete(); });
    return;
  }
  const sprites = effect.list as Phaser.GameObjects.Sprite[];
  for (let index = 0; index < sprites.length; index++) {
    const sprite = sprites[index]!;
    sprite.anims.stop();
    sprite.anims.accumulator = 0;
    if (index === 0) {
      sprite.off('animationcomplete');
      sprite.once('animationcomplete', onComplete);
    }
    sprite.play({ key: animations[index]!, startFrame: 0, repeat: 0 });
  }
}

const POOL_PER_CLIP = 16;
const POOL_TOTAL = 256;

/** 池里的容器记得自己当初按哪个片段建好，回收时才知道放回哪个桶。 */
const pooledEffects = new WeakMap<Phaser.GameObjects.Container, { clip: EffectClip; animations: string[] }>();
/** 已经在空闲桶里的容器不能再放一次；warm 的空片段会在下一拍回调 release。 */
const pooledFree = new WeakSet<Phaser.GameObjects.Container>();

/**
 * 命中特效池：同一个 clip 的容器、精灵、动画播完只隐藏不销毁，下次命中直接重播。
 *
 * 命中是战斗里最密的尖峰（一次范围技能能同时打出十几个特效），每次都 `add.sprite`
 * 再销毁会让浏览器不停回收对象。池只在战斗期间存活，`destroy()` 时统一释放贴图租约。
 */
export class EffectPool {
  private readonly scene: Phaser.Scene;
  private readonly free = new Map<EffectClip, Phaser.GameObjects.Container[]>();
  private readonly onShutdown = (): void => this.destroy();
  private idle = 0;
  private closed = false;
  constructor(scene: Phaser.Scene) {
    this.scene = scene;
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, this.onShutdown);
  }

  /** 提前建好指定片段的容器、精灵和动画并放回空闲桶；首次播放只重播，不再现建。 */
  warm(clip: EffectClip, count = 1): void {
    if (this.closed) return;
    const effects: Phaser.GameObjects.Container[] = [];
    // 先全部取出来再统一回收；边取边还会让下一轮又拿到同一个容器。
    for (let index = 0; index < count; index++) {
      const effect = this.acquire(clip, 0, 0);
      // 一层都没建起来的片段会在下一拍自行回收；不要提前放进池里，否则回收回调可能命中刚被复用的容器。
      if (!pooledEffects.get(effect)?.animations.length) { effect.destroy(); continue; }
      effects.push(effect);
    }
    for (const effect of effects) this.release(effect);
  }

  /** 取一个特效并立刻从第 0 帧播放；播完自动回到池里。 */
  acquire(clip: EffectClip, x: number, y: number): Phaser.GameObjects.Container {
    if (this.closed) return createEffect(this.scene, clip, x, y);
    const pooled = this.free.get(clip)?.pop();
    const effect = pooled?.scene ? pooled : undefined;
    if (!effect) {
      const created = this.scene.add.container(x, y).setDepth(y + EFFECT_DEPTH_OFFSET);
      leaseEffect(this.scene, created, clip);
      const animations = buildEffectLayers(this.scene, created, clip, false, 0, 0, () => this.release(created));
      pooledEffects.set(created, { clip, animations });
      return created;
    }
    pooledFree.delete(effect);
    this.idle--;
    effect.setPosition(x, y).setDepth(y + EFFECT_DEPTH_OFFSET).setVisible(true).setActive(true);
    replayEffect(this.scene, effect, pooledEffects.get(effect)!.animations, () => this.release(effect));
    return effect;
  }

  /** 收回一个特效：还在播的（如数字槽位要立刻复用）会被停掉。池满或关图时直接销毁。 */
  release(effect: Phaser.GameObjects.Container): void {
    if (!effect.scene || pooledFree.has(effect)) return;
    effect.parentContainer?.remove(effect);
    effect.setVisible(false);
    for (const sprite of effect.list as Phaser.GameObjects.Sprite[]) sprite.anims.stop();
    effect.emit('effect-recycle');
    const record = pooledEffects.get(effect);
    if (!record || this.closed) { effect.destroy(); return; }
    const bucket = this.free.get(record.clip) ?? [];
    if (bucket.length >= POOL_PER_CLIP || this.idle >= POOL_TOTAL) { effect.destroy(); return; }
    pooledFree.add(effect);
    bucket.push(effect);
    this.free.set(record.clip, bucket);
    this.idle++;
  }

  destroy(): void {
    if (this.closed) return;
    this.closed = true;
    this.scene.events.off(Phaser.Scenes.Events.SHUTDOWN, this.onShutdown);
    for (const bucket of this.free.values()) for (const effect of bucket) effect.destroy();
    this.free.clear();
    this.idle = 0;
  }
}

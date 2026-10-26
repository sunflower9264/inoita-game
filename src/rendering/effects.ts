import Phaser from 'phaser';
import type { EffectClip } from '../domain/content.ts';
import { EFFECT_ATLAS_BY_FILE, EFFECT_ATLAS_PAGES } from '../generated/effect-atlas.ts';
import { backdropApproximation, layerDraw } from './effect-colors.ts';
import { blendModeOf } from './blend-modes.ts';
import { rememberEffectAnimation } from './effect-animations.ts';

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

export function createEffect(scene: Phaser.Scene, clip: EffectClip, x: number, y: number, loop = false): Phaser.GameObjects.Container {
  const effect = scene.add.container(x, y).setDepth(y + 1);
  setEffectClip(scene, effect, clip, loop);
  return effect;
}

/** 投射物转向时更换方向素材，保留动画帧和帧内进度。 */
export function setEffectClip(scene: Phaser.Scene, effect: Phaser.GameObjects.Container, clip: EffectClip, loop: boolean): void {
  const previous = (effect.list[0] as Phaser.GameObjects.Sprite | undefined)?.anims;
  const startFrame = previous?.currentFrame ? (previous.currentFrame.index - 1) % clip.frames : 0;
  const elapsed = previous?.accumulator ?? 0;
  effect.removeAll(true);
  for (const layer of clip.layers) {
    const atlas = EFFECT_ATLAS_BY_FILE[layer.file];
    const frameRefs = atlas?.slice(0, clip.frames);
    const pages = frameRefs?.length
      ? [...new Set(frameRefs.map(ref => {
          const page = EFFECT_ATLAS_PAGES[ref.page];
          if (!page) throw new Error(`特效图集页缺失：${ref.page}`);
          return page.key;
        }))]
      : [layer.key];
    if (scene.textures) {
      const missing = pages.find(key => !scene.textures.exists(key));
      if (missing) {
        globalThis.storyDiagnostics?.record('effect-texture-missing', { key: missing, file: layer.file });
        continue;
      }
    }
    const textureKey = frameRefs?.length ? EFFECT_ATLAS_PAGES[frameRefs[0]!.page]!.key : layer.key;
    const sprite = scene.add.sprite(0, 0, textureKey, frameRefs?.[0]?.frame).setOrigin(clip.originX, clip.originY)
      .setScale(clip.mirrorX ? -1 : 1, 1);
    const animationKey = frameRefs?.length ? `${layer.key}@atlas` : layer.key;
    if (typeof scene.anims?.get === 'function' && scene.anims.exists(animationKey) && !(scene.anims.get(animationKey)?.frames?.length)) {
      scene.anims.remove(animationKey);
    }
    if (!scene.anims.exists(animationKey)) {
      const frames = frameRefs?.length
        ? frameRefs.map(ref => ({ key: EFFECT_ATLAS_PAGES[ref.page]!.key, frame: ref.frame }))
        : scene.anims.generateFrameNumbers(textureKey, { start: 0, end: clip.frames - 1 });
      if (scene.textures && (!frames || !frames.length)) {
        globalThis.storyDiagnostics?.record('effect-frames-empty', { key: textureKey, frames: clip.frames });
        sprite.destroy();
        continue;
      }
      scene.anims.create({ key: animationKey, frames, frameRate: clip.frameRate });
    }
    if (frameRefs?.length) rememberEffectAnimation(scene, animationKey, pages);
    const draw = layerDraw(layer);
    sprite.setBlendMode(blendModeOf(draw.kind === 'backdrop' ? backdropApproximation(layer.operations) : draw.blend));
    effect.add(sprite);
    if (effect.length === 1 && !loop) sprite.once('animationcomplete', () => effect.destroy());
    sprite.play({ key: animationKey, startFrame: Math.max(0, Math.min(startFrame, clip.frames - 1)), repeat: loop ? -1 : 0 });
    sprite.anims.accumulator = elapsed;
  }
  if (!effect.length && !loop && scene.time) {
    scene.time.delayedCall(0, () => { if (effect.scene) effect.destroy(); });
  }
}

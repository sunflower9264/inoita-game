import type Phaser from 'phaser';

/**
 * 图集特效的动画 key 不等于纹理 key（一页图集会被多个图层共用），
 * 纹理释放时不能靠 `removeTexture` 按 key 找到动画。这里记下动画用了哪些页纹理，
 * 页被释放时把对应动画一起删掉；下次播放会重新创建。
 * 账本按全游戏共用的 AnimationManager 记，不能按 Scene 分开记。
 */
const registry = new WeakMap<Phaser.Animations.AnimationManager, Map<string, Set<string>>>();

/**
 * 动画状态当前播到第几帧（从 0 开始）。
 *
 * Phaser 的 `currentFrame.index` 从 1 开始，0 表示还没有帧；动作序列和素材帧号都从 0
 * 开始计数，所以取用帧号时统一走这里。
 */
export function currentAnimationFrame(state?: Phaser.Animations.AnimationState): number {
  return (state?.currentFrame?.index ?? 1) - 1;
}

export function rememberEffectAnimation(scene: Phaser.Scene, animationKey: string, textureKeys: Iterable<string>): void {
  let animations = registry.get(scene.anims);
  if (!animations) { animations = new Map(); registry.set(scene.anims, animations); }
  animations.set(animationKey, new Set(textureKeys));
}

export function releaseEffectAnimations(anims: Phaser.Animations.AnimationManager, textureKey: string): void {
  const animations = registry.get(anims);
  if (!animations) return;
  for (const [animationKey, textureKeys] of [...animations]) {
    if (!textureKeys.has(textureKey)) continue;
    if (anims.exists(animationKey)) anims.remove(animationKey);
    animations.delete(animationKey);
  }
}

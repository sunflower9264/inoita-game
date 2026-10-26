import type Phaser from 'phaser';

/**
 * 图集特效的动画 key 不等于纹理 key（一页图集会被多个图层共用），
 * 纹理释放时不能靠 `removeTexture` 按 key 找到动画。这里记下动画用了哪些页纹理，
 * 页被释放时把对应动画一起删掉；下次播放会重新创建。
 */
const registry = new WeakMap<Phaser.Scene, Map<string, Set<string>>>();

export function rememberEffectAnimation(scene: Phaser.Scene, animationKey: string, textureKeys: Iterable<string>): void {
  let animations = registry.get(scene);
  if (!animations) { animations = new Map(); registry.set(scene, animations); }
  animations.set(animationKey, new Set(textureKeys));
}

export function releaseEffectAnimations(scene: Phaser.Scene, textureKey: string): void {
  const animations = registry.get(scene);
  if (!animations) return;
  for (const [animationKey, textureKeys] of [...animations]) {
    if (!textureKeys.has(textureKey)) continue;
    if (scene.anims.exists(animationKey)) scene.anims.remove(animationKey);
    animations.delete(animationKey);
  }
}

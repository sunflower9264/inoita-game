import type Phaser from 'phaser';
import type { ActorDefinition } from '../../domain/content.ts';
import { blendModeOf } from '../../rendering/blend-modes.ts';
import type { UiSurface } from './widgets.ts';

export interface CharacterPreviewRect { x: number; y: number; width: number; height: number }

/**
 * 菜单里的角色立绘。只摆角色外观的第一帧静态图，不创建会播放动画的角色。
 * 预览图按预览框缩放居中，并跟随页面清理一起销毁：重绘、切页、点物品都不会
 * 在场景原点留下多余的精灵。
 */
export class CharacterPreview {
  private readonly scene: Phaser.Scene;
  private current?: { actor: ActorDefinition; images: Phaser.GameObjects.Image[] };
  constructor(scene: Phaser.Scene) { this.scene = scene; }
  show(surface: UiSurface, actor: ActorDefinition, rect: CharacterPreviewRect): void {
    if (this.current?.actor !== actor) {
      this.destroy();
      this.current = { actor, images: this.draw(actor, rect) };
    }
    for (const image of this.current.images) {
      image.setVisible(true);
      surface.root.add(image);
    }
  }
  /** 从当前页面摘下并隐藏：Phaser 4 会把移出容器的对象放回场景显示列表。 */
  detach(): void {
    for (const image of this.current?.images ?? []) {
      image.parentContainer?.remove(image);
      image.setVisible(false);
    }
  }
  destroy(): void {
    for (const image of this.current?.images ?? []) image.destroy();
    this.current = undefined;
  }
  private draw(actor: ActorDefinition, rect: CharacterPreviewRect): Phaser.GameObjects.Image[] {
    const clip = actor.clips['idle-south'];
    if (!clip) return [];
    const scale = Math.min(rect.width / Math.max(1, clip.frameWidth), rect.height / Math.max(1, clip.frameHeight));
    const left = -clip.originX * clip.frameWidth, top = -clip.originY * clip.frameHeight;
    const x = rect.x + (rect.width - clip.frameWidth * scale) / 2 - left * scale;
    const y = rect.y + (rect.height - clip.frameHeight * scale) / 2 - top * scale;
    const images: Phaser.GameObjects.Image[] = [];
    try {
      for (const layer of clip.layers) images.push(this.scene.add.image(0, 0, layer.key, 0)
        .setOrigin(clip.originX, clip.originY).setScale(scale).setPosition(x, y).setBlendMode(blendModeOf(layer.blend)));
      return images;
    } catch (error) {
      for (const image of images) image.destroy();
      throw error;
    }
  }
}

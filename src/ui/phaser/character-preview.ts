import { createCharacter, type CharacterVisual } from '../../rendering/characters.ts';
import type { ActorDefinition } from '../../domain/content.ts';
import type Phaser from 'phaser';
import type { UiSurface } from './widgets.ts';

export interface CharacterPreviewRect { x: number; y: number; width: number; height: number }

/** 按预览框等比缩放并居中；行走图的脚底坐标不能直接当立绘位置。 */
export function fitCharacterPreview(scene: Phaser.Scene, actor: ActorDefinition, rect: CharacterPreviewRect, id: string): CharacterVisual {
  const visual = createCharacter(scene, actor, { id, actor: actor.id, x: 0, y: 0 });
  const bounds = visual.container.getBounds();
  const scale = Math.min(rect.width / Math.max(1, bounds.width), rect.height / Math.max(1, bounds.height));
  visual.container.setScale(scale).setPosition(
    rect.x + (rect.width - bounds.width * scale) / 2 - bounds.x * scale,
    rect.y + (rect.height - bounds.height * scale) / 2 - bounds.y * scale,
  );
  return visual;
}

/** 菜单里的角色合成立绘：同一外观只合成一次，离开页面时摘下、回来再挂上。 */
export class CharacterPreview {
  private readonly scene: Phaser.Scene;
  private readonly id: string;
  private current?: { actor: ActorDefinition; visual: CharacterVisual };
  constructor(scene: Phaser.Scene, id: string) { this.scene = scene; this.id = id; }
  show(surface: UiSurface, actor: ActorDefinition, rect: CharacterPreviewRect): void {
    if (this.current?.actor !== actor) {
      this.current?.visual.container.destroy();
      this.current = { actor, visual: fitCharacterPreview(this.scene, actor, rect, this.id) };
    }
    surface.root.add(this.current.visual.container);
  }
  /** 从当前页面摘下但保留缓存，下一次 show 直接复用。 */
  detach(): void {
    const container = this.current?.visual.container;
    container?.parentContainer?.remove(container);
  }
  destroy(): void {
    this.current?.visual.container.destroy();
    this.current = undefined;
  }
}

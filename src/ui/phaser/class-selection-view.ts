import Phaser from 'phaser';
import type { UiImage, UiNode } from '../dom/node.ts';
import type { UiSurface } from '../widgets.ts';

/** 职业选择页的 Phaser 视图适配：页面只持有抽象结果，具体场景系统留在本层。 */
export function setClassSelectionBackdrop(scene: Phaser.Scene): void {
  scene.cameras.main.setBackgroundColor('#000000');
}

export function applyClassSelectionFilters(scene: Phaser.Scene, keys: Iterable<string>): void {
  for (const key of new Set(keys)) scene.textures.get(key).setFilter(Phaser.Textures.FilterMode.NEAREST);
}

export function createClassSelectionBackground(scene: Phaser.Scene, key: string): Phaser.GameObjects.Image {
  return scene.add.image(0, 0, key).setOrigin(0).setScrollFactor(0).setDepth(0);
}

export function addClassSelectionHighlight(view: UiSurface, file: string, x: number, y: number,
  width: number, height: number, parent?: UiNode): UiImage {
  return view.image(file, x, y, width, height, parent).setBlendMode(Phaser.BlendModes.ADD);
}

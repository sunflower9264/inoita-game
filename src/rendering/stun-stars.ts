import Phaser from 'phaser';
import type { CharacterVisual } from './characters.ts';

/** 眩晕时在头顶绕圈的三颗小星星；不依赖美术资源，只用 Phaser 的形状与补间。 */
export class StunStars {
  private readonly character: CharacterVisual;
  private readonly container: Phaser.GameObjects.Container;
  private readonly orbit: Phaser.GameObjects.Container;
  private readonly spin: Phaser.Tweens.Tween;

  constructor(scene: Phaser.Scene, character: CharacterVisual) {
    this.character = character;
    this.orbit = scene.add.container(0, 0);
    for (let index = 0; index < 3; index++) {
      const angle = (Math.PI * 2 * index) / 3;
      this.orbit.add(scene.add.star(Math.cos(angle) * 8, Math.sin(angle) * 3, 4, 2, 5, 0xffe066, 0.95));
    }
    this.container = scene.add.container(0, 0, [this.orbit]).setName('stun-stars');
    character.container.add(this.container);
    this.spin = scene.tweens.add({targets: this.orbit, angle: 360, duration: 1600, repeat: -1});
    this.setVisible(false);
  }

  setVisible(visible: boolean): void {
    const anchor = this.character.actor.headAnchor;
    const shown = visible && !!anchor && this.character.container.active;
    if (!shown || !anchor) {
      this.container.setVisible(false);
      return;
    }
    const hasOverhead = this.character.container.list.some(child => child.name === 'overhead-status');
    this.container.setVisible(true).setPosition(anchor.x, anchor.y - (hasOverhead ? 27 : 8));
  }

  destroy(): void {
    this.spin.stop();
    if (this.container.active) this.container.destroy();
  }
}

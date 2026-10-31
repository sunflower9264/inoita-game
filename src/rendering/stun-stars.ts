import Phaser from 'phaser';
import type { CharacterVisual } from './characters.ts';

/** 眩晕提示：三颗小星星沿椭圆绕头顶运动，不依赖美术资源。 */
const ORBIT_RADIUS_X = 8;
const ORBIT_RADIUS_Y = 3;
const ORBIT_PERIOD_MS = 1600;
const ORBIT_STAR_COUNT = 3;
export class StunStars {
  private readonly scene: Phaser.Scene;
  private readonly character: CharacterVisual;
  private readonly container: Phaser.GameObjects.Container;
  private readonly orbit: Phaser.GameObjects.Container;
  private readonly stars: Phaser.GameObjects.Star[] = [];
  private phase = 0;

  constructor(scene: Phaser.Scene, character: CharacterVisual) {
    this.scene = scene;
    this.character = character;
    this.orbit = scene.add.container(0, 0);
    for (let index = 0; index < ORBIT_STAR_COUNT; index++) {
      const star = scene.add.star(0, 0, 4, 2, 5, 0xffe066, 0.95);
      this.stars.push(star);
      this.orbit.add(star);
    }
    this.container = scene.add.container(0, 0, [this.orbit]).setName('stun-stars');
    character.container.add(this.container);
    this.placeStars();
    scene.events.on(Phaser.Scenes.Events.UPDATE, this.spin, this);
    this.setVisible(false);
  }

  /** 三颗星沿同一个椭圆匀速走；相位相隔 120°，不再整体旋转椭圆。 */
  private spin(_time: number, delta: number): void {
    this.phase = (this.phase + delta / ORBIT_PERIOD_MS) % 1;
    this.placeStars();
  }

  private placeStars(): void {
    for (const [index, star] of this.stars.entries()) {
      const angle = Math.PI * 2 * (this.phase + index / ORBIT_STAR_COUNT);
      star.setPosition(Math.cos(angle) * ORBIT_RADIUS_X, Math.sin(angle) * ORBIT_RADIUS_Y);
    }
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
    this.scene.events.off(Phaser.Scenes.Events.UPDATE, this.spin, this);
    if (this.container.active) this.container.destroy();
  }
}

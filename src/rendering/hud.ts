import { SCENE_KEYS } from '../application/scene-keys.ts';
import Phaser from 'phaser';

/**
 * 每个游戏场景在共用界面场景里拥有一组控件，随所属场景隐藏和释放。
 *
 * 登记表是本组控件可见性的唯一权威：经 `add` 登记过的对象，显隐一律走 `setVisible`。
 * 谁自己直接改容器，登记表就停在旧值，下一次 `refresh()`（切图重建、旋转、从后台回来）
 * 会把它翻回旧值，表现为该隐藏的控件又冒出来。
 */
export class Hud {
  readonly scene: Phaser.Scene;
  private readonly owner: Phaser.Scene;
  private readonly layer: Phaser.GameObjects.Layer;
  private readonly visibility = new Map<Phaser.GameObjects.Container, boolean>();

  constructor(owner: Phaser.Scene) {
    this.owner = owner;
    this.scene = owner.scene.get(SCENE_KEYS.controlsUi);
    this.layer = this.scene.add.layer();
    for (const event of ['sleep', 'wake', 'pause', 'resume']) owner.events.on(event, this.refresh, this);
    this.scene.scene.bringToTop();
    if(owner.scene.manager.keys['formal-ui'])owner.scene.bringToTop('formal-ui');
  }
  add(object: Phaser.GameObjects.Container): Phaser.GameObjects.Container {
    this.layer.add(object);
    this.visibility.set(object, object.visible);
    return object;
  }
  setVisible(object: Phaser.GameObjects.Container, visible: boolean): void {
    this.visibility.set(object, visible);
    // 比较对象实际值，不能缓存“上次请求值”：切图/睡眠唤醒后要能重新应用。
    const resolved = visible && this.owner.sys.isActive();
    if (object.visible === resolved) return;
    object.setVisible(resolved);
  }
  private applyVisibility(object: Phaser.GameObjects.Container, requested: boolean): void {
    const visible = requested && this.owner.sys.isActive();
    object.setVisible(visible);
  }
  private refresh(): void {
    for (const [object, visible] of this.visibility) this.applyVisibility(object, visible);
    if(this.owner.sys.isActive()){this.scene.scene.bringToTop();if(this.owner.scene.manager.keys['formal-ui'])this.owner.scene.bringToTop('formal-ui');}
  }
  layout(width: number, height: number): void {
    this.scene.cameras.main.setSize(width, height);
    this.refresh();
  }
  destroy(): void {
    for (const event of ['sleep', 'wake', 'pause', 'resume']) this.owner.events.off(event, this.refresh, this);
    this.visibility.clear(); this.layer.destroy(true);
  }
}

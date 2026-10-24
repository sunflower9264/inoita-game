import Phaser from 'phaser';
import { ControlLayoutPreferences, resolveControlLayout } from '../control-layout.ts';
import { controlViewport } from './control-layout-viewport.ts';
import type { ControlSkin } from '../../domain/control-skin.ts';
import type { Hud } from '../../rendering/hud.ts';

/** 底盘与摇杆头尺寸。 */
const BASE_RADIUS = 105, KNOB_RADIUS = 35;
/** 摇杆头能离开中心的距离：底盘直径的三成。 */
const KNOB_LIMIT = BASE_RADIUS * 0.6;
/** 小于这个距离算没推动，避免手指轻微抖动就走起来。 */
const DEAD_ZONE = 8.75;

/**
 * 屏幕左下角的移动摇杆。Phaser 没有内置虚拟摇杆，这里是标准做法：
 * 底盘与摇杆头画在界面层上，用 pointer 事件算出归一化方向。
 * 对外只暴露 `axis`，场景每帧读它，由地图场景消费。
 */
export class MoveStick {
  readonly axis = { x: 0, y: 0 };
  private readonly scene: Phaser.Scene;
  private readonly hud: Hud;
  private readonly container: Phaser.GameObjects.Container;
  private readonly knob: Phaser.GameObjects.Image;
  private center = { x: 0, y: 0 };
  private pointerId = -1;
  private readonly preferences: ControlLayoutPreferences | undefined;
  private readonly unsubscribe: () => void;
  private layoutHeight: number | undefined;

  constructor(scene: Phaser.Scene, hud: Hud, skin: ControlSkin, preferences?: ControlLayoutPreferences) {
    scene = hud.scene; this.scene = scene; this.hud = hud; this.preferences = preferences;
    this.unsubscribe = preferences?.subscribe(() => { if (this.layoutHeight !== undefined) this.layout(this.layoutHeight); }) ?? (() => {});
    this.container = hud.add(scene.make.container({ x: 0, y: 0 }, false));
    for(const file of [skin['stick-base'],skin.button])scene.textures.get(file).setFilter(Phaser.Textures.FilterMode.LINEAR);
    const base=scene.add.image(0,0,skin['stick-base']).setDisplaySize(BASE_RADIUS*2,BASE_RADIUS*2);
    this.knob=scene.add.image(0,0,skin.button).setDisplaySize(KNOB_RADIUS*2,KNOB_RADIUS*2);
    this.container.add([base, this.knob]);
    this.container.setInteractive(new Phaser.Geom.Circle(0, 0, BASE_RADIUS), Phaser.Geom.Circle.Contains);
    this.container.on('pointerdown', (pointer: Phaser.Input.Pointer, _x: number, _y: number, event: Phaser.Types.Input.EventData) => {
      event.stopPropagation();
      if (this.pointerId >= 0) return;
      this.pointerId = pointer.id; this.track(pointer);
    });
    // 手指移出底盘也要继续跟随，相当于 DOM 版的指针捕获。
    scene.input.on(Phaser.Input.Events.POINTER_MOVE, this.onMove, this);
    scene.input.on(Phaser.Input.Events.POINTER_UP, this.onUp, this);
    scene.input.on(Phaser.Input.Events.POINTER_UP_OUTSIDE, this.onUp, this);
  }
  private onMove(pointer: Phaser.Input.Pointer): void {
    if (pointer.id === this.pointerId) this.track(pointer);
  }
  private onUp(pointer: Phaser.Input.Pointer): void {
    if (pointer.id === this.pointerId) this.reset();
  }
  private track(pointer: Phaser.Input.Pointer): void {
    const dx=(pointer.x-this.center.x)/this.container.scaleX,dy=(pointer.y-this.center.y)/this.container.scaleY;
    const distance = Math.hypot(dx, dy), ratio = Math.min(1, KNOB_LIMIT / (distance || 1));
    const pushed = distance >= DEAD_ZONE;
    this.axis.x = pushed ? dx * ratio / KNOB_LIMIT : 0;
    this.axis.y = pushed ? dy * ratio / KNOB_LIMIT : 0;
    this.knob.setPosition(pushed ? dx * ratio : 0, pushed ? dy * ratio : 0);
  }
  /** 松手或流程接管输入时回到中位。 */
  reset(): void {
    this.pointerId = -1; this.axis.x = 0; this.axis.y = 0; this.knob.setPosition(0, 0);
  }
  layout(height: number): void {
    this.layoutHeight = height;
    const position = resolveControlLayout(controlViewport(this.scene, this.scene.scale.width, height), this.preferences?.snapshot()).move;
    this.center = {x: position.x, y: position.y};
    this.container.setScale(position.scale);
    this.container.setPosition(position.x, position.y);
    this.reset();
  }
  /** 加载中、对话或面板锁住输入、流程挂起时收起摇杆；收起后 Phaser 也不再把它算作点击目标。 */
  setVisible(visible: boolean): void {
    this.hud.setVisible(this.container, visible);
    if (!visible) this.reset();
  }
  destroy(): void {
    this.unsubscribe();
    this.scene.input.off(Phaser.Input.Events.POINTER_MOVE, this.onMove, this);
    this.scene.input.off(Phaser.Input.Events.POINTER_UP, this.onUp, this);
    this.scene.input.off(Phaser.Input.Events.POINTER_UP_OUTSIDE, this.onUp, this);
    this.container.destroy(true);
  }
}

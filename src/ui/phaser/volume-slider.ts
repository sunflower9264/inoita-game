import type Phaser from 'phaser';
import { UI_EVENTS } from '../../application/ui-events.ts';
import { FONT } from '../text-style.ts';

const TRACK_HEIGHT = 10;
const KNOB_WIDTH = 18;
const KNOB_HEIGHT = 26;
const PAD = 12;

function clampVolume(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * 设置页的音量滑动条：0–1 的值，最左边表示静音。
 * 拖动时实时回调，数值文字跟着变化；滚动区只在纵向拖动时滚动，所以横向滑动不会带动列表。
 */
export class VolumeSlider {
  readonly label: string;
  readonly root: Phaser.GameObjects.Container;
  private readonly scene: Phaser.Scene;
  private readonly trackWidth: number;
  private readonly fill: Phaser.GameObjects.Rectangle;
  private readonly knob: Phaser.GameObjects.Rectangle;
  private readonly valueText: Phaser.GameObjects.Text;
  private readonly onChange: (value: number) => void;
  private current: number;
  private press?: { id: number; startX: number; startValue: number };

  constructor(scene: Phaser.Scene, parent: Phaser.GameObjects.Container, label: string,
    x: number, y: number, width: number, value: number, onChange: (value: number) => void) {
    this.scene = scene; this.label = label; this.trackWidth = width; this.onChange = onChange;
    this.current = clampVolume(value);
    this.root = scene.add.container(x, y);
    parent.add(this.root);
    const track = scene.add.rectangle(0, 0, width, TRACK_HEIGHT, 0x4a3b28).setOrigin(0, .5);
    this.fill = scene.add.rectangle(0, 0, width * this.current, TRACK_HEIGHT, 0xc9ad78).setOrigin(0, .5);
    this.knob = scene.add.rectangle(0, 0, KNOB_WIDTH, KNOB_HEIGHT, 0xf3deb0).setOrigin(.5);
    this.valueText = scene.add.text(width + 18, 0, '', {
      fontFamily: FONT, fontSize: 18, color: '#f3deb0', resolution: 3
    }).setOrigin(0, .5);
    this.root.add([track, this.fill, this.knob, this.valueText]);
    this.root.setData('volumeSlider', label);

    // 热区比可见轨道略宽，手指更容易按中；命中时阻止场景级 pointerdown，避免滚动区接管。
    const zone = scene.add.zone(-PAD, -20, width + PAD * 2, 40).setOrigin(0).setInteractive()
      .setData('volumeSlider', label);
    this.root.add(zone);
    zone.on('pointerdown', (pointer: Phaser.Input.Pointer, localX: number, _localY: number,
      event: Phaser.Types.Input.EventData) => {
      event.stopPropagation();
      this.press = { id: pointer.id, startX: pointer.x, startValue: this.current };
      this.setValue((localX - PAD) / width);
    });
    scene.input.on('pointermove', this.move, this);
    scene.input.on('pointerup', this.up, this);
    scene.input.on('pointerupoutside', this.up, this);
    scene.input.on('gameout', this.cancel, this);
    scene.game.events.on(UI_EVENTS.cancelInput, this.cancel, this);
    this.apply();
  }

  get value(): number { return this.current; }

  setValue(value: number): void {
    const next = clampVolume(value);
    if (next === this.current) return;
    this.current = next;
    this.apply();
    this.onChange(next);
  }

  destroy(): void {
    this.scene.input.off('pointermove', this.move, this);
    this.scene.input.off('pointerup', this.up, this);
    this.scene.input.off('pointerupoutside', this.up, this);
    this.scene.input.off('gameout', this.cancel, this);
    this.scene.game.events.off(UI_EVENTS.cancelInput, this.cancel, this);
    if (this.root.active) this.root.destroy(true);
  }

  private readonly move = (pointer: Phaser.Input.Pointer): void => {
    const press = this.press;
    if (!press || press.id !== pointer.id || !pointer.isDown) return;
    const scale = this.root.getWorldTransformMatrix().scaleX || 1;
    this.setValue(press.startValue + (pointer.x - press.startX) / (scale * this.trackWidth));
  };

  private readonly up = (pointer: Phaser.Input.Pointer): void => {
    if (this.press?.id === pointer.id) this.press = undefined;
  };

  private readonly cancel = (): void => { this.press = undefined; };

  private apply(): void {
    this.fill.setSize(this.trackWidth * this.current, TRACK_HEIGHT);
    this.knob.setPosition(this.trackWidth * this.current, 0);
    const text = this.current <= 0 ? '关闭' : `${Math.round(this.current * 100)}%`;
    if (this.valueText.text !== text) this.valueText.setText(text);
  }
}

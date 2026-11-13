import type Phaser from 'phaser';
import type { StoryInterface } from '../domain/story-interface.ts';
import type { PendingAsset } from './scene-assets.ts';

/** 头顶图标只用这三张小地图状态图；`locked` 和 `completed` 不挂标记。 */
const MARKER_STATUSES = ['available', 'active', 'ready'] as const;

/** 地图树冠的深度是 10000；任务图标必须画在它上面。 */
export const QUEST_MARKER_DEPTH = 10001;
/** 图标中心停在角色脚点上方 50 像素。 */
const MARKER_LIFT_PX = 50;

/**
 * 三张图标随共享入口一次装好：任何一张地图上的人都可能挂标记，
 * 不能等到某个任务可接取时再请求图片。
 */
export function questMarkerAssets(storyInterface: StoryInterface): PendingAsset[] {
  return MARKER_STATUSES.map(status => {
    const file = storyInterface.assets[`minimap-${status}`];
    return { kind: 'image' as const, key: file, file };
  });
}

/**
 * 人物头顶的任务图标。
 *
 * 画在世界场景自己的高深度层里，不挂在人物容器下：人物站在树冠、屋顶或别人身后时，
 * 图标仍然可见。位置由 `WorldScene` 只对有标记的角色更新，不逐帧扫全图。
 * 和小地图共用原版图标；中心停在脚点上方 50 像素。
 */
export class QuestMarker {
  private readonly scene: Phaser.Scene;
  private readonly image: Phaser.GameObjects.Image;
  /** 当前真正可用的贴图键。 */
  private file = '';
  /** 任务状态要求的贴图键；纹理晚到时留着它重试。 */
  private desired = '';
  private visible = true;
  private lastX = Number.NaN;
  private lastY = Number.NaN;
  private lastAlpha = Number.NaN;
  private shown = false;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
    this.image = scene.add.image(0, 0, '').setName('quest-marker')
      .setDepth(QUEST_MARKER_DEPTH).setVisible(false);
  }

  /** 供测试和诊断确认图标确实画在树冠之上。 */
  get depth(): number { return this.image.depth; }

  /** 跟随角色脚点；图标中心停在脚点上方 50 像素。值没变就不写显示列表。 */
  position(x: number, y: number): void {
    if (x === this.lastX && y === this.lastY) return;
    this.lastX = x; this.lastY = y;
    this.image.setPosition(x, y - MARKER_LIFT_PX);
  }

  setAlpha(alpha: number): void {
    if (alpha === this.lastAlpha) return;
    this.lastAlpha = alpha;
    this.image.setAlpha(alpha);
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.applyVisibility();
  }

  /** 传 undefined 表示这个角色现在不该挂标记；贴图缺失时保持隐藏并等待纹理到齐。 */
  setFile(file: string | undefined): void {
    this.desired = file ?? '';
    this.syncTexture();
  }

  /** 纹理晚到（例如上下文恢复后重新入库）时补一次设置；平时只在文件变化时生效。 */
  retryTexture(): void {
    if (this.file !== this.desired) this.syncTexture();
  }

  private syncTexture(): void {
    const key = this.desired && this.scene.textures.exists(this.desired) ? this.desired : '';
    if (key !== this.file) {
      this.file = key;
      if (key) this.image.setTexture(key);
    } else if (key && this.image.texture.key !== key) {
      this.image.setTexture(key);
    }
    this.applyVisibility();
  }

  private applyVisibility(): void {
    const shown = this.visible && this.file !== '';
    if (shown === this.shown) return;
    this.shown = shown;
    this.image.setVisible(shown);
  }

  destroy(): void {
    this.image.destroy();
  }
}

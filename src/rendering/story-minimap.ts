import { UI_EVENTS } from '../application/ui-events.ts';
import type Phaser from 'phaser';
import type { WorldMap } from '../domain/content.ts';
import type { StoryInterface } from '../domain/story-interface.ts';
import type { Point } from '../domain/navigation.ts';
import type { Hud } from './hud.ts';
import type { DomUi } from '../ui/dom/dom-ui.ts';
import { DomMinimap, type MinimapTask } from '../ui/dom/minimap.ts';
import { controlViewport } from '../ui/phaser/control-layout-viewport.ts';
export type { MinimapTask } from '../ui/dom/minimap.ts';

/** 小地图的场景接线；地形、边框和标记由 DOM/SVG 绘制。 */
export class StoryMinimap {
  private readonly owner: Phaser.Scene;
  private readonly view: DomMinimap;
  private readonly unwatch: () => void;
  private active = true;
  private requested = false;
  constructor(owner: Phaser.Scene, hud: Hud, map: WorldMap, content: StoryInterface, domUi: DomUi) {
    const parent = domUi.layer('hud');
    if (!parent) throw new Error('小地图界面尚未就绪');
    this.owner = owner;
    this.view = new DomMinimap(parent, map, content.assets, error => globalThis.storyDiagnostics?.record('ui-image-error', { error }));
    this.unwatch = hud.watchVisibility(active => { this.active = active; this.view.visible(active && this.requested); });
    this.layout();
  }
  layout(): void {
    this.view.layout(controlViewport());
    // 小地图高度是设计页面尺寸；菜单侧边按钮挂在 UiSurface 上，用同一套页面单位。
    this.owner.game.events.emit(UI_EVENTS.minimapLayout, this.view.height);
  }
  extent(): { x: number; y: number; width: number; height: number } { return this.view.extent(); }
  updatePlayer(point: Point): void { this.view.updatePlayer(point); }
  updateTasks(tasks: MinimapTask[]): void { this.view.updateTasks(tasks); }
  updateEnemies(enemies: (Point & { id: string })[]): void { this.view.updateEnemies(enemies); }
  setVisible(visible: boolean): void { this.requested = visible; this.view.visible(visible && this.active); }
  destroy(): void { this.unwatch(); this.view.destroy(); }
}

import { UI_EVENTS } from '../application/ui-events.ts';
import Phaser from 'phaser';
import type { WorldMap } from '../domain/content.ts';
import { minimapExits, minimapCellSize, minimapPoint, minimapRuns } from '../domain/minimap.ts';
import { MINIMAP_ASSETS, type StoryInterface } from '../domain/story-interface.ts';
import type { Point } from '../domain/navigation.ts';
import type { Hud } from './hud.ts';
import type { PendingAsset } from './scene-assets.ts';
import { UI_UNIT_HEIGHT, UI_UNIT_WIDTH, readSafeArea } from '../ui/viewport.ts';

export interface MinimapTask extends Point { id: string; status: 'available' | 'active' | 'ready' }

export function minimapAssets(content: StoryInterface): PendingAsset[] {
  return MINIMAP_ASSETS.map(key => ({kind: 'image', key, file: content.assets[key]}));
}

/** A translucent blocking grid and native markers in the shared HUD scene. */
export class StoryMinimap {
  private readonly owner: Phaser.Scene;
  private readonly hud: Hud;
  private readonly map: WorldMap;
  private readonly container: Phaser.GameObjects.Container;
  private readonly player: Phaser.GameObjects.Image;
  private readonly terrainKey: string;
  private readonly cellSize: number;
  private readonly tasks = new Map<string, Phaser.GameObjects.Image>();
  /** 上次任务点的 id/状态/坐标；没变就不重设贴图与层序。 */
  private taskSignature = '';
  private playerPoint?: { x: number; y: number };
  private placed = { x: 0, y: 0, scale: 1 };
  constructor(owner: Phaser.Scene, hud: Hud, map: WorldMap) {
    this.owner = owner; this.hud = hud; this.map = map;
    this.cellSize = minimapCellSize(map.columns, map.rows);
    const width = map.columns * this.cellSize, height = map.rows * this.cellSize;
    this.terrainKey = `minimap-terrain-${map.id}`;
    const terrain = hud.scene.make.graphics({}, false);
    for (const run of minimapRuns(map)) {
      terrain.fillStyle(run.blocked ? 0x000000 : 0x808080, (run.blocked ? 180 : 130) / 255)
        .fillRect(run.x * this.cellSize, run.y * this.cellSize, run.width * this.cellSize, this.cellSize);
    }
    terrain.generateTexture(this.terrainKey, width, height); terrain.destroy();
    this.container = hud.add(hud.scene.make.container({x: 0, y: 0}, false));
    this.container.add(new Phaser.GameObjects.Image(hud.scene, 3, 3, this.terrainKey).setOrigin(0));
    this.image('edge-horizontal', 3, 0).setCrop(0, 0, width, 3);
    this.image('edge-horizontal', 3, height + 2).setCrop(0, 0, width, 3).setFlipY(true);
    this.image('edge-vertical', 0, 3).setCrop(0, 0, 3, height);
    this.image('edge-vertical', width + 3, 3).setCrop(0, 0, 3, height).setFlipX(true);
    this.image('corner-nw', 0, 0);
    this.image('corner-ne', width - 1, 0);
    this.image('corner-sw', 0, height - 2);
    this.image('corner-se', width - 1, height - 2);
    for (const exit of minimapExits(map.exits)) {
      const p = this.project(exit, 4);
      this.image('exit', p.x, p.y).setOrigin(0.5);
    }
    this.player = this.image('player', 0, 0).setOrigin(0.5);
    hud.setVisible(this.container, false);
    this.layout();
  }
  private image(part: string, x: number, y: number): Phaser.GameObjects.Image {
    const image = new Phaser.GameObjects.Image(this.hud.scene, x, y, `minimap-${part}`).setOrigin(0);
    this.container.add(image);
    return image;
  }
  layout(): void {
    const bounds = this.owner.game.canvas.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const unit = this.owner.scale.height / bounds.height;
    const safe = readSafeArea(), cssScale = Math.min(bounds.width / UI_UNIT_WIDTH, bounds.height / UI_UNIT_HEIGHT);
    this.placed = { x: (safe.left + 12) * unit, y: (safe.top + 12) * unit, scale: cssScale * unit };
    this.container.setPosition(this.placed.x, this.placed.y).setScale(this.placed.scale);
    this.owner.game.events.emit(UI_EVENTS.minimapLayout,this.map.rows*this.cellSize+7);
  }
  /** 小地图在 HUD 里占的矩形；帧率显示按它排在小地图右边。 */
  extent(): { x: number; y: number; width: number; height: number } {
    return { x: this.placed.x, y: this.placed.y,
      width: (this.map.columns * this.cellSize + 6) * this.placed.scale,
      height: (this.map.rows * this.cellSize + 7) * this.placed.scale };
  }
  private project(point: Point, lift: number): Point {
    const p = minimapPoint(point, this.map.tileSize, this.cellSize);
    return {x: p.x + 3, y: p.y + 3 - lift};
  }
  updatePlayer(point: Point): void {
    const p = this.project(point, 4);
    if (this.playerPoint?.x === p.x && this.playerPoint.y === p.y) return;
    this.playerPoint = p; this.player.setPosition(p.x, p.y);
  }
  updateTasks(tasks: MinimapTask[]): void {
    const signature = tasks.map(task => `${task.id}|${task.status}|${task.x}|${task.y}`).join(';');
    if (signature === this.taskSignature) return;
    this.taskSignature = signature;
    const ids = new Set(tasks.map(task => task.id));
    for (const [id, icon] of this.tasks) if (!ids.has(id)) { icon.destroy(); this.tasks.delete(id); }
    for (const task of tasks) {
      let icon = this.tasks.get(task.id);
      if (!icon) {
        icon = this.image(task.status, 0, 0).setOrigin(0.5);
        this.tasks.set(task.id, icon);
      }
      const p = this.project(task, 3);
      icon.setTexture(`minimap-${task.status}`).setPosition(p.x, p.y);
    }
    this.container.bringToTop(this.player);
  }
  setVisible(visible: boolean): void { this.hud.setVisible(this.container, visible); }
  destroy(): void {
    this.tasks.clear(); this.container.destroy(true);
    this.hud.scene.textures.remove(this.terrainKey);
  }
}

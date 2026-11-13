import type { WorldMap } from '../../domain/content.ts';
import type { Point } from '../../domain/navigation.ts';
import { minimapCellSize, minimapExits, minimapPoint, minimapRuns } from '../../domain/minimap.ts';
import { uiUnitScale } from '../viewport.ts';
import type { ControlViewport } from '../control-layout.ts';
import { domAssets, type DomAssets } from './assets.ts';
import { DomComponent, DomImage } from './components.ts';

export interface MinimapTask extends Point { id: string; status: 'available' | 'active' | 'ready' }
interface Marker { image: DomImage; file: string; x: number; y: number }
/** 小地图边框厚度：也是地形、出口和标记相对图框的内缩。 */
const MINIMAP_FRAME_INSET = 3;
/** 原版地形不透明度按 0–255 存：阻挡 180、可走 130。 */
const BLOCKED_TERRAIN_ALPHA = 180 / 255, WALKABLE_TERRAIN_ALPHA = 130 / 255;

/** 地形用合并的 SVG 路径，图标用 DOM 图片；移动只改标记位置。 */
export class DomMinimap extends DomComponent {
  private readonly map: WorldMap;
  private readonly files: Record<string, string>;
  private readonly assets: DomAssets;
  private readonly failed: (error: unknown) => void;
  private readonly cellSize: number;
  private readonly player: DomImage;
  private playerKey = '';
  private readonly tasks = new Map<string, Marker>();
  private readonly enemies = new Map<string, Marker>();
  private placed = { x: 0, y: 0, scale: 1 };
  readonly width: number;
  readonly height: number;
  constructor(parent: HTMLElement, map: WorldMap, files: Record<string, string>, failed: (error: unknown) => void, assets = domAssets) {
    super(parent); this.map = map; this.files = files; this.failed = failed; this.assets = assets;
    this.cellSize = minimapCellSize(map.columns, map.rows);
    const width = map.columns * this.cellSize, height = map.rows * this.cellSize;
    this.width = width + 6; this.height = height + 7;
    this.rect({ x: 0, y: 0, width: this.width, height: this.height });
    const terrain = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    terrain.setAttribute('viewBox', `0 0 ${width} ${height}`);
    Object.assign(terrain.style, { position: 'absolute', left: `${MINIMAP_FRAME_INSET}px`, top: `${MINIMAP_FRAME_INSET}px`, width: `${width}px`, height: `${height}px` });
    const runs = minimapRuns(map);
    for (const blocked of [false, true]) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('fill', blocked ? '#000' : '#808080');
      path.setAttribute('opacity', String(blocked ? BLOCKED_TERRAIN_ALPHA : WALKABLE_TERRAIN_ALPHA));
      path.setAttribute('d', runs.filter(run => run.blocked === blocked).map(run =>
        `M ${run.x * this.cellSize} ${run.y * this.cellSize} h ${run.width * this.cellSize} v ${this.cellSize} h ${-run.width * this.cellSize} Z`).join(' '));
      terrain.appendChild(path);
    }
    this.element.appendChild(terrain);
    this.image('edge-horizontal', MINIMAP_FRAME_INSET, 0, width, MINIMAP_FRAME_INSET);
    this.image('edge-horizontal', MINIMAP_FRAME_INSET, height + 2, width, MINIMAP_FRAME_INSET).element.style.transform = 'scaleY(-1)';
    this.image('edge-vertical', 0, MINIMAP_FRAME_INSET, MINIMAP_FRAME_INSET, height);
    this.image('edge-vertical', width + MINIMAP_FRAME_INSET, MINIMAP_FRAME_INSET, MINIMAP_FRAME_INSET, height).element.style.transform = 'scaleX(-1)';
    for (const [part, x, y] of [['nw', 0, 0], ['ne', width - 1, 0], ['sw', 0, height - 2], ['se', width - 1, height - 2]] as const)
      this.image(`corner-${part}`, x, y, 7, 7);
    for (const exit of minimapExits(map.exits)) {
      const point = this.project(exit, 4); this.image('exit', point.x, point.y);
    }
    this.player = this.image('player', 0, 0);
    this.visible(false);
  }
  private image(part: string, x: number, y: number, width?: number, height?: number): DomImage {
    const image = new DomImage(this).rect({ x, y, width: width ?? 1, height: height ?? 1 });
    if (width === undefined) image.naturalSize(.5, .5);
    this.load(image, this.files[`minimap-${part}`]); return image;
  }
  private load(image: DomImage, file: string): void {
    void image.load(this.assets, file).catch(error => { if (!image.signal.aborted && (error as Error)?.name !== 'AbortError') this.failed(error); });
  }
  private project(point: Point, lift: number): Point {
    const at = minimapPoint(point, this.map.tileSize, this.cellSize);
    return { x: at.x + MINIMAP_FRAME_INSET, y: at.y + MINIMAP_FRAME_INSET - lift };
  }
  layout(viewport: ControlViewport): void {
    const scale = uiUnitScale(viewport.width, viewport.height);
    this.placed = { x: viewport.insets.left + 12, y: viewport.insets.top, scale };
    Object.assign(this.element.style, { left: `${this.placed.x}px`, top: `${this.placed.y}px`, transformOrigin: '0 0', transform: `scale(${scale})` });
  }
  extent(): { x: number; y: number; width: number; height: number } {
    return { x: this.placed.x, y: this.placed.y, width: this.width * this.placed.scale, height: this.height * this.placed.scale };
  }
  updatePlayer(point: Point): void {
    const at = this.project(point, 4), key = `${at.x}|${at.y}`;
    if (key === this.playerKey) return;
    this.playerKey = key;
    this.player.element.style.left = `${at.x}px`; this.player.element.style.top = `${at.y}px`;
  }
  updateTasks(tasks: readonly MinimapTask[]): void {
    this.markers(this.tasks, tasks.map(task => ({ ...task, part: task.status })), 3);
  }
  updateEnemies(enemies: readonly (Point & { id: string })[]): void {
    this.markers(this.enemies, enemies.map(enemy => ({ ...enemy, part: 'special' })), 0);
  }
  private markers(current: Map<string, Marker>, points: readonly (Point & { id: string; part: string })[], lift: number): void {
    const ids = new Set(points.map(point => point.id));
    for (const [id, marker] of current) if (!ids.has(id)) { marker.image.destroy(); current.delete(id); }
    for (const point of points) {
      const at = this.project(point, lift), file = this.files[`minimap-${point.part}`];
      let marker = current.get(point.id);
      if (!marker) {
        marker = { image: this.image(point.part, at.x, at.y), file, ...at };
        current.set(point.id, marker);
      }
      if (marker.file !== file) { marker.file = file; this.load(marker.image, file); }
      if (marker.x !== at.x || marker.y !== at.y) {
        marker.x = at.x; marker.y = at.y;
        marker.image.element.style.left = `${at.x}px`; marker.image.element.style.top = `${at.y}px`;
      }
    }
    this.player.element.style.zIndex = '1';
  }
}

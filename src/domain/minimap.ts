import type { MapExit, WorldMap } from './content.ts';
import type { Point } from './navigation.ts';

/** 小地图面板的参考像素尺寸；原版按地图格数选择每格像素。 */
const MINIMAP_PANEL_WIDTH_PX = 200;
const MINIMAP_PANEL_HEIGHT_PX = 150;
/** 候选取值从大到小；都放不下时用最小的 2 像素。 */
const MINIMAP_CELL_SIZES = [5, 4, 3] as const;
const MINIMAP_MIN_CELL_SIZE = 2;

/** Reference pixels per terrain cell, using the original map-size thresholds. */
export function minimapCellSize(columns: number, rows: number): number {
  for (const cellSize of MINIMAP_CELL_SIZES)
    if (columns * cellSize < MINIMAP_PANEL_WIDTH_PX && rows * cellSize < MINIMAP_PANEL_HEIGHT_PX) return cellSize;
  return MINIMAP_MIN_CELL_SIZE;
}
/** Original markers follow the occupied tile, rather than sub-tile movement. */
export function minimapPoint(point: Point, tileSize: number, cellSize: number): Point {
  return {x: Math.floor(point.x / tileSize) * cellSize, y: Math.floor(point.y / tileSize) * cellSize};
}

/** Adjacent cells with the same shading can share one draw call, within each row. */
export function minimapRuns(map: Pick<WorldMap, 'columns' | 'rows' | 'blocked'>) {
  const runs: {x: number; y: number; width: number; blocked: boolean}[] = [];
  for (let y = 0; y < map.rows; y++) {
    for (let x = 0; x < map.columns;) {
      const start = x, blocked = map.blocked[y * map.columns + x];
      while (++x < map.columns && map.blocked[y * map.columns + x] === blocked) {}
      runs.push({x: start, y, width: x - start, blocked});
    }
  }
  return runs;
}

/** One marker per connected doorway, preserving distinct destinations. */
export function minimapExits(exits: readonly MapExit[]): Point[] {
  const remaining = [...exits], points: Point[] = [];
  while (remaining.length) {
    const group = [remaining.shift()!];
    for (let i = 0; i < group.length; i++) {
      const a = group[i];
      for (let j = remaining.length - 1; j >= 0; j--) {
        const b = remaining[j];
        if (a.destination === b.destination && a.x <= b.x + b.width && b.x <= a.x + a.width &&
            a.y <= b.y + b.height && b.y <= a.y + a.height) group.push(...remaining.splice(j, 1));
      }
    }
    const left = Math.min(...group.map(e => e.x)), right = Math.max(...group.map(e => e.x + e.width));
    const top = Math.min(...group.map(e => e.y)), bottom = Math.max(...group.map(e => e.y + e.height));
    points.push({x: (left + right) / 2, y: (top + bottom) / 2});
  }
  return points;
}

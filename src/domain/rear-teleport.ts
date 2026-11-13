import type { Facing } from './content.ts';
import type { Combatant } from './combat.ts';
import type { GameRectangle, Point } from './navigation.ts';

const GRID_SIZE = 8;
const GAP = 8;
const DIRECTIONS: Facing[] = ['south', 'west', 'north', 'east'];
/** 落点搜索顺序：背后 → 一侧 → 另一侧 → 正面。 */
const REAR_FIRST_TURN_ORDER = [0, 1, 3, 2] as const;

/** 黑暗奇袭依次寻找背后、两侧和正面的可达位置。 */
export function planRearTeleport(caster: Combatant, target: Combatant,
  canStand: (point: Point) => boolean, canReach: (point: Point) => boolean,
  mapBounds?: GameRectangle): Point | undefined {
  if (!target.facing) return undefined;
  const facing = DIRECTIONS.indexOf(target.facing);
  const left = target.position.x + target.bounds.x;
  const top = target.position.y + target.bounds.y;
  const right = left + target.bounds.width;
  const bottom = top + target.bounds.height;
  const opposite = (facing + DIRECTIONS.length / 2) % DIRECTIONS.length;
  for (const turn of REAR_FIRST_TURN_ORDER) {
    const direction = DIRECTIONS[(opposite + turn) % DIRECTIONS.length]!;
    const region = direction === 'north' ? { left, right, top: top - caster.bounds.y - caster.bounds.height - GAP, bottom: top - GAP } :
      direction === 'south' ? { left, right, top: bottom - GAP, bottom: bottom - caster.bounds.y + GAP } :
      direction === 'west' ? { left: left + caster.bounds.x - GAP, right: left - GAP, top, bottom } :
      { left: right - GAP, right: right + caster.bounds.x + caster.bounds.width + GAP, top, bottom };
    const preferred = direction === 'north' ? { x: target.position.x, y: region.top } :
      direction === 'south' ? { x: target.position.x, y: region.bottom } :
      direction === 'west' ? { x: region.left, y: target.position.y } :
      { x: region.right, y: target.position.y };
    // 原版纵向只试首选格；横向在首选行按朝向逐格检查。
    const firstColumn = Math.max(Math.floor((mapBounds?.x ?? 0) / GRID_SIZE), Math.floor(region.left / GRID_SIZE));
    const lastColumn = Math.min(mapBounds ? Math.floor((mapBounds.x + mapBounds.width) / GRID_SIZE) : Infinity,
      Math.floor(region.right / GRID_SIZE));
    if (firstColumn > lastColumn) continue;
    const row = Math.floor(preferred.y / GRID_SIZE);
    let column = Math.floor(preferred.x / GRID_SIZE);
    const attempts = direction === 'north' || direction === 'south' ? 1 : lastColumn - firstColumn + 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const candidate = { x: column * GRID_SIZE, y: row * GRID_SIZE };
      if (canStand(candidate)) {
        if (canReach(candidate)) return candidate;
        break;
      }
      column = direction === 'east' ? Math.max(firstColumn, column - 1) : column >= lastColumn ? firstColumn : column + 1;
    }
  }
  return undefined;
}

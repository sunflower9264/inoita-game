import type { CollisionBox, EnemySpawn, EntityPlacement, Facing } from './content.ts';
import type { ChestOpenResult } from './drops.ts';

export const CHEST_OPEN_MS = 600;
/** 原版实体的范围矩形是 16×16、锚在脚底（见 findings 49）。 */
const FOOT_BOX_SIZE = 16;
/** `UTIL_GetRectDistance` 把两轴间隙之和右移 3 位，所以距离单位是 8 px。 */
const RECT_DISTANCE_UNIT = 8;
/** `GAMESTATE_PressKeyPlay` 要求 `CHAR_GetDistance` 不超过 6。 */
const RECT_DISTANCE_LIMIT = 6;
/** 玩家和实体边缘贴在一起时允许的最大间隙：1 个 8 px 单位（一格）。 */
export const BODY_ADJACENT_GAP = 8;
/** 商店可以隔着柜台说话：柜台深度再加一格，最多 4 个 8 px 单位。 */
export const SHOP_COUNTER_GAP = 32;

export interface ChestVisitsState { map?:string; visit:number; opened:string[]; consumed:string[]; enemies:EnemySpawn[] }

/** 开启记录和宝箱怪属于一次地图访问；同图场景重建继续使用这份记录。 */
export class ChestVisits {
  private map?: string;
  private visit = 0;
  private readonly opened = new Set<string>();
  /** 剧情摆放的一次性宝箱：开启后跨地图访问保持已消耗，不能反复领取。 */
  private readonly consumed = new Set<string>();
  private readonly enemies: EnemySpawn[] = [];
  /** 生成记录或本次访问变化时递增；只读投影可以据此复用上一次的结果。 */
  private revisionValue = 0;
  get revision(): number { return this.revisionValue; }
  captureState():ChestVisitsState { return structuredClone({map:this.map,visit:this.visit,opened:[...this.opened],consumed:[...this.consumed],enemies:this.enemies}); }
  restoreState(state:ChestVisitsState):void {
    this.revisionValue++;
    const restored=structuredClone(state);this.map=restored.map;this.visit=restored.visit;
    this.opened.clear();for(const id of restored.opened)this.opened.add(id);
    this.consumed.clear();for(const id of restored.consumed??[])this.consumed.add(id);
    this.enemies.splice(0,this.enemies.length,...restored.enemies);
  }
  get mapId(): string | undefined { return this.map; }
  get spawns(): readonly EnemySpawn[] { return this.enemies; }
  enterMap(map: string): void {
    if (map === this.map) return;
    this.revisionValue++;
    this.map = map; this.visit++;
    this.opened.clear(); this.enemies.length = 0;
  }
  private persistentKey(map:string,entity:string):string { return `${map}:${entity}`; }
  isOpened(map: string, entity: string, oneTime = false): boolean {
    if (oneTime) return this.consumed.has(this.persistentKey(map, entity));
    return this.map === map && this.opened.has(entity);
  }
  /** 泉水喝出怪物：和宝箱怪走同一份生成记录，随本次地图访问一起重建。 */
  spawnEnemy(map: string, key: string, enemyId: string, position: {x:number;y:number}): void {
    this.revisionValue++;
    this.enemies.push({ id: `spring:${this.visit}:${map}:${key}`, enemyId, x: position.x, y: position.y, respawn: false });
  }
  /** 可破坏物里开出的怪：同样只活到本次地图访问结束。 */
  spawnBreakableEnemies(map: string, key: string, enemyIds: readonly string[], position: {x:number;y:number}): void {
    if (map !== this.map) return;
    this.revisionValue++;
    enemyIds.forEach((enemyId, index) => this.enemies.push({
      id: `breakable:${this.visit}:${map}:${key}:${index}`, enemyId, x: position.x, y: position.y, respawn: false
    }));
  }
  open(map: string, entity: string, position: {x:number;y:number}, roll: () => ChestOpenResult, oneTime = false): ChestOpenResult | undefined {
    if (map !== this.map) return;
    const key = this.persistentKey(map, entity);
    if (oneTime ? this.consumed.has(key) : this.opened.has(entity)) return;
    this.revisionValue++;
    if (oneTime) this.consumed.add(key); else this.opened.add(entity);
    try {
      const result = roll();
      result.enemies.forEach((enemyId, index) => this.enemies.push({
        id: `chest:${this.visit}:${map}:${entity}:${index}`, enemyId, x:position.x, y:position.y, respawn: false
      }));
      return result;
    } catch (error) {
      if (oneTime) this.consumed.delete(key); else this.opened.delete(entity);
      throw error;
    }
  }
}

/**
 * 原版 `MAP_AddNPCItemLocation` 对宝箱的判定：每次进图重掷一次。
 *
 * 普通宝箱掷 1..99，不超过 29 才出现（约 29%）；优质宝箱先过同一道关，再过一道
 * 「1..99 达到 60」的关——过了才是优质宝箱，没过就降级成普通宝箱，所以优质宝箱
 * 实际约 11.6%。这一次没出现就返回 undefined。
 */
const PLACEMENT_DICE = 99;

export function rollPlacement(entity: EntityPlacement, random: () => number): EntityPlacement | undefined {
  const dice = () => Math.floor(random() * PLACEMENT_DICE) + 1;
  const { appear, downgrade } = entity;
  if (appear && dice() > appear.atMost) return undefined;
  if (downgrade && dice() < downgrade.atLeast) return { ...entity, actor: downgrade.actor };
  return entity;
}

/**
 * 原版挑「身边的可交互对象」用的距离（`PLAYER_DoCheckNearNPC` 0x1be0b0）：
 * 两个脚底坐标的曼哈顿距离不超过 24 px 才算身边；已经在手上的目标放宽到 25 px。
 */
export const NEAR_OBJECT_DISTANCE = 24;

/** 原版 `PLAYER_DoCheckNearNPC` 的距离判定。 */
export function nearInteractable(from: {x:number;y:number}, target: {x:number;y:number}): boolean {
  return Math.abs(from.x - target.x) + Math.abs(from.y - target.y) <= NEAR_OBJECT_DISTANCE;
}

/**
 * 目标碰撞盒（锚在脚底）与玩家 16×16 脚底框之间的两轴间隙之和，单位 px。
 * `flip` 时按原版镜像横轴，盒子的左边界变成 `-x - width`。
 */
export function bodyGap(
  from: {x:number;y:number},
  target: {x:number;y:number},
  collision: CollisionBox,
  flip = false
): number {
  const half = FOOT_BOX_SIZE / 2;
  const left = target.x + (flip ? -collision.x - collision.width : collision.x);
  const top = target.y + collision.y;
  const gapX = Math.max(0, left - (from.x + half), from.x - half - (left + collision.width));
  const gapY = Math.max(0, top - (from.y + half), from.y - half - (top + collision.height));
  return gapX + gapY;
}

/**
 * 身边的可交互对象。原版先按脚底曼哈顿 24 px 挑；目标自身带实体范围、把玩家挡在
 * 24 px 外时，再按玩家脚底框与目标真实碰撞盒的间隙兜底。普通剧情和 NPC 只放宽到
 * 贴身（1 格），商店可以隔着柜台（4 格）；大体积机关贴边站也能交互，但不会把
 * 16×24 的交互对象放宽到两三格之外。
 */
export function nearInteractive(
  from: {x:number;y:number},
  target: {x:number;y:number},
  collision?: CollisionBox,
  flip = false,
  bodyReach = BODY_ADJACENT_GAP
): boolean {
  return nearInteractable(from, target)
    || (!!collision && bodyGap(from, target, collision, flip) <= bodyReach);
}

/**
 * 原版 `CHAR_GetDistance`（0x1767ac）= `UTIL_GetRectDistance`（0x1ddd38）：
 * 两个 16×16 脚底矩形的两轴间隙之和 ÷ 8。`GAMESTATE_PressKeyPlay`（0x12f6f8）要求它不超过 6。
 */
export function canReachChest(from: {x:number;y:number}, chest: {x:number;y:number}): boolean {
  const gapX = Math.max(0, Math.abs(from.x - chest.x) - FOOT_BOX_SIZE);
  const gapY = Math.max(0, Math.abs(from.y - chest.y) - FOOT_BOX_SIZE);
  return (gapX + gapY) / RECT_DISTANCE_UNIT <= RECT_DISTANCE_LIMIT;
}

/**
 * 原版 `GAMESTATE_PressKeyPlay` 在按攻击键时还要求玩家正面朝着目标：
 * `CHAR_GetDirectionForCharacter`（0x184dfc）给出目标所在的方向码（0 南／1 西／2 北／3 东，
 * 取间隙较大的那一轴），必须等于玩家当前朝向，否则这一下是普攻。
 */
export function facesTarget(from: {x:number;y:number}, facing: Facing, target: {x:number;y:number}): boolean {
  const dx = target.x - from.x, dy = target.y - from.y;
  if (Math.abs(dx) >= Math.abs(dy)) return facing === (dx >= 0 ? 'east' : 'west');
  return facing === (dy >= 0 ? 'south' : 'north');
}

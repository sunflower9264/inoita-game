import { GAME_WIDTH, GAME_HEIGHT } from './viewport.ts';

/** 操作键位属于设备偏好；角色、存档和两组快捷栏共用。 */
export const CONTROL_IDS = ['move', 'attack', 'slot-0', 'slot-1', 'slot-2', 'slot-3', 'slot-4', 'slot-5', 'swap'] as const;
export type ControlId = typeof CONTROL_IDS[number];
export interface ControlPoint { x: number; y: number }
/** 中心点相对屏幕安全区的位置，横纵分别为 0–1。缺项使用现有默认位置。 */
export type ControlLayoutOverrides = Partial<Record<ControlId, ControlPoint>>;
export interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void }
export const CONTROL_LAYOUT_STORAGE_KEY = 'inotia-control-layout';
const FORMAT = 1;

/** 各类操作控件的基准尺寸（界面单位）；布局解析与绘制层共用这一份。 */
export const CONTROL_SIZES = {
  move: { width: 210, height: 210 },
  attack: { width: 159, height: 160 },
  swap: { width: 75, height: 75 },
  slot: { width: 94, height: 94 }
} as const;

export const SHORTCUT_OFFSETS = [
  {x:-342,y:33},{x:-242,y:33},{x:-142,y:33},
  {x:-129,y:-57},{x:-61,y:-120},{x:33,y:-123}
] as const;
/** 左侧存档／菜单按钮的基准边长（界面单位）；电脑模式技能行的一格按它换算。 */
export const HUD_SIDE_BUTTON_SIZE = 56;
export const SWAP_OFFSET = {x:42,y:-210} as const;
/** 登记页的待登记对象相对默认普攻中心的位置。 */
export const PENDING_OFFSET = {x:-382,y:-183} as const;

function validPoint(value: unknown): value is ControlPoint {
  if (!value || typeof value !== 'object') return false;
  const point = value as ControlPoint;
  return Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1;
}
function clone(positions: ControlLayoutOverrides): ControlLayoutOverrides {
  return Object.fromEntries(CONTROL_IDS.flatMap(id => positions[id] ? [[id, {...positions[id]}]] : []));
}
function deviceStorage(): StorageLike | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

export class ControlLayoutPreferences {
  private readonly storage: StorageLike | null;
  private positions: ControlLayoutOverrides = {};
  private readonly listeners = new Set<() => void>();
  constructor(storage?: StorageLike | null) {
    this.storage = storage === undefined ? deviceStorage() : storage;
    try {
      const saved: unknown = JSON.parse(this.storage?.getItem(CONTROL_LAYOUT_STORAGE_KEY) ?? 'null');
      if (!saved || typeof saved !== 'object') return;
      const {version, positions} = saved as {version?: unknown; positions?: unknown};
      if (version !== FORMAT || !positions || typeof positions !== 'object' || Array.isArray(positions)) return;
      const entries = Object.entries(positions);
      if (entries.some(([id, point]) => !CONTROL_IDS.includes(id as ControlId) || !validPoint(point))) return;
      this.positions = clone(positions as ControlLayoutOverrides);
    } catch { /* 存储不可读时使用默认布局。 */ }
  }
  snapshot(): ControlLayoutOverrides { return clone(this.positions); }
  set(id: ControlId, normalizedPoint: ControlPoint): void {
    if (!CONTROL_IDS.includes(id) || !validPoint(normalizedPoint)) return;
    this.positions[id] = {...normalizedPoint};
    this.save();
  }
  reset(): void { this.positions = {}; this.save(); }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private save(): void {
    try { this.storage?.setItem(CONTROL_LAYOUT_STORAGE_KEY, JSON.stringify({version: FORMAT, positions: this.positions})); }
    catch { /* 写入失败时当前运行仍使用内存中的键位。 */ }
    for (const listener of this.listeners) listener();
  }
}

export interface ControlViewport {
  width: number; height: number;
  insets: {left: number; right: number; top: number; bottom: number};
}
export interface ControlPlacement extends ControlPoint { scale: number; width: number; height: number }

function safeArea(viewport: ControlViewport) {
  const {width, height, insets} = viewport;
  return {left: insets.left, top: insets.top,
    width: Math.max(1, width - insets.left - insets.right), height: Math.max(1, height - insets.top - insets.bottom)};
}
function constrain(value: number, start: number, length: number, size: number): number {
  const half = Math.min(length, size) / 2;
  return Math.max(start + half, Math.min(start + length - half, value));
}
function fitPoint(viewport: ControlViewport, point: ControlPoint, size: {width: number; height: number}): ControlPoint {
  const safe = safeArea(viewport);
  return {x: constrain(point.x, safe.left, safe.width, size.width), y: constrain(point.y, safe.top, safe.height, size.height)};
}

/** 默认摇杆沿用全画布缩放，其余控件沿用安全区缩放。 */
export function resolveControlLayout(viewport: ControlViewport, overrides: ControlLayoutOverrides = {}): Record<ControlId, ControlPlacement> {
  const safe = safeArea(viewport);
  const actionScale = Math.min(safe.width / GAME_WIDTH, safe.height / GAME_HEIGHT);
  const moveScale = Math.min(viewport.width / GAME_WIDTH, viewport.height / GAME_HEIGHT);
  const attack = {x: viewport.width - viewport.insets.right - 104 * actionScale,
    y: viewport.height - viewport.insets.bottom - 80 * actionScale};
  const placement = (id: ControlId, point: ControlPoint, scale: number, width: number, height: number): ControlPlacement => {
    const size = {width: width * scale, height: height * scale};
    const custom = overrides[id];
    const position = custom ? fitPoint(viewport, {x: safe.left + custom.x * safe.width, y: safe.top + custom.y * safe.height}, size) : point;
    return {...position, scale, ...size};
  };
  const result = {
    move: placement('move', {x: safe.left + 129 * moveScale, y: viewport.height - viewport.insets.bottom - 129 * moveScale}, moveScale, CONTROL_SIZES.move.width, CONTROL_SIZES.move.height),
    attack: placement('attack', attack, actionScale, CONTROL_SIZES.attack.width, CONTROL_SIZES.attack.height),
    swap: placement('swap', {x: attack.x + SWAP_OFFSET.x * actionScale, y: attack.y + SWAP_OFFSET.y * actionScale}, actionScale, CONTROL_SIZES.swap.width, CONTROL_SIZES.swap.height)
  } as Record<ControlId, ControlPlacement>;
  SHORTCUT_OFFSETS.forEach((offset, index) => {
    const id = `slot-${index}` as ControlId;
    result[id] = placement(id, {x: attack.x + offset.x * actionScale, y: attack.y + offset.y * actionScale}, actionScale, CONTROL_SIZES.slot.width, CONTROL_SIZES.slot.height);
  });
  return result;
}

/** 拖动点先限制图片完整留在安全区，再转为可跨尺寸保存的坐标。 */
export function normalizeControlPosition(viewport: ControlViewport, id: ControlId, point: ControlPoint, overrides: ControlLayoutOverrides = {}): ControlPoint {
  const safe = safeArea(viewport), position = fitPoint(viewport, point, resolveControlLayout(viewport, overrides)[id]);
  return {x: (position.x - safe.left) / safe.width, y: (position.y - safe.top) / safe.height};
}

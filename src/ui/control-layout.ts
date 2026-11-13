import { GAME_WIDTH, GAME_HEIGHT } from './viewport.ts';

/** 操作键位属于设备偏好；角色、存档和两组快捷栏共用。 */
export const CONTROL_IDS = ['move', 'attack', 'slot-0', 'slot-1', 'slot-2', 'slot-3', 'slot-4', 'slot-5', 'swap'] as const;
export type ControlId = typeof CONTROL_IDS[number];
export interface ControlPoint { x: number; y: number }
/** 控件中心相对屏幕安全区的位置（横纵 0–1）和用户缩放倍率；缺项使用默认位置和 1 倍。 */
interface ControlOverride extends ControlPoint { scale?: number }
export type ControlLayoutOverrides = Partial<Record<ControlId, ControlOverride>>;
export interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void }
export const CONTROL_LAYOUT_STORAGE_KEY = 'inotia-control-layout';
/** 用户能拉到的最小和最大倍率；布局解析和编辑器共用。 */
export const CONTROL_SCALE_MIN = 0.6;
const CONTROL_SCALE_MAX = 2;
const CONTROL_LAYOUT_STORAGE_FORMAT_VERSION = 2;
/** 最早一版只存位置，没有 `scale`。 */
const POSITION_ONLY_STORAGE_VERSION = 1;

/** 各类操作控件的基准尺寸（界面单位）；布局解析与绘制层共用这一份。 */
export const CONTROL_SIZES = {
  move: { width: 210, height: 210 },
  /** 十字键的可见圆盘与热区同直径；摇杆模式仍用 `move` 的 210。 */
  moveDpad: { width: 274, height: 274 },
  attack: { width: 159, height: 160 },
  swap: { width: 75, height: 75 },
  slot: { width: 94, height: 94 }
} as const;

const SHORTCUT_OFFSETS = [
  {x:-342,y:33},{x:-242,y:33},{x:-142,y:33},
  {x:-129,y:-57},{x:-61,y:-120},{x:33,y:-123}
] as const;
/** 左侧存档／菜单按钮的基准边长（界面单位）；电脑模式技能行的一格按它换算。 */
export const HUD_SIDE_BUTTON_SIZE = 56;
const SWAP_OFFSET = {x:42,y:-210} as const;
/** 普攻按钮中心距安全区右下角的基准内缩（界面单位）。 */
const ATTACK_ANCHOR_INSET = {x:104, y:80} as const;
/** 移动控件中心离安全区边缘的最小留白，避免圆盘贴边被裁。 */
const MOVE_MIN_CENTER_INSET = 129;
/** 登记页的待登记对象相对默认普攻中心的位置。 */
export const PENDING_OFFSET = {x:-382,y:-183} as const;

function validScale(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= CONTROL_SCALE_MIN && value <= CONTROL_SCALE_MAX;
}
function validPoint(value: unknown): value is ControlPoint {
  if (!value || typeof value !== 'object') return false;
  const point = value as ControlPoint;
  return Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1;
}
function validOverride(value: unknown): value is ControlOverride {
  if (!validPoint(value)) return false;
  const scale = (value as ControlOverride).scale;
  return scale === undefined || validScale(scale);
}
function clone(positions: ControlLayoutOverrides): ControlLayoutOverrides {
  return Object.fromEntries(CONTROL_IDS.flatMap(id => {
    const override = positions[id];
    if (!override) return [];
    const copy: ControlOverride = {x: override.x, y: override.y};
    if (override.scale !== undefined) copy.scale = override.scale;
    return [[id, copy]];
  }));
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
      // 上一版只存位置；没有 scale 的记录按 1 倍读取，写回时统一用新版格式。
      if ((version !== POSITION_ONLY_STORAGE_VERSION && version !== CONTROL_LAYOUT_STORAGE_FORMAT_VERSION) || !positions || typeof positions !== 'object' || Array.isArray(positions)) return;
      const entries = Object.entries(positions);
      if (entries.some(([id, point]) => !CONTROL_IDS.includes(id as ControlId) || !validOverride(point))) return;
      this.positions = clone(positions as ControlLayoutOverrides);
    } catch { /* 存储不可读时使用默认布局。 */ }
  }
  snapshot(): ControlLayoutOverrides { return clone(this.positions); }
  /** 写入位置；不传 `scale` 时保留该控件已有的倍率。 */
  set(id: ControlId, normalizedPoint: ControlPoint, scale?: number): void {
    if (!CONTROL_IDS.includes(id) || !validPoint(normalizedPoint) || (scale !== undefined && !validScale(scale))) return;
    const nextScale = scale ?? this.positions[id]?.scale;
    this.positions[id] = nextScale === undefined ? {...normalizedPoint} : {...normalizedPoint, scale: nextScale};
    this.save();
  }
  reset(): void { this.positions = {}; this.save(); }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private save(): void {
    try { this.storage?.setItem(CONTROL_LAYOUT_STORAGE_KEY, JSON.stringify({version: CONTROL_LAYOUT_STORAGE_FORMAT_VERSION, positions: this.positions})); }
    catch { /* 写入失败时当前运行仍使用内存中的键位。 */ }
    for (const listener of this.listeners) listener();
  }
}

export interface ControlViewport {
  width: number; height: number;
  insets: {left: number; right: number; top: number; bottom: number};
}
export interface ControlPlacement extends ControlPoint {
  /** 屏幕适配缩放；不含用户倍率。 */
  scale: number;
  /** 用户在布局编辑器里调过的倍率，默认 1。 */
  userScale: number;
  width: number; height: number;
}

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

/**
 * 默认摇杆沿用全画布缩放，其余控件沿用安全区缩放。
 * `moveSize` 由调用方按当前移动样式传入：摇杆 210，十字键 274。
 */
export function resolveControlLayout(viewport: ControlViewport, overrides: ControlLayoutOverrides = {},
  moveSize: {width: number; height: number} = CONTROL_SIZES.move): Record<ControlId, ControlPlacement> {
  const safe = safeArea(viewport);
  const actionScale = Math.min(safe.width / GAME_WIDTH, safe.height / GAME_HEIGHT);
  const moveScale = Math.min(viewport.width / GAME_WIDTH, viewport.height / GAME_HEIGHT);
  const attack = {x: viewport.width - viewport.insets.right - ATTACK_ANCHOR_INSET.x * actionScale,
    y: viewport.height - viewport.insets.bottom - ATTACK_ANCHOR_INSET.y * actionScale};
  const placement = (id: ControlId, point: ControlPoint, scale: number, width: number, height: number): ControlPlacement => {
    const custom = overrides[id];
    const userScale = custom?.scale ?? 1;
    const size = {width: width * scale * userScale, height: height * scale * userScale};
    const position = custom ? fitPoint(viewport, {x: safe.left + custom.x * safe.width, y: safe.top + custom.y * safe.height}, size) : point;
    return {...position, scale, userScale, ...size};
  };
  // 十字键圆盘比摇杆大：中心离安全区边缘至少留出半个直径，避免贴边被裁掉。
  const moveOffset = Math.max(MOVE_MIN_CENTER_INSET, moveSize.width / 2) * moveScale;
  const result = {
    move: placement('move', {x: safe.left + moveOffset, y: viewport.height - viewport.insets.bottom - moveOffset}, moveScale, moveSize.width, moveSize.height),
    attack: placement('attack', attack, actionScale, CONTROL_SIZES.attack.width, CONTROL_SIZES.attack.height),
    swap: placement('swap', {x: attack.x + SWAP_OFFSET.x * actionScale, y: attack.y + SWAP_OFFSET.y * actionScale}, actionScale, CONTROL_SIZES.swap.width, CONTROL_SIZES.swap.height)
  } as Record<ControlId, ControlPlacement>;
  SHORTCUT_OFFSETS.forEach((offset, index) => {
    const id = `slot-${index}` as ControlId;
    result[id] = placement(id, {x: attack.x + offset.x * actionScale, y: attack.y + offset.y * actionScale}, actionScale, CONTROL_SIZES.slot.width, CONTROL_SIZES.slot.height);
  });
  return result;
}

/**
 * 控件中心保持不动时，放大到完整留在安全区内的最大倍率。
 * 中心越靠近屏幕边缘，可放大的空间越小；结果不会低于最小倍率。
 */
export function maxControlScale(viewport: ControlViewport, id: ControlId,
  overrides: ControlLayoutOverrides = {}, moveSize: {width: number; height: number} = CONTROL_SIZES.move): number {
  const safe = safeArea(viewport), placement = resolveControlLayout(viewport, overrides, moveSize)[id];
  const baseWidth = placement.width / placement.userScale, baseHeight = placement.height / placement.userScale;
  const halfWidth = Math.min(placement.x - safe.left, safe.left + safe.width - placement.x);
  const halfHeight = Math.min(placement.y - safe.top, safe.top + safe.height - placement.y);
  return Math.max(CONTROL_SCALE_MIN, Math.min(CONTROL_SCALE_MAX,
    Math.max(1, halfWidth) / (baseWidth / 2), Math.max(1, halfHeight) / (baseHeight / 2)));
}

/** 拖动点先限制图片完整留在安全区，再转为可跨尺寸保存的坐标。 */
export function normalizeControlPosition(viewport: ControlViewport, id: ControlId, point: ControlPoint,
  overrides: ControlLayoutOverrides = {}, moveSize: {width: number; height: number} = CONTROL_SIZES.move): ControlPoint {
  const safe = safeArea(viewport), position = fitPoint(viewport, point, resolveControlLayout(viewport, overrides, moveSize)[id]);
  return {x: (position.x - safe.left) / safe.width, y: (position.y - safe.top) / safe.height};
}

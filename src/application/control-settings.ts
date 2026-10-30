const STORAGE_KEY = 'inotia4.control.style.v1';

/** 触屏移动键样式：原版虚拟摇杆或符文四向十字键。 */
export type MoveControlStyle = 'stick' | 'dpad';
/** 当前操作方式：两种触屏样式加电脑键鼠模式。 */
export type ControlMode = MoveControlStyle | 'keyboard';

export interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void }

function deviceStorage(): StorageLike | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

/**
 * 操作方式属于本机偏好，不进存档。
 * `moveStyle` 始终保留最近一次触屏样式，电脑模式下切回触屏时用它恢复原选择。
 */
export class ControlSettings {
  private readonly storage: StorageLike | null;
  private modeValue: ControlMode = 'stick';
  private moveStyleValue: MoveControlStyle = 'stick';
  private readonly styleListeners = new Set<(style: MoveControlStyle) => void>();
  private readonly modeListeners = new Set<(mode: ControlMode) => void>();

  constructor(storage?: StorageLike | null) {
    this.storage = storage === undefined ? deviceStorage() : storage;
    const { mode, moveStyle } = this.read();
    this.modeValue = mode;
    this.moveStyleValue = moveStyle;
  }

  get mode(): ControlMode { return this.modeValue; }

  get moveStyle(): MoveControlStyle { return this.moveStyleValue; }

  setMode(mode: ControlMode): void {
    if (this.modeValue === mode) return;
    const previousStyle = this.moveStyleValue;
    this.modeValue = mode;
    if (mode !== 'keyboard') this.moveStyleValue = mode;
    this.save();
    if (this.moveStyleValue !== previousStyle)
      for (const listener of this.styleListeners) listener(this.moveStyleValue);
    for (const listener of this.modeListeners) listener(mode);
  }

  /** 旧的入口：选触屏样式就等于选对应的触屏模式。 */
  setMoveStyle(style: MoveControlStyle): void { this.setMode(style); }

  /** 只关心触屏样式的订阅者（移动摇杆等）；电脑模式不触发它。 */
  subscribe(listener: (style: MoveControlStyle) => void): () => void {
    this.styleListeners.add(listener);
    return () => { this.styleListeners.delete(listener); };
  }

  /** 操作方式变化都要知道的订阅者（世界 HUD、操作设置）。 */
  subscribeMode(listener: (mode: ControlMode) => void): () => void {
    this.modeListeners.add(listener);
    return () => { this.modeListeners.delete(listener); };
  }

  private read(): { mode: ControlMode; moveStyle: MoveControlStyle } {
    try {
      const saved: unknown = JSON.parse(this.storage?.getItem(STORAGE_KEY) ?? '{}');
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return { mode: 'stick', moveStyle: 'stick' };
      const { mode, moveStyle } = saved as { mode?: unknown; moveStyle?: unknown };
      const style: MoveControlStyle = moveStyle === 'dpad' ? 'dpad' : 'stick';
      if (mode === 'keyboard') return { mode, moveStyle: style };
      if (mode === 'stick' || mode === 'dpad') return { mode, moveStyle: mode };
      // 旧格式只有 moveStyle：十字键偏好直接当作操作方式。
      return { mode: style, moveStyle: style };
    } catch {
      return { mode: 'stick', moveStyle: 'stick' };
    }
  }

  private save(): void {
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify({ mode: this.modeValue, moveStyle: this.moveStyleValue }));
    } catch {
      /* 隐私模式等环境下安全忽略，内存值仍然生效 */
    }
  }
}

export const controlSettings = new ControlSettings();

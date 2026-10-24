const STORAGE_KEY = 'inotia4.control.style.v1';

export type MoveControlStyle = 'stick' | 'dpad';

interface ControlPreferences {
  moveStyle: MoveControlStyle;
}

function preferences(): ControlPreferences {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    return { moveStyle: saved.moveStyle === 'dpad' ? 'dpad' : 'stick' };
  } catch {
    return { moveStyle: 'stick' };
  }
}

const settings = preferences();
const listeners = new Set<(style: MoveControlStyle) => void>();

export const controlSettings = {
  /** 当前移动控制键样式：'stick' 为原版虚拟摇杆，'dpad' 为符文四向十字按键。默认为 'stick'。 */
  get moveStyle(): MoveControlStyle {
    return settings.moveStyle;
  },
  setMoveStyle(style: MoveControlStyle): void {
    if (settings.moveStyle === style) return;
    settings.moveStyle = style;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      /* 隐私模式等环境下安全忽略 */
    }
    for (const listener of listeners) listener(style);
  },
  subscribe(listener: (style: MoveControlStyle) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }
};

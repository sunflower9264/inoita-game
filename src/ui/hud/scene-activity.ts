/** 需要监听场景激活/暂停变化以同步 DOM HUD 显隐的宿主契约。 */
export interface SceneActivitySource {
  readonly sys: { isActive(): boolean };
  readonly events: {
    on(event: string, fn: () => void, context?: unknown): unknown;
    off(event: string, fn: () => void, context?: unknown): unknown;
  };
}

/**
 * 监听所属游戏场景的暂停、睡眠与唤醒事件并通知 DOM HUD 组件，
 * 替代过去常驻空转的 `ControlsScene` 与 `rendering/hud.ts`。
 */
export class SceneActivity {
  private readonly owner: SceneActivitySource;
  private readonly listeners = new Set<(active: boolean) => void>();

  constructor(owner: SceneActivitySource) {
    this.owner = owner;
    for (const event of ['sleep', 'wake', 'pause', 'resume']) {
      owner.events.on(event, this.refresh, this);
    }
  }

  private refresh(): void {
    const active = this.owner.sys.isActive();
    for (const listener of this.listeners) listener(active);
  }

  layout(_width?: number, _height?: number): void {
    this.refresh();
  }

  watchVisibility(listener: (active: boolean) => void): () => void {
    this.listeners.add(listener);
    listener(this.owner.sys.isActive());
    return () => {
      this.listeners.delete(listener);
    };
  }

  destroy(): void {
    for (const event of ['sleep', 'wake', 'pause', 'resume']) {
      this.owner.events.off(event, this.refresh, this);
    }
    for (const listener of this.listeners) listener(false);
    this.listeners.clear();
  }
}

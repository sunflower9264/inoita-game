import type { DomLabel, DomUi } from '../dom/dom-ui.ts';
import { readSafeArea } from '../viewport.ts';

export interface NameBannerHost {
  readonly events: {
    on(event: string, fn: () => void, context?: unknown): unknown;
    off(event: string, fn: () => void, context?: unknown): unknown;
  };
  readonly game: {
    readonly canvas: {
      getBoundingClientRect(): { width: number; height: number };
    };
  };
}

const FADE_IN_MS = 150;
const HOLD_MS = 2000;
const FADE_OUT_MS = 400;
const TICK_MS = 16;

/** 地图入场提示与附近交互对象共用的屏幕名称条；文字只由 DOM 层绘制。 */
export class NameBanner {
  private readonly scene: NameBannerHost;
  private readonly mapName: string;
  private domLabel?: DomLabel;
  private mapPending = true;
  private kind: 'map' | 'target' | null = null;
  private enabled = false;
  private domShown = false;
  private domOpacity = 0;
  private domPhase: 'idle' | 'in' | 'hold' | 'out' = 'idle';
  private domElapsed = 0;
  private domLastAt = 0;
  private domTimer?: ReturnType<typeof setTimeout>;

  constructor(scene: NameBannerHost, mapName: string, domUi?: DomUi) {
    this.scene = scene;
    this.mapName = mapName;
    if (!domUi) return;
    this.domLabel = domUi.label('hud', 'dom-name-banner', { x: 0.5, y: 0 })
      .setStyle({
        background: 'rgba(0,0,0,0.55)', color: '#fff4dc', fontSize: '18px',
        height: '34px', lineHeight: '34px', textAlign: 'center',
        overflow: 'hidden', textOverflow: 'ellipsis', textShadow: 'none', opacity: '0'
      })
      .setVisible(false);
    // 场景暂停/睡眠时旧实现靠 Phaser 计时器停表；DOM 计时器要自己停，恢复后再接上。
    scene.events.on('pause', this.onScenePause, this);
    scene.events.on('sleep', this.onScenePause, this);
    scene.events.on('resume', this.onSceneWake, this);
    scene.events.on('wake', this.onSceneWake, this);
  }

  layout(): void {
    if (!this.domLabel) return;
    const bounds = this.scene.game.canvas.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const safe = readSafeArea();
    const width = Math.min(480, Math.max(1, bounds.width - 2 * Math.max(safe.left, safe.right)) * 0.6);
    this.domLabel.setStyle({ width: `${width}px` }).setPosition(bounds.width / 2, safe.top + 24);
  }

  /** 输入被流程接管时暂停提示；恢复后先重新判断当前目标。 */
  sync(enabled: boolean, targetName: string | null): void {
    if (!this.domLabel) return;
    if (enabled !== this.enabled) {
      this.enabled = enabled;
      if (enabled) this.resumeDom(); else this.pauseDom();
    }
    this.showDom(enabled && this.kind !== null);
    if (!enabled) return;
    if (targetName !== null) {
      if (this.kind === 'target' && this.domLabel.element.textContent === targetName) return;
      this.cancelDomAnimation(); this.mapPending = false; this.kind = 'target';
      this.domLabel.setText(targetName); this.setDomOpacity(1); this.showDom(true);
    } else if (this.kind === 'target') {
      this.kind = null; this.showDom(false);
    } else if (this.mapPending) {
      this.mapPending = false; this.kind = 'map';
      this.domLabel.setText(this.mapName); this.setDomOpacity(0); this.showDom(true);
      this.startDomAnimation();
    }
  }

  private showDom(visible: boolean): void {
    if (visible === this.domShown) return;
    this.domShown = visible;
    this.domLabel!.setVisible(visible);
  }
  private setDomOpacity(value: number): void {
    if (value === this.domOpacity) return;
    this.domOpacity = value;
    this.domLabel!.setStyle({ opacity: String(value) });
  }
  private startDomAnimation(): void {
    this.domPhase = 'in'; this.domElapsed = 0; this.domLastAt = Date.now();
    this.scheduleDomTick();
  }
  private scheduleDomTick(): void {
    if (this.domTimer) return;
    this.domTimer = setTimeout(() => { this.domTimer = undefined; this.stepDom(); }, TICK_MS);
  }
  private stepDom(): void {
    if (!this.domLabel || !this.enabled || this.domPhase === 'idle') return;
    const now = Date.now();
    this.domElapsed += Math.max(0, now - this.domLastAt); this.domLastAt = now;
    if (this.domPhase === 'in') {
      const progress = Math.min(1, this.domElapsed / FADE_IN_MS);
      this.setDomOpacity(progress);
      if (progress >= 1) { this.domPhase = 'hold'; this.domElapsed = 0; }
    } else if (this.domPhase === 'hold') {
      if (this.domElapsed >= HOLD_MS) { this.domPhase = 'out'; this.domElapsed = 0; }
    } else {
      const progress = Math.min(1, this.domElapsed / FADE_OUT_MS);
      this.setDomOpacity(1 - progress);
      if (progress >= 1) { this.domPhase = 'idle'; this.kind = null; this.showDom(false); return; }
    }
    this.scheduleDomTick();
  }
  private pauseDom(): void {
    if (this.domTimer) { clearTimeout(this.domTimer); this.domTimer = undefined; }
  }
  private resumeDom(): void {
    if (!this.domLabel || this.domPhase === 'idle' || this.domTimer) return;
    this.domLastAt = Date.now(); this.scheduleDomTick();
  }
  private cancelDomAnimation(): void {
    this.pauseDom(); this.domPhase = 'idle'; this.domElapsed = 0;
  }
  private readonly onScenePause = (): void => {
    this.pauseDom();
    if (this.domShown) { this.domShown = false; this.domLabel?.setVisible(false); }
  };
  private readonly onSceneWake = (): void => { this.resumeDom(); };
  destroy(): void {
    this.cancelDomAnimation();
    this.scene.events.off('pause', this.onScenePause, this);
    this.scene.events.off('sleep', this.onScenePause, this);
    this.scene.events.off('resume', this.onSceneWake, this);
    this.scene.events.off('wake', this.onSceneWake, this);
    this.domLabel?.remove();
    this.domLabel = undefined;
  }
}

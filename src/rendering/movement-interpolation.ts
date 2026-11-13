import type { Point } from '../domain/navigation.ts';

/** 还没收到物理步时长时，按每秒 60 步估算一个逻辑步。 */
const DEFAULT_STEP_MS = 1000 / 60;

interface MovingVisual extends Point { active: boolean }
interface MotionSample {
  position(): Point;
  enabled(): boolean;
  previous: Point;
  current: Point;
  saved: Point;
}

/** 保存已完成碰撞的两次位置，只在绘制期间借用人物容器的坐标。 */
export class MovementInterpolation {
  private remainingMs = 0;
  private stepMs = DEFAULT_STEP_MS;
  private readonly samples = new Map<MovingVisual, MotionSample>();
  private readonly restoredPositions = new Map<MovingVisual, Point>();
  private readonly moving = new Set<MovingVisual>();

  register(visual: MovingVisual, position: () => Point, enabled: () => boolean): void {
    const current = position();
    this.samples.set(visual, { position, enabled, previous: { ...current }, current: { ...current }, saved: { ...current } });
  }

  beginFrame(deltaMs: number): void {
    this.restore();
    this.remainingMs += deltaMs;
  }

  /** 每个物理步调用一次，长帧补步也逐次采样，保留最后两个结算位置。 */
  completeStep(durationMs: number): void {
    this.stepMs = durationMs;
    this.remainingMs -= durationMs;
    for (const [visual, sample] of this.samples) {
      const current = sample.position();
      sample.previous.x = sample.current.x; sample.previous.y = sample.current.y;
      sample.current.x = current.x; sample.current.y = current.y;
      if (!sample.enabled()) { sample.previous.x = current.x; sample.previous.y = current.y; }
      if (sample.previous.x !== current.x || sample.previous.y !== current.y) this.moving.add(visual);
      else this.moving.delete(visual);
    }
  }

  position(visual: MovingVisual): Point {
    const sample = this.samples.get(visual);
    if (!sample) return { x: visual.x, y: visual.y };
    if (!sample.enabled()) return sample.position();
    const fraction = Math.max(0, Math.min(1, this.remainingMs / this.stepMs));
    return {
      x: sample.previous.x + (sample.current.x - sample.previous.x) * fraction,
      y: sample.previous.y + (sample.current.y - sample.previous.y) * fraction
    };
  }

  apply(): void {
    this.restore();
    const fraction = Math.max(0, Math.min(1, this.remainingMs / this.stepMs));
    for (const visual of this.moving) {
      const sample = this.samples.get(visual)!;
      if (!visual.active || !sample.enabled()) continue;
      const x = sample.previous.x + (sample.current.x - sample.previous.x) * fraction;
      const y = sample.previous.y + (sample.current.y - sample.previous.y) * fraction;
      if (visual.x === x && visual.y === y) continue;
      sample.saved.x = visual.x; sample.saved.y = visual.y;
      this.restoredPositions.set(visual, sample.saved);
      visual.x = x; visual.y = y;
    }
  }

  restore(): void {
    for (const [visual, position] of this.restoredPositions) {
      if (visual.active) Object.assign(visual, position);
    }
    this.restoredPositions.clear();
  }

  /** 瞬移、换装和重新启用时从实际落点开始显示。物理时钟的余量保持不变。 */
  reset(visual: MovingVisual): void {
    const saved = this.restoredPositions.get(visual);
    if (saved && visual.active) Object.assign(visual, saved);
    this.restoredPositions.delete(visual);
    this.moving.delete(visual);
    const sample = this.samples.get(visual);
    if (sample) {
      const current = sample.position();
      sample.previous.x = sample.current.x = current.x;
      sample.previous.y = sample.current.y = current.y;
    }
  }

  remove(visual: MovingVisual): void { this.reset(visual); this.samples.delete(visual); }
  destroy(): void { this.restore(); this.samples.clear(); this.moving.clear(); }
}

import type { StoryDirector } from '../domain/story-director.ts';

interface DiagnosticCollector {
  record(kind: string, details: unknown, withState?: boolean): void;
  flush(): Promise<void>;
  setSnapshot(provider: () => unknown): void;
  setMetrics(provider: () => unknown): void;
  export(): Promise<string>;
}
declare global { var storyDiagnostics: DiagnosticCollector | undefined; }

/** 超过这个耗时的帧记一次长帧。 */
const LONG_FRAME_MS = 50;
/** 最近保留的帧间隔样本数。 */
const INTERVAL_SAMPLES = 120;
/** 最近保留的每秒帧率样本数；60 条约一分钟。 */
const SECOND_SAMPLES = 60;
/** 暂停、切后台或长演出造成的空档不当作掉帧，重置当前窗口。 */
const IDLE_RESET_MS = 2000;

export interface FrameSnapshot {
  /** 最近一秒交付的帧数。 */
  fps: number;
  /** 最近一分钟的每秒帧率平均值、最低值、最高值。 */
  avgFps: number;
  minFps: number;
  maxFps: number;
  /** 本次会话累计的超过 50 毫秒的帧数。 */
  longFrames: number;
  /** 最近样本里的最长帧间隔。 */
  maxFrameMs: number;
  /** 最近样本里 95% 的帧都快于这个耗时。 */
  p95FrameMs: number;
  /** 当前参与统计的帧间隔样本数。 */
  samples: number;
  /** 当前窗口里的每秒帧率样本数；为 0 时平均/最低帧率还没有意义。 */
  secondSamples: number;
  /** 本次会话累计交付帧数。 */
  frames: number;
}

/**
 * 轻量帧统计：每帧只做整数加减和一次定长数组写入，不新建对象。
 * 统计器不读取 Phaser 内部状态，由调用方在每次真正交付一帧时喂入时间戳。
 */
export class FrameStats {
  private readonly intervals = new Float32Array(INTERVAL_SAMPLES);
  private readonly seconds = new Float32Array(SECOND_SAMPLES);
  private readonly sorted = new Float32Array(INTERVAL_SAMPLES);
  private intervalIndex = 0;
  private intervalCount = 0;
  private secondIndex = 0;
  private secondCount = 0;
  private lastFrameAt = 0;
  private windowStart = 0;
  private windowFrames = 0;
  private currentFps = 0;
  private frames = 0;
  private longFrames = 0;

  /** 每次真正交付到画面的一帧调用一次。`now` 用 `performance.now()`。 */
  frame(now: number): void {
    const previous = this.lastFrameAt;
    this.lastFrameAt = now;
    this.frames += 1;
    if (!previous) { this.windowStart = now; return; }
    const interval = now - previous;
    if (interval <= 0) return;
    if (interval > IDLE_RESET_MS) {
      // 挂起、切后台或长演出之后的第一次回调不参与统计，避免把停顿算成超低帧率。
      this.resetWindow(now);
      return;
    }
    this.intervals[this.intervalIndex] = interval;
    this.intervalIndex = (this.intervalIndex + 1) % INTERVAL_SAMPLES;
    if (this.intervalCount < INTERVAL_SAMPLES) this.intervalCount += 1;
    if (interval > LONG_FRAME_MS) this.longFrames += 1;
    if (!this.windowStart) this.windowStart = now;
    this.windowFrames += 1;
    const elapsed = now - this.windowStart;
    if (elapsed < 1000) return;
    this.currentFps = Math.round(this.windowFrames * 1000 / elapsed);
    this.seconds[this.secondIndex] = this.currentFps;
    this.secondIndex = (this.secondIndex + 1) % SECOND_SAMPLES;
    if (this.secondCount < SECOND_SAMPLES) this.secondCount += 1;
    this.windowStart = now;
    this.windowFrames = 0;
  }

  snapshot(): FrameSnapshot {
    let minFps = 0, maxFps = 0, totalFps = 0;
    for (let index = 0; index < this.secondCount; index += 1) {
      const value = this.seconds[index];
      if (!minFps || value < minFps) minFps = value;
      if (value > maxFps) maxFps = value;
      totalFps += value;
    }
    let maxFrameMs = 0;
    const count = this.intervalCount;
    for (let index = 0; index < count; index += 1) {
      this.sorted[index] = this.intervals[index];
      if (this.intervals[index] > maxFrameMs) maxFrameMs = this.intervals[index];
    }
    let p95FrameMs = 0;
    if (count) {
      const sample = this.sorted.subarray(0, count);
      sample.sort();
      p95FrameMs = sample[Math.min(count - 1, Math.floor((count - 1) * 0.95))];
    }
    return {
      fps: this.currentFps,
      avgFps: this.secondCount ? Math.round(totalFps / this.secondCount) : 0,
      minFps: Math.round(minFps),
      maxFps: Math.round(maxFps),
      longFrames: this.longFrames,
      maxFrameMs: Math.round(maxFrameMs),
      p95FrameMs: Math.round(p95FrameMs),
      samples: count,
      secondSamples: this.secondCount,
      frames: this.frames,
    };
  }

  private resetWindow(now: number): void {
    this.windowStart = now;
    this.windowFrames = 0;
    this.currentFps = 0;
    this.intervalIndex = 0;
    this.intervalCount = 0;
    this.secondIndex = 0;
    this.secondCount = 0;
  }
}

/** 每次跳过只写一条轻量摘要；阶段时间都从点击时刻开始算。 */
export function installStorySkipDiagnostics(director: Pick<StoryDirector, 'onSkipProgress'>,
  record: (kind: string, details: object) => void, now: () => number = () => performance.now()): void {
  let timing: { started: number; logicMs?: number; worldReadyMs?: number; cancelled?: boolean; stages?: Record<string, number> } | undefined;
  director.onSkipProgress = phase => {
    if (phase === 'requested') { timing ??= { started: now() }; return; }
    if (!timing) return;
    const elapsed = Math.max(0, Math.round((now() - timing.started) * 10) / 10);
    if (['assets-start', 'assets-ready', 'portraits-ready', 'sounds-ready', 'outfit-ready', 'objects-ready'].includes(phase)) {
      (timing.stages ??= {})[phase] = elapsed; return;
    }
    if (phase === 'logic-complete') { timing.logicMs = elapsed; return; }
    if (phase === 'world-ready') { timing.worldReadyMs = elapsed; return; }
    if (phase === 'cancelled') { timing.cancelled = true; return; }
    const details = { outcome: timing.cancelled ? 'cancelled' : phase,
      logicMs: timing.logicMs ?? null, worldReadyMs: timing.worldReadyMs ?? null,
      unlockedMs: phase === 'released' ? elapsed : null, elapsedMs: elapsed,
      ...(timing.stages ? { stages: timing.stages } : {}) };
    timing = undefined; record('story-skip-summary', details);
  };
}

/**
 * 让错误记录带上当时的运行状态。只设置快照，不挂引擎帧事件，也不逐帧计时。
 * 返回的函数在游戏销毁时清掉快照，避免错误记录继续持有旧会话。
 */
export function installDiagnosticSnapshot(snapshot: () => unknown): () => void {
  const collector = globalThis.storyDiagnostics;
  if (!collector) return () => {};
  collector.setSnapshot(snapshot);
  return () => collector.setSnapshot(() => null);
}

/** 让每条记录都带上帧率、内存和画面设置；读取失败时由收集器单独处理。 */
export function installDiagnosticMetrics(metrics: () => unknown): () => void {
  const collector = globalThis.storyDiagnostics;
  if (!collector) return () => {};
  collector.setMetrics(metrics);
  return () => collector.setMetrics(() => null);
}

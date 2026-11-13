import type { StoryDirector } from '../domain/story-director.ts';

interface DiagnosticCollector {
  record(kind: string, details: unknown, withSnapshot?: boolean): void;
  flush(): Promise<void>;
  setSnapshot(provider: () => unknown): void;
  export(): string;
}
declare global { var storyDiagnostics: DiagnosticCollector | undefined; }

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

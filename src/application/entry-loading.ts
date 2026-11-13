import type { AssetLease } from './assets.ts';
import type { EntryPlan } from './entry-plan.ts';
import type { PendingAsset } from '../rendering/scene-assets.ts';

export interface EntryLoadingPorts {
  /** 加载一批场景资源；progress 是这一批的 0–1。 */
  load(assets: PendingAsset[], progress: (value: number) => void): Promise<AssetLease>;
  /** 报告当前阶段。silent 时由调用方传空实现。 */
  report(label: string, progress: number): void;
  preloadPortraits(files: string[], signal: AbortSignal, progress: (value: number) => void): Promise<void>;
  prepareSounds(names: string[], signal: AbortSignal): Promise<void>;
}

interface EntryLoadingResult {
  /** 当前图的租约；场景接管后负责释放。 */
  currentLease: AssetLease;
}

/**
 * 加载入口计划：当前图 0–0.88，立绘 0.88–0.91，音效，0.94 留给场景对象构建。
 * 失败时释放已经拿到的租约，避免残留引用。
 */
export async function loadEntryPlan(plan: EntryPlan, ports: EntryLoadingPorts, options: { signal: AbortSignal; start?: number; end?: number; preparePresentation?: boolean; onPhase?: (phase: 'assets-ready' | 'portraits-ready' | 'sounds-ready') => void }): Promise<EntryLoadingResult> {
  const { signal } = options;
  const start = options.start ?? 0, end = options.end ?? 1, span = end - start;
  const report = (label: string, value: number) => ports.report(label, start + value * span);
  const label = `正在加载 · ${plan.current.map.name}`;
  let currentLease: AssetLease | undefined;
  try {
    report(label, 0);
    currentLease = await ports.load([...plan.shared, ...plan.current.assets, ...(plan.residentCombat ?? [])], value => report(label, value * 0.88));
    signal.throwIfAborted();
    options.onPhase?.('assets-ready');

    if (options.preparePresentation !== false) {
      report('正在准备剧情画面…', 0.88);
      if (plan.portraits.length) await ports.preloadPortraits(plan.portraits, signal, value => report('正在准备剧情画面…', 0.88 + value * 0.03));
      signal.throwIfAborted();
      options.onPhase?.('portraits-ready');
      await ports.prepareSounds(plan.sounds, signal);
      signal.throwIfAborted();
      options.onPhase?.('sounds-ready');
    }

    report('正在布置地图…', 0.94);
    return { currentLease };
  } catch (error) {
    currentLease?.release();
    throw error;
  }
}

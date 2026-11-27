import type { StoryContext } from '../application/ports.ts';

/** 剧情世界静默重建的等待上限；超时同时中止新场景的加载。 */
export const STORY_WORLD_SWITCH_TIMEOUT_MS = 30_000;

/** 等待一个 Promise，同时响应调用方的取消信号。 */
export function waitForAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('操作已取消'));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('操作已取消'));
    signal.addEventListener('abort', abort, { once: true });
    work.then(
      value => { signal.removeEventListener('abort', abort); resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); },
    );
  });
}

export interface WorldReadinessOptions {
  signal?: AbortSignal;
  onReady?: () => void;
  onError?: (error: unknown) => void;
}

export interface WorldReadinessHost<TOptions extends WorldReadinessOptions> {
  worldReady(): boolean;
  isDestroyed(): boolean;
  currentOptions(): TOptions | undefined;
  setLoadingWorld(loading: boolean): void;
  restartScene(options: TOptions): void;
}

/**
 * 协调世界场景的跨代加载、就绪等待、失败重建、超时中止与入口剧情加载屏遮罩。
 * 不直接依赖 Phaser，仅通过 `WorldReadinessHost` 驱动场景重启。
 */
export class WorldReadiness<TOptions extends WorldReadinessOptions = WorldReadinessOptions> {
  private readonly host: WorldReadinessHost<TOptions>;
  /** 当前场景代际的打开任务：init 先放占位，create 换成真正的进图任务。 */
  openTask?: Promise<void>;
  /** 重建任务自己的取消源；只跟随场景换代或关闭，不跟随某个调用方的剧情信号。 */
  readyAbort = new AbortController();
  /** 基础进图参数：正常进图时更新，重建只从这里生成，避免回调和参数套娃。 */
  baseOptions?: TOptions;
  /** 进图加载页还在等这条剧情的第一幕；等待期间的素材补载不另开加载页。 */
  entryStoryStarted?: () => void;

  private settleOpenStarted?: () => void;
  private readyTask?: Promise<void>;
  private readyRebuild = false;
  private pendingRestart?: { options: TOptions; controller: AbortController; settle: (error?: unknown) => void };

  constructor(host: WorldReadinessHost<TOptions>) {
    this.host = host;
  }

  /** 世界切换已经排队：占住 openTask，等 create 结算并换成真正的进图任务。 */
  beginSwitch(): void {
    // 连续排队时先叫醒上一批等待者，让它们重新读取新的占位，而不是等满超时。
    this.settleOpenStarted?.();
    this.openTask = new Promise<void>(resolve => { this.settleOpenStarted = resolve; });
  }

  /** 新一代场景 init 时重置代际取消源，并按参数身份认领已排队的重建请求。 */
  claimInit(options: TOptions): void {
    this.readyTask = undefined;
    this.readyRebuild = false;
    if (!this.openTask) this.beginSwitch();
    this.readyAbort.abort(new Error('正式地图已经重新加载'));
    this.readyAbort = new AbortController();
    const pending = this.pendingRestart;
    this.pendingRestart = undefined;
    if (pending && pending.options === options) {
      // 这次 init 就是排队中的重建：基础参数已在 restartWorld 里更新。
    } else {
      pending?.controller.abort(new Error('正式地图已经重新加载'));
      pending?.settle(new Error('正式地图已经重新加载'));
      this.baseOptions = options;
    }
  }

  /** create 开始执行，解除 init 占位的切换等待。 */
  settleCreateStarted(): void {
    this.settleOpenStarted?.();
    this.settleOpenStarted = undefined;
  }

  /** create 因外部信号已中止而提前退出时清理代际状态。 */
  abortCreate(reason: unknown): void {
    this.readyAbort.abort(reason);
    this.openTask = undefined;
    this.settleOpenStarted = undefined;
  }

  /** 追踪 create() 发起的异步 open() 任务，按当次 options 投递错误回调。 */
  trackOpen(
    options: TOptions,
    openTask: Promise<void>,
    signal: AbortSignal,
    isCurrentOptions: () => boolean,
    onFailure: (error: unknown) => void,
  ): void {
    this.openTask = openTask;
    void openTask.catch(error => {
      // 取消也要把结果交给等待者：`restartStoryWorld` 靠 onError 结算 Promise；
      // 结算必须用发起本次加载的 options——不能错算到新一代场景头上。
      options.onError?.(error);
      if (!signal.aborted && isCurrentOptions()) onFailure(error);
    }).finally(() => {
      if (this.openTask === openTask) this.openTask = undefined;
    });
  }

  /** 场景关闭时清理状态并结算未被 init 认领的重建请求。 */
  handleShutdown(): void {
    this.readyAbort.abort(new Error('正式地图已经关闭'));
    this.openTask = undefined;
    this.settleOpenStarted = undefined;
    this.readyTask = undefined;
    this.readyRebuild = false;
    this.entryStoryStarted = undefined;
    this.baseOptions = undefined;
    const pendingRestart = this.pendingRestart;
    if (pendingRestart) {
      // 场景重启也会触发 shutdown，紧接着同一帧的 init 会认领 pendingRestart；
      // 推到微任务再检查：仍未被认领说明场景已关闭，结算并释放闭包。
      queueMicrotask(() => {
        if (this.pendingRestart !== pendingRestart) return;
        this.pendingRestart = undefined;
        pendingRestart.controller.abort(new Error('场景已关闭'));
        pendingRestart.settle(new Error('场景已关闭'));
      });
    }
  }

  /**
   * 剧情正常开演前调用：只等在途进图结算，不重建。
   * 世界没有在途打开却仍不完整时抛错，交给错误页和重试路径处理。
   */
  waitWorldReady(signal?: AbortSignal): Promise<void> {
    return this.ensureReady(false, signal);
  }

  /** 错误重试和剧情投影前调用：先等在途进图；世界仍不完整就用基础参数重建。 */
  recoverWorld(signal?: AbortSignal): Promise<void> {
    return this.ensureReady(true, signal);
  }

  private ensureReady(rebuild: boolean, signal?: AbortSignal): Promise<void> {
    if (this.host.worldReady()) return Promise.resolve();
    if (this.readyTask) {
      // 复用已有任务；但「只等待」的任务不能满足重建请求，先等它结束再重建。
      if (!rebuild || this.readyRebuild) return waitForAbort(this.readyTask, signal);
      const current = this.readyTask;
      return waitForAbort(current, signal).catch(() => {}).then(() => {
        signal?.throwIfAborted();
        if (this.readyTask === current) {
          this.readyTask = undefined;
          this.readyRebuild = false;
        }
        return this.ensureReady(true, signal);
      });
    }
    this.readyRebuild = rebuild;
    const task = this.ensureReadyNow(rebuild);
    this.readyTask = task;
    void task.finally(() => {
      if (this.readyTask === task) {
        this.readyTask = undefined;
        this.readyRebuild = false;
      }
    }).catch(() => {});
    // 调用方只取消自己的等待；共享任务跟随场景换代或关闭。
    return waitForAbort(task, signal);
  }

  private async ensureReadyNow(rebuild: boolean): Promise<void> {
    const signal = this.readyAbort.signal;
    signal.throwIfAborted();
    let lastError: unknown;
    // 先等在途进图；等待期间若又换了新一代，继续等新的那一次。
    for (let attempts = 0; attempts < 3; attempts++) {
      if (this.host.worldReady()) return;
      const task = this.openTask;
      if (!task) break;
      try {
        await this.waitOpenTask(task, signal);
      } catch (error) {
        signal.throwIfAborted();
        lastError = error;
      }
      if (this.host.worldReady()) return;
      if (this.openTask === task) break;
    }
    if (this.host.worldReady()) return;
    signal.throwIfAborted();
    if (!rebuild) throw lastError instanceof Error ? lastError : new Error('正式地图尚未就绪');
    const options = this.baseOptions ?? this.host.currentOptions();
    if (this.host.isDestroyed() || !options) throw new Error('正式地图尚未就绪');
    await this.restartWorld(options);
  }

  private waitOpenTask(task: Promise<void>, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('正式地图加载超时')), STORY_WORLD_SWITCH_TIMEOUT_MS);
      waitForAbort(task, signal).then(
        () => { clearTimeout(timer); resolve(); },
        error => { clearTimeout(timer); reject(error); },
      );
    });
  }

  /**
   * 用基础参数重建正式世界并等待新场景就绪。
   * 不监听场景代际的取消源：这次重启自己触发的 shutdown/init 不能取消它，
   * 场景真正关闭时由 open 的失败回调结算，超时再兜底。
   */
  restartWorld(options: TOptions): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let finished = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const controller = new AbortController();
      const done = (error?: unknown) => {
        if (finished) return;
        finished = true;
        if (this.pendingRestart?.controller === controller) this.pendingRestart = undefined;
        if (timer) clearTimeout(timer);
        if (error) reject(error); else resolve();
      };
      timer = setTimeout(() => {
        const error = new Error('正式地图重建超时');
        controller.abort(error);
        done(error);
      }, STORY_WORLD_SWITCH_TIMEOUT_MS);
      this.host.setLoadingWorld(true);
      this.baseOptions = options;
      const { onReady, onError } = options;
      const wrapped = {
        ...options,
        signal: controller.signal,
        onReady: () => { if (finished) return; try { onReady?.(); } finally { done(); } },
        onError: (error: unknown) => { if (finished) return; try { onError?.(error); } finally { done(error); } },
      } as TOptions;
      this.pendingRestart = { options: wrapped, controller, settle: done };
      try {
        this.beginSwitch();
        this.host.restartScene(wrapped);
      } catch (error) {
        this.pendingRestart = undefined;
        this.openTask = undefined;
        this.settleOpenStarted = undefined;
        done(error);
      }
    });
  }

  /** 剧情驱动跨图或快照恢复时的等待式场景重建。 */
  restartStoryWorld(nextOptions: Omit<TOptions, 'signal' | 'onReady' | 'onError'>, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    return new Promise<void>((resolve, reject) => {
      let finished = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      // 子控制器：取消/超时真正中止新场景的加载。只 reject 的话，晚到的 open() 仍会跑完并盖掉错误页。
      const controller = new AbortController();
      const forwardAbort = () => controller.abort(signal.reason);
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener('abort', forwardAbort, { once: true });
      const done = (error?: unknown) => {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        signal.removeEventListener('abort', forwardAbort);
        if (error) reject(error); else resolve();
      };
      const abort = () => done(signal.reason ?? new Error('剧情世界切换已取消'));
      signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => {
        const error = new Error('剧情世界切换超时');
        controller.abort(error);
        done(error);
      }, STORY_WORLD_SWITCH_TIMEOUT_MS);
      this.host.setLoadingWorld(true);
      this.beginSwitch();
      try {
        this.host.restartScene({
          ...nextOptions,
          signal: controller.signal,
          onReady: () => done(),
          onError: (error: unknown) => done(error),
        } as TOptions);
      } catch (error) {
        this.openTask = undefined;
        this.settleOpenStarted = undefined;
        done(error);
      }
    });
  }

  /**
   * 进图即触发的剧情：加载页留到第一幕画出来再收。
   * 没有剧情时立即收起加载页。
   */
  async holdEntryLoading(
    entryStory: (() => Promise<boolean>) | undefined,
    ui: Pick<StoryContext['ui'], 'loaded' | 'failed'>,
    director: { onPresentationStarted?: () => void },
    playStory: (work: () => Promise<boolean>) => Promise<boolean>,
  ): Promise<void> {
    if (!entryStory) {
      ui.loaded();
      return;
    }
    const started = new Promise<void>(resolve => { this.entryStoryStarted = resolve; });
    director.onPresentationStarted = () => this.finishEntryStory(director);
    const story = playStory(entryStory);
    void story.then(() => this.finishEntryStory(director));
    await started;
    if (!ui.failed) ui.loaded();
  }

  /** 第一幕出现、或这段剧情没有演出直接结束：都算加载完成。重复调用无副作用。 */
  finishEntryStory(director: { onPresentationStarted?: () => void }): void {
    const resolve = this.entryStoryStarted;
    this.entryStoryStarted = undefined;
    director.onPresentationStarted = undefined;
    resolve?.();
  }
}

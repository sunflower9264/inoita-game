import { displaySettings } from './display-settings.ts';
import { currentRefreshRate, detectRefreshRate, refreshRateKnown, resolveFrameLimit, setRefreshRate } from './frame-pacing.ts';
import { resetAudioContext, resumeAudioContext } from './game-audio.ts';
import { requestNativeFrameRate } from './native-frame-rate.ts';

/** 启动后第一次补测刷新率的延迟；启动初期 rAF 可能还没按高刷回调。 */
export const REFRESH_RECHECK_AFTER_BOOT_MS = 3000;
/** 进图/读档加载结束后补测刷新率的延迟；此时加载压力已经结束。 */
export const REFRESH_RECHECK_AFTER_START_MS = 1200;

/**
 * 手机键盘弹出/收起会改变 visualViewport 的尺寸和偏移，但这不是游戏画布尺寸变化。
 * 文本输入框聚焦期间保持当前画布、面板和固定输入框的位置；失焦后的键盘收起事件
 * 会再次触发布局，届时才按恢复后的可视区重排。否则整个菜单会跟着输入框被顶上去。
 */
export function editingText(): boolean {
  if (typeof document === 'undefined') return false;
  const active = document.activeElement;
  if (!active) return false;
  return (typeof HTMLInputElement !== 'undefined' && active instanceof HTMLInputElement)
    || (typeof HTMLTextAreaElement !== 'undefined' && active instanceof HTMLTextAreaElement)
    || (typeof HTMLElement !== 'undefined' && active instanceof HTMLElement && active.isContentEditable);
}

/** 推迟到浏览器首帧绘制之后执行低优先级后台工作（如职业选择界面的提前预载）。 */
export function afterFirstPaint(work: () => void): void {
  requestAnimationFrame(() => setTimeout(work, 0));
}

/** 合并同帧多次窗口/可视区变更事件并按当前文本输入状态排版；返回解除监听的函数。 */
export function installViewportLayoutScheduler(
  onLayout: (options: { keepSize: boolean }) => void,
): () => void {
  let layoutFrame = 0;
  const schedule = (): void => {
    cancelAnimationFrame(layoutFrame);
    layoutFrame = requestAnimationFrame(() => {
      onLayout({ keepSize: editingText() });
    });
  };
  for (const event of ['resize', 'orientationchange', 'pageshow']) {
    window.addEventListener(event, schedule);
  }
  window.visualViewport?.addEventListener('resize', schedule);
  window.visualViewport?.addEventListener('scroll', schedule);
  return () => {
    cancelAnimationFrame(layoutFrame);
    for (const event of ['resize', 'orientationchange', 'pageshow']) {
      window.removeEventListener(event, schedule);
    }
    window.visualViewport?.removeEventListener('resize', schedule);
    window.visualViewport?.removeEventListener('scroll', schedule);
  };
}

export interface DisplayFramePacingHost {
  setFpsLimit(limit: number): void;
  applyRenderScale(): void;
}

/**
 * 串联渲染倍率、目标帧率、原生壳显示模式切换事件与高刷屏补测。
 * 与 Phaser 具体类解耦，通过极简回调驱动 `loop.setFPSLimit` 与 `configureCanvas`。
 */
export function installDisplayFramePacing(host: DisplayFramePacingHost): {
  remeasureAfterStart(): void;
  dispose(): void;
} {
  let disposed = false;
  const unsubscribeRenderScale = displaySettings.subscribeRenderScale(() => {
    if (!disposed) host.applyRenderScale();
  });
  const applyFrameLimit = (): void => {
    if (disposed) return;
    host.setFpsLimit(resolveFrameLimit(displaySettings.frameRateLimit, currentRefreshRate()));
  };
  const unsubscribeFrameRate = displaySettings.subscribeFrameRateLimit(applyFrameLimit);
  const remeasureNow = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      void detectRefreshRate().then(applyFrameLimit);
    }
  };

  // 玩家选的帧率也告诉安卓壳：壳会选一个刷新率能整除它的屏幕模式，
  // 避免 60 帧在 90Hz 屏上反复在 1 个和 2 个屏幕节拍之间跳。
  let nativeFrameRate = 0;
  const syncNativeFrameRate = (): void => {
    const rate = displaySettings.frameRateLimit;
    if (rate === nativeFrameRate) return;
    nativeFrameRate = rate;
    requestNativeFrameRate(rate);
  };
  syncNativeFrameRate();
  const unsubscribeNativeFrameRate = displaySettings.subscribeFrameRateLimit(syncNativeFrameRate);

  // 壳选好显示模式后把真实刷新率写进页面；直接采用，不再靠 rAF 重测。
  const applyNativeDisplayRate = (): void => {
    const hz = (globalThis as { __inoitaDisplayHz?: number }).__inoitaDisplayHz;
    if (typeof hz !== 'number' || !(hz > 0)) return;
    setRefreshRate(hz);
    applyFrameLimit();
  };
  applyNativeDisplayRate();
  window.addEventListener('inoita-display-rate', applyNativeDisplayRate);

  // 刷新率要等页面跑起来才量得到；量到之前按 60Hz 处理，60 档先按 90 的上限跑。
  void detectRefreshRate().then(applyFrameLimit);
  // 启动初期浏览器可能还没按高刷回调，量到的值会偏低；3 秒后补测一次。
  const settleRefreshTimer = window.setTimeout(remeasureNow, REFRESH_RECHECK_AFTER_BOOT_MS);
  // 进图/读档完成时加载压力已经结束，此时再量一次，拿到的才是屏幕真实节奏。
  let startRefreshTimer = 0;
  const remeasureAfterStart = (): void => {
    window.clearTimeout(startRefreshTimer);
    startRefreshTimer = window.setTimeout(remeasureNow, REFRESH_RECHECK_AFTER_START_MS);
  };
  // 页面在后台启动时 rAF 不跑，第一次会量不到；恢复可见后补测一次再换算限帧。
  const remeasureWhenVisible = (): void => {
    if (refreshRateKnown() || typeof document === 'undefined' || document.visibilityState !== 'visible') return;
    void detectRefreshRate().then(applyFrameLimit);
  };
  document.addEventListener('visibilitychange', remeasureWhenVisible);
  window.addEventListener('pageshow', remeasureWhenVisible);

  return {
    remeasureAfterStart,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      unsubscribeRenderScale();
      unsubscribeFrameRate();
      unsubscribeNativeFrameRate();
      window.removeEventListener('inoita-display-rate', applyNativeDisplayRate);
      window.clearTimeout(settleRefreshTimer);
      window.clearTimeout(startRefreshTimer);
      document.removeEventListener('visibilitychange', remeasureWhenVisible);
      window.removeEventListener('pageshow', remeasureWhenVisible);
    },
  };
}

export interface WebAudioRecoverySoundHost {
  pauseOnBlur: boolean;
  readonly locked: boolean;
  readonly context?: {
    readonly state: string;
    resume(): Promise<void>;
    suspend(): Promise<void>;
  } | null;
  readonly onGameVisible?: (...args: unknown[]) => void;
}

export interface WebAudioRecoveryHost {
  readonly isIOS: boolean;
  readonly sound: WebAudioRecoverySoundHost;
  emitBlur(): void;
  emitFocus(): void;
  removeDefaultVisibleListener(listener: (...args: unknown[]) => void): void;
}

/**
 * 接管 iOS 键盘失焦/回前台后的音频上下文恢复：
 * 避免软键盘弹出误停音频循环，并接住 Phaser 默认 VISIBLE 回调在 iOS 上的异步拒绝。
 */
export function installWebAudioRecovery(host: WebAudioRecoveryHost): () => void {
  const { isIOS, sound } = host;
  sound.pauseOnBlur = false;
  const onBlur = () => { if (!editingText()) host.emitBlur(); };
  const onFocus = () => host.emitFocus();
  window.onblur = onBlur;
  window.onfocus = onFocus;

  if (sound.onGameVisible) host.removeDefaultVisibleListener(sound.onGameVisible);

  let resumeFailureLogged = false;
  const reportFailure = (trigger: string) => (error: unknown) => {
    if (resumeFailureLogged) return;
    resumeFailureLogged = true;
    globalThis.storyDiagnostics?.record('audio-resume-failed', {
      state: sound.context?.state ?? 'missing',
      hidden: document.visibilityState !== 'visible',
      trigger,
      reason: error instanceof Error ? error.message : String(error),
    }, false);
  };
  const resumeAudio = (gesture: boolean, trigger: string) => resumeAudioContext(sound.context ?? undefined, {
    visible: () => document.visibilityState === 'visible',
    locked: () => sound.locked,
    gesture,
    // 自动事件没有用户手势，iOS 的拒绝是预期内的，不占用唯一一条诊断。
    onFailure: gesture ? reportFailure(trigger) : undefined,
  });

  let appleResetTimer = 0;
  const recoverVisible = () => {
    if (document.visibilityState !== 'visible') return;
    // iOS 17/18 回前台后上下文可能报 running 却发不出声音，照 Phaser 原来的做法
    // 先挂起再恢复；其它平台只补一次普通 resume。
    if (isIOS) {
      window.clearTimeout(appleResetTimer);
      appleResetTimer = window.setTimeout(() => resetAudioContext(sound.context ?? undefined, {
        visible: () => document.visibilityState === 'visible',
        onFailure: reportFailure('visible'),
      }), 100);
      return;
    }
    resumeAudio(false, 'visible');
  };

  const pointerDown = () => resumeAudio(true, 'pointerdown');
  const focused = () => resumeAudio(false, 'focus');
  window.addEventListener('pointerdown', pointerDown, { capture: true });
  window.addEventListener('focus', focused);
  document.addEventListener('visibilitychange', recoverVisible);
  window.addEventListener('pageshow', recoverVisible);

  return () => {
    window.clearTimeout(appleResetTimer);
    if (window.onblur === onBlur) window.onblur = null;
    if (window.onfocus === onFocus) window.onfocus = null;
    window.removeEventListener('pointerdown', pointerDown, true);
    window.removeEventListener('focus', focused);
    document.removeEventListener('visibilitychange', recoverVisible);
    window.removeEventListener('pageshow', recoverVisible);
  };
}

export interface SuspendableScenePort {
  isActive(): boolean;
  isPaused(): boolean;
  pause(): void;
  resume(): void;
}

export interface PageSuspensionHost {
  isAlreadySuspended(): boolean;
  flushForBackground(): void;
  setUiSuspended(suspended: boolean): void;
  hasLockOwner(owner: string): boolean;
  currentScene(): SuspendableScenePort | undefined;
  storyStageScene(): SuspendableScenePort | undefined;
  pauseAllSound(): void;
  resumeAllSound(): void;
  unlockSound(): void;
  resetInput(): void;
}

/** 竖屏锁屏、页面隐藏与失焦保护：切后台前同步落一次自动存档，并在切回横屏/前台时恢复未锁定场景。 */
export function installPageSuspensionLifecycle(host: PageSuspensionHost): {
  sync(): void;
  dispose(): void;
} {
  const portrait = window.matchMedia('(orientation: portrait)');
  const setSuspended = (suspended: boolean): void => {
    host.setUiSuspended(suspended);
    const scene = host.currentScene();
    // 同一帧内的 pagehide/pageshow 也按事件顺序排队，避免漏掉恢复。
    if (scene && (scene.isActive() || scene.isPaused())) {
      if (suspended) scene.pause();
      else if (!host.hasLockOwner('pressure-debug')) scene.resume();
    }
    const stage = host.storyStageScene();
    if (stage && (stage.isActive() || stage.isPaused())) {
      if (suspended) stage.pause();
      else stage.resume();
    }
    if (suspended) host.pauseAllSound();
    else host.resumeAllSound();
  };

  const sync = (): void => {
    // WebKit 可能在保留的 MediaQueryList 之前就更新了视口尺寸。
    const suspended = document.hidden || window.innerHeight > window.innerWidth;
    // 进入后台或竖屏前先同步落一次自动存档，避免进程被系统回收时丢掉最近的进度。
    if (suspended && !host.isAlreadySuspended()) host.flushForBackground();
    setSuspended(suspended);
  };

  let orientationFrame = 0;
  const onOrientation = (): void => {
    sync();
    cancelAnimationFrame(orientationFrame);
    orientationFrame = requestAnimationFrame(sync);
  };
  const onBlur = (): void => host.resetInput();
  const onPageHide = (): void => setSuspended(true);
  const onPointerUnlock = (): void => host.unlockSound();

  document.addEventListener('visibilitychange', sync);
  window.addEventListener('resize', sync);
  window.addEventListener('orientationchange', onOrientation);
  window.visualViewport?.addEventListener('resize', sync);
  portrait.addEventListener('change', sync);
  window.addEventListener('blur', onBlur);
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('pageshow', sync);
  document.addEventListener('pointerdown', onPointerUnlock, { once: true });
  sync();

  return {
    sync,
    dispose: () => {
      cancelAnimationFrame(orientationFrame);
      document.removeEventListener('visibilitychange', sync);
      window.removeEventListener('resize', sync);
      window.removeEventListener('orientationchange', onOrientation);
      window.visualViewport?.removeEventListener('resize', sync);
      portrait.removeEventListener('change', sync);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', sync);
      document.removeEventListener('pointerdown', onPointerUnlock);
    },
  };
}

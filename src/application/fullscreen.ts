/**
 * 浏览器全屏开关。
 *
 * 全屏是浏览器能力，不是游戏状态：不写 localStorage，也不进存档。设置页按
 * `fullscreenSupported()` 决定是否显示这一项——iPhone Safari 没有 Fullscreen API；
 * 项目自带的 Android WebView 壳没有接宿主全屏回调（APK 本身用隐藏系统栏实现沉浸式），
 * 这两处点了都不会有反应，所以直接不显示。
 */
type LegacyDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitFullscreenEnabled?: boolean;
  webkitExitFullscreen?: () => void;
};
type LegacyElement = HTMLElement & { webkitRequestFullscreen?: () => void | Promise<void> };
/** `lock()` 不在 TypeScript 的 DOM 类型里，运行时只有部分移动浏览器提供。 */
type LockableOrientation = ScreenOrientation & { lock?: (orientation: string) => Promise<void> };

/** APK 内页面的固定源；该 WebView 壳没有实现全屏回调。 */
const PACKAGED_HOST = 'appassets.androidplatform.net';

function legacyDocument(): LegacyDocument | undefined {
  return typeof document === 'undefined' ? undefined : document as LegacyDocument;
}

/** 全屏在此环境的可用状态：可用、APK 壳（已沉浸式）、浏览器不支持。 */
export type FullscreenStatus = 'available' | 'packaged' | 'unsupported';

/** 判断当前环境能否进入浏览器全屏，以及不能时的原因。 */
export function fullscreenStatus(): FullscreenStatus {
  const doc = legacyDocument();
  if (!doc) return 'unsupported';
  if (typeof location !== 'undefined' && location.hostname === PACKAGED_HOST) return 'packaged';
  const element = doc.documentElement as LegacyElement;
  const request = element.requestFullscreen ?? element.webkitRequestFullscreen;
  const enabled = doc.fullscreenEnabled ?? doc.webkitFullscreenEnabled;
  return typeof request === 'function' && enabled !== false ? 'available' : 'unsupported';
}

/** 当前是否处于浏览器全屏。 */
export function fullscreenActive(): boolean {
  const doc = legacyDocument();
  return Boolean(doc?.fullscreenElement ?? doc?.webkitFullscreenElement);
}

/** 进入或退出全屏；进入时顺带尝试锁定横屏。 */
export function setFullscreen(enabled: boolean): void {
  const doc = legacyDocument();
  if (!doc) return;
  if (enabled) {
    const element = doc.documentElement as LegacyElement;
    const request = element.requestFullscreen ?? element.webkitRequestFullscreen;
    if (!request) return;
    const entering = request.call(element) as void | Promise<void>;
    // 横屏锁定要求文档已经进入全屏；等 request 完成再试，旧 WebKit 不返回 Promise 时直接试。
    if (entering && typeof entering.then === 'function') entering.then(lockLandscape, () => {});
    else lockLandscape();
    return;
  }
  const exit = doc.exitFullscreen ?? doc.webkitExitFullscreen;
  if (exit) ignoreRejection(exit.call(doc));
}

/** 监听全屏状态变化（含浏览器自身的退出操作）；返回取消订阅函数。 */
export function onFullscreenChange(listener: () => void): () => void {
  const doc = legacyDocument();
  if (!doc) return () => {};
  doc.addEventListener('fullscreenchange', listener);
  doc.addEventListener('webkitfullscreenchange', listener);
  return () => {
    doc.removeEventListener('fullscreenchange', listener);
    doc.removeEventListener('webkitfullscreenchange', listener);
  };
}

function lockLandscape(): void {
  try {
    if (typeof screen === 'undefined') return;
    const orientation = screen.orientation as LockableOrientation | undefined;
    if (typeof orientation?.lock !== 'function') return;
    ignoreRejection(orientation.lock('landscape'));
  } catch {
    // 桌面浏览器和 iOS 不支持方向锁定，忽略即可。
  }
}

function ignoreRejection(result: unknown): void {
  const pending = result as Promise<void> | undefined;
  if (pending && typeof pending.catch === 'function') pending.catch(() => {});
}

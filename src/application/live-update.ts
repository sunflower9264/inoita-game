/**
 * 原生热更新壳的网页侧接线。
 *
 * 壳在标题页加载完成后需要知道「新版本能正常启动」，才会提交这次更新；
 * 没收到信号就回退上一版。网页只负责发这一下。
 */

interface InotiaNativeBridge {
  markBootOk?: () => void;
}

declare global {
  var InotiaNative: InotiaNativeBridge | undefined;
}

let bootReadySent = false;

/** 标题页资源加载完成后调用；同一个页面生命周期只发一次。 */
export function notifyBootReady(): void {
  if (bootReadySent) return;
  bootReadySent = true;
  try { globalThis.InotiaNative?.markBootOk?.(); } catch { /* 原生桥不可用时忽略 */ }
}

/**
 * 生产构建信任构建期内容校验的结果：运行时只做 JSON.parse，不重复跑语义校验。
 *
 * 开发服务、Node 测试与直接 import 时构建常量不存在，默认 false；
 * 构建期由 Vite define 注入 true。GM/显式 ?validate 必须走完整校验。
 */
declare const __STORY_TRUST_CONTENT__: boolean;

const injected = typeof __STORY_TRUST_CONTENT__ === 'boolean' ? __STORY_TRUST_CONTENT__ : false;

/** 当前页面是否可以使用信任路径；GM 与 ?validate 强制完整校验。 */
export function trustedContentNow(): boolean {
  if (!injected) return false;
  if (typeof location !== 'undefined') {
    const params = new URLSearchParams(location.search);
    if (params.has('gm') || params.has('validate')) return false;
  }
  return true;
}

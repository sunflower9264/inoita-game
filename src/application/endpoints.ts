/**
 * 服务地址的唯一解析入口。
 *
 * 网页始终同源（= 页面和接口在同一个域名和端口），空字符串表示请求相对的
 * `/__cloud` 和 `/__diagnostics/report`。Android/热更新页面由宿主在脚本运行前
 * 注入 `__inoitaEndpoints`；路径固定，环境只配服务根地址。
 */
export const CLOUD_PATH = '/__cloud';
export const DIAGNOSTICS_REPORT_PATH = '/__diagnostics/report';

/** 宿主注入的地址表协议版本；结构变更时加一，旧版本整体降级为同源默认。 */
const RUNTIME_ENDPOINTS_VERSION = 1;

interface RuntimeEndpoints {
  version: typeof RUNTIME_ENDPOINTS_VERSION;
  /** 完整的云存档基址；空串表示同源。 */
  cloudBase: string;
  /** 完整的诊断上报地址；空串表示同源。 */
  diagnosticsReport: string;
}

interface EndpointGlobals {
  __inoitaEndpoints?: unknown;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function emptyEndpoints(): RuntimeEndpoints {
  return { version: RUNTIME_ENDPOINTS_VERSION, cloudBase: '', diagnosticsReport: '' };
}

/**
 * 校验一个完整服务地址：空串表示同源；否则必须是 HTTPS，或本机调试的
 * localhost/127.0.0.1 HTTP。路径必须是约定的服务路径，防止把根地址填进
 * 完整地址字段后悄悄请求到 `/register`。
 */
function normalizeEndpoint(value: unknown, suffix: string): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  let url: URL;
  try { url = new URL(trimmed); } catch { return undefined; }
  if (url.username || url.password || url.search || url.hash) return undefined;
  const local = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return undefined;
  if (!url.pathname.endsWith(suffix)) return undefined;
  return url.toString().replace(/\/+$/, '');
}

/** 校验环境配置里的服务根地址；空串只给网页同源用。 */
export function endpointConfigProblem(base: string): string | undefined {
  const trimmed = base.trim().replace(/\/+$/, '');
  if (!trimmed) return undefined;
  let url: URL;
  try { url = new URL(trimmed); } catch { return '服务地址格式无效。'; }
  if (url.username || url.password) return '服务地址不能包含账号或密码。';
  if (url.search || url.hash) return '服务地址不能带查询参数或锚点。';
  const local = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))
    return '服务地址必须使用 HTTPS；本机调试可用 localhost/127.0.0.1 的 HTTP。';
  return undefined;
}

/** 由服务根地址派生两个固定接口地址；空根地址表示网页同源。 */
export function endpointsFromBase(base: string): RuntimeEndpoints {
  const normalized = base.trim().replace(/\/+$/, '');
  if (!normalized) return emptyEndpoints();
  return {
    version: RUNTIME_ENDPOINTS_VERSION,
    cloudBase: `${normalized}${CLOUD_PATH}`,
    diagnosticsReport: `${normalized}${DIAGNOSTICS_REPORT_PATH}`,
  };
}

/**
 * 读取宿主注入的地址。网页没有注入时就是同源默认；Android/热更新必须注入
 * 当前协议版本的对象。非法字段单独降级为空，不把坏地址交给网络层。
 */
export function resolveEndpoints(globals: EndpointGlobals = globalThis as EndpointGlobals): RuntimeEndpoints {
  const raw = globals.__inoitaEndpoints;
  if (!raw || typeof raw !== 'object' || (raw as { version?: unknown }).version !== RUNTIME_ENDPOINTS_VERSION) return emptyEndpoints();
  const record = raw as { cloudBase?: unknown; diagnosticsReport?: unknown };
  return {
    version: RUNTIME_ENDPOINTS_VERSION,
    cloudBase: normalizeEndpoint(record.cloudBase, CLOUD_PATH) ?? '',
    diagnosticsReport: normalizeEndpoint(record.diagnosticsReport, DIAGNOSTICS_REPORT_PATH) ?? '',
  };
}

/** 传给 CloudSaveClient 的云存档基址；空串让客户端走同源相对路径。 */
export function cloudBaseUrl(): string {
  return resolveEndpoints().cloudBase;
}

/** 诊断上报地址；没有显式地址时回退同源固定路径。 */
export function diagnosticsReportUrl(): string {
  return resolveEndpoints().diagnosticsReport || DIAGNOSTICS_REPORT_PATH;
}

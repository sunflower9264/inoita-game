import { spawnSync } from 'node:child_process';
import type { KeyObject } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import type { BuildMeta } from './build-version.ts';
import { BUILD_META_FILENAME } from './build-version.ts';
import { parseManifest, parsePointer, sha256Hex, verifyBytes, type UpdatePointer } from './update-manifest.ts';
import { readUpdatePublicKey } from './update-key.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** 线上入口：nginx 终止 TLS 后转发到本机 4004 的静态服务。 */
const DEFAULT_DEPLOY_URL = 'https://catgo.online:4002';
/** 构建刚替换 dist 时服务可能短暂不可用：最多探测 5 次，重试间隔 300 ms。 */
const BUILD_PROBE_ATTEMPTS = 5;
const BUILD_PROBE_RETRY_DELAY_MS = 300;
const BUILD_PROBE_TIMEOUT_MS = 1200;
/** 首页与入口 bundle 的验收请求超时。 */
const VERIFY_REQUEST_TIMEOUT_MS = 2000;
/** 拉取更新指针和清单的超时。 */
const UPDATE_FETCH_TIMEOUT_MS = 4000;

export function compareBuild(local: BuildMeta, remote: BuildMeta): { ok: boolean; reason?: string } {
  if (local.builtAt !== remote.builtAt) return { ok: false, reason: `builtAt 不一致：本地 ${local.builtAt}，服务 ${remote.builtAt}` };
  if (local.assetVersion !== remote.assetVersion)
    return { ok: false, reason: `assetVersion 不一致：本地 ${local.assetVersion}，服务 ${remote.assetVersion}` };
  if (local.contentVersion !== remote.contentVersion)
    return { ok: false, reason: `contentVersion 不一致：本地 ${local.contentVersion}，服务 ${remote.contentVersion}` };
  return { ok: true };
}

function run(command: string, args: string[]): void {
  // Windows 不能直接用 CreateProcess 启动 .cmd，必须经过 shell；否则 npm.cmd 返回 EINVAL。
  const result = spawnSync(command, args, {
    cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' && /\.cmd$/i.test(command)
  });
  if (result.error) throw new Error(`命令启动失败：${path.basename(command)} ${args.join(' ')}（${result.error.message}）`);
  if (result.status !== 0) throw new Error(`命令失败：${path.basename(command)} ${args.join(' ')}`);
}

async function remoteBuild(base: string): Promise<{ meta?: BuildMeta; error?: string }> {
  let lastError = '';
  for (let attempt = 0; attempt < BUILD_PROBE_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(`${base}/__build`, { signal: AbortSignal.timeout(BUILD_PROBE_TIMEOUT_MS) });
      if (!response.ok) { lastError = `HTTP ${response.status}`; }
      else {
        const value = await response.json() as { meta?: BuildMeta };
        if (value.meta) return { meta: value.meta };
        lastError = '响应缺少 meta';
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (attempt + 1 < BUILD_PROBE_ATTEMPTS) await sleep(BUILD_PROBE_RETRY_DELAY_MS);
  }
  return { error: lastError };
}

function parseArgs(argv: string[]): { base: string; skipBuild: boolean } {
  // 本机 4002 现在由 nginx 终止 TLS，再转发到 127.0.0.1:4004 的静态服务。
  let base = process.env.STORY_DEPLOY_URL ?? DEFAULT_DEPLOY_URL, skipBuild = false;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (value === '--skip-build') skipBuild = true;
    else if (value === '--url') base = argv[++index] ?? base;
    else if (value.startsWith('--url=')) base = value.slice('--url='.length);
  }
  return { base: base.replace(/\/+$/, ''), skipBuild };
}

async function verifyServed(base: string, meta: BuildMeta): Promise<void> {
  const page = await fetch(`${base}/`, { signal: AbortSignal.timeout(VERIFY_REQUEST_TIMEOUT_MS) });
  if (!page.ok) throw new Error(`首页返回 HTTP ${page.status}`);
  const html = await page.text();
  const bundle = /bundles\/[^"']+\.js/.exec(html)?.[0];
  if (!bundle) throw new Error('首页没有引用 bundles/*.js');
  const script = await fetch(`${base}/${bundle}`, { signal: AbortSignal.timeout(VERIFY_REQUEST_TIMEOUT_MS) });
  if (!script.ok) throw new Error(`入口 bundle 返回 HTTP ${script.status}`);
  const asset = await fetch(`${base}/assets/ui/app-icon.png?v=${encodeURIComponent(meta.assetVersion)}`,
    { method: 'HEAD', signal: AbortSignal.timeout(VERIFY_REQUEST_TIMEOUT_MS) });
  if (!asset.ok) throw new Error(`版本化资源返回 HTTP ${asset.status}`);
  if (!(asset.headers.get('cache-control') ?? '').includes('immutable'))
    throw new Error('版本化资源的 Cache-Control 不是 immutable');
}

async function fetchUpdateBytes(url: string): Promise<Buffer> {
  // nginx 可能缓存指针；显式要求回源，避免刚部署就比对到上一版。
  const response = await fetch(url, {
    headers: { 'cache-control': 'no-cache', pragma: 'no-cache' },
    signal: AbortSignal.timeout(UPDATE_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${url} 返回 HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function fetchSignedJson<T>(
  base: string, relative: string, parse: (value: unknown) => T, publicKey: KeyObject,
): Promise<{ value: T; bytes: Buffer }> {
  const [bytes, signature] = await Promise.all([
    fetchUpdateBytes(`${base}/${relative}`),
    fetchUpdateBytes(`${base}/${relative}.sig`),
  ]);
  if (!verifyBytes(bytes, signature.toString('utf8'), publicKey)) throw new Error(`${relative} 签名无效`);
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error(`${relative} 不是有效 JSON`); }
  return { value: parse(value), bytes };
}

async function verifyRemoteUpdate(
  base: string, pointerName: string, local: UpdatePointer, publicKey: KeyObject, label: string,
): Promise<UpdatePointer> {
  const remote = await fetchSignedJson(base, pointerName, parsePointer, publicKey);
  if (remote.value.buildId !== local.buildId)
    throw new Error(`${label}指针 buildId 不一致：本地 ${local.buildId}，服务 ${remote.value.buildId}`);
  if (remote.value.manifestSha256 !== local.manifestSha256)
    throw new Error(`${label}指针 manifestSha256 与本地不一致`);
  const manifest = await fetchSignedJson(base, remote.value.manifest, parseManifest, publicKey);
  if (sha256Hex(manifest.bytes) !== remote.value.manifestSha256)
    throw new Error(`${label}清单 SHA-256 与指针不一致`);
  if (manifest.value.buildId !== remote.value.buildId)
    throw new Error(`${label}清单 buildId 与指针不一致`);
  console.log(`更新清单已核对：${label} ${remote.value.buildId}，${manifest.value.files.length} 个文件`);
  return remote.value;
}

async function verifyUpdate(base: string): Promise<void> {
  const publicKey = readUpdatePublicKey();
  let stableBytes: Buffer;
  try { stableBytes = await readFile(path.join(ROOT, 'dist', 'update', 'latest.json')); }
  catch { throw new Error('dist/update/latest.json 不存在；先生成私钥并运行 npm run build'); }
  const localStable = parsePointer(JSON.parse(stableBytes.toString('utf8')));
  await verifyRemoteUpdate(base, 'update/latest.json', localStable, publicKey, '正式');

  let stagingText: string | undefined;
  try { stagingText = await readFile(path.join(ROOT, 'dist', 'update', 'latest-staging.json'), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (stagingText) {
    const localStaging = parsePointer(JSON.parse(stagingText));
    const remoteStaging = await verifyRemoteUpdate(base, 'update/latest-staging.json', localStaging, publicKey, '自测');
    if (remoteStaging.buildId !== localStable.buildId)
      throw new Error('自测指针与正式指针没有指向同一份清单');
  }
}

async function main(): Promise<number> {
  const { base, skipBuild } = parseArgs(process.argv.slice(2));
  if (!skipBuild) {
    try {
      run(process.execPath, [path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit']);
      // 走 npm run build，确保 prebuild 的图集生成先执行；直接调 build.mjs 会跳过它。
      run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build']);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }
  let local: BuildMeta;
  try {
    local = JSON.parse(await readFile(path.join(ROOT, 'dist', BUILD_META_FILENAME), 'utf8')) as BuildMeta;
  } catch {
    console.error('dist 缺少 .build-meta.json，请先运行 npm run build（或去掉 --skip-build）。');
    return 1;
  }
  const remote = await remoteBuild(base);
  if (!remote.meta) {
    console.error(`构建完成，但 ${base} 的打包服务没有响应（${remote.error ?? '未知原因'}）。`);
    console.error('启动：systemctl --user restart inoita-game，或在项目根目录运行 npm run serve');
    return 2;
  }
  const compared = compareBuild(local, remote.meta);
  if (!compared.ok) {
    console.error(`${base} 仍在提供旧构建：${compared.reason}`);
    console.error('如果服务刚启动或构建刚刚替换，请重跑本脚本；否则检查服务是否指向 dist/。');
    return 3;
  }
  try {
    await verifyServed(base, local);
    await verifyUpdate(base);
  } catch (error) {
    console.error(`版本一致，但 HTTP 验收失败：${error instanceof Error ? error.message : String(error)}`);
    return 3;
  }
  console.log(`已同步：${base}/`);
  console.log(`builtAt ${local.builtAt}`);
  console.log(`assetVersion ${local.assetVersion} / contentVersion ${local.contentVersion}`);
  console.log('资源带内容版本并长缓存；index.html 与诊断脚本按 no-cache 校验。');
  return 0;
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (invoked) main().then(code => process.exit(code), error => { console.error(error); process.exit(1); });

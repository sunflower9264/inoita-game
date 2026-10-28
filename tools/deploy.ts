import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import type { BuildMeta } from './build-version.ts';
import { BUILD_META_FILENAME } from './build-version.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export function compareBuild(local: BuildMeta, remote: BuildMeta): { ok: boolean; reason?: string } {
  if (local.builtAt !== remote.builtAt) return { ok: false, reason: `builtAt 不一致：本地 ${local.builtAt}，服务 ${remote.builtAt}` };
  if (local.assetVersion !== remote.assetVersion)
    return { ok: false, reason: `assetVersion 不一致：本地 ${local.assetVersion}，服务 ${remote.assetVersion}` };
  if (local.contentVersion !== remote.contentVersion)
    return { ok: false, reason: `contentVersion 不一致：本地 ${local.contentVersion}，服务 ${remote.contentVersion}` };
  return { ok: true };
}

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`命令失败：${path.basename(command)} ${args.join(' ')}`);
}

async function remoteBuild(base: string): Promise<{ meta?: BuildMeta; error?: string }> {
  let lastError = '';
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = await fetch(`${base}/__build`, { signal: AbortSignal.timeout(1200) });
      if (!response.ok) { lastError = `HTTP ${response.status}`; }
      else {
        const value = await response.json() as { meta?: BuildMeta };
        if (value.meta) return { meta: value.meta };
        lastError = '响应缺少 meta';
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (attempt < 4) await sleep(300);
  }
  return { error: lastError };
}

function parseArgs(argv: string[]): { base: string; skipBuild: boolean } {
  // 本机 4002 现在由 nginx 终止 TLS，再转发到 127.0.0.1:4004 的静态服务。
  let base = process.env.STORY_DEPLOY_URL ?? 'https://catgo.online:4002', skipBuild = false;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (value === '--skip-build') skipBuild = true;
    else if (value === '--url') base = argv[++index] ?? base;
    else if (value.startsWith('--url=')) base = value.slice('--url='.length);
  }
  return { base: base.replace(/\/+$/, ''), skipBuild };
}

async function verifyServed(base: string, meta: BuildMeta): Promise<void> {
  const page = await fetch(`${base}/`, { signal: AbortSignal.timeout(2000) });
  if (!page.ok) throw new Error(`首页返回 HTTP ${page.status}`);
  const html = await page.text();
  const bundle = /bundles\/[^"']+\.js/.exec(html)?.[0];
  if (!bundle) throw new Error('首页没有引用 bundles/*.js');
  const script = await fetch(`${base}/${bundle}`, { signal: AbortSignal.timeout(2000) });
  if (!script.ok) throw new Error(`入口 bundle 返回 HTTP ${script.status}`);
  const asset = await fetch(`${base}/assets/ui/app-icon.png?v=${encodeURIComponent(meta.assetVersion)}`,
    { method: 'HEAD', signal: AbortSignal.timeout(2000) });
  if (!asset.ok) throw new Error(`版本化资源返回 HTTP ${asset.status}`);
  if (!(asset.headers.get('cache-control') ?? '').includes('immutable'))
    throw new Error('版本化资源的 Cache-Control 不是 immutable');
}

async function main(): Promise<number> {
  const { base, skipBuild } = parseArgs(process.argv.slice(2));
  if (!skipBuild) {
    try {
      run(process.execPath, [path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit']);
      run(process.execPath, [path.join(ROOT, 'tools', 'build.mjs')]);
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

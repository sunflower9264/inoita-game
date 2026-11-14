import path from 'node:path';
import process from 'node:process';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import { computeVersions, versionHtmlAssets } from './tools/build-version.ts';

/**
 * 开发服务直接读工作区，改完 `public/content/*.json` 刷新页面就能看到效果，
 * 但完整校验原先只在 `npm run build` 里跑——开发时改坏内容不会立刻被拦。
 * 这个插件把同一套校验接到开发服务上：启动跑一次，内容变动再跑，失败时
 * 终端打印错误并让浏览器弹出 Vite 的报错浮层。
 *
 * `validate-content.mjs` 是无类型的 `.mjs`，`strict` 下静态 import 会报
 * 「找不到声明文件」。这里用变量形式的动态 import 绕开解析再断言类型——
 * 不要为此把 `tools/` 加进 tsconfig 的 include，那需要打开 `types:["node"]`，
 * 会让 `src/` 下的浏览器代码也看见 Node 全局量。
 */
function contentGuard(): Plugin {
  return {
    name: 'content-guard',
    apply: 'serve',
    configureServer(server) {
      const projectRoot = server.config.root;
      const contentDir = path.join(projectRoot, 'public', 'content');
      let running = false;
      const check = async (): Promise<void> => {
        if (running) return;
        running = true;
        try {
          const guardModule = pathToFileURL(path.join(projectRoot, 'tools', 'validate-content.mjs')).href;
          const { validateContent } = await import(/* @vite-ignore */ guardModule) as { validateContent: (root: string) => unknown };
          validateContent(path.join(projectRoot, 'public'));
          server.config.logger.info('内容校验通过');
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          server.config.logger.error(`内容校验失败：${message}`);
          server.ws.send({ type: 'error', err: { message, stack: '' } });
        } finally {
          running = false;
        }
      };
      void check();
      server.watcher.add(contentDir);
      const onContentChange = (file: string): void => {
        if (path.dirname(file).startsWith(contentDir)) void check();
      };
      server.watcher.on('change', onContentChange);
      server.watcher.on('add', onContentChange);
      server.watcher.on('unlink', onContentChange);
    }
  };
}

function diagnosticCollector(): Plugin {
  return {
    name: 'client-diagnostics',
    apply: 'serve',
    async configureServer(server) {
      const moduleUrl = pathToFileURL(path.join(server.config.root, 'tools', 'diagnostic-collector.mjs')).href;
      const { createDiagnosticMiddleware } = await import(/* @vite-ignore */ moduleUrl);
      server.middlewares.use(createDiagnosticMiddleware(server.config.root));
    }
  };
}

type CloudMiddleware = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, next: () => void) => void;

/**
 * 开发服务挂同一套云存档接口，数据目录用 `.cloud-save-dev`，与生产 `.cloud-save` 分开。
 * 动态 import 沿用诊断插件的写法；加载失败只警告，不让 `npm run dev` 起不来。
 */
function cloudSaveService(): Plugin {
  return {
    name: 'cloud-save',
    apply: 'serve',
    async configureServer(server) {
      try {
        const moduleUrl = pathToFileURL(path.join(server.config.root, 'tools', 'cloud-save-service.ts')).href;
        const { createCloudSaveService } = await import(/* @vite-ignore */ moduleUrl) as {
          createCloudSaveService: (options: { dataDir: string }) => CloudMiddleware;
        };
        server.middlewares.use(createCloudSaveService({ dataDir: path.join(server.config.root, '.cloud-save-dev') }));
      } catch (error) {
        server.config.logger.warn(`云存档开发服务未启动：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };
}

interface BuildInfo {
  game: string;
  package: string;
  contentVersion: string;
  assetVersion: string;
  mode: 'build' | 'dev';
}

/** 在页面脚本之前注入版本信息，最早的一条诊断记录也能对上代码。 */
function injectBuildInfo(info: BuildInfo): Plugin {
  return {
    name: 'build-info',
    transformIndexHtml: {
      order: 'pre',
      handler: () => [{
        tag: 'script',
        children: `window.__inoitaBuild=${JSON.stringify(info)};`,
        injectTo: 'head-prepend',
      }],
    },
  };
}

function readBuildInfo(root: string, command: string, versions: { assetVersion: string; contentVersion: string }): BuildInfo {
  let packageVersion = '';
  let gameVersion = '';
  try {
    packageVersion = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version ?? '';
  } catch { /* 版本缺失不影响启动。 */ }
  try {
    const changelog = JSON.parse(readFileSync(path.join(root, 'public', 'content', 'changelog.json'), 'utf8'));
    gameVersion = changelog?.releases?.[0]?.gameVersion ?? '';
  } catch { /* 更新日志缺失时只留空。 */ }
  return {
    game: gameVersion,
    package: packageVersion,
    contentVersion: versions.contentVersion,
    assetVersion: versions.assetVersion,
    mode: command === 'build' ? 'build' : 'dev',
  };
}

function versionPublicAssets(assetVersion: string): Plugin {
  return {
    name: 'version-public-assets',
    apply: 'build',
    transformIndexHtml: {
      // 必须在 Vite 把 `/assets` 改写成 `./assets` 之后执行。
      order: 'post',
      handler(html) { return versionHtmlAssets(html, assetVersion); }
    }
  };
}

/**
 * 开发服务默认直接读 public/content，不走构建期的动画贴图合并，所以同样的场景
 * 在 4003 会比 4002/APK 多加载重复纹理。这个插件在 serve 时用同一个
 * `buildContent` 生成临时内容目录，`/content/*.json` 优先返回编译结果；内容变动
 * 自动重建，构建失败则回退源内容。代码仍从源码加载，只有内容走构建规则。
 */
function devBuiltContent(): Plugin {
  return {
    name: 'dev-built-content',
    apply: 'serve',
    async configureServer(server) {
      const projectRoot = server.config.root;
      const sourceDir = path.join(projectRoot, 'public', 'content');
      const directories = new Set<string>();
      let activeDir: string | undefined;
      let queue = Promise.resolve();
      let timer: ReturnType<typeof setTimeout> | undefined;

      const build = async (): Promise<void> => {
        const next = await fs.mkdtemp(path.join(os.tmpdir(), 'inoita-dev-content-'));
        directories.add(next);
        try {
          const moduleUrl = pathToFileURL(path.join(projectRoot, 'tools', 'content-build.ts')).href;
          const { buildContent } = await import(/* @vite-ignore */ moduleUrl) as {
            buildContent: (source: string, output: string) => Promise<{
              clipKeysBefore: number; clipKeysAfter: number; dedupedLayers: number;
            }>;
          };
          const stats = await buildContent(sourceDir, next);
          const previous = activeDir;
          activeDir = next;
          if (previous) setTimeout(() => {
            directories.delete(previous);
            void fs.rm(previous, { recursive: true, force: true });
          }, 30_000);
          server.config.logger.info(`开发内容已按生产规则编译：动画贴图键 ${stats.clipKeysBefore} -> ${stats.clipKeysAfter}，合并 ${stats.dedupedLayers} 个图层引用`);
        } catch (error) {
          directories.delete(next);
          await fs.rm(next, { recursive: true, force: true });
          server.config.logger.warn(`开发内容编译失败，继续读取 public/content：${error instanceof Error ? error.message : String(error)}`);
        }
      };

      const schedule = (): void => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = undefined;
          queue = queue.then(build);
        }, 150);
      };

      server.middlewares.use((req, res, next) => {
        const contentDir = activeDir;
        if (!contentDir || req.method !== 'GET') return next();
        const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
        if (!pathname.startsWith('/content/') || !pathname.endsWith('.json')) return next();
        let relative: string;
        try { relative = decodeURIComponent(pathname.slice('/content/'.length)); }
        catch { return next(); }
        const target = path.resolve(contentDir, relative);
        if (!target.startsWith(contentDir + path.sep)) return next();
        void fs.readFile(target).then(body => {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          res.end(body);
        }, () => next());
      });

      server.watcher.add(sourceDir);
      const onContentChange = (file: string): void => {
        if (path.dirname(file).startsWith(sourceDir)) schedule();
      };
      server.watcher.on('change', onContentChange);
      server.watcher.on('add', onContentChange);
      server.watcher.on('unlink', onContentChange);
      server.httpServer?.once('close', () => {
        if (timer) clearTimeout(timer);
        for (const directory of directories) void fs.rm(directory, { recursive: true, force: true });
      });

      await build();
    }
  };
}

// 4002 固定由打包静态服务提供；开发服务改到 4003，两者可同时运行。
// base 用相对路径，dist/ 支持独立部署到站点根目录或子目录。
export default defineConfig(({ command }) => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  let versions = { assetVersion: '', contentVersion: '' };
  if (command === 'build') {
    versions = {
      assetVersion: process.env.STORY_ASSET_VERSION ?? '',
      contentVersion: process.env.STORY_CONTENT_VERSION ?? ''
    };
    if (!versions.assetVersion || !versions.contentVersion)
      versions = computeVersions(path.join(root, 'public'));
  }
  const buildInfo = readBuildInfo(root, command, versions);
  return {
    base: './',
    publicDir: 'public',
    appType: 'mpa',
    define: {
      __STORY_ASSET_VERSION__: JSON.stringify(versions.assetVersion),
      __STORY_CONTENT_VERSION__: JSON.stringify(versions.contentVersion),
      // 生产构建信任构建期校验；dev/test/GM 走完整校验。
      __STORY_TRUST_CONTENT__: JSON.stringify(command === 'build'),
      // 开发服务与 Node 测试打开快照冻结和内部全量校验；生产构建关闭。
      __STORY_DEV_MODE__: JSON.stringify(command !== 'build')
    },
    plugins: [contentGuard(), devBuiltContent(), diagnosticCollector(), cloudSaveService(), injectBuildInfo(buildInfo), versionPublicAssets(versions.assetVersion)],
    server: {
      host: true,
      port: 4003,
      strictPort: true,
      // 子 agent 的工作树在仓库内且各自带整套素材；Android 构建产物有两万多个文件。
      // 不忽略它们会占满系统文件监听名额，开发服务直接以 ENOSPC 退出。
      watch: { ignored: ['**/.claude/**', '**/android/**', '**/dist/**', '**/.build-*/**', '**/apk-out/**'] },
      // 账号、会话和云存档文件不能通过 /@fs/ 被开发服务读出去。
      fs: { deny: ['.cloud-save/**', '.cloud-save-dev/**', '.env', '.env.*', '*.{crt,pem}', '**/.git/**'] }
    },
    // 打包产物放进 bundles/，免得和 public/assets/ 里复制过来的地图、立绘混在一起。
    build: { outDir: 'dist', target: 'es2020', assetsDir: 'bundles' }
  };
});

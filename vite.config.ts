import path from 'node:path';
import process from 'node:process';
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
  return {
    base: './',
    publicDir: 'public',
    appType: 'mpa',
    define: {
      __STORY_ASSET_VERSION__: JSON.stringify(versions.assetVersion),
      __STORY_CONTENT_VERSION__: JSON.stringify(versions.contentVersion),
      // 生产构建信任构建期校验；dev/test/GM/?validate 走完整校验。
      __STORY_TRUST_CONTENT__: JSON.stringify(command === 'build')
    },
    plugins: [contentGuard(), diagnosticCollector(), versionPublicAssets(versions.assetVersion)],
    server: { host: true, port: 4003, strictPort: true },
    // 打包产物放进 bundles/，免得和 public/assets/ 里复制过来的地图、立绘混在一起。
    build: { outDir: 'dist', target: 'es2020', assetsDir: 'bundles' }
  };
});

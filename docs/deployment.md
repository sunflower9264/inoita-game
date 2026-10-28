# 打包服务与部署

4002 固定提供 `npm run build` 的产物，4003 是 Vite 开发服务。构建、缓存头、诊断上报和部署核对都围绕这条分工。

## 本地服务

```bash
npm run serve      # 前台静态服务，提供 dist/，默认 4002，可加 --port 4010 冒烟
npm run dev        # 开发服务，读取源码，固定 4003
```

`npm run serve` 由 `tools/serve-built.ts` 读取磁盘上的 `dist/` 提供构建产物。需要长期运行时，用当前环境的进程管理器把它常驻即可；服务不依赖特定机器、用户目录或 Node 安装路径。

## 改动、构建与同步

```bash
npm run typecheck
npm run build      # 校验 public/、构建 staging、写 .build-meta.json、替换 dist/
npm run deploy     # typecheck + build + 核对 4002 正在提供的版本
```

`npm run deploy` 会读取 `dist/.build-meta.json`，请求 `http://127.0.0.1:4002/__build` 对比 `builtAt`、`assetVersion`、`contentVersion`，并确认首页和入口 bundle 可访问、版本化资源返回 `immutable` 缓存头。服务直接读磁盘，构建完成即生效，不需要重启进程；只有静态服务自身代码改动才需要重启，包括 `tools/serve-built.ts`、它在启动时导入的 `tools/diagnostic-collector.mjs` 和 `tools/build-version.ts`。

`npm run deploy` 要求本机 4002 已经在运行。没有服务时先执行 `npm run serve`，再重试。

## 缓存与诊断

- `/bundles/*` 由 Vite 生成内容哈希，静态服务返回一年 `immutable`。
- `/assets/*`、`/content/*` 的 URL 带内容版本（`?v=`）；只有版本等于当前 `dist/.build-meta.json` 时才返回 `immutable`，旧版本或无版本返回 `no-cache` + ETag。
- `index.html`、`diagnostics.js`、`manifest.webmanifest` 始终 `no-cache`，部署后刷新即可拿到新入口。
- 文本资源（JS/CSS/JSON/HTML/manifest/SVG）按需 gzip；图片与 MP3 不重复压缩。MP3 支持单段 Range（iOS 播放/seek 需要）。
- `POST /__diagnostics/report` 由 `tools/serve-built.ts` 在静态处理之前挂载 `tools/diagnostic-collector.mjs`，收到后写到 `.diagnostics/client-errors.jsonl`，每行一条 JSON，达到 2 MiB 时轮转。

## 回滚

内容回滚用 `git revert` 还原对应提交，再重新 `npm run deploy`。`dist/` 被 Git 忽略，不能靠 checkout 恢复；需要旧产物时，切到对应提交重新构建。

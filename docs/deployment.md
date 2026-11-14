# 打包服务与部署

对外入口是 `https://catgo.online:4002/`：系统 nginx 在 4002 终止 TLS，再转发到只监听本机 4004 的打包静态服务。4003 是 Vite 开发服务。构建、缓存头、诊断上报、云存档和部署核对都围绕这条分工。

## 本地服务

```bash
npm run serve      # 打包静态服务，提供 dist/，默认 127.0.0.1:4004
npm run dev        # 开发服务，读取源码，固定 4003
```

`npm run serve` 由 `tools/serve-built.ts` 读取磁盘上的 `dist/` 提供构建产物。需要长期运行时，用当前环境的进程管理器把它常驻即可；服务不依赖特定机器、用户目录或 Node 安装路径。本机常驻单元是 `inoita-game.service`，启动参数为 `--port 4004 --host 127.0.0.1`。云存档数据默认写到项目根目录的 `.cloud-save/`；本地冒烟可用 `--cloud-data /tmp/inoita-cloud` 指定独立目录，避免碰生产账号。开发服务（4003）使用 `.cloud-save-dev/`。

nginx 站点配置的仓库副本在 `deploy/nginx/catgo.online.conf`，本机放在 `/etc/nginx/sites-available/catgo.online` 并链接到 `sites-enabled`。证书由 certbot 管理，证书和私钥在 `/etc/letsencrypt/live/catgo.online/`；`certbot.timer` 已启用，续期通过 80 端口的 standalone 校验完成。nginx 读取的是 `fullchain.pem` 与 `privkey.pem`。

## 改动、构建与同步

```bash
npm run typecheck
npm run build      # 校验 public/、构建 staging、写 .build-meta.json、替换 dist/
npm run deploy     # typecheck + build + 核对 HTTPS 入口正在提供的版本
```

`npm run deploy` 会读取 `dist/.build-meta.json`，请求 `https://catgo.online:4002/__build` 对比 `builtAt`、`assetVersion`、`contentVersion`，并确认首页和入口 bundle 可访问、版本化资源返回 `immutable` 缓存头。它还会核对线上 `/update/latest.json` 的 `buildId`、`manifestSha256` 与本地一致，并拉清单验签；不一致时返回失败。可以用 `--url` 或环境变量 `STORY_DEPLOY_URL` 指定别的入口。

静态服务直接读磁盘，构建完成即生效，不需要重启进程，也不需要重启 nginx；只有静态服务自身代码改动才需要重启 4004 服务，包括 `tools/serve-built.ts`、它在启动时导入的 `tools/cloud-save-service.ts`、`tools/cloud-save-store.ts`、`tools/diagnostic-collector.mjs` 和 `tools/build-version.ts`。nginx 站点配置改动后运行 `nginx -t` 再 reload。

云存档的部署顺序是：先上线服务端代码和 `.cloud-save/` 目录并重启 4004，再改 nginx 的 `client_max_body_size 4m` 并 reload，最后构建部署客户端；需要时再打 APK。旧客户端不会调用 `/__cloud`，先服务端最安全。详细接口、数据布局和限制见 [云存档与账号](cloud-save.md)。

客户端服务地址：网页始终同源，本地 4003 和生产 4002 都不写域名；Android/热更新由宿主注入 `__inoitaEndpoints`。环境根地址集中在 `config/endpoints.json`，生产云存档和诊断共用 `https://catgo.online:4002`。规则和调试方式见 [服务地址管理](endpoints.md)。

`npm run deploy` 要求 nginx 与 4004 服务都在运行。没有服务时先执行 `systemctl --user restart inoita-game`（或在本机运行 `npm run serve`），再重试。

## 缓存与诊断

- `/bundles/*` 由 Vite 生成内容哈希，静态服务返回一年 `immutable`。
- `/update/latest.json`、`/update/latest-staging.json` 及其 `.sig` 用 `no-store`；`/update/<buildId>.json` 和 `.sig` 是内容决定的，用一年 `immutable`。
- `/assets/*`、`/content/*` 的 URL 带内容版本（`?v=`）；只有版本等于当前 `dist/.build-meta.json` 时才返回 `immutable`，旧版本或无版本返回 `no-cache` + ETag。
- `index.html`、`diagnostics.js`、`manifest.webmanifest` 始终 `no-cache`，部署后刷新即可拿到新入口。
- 文本资源（JS/CSS/JSON/HTML/manifest/SVG）按需 gzip；图片与 MP3 不重复压缩。MP3 支持单段 Range（iOS 播放/seek 需要）。
- `POST /__diagnostics/report` 由 `tools/serve-built.ts` 在静态处理之前挂载 `tools/diagnostic-collector.mjs`，nginx 原样转发；按错误和会话分流写入 `.diagnostics/client-errors.jsonl`（2 MiB × 8）和 `.diagnostics/client-session.jsonl`（8 MiB × 11），每行一条 JSON，各自轮转。
- `/__cloud/*` 由 `tools/cloud-save-service.ts` 处理，所有响应 `Cache-Control: no-store`。数据在 `.cloud-save/`：`accounts/`、`saves/`、`sessions.json`。每账号只保留一个有效 token；token 30 天有效，剩余 7 天内打开云页会续期，登录链最多 90 天；账号连续输错 3 次锁 15 分钟。备份时整个目录一起备份。
- nginx 必须允许云存档请求体：仓库配置已加 `client_max_body_size 4m`。不设置时 nginx 默认 1m 会在 Node 之前用 HTML 413 拒绝大存档。
- 云服务初始化失败时只把 `/__cloud` 降级为 503 JSON；静态首页和游戏继续提供。

## 回滚

内容回滚用 `git revert` 还原对应提交，再重新 `npm run deploy`。`dist/` 被 Git 忽略，不能靠 checkout 恢复；需要旧产物时，切到对应提交重新构建。

Android 热更新客户端不支持降级。已经发出去的更新只能靠发布一个内容正确的新构建来撤回，不能把网站换回旧构建；详见 [热更新（Android 自带 Chromium）](live-update.md)。

# config

客户端连接服务端的环境配置。这里只放公开的服务根地址，不放 token、密码或签名。

## 文件

- `endpoints.json`：按环境列出服务根地址；云存档和诊断共用同一个根地址。

## 规则

- 网页端固定同源，`web` 的 `serverBaseUrl` 始终为空；网页运行时不读取这个文件，也不需要构建时注入。
- 当前消费方：`android/app/build.gradle` 只读取 `androidRelease.serverBaseUrl`，用它派生云存档、诊断和热更地址；`tests/endpoints.test.ts` 校验环境值。`androidDebug` 由配置和测试保留，要让调试包真正走本机 4003，需要在 Gradle 按 buildType 切换。
- 两个接口路径固定：云存档 `/__cloud`，诊断 `/__diagnostics/report`。环境只改根地址。
- 生产云存档和诊断共用一个 HTTPS 基座：`https://catgo.online`。调试约定用 `adb reverse tcp:4003 tcp:4003`，根地址写 `http://127.0.0.1:4003`；网络配置对本机明文放行，所有变体共用这份配置，release 的实际服务地址仍是 HTTPS。
- 页面只读取宿主注入的 `__inoitaEndpoints`（`version`、`cloudBase`、`diagnosticsReport`），不读取其他地址变量。Android/热更新壳在页面脚本运行前注入；热更新包不写 API 域名。
- 热更新检查地址从 `androidRelease.serverBaseUrl` 派生：正式 `/update/latest.json`，自测 `/update/latest-staging.json`。下载走原生 HTTP，不需要 CORS。
- 改这里时同步 `docs/endpoints.md`、`src/application/AGENTS.md`、`android/AGENTS.md`，并运行 `tests/endpoints.test.ts`。

## 验证

```bash
npm test -- tests/endpoints.test.ts
```

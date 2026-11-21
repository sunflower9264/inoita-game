# android

自带 Chromium 的 Android 壳：把 Vite 构建出的 `dist/` 打进 APK，由 Cefrium 内置的 Chromium 156 打开。

## 文件

- 根目录：`build.gradle` 声明 Android 插件（AGP 9.4）与 Cefrium 插件，`settings.gradle` 配置模块与仓库，`gradle.properties` 放 Gradle 参数，`gradlew`、`gradlew.bat` 是包装器脚本（Gradle 9.7.1）。
- `app/build.gradle`：应用配置、`assets.srcDirs` 指向 `../dist`、从 `config/endpoints.json` 的 `androidRelease.serverBaseUrl` 派生云存档/诊断/热更地址；签名读取仓库外的 `keystore.properties`；minSdk 29、compileSdk 37、只保留 arm64-v8a。
- `app/src/main/AndroidManifest.xml` 与 `app/src/main/java/io/github/sunflower9264/inoita/MainActivity.java`：前者是清单、权限与横屏 Activity 配置，后者用 `CefriumBrowser` 承载页面、处理全屏与生命周期，并按页面报来的帧率选择显示模式。
- `InotiaApplication.java`：在 `attachBaseContext` / `onCreate` 初始化 Chromium；初始化必须早于任何 `CefriumBrowser`。
- `AssetContentServer.java`：`CefriumContentServer` 的实现，在 `CefriumProfile.getDefault()` 上注册一次，由 Cefrium 在进程内回答 `https://inoita.invalid`，不开 socket。按 `UpdateManager` 的版本快照送文件，并提供 `/__native/report`、`/__native/boot-ok`、`/__native/build-info`、`/__native/frame-rate`、`/__native/bootstrap.js`；`/__cloud` 反向代理到 `config/endpoints.json` 派生出的地址，诊断走 `Diagnostics`。
- `AssetPaths.java`：内容服务的路径规范化和 MIME/缓存规则。内容服务传入的路径已解码，`normalizeDecoded` 只做分段校验。
- `Diagnostics.java`：页面与更新流程共用的诊断上报；`CrashLog.java` 把崩溃与启动信息落盘，供诊断使用。
- `app/src/main/java/io/github/sunflower9264/inoita/Update*.java`：热更新器。`UpdateManager` 管检查、下载和启动回退；`UpdateManifest` 解析并验签指针/清单；`UpdateHttp` 固定 host、处理 gzip 与 Range；`UpdateInstaller` 做差量、硬链接和版本切换；`UpdateState` 管 SharedPreferences 与版本目录。
- `update-public-key.txt`：热更清单验签公钥（base64 SPKI DER），由 `npm run update:key` 生成；缺失时 Gradle 写空字符串，热更检查自动跳过。
- `app/src/main/res/values/{colors,strings,styles}.xml` 与 `app/src/main/res/xml/network_security_config.xml`：颜色、字符串、主题和明文流量白名单。

## 规则

- **构建工具链固定**：JDK 25、Gradle 9.7.1、AGP 9.4、compileSdk 37、build-tools 37.0.0。`tools/build-apk.mjs` 会优先使用 `~/.local/jdk-25`；本机打包前先确认这些版本，构建固定在这套工具链上。
- 网页产物仍是 `dist/`；`npm run apk` 默认先执行 `npm run build`，只有使用 `--skip-web` 或在 Android Studio 直接打包时才需要手动构建。`assets.srcDirs` 直接读取 `../dist`，不复制。
- **页面 origin 固定为 `https://inoita.invalid`**，写成 `AssetContentServer.ORIGIN`。它是 `localStorage` 的身份，发布后不能改；改 origin 等于换掉所有本地存档。`registerContentServer` 要求 origin 只有 `https://<host>`，不能带端口或路径。
- 内容服务在 `CefriumProfile.getDefault()` 上注册一次、跟随进程；`MainActivity` 重建时复用，不调用 `unregisterContentServer`。`serve()` 在后台线程并发执行，必须线程安全：只读不可变快照，帧率回调用 `volatile` 并投递到主线程，`onDestroy` 只清自己设置的监听。
- `index.html` 由 `AssetContentServer` 在 `<head>` 最前面注入 `/__native/bootstrap.js`。这个脚本必须在模块脚本之前定义 `__inoitaEndpoints`、`__inoitaBuildInfo` 和 `window.InotiaNative`，因此注入点固定在 `<head>` 最前面，不能推迟到 `loadUrl` 之后。
- `window.InotiaNative` 只是兼容层：`report()` 走 `/__native/report`，`markBootOk()` 走 `/__native/boot-ok`，`buildInfo()` 读 `__inoitaBuildInfo`，`setFrameRate(rate)` 走 `/__native/frame-rate`。页面代码继续按原接口调用。
- **按玩家帧率选显示模式，Surface 的帧率请求保持 30/60。** 壳收到 30/60 后，选一个刷新率是目标帧率整数倍的最低显示模式（30→60/90/120，60→60/120），写 `preferredDisplayModeId`。`Surface.setFrameRate` 传玩家选的 30/60 和 `FRAME_RATE_COMPATIBILITY_FIXED_SOURCE`（游戏要固定目标帧率；媒体页建议 DEFAULT，游戏页用 FIXED_SOURCE）。关键是不能传屏幕瞬时的低刷新率（LTPO 会掉到 10Hz），那会让系统把整个应用按该帧率限死。`DisplayManager.onDisplayChanged` 和 800ms 兜底只读实际刷新率、写 `window.__inoitaDisplayHz` 并派发 `inoita-display-rate`，页面用 `setRefreshRate` 换算限帧；实际值不能回设 Surface。整数倍保证每个游戏帧占整数个屏幕节拍；60 帧在 90Hz 上会反复在 1 个和 2 个节拍之间跳，所以不要固定请求最高刷新率。
- `Cefrium.setGpuProcessEnabled(true)`、`setLibraryPrefetchEnabled(false)`、`setComponentUpdatesEnabled(false)` 都在 `attachBaseContext` 里、`Cefrium.setupProcess` 之前设置；SDK 的 `CefriumInitProvider` 在本方法返回后就会读预读开关，放到 `onCreate` 已经太晚。GPU 独立进程实测多约 21% 内存，没有帧率收益就回退。
- `__inoitaEndpoints` 在 APK 内指向内容服务的同源地址：`cloudBase = https://inoita.invalid/__cloud`，`diagnosticsReport = https://inoita.invalid/__diagnostics/report`；`/__cloud` 再转到 `config/endpoints.json` 派生地址，页面不写域名，也不受 CORS 影响。代理**不能转发 `Origin`**，否则云存档服务会按旧 allowlist 拒绝；上游状态码要原样保留（423/429/507 不能被改成 500）。
- **热更只换网页层**。`UpdateManager.initialize()` 读取清单、应用待处理版本并发布不可变路径快照，然后回调；`MainActivity.onUpdateManagerReady()` 在回调里注册内容服务并创建 `CefriumBrowser`，加载地址带 `?v=<buildId>`。清单不可用时降级为只读 APK 资源。
- 内容服务给文件、注入后的 HTML 和代理响应都设置 `Content-Length`，由 Cefrium 处理 `Range`/`HEAD`；路径按段校验后拒绝 `.`、`..`、反斜杠、NUL、空段和隐藏段。
- 热更新指针的 `minShell` 必须和新壳一致。当前 `SHELL_VERSION=2`，`tools/update-manifest.ts` 的 `MIN_SHELL=2`；旧 WebView 壳（1）会跳过新清单，需要重装 APK。
- 更新检查不只做一次：冷启动检查，失败 30 秒后重试（最多 3 次），重试用尽后弹出「检查更新失败」并允许手动重试；回到前台且距上次检查超过 6 小时再查。检查时间/结果、待处理 buildId、下载失败原因、失败 buildId 和时间、启动耗时都持久化到 SharedPreferences。
- 检查失败和下载失败都不能静默：检查失败重试用尽后弹提示，下载失败弹「更新失败」并允许重试；「稍后」只在本进程内抑制重复提示。
- 下载和应用分开：下载并校验完成只记录持久化的 `readyBuildId`，弹「更新已准备好，重启后生效」；立即重启才切 active，选稍后或杀进程则在下次冷启动 `initialize()` 时自动应用。
- 回退只发生在「新版本重建浏览器后、标题页调用 `markBootOk()` 前」的 90 秒窗口；正常游玩时 `onRenderProcessTerminated` 只重建浏览器。回退后弹出提示并允许重试，失败 buildId 有 24 小时冷却。
- 更新生命周期通过 `Diagnostics` 写 `update-*` 事件，带 buildId、文件数、失败原因和 `buildInfo`。上报走后台单线程，不能阻塞 `UpdateManager.initialize()` 和冷启动。
- 壳使用 edge-to-edge：`setDecorFitsSystemWindows(false)`，Cefrium 的 surface 铺满整屏；安全区只由网页用于 HUD、侧边按钮和文字避让，不参与画布尺寸。全屏开关在自带引擎里返回 `packaged`，由隐藏系统栏实现沉浸式。
- 页面背景色用 `browser.setBackgroundColor(...)`；它在屏幕上显示的 Surface 浏览器上于第一帧前生效。`getSurfaceContainer()` 只用于把视图加进布局。
- 网络配置允许本机 `127.0.0.1` 与 `localhost` 的明文，所有变体共用这份 `src/main` 配置；调试流程用 `adb reverse` 搭配它，release 的云存档、诊断和更新下载仍必须是 HTTPS。内容服务本身是 HTTPS origin，不经明文 HTTP。
- **Cefrium 基线 0.21.0**，包含新版 `CefriumContentServer`、新客户端接口和 Chromium 安全修复；升级时同时改 `android/build.gradle` 的插件版本和 `app/build.gradle` 的 SDK 版本。
- **引擎升级必须发 APK**。Cefrium/Chromium 是原生库，热更只能换 `dist/` 里的网页内容。Chromium 版本由 `com.cefrium:cefrium-sdk` 决定，升级时改版本号并重新打包。Cefrium 是 LGPL-3.0-or-later 或商业许可；分发 APK 时保留根目录 `THIRD-PARTY-NOTICES.md` 并提供源码地址。
- Cefrium 的原生库必须解压到磁盘：Gradle 打开 `useLegacyPackaging`，清单保留 `android:extractNativeLibs="true"`；只打 `arm64-v8a`。
- `verify-apk.mjs` 会检查 Cefrium 类、内容服务类、`ACCESS_NETWORK_STATE`、arm64 原生库、16 KB 页对齐和游戏资产与 `dist` 一致；Cefrium 自带的 `icudtl.dat`、`*.pak`、`stored-locales/`、`cefrium/` 不参与和 `dist` 的逐文件对比。
- keystore、`keystore.properties` 与 Android SDK 位于仓库外，只在本机配置。
- 清单、资源或 Java 改动后用 `npm run apk` 重新打包，再用 `npm run verify:apk` 校验产物。

## 验证

```bash
npm test -- tests/endpoints.test.ts
npm run build
npm run apk
npm run verify:apk
```

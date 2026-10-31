# android

Android WebView 壳：把 Vite 构建出的 `dist/` 原样打进 APK，提供本地页面、键盘输入与诊断上报。

## 文件

- 根目录：`build.gradle` 声明 Android 插件，`settings.gradle` 配置模块与仓库，`gradle.properties` 放 Gradle 参数，`gradlew`、`gradlew.bat` 是包装器脚本。
- `app/build.gradle`：应用配置、`assets.srcDirs` 指向 `../dist`、`DIAGNOSTICS_URL` 与签名。
- `app/src/main/AndroidManifest.xml` 与 `app/src/main/java/io/github/sunflower9264/inoita/MainActivity.java`：前者是清单、权限与横屏 Activity 配置，后者是 WebView 宿主，处理资源加载、全屏与键盘事件。
- `app/src/main/res/values/{colors,strings,styles}.xml` 与 `app/src/main/res/xml/network_security_config.xml`：颜色、字符串、主题和明文流量白名单。

## 规则

- WebView 通过 `assets.srcDirs` 直接读取 `../dist`，打包 APK 前先在仓库根目录运行 `npm run build`。
- `app/build.gradle` 的 `DIAGNOSTICS_URL` 与 `app/src/main/res/xml/network_security_config.xml` 放行的地址保持同步。
- keystore、`keystore.properties` 与 Android SDK 位于仓库外，只在本机配置。
- 清单、资源或 Java 改动后用 `npm run apk` 重新打包，再用 `npm run verify:apk` 校验产物。

## 验证

```bash
npm run apk
npm run verify:apk
```

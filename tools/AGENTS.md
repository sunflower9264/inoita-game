# tools

仓库脚本：构建、内容校验、图集生成、诊断、测试入口与 APK 打包。由根目录 `package.json` 的命令调用，不进入游戏运行时。

## 文件

- 构建/校验：`build.mjs` 打包入口，`content-build.ts` 把内容 JSON 编译成运行时数据，`validate-content.mjs` 校验内容，`validate-spritesheet.ts` 校验精灵表，`build-version.ts` 计算资源与内容版本，`deploy.ts` 构建后核对 HTTPS 入口版本。
- 服务/诊断：`serve-built.ts` 提供打包后的静态服务，`diagnostic-collector.mjs` 是诊断上报中间件，`diagnostic-collector.d.mts` 是它的类型声明。
- 图集/资源：`build-icon-atlas.ts`、`build-prop-atlas.ts`、`build-effect-atlas.ts`、`build-ui-atlas.ts` 生成图集，`build-slot-frames.ts` 生成装备槽帧，`asset-report.ts` 输出素材重复与体积报告。
- 测试/审计/APK：`test.ts` 是测试入口，`audit-story-actors.ts` 审计剧情角色摆放，`screen-draft-scripts.mjs` 逐段筛选剧情演出草稿，`build-apk.mjs` 与 `verify-apk.mjs` 打包并校验 APK。

## 规则

- `tools/` 不进入 tsconfig 的 include，脚本独立于应用的类型检查运行。
- `.mjs` 脚本不做类型检查；`.ts` 脚本由 Node 的类型剥离直接执行，写法保持可擦除。
- 改动构建、校验或打包逻辑后运行对应命令验证：`npm run build`、`npm run validate:content`、`npm run test:standalone`，APK 改动用 `npm run apk` 和 `npm run verify:apk`。
- 生成物 `dist/`、`public/content/debug/start.json`、`src/generated/*` 由脚本产出，内容变化后重跑对应生成命令。
- 新增脚本在根目录 `package.json` 挂成命令，沿用现有命令命名。

## 验证

```bash
npm run build
npm run validate:content
```

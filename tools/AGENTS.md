# tools

仓库脚本：构建、内容校验、图集生成、诊断、测试入口与 APK 打包。由根目录 `package.json` 的命令调用，不进入游戏运行时。

## 文件

- 构建/校验：`build.mjs` 打包入口，`content-build.ts` 把内容 JSON 编译成运行时数据，`content-manifest.ts` 生成生产内容哨兵清单，`validate-content.mjs` 校验内容，`validate-spritesheet.ts` 校验精灵表，`build-version.ts` 计算资源与内容版本，`deploy.ts` 构建后核对 HTTPS 入口版本，`patch-phaser.mjs` 把 Phaser PR #7420 的动态缓冲补丁应用到 4.2.1 运行时包。
- 服务/诊断：`serve-built.ts` 提供打包后的静态服务，`diagnostic-collector.mjs` 是诊断上报中间件（按错误/会话拆成两个 JSONL 流，分别轮转；同一会话同一地图的重复检查点诊断 60 秒内只留一条；按 `id` 去重），`diagnostic-collector.d.mts` 是它的类型声明，`diagnostics-report.mjs` 按会话汇总和查看时间线。
- 云存档：`cloud-save-store.ts` 负责账号、会话、续期、改密和存档落盘（scrypt、单会话、锁定、配额、原子写），`cloud-save-service.ts` 把 `/__cloud` HTTP 路由、CORS、限流和请求体上限接到静态服务上。
- 图集/资源：`build-icon-atlas.ts`、`build-prop-atlas.ts`、`build-effect-atlas.ts`、`build-ui-atlas.ts`、`build-character-atlas.ts` 生成图集，`atlas-pack.ts` 提供按加载块装箱的共用实现，`asset-source.ts` 解析 `asset-source/` 源图，`build-slot-frames.ts` 生成装备槽帧，`asset-report.ts` 输出源素材重复与生产构建后的运行时素材口径，`asset-keep.ts` 计算运行时保留集，`prune-assets.ts` 把未引用素材移进归档目录。
- 角色图集按 1024 页装箱，并在生成时打印「最差 10 个 actor」的页占用；新增大型 actor 或大技能帧后先看这份报告，避免单个小角色被装进大页后一次拉起几十 MB 纹理。
- 测试/审计/APK：`test.ts` 是测试入口，`audit-story-actors.ts` 审计剧情角色摆放，`build-apk.mjs` 与 `verify-apk.mjs` 打包并校验 APK。
- 热更新：`update-manifest.ts` 生成、签名和验签逐文件清单，`update-key.ts` 生成签名密钥与公钥，`verify-update.ts` 核对 APK 基线与线上清单的差量。

## 规则

- `tools/` 不进入 tsconfig 的 include，脚本独立于应用的类型检查运行。
- **Phaser 固定在 4.2.1，动态缓冲补丁由 `patch-phaser.mjs` 固化。** `postinstall`、`predev` 和 `prebuild` 会自动执行；脚本按版本和补丁锚点校验，重复执行直接跳过。升级 Phaser 时先核对 PR #7420，再同步更新脚本里的版本号和锚点，不要手工改 `node_modules` 后依赖它。
- 同一脚本还给 `WebGLFramebufferWrapper` 构造失败补清理：登记到 renderer 之前创建失败时释放颜色纹理、绘图缓冲与绑定状态，避免重复进图累积失败资源。`tests/phaser-framebuffer.test.ts` 用运行时包中的真实构造器验证失败与成功路径。
- `.mjs` 脚本不做类型检查；`.ts` 脚本由 Node 的类型剥离直接执行，写法保持可擦除。
- **Android 打包工具链**：Cefrium 需要 JDK 25、Gradle 9.7.1、AGP 9.4、Android SDK 37 和 build-tools 37.0.0。`build-apk.mjs` 优先使用 `~/.local/jdk-25`，其次 `JAVA_HOME`；低于 JDK 25 直接失败。不要退回 JDK 17 / Gradle 8.7。
- `verify-apk.mjs` 会检查 Cefrium 类、arm64 原生库、16 KB 页对齐；Cefrium 自带的 `icudtl.dat`、`*.pak`、`stored-locales/`、`cefrium/` 不参与和 `dist` 的逐文件对比。
- 改动构建、校验或打包逻辑后运行对应命令验证：`npm run build`、`npm run validate:content`、`npm run test:standalone`，APK 改动用 `npm run apk` 和 `npm run verify:apk`。
- 生成物 `dist/`、`public/content/debug/start.json`、`src/generated/*`、`tools/character-atlas-aliases.ts` 由脚本产出，内容变化后重跑对应生成命令。
- **图集源图归档在 `asset-source/`。** 图集生成、内容构建去重、逐像素测试只从 `asset-source/` 读原图，不再去 `public/assets` 找同名文件；`public/assets` 只放运行时图集页、地图、音频和明确未进图集的例外图片。别名表 `tools/character-atlas-aliases.ts` 只给工具判断覆盖，不进入运行时包。
- 构建在 `dist/content-manifest.json` 写生产内容哨兵：记录编译后内容的 `contentVersion` 和 `campaign.json`/`battle.json` 的必需顶层键。清单放在 `content/` 外，不参与 `hashTree(content)`；运行时只读清单，不重算 34MB 内容哈希。
- 用 `npm run test:content-build` 跑真实内容的编译烟雾测试（一次最小战斗和一个剧情节点）；它不进入每次单元测试。
- **构建会裁剪未引用素材。** `build.mjs` 在 Vite 输出后调用 `prune-assets.ts`，把 `dist/assets` 里没有被运行时引用的文件移到仓库根目录的 `asset-archive/`（不进 Git），并写 `asset-archive/report.json`。
- 保留集由 `asset-keep.ts` 从三处求并集：编译后内容 JSON 里的 `assets/...`、代码里固定的界面路径、运行时真正交给 Phaser 的 `PendingAsset`；被 UI/图标/特效/物件/角色图集替代的原图只保留图集页。任何被引用但磁盘上不存在的路径会让构建直接失败。
- `npm run audit:assets` 只检查、不移动；`npm run build -- --no-prune` 保留全部素材但仍执行引用检查，用于对比排查。
- `content-build.ts` 按解码后的像素、图片尺寸和切帧合并角色图片，帧率、镜像与循环由各自的动画保留。真实内容构建验收逐一检查六职业的技能、召唤物图片与图集帧，并按图集页核对黑暗空间对白避开的陨石纹理量；页面共享后不再要求陨石文件完全不与对白页共存。
- 新增脚本在根目录 `package.json` 挂成命令，沿用现有命令命名。
- 云存档数据目录：生产 `.cloud-save/`，开发 `.cloud-save-dev/`；两者都不进 Git。云服务初始化失败只能让 `/__cloud` 返回 503，不能让 4004 的静态服务起不来。
- 诊断日志目录 `.diagnostics/` 不进 Git；错误流 2 MiB × 8，会话流 8 MiB × 11，查看时用 `npm run diag:list` 和 `npm run diag:session -- <id>`，不要直接翻几十万行 JSONL。
- 改 `serve-built.ts` 或云存档服务后需要重启 4004；只改客户端/内容时普通构建即可。
- 热更新清单的 `buildId` 只由文件内容决定；`builtAt`、`minShell` 只放指针，清单保持字节稳定。私钥在 `~/.config/inoita/update-signing.pem`，公钥写 `android/update-public-key.txt`；私钥丢失后老客户端只能重装 APK。

## 验证

```bash
npm run build
npm run audit:assets
npm run validate:content
npm run test:content-build
npm test -- tests/cloud-save-store.test.ts tests/cloud-save-service.test.ts
npm test -- tests/update-manifest.test.ts tests/serve-built.test.ts
npm run verify:update -- --apk apk-out/Inotia-4-1.0.0.apk --url https://catgo.online:4002
```

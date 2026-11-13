# 艾诺迪亚 · 故事 开发规则

Phaser 4.2.1 + TypeScript 的剧情与任务体验版。源码、内容、素材和测试都在本仓库内。

**游戏行为以 `src/`、`public/content/` 和 `tests/` 为准。** 规则不清楚时读现有实现、内容定义和测试；不要依赖仓库外的资料。

## 规则层级

- 本文件是全局规则；各代码目录的 `AGENTS.md` 只补该目录的局部约束，不整段复制全局规则。
- **默认在 `main` 分支开发。** 没有特殊要求时，改动直接提交到 `main`；只有用户主动要求时才新建或切换到其他分支。
- 冲突时以离被改文件最近的 `AGENTS.md` 为准；聊天里的明确指令优先。
- 每个含 `AGENTS.md` 的目录同时有一个指向它的 `CLAUDE.md` 符号链接。规则只改 `AGENTS.md`，`CLAUDE.md` 不单独维护。新增代码子目录时补一对。
- 游戏实现改了，就同步更新对应的 `AGENTS.md`；文件增删、命令变化和约束变化都算。

## 沟通

面向用户的解释里禁止直接使用未经解释的内部简称。先用日常语言说清它解决什么问题，再出现技术词。

- 「同值短路」要说成「值没变就直接跳过后面的写入」。
- 「增量更新」要说成「只改变化的部分，没变的不重建」。
- 「常驻包」「IR」这类词，第一次出现必须紧跟一句人话解释。
- 代码、测试和提交信息可以用准确的技术词；对话和给用户看的文档要先让人看懂。

## 1. 按画面职责选择实现层

屏幕界面的文字、图片、按钮、滚动、拖拽和布局编辑由 DOM、CSS 与必要的 SVG 承担。地图、角色、镜头、物理、角色头顶血条、伤害数字和战斗特效由 Phaser 承担。游戏世界实现优先用 Phaser 4.2.1 内置 API，再查技能和对应版本文档。场景只编排生命周期，游戏规则保持在领域层。分层与 import 方向见 `src/AGENTS.md`。

引擎版本以 `package.json` 为准；升级 Phaser 时同步更新 `README.md` 和本规则。

## 2. 先定义游戏语义，再写实现代码

游戏代码里只出现有语义的名字，不出现解析过程的中间产物；命名示例和分层说明见 `src/AGENTS.md`。

- **工程自包含**。运行、测试和普通构建只读取本目录的源码、`public/`、`asset-source/` 和测试。
- **素材优先用原版**。素材缺失时先查 `../inoita` 工程的原版图集与切片表；没有就用该工程里的逆向技能从原版 APK 提取；确实没有时单独汇报缺口，不用临时生成图或职业图冒充。取到的素材复制进本仓库，构建仍只读本仓库。
- **内容直接在本仓库维护**。`public/content/` 是剧情、任务、地图和战斗数据的唯一源文件。发现和原版不一致时，去 `../inoita` 对照原版实现和素材，然后把修正直接写进本仓库对应的 JSON、类型或代码；后续内容变更也以本仓库的 JSON 和代码为起点。
- **剧情独立创作**。`public/content/campaign.json` 是剧情、任务和角色摆放的源文件；新增字段先定义游戏含义、单位和消费方式，内容加载和构建共用校验器。
- **名字用游戏里的概念**。动画叫 `walk-east`、`idle-south`，地图属性叫 `blocked`、`exits`、`entities`，剧情行为叫 `dialogue`、`choice`。
- **存档兼容上一版**。当前代码必须能读回最近一次发布的存档格式；升级流程见 `src/domain/AGENTS.md`，迁移链在 `src/application/saved-game.ts`。
- **服务地址分开发与部署**。网页始终同源，页面不写域名；Android 壳由本地服务在页面脚本前注入 `__inoitaEndpoints` 和原生桥。环境根地址只维护 `config/endpoints.json`：Android 调试用 `adb reverse` 指向本机 4003，发布和网页生产共用 `https://catgo.online:4002`；云存档 `/__cloud`、诊断 `/__diagnostics/report` 路径固定。热更新检查地址从同一根地址派生 `/update/latest.json`，自测通道用 `/update/latest-staging.json`；下载走原生 HTTP，不需要 CORS。细则见 `config/AGENTS.md`、`src/application/AGENTS.md`、`android/AGENTS.md`。

## 3. 测试与验证

默认按本次改动的行为和直接依赖选择相关测试文件：

```bash
npm test -- tests/example.test.ts
```

该命令先做一次类型检查，再用 `node:test` 运行指定文件；不带文件参数时输出用法并退出。自动化测试只写在 `tests/*.test.ts`。

- TypeScript 改动需要类型检查；没有相关用例时运行 `npm run typecheck`。
- 内容、内容校验器或素材引用有变化时运行 `npm run validate:content`。
- 素材引用或图集映射变化时运行 `npm run audit:assets`；它只检查保留集，不移动文件。
- 内容构建链路（`tools/content-build.ts`、`tools/content-manifest.ts`、`tools/build.mjs`）有变化时运行 `npm run test:content-build`，它会用真实内容编译到临时目录并跑一场最小战斗和一个剧情节点。
- 相关检查通过后继续完成任务；只有新改动、新失败或尚未解决的疑点才扩大测试。
- 全量单元测试只在用户明确要求时使用 `npm run test:all`；独立安装与构建验收用 `npm run test:standalone`。测试写法见 `tests/AGENTS.md`。

**验证不主动调用浏览器。** Playwright、headless Chrome 以及任何等价手段都不自行启动；界面与实际运行效果交给用户验收。只有用户明确要求时才用浏览器。

每修复一个独立问题，完成代码/内容修正及必要验证后单独创建 Git 提交，提交说明写清修复行为和验证结果。

## 4. 本地服务与端口

| 端口 | 服务 | 启动方式 | 地址 |
|---|---|---|---|
| 4002 | HTTPS 入口（nginx 终止 TLS，转发到 4004） | 系统 nginx | https://catgo.online:4002/ |
| 4004 | 打包后的静态服务（`dist/`，仅本机） | `npm run serve` | http://127.0.0.1:4004/ |
| 4003 | Vite 开发服务（代码读源码，内容按生产规则编译） | `npm run dev` | http://localhost:4003/ |

端口上已经有监听就说明服务已经启动，直接访问即可，不要再起一个。重复启动只会撞端口失败。不确定当前跑着什么时先看：

```bash
ss -ltnp | grep -E '4002|4003|4004'
```

在根目录运行 `npm run build` 生成 `dist/`；`npm run deploy` 会做类型检查、构建，并通过 `https://catgo.online:4002` 核对正在提供的版本。4004 静态服务直接读磁盘，构建完成即生效，不需要重启；只有静态服务自身改动才需要重启。

本地调试用 4003；4002/4004 是部署链路。Android 调试通过 `adb reverse tcp:4003 tcp:4003` 复用 4003，不把开发地址写进 release 包。

4003 的代码仍从源码加载；`/content` 请求由开发服务用 `buildContent` 生成临时目录后提供，内容改动自动重建，所以素材口径与 4002/APK 一致——同样的场景不会因为开发模式多加载重复贴图。

## 5. 目录导航

```text
package.json           依赖与命令；Phaser 版本以这里为准
index.html             页面入口，Vite 从这里打包
vite.config.ts         开发服务 4003；打包产物放 dist/
tsconfig.json          类型检查；只用可擦除语法，测试用 node --test 直接跑 .ts
src/                   游戏源码（规则见 src/AGENTS.md）
  app.ts               启动装配；场景与界面使用 application/ports.ts 的能力接口
  main.ts              游戏配置与启动
  application/         端口装配、内容加载、存档迁移（AGENTS.md）
  scenes/              地图、剧情舞台、菜单与调试场景（AGENTS.md）
  domain/              内容类型、会话状态、剧情调度、通行、战斗规则（AGENTS.md）
  rendering/           角色、世界、战斗与特效表现（AGENTS.md）
  ui/                  菜单、HUD、对话、DOM 组件与界面逻辑（AGENTS.md）
  debug/               GM 动作层与剧情跳转（AGENTS.md）
  generated/           图集常量，生成物（AGENTS.md）
public/                运行时静态资源和内容（图集页、地图、音频、未进图集的例外图片）
  content/             剧情、任务、地图、战斗、物品、音频等内容 JSON
  assets/              运行时图片与音频素材
config/                环境服务根地址（AGENTS.md；网页固定同源，Android 调试/发布分环境）
asset-source/          图集生成与内容去重的源素材（进 Git；原图不再放 public）
asset-archive/         构建裁剪出的运行时旧图副本（不进 Git）
tests/                 单元测试（AGENTS.md；helpers、support 另有）
tools/                 构建、校验、调试现场表生成、静态服务、APK 打包（AGENTS.md；debug-start 另有）
deploy/                nginx 站点等部署配置
docs/                  架构、模块原理、剧情创作、音频、掉落、云存档、部署、服务地址、热更新、调试与诊断
android/               Android 自带 Chromium 156 的壳（minSdk 29，规则见 AGENTS.md）
.agents/skills/        Phaser 4 开发技能
.claude/skills         指向 ../.agents/skills 的符号链接
```

`docs/` 只放长期维护的开发说明；一次性的交接、排查记录和已完成方案写进提交说明，做完即删。

## 6. 常用命令

```bash
npm test -- tests/combat.test.ts   # 类型检查 + 指定用例
npm run typecheck                  # 只做类型检查
npm run validate:content           # 内容、校验器或素材引用变化时
npm run audit:assets               # 只检查素材保留集，不裁剪
npm run atlas:all                  # 重新生成图标/道具/界面/特效/角色全部图集
npm run test:content-build         # 真实内容编译后跑最小战斗与剧情节点
npm run debug-start                # 内容改动后重新生成 GM 任务现场表
npm run debug-start:check          # 只检查 GM 任务现场表是否过期
npm run test:all                   # 用户明确要求全量单元测试时
npm run test:standalone            # 独立安装、类型检查与构建验收
npm run build                      # 校验、替换 dist/，并把未引用素材移进 asset-archive/
npm run build -- --no-prune        # 保留全部素材，只做引用检查
npm run deploy                     # 类型检查 + 构建 + 核对 HTTPS 入口版本
npm run serve                      # 前台启动打包静态服务（默认 4004）
npm run dev                        # 开发服务器 http://localhost:4003/
npm run apk                        # 打包 Android 安装包（Cefrium/Chromium 156，需要 JDK 25）
npm run verify:apk                 # 校验 APK 产物
npm run update:key                 # 首次生成热更新签名密钥（私钥在仓库外）
npm run verify:update              # 核对 APK 基线与线上清单的差量
```

## 7. 性能优化

性能差不一定只是每帧跑得太多。按下面九类逐类看，哪类命中就改哪类。

- **跑得太勤。** 每秒跑 60 次的东西只留必须每秒做的事。AI、寻路、界面刷新能 0.1 秒一次就不要每帧一次；背包、任务面板变了才刷新。
- **一次碰太多对象。** 一个函数本身不慢，乘以每帧 1000 个对象就慢了。只碰附近、活着、在屏幕上的对象，不要每帧遍历全图。
- **找得太慢。** 每次都从头翻名单，人一多就慢。常用名单提前做成 `Map`/`Set` 或静态索引，按名字直接取，不要 `find` 全队。
- **重复算。** 同一道题每帧重算。数据没变就保留上次结果；数据变了再用“变了才加一”的版本号通知重算。技能表、队伍加成、条件、HUD 都属于这类。
- **不停造垃圾。** 每帧新建对象、数组、闭包、字符串，浏览器要不停回收，回收时就会卡。能复用就复用；子弹、伤害数字这类高频对象提前建好一批反复用。
- **画得太多或反复重建。** 同一张图能一起画就别拆开；方向没变就只挪位置，不要删掉重做；数字文字不要每帧重画。
- **占内存太多。** 不用的图、声音、地图要能释放；常用素材只留当前进度需要的；缓存要有上限，最久没用的先删。换图、回菜单、新开一局都是清理时机。
- **存档、加载、解析太重。** 这些活放到进图、回菜单、读档时做，不要塞进游戏循环；存档只写变化的部分，不要每次全量复制。
- **内容本身太重。** 同一张图按方向存好几份、没用到的素材也打包进去，构建时就能去重和瘦身。`npm run build` 会按运行时引用裁剪 `dist/assets`，把未引用文件移进 `asset-archive/`；图集源图在 `asset-source/`，构建运行时只加载图集页。

**先问四个数：** 这件事多久做一次、每次碰多少对象、每次造多少临时对象、占多少内存。只要有一项随玩家进度增长，就改成缓存、索引、降频、复用或上限。

**不用等基线才动手。** 按上面的类别先改，一次只改一类，单独提交；改完在 4002/APK 上实测，确认没有把别的指标弄坏。各目录已有的索引、版本缓存和素材占用登记继续沿用，具体机制见对应 `AGENTS.md`。

### Phaser 动态缓冲区补丁（验证中）

安卓战斗掉帧（安卓浏览器和 APK 都掉，iOS 不卡）目前有一个待验证的候选：[Phaser PR #7420](https://github.com/phaserjs/phaser/pull/7420)。它改 `WebGLBufferWrapper.update`：动态缓冲区从偏移 0 上传时改用 `bufferData` 重新分配存储，让驱动丢弃旧缓冲，避免同一帧前面的 draw call 还在用的缓冲被复制或同步；`STATIC_DRAW` 和带偏移的局部更新保持原逻辑。早期版本 [PR #7345](https://github.com/phaserjs/phaser/pull/7345) 只做了每次 `bufferData` 重分配，没有处理局部更新，不要单独采用。

现状：安卓战斗实测有效，已固化为 `tools/patch-phaser.mjs`，由 `postinstall`、`predev` 和 `prebuild` 自动应用；Phaser 仍锁 `4.2.1`，补丁打在 `node_modules/phaser/dist/phaser.esm.js`，构建和 APK 都会带它。升级 Phaser 时先核对 PR #7420 和脚本里的补丁锚点，再更新 `patch-phaser.mjs` 的版本检查。

同一脚本还处理绘图缓冲创建失败时的资源清理：构造器抛错前释放已申请的颜色纹理和缓冲，避免进图重试累积显存。升级时一并核对这一清理分支；验证见 `tests/phaser-framebuffer.test.ts`。

验证方式：同一台安卓设备、同一张地图和战斗，对比补丁前后的实际帧率。菜单和静态地图不掉、只有战斗掉且随同屏敌人/特效增加而变差，才更像这个补丁能解决的「批次缓冲复制」问题。

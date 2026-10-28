# 艾诺迪亚 · 故事 开发规则

Phaser 4.2.1 + TypeScript 的剧情与任务体验版。源码、内容、素材和测试都在本仓库内。

**游戏行为以 `src/`、`public/content/` 和 `tests/` 为准。** 规则不清楚时读现有实现、内容定义和测试；不要依赖仓库外的资料。

## 沟通

面向用户的解释里禁止直接使用未经解释的内部简称。先用日常语言说清它解决什么问题，再出现技术词。

- 「同值短路」要说成「值没变就直接跳过后面的写入」。
- 「增量更新」要说成「只改变化的部分，没变的不重建」。
- 「常驻包」「IR」这类词，第一次出现必须紧跟一句人话解释。
- 代码、测试和提交信息可以用准确的技术词；对话和给用户看的文档要先让人看懂。

## 1. 实现功能先走 Phaser 内置能力，再走技能，最后查文档

游戏界面使用 Phaser 4 的场景、游戏对象与现有界面组件实现。按这个顺序找解法，不要跳步：

1. **Phaser 内置 API**。移动和碰撞交给 Arcade Physics（`this.physics`，技能 `physics-arcade`），镜头跟随用 `this.cameras.main.startFollow()`（技能 `cameras`），逐帧动画用 AnimationManager（`this.anims`，技能 `animations`）。不要自己写循环——自己造轮子会丢掉内置的碰撞分离、视口剔除和时序处理。
2. **项目内技能**。`.agents/skills/` 里有 Phaser 4 的场景、动画、物理、相机、瓦片地图、输入、文本、粒子、滤镜等技能；Claude Code 通过 `.claude/skills` 读取。用 Skill 工具按功能调用。
3. **Phaser 4.2.1 官方文档**。技能没覆盖时查对应版本的文档。

Phaser 4 和 3 的差异很大：渲染管线从 pipeline 改成 render node，FX 和 mask 改成 filter，tint 系统和纹理坐标也变了。公开语料里 Phaser 3 的代码远多于 4，不要凭记忆写 v3 写法。引擎版本以 `package.json` 声明为准；升级引擎时同步更新本文档和 `README.md`。

## 2. 先定义游戏语义，再写 Phaser 代码

游戏代码里只出现有语义的名字，不出现解析过程的中间产物。

| 别这样写 | 要这样写 |
|---|---|
| `pos = { x: -rec.u_5, y: -rec.u_7 }` | `worldPosition = { x: -rec.tileX, y: -rec.tileY }` |
| `if (tileId & 0x3FFF)` / `flags >> 14` | `getTileIndex(cell)`、`isFlippedHorizontally(cell)` |
| `if (idx === 0x2484) alpha = 0` | 解码时算出 `transparentIndex`，渲染只读这个字段 |
| `paletteSetId = MAPINFOBASE[map].byte[3]` | 导出阶段就展开成 `world.tilePalette` |

边界保持一致：

- **工程自包含**。运行、测试和普通构建只读取本目录的源码、`public/` 和测试。
- **剧情独立创作**。`public/content/campaign.json` 是剧情、任务和角色摆放的源文件；新增字段先定义游戏含义、单位和消费方式，内容加载和构建共用校验器。
- **名字用游戏里的概念**。动画叫 `walk-east`、`idle-south`，地图属性叫 `blocked`、`exits`、`entities`，剧情行为叫 `dialogue`、`choice`。
- **存档兼容上一版**。当前代码必须能读回最近一次发布的存档格式。改了存档结构或校验口径就把 `src/domain/save-game.ts` 的 `SAVE_FORMAT` 加一，同时在 `src/application/saved-game.ts` 的升级链里补上旧版到新版的迁移和旧档测试；升级链覆盖的旧档正常读取，更早的档案显示为空槽。

## 3. 测试与验证

默认按本次改动的行为和直接依赖选择相关测试文件：

```bash
npm test -- tests/example.test.ts
```

该命令先做一次类型检查，再用 `node:test` 运行指定文件；不带文件参数时输出用法并退出。自动化测试只写在 `tests/*.test.ts`。

- TypeScript 改动需要类型检查；没有相关用例时运行 `npm run typecheck`。
- 内容、内容校验器或素材引用有变化时运行 `npm run validate:content`。
- 相关检查通过后继续完成任务；只有新改动、新失败或尚未解决的疑点才扩大测试。
- 全量单元测试只在用户明确要求时使用 `npm run test:all`。
- 独立安装与构建验收用 `npm run test:standalone`。

**验证不主动调用浏览器。** Playwright、headless Chrome 以及任何等价手段都不自行启动；界面与实际运行效果交给用户验收。只有用户明确要求时才用浏览器。

每修复一个独立问题，完成代码/内容修正及必要验证后单独创建 Git 提交，提交说明写清修复行为和验证结果。

## 4. 本地服务与端口

| 端口 | 服务 | 启动方式 | 地址 |
|---|---|---|---|
| 4002 | HTTPS 入口（nginx 终止 TLS，转发到 4004） | 系统 nginx | https://catgo.online:4002/ |
| 4004 | 打包后的静态服务（`dist/`，仅本机） | `npm run serve` | http://127.0.0.1:4004/ |
| 4003 | Vite 开发服务（读源码） | `npm run dev` | http://localhost:4003/ |

端口上已经有监听就说明服务已经启动，直接访问即可，不要再起一个。重复启动只会撞端口失败。不确定当前跑着什么时先看：

```bash
ss -ltnp | grep -E '4002|4003|4004'
```

在根目录运行 `npm run build` 生成 `dist/`；`npm run deploy` 会做类型检查、构建，并通过 `https://catgo.online:4002` 核对正在提供的版本。4004 静态服务直接读磁盘，构建完成即生效，不需要重启；只有静态服务自身改动才需要重启。

## 5. 目录导航

```text
package.json           依赖与命令；Phaser 版本以这里为准
index.html             页面入口，Vite 从这里打包
vite.config.ts         开发服务 4003；打包产物放 dist/
tsconfig.json          类型检查；只用可擦除语法，测试用 node --test 直接跑 .ts
src/                   游戏源码
  app.ts               启动装配；场景与界面使用 application/ports.ts 的能力接口
  main.ts              游戏配置与启动
  scenes/              地图、剧情舞台、菜单与调试场景
  domain/              内容类型、会话状态、剧情调度、通行、战斗规则
  rendering/           角色、世界、战斗与特效表现
  ui/                  菜单、HUD、对话与 Phaser 面板
  debug/               GM 动作层与剧情跳转
public/                原样复制进构建产物的静态资源和内容
  content/             剧情、任务、地图、战斗、物品、音频等内容 JSON
  assets/              图片与音频素材
tests/                 单元测试（*.test.ts）与独立构建验证
tools/                 构建、校验、调试现场表生成、静态服务、APK 打包
deploy/                nginx 站点等部署配置
docs/                  架构、剧情创作、音频、部署、调试与诊断
android/               Android WebView 壳（可选）
.agents/skills/        Phaser 4 开发技能
.claude/skills         指向 ../.agents/skills 的符号链接
```

## 6. 常用命令

```bash
npm test -- tests/combat.test.ts   # 类型检查 + 指定用例
npm run typecheck                  # 只做类型检查
npm run validate:content           # 内容、校验器或素材引用变化时
npm run debug-start                # 内容改动后重新生成 GM 任务现场表
npm run debug-start:check          # 只检查 GM 任务现场表是否过期
npm run test:all                   # 用户明确要求全量单元测试时
npm run test:standalone            # 独立安装、类型检查与构建验收
npm run build                      # 校验并替换 dist/
npm run deploy                     # 类型检查 + 构建 + 核对 HTTPS 入口版本
npm run serve                      # 前台启动打包静态服务（默认 4004）
npm run dev                        # 开发服务器 http://localhost:4003/
npm run apk                        # 打包 Android 安装包
npm run verify:apk                 # 校验 APK 产物
```

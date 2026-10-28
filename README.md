# 艾诺迪亚 · 故事

Phaser 4.2.1 + TypeScript 的剧情与任务体验版，面向手机横屏。源码、内容、素材、测试和构建工具都在本仓库内，安装依赖后可以直接运行。

## 环境要求

- Node.js 24 或更高版本（工程直接执行 `.ts` 脚本，并运行 Vite 8）
- npm

## 快速开始

```bash
npm ci
npm run dev
```

开发服务默认在 http://localhost:4003/ 。首次安装请用 `npm ci`，不要用 `npm run test:standalone` 作为安装方式。

## 常用命令

```bash
npm run dev                 # Vite 开发服务，4003
npm run build               # 校验内容后构建到 dist/
npm run serve               # 前台静态服务，默认 4004
npm run deploy              # 类型检查 + 构建 + 核对 HTTPS 入口版本
npm run typecheck           # 只做 TypeScript 类型检查
npm test -- tests/combat.test.ts   # 类型检查 + 指定测试文件
npm run test:all            # 全量单元测试
npm run validate:content    # 内容、校验器或素材引用变化时
npm run test:standalone     # 独立安装、类型检查和构建验收
npm run apk                 # 打包 Android 安装包
npm run verify:apk          # 校验 APK 产物
```

本机访问地址是 https://catgo.online:4002/：nginx 终止 TLS 后转发到 127.0.0.1:4004 的静态服务。`npm run deploy` 需要 nginx 和 4004 静态服务都在运行。构建产物在 `dist/`，服务直接读磁盘，构建完成即生效。

## 目录结构

```text
src/                游戏源码
  application/      能力接口、内容加载、存档与音频装配
  domain/           战斗、剧情、任务、背包、存档等纯规则
  rendering/        Phaser 世界、战斗、特效与角色表现
  scenes/           地图、剧情舞台、菜单与调试场景
  ui/               菜单、HUD、对话与 Phaser 面板
  debug/            GM 调试动作层
public/             随游戏发布的静态资源
  content/          剧情、任务、地图、战斗、物品等内容 JSON
  assets/           地图、角色、UI、特效、音频等素材
tests/              单元测试与独立构建验收
tools/              构建、校验、静态服务、APK 打包
docs/               架构、剧情创作、部署、调试与诊断说明
android/            Android WebView 壳（可选打包层）
.agents/skills/     随仓库提供的 Phaser 4 开发技能
```

## 内容与素材

- `public/content/campaign.json` 是剧情、任务、事件与角色摆放的源文件。
- `public/content/world.json`、`public/content/maps/`、`public/content/battle.json` 等保存地图与战斗数据。
- `public/assets/` 保存图片与音频，路径由内容 JSON 引用。
- 内容字段的写法和校验规则见 [剧情与任务创作](docs/story-content.md)。
- 改动内容、校验器或素材引用后运行 `npm run validate:content`；构建时也会再校验一次。

素材和内容随游戏版本管理，不依赖仓库外部数据。新增素材时按现有目录和命名规则放置，并确认内容校验与构建通过。

## 开发入口

| 要做的工作 | 从哪里开始 |
|---|---|
| 先弄懂各模块怎么协作 | [模块原理入门](docs/module-guide.md) |
| 改功能、规则或生命周期 | [架构与修改入口](docs/architecture.md) → 对应源码与测试 |
| 写对白、任务、事件或地图条件 | [剧情与任务创作](docs/story-content.md) → `public/content/campaign.json` |
| 改音乐、环境音与音效 | [音频说明](docs/audio.md) → `public/content/audio.json` |
| 调试游戏或任务 | [GM 调试模式](docs/debugging.md) |
| 部署与缓存 | [打包服务与部署](docs/deployment.md) |
| 收集手机端报错 | [诊断说明](docs/diagnostics.md) |

## 界面与调试场景

游戏界面由 Phaser 的场景、游戏对象和现有界面组件绘制。

- `?gm`：本次会话打开 GM 调试模式，标题页出现「调试」入口。
- `?animation-debug`：跳过标题和剧情，查看人物动画、换装与地图角色。
- `?ui-debug`：单独查看界面布局。

GM 面板包含状态、人物、道具和剧情四个子页；浏览器里也可以通过 `globalThis.gm` 调用同一套调试动作。

## Phaser 技能

仓库自带 28 个 Phaser 4 开发技能，位于 `.agents/skills/`，Claude Code 通过 `.claude/skills` 符号链接读取。技能覆盖场景、动画、物理、相机、瓦片地图、输入、文本、粒子、滤镜、缩放与 Phaser 4 新特性。

实现功能时按这个顺序找解法：

1. Phaser 内置 API；
2. 项目内对应的 Phaser 技能；
3. Phaser 4.2.1 官方文档。

引擎版本以 `package.json` 为准。

## 测试与验收

默认选择与改动直接相关的 `tests/*.test.ts`，可以一次传多个文件。单元测试验证规则和轻量表现替身；内容校验验证文件和引用。二者都不能替代真机画面、音频和长时间资源占用验收。

按项目约定，不主动启动浏览器自动化；界面和真机效果由用户验收。用户明确要求时才使用浏览器。

## 打包 Android 安装包

`npm run apk` 会把 `dist/` 打进 `android/` 提供的 WebView 壳。首次运行会自动下载 Android SDK 与 Gradle，并生成签名密钥到用户目录；`android/keystore.properties`、构建缓存和产物都不会进入仓库。

## 特别感谢

<p align="center">测试人员：kj</p>

<p align="center">感谢 kj 的反馈与验证。</p>

## 许可证

本仓库的源代码（`src/`、`tests/`、`tools/` 等）采用 [MIT License](LICENSE)。

`public/assets/` 中的图片、音频等素材，以及 `public/content/` 中派生自原版游戏的剧情、任务和文本，版权归原权利方所有，不包含在 MIT 许可范围内，仅用于学习与研究。

## 版权

游戏素材与派生内容的版权归原权利方所有，本项目用于学习与研究。

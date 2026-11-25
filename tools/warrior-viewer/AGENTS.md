# 狂战士动作与素材工作台

独立开发页面，用游戏已有的狂战士动作、战斗特效、部件与界面素材检查动画、换装、逐帧组合及整套新职业素材规格。

## 入口与文件

在仓库根目录使用现有 `npm run dev`，访问 `http://localhost:4003/tools/warrior-viewer/index.html`。4003 已经监听时直接使用当前服务。

- `index.html` 与 `style.css` 提供双视图工作台：「动作与切片检查」（动作目录、播放控制、关键帧与音效条、换装选择、当前帧切片面板）与「职业素材总清单」（跨架势动作模板表、12 部位全套切片图鉴、配套图标/特效/音效清单与规格导出）。
- `main.ts` 加载内容、部件图集及按需加载的特效/UI 图集，通过 Phaser 绘制纸娃娃部件、同步叠加战斗特效与状态染色，并连接双视图交互。
- `model.ts` 复用领域层的 `costumeRecipe`、`townMovementPoses` 与 `sharedWardrobePoses`，处理装备与佣兵预设、动作目录、关键帧与特效时间轴、边界提示、外观覆盖、切片解析、范围计算、播放状态、姿势加载、长枪样板合并与全职业素材账本。
- `prototypes/spear/` 保存长枪样板的可编辑像素源数据（`source.ts` 30 张长枪切片：同平面全长切片统一收口为 ~51.5px 标准枪长且 100% 保持正向顶光无 `scaleY: -1` 翻转，南北纵深向保留俯视近大远小透视缩短，含四向挺拔单手朝前微仰持枪切片、北向俯视透视右肋直刺切片、南北向 ~19°/~32° 窄透视微斜上挑切片、四向脱战斜背背后切片、双侧枪花居中顶光切片与全套动作，以及兼容全部 63 套盔甲的全四向挺拔双手持枪双臂预设 `SPEAR_ARMS_PRESETS`、西/东向全掌贴地实踩战斗下盘预设与兼容全部 70 款头饰/11 款角色脸型的四向技能头部/上身/披风联动预设 `headPose`、`effects-source.ts` 12 套原创像素特效）、导出脚本（`export.ts`）以及生成的透明 PNG（`spear-parts.png`、`spear-effects.png`）与整套姿态/特效数据（`spear-prototype.json`，涵盖四向挺拔单手朝前微仰持枪待机/行走、四向脱战斜背长枪待机/行走（北向压披风且位于头发/头盔之下不穿模）、直刺/横扫/立枪对照、普攻三段轻刺/横扫/上挑（其中南北向上挑与 `spear-basic-lift` 挑光采用仿原版 `heavy-swing-3` 的 ~19° 窄 J 形 3D 透视立弧，兼顾正方向指向性与不挡脸立体弧度）、6 项伤害主动技含真 3D 俯视投影左右双侧枪花与 360° 旋风枪舞且狂龙穿心破/虬龙扫暴阵/连环点枪/万圣龙王破均为零人物位移的原地施放（头部只动不转向、虬龙南向抬头平视不低头且虬龙/万圣南北向零横晃、虬龙四向横扫光弧精确对称于四正方向）、南北向全部攻击与技能均为双手实握且北向全套招式在有/无披风下双腿空隙零漏枪把、3 项自身增益双手立枪聚气与 23 帧长枪阵亡，支持多段特效与原版特效混叠）；修改像素、握点或特效后执行 `node tools/warrior-viewer/prototypes/spear/export.ts` 重导。访问 `?weapon=prototype-spear-basic`（可加 `&action=town-walk`、`&action=skill-whirl-sweep` 或 `&action=attack-3` 等）直达样板预览。
- `tsconfig.json` 为本目录浏览器 TypeScript 提供独立类型检查。

## 数据与绘制

- 从同源 `/content/wardrobe.json`、`/content/items.json`、`/content/battle.json`、`/content/story-classes.json`、`/content/menu-panels.json`、`/content/status-hud.json`、`/content/companions.json` 和 `/content/audio.json` 读取游戏数据；纸娃娃使用衣柜两张部件图集，战斗特效按需读取 `public/assets/effect-atlas/` 无损 WebP 图集，图标与职业图读取 `menu-icons.webp` 与 `menu-ui-*.webp`。姿势加载同时支持完整 JSON 与开发服务拆分后的 `/content/wardrobe/poses/<id>.json`。
- 初始为狂战士主角默认外观、基础双手剑外形、南向待机。动作目录跟随合法主副手组合，包含技能覆盖、普攻三段连击、双持、狂暴、独立的地图待机与行走，以及取自 `wardrobe.sharedPoses` 的 23 帧战斗阵亡动作 `die`（该字段仅供按需读取，不改变主游戏默认合成列表）。
- 播放普攻、双持、狂暴和 9 个主动技能时，画布默认按游戏实际事件帧叠加对应挥砍刀光、技能特效与 Buff 外观染色（如「血之狂暴」红色脉冲、「狮子吼」蓝色着色），时间轴下方标出出刀光帧、命中帧、冲锋帧与震屏帧，并支持点击跳帧与音效试听。画布背景由 Phaser 内部以最底层不透明实色或 24×24 棋盘贴图绘制（`transparent: false`），保证原版 `add`/`screen`/`multiply` 特效的纯黑底帧与背景像素正确混合，不出现透明帧缓冲黑框。
- 部位外观按「狂战士可用 / 其他职业与佣兵款式」分组；右侧支持切换狂战士角色预设（主角凯恩 + 狂战士佣兵/剧情伙伴）及主副手、盔甲、头盔、披风装备。
- 页面覆盖值仅存在于当前展示器会话。修改游戏实际外观应回到内容源文件。异步加载结果安装前校验选择版本，错误显示具体动作或切片标识。

## 操作与验证

切换顶部「动作与切片检查 / 职业素材总清单」视图。检查视图中空格暂停或继续，左右键逐帧，拖动进度条或点击关键帧标签定位；勾选「叠加特效 / 状态染色」切换表现层；点击切片的「仅看此片」会暂停，点击「显示完整角色」恢复组合视图。总清单视图支持按分类筛选全部 30 组去重动作模板并一键跳转预览，支持导出 Markdown / JSON 规格表。

```bash
npm test -- tests/warrior-viewer.test.ts tests/wardrobe.test.ts
npx tsc --noEmit -p tools/warrior-viewer/tsconfig.json
npm run validate:content
git diff --check
```

用例见 `tests/warrior-viewer.test.ts`。页面入口与真实拆包数据可通过 HTTP 请求检查；界面效果由用户在浏览器验收。

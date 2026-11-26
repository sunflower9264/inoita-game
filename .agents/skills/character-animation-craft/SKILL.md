---
name: character-animation-craft
description: >-
  Craft, refine, and verify 2.5D top-down pixel character animations, weapon slices,
  paper-doll body/arm/leg/head rigging, occlusion layering, and dual-layer pixel combat VFX
  in Inotia 4 Remake (benchmarked on the Lancer/Spear animation pipeline).
  Use when modifying existing character animations, idle/walk/town/attack/skill/die poses,
  grip alignment, head/cloak choreography, pixel slash/beam/aura effects, screen shake pacing,
  or authoring a brand-new animation set for a new weapon or class.
---

# 角色动画与特效工坊（Character Animation Craft）

本技能以已定稿的**龙枪武士（`tools/warrior-viewer/prototypes/spear/`）**为质量标杆，专管游戏内的**人物纸娃娃动画、武器像素切片、战斗像素特效与量化几何验收**。

## 快速路由（按需读取参考手册）

| 任务场景 | 先读哪份参考 | 常用工具 / 文件 |
|---|---|---|
| 改武器切片、握点、手臂、下盘、头部/披风、遮挡层序、四向身法 | [body-and-weapon-rigging.md](./references/body-and-weapon-rigging.md) | `tools/warrior-viewer/prototypes/<weapon>/source.ts` |
| 做或改刀光、枪芒、横扫弧、上挑弧、3D 舞花、护体罩、多幕大招、震屏 | [pixel-vfx-craft.md](./references/pixel-vfx-craft.md) | `tools/warrior-viewer/prototypes/<weapon>/effects-source.ts` |
| 写动画防回归断言、核查像素级几何缺陷 | [animation-qa-invariants.md](./references/animation-qa-invariants.md) | [inspect-animation-quality.ts](./scripts/inspect-animation-quality.ts) |
| 为新武器 / 新职业从零起一套动画样板 | 依次读上述三份参考 | [scaffold-animation-prototype.ts](./scripts/scaffold-animation-prototype.ts) |

---

## 工作流 A：修改现有职业动画或特效（以龙枪为例）

1. **只改可编辑源码，不手改生成物**：
   - 人物切片、握把、骨骼预设与动作帧：`tools/warrior-viewer/prototypes/spear/source.ts`
   - 像素特效色板与逐帧绘制：`tools/warrior-viewer/prototypes/spear/effects-source.ts`
   - 动作时间轴、出光帧、命中帧、震屏与音效：`tools/warrior-viewer/prototypes/spear/export.ts`
2. **重新导出工作台预览包**：
   ```bash
   node tools/warrior-viewer/prototypes/spear/export.ts
   ```
3. **先跑自动化像素体检与单测**（秒级揪出手武器分离、破顶光、走路腿、北向漏把、抖头与贴图超限）：
   ```bash
   node .agents/skills/character-animation-craft/scripts/inspect-animation-quality.ts \
     --prototype tools/warrior-viewer/prototypes/spear/spear-prototype.json
   npm test -- tests/warrior-viewer.test.ts
   npx tsc --noEmit -p tools/warrior-viewer/tsconfig.json
   ```
4. **交由用户在工作台逐帧目检**（遵守项目规则：不主动调用无头浏览器，4003 端口若已在监听直接复用）：
   - 打开 `http://localhost:4003/tools/warrior-viewer/index.html?weapon=prototype-spear-basic&action=<动作键>`
   - 检查三底色（浅灰 / 深底 / 草地）× 四外观（默认 / 重甲 / 头盔 / 无披风佣兵奥拉夫）。
5. **动画定稿后同步进正式游戏资源与图集**：
   ```bash
   npm run spear:build && npm run atlas:all
   npm test -- tests/spear-class-integration.test.ts tests/wardrobe.test.ts
   ```

---

## 工作流 B：为新武器 / 新职业起一套动画样板

1. **一键生成开箱可运行的动画样板骨架**：
   ```bash
   node .agents/skills/character-animation-craft/scripts/scaffold-animation-prototype.ts \
     --weapon <weaponKind> --name <中文武器名>
   ```
   自动创建 `tools/warrior-viewer/prototypes/<weaponKind>/`（含 `source.ts`、`effects-source.ts`、`export.ts`），自带 14 色像素绘制工具、兼容全盔甲/下装/头饰的纸娃娃装配器与 3840 宽货架特效装箱器。
2. **导出并在工作台挂载预览**：
   - 执行 `node tools/warrior-viewer/prototypes/<weaponKind>/export.ts` 产出 `*-parts.png`、`*-effects.png` 与 `*-prototype.json`。
   - 参照 `tools/warrior-viewer/main.ts` 加载 `./prototypes/spear/spear-prototype.json` 的方式挂接新样板 JSON。
3. **按四批次递增打磨动作与特效**（每批跑一次 `inspect-animation-quality.ts`）：
   - **第 1 批（基础循环）**：四向 `idle`、`walk`、脱战背负 `town-idle` / `town-walk`（东向统一 `mirrorX: true` 复用西向）。
   - **第 2 批（普攻连段）**：`attack` / `attack-2` / `attack-3` 三段节奏立体互补（如轻刺 → 横扫 → 上挑，无控制无震屏），配素银克制挥砍光。
   - **第 3 批（主动技与增益）**：伤害技各自建立辨识度（单点穿透 / 广角横扫 / 360° 旋风 / 高频连击 / 重劈震地 / 多幕大招），增益技共用一套干净聚气姿态。
   - **第 4 批（收尾与护栏）**：补齐 23 帧阵亡动作（与原版 `sharedPoses.die-*` 同口径），在 `tests/warrior-viewer.test.ts` 固化本武器专属几何断言。

---

## 十大动画铁律（龙枪实测沉淀）

1. **武器零 `scaleY: -1`**：严禁垂直翻转武器切片，会颠倒顶光高光与软饰重力；反斜向必须独立出切片。
2. **同平面统一尺寸、纵深向合理透视**：东西/斜平面武器长度统一锁死（长枪 50–53px 防橡皮筋拉伸），南北纵深向适度缩短（~37–43px）体现俯视透视。
3. **全换装通用骨骼**：手臂只用 63 套上衣共有的 `coat-front[5..14]` 且 `angle: 0`（禁用旋转怪手与刺客猫背 `[15]`）；非行走招式下盘只用 62 套下装共有的贴地战斗腿 `coat-back[6, 11, 18]`（严禁混入走路腿 `[7..10]`）。
4. **头脸颈成组同步、非旋转招式只动不转向**：`body`（脸/颈）与 `head-front` / `head-back` 必须按 `HEAD_VIEW_PIECES` 严格同步 `(piece, x, y, scaleX)`；除 360° 旋风类外，锁定本朝向切片、南北向 `head.x === 0`、位移反转不超过阈值，杜绝啄木鸟抖头或低头埋胸。
5. **手与武器严丝合缝**：日常单手提持落在黄金重心位（空手保持净空不穿模），战斗招式双手像素贴紧合法握杆区（与武器最小距离 `<= 4px`，南向双拳拉开间距不叠拳）。
6. **北向双腿裆部零漏像素**：全部北向战斗动作（无论有/无披风）在双腿间 `x ∈ [-4, 4], y ≥ -8` 绝不能露出武器柄尾，也不得混入头顶悬空臂。
7. **原地招式下盘不滑步**：原地释放技能时 `coat-back` 脚心水平/垂直漂移控制在极小范围（`<= 3.5px` / `<= 4px`），靠躯干前倾、披风翻飞与特效延展做冲击力。
8. **东西横扫饱满 180°、南北上挑窄 J 不挡脸**：西/东向横扫必须从北侧起势经正侧扫至南侧前景；南/北向上挑采用 ~19° 窄透视立弧，既有方向感又不挡脸。
9. **像素特效双层无黑框 + 货架装箱防爆显存**：全部特效采用 `normal` 底光 + `add` 炽核双层；半透明护体罩 `base` 层严禁深暗低亮色（避免灰底/草地黑边），收尾原大原地渐隐不收缩；大尺寸特效用 `<= 3840px` 货架装箱防超过 WebGL 4096 上限。
10. **克制震屏与保持原色**：出光帧早于命中帧 1 帧制造打击前置感；大招不滥用角色整体变色染色；全职业只留 1–2 个核心重击/大招主爆发帧触发强制震屏。

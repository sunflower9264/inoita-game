# 艾诺迪亚 · 故事：全游戏性能审查与修复路线

- 审查日期：2026-10-25
- 对应提交：`891a357`（`main`）
- 范围：整个游戏，不止战斗/资源/地图；含构建、存档、剧情、菜单、输入、安卓壳
- 状态：审查记录与修复路线；P0.6 绿色基线与 P1.1 高频 emit 链路已于 2026-10-25 实施，见第 12 节。本文中的行号会随代码变化漂移，优先按函数名和文件检索
- 方法：8 路只读模块审查 + 1 路综合评审；Node 内容统计/微基准；**未启动浏览器，未修改运行时代码**

> 证据标签：**【已证实】** = 代码路径、内容统计或可复现微基准；**【估算】** = 按文件尺寸/帧矩形推算，量级可信但非绝对值；**【待测】** = 必须用真机 Performance/Renderer 面板确认。

---

## 0. 一页结论

用户说“这个游戏应该不怎么吃性能”，这个判断是对的。当前卡顿主要不是设备弱，而是实现做了大量可避免的工作。按影响从大到小：

1. **纹理超集与请求风暴（首次进图/Boss 图最重）**
   首次进图并集约 **4,248 个贴图键、约 2.1 GB 解码纹理下限**；其中“常驻战斗包” **3,363 键 / 2,060 MB**，首次进图后永不释放。常驻包 **70% 的键是字节完全重复**的内容；四个大招占常驻包约七成；龙系 Boss 单角色全 clip **433 MB**、黑暗势力 Boss **287 MB**。加上 24.9 MB 内容 JSON、281 张剧情地图、678 张菜单图，首次进入前约有 **5,000+ 次资源请求**（世界加载 6 并发）。

2. **高频 emit 链路随背包变大而恶化（越到后期越卡）**
   `StoryDirector.observeChanges` 每次 `session.emit()` 都遍历背包并逐件 `itemCount`，而 `Bag.count` 每次重建全量计数，复杂度 O(n²)。本机实测 **201 件 1.62 ms、801 件 19.2 ms / 次 emit**；战斗中每次掉血、每次恢复脉冲都会 emit。主角 `BattleCharacter.panel` 没有缓存，9 件装备时 **46 µs/次**，每帧多次调用。`healthChanged` 每次受击扫描 593 条事件；quest marker 每次通知约 **角色数 × 505** 次任务判断。

3. **敌人 A\* 无预算同步全图搜索（战斗卡死的直接机制）**
   `enemy-ai.ts` 的 `findPath` 没传 `maxExpanded`，目标不可达时会把连通分量搜完。本机 50×57 图、46 actor 实测 **可达 2–17 ms、不可达 12–90 ms / 次**，每 180 ms 重试；`NavigationWorld.canStand` 每次分配 Map/矩形/shape，**11.9 µs/扩展**。`stepDelta` 上限 180 ms 仍允许一次渲染帧跑 3 个逻辑帧，会把尖峰放大 3 倍。

4. **移动端绘制被“无图集 + 每批 1 纹理 + DPR 3”放大**
   每张地图只有 2 张整图 + 42（最大 134）个 feature Image，但移动端 Phaser 默认每批只允许 1 张纹理；按深度排序后每图 **47–127 次纹理切换**。手机画布约 2.6–3.0 MP，桌面 Retina 约 5.2 MP；canopy 抽样 64%–100% 全透明，仍是整屏 alpha pass。

5. **逐帧全量重算（稳定掉帧与 GC）**
   地面掉落每帧 `structuredClone` 最多 64 件；快捷栏/冷却每帧重算重画；`syncHud` 每帧构造 100–200 个临时对象；`syncDepth` 每帧对全部角色写 depth 并置排序脏位；`recoverResources` 每逻辑帧构建全 actor 属性，而恢复脉冲实际 1.86 s 一次；593 条剧情事件每帧全量扫描。

6. **剧情/菜单/存档的“打开时卡一下”**
   每句对白触发 3–4 次 `FormalUiScene.sync` 全量 clear/重建；演出时 WorldScene 没 sleep，和 StoryStageScene 两套场景同时 update/渲染。菜单每次点击整页重建，商店/合成/队伍存在双重建；滚动区遮罩每帧重做。存档页一次打开会全量 `JSON.parse` 22–33 次。

**最可能立即见效的七件事**：

1. 先把手机测试从 4003 开发服务切到 **4002 构建产物或 APK**，并加低频帧时间采样。
2. 修高频 emit 链：`observeChanges` 去 O(n²)、`BattleCharacter.panel` 缓存、事件/任务索引。
3. 敌人/队伍寻路改成冻结快照 + 跨帧增量 + **全局每渲染帧扩展预算**，并修 `canStand` 分配。
4. 纹理内容去重（预计 **-846 MB / -2,693 键**，零画质）+ 常驻包缩围 + 返回菜单释放。
5. 生产环境删除运行期重复语义校验；不再 fetch 281 张剧情地图；`campaign.json` 构建期 minify（9.46 → 4.28 MB）。
6. 逐帧脏检查：掉落、快捷栏/冷却、syncHud、recoverResources、syncDepth、静态 body。
7. 剧情/菜单：演出时睡掉 WorldScene；对白增量更新；菜单 render 合并；滚动遮罩静态化；存档摘要缓存。

**JSON 结论（详见第 6 节）**：保留“数据是数据”，但停止把导出的原始 JSON 当运行时格式。作者态 JSON → 构建期校验/编译/拆分 → 运行时紧凑 IR + TS/Phaser 消费。技能保留 JSON 作者态合理，但数值、行为事件、预格式化展示文本要分开；`details/valueParts` 应从数值派生。

---

## 1. 怎么查的、证据到哪一步

### 1.1 覆盖的模块

| 模块 | 覆盖内容 |
|---|---|
| 战斗 / AI / 寻路 | CombatRuntime、WorldCombat、敌人/队伍/召唤 AI、NavigationWorld、路径预算 |
| 资源 / 纹理 / 音频 | 入口计划、AssetLease、常驻包、Boss clip、音频预载/解码 |
| 地图 / 渲染 / HUD | 地图整图+feature、DPR、Phaser 批处理、快捷栏/状态栏/掉落/相机 |
| 剧情 / 任务 / 对白 / 演出 | StoryDirector/Runtime/World、StoryPresenter、story-stage、对白/选择/任务弹窗 |
| 菜单 / UI / 背包 / 商店 / 合成 / 任务日志 | StoryUI/GameUI、Phaser 面板、菜单场景、UI 布局 JSON、菜单图预载 |
| 存档 / 会话 / 队伍 / 经济 | save/load/checkpoint/autosave、Session、party、bag/items/drops/shop/crafting |
| 移动 / 物理 / 交互 / 输入 / 安卓 | Arcade Movement、Navigation、相机、小地图、拾取、摇杆/键盘、resize、WebView |
| 构建 / 部署 / 校验 / 测试 / APK / 诊断 | Vite/build/validate/deploy/serve/APK、诊断上报、bundle/cache、测试体系 |
| 数据驱动 / JSON 边界 | 全量 JSON → 运行时/构建期/代码/Phaser 内置的分界、专家评审、钢人论证 |

### 1.2 证据等级

- **【已证实】**：能直接在代码里指出调用路径，或用仓库真实内容/Node 微基准复现。
- **【估算】**：例如“纹理解码 MB”按 `宽 × 高 × 4`、帧矩形和加载清单推算；实际 GPU 上传时机、浏览器回收、压缩格式会改变绝对值，但量级成立。
- **【待测】**：需要真机 Performance、Memory、Network、Spector.js 或 `chrome://inspect` 才能定性。

### 1.3 测量基线必须先纠正：4003 ≠ 4002

现有 `.diagnostics/client-errors.jsonl` 里的手机记录全部来自 **4003 Vite 开发服务**（iPhone，`http://172.20.10.3:4003/`），且没有进入世界的性能样本。两者差距极大：

| 维度 | 4003 Vite dev | 4002 dist |
|---|---|---|
| JS 模块数 | **241 个**（240 src + 1 phaser 预打包） | 1 个入口 JS |
| JS 原始体积 | **26.69 MB**（Phaser 21.0 MB + src 5.71 MB，含内联 sourcemap） | 2.31 MB |
| 压缩 | 无 gzip | gzip 630 KB |
| 缓存 | `no-cache` | bundles immutable；带 `?v=` 的资源 immutable |
| 代码形态 | 未 minify、未 tree-shake、模块间接层多 | minify + tree-shake + 单 chunk |
| `campaign.json` | 9.92 MB 原样 | gzip 637 KB |

**手机上的性能结论只能基于 4002 或 APK。** 4003 只用于功能调试。当前 4002 未监听、4003 在监听；测试前先启动 `npm run serve` 或安装 APK。

### 1.4 当前测试是红的（前置事实）

- `tests/` 有 361 个测试文件；`node tools/test.ts --all` 约 38 s，退出码 1。
- ~~`tests/title-save-entry.test.ts` 单跑仍 2/11 失败~~ → **已修**（2026-10-25，11/11）。`tests/story-menu-interactions.test.ts` 的 fixture 也已补齐全屏监听所需的 `document` 替身，套件从 0/52 恢复到 39/52；剩余 13 条为既有失败。
- 全量套件里仍有既有失败（战斗运行时 4 条、菜单 13 条等），改动前已在 HEAD 复现；后续改动需以“同文件失败数不增加”为准。

---

## 2. 第一性原理：五条成本法则

1. **活跃集合法则**：每帧成本应跟“当前活跃的单位/可见的对象/正在进行的任务”成正比，而不是跟总内容成正比。
   - 违反：常驻全职业/全伙伴、全图敌人 step、593 条事件每帧扫描、281 张地图启动加载。
2. **使用粒度法则**：资源应在“使用它的粒度”加载，在“不用时”释放。
   - 违反：首图 4,248 键/2.1 GB、常驻包永不释放、20 张预取地图、Boss 全 clip、BGM 换歌立即删缓存。
3. **运行时表示法则**：运行时消费的应是紧凑、预校验、面向消费的格式，不是作者/导出格式。
   - 违反：26 MB 原始 JSON、运行时重复语义校验、技能 JSON 混行为与展示字符串、运行时加载 281 张地图做校验。
4. **变化驱动法则**：每帧工作应由“值变了”驱动，而不是无条件重算。
   - 违反：快捷栏/冷却/掉落 clone/syncHud/状态颜色/buff loop/depth/quest marker。
5. **批处理与填充率法则**：移动端绘制成本由“纹理切换/批次/填充像素”决定，不是对象数。
   - 违反：无图集、移动端每批 1 纹理、DPR 3、全透明 canopy 整屏 alpha、特效 5–16 层不同纹理/混合模式。

这五条也是修复方案的组织方式：先让成本跟活跃集合走，再让资源按粒度加载/释放，再改运行时表示，最后处理批处理与填充率。

---

## 3. 帧预算与时间基准

- 渲染帧目标 60 FPS，预算 **16.7 ms/帧**。
- 战斗逻辑帧 `LOGIC_FRAME_MS = 60`，即约 **16.7 逻辑帧/秒**；`WorldCombat.update` 每渲染帧调用，只有累计满 60 ms 才执行逻辑帧回调。
- `stepDelta = Math.min(delta, 180)`：卡顿时一次渲染帧最多追 3 个逻辑帧。这个上限防住了无限追赶，但没有防住“3 波 AI/寻路/状态”叠加。
- 移动端还有一个额外成本：`configureCanvas` 把画布放大到 `min(3, DPR)`，逻辑视野不变，但物理像素是 CSS 的 density² 倍。iPhone 393×665、DPR 3 → 画布约 **1179×1995 ≈ 2.35 MP**；桌面 Retina 1440×900、DPR 2 → **5.18 MP**。

一帧的钱分成四份，本文按这四份归因：

| 成本 | 主要模块 | 典型问题 |
|---|---|---|
| 主线程 JS：逻辑、AI、UI 投影、分配/GC | 战斗、AI、会话、HUD、掉落 | 同步 A\*、O(n²) emit、每帧 clone/临时对象 |
| 主线程阻塞：加载/解析/校验/解码/上传 | 资源、内容、存档 | 4,248 贴图、24.9 MB JSON、281 张地图、运行时校验 |
| draw call / 纹理切换 | 地图、角色、特效、UI | 无图集、移动端 1 纹理/批、特效多层 |
| 填充率 | 地图、canopy、DPR、全屏特效 | DPR 3、透明 canopy、全屏 alpha |

---

## 4. 全模块审计

### 4.1 纹理、资源加载与音频

**结论：这是最大的隐性成本。**

【已证实】首次进图的并集（样本：起始图 `shadow-camp`、黑暗骑士、11 张剧情预取；不同职业/地图会变，量级一致）：

| 阶段 | 唯一贴图键 | 解码纹理下限 | 磁盘 | 相对上阶段增量 |
|---|---:|---:|---:|---:|
| `sharedEntryAssets` | 321 | 41 MB | 2.3 MB | +321 / +41 MB |
| 当前地图视觉+战斗 | 411 | 553 MB | 3.5 MB | +272 / +534 MB |
| 常驻战斗包 | 3,363 | **2,060 MB** | 25.6 MB | **+3,123 / +1,512 MB** |
| 剧情预取 11 张图 | 931 | 596 MB | 6.1 MB | +532 / +44 MB |
| **首次进图并集** | **4,248** | **2,131 MB** | 30.6 MB | — |

- 常驻包由 `resident-combat-assets.ts` 生成，加载 **6 个职业全部技能 + 41 个伙伴外观 + 共享特效**；首次进图后 lease 永不释放。
- **70% 的键是字节重复**：3,363 键只有 1,007 个唯一像素内容；首次进图 4,248 键只有 1,555 个唯一内容。去重可省 **826–846 MB**，零画质变化。1,103 个重复组的帧布局完全一致，只有 `mirrorX` 不同，运行时已用 sprite 翻转处理，合并安全。
- 四个技能特效占常驻包 **1,512 MB（71%）**：`hellsword-swing` 496 MB、`rampage-burst` 543 MB、`freeze-shard` 259 MB、`blinding-flash` 213 MB。
- Boss 全 clip：龙系 **433 MB**（skill clip 352 MB）、黑暗势力 **287 MB**（skill clip 229 MB）。`characterAssets` 返回 actor 的全部 clips，包括只在特定技能中用的 `skill-*`。
- 普通切图相对常驻包新增中位数约 **10 MB**；Boss 图新增 **290–441 MB**。
- 释放策略：地图历史保留 3 个 lease；剧情预取最多 20 张；常驻包无释放调用；返回菜单不清地图历史。
- 音频：183 个文件 / 17.4 MB；BGM 完整解码 24–28 MB/首；**28.9% 的地图出口会换 BGM**。✅ 已保留上一首解码缓存（2026-10-25），往回切图不再重新解码；首次战斗预载 **131 个 SE / 18.1 MB 解码**，异步不阻塞。预载策略保留：首次播放不允许慢半拍。

**修复方向（按收益/成本）**：
1. 构建期内容哈希去重，canonical key 或 loader alias；预计 **-846 MB / -2,693 键**，零画质。
2. 常驻包缩围：只留当前职业 + 当前队伍 + 共享效果；当前职业/队伍已由每图 `planMapCombat` 覆盖，伙伴入队已有 `partyMemberCombatAssets` 路径。
3. 返回菜单/新游戏释放常驻包与地图历史；`storyPrefetches` 从 20 张改为字节预算。
4. 技能级/角色 clip 懒加载：基础 clip（idle/walk/attack/die）+ 当前快捷栏/遭遇技能；Boss `skill-*` 在战斗前加载、打完释放。
5. 图集：先做地图 props 与 UI 菜单图；角色/特效图集二期。
6. 音频保持预载：BGM 保留上一首解码缓存（2026-10-25）；不做流式，也不收窄 `prepareCombat`。首次播放不允许等加载，见第 8 节决策记录。

**验证/风险**：去重前后逐场景截图 diff；`residentCombatCoverageGaps` 零缺口；Boss 首次技能释放的加载体验；低端机纹理内存/上下文丢失。

### 4.2 战斗、AI 与寻路

**结论：敌人 A\* 是全游戏最确定的毫秒级尖峰来源。**

✅ **已修（2026-10-25）** 【已证实·改造前】`enemy-ai.ts` 的 `navigate`/`wander` 调用 `findPath` 时没有传 `maxExpanded`（默认 `Infinity`）。目标不可达时会把整个连通分量搜完：

- 50×57 地图、46 actor、约 400 px 路程：**694 扩展 / 15.8 ms**；不可达：**7,026 扩展 / 89.6 ms**（桌面 Node）。
- 40×35 有障碍、1 actor：277–1,736 扩展 / **1.9–12.5 ms**；不可达 4,792 扩展 / 12.5 ms；46 actor 时约 **50 ms**。
- 敌人每 **180 ms** 重试一次；多个敌人同逻辑帧重算会叠加。
- ✅ **已修（2026-10-25）** `NavigationWorld.canStand` 现在只补人物占位；空 `placements` 不再建 Map，重叠判定不再分配临时矩形。实测基线 **11.9 µs/扩展**，只查地形 2.8 µs。
- ✅ **已修（2026-10-25）** 队伍跟随：玩家每逻辑帧移动 8 px，正好等于 `moved` 阈值 8 px，所以玩家行走时每个队员**每逻辑帧**重算一次 1024 预算 A\*。现在改为队长移动 ≥24 px 且距上次重算 ≥180 ms 才重算，单次上限 384，预算不足下一帧再试。
- ✅ **已修（2026-10-25）** `stepDelta` 180 ms → 最多 3 个逻辑帧；一次卡顿会触发 3 波 AI/寻路。现已降到 120 ms（最多 2 帧）。

**项目内已有正确范式**（本次已复用）：`friendly-summon-ai.ts` 用 `navigation.captureStandability(actor)` 冻结通行快照 + `createPathSearch(...).step(64)` 跨帧增量 + 失败退避。

**修复方向**：
1. ✅ 敌人/游荡/队伍跟随统一改成冻结快照 + 跨帧增量 + 失败退避。
2. ✅ **加全局每渲染帧扩展预算**（当前统一 512，每次推进 128）。不能把 `step(64)` 直接复制给 46 个敌人：46 × 64 × 11.9 µs ≈ 35 ms/逻辑帧。
3. ✅ `canStand`：空 placements 早退、去重复地形查询、避免临时矩形。
4. ✅ 队伍跟随：阈值 8 px → 24 px，预算 1024 → 384。
5. ✅ `stepDelta` 逻辑步上限压到 2（180 → 120 ms）。
6. `walk-route.ts` 和 `canReach` 的同步 512 节点搜索也要预算或分帧。

**验证/风险**：路径基准 p95/最大扩展；AI 反应慢 1–2 帧、路径质量变化需实机验收；全局预算可能导致远处敌人晚几帧开始追。

### 4.3 战斗帧循环、状态与掉落

**结论：单次快照/条件更新不慢；问题在“每帧/每次 emit 的无条件全量投影”。**

- 【已证实】`CombatRuntime.step` 的 filter/sort、`CombatController.snapshot()`、`CombatConditions.update` 实测都很小（µs 级），不是主因。
- ✅ **已修（2026-10-25）** `WorldCombat.update` 每渲染帧对全部 player/ally/enemy 做 `setCharacterStealth`、`statusColors.paint`、`setPaused`。`statusColors.paint` 按（着色规则、逻辑帧、图层批次）同值短路；`setPaused` 同值直接返回，新刷出的敌人/召唤物与入队队友会使缓存失效。
- ✅ **已修（2026-10-25）** `syncBuffLoops` 每帧对每个 actor 调 `buffLoopFrames`（多层分配），再进 `BuffLoopRenderer.sync` 分配 Map/Set。无 buff 时现在返回共享空数组，渲染器也不再建 Map/Set。
- ✅ **已修（2026-10-25）** `recoverResources` 每逻辑帧构建全 actor 恢复属性，但脉冲间隔约 1.86 s。现在非脉冲帧只推进恢复时钟，不构建属性。
- `roster.refresh` 每渲染帧；`updateEnemies` 每逻辑帧对全图所有敌人 step（无视野裁剪）。✅ 其中与 `syncDepth` 重复的 `setDepth` 已删除（2026-10-25）。
- `observeSummonCombat` 每逻辑帧构造全量 `combatants()` 并为每个敌人 snapshot，即使场上无召唤物。
- `afterMovement` 每渲染帧对每个 ally/enemy `controller.snapshot()`。
- 地面掉落：`GroundLootStore.forMap` 每帧 `structuredClone` 当前图所有掉落（上限 64）。✅ 已加 revision，只在掉落变化时克隆并重建视图（2026-10-25）；`collectNearby` 每帧扫描全局掉落仍未分桶。
- `completedStoryEncounters` 每帧通过 `storyWorld.activeEncounters` + `structuredClone` 判断新成果。

**修复方向**：给状态/条件/掉落/roster 加 revision/dirty；`recoverResources` 按脉冲早退；`setPaused` 同值早退；`syncBuffLoops` 无 buff 快速返回；`updateEnemies` 远处敌人降频；去除重复 `setDepth`；掉落按地图分桶 + 只读视图 + revision 驱动视图。

### 4.4 地图渲染、视口与相机

**结论：地图画法本身是高效的；移动端成本来自纹理切换、填充率和 DPR。**

【已证实】`drawMapLayers` 不是逐格绘制：每图 1 张整图 ground + 1 张整图 canopy + 每个 feature 一个 Image。全 416 图：feature 平均 42.2、中位 40、最大 134；起始图 83 个 feature、17 个唯一贴图。

- Phaser 4 移动端 `autoMobileTextures=true`（`Config.js:352`），`RenderNodeManager` 非桌面设备 `maxParallelTextureUnits=1`；当前批次纹理数到上限就提交。按 feature 的 `y` 深度排序，起始图约 **74 次纹理切换**，典型战斗图 **47 次**，最大图 **127 次**。
- 普通 Image 没有渲染视锥剔除；85–136 个 feature 每帧都会提交，即使不在屏幕内。
- canopy 抽样全透明像素：shadow-camp 99.3%、snowfield-1 99.9%、eternal-snowy-valley 100%、pendrik-village 94.1%、最大 canopy 64.0%。每帧仍是整屏 alpha pass。
- `configureCanvas` 使用 `min(3, DPR)`；`worldZoom` 又把缩放乘回，逻辑视野不变，物理像素是 density² 倍。
- `batchSize: 4096` 低于 Phaser 默认 16384；当前 quad 数远小于 4096，没有收益，属于无意义下调。
- 物理：Arcade 默认 `useTree: true`，group vs group 用 RTree，不是全量两两检测；典型 body <50，不是主因。

**修复方向**：先做地图 prop 图集（10–28 张/图 → 1–3 次切换）；canopy 包围盒裁边/分块跳过全透明块；DPR 上限/画质档（默认 2，低端 1.5，需视觉验收）；恢复 `batchSize` 默认；`autoMobileTextures` 只做 A/B 实验，不盲改。长期再评估 `SpriteGPULayer`/`TilemapGPULayer`，不要与图集同时上两套。

### 4.5 角色与特效渲染

- 全量 7,243 个 clip 中 7,182 个是单图层，角色 draw call 主要等于可见角色数；主要问题是每个 clip 一个独立 spritesheet（佣兵 76 个文件/角色），请求数和纹理绑定多。
- `replaceLayers` 每次动作/转向重建 sprite；`playCharacterSequence` 每次普攻/技能重建并 `anims.create`。频率是“每次动作”，不是每帧；战斗瞬时抖动，不是稳态主因。
- 特效：每次命中 `createEffect` 建 Container + 多层 Sprite；投射物方向变化时 `setEffectClip` 销毁/重建全部层；`rampage-burst` 16 层、`freeze-shard` 10 层、`blinding-flash` 7 层，混合模式频繁打断批次。
- `BuffLoopRenderer.sync` 每帧为每个角色建 Map/Set、`setCurrentFrame`、`bringToTop`；无 buff 也分配。
- `StatusColorRenderer.paint` 每帧对全部有色 actor 更新 color matrix；启用 filter 时 Phaser 走额外离屏通道，移动端成本待测。
- 项目中 **没有使用 Phaser ParticleEmitter**；原版逐帧特效自研合理，但通用火花/烟雾可评估内置粒子，不建议重写原版特效。

**修复方向**：角色/特效图集二期；投射物按 heading 建有限 Sprite 池而不是每次 destroy/create；buff/status 加 revision；大特效降采样/压缩纹理（`rampage-burst` 543 MB，2× 降采样可到约 136 MB）。

### 4.6 HUD、输入、移动与物理

- ✅ **已修（2026-10-25）** `refreshSkillCooldowns` 每渲染帧 `setCooldowns → paint()`。现在按冷却读数签名门控，没有冷却变化时不再重画六格；`refreshShortcutPage` 本身已有 layout/槽位缓存。
- ✅ **已修（2026-10-25）** `syncHud` 每帧先算 `targetStatus()`（含 `calculateEnemy`、`combatants()` 全量数组）和 `hasHostileTarget()`。现在按 `(combatTick, 目标 id)` 缓存，同一逻辑帧内的多个渲染帧只算一次。
- `Hud.setVisible`、`statusHud.setVisible`、`overheadStatus.setVisible`、`NameBanner.sync` 每帧无条件写；`MoveStick.setVisible(false)` 每帧走 `reset()` → 4 个箭头 `setTexture`（PR 4b6dd64 的小回归）。
- ✅ **已修（2026-10-25）** `MovementWorld.syncDepth` 每帧对所有注册容器 `setDepth`；Phaser 的 depth setter 会 `queueDepthSort()`。现在值没变就不写。典型地图 60–70% 的 body 是不可移动的地图实体，但它们仍参与每物理步的约束查询、`settleStep`、插值和深度。
- `MovementInterpolation` 每帧 3 次 restore + 1 次 apply，遍历全部注册视觉；`MovementBody.update` 每个 body 每步产生约 8–10 个小对象，60–70 body ≈ 3–4 万对象/秒。
- `WalkRoute.next` 每步两次 `canTraverse`，同一段路重复采样。
- `afterMovement` 每帧 593 条事件、92 条 near filter、每条 near 再 `characters.find`；出口平均 7.4、最大 36，本身便宜。
- ✅ **已修（2026-10-25）** quest marker：`markerActor` 现在按 `(questBook.version, 调试焦点, actor)` 缓存；`marker()` 原本就有 `npcQuestSlot` 投影缓存。
- 输入、相机、小地图地形、出口、resize 都是事件驱动或低频；没有每帧轮询/泄漏。
- Android：dist 约 237 MB；WebView 已开硬件加速；全屏/系统栏滑动会触发 viewport resize + `ui.resetInput()`，可能表现为“移动中突然停一下”。

**修复方向**：快捷栏/冷却签名 + 10–15 Hz；`syncHud` 目标/敌意事件化或 10 Hz；HUD 可见性同值短路；`syncDepth` 同值跳过、静态 body 跳过约束/插值；掉落 revision；quest marker 按 questBook 版本缓存；`WalkRoute` 只算一次；`structuredClone` 在旧 Android WebView 是 JS polyfill（`browser-compat.ts`），热路径更要避免。

### 4.7 剧情、任务、对白与演出

**结论：领域层优化得不错；主要成本在表现层重复重建和双场景渲染。**

- 【已证实】`StoryRuntime` 事件按来源索引、QuestBook 写时复制、`session.quests` 按版本缓存、`refresh()` 无变化早退；条件求值、`waitEncounter` 状态机、对白分页/打字机算法都很便宜。**不要重写这些。**
- 每句对白：`GameUI` 至少触发 3 次 `FormalUiScene.sync`，有立绘 4 次。✅ 同一句对白翻页时不再整屏重建（2026-10-25）：框、立绘、说话人和控件保留，正文 Text 按位置复用；新对白/换立绘/选项/弹窗仍整屏重建。长演出里**翻页**这部分的全量重建已消掉。
- 演出时 `scene.launch('story-stage')` + `moveAbove`，WorldScene 没有 pause/sleep；舞台相机底色只是遮住，下层仍在 update/渲染（两套地图/角色/物理/相机）。
- 每个演出动作（face/appear/walk/leave/world-object）走 `captureStage()` + `applyStorySceneAction`，多次 `structuredClone`；全内容约 7,400 个这类动作。跨图演出 `scenes` 历史增长后，每次快照越来越贵。
- 每个剧情节点：`capture()`（session + world + stage）、提交时克隆 commit/checkpoint/stage、`session.applyStoryCommands`（空批次 0.48–1.25 ms）等，组合约 1–3 ms/节点。
- ✅ **已修（2026-10-25）** 每次受击 `healthChanged` 用 `campaign.events.find` 扫最多 593 条事件（实际只有 19 条 battle 事件）。事件表已按 `source`/`key` 预建索引。
- 每次 emit 的 `observeChanges` 见 4.9（O(n²) 背包扫描）。
- `campaign.json` 9.46 MB，压缩空白后 4.28 MB；运行时校验 + 两次图克隆约 250–300 ms（桌面 Node）。
- 内容量：693 脚本、3,635 节点、25,568 演出动作、4,653 句对白、505 任务、593 事件。

**修复方向**：演出时 sleep/暂停 WorldScene；对白 UI 增量更新（同立绘、仅文本变化不 clear）；`captureStage`/`committed` 用 diff，只对变化演员克隆；`healthChanged` 建 `(source,key)` 索引；`validateStoryGraph` 构建期做一次；`campaign.json` minify + 按章节拆；事件/任务预索引。

### 4.8 菜单、背包、商店、合成与任务日志

**结论：菜单图片预载做得对；卡顿来自整页重建、双重 render、滚动遮罩和存档 parse。**

- 菜单图片 654–697 张、约 4.1–4.6 MB、解码约 15 MB，返回菜单释放；打开面板无网络 IO，这是正确的。
- 每次点击/状态变化：`StoryUI.render()` 先清空 `surface/body/description/modal` 和所有 `ScrollArea`，再整页重画。✅ `show()` 末尾重复的 `sync()` 已去掉；商店买卖、队伍加入/移出、合成成功都不再重画第二次（2026-10-25）；失败路径仍本地重画以显示错误。
- 商店购买/出售、合成提交、队伍变更、恢复药水：session emit 触发一次 render，`changed()` 再一次，**同一次操作双重建**。
- 单次打开约 130–350 个 GameObjects、17–80 个 Phaser Text；每个 Text 有独立 canvas 纹理，3× DPR 下创建/销毁几十张高分辨率文字纹理会造成数 MB GPU 上传。
- ✅ **已修（2026-10-25）** 滚动区在 WebGL 下用 `enableFilters + addMask`；`FilterMask` 默认每帧 `updateDynamicTexture`。现在 `autoUpdate=false`，只在遮罩几何变化时置 `needsUpdate`。
- 存档页：`newestFirstSlots` 排序比较器反复 `inspect`，每行再 `inspect`，自动槽再 1 次，立绘再 10 次；一次打开约 **22–33 次全量 JSON.parse**。✅ 已加 `peek` 摘要缓存（2026-10-25）：排序/行/立绘只用摘要，同一份原文只解析一次；读档才 `inspect` 完整存档。
- 非虚拟列表：任务日志按全部活跃组渲染；GM 道具页 1003 件全画（`ScrollArea.setVirtual` 已存在但未用）。
- 小开销：说明分隔线每 8 px 一个 Rectangle（353 宽约 44 个）；round band 每行 9 个对象；`save-board` 先画文字再 `setText` 重画；`MemberPanel` 每次数值变化重建 hitArea。
- `status-hud.json`/`menu-panels.json` 是小型布局/皮肤数据，保留；不要扩成通用布局引擎。

**修复方向**：同帧 render 合并；静态遮罩 `autoUpdate=false`；存档摘要缓存（单独 summary key，打开存档页不再 parse 全档）；任务日志/GM 列表虚拟化；局部重绘；Text 复用/减少 3× resolution 的临时对象；`MemberPanel` hitArea 只建一次。

### 4.9 存档、会话、队伍与经济

**结论：存档频率和大小合理；真正的问题是高频 emit 链路和主角面板重算。**

- 自动存档：去抖 1.2 s、最小间隔 2 s、5 分钟定时；触发进图/剧情事件/任务/定时。检查点只在进图和剧情世界投影后捕获，不是每帧。
- 存档约 **211–300 KB**；检查点捕获 1.14–1.76 ms；写盘 0.73–0.87 ms；读档 parse 0.4–0.5 ms（桌面 V8）。11 槽合计接近 localStorage 5 MB 配额，晚期状态可能 4.4 MB。
- ✅ **已修（2026-10-25）** **`StoryDirector.observeChanges` 每次 emit**：`bag.entries` 深拷贝全包，循环内每件 `session.itemCount`，而 `Bag.counts` 每次重建 Map → O(n²)。实测 201 件 **1.62 ms**、801 件 **19.2 ms/次 emit**（桌面）。现在背包 revision 未变即跳过，`Bag.counts` 自身也按 revision 缓存；每次 emit 也不再深拷贝整个世界，只复制 choices 和 encounter 状态两张小表。
- ✅ **已修（2026-10-25）** **`BattleCharacter.panel` 无缓存**：每次读 `hero.player` 都 `calculateCharacter` + `bag.get`（每件装备 `structuredClone`）。2 件 11.8 µs、9 件 **46.2 µs/次**；`party.alive('player')` 9.2 µs。佣兵 `CompanionMember.panel` 有缓存，0.012 µs/次。现在按 `(bag.revision, level, panelRevision)` 缓存；同时修掉加点预览直接改写面板的隐患。
- `Bag.entries`/`allCells`/`pouchCells` 全部深拷贝；UI 每次 render 各取一次，200 件时几百次 clone。
- `StoryDirector` 构造 30.9 ms（图 `structuredClone` 21.1 ms + 图校验 9.1 ms）；运行时至少两个 StoryRuntime，约 60 ms 额外。
- 数据重复：`shops.equipment` 与 `character-stats.equipment` 662 项完全重合、约 1.2 MB；`items.groundSprite` 1008 份对象只有 67 个唯一文件。
- 掉落/商店/合成单次计算很小（Boss 掉落 2–3 µs、普通商店 0.35 ms），不需要为帧率重写公式。
- Wardrobe 每个场景/同伴一个实例，构造时遍历 3,623 个 sprites；换图重建，成本不大但可共享。

**修复方向**：`observeChanges` 用 bag revision 门控 + 一次 counts；`Bag.counts/entries` 按 revision 缓存；`BattleCharacter.panel` 缓存；quest marker 缓存；`healthChanged` 事件索引；检查点去掉外层重复 clone、静态外观按 actor 解析；存档摘要与全档分离（需递增 `SAVE_FORMAT`）；数据表构建期合并 `shops/character-stats`、groundSprite 共享。

### 4.10 构建、校验、测试、APK 与诊断

**结论：构建链路设计正确；问题是重复校验、运行期重复语义校验、资源未压缩/未拆包，以及测试红。**

- `dist` 约 **237 MB / 12,168 文件**；入口 JS 2.31 MB（gzip 630 KB），Phaser min 1.38 MB 约占 60%；无 source map；单 chunk。
- `npm run validate:content` **1.40 s**；`typecheck` 2.58 s；`npm run build` 内部 `validateContent(public)` + 复制 217 MB + 再 `validateContent(output)`，第二次是重复劳动（多约 1.4 s）。
- **构建期已经调用 `validateStoryReferences` / `validateStoryPerformance`**（`content-relations.ts`）；运行期 `main.ts` 又跑一遍，还有 8 个内容校验器也是重复。生产环境应删运行时语义校验，只保留 parse/轻量 shape。
- 构建期缺 `springs.json` 校验；`npm run debug-start` 指引不存在。
- 全量测试 361 文件、38 s、退出码 1；`title-save-entry` 单跑 2/11 失败。
- 诊断收集器不是每帧：`markFrame` 每帧只 3 次 `Date.now()`；snapshot/JSON/localStorage 只在错误/启动/停帧时发生。错误风暴时 `localStorage` 同步写最多约 384 KB，会放大阻塞；正常游玩不是主因。
- 4003 dev 是 241 模块 / 26.69 MB JS；4002 是 2.31 MB / gzip 630 KB。手机性能必须以 4002/APK 为准。
- 现成工具建议：图片优化 `sharp`/`cwebp`/`oxipng`/`pngquant`；图集 `free-tex-packer-core`/TexturePacker；brotli 预压缩；Vite `manualChunks` 拆 Phaser vendor；体积分析 `rollup-plugin-visualizer`。**不建议**整体替换现有 `shape<T>` 校验（编译期键绑定 + 中文错误路径是优势），也不建议换测试框架。

**修复方向**：删除 build 第二次 `validateContent`；`springs.json` 纳入校验；生产删除运行期语义校验；菜单图懒加载；PNG/WebP 优化；Phaser vendor 拆分；逐文件 hash manifest（避免一个 PNG 变化重下全部素材）；诊断加低频帧时间采样与构建版本/DPR。

### 4.11 启动与内容解析

- `prepareStory` 一次加载 13 个内容目录，约 **24.9 MB**：campaign 9.46、wardrobe 4.57、battle 4.53、world 2.48、character-stats 1.43、shops 1.24、items 0.66、其余约 0.3 MB。
- 同一阶段加载 **281 张剧情引用地图**（3.75 MB，281 次 fetch），跑 8 个内容校验器 + `validateStoryReferences` + `validateStoryPerformance`；本机约 **390 ms 主线程**（移动端 3–10 倍）。这还没算 `assetGap` 逐帧验收和 `loadSceneAssets` 的 `JSON.stringify` 去重。
- 678 张菜单图在进入世界前全部预载（4.4 MB / 解码约 15 MB）。
- 地图 JSON 有 `ContentLoader` 永久缓存，同一张图第二次进入不会重新 fetch/parse；进图只重复 parse drops/springs（约 0.4 ms）。**地图 JSON 缓存不是瓶颈。**
- `campaign.json` 有大量缩进空白：9.46 MB → minify 4.28 MB（gzip 0.65 MB）。
- 内容规模：505 任务、593 事件、693 脚本、3,635 节点、25,568 演出动作；battle 90 技能、93 普攻、158 特效、553 敌人；items 1008；wardrobe 3,623 sprites、220 poses。

**修复方向**：生产删运行时语义校验；不再 fetch 281 张地图；`campaign.json` 构建期 minify；菜单图按面板懒加载；技能/敌人/剧情按章节/地图/职业拆分；构建期预计算事件索引、可达脚本、演出素材清单。

### 4.12 调试与 GM

`src/debug/`（GM 面板、headless story、story jump、catalog validation）只在 `?gm`/`?inspect`/dev 下使用；GM 道具页一次渲染 1003 件，但这是开发工具，不影响玩家。建议按 `import.meta.env.DEV` 动态导入，减少生产包体，但不是性能主因。

### 4.13 已排除 / 不要动

- Arcade Physics：RTree、group vs group，不是全量两两检测；典型 body <50。
- `CombatRuntime.step`、`CombatController.snapshot`、`CombatConditions.update`：实测 µs 级。
- 地图格子数：不是逐格绘制，中位 1,050 格不影响。
- 地图 JSON 缓存：工作正常，切图不会重复 parse。
- 相机、小地图地形、出口、输入、resize、FPS 文字：低频/事件驱动。
- QuestBook 写时复制、`session.quests` 投影缓存、条件求值、`waitEncounter` 状态机。
- 构建 staging + 原子替换 + `.build-meta.json`、`serve-built.ts` 缓存/ETag/Range、APK 校验。
- 诊断收集器的事件驱动设计。
- `shape<T>` 自研结构校验（编译期键绑定 + 中文错误路径）。
- PR `4b6dd64`：不是根因；`batchSize: 4096` 无收益，恢复默认即可。

---

## 5. 数据驱动与 JSON 边界（专家评审 + 钢人论证）

### 5.1 先把问题问对

这不是“JSON 还是 TypeScript”的二选一，而是四个独立问题：

1. **源文件谁维护？** 人、导出工具，还是两者都有？
2. **运行时需要什么表示？** 原始 JSON、紧凑 IR，还是编译后的代码？
3. **行为放哪？** 数据解释器、构建期编译，还是手写 TS？
4. **校验放哪？** 构建期、运行时，还是两者？

用户已明确：**数据已经从原版导出，现在有了定义，可以当成新项目做。** 这意味着导出的 JSON 是素材/起点，不是必须原样保留的运行时契约。但它也不意味着要手写 553 个敌人、25,568 个演出动作——正确做法是改**运行时表示和构建管线**，不是把内容全部重敲一遍。

### 5.2 双向钢人

**命题**：技能/战斗/剧情等内容继续用 JSON，还是更多改成 TypeScript/编译产物？

| | 保留 JSON 数据驱动 | 改为 TS/构建期编译 |
|---|---|---|
| 最强理由 | 内容规模大（505 任务、693 脚本、90 技能、553 敌人、1008 物品）；JSON 可 diff、可校验、可工具化；稳定 ID 供存档/剧情引用；非开发者也能改；原版导出可直接对照 | 导出已完成，运行时格式可以重新设计；TS 有编译期类型、重构、tree-shaking；行为是代码，通用 DSL 解释器等于第二套引擎；26 MB JSON + 运行时校验是纯浪费；现代构建管线可以生成紧凑产物 |
| 适用条件 | 内容持续人工编辑、需要本地化/模组/外部工具、团队有内容作者 | 开发驱动、内容从导出生成、移动端加载/内存预算紧、行为复杂且特例多 |
| 最大收益 | 作者效率、可审计、稳定契约、内容与代码分离 | 启动/内存/运行时开销下降、类型安全、少一层解释/校验、可按需拆包 |
| 最大风险 | 运行时把作者格式当消费格式，解析/校验/分发成本高；DSL 越做越大 | 迁移成本高；失去非开发者编辑；TS 对象不一定比 JSON 更易维护；容易变成大爆炸重写 |
| 最难回答的反对意见 | “JSON.parse 本身很快，问题是你重复校验和加载太多，不是 JSON 语法”——成立，所以即使保留 JSON 也必须改校验/拆分/懒加载 | “你把 26 MB 数据变成 26 MB TS，还是要打包/解析，且失去工具链”——成立，所以不应手写全部内容，而应构建期从 JSON 编译 |

**真正的分歧**不在格式，而在**运行时表示和职责边界**：
- 数据（是什么）：数值、ID、文本、坐标、引用 → 适合作者态 JSON。
- 行为（怎么做）：技能事件序列、命中规则、剧情控制流 → 适合 TS/IR/编译产物。
- 展示（长什么样）：预格式化字符串、颜色、间距 → 应从数据和模板派生，不重复存储。

**关键变量**：谁编辑内容、内容是否还会频繁改、是否需要本地化/模组、移动端加载/内存预算、构建管线维护成本、现有测试覆盖。

**判断**：采用三层——

```text
作者态 JSON（人改/可 diff/schema 校验）
  → 构建期编译产物（紧凑、带 hash、预解析/预校验、按章节/地图/职业拆分）
  → 运行时 TS 领域代码 + Phaser 内置能力消费
```

保留 JSON 作为作者态，停止把原始导出 JSON 当运行时格式；行为编译，数据留下；校验只在构建期；不做大爆炸重写，先试点一个职业 + 一章剧情。

### 5.3 三位互补专家会诊

| 视角 | 怎样重新定义问题 | 最推荐的路径 | 最容易忽略的风险 | 什么新证据会改变判断 |
|---|---|---|---|---|
| 运行时性能工程师 | 卡 = 帧预算/long task/内存压力；先归因再优化 | 先加测量；修 emit O(n²)、同步 A\*、逐帧全量投影；用全局预算和 revision | 只盯微优化，忽略内容/资产管线；把设备当借口 | profiler 显示 GPU bound 而非 CPU；A\* 不在 self time 前列；emit 频率很低 |
| 渲染/引擎工程师 | 卡 = draw call/纹理切换/填充率；资产要按批次组织 | 纹理去重/懒加载/图集；DPR 档位；canopy 裁边；用 Phaser 内置批处理 | 桌面多纹理合批掩盖移动端问题；图集/压缩管线成本被低估 | Spector 显示 draw call <100；填充率不是主因；图集迁移成本高于收益 |
| 内容/工具链架构师 | 卡的一部分是把作者格式当运行时格式；构建/运行时职责重叠 | 作者态 JSON → 构建期编译/校验/拆分 → 紧凑 IR；行为用 TS；按需加载 | 迁移成本、内容作者体验、存档 ID/兼容；TS 不等于自动更好 | 内容几乎不再编辑（可放心编译）；试点显示加载/内存无收益或作者效率明显下降 |

**互相质疑后的共识**：
- 游戏逻辑本身不重；重的是资产超集、无界同步搜索、每帧全量投影和重复校验。
- 自研战斗、寻路、UI、存档是必要的；Phaser 没有等价物，不要为了“现代化”重写。
- 表现层/内容管线才是“现代化”该改的地方：构建期编译、按需加载、图集/压缩、测量门禁。
- 先修影响最大且低风险的部分，再决定是否投入内容编译器。

**真正的分歧与假设**：
- 优先级：资产/内存 vs emit O(n²) vs A\* vs 渲染。答案取决于场景（首次进图/战斗/后期/菜单），所以文档按场景排序，不强行给单一排名。
- 技能是否马上改 TS：取决于内容是否还会频繁编辑、是否有非开发者。当前建议“保留作者态 JSON，先编译 IR”，而不是手写 TS。
- 运行时校验能否删：构建期已覆盖，可以删；但必须保留 parse/基本 shape，防止手改内容绕过构建直接部署。
- UI 是否引入框架：Phaser 没有 UI kit，自研合理；列表虚拟化/静态遮罩是代码问题，不需要换框架。

### 5.4 分界表

| 内容/系统 | 现在 | 建议 | 理由 |
|---|---|---|---|
| 地图数据（blocked/ground/canopy/features/entities/exits） | 自定义 JSON，416 张 | 保留数据；构建期预处理成每图包；可选 Tiled | 纯数据、工具友好；当前整图预渲染性能好 |
| 地图静态图 | 832 张 ground/canopy + 763 props | 保留；props 进图集；canopy 裁边；长期压缩纹理 | 渲染/请求成本 |
| 技能数值/等级 | `battle.json` skills 1.25 MB | 保留数值；删除预格式化 `details/valueParts`，从数值派生 | 数值是数据，展示字符串重复 |
| 技能行为（events/combatUnits/transition/followUp） | JSON DSL，运行时解释 | 构建期编译成紧凑 IR/TS 函数；新技能用 typed builder | 行为是代码；避免通用 DSL 解释器 |
| Buff/状态/效果定义 | JSON 数据表 | 保留数据，构建期校验；执行用现有 executor | 数据为主，逻辑固定 |
| 敌人定义（553） | `battle.json` 2.95 MB | 保留数据；按地图/等级拆分/索引；不要启动全载 | 大部分与当前地图无关 |
| 剧情/任务/对白 | `campaign.json` 9.46 MB | 保留 JSON；构建期 minify/预索引/按章节拆；脚本已是编译节点图 | 内容量大、需要编辑/本地化；不建议生成 25k TS 动作 |
| 物品/装备/商店/衣柜 | items/shops/wardrobe JSON | 保留数据；商店/衣柜按需懒加载；构建期合并重复数值 | 纯数据，不参与每帧 |
| UI 布局（menu-panels/status-hud/control-skin） | 小 JSON | 保留；不要扩成通用布局引擎 | 小型皮肤/坐标数据；复杂布局在代码里 |
| 存档 | JSON | 保留；摘要与全档分离 | 序列化格式本来就该是数据 |
| 本地化 | 目前内嵌 | 未来 JSON/PO | 数据 |
| 内容校验 schema | 手写 `shape<T>` + 运行时 | 构建期完整校验；运行时只保留 parse/轻量 shape | 构建期已覆盖；去掉重复 |
| 音频目录 | `audio.json` 140 KB | 保留数据；首次播放前预载，BGM 只保留上一首缓存 | 数据；预载优先 |

### 5.5 “没必要自己实现”清单

| 现在自研 | 建议 | 判断 |
|---|---|---|
| 运行时完整语义校验（8 个校验器 + story 校验） | 构建期已有；生产只保留 parse/轻量 shape | **删重复** |
| 通用技能 JSON DSL 运行时解释器 | 构建期编译成 IR/闭包；保留读取/校验工具 | **收敛，不重写内容** |
| 同步全图 A\* | 复用 `friendly-summon-ai` 的冻结快照 + 增量搜索 + 全局预算 | **复用项目内现有范式** |
| 启动加载 281 张地图做交叉校验 | 构建期/测试做；运行时按需加载 | **删运行时重复** |
| 预格式化展示字符串 | 数值 + 模板 + 格式化器 | **派生，不存储** |
| 逐文件纹理/请求 | 内容去重 + 图集 + 懒加载 | **用构建期工具** |
| 自研 tilemap | 当前整图预渲染已够；动态瓦片才考虑 Phaser TilemapGPU | **不迁** |
| 图片压缩/图集工具 | `sharp`/`cwebp`/`oxipng`/`free-tex-packer-core` | **用现成工具** |
| 通用 schema 库 | 可评估 TypeBox/Ajv 构建期；现有 `shape<T>` 暂不整体替换 | **可评估，不强制** |
| Phaser 已有能力 | 继续用 Arcade、AnimationManager、SoundManager、Camera、Input、Tweens | **不要重写** |
| 战斗规则、寻路、UI/摇杆、存档、AssetLease、原版特效 | 保留自研 | **引擎没有等价物** |

### 5.6 技能 JSON 专项：为什么现在这样、该怎么改

当前 `battle.json` 的 90 个技能混了三类东西：

1. **数值与成长**：法力、冷却、等级、伤害权重、rank 表——适合 JSON。
2. **行为事件**：`events` / `combatUnits` / `transition` / `followUpAction`——是行为，适合 IR/TS 编译产物。
3. **预格式化展示**：`details` / `valueParts`（标签、颜色、零值、间距、百分比字符串）——90/90 技能都有，和数值重复，是 4.5 MB 的重要来源。

**结论**：技能继续用 JSON 作为**作者态 DSL** 合理；把当前 JSON 直接当**运行时最终形态**不合理。正确做法：
- 数值/等级/ID 保留为数据。
- `events/combatUnits/transition` 在构建期编译成规范化 IR（数组索引、整数 opcode、预解析效果名）。
- `details/valueParts` 改为“数值 + 标签模板 + 格式化器”运行时生成，保证格式一致。
- 特殊技能用 `handler` 指向 TS 注册表，不把特例塞回 JSON。
- 加载按职业/技能拆分，快捷栏/遭遇预载；不要启动加载全部 553 敌人和 6 职业全部技能。

**试点**（不大爆炸）：
1. 选 1 个职业（约 8–12 个技能），优先选拥有四个大特效中最多特效的职业；再选 1 个敌人族做对照。
2. 建 parity harness：对全部等级快照伤害/耗蓝/冷却/事件序列/展示文本（颜色、间距、零值）。
3. 删除试点技能的 `details/valueParts`，实现单一格式化器；逐字比对，不一致改格式化器，不改内容。
4. 定义版本化 `SkillActionIR`，构建期编译；运行时只消费 IR。
5. 加 content lint：禁止预格式化字符串、效果名必须可解析、事件 kind 必须已知。
6. 量测 `battle.json` 体积、解析时间、战斗 parity；达到“体积明显下降 + 零行为差异”再推广，否则停止，保留 JSON + 构建期校验。

### 5.7 迁移顺序与退出条件

- **先做低风险的结构优化**（去重、懒加载、拆分、构建期校验），不改变作者格式。
- **再做技能 IR 试点**；试点失败就停，保留 JSON。
- **最后才考虑把作者态迁到 TS builder**；只有在内容作者是开发者、且需要强类型/重构时才值得。
- 退出条件：如果试点导致内容编辑效率明显下降、parity 无法保证、或加载/内存收益 <10%，停止迁移。

---

## 6. 修复路线图

### P0：测量、基线与前置门禁

| 项 | 内容 | 产出 |
|---|---|---|
| P0.1 基线 | 手机统一测 4002/APK；清缓存冷启动/热启动；S1–S5 场景；同设备同网络 3 次取中位数 | 基线表 |
| P0.2 帧时间采样 | 扩展现有 `game-diagnostics.ts`：PRE_STEP/POST_STEP/POST_RENDER 记录 update/render 时长；低频汇总 P50/P95/最长帧；错误上报带构建版本/DPR | `?perf` 或诊断字段 |
| P0.3 资产归因 ✅ | `npm run report:assets` 扫描全部图片，按 SHA-256 分组并估算解码 MB，输出重复组与 Top 20 | 资产报告 |
| P0.4 寻路基准 | 固定 50×57/46 actor 地图，测可达/不可达/拥挤三类；记录扩展数、p50/p95、最大耗时 | `tests/perf-pathfinding` 或脚本 |
| P0.5 消融矩阵 | 真机逐项关闭：canopy、DPR 1.5/2、常驻包只留当前职业、AI step、HUD 重绘、音频 | 贡献排序 |
| P0.6 绿色测试 ✅ | 先修当前红测试；至少让 `title-save-entry` 单跑通过 | 回归前置。已完成：11/11；菜单交互套件恢复 39/52 |

### P1：低风险快赢（不改玩法/画质）

1. ✅ **高频 emit 链路（2026-10-25 已实施）**：`observeChanges` 用 bag revision + 一次 counts；`Bag.counts` 按 revision 缓存；`BattleCharacter.panel` 缓存；`healthChanged` 事件索引；quest marker 按 questBook 版本缓存。仍待做：`Bag.entries/allCells/pouchCells` 的深拷贝缓存。
2. ✅ **寻路（2026-10-25 已实施）**：敌人跨帧增量搜索 + 冻结快照 + 失败退避 600 ms；队伍 24 px/180 ms 重算；`WorldCombat` 每渲染帧共享 512 扩展预算；`canStand` 分配优化；`stepDelta` 最多 2 个逻辑步。
3. ✅ **纹理去重（2026-10-25 已实施）**：构建期按文件 SHA-256 + 帧尺寸/帧数/帧率/循环类型合并 `battle.json` / `world.json` 的动画图层键；常驻包 3,363 键 / 1,769 MB → 1,025 键 / 996 MB。另有 `npm run report:assets` 输出完整重复归因；剩余文件级去重（地图 prop、UI 非图标资源）待做。
4. **常驻包缩围**：只留当前职业/队伍/共享效果；返回菜单释放；伙伴入队时加载。
5. ✅ **启动减负（2026-10-25 已实施）**：生产删运行期语义校验，构建期 minify 全部内容；不再 fetch 281 张地图；商店装备表、人物动作拆文件按需取；菜单物品/技能图标改为开局后后台补。仍需做：`campaign.json` 按章节/地图拆分。
6. **逐帧脏检查（大部分完成，2026-10-25）**：✅ 掉落 revision + 按地图索引、`recoverResources` 早退、`syncDepth` 同值跳过、状态色/持续特效同值短路、重复 `setDepth` 删除、冷却签名、`setPaused` 同值、`syncHud` 目标状态按战斗帧缓存；仍待做：静态 body 跳过约束/插值、HUD 可见性同值短路、`WalkRoute` 重复采样。
7. **剧情/菜单表现层（大部分完成，2026-10-25）**：✅ 滚动遮罩静态化、对白翻页增量、商店/队伍去重、存档摘要缓存；仍待做：演出 sleep WorldScene、合成成功后的第二次重画、菜单更彻底的局部重绘。

### P2：结构性改造

- Boss/角色 `skill-*` clip 按需加载，打完释放。
- 地图 prop 图集；canopy 包围盒裁边/分块。UI 物品/技能图标图集 ✅（439 个图标 → 1 张 2,045×1,143 图集，请求数 439 → 2）。
- 菜单/任务日志虚拟化；`MemberPanel` hitArea 复用。
- 战斗/HUD 更完整的 revision 体系：`EnemyRoster`、`conditions`、`statusColors`、`syncBuffLoops`、`setPaused`。
- 存档摘要与全档分离（递增 `SAVE_FORMAT`）；检查点去重复 clone/冗余字段。
- ✅ BGM 保留上一首解码缓存（2026-10-25）；流式与 `prepareCombat` 收窄**不做**：首次播放必须已经预载。
- DPR 上限/画质档（默认 2，低端 1.5，需视觉验收）。
- 构建：`springs.json` 校验 ✅；仍待做：删第二次 `validateContent`、Phaser vendor 拆包、brotli、逐文件 hash manifest。

### P3：长期治理

- 内容编译器：技能 IR ✅（90 个技能展示模板、235 个技能/敌人动作的 `requiresTarget/effectNames/soundNames/summonNames/eventFrames` 已在构建期生成）；剧情预索引/拆分、按章节/地图/职业打包仍待做。
- 大特效降采样/压缩纹理（`rampage-burst` 543 → 约 136 MB，2×；KTX/ASTC 再降）。
- 角色/特效图集；必要时 Phaser `SpriteGPULayer`/`TilemapGPULayer`。
- 资产使用图与 CI 预算：孤儿资源、重复率、常驻 MB、单图纹理数、单技能 MB。
- 设备档位与降级：DPR、canopy、特效层数、AI 预算、音频并发。

### 并行工作流（实施阶段）

| 工作流 | 主要文件 | 依赖 | 验收 |
|---|---|---|---|
| 1. 测量/基线 | `game-diagnostics.ts`、`world-scene.ts`、`world-combat.ts` | — | S1–S5 基线 |
| 2. emit/会话/存档 | `story-director.ts`、`character-stats.ts`、`bag.ts`、`session.ts`、`save-game.ts` | 1 | emit p95、存档页时间、存档大小 |
| 3. 寻路/AI | `enemy-ai.ts`、`party-ai.ts`、`friendly-summon-ai.ts`、`navigation-world.ts`、`pathfinding.ts` | 1 | A\* p95/最大扩展、AI 回归 |
| 4. 纹理/资产 | `resident-combat-assets.ts`、`combat-assets.ts`、`scene-assets.ts`、`entry-plan.ts`、`app.ts`、build tools | 1 | 首图键数/请求/解码 MB、Boss 图 |
| 5. 启动/内容 | `main.ts`、`content-loader.ts`、`tools/validate-content.mjs`、`menu-images.ts` | 1 | TTI、请求数、校验时间 |
| 6. 剧情/菜单表现 | `story-presenter.ts`、`formal-ui-scene.ts`、`story-ui.ts`、`widgets.ts`、`story-stage-scene.ts` | 1 | 对白/菜单帧时间、UI 对象创建数 |
| 7. 逐帧/移动 | `world-scene.ts`、`world-combat.ts`、`ground-loot.ts`、`movement-world.ts`、`action-controls.ts` | 1 | 每帧 p95、GC、depthSort 次数 |
| 8. 渲染/DPR/图集 | `viewport.ts`、`map-layers.ts`、`combat-presenter.ts`、build tools | 1、4 | draw call、纹理切换、像素量 |
| 9. 内容编译试点 | 技能/剧情 IR、`tools/content-compiler` | 4、5 | parity + 体积/加载收益 |

工作流 2/3/4/5/6/7 大多可并行；4 与 8 共享资产 manifest，需先定 canonical key/图集协议；9 不阻塞前面。

---

## 7. 基线场景与回归门禁

### 7.1 固定场景

| 场景 | 内容 | 主要看 |
|---|---|---|
| S1 启动/职业选择 | 清缓存冷启动 → 点击开始 → 选职业 → 可操作 | TTI、请求数、长任务、内存 |
| S2 首次进图 | 进入起始图，加载到可操作 | 贴图键数/解码 MB、请求 waterfall、首帧时间 |
| S3 行走 | 50×57、46 actor 地图，静止/行走 30 s | 帧 p95、hitch、GC、A\* 调用/扩展 |
| S4 Boss + 大特效 | 龙系/黑暗势力 Boss，四个大招各放一次 | 纹理内存、draw call、单次技能帧时间 |
| S5 菜单/任务 | 打开背包、商店、技能、任务日志、存档页 | 打开耗时、GameObject 创建数、mask/filter 时间 |

### 7.2 初始预算（先作为目标，基线后调整）

- 启动 TTI：中端 Android ≤5 s，低端 ≤8 s（4002/APK 冷启动）。
- 首次进图：≤3 s；Boss 图 ≤5 s（在常驻包缩围/懒加载后）。
- 常驻解码纹理：≤300–500 MB；首图峰值 ≤600–800 MB。
- 每图纹理切换：≤20（图集后）；战斗 draw call：≤100（移动端）。
- A\*：单次同步 ≤4 ms；全局每渲染帧 ≤2–4 ms；不可达/失败退避 ≥600 ms。
- 帧：p95 ≤20 ms（中端），>50 ms hitch ≤1 次/分钟。
- emit：p95 ≤0.5 ms（200 件背包）；菜单打开 ≤100 ms；存档页 ≤50 ms。
- 构建：`validate:content` ≤2 s；`test:all` 绿。

### 7.3 测量方法（用户执行）

- **Network**：清缓存，记录 4002/APK 的请求数、传输量、waterfall；重点看 S1/S2/S4。
- **Performance**：Main + GPU track，记录长任务、FPS p50/p95、GC；对比 S3 静止/行走、S4 大招。
- **Memory**：`chrome://inspect`（Android）/ Safari Web Inspector（iOS），记录 JS heap、GPU memory、纹理/Image 数；进出 Boss 图前后各一次。
- **Spector.js**：抓单帧 draw call、texture binds、batch 数；对比静止/普攻/大招。
- **控制台辅助**：
  - `storyApp.game.renderer.renderNodes.maxParallelTextureUnits` 看是否 1；
  - 包装 `WebGL2RenderingContext.prototype.drawElements/drawArrays` 统计 draw call；
  - `performance.mark/measure` 包 `loadSceneAssets`、`createPathSearch.step`、`FormalUiScene.sync`。
- **不要**用 4003 的首屏/加载体感判断正式性能；不要只看“卡不卡”，要 p50/p95/最长帧。

---

## 8. 决策记录（ADR）

- **地图不迁 Phaser Tilemap**：当前每图 2 张整图 + feature，draw call 低；Tilemap 会引入逐格对象/内容导出改造，收益不确定。先做 prop 图集和 canopy 裁边；只有需要动态瓦片/大量可破坏地形时才评估 `TilemapGPULayer`。
- **保留 Arcade Physics**：RTree + 自定义导航已验证；Matter 会改变碰撞语义和性能特征，不划算。
- **技能保留 JSON 作者态、编译 IR**：不做全量 TS 手写；先试点一个职业，parity 通过再推广。
- **剧情保留 JSON 节点图**：运行时消费的已经是编译后的节点图；不生成 25k TS 动作；做 minify/预索引/拆分/构建期校验。
- **先去重/懒加载，后图集/压缩**：去重零画质、收益最大；图集/压缩需要内容管线，排在后面。
- **UI 不引入重型框架**：Phaser 没有 UI kit；自研控件合理。列表虚拟化、静态遮罩、组件复用是代码优化，不需要 React/DOM 重写。
- **恢复 `batchSize` 默认**：4096 < 16384，当前对象数下无收益；`autoMobileTextures` 只做 A/B 实验。
- **音频保持预载**：BGM 和音效在进图/开战前预载，首次播放不能慢半拍；性能优化不得以延迟首次播放为代价。BGM 只保留上一首解码缓存，不做流式，也不收窄 `prepareCombat`。
- **测量以 4002/APK 为准**：4003 只做功能调试。

---

## 9. 已知未知（必须由 profiler/真机确认）

- 用户设备的实际瓶颈占比：纹理内存 vs draw call vs A\* vs emit vs GC。
- 2.1 GB 解码纹理中实际 GPU 上传/驻留多少；是否导致 WebGL context lost（现有日志有 1 次，发生在菜单阶段）。
- `statusColors` filter 的离屏 pass 成本；`Canopy` alpha 的 fill rate 占比。
- 战斗中真实 emit 频率（攻速/AoE/持续伤害影响）与 `observeChanges` 的耗时分布。
- 菜单 ui mask/filter 在 3× DPR 移动端的实际耗时。
- 每个剧情节点的快照/克隆是否造成可见掉帧。
- Android WebView 上 `structuredClone` polyfill 的实际倍率（旧 WebView 无原生实现）。
- 资源压缩（WebP/PNG 优化）的真实压缩率/画质、图集化的收益。
- APK 实际大小、Gradle 构建耗时（当前无产物）。
- 4002/APK 与 4003 在手机上冷启动/持续帧率的差值。

---

## 10. 附录

### 10.1 内容规模

| 文件 | 大小 | 规模 |
|---|---:|---|
| `campaign.json` | 9.46 MB | 693 脚本、3,635 节点、25,568 演出动作、4,653 句对白、505 任务、593 事件 |
| `wardrobe.json` | 4.57 MB | 3,623 sprites、220 poses、662 装备外观、375 variants |
| `battle.json` | 4.53 MB | 6 职业、90 技能、93 普攻、158 特效、553 敌人 |
| `world.json` | 2.48 MB | 416 地图、693 actors、763 props、12 portraits |
| `character-stats.json` | 1.43 MB | 662 装备数值、105 级经验 |
| `shops.json` | 1.24 MB | 18 商店、662 装备模板、416 地图商店等级 |
| `items.json` | 0.66 MB | 1,008 物品、662 装备、325 唯一图标 |
| `audio.json` | 0.14 MB | 13 BGM、170 SE、416 地图音频 |
| `maps/*.json` | 5.8 MB | 416 张；feature 平均 42、最大 134；实体平均 6.6、最大 32；出口平均 7.4、最大 36 |

### 10.2 资源规模

- `public/assets`：11,728 文件、约 161.5 MiB（磁盘）；PNG 11,544 张 143.8 MB、MP3 183 首 17.4 MB。
- 目录：maps 832 文件 60.8 MB；characters 8,206 文件 58.7 MB；audio 183 文件 17.4 MB；battle-effects 873 文件 12.7 MB；ui 674 文件 8.2–8.5 MB。
- 无 atlas；每张 PNG 一个纹理键；角色每个 clip 一个 spritesheet（佣兵 76 个/角色）。
- `dist` 约 237 MB / 12,168 文件。

### 10.3 关键文件/函数索引

- 资产计划：`src/application/entry-plan.ts`、`src/rendering/map-assets.ts`、`src/rendering/combat-assets.ts`、`src/rendering/resident-combat-assets.ts`、`src/rendering/scene-assets.ts`、`src/application/assets.ts`
- 寻路：`src/domain/enemy-ai.ts`、`src/domain/party-ai.ts`、`src/domain/friendly-summon-ai.ts`、`src/domain/navigation-world.ts`、`src/domain/pathfinding.ts`
- 逐帧：`src/scenes/world-scene.ts`、`src/scenes/world-combat.ts`、`src/domain/ground-loot.ts`、`src/ui/phaser/action-controls.ts`、`src/rendering/movement-world.ts`、`src/rendering/combat-conditions.ts`
- emit/存档：`src/domain/story-director.ts`、`src/domain/bag.ts`、`src/domain/character-stats.ts`、`src/domain/session.ts`、`src/domain/save-game.ts`、`src/ui/phaser/save-board.ts`
- 表现层：`src/ui/story-ui.ts`、`src/scenes/formal-ui-scene.ts`、`src/rendering/story-presenter.ts`、`src/ui/phaser/widgets.ts`
- 启动/校验：`src/main.ts`、`src/application/content-loader.ts`、`src/application/content-validation.ts`、`src/application/content-relations.ts`、`tools/validate-content.mjs`
- 渲染/视口：`src/rendering/map-layers.ts`、`src/ui/viewport.ts`、`src/main.ts`（Phaser 配置）

### 10.4 术语

- **A\***：在网格上找最短路的算法；节点预算 = 一次最多展开多少个格子。
- **draw call**：一次交给 GPU 的绘制命令；纹理切换通常意味着新的 draw call。
- **批处理**：把同纹理/同混合模式的对象合到一次绘制里；移动端 Phaser 默认每批只允许 1 张纹理。
- **DPR**：设备像素比；DPR 3 意味着画布物理像素是 CSS 的 3 倍线性、9 倍面积。
- **解码纹理**：图片解压后在内存/显存里的 RGBA 大小，通常远大于 PNG 文件大小。
- **逻辑帧/渲染帧**：逻辑帧是战斗规则推进（60 ms），渲染帧是画面绘制（目标 16.7 ms）。
- **IR**：中间表示；把作者态 JSON 编译成运行时更紧凑、更易消费的结构。
- **常驻包**：进入游戏后一直持有、不随地图释放的素材集合。
- **O(n²)**：数据量翻倍时耗时约变四倍；背包逐件重算计数是典型例子。

---

## 11. 一句话总结

先别继续加功能：把手机测试切到 4002/APK，修掉“每次 emit 全包扫描 + 每帧全量投影 + 同步全图 A\* + 2.1 GB 纹理超集 + 运行时重复校验”这几件根因；再做图集/压缩/内容编译。JSON 继续当作者态，构建期编译成运行时产物，而不是把导出 JSON 直接塞进游戏。

---

## 12. 实施进度

### 2026-10-25：P0.6 + P1.1 高频 emit 链路（已提交）

| 根因 | 改动 | 提交 | 验证 |
|---|---|---|---|
| `Bag.counts` 每次重建整张 Map | 按 `revision` 缓存 `ReadonlyMap` | `20b2305` | bag/inventory 31/31 |
| `observeChanges` 深拷贝背包 + 逐件计数 | 背包 revision 门控，变化时只读一次 counts | `f20d7f7` | 剧情观察用例 2/2 |
| 观察时深拷贝整个世界 | 只复制 choices/encounter 状态两张小表 | `b790004` | 剧情观察/触发 19/20（1 条既有失败） |
| `healthChanged` 扫 593 条事件 | 事件按 `source`/`key` 预索引 | `f20d7f7` | 原生触发、失败锁用例通过 |
| `BattleCharacter.panel` 每次重算 | 按 `(bag.revision, level, panelRevision)` 缓存 | `e53b65d` | character-stats 16/16 |
| 加点预览直接改写角色面板 | 预览改为在副本上累加 | `8424314` | 菜单套件与改动前基线一致（39/52） |
| `markerActor` 扫 505 条任务 | 按 `(questBook.version, focus, actor)` 缓存 | `c38f3ac` | session 7/7 |
| GM 开关依赖可选异步端口 | 先同步 render，再异步补载目录 | `c42695b` | title 11/11 |
| 测试替身缺 `Scene.scale` / `document.addEventListener` | 补全替身，恢复回归卡口 | `c42695b`、`28925fc` | title 11/11；菜单 0/52 → 39/52 |

同属 P1.1 但本轮未做：`Bag.entries/allCells/pouchCells` 的深拷贝缓存（需先审计调用方是否修改返回值）。剧情观察已不再调用 `StoryWorld.captureState()`；检查点/存档仍会整份捕获。

全量验证口径：`npm run typecheck` 通过；本轮相关 89 条用例全绿；`story-menu-interactions` 39/52、战斗运行时 4 条失败均已在改动前 HEAD 复现，属既有问题。

### 2026-10-25：JSON 内容管线（已提交）

| 根因 | 改动 | 提交 | 验证 |
|---|---|---|---|
| 生产重复跑 8 个语义校验 + 281 张剧情地图 | 构建期校验，生产只 `JSON.parse`；`?gm`/`?validate` 保留完整校验 | `49e8689` | typecheck、validate:content、build |
| 技能 `details` 存 8 级重复格式化字符串 | 构建期编译为 `display` 模板 + `displayValues` | `34e63da` | 4,688 行逐字 parity |
| 技能动作每次现算效果/音效/事件帧 | 全部 235 个技能/敌人动作预计算 IR | `bdd2db4` | 动作 IR parity 测试 |
| `shops.equipment` 与角色数值重复 1.2 MB | 拆到 `shops-equipment.json`，品级从 `character-stats` 派生 | `4193ec9` | 商店拆表/懒加载用例 |
| `wardrobe.poses` 占 3.9 MB，只用到一小部分 | 按动作拆 220 个文件，运行时按 recipe 取 | `bdd2db4` | 加载器冒烟；核心 4.8 MB → 695 KB |
| 654 张菜单图开局全部阻塞加载 | 框架/立绘先加载，物品与技能图标后台补 | `59aab4b` | 菜单图片清单用例 |
| 懒加载把等待推到首次打开 | 人物动作与地图资源并行请求；商店装备表在 `prepareStory` 后后台取；未赶上时提示并上报 | `5aae718` | typecheck、相关 18 项测试、build |

构建产物 content 33,450,325 → 26,875,739 字节；开局必须加载的部分约 22.4 MB。未做：伙伴目录懒加载（152 KB，建会话时就要用）、`groundSprite` 共享（对象本身很小）。

### 2026-10-25：P1.2 寻路与 AI 扩展预算（已提交）

| 根因 | 改动 | 提交 | 验证 |
|---|---|---|---|
| 敌人同步全图 A*，不可达 12–90 ms/次 | `createPathSearch` 跨帧推进 + 冻结快照；搜索期间直走，完成后续接最近点；不可达退避 600 ms | `3265117` | enemy-ai 22/22、enemy-motion 30/60/120 Hz 无停顿 |
| 几十个 AI 各自同步寻路会叠加 | 新增 `PathBudget`，`WorldCombat` 每渲染帧重置 512 扩展，敌人/队伍共享 | `3265117` | 新增预算用例 |
| 队伍每逻辑帧重算 1024 节点 A* | 队长移动 ≥24 px 且距上次 ≥180 ms 才重算；单次上限 384；预算不足下一帧再试 | `3265117` | party-ai 23/23 |
| `canStand` 重复查地形、空 placements 建 Map、临时矩形 | 只补人物占位；空 placements 早退；原地重叠判定 | `5afdfd9` | 寻路/导航/移动 43/43 |
| 卡顿一次追 3 个逻辑帧 | `stepDelta` 180 → 120 ms（最多 2 帧） | `2e6e119` | 相关 150 条用例 145/150，5 条既有失败 |

未做：`walk-route.ts` 与 `NavigationWorld.nearestReachableBody/terrainRoute` 的同步搜索仍未加预算；`canReach` 保持 512 上限。

### 2026-10-25：P1.6 逐帧脏检查（已提交）

| 根因 | 改动 | 提交 | 验证 |
|---|---|---|---|
| 掉落视图每帧克隆整表 | `GroundLootStore.revision`；视图只在增删/落地/读档后重建 | `2e42abf` | 掉落/检查点用例通过 |
| `syncDepth` 每帧写 depth 触发重排 | 值没变不写；删除 `updateEnemies` 的重复 setDepth | `2e42abf` | 移动/战斗用例通过 |
| 状态色每帧重设 color matrix | 按（颜色引用、逻辑帧、图层批次）短路 | `2e42abf` | 战斗/状态用例通过 |
| 无 buff 也分配 Map/Set | 无持续特效直接返回；共享空数组 | `2e42abf` | buff-loop 用例通过 |
| 非脉冲帧构建整队恢复属性 | `pulseDueAtFrame` 门控；非脉冲帧只推进时钟 | `442ead3` | 资源恢复 31/31 |
| 冷却读数没变也重画六格 | 按冷却签名门控 paint | `4d373ec` | 快捷栏/战斗用例通过 |
| 暂停状态每帧逐角色重设动画/特效 | 同值直接返回；新视觉使缓存失效 | `f1d3308` | 战斗运行时无新增失败 |
| 掉落每帧扫全局表 | 每图 id 索引，forMap/collect/advance 只扫当前图 | `8a52454` | 掉落/检查点用例通过 |
| `syncHud` 每帧重算目标状态 | 按 `(combatTick, 目标 id)` 缓存 | `137b5ed` | 状态栏/目标/剧情锁 49/50（1 条既有失败） |

同批补齐：冷却签名、`setPaused` 同值、`syncHud` 目标缓存、掉落按地图索引（见上表）。仍待做：静态 body 跳过约束/插值、HUD 可见性同值短路、`WalkRoute` 重复采样。

### 2026-10-25：其他独立优化（已提交）

| 根因 | 改动 | 提交 | 验证 |
|---|---|---|---|
| 滚动遮罩每帧重做动态纹理 | `autoUpdate=false`，几何变化才 `needsUpdate` | `2a2ed77` | 菜单/任务/标题 68/73（5 条既有失败） |
| 存档排序反复 parse 同一槽 | 排序期间按槽缓存读数 | `b5109f7` | 存档 30/30 |
| BGM 换歌立即删缓存 | 保留上一首解码缓存；关闭音乐释放 | `dbfb895` | 音频 14/14 |

### 2026-10-25：纹理去重与图标图集（已提交）

| 根因 | 改动 | 提交 | 验证 |
|---|---|---|---|
| 动画贴图按方向/角色重复加载 | 构建期按 SHA-256 + 帧配置合并 battle/world 图层键；15,761 个引用从 8,969 键降到 2,874 键 | `adff44e` | 常驻战斗包 3,363 键/1,769 MB → 1,025 键/996 MB；build 校验通过 |
| 439 个菜单图标各发一次请求 | `npm run atlas:icons` 生成 TexturePacker 图集；运行时按帧绘制，图集缺失时退回单图 | `adff44e` | 2.49 MB/439 请求 → 1.49 MB/2 请求；图集测试通过 |
| 重复资产缺少可复查数据 | `npm run report:assets` 按 SHA-256 归因，输出重复组、磁盘/解码 MB 与 Top 20 | `adff44e` | 当前报告：1,901 组 / 6,641 个多余文件 / 51.6 MB 磁盘 / 2.1 GB 解码 |

未做：地图 prop 图集（763 个 prop）、地图 prop 的文件级去重、非动画图片（立绘/UI 框架）的图集化。

### 2026-10-25：剧情与菜单表现层（已提交）

| 根因 | 改动 | 提交 | 验证 |
|---|---|---|---|
| 对白翻页整屏 clear/重建 | 正文页从整屏签名拆出；Text 复用，只更新内容/位置/颜色 | `d84ef6e` | 对白/剧情 41/41；画面需用户验收 |
| 商店/队伍操作成功重画两次 | 成功路径交给 session 通知那次；失败才本地重画 | `e8d20f2` | 菜单/商店/队伍 75/80（5 条既有失败） |
| 存档页反复 `inspect` 整档 | 新增 `peek` 摘要缓存；排序/行/立绘只用摘要 | `4eac018` | 存档/标题/菜单 95/100（5 条既有失败）、save-game 11/11 |
| 合成成功重画两次 | 提交前清掉选中目标，成功沿用 session 通知；失败恢复目标并本地重画 | `6116f28` | 菜单/合成 51/56（5 条既有失败） |

下一项：演出时 sleep WorldScene、静态 body/`WalkRoute`；资产线（另一个进程）：地图 prop 图集与文件级去重。

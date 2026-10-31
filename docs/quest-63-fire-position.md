# quest-63 演出结束后火焰位置异常：现状交接

> 交接目标：接手的人或 agent 不用重新勘察就能继续定位、修复。
> 记录时间：2026-10-31。
> 当前结论：**内容坐标、演出落位、剧情世界提交、正式世界落位这几层都没有找到能把火焰挪走的路径；画面错位的根因还没定位。** 最缺的是一份「演出结束后」的现场证据。
>
> 2026-10-31 更新：用户反馈用调试流程未能复现（原话：「我用调试没复现卡死」）。本次排查用的临时探针与脚本已删除，文档保留，等待再次出现时接手。

## 1. 症状

用户原话（m00139）：

> 这的问题很明显啊，就是剧情演出，火的位置是对的，但是演出结束后，火的位置不对，修复掉

场景：卡姆兰东部地区（地图 `east-kamuran-b52d2b0e`），主线任务 `quest-63`「甩掉艾伦尼追击兵」，属于任务组 `native-group-20`「逃出卡姆兰」（同组还有 quest-57/58/59/60）。

演出：事件 `event-81` 的 `scene-1` 开场。演出里由 5 条 `world-object` 摆放 5 处火焰；演出结束后这 5 个火焰作为剧情世界实体留在本图。

用户提供的截图：`/Users/wangjr/.dsh/attachments/v1/objects/2d/2d15d99148ac5ea5bfc582d1b3a2d3b14b79d0f0b45593747dd471d8af8c90f8`（2560×1540 PNG）。画面是正常游戏 HUD、没有对话框，玩家站在稻草堆左侧，火焰在仓库前。**仅凭这张图无法判断是演出进行中还是结束后**，需要用户再给一张明确的「演出结束之后」的截图。

## 2. 复现步骤

### 2.1 图形界面（用户）

1. 打开 <https://catgo.online:4002/?gm>（`?gm` 只对本次会话生效，不写本地存储）。
2. 进游戏，读档。
3. 菜单 → 系统 → 调试 → 剧情页（默认筛「主线」）。
4. 滚到「逃出卡姆兰 · 甩掉艾伦尼追击兵」，点右侧「进入任务」。

进入后会自动套用现场表并播放 `event-81 / scene-1`；调试期间自动存档暂停，退出用面板顶部「结束本次调试」。

### 2.2 控制台（agent）

`?gm` 隐含 `?inspect`。进游戏后：

```js
globalThis.gm            // app.gm
gm.digest()              // 地图、玩家坐标、任务、世界实体摘要
gm.mark('before')        // 出事前存一份会话状态
gm.recall('before')      // 回到标记（会整体回退任务/背包/世界）
gm.report()              // 摘要 + 最近 40 条 GM 操作发到 /__diagnostics/report
gm.jumpStory({ quest: 'quest-63' })
```

调试现场表在 `public/content/debug/start.json` 的 `quest-63` 项：phase `available`，入口 `east-kamuran-b52d2b0e (520,136)`，`play` 是 `event-81 / scene-1 / cut before-opening`；起始世界 `mapVisit: 2`，`location` 已是 `east-kamuran (520,136)`。

## 3. 场景内容（已核对）

### 3.1 事件脚本

`event-81` 的脚本在 `public/content/campaign.json` 的 `scripts["event-81"]` 里；`scene-1` 的 `presentation` 是动作数组（不是 `commands`）：

1. `stage`：地图 `east-kamuran-b52d2b0e`，落点 `(488,136)`，`facing south`，`playerVisible true`，`mapFromWorld true`；cast 只有一个**占位火焰**：

   ```json
   {"id":"story-flame-7ce0ff5c","actor":"story-flame-7ce0ff5c","binding":"world",
    "characterId":"npc-508","x":536,"y":40,"facing":"south","visible":false,
    "unpositioned":true,"inheritPosition":true}
   ```

2. `fade` 到黑 600ms → `appear player (488,136,south)` → `face player east` → `camera player cut` → `wait 900` → `fade` 亮 600ms → `wait 600` → `wait 300` → `camera-point (568,88) pan` → 5 条 `world-object`（`mode:create`，`command.kind:place`，`scope:visit`，`mapFromStage:true`）→ `wait 600` → `dialogue` 凯恩 → `face player south`。

5 条 `world-object` 的实体：

| id | x | y |
|---|---:|---:|
| `story-object-81-20` | 536 | 40 |
| `story-object-81-21` | 520 | 88 |
| `story-object-81-22` | 568 | 72 |
| `story-object-81-23` | 584 | 136 |
| `story-object-81-24` | 616 | 72 |

五条都是 `characterId: "npc-508"`、`actor: "story-flame-7ce0ff5c"`、`map: "east-kamuran-b52d2b0e"`、`visible: true`。

### 3.2 地图与摆放

- 地图 `east-kamuran-b52d2b0e.json`：640×480，tile 16，40×30。静态实体只有 5 个：水井 `(120,88)`、稻草堆 `(520,136)`、宝箱 `(568,136)`、两个出口 `(8,376)`/`(8,440)`。**静态实体里没有火焰。** 另有 95 个 `scenery-*` 贴图（哈希命名，未逐个确认外观），但演出里的 5 团火焰是 `event-81` 的 `world-object`，不是地图贴图。
- `campaign.placements` 在本图只有两条：`quest-npc-located-npc-221`（barricade，312,296）和 `quest-npc-npc-350`（稻草堆，520,136）。**没有火焰摆放。**
- 全库用 `story-flame` 的 `world-object` 只有两处：`event-55 / scene-2`（旧圣所 `old-sanctuary-54cffd62`，13 个 `story-flame1-343913ac`）和本事件的 5 个。旧圣所的火焰在另一张图，不会串到本图。

### 3.3 火焰角色定义

`world.json` 的 `story-flame-7ce0ff5c`（名字「火花」）：

- `idle-north/south/east/west` 四个 clip 共用同一张图；
- `frameWidth 69`、`frameHeight 107`；
- `originX 0.5072463768115942`、`originY 0.8598130841121495`；
- `layer.blend: "screen"`。

## 4. 已经验证过的事实

### 4.1 剧情世界里的坐标是对的

`tests/tmp-event81-probe.test.ts`（随 `3e17ff2` 提交，已于 2026-10-31 删除）用 `createHeadlessStory` + `replayEvent(event-81)` 跑完整段演出，然后读 `storyWorld.entities`：

- 5 个火焰的最终坐标与脚本完全一致：`(536,40)`、`(520,88)`、`(568,72)`、`(584,136)`、`(616,72)`；
- 玩家落点 `(488,136)`；
- 从玩家到出口 `(24,392)` 的寻路存在（102 步）。

运行方式（探针已删除，命令留作重建参考）：

```bash
npm test -- tests/tmp-event81-probe.test.ts
```

注意：这个探针只验证**剧情世界数据**，不验证 Phaser 画面。

### 4.2 落位链不会改写没动过的内容实体

- `MovementWorld.placeAll()` 里先有一段快速放行：坐标没变、非 `strictTerrain` 的内容实体直接跳过校验（`src/rendering/movement-world.ts:136` 起，`corrected` 映射里）；只有真的移动过的内容实体才走 `canPlace`，失败再用 `nearest()` 就近修正。后面的 `canSettleAll()`（`src/domain/navigation-world.ts:186`）对没动的内容实体也判为通过。
- 内容实体允许贴墙、压在阻挡格上或与别的实体重叠；只有坐标真的变了，才会触发修正。
- 5 个火焰创建后初始坐标就是目标坐标，`canSettleAll` 应判为通过，不触发修正。
- 2026-10-31 用真实 Arcade `World`/`Body` 按真实地图复核：注册后 5 团火的脚点就是内容坐标；`placeAll(..., {evictOccupied:true, displaceable:[player]})` 前后不变，`corrections` 为空。舞台侧用真实 Body 跑 `placeContent` + 多帧 `preUpdate`/`settleStep` 后脚点也不变（火焰在阻挡格上，`terrainRecovery` 为 false，不会被自愈搬走）。

### 4.3 物理坐标不会产生半格偏移

- `Body.reset(x,y)` 会 `gameObject.setPosition(x,y)`，body 的位置取 `gameObject.getTopLeft()`（`node_modules/phaser/src/physics/arcade/Body.js:1581` 起）。
- `updateFromGameObject` 的式子是 `position.x = transform.x + scaleX * (offset.x - displayOriginX)`；Container 的 displayOrigin 是 0。火焰的真实碰撞盒是 `{x:-24,y:-32,width:48,height:40}`（`public/content/world.json` 的 `actors.story-flame-7ce0ff5c`，不是 `-4`）：body 的 offset 与 collision 相同，`footPosition() = body.x - collision.x` 仍等于容器 `(x,y)`。
- `createCharacter` 用 `scene.add.container(entity.x, entity.y)`（`src/rendering/characters.ts:55`），舞台和正式世界共用这条建视觉的代码。

### 4.4 提交链把舞台坐标写进世界的路径

1. 演出阶段：`applySceneAction`（`src/rendering/story-presenter.ts:375`）对新增/变化的演员生成 `placements`；`world-object` 动作逐个 `placeContent(visual, placement.position, enabled)`（`:404`）。
2. 收尾：`finish(true)` 里 `finalStage = captureStage()`（`:520`）；`captureStage`（`:87`）用 `movement.position(visual)`（脚点）写 `x/y`。
3. 提交：`getWorldChanges()`（`:118`）按地图 diff `committedScenes`，跳过没有 `worldEntityId`、`unpositioned` 或 `stageHidden` 的演员，产出 `{id, map, actor, characterId, x, y, facing, visible}`。
4. 编译：`storyCommitCommands()`（`src/domain/story-commit.ts:7`）把 `changes` 变成 `world place` 命令（新实体用 `scope:visit`），放在命令队首；最后补 `travel` 到舞台落点和 `flag eventId`。
5. 世界：`projectStoryWorld()`（`src/scenes/world-scene.ts:1549` 起，同步段约 1589-1610）投影实体，按 `entity.x/y` 建角色，然后 `placeAll(..., {evictOccupied:true, displaceable:[player]})`。
6. 读档/回滚：`restoreScenePositions()`（`:1507`）只处理有 `worldEntityId`、未移除、未 unpositioned 的演员，用快照坐标 `placeAll`。

### 4.5 同图 `travel` 不会清掉访问期实体

`StoryWorldState.apply('travel')` 只有**换图**时才 `mapVisit++` 并清理旧 `mapVisit` 的实体（`src/domain/story-world.ts` 的 `travel` 分支）。本次演出结束的 `travel` 仍在本图，所以 5 个火焰不会被清掉。

### 4.6 相机钳制让「屏幕绝对位置」不能直接对比

地图 640×480。相机宽度取画布像素宽（2560，随设备像素密度变化），地图镜头缩放约 6.7，可见世界宽度只有约 382 px；Phaser 的 `clampX` / `clampY` 按 `displayWidth = width / zoom` 计算，把镜头中点限制在约 x ∈ [191, 449]。舞台 `centerOn(568,88)` 和正式世界跟随玩家都会把中点夹到 x ≈ 449，两边只剩纵向差别：舞台被 `centerOn(88)` 夹到约 y=107，正式世界是玩家 y=136，释放舞台的瞬间整幅画面会纵向跳约 30 px 世界坐标（随窗口缩放变化）。所以对着截图判断「火有没有挪」必须先换算到地图坐标，屏幕绝对位置在演出前后本来就不同。

## 5. 已排除的假设

1. **地图自带火焰重叠**：本图静态实体里没有火焰；95 个 scenery 贴图未逐个确认，但即使其中有静态火，也不是这 5 团演出火焰。
2. **坐标写错**：5 个坐标来自脚本，剧情世界回放也一致。
3. **半格/碰撞盒偏移**：按 Phaser Body 的换算，容器和脚点都在 `(x,y)`。
4. **`placeAll` 把没动的内容实体挪走**：坐标不变时直接放行。
5. **占位火焰 `(2048,2048)` 被写进世界**：`resolveStoryScene` 建的占位演员是 `unpositioned:true`，`getWorldChanges` 和 `restoreScenePositions` 都会跳过。
6. **旧圣所（event-55）的火焰串图**：在另一张地图，且是另一个 actor。

## 6. 还没排除的方向

按可能性从高到低：

1. **视觉层而不是数据层**：演出结束释放舞台的瞬间、正式世界重建的瞬间，是否短暂/持续同时存在两套火焰（舞台的一套仍按舞台相机 `(568,88)` 画）。看 `StoryPresenter.release()` / `WorldScene.restoreStoryWorld()` / `projectStoryWorld()` 的先后。
2. **相机/滚动**：舞台相机 `centerOn(568,88)`，正式世界相机跟随玩家。若用户是在交还操作后立刻看，参照物不同，可能产生「火相对位置变了」的观感（相机钳制与释放时的纵向跳动见 4.6）；需要截图确认「错」是相对什么。
3. **深度/遮挡**：火焰 `setDepth(y+0.5)`，仓库、稻草堆、宝箱的深度如果压过火焰，画面会像「火跑到别处」。
4. **两套火焰并存**：`projectStoryWorld` 重建实体与舞台 `releaseStage` 的时序若反了，可能留下舞台的旧副本。
5. **用户看到的「火」是另一批实体**：例如 `story-flame1-343913ac` 或地图 props，需要现场 `gm.digest()` 的世界实体列表确认。

## 7. 建议的下一步

2026-10-31：用户未能复现，本节暂时挂起。若再次出现，按以下顺序取证：

1. 让用户给一张**演出结束后**的截图（最好包含小地图和玩家位置），或者录 3 秒。
2. 在演出结束前后各跑一次 `gm.digest()`，对比 `world entities` 里 `story-object-81-2x` 的 `x/y` 是否仍是 536/40、520/88、568/72、584/136、616/72。
3. 如果 digest 坐标正确，就在浏览器里检查**渲染层**：临时在 `WorldScene.createActor` 或 `ProjectStoryWorld` 落位后打印 `character.container.x/y` 和 `movement.position(character)`，确认画面对象和实体的坐标是否一致。
4. 检查 `placeAll` 内部的 `corrections`（只保留最近 8 条，私有字段）或 `placement-blocked` 诊断，确认演出结束那次落位有没有修正过 5 个火焰。
5. 若确认是舞台残留，修 `StoryPresenter.release()` 与 `WorldScene` 投影的先后；若是深度，修 `createActor` 的 depth 规则；先有证据再改。

## 8. 关键代码索引

| 位置 | 作用 |
|---|---|
| `src/rendering/story-presenter.ts:87` | `captureStage()`：脚点写回演员坐标 |
| `src/rendering/story-presenter.ts:118` | `getWorldChanges()`：舞台差量 → 世界实体 |
| `src/rendering/story-presenter.ts:375` | `applySceneAction()`：演员落位/增量创建 |
| `src/rendering/story-presenter.ts:404` | `world-object` 走 `placeContent` |
| `src/rendering/story-presenter.ts:520` | `finish()`：完成时固化 `finalStage` |
| `src/rendering/movement-world.ts:126` | `placeContent()`：强制 reset 到内容坐标 |
| `src/rendering/movement-world.ts:136` | `placeAll()`：整组落位、让位与修正 |
| `src/domain/story-scene.ts:126` | `resolveStoryScene()`：占位演员 `(2048,2048)` |
| `src/domain/story-scene.ts:186` | `bind()`：别名改绑（5 个火焰共用别名） |
| `src/domain/story-world.ts:106` | `projectEntities()`：本图实体投影（含 `mapVisit`） |
| `src/domain/story-commit.ts:7` | `storyCommitCommands()`：命令编译 |
| `src/domain/scene-delta.ts:26` | `diffSceneActors()`：按 ActorRef 比较 |
| `src/rendering/characters.ts:55` | `createCharacter()`：容器位置与 depth |
| `src/scenes/story-stage-scene.ts:100` | `showStage()`：舞台建图/建人/相机 |
| `src/scenes/story-stage-scene.ts:206` | `ensureActors()`：增量补演员 |
| `src/scenes/world-scene.ts:823` | `createActor()`：正式世界建角色 |
| `src/scenes/world-scene.ts:1507` | `restoreScenePositions()`：读档/回滚落位 |
| `src/scenes/world-scene.ts:1549` | `projectStoryWorld()`：投影 + `placeAll` |
| `src/domain/navigation-world.ts:124/166/186/226` | `canPlace` / `canStand` / `canSettleAll` / `nearest` |
| `src/debug/gm-actions.ts:442` | `gm.jumpStory` |
| `src/ui/phaser/gm-panel.ts:338` | 调试面板「剧情」页 |

## 9. 工具与命令

```bash
npm run typecheck
npm run validate:content                      # 内容改动后
npm run debug-start:check                     # 调试现场表是否过期
```

事件81路线探针已随 2026-10-31 的清理删除；需要时按 4.1 的记录重建。

诊断文件：`.diagnostics/client-errors.jsonl`（约 2MB，1085 行）。当前没有 `story-object-81` / `story-flame` 相关记录；`kind` 以 `start-phase`（855）和 `collector-start`（149）为主，另有 `story-rebuild-cover` 12、`story-silent-entry-missing` 13、`story-error` 3（都是 2026-10-27 iPhone 资源错误）、`gm-state` 3（训练地牢/暗影厅摘要）。也就是说：**没有现成的运行时证据可反推错位坐标。**

## 10. 约束

- 验证不主动启动浏览器（Playwright/headless Chrome 都不自行启动）；界面由用户验收。
- 每修一个独立问题单独 git 提交，提交说明写清修复行为和验证结果。
- `gm-actions.ts` 不得引入 Phaser/UI。
- 客户端校验不得严于服务端。
- 改存档结构/校验口径要升 `SAVE_FORMAT` 并补迁移和旧档测试。
- 仓库里有一个未跟踪的 `tmp-exit-probe.ts`，是早前出口探针，与本问题无关。

## 11. 相关历史

- 没有针对「演出结束后火焰位置」的修复提交。
- 2026-10-31：用户反馈用调试流程未能复现；同次清理删除了 `3e17ff2` 引入的临时探针 `tests/tmp-event81-probe.test.ts`。
- 相关提交：`a845bc2 fix(story): 位置登记接管同角色过场实例`、`6471bf4 fix(story): 演出结束把掉队佣兵和召唤物收回主角身边`、`1ea2cbe perf(movement): 固定内容体没有移动意图时跳过地形约束`、`3e17ff2 test(story): 补事件81路线探针`。
- 文档：`docs/story-content.md:62-84`（舞台 cast id 与 `worldEntityId`）、`docs/module-guide.md:161`（演出结束的命令编译）。

# 代码审查后续项（2026-10-31）

本轮完成了审查建议 1–4 步，以及用户确认的后续项：泉水全队、换绑差量、D-pad 274、删除无人监听事件、清理 8 个测试专用导出、删除凝视参数与 `durationMs`。

## 已修复的测试失败

- `rush-of-anger-runtime`：AI 音效期望写于初始提交，2026-10-23 的 `ad197ec` 有意让所有玩家阵营成员的技能派发都出声；测试已同步。测试夹具缺少 `terrainFree`/`bodyTerrainFree`，已补。
- `isOneHitKill`：`breakable-drops` 和 `molten-armor` 的夹具缺少生产 `settleHit` 会调用的 `session.isOneHitKill`，已补返回 `false` 的桩。

仍失败、未处理：`tests/frenzy-attack.test.ts` 3 条 Phaser 播放测试在 `main` 基线也失败（`animationcomplete` 后 `finished` 仍为 `false` 等），属于既有测试基础设施问题，未混入本轮改动。

## 本轮已处理

- 泉水：回血/回蓝按每名存活上阵队员自己的上限结算；正面状态给所有存活上阵队员；负面或攻防混合状态只给喝下泉水的人；技能点只给主角；死亡和候补成员不参与。
- 换绑：`scene-delta` 的变化判断补上 `worldEntityId`、`characterId`、`authority`，`story-presenter` 的第二道过滤同步，并补回归用例。
- D-pad：视觉、布局边界、编辑器预览统一到 274×274；摇杆仍是 210×210；默认位置按 274 内移到安全区。
- 场景事件：删除 `map-ready`、`attack-contact`、`combat-hit-feedback` 三处无人监听的 `emit`。
- 测试专用导出：删除 `resolveActionState`、`rollEnemyDrops`、`plainQuestText`、`skillDetailText`；`compileScript`、`storyScriptActions`、`plainText` 移到 `tests/support/story-fixtures.ts`；`EQUIPMENT_SLOT_ORDER` 移到 `domain/items.ts`，并让 `validate:content` 校验槽位顺序。
- 诊断字段：删除 `attack-splash` 的凝视参数和 `ResolvedBasicAttack.durationMs`；保留 `attack-proc` 的 `status`/`stagesExecuted`。

## 保留的“看似死代码”

- `WorldCombat.paused`：生产不读，但 `tests/world-runtime-review.test.ts` 用它断言暂停状态。
- `calculateManaCost` 的 `cost===0?0:cost`：它把负零 `-0` 归一成 `0`，测试会区分两者。
- `GmReferences.actorName`：`gm-panel` 内部已不读，但 `story-ui` 仍传入。
- `attack-proc` 的 `status`/`stagesExecuted`：生产忽略返回值，测试用它断言重入和预算保护。
- `tools/debug-start/data/story-debug-evidence.json`：仍含 `accept`，但运行时只加载 `public/content/debug/start.json`。

## 仍需人工确认

- 宝箱淡出：`captureStoryScene` 只看 `chestOpened`，`refreshState` 还允许 `chestFades` 期间可见；是否统一待定。
- 召唤召回的安全距离：场景用切比雪夫距离和基础感知，敌人 AI 用 `targetDistance/8`、`sightBonusUnits` 和 `map-wide`。
- `shop-panel` 用文本里有没有全角问号 `？` 决定字号和颜色；改成显式 `tone` 更稳。
- 换绑 A→B 后旧世界实体是否移除：本轮只修“漏刷新”，没有改旧实体清理策略。
- `src/rendering/ground-loot.ts` 用 `sprite.texture.key` 当动画键；当前内容没命中图集特效，属于潜在问题。
- 层级遗留：`story-ui.ts` 在布局目录绘制并运行时依赖 Phaser 面板；`wardrobe.ts` 在渲染层改写领域目录；`world-scene`/`world-combat` 仍承载泉水、宝箱等级、圣徒之牺牲、队形等规则。
- 工具脚本死字段、`build-slot-frames.ts` 未挂 npm 命令、148 个导出在定义文件外零引用。

## 本轮验证

- `npm run typecheck` 通过。
- 本轮相关 39 个测试文件、402 条用例通过；`rush-of-anger` 9 条通过；`breakable-drops`/`molten-armor` 19 条通过。
- `npm run validate:content` 通过（416 张地图、12061 个素材）。
- `npm run debug-start:check` 通过（487 个任务、0 gap）。

# 代码审查后续项（2026-10-31）

本轮处理了审查建议里的 1–4 步：修行为问题、修门禁问题、删低风险死代码、收敛文字颜色和控件尺寸。下面记录没有处理或需要人工确认的项目，避免以后误删行为。

## 已修复的预存在失败

`tests/rush-of-anger-runtime.test.ts` 在 `main` 基线失败，不是本轮死代码改动引入；根因已确认并修复（2026-10-31）：

- AI 音效：测试期望写于初始提交（2026-10-22）。2026-10-23 的 `ad197ec` 有意把音效门槛从“只有当前操控角色”改成“所有玩家阵营成员”，注释写明“切到佣兵前他们出手全静音”。生产行为正确，测试期望已同步为手动和 AI 都播放 `Wa_Anger_Rush`。
- `terrainFree`：测试夹具写于初始提交（2026-10-22）。2026-10-25 的 `4b6dd64` 给 `relocateVisual` 加了地形兜底检查，但没有同步夹具。已补 `terrainFree` / `bodyTerrainFree` 返回 `false`，保持“整盒站不下就留在原地”的原意。

验证：`tests/rush-of-anger-runtime.test.ts` 9 条全部通过。

## 保留的“看似死代码”

- `WorldCombat.paused`：`src` 没有读取，但 `tests/world-runtime-review.test.ts` 用它断言暂停状态，保留。若要删，先把测试改成 `diagnostics().runtime.paused`。
- `calculateManaCost` 的 `cost===0?0:cost`：不是恒等表达式，它把负零 `-0` 归一成 `0`，测试会区分两者，保留。
- `GmReferences.actorName`：`gm-panel` 内部已不读，但 `story-ui` 仍传入，保留。
- `tools/debug-start/data/story-debug-evidence.json`：仍含 `accept` 字段，但运行时加载的是 `public/content/debug/start.json`，不受影响；生成器没有清理这份历史输入，留待工具侧整理。

## 需要人工确认的行为

- 泉水结算对象：`world-scene.ts` 里 buff 给当前操控角色，回血/回蓝/技能点给主角。哪种是设计意图需要确认。
- 剧情快照的宝箱淡出：`captureStoryScene` 只看 `chestOpened`，`refreshState` 还允许 `chestFades` 期间可见；是否统一需要确认。
- `scene-delta.changed` 没有比较 `worldEntityId`/`characterId`/`authority`：演员只换绑世界实体时可能不产生差量，需要一次实际换绑场景复现后再改。
- 召唤召回的安全距离：`world-combat.ts` 用切比雪夫距离和基础感知，敌人 AI 用 `targetDistance/8`、`sightBonusUnits` 和 `map-wide`；两套口径是否统一需要确认。
- `shop-panel` 用文本里有没有全角问号 `？` 决定字号和颜色；改成显式 `tone` 字段更稳，但属于界面行为调整。

## 明确未删的“只被测试使用”项目

这些在生产代码里零引用，但测试仍在用；删除会减少覆盖，先保留并建议移到 `tests/support/` 或让生产路径真正使用：

- `resolveActionState`
- `rollEnemyDrops`
- `plainQuestText`
- `compileScript`
- `storyScriptActions`
- `plainText`
- `EQUIPMENT_SLOT_ORDER`
- `skillDetailText`

## 明确未删的行为相关项

- `attack-splash` 的 `gazeTargetId` / `retainCurrentTarget` / `consumedGaze`：生产不传，只有 `molten-armor` 测试覆盖；删掉等于移除一项已测试但未接线的行为。
- `attack-proc` 返回的 `status` / `stagesExecuted`：生产忽略返回值，测试用来断言重入和预算保护；属于诊断 API。
- `ResolvedBasicAttack.durationMs`：生产改用 `basicAttackFrames` 现场计算，测试仍断言该字段。
- `combat-action-dispatcher.ts` 里两次 `between(x); between(y);` 空抽：可能用于对齐原版随机序列，删掉会改变后续随机结果。
- 场景事件 `map-ready`、`attack-contact`、`combat-hit-feedback`：仓库内没有监听者，但外部调试脚本可能动态监听，未删。

## 工具脚本与导出面

- `tools/build-effect-atlas.ts` 的 `EffectLayer.key`、`UniqueFile.paths`、`TrimmedFrame.index`、`AtlasResult.targetFiles`。
- `tools/build-icon-atlas.ts` / `tools/build-ui-atlas.ts` 的 `sourceBytes` 和货架 `height`。
- `tools/content-build.ts` 的 `skillProfiles`、`displayRows`、`irSkills`、`ClipDedupe.canonical/hashes`。
- `tools/debug-start/debug-solver.ts` 的 `elsewhere`、`DebugInputs.draft.scripts/mapEvidence`。
- `tools/build-slot-frames.ts` 没有挂到 npm script，只有文档提到。
- 全仓扫描发现 148 个导出在定义文件之外零引用（多数是类型），`export` 面偏大；建议按模块逐步收回，不做一次性批量修改。

## 层级与语义化遗留

- `src/ui/story-ui.ts` 仍在 `src/ui/` 根目录创建 `UiSurface`、画标签栏和页面，并运行时 import `./phaser/*`；与 `src/ui/AGENTS.md` 的分层描述不一致。
- `src/rendering/wardrobe.ts` 直接 `Object.assign(this.catalog.poses, poses)`，在渲染层改写领域内容目录。
- `src/scenes/world-scene.ts` / `world-combat.ts` 仍承载泉水结算、宝箱等级兜底、圣徒之牺牲伤害转移、队形/跟随/追赶等规则。
- `src/rendering/ground-loot.ts` 用 `sprite.texture.key` 当动画键；当前内容没命中图集特效，属于潜在问题。
- 控件尺寸收敛后，编辑器 D-pad 视觉半径仍是 137（274 直径），而 `resolveControlLayout` 的 move 尺寸是 210；这是原有差异，本轮只统一了来源，没有改数值。

## 本轮验证

- `npm run typecheck` 通过。
- 第二批死代码删除相关的 30 个测试文件、305 条用例通过。
- `npm run validate:content` 通过（416 张地图、12061 个素材）。
- `npm run debug-start:check` 通过（487 个任务、0 gap）。

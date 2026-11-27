# tests/support

测试共用的驱动、替身与内容夹具：驱动一帧动作派发、提供不进行真实渲染的假精灵，并把只服务测试的剧情编译与文本工具收在这里。

## 文件

- `combat-driver.ts`：战斗测试驱动器，导出 `dispatchFrame` 和 `playCombat`，用领域 CombatRuntime 与 CombatActionDispatcher 向测试桩派发动作。
- `combat-test-harness.ts`：纯 Node 战斗领域测试支撑，导出目录缓存加载器、`ZERO_PRIMARY_ATTRIBUTES`、`defaultTestPanel`、`createTestMember`、`createTestEnemy`、`createCombatTestHarness`、`createTestGameUi`、`createSimpleStatsPort`；纯领域测试通过本模块构造 `CombatActorStats`、`CombatSettlementEngine` 等领域对象，禁止导入 `phaser` 或 `scenes/world-combat.ts`。
- `world-combat-fixture.ts`：场景级 `WorldCombat` 测试支撑，导出 `PHASER_STUB_SOURCE`、`loadWorldCombatClass`、`installPhaserStubHooks`、`createFakeContainer`、`createFakePhaserScene`、`createFakeMovementWorld`、`createTestWorldCombat`；供需要验证 `WorldCombat` 场景集成与渲染绑定的测试使用，禁止再通过 `WorldCombat.prototype` 反射私有方法。
- `menu-dom.ts`：导出 `MenuElement`、`domWindow`、`menuFrame`、`installMenuDom`、`domEvent`；提供菜单测试的 DOM 环境、原生指针、捕获与冒泡。`menuFrame` 单独提供画框 CSS 矩形，与假场景的画布像素尺寸分别设置；显式安装时重置画框并返回恢复函数，测试文件结束时恢复全局对象。
- `atlas-image.ts`：导出 `atlasImageSize`，读图集页的宽高并确认它是无损 WebP（`VP8L`）；图集页测试用它代替读 PNG 文件头。
- `fake-sprite.ts`：导出 `FakeSprite`，只实现生产代码用到的链式调用面，避免启动真实渲染。
- `story-fixtures.ts`：剧情与文本测试夹具，导出 `compileScript`、`storyScriptActions` 和 `plainText`；这些工具只被测试使用，不进入生产导出。
- `quest-e2e-indexes.ts`：任务闭环底座的内容加载与只读索引模块，导出 `QuestHarnessContent`、`loadOfficialQuestContent`、`buildCampaignIndexes`、`buildContentSourceIndexes`，预索引任务/事件/掉落/采集点/出口规则、按图预分桶摆放、退回路障与区域触发门、排除后置死胡同回程口的上游入口（`upstreamIncomingExits`）、静态出口连通片（`staticReachableByMap`）与正式剧情切图桥接岛（`storyBridgeMaps`）。
- `quest-e2e-navigation.ts`：任务闭环底座的可见实体投影、跨图物理连通图计算（从主角真实站位出发，要求跨图出口同时开锁且不被动态碰撞体封死，同图传送阵须先踩入口才展开终点，退回路障区域阻断穿行）、刷怪点可接近核验与纯几何阻塞判定模块（零英文角色名正则，只挑能打通目标或打通外部新区域的必需清障事件，不误伤旁观村民与死胡同门房）。
- `quest-e2e-stage.ts`：任务闭环底座的舞台表现端口工厂，导出 `createStoryPresentationPorts`，封装完整 `prepareSceneVisit + assertUniqueActorInstances + assertScenePlan + getWorldChanges` 舞台端口与轻量状态机舞台端口。
- `quest-e2e-harness.ts`：无跑图零兜底任务状态闭环主底座，统一 re-export `QuestHarnessContent`、`loadOfficialQuestContent`、`buildCampaignIndexes`、`createQuestE2EHarness` 与 `runContinuousCampaignPlaythrough`；连接真实 `Session`、`StoryDirector`、`GameUI`、`buildStoryTriggerIndex`、`claimStoryTrigger`、`pickNearestInteractionTarget`、`NavigationWorld`、`WorldEnemyRoster`、`Storefront`、`GroundLootStore.collectAll` 与正式格式 1 存读档。单任务准备在 `applyQuestStartPlan` 后立即清除调试强开覆盖（`clearDebugOverrides`），强制真实验证任务解锁条件、地图触发竞争、身边交互抢焦点、跨图出口与刷怪可达及 6 类合法物品产出；真正横跨物理孤岛的单任务单独走带三道门禁与审计日志（`log.crossIslandTransfers`）的 `crossIslandToMap` 通道。
- `quest-e2e-playthrough.ts`：导出 `runContinuousCampaignPlaythrough`；从 `campaign.start` 单一新会话出发，零调试跳转、零清包、零反推补条件，沿真实打通出口并发接取与跨地图交付全部 487 个正式任务，并在章节关口执行正式格式 1 存读档实例接力。
- `quest-mini-world.ts`：导出 `createMiniQuestWorld`；在内存中构造通过全部正式内容校验器且含真实地图双向出口与刷怪点的最小合法任务集，供破坏性边界、故障注入与反作弊自证测试使用。

## 规则

- 替身只实现用例实际调用的成员；需要记录数值的用例在本地覆写，不把记录行为加进共用基类。
- 假对象使用内存存储与本地素材。需要浏览器全局对象的 DOM 测试显式安装环境，并登记文件结束时的恢复函数。
- 战斗驱动用显式时钟和候选人列表推进，随机行为由用例用固定种子或显式输入约束，同一输入回放结果一致。
- 新增共用成员时覆盖各用例重合的链式方法，让生产代码多调一个方法时在共用替身上暴露。

## 验证

```bash
npm test -- tests/combat-runtime.test.ts
npm test -- tests/skill-unit-runtime.test.ts
```

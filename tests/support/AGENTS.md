# tests/support

测试共用的驱动、替身与内容夹具：驱动一帧动作派发、提供不进行真实渲染的假精灵，并把只服务测试的剧情编译与文本工具收在这里。

## 文件

- `combat-driver.ts`：战斗测试驱动器，导出 `dispatchFrame` 和 `playCombat`，用领域 CombatRuntime 与 CombatActionDispatcher 向测试桩派发动作。
- `menu-dom.ts`：导出 `MenuElement`、`domWindow`、`menuFrame`、`installMenuDom`、`domEvent`；提供菜单测试的 DOM 环境、原生指针、捕获与冒泡。`menuFrame` 单独提供画框 CSS 矩形，与假场景的画布像素尺寸分别设置；显式安装时重置画框并返回恢复函数，测试文件结束时恢复全局对象。
- `atlas-image.ts`：导出 `atlasImageSize`，读图集页的宽高并确认它是无损 WebP（`VP8L`）；图集页测试用它代替读 PNG 文件头。
- `fake-sprite.ts`：导出 `FakeSprite`，只实现生产代码用到的链式调用面，避免启动真实渲染。
- `story-fixtures.ts`：剧情与文本测试夹具，导出 `compileScript`、`storyScriptActions` 和 `plainText`；这些工具只被测试使用，不进入生产导出。
- `quest-e2e-indexes.ts`：任务闭环底座的内容加载与只读索引模块，导出 `QuestHarnessContent`、`loadOfficialQuestContent`、`buildCampaignIndexes`、`buildContentSourceIndexes`，预索引任务/事件/掉落/采集点/出口规则、静态出口连通片（`staticReachableByMap`）与正式剧情切图桥接岛（`storyBridgeMaps`）。
- `quest-e2e-navigation.ts`：任务闭环底座的可见实体投影、地图静态出口可达性（按修订号缓存，绝不跨锁门）、动态障碍导航网 BFS 与纯几何阻塞判定模块（零英文角色名正则，只挑能打通目标或为打通目标所必需的清障事件，不误伤旁观村民）。
- `quest-e2e-stage.ts`：任务闭环底座的舞台表现端口工厂，导出 `createStoryPresentationPorts`，封装完整 `prepareSceneVisit + assertScenePlan` 舞台端口与轻量状态机舞台端口。
- `quest-e2e-harness.ts`：无跑图零兜底任务状态闭环主底座，统一 re-export `QuestHarnessContent`、`loadOfficialQuestContent`、`buildCampaignIndexes` 与 `createQuestE2EHarness`；连接真实 `Session`、`StoryDirector`、`GameUI`、`NavigationWorld`、`WorldEnemyRoster`、`Storefront`、`GroundLootStore.collectAll` 与正式格式 1 存读档。强制 5 项硬核对：所有人物/机关仅从可达地图真实 `visibleEntities` 查找且须动态碰撞可达（零虚拟实体）；接取与推进全量走真实触发器入口并对 `region` 框做动态路障格子连通校验；目标怪物须存在于活跃遭遇或当前静态出口可达地图真实 `WorldEnemyRoster`；任务/交接物品须经 6 类合法来源在可达地图真实产出（严禁凭空塞包）；普通换图与查找严禁跨锁死出口穿墙，真正横跨物理孤岛的任务单独走带三道门禁与审计日志（`log.crossIslandTransfers`）的 `crossIslandToMap` 通道。
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

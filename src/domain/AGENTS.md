# src/domain

游戏规则的家：会话、剧情、战斗、物品、导航和存档都在这里，全部是纯 TypeScript。

## 文件

- 会话/剧情：`session.ts`、`story-director.ts`、`story-runtime.ts`、`story-graph.ts`、`story-condition.ts`、`story-scene.ts`、`story-script.ts`、`campaign.ts`、`scene-plan.ts`，以及同前缀的 `story-*.ts`、`scene-*.ts`。
- 战斗：`combat-*.ts`、`battle.ts`、`action-*.ts`、`attack-*.ts`、`buff-*.ts`、`skill-*.ts`、`enemy-*.ts`。
- 物品/背包：`items.ts`、`inventory.ts`、`bag.ts`、`drops.ts`、`loot-pity.ts`、`ground-loot.ts`、`crafting.ts`、`enhancement.ts`、`equipment-*.ts`、`shop.ts`、`money.ts`（金额拆分与显示文本）。
- 队伍/召唤：`party*.ts`、`companion-progression.ts`、`friendly-summon-ai.ts`、`summon-*.ts`。
- 导航/地图：`navigation.ts`、`navigation-world.ts`、`pathfinding.ts`、`path-budget.ts`、`walk-route.ts`、`map-placement.ts`、`minimap.ts`。
- 存档/状态：`save-game.ts`、`state-application.ts`、`key-bindings.ts`、`control-skin.ts`、`legendary-weapon.ts`（拔剑判定、奖励与已拔状态）、`inns.ts`（旅店休息费用与恢复）。
- 任务/文本：`quest-*.ts`、`menu-panels.ts`、`text-markup.ts`、`description-text.ts`；其余文件按前缀或符号搜索，例如 `combat-runtime.ts`、`story-entry.ts`。

## 规则

- 本目录保持零 Phaser 依赖，也不 import `application`、`ui`、`rendering`、`scenes`、`debug`。
- 新规则写成纯函数或状态迁移，由 `application` 负责适配 Phaser、浏览器和磁盘。
- 金额一律以铜币存储；对玩家展示时用 `money.ts` 的 `moneyText` 或 `splitMoney`，不要直接把裸数字写成「金币」。
- `SAVE_FORMAT` 当前是 39；改存档结构或校验口径时把它加一，并在 `src/application/saved-game.ts` 补迁移和旧档测试。升级链覆盖的旧档正常读取；比升级链更早的档案显示为空槽。
- 古老武器把地图等级 0 兜底成 1（体验版偏离原版“除零必失败”）。
- 恢复泉水的回血、回蓝按每名存活的上阵队员自己的上限结算，数值夹到上限；正面状态同样给所有存活上阵队员。药水病、药效减半、技能封印和攻升防降的疯癫只给喝下泉水的人。技能点只给主角；出怪与队伍组成无关。
- 组队技能 122「被选择的英雄」在基础拔剑奖励后额外掷一次 uniqueBonus/1000；命中把普通装备或空手失败升级为唯一物品，已经是唯一物品则不重复判定。
- 剧情、任务、事件 ID 是存档引用，只新增不改名；要改名就配套迁移。
- 单元测试写在 `tests/*.test.ts`。

## 验证

- `npm test -- tests/session.test.ts` 覆盖会话与剧情状态；`npm test -- tests/save-game.test.ts` 覆盖存档结构与格式号。

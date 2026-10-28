# Boss 进图主动开战

现有地图中已生成的饥饿的狼首领、骷髅士兵头领，在加载和演出结束、正式战斗恢复后的第一个逻辑帧发现全图队伍并开始追击。攻击仍要求合法站位和既有攻击距离。

这是本作明确选择的玩法增强。敌人的主动／被动分类和基础警戒范围仍由内容数据决定；“进图即全图参战”由内容中的显式配置开启。剧情或展示人物的 Boss 房间继续按既有出场安排运行。

## 内容配置

`EnemyBehavior.engagement` 的 `map-wide` 值启用全图参战，省略时沿用既有发现规则。当前仅配置以下两个定义：

| 敌人 | 当前地图 | 已有生成批次 |
|---|---|---|
| `enemy-starving-boss-wolf-1` 饥饿的狼首领 | 哈怒恩丛林2 `training-dungeon-two` | 代表等级5 |
| `enemy-boss-skeleton-1` 骷髅士兵头领 | 黑暗骑士团地下训练场2 | 代表等级42 |

`map-wide` 是每个敌人定义内的字段，随内容写入 `battle.json`，游戏运行和构建只读取该文件。加载和构建会拒绝“声明了全图参战，却不是主动型、或没有普攻和技能”的定义；内容加载与构建共用校验器。

等级批次、生成条件、击败记录、刷新、奖励与地图出口继续由既有系统管理。配置不会让尚未生成或已被击败的 Boss 提前出现。

## 决策与生命周期

`enemyAwarenessRangeUnits` 为 Boss 返回覆盖当前地图的有限距离，同时用于脚点发现和矩形距离的仇恨衰减。基础警戒数值、移动速度、技能距离和伤害范围保留在内容中。普通怪物仍使用既有警戒与主动／被动行为。

首次发现沿用既有队伍顺序及初始仇恨数值，之后由共同仇恨系统决定目标。拉远不会因警戒距离衰减清空仇恨；当前目标死亡或离场后可以重新选敌。嘲讽仍在当前攻击完整收尾后影响下一次选择。

普通追近每 180ms 重算一次；搜索判定整条路线不可达后，停止追近并保留仇恨，退避 600ms 再重试。全队隐身或没有有效目标时等待；目标重新出现后继续发现。固定站位敌人的移动限制与攻击射程继续生效。

暂停使用共有游戏逻辑时间；离图和销毁沿用既有控制器、物理与战斗运行器的清理。读档恢复静止 Boss 时清除旧的无路重试等待，在下一逻辑帧重新规划。当前存档格式是 `SAVE_FORMAT = 37`；Boss 参战配置本身不新增存档字段。

## 验证依据

| 可复核入口 | 验证结论 |
|---|---|
| `tests/boss-engagement.test.ts` 的两张真实地图与实际 Boss 定义 | 远超普通警戒范围的入口可以发现玩家，沿合法路线接近并出手 |
| 同文件的世界仇恨适配、距离衰减和嘲讽用例 | 发现与衰减范围一致；不反复增加初始仇恨，不打断现有动作换目标 |
| 同文件的堵路、隐身、读档、暂停及销毁用例 | 受阻后限频重试，恢复后参战，销毁后旧动作不再命中 |
| 同文件的等级批次与击败记录、`tests/enemy-content.test.ts` | 标记仅覆盖两个现有 Boss，不改变生成阶段和普通被动怪 |

运行：

```bash
npm test -- tests/boss-engagement.test.ts tests/enemy-content.test.ts tests/enemy-ai.test.ts tests/combat-threat-system.test.ts tests/world-threat.test.ts tests/world-threat-life.test.ts tests/world-enemies.test.ts tests/world-runtime-review.test.ts tests/combat-clock-runtime.test.ts tests/combat-snapshot.test.ts tests/save-game.test.ts tests/saved-game.test.ts tests/saved-game-loader.test.ts tests/friendly-summon-ai.test.ts tests/friendly-summon-world.test.ts
npm run validate:content
npm run build
```

实际画面和战斗观感在游戏入口（默认 4002）验收。

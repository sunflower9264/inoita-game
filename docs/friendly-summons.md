# 友方召唤物的自主行为

玩家与队友召出的地狱之兵和驯兽召唤自动跟随固定的施法者，护主，并按自身警戒范围主动发现附近的敌人。切换操控者不改变召唤物的主人。

这是当前实现的行为增强。技能数值、近战攻击、寿命、命中嘲讽、派生属性和受命呐喊继续沿用现有内容；本文的战术参数是本作的游戏规则。

## 参与战斗

主动型召唤物按自身怪物定义的警戒范围主动发现敌人，游戏内警戒距离规则为八像素量化：`floor(targetDistance / 8) <= awarenessRangeUnits`。地狱之兵和驯兽召唤的警戒范围是 8；被动型定义不会自索敌。展示型场景物（灌木、罐子、木箱、黑甲展示士兵）不会进入自索敌目标。

`SummonCombatAwareness` 继续读取已经起手的敌对动作、敌人的实际追击与最近 1800ms 的敌对接触，提供召唤物视野外的接战目标与威胁优先级。主人只是选中或接近怪物、给自身加增益，本身仍不构成接战；无需选中目标的范围攻击属于真实战斗，但具体敌人要在接触后才进入候选。

下面两条规则约束自索敌：候选距主人不超过 128px（主人当前目标、集火或保留目标放宽到 192px），且主人距目标不超过 192px 的牵引距离。

地狱之兵偏协助主人输出，驯兽优先保护主人并牵制正在攻击自己的怪。主人生命不高于 30% 且受威胁时，两者均优先救主；队员生命不高于 35% 时纳入护卫考虑。

| 参数 | 当前规则 |
|---|---|
| 目标距离 | 普通候选距主人≤128px；主人实际目标、已交战集火目标及保留目标≤192px |
| 决策间隔 | 180ms；战斗动作仍每60ms推进 |
| 换目标 | 更高优先级确认可达后接手，等待当前动作完整收尾；同档保持至少600ms，剩余路线至少缩短32px |
| 搜索结论 | 明确无路的候选记忆900ms；不值得换的同档候选短暂复用验证结果 |
| 普通跟随 | 碰撞边缘间距>32px开始，≤16px停止 |
| 优先归队 | 脚点距主人>192px进入，回到≤64px才恢复选敌 |

## 寻路与解卡

`FriendlySummonController` 决定目标和路线；`CombatController`、`CombatRuntime` 执行动作；`MovementWorld` 与 Arcade Physics 推进位置和碰撞。跟随及攻击站位使用稳定方向偏好，受阻时尝试邻近合法位置。

召唤落点必须从主人位置沿地形走得到：`NavigationWorld.nearestReachableBody` 先校验
`planSummonSpot` 给出的优先点，走不到就在主人的可达区域里找最近的整盒可站点；
整张地图都没有可达位置时这次不出生。连通性按移动的窄足底口径判定，落点本身仍要求
整个碰撞盒不压墙、不压人。

每只召唤最多一个分步搜索任务，每180ms最多启动一次，每逻辑帧最多展开64个节点；当前三名队员的召唤总预算为192。`NavigationWorld.captureStandability` 冻结地形、形状和动态占位。路线完成后验证当前可接入的路段，物理移动继续检查下一段；主人移动时先使用安全前缀，再追踪新目的地。普通怪物和队员仍使用原有同步 `findPath`。

超过主人320px持续5040ms，或超过64px且确有跟随需求、已完整证明无路／持续请求移动却没有4px有效进展达到5040ms后，才有召回资格。首次等待搜索预算不算无路；同一目的已有的完整失败证据可以在重查时保留，执行召回仍等待搜索完成。主人目的移动16px、实际移动4px或找到可走路线会使对应失败证据失效。

世界层另外要求整队及友方召唤连续脱战3000ms、运行器空闲、没有敌人追击。原点、主人和落点均避开活敌警戒，包括隐身敌人。落点从主人附近有限候选中选择，检查地形、占位、出口、交互位置和主人一侧的局部通行。没有合法位置继续等待。

召回移动原实体，生命、魔力、状态、冷却、仇恨和剩余寿命随原实体保留。菜单、剧情与后台暂停使用游戏逻辑时间；眩晕、睡眠、定身不能产生召回资格。

## 保存与验证

当前存档格式为36。世界快照用 `enemy` 与 `friendly-summon` 区分 AI 状态，校验主人、角色类型和召唤分组。读档恢复静止实体，保留资源和冷却，清理路径、搜索和短期决策，重新计算脱战时间。

以下用例分别验证当前实现的规则、调用与行为：

| 证据入口 | 验证结论 |
|---|---|
| `tests/friendly-summon-ai.test.ts` | 专用控制器的自索敌、跟随、角色决策、归队、预算、解卡与动作时序 |
| `tests/navigation-placement.test.ts` | 召唤落点从主人位置可达，隔墙时退回主人一侧 |
| `tests/summon-tactics.test.ts`、`tests/combat.test.ts` | 区分选中目标、实际动作与敌对接触，防止自增益误开怪 |
| `tests/friendly-summon-world.test.ts` | 世界观察到召回落位的真实适配，包含追击、隐身、隔墙、出口和实例保留 |
| `tests/sliced-pathfinding.test.ts` | 分步搜索预算、冻结碰撞，以及旧同步搜索的等价性 |
| `tests/combat-snapshot.test.ts`、`tests/save-game.test.ts` | 新格式读回、静止恢复和身份校验 |

从游戏根目录复核：

```bash
npm test -- tests/friendly-summon-ai.test.ts tests/friendly-summon-world.test.ts tests/summon-tactics.test.ts tests/sliced-pathfinding.test.ts tests/combat.test.ts tests/enemy-ai.test.ts tests/party-ai.test.ts tests/navigation-placement.test.ts tests/movement.test.ts tests/hell-s-pawn.test.ts tests/beast-companion.test.ts tests/curse-of-screams.test.ts tests/world-runtime-review.test.ts tests/combat-snapshot.test.ts tests/save-game.test.ts
```

实际跟随、战斗与召回观感在游戏入口（默认 4002）验收。

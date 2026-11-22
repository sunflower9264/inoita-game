# 已知问题与未完成工作

本文件记录当前已知、尚未修复的问题和未完成的设计。完成一项就删掉对应条目，不保留墓碑。

## 调试跳转：从正式剧情自动生成顺序（未完成）

**目标**：调试跳转的历史顺序只从正式 `scripts` / `events` / `quests` 推导，不再手工维护第二份时间线。

**当前状态**：尝试已整体撤回（`16f2b30a` → 回退 `be4f4406`）。`public/content/campaign.json` 里仍使用手工维护的 `storyProgression`，该字段是可选的调试数据，正式游玩不读取。

**已尝试的做法**：新增 `src/domain/story-progression.ts`，静态扫描脚本控制流后用状态机重放，生成 1113 步顺序；`tools/story-progression.ts` 负责生成和核对。

**撤回原因（code review 确认）**：

1. **自动事件吸收会吞掉未来的一次性事件。** `src/debug/quest-jump.ts` 曾在应用跳转计划后，把所有「当前条件已满足」的一次性 `event` / `quest` / `choice` 事件直接记为已完成，没有检查它在正式顺序里是否位于跳转点之后。跳到 `quest-21` 可接取后，`event-411`（`cardinal-summons` 的唯一接取入口）被吞，任务永远停在 available；跳到 `quest-23` 后，`event-45`（`quest-38` 的唯一接取入口）被吞，主线断开；跳到 `quest-84` 后，`event-145`（该任务的唯一完成事件）被吞，任务永久停在 ready。
2. **地图推导忽略剧情里的临时摆放。** 生成器只查静态 `campaign.placements`，不重放脚本里的 `place` 命令，也不评估摆放的 `condition`。跳到 `quest-168` 时目的地被算成 `shadow-camp`，但 `event-10` 已把卓拉德摆到 `shadow-hall`；跳到 `quest-83` 时交付人被算在卡姆兰洞穴，实际在 `pendrik-village-safehouse`；`quest-75/76/77/79` 还会提前补上 `quest-npc-located-npc-239`，把贝恩错误地搬到南彭德里克。
3. **生成顺序与正式跑图顺序矛盾。** 无条件区域/进图事件被排在任务交接之前，例如 `event-3` / `event-4` 早于 `quest-381` 交付；`event-197` 早于 `quest-107` 交付；`quest-107` 被提前拆成独立的交付步骤。中间跳转点会带上尚未发生的剧情。

**重做时必须满足**：

- 只把推导顺序中位于跳转点之前的事件记为已完成，不能按「当前条件恰好满足」吞掉未来事件；
- 重放剧情 `place` 命令和摆放条件，`mapFromWorld` 的舞台落点沿用当前地图；
- 顺序推导要建模地图可达性，或明确接受并记录与正式跑图的差异；
- 验收至少覆盖 `quest-21`、`quest-23`、`quest-84`、`quest-168`、`quest-83` 这些场景，以及 `tests/quest-jump.test.ts` 与 `tests/gm-quest-jump.test.ts` 的全部用例。

## 旧战斗测试的既有基线失败

**状态**：8 个用例失败，都是测试替身缺口，不是当前运行时代码的行为错误。

**复现**：

```bash
node --test $(grep -l "world-combat.ts" tests/*.test.ts)
```

当前结果：799 项中 791 通过、8 失败。失败分布在：

- `tests/firestorm.test.ts`
- `tests/sniping.test.ts`
- `tests/state-host.test.ts`
- `tests/target-status.test.ts`

**原因**：这些测试的假场景没有实现 `WorldCombat` 构造函数后来新增的实例字段或方法，例如 `equipmentEffectsCache`、`roster.isPresent`、`releaseEnemyState`。对应引入提交是 `65368bc6`、`456a5c67`、`394d2d3e`。

**处理方向**：按共享接口变化同步补齐假场景的字段和方法，不改断言。修好后删除本节。

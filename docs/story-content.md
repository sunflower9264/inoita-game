# 剧情与任务创作

修改 `public/content/campaign.json` 后，运行 `npm run validate:content`；任务条件、剧情分支或演出行为有变化时，再用 `npm test -- <相关测试文件...>` 运行对应测试。测试文件从 `tests/*.test.ts` 中按修改的行为和直接依赖选择，例如内容校验规则使用 `tests/content.test.ts`，剧情调度使用 `tests/story-runtime.test.ts`。全量单元测试只在用户明确要求时运行 `npm run test:all`。运行和构建共用内容、引用及演出校验。游戏运行及测试只读取本目录的源码、内容和资源。

## 先定义任务与触发

任务 `id`、目标 `goals[].id`、事件 `id`、剧情名称和节点 `id` 都是存档和检查点里的恢复引用。调整对白或顺序时保留引用的一致性，新增内容使用新标识；改写任务标识、完成规则或恢复校验时，同时更新引用并增加存档格式号，见下文「版本与恢复」。`contentVersion` 是这份内容的创作版本号。

每个目标声明 `kind`、`target` 和 `quantity`：物品使用物品 ID；击杀使用敌人定义 ID；招募使用徽章物品 ID；对话和调查使用内容中的人物或目标 ID。各目标独立计数，物品目标随真实背包数量变化；数量下降可以使 ready 回到 active。

交互目标记满后不再进入交互候选，同一对象不会重复计数。可见计数型任务的进度与完成提示由屏幕轻提示（`GameUI.showInstant` + `questNotices`）统一自动显示，不要在任务目标上另加自定义提示字段（已全局移除 `feedbackText` 与深色 `toast` 提示条；全项目提示通道分工见 `src/ui/AGENTS.md`）。

| 字段 | 游戏含义 |
|---|---|
| `availableWhen` | 开放条件；quest 的 accepted 表示已接取，completed 表示当前周期结算，settled 表示曾结算 |
| `completion: talk` | 接取后等待交付，不需要额外目标 |
| `completion: all` | 全部目标达成后等待交付 |
| `completion: story` | 由 `script-ready` 提交达成，随后交付 |
| `completion: internal` | 剧情内部进度，可由 `script-complete` 直接推进 |
| `journal: false` | 日志外任务：保存状态、照常计数和交付，但不进任务日志，也不弹任务面板 |
| `repeat` | 每次接取开启新周期；每个周期独立记录目标及奖励 |
| `onAcceptItems` | 接取时交给玩家的物品 |
| `handoverItems` | 完成时交回物品；`quantity` 扣固定数量，`all-matching` 扣当前所有匹配物品 |
| `itemCompletion: equipped-item-shortcut` | 该任务采用有序目标的穿戴例外；通常物品任务按全部目标判断 |

`QuestBook.plan` 预备接取、交付或事实更新，`Session` 负责实际物品、经验及金币提交。接取物品和交回物品分别配置；奖励按主角职业选择，实际结算记录供完成窗口使用。体验版把任务奖励里的金币和敌人/宝箱掉落的金币统一按 10 倍发放；剧情里的 `money-give`、商店出售价格和 GM 加金币不受影响。

`events` 统一声明 `source`、`script`、`condition` 和可选 `priority`。来源包括 start、map-entry、region、near、interaction、quest、inventory、choice、battle、event。区域需要 `map` 和 `region`，省略 key 时按事件 ID 触发；交互可限定 `entity`，任务及物品可用 `key` 限定对象。一般事件成功后播放一次；`repeat` 允许新发生再次触发。同一发生会按优先级依次重查候选条件，延期不完成事件。选择来源例外：每次选择都会产生新的发生，同一个选项再选一次也算；一次选择只执行一条选择事件，新的选择进入下一次发生。

给任务写交付后的自动对白时，把 `source` 设为 `quest`，`key` 填这项任务的编号，再用 `condition` 判断任务是否已交付。《最后的记忆2》的首轮结尾只播一次。后续交付的简短对白设 `repeat: true`，并在条件里要求首轮结尾已经播完。

条件可以使用 all、any、not 组合任务、事件、选择、标记和世界谓词。角色摆放 `condition`、事件 `condition`、任务 `availableWhen` 与出口 `exitRules[].condition` 共享这些规则。**角色摆放的 `condition` 是必填项**：常显写 `{"type":"always","value":true}`，漏写会在校验与构建阶段报错。区域触发保留条件表中的地图与矩形，包括覆盖进图落点和部分越界的有效区域。世界谓词包括 map、near-actor、near-entity、interaction 和 `region:<事件ID>`；对应资源和标记来源必须能够校验。

## 用稳定节点编排

节点分为三部分：`presentation` 负责表现，`commands` 改变游戏状态，`exit` 决定接着去哪里。状态需要在两句对白之间改变时，把它们放进两个节点。

```json
{
  "entry": "report",
  "nodes": [
    {
      "id": "report",
      "presentation": [{ "type": "dialogue", "actor": "darius", "speaker": "卓拉德", "text": "辛苦了。" }],
      "commands": [{ "type": "quest", "command": { "type": "complete", "quest": "grafton-mission" } }],
      "exit": { "type": "next", "target": { "script": "example-report", "node": "reward" } }
    },
    {
      "id": "reward",
      "presentation": [{ "type": "quest-popup", "kind": "complete", "quest": "grafton-mission" }],
      "commands": [],
      "exit": { "type": "end" }
    }
  ]
}
```

这个示例应作为 `scripts["example-report"]` 使用，并由已经 ready 的任务交付入口调用。第一节点的对白与表现收尾成功后，奖励和 reward 游标一起提交。窗口关闭失败时，恢复会重开窗口，奖励保留一次。

调试跳转的历史现场由 `scripts` / `events` / `quests` 在跳转时按目标任务推导：只重放到达该阶段必需的任务交接、世界摆放和选择。与目标无关的区域/进图/近身事件保持未发生，这是调试跳转与完整跑图的有意差异。

区域、近身、选择和战后演出由 `events` 的 `source`、`map`、`region`、`near`、`condition` 和 `place` 描述。脚本交接用 `script`，普通对话沿用任务定义中的阶段地点；有多处候选地点时，运行时会按实际摆放和触发来源选择。演出里的选项由脚本的 `choice` 出口和事件条件里的 `choice` 值表达。

出口包括 next、branch、choice、call、waitEncounter、defer 和 end。branch 检查包含本节点命令结果的条件；choice 保存选择并进入对应节点；call 调用共享脚本，then 指定返回节点。共享脚本的 end 在存在调用栈时返回，无调用栈时才完成整个流程。资源校验分别检查各分支的演员状态；运行还有连续节点预算和调用层级限制。

游戏命令包括 quest、talk、interaction、item-give/take/drop、money-give/take、flag、choice、party-join/leave、party-control、health、mana、equip、unequip-destroy、world、travel 和 encounter。health/mana 使用 `member` 与 `value`，后者是整数或 full；equip 使用 `member`、物品定义 `item` 和装备 `slot`，由现有穿戴规则选择背包中的实例。主角成员名是 player，剧情成员实例名是 `story-<伙伴定义ID>`。

同一节点按命令声明顺序验证及执行，所以先给装备再穿戴、先入队再切控都可以表达。任何物品、角色或任务条件不满足，整个节点保留原状态和原游标。异步加载、对白、走位和弹窗在同步事务之外执行。

## 正式世界与电影舞台

同一段演出可以在多个入口播放。沿用玩家当前地图时，行走目标按触发现场的地形解释。如果目标受阻，角色会落到附近可站立的位置。正常播放和跳过都用这个位置更新镜头和后续剧情。

剧情用 `town-pose` 让主角收起或拿出武器。玩家在切换途中跳过，后续剧情直接使用新姿态，下次需要显示人物时再准备对应的装备外观。

演出 `stage.cast[].id` 是临时演员标识。需要永久改变某个角色时同时填写 `worldEntityId`，精确绑定世界实例；同一舞台一个世界实例只绑定一次。普通临时演员不参与正式世界保存。

舞台条目同时声明 `memberId` 和 `characterId` 时，表示这个人物由队伍成员接管；事件收尾会按人物编号移除同图的地图副本，避免队伍成员和旧 NPC 同时出现。节点里的 `party-leave` 让该人物保留为地图 NPC。

地图人物的 `characterId` 表示稳定人物身份，`actor` 表示外观。任务的 `giverCharacterId`、`deliveryCharacterId`、目标的 `characterId` 和近身事件的 `nearCharacterId` 使用同一身份；不同人物可以共用素材。

地图实体和剧情摆放可以写 `authority` 标明来源：`registered` 是剧情位置登记，代表角色在本图的正式副本；`npc` 是普通任务 NPC；`story` 是演出临时实例；`static` 是地图自带对象。旧内容没写时，加载阶段按 ID 解码一次；运行期只读这个字段来决定位置登记是否接管地图副本，不再各处判断前缀。

电影 stage 可以任意跨图；正式访问与宝箱、泉水、库存保持原状态。真正转场使用 travel 命令。`world` 命令可以放置、隐藏、显示、移除永久实例，以及改变出口状态。出口使用显式地图出口 ID，或 `storyExitId(map,exit)` 的稳定默认值。

`waitEncounter` 声明地图、敌人实例和 outcomes。等待会释放输入锁；每个敌人完成死亡结算之后才能走 won。存在 lost 时先播放该分支，仍全灭则进入原有败北恢复。遭遇 ID 在运行时加上剧情运行和节点身份，同一次结果回调只接受一次。恢复战后节点保留已经获得的经验和掉落。

任务接取、完成先提交状态，再显示任务面板；日志外任务省略面板，同态重放跳过已结算操作。

临时场景物件使用 `world.place` 的 `scope: "visit"`，保留到离开当前地图。`mapFromStage` 从实际演出地图解析位置归属。`instant-message` 通过 `GameUI.showInstant` 屏幕轻提示显示（当前用于结局旁白）。

## 版本与恢复

会话快照保存目标、周期、结算记录、永久世界、稳定游标、调用栈、未处理事件与遭遇等待，以及原有完整人物、背包、伙伴和战斗资源。正式视图另存生成后的实体与持续音频；恢复同图直接还原，跨图重建时沿用生成结果。

正式世界可以随时把这份快照写进存档槽，读档时再灌回一个新会话。存档用的就是这份快照加世界视图，所以读档和「返回检查点」走同一条校验路径：`Session.restoreState` 逐项验背包、技能、任务、队伍和奖励记录，内容对不上就停在读档阶段，不让半份状态进世界。存档里的舞台检查点不重复保存可重建的演员外观，位置、朝向、显隐、姿态、镜头和绑定仍然保留；读档恢复舞台时按世界角色、队伍装备和剧情外观覆盖重新解析。

发版前运行 `npm run release:story`。它先校验内容，再运行剧情回归与存档测试，最后构建。`npm run audit:story` 检查角色身份、舞台演员和舞台动作。`npm run audit:story:full` 还会走代表性的玩家流程，覆盖主线开场、门口触发、近身剧情、确认取消与重新交付、跨图收集与重复交付、狼人战后的普通支线，以及战斗结算失败后的存读档恢复。修改未覆盖的章节或任务时，按受影响的入口补对应回归。

任务、目标、奖励和恢复引用都随存档一起保存。正式版不兼容任何旧存档。已有正式存档后，改变存档结构、内容引用或校验口径时，增加 `src/domain/save-game.ts` 的 `SAVE_FORMAT`；旧格式不再读取，不补迁移和旧档测试。首次发行读写格式 1。比 1 更早的槽显示 EMPTY，更新的槽显示不可读取。可读取的格式在内容损坏或引用校验失败时显示不可读取。`campaign.contentVersion` 是创作版本信息，不能代替存档格式校验。

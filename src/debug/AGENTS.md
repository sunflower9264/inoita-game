# src/debug

调试能力层：GM 动作与调试开关。Node 与浏览器共用这里的实现。

## 文件

- `gm-actions.ts`：GM 动作的唯一实现，面板、`globalThis.gm` 和控制台都调它。
- `quest-jump-history.ts` 按目标任务推导历史现场，计算所选任务开始前或待交付时已经发生的交接、战斗和人物摆放。
- `quest-jump-derivation.ts` 建立剧情内容索引，解析到达目标任务阶段所需的接取、完成、选择和世界摆放，按因果依赖重放并选择目的地。
- `gm-mode.ts`：GM 模式开关的本地持久化，默认关闭。

## 规则

- GM 动作只在 `gm-actions.ts` 实现一次；Phaser 面板、控制台和测试都调用同一入口，不各写一份。
- GM 任务页从 `quest-catalog.ts` 取得分组、显示顺序和当前状态。跳转在 `quest-jump.ts` 按正式接取条件、已经发生的任务交接和所选阶段准备现场。界面预览和存档后的执行使用同一阶段计划。
- 「圣女救援行动」按因果关系准备进度。向前跳时只补到达所选阶段必需的任务交接、持久摆放和选择；与目标无关的区域/进图/近身/战斗事件保持未发生，不按「当前条件已满足」吸收。往回跳时重新开放后续演出的触发。「单独潜入」的返回阶段从救出圣女后的正式落点开始，保留打开的机关，玩家可步行回去与莱曼汇合。
- 每个可选任务有明确的接取和交付入口。历史重放持久 `place` 和 flag；目的地优先使用重放后的发布者/交付者实际摆放，再回退任务阶段地点和静态 placement。`mapFromWorld` 舞台沿用当前地图。story 任务的待交付阶段先满足完成事件的前置状态，再把目标任务合成 ready，完成事件本身保持 idle。
- 向前跳时准备历史交接所需的剧情道具。往回跳时清除后续主支线的交付收据、演出和战斗实例，让玩家按正式流程重新接取和交付。历史进度不结算经验、金币和普通装备。
- 剧情跳转期间 `QuestBook.forcedAvailable` 让目标任务保持可接取，`forcedProgress` 钉住接取条件里要求 ready/active 的前置任务；两者都不进入状态快照或存档，跳转交接（接取剧情播完）和会话关闭时用 `clearDebugOverrides()` 一起清空。
- 起点状态由任务自己的完成方式决定：`completion: 'talk'` 的零目标任务只能从 `ready` 开始，规划结果归一成 `ready`，目的地取 `places.ready`；应用计划时先放成可接取，再走真实的 `quest accept` 命令，让任务簿自己写 ready、周期、运行池和接取物品。内部任务放成锁定，接取命令带 `source: 'script'`。
- 接取事件指定具体地点时，调试跳转以该地点为起点。事件沿用当前地图（`current`）时，先取目标任务在所选阶段的地点；阶段地点也无法确定时才沿用玩家的位置。
- 目的地上发布者/交付者的 placement 条件要一起补进计划。像卓拉德在影营地需要 `quest-npc-located-npc-40` flag，漏补时任务虽然到了待交付，NPC 却不会出现。同样，若前序事件隐藏了目标发布人/交付人、或目标区域触发框前有更早章节应清除的路障/通道，或前置已完结任务在目标活动地图留下了常驻剧情敌怪摆放（`enemy-location`），历史推导只投影对应的正式世界命令而不把无关章节事件塞进 `completedEvents`；显形与登记摆放投影受事件先后与前置完成护栏约束，不把更晚章节才发生的显形/摆放提前拉入早期任务；`available` 模式下目标任务自身的接取事件绝不作为前置环路被提前重放，避免隐藏自身触发实体；挑选正式接取入口时避开依赖“自身已被完成”的后置解锁事件；`applyQuestStartPlan` 清理访问级剧情敌怪残留记录时调用 `Session.forgetEnemyVitalsByPrefix('story-located-')`，不触发整份会话深拷贝。
- 接取演出需要演员时，以每幕实际所在的地图，在已发生的剧情和当前接取演出中查找该角色的摆放。
- 已过开场的现场把起始事件一起存档。选择开场任务自己的接取演出时仍可正常播放。
- 剧情跳转不维护自动事件白名单：设置阶段临时装 `setAutomaticEventFilter(() => false)` 挡住区域/近身抢占，显式接取剧情同步启动后立即清除；之后自动派发完全按正式任务、区域、近身条件执行，和正常游戏同一套推进逻辑。显式 `trigger` / `script` 本来就不经过过滤。
- 待交付任务按其目标和交付清单准备物品。重复任务保留下一轮接取资格，剧情选择按实际进入的分支保存。
- `forcedProgress` 只在自动刷新里优先；正式任务命令（accept/complete/script-ready/script-complete/reset）会先撤掉该任务的钉住，避免把刚完成的正式状态改回 ready。
- 交接时先挡住触发，清 override 并 emit，再结束跳转事务、刷新回滚检查点并补一次自动存档；这样跳转后的进度才是新的回滚点，也不会补演正式剧情。
- `play()` 遇到剧情战斗等待时会先返回，不能拿它的 resolve 当“接取剧情播完”；交接前必须等端口 `settled()` 确认这条 run 真正结束。已开演后遇错，保留现场并报告原因；抵达地图且演出完成后，用任务状态确认交接。如果任务在这次演出中已经交付，用新增的交付次数确认成功，包括打完首领后立即结束的日志外任务。
- 跳转前由界面先让玩家在存档页手动保存当前进度，作为可读档的回滚点；动作层另存一份内存快照（`session.captureState()`、`WorldScene.captureStoryWorld()`、`SessionCheckpoint.peek()`），设置失败或接取演出未启动时恢复。跳转事务期间暂停自动存档，交接后恢复并补写一次。
- 任务页的跳转按钮不直接改状态：`StoryUI` 先打开存档页，`SavePage` 成功写入后通过 `afterManualSave` 才调用 `startStoryJump`；离开存档页、关菜单或换会话会取消待办。agent 调 `globalThis.gm.startStoryJump` 时没有存档页，直接执行跳转。
- 开始跳转期间用 `StoryDirector.holdTriggers()` 挡住设置过程中的任务变化自动开演；传送结束后、接取剧情启动前释放。不要用 `busy` 代替触发保持。解除保持后必须同步启动接取剧情，`releaseTriggers()` 和 `play()` 之间不能插入 `await`，否则区域/近身自动触发可能抢先；显式 run 同步创建后，下一帧的自动判定看到 `running` 不会重复。
- 状态页「完成任务」遇到等待中的剧情战斗时，先按正常击败记录目标并让导演结算遭遇，由剧情事件结算战斗并接取后续任务；当前任务与战斗无关时先结算战斗，不直接完成无关任务。
- 调试道具列表按物品定义过滤仅地面拾取和剧情人物专属装备；可穿戴装备不按当前角色职业筛选，保留调试时给其他职业发放的能力。按物品 ID 直接发放同样校验剧情专属装备限制。
- 人物页的「技能全满」调用 `maxSkills`：主角拉满本职业技能（未学的也学会）；佣兵学会本职业全部技能，并升到该技能伙伴成长表的最高等级（没有伙伴成长表时用普通表长度）。不扣技能点、不改变角色等级，执行后发一次会话通知。
- GM 的诊断上报地址从 `application/endpoints.ts` 取，不在 `gm-actions.ts` 里写默认域名。
- 会话关闭时调用 `GmActions.dispose()`，释放本局操作日志引用。
- 本目录不导入 Phaser，保持能在 Node 下直接运行和测试。

## 验证

```bash
npm run typecheck
npm test -- tests/gm-scene.test.ts tests/gm-actions.test.ts tests/gm-quest-jump.test.ts tests/gm-complete-golem.test.ts tests/quest-catalog.test.ts tests/quest-jump.test.ts tests/quest-jump-history.test.ts tests/story-director-event-filter.test.ts
```

- `tests/gm-complete-golem.test.ts` 覆盖状态页完成任务先结算石魔遭遇、推进后续任务，以及等待中的战斗已卡住时优先结算且不误完成无关任务。

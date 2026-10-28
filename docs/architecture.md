# 游戏架构与修改入口

本目录是 Phaser 4.2.1 + TypeScript 独立工程。游戏运行、测试和构建只使用本目录的源码、内容和资源；`public/` 是随游戏版本管理的素材与内容。

本页提供修改入口和必须保持的状态边界。剧情字段写法见 [剧情与任务创作](story-content.md)，音频生命周期见 [音频](audio.md)，手机报错收集见 [诊断说明](diagnostics.md)。规则以根 [AGENTS.md](../AGENTS.md) 为准；具体行为以表中源码及相应内容为准。

## 按任务找到代码

下表路径均相对项目根目录。测试用 `npm test -- tests/<文件>.test.ts` 运行，可传多个文件；该命令先做一次类型检查。

| 要改什么 | 状态与规则入口 | 装配、表现和内容 | 优先查看的测试 |
|---|---|---|---|
| 启动、标题、职业、读档 | `application/control-state.ts`、`application/saved-game*.ts` | `main.ts`、`app.ts`、`application/ports.ts`、`scenes/menu-scene.ts`、`scenes/story-class-scene.ts` | `title-save-entry`、`saved-game-loader`、`story-class` |
| 动作起手、接近、取消 | `domain/combat.ts`、`combat-runtime.ts`、`combat-action-dispatcher.ts` | `scenes/world-combat.ts`、`rendering/combat-presenter.ts`、`content/battle.json` | `combat`、`combat-runtime`、`combat-kernel` |
| 技能效果与命中反应 | `combat-unit-execution.ts`、`combat-effect-executor.ts`、`combat-hit-resolution.ts`、`combat-reaction-pipeline.ts`、`combat-follow-ups.ts` | `world-combat.ts` 的状态与画面接口、`battle.json` | `skill-unit-runtime`、`skill-reaction-runtime`、对应技能测试 |
| 冷却、状态、持续效果与恢复 | `session.ts`、`combat-clock.ts`、`combat-cooldowns.ts`、`combat-conditions.ts`、`combat-periodic.ts`、`combat-resources.ts` | `world-combat.ts`、`status-hud.json` | `combat-clock-runtime`、`combat-cooldowns`、`combat-state-runtime`、`combat-resources-runtime` |
| 怪物与伙伴 AI（自动行为） | `enemy-ai.ts`、`party-ai.ts`、`combat-threat*.ts`、`world-enemies.ts` | `world-combat.ts`、`content/maps/`、`companions.json` | `enemy-ai`、`party-ai`、`world-enemies`、`world-threat` |
| 移动、碰撞、出口、落位 | `navigation-world.ts`、`pathfinding.ts`、`walk-route.ts`、`navigation.ts` | `rendering/movement-world.ts`、`arcade-movement.ts`、`movement-interpolation.ts`、`scenes/world-scene.ts` | `movement`、`navigation-placement`、`map-entry`、`story-exit-gates` |
| 任务、剧情与永久世界 | `campaign.ts`、`quest-book.ts`、`story-runtime.ts`、`story-world.ts`、`story-director.ts` | `campaign.json`、`rendering/story-presenter.ts`、`scenes/story-stage-scene.ts` | `session-quest-core`、`story-runtime`、`story-director-core`、`story-stage-isolation` |
| 背包、穿戴、人物成长 | `bag.ts`、`items.ts`、`character-stats.ts`、`attribute-allocation.ts`、`story-skills.ts` | `ui/story-ui.ts`、`rendering/wardrobe.ts`、`items.json`、`character-stats.json`、`wardrobe.json` | `bag`、`character-stats`、`wardrobe`、`story-skills` |
| 掉落、宝箱、泉水、商店、融合 | `drops.ts`、`ground-loot.ts`、`chests.ts`、`springs.ts`、`shop.ts`、`crafting.ts` | `world-scene.ts`、`ui/phaser/shop-panel.ts`、`crafting-panel.ts`、对应内容目录 | `drops`、`chests`、`springs`、`shop`、`crafting` |
| 快捷栏、状态栏、菜单和触控 | `shortcut-bar.ts`、`skill-configuration.ts`、`status-hud.ts`、`control-skin.ts` | `ui/phaser/`、`ui/story-ui.ts`、`rendering/hud.ts`、`ui/viewport.ts` | `shortcut-bar`、`status-hud`、`story-menu-interactions`、`viewport` |
| 剧情调试导航与跳转 | `domain/story-debug.ts`、`debug/story-jump.ts`、`debug/gm-actions.ts` | `campaign.json` 的 `debugStory`、`ui/phaser/gm-panel.ts`；[调试说明](debugging.md) | `story-debug`、`story-debug-start`、`gm-actions`、`story-menu-interactions` |
| 内容字段、引用与资源 | `domain/content.ts`、各内容类型 | `application/content-validation.ts`、`content-relations.ts`、`story-reference-validation.ts`、`story-performance-validation.ts` | `content`、对应目录测试；运行 `npm run validate:content` |
| 音效和背景音乐 | `application/game-audio.ts` | `scenes/audio-scene.ts`、`content/audio.json` | `game-audio` |
| 存档和安全检查点 | `save-game.ts`、`session-checkpoint.ts`、`session.ts`、`combat-snapshot.ts` | `application/saved-game*.ts`、`world-scene.ts`、`ui/phaser/save-board.ts` | `save-game`、`saved-game`、`checkpoint`、`combat-snapshot` |

## 状态由谁持有

`StoryApp` 装配内容、会话、导演、音频、场景和界面。场景与界面通过 `application/ports.ts` 获取能力。`ControlState` 记录运行模式与操作锁；每个锁有自己的持有者，关闭时释放本人的锁。

`QuestBookState` 使用版本3，保存按接取追加、完成时尾项替位的 `runningQuestIds`；任务掉落按这份运行顺序逐任务尝试。清支线只重置仍在池中的支线，已交付记录保持完成。

`Session` 是游戏会话的权威入口：它持有主角、队伍、背包、技能配置、任务、剧情游标、永久世界、金币、地面掉落、宝箱、泉水、商店、恢复药水时钟及共享战斗时钟和冷却。Phaser 场景负责把这些状态表现成地图、人物和界面。实时人物位置由 `MovementWorld` 的物理体持有；名单中的初始站位不是实时位置，捕获世界快照时才用物理坐标覆盖。

`Session.transaction` 只合并状态通知，失败时不会自动回滚。招募、交易、加工等组合操作先完成条件与随机结果准备，再同步提交。剧情节点的 `applyStoryCommands` 有额外的隔离预演与完整状态恢复，成功时只通知一次。它的成本与这一批实际会碰的条目成正比：预演沙盒与真实任务簿共享同一份不可变状态根（`QuestBook.fork`），任务簿写入是换条目而不是改条目，批次回滚基线用 O(1) 检查点而不是整会话克隆（`captureBatchBaseline`）。测试助手逐步走位这类**只改位置**的推进走 `Session.movePlayer`——真实运行时玩家位置由物理体推进，本来就不经过剧情命令批次。

`Session.refresh` 按任务版本、背包版本、操控成员及任务条件实际引用值复用已提交的任务结果；恢复、回滚和替换世界条件提供者会重新采样。这份缓存只在内存中存在，实时世界值和独立剧情检查点仍参与输入比较。

`Campaign.mapEntryPlacements` 的条件在进入地图时采样，满足条件的角色以本次访问的寿命加入 `StoryWorldState`；同图场景重建和状态变化保留实体，切图后清理。露娜的评价任务（489）使用这条入口：接取脚本接受后立即标记为可交付，第二次对话正常交付并给奖励；任务说明是同人作品与 B 站网名，不再打开任何外部网页。

`AssetPool` 与 `AssetLease` 记录纹理还有多少使用者；场景、人物、特效和界面各自释放租约。`Wardrobe` 合成装备动画，同组合共用正在生成的任务，最多缓存三套；取消或迟到的合成结果不能提交到新角色或新会话。换装最终提交前复核取消信号、背包版本、角色和穿戴条件。

## 时间、冷却与暂停

绘制由 Phaser 限制为目标 60 FPS（每秒绘制帧数）。`application/game-timing.ts` 交付相邻游戏回调的真实时间差。Arcade Physics 使用 60 Hz 固定物理步；显示位置在已结算的两个物理脚点间插值。游戏战斗采用 `LOGIC_FRAME_MS = 60`，即每逻辑帧 60 毫秒，这三种时间职责分别由对应模块维护。

`Session.advanceCombatFrames` 推进唯一的 `CombatClock`。`WorldCombat.update` 每个逻辑步推进状态、AI、召唤寿命、`CombatRuntime` 的动作／弹道／延迟工作和资源恢复。跨图保留会话帧号与余量。技能和 Buff 的整数取整、随机阈值、执行顺序都属于规则，绘制回调只负责投影。

技能冷却由 `Session.cooldowns: CombatCooldownStore` 持有，以角色 ID 与技能 ID 为键。控制器经 `ActorCooldownPort` 查询和写入同一份状态。起手时先验证目标、装备、突进落点和魔力，再扣魔力、调用 `start`：有效帧数为 `trunc(baseFrames * ratePerThousand / 1000)`，到 `currentFrame >= readyFrame` 可用。HUD 读取剩余帧数换算的 `remainingMs` 和 `durationMs`。控制器销毁、切图或换操控者保留冷却；初始化、复活与成员删除有各自明确的重置入口。

恢复药水使用 `Session.recovery` 的独立整队时钟。即时恢复要求严格超过截止帧才能再次使用；扇形可以已经归零而本帧仍不可用。再生药水加入持续恢复脉冲，不走即时恢复药水的共用冷却。具体实现与边界见 `domain/recovery-items.ts`。

| 发生的操作 | 当前行为 |
|---|---|
| 菜单、竖屏、后台或临时暂停 | 冻结动作、在途任务、状态、冷却、召唤寿命与物理移动；退出后继续 |
| 手动移动打断 | 普攻被方向输入取消并清目标；主动技能从起手接近到收招期间忽略方向输入，不取消动作、不清目标、不驱动移动 |
| 主动技能期间的动作输入 | 技能按钮再次按下在输入层忽略；同时按住多个动作按钮只接受第一个，释放后解除 |
| 换装、技能初始化、撤下队员 | 清理对应角色尚未完成的动作及在途工作，保留已付起手成本 |
| 剧情接管 | 停止整队动作和已有路径，确认已发生的死亡结算；正式世界暂停，电影舞台独立推进 |
| 保存 | 先结算已确认的死亡，捕获状态；活体动作在当前游戏中仍保持冻结后的进度 |
| 读档／检查点恢复 | 保留资源、状态和冷却，恢复为静止角色，清除动作、路径和动作临时属性 |
| 关闭地图 | 取消地图运行器及资源工作，释放监听与纹理；会话继续保存跨图状态 |

`CombatRuntime.setPaused` 按持有者叠加；全部持有者释放后才推进。具体入口及无引擎装配见 `tests/combat-kernel.test.ts`。

## 战斗修改边界

`CombatController` 管理选敌、接近、起手和动作状态。手动主动技能通过 `requestManualSkill` 可以接管普攻；冷却、资源或使用条件不满足时继续旧普攻，满足条件却缺必需目标时结束普攻。主动技能之间不排队。主动技能动作期间（approaching/attacking）场景通过 `WorldCombat.castingSkill` 忽略摇杆与新的技能输入；动作按钮共用按压门控，一个动作按钮按住期间其它动作按钮的按下被忽略。`CombatRuntime` 管理动作帧、弹道抵达与延迟任务；`CombatActionDispatcher` 根据时间轴输出特效、命中与召唤请求。

`combat-unit-execution.ts` 是普通技能和私有追击共同的目标选择、准备、效果及反馈入口。`CombatEffectExecutor` 处理具名效果；`combat-hit-resolution.ts` 协调命中及同帧死亡；`combat-reaction-pipeline.ts` 保留反应顺序；`combat-follow-ups.ts` 负责神之定义、地狱之落雷等私有追击的概率和延迟。`WorldCombat` 连接会话、AI、物理、场景资源和画面能力。

`CombatUnit` 按 `effect` 区分类型，每类只带自己的字段。五维权重按力量、敏捷、体力、智力、精力具名，先合计贡献再除十截断。`CombatOperation` 分别携带加减值、乘数、除数或千分比。每级 `ranks` 从已学等级减一索引。概率按整数区间与严格小于判断，状态时长以毫秒表示并在内容中取整；具体字段见 `domain/battle.ts` 与共同校验器。

`battle.json.basicAttacks` 保存共用普攻规则，职业及敌人引用 `profileId` 并绑定四向动画。`cycleFrames`、`strikeFrame`、`swingFrame` 以逻辑帧表示；周期不足以包含出手帧时延长到 `strikeFrame + 1`。图集保存源帧，运行时按有效周期重复末帧或截取。修改规则和已有动画绑定只需改内容，新图片才需要补充素材与内容引用。

每项技能同时提供主角分支及 `companion` 分支。`skillForMember` 按固定成员身份选择数值：`player` 使用主角成长，其他队员使用佣兵成长，切换操控不改变分支。地狱之兵的受命动作按主人身份选择。免费初始技能、学习、技能书和初始化由 `StorySkillProgression` 管理；快捷栏由 `Bag` 按角色保存两组六格，技能和物品可放进同一排；同一技能只能占一格，登记到新槽会清掉旧槽，再点已登记该技能的槽位会取消该快捷键。

攻击接近距离 `approachDistanceUnits` 按实体边缘的横纵距离各除八取整并加两个近身单位。`searchRadiusPx` 和 `targetRangePx` 使用世界像素。`targetRangeMetric: octagonal-grid` 使用八方向整数近似距离再按八像素取整；省略时采用圆形距离。特效的 `attached` 跟随人物锚点，`ground` 在人物下方，`above-characters` 在人物上方；具体层级由内容与 `CombatEffects` 管理。

正常敌人由地图候选点和任务／遭遇配置生成，资源、掉落、刷新截止时间由会话保存。零血后立即退出选敌与碰撞，660ms 消散结束后结算一次奖励；普通敌人经过 60 秒可操作时间刷新。剧情永久击败使用可写入JSON的 `permanent` 标记，限时刷新使用有限的游戏毫秒截止值。地面物品在落地前不参与拾取，落地后在操控者横纵各 12 像素内自动拾取。任务地面物品由地图的 `questItemSpawns` 定义，`Session.questItemGenerators` 使用共享逻辑帧处理生成与拾取后的刷新；只有对应任务 active 才生成，未拾取实例持续绑定生成点。绑定、剩余帧数与共享检查截止帧随会话存档。队伍人数变化调整敌人上限并保留生命比例。怪物和队员的动作、仇恨、寻路规则分别在 `enemy-ai.ts`、`party-ai.ts` 和 `combat-threat*.ts`。

## 移动、电影舞台与永久世界

所有移动使用 `NavigationWorld` 的通行查询和 `MovementWorld` 的物理执行。坐标统一为人物脚底世界像素。地形探测半径为 4 像素，实体使用各自镜像后的碰撞范围；隐藏或禁用实体释放占位。八像素八方向 A* 检查整段通行并防止斜穿墙角。普通行走仍按窄足底判定；出生、召唤和技能强制位移按整个碰撞盒判定，避免身体压进墙里。批量交换位置先检查整组最终状态，再提交。

物理步完成后才判断交互与出口。出口使用实际脚点并记录出生防回跳状态，先离开出口再进入才能触发。显示插值只临时应用在绘制阶段，规则继续读取真实物理位置。走位受阻时重算路径；规则位置、演员动画和镜头分别由物理、AnimationManager 和 Camera 管理。

`campaign.json` 的节点先播放 `presentation`，成功收尾后再同步提交 `commands` 与下一游标。任务、目标、事件、脚本和节点使用稳定 ID。`QuestBook` 按目标计数和周期结算，`StoryRuntime` 串行调度事件并保存调用栈，`StoryWorldState` 保存永久角色、门、标记、选择和落点。当前内容有505个任务、593条触发事件和693个流程图。入口图按触发条件确定；没有地图条件时，开场舞台继承当前地图。人物或同种敌人在其他事件中的登记地图用于预览与来源说明，实际切图由剧情中的 `travel` 命令驱动。任务链脚本由交付与接取解锁。

电影 `story-stage` 拥有自己的地图、移动世界、换装与资源租约；舞台跨图不改变正式地图访问。演员 `id` 属于本次演出；`worldEntityId` 绑定正式世界实例，稳定人物身份决定绑定关系，显式落点也保留绑定。演员移动按访问或持久登记语义提交；已经迁移到别图的正式实例保留新登记。正式跨图使用 `travel` 命令。`waitEncounter` 创建真实战斗，全部敌人的死亡结算完成后才走胜利分支。跳过与正常播放共用动作结束状态和通行校验；取消或表现失败从稳定节点恢复。

宝箱、泉水与随机货架按正式地图访问管理：同图重建保留，跨图按各自规则刷新。宝箱按钮先按脚点曼哈顿距离 24px 找附近对象，执行时检查正面朝向；点击箱子使用脚底矩形间距的独立规则，见 `domain/chests.ts`。电影舞台的地图切换不触发这些刷新。

进图的素材边界由 `application/entry-plan.ts` 统一计算：只覆盖当前地图的视觉与战斗素材，以及本图可触发脚本（含读档时运行中的脚本）沿 `call`/分支控制流会用到的舞台 cast、剧情特效、立绘、音效与 HUD 共享素材；入口阶段不再读取后续剧情地图的 JSON，也不为它们预取贴图。`WorldScene.open()` 在第一次 `ui.loaded()` 之前完成这份计划；如果这张图一进来就要演剧情（`start` 或 `map-entry`），加载页会一直留到演出第一幕画出，开演前由 `ensureStoryAssets()` 补的素材也加载在同一张页后面，不会先露出地图再弹第二次加载。演出跨图后的世界重建只在当前图素材齐全时静默进行，缺项回退到可见加载。无法静态定位的 `quest`/`inventory`/`choice`/`event` 剧情，以及同一条剧情链后续到达的地图，由 `StoryDirector.prepare()` 在开演前调用 `ensureStoryAssets()` 按需加载（中途触发的演出可能显示「正在准备剧情…」）。加载进度按当前图、剧情画面和对象构建分段显示。

## 存档、界面与内容校验

`save-game.ts` 定义 `{format, summary, session, world}`。当前 `SAVE_FORMAT = 36`；结构或校验口径变化时增加格式号，并在 `application/saved-game.ts` 的升级链里补上从上一版读回的迁移。升级链覆盖的旧格式正常读取，比可读范围更旧的格式按空槽 EMPTY 显示；损坏的当前格式保留不可读取状态。33 → 34 会丢弃旧存档里正在播放的舞台快照（旧格式没有新版演出所需的场景与绑定），其余进度照常恢复；34 → 35 会把同一技能占多格的旧快捷栏收敛到最后一格；35 → 36 收紧演员校验，世界场景里重复的同一实例只保留第一份，正在播放的舞台如果带重复演员则丢弃舞台快照并从当前节点继续。旧档没有世界场景快照时按地图与剧情状态重新投影。存档分两类：十个手动槽使用 `inotia4.story.v1.slot0..9`，唯一的自动槽使用 `inotia4.story.v1.auto`；自动槽固定在读档界面第一行，只能读取。手动槽可以删除与改名（名字只保留中文、英文、数字，存在 `summary.name`），覆盖保存沿用旧名字；`summary.savedAt` 记录写入时刻。自动存档在进入新地图、剧情事件播完（世界投影之后）、任务接取/完成与每 5 分钟定时触发，由 `application/auto-save.ts` 合并写入，演出或菜单锁住时推迟。改名需要手机系统键盘，用 `ui/text-prompt.ts` 的 DOM 输入框覆盖画布，这是“界面由 Phaser 绘制”的唯一例外。演出快照保留角色是否尚未定位；角色切图按目标地图投影解析身份与位置，普通角色的演出移动按当前访问保存。演出生成并留在正式场景的敌人可记录访问寿命和不再刷新。捕捉源在敌人状态中保存所属地图与访问编号；转换出的交互NPC复用访问寿命。当前访问存读保留转换状态，正常离图后清理源抑制与目标NPC。摘要在保存时展开职业、地图、等级与立绘，标题页据此绘制槽位。背包快照包含全部物品格位；普通物品与任务物品均不限携带容量，显示网格随物品数量增长。GM 调试钉住的任务（`questBook.debugPins`）随演出快照往返，但 `captureSaveGame` 会剥除，不写进玩家存档。

读档在独立会话上校验并准备静止战斗状态，再等待旧场景 shutdown 后安装。准备失败保留旧会话；取消或迟到结果不能安装。`prepareCombatRestore` 在隔离副本上检查有限数值、身份、内容、状态和仇恨引用，并清掉动作路径与临时属性。内存检查点只在本次运行内存在，持久槽位跨刷新保存；安全检查点要求可以操作且没有待处理战斗工作。

正式 UI（用户界面）由 Phaser Image、Text、Container、Graphics 与 Layer 绘制；HTML/CSS 负责画布与设备安全区。`formal-ui` 承担对白与菜单，`controls-ui` 承担地图 HUD（状态和操作界面）。菜单、确认层、快捷键登记屏按当前输入层处理触摸与键盘；滚动裁剪同时限制命中区，滚动手势后的抬手不触发条目动作，重绘清理失效焦点。物品使用与交易反馈沿角色横带及当前面板呈现。HUD 的数值与成员面板由会话通知驱动，场景只做调和：逐帧入口先把可见性、目标与敌我状态归一成摘要，摘要不变就不写文本、贴图、裁剪或可见性；buff 图标的闪烁相位按逻辑帧去重，同一逻辑帧内不重复计算。

地图快捷栏按背包和 `SkillConfiguration.version` 缓存当前页与技能等级，切控、换页、配置对象变化和场景初始化也会使缓存失效。技能等级或页码的写入推进配置版本；物品数量、当前魔力消耗、使用条件和冷却继续实时读取。配置版本只用于运行时刷新，不写入存档。

`ContentLoader` 使用 `content-validation.ts` 校验已加载的目录。`tools/validate-content.mjs` 额外检查完整目录、图片、音频及跨文件关系；同一入口也接在 Vite 开发服务（4003）的启动和内容变化上。剧情引用与每条分支的演员、音频、路线、并行冲突由专用校验器检查。`tools/build.mjs` 先校验 `public/`，构建到临时目录，对构建前后的 `public/assets` 与 `public/content` 做内容哈希并比对，再把 `.build-meta.json` 写进产物、校验构建结果并替换 `dist/`。输出使用相对 base 与 `bundles/`，部署在站点根路径；公共资源 URL 在加载边界追加内容版本，供静态服务长缓存。

内容运行时：`tools/content-build.ts` 在构建期把 `public/content` 转成运行时内容目录——全部 JSON minify；`battle.json` 的 90 个技能把 `details` 编译成 `display` 模板 + 每级 `displayValues`，全部 235 个技能/敌人动作预计算 `requiresTarget/effectNames/soundNames/summonNames/eventFrames`；`shops.equipment` 拆到 `shops-equipment.json`，并省略与 `character-stats.gradeVariants` 重复的 `variants`；`wardrobe.poses` 按动作 ID 拆成 `content/wardrobe/poses/*.json`，运行时 `Wardrobe.prepare()` 只取当前武器/职业实际用到的十几条，`pose-index.json` 供 dev/GM 完整校验。`tools/build.mjs` 用它替换 `dist/content` 并计算 `contentVersion`。生产构建注入 `__STORY_TRUST_CONTENT__`，`ContentLoader` 只做 `JSON.parse`；开发服务、Node 测试、`?gm` 与 `?validate` 仍执行完整 `parseX` 和跨文件校验。构建期 `validateContent` 是唯一权威校验入口，运行时不再重复。

菜单图片同样分两批：`gameMenuImageGroups()` 把菜单框架、职业预览和立绘放在 `core`，325 个物品图标与 90 个技能图标放进 `extra`。开局前只等 `core`，`extra` 在世界加载期间后台补；补完后 `StoryUI.refreshMenuAssets()` 重画已打开的菜单。UI 调试与素材校验仍用完整的 `gameMenuImages()`。

地图 prop 走独立图集：`npm run atlas:props` 把 `world.props` 按 SHA-256 去重后打包为 `public/assets/props/atlas/props-0.png/json`，生成 `src/generated/prop-atlas.ts` 的 prop key → 页/frame 映射；`public/content/world.json` 和地图 JSON 完全不变。`mapSurfaceAssets()` 对每张有 feature 的地图只加入一次图集页，`drawMapLayers()` 用 `texture+frame` 绘制，`composeColorDodge()` 从 frame 的裁剪矩形取像素。原始 prop PNG 保留，`validate:content` 校验所有 763 个 prop、17,535 个 feature、帧尺寸/边界/摘要和图集新鲜度。

首次进入世界时，常驻战斗包只包含当前主角职业、全部伙伴外观和共享特效：`residentCombatAssets({..., classIds:[session.character.classId]})`。上阵伙伴的职业特效由每图 `planMapCombat` 和战斗内 `syncAllies` 加载；新游戏/读档/回菜单会释放旧租约并重置 `residentCombatReady`，`residentCombatClassId` 防止换职业后误用旧包。

## 构建、缓存与部署

- 4002 由 `npm run serve` 运行 `tools/serve-built.ts`，直接提供 `dist/`；4003 是 Vite 开发服务（`npm run dev`）。
- 静态服务在静态文件之前挂载 `tools/diagnostic-collector.mjs`，`POST /__diagnostics/report` 与开发服务共用同一套日志：`.diagnostics/client-errors.jsonl`。
- `tools/build-version.ts` 对 `public/assets`、`public/content` 做内容哈希；构建时通过 `vite.config.ts` 的 `define` 注入 `__STORY_ASSET_VERSION__` / `__STORY_CONTENT_VERSION__`。加载边界只在 `content-loader.ts`、`audio-scene.ts`、`scene-assets.ts`、`game-audio.ts` 拼 `?v=`，不改内容字段、纹理键或音频键。
- 缓存策略：`/bundles/*` 与版本匹配的 `/assets/*`、`/content/*` 返回 `immutable`；`index.html`、`diagnostics.js`、`manifest.webmanifest` 与旧版本/无版本资源返回 `no-cache` + ETag。静态服务支持 gzip、单段 Range、304、HEAD，构建替换 dist 的极短窗口返回 503。
- `npm run deploy` = 类型检查 + `npm run build` + 读取 `dist/.build-meta.json` + 请求 `/__build` 比对版本并抽查首页/入口 bundle/版本化资源。服务直接读磁盘，构建完成即生效，不需要重启；只有 `serve-built.ts` 自身改动才需要重启静态服务。

内容或规则改动时，同时更新类型、共同校验器、消费入口和测试。

## 调试与验证边界

`?animation-debug` 直接进入独立动画场景，不创建剧情会话；它复用人物、换装、摇杆和移动世界。`?ui-debug` 进入界面检查场景。`render_game_to_text()` 提供当前场景的文本状态，用于诊断；入口与输出以 `main.ts` 和对应调试场景为准。

单元测试验证规则及轻量表现替身，内容校验验证文件和契约。二者都不能证明真机画面、动作观感、实际音频和长时间资源占用。按根 `AGENTS.md` 选择相关用例；界面与真机验收使用 [4002 游戏入口](http://localhost:4002/) 或 `npm run serve`，用户明确要求后才运行浏览器自动化。

## 友方召唤物

地狱之兵和驯兽召唤使用独立的自主决策，按固定主人跟随、护主和协同已发生的战斗；分步寻路及安全脱战召回见 [友方召唤物说明](friendly-summons.md)。世界快照按普通敌人与友方召唤区分行为类型，当前存档格式为36。

## Boss 全图参战

当前两种地图战斗 Boss 使用显式的 `engagement: map-wide` 配置，加载和演出结束后发现整张地图中的队伍，继续使用原仇恨、技能和碰撞。普通怪物保持原有规则。内容与验证入口见 [Boss 进图主动开战](boss-engagement.md)。

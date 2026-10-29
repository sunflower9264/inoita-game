# 模块原理入门

这份文档回答三个问题：

1. 游戏从一条剧情内容跑到画面上，中间经过哪些模块？
2. 每个模块真正负责什么，哪些状态由它持有？
3. 改一个功能时应该先看哪里，哪些边界不能打破？

详细的字段和修改入口见 [架构与修改入口](architecture.md)；这里尽量用日常语言说明原理。

## 先看一条剧情怎么跑

可以把整个游戏想成一个剧组：

- `Session` 是总账本，记录任务、队伍、背包、剧情世界等“游戏事实”；
- `StoryDirector` 是导演，决定什么时候播哪段剧情；
- `StoryRuntime` 是场记，记录剧情演到哪个节点、还在等什么；
- `StoryPresenter` 是舞台监督，把导演的要求交给演出舞台；
- `StoryStageScene` 是临时摄影棚，只负责把这一幕演出来；
- `WorldScene` 是正式片场，玩家真正走地图、打怪、交互的地方；
- `ScenePlan` 是演员表，说明这一幕应该有哪些演员、谁绑谁；
- `SaveGame` 是存档封包，把账本和片场状态装进文件。

一条剧情大致这样走：

```text
campaign.json / 地图内容
        │
        ▼
内容加载与校验（ContentLoader + content-validation）
        │
        ▼
Session 持有任务、队伍、背包、世界状态
        │
        ▼
触发事件（开场、进图、靠近、区域、击败、交互）
        │
        ▼
StoryDirector 请求播放
        │
        ▼
StoryRuntime 找到脚本和节点
        │
        ▼
StoryPresenter → StoryStageScene 播对白、走位、战斗
        │
        ▼
剧情节点提交 commands
        │
        ▼
Session.applyStoryCommands 修改任务/世界/队伍
        │
        ▼
StoryDirector.project → WorldScene 把结果投影回正式地图
        │
        ▼
检查点 / 自动存档 / 玩家继续游戏
```

关键点：**演出期间舞台是临时工作区；只有节点提交时才修改正式世界。**  
这也是为什么调试剧情时，不能靠“画面上看起来对”来判断任务状态，必须看 `Session` 里的真实状态。

## 启动与装配

主要文件：`src/main.ts`、`src/app.ts`、`src/application/ports.ts`、`src/application/content-loader.ts`

`StoryApp` 是运行上下文，不是一个“万能管理器”。它保存已经装配好的内容目录、会话、导演、场景和界面，让场景通过 `application/ports.ts` 里的能力接口访问依赖，而不是互相直接 import。

启动分几个阶段：

1. 建界面和基础存储；
2. 加载并校验内容；
3. Phaser 就绪后接线场景和菜单；
4. 选职业、创建 `Session`；
5. 创建 `StoryDirector`；
6. 开始自动存档。

`StoryApp` 的成员不是同时有值的。比如 `session`、`director` 在进入游戏后才有；`audio` 由音频场景写入；`useRecoveryItem` 在战斗时才有、战斗结束会清空。排查“这个能力为什么是空的”时，先看它属于哪个装配阶段。

## 内容与校验

主要文件：`src/domain/campaign.ts`、`src/domain/content.ts`、`src/application/content-validation.ts`、`src/application/content-relations.ts`、`src/application/story-reference-validation.ts`

`public/content/*.json` 是游戏内容的源文件。内容包括：

- 世界地图和人物外观；
- 剧情脚本、事件、任务；
- 战斗、技能、物品、商店；
- 调试任务目录。

加载后先做结构化校验，再做跨文件引用校验：任务目标是否存在、舞台演员是否能找到、地图出口是否指向有效地图、素材文件是否存在等。校验实际上分三层，越往后越接近“这段剧情真的能演”：

1. `content-validation.ts`：每个文件自己的字段和取值是否合法；
2. `content-relations.ts`、`story-reference-validation.ts`：文件之间引用的地图、人物、敌人、出口、实体、任务目标能不能对上；
3. `story-performance-validation.ts`：演出本身是否可执行，包括走位终点能不能走到、并行动作结束后演员状态是否一致、分支合流后演员是否接得上。

分层的意思是：单个文件合法只是第一关。一段对白引用了不存在的立绘、一个走位终点落在墙里，语法上都"合法"，但运行时就会黑屏或卡住，所以要在构建阶段拦下来。

内容校验不是“启动时的装饰”。它把许多运行时会变成“找不到人/黑屏/卡死”的问题提前到构建或启动阶段。

`public/content/debug/start.json` 是独立的调试任务目录。它记录每条任务“开演前世界是什么样”，由 `tools/debug-start` 生成；改过内容后要重新生成，否则现场表会过期。

## Session：游戏事实的总账本

主要文件：`src/domain/session.ts`

`Session` 持有：

- 主角和队伍；
- 背包、装备、技能配置；
- 任务簿和任务进度；
- 剧情世界（永久角色、门、标记、选择、落点）；
- 战斗资源、冷却、金币、地面掉落、宝箱、泉水、商店访问记录。

可以把它理解成“游戏规则层的事实”。Phaser 场景不拥有这些事实，只负责把它们画出来。

需要区分两套位置：

- **规则位置**：`Session`/剧情世界记录的人物脚点；
- **实时位置**：`MovementWorld` 的物理体在场景里实际站的位置。

平时移动由物理体推进；捕获世界快照时，才把实时位置写回快照。不要把画面上的坐标当成任务逻辑的权威来源。

`Session.applyStoryCommands()` 是剧情修改世界的唯一正式入口。它先预演一批命令，确认能完成，再一次性提交；失败时保留原状态和原游标。这样不会出现“任务做了一半、世界改了一半”的状态。

## QuestBook：任务状态机

主要文件：`src/domain/quest-book.ts`

`QuestBook` 管理任务状态：

```text
locked → available → active → ready → completed
```

- `locked`：还没解锁；
- `available`：可以接；
- `active`：进行中；
- `ready`：目标完成，等待交付；
- `completed`：已结算。

它还记录任务的运行池、目标计数、完成周期和奖励收据。任务接取/完成会触发会话通知，自动存档和 GM 摘要都靠这份状态。

任务完成不等于“演出播完”。任务可能需要移动、触发、战斗、交付；必须以 `QuestBook` 的状态为准。

体验版的金币获取有一套统一的放大规则：敌人和宝箱掉落、任务金币奖励都按 10 倍发放，`src/domain/economy.ts` 是这份倍率的唯一来源。剧情 `money-give`、商店出售和 GM 加金币不走这条倍率。

## StoryWorld：永久世界

主要文件：`src/domain/story-world.ts`

`StoryWorld` 保存剧情对正式世界做出的永久改变：

- 放置、隐藏、移除的人物和物件；
- 门和出口的开关；
- 剧情标记、选择；
- 剧情遭遇；
- 队伍 Buff、外观覆盖；
- 当前落点和地图访问次数。

`StoryStageSnapshot` 是演出中的临时场景，不会直接写进 `StoryWorld`。演出结束后，由 `storyCommitCommands()` 把显式命令和演员差量编译成 `StoryCommand`，再交给 `Session.applyStoryCommands()`。

## StoryRuntime：剧情调度器

主要文件：`src/domain/story-runtime.ts`

`StoryRuntime` 负责“剧情演到哪了”：

- 当前运行实例、脚本、节点和游标；
- 调用栈；
- 等待中的战斗遭遇；
- 待处理事件、已完成事件、触发序号；
- 检查点快照。

它不关心画面，只负责脚本调度。`StoryDirector` 把事件交给它，它按节点顺序推进，遇到 `waitEncounter` 时暂停，等战斗结果回来再继续。

`StoryRuntimeSnapshot` 是剧情检查点。当前运行中的快照和写档检查点有版本区别：

- 版本 2：运行中的完整快照；
- 版本 3：存档里的精简检查点，剥离可重建的演员外观。

## StoryDirector：导演

主要文件：`src/domain/story-director.ts`

`StoryDirector` 把几件事串起来：

1. 判断事件是否应该触发；
2. 请求 `StoryRuntime` 播放；
3. 调用 `StoryPresenter` 播演出；
4. 演出成功后提交节点命令；
5. 提交成功后投影回正式世界；
6. 收尾、取消、重试、检查点。

它不自己保存“剧情是否完成”，而是读 `Session`/`StoryRuntime`。这样任务、舞台和存档看到的是同一份事实。

## StoryPresenter 与 StoryStageScene：临时摄影棚

主要文件：`src/rendering/story-presenter.ts`、`src/scenes/story-stage-scene.ts`

演出期间，正式世界会暂停，`story-stage` 场景启动。它拥有自己的地图、人物、移动世界、换装和资源租约。

`StoryPresenter` 负责：

- 创建/恢复舞台；
- 执行对白、走位、镜头、特效、显隐；
- 把最终舞台状态传回导演；
- 舞台释放后恢复正式世界。

`StoryStageScene` 只负责画。它不应该直接修改 `Session` 的任务或世界；演出结束时的提交由导演完成。

舞台只画主角和本幕 `cast` 点名的演员。正式世界里的召唤物一律不进入演出画面；佣兵和剧情伙伴都要被这一幕点名才出现，没点名的都留在正式世界。判断依据是舞台绑定，不是伙伴的招募来源。

WebGL 上下文丢失后，Phaser 会自己重建普通图片、着色器和缓冲区，但不会重画衣柜用 `DynamicTexture` 合成的人物外观，也不会重做滚动区的静态遮罩。项目在 `restorewebgl` 事件里按原纹理键重画这些内容；角色和动画继续引用同一份外观，不需要重建场景。详情见 `docs/debugging.md` 的“画面恢复”。

## ActorRef、ScenePlan 与演员身份

主要文件：`src/domain/actor-ref.ts`、`src/domain/actor-census.ts`、`src/domain/scene-plan.ts`、`src/domain/scene-snapshot.ts`、`src/domain/story-scene.ts`

同一场戏里，演员可能有多种身份写法：

- 地图实体：`worldEntityId`；
- 队伍成员：`memberId`；
- 战斗敌人：`enemyKey`；
- 剧情临时演员：舞台别名/实例 ID。

`characterId` 是“人物编号”，不是实例编号。同一张图可能有两个同编号士兵，所以不能拿人物编号直接当唯一键。

`ActorRef` 是带作用域的实例引用：

```text
world  + map + entityId
party  + memberId
combat + map + encounterId + enemyKey
story  + runId + instanceId
```

`ScenePlan` 是从当前场景快照派生出的只读演员表，负责：

- 每个演员的 `ActorRef`；
- 舞台别名绑定；
- 可见性和重复实例检查；
- 渲染时应该画哪些人。

它不是第五份可写状态。位置、姿态、显隐仍由现有场景动作 reducer 维护；`ScenePlan` 只是把“谁应该出现”算清楚。

地图实体和舞台演员还有 `authority`（来源）：

- `registered`：剧情位置登记，代表角色在本图的正式副本；
- `npc`：任务 NPC；
- `story`：演出临时实例；
- `static`：地图自带对象。

旧内容没写这个字段时只在读取边界按 ID 解码一次；运行期按来源决定谁接管、谁隐藏。

## WorldScene 与 WorldCombat：正式片场

主要文件：`src/scenes/world-scene.ts`、`src/scenes/world-combat.ts`

`WorldScene` 负责正式地图：

- 地图图层、人物、碰撞、出口、交互；
- 把 `Session`/`StoryWorld` 的状态投影成画面；
- 剧情结束时重建或恢复正式世界。

进图时落点会先保证站得下，再自动避开出口至少 24 像素。到达出口在玩家真正走出这段缓冲区之前不会再次触发；切图后方向输入也要先回中一次。这三条一起防止“刚进图走一步又回到上一张图”。

`WorldCombat` 负责战斗：

- 战斗角色、敌人、召唤物；
- 技能动作、命中、死亡、掉落；
- 队伍 AI 和敌人 AI 的场景接入；
- 战斗快照与恢复。

`WorldScene.projectStoryWorld()` 是剧情结果回到正式世界的唯一投影入口。演出舞台自己的临时演员不应该残留到正式地图。

进图前还有一步“带妆彩排”，主要在 `src/domain/scene-visit.ts`。宝箱开什么、泉水回多少、刷哪些敌人、队伍从哪落脚，这些带随机性的结果会先在一个隔离会话里算出来，形成 `SceneSnapshot`；正式进图时直接接收同一份结果，而不是到了地图上再摇一次。这样读档、重进同一张图看到的是同一个世界。

战斗里 `CombatController` 管动作阶段（选敌、接近、攻击），`CombatRuntime` 管动作帧、弹道和延迟工作。场景只负责把它们的决定画出来。

## 队伍 AI

主要文件：`src/domain/party-ai.ts`、`src/domain/friendly-summon-ai.ts`、`src/domain/combat-threat*.ts`

佣兵和召唤物不是“玩家第二只手”，而是有自己决策的 AI：

- 玩家指派目标时优先攻击该目标；
- 被攻击时按反击档位决定是否还手；
- 没有目标时跟随当前操控者；
- 召唤物按主人位置、攻击距离和召唤类型行动。

跟随和追击都有“无进展”保护：长时间位移不足会取消旧路线，必要时把掉队单位收拢到操控者旁边。这样不会被剧情障碍或人群永久卡住。

## 存档、检查点与自动存档

主要文件：`src/domain/save-game.ts`、`src/application/saved-game.ts`、`src/domain/session-checkpoint.ts`、`src/application/auto-save.ts`

一份存档包含：

- `format`：存档格式版本；
- `summary`：标题页显示的摘要；
- `session`：会话状态；
- `world`：正式世界视图。

当前 `SAVE_FORMAT = 37`。旧格式通过 `SAVE_UPGRADES` 升级链读取；比可读范围更旧的存档显示为空槽。

存档槽一共十一个：十个手动槽加一个自动槽。自动槽固定在标题页顶部，不能改名、不能删除。存档里的摘要在保存时就展开好职业名、地图名和立绘，所以标题页只读摘要就能显示槽位，不用先把整个世界和职业目录加载进来。

读档的顺序是“先准备，后替换”：先升级、迁移、校验，构造出一个候选会话；全部通过并且旧场景清理完成后，才把候选装进游戏。中途取消不会留下半个新会话。

检查点和存档不是一回事：

- **检查点**：内存里的最近安全状态，死亡/重试时恢复；
- **存档**：写到 localStorage 的持久数据；
- **自动存档**：按进图、剧情完成、任务变化、定时等时机合并写入。

自动存档会“合并快递”：进图、剧情事件完成、任务接取/完成、定时检查这几个触发在短窗口内合并成一次写入，默认等 1.2 秒，两次写入至少隔 2 秒。演出或菜单锁定、世界还没准备好时先不写；页面切到后台前跳过去抖，同步写一次。

## 调试与 GM

主要文件：`src/debug/gm-actions.ts`、`src/debug/story-jump.ts`、`src/domain/story-debug.ts`、`src/ui/phaser/gm-panel.ts`、`src/main.ts`

任务调试的入口是 `debugStory.tasks`：

- 每条任务有 `entry`（默认落点）、`start`（开演前世界）和 `play`（要播的剧情）；
- `prepareTaskStart()` 在隔离沙箱里把现场表展开成完整会话；
- `jumpStory()` 安装现场、切图、播放开幕演出；
- 进入调试后自动存档暂停，检查点跳过。

单任务调试现在的收尾规则：

- 开幕演出播完不结束，玩家继续移动/触发/战斗；
- 当前任务真正完成后，恢复进入调试前的会话和世界；
- 恢复自动存档、抓一次检查点、回到调试剧情页；
- 不自动接下一任务，不额外弹完成提示。

GM 面板是动作层的 UI 外壳。`gm-actions.ts` 不能 import Phaser/UI；面板、无浏览器测试和 `globalThis.gm` 共用同一份动作实现。

## 无头剧情：不画一帧的排练

主要文件：`src/debug/headless-story.ts`、`tests/helpers/story-playthrough.ts`、`tools/debug-start/`

测试里经常需要“把一段剧情从头跑到尾”，但不想启动 Phaser。无头剧情用真实的 `Session`、真实的 `StoryDirector`、真实的 `StoryRuntime` 和真实的场景归约来跑，只是不画画面。它和正式游戏共用同一套提交与投影规则，所以测试通过基本能代表游戏里也通过。

一个硬规则是：遇到需要玩家选择的地方，必须由测试显式给出选哪一项，不允许默认选第一个。否则剧情增删一个选项，测试就可能悄悄走到另一条分支。

GM 任务现场表也是用这条通道生成的：从新游戏开始，用真实运行时回放到某条任务开演前，把那一刻的会话和世界记下来，就是 `public/content/debug/start.json`。

## 测试与发布

主要文件：`tests/`、`tools/test.ts`、`tools/validate-content.mjs`、`tools/audit-story-actors.ts`、`tools/debug-start/`

测试分几类：

- 领域单元测试：任务、剧情、战斗、存档、AI；
- 场景/界面交互测试：菜单、GM 面板、Phaser 替身；
- 内容审计：全部舞台、支线开幕、支线全流程；
- 主线完整回放：从新游戏到结局；
- 存档升级/往返；
- 构建与独立安装验收。

常用命令：

```bash
npm test -- tests/combat.test.ts
npm run typecheck
npm run validate:content
npm run audit:story
npm run audit:story:full
npm run test:standalone
npm run build
npm run deploy
```

发布前建议用 `npm run release:story`：内容校验、GM 现场表、剧情审计、存档升级、主线回放和构建一条链跑完。

## 修改时先看哪里

| 想改什么 | 先看 |
|---|---|
| 启动、读档、职业 | `main.ts`、`app.ts`、`saved-game.ts` |
| 任务规则 | `quest-book.ts`、`session.ts`、`campaign.json` |
| 剧情脚本/节点 | `story-runtime.ts`、`story-director.ts`、`campaign.json` |
| 舞台演员 | `actor-ref.ts`、`scene-plan.ts`、`story-scene.ts`、`story-stage-scene.ts` |
| 正式地图 | `world-scene.ts`、`scene-visit.ts`、`map-placement.ts` |
| 战斗/技能 | `combat.ts`、`combat-runtime.ts`、`world-combat.ts`、`battle.json` |
| 佣兵/召唤 AI | `party-ai.ts`、`friendly-summon-ai.ts` |
| 存档/检查点 | `save-game.ts`、`saved-game.ts`、`session-checkpoint.ts`、`auto-save.ts` |
| GM/任务调试 | `gm-actions.ts`、`story-jump.ts`、`gm-panel.ts` |
| 内容校验 | `content-validation.ts`、`content-relations.ts`、`story-reference-validation.ts`、`story-performance-validation.ts` |
| 无头剧情/剧情审计 | `debug/headless-story.ts`、`tests/helpers/story-playthrough.ts`、`tools/audit-story-actors.ts` |
| 进图彩排与场景快照 | `scene-visit.ts`、`scene-snapshot.ts`、`world-scene.ts` |

## 最重要的几条边界

1. **舞台不直接写正式世界。** 演出结果先回到导演，节点提交后才改 `Session`。
2. **人物编号不是实例编号。** 需要唯一实例时用 `ActorRef`/`worldEntityId`/`memberId`/`enemyKey`。
3. **任务完成看 `QuestBook`，不看演出是否播完。**
4. **实时位置和规则位置分开。** 画面坐标不能替代会话状态。
5. **调试现场不写玩家存档。** 进入前快照、恢复、检查点顺序都不能乱。
6. **内容改动要跑校验和对应回放。** 能静态发现的问题不要留到运行时。

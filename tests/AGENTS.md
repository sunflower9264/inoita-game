# tests

单元测试与独立构建验收。平铺的 `*.test.ts` 覆盖剧情、战斗、任务、地图、存档和界面规则；`standalone.mjs` 负责独立安装与构建验收，`content-build-smoke.mjs` 用真实内容做编译后的行为烟雾测试。

## 文件

- `tests/*.test.ts` 全部平铺在根目录，按模块前缀命名：`story-*` 最多，其次 `combat-*`、`quest-*`、`world-*`、`skill-*`；常见前缀还有 `enemy-*`、`party-*`、`session-*`、`equipment-*`、`action-*`。找用例先按前缀匹配，例如 `tests/combat-*.test.ts`、`tests/story-*.test.ts`。
- `standalone.mjs`：独立安装、类型检查和构建验收，对应 `npm run test:standalone`；`content-build-smoke.mjs` 对应 `npm run test:content-build`，复用一次临时构建验证最小战斗和剧情节点，六职业与图集细节见 `tools/AGENTS.md`。
- `helpers/`、`support/`：测试驱动与替身，不是测试入口。`fixtures/` 存放 `map-prop-baseline.json` 和 `story-actor-ledger.json` 两份测试基线，变化时必须显式更新并说明原因。

## 规则

- 测试入口平铺在 `tests/*.test.ts`；`tools/test.ts` 只接受该目录下的 `.test.ts` 文件，传目录或其他扩展名会被拒绝，不带参数时打印用法并退出。
- 共享接口或绘制方法变了，同步更新测试里的假对象（如 `tests/shop-panel.test.ts` 的 `Surface`），让它实现被测代码实际调用的方法。
- 单文件用 `npm test -- tests/<file>.test.ts`，它先跑类型检查再用 `node:test` 执行；全量 `npm run test:all` 只在用户明确要求时运行，独立构建验收用 `npm run test:standalone`。
- Node 直接执行 `.ts`，只写可擦除语法：不用 `enum`、`namespace` 和构造函数参数属性。
- 用例验证可观察的行为和分支规则；实现重构不应迫使断言改写。
- 验证不自行启动浏览器或 headless Chrome；每个独立修复在相关检查通过后单独提交，说明写清行为和验证结果。

## 测试覆盖

### 剧情与任务

- `story-intake.test.ts` 用「最后的封印」石魔战验证遭遇出现在玩家当前地图、等待战斗的剧情恢复后继续；`story-gated-interaction.test.ts` 覆盖七组剧情确认入口的取消后重试、普通交付保护和剧情结算，并用真实结界石验证石魔生成、击败后的主线推进与正常存档恢复。
- `story-native-triggers.test.ts` 检查《最后的记忆2》前三次交付各播一段对白、各发一次奖励并开放下一轮；`story-trigger-occupancy.test.ts` 逐帧验证原地只播一次、走开再靠近可重播、过滤解除后补播；`story-trigger-index.test.ts` 验证五类封印祭坛只在各自洞穴和剧情阶段触发，不会在候选地图上抢占一次性事件。
- `story-stage-isolation.test.ts` 验证加载途中跳过、迟到画面清理、共享启动与真实坐标保留；`story-skip.test.ts` 验证流程阶段与解锁顺序。「最后的记忆1」四处铁门入口覆盖正常走位、开场跳过和途中跳过，核对落点、镜头与弹窗前补画。
- `story-progression.test.ts` 验证「前往钢之兽人部落」与「被绑架的兽人长老」整段跳过和接取窗口读档续播，核对任务交付、沃尔达克入队及收尾地图。
- `story-preparation.test.ts` 覆盖确定路径与调用返回、预测边界；`story-asset-preparation.test.ts` 覆盖跨场景请求复用、目标替换、取消和失败重试；入口测试验证恢复游戏不等待后续剧情素材。
- `story-equipment.test.ts` 覆盖剧情装备发放与拾取拦截、手动穿脱与连带替换保护、剧情移除与离队销毁、正常装备退回；`story-disguise.test.ts` 验证剧情伪装穿脱；`story-scene`、`story-stage-isolation` 与 `saved-game` 覆盖主角收放武器、同图保留、换图恢复默认和存档读回；「消失的圣女1」在外观未准备好时分别跳过和取消整段剧情，核对姿态与迟到外观。
- 剧情动作测试检查等待结束时仍在播放、自然完成后的保持或待机、跳过后的最终姿势；`story-playthrough-rewards.test.ts` 验证剧情奖励。
- 剧情跳转回归遍历全部菜单任务并颠倒显示顺序，用正式进图、行走、战斗、交付和存读档验证蜘蛛巢穴前跳回跳，以及接取演出里赢得首领战后的跳转；`quest-jump-history.test.ts` 验证 quest-21/23/84/168/83 的因果历史、`place` 重放和无关区域事件隔离；`gm-quest-jump.test.ts` 用「圣女救援行动」逐个验证跳转现场，序幕与哈肯沙漠折返验证旧演出结束与主动回跳。
- `quest-actor-visibility.test.ts` 覆盖交付人在同一次进图现身、取消剧情后恢复缺席；`quest-drops.test.ts` 覆盖任务物品来源；`quest-item-generation.test.ts` 验证掉落满额后读档与任务拾取。
- `audit:story:full` 跑主线开场、门口触发、近身剧情、专属任务交付、跨图收集、狼人战后接取交付和战斗失败恢复的代表性流程。

### 战斗与技能

- `combat-hit-resolution.test.ts` 从敌人普攻命中开始验证「圣徒之牺牲」的分摊与保护者倒地顺序；`combat-rewards.test.ts` 通过真实 `Session.settleEnemyDefeat` 验证普通、首杀、保底、任务、压测与景物奖励，并覆盖满地魔法药丸后的拾取、故障注入回滚、死亡单移除与监听错误隔离、伙伴原地回滚。
- `combat-outcomes.test.ts` 覆盖死亡单在 settle/present 抛错时的清除、失败回调和 flush 不向战斗帧抛错；`combat-defeat-ticket.test.ts` 覆盖离图先结算再移动、恢复世界先丢弃旧死亡单、销毁只释放死亡单不发放奖励。
- `combat-conditions.test.ts`、`world-skill-cache.test.ts`、`buff-loop-renderer.test.ts` 验证状态名单失效、暂停颜色、显隐、倒下/复活、恢复与纹理迟到；`enrage-runtime.test.ts` 验证血蓝共用输入与读取时序；`combat.test.ts` 验证普攻距离随换装更新。
- `basic-attack-repeat.test.ts` 与 `world-runtime-review.test.ts` 验证手动对敌技能自然结束后接普攻，以及无目标、辅助技能和切人边界。
- `enemy-presence-runtime.test.ts` 用正式任务、怪物和掉落验证剧情清场后的任务怪恢复、扣血、单次死亡结算、任务掉落、刷新换图、同帧退场、重复接取与捕捉；`enemy-respawn.test.ts` 覆盖视野内 60 秒/视野外 20 秒/48 像素缓冲、回头、镜头变化、读档换图和各生命周期；`combat-clock-runtime.test.ts` 验证主镜头接线、采样档位、暂停计时和提前刷新只结算一次。
- `party-follow.test.ts` 按连续移动覆盖墙内站位、拐角、赶路、拉扯、离队边界和预算等待；窄道拐角用真实导航核对寻路与移动的脚点通行范围。物理阻挡解除后验证重新迈步，持续受阻时验证四秒拉回门槛。真实人物占位覆盖绕行、挡路者移开、跨帧搜索等待预算和无路时拉回，逐段检查行走不穿过人物。大房间窄门覆盖首次搜索失败后的再次搜索，挡路者移开后 120ms 内恢复行走并绕过拐角；门口始终被堵时验证累计无进展达到门槛后拉回。跟随验收统计实际位移与拉回次数。
- 佣兵战术用正式技能数据验证治疗对象、召唤吼叫范围、群攻覆盖、冲锋与绕后落点、猎人埋伏；走位用例通过战斗控制器检查受围撤步、狭路还击和走近治疗。
- `mercenary-skills.test.ts`、`mercenary-skill-unlocks.test.ts`、存档与菜单用例覆盖佣兵手动加点、主角学习规则、招募上限、解锁资格、技能书突破、免费初始化、历史补点、成员隔离，以及封印书共享与检查点恢复；`mercenary-skills.test.ts` 同时验证伙伴自动成长提示与门槛范围。
- `lamp-merchant.test.ts` 覆盖神灯扣减、重复召唤、失败回滚、同图恢复和离图清理。
- 战斗性能回归以实际调用次数和生命周期为依据：连续攻击复用显示对象和动画，技能及增益反应描述在输入变化后刷新，寻路预判遵守快照与预算。调用次数减少与 Node 耗时不能替代同设备、同存档的帧率验收。

### 物品、掉落与装备

- `bag.test.ts`、`inventory.test.ts` 覆盖完整物品目录、分类数量和装备数据；`loot-redesign.test.ts` 覆盖来源等级筛选、全队黄紫装保底和封印盒存档；`material-gifts.test.ts` 覆盖六种材料礼盒的奖励、重复开盒、等级门槛和精英/Boss 来源限制。
- 装备清理由 shop、shop-panel、story-menu-interactions 覆盖等级与独立品质筛选、保护条件、报价变化、上锁入口和长按释放；`saved-game.test.ts` 覆盖锁定状态读回。

### 世界、地图与交互

- `map-prop-baseline.test.ts` 与 `story-actor-ledger.test.ts` 分别校验 `fixtures/` 的两份基线；台账变化必须显式更新基线。
- `world-frame-work.test.ts` 验证饰品换装保留角色、碰撞体和攻击动作，随后投影不重复准备；`world-skill-cache.test.ts` 验证饰品不触发技能资源补载、新技能等待外观合成，并覆盖共享贴图、退队清理、迟到失败、入队换装重试和读档等待全队资源。
- `scene-assets.test.ts` 验证资源齐全时不等待无关下载、缺帧修复按队列执行；`content-loader.test.ts` 用拆包与完整衣柜两种格式验证八份城镇动作跨会话常驻、并发只下载一次。
- `movement-content-recovery.test.ts` 覆盖内容机关压住队伍单位后的自愈；`movement.test.ts` 验证移动平滑；`display-settings.test.ts` 验证画面偏好默认值与持久化；`game-timing.test.ts` 验证 30/60 限帧、120 帧压力、实际耗时和寻路额度。

### 界面与菜单

- `dom-text-layout.test.ts` 验证菜单仅移动时文字跟随、锚点即时更新；`dom-surface.test.ts` 验证输入守卫、原生拖动、取消、嵌套长按、滚动后点击、静态按钮键盘导航、嵌套菜单滚动层坐标、图片裁边翻转、角色预览与预载信号，以及 3× 采样下的坐标一致性。
- `dom-assets.test.ts` 覆盖共享图集、独立取消与失败重试；`dom-components.test.ts` 覆盖裁剪、父子清理、轮盘技能/物品、多指互斥、隐藏后释放按键、DOM 小地图、技能行、SVG 冷却、四向移动、触摸取消与改键；`status-hud.test.ts` 验证场景暂停、唤醒和销毁时的可见性通知。
- `story-menu-interactions.test.ts` 用真实 DOM 菜单和原生事件验证交易、加点、背包拖放、存读档、布局编辑与弹层输入隔离，覆盖 1×/2×/3×、小数倍率和横竖屏；`scene-input-routing.test.ts` 验证职业选择预览与页面复用，并通过实际改名入口验证输入期间的 Escape 隔离及取消后的返回；`character-animation-reuse.test.ts` 验证六职业待机循环、角色释放和合成外观持有。
- `wardrobe.test.ts` 验证跨场景合成外观复用、独立取消、无外观变化换装、大动作分批绘制、缓存上限、会话清理、图形上下文恢复、尺寸限制与显存预算；`composition-budget.test.ts` 验证工作预算排除等待与中途取消；`texture-lifecycle.test.ts` 验证可见引用不删、隐藏不算引用、容器内角色计入、帧后补删。
- `prompt-shell.test.ts` 覆盖输入弹窗图片层、释放、系统键盘可见范围与密码表单；`menu-item-drag.test.ts` 覆盖长按阈值、移动取消、多指隔离、失效定时器和资源释放；`formal-presentation.test.ts` 覆盖全屏优先级、跳过补画与世界重建遮挡；`world-hud.test.ts` 覆盖一次地图访问的 HUD 装配、会话绑定与释放。
- `status-color-renderer.test.ts` 验证受击闪光结束后的颜色恢复与换动作混合方式；`warrior-viewer.test.ts` 覆盖展示器的狂战士主副手组合、四向动作、图集切片、独立外观、镜像基准点、播放控制和姿势拆包。

### 存档与生命周期

- `saved-game.test.ts` 覆盖格式 1 读档、尚未创建菜单时的后台保存、继续击败第八名哨兵，以及再次读档保留交付回执和奖励；`game-thumbnail.test.ts` 验证换局、截图超时和回调晚到时后台保存可用的画面。
- `resident-combat-lifecycle.test.ts` 验证回标题后的会话资源与回调释放、迟到退出回调不能清理新会话；`session-lifecycle.test.ts` 验证退出先取消本局工作、场景 shutdown 后才释放资源；`session-cooldowns-party.test.ts` 验证放逐/预备队冷却、放逐清理掉落保底、剧情离队失败或撤销时恢复伙伴战斗状态。

### 资源、图集与渲染

- `phaser-framebuffer.test.ts` 从实际运行时包提取构造器，验证分配失败清理和补丁重复执行；`character-animation-reuse.test.ts` 验证隐藏、同名动作换外观、销毁与替换失败清理；`wardrobe.test.ts` 验证池销毁后已有画面持有者归还前不删图。
- `world-effects.test.ts` 验证飞弹转向、持续效果保留贴图，以及地狱火在 1×/2×/3× 采样下的位置、数量和层级一致；`buff-loop-renderer.test.ts` 验证首次缺图后恢复。
- 图片加载测试覆盖业务场景取消后共用下载继续、同键接管、图集子文件、迟到回收与进度回调取消拒绝交付；图集帧映射由 `tests/*-atlas.test.ts` 覆盖。

### 调试

- `gm-actions.test.ts` 验证调试道具隐藏剧情专属装备并保留其他职业可穿戴；`gm-quest-jump.test.ts` 覆盖跳转传送、接取剧情与交接、等待战斗结束、失败回滚、播放失败报告和并发拒绝；`gm-quest-panel.test.ts` 验证任务页只把跳转交给宿主先存档；`gm-complete-golem.test.ts` 覆盖状态页完成任务先结算石魔遭遇。

## 验证

```bash
npm test -- tests/combat.test.ts
npm run test:standalone
npm run test:content-build
npm run audit:story        # 剧情角色与演出内容审计
npm run audit:story:full   # 主线代表性流程
npm run test:all           # 仅用户明确要求全量时
```

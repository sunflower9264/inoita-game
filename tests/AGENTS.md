# tests

单元测试与独立构建验收。平铺的 `*.test.ts` 覆盖剧情、战斗、任务、地图、存档和界面规则；`standalone.mjs` 负责独立安装与构建验收，`content-build-smoke.mjs` 用真实内容做编译后的行为烟雾测试。

## 文件

- `tests/*.test.ts` 全部平铺在根目录，按模块前缀命名：`story-*` 最多，其次 `combat-*`、`quest-*`、`world-*`、`skill-*`、`action-*`。找用例先按前缀匹配，例如 `tests/combat-*.test.ts`、`tests/story-*.test.ts`。
- `standalone.mjs`：独立安装、类型检查和构建验收，对应 `npm run test:standalone`；`content-build-smoke.mjs` 对应 `npm run test:content-build`，复用一次临时构建验证六职业实际文件与图集帧、黑暗空间对白动作范围、最小战斗和剧情节点。
- `helpers/`、`support/`、`fixtures/`：测试驱动、替身和固定数据，不是测试入口。

## 规则

- 测试入口平铺在 `tests/*.test.ts`；`tools/test.ts` 只接受该目录下的 `.test.ts` 文件，传目录或其他扩展名会被拒绝，不带参数时打印用法并退出。
- 共享接口或绘制方法变了，同步更新测试里的假对象（如 `tests/shop-panel.test.ts` 的 `Surface`），让它实现被测代码实际调用的方法。
- 单文件用 `npm test -- tests/foo.test.ts`，它先跑类型检查再用 `node:test` 执行；全量 `npm run test:all` 只在用户明确要求时运行，独立构建验收用 `npm run test:standalone`。
- Node 直接执行 `.ts`，只写可擦除语法：不用 `enum`、`namespace` 和构造函数参数属性。
- 用例验证可观察的行为和分支规则；实现重构不应迫使断言改写。
- 验证不自行启动浏览器或 headless Chrome；每个独立修复在相关检查通过后单独提交，说明写清行为和验证结果。

## 验证

- `story-intake.test.ts` 使用「最后的封印」的石魔战验证遭遇在玩家当前地图出现，等待战斗的剧情能在恢复后继续。
- `story-gated-interaction.test.ts` 覆盖七组剧情确认入口的取消后再次点击、普通交付保护与剧情结算，使用真实结界石内容验证石魔生成、击败后的主线推进，以及正常存档恢复。

- `bag.test.ts` 与 `inventory.test.ts` 覆盖完整物品目录、分类数量和装备数据；任务物品来源由 `quest-drops.test.ts` 验证。
- `loot-redesign.test.ts` 覆盖来源等级筛选、全队黄紫装保底和封印盒存档。
- `material-gifts.test.ts` 覆盖六种材料礼盒的全部奖励、重复开盒消耗、等级门槛和精英/Boss 来源限制。
- `dom-text-layout.test.ts` 验证菜单仅移动时文字跟随、锚点即时更新；`dom-surface.test.ts` 验证输入守卫、原生拖动、取消、嵌套长按、滚动后点击、静态按钮键盘导航、嵌套菜单滚动层坐标、图片裁边翻转、实时角色预览与预载信号；3× 采样下滚动、滑条与拖动沿用屏幕输入坐标，预览在画布内随采样倍率换算，DOM 遮罩留出的区域保持屏幕尺寸。
- 职业选择的实时预览和页面复用由 `scene-input-routing.test.ts` 验证；`character-animation-reuse.test.ts` 验证六个职业的待机动作循环播放和角色释放。
- `story-menu-interactions.test.ts` 使用真实 DOM 菜单组件和原生事件，验证交易、加点、背包拖放、存读档、布局编辑与弹层输入隔离；屏幕尺寸与画布采样倍率分别设置，覆盖 1×／2×／3×、小数倍率和横竖屏下的遮罩、横带、文字及点击一致性。
- `game-timing.test.ts` 验证 30 / 60 帧限帧切换、120 帧限帧器压力、实际耗时和战斗寻路额度；`movement.test.ts` 验证移动平滑；`display-settings.test.ts` 验证画面偏好的默认值和持久化。
- `dom-assets.test.ts` 覆盖共享图集、独立取消与失败重试；`dom-components.test.ts` 覆盖裁剪、父子清理、轮盘技能/物品、多指互斥及隐藏后释放按键。
- `status-color-renderer.test.ts` 验证受击闪光结束后恢复原色和最新状态颜色。
- DOM 状态栏在 `dom-components.test.ts` 验证切控、阵亡头像、目标与资源释放；`status-hud.test.ts` 验证场景暂停、唤醒和销毁时的 DOM 可见性通知。
- `dom-components.test.ts` 同时覆盖 DOM 小地图、电脑技能行、SVG 冷却、四向移动、触摸取消和改键；`control-settings.test.ts` 覆盖操作模式的持久化与通知。

- `story-stage-isolation.test.ts` 验证加载途中跳过、迟到画面清理、共享启动与真实坐标保留；`story-skip.test.ts` 验证流程阶段及解锁顺序。
- 「最后的记忆1」的四处铁门入口覆盖正常走位、开场跳过和走位途中跳过，核对实际地图上的落点、镜头和弹窗前补出的画面。
- `scene-assets.test.ts` 验证已齐全的资源不等待无关下载，以及缺帧修复仍按队列执行。
- `wardrobe.test.ts` 验证跨场景合成外观复用、独立取消、无外观变化的换装、大动作分批绘制、缓存上限、会话清理及图形上下文恢复；`composition-budget.test.ts` 验证工作预算排除等待时间及中途取消。
- `warrior-viewer.test.ts` 覆盖独立素材展示器的狂战士主副手组合、四向动作与图集切片、独立外观覆盖、镜像基准点、播放控制和姿势拆包加载。
- `content-loader.test.ts` 用拆包及完整衣柜两种格式验证八份城镇动作跨会话常驻、并发只下载一次。
- `wardrobe.test.ts` 还覆盖绘图恢复等待、超时、取消、半成品重建、尺寸限制与外观显存预算；`phaser-framebuffer.test.ts` 从实际运行时包提取构造器验证分配失败清理和补丁重复执行。
- `world-frame-work.test.ts` 验证饰品换装保留角色、碰撞体和攻击动作，随后投影不会重复准备；`world-skill-cache.test.ts` 验证饰品不触发技能资源补载，新技能等待外观合成；`story-menu-interactions.test.ts` 验证装备准备期间保留页面、完成后只刷新一次。

```bash
npm test -- tests/combat.test.ts
npm run test:standalone
```

- `session-cooldowns-party.test.ts` 验证放逐与预备队的冷却、放逐时清理掉落保底，以及剧情离队失败或撤销时恢复对应伙伴的战斗状态。

- `world-skill-cache.test.ts` 验证共享技能贴图在原使用者离队后仍由后学会的主角持有，最后释放时回收；覆盖退队失败清理、迟到失败、自动反应等待资源，入队期间换装的重试，以及读档等待全队技能资源、准备失败保留原战斗现场。
- `basic-attack-repeat.test.ts` 与 `world-runtime-review.test.ts` 验证手动对敌技能自然结束后接普攻，以及无目标、辅助技能和切人时的边界。

- `quest-actor-visibility.test.ts` 覆盖任务交付人在同一次进图中现身，以及取消剧情后恢复此前的缺席状态。
- `story-native-triggers.test.ts` 直接检查《最后的记忆2》的交付通知，验证前三次交付各播一段对应的对白、各发一次奖励，并重新开放下一轮对话。
- 剧情跳转回归遍历全部菜单任务并颠倒显示顺序，同时用正式进图、行走、战斗、交付和存读档流程验证蜘蛛巢穴的前跳与回跳，以及在接取演出里赢得首领战后的跳转结果。
- `gm-actions.test.ts` 验证调试道具列表隐藏剧情人物专属装备，并保留其他职业的可穿戴装备；`gm-quest-jump.test.ts` 覆盖剧情跳转的传送、接取剧情与交接（清强制状态、检查点、自动存档），等待剧情战斗结束才交接，以及失败回滚、播放失败报告和并发拒绝；`gm-quest-panel.test.ts` 验证任务页只把跳转交给宿主先存档。
- `combat-hit-resolution.test.ts` 从敌人的普攻命中开始，验证「圣徒之牺牲」给两人各扣多少血，以及保护者倒地的先后顺序。

- `world-effects.test.ts` 验证飞弹转向和持续效果独立保留贴图到结束；`buff-loop-renderer.test.ts` 验证首次缺图后恢复。
- `world-effects.test.ts` 还通过实际战斗装配与特效播放器验证地狱火在 1×/2×/3× 采样下的位置、数量和绘制层级一致，覆盖主角与佣兵。

- `resident-combat-lifecycle.test.ts` 验证回标题后的会话资源与回调释放，以及迟到退出回调不能清理新会话；`session-lifecycle.test.ts` 验证退出先取消本局工作，场景 shutdown 后才释放资源。

- 状态表现优化由 `combat-conditions.test.ts`、`world-skill-cache.test.ts` 和 `buff-loop-renderer.test.ts` 验证名单失效、暂停颜色、显隐、倒下/复活、恢复与纹理迟到；`enrage-runtime.test.ts` 验证血蓝共用输入且保留读取时序；`combat.test.ts` 验证已解析普攻距离随换装更新。

- 战斗性能回归以实际调用次数和生命周期为依据：连续攻击复用显示对象和动画，技能及增益反应描述在输入变化后刷新，寻路预判遵守快照与预算。调用次数减少与 Node 耗时不能替代同设备、同存档的帧率验收。

- `story-preparation.test.ts` 覆盖确定路径与调用返回、预测边界；`story-asset-preparation.test.ts` 覆盖跨场景请求复用、目标替换、取消和失败重试；入口测试验证恢复游戏不等待后续剧情素材。

- 装备清理由 shop、shop-panel、story-menu-interactions 用例覆盖等级与独立品质筛选、保护条件、报价变化、上锁入口和长按释放；saved-game 覆盖锁定状态读回。
- `texture-lifecycle.test.ts` 覆盖纹理退役：可见对象仍引用时不删、隐藏对象不算引用、容器内角色计入，以及引用消失后在帧后检查里补删。
- `enemy-presence-runtime.test.ts` 使用正式任务、怪物和掉落，验证剧情清场后的任务怪从存档恢复、普攻和技能扣血、单次死亡结算、任务掉落、刷新与换图、任务结束后的同帧退场、重复接取及捕捉；在场与生成资格查询保持只读。
- `enemy-respawn.test.ts` 覆盖视野内 60 秒、视野外 20 秒、四边 48 地图像素缓冲、回头、镜头范围变化、读档、换图和一次性/捕捉/动态敌人；`combat-clock-runtime.test.ts` 验证主镜头接线、各档画面采样和暂停计时，真实任务战斗用例验证提前刷新的怪仍扣血并只结算一次掉落。

- `party.test.ts` 验证后备佣兵分到经验后可以升级，倒地者的生命仍为零。该文件与 `story-menu-interactions.test.ts` 还验证佣兵能力点、旧成长保留和人物页加点。

- `status-color-renderer.test.ts` 使用幽灵黑底源图验证发光层闪白模式，以及换动作后混合方式切换、新旧图层的颜色恢复。

- 剧情动作测试检查等待结束时仍在播放、自然完成后的保持或待机，以及跳过后的最终姿势。

- `lamp-merchant.test.ts` 覆盖神灯扣减、重复召唤、失败回滚、同图恢复和离图清理。

- `party-follow.test.ts` 按连续移动推进角色，覆盖墙内站位、拐角、赶路、拉扯与离队边界和预算等待；跟随验收统计实际位移和拉回次数。

- `mercenary-skills.test.ts`、`mercenary-skill-unlocks.test.ts`、存档和菜单测试覆盖佣兵手动加点、主角学习规则、招募上限、解锁资格、技能书突破、免费初始化、历史补点与成员隔离；战斗缓存测试验证初始化只清理对应成员。主角初始化继续验证初始技能和快捷栏恢复。
- `mercenary-skills.test.ts` 同时验证剧情伙伴自动成长提示与实际升级一致，以及成长门槛不超过角色等级范围。

- `saved-game.test.ts` 覆盖格式 1 读档、尚未创建菜单时的后台保存、继续击败第八名哨兵，以及再次读档时保留交付回执和奖励。`game-thumbnail.test.ts` 验证换局、截图超时和回调晚到时后台保存可用的画面。
- `story-scene`、`story-stage-isolation` 与 `saved-game` 覆盖主角收放武器、同图保留、换图恢复默认和存档读回。「消失的圣女1」在装备外观还没准备好时分别跳过和取消整段剧情，核对主角姿态和迟到的外观。

- `mercenary-skill-unlocks.test.ts` 覆盖六职业封印书的永久共享、候补与未来佣兵继承、抽取去重、失败回滚和检查点恢复；存档与菜单用例覆盖共享资格、等级保留和背包控件复用。

- `story-equipment.test.ts` 覆盖剧情装备发放与拾取拦截、手动穿脱与连带替换保护、剧情移除与离队销毁、正常装备退回；`story-disguise.test.ts` 验证剧情伪装穿脱，`saved-game.test.ts` 验证当前格式读回时保留剧情装备限制。

- `prompt-shell.test.ts` 覆盖确定/取消按钮实际图片层、独立输入弹窗的图片释放、系统键盘可见范围与密码表单校验及提交。

- `story-trigger-occupancy.test.ts` 逐帧走正式场景的触发判断，验证原地只播一次、走开再靠近可以重播，以及过滤解除后的补播。
- `combat-defeat-ticket.test.ts` 覆盖正常离图先结算再提交地图移动、恢复世界先丢弃旧死亡单，以及销毁战斗只释放死亡单、不发放奖励。
- `audit:story:full` 运行主线开场、门口触发、近身剧情、专属任务交付、跨图收集、狼人战后接取和交付，以及战斗失败恢复的代表性流程。狼人战后用例从实际区域入口启动战斗，通过世界场景的更新上报胜利，覆盖跳过演出、读档和重复战果。

- `combat-rewards.test.ts` 通过真实 `Session.settleEnemyDefeat` 验证普通、首杀、保底、任务、压测与景物奖励；另覆盖满地魔法药丸后新装备的拾取与属性保留；`quest-item-generation.test.ts` 验证普通掉落满额后读档和任务拾取。故障注入覆盖地面掉落裁剪、经验与宝箱衍生怪的原子回滚，并验证死亡单在结算前移除、提交后的监听者错误隔离。

- `combat-rewards.test.ts` 覆盖击杀结算失败后的伙伴原地回滚：成员与技能对象保持身份，原有世界绑定和血条查询继续读取恢复后的状态。

- `character-animation-reuse.test.ts` 验证角色直接持有合成外观：隐藏、同名动作换外观、销毁和替换失败清理；`wardrobe.test.ts` 验证池销毁后已有画面持有者归还前不删图，并拒绝用旧外观创建新持有者。

- 图片加载测试显式登记下载宿主，覆盖业务场景取消后共用下载继续、同键接管、图集子文件、迟到回收，以及进度回调取消时拒绝交付。

- `menu-item-drag.test.ts` 覆盖长按阈值、移动取消、多指隔离、失效定时器和拖拽资源释放；背包异步操作的关闭、换人和换会话隔离由 `story-menu-interactions.test.ts` 验证。
- `combat-outcomes.test.ts` 覆盖死亡单在 settle/present 抛错时的清除、失败回调和 flush 不向战斗帧抛错。
- `formal-presentation.test.ts` 覆盖全屏显示优先级、跳过补画与世界重建遮挡；`world-hud.test.ts` 覆盖一次地图访问的 HUD 装配、会话绑定与释放。

佣兵战术用正式技能数据验证治疗对象、召唤物吼叫的实际范围与交战目标、群攻覆盖、冲锋与绕后的可达落点，以及猎人开埋伏时能否立即普攻；走位用例通过战斗控制器检查受围撤步、狭路还击和走近治疗。

- `gm-quest-jump.test.ts` 使用正式剧情逐个验证「圣女救援行动」的跳转现场，包括开机关、次元之门战斗，以及从后期存档跳回救人现场后读档、步行交付和单次奖励。序幕与哈肯沙漠的折返用例验证旧演出保持结束、主动回跳能重新推进。

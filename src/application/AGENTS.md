# src/application

演出内容校验使用与剧情播放相同的调用深度上限，在进入多余的一层前报告内容错误。

`saved-game.ts` 从绑定的游戏会话、地图现场、职业和立绘生成记录。手动保存和自动保存共用这个入口。

云存档下载在覆盖本机槽位前调用正式读档的准备步骤，检查存档并加载目标地图。逐槽报告失败，取消后停止写入；准备失败统一提示“游戏存档出错”，原始错误连同槽位写 `load-validation-failed` 诊断。

能力接口与适配层：把 `domain` 的纯规则接到 Phaser、浏览器和磁盘。

## 文件

- 端口/场景键/事件：`ports.ts`（能力接口）、`scene-keys.ts`（场景键）、`ui-events.ts`（界面事件名）、`input-router.ts`（全局键盘作用域与优先级）、`entry-loading.ts`（入口加载与继续进度）、`entry-plan.ts`（入口计划、公共素材分批与地图资产）、`menu-images.ts`（标题与菜单图片分组）。
- 内容加载与校验：`content-loader.ts`（内容加载器与生产哨兵）、`content-validation.ts`（内容字段校验器）、`content-relations.ts`（引用关系校验）、`content-hash.ts`（规范化 JSON 与内容摘要）、`content-trust.ts`（构建期信任开关）、`story-performance-validation.ts`（剧情演出校验）、`story-reference-validation.ts`（剧情引用校验）。
- 存档/自动保存：`saved-game.ts`（读档时校验格式、会话和地图现场）、`saved-game-loader.ts`（存档读取与取消）、`auto-save.ts`（自动保存节流与重试）、`quest-item-grants.ts`（任务物品净发放与溢出）、`world-snapshot.ts`（世界快照与存档捕获结果的数据类型）。
- 云存档：`cloud-save.ts`（HTTP 客户端、token 存储、续期、改密与结果化错误）、`cloud-save-sync.ts`（逐槽备份/恢复、覆盖确认与部分失败）、`endpoints.ts`（云存档/诊断服务地址解析，网页同源，宿主注入）。
- 剧情素材：`story-asset-preparation.ts`（剧情目标的在途任务与完整素材使用权）。
- 资源/版本：`assets.ts`（素材池与租约）、`asset-version.ts`（素材与内容版本号）。
- 热更新接线：`live-update.ts`（标题页启动完成信号）。
- 设置/控制：`control-settings.ts`（操作模式设置）、`control-state.ts`（操作状态与游戏模式）、`display-settings.ts`（显示偏好）、`key-bindings.ts`（键位偏好）、`fullscreen.ts`（全屏与横屏锁定）。
- Phaser/浏览器适配：`game-audio.ts`（音频适配）、`game-timing.ts`（帧时钟适配）、`frame-pacing.ts`（帧率上限换算与刷新率测量）、`native-frame-rate.ts`（把玩家帧率告诉安卓壳）、`game-diagnostics.ts`（错误快照、帧统计、指标注入与跳过摘要）、`browser-compat.ts`（浏览器 API 兼容补丁）、`page-interaction-guard.ts`（整页缩放与长按菜单锁定）。

## 规则

- 伙伴技能自动成长等级必须处于角色等级范围，并按技能等级严格递增。每个职业主动技能都要在伙伴目录登记战术用途。治疗和召唤用途还须在主角及佣兵动作中有对应效果。
- 加载与构建都检查剧情顺序，核对全部任务的接取与交付、日志外持续任务、一次性事件、分支选择和有多个候选地点时的实际地图。
- 内容校验核对任务 `interactionEvent` 的近身事件、重复资格、任务条件与交付角色一致；同一任务依赖重复近身事件确认时显式声明交互事件，交付脚本与交互事件各自独占处理职责。`actor-visibility` 命令的 `characterId` 必须是地图实体、剧情摆放或任务目标里出现过的人物身份，写错编号直接报错。
- 读档校验通过后保留已读取的目标地图，安装新会话时清理其他会话内容，正式进图复用这份地图。地图现场可携带这次接触已播放的剧情，由读档入口交给新场景恢复。
- 键盘输入只从场景桥接一次进 `input-router.ts`。作用域从高到低是 `text-input > modal > menu > dialogue > world`；处理器返回 `boolean` 表示是否消费。文本输入框有焦点、弹层或菜单打开时用 `exclusive` 独占，按键不会再落到世界层。按钮点击、滚动和拖拽继续走 Phaser 输入，router 不接指针。场景 `shutdown` 时注销自己注册的作用域。
- 新能力先在 `ports.ts` 定义接口，由 `src/app.ts` 在启动阶段注入实现。
- 场景通过 ports 取素材、音频和浏览器能力，加载与 API 调用留在本目录。
- **标题页后台预载公共素材。** `commonAssetBatches` 把 HUD、掉落/任务图标、衣柜图集、全部职业与伙伴的基础动作和通用战斗反馈分成小批；标题页加载完成后由正式界面场景逐个加载。开始游戏或读档时停掉剩余批次，已载入的纹理留在全局纹理库，进图计划直接复用；技能动作、已学技能特效和召唤物仍按本次会话补齐。内容目录与会话无关，预载任务不随入口切换取消，调用方等完后各自检查自己的取消信号。
- 游戏入口把 `StoryDirector.onSkipProgress` 接到 `installStorySkipDiagnostics`，每次跳过只写一条 `story-skip-summary`，记录逻辑完成、世界就绪与实际解锁的耗时；选择和任务确认单独标明终点。
- **诊断先落本地日志再异步上传。** 错误类记录默认附完整快照，其他记录默认不带；需要时第三个参数传 `true`。开战/收战、换图、存读档、心跳和高频事件只带选定字段。每帧只允许 `FrameStats.frame` 做一次整数加减，不在帧回调里新建对象或读取场景状态。`storyDiagnostics.record(kind, details, withState)` 的第三个参数显式控制是否附完整快照。
- 云存档是旁路能力：客户端构造不联网，只有打开云页/点击上传下载才请求；网络、token 或存储失败都结果化返回，不能抛到菜单或游戏循环。
- 云存档和诊断的服务地址只从 `endpoints.ts` 解析。环境根地址在 `config/endpoints.json`：网页根地址为空（运行时同源）；Android 发布写 `https://catgo.online`，调试约定为 `adb reverse` 的 `127.0.0.1:4003`，当前 Gradle 尚未按 buildType 切换。Android 壳由内置内容服务提供的 `bootstrap.js` 在页面脚本前注入同源代理地址；页面里不再另写域名或读取别的地址变量。
- 只有 `game-audio.ts`、`game-timing.ts` import Phaser，其余文件保持纯 TypeScript。
- 整页缩放和长按选择由 `page-interaction-guard.ts` 在入口统一拦截；viewport 声明和 `game.css` 的 `touch-action` 是第一道，Safari 的 gesture 事件、桌面 Ctrl/⌘ 缩放和右键/选择事件是兜底。输入框保留原生粘贴和选择菜单，不要在输入框上拦截。
- 画面偏好保存在本机：帧率上限只接受 30 或 60，缺省为 60；游戏启动读取偏好，设置变化立即调整 Phaser 限帧，销毁时取消订阅。纹理批次默认自动：安卓单纹理，iOS 和桌面多纹理；单纹理/多纹理可手动覆盖，启动和设置变化时更新 `setMaxParallelTextureUnits`。画面精度接受 1/2/3 三档，缺省 1；实际倍率取档位与本机设备像素比的较小值，切档立即重配画布，不重启。帧时钟继续使用相邻交付时刻计算真实耗时。
- 限帧阈值不等于玩家选项：60 档离屏幕刷新率不到 2Hz 时用 90 的数值上限，而不是 `fps.limit = 0`；30 档贴近屏幕时仍交给 vsync（0），其余明显低于刷新率的档位按玩家选项限帧。60Hz 屏上把上限设成 60 会踩进 Phaser 限帧器的临界区，实测刷新 54 次只交付 34 帧；90 高于屏幕节拍，每个 rAF 都能过阈值，画面仍是 60 帧。刷新率用连续 rAF 间隔的中位数测量；高刷屏在启动初期可能仍按 60Hz 回调，所以进图/读档就绪后要补测，并且只采纳样本足够且更高的结果。否则 120Hz 屏上的 60 档会被误判成 90 上限，实际跑到 90 左右。
- 玩家选的帧率通过 `window.InotiaNative.setFrameRate` 告诉安卓壳（`native-frame-rate.ts`）。壳选一个刷新率是目标帧率整数倍的显示模式：30 选 60/90/120，60 选 60/120。整数倍保证每个游戏帧占整数个屏幕节拍；60 帧跑在 90Hz 上会反复在 1 个和 2 个节拍之间跳。壳选好后把屏幕**实际**刷新率写回 `window.__inoitaDisplayHz` 并派发 `inoita-display-rate`，页面用 `setRefreshRate` 直接采用，不再靠 rAF 重测。这里不能写玩家请求的 30/60：`resolveFrameLimit` 要靠实际值判断 60 档要不要用 90 的上限、30 档要不要交给 vsync；低于 20Hz 的瞬时值会被忽略。网页版没有原生桥时静默跳过。
- 已有正式存档后，改存档结构或校验口径时，把 `src/domain/save-game.ts` 的 `SAVE_FORMAT` 加一；旧格式不再读取，不补迁移和旧档测试。
- 读档校验失败给玩家统一的“游戏存档出错”提示，内部错误只写 `load-validation-failed` 诊断，不把领域校验句直接弹给玩家。
- **自动存档优先走 `writeAsync`，页面隐藏时走同步 `write`。** 常规写入先等一帧截取游戏画面缩略图；`flushForBackground` 不等截图，沿用最近一张，避免页面隐藏后保存没落地。截图失败只保存无图存档，不阻断写入。
- 自动存档的异步截图写入前检查写入序号；后台同步写入或停止后，较早的截图结果不能覆盖新进度。
- 内容加载与构建共用 `content-validation.ts` 的校验器，新增内容字段先在这里定校验口径。
- 生产信任路径只取构建写出的 `content-manifest.json`：比较 `contentVersion` 与页面注入的 `__STORY_CONTENT_VERSION__`，并检查本次文件的必需顶层键；不匹配时明确失败并提示刷新/更新，不静默继续。启动时不对整份内容重算哈希。dev、Node 测试和 `?gm` 继续走完整校验。
- 热更新只做旁路：标题页加载完成后调用 `notifyBootReady()`；网页版没有原生桥时静默跳过。检查、下载、切换和回退都在 Android 壳里，网页不判断版本。
- `StoryContext.outfits` 由新会话装配创建，世界与剧情舞台共用；回标题或替换会话时销毁旧外观池，仍被场景使用的纹理在最后一个使用权释放后回收。
- 内容加载器只保留最近 2 张已完成地图，外部持有的地图对象与共用下载继续有效。城镇站立、行走的四向动作由内容加载器跨会话持有，其他动作只合并进行中的请求，完成后交给会话外观池。开发/GM 完成全量校验后调用 `releaseValidationCaches` 释放临时数据。
- 内容文件与生产清单请求在 15 秒后超时，失败释放请求并允许重试；共用请求的调用方各自取消，最后一个调用方退出时取消底层请求。
- 会话边界清理：回菜单和新会话装配时调用 `ContentLoader.clearSessionCaches()` 与 `StoryApp.clearMapHistory()`；只清已完成的地图解析和历史地图租约，核心内容表保持常驻。
- 地图素材历史保留最近 2 张，预取额度单独管理。
- 音频只常驻基础界面音与通用战斗反馈；战斗、剧情按完整清单替换准备范围，过期加载完成后释放无主缓存。一次性音效持有声音实例到播放结束，暂停期间仍保留；游戏中保留当前及上一首音乐，回标题清空旧局音乐历史。
- **声音销毁只从「自然播完」发起。** Phaser 的 `destroy()` 内部会先同步发 `stop`；`stop` 回调只做记账和释放缓存，不能再次调 `destroy`，否则内层销毁把 `muteNode` 置空后，外层继续 `disconnect()` 会报 null。外部停止（如 `removeAll`）由调用方自己负责销毁。
- `story-asset-preparation.ts` 持有一个剧情目标的在途任务与完整素材使用权。世界关闭不取消，目标变化、剧情取消、会话退出或新世界接管时释放；失败允许正式入口补载。剧情内静默入口只等待可玩资源，立绘与演出音效在对应演出前准备。
- `summonLampMerchant` 将背包召唤交给世界场景准备，成功后界面关闭背包；神灯商店必须有角色定义。
- 挑战模式的场内换职业通过界面能力接口暂停世界，再销毁旧局并以所选职业重建会话。
- 标题页和游戏菜单预载 `PROMPT_IMAGES` 中的独立输入弹窗皮肤，确保原生输入聚焦时边框与按钮已准备。
- `world-snapshot.ts` 定义世界快照与存档捕获结果，读档、存档、检查点和能力接口直接依赖该数据类型，不依赖具体世界场景。

## 验证

```bash
npm test -- tests/saved-game.test.ts
npm test -- tests/cloud-save-client.test.ts tests/cloud-save-sync.test.ts tests/cloud-save-offline.test.ts
npm test -- tests/endpoints.test.ts
npm test -- tests/content-loader.test.ts
```

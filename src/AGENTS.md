# src

本机读档和云档恢复共用 `session-lifecycle.ts` 的候选准备步骤。正式读档在准备成功后安装会话。

游戏源码的家：`app.ts` 负责装配，`main.ts` 创建 Phaser 游戏并注册场景。

## 文件

- `app.ts`：启动装配；按阶段接 ports、UI 和状态，场景与界面通过 `application/ports.ts` 的能力接口取依赖。
- `session-lifecycle.ts`：统一会话装配、候选读档交接和退出；本局回调绑定会话身份与取消信号，旧局回调不能操作新局。剧情连续执行超限时，会话和世界场景把节点轨迹写入诊断记录，界面显示简短错误。
- `main.ts`：Phaser 游戏配置与场景注册；新会话创建共用外观池，回标题或换会话释放；开发页、部署页与 APK 接入跳过耗时摘要。
- 标题预载与直接进图通过同一内容准备入口取得城镇站立、行走的四向动作；这些动作跨会话复用，具体穿戴的外观按当前队伍合成。
- 自动存档读取本局最近一次成功的截图。停止本局自动存档时，同时取消在等的截图并清空已有图片。
- `game.css`：页面、画布、DOM 图片容器及其上方文字层的样式。
- `scenes/`：地图、剧情舞台和菜单，编排生命周期；`debug/`：GM 动作与调试开关；`generated/`：构建生成的图集描述。
- `domain/`：内容类型、会话状态、剧情调度、通行与战斗规则。
- `application/`：内容加载、存档、设置和浏览器能力适配。
- `rendering/`：角色、地图、战斗和特效的绘制；`ui/`：布局计算，`ui/dom/` 承担屏幕界面绘制和输入。

## 规则

- 依赖方向固定：`domain`、`debug` 是纯 TypeScript，不 import Phaser 和上层目录；`application` 大多是纯逻辑，只有 `application/game-audio.ts`、`application/game-timing.ts` 两个 Phaser 适配器。
- 场景只编排生命周期；世界绘制归 `rendering`，布局和状态归 `ui`，屏幕界面绘制和输入归 `ui/dom`。
- 手机系统键盘只影响 DOM 输入框，不改变游戏画布尺寸。`main.ts` 的 `visualViewport` 重排在输入框聚焦时只跟随位置偏移（`fitViewport({keepSize:true})`），不按键盘缩小后的可视区重算尺寸；云存档输入框挂在 `#game-frame` 内，与画布共用坐标系。
- iOS 弹出键盘会让窗口短暂失焦。`main.ts` 在启动后接管 `window.onblur/onfocus` 并关闭 Phaser 的 `pauseOnBlur`：输入框聚焦期间的失焦不能暂停游戏循环或音频，真正的页面切走由 `visibilitychange` 驱动。
- **iOS 音频恢复要接住拒绝。** `resumeAudioContext` 只在页面可见且上下文未运行时尝试 `resume()`；自动事件跳过 Phaser 的 `locked` 快照，真实手势不受它阻挡（首次解锁被拒后 `locked` 会一直为 true）。iOS 回前台还要按 Phaser 原来的做法先 `suspend()` 再 `resume()`（`resetAudioContext`），因为 iOS 17/18 可能报 `running` 却没有声音；同步和异步拒绝都不能漏，`ready` 后摘掉 Phaser 自带的 `VISIBLE` 处理器，改用这套带 catch 的恢复。
- 玩法规则只在 `domain` 写一份，`application` 负责把它接到 Phaser 和浏览器。
- 游戏世界实现顺序：Phaser 4 内置 API → 技能 → Phaser 4.2.1 官方文档。屏幕界面采用 DOM、CSS 和 SVG，复用现有布局与状态接口。
- 进入游戏前通过同一个预载入口同步等待菜单、DOM 状态栏、轮盘、小地图和图集图片；回菜单统一释放界面持有的图片资源。
- 读档完成后记录音频上下文、锁定状态和播放中的音轨，供手机排查声音问题。
- 音频恢复监听使用窗口指针捕获阶段，DOM 控件消费触摸后仍能恢复音频上下文。
- 内置优先：移动和碰撞用 Arcade Physics（`this.physics`），镜头跟随用 `this.cameras.main.startFollow()`，逐帧动画用 `this.anims`；不要自己写循环。
- Phaser 4 的渲染管线是 render node，FX/mask 用 filter，tint 和纹理坐标与 v3 不同；不要套 v3 写法。
- 代码用游戏语义命名：`pos = { x: -rec.u_5, ... }` 写成 `worldPosition = { x: -rec.tileX, ... }`；位运算封装成 `getTileIndex(cell)` / `isFlippedHorizontally(cell)`；`0x2484` 这类索引在解码时算成 `transparentIndex`；地图调色板在导出阶段展开成 `world.tilePalette`。

## 验证

- `npm run typecheck` 覆盖整个 `src`；按改动另跑 `npm test -- tests/session.test.ts`。

- 回标题先停自动保存、取消旧请求并关闭舞台和世界场景，再由 `StoryApp.releaseSession(expected)` 清会话、导演、检查点与资源池；退出回调只释放它捕获的旧会话。读档先验证独立候选，停止旧场景后再安装。

- 剧情预取从当前节点沿确定路径提前准备目标世界；会话持有加载任务，常驻界面场景承接下载，跳过耗时摘要覆盖网页与 APK。

- 菜单重绘保留正文根节点的 DOM 挂载；清理装备等级长按仅更新清单与文字，按钮节点持续复用。

- `game.css` 的独立输入弹窗采用原版图框、共用按钮与深色输入区；按钮图片层与菜单共用 `common-button-face.ts` 的 CSS 图片边框绘制。普通高度下正文滚动、标题和操作行固定；短屏使用紧凑布局，极短空间整张表单滚动。

- 图片下载场景在其他业务场景之前启动，随游戏运行；地图和剧情场景只拥有请求等待与交付后的素材使用权。

- 调试跳转先在世界场景完成传送并确认目标地图就绪，再把正式演出的播放结果交给动作层。

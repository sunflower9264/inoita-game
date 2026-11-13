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

- `dom-text-layout.test.ts` 验证菜单仅移动时文字跟随、锚点即时更新；`dom-surface.test.ts` 验证输入守卫、原生拖动、取消、嵌套长按、滚动后点击、静态按钮键盘导航、嵌套菜单滚动层坐标、图片裁边翻转、实时角色预览与预载信号；3× 采样下滚动、滑条与拖动沿用屏幕输入坐标，预览在画布内随采样倍率换算，DOM 遮罩留出的区域保持屏幕尺寸。
- 职业选择的实时预览和页面复用由 `scene-input-routing.test.ts` 验证；`character-animation-reuse.test.ts` 验证六个职业的待机动作循环播放和角色释放。
- `story-menu-interactions.test.ts` 使用真实 DOM 菜单组件和原生事件，验证交易、加点、背包拖放、存读档、布局编辑与弹层输入隔离；屏幕尺寸与画布采样倍率分别设置，覆盖 1×／2×／3×、小数倍率和横竖屏下的遮罩、横带、文字及点击一致性。
- 调试菜单用例覆盖可见行复用、滚动到列表末尾、关闭释放、迟到预览和重新打开；`resident-combat-lifecycle.test.ts` 覆盖调试现场表的持有、释放和异步加载竞态。
- `game-timing.test.ts` 验证 30 / 60 帧限帧切换、120 帧限帧器压力、实际耗时和战斗寻路额度；`movement.test.ts` 验证移动平滑；`display-settings.test.ts` 验证画面偏好的默认值和持久化。
- `dom-assets.test.ts` 覆盖共享图集、独立取消与失败重试；`dom-components.test.ts` 覆盖裁剪、父子清理、轮盘技能/物品、多指互斥及隐藏后释放按键。
- `status-color-renderer.test.ts` 验证受击闪光结束后恢复原色和最新状态颜色。
- DOM 状态栏在 `dom-components.test.ts` 验证切控、阵亡头像、目标与资源释放；`status-hud.test.ts` 验证场景暂停、唤醒和销毁时的 DOM 可见性通知。
- `dom-components.test.ts` 同时覆盖 DOM 小地图、电脑技能行、SVG 冷却、四向移动、触摸取消和改键；`control-settings.test.ts` 覆盖操作模式的持久化与通知。

- `story-stage-isolation.test.ts` 验证加载途中跳过、迟到画面清理、共享启动与真实坐标保留；`story-skip.test.ts` 验证流程阶段及解锁顺序。
- `scene-assets.test.ts` 验证已齐全的资源不等待无关下载，以及缺帧修复仍按队列执行。
- `wardrobe.test.ts` 验证跨场景合成外观复用、独立取消、换装、缓存上限、会话清理及图形上下文恢复。

```bash
npm test -- tests/combat.test.ts
npm run test:standalone
```

- `session-cooldowns-party.test.ts` 验证放逐与预备队的冷却、掉落保底清理，以及旧档中已放逐成员记录的回收。

- `world-skill-cache.test.ts` 验证共享技能贴图在原使用者离队后仍由后学会的主角持有，最后释放时回收；覆盖退队失败清理、迟到失败、自动反应等待资源，入队期间换装的重试，以及读档等待全队技能资源、准备失败保留原战斗现场。
- `basic-attack-repeat.test.ts` 与 `world-runtime-review.test.ts` 验证手动对敌技能自然结束后接普攻，以及无目标、辅助技能和切人时的边界。

- `debug-mark-store.test.ts` 验证摘要分页不读取正文、跨实例读取及配额失败的原子覆盖；`gm-actions.test.ts` 验证持久标记的取消、损坏、现场回退与任务返回点。

- `world-effects.test.ts` 验证飞弹转向和持续效果独立保留贴图到结束；`buff-loop-renderer.test.ts` 验证首次缺图后恢复。

- `resident-combat-lifecycle.test.ts` 验证回标题后的会话资源释放，以及迟到退出回调不能清理新会话。

- 持久标记预校验失败不通知或修改原会话；会话销毁后迟到结果不安装，退出恢复原位置后才恢复保存，并拒绝并发退出。

- 状态表现优化由 `combat-conditions.test.ts`、`world-skill-cache.test.ts` 和 `buff-loop-renderer.test.ts` 验证名单失效、暂停颜色、显隐、倒下/复活、恢复与纹理迟到；`enrage-runtime.test.ts` 验证血蓝共用输入且保留读取时序；`combat.test.ts` 验证已解析普攻距离随换装更新。

- 战斗性能回归以实际调用次数和生命周期为依据：连续攻击复用显示对象和动画，技能及增益反应描述在输入变化后刷新，寻路预判遵守快照与预算。调用次数减少与 Node 耗时不能替代同设备、同存档的帧率验收。

- `story-preparation.test.ts` 覆盖确定路径与调用返回、预测边界；`story-asset-preparation.test.ts` 覆盖跨场景请求复用、目标替换、取消和失败重试。

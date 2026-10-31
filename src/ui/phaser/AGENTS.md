# src/ui/phaser

Phaser 界面实现层：创建面板、控件和 HUD，绑定输入并完成绘制。布局数字来自 `src/ui/`。

## 文件

- 面板：`forge-panel.ts`（强化台）、`crafting-panel.ts`（合成台）、`shop-panel.ts`（商店）、`quest-panel.ts`（任务阅读）、`party-panel.ts`（佣兵队伍）、`description-panel.ts`（说明框）、`save-board.ts`（存档槽）、`gm-panel.ts`（GM 面板）、`popup-panel.ts`（通用弹层）、`quest-popup.ts`（任务窗）、`volume-slider.ts`（音量条）。
- 控件与输入：`action-controls.ts`（动作按钮）、`keyboard-actions.ts`（键盘派发）、`move-stick.ts`（摇杆与十字键）、`key-binding-editor.ts`（键位编辑）、`control-layout-editor.ts`（布局编辑）、`control-layout-viewport.ts`（安全区换算）。
- 绘制与组件：`widgets.ts`（公共绘制与纹理键）、`solid-border.ts`（实心边框）、`round-band.ts`（圆角带）、`cooldown-fan.ts`（冷却扇形）、`native-message.ts`（原生提示）、`ui-asset-host.ts`（菜单图片预载）、`status-hud.ts`（队友状态）、`computer-skill-hud.ts`（电脑模式技能行）、`quest-text.ts`（任务文本）、`description-text.ts`（说明文本）、`modal-placement.ts`（弹层定位）。

## 规则

- 面板负责绘制和输入绑定；矩形、断行和滚动量从 `src/ui/` 的布局模块取，不在面板里另算一套。
- 字体、字号和颜色统一取 `src/ui/text-style.ts`，不写新的硬编码值。
- 每个面板按现有 `create`/`destroy` 结构成对实现，重新打开时复用同一套释放路径。
- 场景关闭时摘掉自己的监听、计时器和 tween，统一挂在 `shutdown` 或 `destroy` 上。
- 调试入口只收集点击，动作执行调用 `src/debug/gm-actions.ts`，不在面板里复制逻辑。
- **子页面用原版图框。** 强化台、合成台画在 `body` 的左右框里，背景用原版边框/底色；只有确认框用 `modal` 的 `drawNativeMessage`，不给整页铺黑色遮罩。
- **带边框的面板内部先按可滚动设计。** 属性、强化概率、宝石孔、配方材料这类内容会随数据变长，边框内不要假设固定高度一定放得下。用 `v.scroll` 给内部内容单独滚动，内容高度按实际底部计算；底部按钮和提示跟着内容下移，不要固定在会被长内容压住的位置。
- **边框内边距不能盖住内容。** `v.border` 先画，滚动内容和控件后画；内容的 `parent` / `guard` 要指向对应滚动区，坐标保持在边框内。不要把内容画到内边距的黑色底下面，也不要让滚动裁剪区吞掉按钮的点击。
- **面板动作后只调一次 `changed`。** 不要同时依赖会话通知和本地回调各重绘一次；`StoryUI` 在子页面打开时已跳过会话通知。

## 验证

```bash
npm run typecheck
npm test -- tests/control-layout.test.ts tests/native-message-layout.test.ts
```

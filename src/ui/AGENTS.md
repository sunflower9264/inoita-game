# src/ui

界面的布局、文本与接口层：算好矩形、断行、颜色和提示内容，交给 `src/ui/phaser/` 绘制。

## 文件

- 布局：`bag-layout.ts`（背包格位）、`choice-layout.ts`（选项竖排）、`control-layout.ts`（控件键位）、`item-layout.ts`（物品格与货币）、`shop-layout.ts`（商店两栏）、`quest-popup-layout.ts`（任务窗）、`description-text-layout.ts`（说明断行）、`text-layout.ts`（通用换行）、`viewport.ts`（画布缩放、安全区与参考分辨率）。
- 文本与样式：`text-style.ts`（共用字体）、`text-prompt.ts`（系统键盘输入）、`dialogue-text.ts`（对白分页、断行与逐字显示）、`item-detail-lines.ts`（物品说明行）、`skill-detail-lines.ts`（技能说明行）、`item-result-details.ts`（操作结果说明）、`enhancement-odds-lines.ts`（强化结果句与混沌结果表）、`item-name-color.ts`（品质颜色与装备格边框）、`character-values.ts`（角色数值）、`money-display.ts`（金额拆分）。
- 接口与交互：`game-ui.ts`（UI 能力与视图接口）、`story-ui.ts`（剧情与菜单 UI 的接口、页面枚举和提示文案）、`action-press-gate.ts`（动作按钮互斥）、`common-button.ts`（通用按钮素材）、`instant-message.ts`（屏幕提示）、`slot-frame.ts`（格子底图）。

## 规则

- 本目录只做布局、断行、格式化和提示内容；实际绘制在 `src/ui/phaser/`。
- 这里不运行时导入 `phaser`；需要 Phaser 类型时用 `import type`，写法参考 `story-ui.ts`。
- 文本宽度、换行、选项高度和滚动范围在进入 Phaser 前算完，绘制层只按结果摆放。
- 字体、字号和颜色取 `text-style.ts`，新面板不再另建一套字体栈。
- 新增面板先在这里补几何和文本函数，再在 `src/ui/phaser/` 实现绘制。
- **强化结果先写人话。** 普通卷轴写成「当前 +N：X% 到 +N+1，Y% 到 +N+2」；混沌卷轴写成三行结果表。概率文案统一由 `enhancement-odds-lines.ts` 生成，面板只负责画。
- **菜单子页面保留底层。** 强化台、合成台这类从菜单进入的子页面用 `page` 渲染在 `body` 上；`surface`/`body` 继续可见，只把说明层让位，不要隐藏整层再铺纯黑遮罩。
- **一次操作只重绘一次。** 子页面打开期间（如 `page==='forge'`）`bind` 的会话订阅跳过整页重绘；动作完成后由子页面面板的 `changed` 统一重绘一次。
- **说明面板动作行用文字按钮。** `renderItemDetail` 的动作统一走 `v.button(label, ...)` 的共用按钮皮肤；不再给动作塞 `item-equip`/`item-discard` 这类烘焙图。

## 验证

```bash
npm run typecheck
npm test -- tests/bag-layout.test.ts tests/choice-layout.test.ts
```

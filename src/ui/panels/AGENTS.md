# src/ui/panels

游戏菜单与弹出面板绘制层（纯 TypeScript + `UiSurface` / `src/ui/dom/`，不 import `phaser`）。

## 文件

- 功能面板：`forge-panel.ts`（强化台）、`skill-book-panel.ts`（技能书页）、`crafting-panel.ts`（合成台）、`shop-panel.ts`（商店与装备清理）、`quest-panel.ts`（任务阅读）、`party-panel.ts`（佣兵与剧情同伴队伍）、`gm-panel.ts`（GM 面板）、`save-board.ts`（存档槽列表）、`cloud-save-panel.ts`（云存档账号与同步页）、`quest-popup.ts`（正式对话/任务确认窗）。
- 设置与编辑：`control-layout-editor.ts`（触控布局编辑）、`key-binding-editor.ts`（键位绑定编辑）。
- 共用绘制、测量与弹层辅助：`bag-rail.ts`（背包/商店/合成/强化共用侧栏）、`description-panel.ts`（物品详情框与行绘制）、`description-text.ts`（`withSurfaceTextMetrics` 无 DOM 分配 2D Canvas 测宽与测试探针回退）、`quest-text.ts`（任务文本绘制）、`native-message.ts`（原生确认横带）、`popup-panel.ts`（通用弹层底框）、`round-band.ts`（圆角条）、`solid-border.ts`（实心边框）、`modal-placement.ts`（弹层居中、屏幕坐标与遮挡矩形计算）。

## 规则

- 本目录严禁 import `phaser`；界面绘制与输入全部走 `src/ui/widgets.ts`（`UiSurface`）、`src/ui/viewport.ts`（`controlViewport`）与 `src/ui/dom/`。
- DOM 文字收集通过显式 `writer`/`sink` 或 `domMode` 返回规格，禁止在宿主或调用方 monkey-patch `view.text` / `view.button`。
- 文本断行宽度优先通过 `withSurfaceTextMetrics` 调用 `UiSurface.measureText`，不在真实运行时临时创建和销毁测量文本节点。
- 弹层坐标换算与页面文字遮挡矩形统一使用 `modal-placement.ts`（`surfaceScreenPoint`、`modalOcclusionRect`、`bandOcclusionRect`、`transformModalTextSpec`）。

## 验证

```bash
npm run typecheck
npm test -- tests/native-message-layout.test.ts tests/shop-panel.test.ts tests/gm-quest-panel.test.ts
```

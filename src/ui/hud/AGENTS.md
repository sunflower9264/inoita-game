# src/ui/hud

游戏世界屏幕 HUD 的生命周期与 DOM 组件接线层（纯 TypeScript，不 import `phaser`）。

## 文件

- `scene-activity.ts`：`SceneActivity` 监听所属游戏场景的 `pause`/`resume`/`sleep`/`wake` 并驱动 DOM HUD 显隐（替代过去的常驻空转场景 `ControlsScene` 与 `rendering/hud.ts`）。
- `status-hud.ts`：主控者、队员、目标状态栏与 Buff 图标的 DOM 状态同步。
- `move-stick.ts`：触屏摇杆 / D-pad 与移动键映射。
- `action-controls.ts`：触屏攻击、快捷技能、消耗品与换组按钮生命周期。
- `computer-skill-hud.ts`：电脑模式六格只读快捷栏接线。
- `keyboard-actions.ts`：战斗快捷位与切换目标键盘动作路由，注册 `inputRouter` 的 `world` 作用域。
- `name-banner.ts`：区域进入名称横幅计时与 DOM 显隐。
- `story-minimap.ts`：世界小地图地形、任务与交互点接线。

## 规则

- 本目录严禁 import `phaser`；宿主生命周期通过 `SceneActivitySource`、`UiSceneHost` 与 `KeyboardSceneSource` 等最小接口传入。
- DOM 显示与指针处理复用 `src/ui/dom/`；控件尺寸、布局与视口取 `src/ui/control-layout.ts` 和 `src/ui/viewport.ts`。
- 键盘适配器注册在 `inputRouter` 的 `world` 作用域并在销毁时注销；所有监听器和计时器随 `destroy()` 成对清理。

## 验证

```bash
npm run typecheck
npm test -- tests/world-hud.test.ts tests/status-hud.test.ts tests/keyboard-actions.test.ts
```

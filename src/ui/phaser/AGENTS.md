# src/ui/phaser

真实依赖 Phaser 场景/画布的少数界面适配模块（仅保留这 3 个模块；其余纯 DOM 面板与 HUD 已迁至 `src/ui/panels/` 与 `src/ui/hud/`）。

## 文件

- `class-selection-view.ts`（职业选择页的场景背景、纹理过滤和加色选中层）。
- `live-character-preview.ts`（菜单角色预览的画布坐标换算、待机播放与外观持有）。
- `game-thumbnail.ts`（同一局共享画布截图）。

## 规则

- 本目录只放真正使用 Phaser API（纹理、对象、渲染器快照）的适配代码；纯 DOM 菜单面板放在 `src/ui/panels/`，世界 HUD 接线放在 `src/ui/hud/`。
- `live-character-preview.ts` 接收菜单的屏幕矩形，经 `screenRectToCanvas` 换算后在游戏画布上播放待机动作；给菜单遮罩留出的预览区域保持 CSS 坐标。切换页和关闭时销毁角色并由共用绘制层归还外观。
- `game-thumbnail.ts` 让同一局的存档共用一次画布截图。换局时结束旧请求，并清掉渲染器里还没执行的一次性快照回调；新的存档从下一次截到的画面开始使用。

## 验证

```bash
npm run typecheck
npm test -- tests/dom-surface.test.ts tests/game-thumbnail.test.ts
```

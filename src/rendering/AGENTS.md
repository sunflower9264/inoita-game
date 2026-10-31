# src/rendering

把 `domain` 的状态画到 Phaser 里：角色、地图、战斗表现和界面特效。

## 文件

- 角色/移动：`characters.ts`、`arcade-movement.ts`、`movement-world.ts`、`movement-interpolation.ts`、`character-visibility.ts`、`name-banner.ts`、`control-skin.ts`。
- 地图/资源：`map-layers.ts`、`map-assets.ts`、`prop-atlas.ts`、`scene-assets.ts`、`story-map-view.ts`、`story-minimap.ts`。
- 战斗表现：`combat-presenter.ts`、`combat-effects.ts`、`combat-feedback.ts`、`combat-outcomes.ts`、`combat-assets.ts`、`combat-asset-descriptors.ts`、`resident-combat-assets.ts`、`combat-visual-coverage.ts`、`buff-loop-renderer.ts`、`stun-stars.ts`、`status-color.ts`、`status-hud.ts`、`overhead-status.ts`。
- 剧情/HUD/其他：`story-presenter.ts`、`hud.ts`、`action-controls.ts`、`ground-loot.ts`、`pickup-messages.ts`、`wardrobe.ts`、`effects.ts`、`effect-animations.ts`、`effect-colors.ts`、`blend-modes.ts`、`webgl-recovery.ts`。

## 规则

- 本目录只读取 `domain` 状态并绘制，规则变化和存档写入留在 `domain` 与 `application`。
- 动画名用游戏概念：`walk-east`、`idle-south`，不拼接帧号或方向偏移。
- 沿用现有纹理、depth、filter 的组织方式；Phaser 4 写法以 `.agents/skills/` 和 4.2.1 文档为准。
- 性能敏感的改动先读 `docs/performance.md`，再决定是否新增对象或逐帧逻辑。

## 验证

- `npm run typecheck`：类型检查覆盖本目录。
- `npm test -- tests/buff-loop-renderer.test.ts`：状态图标循环表现。

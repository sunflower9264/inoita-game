# src/scenes

Phaser 场景层：驱动生命周期、转发输入，把 domain、rendering、ui 的能力接起来。游戏规则不属于这里。

## 文件

- `world-scene.ts`：主世界，负责地图加载、角色移动、镜头与地图内交互。
- `world-combat.ts`：世界内战斗的装配与更新，把战斗规则接到场景表现。
- `story-stage-scene.ts`：剧情舞台，承接对白、选项和演出期间的输入锁定。
- `menu-scene.ts`：标题与主菜单，含存档槽入口。
- `story-class-scene.ts`：新游戏的职业选择与角色预览。
- `formal-ui-scene.ts`：正式 UI 场景，承载 HUD、背包装备、商店等菜单面板。
- `audio-scene.ts`：音频设置页；跨场景常驻，切换场景不打断播放。
- `controls-scene.ts`：操作设置页，键位与控件布局。
- `animation-debug-scene.ts`：`?animation-debug` 进入的动画调试场景。
- `ui-debug-scene.ts`：`?ui-debug` 进入的面板调试场景。

## 规则

- 场景只驱动生命周期、转发输入、调度下层模块；判定和数值规则写进 `src/domain/`，具体绘制交给 `src/rendering/` 与 `src/ui/phaser/`。
- 场景键从 `SCENE_KEYS`（`src/application/scene-keys.ts`）取，构造、查找、启动都用它，不写裸字符串。
- 新增场景在 `src/main.ts` 注册，并接上对应模式与 URL 参数的启动分支。
- 跨场景状态通过 `src/application/ports.ts` 的能力接口传递，不挂全局变量或模块级可变状态。
- 场景 `shutdown` 时解绑输入、计时器和 tween，避免重启后重复触发。

## 验证

```bash
npm run typecheck
npm test -- tests/scene-assets.test.ts
```

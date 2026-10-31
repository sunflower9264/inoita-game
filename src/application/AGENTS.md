# src/application

能力接口与适配层：把 `domain` 的纯规则接到 Phaser、浏览器和磁盘。

## 文件

- 端口/场景键/事件：`ports.ts`（能力接口）、`scene-keys.ts`（场景键）、`ui-events.ts`（界面事件名）、`entry-loading.ts`（入口加载与继续进度）、`entry-plan.ts`（入口计划与地图资产）、`menu-images.ts`（标题与菜单图片分组）。
- 内容加载与校验：`content-loader.ts`（内容加载器）、`content-validation.ts`（内容字段校验器）、`content-relations.ts`（引用关系校验）、`content-hash.ts`（规范化 JSON 与内容摘要）、`content-trust.ts`（构建期信任开关）、`story-performance-validation.ts`（剧情演出校验）、`story-reference-validation.ts`（剧情引用校验）。
- 存档/迁移/自动保存：`saved-game.ts`（存档格式与升级链）、`saved-game-loader.ts`（存档读取与取消）、`auto-save.ts`（自动保存节流与重试）、`quest-item-grants.ts`（任务物品净发放与溢出）。
- 资源/版本：`assets.ts`（素材池与租约）、`asset-version.ts`（素材与内容版本号）。
- 设置/控制：`control-settings.ts`（操作模式设置）、`control-state.ts`（操作状态与游戏模式）、`display-settings.ts`（显示偏好）、`key-bindings.ts`（键位偏好）、`fullscreen.ts`（全屏与横屏锁定）。
- Phaser/浏览器适配：`game-audio.ts`（音频适配）、`game-timing.ts`（帧时钟适配）、`game-diagnostics.ts`（诊断上报适配）、`browser-compat.ts`（浏览器 API 兼容补丁）。

## 规则

- 新能力先在 `ports.ts` 定义接口，由 `src/app.ts` 在启动阶段注入实现。
- 场景通过 ports 取素材、音频和浏览器能力，加载与 API 调用留在本目录。
- 只有 `game-audio.ts`、`game-timing.ts`、`game-diagnostics.ts` import Phaser，其余文件保持纯 TypeScript。
- 改存档结构或校验口径时，把 `src/domain/save-game.ts` 的 `SAVE_FORMAT` 加一，并在 `saved-game.ts` 的升级链补旧版到新版的迁移和旧档测试。
- 内容加载与构建共用 `content-validation.ts` 的校验器，新增内容字段先在这里定校验口径。

## 验证

- `npm test -- tests/saved-game.test.ts`：存档迁移与旧档读取。
- `npm test -- tests/content-loader.test.ts`：内容加载与校验。

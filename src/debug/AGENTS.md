# src/debug

调试能力层：GM 动作、调试开关、剧情跳转和无渲染回放。Node 与浏览器共用这里的实现。

## 文件

- `gm-actions.ts`：GM 动作的唯一实现，面板、`globalThis.gm` 和无头回放都调它。
- `gm-mode.ts`：GM 模式开关的本地持久化，默认关闭。
- `headless-story.ts`：无渲染剧情回放，按内容与命令推进剧情。
- `story-jump.ts`：剧情跳转，定位任务与事件现场。
- `catalog-validation.ts`：调试目录校验，检查现场表引用的地图、任务和事件。

## 规则

- GM 动作只在 `gm-actions.ts` 实现一次；Phaser 面板和无头回放都调用同一入口，不各写一份。
- 剧情、任务和事件 ID 是存档引用，跳转与回放只读取这些 ID，不改名、不重新编号。
- 本目录不导入 Phaser，保持能在 Node 下直接运行和测试。
- 内容改动后运行 `npm run debug-start` 重新生成 GM 任务现场表；提交前用 `npm run debug-start:check` 检查是否过期。

## 验证

```bash
npm run debug-start:check
npm test -- tests/gm-scene.test.ts tests/story-debug-start.test.ts
```

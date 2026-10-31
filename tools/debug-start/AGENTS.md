# tools/debug-start

生成 GM 任务现场表（调试用的剧情起点快照），并按任务和条件求解可复现的调试现场。

## 文件

- `story-debug-start.ts`：现场表生成器，读取 `public/content` 与 `data/`，写入 `public/content/debug/start.json`，支持 `--write` 和 `--check`。
- `debug-solver.ts`：调试现场求解器，用无头剧情运行时计算任务起点、上下文和缺口。
- `data/`：6 份生成 JSON，作为求解输入：`data/source-map.json`、`data/story-debug-contexts.json`、`data/story-debug-evidence.json`、`data/story-debug-order.json`、`data/story-debug-routes.json`、`data/story-scripts-draft.json`。

## 规则

- 内容改动后运行 `npm run debug-start` 重新生成现场表；提交前用 `npm run debug-start:check` 检查是否过期。
- 生成器读取内容定义并调用领域函数；游戏规则只在 `src/domain/` 维护一份。
- `data/` 与 `public/content/debug/start.json` 都是生成物，需要更新时重新生成，不手改。
- 生成结果保持稳定排序，避免无意义的 diff。

## 验证

```bash
npm test -- tests/story-debug-start.test.ts
npm run debug-start:check
```

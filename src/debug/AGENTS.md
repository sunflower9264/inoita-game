# src/debug

调试能力层：GM 动作、调试开关、剧情跳转和无渲染回放。Node 与浏览器共用这里的实现。

## 文件

- `gm-actions.ts`：GM 动作的唯一实现，面板、`globalThis.gm` 和无头回放都调它。
- `debug-marks.ts`：持久标记的摘要、现场正文与数据库能力接口。
- `gm-mode.ts`：GM 模式开关的本地持久化，默认关闭。
- `headless-story.ts`：无渲染剧情回放，按内容与命令推进剧情。
- `story-jump.ts`：剧情跳转，定位任务与事件现场。
- `catalog-validation.ts`：调试目录校验，检查现场表引用的地图、任务和事件。

## 规则

- GM 动作只在 `gm-actions.ts` 实现一次；Phaser 面板和无头回放都调用同一入口，不各写一份。
- 人物页的「技能全满」调用 `maxSkills`：主角拉满本职业技能（未学的也学会）；佣兵学会本职业全部技能，并升到该技能伙伴成长表的最高等级（没有伙伴成长表时用普通表长度）。不扣技能点、不改变角色等级，执行后发一次会话通知。
- 剧情、任务和事件 ID 是存档引用，跳转与回放只读取这些 ID，不改名、不重新编号。
- GM 的诊断上报地址从 `application/endpoints.ts` 取，不在 `gm-actions.ts` 里写默认域名。
- 本目录不导入 Phaser，保持能在 Node 下直接运行和测试。
- 内容改动后运行 `npm run debug-start` 重新生成 GM 任务现场表；提交前用 `npm run debug-start:check` 检查是否过期。

## 验证

```bash
npm run debug-start:check
npm test -- tests/gm-scene.test.ts tests/story-debug-start.test.ts
```

- 控制台通过 `consoleGmActions` 使用异步持久标记；正文只在恢复时读取，分页只读摘要。保存事务完成后返回成功，写入失败保留旧标记。
- 恢复持久标记先保留正式会话与世界现场，暂停正式保存；任务标记还保留任务返回点。退出先返回任务原点，再退出标记现场恢复正式进度。失败保持原局或保留可重试返回点。
- 会话关闭时调用 `GmActions.dispose()`，中止在途恢复并释放订阅、计时器和本局标记引用。
- 剧情预览和跳转持有调试现场表直到操作结束，关闭调试界面不会中断进行中的操作。

- 持久标记恢复先通过装配方的独立候选校验，再进入导演切换锁；会话销毁后丢弃迟到结果，正在恢复或退出时拒绝重复退出。

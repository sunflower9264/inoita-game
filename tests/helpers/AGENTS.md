# tests/helpers

剧情测试的共用驱动：自动推进剧情路线、装配剧情舞台，避免每个用例重复搭场景。

## 文件

- `story-playthrough.ts`：剧情自动跑图驱动，导出无头内容 `headlessContent` 和入口 `playthrough`，用 StoryDirector 沿路线推进。
- `story-stage.ts`：剧情舞台测试装配，导出 `stageSnapshot`，把舞台状态整理成快照供断言使用。

## 规则

- 剧情用例优先复用这两个驱动，不复制内容加载、舞台搭建和 Phaser 短路代码。
- 驱动保持确定性：用注入的时钟、固定内容和显式输入推进，不依赖真实计时器、渲染或随机数。
- 这里只做装配和驱动；游戏规则调用 `src/domain/` 的导出函数，不在此另写一份。
- 扩展驱动时保持已有调用方式稳定，新能力通过可选参数加入。

## 验证

```bash
npm test -- tests/story-runtime.test.ts
npm test -- tests/story-playthrough-rewards.test.ts
```

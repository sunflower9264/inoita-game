# tests/support

测试共用的驱动、替身与内容夹具：驱动一帧动作派发、提供不进行真实渲染的假精灵，并把只服务测试的剧情编译与文本工具收在这里。

## 文件

- `combat-driver.ts`：战斗测试驱动器，导出 `dispatchFrame` 和 `playCombat`，用领域 CombatRuntime 与 CombatActionDispatcher 向测试桩派发动作。
- `fake-sprite.ts`：假 Sprite，只实现生产代码用到的链式调用面，避免启动真实渲染。
- `story-fixtures.ts`：剧情与文本测试夹具，导出 `compileScript`、`storyScriptActions` 和 `plainText`；这些工具只被测试使用，不进入生产导出。

## 规则

- 替身只实现用例实际调用的成员；需要记录数值的用例在本地覆写，不把记录行为加进共用基类。
- 假对象保持无副作用：不写存档、不发网络请求、不改全局状态。
- 战斗驱动用显式时钟和候选人列表推进，随机行为由用例用固定种子或显式输入约束，同一输入回放结果一致。
- 新增共用成员时覆盖各用例重合的链式方法，让生产代码多调一个方法时在共用替身上暴露。

## 验证

```bash
npm test -- tests/combat-runtime.test.ts
npm test -- tests/skill-unit-runtime.test.ts
```

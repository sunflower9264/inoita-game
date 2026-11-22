# 已知问题与未完成工作

本文件记录当前已知、尚未修复的问题和未完成的设计。完成一项就删掉对应条目，不保留墓碑。

## 旧战斗测试的既有基线失败

**状态**：8 个用例失败，都是测试替身缺口，不是当前运行时代码的行为错误。

**复现**：

```bash
node --test $(grep -l "world-combat.ts" tests/*.test.ts)
```

当前结果：799 项中 791 通过、8 失败。失败分布在：

- `tests/firestorm.test.ts`
- `tests/sniping.test.ts`
- `tests/state-host.test.ts`
- `tests/target-status.test.ts`

**原因**：这些测试的假场景没有实现 `WorldCombat` 构造函数后来新增的实例字段或方法，例如 `equipmentEffectsCache`、`roster.isPresent`、`releaseEnemyState`。对应引入提交是 `65368bc6`、`456a5c67`、`394d2d3e`。

**处理方向**：按共享接口变化同步补齐假场景的字段和方法，不改断言。修好后删除本节。

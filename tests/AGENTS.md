# tests

单元测试与独立构建验收。404 个平铺的 `*.test.ts` 覆盖剧情、战斗、任务、地图、存档和界面规则；`standalone.mjs` 负责独立安装与构建验收。

## 文件

- `tests/*.test.ts` 全部平铺在根目录，按模块前缀命名：`story-*` 65 个最多，其次 `combat-*`、`quest-*`、`world-*`、`skill-*`、`action-*`。找用例先按前缀匹配，例如 `tests/combat-*.test.ts`、`tests/story-*.test.ts`。
- `standalone.mjs`：独立安装、类型检查和构建验收，对应 `npm run test:standalone`。
- `helpers/`、`support/`、`fixtures/`：测试驱动、替身和固定数据，不是测试入口。

## 规则

- 测试入口平铺在 `tests/*.test.ts`；`tools/test.ts` 只接受该目录下的 `.test.ts` 文件，传目录或其他扩展名会被拒绝，不带参数时打印用法并退出。
- 共享接口或绘制方法变了，同步更新测试里的假对象（如 `tests/shop-panel.test.ts` 的 `Surface`），让它实现被测代码实际调用的方法。
- 单文件用 `npm test -- tests/foo.test.ts`，它先跑类型检查再用 `node:test` 执行；全量 `npm run test:all` 只在用户明确要求时运行，独立构建验收用 `npm run test:standalone`。
- Node 直接执行 `.ts`，只写可擦除语法：不用 `enum`、`namespace` 和构造函数参数属性。
- 用例验证可观察的行为和分支规则；实现重构不应迫使断言改写。
- 验证不自行启动浏览器或 headless Chrome；每个独立修复在相关检查通过后单独提交，说明写清行为和验证结果。

## 验证

```bash
npm test -- tests/combat.test.ts
npm run test:standalone
```

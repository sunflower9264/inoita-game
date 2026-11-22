# src/generated

构建期生成的图集索引：把素材和图集 JSON 的路径映射成纹理键，供加载与绘制读取。

## 文件

- `icon-atlas.ts`：菜单图标图集的文件、数据与帧信息。
- `prop-atlas.ts`：场景道具图集页与按键索引。
- `effect-atlas.ts`：战斗与剧情特效图集页。
- `ui-atlas.ts`：界面图集页。
- `character-atlas.ts`：角色动作图集页与逐帧页号索引。

## 规则

- 五个文件都由脚本生成：`npm run atlas:icons`、`atlas:props`、`atlas:effects`、`atlas:ui`、`atlas:characters`；不手改。
- `npm run atlas:all` 按 icons → props → ui → effects → characters 的顺序全部重生成；`npm run build` 的 `prebuild` 会自动执行它。
- 素材或图集 JSON 变化后重新运行对应脚本，再提交生成结果。
- `npm run typecheck` 保证生成文件的类型与引用可编译；图集新鲜度、哨兵帧和内容引用由 `npm run validate:content` 检查，帧映射由对应 atlas 测试覆盖。
- 消费方使用导出的常量和映射取纹理键，不自己拼资源路径。
- 文件内容是紧凑编码（编码器见 `tools/atlas-codegen.ts`）：页表里按页号能推出的 `key`/`file`/`data` 只写一次模板，其余字段写成元组；逐文件映射按目录合行（`目录|名字,字段…`），逐帧页号写成 `页号*连续帧数`。模块加载时由文件内的几行解码器还原成与原先完全相同的对象（键顺序也一致），导出名和类型不变。这样主包少约 570 KB。
- 新增图集先改 `tools/` 里的生成脚本，再由脚本产出本目录文件。
- 剧情职业演员的 `previewActor`/`playerActor` 及其全部 `clips`（含默认攻击）随 `sourceActors` 收集，四向动画按演员自身的原版动画行生成。

## 验证

```bash
npm run typecheck
npm test -- tests/icon-atlas.test.ts tests/prop-atlas.test.ts tests/effect-atlas.test.ts tests/ui-atlas.test.ts tests/character-atlas.test.ts
```

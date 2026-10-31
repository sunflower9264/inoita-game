# src/generated

构建期生成的图集索引：把素材和图集 JSON 的路径映射成纹理键，供加载与绘制读取。

## 文件

- `icon-atlas.ts`：菜单图标图集的文件、数据与帧信息。
- `prop-atlas.ts`：场景道具图集页与按键索引。
- `effect-atlas.ts`：战斗特效图集页。
- `ui-atlas.ts`：界面图集页。

## 规则

- 四个文件都由脚本生成：`npm run atlas:icons`、`atlas:props`、`atlas:effects`、`atlas:ui`；不手改。
- 素材或图集 JSON 变化后重新运行对应脚本，再提交生成结果。
- 生成文件参与类型检查；图集数据缺失或帧名不匹配会在 `npm run typecheck` 暴露。
- 消费方使用导出的常量和映射取纹理键，不自己拼资源路径。
- 新增图集先改 `tools/` 里的生成脚本，再由脚本产出本目录文件。

## 验证

```bash
npm run typecheck
npm test -- tests/icon-atlas.test.ts tests/prop-atlas.test.ts tests/effect-atlas.test.ts tests/ui-atlas.test.ts
```

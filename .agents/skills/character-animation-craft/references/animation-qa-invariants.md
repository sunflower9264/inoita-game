# 动画像素级几何验收与防回归手册

> 标杆用例：`tests/warrior-viewer.test.ts`（长枪样板全套像素几何回归测试）。

仅靠肉眼看单帧容易漏掉「换件重甲就缺手臂」「切无披风佣兵北向裆部漏枪把」「某帧武器偷偷 `scaleY=-1`」「高频连刺头部逐帧抽搐」等问题。每次改动画或加新技能，按本手册做「自动体检 + 目检对照」两步闭环。

## 1. 一键自动化像素体检

运行技能内置体检脚本：

```bash
node .agents/skills/character-animation-craft/scripts/inspect-animation-quality.ts \
  --prototype tools/warrior-viewer/prototypes/spear/spear-prototype.json
```

需要逐动作明细时追加 `--verbose`。

## 2. 十项量化动画质量标准

| 编号 | 检查项 | 合格标准 | 典型回归症状 |
|---|---|---|---|
| 1 | 武器正向顶光 | 全部姿态中武器部件 `scaleY === 1` | 反斜切片借用翻转导致高光在底部、软饰倒翘 |
| 2 | 同平面武器长度一致 | 同平面全长切片最大像素跨度集中在统一窄区间（如长枪 `50.0..53.0px`） | 某招式切片突然拉长变“橡皮筋” |
| 3 | 骨骼干净度 | 手臂 `coat-front[3..14]` 全帧 `angle === 0`；禁用 `coat-front[15]`；无 `coat-front[5] (y < -30)` 悬空手 | 背后翘起怪手、刺客猫背、头顶残手 |
| 4 | 战斗下盘不踏步 | 非 `walk-*`/`town-walk-*` 招式绝不含走路腿 `coat-back[7..10]` | 出招时脚下像在原地小跑 |
| 5 | 多外观兼容 | 抽样多套盔甲（`body`）、多款头饰（`head`）与无披风佣兵（`mercenary-olaf`）全部帧有效解析 | 换装备后缺手臂、缺头盔或报错 |
| 6 | 头脸同步与防抖头 | `head-front`/`head-back`/`body` 切片按 `HEAD_VIEW_PIECES` 配对且 `(x, y, scaleX)` 严格一致；非旋转战斗招式锁本向不转向、南北向 `head.x === 0`、方向反转 `<= 2`（多段连刺 `<= 3`） | 脸和头发错位、逐帧啄木鸟抖头、南向低头埋胸 |
| 7 | 原地招式脚心稳定 | 原地施放技能全帧 `coat-back` 脚心 `|cx| <= 2.5px`、水平漂移 `<= 3.5px`、纵向漂移 `<= 4px` | 原地放技能时角色脚底滑步 |
| 8 | 北向裆部零漏武器 | 北向战斗帧（含无披风外观）逐像素扫描 `x ∈ [-4, 4], y ∈ [-8, 24]`，顶层武器像素数 === `0` | 背身打怪时双腿缝里戳出一截枪把 |
| 9 | 手与武器像素贴合 | 战斗帧手臂像素包络与武器像素最小距离 `<= 4px`；日常单手平提握位 `42%..53%` 且空手净空 `>= 3.0px`；长杆突刺/聚气手掌 `0%..55%`、南向双拳间距 `>= 10%` | 武器悬空脱手、叠拳、手握到红缨/刃口 |
| 10 | 特效与震屏体检 | 特效图宽高 `<= 4096px`；横扫光弧峰值质心偏正方向 `<= 4°~5°`；柔光罩 `base` 层 `R>=160, G>=220, A<=90` 且末帧不内缩；全职业震屏总数克制（建议 `<= 2`） | WebGL 纹理爆尺寸、灰底黑塑料框、横扫光歪斜、全屏晕震 |

## 3. 在 `tests/warrior-viewer.test.ts` 固化专属防回归

针对某武器特有的关键招式（例如长枪的 180° 东西横扫跨度、~19° 窄 J 上挑弧、单手黄金重心比例、三幕大招护罩渐隐），把断言追加进 `tests/warrior-viewer.test.ts`：
- 渲染像素验证优先直接读取已导出的 `parts.png` / `effects.png` 与 `wardrobe.json` 的 `parts-0.png` / `parts-1.png`，用纯 Node + `pngjs` 做逐像素坐标投影（毫秒级跑完，零浏览器依赖）；
- 坐标换算公式与游戏运行态 `OutfitPool` 完全一致：
  ```ts
  const rad = (part.angle * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const wx = part.x + (sx - sprite.anchorX) * part.scaleX * cos - (sy - sprite.anchorY) * part.scaleY * sin;
  const wy = part.y + (sx - sprite.anchorX) * part.scaleX * sin + (sy - sprite.anchorY) * part.scaleY * cos;
  ```

## 4. `warrior-viewer` 人工目检清单

在 `http://localhost:4003/tools/warrior-viewer/index.html?weapon=<prototypeWeaponId>` 验收时，依次切换：
1. **三背景对照**：浅灰底（揪半透明暗边/黑框）、深色底（看 `add` 发光层次）、草地底（看实战辨识度）；
2. **四外观对照**：默认主角、一款重甲（检查手臂颜色与肩窝衔接）、一款全罩头盔（检查头脸同步与北向背枪穿模）、无披风佣兵奥拉夫（检查北向裆部是否漏武器）；
3. **空格暂停 + 左右键逐帧**：重点盯起势→命中帧→收招衔接与出光帧位置，确认无突兀跳帧。

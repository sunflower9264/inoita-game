# 宝石与强化卷轴：现状、原版调查与「装备强化台」改造交接

> 快照：2026-10-31，HEAD `3e17ff2`。仓库 `/Users/wangjr/Desktop/workspace/inoita-game`。
> 用途：交给下一个 agent/工具直接开工。**已确认的大方向是 A：装备优先的强化台**；文中标「建议」的界面细节还没逐条和用户确认。

## 0. 先看结论

- **现在的问题不是规则，是入口和反馈。** 玩家必须先从背包点卷轴/宝石，再点说明底部的「使用」，然后在背包里找一件亮起来的装备，最后结果只闪 1.8 秒。一次强化三步，失败原因还被提前过滤掉，宝石镶上就再也拿不下来。
- **原版没有宝石取出/替换。** 原版 `ITEMSYSTEM_PutJewel` 只把宝石节点挂到装备的宝石列表尾部、把已用孔数 +1；导出函数里没有 RemoveJewel/TakeJewel/Extract；配方里也没有取出配方。复刻要加取出，属于新增设计，必须明确标注，不要让玩家以为是原版功能。
- **建议改成装备优先的「强化台」。** 从装备说明进入，左边是这件装备的 `+N`、剩余耐久、孔位和当前属性，右边是强化/镶嵌/净化三个页签。强化页列出所有能用的卷轴（成功率、为什么不能用），点一行立即结算、原地刷新，可以连续点；镶嵌页点孔位选宝石、预览后确认，已镶的孔可以取出或替换。
- **不需要改存档格式。** 每颗宝石在生成时恰好掷 1 条词条，`numbers.gemModifiers[i]` 与 `gems[i]` 一一对应；取出时把这条词条写回新宝石实例即可。`SAVE_FORMAT` 仍是 38。
- **旧入口要删干净。** `applying`、`beginApply`、`hasApplyTarget`、`canApplyTarget`、`applyItem` 都不要再保留第二套入口；`NON_MENU_USE_KINDS` 只留作 `beginOperation` 的防呆，避免宝石/卷轴在调试页打开普通使用弹窗。

## 1. 用户要什么（按时间）

- m00001：「来优化宝石、强化卷轴的使用，你看下当前是什么逻辑？」——先讲清现状，再优化。
- m00255：「不是，让你说下什么逻辑，不是让你直接改啊，因为现在的交互本来就很垃圾，你不设计一下就动手吗」——先设计，不要直接改。
- m00290：「走A吧，现在点击宝石根本有没有说明，刚好不走点击宝石用镶嵌这种逻辑了。取出和替换宝石，你看下原版咋做的，原版分析在上级目录的inotia文件夹下。你可以多开子agent协助你」——选 A；宝石不再从「点宝石→镶嵌」进入；要按原版确定取出/替换。
- m00504：「把当前已知的信息，输出到一个文档中，我换个agent工具去做」——本文就是这份文档。

原版分析实际在 `/Users/wangjr/Desktop/workspace/inoita`（用户写的 `inotia` 是笔误）。

## 2. 现在怎么运作

### 2.1 规则层（数值）

| 对象 | 现状 |
|---|---|
| 强化卷轴 | 12 张：低级/中级/高级/顶级 × 武器/防具，加特级武器/特级防具、混沌武器/混沌防具。卷轴可堆叠。 |
| 使用一次 | 普通卷轴扣装备 1 点「强化耐久度」；装备通常 3~13 点，少数固定 12/15（content 里的 `fixedEnhancementUses`）。 |
| +1 与 +2 | 普通卷轴先用一次必定 +1；随后再掷一次「大成功」，通过则 +2（提示 `enchant-double`）。 |
| 上限 | `MAX_ENHANCEMENT_LEVEL=30`，到 30 后不能再强化。 |
| 等级门槛 | 卷轴 `use.maxLevel`：低级 33、中级 66、高级 99、顶级/特级/混沌 0（0 = 不限）。装备等级高于 `maxLevel` 时显示「等级不符。」 |
| 家族锁定 | 装备第一次吃哪张卷轴，就记住那一族；之后换别的族会被「与一般的强化卷轴不同。」挡住。现有代码允许旧卷轴不是混沌、且新旧 `maxLevel` 都为 0 时互换（顶级/特级/混沌之间），混沌还要求耐久 0；不是只限顶级↔特级。 |
| 混沌卷轴 | `requiresEnhanced:true`。要求装备至少 +1、且「强化耐久度」正好 0；不消耗耐久；先掷一次失败判定，失败降 1 级，成功后才进入 +1/+2 判定。 |
| 宝石 | 5 种（低/中/高/顶级/混沌），`stackable:false`，每个实例生成时随机 1 条词条，词条颜色 `#bf0000`。 |
| 宝石孔 | 装备生成时 80% 概率有孔，按 35/30/20/15 权重给 1~4 孔，受 `socketLimit` 限制；`numbers.sockets` 存总孔数。 |
| 镶嵌 | 只能镶进 `!locked` 的装备；已用孔数达到 `numbers.sockets` 时「宝石孔不足。」；镶上后词条永久生效，当前没有取出/替换。 |
| 净化 | `jewel-of-catharsis`（净化之宝石），`use.kind='purify'`；只能对 `numbers.chaos` 存在的装备使用，清掉混沌，保留强化/耐久/宝石/普通词条。 |

### 2.2 三个概率公式

代码在 `src/domain/character-stats.ts`：

```ts
// 392-396
function enhancementSucceeds(random:()=>number, threshold:number):boolean {
  return 1 + Math.floor(random() * ENHANCEMENT_ROLL_MAX) < Math.trunc(threshold);
}
```

`ENHANCEMENT_ROLL_MAX=998`，所以概率是 `(trunc(threshold)-1)/998`，上限 `997/998`。

- 普通卷轴的 +2 判定：`threshold = 1500 / (raised + 5) + bonusChance`，`raised = 当前强化等级 + 1`。+0 时约 25%，+20 时约 5.6%；特级卷轴 `bonusChance=300`，+0 时约 55%。
- 混沌卷轴的失败判定：`threshold = 50000 / (10 + level*level)`。+0 时必定通过，+10 时约 45%，+20 时约 12%，+30 时约 5%。失败返回 `level-1`，并且不再掷 +2。
- 耐久初始值：`random(min,max) + random(min,max) + 1`，内容里 `importance` 对应的 `[1,1]` 得 3 点；`[1,6]` 得 3~13 点。

### 2.3 一次使用的完整路径（现状）

1. 背包里点卷轴、宝石或净化石 → `StoryUI.selectItem` 打开说明面板。
2. 说明底部 `bagMenu` 根据 `use.kind` 出现「强化/镶嵌/净化」按钮，点它调用 `beginApply(id)`。
3. `beginApply` 用 `hasApplyTarget` 扫全部已穿戴 + 背包物品，找 `canApply && !applicationProblem` 的目标：
   - 一个都没有 → `showInstant('没有可以使用的装备。')`，结束。
   - 有 → `applying=id`、底栏「点选要使用的装备」、可用目标叠 `inventory-selected` 高亮。
4. 点目标 → `applyItem` → `bag.use(source,target)`：
   - `bag.use` 先算 `rules.enchant(source,target,random)`，再 `rules.applyUse` 写耐久/词条，最后 `consume` 扣道具。
   - 强化结果写 `entry.enhancement`；镶嵌写 `entry.gems.push(source.item)`，词条由 `applyUse` 推进 `numbers.gemModifiers`。
5. `applyItem` 用 `showInstant(result.notice ? itemMessages[notice] : result.message)` 显示结果；`ItemApplicationError` 也走 `showInstant`；然后 `applying=undefined`、清底栏、重画。
6. 点到「类型对但被规则挡住」的目标（比如宝石镶满孔的装备）：`canApplyTarget` 为 false，`selectItem` 把 `applying` 静默清掉并打开那件装备的说明，**不解释原因**。

### 2.4 玩家实际遇到的七个问题

1. 每个动作至少三步（点道具 → 点「使用」 → 点装备），没有连续使用；一件装备通常 3 次耐久，就要重复三遍。
2. 可点击目标被 `hasApplyTarget` 提前过滤：只要有目标可用，就进入选目标态，失败原因（耐久不足、等级不符、卷轴家族不符、孔满）根本轮不到显示。
3. 选目标时看不到装备的剩余耐久、孔数、当前 `+N`，只能凭记忆挑装备。
4. 宝石一镶就消耗，没有预览、没有确认、没有取出；镶错了只能认。
5. 只能从道具进；不能先看装备再决定用哪张卷轴/哪颗宝石。
6. 结果只闪 1.8 秒（`INSTANT_MESSAGE_MS=30*LOGIC_FRAME_MS`，`LOGIC_FRAME_MS=60`），单槽文本，后一条覆盖前一条；连续使用时看不到上一手发生了什么。
7. 12 张卷轴和 4 种宝石的说明还写着「拖动到装备上」，拖拽路径已经被删除；`chaos-jewel` 的说明是空的。玩家按说明做，做不了。

### 2.5 内容与存档现状

- `public/content/items.json` 是 `{ items: { <id>: ItemDefinition }, ... }`，共 998 条。
- 14 个物品仍写着拖动文案：
  - 10 张卷轴：`novice/standard/advance/supreme` × `weapon/armor`，加 `sp-weapon-enhance-scroll`、`sp-armor-enhance-scroll`。
  - 4 种宝石：`novice-jewel`、`standard-jewel`、`advanced-jewel`、`supreme-jewel`。
  - `chaos-weapon-scroll`、`chaos-armor-scroll`、`chaos-jewel` 没有拖动句；`jewel-of-catharsis` 只写「初始化混沌道具或深渊混沌道具。」
- 662 件装备：107 件 `enchantable:false`，26 件 `socketCapacity:0`，全部 662 件 `socketLimit>0`。
- 耐久分布：`[1,1]` 138 件、`[1,2]` 90、`[1,3]` 81、`[1,4]` 114、`[1,5]` 126、`[1,6]` 22；固定 12 的 79 件、固定 15 的 6 件。
- `src/domain/save-game.ts`：`SAVE_FORMAT=38`，`LEGACY_SAVE_FORMATS=[37,36,35,34,33]`；`src/application/saved-game.ts` 的 `SAVE_UPGRADES` 逐版迁移。存档里没有单独的宝石结构，宝石就是 `entry.gems: string[]` + `entry.numbers.gemModifiers: Modifier[]`。
- **旧档风险**：`saved-game.ts` 里没有 `gemModifiers` 的迁移；`verifyBagState` 也不检查 `gemModifiers.length === gems.length`。新方法必须对 `undefined`/长度不匹配做 guard，不能直接下标访问。

### 2.6 关键代码位置

| 文件 | 位置 | 内容 |
|---|---|---|
| `src/ui/story-ui.ts` | 79 | `NON_MENU_USE_KINDS`（保留作 `beginOperation` 防呆） |
| 同上 | 81 | `interface BagMenuAction` |
| 同上 | 1019 | `renderBag` |
| 同上 | 1111 | `selectItem` |
| 同上 | 1118 | `beginApply` |
| 同上 | 1125 / 1130 | `hasApplyTarget` / `canApplyTarget` |
| 同上 | 1135 / 1166 | `renderItemDetail` / `renderGmItemDetail` |
| 同上 | 1155-1160 | 说明底部操作行 |
| 同上 | 1192 | `bagMenu` |
| 同上 | 1209 / 1210 | 普通使用按钮 / 道具应用按钮 |
| 同上 | 1226 / 1236 | `beginOperation` / `applyItem` |
| 同上 | 183-200 | `sync` |
| 同上 | 299 | Esc 分支 |
| 同上 | 410 | `renderNow` |
| `src/domain/bag.ts` | 13-23 | `BagRules` |
| 同上 | 399-408 | `canApply` |
| 同上 | 409-419 | `applicationProblem` |
| 同上 | 420-424 | `targetProblem` |
| 同上 | 432-488 | `use` |
| `src/domain/character-stats.ts` | 105-113 | 概率常量 |
| 同上 | 247-257 | `enchant` 回调 |
| 同上 | 258-267 | `applyUse` |
| 同上 | 359-367 | `initializeItem` |
| 同上 | 368-387 | `targetProblem` |
| 同上 | 392-396 | `enhancementSucceeds` |
| 同上 | 398-415 | `rollEquipmentNumbers` |
| `src/ui/item-detail-lines.ts` | 14-26 / 30-91 | 颜色 / `itemDescriptionBody` |
| `src/ui/bag-layout.ts` | — | `DESCRIPTION_PANEL`、`descriptionPanel`、`bagLayout` |
| `src/ui/phaser/widgets.ts` | 136-178 | `button`（无图文字按钮） |
| 同上 | 274+ | `ScrollArea` |
| `src/ui/phaser/modal-placement.ts` | 14 | `centerModal` |

## 3. 原版（Inotia）调查：宝石能不能取出？

分析在 `/Users/wangjr/Desktop/workspace/inoita`（`work/` 是反汇编 findings/evidence，`site/data` 是原版数据）。

| 证据 | 结论 |
|---|---|
| `work/bag-items/evidence/ITEMSYSTEM_PutJewel.asm` | 目标实例 `[x19,0x19]`：高 4 位总孔、低 4 位已用孔；要求总孔 ≥1 且总孔 > 已用；宝石值范围 `0x21..0x25`；从 `ITEMOPTPOOL_pListPool` 取节点，写词条后挂到 `+0x20` 列表尾，已用孔 +1。**没有减少已用孔或释放节点的分支。** |
| `work/bag-items/evidence/ITEMSYSTEM_CanPutJewel.asm` | 只判物品类别（真装备）、状态值 `[+0x10]` bits[31..25] ≥100（已揭示/已购买）和 `ITEMDATABASE+7` bit4 禁镶嵌标记；**不读 `+0x19` 的孔数**。空孔检查在 `PutJewel` 里。 |
| `work/libgame_exports.txt` | 只有 `ITEMSYSTEM_CanPutJewel`、`ApplySocket`、`ApplySocketForMixure`、`GetJewelOptionValue`、`IsJewel`、`MakeJewel`、`PutJewel`、`UIMix_FindJewelUpgradeStuff`。**没有 RemoveJewel/TakeJewel/Extract/remove-jewel。** |
| `site/data/recipes.json` | 宝石大量作为装备合成材料；没有取出/替换配方。 |
| 帮助文本 | 宝石「可通过拖动到要镶嵌的道具上面来进行镶嵌，宝石的镶嵌数量取决于道具的宝石槽数」；没有取出说明。 |
| `ITEMSYSTEM_RestoreChaos` | 只清混沌，保留强化、耐久、宝石、普通词条。 |

**结论：原版没有宝石取出/替换。** 这不是「原版有、复刻没做」，而是原版就是一次性镶嵌。

补充取证（子 agent 复核，2026-10-31）：

- 写 `item+0x19`（高 4 位总孔、低 4 位已用）的指令全库只有 3 处：`ITEMSYSTEM_ApplySocket`（生成时开孔）、`ITEMSYSTEM_PutJewel`（已用 +1）、`SAVE_LoadItem`（读档还原）。**没有清零或减一。**
- UI 唯一入口是 `UIEquip_IsApplyStuff` → `UIEquip_ApplyStuff`：`PutJewel` 返回 0 后立刻 `INVEN_ConsumeItem(宝石)` 再存盘。宝石道具当场消失，节点里只留 `(type=1, 词条行号, 数值)`，**连宝石 id 和能力等级都没存**。
- 装备详情菜单只有 装备/解除/使用/粉碎/快捷键六类按钮；`recipes.json` 69 条配方、`items.json` 1018 条道具、`text_zhhans.json` 35811 条文本里都没有取出/拆除；原版也没有道具锁。
- 原版满孔时 `CanPutJewel` 不拦，拖上去后由 `PutJewel` 返回 2，才弹「宝石孔不足」；复刻的 `applicationProblem` 在点选前就返回 `socket-full`，这是有意的交互改良。
- 原版存档里宝石节点是 `19 + 4n` 字节的独立列表，不存来源宝石 id。**复刻不同**：`ItemInstance.gems` 存宝石物品 id，`numbers.gemModifiers` 存词条，两者按下标一一对应，所以复刻能精确还原「哪一颗宝石、什么词条」；不需要为取出/替换新增存档字段。

复刻新增取出时，建议遵守：

- 只在装备侧发起（强化台的镶嵌页），不增加「点宝石 → 取出」入口。
- 取出把宝石原样放回背包，**保留它当初掷出的词条**；替换时旧宝石也回背包。
- 默认免费、随时可取，不加金币/道具成本；原版没有取出，复刻不宜再叠收费。
- 明确告诉玩家这是复刻新增（文档/说明即可，不必做游戏内标签）。

如果用户最终决定「忠于原版、不做取出」，只需删掉镶嵌页的已镶孔操作，方案 A 的其余部分不受影响。

## 4. 方案 A：装备优先的强化台

### 4.1 入口

在**装备**（背包里的、已穿戴的都算）说明底部的操作行加一个文字按钮：

| 装备能力 | 按钮文案 |
|---|---|
| 可强化 + 有孔 | `强化/镶嵌`（字号 16，避免超出 125px） |
| 只可强化 | `强化` |
| 只可镶嵌 | `镶嵌` |
| 只可净化（有混沌） | `净化` |
| 都没有 | 不加按钮 |

- 按钮走现有无字按钮皮肤：`v.button(label, x, y, 125, 55, run, { fontSize? })`，不新增素材。`item-use.png` 是 149×75、中间烘焙了「使用」，不能复用。
- 同时删掉卷轴/宝石/净化石说明里的「使用」按钮（`bagMenu` 的 `NON_MENU_USE_KINDS` 分支），宝石不再从道具侧进入镶嵌。
- 已穿戴装备的操作行是「卸下 + 强化/镶嵌」（2 个）；背包里的装备是「装备/替换 + 强化/镶嵌 + 丢弃」（3 个），正好在操作行 3 个按钮的上限内。

### 4.2 版面

用 1024×640 的 `modal` 覆盖层，打开时隐藏背包层（`surface`/`body`/`description`），避免同名按钮重复。

```text
┌──────────────────────────────────────────────────────────────┐
│  装备强化                                             [关闭] │
│ ┌────────────────────────┐  ┌─────────────────────────────┐ │
│ │ [图标] 基础短剑 +3      │  │ [强化] [镶嵌] [净化]        │ │
│ │ 强化耐久度 2            │  │ ┌─────────────────────────┐ │ │
│ │ 宝石孔 1/3              │  │ │ 低级武器强化卷轴         │ │ │
│ │ 攻击 12                 │  │ │ +1 确定 · +2 25%        │ │ │
│ │ 混沌属性：无            │  │ │ 耐久剩余 2              │ │ │
│ │                        │  │ └─────────────────────────┘ │ │
│ │ 结果：强化 +4           │  │  ...                        │ │
│ └────────────────────────┘  └─────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

- 左栏：图标、名称 + `+N`、`强化耐久度 ${numbers.enhancementUses ?? 0}`、`宝石孔 ${gems.length}/${numbers.sockets ?? socketCapacity}`、当前攻击/防御（`equipmentPower`）、混沌属性、结果行。
- 右栏：三个页签 + 可滚动列表。页签始终显示；没有孔的装备在镶嵌页写「这件装备没有宝石孔」，没有混沌的装备在净化页写「这件装备没有混沌属性」。
- 结果行是常驻文本，不是 1.8 秒即时消息；颜色：普通 `#e2cb9e`、大成功 `#ffd75e`、失败 `#ff6b6b`。

### 4.3 强化页

- 列出背包里所有 `use.kind === 'enchant'` 的卷轴（每个堆叠一行，显示数量）。
- 每行显示：名称、`+1 确定，+2 X%`（混沌显示 `成功 X%，失败降 1 级`）、耐久消耗说明。
- 可用性：
  - `!bag.canApply(scroll.id, target.id)` → 「该道具不适合。」（通常是武器卷轴对防具）。
  - 否则 `bag.applicationProblem(scroll.id, target.id)` 的文案（`menuPanels.itemMessages[notice]`）：等级不符、耐久不足、强化上限、卷轴家族不符、混沌需要 +1、混沌需要耐久 0。
  - 不可用的行灰掉、不可点，但**原因要写出来**，这是这次改造的核心之一。
- 点可用行 → 立即 `bag.use(scroll.id, target.id)`，不弹确认，原地刷新：
  - 卷轴堆叠还有剩余、装备还有耐久 → 行不消失，玩家可以连续点。
  - 卷轴用完 → 行消失；装备耐久 0 → 普通行全部灰掉。
  - 结果写左侧结果行：`result.message`（已含装备名与 +N），不要用 `itemMessages['enchant-double']` 的「强化+2成功！」，后者会丢掉数值。
- 耐久为 0 时，混沌卷轴行加亮（边框/底色），并显示「耐久已耗尽，可改用混沌卷轴」；普通卷轴行灰掉。
- 排序建议：可用行在前，按卷轴等级从低到高；不可用行在后，按原因分组。混沌卷轴在耐久 0 时置顶。

### 4.4 镶嵌页（含取出/替换）

- 顶部画 `numbers.sockets` 个孔位（最多 4 个），已镶的显示宝石图标，空孔显示空槽。
- **只有下一个空孔可点**（从左到右填），其余空孔灰掉；这样不需要新增「指定孔位镶嵌」的领域 API，`bag.use` 的追加行为与界面一致。
- 点下一个空孔 → 下方列出背包里的宝石（`use.kind === 'socket'`）：
  - 每行：宝石图标、名称、词条（红色 `#bf0000`）、数量/实例。
  - 选中一颗 → 预览：宝石词条 + 当前孔位 + 「镶嵌后」提示；至少显示词条，能算属性差更好（见 5.5）。
  - 「确认镶嵌」→ `bag.use(gem.id, target.id)`，结果写结果行。
- 点已镶的孔 → 显示这颗宝石的词条 + 两个按钮：
  - 「取出」→ 确认后 `bag.unsocket(target.id, index)`，宝石回背包，孔位变空。
  - 「替换」→ 进入选宝石列表；选中后「确认替换」→ `bag.swapGem(target.id, index, gem.id)`，旧宝石回背包。
- 取出/替换都要二次确认（会改变永久属性），确认文案写清楚「宝石会回到背包，属性会消失」。
- 装备 `locked` 时，镶嵌页整页只读并写「这件装备已锁定，不能镶嵌」。

### 4.5 净化页

- 只有 `target.numbers.chaos` 存在时显示内容；否则写「这件装备没有混沌属性」。
- 显示背包里的净化之宝石（`use.kind === 'purify'`）和数量；没有就写「背包里没有净化之宝石」。
- 点「净化」→ `bag.use(stone.id, target.id)`，结果行显示 `result.message`（`${装备名}的混沌属性已净化`）。不需要二次确认，保留强化/耐久/宝石。

### 4.6 反馈

- 强化台内的所有结果只写左侧结果行，不走 `showInstant`，这样连续操作时上一手结果还在。
- 成功/失败播放 `audio.ui('enchant')`；打开、切页、选行播放 `select`；关闭播放 `back`。
- 打开时清空 `itemNotice`；强化台内的失败写结果行，不弹 `itemNotice`，避免和 forge 弹层叠加。
- 结果行保留到下一次操作或关闭；关闭后回到装备说明，说明里的 `+N`、耐久、孔位、词条已经是最新值。

### 4.7 旧流程删除清单

| 位置 | 处理 |
|---|---|
| `src/ui/story-ui.ts:79` | `NON_MENU_USE_KINDS` 保留；只删 `bagMenu`/`selectItem` 里的用法 |
| 同上 1111 `selectItem` | 只保留说明开关；删除 `applying` 分支 |
| 同上 1118-1134 | 删除 `beginApply`、`hasApplyTarget`、`canApplyTarget` |
| 同上 1209-1210 | 删除 NON_MENU 的「使用」按钮 |
| 同上 1233 | 保留 `beginOperation` 的 NON_MENU guard（防调试页误开普通使用弹窗） |
| 同上 1236-1250 | 删除 `applyItem` |
| 同上 299 | Esc 的 `applying` 分支换成 `forge` |
| 同上 1079 | 删除 `!this.applying`，拖动恢复为始终可用（面板遮住背包时除外） |
| 同上 1058-1085 | 删除 `applying` 的 `inventory-selected` 高亮分支 |
| `tests/story-menu-interactions.test.ts:229` | 删除 `internals.applying`；相关断言全部重写 |

注意：`selectItem` 删除 `applying` 后，点第二件物品就是正常切换说明；`suppressClick` 仍然保留给拖拽。

## 5. 领域层改动

### 5.1 概率 API（让界面和结算共用一套数）

现在界面无法显示成功率；不要在 UI 里复制 `1500/(raised+5)` 这类公式，否则两处会漂移。

建议：

```ts
// src/domain/items.ts 或新文件 src/domain/enhancement.ts
export interface EnhancementOdds {
  success: number;   // 本次不降级的概率，0..1
  double: number;    // 最终 +2 的概率，0..1（对混沌是 success 之后的联合概率）
  failure: number;   // 失败降 1 级的概率，0..1；普通卷轴为 0
  losesLevel: boolean;
}

export function enhancementChance(threshold: number): number {
  const value = Math.trunc(threshold);
  return Math.min(998, Math.max(0, value - 1)) / 998;
}
```

`enhancementSucceeds` 改成 `return random() < enhancementChance(threshold);`，与旧实现逐点等价（旧的 `1 + floor(random*998) < trunc(threshold)`）。

`BagRules` 加可选方法：

```ts
odds?(source: ItemInstance, target: ItemInstance): EnhancementOdds;
```

`BattleCharacter` 实现：

```ts
// 写在构造函数里构造 BagRules 的同一闭包内：items 是构造参数，catalog 是 this.catalog。
// BattleCharacter 没有 this.items 字段，别照抄成 this.items。
const level = target.enhancement, raised = level + 1;
const rule = catalog.enchantments[source.item]?.[items.items[target.item].kind];
const double = enhancementChance(1500 / (raised + 5) + (rule?.bonusChance ?? 0));
const use = items.items[source.item].use;
if (!use?.requiresEnhanced) return { success: 1, double, failure: 0, losesLevel: false };
const success = enhancementChance(50000 / (10 + level * level));
return { success, double: success * double, failure: 1 - success, losesLevel: true };
```

`Bag` 加：

```ts
applicationOdds(sourceId: string, targetId: string): EnhancementOdds | undefined;
```

只在 `canApply` 且 `applicationProblem` 为空时返回，否则 `undefined`；UI 对不可用行只显示原因，不显示概率。

**显示口径**：
- 普通卷轴：`+1 确定，+2 25%`。
- 混沌卷轴（以 +10 为例）：`不降级 45%，降 1 级 55%；+2 5%`。
- 用 `odds.double` 显示最终 +2 概率，不要显示条件概率误导玩家。

### 5.2 宝石取出/替换

新增两个 `Bag` 方法（或一个 `addEquipmentGem` 模块）。前提不变量：**每颗宝石恰好 1 条词条**，所以 `numbers.gemModifiers[i]` 对应 `gems[i]`。

```ts
unsocket(targetId: string, index: number): { gemId: string; name: string };
swapGem(targetId: string, index: number, sourceId: string): { removedId: string; name: string };
```

`unsocket` 步骤：

1. `target = this.instances.get(targetId)`（**不能用 `this.get`，它返回副本**），必须有 `catalog.items[target.item].equipment`；`index` 在 `[0, target.gems.length)`。
2. `modifier = target.numbers?.gemModifiers?.[index]`；`undefined` 或长度不匹配 → `throw new Error('宝石数据不完整，无法取出')`（旧档 guard）。
3. `gemItem = target.gems[index]`；从 `gems` 和 `gemModifiers` 同时 `splice(index, 1)`。
4. `restored = this.create(gemItem)`；把 `modifier` 写回 `restored.numbers.modifiers = [{...modifier}]`。`create` 会先随机掷一条，这里覆盖掉；`create` 用的是 `itemRandom(...)`，不消耗 `Math.random`，不影响强化随机流。
5. `this.put(restored.id)`；`this.notify()`。
6. 返回新实例 id 和装备/宝石名，供 UI 写「已取出 X」。

`swapGem` 步骤：

1. 校验 `target`、`index`（必须是已镶孔）、`source` 是背包里的宝石（`use.kind === 'socket'`）、`source.id !== target.id`、目标 `!locked`、`source.numbers.modifiers.length === 1`。
2. 取旧 `gemItem` 与旧 `modifier`；`target.gems[index] = source.item`；`target.numbers.gemModifiers[index] = {...source.numbers.modifiers[0]}`。
3. 用旧 `gemItem` + 旧 `modifier` 造一个新实例（同 `unsocket` 第 4 步），`put`。
4. `this.consume(sourceId)`；`this.notify()`；返回旧宝石新 id。

边界：

- `target.numbers.gemModifiers` 缺失 → 拒绝，提示「宝石数据不完整」；不要 `undefined.push`。
- 背包满：`put` 现有实现会追加到末尾，不报错；沿用，不新增「背包已满」流程。
- `swapGem` 不调用 `bag.use`，因为 `bag.use` 的 `applicationProblem` 会在满孔时返回 `socket-full`，且追加到列表尾，不能保证同一孔位。
- 取出/替换后 `equipmentPower`/`calculateCharacter` 会自动用新的 `gemModifiers`，不需要额外刷新属性缓存；`calculateCharacter` 每次按装备重算。
- 不新增存档字段，`SAVE_FORMAT` 保持 38；如果未来允许一颗宝石多条词条，必须同时存每颗宝石的词条数，否则 1:1 假设失效。

### 5.3 `Bag.canApply` / `use` 是否要改

- 不需要改规则本身。强化台只是换入口，仍然调用 `bag.use`，保留所有校验。
- 镶嵌页的「下一个空孔」调用 `bag.use`，追加到 `gems` 尾部，与界面从左到右填一致。
- 取出/替换走新方法，绕过 `applicationProblem` 的「孔满」检查，但仍然检查 `locked`。
- 净化页调用 `bag.use(stone, target)`，`canApply` 已经要求 `numbers.chaos`。

### 5.4 存档兼容

- 没有新增字段；`gems` 与 `gemModifiers` 已在 `numbers` 里持久化。
- 旧档 `gemModifiers` 缺失或长度不匹配时，`unsocket`/`swapGem` 必须拒绝，不能把存档写坏。
- 进游戏时不需要迁移；`verifyBagState` 可以补一条检查（`gemModifiers` 与 `gems` 等长），但补检查会让旧档读不进来，需先在迁移链里补齐或只在取出时 guard。建议先只在取出时 guard，避免扩大改动面。

### 5.5 属性预览（可选但推荐）

- 最低要求：镶嵌确认页显示宝石词条（红色）和目标当前孔位。
- 更好：显示「镶嵌后攻击/防御」的差值。实现方式二选一：
  1. 在 `BattleCharacter` 加 `previewEquipment(targetId, change)`：克隆目标实例、改 `gems/gemModifiers`、按当前队伍/等级重算 `calculateCharacter`，返回面板；`ForgePanel` 只读结果。
  2. 只显示宝石词条，不做角色面板差值；界面更简单，但玩家仍要自己判断。
- 不要用 `equipmentPower` 代替角色面板：它只算强化加成，不含宝石词条和职业属性。

## 6. UI 层改动

### 6.1 新面板 `src/ui/phaser/forge-panel.ts`

照 `src/ui/phaser/crafting-panel.ts` 的模式写：

```ts
class ForgePanel {
  constructor(bag, panels, grades, changed, sound, close);
  open(targetId: string, tab?: 'enchant'|'socket'|'purify'): void;
  render(v: UiSurface, placeModal: (w:number,h:number)=>void): void;
  captureScroll(): void;   // 在 StoryUI.renderNow 清屏前保存列表滚动位置
  get modalOpen(): boolean;
}
```

- 自己保存 `targetId`、`tab`、`socketIndex`、`selectedGem`、`result`、`resultTone`、`offset`。
- `render` 里先 `placeModal(1024,640)`，再画半透明黑底（`v.rect(0,0,1024,640,0x000000,.7)`）、边框、标题、关闭按钮、左右两栏。
- 列表用 `v.scroll(...)`：行用 `v.button('',... , { bare:true, parent:scroll.content, guard:scroll.guard })`；`scroll.setHeight(rows*rowHeight)`、`scroll.scrollTop=this.offset`。
- 图标用 `items.items[entry.item].icon`，通过 `v.image(icon, x, y, w, h)` 画；不要新建素材。
- 页签用 `v.button('强化', ..., { selected: this.tab==='enchant' })`（`selected` 已在 `widgets.button` 的 options 里）。
- 关闭按钮用 `v.button('关闭', ..., { image:'close' })` 或文字按钮；注意 `scene.button('关闭')` 必须唯一。

### 6.2 `StoryUI` 接线

- 字段：`private forge?: ForgePanel;`。
- `openForge(targetId)`：

```ts
private openForge(targetId: string): void {
  const target = this.session!.bag.get(targetId);
  const equipment = target && this.app.characterStats.equipment[target.item]?.equipment;
  if (!target || !equipment) return;
  this.cancelDrag();
  this.selectedItem = targetId;           // 关闭后回到装备说明
  const sockets = target.numbers?.sockets ?? equipment.socketCapacity ?? 0;
  this.forge = new ForgePanel(
    this.session!.bag, this.app.menuPanels, this.app.shops?.grades ?? {},
    () => this.render(), () => this.app.audio?.ui('select'), () => this.closeForge(),
  );
  const tab = sockets > 0 ? 'socket' : equipment.enchantable ? 'enchant' : 'purify';
  this.forge.open(targetId, tab);
  this.app.audio?.ui('select');
  this.render();
}
```
- `closeForge()`：`this.forge=undefined; this.render();`。
- `renderNow` 412 行：在清屏前加 `this.forge?.captureScroll();`。
- `renderNow` 页面分发之后：`if(this.forge){this.beginModal(1024,640);this.forge.render(this.modal!,this.placeModal);}`。
- `sync()` 183-200：`const base=menu&&!this.forge;`，`surface.visible(base)`、`body.visible(base)`、`description.visible(base)`；`modal` 条件加 `|| !!this.forge`。
- `surface.enabled` 158 行加 `&& !this.forge`；`modal.enabled` 160 行加 `|| !!this.forge`。
- Esc 299 行：在 `skillReset` 之后、`craftingPanel` 之前加 `else if(this.forge){this.closeForge();}`；删掉 `applying` 分支。
- `close()` 278 行：加 `this.forge=undefined;`。
- `NON_MENU_USE_KINDS` 保留（只给 `beginOperation` 防呆）；`bagMenu` 的 NON_MENU 分支删除；`selectItem` 不再读它。
- `renderItemDetail` 的操作行 1155-1160：`action.text` 为真时走 `v.button(action.label,...)`，不再画 `hit` 图；否则保持现有图片路径。

### 6.3 操作按钮

`BagMenuAction` 加 `text?: boolean; fontSize?: number;`：

```ts
interface BagMenuAction { label:string; image:string; run:()=>void; disabled?:boolean; text?:boolean; fontSize?:number; }
```

`bagMenu` 在 `worn ? 卸下 : 装备/替换` 之后、通用使用/丢弃之前加（已穿戴也要加）：

```ts
const forgeLabel = this.forgeLabel(entry);
if (forgeLabel) actions.push({ label: forgeLabel, image: '', text: true, fontSize: forgeLabel.length > 2 ? 16 : undefined, run: () => this.openForge(entry.id) });
```

`forgeLabel`：

```ts
const equipment = item.equipment; if (!equipment) return undefined;
const sockets = entry.numbers?.sockets ?? equipment.socketCapacity;
const canEnchant = equipment.enchantable;
const canSocket = sockets > 0 && !equipment.locked;
const canPurify = !!entry.numbers?.chaos;
if (canEnchant && canSocket) return '强化/镶嵌';
if (canEnchant) return '强化';
if (canSocket) return '镶嵌';
if (canPurify) return '净化';
return undefined;
```

注意：`equipment.enchantable` 为 false 但 `canSocket` 为 true 时按钮是「镶嵌」，玩家不会误以为能强化；强化页会显示「这件装备不能强化」。

### 6.4 输入与测试约束

- `tests/story-menu-interactions.test.ts` 的假场景 `MenuScene.button(label)` 断言**可见层里恰好 1 个同名按钮**；forge 打开时必须隐藏 `surface`/`body`/`description`，否则背包里的同名装备/按钮会让 `scene.button('强化/镶嵌')` 断言失败。
- forge 的列表行如果都叫「使用」，会重复；行按钮的 label 用卷轴/宝石名，或空 label 只靠行点击。
- `scroll` 的按钮父容器用 `scroll.content`、`guard: scroll.guard`，否则列表外点击/滚动会误触。
- 强化台内的动作是同步的；不需要 `busy`。如果以后加动画，再引入 `busy` 并确保 `modal.enabled` 不被自己关掉。
- 打开 forge 时清 `itemNotice`；forge 内不要设置 `itemNotice`。

### 6.5 内容文案

改 `public/content/items.json` 里这 14 个物品的 `description` 和 `descriptionParts`（两处都有同一句；只改 `description` 会导致详情页仍显示旧句）：

- 10 张卷轴：把「可通过拖动到要强化的道具上面来进行强化。」改成「在装备说明里点「强化」进入强化台。」
- 4 种宝石：把「可通过拖动到要镶嵌的道具上面来进行镶嵌，宝石的镶嵌数量取决于道具的宝石槽数。」改成「在装备说明里点「镶嵌」选择宝石孔。」
- `chaos-jewel` 的 `description` 目前是空的；可以补「在装备说明里点「镶嵌」选择宝石孔。」保持一致。
- `chaos-weapon-scroll` / `chaos-armor-scroll` 没有拖动句，保留原文。
- 改完跑 `npm run validate:content`；如果 `debug-start` 现场表引用了道具说明，再跑 `npm run debug-start`。

## 7. 测试

### 7.1 领域测试（`tests/bag.test.ts`、新增 `tests/enhancement.test.ts`）

- `enhancementChance`：0、1、300、998、5000 的边界；与旧 `enhancementSucceeds` 在固定随机值下逐点一致。
- `applicationOdds`：普通卷轴 `success=1`、`double≈0.2996`；混沌 +0 `success=1`；+10 约 0.45；满级/耐久不足时返回 `undefined`。
- `unsocket`：装备 3 孔、镶 2 颗；取出 index 0 后 `gems`/`gemModifiers` 同步移除；背包里出现的新宝石词条等于取出的那条；`notify` 触发 revision。
- `swapGem`：同一孔位替换后 `gems[index]` 是新宝石、`gemModifiers[index]` 是新词条；旧宝石回背包且词条保留；`locked` 拒绝；满孔仍可替换。
- 旧档 guard：`gemModifiers` 缺失/长度不匹配时抛错，不修改状态。

### 7.2 交互测试（`tests/story-menu-interactions.test.ts`）

- 打开装备说明 → 点「强化/镶嵌」→ `internals.forge` 存在；背包层不可见（`scene.button` 不重复）。
- 强化页：卷轴行显示 `+2 概率`；点可用行后装备 `enhancement` +1、耐久 -1、结果行文本更新；卷轴还有剩余时行还在，可以再点一次。
- 耐久 0：普通卷轴行不可点，混沌卷轴行可点且高亮；点混沌失败时 `enhancement` 降 1、耐久不变。
- 镶嵌页：空孔点击 → 宝石列表 → 选宝石 → 确认 → `gems.length` +1；满孔后空孔不可点。
- 已镶孔：点开 → 取出 → 确认 → 宝石回背包，孔位减少；替换 → 旧宝石回背包、新宝石进同一位置。
- 净化页：没有混沌时显示空状态；有混沌且背包有净化石时点净化 → `numbers.chaos` 消失。
- 关闭 forge → 回到装备说明，数值已更新；Esc 同样关闭。
- 旧入口不存在：点卷轴/宝石说明，底部没有「使用」按钮。

### 7.3 需要重写的现有用例

| 行 | 用例 | 处理 |
|---|---|---|
| 585 | `socket gems start from the detail button...` | 改成从装备侧打开 forge 再镶嵌 |
| 602 | `apply items explain...` | 删除或改成「装备没有可用能力时不出现按钮」 |
| 613 | `purify jewels...` | 改成从装备侧净化 |
| 1189 | `processing items use the detail button instead of drag-and-drop` | 改成 forge 入口；断言不再有拖拽/「使用」按钮 |

`tests/chaos-equipment.test.ts` 里的混沌规则测试保留；`tests/item-description.test.ts` 需要更新正文断言（如果它断言了「拖动」句）。

### 7.4 命令

```bash
npm test -- tests/bag.test.ts tests/story-menu-interactions.test.ts tests/item-description.test.ts tests/chaos-equipment.test.ts
npm run typecheck
npm run validate:content
```

内容改动后如 `debug-start` 现场表过期，再跑 `npm run debug-start`。全量 `npm run test:all` 只在用户明确要求时跑。

## 8. 实施顺序（建议）

1. **领域概率 API**：`EnhancementOdds`、`enhancementChance`、`BagRules.odds`、`Bag.applicationOdds`、`BattleCharacter` 实现；补领域测试；`npm run typecheck`。
2. **取出/替换**：`Bag.unsocket`、`Bag.swapGem`；补领域测试（含旧档 guard）。
3. **ForgePanel + 入口**：新面板、`StoryUI.openForge/closeForge`、`bagMenu` 文字按钮、`renderNow/sync/enabled/Esc` 接线；先把旧流程留着，确认新面板能打开。
4. **删旧流程**：`applying`/`beginApply`/`hasApplyTarget`/`canApplyTarget`/`applyItem` 和对应高亮/拖动禁用；`NON_MENU_USE_KINDS` 保留防呆；重写测试。
5. **内容文案**：14 个物品的 `description`/`descriptionParts`；`validate:content`。
6. **收尾**：`npm test -- ...`、`npm run typecheck`、`npm run validate:content`；按 AGENTS.md 每个独立修复一个 commit。

## 9. 还没定的选择（接手的 agent 应先问用户或按默认做）

| 问题 | 默认建议 |
|---|---|
| 宝石取出/替换是否保留？ | 保留，免费、原词条回背包；原版没有，属于复刻新增。 |
| 取出/替换是否二次确认？ | 是，会改永久属性。 |
| 混沌卷轴是否二次确认？ | 不确认，但行上写清「失败降 1 级」。 |
| 强化结果是否同时弹即时消息？ | 不弹；只留 forge 结果行。 |
| 入口文案 | 二者都有用「强化/镶嵌」（字号 16）；只有一项用「强化」「镶嵌」「净化」。 |
| 是否恢复拖拽强化？ | 不恢复；装备侧入口已经覆盖。 |
| 宝石词条是否保留？ | 保留；不保留等于销毁，玩家会 SL。 |
| 是否加「一键用完」/批量？ | 不做；连续点已经够。 |
| 是否需要完整属性差值预览？ | 推荐做；做不了就先显示宝石词条，别用 `equipmentPower` 冒充。 |
| 强化台是否也支持 GM 页？ | 暂不支持；`renderGmItemDetail` 不加操作行。 |

## 10. 仓库现状与注意事项

- HEAD `3e17ff2`；工作区还有未跟踪的 `tmp-exit-probe.ts`、`docs/goblin-lair-gateway-stuck.md`、`docs/quest-63-fire-position.md`、`docs/images/`（都不是本文产物，别删）。
- `stash@{0}` 是早前一次 `git pull --rebase --autostash` 收走的废弃改动（bag/StoryUI/测试），与方案 A 不一致，**不要直接 apply**；需要的话先看 diff 再决定。
- 原版取出/替换的复核已经完成，结论与本文一致：原版没有取出、没有替换、也没有间接返还；补充证据已并入 §3「补充取证」。
- 旧流程的测试断言 `internals.applying` 在 `tests/story-menu-interactions.test.ts:229`；删除字段时一并清理。
- `MAX_ENHANCEMENT_LEVEL=30` 与 `equipmentPower` 的 `threshold=10` 是内容/规则层常量，不要在 UI 里硬编码。
- 改内容后 `npm run validate:content`；改 TypeScript 后 `npm run typecheck`；提交信息按 AGENTS.md 写清修复行为和验证结果。

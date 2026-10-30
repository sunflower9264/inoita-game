# 用户反馈待办

记录时间：2026-10-30。

本文合并了两个人分别记的两份材料：远端仓库的 `docs/user-feedback-todo.md`，和本地的
`docs/player-feedback-2026-10-30.md`（已并入本文删除）。

编号沿用玩家当初的说话顺序，所以 7、8、9 三个号不存在。本地那份自带的三条补充接在后面，
成了 15–17。

**没打勾的条目只做了核查，一行代码都没改。** 先定要修哪几条，再逐条动手、逐条提交。

## 状态总览

| 编号 | 内容 | 状态 |
|---|---|---|
| 1 | 批量售卖 | 已完成 |
| 2 | 血之复仇、黑暗之刃没有状态图标 | 已完成（黑暗之刃按原版保持无图标） |
| 3 | 卡娜的眩晕技能看起来像定身 | 已修（命中金光 + 头顶三颗星星；命中金光是原版漏项，暴击与钝器眩晕的金光为增强） |
| 4 | 沃尔达克头像错成主角 | 已修：无立绘时改用职业图兜底 |
| 5 | 兽人部落 NPC 缺少交互 | 已核查：与原版一致，不改 |
| 6 | 交互时只有一句「一路小心。」 | 已修（无闲话内容不再弹窗，完成的任务不再保留交互） |
| 10 | 交互范围过大 | 已修（普通目标贴身 1 格；商店隔柜台 4 格） |
| 11 | 任务道具交付后不清除 | 已修（删掉重复发放的源头） |
| 12 | 打开背包掉帧、数量改动整页重画 | 数量变化已修；背包静态层待做 |
| 13 | 背包格子按装备品质上色 | 已修（边框按品质换图） |
| 14 | 融合器交互不对 | 已修（融合器接入配方列表） |
| 15 | 宝石、强化卷轴用起来麻烦 | 已修（点道具选装备，拖拽保留） |
| 16 | 圣女演出里三只重复的打铁 NPC | 已修：29 个角色的朝北待机改用正面待机 |
| 17 | 变异的修道院院长出现两只 | 已修（含同根因的 401、同类的 72） |

## 一、已完成

### 1. 批量售卖

玩家想一次卖光某一类，不用一格一格点。

决定：不做二次确认；不能卖的物品在批量模式里直接不显示。

做法：`Storefront.sellMany` 先整批校验，再一次结算；出售页背包框上方加「批量出售」开关，
开启后点格子就是勾选，底部显示已选数量和本次合计，点「出售选中（N）」一次卖完；
离开出售页清空勾选。

验证：`npm test -- tests/shop.test.ts tests/shop-panel.test.ts`，23 项通过。

### 2. 血之复仇、黑暗之刃没有状态图标

现象：技能效果已经生效，但头顶没有图标，人物面板数值也不跟着动。

核查：血之复仇属于「状态图标没注册」，已把原版图标补进状态栏目录；顺带补了同一处漏扫的
另外 8 个反应类状态图标。黑暗之刃是常驻被动（改魔法伤害率），原版本来就没有图标，
角色面板的魔法攻击数值也不变，所以保持原样。

## 二、表现与界面

### 3. 卡娜的眩晕技能看起来像定身

现象：被晕住时主角站着不动，但没有眩晕动作，也没有图标。

核查：规则这一层是完整的。`src/domain/combat-state.ts:13`-`14` 里
`canAct = !sleep && !stun`、`canMove = canAct && !immobilized`，晕住时既不能动也不能出招。
缺的只是表现：没有眩晕动作、没有头顶图标、没有面板提示。
内容侧的 `attack-stun` 时长在 `public/content/battle.json` 的状态表里，约 1.86 秒。

补充核查：原版没有眩晕图标或动作。`buffs.json` 里 `attack-stun` 的 `icon_index` 是 `-1`，
状态位命中 `0x11d` 时原版只把角色切回待机。所以这不是复刻漏了素材，而是原版本身表现不清；
按玩家反馈额外补一个提示。

不过「原版毫无表现」只说对了一半。原版 Buff 记录有三个画面字段：`+6` 是打中那一下的特效，
`+8` 是状态期间反复播放的表现，`+10` 是状态栏图标。逐条解码：

- 玩家侧三条眩晕（`attack-stun` 57、`critical-hit-stun` 62、`blunt-hit-stun` 63）三项全是 `-1`，
  确实一点表现都没有。
- 怪物三条（`monster-landshake-stun` 70、`monster-strong-stun` 71、`monster-hammer-stun` 72）
  的 `+6` 是 `138`，也就是 `flash-gold`：**命中瞬间有一次金色闪光**。卡娜的眩晕技能用的就是 71。
- `monster-sleep` 76 的 `+6` 是 `464`（`monster-sleep-aura`，紫色光环）；
  `monster-emergency-recovery` 78 是 `+6 = 464` 加 `+8 = 192`（`monster-poison-aura`）。

我们这边把这类字段整批丢了：导出器只在技能 Buff 的白名单里读 `+6`/`+8`，怪物 Buff 70–83
不在名单，于是 54 条眩晕/睡眠增益一条施加特效都没有。所以卡娜打晕玩家时，连原版那一下金光都没有。

补回原版漏项：
- 旧项目 `work/tools/game_content/battle_resolution.py` 把两个字段移出白名单，特效名改查合并表
  `EFFECT_NAMES`（提交 `a0942be3`）。完整重导出仍被旧项目自己的「调试现场表已过期（maps）」挡住，
  所以这次按同样的解码结果直接补进本仓库数据。
- `public/content/battle.json`：6 类怪物增益共 60 个等级补上 `applicationEffect`，
  `monster-emergency-recovery` 另补 `loopEffects`（`monster-poison-aura`，从第 10 帧接上）。
- `tests/buff-visual-content.test.ts`：钉住这 6 类增益的命中特效、卡娜那条技能的 `flash-gold`、
  以及「引用的特效必须都在素材表里」。

持续期间的表现是另一层：`src/rendering/stun-stars.ts` 在眩晕时给头顶加三颗绕圈的小星星。
这一层原版没有，属按玩家反馈加的增强。

玩家侧也一并补了口子（有意偏离原版，按玩家要求）：原版 Buff 57/62/63 的 `+6` 全是 `-1`，
现在 `critical-hit-stun`（暴击眩晕）和 `blunt-hit-stun`（钝器眩晕）也用怪物眩晕同款 `flash-gold`，
值和时长没动（各 960 毫秒，即原版母帧龄 15）。这两条只有在学了佣兵团技能「弱点攻击」（30‰）
和「钝器达人」（20‰）时才会触发。普通攻击眩晕 `attack-stun`（涂层、暗杀之剑那类）仍保持原版无特效。

验证：`npm run typecheck` 通过；`npm test -- tests/buff-visual-content.test.ts` 5 项通过；
`npm run validate:content` 通过（`{ maps: 416, assets: 12086 }`）。实际显示效果交给用户验收。

### 4. 沃尔达克头像错成主角

现象：人物面板里沃尔达克显示的是主角凯恩的脸。

核查：角色本身没有头像字段，头像按 actor 取。`mercenary-olaf`（沃尔达克）的 `portrait`
是 `null`，旧代码取不到就回退主角，代码在 `src/ui/story-ui.ts:342`：
`portraits[actor.portrait ?? 'kiyan'] ?? portraits.kiyan`。头像表里目前只有 12 张（凯恩、圣女、
阿萨德、贾纳斯、达里乌斯、波尔蒂亚、鑫迪、亚历山大、科内特、老兵、红龙、紫魔），确实没有沃尔达克。

核查原版：`UIPortrait_DrawPortChar` 找不到立绘时直接不画；队员栏的
`UIPortrait_DrawPortPartyButton` 找不到立绘时改取 `PORTRAITCLASSBASE`，也就是按职业取图。
原版没有任何「用主角头像兜底」的逻辑，12 张立绘里也没有沃尔达克。

修法：`memberPartyIcon` 和 `memberArt` 统一成「有专用立绘用立绘，没有就用
`party-class-${classId}` 职业图」；沃尔达克是 `warrior`，显示战士职业图。主角一定有立绘，
`playerPortrait` 不动。

验证：`npm run typecheck` 通过；实际显示效果交给用户验收。

### 12. 打开背包掉帧、数量改动整页重画

现象：打开背包卡顿；商店里点一次数量加号，整个界面像被重刷了一遍。

核查：这两件事是同一个根因。`src/ui/story-ui.ts:393` 的 `renderNow()` 第一句就把整个界面拆掉，
再从头重画；商店面板构造时传入的 `changed` 回调就是 `()=>this.render()`
（`src/ui/story-ui.ts:236`），数量加减一旦调用它，点一下加号就要销毁并重建标签栏、两栏货架、
背包所有格子、分类列、金币、筛选按钮；背包页还会用 `createCharacter` 现场合成 157×157
人物立绘。格子多的时候一次重画就是几百个对象。

玩家已经明确要求：**数量变化不允许整页重画。** 这是硬要求，不是建议。

已做（2026-10-30）：
- 数量加减只改弹框里的数字、金额三位数和左右两枚箭头的灰/亮，不再通知菜单重画
  （`src/ui/phaser/shop-panel.ts:346` 的 `stepQuantity` 与 `:355` 的 `syncQuantity`）。
  按钮的可用态改由 `src/ui/phaser/widgets.ts` 里按钮自带的 `setEnabled` 开关控制，
  因为原来的 `disabled` 只决定创建那一刻的样子，之后改不了。
- 背包立绘按角色缓存（`src/ui/story-ui.ts:124` 的 `bagPortrait`）：换人、换装备才重新合成，
  其余重画直接复用；重画前先把它从内容层摘下来，免得被整层清空销毁。

还没做：
- 背包和商店的静态层（图框、标题、格子底图）仍随每次重画重建，只重画变化的那一层还没做。
  这条的效果要按 `docs/performance.md` 的口径在 4002 或 APK 上测，4003 只用来调试功能。

### 13. 背包格子按装备品质上色

现象：希望格子边框跟装备品质走。

核查：所有格子用的都是同一张 `inventory-slot` 底图，没有任何按品质换图的代码。品质色原本只出现在拾取飘字和物品说明标题，颜色表在 `src/ui/item-name-color.ts`：稀有度 1 绿 `#4eff00`、2 蓝 `#00b4ff`、3 黄 `#ffe600`、4 紫 `#9c00ff`，混沌装备蓝、史诗混沌橙。

口径：**不加设置开关，默认就按品质上色**；药水、材料这类没有品级的道具保持原样。

做法：底图是一整张 74×74 的半透明 PNG（米色边框 + 灰色内底），直接叠色会把内底一起染色，所以改成按品质预生成 6 张只换边框的图。边框像素的判据是「红色通道比蓝色通道高 20 以上」，内底是中性灰不满足这个条件。

已做（2026-10-30）：
- `tools/build-slot-frames.ts`：读 `public/assets/ui/menus/inventory-slot.png`，只把边框像素换成品质色，保留原始明暗、抗锯齿与透明度，写出 6 张变体。底图重画后跑 `node tools/build-slot-frames.ts` 重新生成。
- `public/assets/ui/menus/inventory-slot-{rarity-1,rarity-2,rarity-3,rarity-4,chaos,epic-chaos}.png`：新增 6 张图，`public/content/menu-panels.json` 登记对应键。
- 跑 `npm run atlas:ui` 重新打包 UI 图集（`src/generated/ui-atlas.ts`、`public/assets/ui/menu-ui-0.*`）。
- `src/ui/item-name-color.ts`：新增 `equipmentGrade`（品级取实例 → 模板默认 → 2）与 `equipmentColor`（品质色），以及 `equipmentSlotFrame`（装备返回边框图键，非装备返回空）。
- `src/ui/slot-frame.ts`：格子底图的统一入口，查不到边框图就回退默认格子。
- `src/ui/story-ui.ts`：背包页装备格与物品格按品质换边框；空格子保持默认图。
- `src/ui/phaser/party-panel.ts`：队伍页装备格一起换。
- `src/ui/item-detail-lines.ts`：说明标题改用同一套取色函数，避免两处口径分叉。
- `tests/slot-frames.test.ts`：15 个品级、两档混沌、空格子、非装备各一条断言，并检查 6 张图都在配置里且文件存在。

验证：`npm run typecheck` 通过；`npm test -- tests/slot-frames.test.ts tests/ui-atlas.test.ts`、`tests/item-description.test.ts tests/menu-panels.test.ts tests/bag-layout.test.ts`、`tests/story-menu-interactions.test.ts` 共 82 项全过；`npm run validate:content` 通过（`{ maps: 416, assets: 12086 }`）。界面效果由玩家验收。

## 三、内容与流程

### 5. 兽人部落 NPC 缺少交互（确认不算 bug）

现象：钢之兽人部落里几个兽人点了没反应，只有兜底台词。

核查：原版数据 `~/Desktop/workspace/inoita/site/data/npc.json` 里，编号 259（警备队员 图罗纳克）、
260（巴乌戈）、282（萨兹）、283（古斯特）四条都没有 `functions` 字段；全库 656 个 NPC 里只有
47 个带 `functions`，武器商人（编号 0）就带，说明这个查法有效。
**原版他们就是纯剧情 NPC，我们现在和原版一致。** 不改。

### 6. 交互时只有一句「一路小心。」

核查：原先的兜底台词在 `src/domain/story-director.ts` 的 `talk`：
`entity.hint || actor.description || '一路小心。'`。一个实体既没配任务、也没配 hint、也没配描述，
交互时就会显示这句。

进一步核查根因：这些 NPC 大多已经做完任务，本该不再可交互，但 `Session.markerActor` 把任务表里
所有可见任务都算进来，不管状态，也不区分发布人和交付人。于是已完成任务、还没接的交付任务都会让
NPC 继续可选中，`talk` 又拿不到任务，只能落到兜底台词。

修法：`markerActor` 只看 `available`/`active`/`ready` 三种状态；`available` 按发布人匹配，
其余按交付人匹配，和 `forActor` 的判定一致。`talk` 没有 hint/描述时直接返回，不再编造台词。
NPC 自己的描述还在，所以有闲话的角色照样能聊。

验证：`npm test -- tests/session.test.ts tests/quest-target-interaction.test.ts` 17 项通过；
加上近身触发与门口两条回归用例共 22 项通过。

### 11. 任务道具交付后不清除

现象：净化石任务交完了，背包里还留着一颗。

核查：这颗石头被发了两次，交付只扣一次。
- 拾取原石的剧情命令发一颗：`event-66` 场景 4，`item-give purity-stone`。
- 接下 quest-53「狼人的恢复」时又发一颗：这条任务的 `onAcceptItems`。
- 交付时按数量只扣一颗：`handoverItems` 写的是 `"removal": "quantity"`。

原版对照：原版任务表里这条是类型 2。接取时 `ApplyPrepare@0x1bfe04` 发放 PREPARE 物品，
`@0x1bffe0` 对类型 2 再把「完成目标」里的物品也发一遍；交付时 `ApplyReward` 按
`remove_count_argument` 扣除，这条记录是 1。所以原版同样发两次、只扣一次，也会剩一颗。
证据见旧项目 `work/findings/45_quest_world.md` 与 `site/data/quest_chains.json` 的 53 号任务。

「多发一份」的两种来源（原版自己也带着）：
- 同一件道具既在 PREPARE 表、又在 COMPLETE 表里，接取时发两份；
- 剧情已经用 `item-give` 发过，接取时按完成目标再发一份。

决定：从源头删掉重复的那一份，交付恢复原版的「按需要数量扣」。
剩下那颗属性是 `discardable: false`、`sellable: false`，丢不掉也卖不掉，会永久占一格，
所以这里**有意偏离原版**——原版会让它留在包里。

已做（2026-10-30）：
- `public/content/campaign.json`：13 条任务删掉多余的接取发放。
  5 条接取发放整条删除，道具由剧情发（quest-50 矿山钥匙、quest-53 净化石、quest-55 魔法石、
  quest-223 猎手的遗物、quest-253 净化之泉水）；7 条是两条一模一样的接取记录，去掉一条
  （quest-64、70、71、95、172、174、304）；quest-250 精制的麦粉两条接取记录都删，剧情已经发过。
  17 条交付记录从上一版的 `"all-matching"` 改回 `"quantity"`，改成按需要数量扣。
- 新增 `src/application/quest-item-grants.ts`：算「接取发放 + 剧情净发放」，净发放要减掉剧情收回去的数量
  （递交演出常见先给一件再收回一件，例如 `event-218` 场景 8 的药方）。
- `src/application/content-relations.ts`：内容校验里加一条，发放量超过交付需求就报错，
  以后加任务不能再犯。
- `tests/quest-item-grants.test.ts`：7 项，覆盖剧情已发、接取重复记录、净额抵扣、只够交付量等情况。
- `tests/story-chapters.test.ts`、`tests/story-intake.test.ts`、`tests/quest-target-interaction.test.ts`：
  净化石与矿山钥匙改成「交货前 1 颗」，接取不再补发。

验证：`npm test -- tests/story-chapters.test.ts`（主流程 102 秒）通过；
`tests/story-intake.test.ts`、`tests/quest-target-interaction.test.ts`、`tests/quest-item-grants.test.ts`
共 32 项通过；`npm run validate:content` 通过（`{ maps: 416, assets: 12086 }`）；
`npm run debug-start:check` 通过。`tests/session-quest-core.test.ts` 有 3 条既有失败（金额 ×10，与本次无关，
在原始数据上同样失败）。

### 16. 圣女演出里三只重复的打铁 NPC

现象：帝国首都广场圣女演讲那段，场上有三只一模一样的俯身打铁 NPC。

核查：不是剧情刷了三个人，是素材挂错。演出里三名观众互不重复，问题出在它们的朝北待机图上：
`man-0e5eefd0`、`story-woman-3369ef62`、`old-man-e1fa97be`、`rich-roderick-f77d4714`
这四个角色的 `idle-north-normal.png` 是同一个文件（sha256 前 8 位 `8931e52b`，456×58，12 帧），
画面就是一个光膀子的人对着铁砧敲烧红的铁块。它们的朝南待机是普通站姿，帧尺寸 21×41；
朝北却是 38×58。尺寸对不上，说明这张图本来就不属于这类平民 NPC。

影响面：全库有 **29 个角色**共用这张图，包括商人、囚犯、厨师、富商等，不止演出里那三个。

已做（2026-10-30）：
- 原版 event 178 的角色面向指令和复刻一致：三名观众都设方向 2（北），不是剧情刷人。
- 原版普通 NPC 只有一条人物待机动画（319）；动作表里的 320 是打铁动作（和黑点奸商同款），
  321 是单帧道具图，都不是背面人物图。旧导出把朝北指向了 320，才让 29 个角色都变成铁匠。
- 没有可用的背面人物图，因此把这 29 个角色的 `idle-north` 指向各自的 `idle-south`。演出仍按原版朝北，
  画面显示人物正面；人物、尺寸和帧数都正确，不再是打铁图。原图文件保留，等以后有正确背面素材再换。
- `public/content/world.json` 只改这 29 处剪辑引用；`npm run validate:content` 通过（416 张地图、12057 个素材）。

### 17. 变异的修道院院长出现两只

现象：打变异修道院院长时场上出现两个 boss。

核查：`public/content/campaign.json` 里 `event-119` 的战斗生成列表原本写了两条，敌人 id 都是
`enemy-mutated-abbot-1`，坐标分别是 (184,232) 和 (152,248)。

根源在原版数据的搬运脚本 `~/Desktop/workspace/inoita/work/tools/game_content/export_encounters.py`：
它按命令顺序收「摆怪」记录，但没在切图（`0x0a`）时清空。原版换图后旧图上的角色不会跟过来，
事件会在新图上重新摆一遍。事件 119 先摆院长演回忆，切到回忆图再切回来重摆；脚本把切图前那次
摆位也留了下来，于是开打时多出一只。

已做（2026-10-30）：
- 脚本在切图时清空已摆记录，重新导出得到 81 场 194 只（原 198 只），`--check` 比对通过。
- `campaign.json` 里 `event-119` 只留 (152,248) 那只，正是原版唯一一条仇恨命令指的位置。
- 同一根因的 `event-401` 一并修掉：封印守护者从两只变一只、守护石像从四只变两只，与三条
  仇恨命令一一对应。
- `tests/story-chapters.test.ts` 里那句「打两次院长」改成打一次；
  `tests/story-near-warp.test.ts` 的敌人数量断言从 6 改成 3。

还没做：无。

**同类重复的第二处（2026-10-30 已修）**：`event-72` 在东卡木兰打卫兵时，遭遇生成了一只
`enemy-arnen-guard-1` 在 (120,232)，而这张地图自己的常驻刷怪点也在 (120,232) 刷同一只。
改动前，遭遇生成是**追加**到地图刷怪上的（`src/domain/world-enemies.ts:95` 起），两者不会
互相抵消，所以这里是同一只卫兵出现两次。原版这场没有生成命令，是直接让地图上那只卫兵仇恨
玩家（仇恨格 (6,12) 就在这个刷怪点旁边），复刻把它转成「再生成一只」才造成重复。地图常驻
刷怪按等级带挑选，所以这个重复只在选中该刷怪点的等级段出现。

已做：
- `src/domain/world-enemies.ts:104`-`116`：遭遇点落在常驻怪身上时，同格同敌人的常驻怪让位，
  只留遭遇那一份。判定键是 `occupiedKey(enemyId,x,y)`（同文件 `:278`）。
- 用例 `tests/story-map-objects.test.ts:87` 覆盖「遭遇开在常驻怪身上，格子里只剩一只」。
- `src/application/content-relations.ts:174` 起加了一条内容校验：同一场遭遇里同一敌人不许在同一格
  摆两条完全相同的记录；`npm run validate:content` 会拦下来。
- 全库扫过一遍，遭遇点和地图常驻刷怪撞格的只有 `event-72` 这一处，其余 80 场不受影响。

## 四、待核查与待定

### 10. 交互范围过大

现象：离净化石还有三四格远就能触发对话。

原因：挑交互目标时，带碰撞的物件在曼哈顿 24 像素之外还会再走一条兜底
`canReachChest`（两个 16×16 脚底框间隙和除以 8 不超过 6，单轴最多 64 像素）。
这条兜底本来是 2026-10-18 为「路障恢复静态碰撞后贴边站不进去」加的，但它按目标的
锚点算距离，没按目标真实的碰撞盒算，于是 16×24 的净化石也被放宽到三四格。

修法：兜底改成按目标真实碰撞盒（含 `flip` 镜像）与玩家 16×16 脚底框的间隙算。
普通剧情和 NPC 最多放宽 8 像素（1 格），只有商店保留 32 像素（4 格）的柜台距离；
近身自动起演一律用 1 格。路障、钢门这类只能贴边站的机关仍在范围内，净化石在 2 格
以外不再被选中。

验证：`tests/chests.test.ts` 覆盖 16×16 普通目标、48×32 路障、32×64 钢门、16×24
净化石和商店柜台；`tests/story-near-trigger.test.ts`、`tests/story-doorway-trigger.test.ts`
通过。

### 14. 融合器交互不对

现象：玩家不知道怎么做装备。

根因：装备配方早就在 `public/content/items.json` 的 `.recipes` 里，使用合成套装也会把配方
记进 `Bag.recipeBook`，但融合器只做混沌、深渊混沌两种加工，配方没有任何使用入口。

修法：融合器顶部加「配方合成／混沌合成」切换。配方页列出已学会的配方书配方，以及常备的
药水、宝石配方；选中后显示产物、材料、费用和组合按钮。配方书配方按 `learnedRecipes`
过滤，没学会时提示「使用合成套装或在任务中获得配方」。费用按原版：药水与装备 1，
中级／高级／顶级／混沌宝石分别为 90／360／1500／6000。

补了 14 条常备配方：恢复药水四档、再生药水四档、元气恢复药水、卓越灵药、四种宝石升级。
宝石孔生成需要先选目标装备，这轮不做。

验证：`tests/recipe-crafting.test.ts` 4 项通过；`npm run validate:content` 通过。

### 15. 宝石、强化卷轴用起来麻烦

现象：要把宝石嵌进装备、把强化卷轴用在装备上，得先长按物品，再拖到身上对应的装备格。

核查：背包拖动链路在 `src/ui/story-ui.ts:1259`-`1278`。按下后要等 350 毫秒长按计时
（`:1261`）才进拖动，中途移动超过 8 像素算取消（`:1270`），松手必须正好落在某个可放置目标上
才生效（`:1274`）。宝石、卷轴这类必须指定一件装备的道具，目标格子小、路径短，手机上很容易拖空。

修法：点宝石、强化卷轴这类必须先选装备的道具，直接进入「选装备」状态：所有能用的装备格亮起，
再点目标就使用；再点一次道具或按 Escape 取消。原来的长按拖拽保留。只改交互，不碰道具规则。

验证：`tests/story-menu-interactions.test.ts` 新增「点选装备格镶嵌宝石」用例，文件内 61 项通过；
`npm run typecheck` 通过。

## 五、处理记录

- 1（2026-10-30）：批量出售改为多选一次结算。测试 23 项通过。
- 2（2026-10-30）：补上 9 个反应类状态图标（血之复仇，加上破坏之魔甲、黑暗感知、深呼吸、
  魔法之眼、祈祷、信念之盾、狙击、狂乱之暴风的子状态），来源是原版图组 35。
  状态栏测试与内容校验通过。黑暗之刃按原版保持无图标。
- 12（2026-10-30）：数量加减不再整页重画，只改弹框里的数字、金额与箭头灰态；背包立绘改成按角色缓存。
  商店面板测试与菜单交互测试全部通过。背包和商店的静态层重画还没做。
- 14（2026-10-30）：融合器接入配方列表，补 14 条常备药水／宝石配方；52 条配方书配方按已学列表过滤。测试 4 项、内容校验通过。
- 17（2026-10-30）：提取脚本切图时作废旧图摆怪，重导出后院长与封印守护者各少一只。
  遭遇开在常驻怪身上时让常驻那只让位（修事件 72）；内容校验新增「同一格不许摆两只」。
  剧情主流程、遭遇相关用例与 `validate:content` 通过。
- 11（2026-10-30）：删掉 13 条任务重复发放的任务道具，交付恢复按需要数量扣；内容校验新增「发放不得超过需求」。
  剧情主流程、任务交互与 `validate:content`、`debug-start:check` 通过。
- 13（2026-10-30）：按品质预生成 6 张格子边框图，背包页与队伍页的装备格、背包物品格换边框，空格子与非装备不变。
  格子取色、说明标题取色现在共用同一套函数。图集测试、边框测试、菜单交互测试与 `validate:content` 通过。
- 10（2026-10-30）：交互兜底从「锚点 + 固定 48 像素」改成「真实碰撞盒边缘 + 1 格」，
  商店保留 4 格柜台距离。净化石不再隔两三格被选中，路障和钢门仍能贴边交互。
  `tests/chests.test.ts`、`tests/story-near-trigger.test.ts`、`tests/story-doorway-trigger.test.ts` 通过。
- 6（2026-10-30）：`markerActor` 只认未完成的任务，完成后的 NPC 不再可交互；没有 hint/描述时
  不再弹「一路小心。」。会话、任务交互与近身触发共 22 项测试通过。
- 15（2026-10-30）：宝石、强化卷轴改成「点道具 → 点亮可用装备格 → 点目标使用」，拖拽保留。
  菜单交互测试 61 项通过。
- 3（2026-10-30）：查清原版 Buff 的三个画面字段（`+6` 施加特效、`+8` 循环表现、`+10` 图标）：
  玩家侧眩晕 57/62/63 全是 `-1`，怪物 70/71/72 是 `flash-gold`、睡眠 76 是 `monster-sleep-aura`、
  紧急恢复 78 还有循环光环 `monster-poison-aura`。导出器原来只在技能 Buff 白名单里读这两个字段，
  怪物增益整批丢失，已修导出器并把这 6 类共 60 个等级补回 `public/content/battle.json`。
  持续期间另加头顶三颗星星（增强）；按玩家要求把暴击眩晕、钝器眩晕也补上同款金光（增强）。
  `tests/buff-visual-content.test.ts` 5 项、`validate:content`、`typecheck` 通过。

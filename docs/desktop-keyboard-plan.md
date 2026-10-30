# 电脑键鼠操作与可重绑定键位（实施计划）

记录时间：2026-10-30。

状态：计划已批准，代码尚未改动。本页是实现依据，不是当前行为的说明；落地后以源码和测试为准。

## 一、目标

现有操作全部是触屏：`MoveStick` 负责摇杆或十字键，`ActionControls` 负责攻击、六个快捷位和切组。电脑上键盘和鼠标还没有接进来。

本计划补一套电脑操作，并让玩家在设置里自己改键：

- 鼠标左键攻击。点地面普攻，点敌人选中并普攻；点界面按钮、状态面板、摇杆不攻击。
- WASD 移动。默认 W 上、S 下、A 左、D 右。
- 数字键 1–6 释放当前技能轮组的六个快捷位。快捷位里是技能就放技能，是物品就用物品。
- Q 切换技能轮组，和现有切组按钮走同一套逻辑。
- M 打开菜单。菜单、背包、商店继续用鼠标点击。
- 设置 → 键位设置：12 个动作都能改键；改键时检测“已被其他动作占用”和“浏览器或系统保留键”；改完立即生效，刷新页面后保留。
- 触屏、摇杆、十字键的布局和行为不变。

验收分两部分：`npm run typecheck` 和相关单元测试通过；浏览器里按“手动验收”逐项确认。

## 二、键位方案

### 2.1 动作与默认键

键位用 `KeyboardEvent.code`（物理按键位置），不用 `event.key`。这样输入法、大小写和大部分键盘布局不会让按键错位。

键位对象：

```ts
interface KeyBinding {
  code: string; // KeyboardEvent.code，例如 KeyW、Digit1、ArrowUp
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  meta: boolean;
}
```

| 动作 key | 界面名称 | 默认键 |
|---|---|---|
| `move.up` | 向上移动 | W |
| `move.down` | 向下移动 | S |
| `move.left` | 向左移动 | A |
| `move.right` | 向右移动 | D |
| `skill.1`–`skill.6` | 快捷位 1–6 | 1–6 |
| `wheel.next` | 切换技能轮组 | Q |
| `menu` | 打开菜单 | M |

鼠标左键攻击固定，不进入重绑列表。右键暂时不加功能。

Shift 组合允许，例如 `Shift+W`。Ctrl、Alt、Meta 组合一律拒绝，因为浏览器和操作系统会先处理它们。

当前 `MoveStick` 里藏着 Arrow 键的方向别名。这套别名要删掉，方向键改为可以自己绑到移动上。

### 2.2 菜单键为什么用 M

浏览器全屏时，`Escape` 往往先被浏览器用来退出全屏，网页不一定收得到。所以菜单默认用 M，`Escape` 只做固定的关闭/取消键，不参与重绑。

### 2.3 保留键

下面这些键不能绑定。编辑器和存储加载共用同一套判断，提示中文原因：

| 按键 | 原因 |
|---|---|
| 任何 Ctrl / Alt / Meta 组合 | 会被浏览器或系统占用 |
| `F1`–`F12` | F1–F12 由浏览器占用 |
| `Tab` | Tab 用于菜单焦点切换 |
| `Escape` | Esc 用于关闭菜单和取消操作 |
| `Backspace` | Backspace 在浏览器里会后退 |
| 单独的 Shift / Control / Alt / Meta | 修饰键不能单独绑定 |
| `CapsLock`、`NumLock`、`ScrollLock`、`Pause`、`PrintScreen`、`Insert`、`ContextMenu` | 这个键由浏览器或系统保留 |
| `Browser*` | 浏览器功能键不能绑定 |
| 空 code | 没有识别到按键 |

浏览器地址栏、标签页、全屏等系统级快捷键，网页 API 既不能枚举也不能拦截。编辑器做静态拒绝，并明确写“这些键由浏览器先处理”；不假装能检测全部系统快捷键。

### 2.4 冲突检测

冲突范围覆盖 12 个动作。按下的键已经属于另一个动作时，返回：

```text
已被「向下移动」占用
```

同一个动作重新绑定成它当前的键不算冲突。失败时不写入存储，编辑器保持捕获状态并显示原因。

### 2.5 存储

- localStorage key：`inotia4.keys.v1`
- 格式：`{format: 1, bindings: Record<KeyBindingAction, string>}`
- 字符串是规范形式，例如 `KeyW`、`Shift+KeyW`、`ArrowUp`。
- 写盘失败只吞掉错误，内存里的绑定仍然生效。
- 键位是本机设置，不进存档，不改 `SAVE_FORMAT`，不碰 `src/domain/save-game.ts`。

## 三、代码结构

### 3.1 新增文件

| 文件 | 职责 |
|---|---|
| `src/domain/key-bindings.ts` | 动作表、默认键、键位对象、存储串与显示串、保留键判断。纯数据和纯函数，不依赖 Phaser。 |
| `src/application/key-bindings.ts` | `KeyBindingPreferences`：读写 localStorage、冲突检测、匹配按键、订阅变更、单例。 |
| `src/ui/phaser/keyboard-actions.ts` | 世界场景的键盘派发：数字键放快捷位，Q 切组。只 `import type Phaser`，便于单测。 |
| `src/ui/phaser/key-binding-editor.ts` | 设置里的键位编辑面板：两列 12 行、捕获按键、错误提示、恢复默认。 |
| `tests/key-bindings.test.ts` | 键位数据、存储、冲突、保留键的单元测试。 |
| `tests/keyboard-actions.test.ts` | 键盘派发的单元测试。 |

### 3.2 修改文件

| 文件 | 改动 |
|---|---|
| `src/ui/phaser/move-stick.ts` | 删掉硬编码 WASD/Arrow；改为按 `KeyBindingPreferences` 匹配四个移动动作。 |
| `src/scenes/world-scene.ts` | 接入 `KeyboardActions`；数字键放快捷位；抽出切组方法；世界级左键攻击。 |
| `src/scenes/world-combat.ts` | 给敌人容器加 `enemy` 标记，左键点敌人优先攻击。 |
| `src/rendering/status-hud.ts` | 给成员面板和玩家大面板加 `uiAction` 标记，点面板不攻击。 |
| `src/scenes/formal-ui-scene.ts` | 界面按钮点击阻止世界场景再收到；键位捕获时跳过菜单键盘处理。 |
| `src/ui/game-ui.ts` | 新增 `keyBindingEditing` 状态和 setter。 |
| `src/application/ports.ts` | 上下文增加 `keyBindings`，界面状态增加 `keyBindingEditing`。 |
| `src/app.ts` | `StoryApp` 持有 `keyBindings`。 |
| `src/ui/story-ui.ts` | 设置页新增“键位设置”；菜单键；编辑面板的打开、关闭、同步和销毁。 |
| `src/main.ts` | 诊断信息增加 `editingKeys`。 |
| `tests/control-settings.test.ts` | 桩 scene 补键盘监听；新增 MoveStick 绑定测试。 |
| `tests/story-menu-interactions.test.ts` | 测试夹具补 `keyBindings`。 |

## 四、领域层与存储层

### 4.1 `src/domain/key-bindings.ts`

导出：

```ts
const KEY_ACTIONS: readonly KeyBindingAction[];
const SKILL_BINDING_ACTIONS: readonly KeyBindingAction[];
const DEFAULT_KEY_BINDINGS: Readonly<Record<KeyBindingAction, KeyBinding>>;
const KEY_ACTION_LABELS: Readonly<Record<KeyBindingAction, string>>;

function bindingFromEvent(event: KeyboardEvent): KeyBinding | undefined;
function bindingKey(binding: KeyBinding): string;
function bindingFromKey(value: string): KeyBinding | undefined;
function formatBinding(binding: KeyBinding): string;
function reservedBindingReason(binding: KeyBinding): string | undefined;
```

几个细节：

- `bindingFromEvent` 用 `event.code || event.key`。合成输入中、单独修饰键返回 `undefined`；保留键仍然返回 binding，交给上层显示原因。
- `formatBinding` 负责把 code 变成玩家看得懂的字：`KeyW → W`、`Digit1 → 1`、`ArrowUp → ↑`、`Space → 空格`、`Numpad1 → 小键盘 1`，有修饰位时加 `Shift+` 前缀。
- 显示按标准 US 布局换算字母和数字；实际绑定以物理 code 为准。非 US 布局的标签可能不同，但功能正确。

### 4.2 `src/application/key-bindings.ts`

```ts
class KeyBindingPreferences {
  constructor(storage?: StorageLike);
  get(action: KeyBindingAction): KeyBinding;
  snapshot(): Readonly<Record<KeyBindingAction, KeyBinding>>;
  set(action: KeyBindingAction, binding: KeyBinding): string | undefined;
  reset(): void;
  subscribe(listener: () => void): () => void;
  validate(action: KeyBindingAction, binding: KeyBinding): string | undefined;
  matches(action: KeyBindingAction, event: KeyboardEvent): boolean;
  actionFor(binding: KeyBinding, except?: KeyBindingAction): KeyBindingAction | undefined;
}
```

行为：

- `set` 返回错误消息，不抛异常；编辑器直接显示。成功时写盘并通知订阅者。
- `matches` 精确比较 code 和 shift / ctrl / alt / meta 四个修饰位；`event.isComposing` 为真时返回 `false`。
- `reset` 恢复默认、写盘、通知。
- `subscribe` 返回退订函数。

加载顺序：

1. 默认值起步。
2. JSON 损坏、`format !== 1`、`bindings` 不是对象 → 全部默认。
3. 逐项用 `bindingFromKey` 解析。解析失败或命中保留键的项回默认。
4. 先合并全部存储值，再判重。某个键被两个动作占用时，把这两个动作都回默认；仍有重复就整体回默认。

第 4 步必须先合并再判重，否则把 W/S 互换保存后，读到第一项就会把第二项当成冲突，互换配置永远读不回来。

写盘用 try/catch；`subscribe` 用 `Set`。导出单例 `keyBindings`，默认取 `localStorage` 时包 try/catch，非浏览器环境回 `undefined`。

## 五、键盘派发与移动

### 5.1 `src/ui/phaser/keyboard-actions.ts`

```ts
interface KeyboardActionHandlers {
  skill(slot: number): void;
  cycle(): void;
}

class KeyboardActions {
  constructor(
    scene: Phaser.Scene,
    bindings: KeyBindingPreferences,
    handlers: KeyboardActionHandlers,
  );
  destroy(): void;
}
```

- 监听 `scene.input.keyboard.on('keydown', ...)`。
- 匹配 `skill.1`–`skill.6` 时 `event.preventDefault()`，调用 `skill(1..6)`。
- 匹配 `wheel.next` 时 `event.preventDefault()`，调用 `cycle()`。
- 过滤输入框、`isComposing`、`repeat`。repeat 仍要 `preventDefault()`，但不重复触发动作。
- 只 `import type Phaser`，运行时没有 Phaser 依赖，测试可以直接用桩 scene。
- `destroy()` 解绑监听。

### 5.2 `src/ui/phaser/move-stick.ts`

- 构造函数增加第 5 个参数：

  ```ts
  bindings: KeyBindingPreferences = keyBindings
  ```

- 删除 `keyToCardinal` 和硬编码的 WASD / Arrow 映射。
- `keyHistory` 改为 `{dir: CardinalDir; code: string}[]`。
- `onKeyDown`：
  - 先用 `bindings.matches('move.up' | 'move.down' | 'move.left' | 'move.right', event)` 找方向；
  - 命中后 `preventDefault()`；
  - 同 code 已在历史里就直接返回；
  - 否则 push，`pointerId < 0` 时 `syncKeyAxis()`。
- `onKeyUp` 按 `event.code` 从 `keyHistory` 移除，再 `syncKeyAxis()`。不依赖修饰键状态，避免先松开 Shift 导致方向卡住。
- `syncKeyAxis()` 取 `keyHistory.at(-1)?.dir`，保持“后按优先，不叠加”。
- 构造时订阅 `bindings.subscribe(() => this.reset())`，`destroy()` 退订。
- 触屏 pointer、死区、摇杆/十字键外观完全不动。

## 六、世界场景

### 6.1 键盘快捷位

`src/scenes/world-scene.ts` 新增 `private keyboardActions?: KeyboardActions`。

`open()` 里创建：

```ts
this.keyboardActions = new KeyboardActions(this, this.app.keyBindings, {
  skill: slot => this.triggerShortcutSlot(slot),
  cycle: () => this.cycleShortcutPage(),
});
```

`shutdown` 里 `this.keyboardActions?.destroy()`。

新增 `private triggerShortcutSlot(slot: number): void`：

1. `canControl` 检查。
2. `controlledContext()` 取 `member / owner / configuration / page`。
3. 用 `shortcutBar(owner, member.classId, configuration).page(page)[slot - 1]` 取当前格的条目。
4. 物品走 `useShortcutItem(entry.id)`。
5. 技能走 `this.combat?.attack(entry.id)`。

冷却、蓝耗、是否装备继续由 `WorldCombat.attack` 校验，不在键盘层重复。

### 6.2 切换技能轮组

把现有 `ActionControls` 的 `swap` 回调抽成 `private cycleShortcutPage(): void`，行为保持：

- `canControl` 检查。
- 取 `controlledMember ?? session.hero`。
- 玩家用 `session.skills`，队友用 `member.skills`。
- `nextShortcutPage(member.classId)` 后 `refreshLoadout()`。

`ActionControls` 的 `swap` 改为调用这个方法，Q 键也调用它。

### 6.3 世界级左键

`create()` 注册：

```ts
this.input.on(Phaser.Input.Events.POINTER_DOWN, this.onPointerDown, this);
```

`shutdown` 里解绑。

```ts
private onPointerDown(
  pointer: Phaser.Input.Pointer,
  objects: Phaser.GameObjects.GameObject[],
): void {
  if (pointer.button !== 0 || pointer.wasTouch || this.stageOccluded) return;
  if (!this.canControl) return;
  if (objects.some(object => object.getData('uiAction'))) return;
  if (objects.some(object => object.getData('enemy'))) {
    this.startBasicAttack();
    return;
  }
  this.attackKey();
}
```

含义：

- 只处理鼠标左键；触屏和手写笔的 `wasTouch` 直接跳过。
- 点 HUD、状态面板、界面按钮不攻击。
- 点敌人直接普攻，不会被旁边的宝箱或交互物抢走。
- 其他地面点击走现有 `attackKey()`：先看身边有没有可交互对象，有就交互，没有就普攻。
- 不新增点击移动。移动仍由 WASD 或触屏摇杆负责。

### 6.4 敌人标记

`src/scenes/world-combat.ts` 的 `makeSelectable` 给敌人容器加：

```ts
.setData('enemy', true)
```

敌人原有的 `pointerdown → selectEnemy` 保留，不调用 `stopPropagation`，让世界场景能继续收到这次点击并攻击。

### 6.5 状态面板标记

`src/rendering/status-hud.ts` 的成员面板容器（约 60 行）和玩家大面板 `playerContainer`（约 168 行）在 `setInteractive` 后链式加：

```ts
.setData('uiAction', true)
```

第 91 行重新 `disableInteractive().setInteractive()` 不会清掉 data，不需要重复设置。这样点面板只走面板自己的 `pointerup`，不会触发世界普攻。

### 6.6 `canControl`

```ts
private get canControl(): boolean {
  return this.sys.isActive()
    && !this.loadingWorld
    && this.app.ui.ready
    && !this.app.ui.controlLayoutEditing
    && !this.app.ui.keyBindingEditing
    && !this.app.locked
    && !this.app.suspended
    && !this.app.director?.busy;
}
```

编辑器打开时，世界侧技能、移动、攻击全部关掉，不依赖键盘事件跨场景的先后顺序。

## 七、界面与菜单

### 7.1 `FormalUiScene` 的点击和键盘

`src/scenes/formal-ui-scene.ts` 的 `pointerdown` 改为：

```ts
if (this.app.ui.defeated || this.app.ui.worldRebuildCover) return;
if (objects.some(object => object.getData('uiAction'))) {
  this.input.stopPropagation();
  return;
}
if (this.app.ui.keyBindingEditing) return;
this.app.ui.pressDialogue(pointer.id);
```

点任何界面按钮时阻止世界场景再收到同一次点击。`FormalUiScene` 的键盘 handler 在 `suspended` / `worldRebuildCover` 判断之后加：

```ts
if (this.app.ui.keyBindingEditing) return;
```

避免按键捕获时 Enter / 空格误触菜单按钮。

### 7.2 `GameUI` 状态

`src/ui/game-ui.ts`：

```ts
keyBindingEditing = false;

setKeyBindingEditing(value: boolean): void {
  if (this.keyBindingEditing === value) return;
  this.keyBindingEditing = value;
  this.resetInput();
  this.updateControls();
}
```

`setMode()` 里与 `controlLayoutEditing = false` 同处加 `this.keyBindingEditing = false`。

### 7.3 端口与装配

`src/application/ports.ts`：

- `StoryContext`、`StoryUIContext` 增加 `readonly keyBindings: KeyBindingPreferences`。
- `SceneUI` 增加 `'keyBindingEditing'`。
- `StoryUIContext.ui` 的 Pick 增加 `'keyBindingEditing' | 'setKeyBindingEditing'`。

`src/app.ts`：

```ts
readonly keyBindings = new KeyBindingPreferences();
```

放在 `controlLayout` 旁边。

`src/main.ts`：诊断信息增加 `editingKeys: ui.keyBindingEditing`，便于现场确认状态。

### 7.4 设置页入口

`src/ui/story-ui.ts` 的 `renderSettings()` 在“移动方式”之后、“操作设置”之前插入一行“键位设置”：

- label：`260, rowTop + 15`
- 按钮：`485, rowTop, 220, 66`
- 行距继续 90
- 点击调用 `openKeyBindingEditor()`

音乐、音效、帧率、暴击四行的固定 y=80/170/260/350 不变。

### 7.5 菜单键

`StoryUI.key(event)` 的打开菜单逻辑：

- `suspended` 判断后，如果 `ui.keyBindingEditing`，转给 `keyBindingEditor?.key(event)` 并 return。
- `renameRef` 判断保留。
- 原来“菜单没开就直接 return”的分支改为：

  ```ts
  if (!event.repeat && this.session && this.app.ui.mode === 'game'
      && this.app.ui.ready && !this.app.ui.locked
      && this.app.keyBindings.matches('menu', event)) {
    event.preventDefault();
    this.show('bag');
  }
  return;
  ```

- 菜单已开时保持原有 Escape / Tab / Enter / 空格逻辑。
- 这条路径不调用 `event.stopPropagation()`。世界侧在菜单打开时已经通过 `ui.locked` 关掉输入，不需要依赖场景键盘顺序，也不会破坏现有测试桩。

### 7.6 `StoryUI` 同步与关闭

- 新增 `private keyBindingEditor?: KeyBindingEditor`。
- `attach(scene)` 的 shutdown 清理里销毁 `keyBindingEditor`。
- `sync()`：
  - `surface.enabled()` 和 `body.enabled()` 增加 `!ui.keyBindingEditing`；
  - `menu` 条件增加 `!ui.keyBindingEditing`；
  - `keyBindingEditor?.visible(open && ui.keyBindingEditing && !suspended)`；
  - 末尾 `layout()` 调用 `keyBindingEditor.layout()`。
- `close()`：先 `keyBindingEditor?.close()`、`ui.setKeyBindingEditing(false)`，再执行原有清理。
- 新增 `openKeyBindingEditor()` / `closeKeyBindingEditor()`：
  - 懒建 `new KeyBindingEditor(this.scene, this.app.keyBindings, this.app.menuPanels.assets, () => this.closeKeyBindingEditor())`；
  - 打开：`open()`、`ui.setKeyBindingEditing(true)`、`render()`；
  - 关闭：`close()`、`page = 'settings'`、`ui.setKeyBindingEditing(false)`、`render()`。

## 八、键位编辑面板

`src/ui/phaser/key-binding-editor.ts` 结构仿 `src/ui/phaser/control-layout-editor.ts`。

### 8.1 外观

- `UiSurface(scene, 960, 640, 350)`，`frame(assets, 0, 0, 960, 640)`。
- 标题“键位设置”；副标题“点击动作后按下新按键；鼠标左键攻击固定”。
- 两列，每列 6 行：
  - 左“移动与轮组”：向上、向下、向左、向右、切换技能轮组、打开菜单。
  - 右“技能与快捷位”：快捷位 1–6。
- 每行一个文字标签加一个键位按钮（约 140×48）。
- 底部“恢复默认”200×56、“返回”160×56；右上关闭按钮 67×67（`assets.close` / `assets['close-pressed']`）。
- 底部说明：“Ctrl/Alt/Command 组合和 F1–F12 由浏览器或系统占用”。

### 8.2 捕获流程

1. 点击某个动作的键位按钮，进入捕获；按钮显示“按下按键…”并高亮。
2. 捕获中 `Escape` 取消。
3. 修饰键、输入法合成中的键忽略。
4. 调用 `preferences.set(action, binding)`：
   - 失败：显示 `键名：原因`，保持捕获；
   - 成功：显示“已绑定…”，退出捕获。
5. 任何导致面板重画的操作都重新渲染当前绑定。

监听 `UI_EVENTS.cancelInput` 和 `scene.input` 的 `gameout` 取消捕获，避免切走窗口后一直停在“按下按键…”。

### 8.3 生命周期

- `open()`：清空重画、`active = true`、`visible(true)`、`layout()`。
- `close()`：只隐藏并清捕获，不清空面板。避免在按钮自己的 `pointerup` 里销毁对象。
- `visible(false)`：同时取消捕获。
- `key(event)`：捕获中优先处理；否则 Escape 关闭，其余转给 `panel.key(event)` 处理 Tab / Enter / 空格。
- `destroy()`：解绑事件、销毁 `UiSurface`。

## 九、测试

新增：

### 9.1 `tests/key-bindings.test.ts`

- 默认键位完整且不重复。
- `bindingKey` / `bindingFromKey` 回环。
- 保留键：Escape、Tab、Backspace、F1、Ctrl+W、Alt+1、Meta+K、单独 Shift。
- 重复检测：把 `move.down` 绑到 `KeyW` 返回“已被向上移动占用”。
- 同动作同键允许。
- Shift 组合保存和读取。
- 存储坏 JSON、错误 format、未知 code 回默认。
- 写盘失败仍生效。
- W/S 互换能读回。
- `reset()` 和 `subscribe()`。

### 9.2 `tests/keyboard-actions.test.ts`

- 桩 `scene.input.keyboard.on/off`。
- 1–6 触发 `skill(1..6)`。
- Q 触发 `cycle()`。
- 无关键不触发。
- repeat、Ctrl 组合、输入法合成不触发。
- 改绑后立即生效。
- `destroy()` 后不再触发。

### 9.3 修改现有测试

- `tests/control-settings.test.ts`：桩 scene 补 `input.keyboard.on/off`；新增 MoveStick 绑定测试：把 `move.up` 改成 `ArrowUp` 后，`KeyW` 不动、`ArrowUp` 动、keyup 归零。
- `tests/story-menu-interactions.test.ts`：`fixture()` 的 `StoryUIContext` 字面量补 `keyBindings: new KeyBindingPreferences()`。现有 `scene.key()` 桩不调用 `stopPropagation`，新逻辑不依赖它。

### 9.4 验证命令

```bash
npm run typecheck
npm test -- tests/key-bindings.test.ts tests/keyboard-actions.test.ts tests/control-settings.test.ts tests/story-menu-interactions.test.ts tests/control-layout.test.ts tests/world-control-preview.test.ts tests/shortcut-bar.test.ts
```

不启动浏览器自动化；内容文件没改，不跑 `validate:content`。

## 十、边界与失败模式

| 情况 | 处理 |
|---|---|
| 点 HUD、状态面板、界面按钮 | 世界级 pointerdown 过滤 `uiAction`；FormalUiScene 对界面点击 `stopPropagation()` |
| 点敌人 | 敌人容器带 `enemy` 标记，直接 `startBasicAttack()`，优先于附近交互物 |
| 点宝箱、触屏控件 | 它们自己的对象级 pointerdown 已 `stopPropagation()`，世界场景收不到 |
| 触屏和手写笔 | `pointer.wasTouch` 为真时直接返回 |
| 菜单或键位编辑面板打开 | `ui.locked` / `keyBindingEditing` 让 `canControl` 为 false，摇杆隐藏、战斗输入拒绝 |
| 焦点在输入框 | `document.activeElement` 为 INPUT / TEXTAREA / SELECT / contentEditable 时忽略 |
| 输入法拼写中 | `event.isComposing` 为真时忽略 |
| 先松开 Shift | keyup 按物理 code 清方向，不卡移动 |
| 浏览器系统快捷键 | 静态拒绝 Ctrl/Alt/Meta、F1–F12、Tab、Esc、Backspace 和浏览器键；界面说明网页无法拦截地址栏/标签页快捷键 |
| 全屏下的 Esc | 浏览器可能先退出全屏，所以菜单键默认 M |
| 存储损坏 | 回默认，不影响进游戏 |
| 写盘失败 | 仅内存生效，不阻塞操作 |
| 非 US 键盘布局 | 绑定按物理 code 生效；显示标签可能不同，但功能正确 |

## 十一、假设

- 目标平台是桌面浏览器；移动端保留现有触屏操作。
- 键位编辑面板在所有设备都显示，但没有硬件键盘时玩家不会用它。
- 默认菜单键用 M 而不是 Esc，避开浏览器全屏的 Esc 抢占。
- 鼠标左键攻击固定，不做鼠标键重绑；右键暂不新增功能。
- 键位是本机设置，不随存档同步，不 bump `SAVE_FORMAT`。
- 不引入新依赖，只用现有 Phaser 4、TypeScript、node:test。

## 十二、实施顺序

1. 新增 `src/domain/key-bindings.ts`、`src/application/key-bindings.ts`，补 `tests/key-bindings.test.ts`。
2. 新增 `src/ui/phaser/keyboard-actions.ts`，补 `tests/keyboard-actions.test.ts`。
3. 改 `MoveStick`，扩展 `tests/control-settings.test.ts`。
4. 改 `GameUI`、`ports.ts`、`app.ts`、`main.ts` 诊断字段。
5. 改 `WorldScene` 的键盘快捷位、切组、左键攻击；补 `world-combat` 敌人标记和 `status-hud` 界面标记。
6. 新增 `KeyBindingEditor`，接入 `StoryUI` 设置页、键盘路由、`sync` / `close` / `layout` / shutdown；改 `FormalUiScene` 的键盘与点击分派。
7. 更新 `tests/story-menu-interactions.test.ts` 的 fixture。
8. 跑 typecheck 和相关测试，修到全绿；单独创建一次 Git 提交，提交说明写清行为与验证命令。

## 十三、手动验收

- 进游戏后 WASD 能走，数字 1–6 能放当前轮组的技能，Q 能切轮组，M 能开菜单。
- 左键点地面会普攻；点敌人会选中并攻击；点状态面板、HUD、摇杆不会攻击；点宝箱仍开箱。
- 设置页能看到“键位设置”，进入后 12 个动作都有当前键；改一个键后立刻能用，刷新页面后仍在。
- 把“向下移动”改成 W 会提示已被“向上移动”占用；按 Escape / Tab / F1 / Ctrl+W 会提示保留原因。
- 把“向上移动”改成方向键上，W 和方向键上都能按预期工作；先松 Shift 不会卡住移动。
- 菜单打开时按 WASD、数字键不会让角色移动或放技能；关闭菜单后恢复。
- 触屏摇杆、十字键、技能按钮、背包拖拽和以前一致。

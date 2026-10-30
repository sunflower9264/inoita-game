/**
 * 电脑键位的动作表与纯函数。
 *
 * 绑定以 `KeyboardEvent.code`（物理按键位置）为准，不受输入法、大小写和键盘布局影响；
 * `event.key` 只在浏览器没给出 code 时兜底。存储和比较都用规范串，例如 `KeyW`、`Shift+KeyW`。
 */
export const KEY_ACTIONS = [
  'move.up', 'move.down', 'move.left', 'move.right',
  'party.previous', 'party.next',
  'skill.1', 'skill.2', 'skill.3', 'skill.4', 'skill.5', 'skill.6',
  'wheel.next', 'menu'
] as const;
export type KeyBindingAction = typeof KEY_ACTIONS[number];

export const SKILL_BINDING_ACTIONS = KEY_ACTIONS.filter(action => action.startsWith('skill.')) as readonly KeyBindingAction[];

export interface KeyBinding {
  /** `KeyboardEvent.code`，例如 `KeyW`、`Digit1`、`ArrowUp`。 */
  code: string;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  meta: boolean;
}

const binding = (code: string): KeyBinding => ({ code, shift: false, ctrl: false, alt: false, meta: false });

/** 默认键：WASD 移动、Q/E 切人、数字键 1–6 放快捷位、空格切组、M 开菜单。 */
export const DEFAULT_KEY_BINDINGS: Readonly<Record<KeyBindingAction, KeyBinding>> = {
  'move.up': binding('KeyW'),
  'move.down': binding('KeyS'),
  'move.left': binding('KeyA'),
  'move.right': binding('KeyD'),
  'party.previous': binding('KeyQ'),
  'party.next': binding('KeyE'),
  'skill.1': binding('Digit1'),
  'skill.2': binding('Digit2'),
  'skill.3': binding('Digit3'),
  'skill.4': binding('Digit4'),
  'skill.5': binding('Digit5'),
  'skill.6': binding('Digit6'),
  'wheel.next': binding('Space'),
  menu: binding('KeyM')
};

export const KEY_ACTION_LABELS: Readonly<Record<KeyBindingAction, string>> = {
  'move.up': '向上移动',
  'move.down': '向下移动',
  'move.left': '向左移动',
  'move.right': '向右移动',
  'party.previous': '上一个操作人物',
  'party.next': '下一个操作人物',
  'skill.1': '快捷位 1',
  'skill.2': '快捷位 2',
  'skill.3': '快捷位 3',
  'skill.4': '快捷位 4',
  'skill.5': '快捷位 5',
  'skill.6': '快捷位 6',
  'wheel.next': '切换技能组',
  menu: '打开菜单'
};

export const MOVE_BINDING_ACTIONS = ['move.up', 'move.down', 'move.left', 'move.right'] as const;
export type MoveBindingAction = typeof MOVE_BINDING_ACTIONS[number];

const MODIFIER_CODES = new Set([
  'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight',
  'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'OSLeft', 'OSRight',
  // 没有 code 时 `event.key` 会给出这些裸名字，同样不能单独绑定。
  'Shift', 'Control', 'Alt', 'Meta', 'AltGraph'
]);

const LOCK_CODES: Readonly<Record<string, string>> = {
  CapsLock: '这个键由浏览器或系统保留',
  NumLock: '这个键由浏览器或系统保留',
  ScrollLock: '这个键由浏览器或系统保留',
  Pause: '这个键由浏览器或系统保留',
  PrintScreen: '这个键由浏览器或系统保留',
  Insert: '这个键由浏览器或系统保留',
  ContextMenu: '这个键由浏览器或系统保留'
};

const KEY_LABELS: Readonly<Record<string, string>> = {
  Space: '空格',
  Enter: '回车',
  NumpadEnter: '小键盘回车',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  ShiftLeft: 'Shift',
  ShiftRight: 'Shift',
  ControlLeft: 'Ctrl',
  ControlRight: 'Ctrl',
  AltLeft: 'Alt',
  AltRight: 'Alt',
  MetaLeft: 'Command',
  MetaRight: 'Command'
};

/** `KeyboardEvent.code` / `event.key` 的合法形状；所有标准 code 都是字母开头的单词。 */
const CODE_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/;

function keyLabel(code: string): string {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return `小键盘 ${code.slice(6)}`;
  return KEY_LABELS[code] ?? code;
}

/** 从键盘事件读出一次按键；输入法合成中、单独的修饰键或识别不出按键时返回 undefined。 */
export function bindingFromEvent(event: KeyboardEvent): KeyBinding | undefined {
  if (event.isComposing) return undefined;
  const code = event.code || event.key;
  if (!code || MODIFIER_CODES.has(code) || !CODE_PATTERN.test(code)) return undefined;
  return { code, shift: event.shiftKey, ctrl: event.ctrlKey, alt: event.altKey, meta: event.metaKey };
}

/** 规范串：修饰位按 Shift、Ctrl、Alt、Meta 的顺序加前缀。 */
export function bindingKey(binding: KeyBinding): string {
  return `${binding.shift ? 'Shift+' : ''}${binding.ctrl ? 'Ctrl+' : ''}${binding.alt ? 'Alt+' : ''}${binding.meta ? 'Meta+' : ''}${binding.code}`;
}

/** 解析规范串；格式不对时返回 undefined。 */
export function bindingFromKey(value: string): KeyBinding | undefined {
  if (!value) return undefined;
  const parts = value.split('+');
  const code = parts.pop()!;
  if (!CODE_PATTERN.test(code)) return undefined;
  const result = binding(code);
  for (const part of parts) {
    if (part === 'Shift') result.shift = true;
    else if (part === 'Ctrl' || part === 'Control') result.ctrl = true;
    else if (part === 'Alt') result.alt = true;
    else if (part === 'Meta' || part === 'Command') result.meta = true;
    else return undefined;
  }
  return result;
}

/** 给玩家看的键名：`KeyW → W`、`Digit1 → 1`、`ArrowUp → ↑`、`Shift+KeyW → Shift+W`。 */
export function formatBinding(binding: KeyBinding): string {
  return `${binding.shift ? 'Shift+' : ''}${binding.ctrl ? 'Ctrl+' : ''}${binding.alt ? 'Alt+' : ''}${binding.meta ? 'Command+' : ''}${keyLabel(binding.code)}`;
}

/**
 * 不能绑定的键及原因。浏览器地址栏、标签页、全屏等系统快捷键无法枚举，
 * 这里只拒绝能从按键本身判断的部分，界面文案说明其余的会被浏览器先处理。
 */
export function reservedBindingReason(binding: KeyBinding): string | undefined {
  if (!binding.code) return '没有识别到按键';
  if (binding.ctrl || binding.alt || binding.meta) return '会被浏览器或系统占用';
  if (/^F([1-9]|1[0-2])$/.test(binding.code)) return 'F1–F12 由浏览器占用';
  if (binding.code === 'Tab') return 'Tab 用于菜单焦点切换';
  if (binding.code === 'Escape') return 'Esc 用于关闭菜单和取消操作';
  if (binding.code === 'Backspace') return 'Backspace 在浏览器里会后退';
  if (MODIFIER_CODES.has(binding.code)) return '修饰键不能单独绑定';
  if (LOCK_CODES[binding.code]) return LOCK_CODES[binding.code];
  if (binding.code.startsWith('Browser')) return '浏览器功能键不能绑定';
  return undefined;
}

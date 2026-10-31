import {
  DEFAULT_KEY_BINDINGS,
  KEY_ACTIONS,
  KEY_ACTION_LABELS,
  bindingFromKey,
  bindingKey,
  reservedBindingReason,
  type KeyBinding,
  type KeyBindingAction
} from '../domain/key-bindings.ts';

export interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void }

export const KEY_BINDINGS_STORAGE_KEY = 'inotia4.keys.v1';
const FORMAT = 1;

function deviceStorage(): StorageLike | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

function defaults(): Record<KeyBindingAction, KeyBinding> {
  return Object.fromEntries(KEY_ACTIONS.map(action => [action, { ...DEFAULT_KEY_BINDINGS[action] }])) as Record<KeyBindingAction, KeyBinding>;
}

/**
 * 本机键位偏好。键位不进存档、不参与 `SAVE_FORMAT`；
 * 写盘失败只影响刷新后的保留，当前运行仍用内存里的绑定。
 */
export class KeyBindingPreferences {
  private readonly storage: StorageLike | null;
  private bindings: Record<KeyBindingAction, KeyBinding>;
  private readonly listeners = new Set<() => void>();

  constructor(storage?: StorageLike | null) {
    this.storage = storage === undefined ? deviceStorage() : storage;
    this.bindings = this.load();
  }

  get(action: KeyBindingAction): KeyBinding { return { ...this.bindings[action] }; }

  /** 检查一次绑定能否写入；返回给玩家看的中文原因，`undefined` 表示可用。 */
  validate(action: KeyBindingAction, binding: KeyBinding): string | undefined {
    const reserved = reservedBindingReason(binding);
    if (reserved) return reserved;
    const owner = this.actionFor(binding, action);
    if (owner) return `已被「${KEY_ACTION_LABELS[owner]}」占用`;
    return undefined;
  }

  /** 写入失败时返回原因，不抛异常；成功时写盘并通知订阅者。 */
  set(action: KeyBindingAction, binding: KeyBinding): string | undefined {
    const error = this.validate(action, binding);
    if (error) return error;
    this.bindings[action] = { ...binding };
    this.save();
    return undefined;
  }

  reset(): void {
    this.bindings = defaults();
    this.save();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** 按键与绑定逐项比较，修饰键也必须一致；输入法合成中不算按键。 */
  matches(action: KeyBindingAction, event: KeyboardEvent): boolean {
    if (event.isComposing) return false;
    const binding = this.bindings[action];
    return binding.code === (event.code || event.key)
      && binding.shift === event.shiftKey
      && binding.ctrl === event.ctrlKey
      && binding.alt === event.altKey
      && binding.meta === event.metaKey;
  }

  /** 这个按键当前属于哪个动作；`except` 用来排除正在重绑的动作本身。 */
  actionFor(binding: KeyBinding, except?: KeyBindingAction): KeyBindingAction | undefined {
    const key = bindingKey(binding);
    return KEY_ACTIONS.find(action => action !== except && bindingKey(this.bindings[action]) === key);
  }

  private load(): Record<KeyBindingAction, KeyBinding> {
    const result = defaults();
    let saved: unknown;
    try { saved = JSON.parse(this.storage?.getItem(KEY_BINDINGS_STORAGE_KEY) ?? 'null'); }
    catch { return result; }
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return result;
    const { format, bindings } = saved as { format?: unknown; bindings?: unknown };
    if (format !== FORMAT || !bindings || typeof bindings !== 'object' || Array.isArray(bindings)) return result;

    // 先把所有能解析的存储值合并进来，再统一判重：
    // 否则把 W/S 互换保存后，读到第二项时会以为它和第一项冲突，互换配置永远读不回来。
    for (const action of KEY_ACTIONS) {
      const raw = (bindings as Record<string, unknown>)[action];
      if (typeof raw !== 'string') continue;
      const binding = bindingFromKey(raw);
      if (!binding || reservedBindingReason(binding)) continue;
      result[action] = binding;
    }
    const owners = new Map<string, KeyBindingAction[]>();
    for (const action of KEY_ACTIONS) {
      const key = bindingKey(result[action]);
      const list = owners.get(key);
      if (list) list.push(action); else owners.set(key, [action]);
    }
    for (const actions of owners.values())
      if (actions.length > 1) for (const action of actions) result[action] = { ...DEFAULT_KEY_BINDINGS[action] };

    // 回默认后可能又撞上别的存储值（例如技能位曾是 W）；仍有重复就整体回默认。
    const seen = new Set<string>();
    for (const action of KEY_ACTIONS) {
      const key = bindingKey(result[action]);
      if (seen.has(key)) return defaults();
      seen.add(key);
    }
    return result;
  }

  private save(): void {
    try {
      this.storage?.setItem(KEY_BINDINGS_STORAGE_KEY, JSON.stringify({
        format: FORMAT,
        bindings: Object.fromEntries(KEY_ACTIONS.map(action => [action, bindingKey(this.bindings[action])]))
      }));
    } catch { /* 写盘失败时当前运行仍使用内存中的绑定。 */ }
    for (const listener of this.listeners) listener();
  }
}

export const keyBindings = new KeyBindingPreferences();

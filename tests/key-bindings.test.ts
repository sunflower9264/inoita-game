import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_KEY_BINDINGS, KEY_ACTIONS, bindingFromEvent, bindingFromKey, bindingKey, formatBinding,
  reservedBindingReason, type KeyBinding
} from '../src/domain/key-bindings.ts';
import { KEY_BINDINGS_STORAGE_KEY, KeyBindingPreferences, type StorageLike } from '../src/application/key-bindings.ts';

const binding = (code: string, modifiers: Partial<Pick<KeyBinding, 'shift' | 'ctrl' | 'alt' | 'meta'>> = {}): KeyBinding =>
  ({ code, shift: false, ctrl: false, alt: false, meta: false, ...modifiers });

class MemoryStorage implements StorageLike {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

const stored = (bindings: Record<string, string>): MemoryStorage => {
  const storage = new MemoryStorage();
  storage.setItem(KEY_BINDINGS_STORAGE_KEY, JSON.stringify({ format: 1, bindings }));
  return storage;
};

test('默认键位覆盖全部动作且互不重复', () => {
  assert.equal(KEY_ACTIONS.length, 12);
  assert.equal(new Set(KEY_ACTIONS.map(action => bindingKey(DEFAULT_KEY_BINDINGS[action]))).size, KEY_ACTIONS.length);
  for (const action of KEY_ACTIONS) assert.ok(DEFAULT_KEY_BINDINGS[action].code, `${action} 缺少默认键`);
});

test('规范串可以存回，显示串用玩家看得懂的键名', () => {
  for (const value of ['KeyW', 'Shift+KeyW', 'ArrowUp', 'Digit1', 'Space', 'Numpad1']) {
    const parsed = bindingFromKey(value);
    assert.ok(parsed, `应能解析 ${value}`);
    assert.equal(bindingKey(parsed), value);
  }
  assert.equal(formatBinding(bindingFromKey('Shift+KeyW')!), 'Shift+W');
  assert.equal(formatBinding(bindingFromKey('ArrowUp')!), '↑');
  assert.equal(formatBinding(bindingFromKey('Digit1')!), '1');
  assert.equal(formatBinding(bindingFromKey('Numpad1')!), '小键盘 1');
  assert.equal(formatBinding(bindingFromKey('Space')!), '空格');
});

test('保留键给出中文原因', () => {
  assert.equal(reservedBindingReason(binding('Escape')), 'Esc 用于关闭菜单和取消操作');
  assert.equal(reservedBindingReason(binding('Tab')), 'Tab 用于菜单焦点切换');
  assert.equal(reservedBindingReason(binding('Backspace')), 'Backspace 在浏览器里会后退');
  assert.equal(reservedBindingReason(binding('F1')), 'F1–F12 由浏览器占用');
  assert.equal(reservedBindingReason(binding('F12')), 'F1–F12 由浏览器占用');
  assert.equal(reservedBindingReason(binding('KeyW', { ctrl: true })), '会被浏览器或系统占用');
  assert.equal(reservedBindingReason(binding('Digit1', { alt: true })), '会被浏览器或系统占用');
  assert.equal(reservedBindingReason(binding('KeyK', { meta: true })), '会被浏览器或系统占用');
  assert.equal(reservedBindingReason(binding('ShiftLeft')), '修饰键不能单独绑定');
  assert.equal(reservedBindingReason(binding('KeyW')), undefined);
});

test('键盘事件读出按键；合成输入与单独修饰键返回 undefined', () => {
  const event = (init: Partial<KeyboardEvent>): KeyboardEvent => ({
    code: '', key: '', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
    isComposing: false, repeat: false, preventDefault() {}, ...init
  }) as KeyboardEvent;
  assert.equal(bindingKey(bindingFromEvent(event({ code: 'KeyW', key: 'w' }))!), 'KeyW');
  assert.equal(bindingKey(bindingFromEvent(event({ code: 'KeyW', shiftKey: true }))!), 'Shift+KeyW');
  assert.equal(bindingFromEvent(event({ code: '', key: 'Shift' })), undefined);
  assert.equal(bindingFromEvent(event({ code: 'ShiftLeft', key: 'Shift', shiftKey: true })), undefined);
  assert.equal(bindingFromEvent(event({ code: 'KeyW', isComposing: true })), undefined);
});

test('冲突检测覆盖全部动作，同一动作重绑自身不算冲突', () => {
  const preferences = new KeyBindingPreferences(null);
  assert.equal(preferences.set('move.down', binding('KeyW')), '已被「向上移动」占用');
  assert.equal(preferences.set('skill.6', binding('Digit1')), '已被「快捷位 1」占用');
  assert.equal(preferences.set('move.up', binding('KeyW')), undefined);
  assert.equal(preferences.set('move.up', binding('Escape')), 'Esc 用于关闭菜单和取消操作');
});

test('改键立即生效并写入存储；重新构造后读回', () => {
  const storage = new MemoryStorage();
  const preferences = new KeyBindingPreferences(storage);
  assert.equal(preferences.set('move.up', binding('ArrowUp')), undefined);
  assert.deepEqual(preferences.get('move.up'), binding('ArrowUp'));

  const reloaded = new KeyBindingPreferences(storage);
  assert.deepEqual(reloaded.get('move.up'), binding('ArrowUp'));
});

test('Shift 组合保存与读取', () => {
  const storage = new MemoryStorage();
  const preferences = new KeyBindingPreferences(storage);
  assert.equal(preferences.set('skill.1', binding('KeyW', { shift: true })), undefined);
  const reloaded = new KeyBindingPreferences(storage);
  assert.deepEqual(reloaded.get('skill.1'), binding('KeyW', { shift: true }));
  assert.equal(bindingKey(reloaded.get('skill.1')), 'Shift+KeyW');
});

test('坏 JSON、错误格式和无法解析的键回默认', () => {
  const badJson = new MemoryStorage();
  badJson.setItem(KEY_BINDINGS_STORAGE_KEY, '{oops');
  assert.deepEqual(new KeyBindingPreferences(badJson).get('move.up'), DEFAULT_KEY_BINDINGS['move.up']);

  const badFormat = new MemoryStorage();
  badFormat.setItem(KEY_BINDINGS_STORAGE_KEY, JSON.stringify({ format: 2, bindings: { 'move.up': 'ArrowUp' } }));
  assert.deepEqual(new KeyBindingPreferences(badFormat).get('move.up'), DEFAULT_KEY_BINDINGS['move.up']);

  const badCode = stored({ 'move.up': '1234' });
  assert.deepEqual(new KeyBindingPreferences(badCode).get('move.up'), DEFAULT_KEY_BINDINGS['move.up']);

  const reserved = stored({ 'move.up': 'Escape' });
  assert.deepEqual(new KeyBindingPreferences(reserved).get('move.up'), DEFAULT_KEY_BINDINGS['move.up']);
});

test('写盘失败时内存绑定仍然生效', () => {
  const storage: StorageLike = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
  const preferences = new KeyBindingPreferences(storage);
  assert.equal(preferences.set('menu', binding('KeyN')), undefined);
  assert.deepEqual(preferences.get('menu'), binding('KeyN'));
});

test('W/S 互换能读回：先合并全部存储值再判重', () => {
  const storage = stored({ 'move.up': 'KeyS', 'move.down': 'KeyW' });
  const preferences = new KeyBindingPreferences(storage);
  assert.deepEqual(preferences.get('move.up'), binding('KeyS'));
  assert.deepEqual(preferences.get('move.down'), binding('KeyW'));
});

test('两个动作存成同一个键时回默认', () => {
  const storage = stored({ 'move.up': 'KeyS', 'move.down': 'KeyS' });
  const preferences = new KeyBindingPreferences(storage);
  assert.deepEqual(preferences.get('move.up'), DEFAULT_KEY_BINDINGS['move.up']);
  assert.deepEqual(preferences.get('move.down'), DEFAULT_KEY_BINDINGS['move.down']);
});

test('reset 恢复默认并通知订阅者', () => {
  const preferences = new KeyBindingPreferences(null);
  let changes = 0;
  const unsubscribe = preferences.subscribe(() => changes++);
  preferences.set('menu', binding('KeyN'));
  assert.equal(changes, 1);
  preferences.reset();
  assert.equal(changes, 2);
  assert.deepEqual(preferences.get('menu'), DEFAULT_KEY_BINDINGS.menu);
  unsubscribe();
  preferences.set('menu', binding('KeyN'));
  assert.equal(changes, 2);
});

test('匹配按键时修饰键必须完全一致', () => {
  const preferences = new KeyBindingPreferences(null);
  const event = (init: Partial<KeyboardEvent>): KeyboardEvent => ({
    code: 'KeyW', key: 'w', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
    isComposing: false, repeat: false, preventDefault() {}, ...init
  }) as KeyboardEvent;
  assert.equal(preferences.matches('move.up', event({})), true);
  assert.equal(preferences.matches('move.up', event({ shiftKey: true })), false);
  assert.equal(preferences.matches('move.up', event({ ctrlKey: true })), false);
  assert.equal(preferences.matches('move.up', event({ isComposing: true })), false);
});

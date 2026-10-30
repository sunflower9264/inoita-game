import assert from 'node:assert/strict';
import test from 'node:test';
import { KeyBindingPreferences } from '../src/application/key-bindings.ts';
import { KeyboardActions } from '../src/ui/phaser/keyboard-actions.ts';
import type Phaser from 'phaser';

interface FakeEvent extends Partial<KeyboardEvent> {
  code: string;
  key: string;
  prevented: number;
}

function key(code: string, key = code, init: Partial<FakeEvent> = {}): FakeEvent {
  const event: FakeEvent = {
    code, key, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
    isComposing: false, repeat: false, prevented: 0,
    preventDefault() { event.prevented++; },
    ...init
  };
  return event;
}

function fixture() {
  let handler: ((event: KeyboardEvent) => void) | undefined;
  const scene = {
    input: {
      keyboard: {
        on(event: string, fn: (event: KeyboardEvent) => void) { if (event === 'keydown') handler = fn; },
        off(event: string, fn: (event: KeyboardEvent) => void) { if (event === 'keydown' && handler === fn) handler = undefined; }
      }
    }
  };
  const calls: string[] = [];
  const bindings = new KeyBindingPreferences(null);
  const actions = new KeyboardActions(scene as unknown as Phaser.Scene, bindings, {
    skill: slot => calls.push(`skill ${slot}`),
    cycle: () => calls.push('cycle'),
    previousMember: () => calls.push('previous'),
    nextMember: () => calls.push('next')
  });
  return { bindings, calls, press: (event: FakeEvent) => handler?.(event as KeyboardEvent), destroy: () => actions.destroy(), live: () => handler !== undefined };
}

test('数字键 1–6 触发对应快捷位', () => {
  const f = fixture();
  for (let slot = 1; slot <= 6; slot++) f.press(key(`Digit${slot}`));
  assert.deepEqual(f.calls, ['skill 1', 'skill 2', 'skill 3', 'skill 4', 'skill 5', 'skill 6']);
  f.destroy();
});

test('空格切换技能组，Q/E 切上一个/下一个，无关按键不触发', () => {
  const f = fixture();
  f.press(key('Space', ' '));
  f.press(key('KeyQ'));
  f.press(key('KeyE'));
  f.press(key('KeyM'));
  f.press(key('KeyZ'));
  assert.deepEqual(f.calls, ['cycle', 'previous', 'next']);
  f.destroy();
});

test('按住重复、Ctrl 组合和输入法合成不触发动作', () => {
  const f = fixture();
  const repeat = key('Digit1', '1', { repeat: true });
  f.press(repeat);
  assert.equal(repeat.prevented, 1, '重复按键仍要阻止默认动作');
  f.press(key('Digit1', '1', { ctrlKey: true }));
  f.press(key('KeyQ', 'q', { ctrlKey: true }));
  f.press(key('Digit1', '1', { isComposing: true }));
  assert.deepEqual(f.calls, []);
  f.destroy();
});

test('改绑后立即按新键生效', () => {
  const f = fixture();
  assert.equal(f.bindings.set('skill.1', { code: 'KeyZ', shift: false, ctrl: false, alt: false, meta: false }), undefined);
  f.press(key('Digit1'));
  f.press(key('KeyZ'));
  assert.deepEqual(f.calls, ['skill 1']);
  f.destroy();
});

test('切人键可以改绑，旧键失效', () => {
  const f = fixture();
  assert.equal(f.bindings.set('party.next', { code: 'KeyR', shift: false, ctrl: false, alt: false, meta: false }), undefined);
  f.press(key('KeyE'));
  f.press(key('KeyR'));
  assert.deepEqual(f.calls, ['next']);
  f.destroy();
});

test('destroy 后不再触发', () => {
  const f = fixture();
  f.destroy();
  assert.equal(f.live(), false);
  f.press(key('Digit1'));
  assert.deepEqual(f.calls, []);
});

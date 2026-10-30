import type Phaser from 'phaser';
import { SKILL_BINDING_ACTIONS, type KeyBindingAction } from '../../domain/key-bindings.ts';
import type { KeyBindingPreferences } from '../../application/key-bindings.ts';

export interface KeyboardActionHandlers {
  /** `slot` 从 1 开始，对应屏幕上的六个快捷位。 */
  skill(slot: number): void;
  cycle(): void;
}

function editingText(): boolean {
  const element = globalThis.document?.activeElement as HTMLElement | null | undefined;
  if (!element) return false;
  return element.tagName === 'INPUT' || element.tagName === 'TEXTAREA'
    || element.tagName === 'SELECT' || element.isContentEditable;
}

/**
 * 世界场景的键盘派发：数字键放当前轮组的快捷位，Q 切组。
 * 冷却、蓝耗和是否装备仍由 `WorldCombat.attack` 校验，这里不去重复判断。
 */
export class KeyboardActions {
  private readonly scene: Phaser.Scene;
  private readonly bindings: KeyBindingPreferences;
  private readonly handlers: KeyboardActionHandlers;
  private readonly keydown = (event: KeyboardEvent): void => {
    if (event.isComposing || editingText()) return;
    for (let index = 0; index < SKILL_BINDING_ACTIONS.length; index++) {
      if (!this.bindings.matches(SKILL_BINDING_ACTIONS[index], event)) continue;
      event.preventDefault();
      if (!event.repeat) this.handlers.skill(index + 1);
      return;
    }
    const cycle: KeyBindingAction = 'wheel.next';
    if (!this.bindings.matches(cycle, event)) return;
    event.preventDefault();
    if (!event.repeat) this.handlers.cycle();
  };

  constructor(scene: Phaser.Scene, bindings: KeyBindingPreferences, handlers: KeyboardActionHandlers) {
    this.scene = scene; this.bindings = bindings; this.handlers = handlers;
    scene.input.keyboard?.on('keydown', this.keydown);
  }

  destroy(): void {
    this.scene.input.keyboard?.off('keydown', this.keydown);
  }
}

import type Phaser from 'phaser';
import { SKILL_BINDING_ACTIONS, type KeyBindingAction } from '../../domain/key-bindings.ts';
import type { KeyBindingPreferences } from '../../application/key-bindings.ts';

export interface KeyboardActionHandlers {
  /** `slot` 从 1 开始，对应屏幕上的六个快捷位。 */
  skill(slot: number): void;
  cycle(): void;
  previousMember(): void;
  nextMember(): void;
}

function editingText(): boolean {
  const element = globalThis.document?.activeElement as HTMLElement | null | undefined;
  if (!element) return false;
  return element.tagName === 'INPUT' || element.tagName === 'TEXTAREA'
    || element.tagName === 'SELECT' || element.isContentEditable;
}

/**
 * 世界场景的键盘派发：数字键放当前轮组的快捷位，空格切组，Q/E 切上一个/下一个操作人物。
 * 冷却、蓝耗和是否装备仍由 `WorldCombat.attack` 校验，这里不去重复判断。
 */
export class KeyboardActions {
  private readonly scene: Phaser.Scene;
  private readonly bindings: KeyBindingPreferences;
  private readonly handlers: KeyboardActionHandlers;
  private readonly keydown = (event: KeyboardEvent): void => {
    if (event.isComposing || editingText()) return;
    for (let index = 0; index < SKILL_BINDING_ACTIONS.length; index++) {
      if (this.dispatch(SKILL_BINDING_ACTIONS[index], event, () => this.handlers.skill(index + 1))) return;
    }
    if (this.dispatch('wheel.next', event, () => this.handlers.cycle())) return;
    if (this.dispatch('party.previous', event, () => this.handlers.previousMember())) return;
    this.dispatch('party.next', event, () => this.handlers.nextMember());
  };

  constructor(scene: Phaser.Scene, bindings: KeyBindingPreferences, handlers: KeyboardActionHandlers) {
    this.scene = scene; this.bindings = bindings; this.handlers = handlers;
    scene.input.keyboard?.on('keydown', this.keydown);
  }

  /** 匹配则阻止默认动作；按住不放只阻止默认，不重复执行。 */
  private dispatch(action: KeyBindingAction, event: KeyboardEvent, run: () => void): boolean {
    if (!this.bindings.matches(action, event)) return false;
    event.preventDefault();
    if (!event.repeat) run();
    return true;
  }

  destroy(): void {
    this.scene.input.keyboard?.off('keydown', this.keydown);
  }
}

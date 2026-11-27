import { SKILL_BINDING_ACTIONS, type KeyBindingAction } from '../../domain/key-bindings.ts';
import type { KeyBindingPreferences } from '../../application/key-bindings.ts';
import type { InputRouter } from '../../application/input-router.ts';

export interface KeyboardSceneSource {
  readonly input?: {
    readonly keyboard?: {
      on(event: 'keydown', fn: (event: KeyboardEvent) => unknown): unknown;
      off(event: 'keydown', fn: (event: KeyboardEvent) => unknown): unknown;
    } | null;
  };
}

interface KeyboardActionHandlers {
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
  private readonly scene: KeyboardSceneSource;
  private readonly bindings: KeyBindingPreferences;
  private readonly handlers: KeyboardActionHandlers;
  /** 接入 router 时的注销函数；没有 router 时保持场景直连。 */
  private unregisterInput?: () => void;
  private readonly keydown = (event: KeyboardEvent): boolean => {
    if (event.isComposing || editingText()) return false;
    for (let index = 0; index < SKILL_BINDING_ACTIONS.length; index++) {
      if (this.dispatch(SKILL_BINDING_ACTIONS[index], event, () => this.handlers.skill(index + 1))) return true;
    }
    if (this.dispatch('wheel.next', event, () => this.handlers.cycle())) return true;
    if (this.dispatch('party.previous', event, () => this.handlers.previousMember())) return true;
    return this.dispatch('party.next', event, () => this.handlers.nextMember());
  };

  constructor(scene: KeyboardSceneSource, bindings: KeyBindingPreferences, handlers: KeyboardActionHandlers, router?: InputRouter) {
    this.scene = scene; this.bindings = bindings; this.handlers = handlers;
    if (router) this.unregisterInput = router.register('world', this.keydown);
    else scene.input?.keyboard?.on('keydown', this.keydown);
  }

  /** 匹配则阻止默认动作；按住不放只阻止默认，不重复执行。 */
  private dispatch(action: KeyBindingAction, event: KeyboardEvent, run: () => void): boolean {
    if (!this.bindings.matches(action, event)) return false;
    event.preventDefault();
    if (!event.repeat) run();
    return true;
  }

  destroy(): void {
    this.unregisterInput?.();
    this.unregisterInput = undefined;
    this.scene.input?.keyboard?.off('keydown', this.keydown);
  }
}

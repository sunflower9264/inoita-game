import type { ControlSkin } from '../../domain/control-skin.ts';
import { UI_EVENTS } from '../../application/ui-events.ts';
import { ControlLayoutPreferences, resolveControlLayout } from '../control-layout.ts';
import { controlViewport } from '../viewport.ts';
import type { DomUi } from '../dom/dom-ui.ts';
import type { UiSceneHost } from '../dom/node.ts';
import { DomActionControls } from '../dom/action-controls.ts';
import type { ActionControlsHandlers, ShortcutSlot } from '../shortcut-view.ts';
import type { SceneActivity } from './scene-activity.ts';
export { SLOT_ICON_SIZE, ITEM_ICON_SIZE, type ActionControlsHandlers, type ShortcutSlot } from '../shortcut-view.ts';
export { QUANTITY_BADGE } from '../dom/action-controls.ts';

type ActionControlsOwner = UiSceneHost & { readonly sys?: { isActive(): boolean } };

/** 共用控件布局的参考锚点。 */
export function controlPlacement(): { scale: number; anchor: { x: number; y: number } } {
  const { attack } = resolveControlLayout(controlViewport());
  return { scale: attack.scale, anchor: { x: attack.x / attack.scale, y: attack.y / attack.scale } };
}

/** 场景生命周期适配；可见画面与输入由 DOM 组件持有。 */
export class ActionControls {
  private readonly view: DomActionControls;
  private readonly owner: ActionControlsOwner;
  private readonly preferences?: ControlLayoutPreferences;
  private readonly unsubscribe: () => void;
  private readonly unwatch?: () => void;
  private active = true;
  private requested = false;
  constructor(
    owner: ActionControlsOwner,
    handlers: ActionControlsHandlers,
    skin: ControlSkin,
    preferences?: ControlLayoutPreferences,
    domUi?: DomUi,
    activity?: Pick<SceneActivity, 'watchVisibility'>,
  ) {
    const parent = domUi?.layer('hud');
    if (!parent) throw new Error('操作界面尚未就绪');
    this.owner = owner; this.preferences = preferences;
    this.view = new DomActionControls(parent, skin, handlers, error => {
      globalThis.storyDiagnostics?.record('ui-image-error', { error });
    });
    this.unsubscribe = preferences?.subscribe(() => this.layout()) ?? (() => {});
    if (activity) {
      this.unwatch = activity.watchVisibility(active => { this.active = active; this.view.visible(this.requested && active); });
    } else {
      for (const event of ['sleep', 'wake', 'pause', 'resume']) owner.events?.on(event, this.refresh);
      this.active = owner.sys?.isActive() ?? true;
    }
    owner.game?.events?.on(UI_EVENTS.cancelInput, this.resetInput);
    window.addEventListener('blur', this.resetInput);
  }
  private readonly refresh = (): void => {
    this.active = this.owner.sys?.isActive() ?? true;
    this.view.visible(this.requested && this.active);
  };
  readonly resetInput = (): void => { this.view.resetInput(); };
  setShortcutPage(slots: readonly ShortcutSlot[]): void { this.view.setShortcutPage(slots); }
  snapshot(): readonly ShortcutSlot[] { return this.view.snapshot(); }
  setAttack(enabled: boolean): void { this.view.setAttack(enabled); }
  layout(): void {
    this.view.layout(controlViewport(), this.preferences?.snapshot());
  }
  setVisible(visible: boolean): void { this.requested = visible; this.view.visible(visible && this.active); }
  destroy(): void {
    this.unsubscribe();
    this.unwatch?.();
    if (!this.unwatch) for (const event of ['sleep', 'wake', 'pause', 'resume']) this.owner.events?.off(event, this.refresh);
    this.owner.game?.events?.off(UI_EVENTS.cancelInput, this.resetInput);
    window.removeEventListener('blur', this.resetInput);
    this.view.destroy();
  }
}

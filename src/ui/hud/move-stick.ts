import type { ControlSkin } from '../../domain/control-skin.ts';
import type { ControlLayoutPreferences } from '../control-layout.ts';
import { keyBindings as defaultKeyBindings, type KeyBindingPreferences } from '../../application/key-bindings.ts';
import type { InputRouter } from '../../application/input-router.ts';
import { UI_EVENTS } from '../../application/ui-events.ts';
import type { DomUi } from '../dom/dom-ui.ts';
import { DomMoveStick } from '../dom/move-stick.ts';
import { controlViewport } from '../viewport.ts';
import type { SceneActivity } from './scene-activity.ts';
export { STICK_KNOB_RADIUS, DPAD_BASE_RADIUS, DPAD_RUNE_ALPHA, DPAD_ARROW_OFFSET, DPAD_ARROW_SCALE_NORM } from '../dom/move-stick.ts';

export interface MoveStickOwner {
  readonly game?: {
    readonly events?: {
      on(event: string, fn: () => void): unknown;
      off(event: string, fn: () => void): unknown;
    };
  };
  readonly input?: {
    readonly keyboard?: {
      on(event: 'keydown', fn: (event: KeyboardEvent) => unknown): unknown;
      off(event: 'keydown', fn: (event: KeyboardEvent) => unknown): unknown;
    } | null;
  };
}

/** 移动控件的场景与键盘接线。 */
export class MoveStick {
  readonly axis: { x: number; y: number };
  private readonly view: DomMoveStick;
  private readonly preferences?: ControlLayoutPreferences;
  private readonly cleanup: (() => void)[] = [];
  private requested = false;
  private active = true;
  constructor(owner: MoveStickOwner, activity: SceneActivity, skin: ControlSkin, preferences?: ControlLayoutPreferences,
    bindings: KeyBindingPreferences = defaultKeyBindings, router?: InputRouter, domUi?: DomUi) {
    const parent = domUi?.layer('hud');
    if (!parent) throw new Error('移动界面尚未就绪');
    this.preferences = preferences;
    this.view = new DomMoveStick(parent, skin, error => globalThis.storyDiagnostics?.record('ui-image-error', { error }));
    this.axis = this.view.axis;
    this.cleanup.push(activity.watchVisibility(active => { this.active = active; this.view.setVisible(active && this.requested); }));
    const down = (event: KeyboardEvent) => this.view.keyDown(event, bindings);
    const up = (event: KeyboardEvent) => this.view.keyUp(event);
    if (router) this.cleanup.push(router.register('world', down, { active: () => this.requested && this.active }));
    else { owner.input?.keyboard?.on('keydown', down); this.cleanup.push(() => owner.input?.keyboard?.off('keydown', down)); }
    window.addEventListener('keyup', up); window.addEventListener('blur', this.reset);
    this.cleanup.push(() => { window.removeEventListener('keyup', up); window.removeEventListener('blur', this.reset); });
    owner.game?.events?.on(UI_EVENTS.cancelInput, this.reset);
    this.cleanup.push(() => owner.game?.events?.off(UI_EVENTS.cancelInput, this.reset));
    this.cleanup.push(bindings.subscribe(this.reset));
    if (preferences) this.cleanup.push(preferences.subscribe(() => this.layout()));
  }
  readonly reset = (): void => { this.view.reset(); };
  layout(): void { this.view.layout(controlViewport(), this.preferences?.snapshot()); }
  setVisible(visible: boolean): void { this.requested = visible; this.view.setVisible(visible && this.active); }
  destroy(): void { for (const dispose of this.cleanup.splice(0)) dispose(); this.view.destroy(); }
}

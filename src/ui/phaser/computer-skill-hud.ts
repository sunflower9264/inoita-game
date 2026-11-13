import type Phaser from 'phaser';
import type { Hud } from '../../rendering/hud.ts';
import type { ControlSkin } from '../../domain/control-skin.ts';
import type { Cooldown } from '../../domain/combat.ts';
import type { ShortcutSlot } from '../shortcut-view.ts';
import type { DomUi } from '../dom/dom-ui.ts';
import { DomComputerSkillHud } from '../dom/computer-skill-hud.ts';
import { controlViewport } from './control-layout-viewport.ts';

/** 电脑技能行的场景显隐接线。 */
export class ComputerSkillHud {
  private readonly view: DomComputerSkillHud;
  private readonly unwatch: () => void;
  private active = true;
  private requested = false;
  constructor(_owner: Phaser.Scene, hud: Hud, skin: ControlSkin, domUi?: DomUi) {
    const parent = domUi?.layer('hud');
    if (!parent) throw new Error('技能状态界面尚未就绪');
    this.view = new DomComputerSkillHud(parent, skin, error => globalThis.storyDiagnostics?.record('ui-image-error', { error }));
    this.unwatch = hud.watchVisibility(active => { this.active = active; this.view.visible(active && this.requested); });
  }
  setPage(slots: readonly ShortcutSlot[]): void { this.view.setPage(slots); }
  setCooldowns(cooldowns: Readonly<Record<string, Cooldown>>): void { this.view.setCooldowns(cooldowns); }
  layout(): void { this.view.layout(controlViewport()); }
  setVisible(visible: boolean): void { this.requested = visible; this.view.visible(visible && this.active); }
  destroy(): void { this.unwatch(); this.view.destroy(); }
}

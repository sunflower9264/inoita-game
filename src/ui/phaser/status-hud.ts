import type { Hud } from '../../rendering/hud.ts';
import type { StoryPlayerState } from '../../domain/story-interface.ts';
import type { ActiveCondition } from '../../domain/combat-conditions.ts';
import type { StatusHudSkin, TargetStatus } from '../../domain/status-hud.ts';
import type { PartyActiveSnapshot } from '../../domain/party.ts';
import type { DomUi } from '../dom/dom-ui.ts';
import { DomStatusHud, type MemberValues } from '../dom/status-hud.ts';
import { controlViewport } from './control-layout-viewport.ts';

/** 状态栏的场景生命周期接线；所有显示和点击由 DOM 组件持有。 */
export class StatusHud {
  private readonly view: DomStatusHud;
  private readonly unwatch: () => void;
  private requested = false;
  private active = true;
  constructor(hud: Hud, skin: StatusHudSkin, readPlayer: () => Readonly<StoryPlayerState> | undefined, subscribe: (listener: () => void) => () => void,
    readParty?: () => PartyActiveSnapshot | undefined, onSelect?: (id: string) => void, portraitFor?: (id: string) => string | undefined,
    onFocus?: () => void, readConditions?: (id: string) => readonly ActiveCondition[], readHero?: () => MemberValues | undefined, domUi?: DomUi) {
    const parent = domUi?.layer('hud');
    if (!parent) throw new Error('状态界面尚未就绪');
    this.view = new DomStatusHud(parent, skin, { readPlayer, subscribe, readParty, onSelect, portraitFor, onFocus, readConditions, readHero },
      error => globalThis.storyDiagnostics?.record('ui-image-error', { error }));
    this.unwatch = hud.watchVisibility(active => { this.active = active; this.view.setVisible(this.requested && active); });
    this.layout();
  }
  layout(): void { this.view.layout(controlViewport()); }
  update(tick: number): void { this.view.update(tick); }
  setTarget(target: TargetStatus | undefined): void { this.view.setTarget(target); }
  setVisible(visible: boolean): void { this.requested = visible; this.view.setVisible(visible && this.active); }
  destroy(): void { this.unwatch(); this.view.destroy(); }
}

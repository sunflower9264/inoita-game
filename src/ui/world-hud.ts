import { controlSettings } from '../application/control-settings.ts';
import { displaySettings } from '../application/display-settings.ts';
import { memberArt } from '../domain/menu-panels.ts';
import type { TargetStatus } from '../domain/status-hud.ts';
import type { StoryPlayerState } from '../domain/story-interface.ts';
import type { ActiveCondition } from '../domain/combat-conditions.ts';
import { SceneActivity, type SceneActivitySource } from './hud/scene-activity.ts';
import { NameBanner, type NameBannerHost } from './hud/name-banner.ts';
import { StoryMinimap } from './hud/story-minimap.ts';
import { StatusHud } from './hud/status-hud.ts';
import { MoveStick, type MoveStickOwner } from './hud/move-stick.ts';
import { ActionControls, type ShortcutSlot } from './hud/action-controls.ts';
import { ComputerSkillHud } from './hud/computer-skill-hud.ts';
import { KeyboardActions, type KeyboardSceneSource } from './hud/keyboard-actions.ts';
import type { DomUi, DomLabel } from './dom/dom-ui.ts';
import type { UiSceneHost } from './dom/node.ts';
import type { WorldMap } from '../domain/content.ts';

import type { StoryContext } from '../application/ports.ts';

type WorldHudOwner = SceneActivitySource & NameBannerHost & MoveStickOwner & KeyboardSceneSource & UiSceneHost & {
  readonly game: { readonly loop: { readonly frame: number }; readonly canvas: { getBoundingClientRect(): { width: number; height: number } }; readonly events?: { on(...args: any[]): unknown; off(...args: any[]): unknown; emit(...args: any[]): unknown } };
};
type HudContext = Pick<StoryContext, 'session'|'statusHud'|'world'|'menuPanels'|'controlSkin'|'controlLayout'|'keyBindings'|'inputRouter'|'storyInterface'>;
interface HudActions {
  attack(): void;
  skill(key: string): void;
  item(id: string): void;
  cycle(): void;
  slot(slot: number): void;
  member(direction: -1 | 1): void;
  select(id: string): void;
  focus(): void;
}
interface HudSources {
  active(): boolean;
  player(): Readonly<StoryPlayerState> | undefined;
  conditions(id: string): readonly ActiveCondition[];
}
export interface WorldHudState {
  enabled: boolean;
  backgroundVisible: boolean;
  targetName: string | null;
  hasTarget: boolean;
  hostile: boolean;
  targetStatus?: TargetStatus;
}
const NEUTRAL_AXIS = {x:0,y:0};
const FPS_WINDOW_MS = 1000;
const FPS_RESET_AFTER_IDLE_MS = 2000;

/** 一次地图访问的屏幕控件；会话、订阅和节点随本次访问一起释放。 */
export class WorldHud {
  private readonly owner: WorldHudOwner;
  private readonly domUi?: DomUi;
  private readonly activity: SceneActivity;
  private statusHud?: StatusHud;
  private stick?: MoveStick;
  private controls?: ActionControls;
  private keyboardActions?: KeyboardActions;
  private skillHud?: ComputerSkillHud;
  private nameBanner?: NameBanner;
  private unsubscribeMode?: () => void;
  private session?: HudContext['session'];
  private active: () => boolean = () => false;
  private destroyed = false;
  private lastState?: WorldHudState;
  private signature = '';
  private mapView?: StoryMinimap;
  private fpsReadout?: { dom?: DomLabel; lastRaf?: number; lastActual?: number; lastVisible?: boolean };
  private fpsFrameBase = 0;
  private fpsWindowStart = 0;
  private fpsActualFrames = 0;

  constructor(owner: WorldHudOwner, domUi?: DomUi) {
    this.owner = owner; this.domUi = domUi; this.activity = new SceneActivity(owner);
  }
  get minimap(): StoryMinimap | undefined { return this.mapView; }
  get axis(): {x:number;y:number} { return this.active() ? this.stick?.axis ?? NEUTRAL_AXIS : NEUTRAL_AXIS; }
  get ready(): boolean { return !!this.controls; }

  mount(context: HudContext, map: WorldMap, sources: HudSources, actions: HudActions): void {
    if (this.destroyed || this.session) throw new Error('地图界面不能重复装配');
    const session = context.session;
    this.session = session; this.active = sources.active;
    const run = <A extends unknown[]>(action: (...args:A)=>void) => (...args:A) => {
      if (!this.destroyed && sources.active()) action(...args);
    };
    this.statusHud = new StatusHud(this.activity, context.statusHud, () => (sources.active() ? sources.player() : undefined) ?? session.player,
      listener => session.subscribe(listener), () => session.party?.activeSnapshot(), run(actions.select), id => {
        if (id === 'player') return context.statusHud.assets['player-portrait'];
        const member = session.party?.get(id); if (!member) return undefined;
        return memberArt(context.menuPanels, context.world.actors[member.definition.actor], member.classId, member.source).partyIcon;
      }, run(actions.focus), id => sources.active() ? sources.conditions(id) : [], () => session.player, this.domUi);
    this.stick = new MoveStick(this.owner, this.activity, context.controlSkin, context.controlLayout, context.keyBindings, context.inputRouter, this.domUi);
    this.controls = new ActionControls(this.owner, {
      attack: run(actions.attack), skill: run(actions.skill), item: run(actions.item), swap: run(actions.cycle)
    }, context.controlSkin, context.controlLayout, this.domUi, this.activity);
    this.keyboardActions = new KeyboardActions(this.owner, context.keyBindings, {
      skill: run(actions.slot), cycle: run(actions.cycle), previousMember: run(() => actions.member(-1)), nextMember: run(() => actions.member(1))
    }, context.inputRouter);
    this.skillHud = new ComputerSkillHud(this.activity, context.controlSkin, this.domUi);
    this.nameBanner = new NameBanner(this.owner, map.name, this.domUi);
    this.unsubscribeMode = controlSettings.subscribeMode(() => { if (this.lastState) this.sync(this.lastState); });
  }
  mountMinimap(map: WorldMap, content: HudContext['storyInterface']): void {
    if (this.destroyed || this.mapView) return;
    if (!this.domUi) throw new Error('小地图界面尚未就绪');
    this.mapView = new StoryMinimap(this.owner, this.activity, map, content, this.domUi);
    this.fpsReadout = this.createFpsReadout();
  }
  layout(width: number, height: number): void {
    if (this.destroyed) return;
    this.activity.layout(width, height); this.stick?.layout(); this.controls?.layout(); this.skillHud?.layout();
    this.nameBanner?.layout(); this.mapView?.layout(); this.layoutFps(); this.statusHud?.layout();
  }
  sync(state: WorldHudState): void {
    if (this.destroyed) return;
    this.lastState = state;
    const enabled = state.enabled && this.active();
    const visible = state.backgroundVisible && this.active();
    // 每次应用实际显隐，确保新建的控件也采纳当前状态。
    this.stick?.setVisible(enabled);
    this.controls?.setVisible(enabled && controlSettings.mode !== 'keyboard');
    this.skillHud?.setVisible(enabled && controlSettings.mode === 'keyboard');
    this.mapView?.setVisible(visible); this.statusHud?.setVisible(visible);
    this.domUi?.setLayerVisible('hud', visible);
    this.nameBanner?.sync(visible, state.targetName);
    const target = state.targetStatus;
    const signature = `${enabled}|${state.hasTarget}|${state.hostile}|${target ? `${target.id}|${target.name}|${target.level}|${target.health}/${target.maxHealth}|${target.sceneLevel}` : ''}`;
    if (signature === this.signature) return;
    this.signature = signature;
    this.controls?.setAttack(enabled && (state.hasTarget || state.hostile));
    this.statusHud?.setTarget(target);
  }
  setShortcutPage(slots: readonly ShortcutSlot[]): void { this.skillHud?.setPage(slots); this.controls?.setShortcutPage(slots); }
  snapshot(): readonly ShortcutSlot[] { return this.controls?.snapshot() ?? []; }
  setTarget(target: TargetStatus | undefined): void { this.statusHud?.setTarget(target); }
  updateStatus(): void { if (!this.destroyed && this.session) this.statusHud?.update(this.session.combatTick); }
  resetInput(): void { this.controls?.resetInput(); this.stick?.reset(); }
  private createFpsReadout(): { dom?: DomLabel } {
    const dom=this.domUi?.label('hud','dom-fps');
    if(dom)dom.setStyle({fontSize:'22px',color:'#fff4dc',textShadow:'0 1px 2px rgba(0,0,0,.7)'});
    return { dom };
  }
  private layoutFps(): void {
    const extent = this.minimap?.extent(), readout = this.fpsReadout;
    if (!extent || !readout?.dom) return;
    readout.dom.setPosition(extent.x + extent.width + 8, extent.y);
  }
  updateFps(): void {
    const readout = this.fpsReadout;
    if (!readout?.dom) return;
    const visible = displaySettings.fps;
    if (readout.lastVisible !== visible) {
      readout.lastVisible = visible;
      this.fpsFrameBase = this.owner.game.loop.frame; this.fpsWindowStart = 0; this.fpsActualFrames = 0;
      readout.dom.setVisible(visible);
    }
    if (!visible) return;
    // 数浏览器的 requestAnimationFrame 调用次数，不是游戏更新次数：
    // 限帧后游戏每秒只更新 60 次，浏览器仍可能按屏幕刷新率叫 120 次。
    const now = performance.now();
    if (!this.fpsWindowStart) {
      this.fpsWindowStart = now;
      this.fpsFrameBase = this.owner.game.loop.frame;
      this.fpsActualFrames = 0;
    }
    // updateFps 每个真正交付到画面的游戏帧调用一次，所以直接数调用次数。
    this.fpsActualFrames++;
    const elapsed = now - this.fpsWindowStart;
    // 挂起、演出遮挡等长时间不更新后，先以当前帧重新开窗，避免把停顿算成一次超低值。
    if (elapsed > FPS_RESET_AFTER_IDLE_MS) {
      this.fpsWindowStart = now; this.fpsFrameBase = this.owner.game.loop.frame; this.fpsActualFrames = 0; return;
    }
    if (elapsed < FPS_WINDOW_MS) return;
    const raf = Math.round(Math.max(0, this.owner.game.loop.frame - this.fpsFrameBase) * 1000 / elapsed);
    const actual = Math.round(this.fpsActualFrames * 1000 / elapsed);
    this.fpsFrameBase = this.owner.game.loop.frame; this.fpsWindowStart = now; this.fpsActualFrames = 0;
    if (readout.lastRaf !== raf || readout.lastActual !== actual) {
      readout.lastRaf = raf;
      readout.lastActual = actual;
      readout.dom.setText(`rAF ${raf} / 实际 ${actual} 帧`);
    }
  }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.unsubscribeMode?.(); this.unsubscribeMode = undefined;
    this.stick?.destroy(); this.controls?.destroy(); this.keyboardActions?.destroy(); this.skillHud?.destroy();
    this.nameBanner?.destroy(); this.mapView?.destroy(); this.fpsReadout?.dom?.remove(); this.statusHud?.destroy();
    this.activity.destroy();
    this.session = undefined; this.active = () => false; this.lastState = undefined;
    this.stick = undefined; this.controls = undefined; this.keyboardActions = undefined; this.skillHud = undefined;
    this.nameBanner = undefined; this.mapView = undefined; this.statusHud = undefined; this.fpsReadout = undefined;
    this.domUi?.setLayerVisible('hud', false);
  }
}

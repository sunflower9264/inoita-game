import type Phaser from 'phaser';
import type { BattleCatalog } from '../domain/battle.ts';
import type { BuffLoopFrame, ConditionAppearance } from '../domain/combat-conditions.ts';
import type { ActorDefinition, Facing } from '../domain/content.ts';
import type { Point } from '../domain/navigation.ts';
import { BuffLoopRenderer } from './buff-loop-renderer.ts';
import { setCharacterStealth } from './character-visibility.ts';
import type { CharacterVisual } from './characters.ts';
import { StateMarkers } from './state-markers.ts';
import { StatusColorRenderer } from './status-color.ts';
import { TargetFocus } from './target-focus.ts';

const TAP_FACINGS: readonly Facing[] = ['north', 'south', 'east', 'west'];

/**
 * 点击敌人的命中矩形，按待机动作的显示范围取并集；原点在脚底，所以范围要减去锚点偏移。
 * 只读动画帧的裁剪尺寸，不依赖 Phaser，可在没有场景的情况下测试。
 */
export function enemyTapRect(actor: ActorDefinition): { x: number; y: number; width: number; height: number } {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const facing of TAP_FACINGS) {
    const clip = actor.clips[`idle-${facing}`];
    if (!clip) continue;
    left = Math.min(left, -clip.frameWidth * clip.originX);
    top = Math.min(top, -clip.frameHeight * clip.originY);
    right = Math.max(right, clip.frameWidth * (1 - clip.originX));
    bottom = Math.max(bottom, clip.frameHeight * (1 - clip.originY));
  }
  // 缺少待机动作的目录（场怪物件）回落到碰撞框。
  if (!Number.isFinite(left)) {
    const box = actor.collision!;
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

interface ConditionVisualEntry {
  visual: CharacterVisual;
  appearance: ConditionAppearance;
  layers: CharacterVisual['layers'];
  shown: boolean;
  active: boolean;
  visible: boolean;
  defeating: boolean;
  frame: number;
}

/**
 * 战斗状态视觉协调器：
 * 统一同步潜行半透明、眩晕/睡眠头顶图标、状态着色矩阵、持续增益循环特效及脚下选中圈。
 */
export class CombatStatusVisuals {
  private readonly statusColors = new StatusColorRenderer();
  private readonly stateMarkers: StateMarkers;
  private readonly buffLoops: BuffLoopRenderer;
  private focusRings?: TargetFocus;
  private readonly conditionVisuals = new Map<string, ConditionVisualEntry>();
  private readonly buffLoopActors = new Set<string>();

  constructor(scene: Phaser.Scene, catalog: BattleCatalog) {
    this.stateMarkers = new StateMarkers(scene, catalog);
    this.buffLoops = new BuffLoopRenderer(scene, catalog);
  }

  initFocusRings(scene: Phaser.Scene): void {
    this.focusRings?.destroy();
    this.focusRings = new TargetFocus(scene);
  }

  flash(visual: CharacterVisual, scene: Phaser.Scene): void {
    this.statusColors.flash(visual, scene);
  }

  syncFocusRings(
    playerPoint: Point | undefined,
    targetPoint: Point | undefined,
    targetId: string | undefined,
    shown: boolean,
    deltaMs: number,
  ): void {
    this.focusRings?.update(playerPoint, targetPoint, targetPoint ? targetId : undefined, shown, deltaMs);
  }

  /** 规则状态统一在这里变成只读表现：眩晕用金色星星，睡眠用 Zzz；都不参与结算。 */
  syncStateMarkers(
    shown: boolean,
    frame: number,
    appearances: ReadonlyMap<string, ConditionAppearance>,
    visualOf: (id: string) => CharacterVisual | undefined,
    isPendingDefeat: (id: string) => boolean,
  ): void {
    for (const [id, entry] of this.conditionVisuals) {
      if (!appearances.has(id) || visualOf(id) !== entry.visual) {
        if (entry.visual.container.active) {
          setCharacterStealth(entry.visual, false);
          this.statusColors.paint(entry.visual, undefined, frame);
        }
        this.stateMarkers.remove(id);
        this.conditionVisuals.delete(id);
      }
    }
    for (const [id, appearance] of appearances) {
      const visual = visualOf(id);
      if (!visual) continue;
      const previous = this.conditionVisuals.get(id);
      const active = visual.container.active;
      const visible = visual.container.visible;
      const defeating = isPendingDefeat(id);
      const changed =
        !previous ||
        previous.appearance !== appearance ||
        previous.visual !== visual ||
        previous.layers !== visual.layers ||
        previous.shown !== shown ||
        previous.active !== active ||
        previous.visible !== visible ||
        previous.defeating !== defeating;
      if (changed) {
        setCharacterStealth(visual, appearance.states.includes('stealthed'));
        this.stateMarkers.sync(id, visual, appearance.states, shown);
      }
      if (!defeating && (changed || (appearance.colors?.length && previous?.frame !== frame))) {
        this.statusColors.paint(visual, appearance.colors, frame);
      }
      if (changed) {
        this.conditionVisuals.set(id, { visual, appearance, layers: visual.layers, shown, active, visible, defeating, frame });
      } else if (previous) {
        previous.frame = frame;
      }
    }
  }

  syncBuffLoops(
    appearances: ReadonlyMap<string, ConditionAppearance>,
    visualOf: (id: string) => CharacterVisual | undefined,
    buffLoopFrames: (id: string) => readonly BuffLoopFrame[],
    isActorActive: (id: string) => boolean,
  ): void {
    for (const id of this.buffLoopActors) {
      if (!appearances.get(id)?.loops) {
        this.buffLoops.remove(id);
        this.buffLoopActors.delete(id);
      }
    }
    for (const [id, appearance] of appearances) {
      if (!appearance.loops) continue;
      const visual = visualOf(id);
      if (!isActorActive(id) || !visual?.container.active) {
        this.buffLoops.remove(id);
        this.buffLoopActors.delete(id);
        continue;
      }
      this.buffLoops.sync(id, visual, buffLoopFrames(id));
      this.buffLoopActors.add(id);
    }
  }

  clearBuffLoops(): void {
    this.buffLoops.clear();
    this.buffLoopActors.clear();
  }

  destroy(): void {
    this.stateMarkers.clear();
    this.conditionVisuals.clear();
    this.focusRings?.destroy();
    this.focusRings = undefined;
    this.clearBuffLoops();
  }
}

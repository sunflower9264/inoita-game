/** 支持潜行透明度调节的角色视觉最小接口，避免与 `characters.ts` 互相引用。 */
export interface StealthVisualTarget {
  readonly layers: readonly { alpha: number; setAlpha(value: number): unknown }[];
}

const hidden = new WeakSet<StealthVisualTarget>();
const originalAlpha = new WeakMap<StealthVisualTarget['layers'][number], number>();
/** 隐身时人物图层保留一半透明度；容器上的死亡淡出和头顶状态不受影响。 */
const STEALTH_ALPHA_SCALE = 0.5;

/** 隐身只影响人物图层；容器上的死亡淡出和头顶状态保持各自的透明度。 */
export function setCharacterStealth(character: StealthVisualTarget, stealthed: boolean): void {
  if (hidden.has(character) === stealthed) return;
  if (stealthed) hidden.add(character); else hidden.delete(character);
  applyCharacterVisibility(character);
}

/** 动画或装备重建图层时同步当前隐身表现。 */
export function applyCharacterVisibility(character: StealthVisualTarget): void {
  for (const layer of character.layers) {
    if (hidden.has(character)) {
      if (!originalAlpha.has(layer)) { originalAlpha.set(layer, layer.alpha); layer.setAlpha(layer.alpha * STEALTH_ALPHA_SCALE); }
    } else {
      const alpha = originalAlpha.get(layer);
      if (alpha !== undefined) { layer.setAlpha(alpha); originalAlpha.delete(layer); }
    }
  }
}

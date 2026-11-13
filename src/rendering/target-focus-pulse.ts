/** 原版按 30fps 推进脉冲。 */
const FOCUS_PULSE_FPS = 30;
/** 缩放脉冲六帧一循环：从 130% 往回到 80%，再跳回 130%。 */
const PULSE_CYCLE_FRAMES = 6;
/** 循环里每退一帧缩小 10 个百分点。 */
const PULSE_STEP_PERCENT = 10;
/** 循环的最小缩放是 80%。 */
const PULSE_MIN_PERCENT = 80;
/** 百分比换算成倍率的除数。 */
const PERCENT_SCALE = 100;

/** 原版换目标后的红圈脉冲帧数。 */
export const FOCUS_PULSE_FRAMES = 17;

/** 原版一个脉冲帧的时长；原版按 30fps 推进，17 帧约 567ms。 */
export const FOCUS_PULSE_FRAME_MS = 1000 / FOCUS_PULSE_FPS;

/**
 * 红圈剩余脉冲帧对应的缩放。
 *
 * 原版 `GAMEPLAY_DrawFocus` 用 `((帧 % 6) * 10) + 80` 作为 `SPR_DrawEx`
 * 的缩放百分比，从 130% 往回到 80% 循环，17 帧后恢复 100%。
 */
export function focusRingScale(remaining: number): number {
  return remaining > 0
    ? ((remaining % PULSE_CYCLE_FRAMES) * PULSE_STEP_PERCENT + PULSE_MIN_PERCENT) / PERCENT_SCALE
    : 1;
}

/** 按真实耗时推进脉冲，避免 120/144Hz 屏上播得更快。 */
export function advanceFocusPulse(remaining: number, deltaMs: number): number {
  if (remaining <= 0 || deltaMs <= 0) return Math.max(0, remaining);
  return Math.max(0, remaining - deltaMs / FOCUS_PULSE_FRAME_MS);
}

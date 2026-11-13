import { LOGIC_FRAME_MS } from '../domain/battle.ts';

/**
 * 原版 `INSTANTMSGSYSTEM_Add` 的屏幕提示。`CHAR_DrinkSpring @0x18ca30` 用它显示
 * 泉水效果文本：类型 0（屏幕居中）、生命 0x1e 个逻辑帧。反汇编见
 * work/findings/spring-message-2026-10-13.md。
 */
const INSTANT_MESSAGE_FRAMES = 30;
/** 每剩一个逻辑帧贡献 25% 不透明度；不足一帧也按一帧算。 */
const INSTANT_MESSAGE_ALPHA_PER_FRAME = 25 / 100;
export const INSTANT_MESSAGE_MS = INSTANT_MESSAGE_FRAMES * LOGIC_FRAME_MS;
/** `INSTANTMSG_Draw @0x1d820c` 的取位：水平居中、纵向取屏幕高度的 3/10（整数除法）。 */
const INSTANT_MESSAGE_HEIGHT_RATIO = 3 / 10;

export function instantMessagePoint(screenWidth: number, screenHeight: number): { x: number; y: number } {
  return { x: Math.floor(screenWidth / 2), y: Math.floor(screenHeight * INSTANT_MESSAGE_HEIGHT_RATIO) };
}

/**
 * `INSTANTMSG_Draw` 的透明度：剩下的整帧数不足 4 时每帧降 25，之后（0 帧）不再绘制，
 * 所以可见的最后三段是 75／50／25。
 */
export function instantMessageAlpha(remainingMs: number): number {
  if (remainingMs <= 0) return 0;
  return Math.min(1, Math.ceil(remainingMs / LOGIC_FRAME_MS) * INSTANT_MESSAGE_ALPHA_PER_FRAME);
}

/** 显示中的一条屏幕提示；由 `GameUI` 持有，随界面时钟推进。 */
export class InstantMessage {
  text = '';
  private remainingMs = 0;
  show(text: string): void { this.text = text; this.remainingMs = INSTANT_MESSAGE_MS; }
  clear(): void { this.text = ''; this.remainingMs = 0; }
  get alpha(): number { return this.text ? instantMessageAlpha(this.remainingMs) : 0; }
  tick(delta: number): void {
    if (!this.text) return;
    this.remainingMs -= delta;
    if (this.remainingMs <= 0) this.clear();
  }
}

import type Phaser from 'phaser';
import type { Cooldown } from '../../domain/combat.ts';

/** 只依赖快捷位里与冷却有关的字段，方便操作按钮和电脑模式技能行共用。 */
export interface CooldownSlotLike {
  entry: { kind: 'skill' | 'item'; id: string } | null;
  /** 物品格的恢复冷却；技能格的冷却来自 `cooldowns`。 */
  cooldown?: Cooldown;
}

/** 技能按技能 id 取冷却，物品用自己的格子冷却。 */
export function shortcutCooldown(
  slot: CooldownSlotLike | undefined,
  cooldowns: Readonly<Record<string, Cooldown>>
): Cooldown | undefined {
  const entry = slot?.entry;
  if (!entry) return undefined;
  return entry.kind === 'skill' ? cooldowns[entry.id] : slot!.cooldown;
}

/** 剩余比例；没有冷却返回 undefined。时长为 0 时按“刚开始冷却”处理，避免除零。 */
function progressOf(cooldown: Cooldown | undefined): number | undefined {
  if (!cooldown || cooldown.remainingMs <= 0) return undefined;
  if (cooldown.durationMs <= 0) return 0;
  return Math.min(1, Math.max(0, 1 - cooldown.remainingMs / cooldown.durationMs));
}

/** 画布重画签名：进度和半径不变就不必重画。 */
export function cooldownFanState(cooldown: Cooldown | undefined, radius: number): string {
  const progress = progressOf(cooldown);
  return progress === undefined ? '' : `${progress}:${radius}`;
}

/** 深色扇形表示剩余时间，亮色前沿和圆环让移动端小图标也能看清比例。 */
export function drawCooldownFan(graphics: Phaser.GameObjects.Graphics, radius: number, cooldown: Cooldown | undefined): void {
  graphics.clear();
  const progress = progressOf(cooldown);
  if (progress === undefined) return;
  const start = -Math.PI / 2 + progress * Math.PI * 2;
  graphics.fillStyle(0x000000, .55);
  if (progress <= 0) graphics.fillCircle(0, 0, radius);
  else graphics.slice(0, 0, radius, start, Math.PI * 1.5, false).fillPath();
  if (progress > 0 && progress < 1) {
    graphics.lineStyle(2, 0xffe6a3, .9);
    graphics.beginPath();
    graphics.moveTo(0, 0);
    graphics.lineTo(Math.cos(start) * radius, Math.sin(start) * radius);
    graphics.strokePath();
  }
  graphics.lineStyle(1, 0xffe6a3, .45);
  graphics.strokeCircle(0, 0, radius - 1);
}

/** 冷却图标上显示的整秒数；不足一秒显示 1，避免看起来像已经好了。 */
export function cooldownSecondsLabel(remainingMs: number): string {
  return remainingMs > 0 ? String(Math.ceil(remainingMs / 1000)) : '';
}

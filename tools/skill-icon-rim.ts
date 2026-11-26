import { PNG } from 'pngjs';

/** 原版 75×75 技能图标标准圆框与各技能原画的精确半径分界（全部 89 枚标准原版图标在 r >= 34.828 处逐像素一致）。 */
export const SKILL_ICON_SIZE = 75;
export const SKILL_ICON_CENTER = 37;
export const SKILL_RIM_INNER_RADIUS = 34.82;
const SKILL_INNER_SHADOW_START = 33.8;

/** 三张底色截然不同的原版技能图标，用于多图共识提取标准青铜圆框与透明边界，杜绝误选破框单图。 */
export const CANONICAL_RIM_SAMPLES = [
  'assets/skills/dark-strike.png',
  'assets/skills/spirit-of-nature.png',
  'assets/skills/flares-of-pain.png',
] as const;

export interface CanonicalSkillRim {
  readonly width: number;
  readonly height: number;
  /** 半径 r >= SKILL_RIM_INNER_RADIUS 的标准圆框 RGBA；透明像素 RGB 统一归零。 */
  readonly rgba: Uint8Array;
}

/**
 * 从多张底色不同的原版技能图标中提取 75×75 标准青铜圆框与透明边界，
 * 并强制校验：多图透明通道完全一致、严格八向对称、圆外全透明、外圈青铜框逐像素一致且对称。
 */
export function extractCanonicalSkillRim(samples: readonly PNG[]): CanonicalSkillRim {
  if (samples.length < 2) {
    throw new Error('提取标准技能圆框至少需要 2 张不同底色的原版图标作为共识样本');
  }
  const first = samples[0]!;
  for (const sample of samples) {
    if (sample.width !== SKILL_ICON_SIZE || sample.height !== SKILL_ICON_SIZE) {
      throw new Error(`技能圆框样本尺寸异常：期望 ${SKILL_ICON_SIZE}x${SKILL_ICON_SIZE}，实际 ${sample.width}x${sample.height}`);
    }
  }

  const rgba = new Uint8Array(SKILL_ICON_SIZE * SKILL_ICON_SIZE * 4);
  for (let y = 0; y < SKILL_ICON_SIZE; y++) {
    for (let x = 0; x < SKILL_ICON_SIZE; x++) {
      const idx = (y * SKILL_ICON_SIZE + x) * 4;
      const alpha = first.data[idx + 3]!;
      for (const sample of samples) {
        if (sample.data[idx + 3] !== alpha) {
          throw new Error(`技能圆框样本透明通道不一致于 (${x},${y})`);
        }
      }
      const symmetricCoords: readonly [number, number][] = [
        [SKILL_ICON_SIZE - 1 - x, y],
        [x, SKILL_ICON_SIZE - 1 - y],
        [y, x],
      ];
      for (const [sx, sy] of symmetricCoords) {
        if (first.data[(sy * SKILL_ICON_SIZE + sx) * 4 + 3] !== alpha) {
          throw new Error(`技能圆框样本透明通道不满足八向对称于 (${x},${y}) vs (${sx},${sy})`);
        }
      }

      const r = Math.hypot(x - SKILL_ICON_CENTER, y - SKILL_ICON_CENTER);
      if (r > 38.3 && alpha !== 0) {
        throw new Error(`技能圆框样本圆外存在非透明像素于 (${x},${y}) r=${r.toFixed(2)} alpha=${alpha}`);
      }
      if (r >= SKILL_RIM_INNER_RADIUS) {
        if (alpha === 0) continue; // 保持 (0,0,0,0)，避免缩放采样出现不可见白边
        const r0 = first.data[idx]!;
        const g0 = first.data[idx + 1]!;
        const b0 = first.data[idx + 2]!;
        for (const sample of samples) {
          if (sample.data[idx] !== r0 || sample.data[idx + 1] !== g0 || sample.data[idx + 2] !== b0) {
            throw new Error(`技能圆框样本外圈颜色不一致于 (${x},${y}) r=${r.toFixed(2)}`);
          }
        }
        for (const [sx, sy] of symmetricCoords) {
          const sIdx = (sy * SKILL_ICON_SIZE + sx) * 4;
          if (
            Math.abs(first.data[sIdx]! - r0) > 1 ||
            Math.abs(first.data[sIdx + 1]! - g0) > 1 ||
            Math.abs(first.data[sIdx + 2]! - b0) > 1
          ) {
            throw new Error(`技能圆框样本外圈颜色不满足八向对称于 (${x},${y}) vs (${sx},${sy})`);
          }
        }
        rgba[idx] = r0;
        rgba[idx + 1] = g0;
        rgba[idx + 2] = b0;
        rgba[idx + 3] = alpha;
      }
    }
  }
  return { width: SKILL_ICON_SIZE, height: SKILL_ICON_SIZE, rgba };
}

/** 将 75×75 原画封装进校验通过的标准青铜圆框，内缘仅对原画自身做黑槽压暗，不混入任何外部图颜色。 */
export function composeSkillIcon(rawRgba: Uint8Array, rim: CanonicalSkillRim): PNG {
  if (rawRgba.length !== SKILL_ICON_SIZE * SKILL_ICON_SIZE * 4) {
    throw new Error(`技能图标原画缓冲区长度异常：${rawRgba.length}`);
  }
  const png = new PNG({ width: SKILL_ICON_SIZE, height: SKILL_ICON_SIZE });
  for (let y = 0; y < SKILL_ICON_SIZE; y++) {
    for (let x = 0; x < SKILL_ICON_SIZE; x++) {
      const idx = (y * SKILL_ICON_SIZE + x) * 4;
      const r = Math.hypot(x - SKILL_ICON_CENTER, y - SKILL_ICON_CENTER);
      if (r >= SKILL_RIM_INNER_RADIUS) {
        png.data[idx] = rim.rgba[idx]!;
        png.data[idx + 1] = rim.rgba[idx + 1]!;
        png.data[idx + 2] = rim.rgba[idx + 2]!;
        png.data[idx + 3] = rim.rgba[idx + 3]!;
      } else if (r > SKILL_INNER_SHADOW_START) {
        const t = (r - SKILL_INNER_SHADOW_START) / (SKILL_RIM_INNER_RADIUS - SKILL_INNER_SHADOW_START);
        const gain = 1 - t * 0.85;
        png.data[idx] = Math.round(rawRgba[idx]! * gain);
        png.data[idx + 1] = Math.round(rawRgba[idx + 1]! * gain);
        png.data[idx + 2] = Math.round(rawRgba[idx + 2]! * gain);
        png.data[idx + 3] = 255;
      } else {
        png.data[idx] = rawRgba[idx]!;
        png.data[idx + 1] = rawRgba[idx + 1]!;
        png.data[idx + 2] = rawRgba[idx + 2]!;
        png.data[idx + 3] = 255;
      }
    }
  }
  return png;
}

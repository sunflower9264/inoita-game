/**
 * 长枪样板「直刺枪芒特效（spear-thrust-beam）」可编辑像素源数据。
 *
 * 严格采用逐格像素网格 + 量化色板构建（无模糊渐变、无外部生图），
 * 由 export.ts 代码导出透明 PNG（spear-effects.png）及双层（normal 蓝青光体 + add 炽白核心）特效配置。
 *
 * 形态设计：参照经典 2D 像素枪法直刺枪芒——根部尖束于枪箍，前段展宽成锐利柳叶气刃，
 * 尖端拖出细长破空针锋，辅以向后弯折的月牙破空气浪环与高能星火。
 *
 * 帧节奏（6 帧 @ 16.67 fps，对齐直刺动作 F4 出枪芒、F5 命中峰值）：
 * - Frame 0：枪尖聚能闪爆 + 破空尖锥
 * - Frame 1：枪芒疾射贯出 + 吞口第一道气浪环
 * - Frame 2：峰值贯通全长柳叶枪芒 + 双气浪环 + 锋尖十字星芒 + 伴飞金白火星
 * - Frame 3：前蹿拉伸，尾段抽离并扩散残波
 * - Frame 4：裂解为错落锐利残丝与跃动星火
 * - Frame 5：末端细碎星芒消散
 */

export interface EffectFrameGrid {
  id: string;
  rows: readonly string[];
}

export interface DirectionalEffectSource {
  direction: 'west' | 'south' | 'north';
  frameWidth: number;
  frameHeight: number;
  originX: number;
  originY: number;
  baseFrames: readonly EffectFrameGrid[];
  addFrames: readonly EffectFrameGrid[];
}

/** 枪芒底光层（normal 混合）：深蓝青外缘到亮冰蓝主光体，保证深色/游戏/浅色画布都轮廓锐利。 */
export const BEAM_BASE_PALETTE: Readonly<Record<string, readonly [number, number, number, number]>> = {
  '.': [0, 0, 0, 0],
  d: [0x10, 0x38, 0x7e, 135], // 远缘深蓝晕
  D: [0x1a, 0x5c, 0xbd, 200], // 外轮廓深海蓝
  B: [0x33, 0x99, 0xe8, 228], // 主光体湛蓝
  C: [0x78, 0xd9, 0xff, 242], // 内层冰青
  L: [0xc8, 0xf4, 0xff, 248], // 靠近核心极亮青白
  W: [0xf4, 0xfc, 0xff, 255], // 核心纯白
  g: [0xff, 0xd8, 0x78, 225], // 枪锋金火星
};

/** 枪芒炽核层（add 叠加）：纯白锋脊、高频气浪与爆裂星火，在深色与游戏场景上高能提亮。 */
export const BEAM_ADD_PALETTE: Readonly<Record<string, readonly [number, number, number, number]>> = {
  '.': [0, 0, 0, 0],
  d: [0x18, 0x54, 0xb8, 95],
  D: [0x2a, 0x8a, 0xe8, 155],
  B: [0x52, 0xc4, 0xff, 200],
  C: [0xa6, 0xec, 0xff, 232],
  L: [0xe0, 0xfa, 0xff, 246],
  W: [0xff, 0xff, 0xff, 255],
  g: [0xff, 0xee, 0xb0, 245],
};

const COLOR_RANK: Record<string, number> = {
  '.': 0, d: 1, D: 2, B: 3, C: 4, L: 5, g: 6, W: 7,
};

function blank(w: number, h: number): string[][] {
  return Array.from({ length: h }, () => Array.from({ length: w }, () => '.'));
}

function plotMax(grid: string[][], x: number, y: number, ch: string): void {
  const rx = Math.round(x);
  const ry = Math.round(y);
  if (ry < 0 || ry >= grid.length || rx < 0 || rx >= grid[0].length) return;
  if ((COLOR_RANK[ch] ?? 0) > (COLOR_RANK[grid[ry][rx]] ?? 0)) grid[ry][rx] = ch;
}

/** 4 像素小菱形星火。 */
function plotSpark(
  base: string[][],
  add: string[][],
  u: number,
  v: number,
  ch: string,
  putPt: (grid: string[][], along: number, across: number, c: string) => void,
  big = false,
): void {
  putPt(base, u, v, ch);
  putPt(add, u, v, 'W');
  if (big) {
    putPt(add, u - 1, v, ch);
    putPt(add, u + 1, v, ch);
    putPt(add, u, v - 1, ch);
    putPt(add, u, v + 1, ch);
  }
}

function drawLanceAxis(
  base: string[][],
  add: string[][],
  frameIndex: number,
  axisLength: number,
  centerV: number,
  putPt: (grid: string[][], along: number, across: number, ch: string) => void,
): void {
  // along = 0 在枪芒起爆根部（靠近枪箍/枪头后缘），正方向沿出枪方向直刺贯出
  if (frameIndex === 0) {
    // Frame 0：枪尖聚能闪爆 + 锐利破空尖锥（along: 2..36）
    const start = 2;
    const end = 36;
    for (let u = start; u <= end; u++) {
      const f = (u - start) / (end - start);
      const halfW = f < 0.32
        ? 0.8 + (f / 0.32) * 5.6
        : 6.4 * Math.pow(1 - (f - 0.32) / 0.68, 1.15);
      for (let v = -Math.ceil(halfW); v <= Math.ceil(halfW); v++) {
        const av = Math.abs(v);
        if (av > halfW + 0.15) continue;
        const ratio = av / Math.max(0.5, halfW);
        if (ratio < 0.28) {
          putPt(base, u, centerV + v, 'W');
          putPt(add, u, centerV + v, 'W');
        } else if (ratio < 0.56) {
          putPt(base, u, centerV + v, 'C');
          putPt(add, u, centerV + v, 'C');
        } else if (ratio < 0.84) {
          putPt(base, u, centerV + v, 'B');
          putPt(add, u, centerV + v, 'D');
        } else {
          putPt(base, u, centerV + v, 'D');
        }
      }
    }
    // 爆闪十字星芒（中心在 along=14）
    for (let s = -10; s <= 10; s++) {
      const c = Math.abs(s) <= 3 ? 'W' : Math.abs(s) <= 6 ? 'L' : 'C';
      putPt(base, 14, centerV + s, c);
      putPt(add, 14, centerV + s, c);
    }
    for (let s = -6; s <= 6; s++) {
      const c = Math.abs(s) <= 2 ? 'W' : 'C';
      putPt(add, 14 + s, centerV + s, c);
      putPt(add, 14 + s, centerV - s, c);
    }
    return;
  }

  if (frameIndex === 1 || frameIndex === 2) {
    const isPeak = frameIndex === 2;
    const start = isPeak ? 2 : 0;
    const end = isPeak ? axisLength - 1 : axisLength - 12;
    const maxW = isPeak ? 8.2 : 6.8;

    // 1. 柳叶枪芒主体：根部细尖束入 → 中前段(f=0.58)展开如巨型虚影枪刃 → 尖端拉出细长针锋！
    for (let u = start; u <= end; u++) {
      const f = (u - start) / (end - start);
      let halfW: number;
      if (f < 0.16) {
        // 枪箍处极细尾锋渐入
        halfW = 0.6 + (f / 0.16) * (maxW * 0.36);
      } else if (f < 0.58) {
        // 气刃逐渐展宽至饱满柳叶腹
        const k = (f - 0.16) / 0.42;
        halfW = maxW * (0.36 + Math.sin(k * Math.PI * 0.5) * 0.64);
      } else {
        // 前锋如利矛急速收束并拖出针状枪尖
        const k = (f - 0.58) / 0.42;
        halfW = maxW * Math.pow(1 - k, 1.38);
      }

      // 细微锯齿气流纹，增强像素动势
      const ripple = (f > 0.2 && f < 0.8 && (u + frameIndex * 2) % 6 === 0) ? 0.65 : 0;
      const edgeW = halfW + ripple;

      for (let v = -Math.ceil(edgeW); v <= Math.ceil(edgeW); v++) {
        const av = Math.abs(v);
        if (av > edgeW + 0.12) continue;
        const r = av / Math.max(0.5, edgeW);
        const coreW = f > 0.15 && f < 0.88 ? (isPeak ? 1.35 : 1.05) : 0.65;
        if (av <= coreW) {
          putPt(base, u, centerV + v, 'W');
          putPt(add, u, centerV + v, 'W');
        } else if (r < 0.44) {
          putPt(base, u, centerV + v, 'L');
          putPt(add, u, centerV + v, 'L');
        } else if (r < 0.68) {
          putPt(base, u, centerV + v, 'C');
          putPt(add, u, centerV + v, 'C');
        } else if (r < 0.88) {
          putPt(base, u, centerV + v, 'B');
          putPt(add, u, centerV + v, 'B');
        } else {
          putPt(base, u, centerV + v, (u + v) % 2 === 0 ? 'D' : 'd');
          if (isPeak && (u + v) % 2 === 0) putPt(add, u, centerV + v, 'd');
        }
      }
    }

    // 2. 向后弯折的锐利破空气浪环（月牙锥形激波）
    const rings = isPeak
      ? [{ u: 22, rad: 13, curve: 10, thick: 2 }, { u: 48, rad: 10, curve: 8, thick: 1 }]
      : [{ u: 16, rad: 11, curve: 9, thick: 2 }];
    for (const ring of rings) {
      for (let v = -ring.rad; v <= ring.rad; v++) {
        const norm = Math.abs(v) / ring.rad;
        const backCurve = Math.round(norm * norm * ring.curve);
        const ru = ring.u - backCurve;
        const ch = norm < 0.4 ? 'W' : norm < 0.72 ? 'C' : 'B';
        putPt(base, ru, centerV + v, ch);
        putPt(add, ru, centerV + v, ch);
        if (ring.thick >= 2 && norm < 0.82) {
          putPt(base, ru - 1, centerV + v, norm < 0.45 ? 'C' : 'D');
          putPt(add, ru - 1, centerV + v, norm < 0.45 ? 'B' : 'd');
        }
      }
    }

    // 3. 贴刃收束破风丝（随枪芒外廓向枪尖略微内收，非死板平行线）
    const windWisps = isPeak
      ? [
          { s: 14, e: end - 14, v0: -10, v1: -5, c: 'C' },
          { s: 18, e: end - 12, v0: 10, v1: 5, c: 'C' },
          { s: 28, e: end - 22, v0: -13, v1: -9, c: 'B' },
          { s: 26, e: end - 20, v0: 13, v1: 9, c: 'B' },
        ]
      : [
          { s: 10, e: end - 14, v0: -9, v1: -5, c: 'C' },
          { s: 14, e: end - 12, v0: 9, v1: 5, c: 'C' },
        ];
    for (const wisp of windWisps) {
      for (let u = wisp.s; u <= wisp.e; u++) {
        const f = (u - wisp.s) / Math.max(1, wisp.e - wisp.s);
        const v = wisp.v0 + (wisp.v1 - wisp.v0) * f;
        const ch = f > 0.75 ? 'L' : wisp.c;
        putPt(base, u, centerV + v, ch);
        putPt(add, u, centerV + v, ch);
      }
    }

    // 4. 锋尖星芒与跃动金白星火
    const tipStarU = Math.round(start + (end - start) * 0.78);
    const starLen = isPeak ? 8 : 5;
    for (let s = -starLen; s <= starLen; s++) {
      const ch = Math.abs(s) <= 2 ? 'W' : Math.abs(s) <= 5 ? 'L' : 'C';
      putPt(add, tipStarU, centerV + s, ch);
      if (Math.abs(s) <= 4) putPt(base, tipStarU, centerV + s, ch);
    }
    const sparks: [number, number, string, boolean][] = isPeak
      ? [
          [26, -12, 'g', true],
          [40, 12, 'L', false],
          [56, -10, 'g', false],
          [66, 9, 'C', true],
          [end - 9, -6, 'W', false],
          [end - 5, 6, 'g', false],
        ]
      : [
          [22, -10, 'g', false],
          [38, 9, 'L', true],
          [52, -7, 'W', false],
        ];
    for (const [su, sv, ch, big] of sparks) {
      plotSpark(base, add, su, centerV + sv, ch, putPt, big);
    }
    return;
  }

  if (frameIndex === 3) {
    // Frame 3：枪芒前蹿收细，中后段抽空，形成修长锋利余芒与扩散断环
    const start = 16;
    const end = axisLength - 1;
    for (let u = start; u <= end; u++) {
      const f = (u - start) / (end - start);
      const halfW = f < 0.22
        ? 0.5 + (f / 0.22) * 3.4
        : f < 0.65
          ? 3.9 + ((f - 0.22) / 0.43) * 0.7
          : 4.6 * Math.pow(1 - (f - 0.65) / 0.35, 1.3);
      for (let v = -Math.ceil(halfW); v <= Math.ceil(halfW); v++) {
        const av = Math.abs(v);
        if (av > halfW + 0.1) continue;
        if (av <= 0.8 && f > 0.15 && f < 0.92) {
          putPt(base, u, centerV + v, 'L');
          putPt(add, u, centerV + v, 'W');
        } else if (av <= halfW * 0.52) {
          putPt(base, u, centerV + v, 'C');
          putPt(add, u, centerV + v, 'C');
        } else if ((u + v) % 2 === 0) {
          putPt(base, u, centerV + v, 'B');
          putPt(add, u, centerV + v, 'D');
        }
      }
    }
    // 扩散断环（前推到 along=44）
    for (let v = -14; v <= 14; v++) {
      const norm = Math.abs(v) / 14;
      if (norm < 0.32) continue;
      const ru = 44 - Math.round(norm * norm * 10);
      const ch = norm < 0.68 ? 'C' : 'B';
      putPt(base, ru, centerV + v, ch);
      putPt(add, ru, centerV + v, ch);
    }
    // 错落脱体风丝
    const strips: [number, number, number, number][] = [
      [14, end - 22, -8, -5],
      [20, end - 16, 8, 5],
      [42, end - 6, -11, -8],
      [38, end - 8, 11, 8],
    ];
    for (const [s, e, v0, v1] of strips) {
      for (let u = s; u <= e; u++) {
        if ((u + Math.abs(v0)) % 6 === 0) continue;
        const f = (u - s) / Math.max(1, e - s);
        const v = v0 + (v1 - v0) * f;
        putPt(base, u, centerV + v, 'C');
        putPt(add, u, centerV + v, 'B');
      }
    }
    plotSpark(base, add, 24, centerV - 12, 'L', putPt, false);
    plotSpark(base, add, 48, centerV + 12, 'g', putPt, true);
    plotSpark(base, add, 66, centerV - 10, 'W', putPt, false);
    plotSpark(base, add, end - 6, centerV + 7, 'g', putPt, true);
    return;
  }

  if (frameIndex === 4) {
    // Frame 4：错落飞散的细锐气芒残丝 + 菱形星火
    const wisps: [number, number, number, number, string][] = [
      [28, axisLength - 4, 0, 0, 'L'],
      [34, axisLength - 12, -5, -3, 'C'],
      [38, axisLength - 14, 5, 3, 'C'],
      [20, axisLength - 36, -9, -11, 'B'],
      [24, axisLength - 32, 9, 11, 'B'],
      [56, axisLength - 2, -2, -1, 'W'],
    ];
    for (const [s, e, v0, v1, ch] of wisps) {
      for (let u = s; u <= e; u++) {
        if ((u * 3 + Math.abs(v0)) % 7 < 2) continue;
        const f = (u - s) / Math.max(1, e - s);
        const v = v0 + (v1 - v0) * f;
        putPt(base, u, centerV + v, ch === 'W' ? 'C' : 'B');
        putPt(add, u, centerV + v, ch);
      }
    }
    plotSpark(base, add, 30, centerV - 11, 'C', putPt, false);
    plotSpark(base, add, 44, centerV + 10, 'g', putPt, true);
    plotSpark(base, add, 60, centerV - 8, 'W', putPt, true);
    plotSpark(base, add, 74, centerV + 7, 'L', putPt, false);
    plotSpark(base, add, axisLength - 5, centerV - 4, 'g', putPt, false);
    return;
  }

  // Frame 5：末端细碎星芒消散
  const flickers: [number, number, number, string][] = [
    [38, 46, -6, 'B'],
    [54, 65, 0, 'C'],
    [68, 76, 5, 'B'],
    [74, 82, -3, 'L'],
  ];
  for (const [s, e, v, ch] of flickers) {
    for (let u = s; u <= e; u += 2) {
      putPt(base, u, centerV + v, 'D');
      putPt(add, u, centerV + v, ch);
    }
  }
  plotSpark(base, add, 46, centerV - 10, 'C', putPt, false);
  plotSpark(base, add, 62, centerV + 8, 'g', putPt, true);
  plotSpark(base, add, 78, centerV - 7, 'L', putPt, false);
  plotSpark(base, add, axisLength - 4, centerV + 1, 'W', putPt, true);
}

function buildDirectionalBeam(direction: 'west' | 'south' | 'north'): DirectionalEffectSource {
  const frameCount = 6;
  const baseFrames: EffectFrameGrid[] = [];
  const addFrames: EffectFrameGrid[] = [];

  if (direction === 'west') {
    // 西向：110×36，角色原点 (0,0) 在 (98, 29)，枪杆水平中心在 y = -11 -> 像素行 18
    // along=0 在 x = -12（像素 x=86，紧接枪箍前方），贯出至 x = -96（像素 x=2）
    const w = 110;
    const h = 36;
    const startX = 86;
    const axisLength = 84;
    const centerY = 18;
    for (let i = 0; i < frameCount; i++) {
      const base = blank(w, h);
      const add = blank(w, h);
      drawLanceAxis(base, add, i, axisLength, centerY, (grid, along, v, ch) => {
        plotMax(grid, startX - along, v, ch);
      });
      baseFrames.push({ id: `spear-thrust-beam-west-base-${i}`, rows: base.map(r => r.join('')) });
      addFrames.push({ id: `spear-thrust-beam-west-add-${i}`, rows: add.map(r => r.join('')) });
    }
    return {
      direction,
      frameWidth: w,
      frameHeight: h,
      originX: 98 / w,
      originY: 29 / h,
      baseFrames,
      addFrames,
    };
  }

  if (direction === 'south') {
    // 南向：36×108，角色原点 (0,0) 在 (21, 8)，枪尖沿 x = -3（像素列 18）直刺向南 (+y)
    // along=0 在 y = +12（像素 y=20，避开角色躯干与双脚，从枪箍前方射出），贯出至 y = +96（像素 y=104）
    const w = 36;
    const h = 108;
    const startY = 20;
    const axisLength = 84;
    const centerX = 18;
    for (let i = 0; i < frameCount; i++) {
      const base = blank(w, h);
      const add = blank(w, h);
      drawLanceAxis(base, add, i, axisLength, centerX, (grid, along, v, ch) => {
        plotMax(grid, v, startY + along, ch);
      });
      baseFrames.push({ id: `spear-thrust-beam-south-base-${i}`, rows: base.map(r => r.join('')) });
      addFrames.push({ id: `spear-thrust-beam-south-add-${i}`, rows: add.map(r => r.join('')) });
    }
    return {
      direction,
      frameWidth: w,
      frameHeight: h,
      originX: 21 / w,
      originY: 8 / h,
      baseFrames,
      addFrames,
    };
  }

  // 北向：36×114，角色原点 (0,0) 在 (18, 110)，枪尖沿 x = 0（像素列 18）直刺向北 (-y)
  // along=0 在 y = -30（像素 y=80， cleanly 避开头顶，从头顶上方枪箍处破空刺出），贯出至 y = -108（像素 y=2）
  const w = 36;
  const h = 114;
  const startY = 80;
  const axisLength = 78;
  const centerX = 18;
  for (let i = 0; i < frameCount; i++) {
    const base = blank(w, h);
    const add = blank(w, h);
    drawLanceAxis(base, add, i, axisLength, centerX, (grid, along, v, ch) => {
      plotMax(grid, v, startY - along, ch);
    });
    baseFrames.push({ id: `spear-thrust-beam-north-base-${i}`, rows: base.map(r => r.join('')) });
    addFrames.push({ id: `spear-thrust-beam-north-add-${i}`, rows: add.map(r => r.join('')) });
  }
  return {
    direction,
    frameWidth: w,
    frameHeight: h,
    originX: 18 / w,
    originY: 110 / h,
    baseFrames,
    addFrames,
  };
}

export const SPEAR_THRUST_BEAM_SOURCES: readonly DirectionalEffectSource[] = [
  buildDirectionalBeam('west'),
  buildDirectionalBeam('south'),
  buildDirectionalBeam('north'),
];

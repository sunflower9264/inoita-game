/**
 * 长枪样板原创像素特效源数据（全部逐格像素网格 + 量化色板，代码导出透明 PNG）。
 *
 * 第一批包含 5 套四向像素特效（全部采用 normal 底光 + add 炽核双层，适配深色/游戏/浅色画布）：
 * 1. spear-thrust-beam   （6 帧）：破阵枪 / 基础直刺的蓝青柳叶贯通枪芒（保留既有）
 * 2. spear-basic-thrust  （3 帧）：普通攻击第一段 · 素银轻刺破风线
 * 3. spear-basic-flick   （3 帧）：普通攻击第二段 · 素银极薄小月牙拨光
 * 4. spear-heavy-pierce  （5 帧）：狂龙穿心破 · 赤金炽白重刺破甲芒（带向后喷射破甲气锥）
 * 5. spear-slam-arc      （4 帧）：伏龙震 · 暗金土黄纵向重劈弧光 + 地面震裂冲击环
 */

export type RgbaPalette = Readonly<Record<string, readonly [number, number, number, number]>>;

export interface EffectFrameGrid {
  id: string;
  rows: readonly string[];
}

export interface DirectionalEffectSource {
  effectId: string;
  direction: 'west' | 'south' | 'north' | 'default';
  frameWidth: number;
  frameHeight: number;
  originX: number;
  originY: number;
  basePalette: RgbaPalette;
  addPalette: RgbaPalette;
  baseFrames: readonly EffectFrameGrid[];
  addFrames: readonly EffectFrameGrid[];
}

// ---------------------------------------------------------------------------
// 量化调色板族（冷青贯气 / 素银普攻 / 赤金破甲 / 暗金纵劈）
// ---------------------------------------------------------------------------

/** 1. 蓝青柳叶枪芒色板（破阵枪 / 龙王破族） */
export const BEAM_BASE_PALETTE: RgbaPalette = {
  '.': [0, 0, 0, 0],
  d: [0x10, 0x38, 0x7e, 135],
  D: [0x1a, 0x5c, 0xbd, 200],
  B: [0x33, 0x99, 0xe8, 228],
  C: [0x78, 0xd9, 0xff, 242],
  L: [0xc8, 0xf4, 0xff, 248],
  W: [0xf4, 0xfc, 0xff, 255],
  g: [0xff, 0xd8, 0x78, 225],
};

export const BEAM_ADD_PALETTE: RgbaPalette = {
  '.': [0, 0, 0, 0],
  d: [0x18, 0x54, 0xb8, 95],
  D: [0x2a, 0x8a, 0xe8, 155],
  B: [0x52, 0xc4, 0xff, 200],
  C: [0xa6, 0xec, 0xff, 232],
  L: [0xe0, 0xfa, 0xff, 246],
  W: [0xff, 0xff, 0xff, 255],
  g: [0xff, 0xee, 0xb0, 245],
};

/** 2. 素银普攻色板（轻灵克制，不抢技能风头） */
export const SILVER_BASE_PALETTE: RgbaPalette = {
  '.': [0, 0, 0, 0],
  d: [0x36, 0x48, 0x60, 115],
  D: [0x5a, 0x74, 0x92, 175],
  B: [0x90, 0xae, 0xc9, 210],
  C: [0xc4, 0xdc, 0xf0, 232],
  L: [0xe4, 0xf2, 0xff, 245],
  W: [0xff, 0xff, 0xff, 255],
  g: [0xff, 0xf0, 0xc8, 220],
};

export const SILVER_ADD_PALETTE: RgbaPalette = {
  '.': [0, 0, 0, 0],
  d: [0x4c, 0x66, 0x84, 80],
  D: [0x7e, 0xa2, 0xc4, 130],
  B: [0xb4, 0xd2, 0xec, 175],
  C: [0xd8, 0xec, 0xff, 210],
  L: [0xee, 0xf7, 0xff, 235],
  W: [0xff, 0xff, 0xff, 255],
  g: [0xff, 0xf4, 0xd4, 230],
};

/** 3. 赤金/炽白重刺破甲色板（狂龙穿心破） */
export const HEAVY_BASE_PALETTE: RgbaPalette = {
  '.': [0, 0, 0, 0],
  d: [0x6c, 0x12, 0x08, 135], // 深赤暗焰
  D: [0xb4, 0x26, 0x0e, 205], // 赤红烈边
  B: [0xe8, 0x5c, 0x18, 232], // 炽橙主光
  C: [0xff, 0xa8, 0x30, 244], // 烈金内光
  L: [0xff, 0xe4, 0x86, 250], // 亮金白锋
  W: [0xff, 0xfc, 0xf0, 255], // 炽白核心
  g: [0xff, 0xf0, 0x98, 235], // 破甲金火星
};

export const HEAVY_ADD_PALETTE: RgbaPalette = {
  '.': [0, 0, 0, 0],
  d: [0x8c, 0x1e, 0x0a, 95],
  D: [0xd8, 0x42, 0x12, 160],
  B: [0xff, 0x82, 0x24, 205],
  C: [0xff, 0xc8, 0x52, 234],
  L: [0xff, 0xf0, 0xa6, 248],
  W: [0xff, 0xff, 0xff, 255],
  g: [0xff, 0xf6, 0xb8, 245],
};

/** 4. 暗金/土黄纵向重劈色板（伏龙震 · 力劈华山） */
export const SLAM_BASE_PALETTE: RgbaPalette = {
  '.': [0, 0, 0, 0],
  d: [0x44, 0x28, 0x0e, 145], // 深土褐边
  D: [0x7e, 0x4c, 0x16, 210], // 暗青铜金
  B: [0xbe, 0x7c, 0x22, 232], // 土金主弧
  C: [0xe8, 0xb4, 0x44, 244], // 琥珀金
  L: [0xff, 0xe2, 0x8c, 250], // 亮金刃脊
  W: [0xff, 0xf8, 0xdc, 255], // 白金砸击锋芒
  g: [0xff, 0xd2, 0x62, 235], // 碎岩金星
};

export const SLAM_ADD_PALETTE: RgbaPalette = {
  '.': [0, 0, 0, 0],
  d: [0x5e, 0x38, 0x12, 90],
  D: [0xa6, 0x68, 0x1c, 150],
  B: [0xdc, 0x9a, 0x30, 195],
  C: [0xf8, 0xc8, 0x5c, 225],
  L: [0xff, 0xec, 0xa4, 244],
  W: [0xff, 0xfc, 0xe8, 255],
  g: [0xff, 0xe6, 0x88, 240],
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

function drawArcCurve(
  base: string[][],
  add: string[][],
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  startDeg: number,
  endDeg: number,
  maxThickness: number,
  brightHead: boolean,
  steps = 90,
): void {
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    const rad = ((startDeg + (endDeg - startDeg) * f) * Math.PI) / 180;
    // 尾部细尖入，中前段饱满，头部锐利收锋
    const taper = Math.sin(Math.pow(f, brightHead ? 0.72 : 1.0) * Math.PI);
    const thick = Math.max(0.4, maxThickness * taper);
    const ca = Math.cos(rad);
    const sa = Math.sin(rad);
    for (let o = -thick; o <= thick; o += 0.45) {
      const px = cx + (rx + o) * ca;
      const py = cy + (ry + o) * sa;
      const norm = Math.abs(o) / Math.max(0.5, thick);
      if (o >= 0 && norm < 0.35 && f > 0.25) {
        plotMax(base, px, py, 'W');
        plotMax(add, px, py, 'W');
      } else if (norm < 0.55) {
        plotMax(base, px, py, f > 0.35 ? 'L' : 'C');
        plotMax(add, px, py, f > 0.35 ? 'L' : 'C');
      } else if (norm < 0.82) {
        plotMax(base, px, py, 'B');
        plotMax(add, px, py, 'B');
      } else {
        plotMax(base, px, py, 'D');
        if (f > 0.4) plotMax(add, px, py, 'd');
      }
    }
  }
}

// ===========================================================================
// 1. 破阵枪 / 基础直刺：蓝青柳叶贯通枪芒（spear-thrust-beam，6 帧，保持既有表现）
// ===========================================================================

function drawLanceAxis(
  base: string[][],
  add: string[][],
  frameIndex: number,
  axisLength: number,
  centerV: number,
  putPt: (grid: string[][], along: number, across: number, ch: string) => void,
): void {
  if (frameIndex === 0) {
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
        if (ratio < 0.28) { putPt(base, u, centerV + v, 'W'); putPt(add, u, centerV + v, 'W'); }
        else if (ratio < 0.56) { putPt(base, u, centerV + v, 'C'); putPt(add, u, centerV + v, 'C'); }
        else if (ratio < 0.84) { putPt(base, u, centerV + v, 'B'); putPt(add, u, centerV + v, 'D'); }
        else { putPt(base, u, centerV + v, 'D'); }
      }
    }
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

    for (let u = start; u <= end; u++) {
      const f = (u - start) / (end - start);
      let halfW: number;
      if (f < 0.16) halfW = 0.6 + (f / 0.16) * (maxW * 0.36);
      else if (f < 0.58) {
        const k = (f - 0.16) / 0.42;
        halfW = maxW * (0.36 + Math.sin(k * Math.PI * 0.5) * 0.64);
      } else {
        const k = (f - 0.58) / 0.42;
        halfW = maxW * Math.pow(1 - k, 1.38);
      }
      const ripple = (f > 0.2 && f < 0.8 && (u + frameIndex * 2) % 6 === 0) ? 0.65 : 0;
      const edgeW = halfW + ripple;

      for (let v = -Math.ceil(edgeW); v <= Math.ceil(edgeW); v++) {
        const av = Math.abs(v);
        if (av > edgeW + 0.12) continue;
        const r = av / Math.max(0.5, edgeW);
        const coreW = f > 0.15 && f < 0.88 ? (isPeak ? 1.35 : 1.05) : 0.65;
        if (av <= coreW) { putPt(base, u, centerV + v, 'W'); putPt(add, u, centerV + v, 'W'); }
        else if (r < 0.44) { putPt(base, u, centerV + v, 'L'); putPt(add, u, centerV + v, 'L'); }
        else if (r < 0.68) { putPt(base, u, centerV + v, 'C'); putPt(add, u, centerV + v, 'C'); }
        else if (r < 0.88) { putPt(base, u, centerV + v, 'B'); putPt(add, u, centerV + v, 'B'); }
        else {
          putPt(base, u, centerV + v, (u + v) % 2 === 0 ? 'D' : 'd');
          if (isPeak && (u + v) % 2 === 0) putPt(add, u, centerV + v, 'd');
        }
      }
    }

    const rings = isPeak
      ? [{ u: 22, rad: 13, curve: 10, thick: 2 }, { u: 48, rad: 10, curve: 8, thick: 1 }]
      : [{ u: 16, rad: 11, curve: 9, thick: 2 }];
    for (const ring of rings) {
      for (let v = -ring.rad; v <= ring.rad; v++) {
        const norm = Math.abs(v) / ring.rad;
        const ru = ring.u - Math.round(norm * norm * ring.curve);
        const ch = norm < 0.4 ? 'W' : norm < 0.72 ? 'C' : 'B';
        putPt(base, ru, centerV + v, ch);
        putPt(add, ru, centerV + v, ch);
        if (ring.thick >= 2 && norm < 0.82) {
          putPt(base, ru - 1, centerV + v, norm < 0.45 ? 'C' : 'D');
          putPt(add, ru - 1, centerV + v, norm < 0.45 ? 'B' : 'd');
        }
      }
    }

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

    const tipStarU = Math.round(start + (end - start) * 0.78);
    const starLen = isPeak ? 8 : 5;
    for (let s = -starLen; s <= starLen; s++) {
      const ch = Math.abs(s) <= 2 ? 'W' : Math.abs(s) <= 5 ? 'L' : 'C';
      putPt(add, tipStarU, centerV + s, ch);
      if (Math.abs(s) <= 4) putPt(base, tipStarU, centerV + s, ch);
    }
    const sparks: [number, number, string, boolean][] = isPeak
      ? [[26, -12, 'g', true], [40, 12, 'L', false], [56, -10, 'g', false], [66, 9, 'C', true], [end - 9, -6, 'W', false], [end - 5, 6, 'g', false]]
      : [[22, -10, 'g', false], [38, 9, 'L', true], [52, -7, 'W', false]];
    for (const [su, sv, ch, big] of sparks) plotSpark(base, add, su, centerV + sv, ch, putPt, big);
    return;
  }

  if (frameIndex === 3) {
    const start = 16;
    const end = axisLength - 1;
    for (let u = start; u <= end; u++) {
      const f = (u - start) / (end - start);
      const halfW = f < 0.22
        ? 0.5 + (f / 0.22) * 3.4
        : f < 0.65 ? 3.9 + ((f - 0.22) / 0.43) * 0.7 : 4.6 * Math.pow(1 - (f - 0.65) / 0.35, 1.3);
      for (let v = -Math.ceil(halfW); v <= Math.ceil(halfW); v++) {
        const av = Math.abs(v);
        if (av > halfW + 0.1) continue;
        if (av <= 0.8 && f > 0.15 && f < 0.92) { putPt(base, u, centerV + v, 'L'); putPt(add, u, centerV + v, 'W'); }
        else if (av <= halfW * 0.52) { putPt(base, u, centerV + v, 'C'); putPt(add, u, centerV + v, 'C'); }
        else if ((u + v) % 2 === 0) { putPt(base, u, centerV + v, 'B'); putPt(add, u, centerV + v, 'D'); }
      }
    }
    for (let v = -14; v <= 14; v++) {
      const norm = Math.abs(v) / 14;
      if (norm < 0.32) continue;
      const ru = 44 - Math.round(norm * norm * 10);
      const ch = norm < 0.68 ? 'C' : 'B';
      putPt(base, ru, centerV + v, ch);
      putPt(add, ru, centerV + v, ch);
    }
    const strips: [number, number, number, number][] = [[14, end - 22, -8, -5], [20, end - 16, 8, 5], [42, end - 6, -11, -8], [38, end - 8, 11, 8]];
    for (const [s, e, v0, v1] of strips) {
      for (let u = s; u <= e; u++) {
        if ((u + Math.abs(v0)) % 6 === 0) continue;
        const f = (u - s) / Math.max(1, e - s);
        putPt(base, u, centerV + v0 + (v1 - v0) * f, 'C');
        putPt(add, u, centerV + v0 + (v1 - v0) * f, 'B');
      }
    }
    plotSpark(base, add, 24, centerV - 12, 'L', putPt, false);
    plotSpark(base, add, 48, centerV + 12, 'g', putPt, true);
    plotSpark(base, add, 66, centerV - 10, 'W', putPt, false);
    plotSpark(base, add, end - 6, centerV + 7, 'g', putPt, true);
    return;
  }

  if (frameIndex === 4) {
    const wisps: [number, number, number, number, string][] = [
      [28, axisLength - 4, 0, 0, 'L'], [34, axisLength - 12, -5, -3, 'C'], [38, axisLength - 14, 5, 3, 'C'],
      [20, axisLength - 36, -9, -11, 'B'], [24, axisLength - 32, 9, 11, 'B'], [56, axisLength - 2, -2, -1, 'W'],
    ];
    for (const [s, e, v0, v1, ch] of wisps) {
      for (let u = s; u <= e; u++) {
        if ((u * 3 + Math.abs(v0)) % 7 < 2) continue;
        const f = (u - s) / Math.max(1, e - s);
        putPt(base, u, centerV + v0 + (v1 - v0) * f, ch === 'W' ? 'C' : 'B');
        putPt(add, u, centerV + v0 + (v1 - v0) * f, ch);
      }
    }
    plotSpark(base, add, 30, centerV - 11, 'C', putPt, false);
    plotSpark(base, add, 44, centerV + 10, 'g', putPt, true);
    plotSpark(base, add, 60, centerV - 8, 'W', putPt, true);
    plotSpark(base, add, 74, centerV + 7, 'L', putPt, false);
    plotSpark(base, add, axisLength - 5, centerV - 4, 'g', putPt, false);
    return;
  }

  const flickers: [number, number, number, string][] = [[38, 46, -6, 'B'], [54, 65, 0, 'C'], [68, 76, 5, 'B'], [74, 82, -3, 'L']];
  for (const [s, e, v, ch] of flickers) {
    for (let u = s; u <= e; u += 2) { putPt(base, u, centerV + v, 'D'); putPt(add, u, centerV + v, ch); }
  }
  plotSpark(base, add, 46, centerV - 10, 'C', putPt, false);
  plotSpark(base, add, 62, centerV + 8, 'g', putPt, true);
  plotSpark(base, add, 78, centerV - 7, 'L', putPt, false);
  plotSpark(base, add, axisLength - 4, centerV + 1, 'W', putPt, true);
}

function buildDirectionalLinearEffect(options: {
  effectId: string;
  direction: 'west' | 'south' | 'north';
  frameCount: number;
  width: number;
  height: number;
  originPx: [number, number];
  startAlongPx: number;
  axisLength: number;
  centerCrossPx: number;
  basePalette: RgbaPalette;
  addPalette: RgbaPalette;
  drawer: (
    base: string[][],
    add: string[][],
    frameIndex: number,
    axisLength: number,
    centerV: number,
    putPt: (grid: string[][], along: number, across: number, ch: string) => void,
  ) => void;
}): DirectionalEffectSource {
  const { effectId, direction, frameCount, width, height, originPx, startAlongPx, axisLength, centerCrossPx, basePalette, addPalette, drawer } = options;
  const baseFrames: EffectFrameGrid[] = [];
  const addFrames: EffectFrameGrid[] = [];
  for (let i = 0; i < frameCount; i++) {
    const base = blank(width, height);
    const add = blank(width, height);
    const putPt = direction === 'west'
      ? (g: string[][], along: number, v: number, ch: string) => plotMax(g, startAlongPx - along, v, ch)
      : direction === 'south'
        ? (g: string[][], along: number, v: number, ch: string) => plotMax(g, v, startAlongPx + along, ch)
        : (g: string[][], along: number, v: number, ch: string) => plotMax(g, v, startAlongPx - along, ch);
    drawer(base, add, i, axisLength, centerCrossPx, putPt);
    baseFrames.push({ id: `${effectId}-${direction}-base-${i}`, rows: base.map(r => r.join('')) });
    addFrames.push({ id: `${effectId}-${direction}-add-${i}`, rows: add.map(r => r.join('')) });
  }
  return {
    effectId,
    direction,
    frameWidth: width,
    frameHeight: height,
    originX: originPx[0] / width,
    originY: originPx[1] / height,
    basePalette,
    addPalette,
    baseFrames,
    addFrames,
  };
}

// ===========================================================================
// 2. 普通攻击第一段：素银轻量短刺光（spear-basic-thrust，3 帧）
// ===========================================================================

function drawBasicThrustAxis(
  base: string[][],
  add: string[][],
  frameIndex: number,
  axisLength: number,
  centerV: number,
  putPt: (grid: string[][], along: number, across: number, ch: string) => void,
): void {
  if (frameIndex === 0) {
    // 锐利银白短刺尖
    const end = Math.round(axisLength * 0.72);
    for (let u = 2; u <= end; u++) {
      const f = (u - 2) / Math.max(1, end - 2);
      const halfW = f < 0.55 ? 0.6 + (f / 0.55) * 1.9 : 2.5 * (1 - (f - 0.55) / 0.45);
      for (let v = -Math.ceil(halfW); v <= Math.ceil(halfW); v++) {
        const av = Math.abs(v);
        if (av > halfW + 0.1) continue;
        if (av <= 0.6) { putPt(base, u, centerV + v, 'W'); putPt(add, u, centerV + v, 'W'); }
        else if (av <= halfW * 0.65) { putPt(base, u, centerV + v, 'C'); putPt(add, u, centerV + v, 'L'); }
        else { putPt(base, u, centerV + v, 'B'); }
      }
    }
    return;
  }
  if (frameIndex === 1) {
    // 峰值：细长锐利的素银破风刺线 + 极克制的小气环
    const end = axisLength - 1;
    for (let u = 4; u <= end; u++) {
      const f = (u - 4) / Math.max(1, end - 4);
      const halfW = f < 0.25 ? 0.5 + (f / 0.25) * 1.6 : f < 0.68 ? 2.1 + ((f - 0.25) / 0.43) * 0.9 : 3.0 * Math.pow(1 - (f - 0.68) / 0.32, 1.3);
      for (let v = -Math.ceil(halfW); v <= Math.ceil(halfW); v++) {
        const av = Math.abs(v);
        if (av > halfW + 0.1) continue;
        if (av <= 0.65 && f > 0.12) { putPt(base, u, centerV + v, 'W'); putPt(add, u, centerV + v, 'W'); }
        else if (av <= halfW * 0.6) { putPt(base, u, centerV + v, 'L'); putPt(add, u, centerV + v, 'C'); }
        else { putPt(base, u, centerV + v, 'B'); putPt(add, u, centerV + v, 'D'); }
      }
    }
    // 吞口一圈轻巧小气纹
    for (let v = -6; v <= 6; v++) {
      const norm = Math.abs(v) / 6;
      const ru = 14 - Math.round(norm * norm * 5);
      putPt(base, ru, centerV + v, norm < 0.5 ? 'L' : 'B');
      putPt(add, ru, centerV + v, norm < 0.5 ? 'W' : 'C');
    }
    // 两侧轻灵拉丝
    for (let u = 12; u <= end - 8; u++) {
      putPt(add, u, centerV - 4, u > end - 14 ? 'L' : 'B');
      putPt(add, u, centerV + 4, u > end - 14 ? 'L' : 'B');
    }
    return;
  }
  // Frame 2：迅速消散的 3 道银丝与 2 点微星
  for (const [s, e, v, ch] of [[16, axisLength - 2, 0, 'C'], [12, axisLength - 14, -3, 'B'], [14, axisLength - 12, 3, 'B']] as const) {
    for (let u = s; u <= e; u += 2) { putPt(base, u, centerV + v, 'D'); putPt(add, u, centerV + v, ch); }
  }
  plotSpark(base, add, axisLength - 6, centerV - 4, 'L', putPt, false);
  plotSpark(base, add, Math.round(axisLength * 0.55), centerV + 5, 'C', putPt, false);
}

// ===========================================================================
// 3. 普通攻击第二段：素银极薄小月牙拨光（spear-basic-flick，3 帧）
// ===========================================================================

function buildBasicFlick(direction: 'west' | 'south' | 'north'): DirectionalEffectSource {
  const baseFrames: EffectFrameGrid[] = [];
  const addFrames: EffectFrameGrid[] = [];
  // 极简紧凑的斜撩小月牙，厚度仅 2.2~3.0px，干净利落
  const cfg = direction === 'south'
    ? { w: 70, h: 48, ox: 35, oy: 20, cx: 35, cy: 16, rx: 28, ry: 18, arcs: [[155, 85, 2.2], [148, 22, 3.0], [95, 18, 1.6]] as const }
    : direction === 'west'
      ? { w: 58, h: 56, ox: 44, oy: 36, cx: 40, cy: 25, rx: 28, ry: 20, arcs: [[228, 165, 2.2], [220, 128, 3.0], [178, 125, 1.6]] as const }
      : { w: 70, h: 56, ox: 35, oy: 48, cx: 35, cy: 32, rx: 28, ry: 18, arcs: [[-20, -95, 2.2], [-28, -155, 3.0], [-85, -160, 1.6]] as const };

  for (let i = 0; i < 3; i++) {
    const base = blank(cfg.w, cfg.h);
    const add = blank(cfg.w, cfg.h);
    const [a0, a1, thick] = cfg.arcs[i];
    drawArcCurve(base, add, cfg.cx, cfg.cy, cfg.rx, cfg.ry, a0, a1, thick, i !== 2, 70);
    if (i === 1) {
      // 外缘补一条极细银丝增强撩枪锐度
      drawArcCurve(base, add, cfg.cx, cfg.cy, cfg.rx + 4, cfg.ry + 3, a0 + (a1 - a0) * 0.3, a1, 0.8, true, 50);
    }
    baseFrames.push({ id: `spear-basic-flick-${direction}-base-${i}`, rows: base.map(r => r.join('')) });
    addFrames.push({ id: `spear-basic-flick-${direction}-add-${i}`, rows: add.map(r => r.join('')) });
  }
  return {
    effectId: 'spear-basic-flick',
    direction,
    frameWidth: cfg.w,
    frameHeight: cfg.h,
    originX: cfg.ox / cfg.w,
    originY: cfg.oy / cfg.h,
    basePalette: SILVER_BASE_PALETTE,
    addPalette: SILVER_ADD_PALETTE,
    baseFrames,
    addFrames,
  };
}

// ===========================================================================
// 4. 狂龙穿心破：赤金炽白重刺破甲芒 + 向后喷射破甲气锥（spear-heavy-pierce，5 帧）
// ===========================================================================

function drawHeavyPierceAxis(
  base: string[][],
  add: string[][],
  frameIndex: number,
  axisLength: number,
  centerV: number,
  putPt: (grid: string[][], along: number, across: number, ch: string) => void,
): void {
  if (frameIndex === 0) {
    // 压缩赤金爆燃尖锥 + 枪锋十字爆闪
    const end = 34;
    for (let u = 2; u <= end; u++) {
      const f = (u - 2) / (end - 2);
      const halfW = f < 0.35 ? 1.5 + (f / 0.35) * 6.5 : 8.0 * Math.pow(1 - (f - 0.35) / 0.65, 1.1);
      for (let v = -Math.ceil(halfW); v <= Math.ceil(halfW); v++) {
        const av = Math.abs(v);
        if (av > halfW + 0.15) continue;
        const r = av / Math.max(0.5, halfW);
        if (r < 0.32) { putPt(base, u, centerV + v, 'W'); putPt(add, u, centerV + v, 'W'); }
        else if (r < 0.58) { putPt(base, u, centerV + v, 'L'); putPt(add, u, centerV + v, 'L'); }
        else if (r < 0.82) { putPt(base, u, centerV + v, 'C'); putPt(add, u, centerV + v, 'B'); }
        else { putPt(base, u, centerV + v, 'D'); }
      }
    }
    for (let s = -11; s <= 11; s++) {
      const c = Math.abs(s) <= 3 ? 'W' : Math.abs(s) <= 7 ? 'L' : 'C';
      putPt(base, 14, centerV + s, c);
      putPt(add, 14, centerV + s, c);
    }
    return;
  }

  if (frameIndex === 1 || frameIndex === 2) {
    const isPeak = frameIndex === 2;
    const start = 4;
    const end = isPeak ? axisLength - 1 : axisLength - 8;
    const maxW = isPeak ? 9.6 : 8.2;

    // 1. 短而极度凝实的重型赤金破甲钻头枪芒（头部厚重饱满、脊线炽白）
    for (let u = start; u <= end; u++) {
      const f = (u - start) / (end - start);
      let halfW: number;
      if (f < 0.18) halfW = 1.6 + (f / 0.18) * (maxW * 0.48);
      else if (f < 0.56) halfW = maxW * (0.64 + Math.sin(((f - 0.18) / 0.38) * Math.PI * 0.5) * 0.36);
      else halfW = maxW * Math.pow(1 - (f - 0.56) / 0.44, 1.25);

      for (let v = -Math.ceil(halfW); v <= Math.ceil(halfW); v++) {
        const av = Math.abs(v);
        if (av > halfW + 0.15) continue;
        const r = av / Math.max(0.5, halfW);
        if (av <= (isPeak ? 2.1 : 1.6) && f > 0.08 && f < 0.92) {
          putPt(base, u, centerV + v, 'W');
          putPt(add, u, centerV + v, 'W');
        } else if (r < 0.46) {
          putPt(base, u, centerV + v, 'L');
          putPt(add, u, centerV + v, 'L');
        } else if (r < 0.7) {
          putPt(base, u, centerV + v, 'C');
          putPt(add, u, centerV + v, 'C');
        } else if (r < 0.88) {
          putPt(base, u, centerV + v, 'B');
          putPt(add, u, centerV + v, 'B');
        } else {
          putPt(base, u, centerV + v, 'D');
          if ((u + v) % 2 === 0) putPt(add, u, centerV + v, 'd');
        }
      }
    }

    // 2. 向后喷射的破甲气锥（从枪锋后缘沿 V 字形猛烈向后喷射火焰激波！）
    const cones = isPeak
      ? [{ apex: 38, span: 16, backLen: 30, thick: 2.2 }, { apex: 22, span: 12, backLen: 20, thick: 1.5 }]
      : [{ apex: 30, span: 14, backLen: 24, thick: 2.0 }];
    for (const cone of cones) {
      for (let step = 0; step <= cone.backLen * 2; step++) {
        const f = step / (cone.backLen * 2);
        const u = cone.apex - f * cone.backLen;
        const spread = 2.5 + Math.pow(f, 0.85) * cone.span;
        for (const sign of [-1, 1]) {
          for (let t = -cone.thick * 0.5; t <= cone.thick * 0.5; t += 0.5) {
            const v = centerV + sign * (spread + t);
            const ch = f < 0.35 ? 'W' : f < 0.65 ? 'L' : f < 0.85 ? 'C' : 'B';
            putPt(base, u, v, f > 0.78 ? 'D' : ch);
            putPt(add, u, v, ch);
          }
        }
      }
    }

    // 3. 锋尖破甲十字爆闪 + 烈焰金火星
    const tipU = Math.round(start + (end - start) * 0.76);
    const starR = isPeak ? 11 : 7;
    for (let s = -starR; s <= starR; s++) {
      const ch = Math.abs(s) <= 3 ? 'W' : Math.abs(s) <= 7 ? 'L' : 'C';
      putPt(add, tipU, centerV + s, ch);
      if (Math.abs(s) <= 6) putPt(base, tipU, centerV + s, ch);
    }
    const sparks: [number, number, string, boolean][] = isPeak
      ? [[12, -14, 'g', true], [18, 15, 'C', false], [32, -15, 'L', true], [44, 14, 'g', false], [end - 8, -9, 'W', true], [end - 6, 9, 'g', false]]
      : [[14, -12, 'g', false], [28, 12, 'L', true], [44, -9, 'W', false]];
    for (const [su, sv, ch, big] of sparks) plotSpark(base, add, su, centerV + sv, ch, putPt, big);
    return;
  }

  if (frameIndex === 3) {
    // 气锥大幅后爆扩散 + 核心收细拉火线
    const start = 14;
    const end = axisLength - 1;
    for (let u = start; u <= end; u++) {
      const f = (u - start) / (end - start);
      const halfW = f < 0.3 ? 1 + (f / 0.3) * 3.5 : 4.5 * Math.pow(1 - (f - 0.3) / 0.7, 1.2);
      for (let v = -Math.ceil(halfW); v <= Math.ceil(halfW); v++) {
        const av = Math.abs(v);
        if (av > halfW) continue;
        if (av <= 1.0) { putPt(base, u, centerV + v, 'L'); putPt(add, u, centerV + v, 'W'); }
        else if (av <= halfW * 0.6) { putPt(base, u, centerV + v, 'C'); putPt(add, u, centerV + v, 'C'); }
        else if ((u + v) % 2 === 0) { putPt(base, u, centerV + v, 'B'); putPt(add, u, centerV + v, 'D'); }
      }
    }
    // 断裂扩散的 V 形破甲火气
    for (let f = 0.25; f <= 1; f += 0.04) {
      const u = 36 - f * 32;
      const spread = 4 + f * 16;
      for (const sign of [-1, 1]) {
        putPt(base, u, centerV + sign * spread, f > 0.7 ? 'D' : 'B');
        putPt(add, u, centerV + sign * spread, f > 0.7 ? 'B' : 'C');
      }
    }
    plotSpark(base, add, 16, centerV - 15, 'C', putPt, false);
    plotSpark(base, add, 30, centerV + 16, 'g', putPt, true);
    plotSpark(base, add, 50, centerV - 11, 'W', putPt, true);
    plotSpark(base, add, end - 5, centerV + 7, 'g', putPt, false);
    return;
  }

  // Frame 4：炽红金星散落
  for (const [su, sv, ch, big] of [
    [14, -14, 'B', false], [26, 13, 'C', false], [40, -10, 'g', true], [52, 8, 'L', false], [axisLength - 6, -3, 'W', true],
  ] as const) {
    plotSpark(base, add, su, centerV + sv, ch, putPt, big);
  }
}

// ===========================================================================
// 5. 伏龙震（力劈华山）：暗金/土黄纵向重劈下砸弧光 + 地面震裂环（spear-slam-arc，4 帧）
// ===========================================================================

function drawGroundShockRing(
  base: string[][],
  add: string[][],
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  thick: number,
  broken: boolean,
): void {
  const steps = 84;
  for (let i = 0; i < steps; i++) {
    if (broken && (i % 7 === 0 || i % 7 === 1)) continue;
    const rad = (i / steps) * Math.PI * 2;
    const ca = Math.cos(rad);
    const sa = Math.sin(rad);
    for (let o = -thick; o <= thick; o += 0.5) {
      const px = cx + (rx + o) * ca;
      const py = cy + (ry + o * 0.65) * sa;
      const norm = Math.abs(o) / Math.max(0.5, thick);
      if (norm < 0.35 && !broken) { plotMax(base, px, py, 'W'); plotMax(add, px, py, 'L'); }
      else if (norm < 0.68) { plotMax(base, px, py, 'C'); plotMax(add, px, py, 'C'); }
      else { plotMax(base, px, py, 'D'); plotMax(add, px, py, 'B'); }
    }
  }
}

function drawVerticalCleaver(
  base: string[][],
  add: string[][],
  x: number,
  yTop: number,
  yBot: number,
  maxHalfW: number,
): void {
  for (let y = yTop; y <= yBot; y++) {
    const f = (y - yTop) / Math.max(1, yBot - yTop);
    const halfW = f < 0.72 ? 0.8 + Math.sin((f / 0.72) * Math.PI * 0.5) * maxHalfW : maxHalfW * (1 - (f - 0.72) / 0.28);
    for (let dx = -Math.ceil(halfW); dx <= Math.ceil(halfW); dx++) {
      const adx = Math.abs(dx);
      if (adx > halfW + 0.1) continue;
      const r = adx / Math.max(0.5, halfW);
      if (adx <= 1.2 && f > 0.25) { plotMax(base, x + dx, y, 'W'); plotMax(add, x + dx, y, 'W'); }
      else if (r < 0.48) { plotMax(base, x + dx, y, 'L'); plotMax(add, x + dx, y, 'L'); }
      else if (r < 0.76) { plotMax(base, x + dx, y, 'C'); plotMax(add, x + dx, y, 'B'); }
      else { plotMax(base, x + dx, y, 'D'); }
    }
  }
}

function buildSlamArc(direction: 'west' | 'south' | 'north'): DirectionalEffectSource {
  const baseFrames: EffectFrameGrid[] = [];
  const addFrames: EffectFrameGrid[] = [];

  if (direction === 'west') {
    // 92×92，角色脚底 (0,0) 在 (68, 72)，落地点在 (-28, +2) -> 像素 (40, 74)
    const w = 92;
    const h = 92;
    const ox = 68;
    const oy = 72;
    const impX = 36;
    const impY = 72;
    for (let i = 0; i < 4; i++) {
      const base = blank(w, h);
      const add = blank(w, h);
      if (i === 0) {
        // 过顶高速下劈弧（从头顶正上方 -92° 猛劈至正西下方 -185°）
        drawArcCurve(base, add, 66, 62, 42, 46, -88, -172, 4.4, true, 96);
        drawArcCurve(base, add, 66, 62, 34, 38, -96, -168, 1.8, false, 64);
      } else if (i === 1) {
        // 砸地峰值！纵向重劈大弧砸穿地面 + 地面金土冲击椭圆环 + 飞溅碎石星芒
        drawArcCurve(base, add, 66, 62, 42, 46, -108, -196, 5.2, true, 96);
        drawGroundShockRing(base, add, impX, impY, 22, 9, 2.2, false);
        // 砸击点冲天金柱爆裂
        for (let s = -12; s <= 12; s++) {
          plotMax(add, impX + s, impY, Math.abs(s) <= 4 ? 'W' : 'L');
          plotMax(base, impX + s, impY, Math.abs(s) <= 4 ? 'W' : 'C');
        }
        for (let dy = -16; dy <= 4; dy++) {
          const c = dy > -6 ? 'W' : dy > -12 ? 'L' : 'C';
          plotMax(add, impX, impY + dy, c);
          plotMax(base, impX, impY + dy, c);
        }
        for (const [sx, sy, big] of [[impX - 18, impY - 12, true], [impX + 16, impY - 10, false], [impX - 10, impY - 22, true], [impX + 8, impY - 18, false]] as const) {
          plotSpark(base, add, sx, sy, 'g', plotMax, big);
        }
      } else if (i === 2) {
        // 冲击波大幅外扩 + 余弧消散 + 碎岩高溅
        drawArcCurve(base, add, 66, 62, 43, 47, -145, -195, 2.0, false, 56);
        drawGroundShockRing(base, add, impX, impY, 31, 13, 1.8, true);
        for (const [sx, sy, big] of [[impX - 26, impY - 14, true], [impX + 24, impY - 12, false], [impX - 14, impY - 26, false], [impX + 12, impY - 22, true], [impX - 4, impY - 16, false]] as const) {
          plotSpark(base, add, sx, sy, 'g', plotMax, big);
        }
      } else {
        // 末段碎石金尘沉降
        drawGroundShockRing(base, add, impX, impY, 35, 14, 1.0, true);
        for (const [sx, sy] of [[impX - 28, impY - 8], [impX + 25, impY - 6], [impX - 12, impY - 20], [impX + 10, impY - 16]] as const) {
          plotSpark(base, add, sx, sy, 'C', plotMax, false);
        }
      }
      baseFrames.push({ id: `spear-slam-arc-west-base-${i}`, rows: base.map(r => r.join('')) });
      addFrames.push({ id: `spear-slam-arc-west-add-${i}`, rows: add.map(r => r.join('')) });
    }
    return {
      effectId: 'spear-slam-arc',
      direction,
      frameWidth: w,
      frameHeight: h,
      originX: ox / w,
      originY: oy / h,
      basePalette: SLAM_BASE_PALETTE,
      addPalette: SLAM_ADD_PALETTE,
      baseFrames,
      addFrames,
    };
  }

  // 南向 / 北向：82×96 纵向正中力劈 + 落点地面震波环
  const w = 82;
  const h = 96;
  const isSouth = direction === 'south';
  const ox = 41;
  const oy = isSouth ? 56 : 78;
  const impX = 41;
  const impY = isSouth ? 76 : 44;

  for (let i = 0; i < 4; i++) {
    const base = blank(w, h);
    const add = blank(w, h);
    if (i === 0) {
      // 从头顶高空竖直劈落
      drawVerticalCleaver(base, add, impX, isSouth ? 8 : 6, impY - 4, 4.6);
      drawArcCurve(base, add, impX, impY - 24, 14, 24, -120, -60, 2.0, true, 40);
    } else if (i === 1) {
      // 砸地峰值：粗重暗金劈光砸进地面 + 宽椭圆震裂冲击环 + 冲天裂纹与碎石
      drawVerticalCleaver(base, add, impX, isSouth ? 16 : 8, impY + 2, 5.4);
      drawGroundShockRing(base, add, impX, impY, 26, 11, 2.3, false);
      for (let s = -15; s <= 15; s++) {
        plotMax(add, impX + s, impY, Math.abs(s) <= 5 ? 'W' : 'L');
        plotMax(base, impX + s, impY, Math.abs(s) <= 5 ? 'W' : 'C');
      }
      for (const [sx, sy, big] of [[impX - 20, impY - 12, true], [impX + 20, impY - 11, true], [impX - 11, impY - 22, false], [impX + 12, impY - 20, false]] as const) {
        plotSpark(base, add, sx, sy, 'g', plotMax, big);
      }
    } else if (i === 2) {
      drawVerticalCleaver(base, add, impX, impY - 24, impY, 2.0);
      drawGroundShockRing(base, add, impX, impY, 34, 14, 1.8, true);
      for (const [sx, sy, big] of [[impX - 28, impY - 12, true], [impX + 28, impY - 10, false], [impX - 16, impY - 24, false], [impX + 16, impY - 22, true]] as const) {
        plotSpark(base, add, sx, sy, 'g', plotMax, big);
      }
    } else {
      drawGroundShockRing(base, add, impX, impY, 37, 15, 1.0, true);
      for (const [sx, sy] of [[impX - 30, impY - 6], [impX + 30, impY - 6], [impX - 12, impY - 18], [impX + 14, impY - 16]] as const) {
        plotSpark(base, add, sx, sy, 'C', plotMax, false);
      }
    }
    baseFrames.push({ id: `spear-slam-arc-${direction}-base-${i}`, rows: base.map(r => r.join('')) });
    addFrames.push({ id: `spear-slam-arc-${direction}-add-${i}`, rows: add.map(r => r.join('')) });
  }
  return {
    effectId: 'spear-slam-arc',
    direction,
    frameWidth: w,
    frameHeight: h,
    originX: ox / w,
    originY: oy / h,
    basePalette: SLAM_BASE_PALETTE,
    addPalette: SLAM_ADD_PALETTE,
    baseFrames,
    addFrames,
  };
}

// ===========================================================================
// 汇总第一批所有原创特效源（export.ts 自动打包到 spear-effects.png）
// ===========================================================================

export const SPEAR_EFFECT_SOURCES: readonly DirectionalEffectSource[] = [
  // 1. 蓝青直刺枪芒（破阵枪 / 基础直刺）
  buildDirectionalLinearEffect({
    effectId: 'spear-thrust-beam', direction: 'west', frameCount: 6,
    width: 110, height: 36, originPx: [98, 29], startAlongPx: 86, axisLength: 84, centerCrossPx: 18,
    basePalette: BEAM_BASE_PALETTE, addPalette: BEAM_ADD_PALETTE, drawer: drawLanceAxis,
  }),
  buildDirectionalLinearEffect({
    effectId: 'spear-thrust-beam', direction: 'south', frameCount: 6,
    width: 36, height: 108, originPx: [21, 8], startAlongPx: 20, axisLength: 84, centerCrossPx: 18,
    basePalette: BEAM_BASE_PALETTE, addPalette: BEAM_ADD_PALETTE, drawer: drawLanceAxis,
  }),
  buildDirectionalLinearEffect({
    effectId: 'spear-thrust-beam', direction: 'north', frameCount: 6,
    width: 36, height: 114, originPx: [18, 110], startAlongPx: 80, axisLength: 78, centerCrossPx: 18,
    basePalette: BEAM_BASE_PALETTE, addPalette: BEAM_ADD_PALETTE, drawer: drawLanceAxis,
  }),

  // 2. 普通攻击第一段 · 素银轻刺破风线（3 帧，轻锐短促）
  buildDirectionalLinearEffect({
    effectId: 'spear-basic-thrust', direction: 'west', frameCount: 3,
    width: 72, height: 22, originPx: [62, 22], startAlongPx: 50, axisLength: 48, centerCrossPx: 11,
    basePalette: SILVER_BASE_PALETTE, addPalette: SILVER_ADD_PALETTE, drawer: drawBasicThrustAxis,
  }),
  buildDirectionalLinearEffect({
    effectId: 'spear-basic-thrust', direction: 'south', frameCount: 3,
    width: 22, height: 70, originPx: [14, 8], startAlongPx: 20, axisLength: 48, centerCrossPx: 11,
    basePalette: SILVER_BASE_PALETTE, addPalette: SILVER_ADD_PALETTE, drawer: drawBasicThrustAxis,
  }),
  buildDirectionalLinearEffect({
    effectId: 'spear-basic-thrust', direction: 'north', frameCount: 3,
    width: 22, height: 80, originPx: [11, 78], startAlongPx: 50, axisLength: 48, centerCrossPx: 11,
    basePalette: SILVER_BASE_PALETTE, addPalette: SILVER_ADD_PALETTE, drawer: drawBasicThrustAxis,
  }),

  // 3. 普通攻击第二段 · 素银极薄小月牙拨光（3 帧）
  buildBasicFlick('west'),
  buildBasicFlick('south'),
  buildBasicFlick('north'),

  // 4. 狂龙穿心破 · 赤金炽白重刺破甲芒（5 帧，对齐 +10px 前探身位）
  buildDirectionalLinearEffect({
    effectId: 'spear-heavy-pierce', direction: 'west', frameCount: 5,
    width: 104, height: 42, originPx: [96, 32], startAlongPx: 74, axisLength: 68, centerCrossPx: 21,
    basePalette: HEAVY_BASE_PALETTE, addPalette: HEAVY_ADD_PALETTE, drawer: drawHeavyPierceAxis,
  }),
  buildDirectionalLinearEffect({
    effectId: 'spear-heavy-pierce', direction: 'south', frameCount: 5,
    width: 42, height: 102, originPx: [24, 6], startAlongPx: 25, axisLength: 70, centerCrossPx: 21,
    basePalette: HEAVY_BASE_PALETTE, addPalette: HEAVY_ADD_PALETTE, drawer: drawHeavyPierceAxis,
  }),
  buildDirectionalLinearEffect({
    effectId: 'spear-heavy-pierce', direction: 'north', frameCount: 5,
    width: 42, height: 110, originPx: [21, 108], startAlongPx: 70, axisLength: 66, centerCrossPx: 21,
    basePalette: HEAVY_BASE_PALETTE, addPalette: HEAVY_ADD_PALETTE, drawer: drawHeavyPierceAxis,
  }),

  // 5. 伏龙震（力劈华山）· 暗金土黄纵向重劈下砸弧光 + 地面震裂环（4 帧）
  buildSlamArc('west'),
  buildSlamArc('south'),
  buildSlamArc('north'),
];

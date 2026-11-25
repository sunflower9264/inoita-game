/**
 * 长枪样板原创像素特效源数据（全部逐格像素网格 + 量化色板，代码导出透明 PNG）。
 *
 * 全套包含 12 套原创像素特效（全部采用 normal 底光 + add 炽核双层，适配深色/游戏/浅色画布）：
 * 第一批：
 * 1. spear-thrust-beam   （6 帧）：基础直刺的蓝青柳叶贯通枪芒
 * 2. spear-basic-thrust  （3 帧）：普通攻击第一段 · 素银轻刺破风线
 * 3. spear-basic-flick   （3 帧）：普通攻击第二段 · 素银极薄小月牙拨光
 * 4. spear-heavy-pierce  （5 帧）：狂龙穿心破 · 赤金炽白重刺破甲芒（带向后喷射破甲气锥）
 * 5. spear-slam-arc      （4 帧）：伏龙震 · 暗金土黄纵向重劈弧光 + 地面震裂冲击环
 * 第二批：
 * 6. spear-flower-spin   （6 帧）：虬龙扫暴阵前半段 · 真 3D 俯视投影左右双侧枪花（/ 🧍 \，近粗亮远细暗 + 红缨纵深流光）
 * 7. spear-gale-sweep    （6 帧）：虬龙扫暴阵主体 · 四向 180° 青白月牙狂风横扫枪芒
 * 8. spear-flurry-needles（8 帧）：连环点枪前两段 · 暴雨梨花奇偶交替扇形针芒幻影（带红缨残影）
 * 9. spear-flurry-finisher（4 帧）：连环点枪第三段 · 炽青加粗定音主刺芒 + 十字爆闪
 * 10. spear-sovereign-beam（7 帧）：万圣龙王破 · 同源 1.6 倍加长蓝青柳叶枪芒 + 双层青金螺旋气浪
 * 11. spear-spin-storm   （14 帧）：旋风枪舞 · 360° 俯视椭圆冷钢青白刃环 + 飞舞朱红红缨流光 + 末圈气浪爆散
 * 12. spear-basic-lift   （3 帧）：普通攻击第三段 · 素银由下而上轻量上挑弧光（无控制）
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
  '.': 0, d: 1, D: 2, r: 2, B: 3, R: 4, C: 4, P: 5, L: 5, g: 6, W: 7,
};

/** 5. 枪花/暴雨梨花带红缨残影的银青色板 */
export const FLOWER_BASE_PALETTE: RgbaPalette = {
  ...SILVER_BASE_PALETTE,
  r: [0x8c, 0x1a, 0x1a, 185], // 红缨暗影
  R: [0xd6, 0x32, 0x2a, 230], // 甩动红缨正红
  P: [0xff, 0x7a, 0x62, 245], // 红缨亮丝
};

export const FLOWER_ADD_PALETTE: RgbaPalette = {
  ...SILVER_ADD_PALETTE,
  r: [0xb4, 0x26, 0x20, 120],
  R: [0xf0, 0x48, 0x3a, 185],
  P: [0xff, 0x9c, 0x82, 225],
};

/** 6. 虬龙扫暴阵：青白狂风气浪色板 */
export const GALE_BASE_PALETTE: RgbaPalette = {
  '.': [0, 0, 0, 0],
  d: [0x0f, 0x46, 0x70, 130],
  D: [0x1b, 0x74, 0xad, 198],
  B: [0x3c, 0xb4, 0xe8, 228],
  C: [0x88, 0xe8, 0xff, 242],
  L: [0xd4, 0xf8, 0xff, 248],
  W: [0xf6, 0xfd, 0xff, 255],
  g: [0xc8, 0xff, 0xf2, 230],
};

export const GALE_ADD_PALETTE: RgbaPalette = {
  '.': [0, 0, 0, 0],
  d: [0x1a, 0x64, 0x9c, 90],
  D: [0x30, 0x9c, 0xd8, 150],
  B: [0x60, 0xd4, 0xff, 200],
  C: [0xb0, 0xf2, 0xff, 232],
  L: [0xe6, 0xfc, 0xff, 246],
  W: [0xff, 0xff, 0xff, 255],
  g: [0xe0, 0xff, 0xf8, 240],
};

/** 7. 暴雨梨花（连环点枪）：冰青银芒 + 红缨幻影色板 */
export const FLURRY_BASE_PALETTE: RgbaPalette = {
  ...BEAM_BASE_PALETTE,
  r: [0x8c, 0x1a, 0x1a, 180],
  R: [0xdc, 0x34, 0x2c, 225],
  P: [0xff, 0x84, 0x6a, 240],
};

export const FLURRY_ADD_PALETTE: RgbaPalette = {
  ...BEAM_ADD_PALETTE,
  r: [0xb0, 0x26, 0x20, 115],
  R: [0xf2, 0x4c, 0x3e, 180],
  P: [0xff, 0xa2, 0x86, 220],
};

/** 8. 旋风枪舞（360° 旋枪风暴）：锐利银青冷钢刃弧 + 醒目朱红红缨流光 + 淡金火星 */
export const SPIN_BASE_PALETTE: RgbaPalette = {
  '.': [0, 0, 0, 0],
  d: [0x12, 0x3a, 0x6e, 128], // 深冷青风尾
  D: [0x22, 0x66, 0xb2, 196], // 冷青暗刃
  B: [0x4c, 0xa8, 0xe8, 226], // 苍青风弧
  C: [0x96, 0xe4, 0xff, 242], // 银青主光
  L: [0xd8, 0xf6, 0xff, 248], // 炽银亮锋
  W: [0xf8, 0xfe, 0xff, 255], // 纯白尖锋
  g: [0xff, 0xdf, 0x82, 232], // 破风金火星
  r: [0x8c, 0x16, 0x14, 190], // 红缨暗红拖尾
  R: [0xdf, 0x2f, 0x26, 236], // 红缨正朱红
  P: [0xff, 0x82, 0x64, 248], // 红缨高光丝
};

export const SPIN_ADD_PALETTE: RgbaPalette = {
  '.': [0, 0, 0, 0],
  d: [0x1c, 0x56, 0xa2, 86],
  D: [0x38, 0x90, 0xdc, 148],
  B: [0x70, 0xca, 0xff, 198],
  C: [0xb8, 0xf0, 0xff, 232],
  L: [0xe8, 0xfb, 0xff, 246],
  W: [0xff, 0xff, 0xff, 255],
  g: [0xff, 0xf0, 0xb2, 244],
  r: [0xb4, 0x22, 0x1c, 125],
  R: [0xf6, 0x48, 0x38, 192],
  P: [0xff, 0xa6, 0x88, 230],
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
// 6. 虬龙扫暴阵前半段：真 3D 俯视投影左右双侧枪花（spear-flower-spin，6 帧，/ 🧍 \）
// ===========================================================================

function projectFlower3D(x: number, y: number, z: number): { sx: number; sy: number; depth: number } {
  // 模拟艾诺迪亚 4 约 32°~35° 俯视镜头：位于 (0, +82, +132) 望向角色腰胸 (0, 0, 0)
  const camY = 82;
  const camZ = 132;
  const fov = 152;
  const invLen = 1 / Math.hypot(camY, camZ);
  const fy = -camY * invLen;
  const fz = -camZ * invLen;
  const uy = -fz;
  const uz = fy;
  const ry = y - camY;
  const rz = z - camZ;
  const depth = ry * fy + rz * fz;
  const camU = ry * uy + rz * uz;
  const scale = fov / Math.max(30, depth);
  return { sx: x * scale, sy: -camU * scale, depth };
}

function drawDisc(grid: string[][], x: number, y: number, radius: number, ch: string, overwrite = false): void {
  const h = grid.length;
  const w = grid[0].length;
  const r = Math.ceil(radius);
  const r2 = radius * radius;
  const cx = Math.round(x);
  const cy = Math.round(y);
  for (let dy = -r; dy <= r; dy++) {
    const gy = cy + dy;
    if (gy < 0 || gy >= h) continue;
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r2 + 0.15) continue;
      const gx = cx + dx;
      if (gx < 0 || gx >= w) continue;
      if (overwrite) grid[gy][gx] = ch;
      else plotMax(grid, gx, gy, ch);
    }
  }
}

function draw3DSideFlowerWheel(
  base: string[][],
  add: string[][],
  cx: number,
  cy: number,
  sideX: number,
  radius: number,
  rotDeg: number,
  isSpearHead: boolean,
  isHit: boolean,
  isFade: boolean,
  frameIdx: number,
): void {
  // 真实 3D 垂直圆环（位于 Y-Z 平面 X = sideX，近镜前缘微微外展形成自然 / 🧍 \ 俯视透视）
  const coneFlare = sideX < 0 ? 3.2 : -3.2;
  const steps = 260;
  const mainSpan = isFade ? 86 : isHit ? 162 : 142;
  const subSpan = isFade ? 68 : isHit ? 124 : 104;
  const tasselSpan = isFade ? 58 : isHit ? 116 : 98;

  type Sample = {
    depth: number;
    sx: number;
    sy: number;
    qx: number;
    qy: number;
    rel: number;
  };
  const samples: Sample[] = [];
  for (let s = 0; s < steps; s++) {
    const deg = (s / steps) * 360;
    const rad = (deg * Math.PI) / 180;
    const sinR = Math.sin(rad);
    const cosR = Math.cos(rad);
    const p = projectFlower3D(sideX + coneFlare * cosR, radius * sinR, radius * cosR);
    const flutter = Math.sin((deg * Math.PI) / 60 + frameIdx * 1.4) * 0.9;
    const q = projectFlower3D(
      sideX + coneFlare * cosR * 0.85,
      (radius * 0.84 + flutter) * sinR,
      (radius * 0.84 + flutter) * cosR,
    );
    const rel = (((rotDeg - deg) % 360) + 360) % 360;
    samples.push({ depth: p.depth, sx: cx + p.sx, sy: cy + p.sy, qx: cx + q.sx, qy: cy + q.sy, rel });
  }

  // 严格按深度由远及近排序绘制（远后半环退暗、近前半环高亮清晰盖在前方！）
  samples.sort((a, b) => b.depth - a.depth);
  const dMin = 128;
  const dMax = 178;

  for (const sp of samples) {
    const ff = Math.max(0, Math.min(1, (dMax - sp.depth) / (dMax - dMin))); // 0 = 远景后弧，1 = 近景前弧
    const inMain = sp.rel < mainSpan;
    const inSub = sp.rel >= 180 && sp.rel < 180 + subSpan;
    if (inMain || inSub) {
      const span = inMain ? mainSpan : subSpan;
      const local = inMain ? sp.rel : sp.rel - 180;
      const taper = Math.sin((1 - local / span) * Math.PI);
      const thick = (isFade ? 0.45 : 0.55) + (isFade ? 0.65 : (inMain ? 1.55 : 1.05)) * ff * (0.45 + 0.75 * taper);

      // 近景粗亮炽白/亮银，远景细暗冷蓝退远，一眼看出 3D 纵深！
      let baseCh: string;
      let addCh: string | null;
      if (inMain) {
        if (ff > 0.56) { baseCh = taper > 0.4 ? 'W' : 'L'; addCh = 'W'; }
        else if (ff > 0.30) { baseCh = 'C'; addCh = 'L'; }
        else { baseCh = 'B'; addCh = 'D'; }
      } else {
        if (ff > 0.56) { baseCh = 'C'; addCh = 'C'; }
        else if (ff > 0.30) { baseCh = 'B'; addCh = 'D'; }
        else { baseCh = 'D'; addCh = null; }
      }

      // 外边冷暗描边 + 亮心双笔触
      if (thick > 1.15 && ff > 0.4) {
        drawDisc(base, sp.sx, sp.sy, thick, inMain ? 'C' : 'B', false);
        drawDisc(base, sp.sx, sp.sy, Math.max(0.5, thick * 0.52), baseCh, ff > 0.55);
      } else {
        drawDisc(base, sp.sx, sp.sy, thick * 0.85, baseCh, ff > 0.65);
      }
      if (addCh) drawDisc(add, sp.sx, sp.sy, Math.max(0.45, thick * 0.62), addCh, false);
    }

    // 枪尖侧：随 3D 圆环前后明暗变化的醒目朱红红缨流光带！
    if (isSpearHead && sp.rel < tasselSpan) {
      const tf = 1 - sp.rel / tasselSpan;
      const taper = Math.sin(Math.pow(tf, 0.72) * Math.PI);
      const rThick = (isFade ? 0.4 : 0.45) + 1.15 * ff * taper;
      const rCh = ff > 0.52 && tf > 0.38 ? 'P' : ff > 0.30 ? 'R' : 'r';
      drawDisc(base, sp.qx, sp.qy, rThick, rCh, ff > 0.48);
      if (ff > 0.35) drawDisc(add, sp.qx, sp.qy, Math.max(0.45, rThick * 0.75), rCh, false);
    }
  }

  // F2 / F4 命中帧：在最靠前外缘（z = +radius 处）爆出左右双侧横向打击火星与外切亮锋
  if (isHit) {
    const frontMid = projectFlower3D(sideX + coneFlare * 1.15, 0, radius + 3);
    const frontHi = projectFlower3D(sideX + coneFlare, radius * 0.58, radius * 0.82);
    const frontLo = projectFlower3D(sideX + coneFlare, -radius * 0.58, radius * 0.82);
    plotSpark(base, add, cx + frontMid.sx, cy + frontMid.sy, isSpearHead ? 'W' : 'g', plotMax, true);
    plotSpark(base, add, cx + frontHi.sx, cy + frontHi.sy, 'L', plotMax, false);
    plotSpark(base, add, cx + frontLo.sx, cy + frontLo.sy, isSpearHead ? 'g' : 'C', plotMax, false);
  }

  // 旋转领先尖端高光点（位于前侧时放大闪烁，位于远后侧时微弱）
  const leadRad = (rotDeg * Math.PI) / 180;
  const leadP = projectFlower3D(sideX + coneFlare * Math.cos(leadRad), radius * Math.sin(leadRad), radius * Math.cos(leadRad));
  const leadFront = leadP.depth < 152;
  plotSpark(base, add, cx + leadP.sx, cy + leadP.sy, isSpearHead ? 'W' : 'g', plotMax, !isFade && leadFront);
}

function buildFlowerSpin(direction: 'west' | 'south' | 'north'): DirectionalEffectSource {
  // 112×98：角色脚底 (0,0) 在 (56, 60)，3D 旋转中心落在腰胸 (56, 46)（y = -14）
  const w = 112;
  const h = 98;
  const ox = 56;
  const oy = 60;
  const cx = 56;
  const cy = 46;
  const baseFrames: EffectFrameGrid[] = [];
  const addFrames: EffectFrameGrid[] = [];
  const scales = [0.86, 0.98, 1.04, 1.00, 1.06, 1.10];

  for (let i = 0; i < 6; i++) {
    const base = blank(w, h);
    const add = blank(w, h);
    const radius = 28.0 * scales[i];
    const isHit = i === 2 || i === 4;
    const isFade = i === 5;
    // F0..F2 枪尖红缨在左、枪尾冷银在右；F3..F5 翻腕互换（枪尖在右、枪尾在左）
    const headOnLeft = i <= 2;
    const leftRot = -50 + i * 95;
    const rightRot = 130 + i * 95; // 与左侧反相上下交替运动

    // 左侧 3D 透视枪花轮（/ 倾角）
    draw3DSideFlowerWheel(base, add, cx, cy, -30.0, radius, leftRot, headOnLeft, isHit, isFade, i);
    // 右侧 3D 透视枪花轮（\ 倾角）
    draw3DSideFlowerWheel(base, add, cx, cy, +30.0, radius, rightRot, !headOnLeft, isHit, isFade, i);

    baseFrames.push({ id: `spear-flower-spin-${direction}-base-${i}`, rows: base.map(r => r.join('')) });
    addFrames.push({ id: `spear-flower-spin-${direction}-add-${i}`, rows: add.map(r => r.join('')) });
  }

  return {
    effectId: 'spear-flower-spin',
    direction,
    frameWidth: w,
    frameHeight: h,
    originX: ox / w,
    originY: oy / h,
    basePalette: FLOWER_BASE_PALETTE,
    addPalette: FLOWER_ADD_PALETTE,
    baseFrames,
    addFrames,
  };
}

// ===========================================================================
// 7. 虬龙扫暴阵主体：四向 180° 青白月牙狂风枪芒（spear-gale-sweep，6 帧）
// ===========================================================================

function buildGaleSweep(direction: 'west' | 'south' | 'north'): DirectionalEffectSource {
  const baseFrames: EffectFrameGrid[] = [];
  const addFrames: EffectFrameGrid[] = [];

  // 四向 180° 水平俯视椭圆统一口径（rx=50, ry=32，弧心严格对齐腰胸 y=-12）：
  // 每向峰值帧（f2）精确对称于各自正方向（南 +90° / 西 -180° / 北 -90° / 东 0°），杜绝西/东向下垂偏斜与南/北左右偏心
  const cfg = direction === 'south'
    ? {
        w: 144, h: 76, ox: 72, oy: 24, cx: 72, cy: 12, rx: 50, ry: 32,
        // 南向：从正西(180°)水平横扫过正南(+90°)到正东(0°)
        frames: [
          { a0: 180, a1: 110, thick: 4.6, rAdd: 0, gusts: 1 },
          { a0: 178, a1: 30, thick: 7.4, rAdd: 2, gusts: 2 },
          { a0: 175, a1: 5, thick: 8.0, rAdd: 5, gusts: 3 },
          { a0: 145, a1: 0, thick: 4.6, rAdd: 8, gusts: 2 },
          { a0: 100, a1: 0, thick: 2.2, rAdd: 10, gusts: 1 },
          { a0: 55, a1: 0, thick: 1.0, rAdd: 11, gusts: 0 },
        ],
      }
    : direction === 'west'
      ? {
          w: 104, h: 104, ox: 86, oy: 64, cx: 82, cy: 52, rx: 50, ry: 32,
          // 西向（东向自动镜像）：从正北(-90°)水平横扫过正西(-180°)到正南(-270°)
          frames: [
            { a0: -90, a1: -160, thick: 4.6, rAdd: 0, gusts: 1 },
            { a0: -92, a1: -240, thick: 7.4, rAdd: 2, gusts: 2 },
            { a0: -95, a1: -265, thick: 8.0, rAdd: 5, gusts: 3 },
            { a0: -125, a1: -270, thick: 4.6, rAdd: 8, gusts: 2 },
            { a0: -170, a1: -270, thick: 2.2, rAdd: 10, gusts: 1 },
            { a0: -215, a1: -270, thick: 1.0, rAdd: 11, gusts: 0 },
          ],
        }
      : {
          w: 144, h: 76, ox: 72, oy: 64, cx: 72, cy: 52, rx: 50, ry: 32,
          // 北向：从正东(0°)水平横扫过正北(-90°)到正西(-180°)
          frames: [
            { a0: 0, a1: -70, thick: 4.6, rAdd: 0, gusts: 1 },
            { a0: -2, a1: -150, thick: 7.4, rAdd: 2, gusts: 2 },
            { a0: -5, a1: -175, thick: 8.0, rAdd: 5, gusts: 3 },
            { a0: -35, a1: -180, thick: 4.6, rAdd: 8, gusts: 2 },
            { a0: -80, a1: -180, thick: 2.2, rAdd: 10, gusts: 1 },
            { a0: -125, a1: -180, thick: 1.0, rAdd: 11, gusts: 0 },
          ],
        };

  for (let i = 0; i < 6; i++) {
    const base = blank(cfg.w, cfg.h);
    const add = blank(cfg.w, cfg.h);
    const f = cfg.frames[i];
    const rx = cfg.rx + f.rAdd;
    const ry = cfg.ry + Math.round(f.rAdd * 0.72);

    // 主半圈狂风月牙刃（高密度平滑采样消除径向断纹）
    drawArcCurve(base, add, cfg.cx, cfg.cy, rx, ry, f.a0, f.a1, f.thick, i <= 2, 340);
    // 内圈副气刃增强风浪层次
    if (i <= 3) {
      drawArcCurve(base, add, cfg.cx, cfg.cy, rx - 9, ry - 7, f.a0 + (f.a1 - f.a0) * 0.14, f.a1, Math.max(1.0, f.thick * 0.35), i <= 2, 240);
    }
    // 外推狂风流线（明确交代向外推开敌人的风压感）
    for (let g = 0; g < f.gusts; g++) {
      const gr = rx + 5 + g * 3;
      const gry = ry + 4 + g * 2;
      const subStart = f.a0 + (f.a1 - f.a0) * (0.22 + g * 0.14);
      const subEnd = f.a0 + (f.a1 - f.a0) * Math.min(1, 0.72 + g * 0.14);
      drawArcCurve(base, add, cfg.cx, cfg.cy, gr, gry, subStart, subEnd, 1.05, true, 180);
    }
    // 沿弧线外甩的风压星火
    const sparkCount = i === 2 ? 6 : i <= 3 ? 4 : 3;
    for (let s = 0; s < sparkCount; s++) {
      const t = (s + 0.5) / sparkCount;
      const deg = f.a0 + (f.a1 - f.a0) * t;
      const rad = (deg * Math.PI) / 180;
      const sr = rx + 4 + ((s * 3 + i) % 5);
      const sry = ry + 3 + ((s * 2 + i) % 4);
      plotSpark(base, add, cfg.cx + sr * Math.cos(rad), cfg.cy + sry * Math.sin(rad), s % 2 === 0 ? 'g' : 'C', plotMax, i === 2 && s % 2 === 0);
    }

    baseFrames.push({ id: `spear-gale-sweep-${direction}-base-${i}`, rows: base.map(r => r.join('')) });
    addFrames.push({ id: `spear-gale-sweep-${direction}-add-${i}`, rows: add.map(r => r.join('')) });
  }

  return {
    effectId: 'spear-gale-sweep',
    direction,
    frameWidth: cfg.w,
    frameHeight: cfg.h,
    originX: cfg.ox / cfg.w,
    originY: cfg.oy / cfg.h,
    basePalette: GALE_BASE_PALETTE,
    addPalette: GALE_ADD_PALETTE,
    baseFrames,
    addFrames,
  };
}

// ===========================================================================
// 8. 连环点枪前两段：暴雨梨花扇形错位针芒幻影（spear-flurry-needles，8 帧）
// ===========================================================================

function drawFanNeedle(
  base: string[][],
  add: string[][],
  startX: number,
  startY: number,
  dirRad: number,
  startDist: number,
  length: number,
  maxHalfW: number,
  bright: boolean,
  withTassel: boolean,
): void {
  const ux = Math.cos(dirRad);
  const uy = Math.sin(dirRad);
  const nx = -uy;
  const ny = ux;

  // 细锐高速针芒本体
  const steps = Math.round(length * 2.5);
  for (let s = 0; s <= steps; s++) {
    const f = s / steps;
    const t = startDist + f * length;
    const halfW = f < 0.2 ? 0.4 + (f / 0.2) * (maxHalfW * 0.7) : f < 0.65 ? maxHalfW : maxHalfW * Math.pow(1 - (f - 0.65) / 0.35, 1.3);
    for (let o = -halfW; o <= halfW; o += 0.35) {
      const px = startX + ux * t + nx * o;
      const py = startY + uy * t + ny * o;
      const ao = Math.abs(o);
      if (ao <= 0.55 && f > 0.15) {
        plotMax(base, px, py, bright ? 'W' : 'L');
        plotMax(add, px, py, 'W');
      } else if (ao <= halfW * 0.65) {
        plotMax(base, px, py, bright ? 'L' : 'C');
        plotMax(add, px, py, bright ? 'L' : 'C');
      } else {
        plotMax(base, px, py, 'B');
        plotMax(add, px, py, 'D');
      }
    }
  }

  // 针芒根部一点跳跃红缨残影，体现枪影如雨
  if (withTassel) {
    for (let k = 0; k < 5; k++) {
      const px = startX + ux * (startDist + 2 - k * 1.1) + nx * (k % 2 === 0 ? 1.2 : -1.2);
      const py = startY + uy * (startDist + 2 - k * 1.1) + ny * (k % 2 === 0 ? 1.2 : -1.2);
      const ch = k < 2 ? 'P' : k < 4 ? 'R' : 'r';
      plotMax(base, px, py, ch);
      plotMax(add, px, py, ch);
    }
  }

  // 枪尖瞬时点刺星闪
  if (bright) {
    const tx = startX + ux * (startDist + length - 2);
    const ty = startY + uy * (startDist + length - 2);
    plotSpark(base, add, tx, ty, 'W', plotMax, true);
  }
}

function buildFlurryNeedles(direction: 'west' | 'south' | 'north'): DirectionalEffectSource {
  const baseFrames: EffectFrameGrid[] = [];
  const addFrames: EffectFrameGrid[] = [];

  const cfg = direction === 'west'
    ? { w: 94, h: 66, ox: 82, oy: 44, sx: 68, sy: 33, baseDeg: 180 }
    : direction === 'south'
      ? { w: 66, h: 94, ox: 36, oy: 12, sx: 33, sy: 24, baseDeg: 90 }
      : { w: 66, h: 100, ox: 33, oy: 94, sx: 33, sy: 68, baseDeg: -90 };

  // 奇偶帧交替闪烁的 6 组扇形角位：每帧亮 3~4 道错落针芒，干净锐利且像暴雨连刺！
  const patterns: readonly (readonly { deg: number; s: number; len: number; w: number; bright: boolean; tassel: boolean }[])[] = [
    [{ deg: -22, s: 6, len: 46, w: 1.6, bright: true, tassel: true }, { deg: 2, s: 12, len: 52, w: 1.9, bright: true, tassel: false }, { deg: 18, s: 2, len: 40, w: 1.3, bright: false, tassel: true }],
    [{ deg: -12, s: 10, len: 54, w: 1.8, bright: true, tassel: false }, { deg: 10, s: 6, len: 48, w: 1.6, bright: true, tassel: true }, { deg: 25, s: 4, len: 44, w: 1.4, bright: false, tassel: false }, { deg: -26, s: 2, len: 38, w: 1.2, bright: false, tassel: true }],
    [{ deg: -24, s: 10, len: 52, w: 1.8, bright: true, tassel: true }, { deg: -4, s: 14, len: 56, w: 2.0, bright: true, tassel: false }, { deg: 16, s: 8, len: 50, w: 1.7, bright: true, tassel: true }],
    [{ deg: -16, s: 6, len: 48, w: 1.6, bright: true, tassel: false }, { deg: 6, s: 14, len: 56, w: 1.9, bright: true, tassel: true }, { deg: 24, s: 8, len: 48, w: 1.6, bright: true, tassel: false }],
    [{ deg: -20, s: 12, len: 54, w: 1.8, bright: true, tassel: true }, { deg: 0, s: 8, len: 52, w: 1.9, bright: true, tassel: false }, { deg: 14, s: 12, len: 54, w: 1.8, bright: true, tassel: true }, { deg: -8, s: 4, len: 40, w: 1.3, bright: false, tassel: false }],
    [{ deg: -25, s: 8, len: 48, w: 1.6, bright: true, tassel: false }, { deg: -10, s: 14, len: 56, w: 2.0, bright: true, tassel: true }, { deg: 12, s: 10, len: 52, w: 1.8, bright: true, tassel: false }, { deg: 23, s: 6, len: 46, w: 1.5, bright: false, tassel: true }],
    [{ deg: -18, s: 10, len: 54, w: 1.9, bright: true, tassel: true }, { deg: 4, s: 14, len: 58, w: 2.0, bright: true, tassel: false }, { deg: 20, s: 10, len: 50, w: 1.7, bright: true, tassel: true }],
    [{ deg: -12, s: 16, len: 42, w: 1.3, bright: false, tassel: false }, { deg: 8, s: 14, len: 44, w: 1.4, bright: false, tassel: false }, { deg: -22, s: 18, len: 34, w: 1.0, bright: false, tassel: false }],
  ];

  for (let i = 0; i < 8; i++) {
    const base = blank(cfg.w, cfg.h);
    const add = blank(cfg.w, cfg.h);
    for (const needle of patterns[i]) {
      const rad = ((cfg.baseDeg + needle.deg) * Math.PI) / 180;
      drawFanNeedle(base, add, cfg.sx, cfg.sy, rad, needle.s, needle.len, needle.w, needle.bright, needle.tassel);
    }
    baseFrames.push({ id: `spear-flurry-needles-${direction}-base-${i}`, rows: base.map(r => r.join('')) });
    addFrames.push({ id: `spear-flurry-needles-${direction}-add-${i}`, rows: add.map(r => r.join('')) });
  }

  return {
    effectId: 'spear-flurry-needles',
    direction,
    frameWidth: cfg.w,
    frameHeight: cfg.h,
    originX: cfg.ox / cfg.w,
    originY: cfg.oy / cfg.h,
    basePalette: FLURRY_BASE_PALETTE,
    addPalette: FLURRY_ADD_PALETTE,
    baseFrames,
    addFrames,
  };
}

// ===========================================================================
// 9. 连环点枪第三段：加粗高亮主刺芒 + 十字爆闪（spear-flurry-finisher，4 帧）
// ===========================================================================

function drawFlurryFinisherAxis(
  base: string[][],
  add: string[][],
  frameIndex: number,
  axisLength: number,
  centerV: number,
  putPt: (grid: string[][], along: number, across: number, ch: string) => void,
): void {
  if (frameIndex === 0 || frameIndex === 1) {
    const isPeak = frameIndex === 1;
    const end = isPeak ? axisLength - 1 : axisLength - 10;
    const maxW = isPeak ? 8.0 : 5.8;

    // 居中收束爆发的高亮定音主刺芒
    for (let u = 2; u <= end; u++) {
      const f = (u - 2) / (end - 2);
      const halfW = f < 0.2 ? 1.0 + (f / 0.2) * (maxW * 0.45)
        : f < 0.62 ? maxW * (0.55 + Math.sin(((f - 0.2) / 0.42) * Math.PI * 0.5) * 0.45)
          : maxW * Math.pow(1 - (f - 0.62) / 0.38, 1.35);
      for (let v = -Math.ceil(halfW); v <= Math.ceil(halfW); v++) {
        const av = Math.abs(v);
        if (av > halfW + 0.12) continue;
        const r = av / Math.max(0.5, halfW);
        if (av <= (isPeak ? 1.8 : 1.2)) { putPt(base, u, centerV + v, 'W'); putPt(add, u, centerV + v, 'W'); }
        else if (r < 0.48) { putPt(base, u, centerV + v, 'L'); putPt(add, u, centerV + v, 'L'); }
        else if (r < 0.74) { putPt(base, u, centerV + v, 'C'); putPt(add, u, centerV + v, 'C'); }
        else { putPt(base, u, centerV + v, 'B'); putPt(add, u, centerV + v, 'D'); }
      }
    }

    // 锋尖巨型十字星闪（定音「破」字诀！）
    const starU = Math.round(end * (isPeak ? 0.78 : 0.72));
    const crossV = isPeak ? 15 : 10;
    const crossU = isPeak ? 12 : 8;
    for (let s = -crossV; s <= crossV; s++) {
      const ch = Math.abs(s) <= 4 ? 'W' : Math.abs(s) <= 9 ? 'L' : 'C';
      putPt(base, starU, centerV + s, ch);
      putPt(add, starU, centerV + s, ch);
      if (isPeak && Math.abs(s) <= 6) {
        putPt(add, starU - 1, centerV + s, 'L');
        putPt(add, starU + 1, centerV + s, 'L');
      }
    }
    for (let s = -crossU; s <= crossU; s++) {
      const ch = Math.abs(s) <= 4 ? 'W' : 'L';
      putPt(add, starU + s, centerV, ch);
      if (Math.abs(s) <= 6) {
        putPt(add, starU + s, centerV + s, 'C');
        putPt(add, starU + s, centerV - s, 'C');
      }
    }

    // 吞口一圈紧凑激波环
    for (let v = -11; v <= 11; v++) {
      const norm = Math.abs(v) / 11;
      const ru = 18 - Math.round(norm * norm * 8);
      putPt(base, ru, centerV + v, norm < 0.45 ? 'W' : 'C');
      putPt(add, ru, centerV + v, norm < 0.45 ? 'W' : 'L');
    }
    if (isPeak) {
      plotSpark(base, add, starU - 14, centerV - 12, 'g', putPt, true);
      plotSpark(base, add, starU - 10, centerV + 13, 'W', putPt, false);
      plotSpark(base, add, starU + 8, centerV - 10, 'g', putPt, false);
      plotSpark(base, add, starU + 6, centerV + 11, 'L', putPt, true);
    }
    return;
  }

  if (frameIndex === 2) {
    for (let u = 14; u <= axisLength - 1; u++) {
      const f = (u - 14) / (axisLength - 15);
      const halfW = 3.2 * Math.sin(f * Math.PI);
      for (let v = -Math.ceil(halfW); v <= Math.ceil(halfW); v++) {
        if (Math.abs(v) > halfW) continue;
        putPt(base, u, centerV + v, Math.abs(v) <= 0.8 ? 'L' : 'C');
        putPt(add, u, centerV + v, Math.abs(v) <= 0.8 ? 'W' : 'B');
      }
    }
    const starU = Math.round(axisLength * 0.78);
    for (let s = -11; s <= 11; s += 2) putPt(add, starU, centerV + s, 'C');
    plotSpark(base, add, starU - 16, centerV - 13, 'C', putPt, false);
    plotSpark(base, add, starU - 8, centerV + 14, 'g', putPt, true);
    plotSpark(base, add, starU + 6, centerV - 9, 'W', putPt, false);
    return;
  }

  for (const [su, sv, ch, big] of [[24, -8, 'C', false], [42, 9, 'g', true], [56, -7, 'L', false], [axisLength - 6, 0, 'W', true]] as const) {
    plotSpark(base, add, su, centerV + sv, ch, putPt, big);
  }
}

// ===========================================================================
// 10. 万圣龙王破（选项 A）：同源 1.6 倍加长蓝青柳叶枪芒 + 双层青金螺旋气浪（spear-sovereign-beam，7 帧）
// ===========================================================================

function drawSovereignBeamAxis(
  base: string[][],
  add: string[][],
  frameIndex: number,
  axisLength: number,
  centerV: number,
  putPt: (grid: string[][], along: number, across: number, ch: string) => void,
): void {
  if (frameIndex === 0) {
    // 瞬时聚气破膛尖锥（比破阵枪更宽厚，带青金闪芒）
    const end = 52;
    for (let u = 2; u <= end; u++) {
      const f = (u - 2) / (end - 2);
      const halfW = f < 0.34 ? 1.2 + (f / 0.34) * 7.8 : 9.0 * Math.pow(1 - (f - 0.34) / 0.66, 1.15);
      for (let v = -Math.ceil(halfW); v <= Math.ceil(halfW); v++) {
        const av = Math.abs(v);
        if (av > halfW + 0.15) continue;
        const r = av / Math.max(0.5, halfW);
        if (r < 0.3) { putPt(base, u, centerV + v, 'W'); putPt(add, u, centerV + v, 'W'); }
        else if (r < 0.58) { putPt(base, u, centerV + v, 'C'); putPt(add, u, centerV + v, 'C'); }
        else if (r < 0.84) { putPt(base, u, centerV + v, 'B'); putPt(add, u, centerV + v, 'D'); }
        else { putPt(base, u, centerV + v, 'D'); }
      }
    }
    for (let s = -14; s <= 14; s++) {
      const c = Math.abs(s) <= 4 ? 'W' : Math.abs(s) <= 9 ? 'g' : 'C';
      putPt(base, 18, centerV + s, c);
      putPt(add, 18, centerV + s, c);
    }
    return;
  }

  if (frameIndex === 1 || frameIndex === 2 || frameIndex === 3) {
    const isPeak = frameIndex === 2;
    const isSurge = frameIndex === 3;
    const start = isSurge ? 8 : 2;
    const end = frameIndex === 1 ? axisLength - 18 : axisLength - 1;
    const maxW = isPeak ? 10.2 : isSurge ? 8.8 : 8.6;

    // 1. 同源 1.6 倍超长蓝青柳叶枪芒主体（贯穿 4 目标的绝对压迫感）
    for (let u = start; u <= end; u++) {
      const f = (u - start) / (end - start);
      let halfW: number;
      if (f < 0.12) halfW = 1.0 + (f / 0.12) * (maxW * 0.42);
      else if (f < 0.64) halfW = maxW * (0.42 + Math.sin(((f - 0.12) / 0.52) * Math.PI * 0.5) * 0.58);
      else halfW = maxW * Math.pow(1 - (f - 0.64) / 0.36, 1.35);

      const ripple = (f > 0.15 && f < 0.85 && (u + frameIndex * 3) % 6 === 0) ? 0.8 : 0;
      const edgeW = halfW + ripple;

      for (let v = -Math.ceil(edgeW); v <= Math.ceil(edgeW); v++) {
        const av = Math.abs(v);
        if (av > edgeW + 0.12) continue;
        const r = av / Math.max(0.5, edgeW);
        const coreW = f > 0.1 && f < 0.9 ? (isPeak ? 2.1 : 1.5) : 0.8;
        if (av <= coreW) { putPt(base, u, centerV + v, 'W'); putPt(add, u, centerV + v, 'W'); }
        else if (r < 0.45) { putPt(base, u, centerV + v, 'L'); putPt(add, u, centerV + v, 'L'); }
        else if (r < 0.7) { putPt(base, u, centerV + v, 'C'); putPt(add, u, centerV + v, 'C'); }
        else if (r < 0.88) { putPt(base, u, centerV + v, 'B'); putPt(add, u, centerV + v, 'B'); }
        else {
          putPt(base, u, centerV + v, (u + v) % 2 === 0 ? 'D' : 'd');
          if (isPeak && (u + v) % 2 === 0) putPt(add, u, centerV + v, 'd');
        }
      }
    }

    // 2. 双层青金螺旋龙卷气浪（沿 134px 全长呈双正弦交织缠绕枪芒向前飞旋！）
    const phase = frameIndex * 1.1;
    const spiralEnd = end - 10;
    for (let u = start + 8; u <= spiralEnd; u += 0.5) {
      const f = (u - start) / Math.max(1, end - start);
      const env = Math.sin(Math.min(1, f * 1.15) * Math.PI) * 0.85 + 0.25;
      const amp = (isPeak ? 15.5 : 13.5) * env;
      const wave1 = Math.sin(u * 0.13 - phase) * amp;
      const wave2 = Math.sin(u * 0.13 - phase + Math.PI) * amp;
      // 金白龙纹缠丝
      putPt(base, u, centerV + wave1, 'g');
      putPt(add, u, centerV + wave1, f > 0.55 ? 'W' : 'g');
      putPt(base, u, centerV + wave1 + (wave1 >= 0 ? 1 : -1), 'C');
      // 冰青副螺旋丝
      putPt(base, u, centerV + wave2, 'C');
      putPt(add, u, centerV + wave2, 'L');
      putPt(base, u, centerV + wave2 + (wave2 >= 0 ? 1 : -1), 'B');
    }

    // 3. 三道纵深月牙破空气浪环（层层贯破 4 目标！）
    const rings = isPeak
      ? [{ u: 24, rad: 18, curve: 12, thick: 2 }, { u: 62, rad: 15, curve: 10, thick: 2 }, { u: 96, rad: 12, curve: 8, thick: 1 }]
      : [{ u: 22, rad: 16, curve: 11, thick: 2 }, { u: 64, rad: 13, curve: 9, thick: 1 }];
    for (const ring of rings) {
      for (let v = -ring.rad; v <= ring.rad; v++) {
        const norm = Math.abs(v) / ring.rad;
        const ru = ring.u - Math.round(norm * norm * ring.curve);
        const ch = norm < 0.35 ? 'W' : norm < 0.68 ? 'C' : 'B';
        putPt(base, ru, centerV + v, ch);
        putPt(add, ru, centerV + v, ch);
        if (ring.thick >= 2 && norm < 0.84) {
          putPt(base, ru - 1, centerV + v, norm < 0.45 ? 'g' : 'D');
          putPt(add, ru - 1, centerV + v, norm < 0.45 ? 'g' : 'd');
        }
      }
    }

    // 4. 锋尖爆闪星芒 + 伴飞青金火星
    const tipStarU = Math.round(start + (end - start) * 0.8);
    const starR = isPeak ? 12 : 8;
    for (let s = -starR; s <= starR; s++) {
      const ch = Math.abs(s) <= 3 ? 'W' : Math.abs(s) <= 7 ? 'L' : 'C';
      putPt(add, tipStarU, centerV + s, ch);
      if (Math.abs(s) <= 6) putPt(base, tipStarU, centerV + s, ch);
    }
    const sparks: [number, number, string, boolean][] = [
      [30, -17, 'g', true], [50, 17, 'L', false], [74, -16, 'g', true],
      [94, 15, 'C', true], [112, -12, 'W', false], [end - 8, 9, 'g', true],
    ];
    for (const [su, sv, ch, big] of sparks) plotSpark(base, add, su, centerV + sv, ch, putPt, big);
    return;
  }

  if (frameIndex === 4) {
    // 前窜抽空，留下一条纤细高压气柱与断环
    const start = 24;
    const end = axisLength - 1;
    for (let u = start; u <= end; u++) {
      const f = (u - start) / (end - start);
      const halfW = 4.6 * Math.sin(Math.pow(f, 0.8) * Math.PI);
      for (let v = -Math.ceil(halfW); v <= Math.ceil(halfW); v++) {
        const av = Math.abs(v);
        if (av > halfW) continue;
        if (av <= 0.9) { putPt(base, u, centerV + v, 'L'); putPt(add, u, centerV + v, 'W'); }
        else if (av <= halfW * 0.55) { putPt(base, u, centerV + v, 'C'); putPt(add, u, centerV + v, 'C'); }
        else if ((u + v) % 2 === 0) { putPt(base, u, centerV + v, 'B'); putPt(add, u, centerV + v, 'D'); }
      }
    }
    // 残余螺旋断丝
    for (let u = 22; u <= end - 8; u += 2) {
      if (u % 10 === 0) continue;
      const w1 = Math.sin(u * 0.13 - 5.2) * 14;
      putPt(base, u, centerV + w1, 'g');
      putPt(add, u, centerV + w1, 'g');
      putPt(add, u, centerV - w1, 'C');
    }
    plotSpark(base, add, 42, centerV - 16, 'g', putPt, true);
    plotSpark(base, add, 80, centerV + 16, 'W', putPt, true);
    plotSpark(base, add, 114, centerV - 12, 'g', putPt, false);
    return;
  }

  if (frameIndex === 5) {
    // 多道长距离残影流丝与青金星火
    const lines: [number, number, number, string][] = [
      [34, axisLength - 2, 0, 'L'], [42, axisLength - 14, -6, 'C'], [46, axisLength - 12, 6, 'C'],
      [26, axisLength - 40, -12, 'B'], [32, axisLength - 34, 12, 'B'], [78, axisLength - 4, -2, 'W'],
    ];
    for (const [s, e, v, ch] of lines) {
      for (let u = s; u <= e; u++) {
        if ((u * 3 + Math.abs(v)) % 7 < 2) continue;
        putPt(base, u, centerV + v, ch === 'W' ? 'C' : 'B');
        putPt(add, u, centerV + v, ch);
      }
    }
    for (const [su, sv, ch, big] of [[44, -15, 'g', false], [70, 14, 'W', true], [98, -12, 'g', true], [122, 8, 'L', false]] as const) {
      plotSpark(base, add, su, centerV + sv, ch, putPt, big);
    }
    return;
  }

  // Frame 6：远端青金星点清脆收尾
  for (const [su, sv, ch, big] of [
    [52, -12, 'C', false], [78, 12, 'g', true], [102, -10, 'L', false], [120, 6, 'g', false], [axisLength - 6, 0, 'W', true],
  ] as const) {
    plotSpark(base, add, su, centerV + sv, ch, putPt, big);
  }
}

// ===========================================================================
// 11. 旋风枪舞：360° 俯视椭圆冷钢青白刃环 + 飞舞红缨流光 + 末圈爆散（spear-spin-storm，14 帧）
// ===========================================================================

function drawTasselRibbon(
  base: string[][],
  add: string[][],
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  tailDeg: number,
  headDeg: number,
  halfWidth: number,
  phaseSeed: number,
): void {
  // 高密度采样（每度至少 1.5 步），彻底消除外圈断齿并画出双股飘逸红缨丝感
  const steps = Math.max(220, Math.ceil(Math.abs(headDeg - tailDeg) * 1.6));
  for (let s = 0; s <= steps; s++) {
    const f = s / steps; // 0 = 飘尾，1 = 靠近枪颈红缨头
    const deg = tailDeg + (headDeg - tailDeg) * f;
    const rad = (deg * Math.PI) / 180;
    const flutter = Math.sin(f * Math.PI * 3.5 + phaseSeed) * 1.35 * (1 - f * 0.4);
    const taper = Math.sin(Math.pow(f, 0.72) * Math.PI);
    const hw = Math.max(0.45, halfWidth * taper);
    const ca = Math.cos(rad);
    const sa = Math.sin(rad);
    for (let o = -hw; o <= hw; o += 0.35) {
      const px = cx + (rx + flutter + o) * ca;
      const py = cy + (ry + flutter * 0.72 + o * 0.76) * sa;
      const norm = Math.abs(o) / Math.max(0.45, hw);
      const ch = norm < 0.38 && f > 0.34 ? 'P' : norm < 0.76 && f > 0.14 ? 'R' : 'r';
      const gx = Math.round(px);
      const gy = Math.round(py);
      if (gy >= 0 && gy < base.length && gx >= 0 && gx < base[0].length) {
        if (base[gy][gx] !== 'W') base[gy][gx] = ch;
        if (add[gy][gx] !== 'W') add[gy][gx] = ch;
      }
    }
    // 副股细红缨飘丝（略偏外侧、反相波动，增强真丝甩尾质感）
    if (f > 0.12 && f < 0.92) {
      const f2 = Math.sin(f * Math.PI * 4.5 + phaseSeed + 2.1) * 1.5;
      const px2 = cx + (rx + 3.2 + f2) * ca;
      const py2 = cy + (ry + 2.3 + f2 * 0.72) * sa;
      const gx2 = Math.round(px2);
      const gy2 = Math.round(py2);
      if (gy2 >= 0 && gy2 < base.length && gx2 >= 0 && gx2 < base[0].length) {
        const ch2 = f > 0.55 ? 'R' : 'r';
        if (base[gy2][gx2] !== 'W' && base[gy2][gx2] !== 'P') base[gy2][gx2] = ch2;
        if (add[gy2][gx2] !== 'W' && add[gy2][gx2] !== 'P') add[gy2][gx2] = ch2;
      }
    }
  }
}

function buildSpinStorm(direction: 'west' | 'south' | 'north'): DirectionalEffectSource {
  // 140×104：角色脚底 (0,0) 在 (70, 60)，旋风中心在 (70, 48)（腰胸高度 y = -12），南北枪尖完整贴合弧锋不穿帮
  const w = 140;
  const h = 104;
  const ox = 70;
  const oy = 60;
  const cx = 70;
  const cy = 48;
  // 起始角度与 source.ts 四向起旋严丝合缝咬合，每帧逆时针旋转 -90°（东向由西向自动镜像成顺时针）
  const startDeg = direction === 'south' ? 90 : direction === 'west' ? 180 : -90;
  const baseFrames: EffectFrameGrid[] = [];
  const addFrames: EffectFrameGrid[] = [];

  for (let i = 0; i < 14; i++) {
    const base = blank(w, h);
    const add = blank(w, h);
    const tipDeg = startDeg - i * 90;

    if (i < 12) {
      // 阶段 1..3：三整圈旋枪递进（第 1 圈起势 → 第 2 圈满速 → 第 3 圈极限狂舞）
      const turn = Math.floor(i / 4); // 0, 1, 2
      const progress = i / 11;
      const scale = 0.88 + progress * 0.22; // 0.88 → 1.10
      const rx = 50 * scale;
      const ry = 36.5 * scale;
      const mainThick = turn === 0 ? 3.5 + i * 0.28 : turn === 1 ? 5.1 : 5.8;
      const trailSpan = turn === 0 ? 200 + i * 10 : turn === 1 ? 245 : 265;

      // 1. 外圈主枪锋寒芒（高密 440 步平滑连续绘制，彻底无断齿，前锋炽白紧咬枪尖）
      drawArcCurve(base, add, cx, cy, rx, ry, tipDeg + trailSpan, tipDeg, mainThick, true, 440);

      // 2. 180° 对侧平衡风刃弧（维持 360° 连续旋风感，比主锋更薄不抢方向）
      drawArcCurve(
        base, add, cx, cy, rx + 2.5, ry + 1.9,
        tipDeg + 180 + (turn === 0 ? 110 : 140), tipDeg + 180 - 10,
        turn === 0 ? 1.5 : 2.1, false, 240,
      );

      // 3. 第 2~3 圈追加外缘破风丝线，拉满高速离心张力
      if (turn >= 1) {
        drawArcCurve(base, add, cx, cy, rx + 5.8, ry + 4.2, tipDeg + 175, tipDeg + 14, 1.15, true, 260);
      }
      if (turn === 2) {
        drawArcCurve(base, add, cx, cy, rx + 9.2, ry + 6.5, tipDeg + 135, tipDeg + 20, 0.95, false, 220);
      }

      // 4. 内圈枪杆带起的气旋细丝（保持中心镂空，绝不遮挡角色头脸与盔甲）
      drawArcCurve(base, add, cx, cy, rx - 18, ry - 13, tipDeg + 215, tipDeg + 35, 1.05, false, 220);

      // 5. 长枪灵魂标识：紧贴枪头内侧高速甩飞的双股朱红红缨流光带！
      drawTasselRibbon(
        base, add, cx, cy, rx - 8.5, ry - 6.2,
        tipDeg + (turn === 0 ? 136 : 168), tipDeg + 8,
        turn === 0 ? 1.55 : turn === 1 ? 1.95 : 2.2,
        i * 1.4,
      );

      // 6. 枪尖破空十字亮锋 + 沿外缘甩出的金青火星
      const tipRad = (tipDeg * Math.PI) / 180;
      plotSpark(base, add, cx + rx * Math.cos(tipRad), cy + ry * Math.sin(tipRad), 'W', plotMax, true);
      const sparkCount = turn === 0 ? 3 : turn === 1 ? 5 : 7;
      for (let s = 0; s < sparkCount; s++) {
        const sDeg = tipDeg + 26 + s * (280 / sparkCount);
        const sRad = (sDeg * Math.PI) / 180;
        const sr = rx + 4 + ((s * 3 + i) % 6);
        const sry = ry + 3 + ((s * 2 + i) % 4);
        plotSpark(base, add, cx + sr * Math.cos(sRad), cy + sry * Math.sin(sRad), s % 2 === 0 ? 'g' : 'C', plotMax, turn === 2 && s % 3 === 0);
      }
    } else if (i === 12) {
      // Frame 12（对应动画 F14）：三圈收满归位！360° 平滑扩环气浪 + 切向甩飞破风流丝 + 枪尖爆闪
      const rx = 58;
      const ry = 42;
      drawArcCurve(base, add, cx, cy, rx, ry, tipDeg + 356, tipDeg - 4, 4.2, true, 540);
      drawArcCurve(base, add, cx, cy, rx - 8.5, ry - 6.2, tipDeg + 315, tipDeg + 15, 1.85, false, 360);
      // 末圈甩开的红缨收尾光弧
      drawTasselRibbon(base, add, cx, cy, rx - 11.5, ry - 8.4, tipDeg + 190, tipDeg + 6, 1.95, 4.2);
      // 6 道顺旋转方向切向甩离的破风气丝（取代生硬直角射线，更有离心爆发张力）
      for (let k = 0; k < 6; k++) {
        const aStart = tipDeg + k * 60 + 28;
        const aEnd = tipDeg + k * 60 - 10;
        for (let s = 0; s <= 44; s++) {
          const f = s / 44;
          const deg = aStart + (aEnd - aStart) * f;
          const rad = (deg * Math.PI) / 180;
          const expand = f * (k === 0 ? 9.5 : 7.5);
          const px = cx + (rx + 1 + expand) * Math.cos(rad);
          const py = cy + (ry + 0.8 + expand * 0.72) * Math.sin(rad);
          const ch = f > 0.65 ? (k === 0 ? 'W' : 'g') : f > 0.3 ? 'L' : 'C';
          plotMax(base, px, py, ch);
          plotMax(add, px, py, f > 0.5 ? 'W' : 'L');
        }
        const tipRad = (aEnd * Math.PI) / 180;
        const ex = k === 0 ? 10 : 8;
        plotSpark(
          base, add,
          cx + (rx + ex) * Math.cos(tipRad),
          cy + (ry + ex * 0.72) * Math.sin(tipRad),
          k === 0 ? 'W' : k % 2 === 0 ? 'g' : 'L',
          plotMax,
          k === 0 || k % 2 === 0,
        );
      }
      // 归位枪尖强十字爆闪
      const homeRad = (tipDeg * Math.PI) / 180;
      const hx = cx + rx * Math.cos(homeRad);
      const hy = cy + ry * Math.sin(homeRad);
      for (let d = -5; d <= 5; d++) {
        const ch = Math.abs(d) <= 2 ? 'W' : 'L';
        plotMax(base, hx + d, hy, ch);
        plotMax(add, hx + d, hy, ch);
        plotMax(base, hx, hy + d, ch);
        plotMax(add, hx, hy + d, ch);
      }
    } else {
      // Frame 13（对应动画 F15）：外圈断续余风与零星金青火星轻盈消散
      const rx = 62;
      const ry = 44.5;
      for (const offset of [0, 120, 240]) {
        drawArcCurve(base, add, cx, cy, rx, ry, tipDeg + offset + 64, tipDeg + offset + 8, 1.15, false, 140);
      }
      for (let k = 0; k < 6; k++) {
        const rad = ((tipDeg + 20 + k * 60) * Math.PI) / 180;
        plotSpark(base, add, cx + (rx + 2) * Math.cos(rad), cy + (ry + 1.5) * Math.sin(rad), k % 2 === 0 ? 'g' : 'C', plotMax, false);
      }
    }

    baseFrames.push({ id: `spear-spin-storm-${direction}-base-${i}`, rows: base.map(r => r.join('')) });
    addFrames.push({ id: `spear-spin-storm-${direction}-add-${i}`, rows: add.map(r => r.join('')) });
  }

  return {
    effectId: 'spear-spin-storm',
    direction,
    frameWidth: w,
    frameHeight: h,
    originX: ox / w,
    originY: oy / h,
    basePalette: SPIN_BASE_PALETTE,
    addPalette: SPIN_ADD_PALETTE,
    baseFrames,
    addFrames,
  };
}

// ===========================================================================
// 12. 普通攻击第三段：素银由下而上轻量上挑弧光（spear-basic-lift，3 帧，无控制）
// ===========================================================================

function buildBasicLift(direction: 'west' | 'south' | 'north'): DirectionalEffectSource {
  const baseFrames: EffectFrameGrid[] = [];
  const addFrames: EffectFrameGrid[] = [];
  // 紧贴普攻「压低→上挑」枪尖轨迹的自下而上素银细弧（保持与前两段一致的轻灵克制感，不抢技能风头）
  const cfg = direction === 'west'
    ? {
        w: 68, h: 76, ox: 52, oy: 56, cx: 46, cy: 38, rx: 30, ry: 30,
        // 西向（东向镜像）：左下低位(130°) 顺时针上挑过正西(180°) 至左上高点(250°)
        arcs: [[130, 198, 2.3], [145, 250, 3.2], [205, 256, 1.5]] as const,
      }
    : direction === 'south'
      ? {
          w: 66, h: 76, ox: 29, oy: 46, cx: 28, cy: 32, rx: 26, ry: 28,
          // 南向：正前下方(95°) 逆时针斜上挑过右前(15°) 至高点(-62°)
          arcs: [[95, 18, 2.3], [76, -62, 3.2], [-10, -68, 1.5]] as const,
        }
      : {
          w: 64, h: 86, ox: 34, oy: 76, cx: 30, cy: 46, rx: 20, ry: 28,
          // 北向：右后低位(25°) 向上挑过右上(-48°) 至正北高空(-102°)
          arcs: [[25, -48, 2.3], [8, -102, 3.2], [-56, -108, 1.5]] as const,
        };

  for (let i = 0; i < 3; i++) {
    const base = blank(cfg.w, cfg.h);
    const add = blank(cfg.w, cfg.h);
    const [a0, a1, thick] = cfg.arcs[i];
    drawArcCurve(base, add, cfg.cx, cfg.cy, cfg.rx, cfg.ry, a0, a1, thick, i !== 2, 180);
    if (i === 1) {
      // 峰值帧外缘补 1 条极细上挑破风银丝 + 顶端轻巧星闪
      drawArcCurve(base, add, cfg.cx, cfg.cy, cfg.rx + 4, cfg.ry + 4, a0 + (a1 - a0) * 0.28, a1, 0.85, true, 140);
      const tipRad = (a1 * Math.PI) / 180;
      plotSpark(base, add, cfg.cx + cfg.rx * Math.cos(tipRad), cfg.cy + cfg.ry * Math.sin(tipRad), 'W', plotMax, true);
    } else if (i === 2) {
      const tipRad = (a1 * Math.PI) / 180;
      plotSpark(base, add, cfg.cx + (cfg.rx + 2) * Math.cos(tipRad), cfg.cy + (cfg.ry + 2) * Math.sin(tipRad), 'L', plotMax, false);
    }
    baseFrames.push({ id: `spear-basic-lift-${direction}-base-${i}`, rows: base.map(r => r.join('')) });
    addFrames.push({ id: `spear-basic-lift-${direction}-add-${i}`, rows: add.map(r => r.join('')) });
  }

  return {
    effectId: 'spear-basic-lift',
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
// 汇总全套 12 组原创特效源（export.ts 自动打包到 spear-effects.png）
// ===========================================================================

export const SPEAR_EFFECT_SOURCES: readonly DirectionalEffectSource[] = [
  // 1. 蓝青直刺枪芒（基础直刺原型对照）
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

  // 2. 普通攻击第一段 · 素银轻刺破风线（3 帧）
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

  // 3B. 普通攻击第三段 · 素银由下而上轻量上挑弧光（3 帧，无控制）
  buildBasicLift('west'),
  buildBasicLift('south'),
  buildBasicLift('north'),

  // 4. 狂龙穿心破 · 赤金炽白重刺破甲芒（5 帧，贴紧原地出枪身位）
  buildDirectionalLinearEffect({
    effectId: 'spear-heavy-pierce', direction: 'west', frameCount: 5,
    width: 104, height: 42, originPx: [96, 32], startAlongPx: 84, axisLength: 68, centerCrossPx: 21,
    basePalette: HEAVY_BASE_PALETTE, addPalette: HEAVY_ADD_PALETTE, drawer: drawHeavyPierceAxis,
  }),
  buildDirectionalLinearEffect({
    effectId: 'spear-heavy-pierce', direction: 'south', frameCount: 5,
    width: 42, height: 102, originPx: [24, 6], startAlongPx: 18, axisLength: 70, centerCrossPx: 21,
    basePalette: HEAVY_BASE_PALETTE, addPalette: HEAVY_ADD_PALETTE, drawer: drawHeavyPierceAxis,
  }),
  buildDirectionalLinearEffect({
    effectId: 'spear-heavy-pierce', direction: 'north', frameCount: 5,
    width: 42, height: 110, originPx: [21, 108], startAlongPx: 78, axisLength: 66, centerCrossPx: 21,
    basePalette: HEAVY_BASE_PALETTE, addPalette: HEAVY_ADD_PALETTE, drawer: drawHeavyPierceAxis,
  }),

  // 5. 伏龙震（力劈华山）· 暗金土黄纵向重劈下砸弧光 + 地面震裂环（4 帧）
  buildSlamArc('west'),
  buildSlamArc('south'),
  buildSlamArc('north'),

  // 6. 虬龙扫暴阵前半段 · 四向前置延长枪花绞杀涡轮（6 帧，东向自动镜像）
  buildFlowerSpin('west'),
  buildFlowerSpin('south'),
  buildFlowerSpin('north'),

  // 7. 虬龙扫暴阵主体 · 四向 180° 青白月牙狂风枪芒（6 帧）
  buildGaleSweep('west'),
  buildGaleSweep('south'),
  buildGaleSweep('north'),

  // 8. 连环点枪前两段 · 暴雨梨花扇形错位针芒幻影（8 帧）
  buildFlurryNeedles('west'),
  buildFlurryNeedles('south'),
  buildFlurryNeedles('north'),

  // 9. 连环点枪第三段 · 炽青加粗定音主刺芒 + 十字爆闪（4 帧，贴紧原地出枪身位）
  buildDirectionalLinearEffect({
    effectId: 'spear-flurry-finisher', direction: 'west', frameCount: 4,
    width: 98, height: 40, originPx: [90, 31], startAlongPx: 78, axisLength: 72, centerCrossPx: 20,
    basePalette: BEAM_BASE_PALETTE, addPalette: BEAM_ADD_PALETTE, drawer: drawFlurryFinisherAxis,
  }),
  buildDirectionalLinearEffect({
    effectId: 'spear-flurry-finisher', direction: 'south', frameCount: 4,
    width: 40, height: 96, originPx: [23, 6], startAlongPx: 18, axisLength: 72, centerCrossPx: 20,
    basePalette: BEAM_BASE_PALETTE, addPalette: BEAM_ADD_PALETTE, drawer: drawFlurryFinisherAxis,
  }),
  buildDirectionalLinearEffect({
    effectId: 'spear-flurry-finisher', direction: 'north', frameCount: 4,
    width: 40, height: 106, originPx: [20, 102], startAlongPx: 72, axisLength: 70, centerCrossPx: 20,
    basePalette: BEAM_BASE_PALETTE, addPalette: BEAM_ADD_PALETTE, drawer: drawFlurryFinisherAxis,
  }),

  // 10. 万圣龙王破（选项 A）· 同源 1.6 倍加长螺旋龙枪芒（7 帧，贴紧原地出枪身位，覆盖 4 目标）
  buildDirectionalLinearEffect({
    effectId: 'spear-sovereign-beam', direction: 'west', frameCount: 7,
    width: 158, height: 48, originPx: [148, 35], startAlongPx: 136, axisLength: 130, centerCrossPx: 24,
    basePalette: BEAM_BASE_PALETTE, addPalette: BEAM_ADD_PALETTE, drawer: drawSovereignBeamAxis,
  }),
  buildDirectionalLinearEffect({
    effectId: 'spear-sovereign-beam', direction: 'south', frameCount: 7,
    width: 48, height: 156, originPx: [27, 6], startAlongPx: 18, axisLength: 130, centerCrossPx: 24,
    basePalette: BEAM_BASE_PALETTE, addPalette: BEAM_ADD_PALETTE, drawer: drawSovereignBeamAxis,
  }),
  buildDirectionalLinearEffect({
    effectId: 'spear-sovereign-beam', direction: 'north', frameCount: 7,
    width: 48, height: 164, originPx: [24, 160], startAlongPx: 130, axisLength: 126, centerCrossPx: 24,
    basePalette: BEAM_BASE_PALETTE, addPalette: BEAM_ADD_PALETTE, drawer: drawSovereignBeamAxis,
  }),

  // 11. 旋风枪舞 · 360° 俯视椭圆冷钢青白刃环 + 朱红红缨流光 + 末圈爆散（14 帧，东向由西向自动镜像同步）
  buildSpinStorm('west'),
  buildSpinStorm('south'),
  buildSpinStorm('north'),
];

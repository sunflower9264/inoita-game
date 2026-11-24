/**
 * 长枪样板可编辑像素源数据（基础铁枪 · 红缨长枪）。
 *
 * 修改任意切片像素网格、调色板、握点或动作轨迹后，执行：
 *   node tools/warrior-viewer/prototypes/spear/export.ts
 * 即可重新导出透明 PNG（spear-parts.png / spear-effects.png）与全套姿态/特效配置（spear-prototype.json）。
 */

export interface PixelSliceSource {
  id: string;
  label: string;
  anchorX: number;
  anchorY: number;
  rows: readonly string[];
}

/** 14 色调色板：轮廓与冷钢 4 阶沿用原版 two-handed-style-1，木杆与铜箍/红缨保持同口径明暗。 */
export const SPEAR_PALETTE: Readonly<Record<string, readonly [number, number, number, number]>> = {
  '.': [0, 0, 0, 0],
  K: [0x18, 0x0c, 0x08, 255], // 深暖黑外轮廓
  D: [0x31, 0x24, 0x29, 255], // 深铁炭轮廓 / 暗钢
  S: [0x52, 0x5d, 0x6b, 255], // 冷钢暗面
  M: [0x84, 0x92, 0xa5, 255], // 冷钢中调
  L: [0xad, 0xba, 0xc6, 255], // 冷钢亮面
  H: [0xee, 0xf4, 0xf8, 255], // 冷钢锋脊高光
  w: [0x3b, 0x25, 0x1e, 255], // 硬木枪杆暗边
  W: [0x6b, 0x47, 0x32, 255], // 硬木枪杆中调
  u: [0x9b, 0x6e, 0x4a, 255], // 硬木枪杆受光边
  g: [0x8c, 0x62, 0x28, 255], // 铜箍暗面
  G: [0xdf, 0xb4, 0x54, 255], // 铜箍亮面
  r: [0x6b, 0x14, 0x14, 255], // 红缨暗红
  R: [0xc4, 0x29, 0x24, 255], // 红缨正红
  P: [0xf2, 0x62, 0x4e, 255], // 红缨高光丝
};

function blankGrid(width: number, height: number): string[][] {
  return Array.from({ length: height }, () => Array.from({ length: width }, () => '.'));
}

function put(grid: string[][], x: number, y: number, ch: string): void {
  const rx = Math.round(x);
  const ry = Math.round(y);
  if (ry >= 0 && ry < grid.length && rx >= 0 && rx < grid[0].length) grid[ry][rx] = ch;
}

function toRows(grid: string[][]): string[] {
  return grid.map(row => row.join(''));
}

/** 围绕已有非透明色块补 1px 四邻外轮廓（已上色像素不覆盖）。 */
function applyOutline(grid: string[][], outlineColor: string, predicate?: (ch: string) => boolean): void {
  const h = grid.length;
  const w = grid[0].length;
  const marks: [number, number][] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (grid[y][x] !== '.') continue;
      const neighbors = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]];
      for (const [nx, ny] of neighbors) {
        if (ny < 0 || ny >= h || nx < 0 || nx >= w) continue;
        const nch = grid[ny][nx];
        if (nch !== '.' && (!predicate || predicate(nch))) {
          marks.push([x, y]);
          break;
        }
      }
    }
  }
  for (const [x, y] of marks) grid[y][x] = outlineColor;
}

/**
 * 构建修长锐利的像素长枪切片：
 * - 枪杆：纤细 2px 核心（上缘受光 u/W + 下缘暗木 w），包 1px 暖黑外轮廓后总宽 3~4px，与原版比例协调
 * - 枪头：修长柳叶钢刃（锋尖锐利、中心脊线 H 高光、两翼冷钢过渡）
 * - 铜箍：金铜吞口环
 * - 枪尾铁镦：细长锥形冷钢收尾
 * - 红缨：支持待机垂摆（hang）、突刺风曳（trail）、横扫甩尾（sweep）与下劈上扬（whip-up）
 */
function buildAngledSpear(options: {
  width: number;
  height: number;
  tipX: number;
  tipY: number;
  buttX: number;
  buttY: number;
  bladeLen: number;
  collarLen: number;
  buttLen: number;
  sway: 0 | 1;
  upright?: boolean;
  tasselMode?: 'hang' | 'trail' | 'sweep' | 'whip-up';
  bladeWidthScale?: number;
}): string[] {
  const {
    width, height, tipX, tipY, buttX, buttY, bladeLen, collarLen, buttLen,
    sway, upright, tasselMode = 'hang', bladeWidthScale = 1,
  } = options;
  const grid = blankGrid(width, height);
  const dx = buttX - tipX;
  const dy = buttY - tipY;
  const totalLen = Math.hypot(dx, dy);
  const ux = dx / totalLen;
  const uy = dy / totalLen;
  let nx = -uy;
  let ny = ux;
  if (upright ? nx > 0 : ny > 0) { nx = -nx; ny = -ny; }

  const sampleAt = (t: number, off: number): [number, number] => [
    tipX + ux * t + nx * off,
    tipY + uy * t + ny * off,
  ];

  // 1. 纤细硬木枪杆（2px 核心）
  const shaftStart = bladeLen + collarLen;
  const shaftEnd = totalLen - buttLen;
  for (let s = shaftStart * 3; s <= shaftEnd * 3; s++) {
    const t = s / 3;
    const [bx, by] = sampleAt(t, -0.45);
    const [tx, ty] = sampleAt(t, 0.45);
    put(grid, bx, by, Math.floor(t) % 6 === 0 ? 'w' : 'W');
    put(grid, tx, ty, Math.floor(t) % 5 === 0 ? 'W' : 'u');
  }

  // 2. 枪尾铁镦（细长锥形钢镦）
  for (let s = shaftEnd * 3; s <= totalLen * 3; s++) {
    const t = s / 3;
    const frac = (t - shaftEnd) / Math.max(1, buttLen);
    const halfW = frac < 0.35 ? 0.85 : frac < 0.72 ? 0.5 : 0.15;
    for (let o = -halfW; o <= halfW; o += 0.35) {
      const [px, py] = sampleAt(t, o);
      const ch = o > 0.25 ? 'L' : o >= -0.15 ? 'M' : 'S';
      put(grid, px, py, ch);
    }
  }

  // 3. 修长柳叶枪头（前锐、中脊亮、后收束）
  for (let s = 0; s <= bladeLen * 4; s++) {
    const t = s / 4;
    const f = t / bladeLen;
    const baseHalfW = f < 0.18
      ? 0.2
      : f < 0.66
        ? 0.28 + ((f - 0.18) / 0.48) * 1.82
        : 2.1 - ((f - 0.66) / 0.34) * 1.25;
    const halfW = baseHalfW * bladeWidthScale;
    for (let o = -halfW; o <= halfW; o += 0.28) {
      const [px, py] = sampleAt(t, o);
      let ch: string;
      if (Math.abs(o) <= 0.38) ch = f < 0.86 ? 'H' : 'L';
      else if (o > 0) ch = o < halfW * 0.62 ? 'L' : 'M';
      else ch = -o < halfW * 0.58 ? 'M' : 'S';
      put(grid, px, py, ch);
    }
  }

  // 4. 金铜吞口箍
  for (let s = bladeLen * 3; s <= (bladeLen + collarLen) * 3; s++) {
    const t = s / 3;
    for (let o = -1.15; o <= 1.15; o += 0.38) {
      const [px, py] = sampleAt(t, o);
      put(grid, px, py, o > 0.05 ? 'G' : 'g');
    }
  }

  // 5. 红缨
  const [collarX, collarY] = sampleAt(bladeLen + collarLen * 0.55, 0);
  if (tasselMode === 'trail') {
    const trailStrands = [
      { off: -1.8, len: 8, spread: -0.25 },
      { off: 1.8, len: 9, spread: 0.28 },
      { off: -0.9, len: 6, spread: -0.15 },
      { off: 0.9, len: 7, spread: 0.15 },
    ];
    for (const strand of trailStrands) {
      for (let step = 0; step < strand.len; step++) {
        const [sx, sy] = sampleAt(bladeLen + collarLen + step * 1.15, strand.off + step * strand.spread);
        const ch = step < 2 ? 'P' : step < strand.len - 2 ? 'R' : 'r';
        put(grid, sx, sy, ch);
      }
    }
  } else if (tasselMode === 'sweep') {
    const sweepStrands = [
      { off: 1.4, len: 7, curve: 0.55 },
      { off: 2.3, len: 9, curve: 0.45 },
      { off: 3.1, len: 6, curve: 0.35 },
    ];
    for (const strand of sweepStrands) {
      for (let step = 0; step < strand.len; step++) {
        const [sx, sy] = sampleAt(bladeLen + collarLen + step * 0.95, strand.off + step * strand.curve);
        const ch = step < 2 ? 'P' : step < strand.len - 2 ? 'R' : 'r';
        put(grid, sx, sy, ch);
      }
    }
  } else if (tasselMode === 'whip-up') {
    // 纵劈砸地惯性：红缨向上后方猛烈扬起
    const bx = Math.round(collarX);
    const by = Math.round(collarY);
    const strands = [
      { ox: -1, oy: -1, len: 6, drift: 1 },
      { ox: 0, oy: -1, len: 8, drift: 1.5 },
      { ox: 1, oy: -1, len: 7, drift: 2 },
    ];
    for (const strand of strands) {
      for (let step = 0; step < strand.len; step++) {
        const sx = bx + strand.ox + Math.round(step * 0.45 * strand.drift);
        const sy = by + strand.oy - step;
        const ch = step < 2 ? 'P' : step < strand.len - 1 ? 'R' : 'r';
        put(grid, sx, sy, ch);
      }
    }
  } else {
    const bx = Math.round(collarX);
    const by = Math.round(collarY);
    const strands = upright
      ? [
          { ox: -2, oy: 1, len: 6, drift: -1 + sway },
          { ox: -1, oy: 1, len: 8, drift: sway },
          { ox: 1, oy: 1, len: 7, drift: sway },
          { ox: 2, oy: 2, len: 5, drift: 1 },
        ]
      : [
          { ox: -1, oy: 1, len: 5, drift: sway },
          { ox: 0, oy: 1, len: 8, drift: sway },
          { ox: 1, oy: 1, len: 6, drift: 1 + sway },
        ];
    for (const strand of strands) {
      for (let step = 0; step < strand.len; step++) {
        const bend = step >= 3 ? Math.round((step - 2) * 0.4 * strand.drift) : 0;
        const sx = bx + strand.ox + bend;
        const sy = by + strand.oy + step;
        const ch = step === 0 ? 'P' : step < 3 ? (strand.ox <= 0 ? 'P' : 'R') : step < strand.len - 1 ? 'R' : 'r';
        put(grid, sx, sy, ch);
      }
    }
  }

  // 6. 1px 清晰像素轮廓线
  applyOutline(grid, 'D', ch => ch === 'H' || ch === 'L' || ch === 'M' || ch === 'S');
  applyOutline(grid, 'K', ch => ch !== 'D');

  return toRows(grid);
}

export const SPEAR_SLICES: readonly PixelSliceSource[] = [
  // 0..5：基础待机与行走切片（保持既有索引不变）
  {
    id: 'spear-diag-0',
    label: '斜持长枪（红缨帧 1）',
    anchorX: 30,
    anchorY: 17,
    rows: buildAngledSpear({
      width: 48, height: 29,
      tipX: 2, tipY: 2, buttX: 45, buttY: 26,
      bladeLen: 14, collarLen: 2.2, buttLen: 4.5,
      sway: 0,
    }),
  },
  {
    id: 'spear-diag-1',
    label: '斜持长枪（红缨帧 2）',
    anchorX: 30,
    anchorY: 17,
    rows: buildAngledSpear({
      width: 48, height: 29,
      tipX: 2, tipY: 2, buttX: 45, buttY: 26,
      bladeLen: 14, collarLen: 2.2, buttLen: 4.5,
      sway: 1,
    }),
  },
  {
    id: 'spear-side-0',
    label: '侧身前指长枪（红缨帧 1）',
    anchorX: 29,
    anchorY: 10,
    rows: buildAngledSpear({
      width: 53, height: 22,
      tipX: 2, tipY: 3, buttX: 50, buttY: 16,
      bladeLen: 15, collarLen: 2.2, buttLen: 4.5,
      sway: 0,
    }),
  },
  {
    id: 'spear-side-1',
    label: '侧身前指长枪（红缨帧 2）',
    anchorX: 29,
    anchorY: 10,
    rows: buildAngledSpear({
      width: 53, height: 22,
      tipX: 2, tipY: 3, buttX: 50, buttY: 16,
      bladeLen: 15, collarLen: 2.2, buttLen: 4.5,
      sway: 1,
    }),
  },
  {
    id: 'spear-upright-0',
    label: '直立长枪（红缨帧 1）',
    anchorX: 9,
    anchorY: 38,
    rows: buildAngledSpear({
      width: 16, height: 52,
      tipX: 5, tipY: 2, buttX: 11, buttY: 49,
      bladeLen: 14, collarLen: 2.2, buttLen: 4.5,
      sway: 0, upright: true,
    }),
  },
  {
    id: 'spear-upright-1',
    label: '直立长枪（红缨帧 2）',
    anchorX: 9,
    anchorY: 38,
    rows: buildAngledSpear({
      width: 16, height: 52,
      tipX: 5, tipY: 2, buttX: 11, buttY: 49,
      bladeLen: 14, collarLen: 2.2, buttLen: 4.5,
      sway: 1, upright: true,
    }),
  },
  // 6..8：四向直刺专用切片
  {
    id: 'spear-thrust-west',
    label: '水平直刺长枪（西/东向）',
    anchorX: 33,
    anchorY: 7,
    rows: buildAngledSpear({
      width: 56, height: 15,
      tipX: 2, tipY: 7, buttX: 53, buttY: 7,
      bladeLen: 16, collarLen: 2.2, buttLen: 4.5,
      sway: 0, tasselMode: 'trail', bladeWidthScale: 1.05,
    }),
  },
  {
    id: 'spear-thrust-south',
    label: '南向直刺长枪（朝镜头突刺）',
    anchorX: 7,
    anchorY: 18,
    rows: buildAngledSpear({
      width: 15, height: 52,
      tipX: 7, tipY: 49, buttX: 7, buttY: 2,
      bladeLen: 16, collarLen: 2.2, buttLen: 4.5,
      sway: 0, upright: true, tasselMode: 'trail', bladeWidthScale: 1.1,
    }),
  },
  {
    id: 'spear-thrust-north',
    label: '北向直刺长枪（向北突刺）',
    anchorX: 7,
    anchorY: 34,
    rows: buildAngledSpear({
      width: 15, height: 52,
      tipX: 7, tipY: 2, buttX: 7, buttY: 49,
      bladeLen: 16, collarLen: 2.2, buttLen: 4.5,
      sway: 0, upright: true, tasselMode: 'trail', bladeWidthScale: 1.05,
    }),
  },
  // 9..11：横扫专用切片
  {
    id: 'spear-sweep-down-diag',
    label: '低斜横扫长枪（下斜锋）',
    anchorX: 30,
    anchorY: 11,
    rows: buildAngledSpear({
      width: 48, height: 29,
      tipX: 2, tipY: 26, buttX: 45, buttY: 2,
      bladeLen: 15, collarLen: 2.2, buttLen: 4.5,
      sway: 0, tasselMode: 'trail',
    }),
  },
  {
    id: 'spear-sweep-flat',
    label: '水平横扫长枪（红缨甩尾）',
    anchorX: 31,
    anchorY: 7,
    rows: buildAngledSpear({
      width: 56, height: 17,
      tipX: 2, tipY: 7, buttX: 53, buttY: 7,
      bladeLen: 15, collarLen: 2.2, buttLen: 4.5,
      sway: 0, tasselMode: 'sweep',
    }),
  },
  {
    id: 'spear-sweep-high-diag',
    label: '高斜蓄势长枪（上斜锋）',
    anchorX: 26,
    anchorY: 22,
    rows: buildAngledSpear({
      width: 42, height: 36,
      tipX: 3, tipY: 2, buttX: 38, buttY: 33,
      bladeLen: 15, collarLen: 2.2, buttLen: 4.5,
      sway: 0, tasselMode: 'trail',
    }),
  },
  // 12..13：伏龙震（力劈华山）专用下劈切片
  {
    id: 'spear-overhead-raise',
    label: '过顶高举长枪（下劈蓄势）',
    anchorX: 25,
    anchorY: 11,
    rows: buildAngledSpear({
      width: 53, height: 24,
      tipX: 49, tipY: 3, buttX: 2, buttY: 15,
      bladeLen: 15, collarLen: 2.2, buttLen: 4.5,
      sway: 0, tasselMode: 'hang',
    }),
  },
  {
    id: 'spear-slam-low',
    label: '砸地低横长枪（红缨上扬）',
    anchorX: 34,
    anchorY: 14,
    rows: buildAngledSpear({
      width: 56, height: 24,
      tipX: 2, tipY: 20, buttX: 53, buttY: 11,
      bladeLen: 15, collarLen: 2.2, buttLen: 4.5,
      sway: 0, tasselMode: 'whip-up',
    }),
  },
  // 14..17：虬龙扫暴阵「双侧侧面枪花」专用居中切片（长度收束至 ~68px，使枪尖与枪尾刚好收在左右立圆花环内，配合半透明残影不违和）
  {
    id: 'spear-windmill-horiz',
    label: '双侧枪花（居中水平 · 尖左尾右）',
    anchorX: 34,
    anchorY: 9,
    rows: buildAngledSpear({
      width: 68, height: 18,
      tipX: 2, tipY: 9, buttX: 65, buttY: 9,
      bladeLen: 15, collarLen: 2.2, buttLen: 5.5,
      sway: 0, tasselMode: 'sweep', bladeWidthScale: 1.0,
    }),
  },
  {
    id: 'spear-windmill-diag-low',
    label: '双侧枪花（居中低斜 22° · 上下摆动）',
    anchorX: 33,
    anchorY: 17,
    rows: buildAngledSpear({
      width: 66, height: 34,
      tipX: 2, tipY: 4, buttX: 63, buttY: 29,
      bladeLen: 15, collarLen: 2.2, buttLen: 5.5,
      sway: 0, tasselMode: 'sweep', bladeWidthScale: 1.0,
    }),
  },
  {
    id: 'spear-windmill-diag-steep',
    label: '双侧枪花（居中高斜 62°）',
    anchorX: 21,
    anchorY: 31,
    rows: buildAngledSpear({
      width: 42, height: 62,
      tipX: 5, tipY: 2, buttX: 36, buttY: 59,
      bladeLen: 15, collarLen: 2.2, buttLen: 5.5,
      sway: 1, tasselMode: 'trail', bladeWidthScale: 1.0,
    }),
  },
  {
    id: 'spear-windmill-vert',
    label: '双侧枪花（居中竖直 90°）',
    anchorX: 9,
    anchorY: 35,
    rows: buildAngledSpear({
      width: 18, height: 70,
      tipX: 9, tipY: 2, buttX: 9, buttY: 67,
      bladeLen: 15, collarLen: 2.2, buttLen: 5.5,
      sway: 0, upright: true, tasselMode: 'trail', bladeWidthScale: 1.0,
    }),
  },
];

export type SpearInsertMode =
  | 'front'
  | 'back'
  | 'replace-staff'
  | 'between-south-arms'
  | 'between-south-walk-arms'
  | 'between-west-arms'
  | 'before-front-hand';

export interface SpearPoseRecipe {
  id: string;
  clip: string;
  basePoseId: string;
  mirrorX: boolean;
  insertMode: SpearInsertMode;
  pieceEven: number;
  pieceOdd: number;
  swayPeriod?: number;
  baseX: number;
  baseY: number;
  stepDx?: readonly number[];
  stepDy?: readonly number[];
  scaleX: number;
  scaleY: number;
  angle: number;
}

export interface SpearKeyframeSpec {
  sourcePoseId: string;
  sourceFrame: number;
  piece: number;
  x: number;
  y: number;
  /** 可选：该帧将整个人物（含换装与长枪）一同平移，用于突进前探/微踏/旋转中轴归中。 */
  bodyDx?: number;
  bodyDy?: number;
  /** 可选：单帧水平镜像原版基础身体帧（用于 360° 旋枪时的东向干净身位）。 */
  mirrorBaseFrame?: boolean;
  scaleX?: number;
  scaleY?: number;
  angle?: number;
  /** 可选：武器透明度（用于高速舞枪花时虚化枪杆残影，避免实体硬杆显得违和）。 */
  alpha?: number;
  insertMode: SpearInsertMode;
}

export interface SpearKeyframedPoseRecipe {
  id: string;
  clip: string;
  mirrorX: boolean;
  frameRate: number;
  frames: readonly SpearKeyframeSpec[];
}

export const SPEAR_CYCLE_RECIPES: readonly SpearPoseRecipe[] = [
  // 一、双手斜持战斗待机
  {
    id: 'prototype-spear-idle-south', clip: 'idle-south', basePoseId: 'pose-4067-south-ticks-0',
    mirrorX: false, insertMode: 'between-south-arms', pieceEven: 0, pieceOdd: 1, baseX: 0, baseY: -8, scaleX: 1, scaleY: 1, angle: 0,
  },
  {
    id: 'prototype-spear-idle-west', clip: 'idle-west', basePoseId: 'pose-4068-west-ticks-0',
    mirrorX: false, insertMode: 'between-west-arms', pieceEven: 2, pieceOdd: 3, baseX: -3, baseY: -10, scaleX: 1, scaleY: 1, angle: 0,
  },
  {
    id: 'prototype-spear-idle-north', clip: 'idle-north', basePoseId: 'pose-4069-north-ticks-0',
    mirrorX: false, insertMode: 'back', pieceEven: 0, pieceOdd: 1, baseX: 1, baseY: -9, scaleX: -1, scaleY: 1, angle: 0,
  },
  {
    id: 'prototype-spear-idle-east', clip: 'idle-east', basePoseId: 'pose-4068-east-ticks-0',
    mirrorX: true, insertMode: 'between-west-arms', pieceEven: 2, pieceOdd: 3, baseX: -3, baseY: -10, scaleX: 1, scaleY: 1, angle: 0,
  },
  // 二、持枪行走
  {
    id: 'prototype-spear-walk-south', clip: 'walk-south', basePoseId: 'pose-4070-south-ticks-0',
    mirrorX: false, insertMode: 'between-south-walk-arms', pieceEven: 0, pieceOdd: 1, swayPeriod: 2,
    baseX: 1, baseY: -8, stepDx: [0, 0, -1, -1, 0, 0, 1, 1], scaleX: 1, scaleY: 1, angle: 0,
  },
  {
    id: 'prototype-spear-walk-west', clip: 'walk-west', basePoseId: 'pose-4071-west-ticks-0',
    mirrorX: false, insertMode: 'between-west-arms', pieceEven: 2, pieceOdd: 3, swayPeriod: 2,
    baseX: -4, baseY: -10, stepDx: [0, 0, -1, -1, 0, 0, 1, 1], scaleX: 1, scaleY: 1, angle: 0,
  },
  {
    id: 'prototype-spear-walk-north', clip: 'walk-north', basePoseId: 'pose-4072-north-ticks-0',
    mirrorX: false, insertMode: 'back', pieceEven: 0, pieceOdd: 1, swayPeriod: 2,
    baseX: 1, baseY: -9, stepDx: [0, 0, 1, 1, 0, 0, -1, -1], scaleX: -1, scaleY: 1, angle: 0,
  },
  {
    id: 'prototype-spear-walk-east', clip: 'walk-east', basePoseId: 'pose-4071-east-ticks-0',
    mirrorX: true, insertMode: 'between-west-arms', pieceEven: 2, pieceOdd: 3, swayPeriod: 2,
    baseX: -4, baseY: -10, stepDx: [0, 0, -1, -1, 0, 0, 1, 1], scaleX: 1, scaleY: 1, angle: 0,
  },
  // 三、立枪待机（单手直立对照）
  {
    id: 'prototype-spear-upright-idle-south', clip: 'spear-upright-idle-south', basePoseId: 'pose-4142-south-ticks-0',
    mirrorX: false, insertMode: 'replace-staff', pieceEven: 4, pieceOdd: 5, baseX: -9, baseY: -10, scaleX: 1, scaleY: 1, angle: 0,
  },
  {
    id: 'prototype-spear-upright-idle-west', clip: 'spear-upright-idle-west', basePoseId: 'pose-4143-west-ticks-0',
    mirrorX: false, insertMode: 'replace-staff', pieceEven: 4, pieceOdd: 5, baseX: -8, baseY: -10, scaleX: 1, scaleY: 1, angle: 0,
  },
  {
    id: 'prototype-spear-upright-idle-north', clip: 'spear-upright-idle-north', basePoseId: 'pose-4144-north-ticks-0',
    mirrorX: false, insertMode: 'replace-staff', pieceEven: 4, pieceOdd: 5, baseX: 11, baseY: -10, scaleX: -1, scaleY: 1, angle: 0,
  },
  {
    id: 'prototype-spear-upright-idle-east', clip: 'spear-upright-idle-east', basePoseId: 'pose-4143-east-ticks-0',
    mirrorX: true, insertMode: 'replace-staff', pieceEven: 4, pieceOdd: 5, baseX: -8, baseY: -10, scaleX: 1, scaleY: 1, angle: 0,
  },
];

const FPS = 50 / 3;

// ---------------------------------------------------------------------------
// 基础直刺 / 横扫原型（保留）
// ---------------------------------------------------------------------------

const THRUST_WEST_FRAMES: readonly SpearKeyframeSpec[] = [
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 2, x: -3, y: -10, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4062-west-ticks-0', sourceFrame: 0, piece: 6, x: 5, y: -11, insertMode: 'front' },
  { sourcePoseId: 'pose-4062-west-ticks-0', sourceFrame: 1, piece: 6, x: 10, y: -11, insertMode: 'front' },
  { sourcePoseId: 'pose-4062-west-ticks-0', sourceFrame: 2, piece: 6, x: -12, y: -11, insertMode: 'before-front-hand' },
  { sourcePoseId: 'pose-4062-west-ticks-0', sourceFrame: 2, piece: 6, x: -15, y: -11, insertMode: 'before-front-hand' },
  { sourcePoseId: 'pose-4062-west-ticks-0', sourceFrame: 2, piece: 6, x: -14, y: -11, insertMode: 'before-front-hand' },
  { sourcePoseId: 'pose-4062-west-ticks-0', sourceFrame: 3, piece: 6, x: -9, y: -11, insertMode: 'before-front-hand' },
  { sourcePoseId: 'pose-4062-west-ticks-0', sourceFrame: 3, piece: 6, x: -3, y: -11, insertMode: 'before-front-hand' },
  { sourcePoseId: 'pose-4062-west-ticks-0', sourceFrame: 4, piece: 2, x: -1, y: -10, insertMode: 'front' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 3, x: -3, y: -10, insertMode: 'between-west-arms' },
];

const THRUST_SOUTH_FRAMES: readonly SpearKeyframeSpec[] = [
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 0, piece: 0, x: 0, y: -8, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 0, piece: 7, x: -7, y: -12, insertMode: 'back' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 1, piece: 7, x: -7, y: -15, insertMode: 'back' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 2, piece: 7, x: -3, y: 4, insertMode: 'front' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 2, piece: 7, x: -3, y: 8, insertMode: 'front' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 2, piece: 7, x: -3, y: 7, insertMode: 'front' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 3, piece: 7, x: -3, y: 1, insertMode: 'front' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 3, piece: 7, x: -4, y: -5, insertMode: 'front' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 4, piece: 0, x: -1, y: -7, insertMode: 'front' },
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 0, piece: 1, x: 0, y: -8, insertMode: 'between-south-arms' },
];

const THRUST_NORTH_FRAMES: readonly SpearKeyframeSpec[] = [
  { sourcePoseId: 'pose-4069-north-ticks-0', sourceFrame: 0, piece: 0, x: 1, y: -9, scaleX: -1, insertMode: 'back' },
  { sourcePoseId: 'pose-4063-north-ticks-0', sourceFrame: 0, piece: 8, x: 0, y: -4, insertMode: 'back' },
  { sourcePoseId: 'pose-4063-north-ticks-0', sourceFrame: 1, piece: 8, x: 0, y: -1, insertMode: 'back' },
  { sourcePoseId: 'pose-4063-north-ticks-0', sourceFrame: 2, piece: 8, x: 0, y: -17, insertMode: 'back' },
  { sourcePoseId: 'pose-4063-north-ticks-0', sourceFrame: 2, piece: 8, x: 0, y: -20, insertMode: 'back' },
  { sourcePoseId: 'pose-4063-north-ticks-0', sourceFrame: 2, piece: 8, x: 0, y: -19, insertMode: 'back' },
  { sourcePoseId: 'pose-4063-north-ticks-0', sourceFrame: 3, piece: 8, x: 0, y: -13, insertMode: 'back' },
  { sourcePoseId: 'pose-4063-north-ticks-0', sourceFrame: 3, piece: 8, x: 0, y: -8, insertMode: 'back' },
  { sourcePoseId: 'pose-4063-north-ticks-0', sourceFrame: 4, piece: 0, x: 1, y: -9, scaleX: -1, insertMode: 'back' },
  { sourcePoseId: 'pose-4069-north-ticks-0', sourceFrame: 0, piece: 1, x: 1, y: -9, scaleX: -1, insertMode: 'back' },
];

const SWEEP_SOUTH_FRAMES: readonly SpearKeyframeSpec[] = [
  { sourcePoseId: 'pose-4073-south-ticks-0', sourceFrame: 0, piece: 0, x: -4, y: -11, insertMode: 'back' },
  { sourcePoseId: 'pose-4073-south-ticks-0', sourceFrame: 1, piece: 11, x: -7, y: -13, insertMode: 'back' },
  { sourcePoseId: 'pose-4073-south-ticks-0', sourceFrame: 2, piece: 11, x: -9, y: -10, insertMode: 'back' },
  { sourcePoseId: 'pose-4073-south-ticks-0', sourceFrame: 3, piece: 9, x: -6, y: -3, insertMode: 'front' },
  { sourcePoseId: 'pose-4073-south-ticks-0', sourceFrame: 4, piece: 9, x: 6, y: -3, scaleX: -1, insertMode: 'front' },
  { sourcePoseId: 'pose-4073-south-ticks-0', sourceFrame: 5, piece: 10, x: 10, y: -7, scaleX: -1, insertMode: 'front' },
  { sourcePoseId: 'pose-4073-south-ticks-0', sourceFrame: 6, piece: 2, x: 8, y: -9, scaleX: -1, insertMode: 'front' },
  { sourcePoseId: 'pose-4073-south-ticks-0', sourceFrame: 7, piece: 0, x: 5, y: -9, scaleX: -1, insertMode: 'front' },
  { sourcePoseId: 'pose-4073-south-ticks-0', sourceFrame: 8, piece: 11, x: 5, y: -11, scaleX: -1, insertMode: 'back' },
  { sourcePoseId: 'pose-4073-south-ticks-0', sourceFrame: 9, piece: 0, x: 2, y: -10, scaleX: -1, insertMode: 'back' },
  { sourcePoseId: 'pose-4073-south-ticks-0', sourceFrame: 10, piece: 0, x: 1, y: -9, insertMode: 'front' },
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 0, piece: 1, x: 0, y: -8, insertMode: 'between-south-arms' },
];

const SWEEP_WEST_FRAMES: readonly SpearKeyframeSpec[] = [
  { sourcePoseId: 'pose-4074-west-ticks-0', sourceFrame: 0, piece: 11, x: 3, y: -14, scaleX: -1, insertMode: 'back' },
  { sourcePoseId: 'pose-4074-west-ticks-0', sourceFrame: 1, piece: 4, x: 4, y: -15, insertMode: 'back' },
  { sourcePoseId: 'pose-4074-west-ticks-0', sourceFrame: 2, piece: 11, x: 0, y: -15, insertMode: 'front' },
  { sourcePoseId: 'pose-4074-west-ticks-0', sourceFrame: 3, piece: 11, x: -6, y: -13, insertMode: 'front' },
  { sourcePoseId: 'pose-4074-west-ticks-0', sourceFrame: 4, piece: 10, x: -12, y: -9, insertMode: 'front' },
  { sourcePoseId: 'pose-4074-west-ticks-0', sourceFrame: 5, piece: 9, x: -9, y: -6, insertMode: 'front' },
  { sourcePoseId: 'pose-4074-west-ticks-0', sourceFrame: 6, piece: 9, x: -8, y: -6, insertMode: 'front' },
  { sourcePoseId: 'pose-4074-west-ticks-0', sourceFrame: 7, piece: 2, x: -6, y: -8, insertMode: 'front' },
  { sourcePoseId: 'pose-4074-west-ticks-0', sourceFrame: 8, piece: 2, x: -4, y: -9, insertMode: 'front' },
  { sourcePoseId: 'pose-4074-west-ticks-0', sourceFrame: 9, piece: 3, x: -3, y: -10, insertMode: 'front' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 2, x: -3, y: -10, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 1, piece: 3, x: -3, y: -10, insertMode: 'between-west-arms' },
];

const SWEEP_NORTH_FRAMES: readonly SpearKeyframeSpec[] = [
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 0, piece: 0, x: 4, y: -10, scaleX: -1, insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 1, piece: 9, x: 6, y: -10, scaleX: -1, insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 2, piece: 11, x: 6, y: -12, scaleX: -1, insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 3, piece: 8, x: 2, y: -15, insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 4, piece: 10, x: -6, y: -16, insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 5, piece: 11, x: -8, y: -13, insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 6, piece: 0, x: -7, y: -10, insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 7, piece: 0, x: -5, y: -10, insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 8, piece: 11, x: -3, y: -12, insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 9, piece: 11, x: 1, y: -11, scaleX: -1, insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 10, piece: 0, x: 1, y: -10, scaleX: -1, insertMode: 'back' },
  { sourcePoseId: 'pose-4069-north-ticks-0', sourceFrame: 0, piece: 1, x: 1, y: -9, scaleX: -1, insertMode: 'back' },
];

// ---------------------------------------------------------------------------
// 第一批新增技能动作：
// 1. 普通攻击三段循环（attack 轻刺 8 帧 + attack-2 斜撩 7 帧 + attack-3 上挑 8 帧，无控制）
// 2. 旋风枪舞（skill-spin-storm，18 帧：基于原版 360° 旋风骨架 pose-4094 三整圈周身旋枪 + 末圈爆散收枪）
// 3. 狂龙穿心破（skill-dragon-pierce，12 帧：蓄力压身 → 10px 前探+残影+赤金重刺）
// 4. 伏龙震（skill-dragon-slam，11 帧：基于原版地面过顶劈 pose-4076..4078 力劈华山重砸）
// ---------------------------------------------------------------------------

// 1A. 普攻第一段 · 轻刺（8 帧，干脆敏捷，F3 出银光、F4 命中）
const ATK1_SOUTH_FRAMES: readonly SpearKeyframeSpec[] = [
  THRUST_SOUTH_FRAMES[0],
  THRUST_SOUTH_FRAMES[1],
  THRUST_SOUTH_FRAMES[3],
  THRUST_SOUTH_FRAMES[4],
  THRUST_SOUTH_FRAMES[6],
  THRUST_SOUTH_FRAMES[7],
  THRUST_SOUTH_FRAMES[8],
  THRUST_SOUTH_FRAMES[9],
];
const ATK1_WEST_FRAMES: readonly SpearKeyframeSpec[] = [
  THRUST_WEST_FRAMES[0],
  THRUST_WEST_FRAMES[1],
  THRUST_WEST_FRAMES[3],
  THRUST_WEST_FRAMES[4],
  THRUST_WEST_FRAMES[6],
  THRUST_WEST_FRAMES[7],
  THRUST_WEST_FRAMES[8],
  THRUST_WEST_FRAMES[9],
];
const ATK1_NORTH_FRAMES: readonly SpearKeyframeSpec[] = [
  THRUST_NORTH_FRAMES[0],
  THRUST_NORTH_FRAMES[1],
  THRUST_NORTH_FRAMES[3],
  THRUST_NORTH_FRAMES[4],
  THRUST_NORTH_FRAMES[6],
  THRUST_NORTH_FRAMES[7],
  THRUST_NORTH_FRAMES[8],
  THRUST_NORTH_FRAMES[9],
];

// 1B. 普攻第二段 · 斜撩（7 帧，截取横扫中段去头去尾加速斜拨，F3 出小月牙拨光）
const ATK2_SOUTH_FRAMES: readonly SpearKeyframeSpec[] = [
  SWEEP_SOUTH_FRAMES[2],
  SWEEP_SOUTH_FRAMES[3],
  SWEEP_SOUTH_FRAMES[4],
  SWEEP_SOUTH_FRAMES[5],
  SWEEP_SOUTH_FRAMES[6],
  SWEEP_SOUTH_FRAMES[10],
  SWEEP_SOUTH_FRAMES[11],
];
const ATK2_WEST_FRAMES: readonly SpearKeyframeSpec[] = [
  SWEEP_WEST_FRAMES[2],
  SWEEP_WEST_FRAMES[3],
  SWEEP_WEST_FRAMES[4],
  SWEEP_WEST_FRAMES[5],
  SWEEP_WEST_FRAMES[7],
  SWEEP_WEST_FRAMES[9],
  SWEEP_WEST_FRAMES[10],
];
const ATK2_NORTH_FRAMES: readonly SpearKeyframeSpec[] = [
  SWEEP_NORTH_FRAMES[2],
  SWEEP_NORTH_FRAMES[3],
  SWEEP_NORTH_FRAMES[4],
  SWEEP_NORTH_FRAMES[5],
  SWEEP_NORTH_FRAMES[7],
  SWEEP_NORTH_FRAMES[10],
  SWEEP_NORTH_FRAMES[11],
];

// 1C. 普攻第三段 · 上挑（8 帧，不产生控制：压低蓄挑 → 由下而上迅猛挑起 → 高空微顿 → 顺势回落，全四向无悬空手）
const ATK3_WEST_FRAMES: readonly SpearKeyframeSpec[] = [
  // F0：战姿微沉
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 2, x: -3, y: -10, insertMode: 'between-west-arms' },
  // F1：压低深蹲，枪尖贴地蓄挑
  { sourcePoseId: 'pose-4080-west-ticks-0', sourceFrame: 3, piece: 13, x: -4, y: -2, insertMode: 'front' },
  // F2：迅猛起挑破空（触发 3 帧素银上挑弧光 spear-basic-lift）
  { sourcePoseId: 'pose-4080-west-ticks-0', sourceFrame: 4, piece: 2, x: -7, y: -9, insertMode: 'front' },
  // F3：挑枪命中帧（双手高举，枪尖斜挑高空，无控制）
  { sourcePoseId: 'pose-4080-west-ticks-0', sourceFrame: 5, piece: 11, x: -8, y: -16, insertMode: 'front' },
  // F4：挑势顶点微顿
  { sourcePoseId: 'pose-4080-west-ticks-0', sourceFrame: 6, piece: 11, x: -6, y: -21, insertMode: 'front' },
  // F5..F7：顺势回落归回战姿
  { sourcePoseId: 'pose-4080-west-ticks-0', sourceFrame: 7, piece: 11, x: -5, y: -16, insertMode: 'front' },
  { sourcePoseId: 'pose-4080-west-ticks-0', sourceFrame: 10, piece: 2, x: -4, y: -10, insertMode: 'front' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 3, x: -3, y: -10, insertMode: 'between-west-arms' },
];

const ATK3_SOUTH_FRAMES: readonly SpearKeyframeSpec[] = [
  // F0：战姿微沉
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 0, piece: 0, x: 0, y: -8, insertMode: 'between-south-arms' },
  // F1：深蹲低手，南向压低枪尖蓄挑
  { sourcePoseId: 'pose-4076-south-ticks-0', sourceFrame: 4, piece: 7, x: -1, y: -1, insertMode: 'front' },
  // F2：由下向上起挑破空（F2 触发素银上挑弧光）
  { sourcePoseId: 'pose-4076-south-ticks-0', sourceFrame: 0, piece: 2, x: 5, y: -8, scaleX: -1, insertMode: 'front' },
  // F3：挑枪命中帧（双手扬起，枪尖高挑斜上）
  { sourcePoseId: 'pose-4076-south-ticks-0', sourceFrame: 1, piece: 11, x: 5, y: -15, scaleX: -1, insertMode: 'front' },
  // F4：挑势顶点高扬微顿
  { sourcePoseId: 'pose-4076-south-ticks-0', sourceFrame: 2, piece: 11, x: 3, y: -20, scaleX: -1, insertMode: 'front' },
  // F5..F7：顺势收枪归位
  { sourcePoseId: 'pose-4076-south-ticks-0', sourceFrame: 1, piece: 11, x: 4, y: -14, scaleX: -1, insertMode: 'front' },
  { sourcePoseId: 'pose-4076-south-ticks-0', sourceFrame: 0, piece: 0, x: 1, y: -8, insertMode: 'front' },
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 0, piece: 1, x: 0, y: -8, insertMode: 'between-south-arms' },
];

const ATK3_NORTH_FRAMES: readonly SpearKeyframeSpec[] = [
  // F0：战姿微沉
  { sourcePoseId: 'pose-4069-north-ticks-0', sourceFrame: 0, piece: 0, x: 1, y: -9, scaleX: -1, insertMode: 'back' },
  // F1：背身深蹲压低蓄挑
  { sourcePoseId: 'pose-4078-north-ticks-0', sourceFrame: 4, piece: 8, x: 0, y: -4, insertMode: 'back' },
  // F2：起身斜右上挑破空（枪尖紧贴北向挑弧起势，F2 触发素银上挑弧光）
  { sourcePoseId: 'pose-4081-north-ticks-0', sourceFrame: 5, piece: 11, x: 3, y: -13, scaleX: -1, insertMode: 'back' },
  // F3：挑枪命中帧（双臂高举、枪尖高挑向北上方）
  { sourcePoseId: 'pose-4078-north-ticks-0', sourceFrame: 1, piece: 8, x: 0, y: -23, insertMode: 'back' },
  // F4：挑势顶点微顿
  { sourcePoseId: 'pose-4078-north-ticks-0', sourceFrame: 2, piece: 8, x: 0, y: -26, insertMode: 'back' },
  // F5..F7：顺势回落归回战姿
  { sourcePoseId: 'pose-4078-north-ticks-0', sourceFrame: 1, piece: 11, x: 1, y: -17, scaleX: -1, insertMode: 'back' },
  { sourcePoseId: 'pose-4078-north-ticks-0', sourceFrame: 0, piece: 0, x: 1, y: -10, scaleX: -1, insertMode: 'back' },
  { sourcePoseId: 'pose-4069-north-ticks-0', sourceFrame: 0, piece: 1, x: 1, y: -9, scaleX: -1, insertMode: 'back' },
];

// 2. 旋风枪舞（18 帧：2 帧沉腰起转 → 12 帧三整圈 360° 周身疾旋 → 1 帧归位爆散终结 → 3 帧稳步收枪）
// 四个正方向旋转帧均选用四肢完全贴身、无悬空手套的原版高动态帧，并做中轴归中：
// - 南向：pose-4094 f3（低身前倾）；西/东向：pose-4074 f5 及其镜像（双手平端疾扫）；北向：pose-4075 f4（背身回旋，枪走 back 层）
const SPIN_CARDINAL_S: SpearKeyframeSpec = {
  sourcePoseId: 'pose-4094-south-ticks-24', sourceFrame: 3, piece: 7, x: -1, y: -4, bodyDx: 0, insertMode: 'front',
};
const SPIN_CARDINAL_E: SpearKeyframeSpec = {
  sourcePoseId: 'pose-4074-west-ticks-0', sourceFrame: 5, mirrorBaseFrame: true, piece: 10, x: 14, y: -11, scaleX: -1, bodyDx: -2, insertMode: 'front',
};
const SPIN_CARDINAL_N: SpearKeyframeSpec = {
  sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 4, piece: 8, x: 0, y: -11, bodyDx: 0, insertMode: 'back',
};
const SPIN_CARDINAL_W: SpearKeyframeSpec = {
  sourcePoseId: 'pose-4074-west-ticks-0', sourceFrame: 5, piece: 10, x: -14, y: -11, scaleX: 1, bodyDx: 2, insertMode: 'front',
};

const SPIN_STORM_SOUTH_FRAMES: readonly SpearKeyframeSpec[] = [
  // F0..F1：沉腰拧枪起转
  { sourcePoseId: 'pose-4094-south-ticks-24', sourceFrame: 0, piece: 0, x: -2, y: -9, insertMode: 'front' },
  { sourcePoseId: 'pose-4094-south-ticks-24', sourceFrame: 2, piece: 9, x: -4, y: -6, insertMode: 'front' },
  // F2..F13：三整圈高速 360° 逆时针旋枪（南 → 东 → 北 → 西 × 3）
  SPIN_CARDINAL_S, SPIN_CARDINAL_E, SPIN_CARDINAL_N, SPIN_CARDINAL_W,
  SPIN_CARDINAL_S, SPIN_CARDINAL_E, SPIN_CARDINAL_N, SPIN_CARDINAL_W,
  SPIN_CARDINAL_S, SPIN_CARDINAL_E, SPIN_CARDINAL_N, SPIN_CARDINAL_W,
  // F14：收满三圈归位南向 + 360° 气浪爆散终结
  SPIN_CARDINAL_S,
  // F15..F17：顺势减速收枪回南向战姿（无悬空手）
  { sourcePoseId: 'pose-4073-south-ticks-0', sourceFrame: 10, piece: 9, x: 1, y: -8, scaleX: -1, bodyDx: -1, insertMode: 'front' },
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 0, piece: 0, x: 0, y: -8, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 1, piece: 1, x: 0, y: -8, insertMode: 'between-south-arms' },
];

const SPIN_STORM_WEST_FRAMES: readonly SpearKeyframeSpec[] = [
  // F0..F1：低身平枪蓄势起转（西向起步，东向镜像后自动从东向起步）
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 2, x: -3, y: -10, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4062-west-ticks-0', sourceFrame: 4, piece: 10, x: -6, y: -11, bodyDx: 1, insertMode: 'front' },
  // F2..F13：三整圈高速 360° 旋枪（西 → 南 → 东 → 北 × 3）
  SPIN_CARDINAL_W, SPIN_CARDINAL_S, SPIN_CARDINAL_E, SPIN_CARDINAL_N,
  SPIN_CARDINAL_W, SPIN_CARDINAL_S, SPIN_CARDINAL_E, SPIN_CARDINAL_N,
  SPIN_CARDINAL_W, SPIN_CARDINAL_S, SPIN_CARDINAL_E, SPIN_CARDINAL_N,
  // F14：收满三圈归位西向 + 360° 气浪爆散终结
  SPIN_CARDINAL_W,
  // F15..F17：顺势减速收枪回西向战姿
  { sourcePoseId: 'pose-4062-west-ticks-0', sourceFrame: 4, piece: 9, x: -5, y: -9, bodyDx: 1, insertMode: 'front' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 2, x: -3, y: -10, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 1, piece: 3, x: -3, y: -10, insertMode: 'between-west-arms' },
];

const SPIN_STORM_NORTH_FRAMES: readonly SpearKeyframeSpec[] = [
  // F0..F1：沉腰拧枪起转
  { sourcePoseId: 'pose-4069-north-ticks-0', sourceFrame: 0, piece: 0, x: 1, y: -9, scaleX: -1, insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 1, piece: 11, x: 4, y: -11, scaleX: -1, insertMode: 'back' },
  // F2..F13：三整圈高速 360° 旋枪（北 → 西 → 南 → 东 × 3）
  SPIN_CARDINAL_N, SPIN_CARDINAL_W, SPIN_CARDINAL_S, SPIN_CARDINAL_E,
  SPIN_CARDINAL_N, SPIN_CARDINAL_W, SPIN_CARDINAL_S, SPIN_CARDINAL_E,
  SPIN_CARDINAL_N, SPIN_CARDINAL_W, SPIN_CARDINAL_S, SPIN_CARDINAL_E,
  // F14：收满三圈归位北向 + 360° 气浪爆散终结
  SPIN_CARDINAL_N,
  // F15..F17：顺势减速收枪回北向战姿
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 8, piece: 11, x: -4, y: -12, bodyDx: 4, insertMode: 'back' },
  { sourcePoseId: 'pose-4069-north-ticks-0', sourceFrame: 0, piece: 0, x: 1, y: -9, scaleX: -1, insertMode: 'back' },
  { sourcePoseId: 'pose-4069-north-ticks-0', sourceFrame: 1, piece: 1, x: 1, y: -9, scaleX: -1, insertMode: 'back' },
];

// 3. 狂龙穿心破 · 蛟龙出海（12 帧：4 帧低重心蓄力 → 10px 前探滑步 + 2 枚残影 + 赤金破甲重刺 → 缓步回防）
const DRAGON_PIERCE_WEST_FRAMES: readonly SpearKeyframeSpec[] = [
  // F0..F3：压低重心后拉长蓄力（拉长 3 帧紧绷感）
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 2, x: -2, y: -10, bodyDx: 1, bodyDy: 0, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4062-west-ticks-0', sourceFrame: 0, piece: 6, x: 6, y: -10, bodyDx: 2, bodyDy: 1, insertMode: 'front' },
  { sourcePoseId: 'pose-4062-west-ticks-0', sourceFrame: 1, piece: 6, x: 11, y: -10, bodyDx: 3, bodyDy: 1, insertMode: 'front' },
  { sourcePoseId: 'pose-4062-west-ticks-0', sourceFrame: 1, piece: 6, x: 12, y: -10, bodyDx: 3, bodyDy: 2, insertMode: 'front' },
  // F4..F6：蛟龙出海前探突刺（整个人物前探 -10px + 2 枚半透明残影 + 赤金破甲芒爆发！）
  { sourcePoseId: 'pose-4062-west-ticks-0', sourceFrame: 2, piece: 6, x: -13, y: -11, bodyDx: -8, bodyDy: 0, insertMode: 'before-front-hand' },
  { sourcePoseId: 'pose-4062-west-ticks-0', sourceFrame: 2, piece: 6, x: -16, y: -11, bodyDx: -10, bodyDy: 0, insertMode: 'before-front-hand' },
  { sourcePoseId: 'pose-4062-west-ticks-0', sourceFrame: 2, piece: 6, x: -15, y: -11, bodyDx: -10, bodyDy: 0, insertMode: 'before-front-hand' },
  // F7..F11：强顿帧后缓步撤回原位
  { sourcePoseId: 'pose-4062-west-ticks-0', sourceFrame: 3, piece: 6, x: -11, y: -11, bodyDx: -8, bodyDy: 0, insertMode: 'before-front-hand' },
  { sourcePoseId: 'pose-4062-west-ticks-0', sourceFrame: 3, piece: 6, x: -6, y: -11, bodyDx: -5, bodyDy: 0, insertMode: 'before-front-hand' },
  { sourcePoseId: 'pose-4062-west-ticks-0', sourceFrame: 4, piece: 2, x: -2, y: -10, bodyDx: -2, bodyDy: 0, insertMode: 'front' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 2, x: -3, y: -10, bodyDx: -1, bodyDy: 0, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 3, x: -3, y: -10, bodyDx: 0, bodyDy: 0, insertMode: 'between-west-arms' },
];

const DRAGON_PIERCE_SOUTH_FRAMES: readonly SpearKeyframeSpec[] = [
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 0, piece: 0, x: 0, y: -8, bodyDx: 0, bodyDy: -1, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 0, piece: 7, x: -7, y: -12, bodyDx: 0, bodyDy: -2, insertMode: 'back' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 1, piece: 7, x: -7, y: -16, bodyDx: 0, bodyDy: -3, insertMode: 'back' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 1, piece: 7, x: -7, y: -17, bodyDx: 0, bodyDy: -3, insertMode: 'back' },
  // 前探向南 +10px 突刺
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 2, piece: 7, x: -3, y: 4, bodyDx: 0, bodyDy: 8, insertMode: 'front' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 2, piece: 7, x: -3, y: 8, bodyDx: 0, bodyDy: 10, insertMode: 'front' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 2, piece: 7, x: -3, y: 7, bodyDx: 0, bodyDy: 10, insertMode: 'front' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 3, piece: 7, x: -3, y: 2, bodyDx: 0, bodyDy: 8, insertMode: 'front' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 3, piece: 7, x: -4, y: -4, bodyDx: 0, bodyDy: 5, insertMode: 'front' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 4, piece: 0, x: -1, y: -7, bodyDx: 0, bodyDy: 2, insertMode: 'front' },
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 0, piece: 0, x: 0, y: -8, bodyDx: 0, bodyDy: 1, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 0, piece: 1, x: 0, y: -8, bodyDx: 0, bodyDy: 0, insertMode: 'between-south-arms' },
];

const DRAGON_PIERCE_NORTH_FRAMES: readonly SpearKeyframeSpec[] = [
  { sourcePoseId: 'pose-4069-north-ticks-0', sourceFrame: 0, piece: 0, x: 1, y: -9, scaleX: -1, bodyDx: 0, bodyDy: 1, insertMode: 'back' },
  { sourcePoseId: 'pose-4063-north-ticks-0', sourceFrame: 0, piece: 8, x: 0, y: -4, bodyDx: 0, bodyDy: 2, insertMode: 'back' },
  { sourcePoseId: 'pose-4063-north-ticks-0', sourceFrame: 1, piece: 8, x: 0, y: -1, bodyDx: 0, bodyDy: 3, insertMode: 'back' },
  { sourcePoseId: 'pose-4063-north-ticks-0', sourceFrame: 1, piece: 8, x: 0, y: 0, bodyDx: 0, bodyDy: 3, insertMode: 'back' },
  // 前探向北 -10px 突刺
  { sourcePoseId: 'pose-4063-north-ticks-0', sourceFrame: 2, piece: 8, x: 0, y: -17, bodyDx: 0, bodyDy: -8, insertMode: 'back' },
  { sourcePoseId: 'pose-4063-north-ticks-0', sourceFrame: 2, piece: 8, x: 0, y: -20, bodyDx: 0, bodyDy: -10, insertMode: 'back' },
  { sourcePoseId: 'pose-4063-north-ticks-0', sourceFrame: 2, piece: 8, x: 0, y: -19, bodyDx: 0, bodyDy: -10, insertMode: 'back' },
  { sourcePoseId: 'pose-4063-north-ticks-0', sourceFrame: 3, piece: 8, x: 0, y: -13, bodyDx: 0, bodyDy: -8, insertMode: 'back' },
  { sourcePoseId: 'pose-4063-north-ticks-0', sourceFrame: 3, piece: 8, x: 0, y: -8, bodyDx: 0, bodyDy: -5, insertMode: 'back' },
  { sourcePoseId: 'pose-4063-north-ticks-0', sourceFrame: 4, piece: 0, x: 1, y: -9, scaleX: -1, bodyDx: 0, bodyDy: -2, insertMode: 'back' },
  { sourcePoseId: 'pose-4069-north-ticks-0', sourceFrame: 0, piece: 0, x: 1, y: -9, scaleX: -1, bodyDx: 0, bodyDy: -1, insertMode: 'back' },
  { sourcePoseId: 'pose-4069-north-ticks-0', sourceFrame: 0, piece: 1, x: 1, y: -9, scaleX: -1, bodyDx: 0, bodyDy: 0, insertMode: 'back' },
];

// 4. 伏龙震 · 力劈华山（11 帧，基于地面过顶纵劈 pose-4076..4078，F4 起纵劈弧光、F5 砸地顿帧震屏+眩晕）
const DRAGON_SLAM_WEST_FRAMES: readonly SpearKeyframeSpec[] = [
  // F0..F2：双手高举长枪过顶蓄势
  { sourcePoseId: 'pose-4077-west-ticks-0', sourceFrame: 0, piece: 12, x: 1, y: -26, insertMode: 'back' },
  { sourcePoseId: 'pose-4077-west-ticks-0', sourceFrame: 1, piece: 12, x: 2, y: -29, insertMode: 'back' },
  { sourcePoseId: 'pose-4077-west-ticks-0', sourceFrame: 2, piece: 12, x: 3, y: -30, insertMode: 'back' },
  // F3：抡圆下压加速（F3 触发纵劈弧光）
  { sourcePoseId: 'pose-4077-west-ticks-0', sourceFrame: 3, piece: 11, x: -6, y: -18, insertMode: 'front' },
  // F4..F6：当头重砸落地微蹲 + 顿帧停枪（F4 命中+震屏+地面震波+眩晕）
  { sourcePoseId: 'pose-4077-west-ticks-0', sourceFrame: 4, piece: 13, x: -7, y: -4, insertMode: 'front' },
  { sourcePoseId: 'pose-4077-west-ticks-0', sourceFrame: 5, piece: 13, x: -7, y: -3, insertMode: 'front' },
  { sourcePoseId: 'pose-4077-west-ticks-0', sourceFrame: 6, piece: 13, x: -6, y: -4, insertMode: 'front' },
  // F7..F10：提枪起身回防
  { sourcePoseId: 'pose-4077-west-ticks-0', sourceFrame: 7, piece: 9, x: -6, y: -7, insertMode: 'front' },
  { sourcePoseId: 'pose-4077-west-ticks-0', sourceFrame: 8, piece: 2, x: -5, y: -9, insertMode: 'front' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 2, x: -3, y: -10, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 1, piece: 3, x: -3, y: -10, insertMode: 'between-west-arms' },
];

const DRAGON_SLAM_SOUTH_FRAMES: readonly SpearKeyframeSpec[] = [
  // F0..F2：双手举枪过顶右上方蓄力
  { sourcePoseId: 'pose-4076-south-ticks-0', sourceFrame: 0, piece: 12, x: 3, y: -26, insertMode: 'back' },
  { sourcePoseId: 'pose-4076-south-ticks-0', sourceFrame: 1, piece: 12, x: 5, y: -29, insertMode: 'back' },
  { sourcePoseId: 'pose-4076-south-ticks-0', sourceFrame: 2, piece: 12, x: 5, y: -30, insertMode: 'back' },
  // F3：竖直劈落切下
  { sourcePoseId: 'pose-4076-south-ticks-0', sourceFrame: 3, piece: 7, x: 1, y: -14, insertMode: 'front' },
  // F4..F6：重砸前方地面深蹲顿枪（枪尖拍砸南向落点！）
  { sourcePoseId: 'pose-4076-south-ticks-0', sourceFrame: 4, piece: 7, x: -1, y: 5, insertMode: 'front' },
  { sourcePoseId: 'pose-4076-south-ticks-0', sourceFrame: 5, piece: 7, x: -1, y: 6, insertMode: 'front' },
  { sourcePoseId: 'pose-4076-south-ticks-0', sourceFrame: 6, piece: 7, x: -1, y: 4, insertMode: 'front' },
  // F7..F10：拉枪起身归位
  { sourcePoseId: 'pose-4076-south-ticks-0', sourceFrame: 7, piece: 9, x: -2, y: -4, insertMode: 'front' },
  { sourcePoseId: 'pose-4076-south-ticks-0', sourceFrame: 8, piece: 0, x: -1, y: -7, insertMode: 'front' },
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 0, piece: 0, x: 0, y: -8, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 1, piece: 1, x: 0, y: -8, insertMode: 'between-south-arms' },
];

const DRAGON_SLAM_NORTH_FRAMES: readonly SpearKeyframeSpec[] = [
  // F0..F2：高举过顶蓄力
  { sourcePoseId: 'pose-4078-north-ticks-0', sourceFrame: 0, piece: 12, x: -1, y: -27, scaleX: -1, insertMode: 'back' },
  { sourcePoseId: 'pose-4078-north-ticks-0', sourceFrame: 1, piece: 12, x: 0, y: -30, scaleX: -1, insertMode: 'back' },
  { sourcePoseId: 'pose-4078-north-ticks-0', sourceFrame: 2, piece: 12, x: 0, y: -31, scaleX: -1, insertMode: 'back' },
  // F3：下压纵劈向北
  { sourcePoseId: 'pose-4078-north-ticks-0', sourceFrame: 3, piece: 8, x: 0, y: -22, insertMode: 'back' },
  // F4..F6：重砸北向地面深蹲顿枪
  { sourcePoseId: 'pose-4078-north-ticks-0', sourceFrame: 4, piece: 8, x: 0, y: -19, insertMode: 'back' },
  { sourcePoseId: 'pose-4078-north-ticks-0', sourceFrame: 5, piece: 8, x: 0, y: -18, insertMode: 'back' },
  { sourcePoseId: 'pose-4078-north-ticks-0', sourceFrame: 6, piece: 8, x: 0, y: -17, insertMode: 'back' },
  // F7..F10：起身回防
  { sourcePoseId: 'pose-4078-north-ticks-0', sourceFrame: 7, piece: 11, x: 1, y: -12, scaleX: -1, insertMode: 'back' },
  { sourcePoseId: 'pose-4078-north-ticks-0', sourceFrame: 8, piece: 0, x: 1, y: -10, scaleX: -1, insertMode: 'back' },
  { sourcePoseId: 'pose-4069-north-ticks-0', sourceFrame: 0, piece: 0, x: 1, y: -9, scaleX: -1, insertMode: 'back' },
  { sourcePoseId: 'pose-4069-north-ticks-0', sourceFrame: 1, piece: 1, x: 1, y: -9, scaleX: -1, insertMode: 'back' },
];

// ---------------------------------------------------------------------------
// 第二批新增技能与完整补齐：
// 5. 虬龙扫暴阵（skill-whirl-sweep，16 帧：4 帧舞枪花前奏 + 12 帧大横扫 + 180° 狂风枪芒）
// 6. 连环点枪（skill-flurry-thrust，17 帧：前 8 帧半伸微颤暴雨梨花针芒 + 2 帧缩枪蓄劲 + 7 帧微踏定音主刺）
// 7. 万圣龙王破（skill-sovereign-pierce，19 帧：6 帧旋枪引气 + 3 帧沉腰凝势 + 10 帧 1.6 倍螺旋龙枪芒，无黑屏）
// 8. 3 个自身增益共用立枪聚气动作（skill-focus-edge / skill-dragon-step / skill-gale-stance，12 帧）
// 9. 长枪战斗阵亡动作（spear-die，23 帧：枪脱手翻转落地 + 角色倒地）
// ---------------------------------------------------------------------------

// 5. 虬龙扫暴阵 · 双侧侧面竖椭圆枪花（方案 C，柔和高速残影枪杆）+ 朝向 180° 大横扫（16 帧）
// 前 6 帧长枪居中横跨并随左右两枚侧面竖椭圆枪花高速上下摆动，F1..F4 枪身虚化为轻柔残影（alpha 0.26~0.34）绝不违和；
// F0..F2 枪尖在左/枪尾在右，F3..F5 翻腕互换（枪尖在右/枪尾在左），随后 F6..F15 恢复实体无缝接朝向 180° 狂风大横扫。
const WHIRL_SWEEP_SOUTH_FRAMES: readonly SpearKeyframeSpec[] = [
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 0, piece: 15, x: 0, y: -12, scaleX: 1, scaleY: 1, alpha: 0.56, insertMode: 'front' },
  { sourcePoseId: 'pose-4094-south-ticks-24', sourceFrame: 3, piece: 15, x: 0, y: -12, scaleX: 1, scaleY: -1, alpha: 0.26, insertMode: 'front' },
  { sourcePoseId: 'pose-4094-south-ticks-24', sourceFrame: 3, piece: 14, x: 0, y: -12, scaleX: 1, scaleY: 1, alpha: 0.34, insertMode: 'front' },
  { sourcePoseId: 'pose-4094-south-ticks-24', sourceFrame: 3, piece: 15, x: 0, y: -12, scaleX: -1, scaleY: 1, alpha: 0.26, insertMode: 'front' },
  { sourcePoseId: 'pose-4094-south-ticks-24', sourceFrame: 3, piece: 14, x: 0, y: -12, scaleX: -1, scaleY: 1, alpha: 0.34, insertMode: 'front' },
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 0, piece: 15, x: 0, y: -12, scaleX: -1, scaleY: -1, alpha: 0.58, insertMode: 'front' },
  // F6：实体恢复抽把切入南向大横扫起势 → F7..F15 甩出南向 180° 狂风大扫
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 0, piece: 11, x: -7, y: -11, insertMode: 'back' },
  ...SWEEP_SOUTH_FRAMES.slice(3),
];

const WHIRL_SWEEP_WEST_FRAMES: readonly SpearKeyframeSpec[] = [
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 15, x: 0, y: -12, scaleX: 1, scaleY: 1, alpha: 0.56, insertMode: 'front' },
  { sourcePoseId: 'pose-4062-west-ticks-0', sourceFrame: 4, piece: 15, x: -2, y: -12, scaleX: 1, scaleY: -1, bodyDx: 2, alpha: 0.26, insertMode: 'front' },
  { sourcePoseId: 'pose-4074-west-ticks-0', sourceFrame: 5, piece: 14, x: -2, y: -12, scaleX: 1, scaleY: 1, bodyDx: 2, alpha: 0.34, insertMode: 'front' },
  { sourcePoseId: 'pose-4062-west-ticks-0', sourceFrame: 4, piece: 15, x: -2, y: -12, scaleX: -1, scaleY: 1, bodyDx: 2, alpha: 0.26, insertMode: 'front' },
  { sourcePoseId: 'pose-4074-west-ticks-0', sourceFrame: 5, piece: 14, x: -2, y: -12, scaleX: -1, scaleY: 1, bodyDx: 2, alpha: 0.34, insertMode: 'front' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 15, x: 0, y: -12, scaleX: -1, scaleY: -1, alpha: 0.58, insertMode: 'front' },
  // F6：实体恢复抽枪高举过渡 → F7..F15 无缝接西向 180° 狂风大横扫
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 11, x: -1, y: -14, insertMode: 'front' },
  ...SWEEP_WEST_FRAMES.slice(3),
];

const WHIRL_SWEEP_NORTH_FRAMES: readonly SpearKeyframeSpec[] = [
  { sourcePoseId: 'pose-4069-north-ticks-0', sourceFrame: 0, piece: 15, x: 0, y: -12, scaleX: 1, scaleY: 1, alpha: 0.56, insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 4, piece: 15, x: 0, y: -12, scaleX: 1, scaleY: -1, alpha: 0.26, insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 4, piece: 14, x: 0, y: -12, scaleX: 1, scaleY: 1, alpha: 0.34, insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 4, piece: 15, x: 0, y: -12, scaleX: -1, scaleY: 1, alpha: 0.26, insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 4, piece: 14, x: 0, y: -12, scaleX: -1, scaleY: 1, alpha: 0.34, insertMode: 'back' },
  { sourcePoseId: 'pose-4069-north-ticks-0', sourceFrame: 0, piece: 15, x: 0, y: -12, scaleX: -1, scaleY: -1, alpha: 0.58, insertMode: 'back' },
  // F6..F15：无缝接北向 180° 狂风大横扫
  ...SWEEP_NORTH_FRAMES.slice(2),
];

// 6. 连环点枪 · 暴雨梨花枪（17 帧 ≈ 1.02s：前 8 帧定半伸微抖乱刺 + 2 帧缩枪蓄劲 + 7 帧微踏全力定音）
const FLURRY_WEST_FRAMES: readonly SpearKeyframeSpec[] = [
  // F0：起手微沉
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 2, x: -3, y: -10, insertMode: 'between-west-arms' },
  // F1..F8：前 0.5s 定在直刺半伸态（微颤 2~3px，靠扇形暴雨梨花针芒打前两段 30% + 30%）
  { sourcePoseId: 'pose-4062-west-ticks-0', sourceFrame: 2, piece: 6, x: -8, y: -11, insertMode: 'before-front-hand' },
  { sourcePoseId: 'pose-4062-west-ticks-0', sourceFrame: 2, piece: 6, x: -11, y: -12, insertMode: 'before-front-hand' },
  { sourcePoseId: 'pose-4062-west-ticks-0', sourceFrame: 2, piece: 6, x: -7, y: -10, insertMode: 'before-front-hand' },
  { sourcePoseId: 'pose-4062-west-ticks-0', sourceFrame: 2, piece: 6, x: -11, y: -11, insertMode: 'before-front-hand' },
  { sourcePoseId: 'pose-4062-west-ticks-0', sourceFrame: 2, piece: 6, x: -8, y: -12, insertMode: 'before-front-hand' },
  { sourcePoseId: 'pose-4062-west-ticks-0', sourceFrame: 2, piece: 6, x: -12, y: -10, insertMode: 'before-front-hand' },
  { sourcePoseId: 'pose-4062-west-ticks-0', sourceFrame: 2, piece: 6, x: -7, y: -11, insertMode: 'before-front-hand' },
  { sourcePoseId: 'pose-4062-west-ticks-0', sourceFrame: 3, piece: 6, x: -9, y: -11, insertMode: 'before-front-hand' },
  // F9..F10：短促缩枪蓄劲 2 帧（疾 → 顿）
  { sourcePoseId: 'pose-4062-west-ticks-0', sourceFrame: 0, piece: 6, x: 5, y: -11, bodyDx: 1, insertMode: 'front' },
  { sourcePoseId: 'pose-4062-west-ticks-0', sourceFrame: 1, piece: 6, x: 10, y: -11, bodyDx: 2, insertMode: 'front' },
  // F11..F13：微踏一步全力伸展刺出第 3 段（破！40%，F11 出定音主刺芒、F12 命中+震屏）
  { sourcePoseId: 'pose-4062-west-ticks-0', sourceFrame: 2, piece: 6, x: -14, y: -11, bodyDx: -4, insertMode: 'before-front-hand' },
  { sourcePoseId: 'pose-4062-west-ticks-0', sourceFrame: 2, piece: 6, x: -16, y: -11, bodyDx: -5, insertMode: 'before-front-hand' },
  { sourcePoseId: 'pose-4062-west-ticks-0', sourceFrame: 2, piece: 6, x: -15, y: -11, bodyDx: -4, insertMode: 'before-front-hand' },
  // F14..F16：利落收势回防
  { sourcePoseId: 'pose-4062-west-ticks-0', sourceFrame: 3, piece: 6, x: -7, y: -11, bodyDx: -2, insertMode: 'before-front-hand' },
  { sourcePoseId: 'pose-4062-west-ticks-0', sourceFrame: 4, piece: 2, x: -2, y: -10, bodyDx: -1, insertMode: 'front' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 3, x: -3, y: -10, bodyDx: 0, insertMode: 'between-west-arms' },
];

const FLURRY_SOUTH_FRAMES: readonly SpearKeyframeSpec[] = [
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 0, piece: 0, x: 0, y: -8, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 2, piece: 7, x: -4, y: 1, insertMode: 'front' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 2, piece: 7, x: -2, y: 5, insertMode: 'front' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 2, piece: 7, x: -4, y: 0, insertMode: 'front' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 2, piece: 7, x: -3, y: 5, insertMode: 'front' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 2, piece: 7, x: -2, y: 1, insertMode: 'front' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 2, piece: 7, x: -4, y: 6, insertMode: 'front' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 2, piece: 7, x: -3, y: 1, insertMode: 'front' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 3, piece: 7, x: -3, y: 2, insertMode: 'front' },
  // 缩枪蓄劲
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 0, piece: 7, x: -7, y: -12, bodyDy: -1, insertMode: 'back' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 1, piece: 7, x: -7, y: -16, bodyDy: -2, insertMode: 'back' },
  // 微踏定音第 3 刺
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 2, piece: 7, x: -3, y: 5, bodyDy: 4, insertMode: 'front' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 2, piece: 7, x: -3, y: 9, bodyDy: 5, insertMode: 'front' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 2, piece: 7, x: -3, y: 8, bodyDy: 4, insertMode: 'front' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 3, piece: 7, x: -3, y: 1, bodyDy: 2, insertMode: 'front' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 4, piece: 0, x: -1, y: -7, bodyDy: 1, insertMode: 'front' },
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 0, piece: 1, x: 0, y: -8, bodyDy: 0, insertMode: 'between-south-arms' },
];

const FLURRY_NORTH_FRAMES: readonly SpearKeyframeSpec[] = [
  { sourcePoseId: 'pose-4069-north-ticks-0', sourceFrame: 0, piece: 0, x: 1, y: -9, scaleX: -1, insertMode: 'back' },
  { sourcePoseId: 'pose-4063-north-ticks-0', sourceFrame: 2, piece: 8, x: -1, y: -14, insertMode: 'back' },
  { sourcePoseId: 'pose-4063-north-ticks-0', sourceFrame: 2, piece: 8, x: 1, y: -18, insertMode: 'back' },
  { sourcePoseId: 'pose-4063-north-ticks-0', sourceFrame: 2, piece: 8, x: -1, y: -13, insertMode: 'back' },
  { sourcePoseId: 'pose-4063-north-ticks-0', sourceFrame: 2, piece: 8, x: 0, y: -18, insertMode: 'back' },
  { sourcePoseId: 'pose-4063-north-ticks-0', sourceFrame: 2, piece: 8, x: 1, y: -14, insertMode: 'back' },
  { sourcePoseId: 'pose-4063-north-ticks-0', sourceFrame: 2, piece: 8, x: -1, y: -19, insertMode: 'back' },
  { sourcePoseId: 'pose-4063-north-ticks-0', sourceFrame: 2, piece: 8, x: 0, y: -14, insertMode: 'back' },
  { sourcePoseId: 'pose-4063-north-ticks-0', sourceFrame: 3, piece: 8, x: 0, y: -15, insertMode: 'back' },
  // 缩枪蓄劲
  { sourcePoseId: 'pose-4063-north-ticks-0', sourceFrame: 0, piece: 8, x: 0, y: -4, bodyDy: 1, insertMode: 'back' },
  { sourcePoseId: 'pose-4063-north-ticks-0', sourceFrame: 1, piece: 8, x: 0, y: -1, bodyDy: 2, insertMode: 'back' },
  // 微踏定音第 3 刺
  { sourcePoseId: 'pose-4063-north-ticks-0', sourceFrame: 2, piece: 8, x: 0, y: -18, bodyDy: -4, insertMode: 'back' },
  { sourcePoseId: 'pose-4063-north-ticks-0', sourceFrame: 2, piece: 8, x: 0, y: -21, bodyDy: -5, insertMode: 'back' },
  { sourcePoseId: 'pose-4063-north-ticks-0', sourceFrame: 2, piece: 8, x: 0, y: -20, bodyDy: -4, insertMode: 'back' },
  { sourcePoseId: 'pose-4063-north-ticks-0', sourceFrame: 3, piece: 8, x: 0, y: -13, bodyDy: -2, insertMode: 'back' },
  { sourcePoseId: 'pose-4063-north-ticks-0', sourceFrame: 4, piece: 0, x: 1, y: -9, scaleX: -1, bodyDy: -1, insertMode: 'back' },
  { sourcePoseId: 'pose-4069-north-ticks-0', sourceFrame: 0, piece: 1, x: 1, y: -9, scaleX: -1, bodyDy: 0, insertMode: 'back' },
];

// 7. 万圣龙王破 · 怒龙穿心（19 帧，无黑屏：6 帧盘枪引气 → 3 帧沉腰凝势 → 10 帧 1.6 倍螺旋龙枪芒贯出）
const SOVEREIGN_WEST_FRAMES: readonly SpearKeyframeSpec[] = [
  // F0..F5：盘枪引气（快播横扫关键帧旋枪聚气）
  SWEEP_WEST_FRAMES[0],
  SWEEP_WEST_FRAMES[1],
  SWEEP_WEST_FRAMES[3],
  SWEEP_WEST_FRAMES[4],
  SWEEP_WEST_FRAMES[5],
  SWEEP_WEST_FRAMES[7],
  // F6..F8：沉腰收枪凝势（3 帧蓄力紧绷，无黑屏）
  { sourcePoseId: 'pose-4062-west-ticks-0', sourceFrame: 0, piece: 6, x: 7, y: -10, bodyDx: 2, bodyDy: 1, insertMode: 'front' },
  { sourcePoseId: 'pose-4062-west-ticks-0', sourceFrame: 1, piece: 6, x: 12, y: -10, bodyDx: 3, bodyDy: 2, insertMode: 'front' },
  { sourcePoseId: 'pose-4062-west-ticks-0', sourceFrame: 1, piece: 6, x: 11, y: -10, bodyDx: 3, bodyDy: 2, insertMode: 'front' },
  // F9..F15：化龙贯出！（前探 -6px + 残影 + 1.6 倍蓝青螺旋龙枪芒 F9~F15 + 强震屏）
  { sourcePoseId: 'pose-4062-west-ticks-0', sourceFrame: 2, piece: 6, x: -13, y: -11, bodyDx: -5, insertMode: 'before-front-hand' },
  { sourcePoseId: 'pose-4062-west-ticks-0', sourceFrame: 2, piece: 6, x: -16, y: -11, bodyDx: -6, insertMode: 'before-front-hand' },
  { sourcePoseId: 'pose-4062-west-ticks-0', sourceFrame: 2, piece: 6, x: -16, y: -11, bodyDx: -6, insertMode: 'before-front-hand' },
  { sourcePoseId: 'pose-4062-west-ticks-0', sourceFrame: 2, piece: 6, x: -15, y: -11, bodyDx: -6, insertMode: 'before-front-hand' },
  { sourcePoseId: 'pose-4062-west-ticks-0', sourceFrame: 3, piece: 6, x: -12, y: -11, bodyDx: -5, insertMode: 'before-front-hand' },
  { sourcePoseId: 'pose-4062-west-ticks-0', sourceFrame: 3, piece: 6, x: -9, y: -11, bodyDx: -4, insertMode: 'before-front-hand' },
  { sourcePoseId: 'pose-4062-west-ticks-0', sourceFrame: 3, piece: 6, x: -5, y: -11, bodyDx: -3, insertMode: 'before-front-hand' },
  // F16..F18：沉稳收枪回防
  { sourcePoseId: 'pose-4062-west-ticks-0', sourceFrame: 4, piece: 2, x: -2, y: -10, bodyDx: -2, insertMode: 'front' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 2, x: -3, y: -10, bodyDx: -1, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 3, x: -3, y: -10, bodyDx: 0, insertMode: 'between-west-arms' },
];

const SOVEREIGN_SOUTH_FRAMES: readonly SpearKeyframeSpec[] = [
  SWEEP_SOUTH_FRAMES[0],
  SWEEP_SOUTH_FRAMES[2],
  SWEEP_SOUTH_FRAMES[3],
  SWEEP_SOUTH_FRAMES[4],
  SWEEP_SOUTH_FRAMES[5],
  SWEEP_SOUTH_FRAMES[7],
  // 沉腰凝势
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 0, piece: 7, x: -7, y: -13, bodyDy: -2, insertMode: 'back' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 1, piece: 7, x: -7, y: -17, bodyDy: -3, insertMode: 'back' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 1, piece: 7, x: -7, y: -16, bodyDy: -3, insertMode: 'back' },
  // 化龙贯出
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 2, piece: 7, x: -3, y: 4, bodyDy: 5, insertMode: 'front' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 2, piece: 7, x: -3, y: 8, bodyDy: 6, insertMode: 'front' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 2, piece: 7, x: -3, y: 8, bodyDy: 6, insertMode: 'front' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 2, piece: 7, x: -3, y: 7, bodyDy: 6, insertMode: 'front' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 3, piece: 7, x: -3, y: 3, bodyDy: 5, insertMode: 'front' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 3, piece: 7, x: -3, y: 0, bodyDy: 4, insertMode: 'front' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 3, piece: 7, x: -4, y: -4, bodyDy: 3, insertMode: 'front' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 4, piece: 0, x: -1, y: -7, bodyDy: 2, insertMode: 'front' },
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 0, piece: 0, x: 0, y: -8, bodyDy: 1, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 0, piece: 1, x: 0, y: -8, bodyDy: 0, insertMode: 'between-south-arms' },
];

const SOVEREIGN_NORTH_FRAMES: readonly SpearKeyframeSpec[] = [
  SWEEP_NORTH_FRAMES[0],
  SWEEP_NORTH_FRAMES[2],
  SWEEP_NORTH_FRAMES[3],
  SWEEP_NORTH_FRAMES[4],
  SWEEP_NORTH_FRAMES[5],
  SWEEP_NORTH_FRAMES[7],
  // 沉腰凝势
  { sourcePoseId: 'pose-4063-north-ticks-0', sourceFrame: 0, piece: 8, x: 0, y: -4, bodyDy: 2, insertMode: 'back' },
  { sourcePoseId: 'pose-4063-north-ticks-0', sourceFrame: 1, piece: 8, x: 0, y: -1, bodyDy: 3, insertMode: 'back' },
  { sourcePoseId: 'pose-4063-north-ticks-0', sourceFrame: 1, piece: 8, x: 0, y: -2, bodyDy: 3, insertMode: 'back' },
  // 化龙贯出
  { sourcePoseId: 'pose-4063-north-ticks-0', sourceFrame: 2, piece: 8, x: 0, y: -17, bodyDy: -5, insertMode: 'back' },
  { sourcePoseId: 'pose-4063-north-ticks-0', sourceFrame: 2, piece: 8, x: 0, y: -20, bodyDy: -6, insertMode: 'back' },
  { sourcePoseId: 'pose-4063-north-ticks-0', sourceFrame: 2, piece: 8, x: 0, y: -20, bodyDy: -6, insertMode: 'back' },
  { sourcePoseId: 'pose-4063-north-ticks-0', sourceFrame: 2, piece: 8, x: 0, y: -19, bodyDy: -6, insertMode: 'back' },
  { sourcePoseId: 'pose-4063-north-ticks-0', sourceFrame: 3, piece: 8, x: 0, y: -15, bodyDy: -5, insertMode: 'back' },
  { sourcePoseId: 'pose-4063-north-ticks-0', sourceFrame: 3, piece: 8, x: 0, y: -12, bodyDy: -4, insertMode: 'back' },
  { sourcePoseId: 'pose-4063-north-ticks-0', sourceFrame: 3, piece: 8, x: 0, y: -8, bodyDy: -3, insertMode: 'back' },
  { sourcePoseId: 'pose-4063-north-ticks-0', sourceFrame: 4, piece: 0, x: 1, y: -9, scaleX: -1, bodyDy: -2, insertMode: 'back' },
  { sourcePoseId: 'pose-4069-north-ticks-0', sourceFrame: 0, piece: 0, x: 1, y: -9, scaleX: -1, bodyDy: -1, insertMode: 'back' },
  { sourcePoseId: 'pose-4069-north-ticks-0', sourceFrame: 0, piece: 1, x: 1, y: -9, scaleX: -1, bodyDy: 0, insertMode: 'back' },
];

// 8. 3 个自身增益共用立枪聚气动作（12 帧，基于原版战吼 pose-3977..3979，立枪顿地聚气、红缨随风猎猎飘动）
const BUFF_CAST_SOUTH_FRAMES: readonly SpearKeyframeSpec[] = [
  { sourcePoseId: 'pose-3977-south-ticks-16', sourceFrame: 0, piece: 4, x: -9, y: -12, insertMode: 'front' },
  { sourcePoseId: 'pose-3977-south-ticks-16', sourceFrame: 1, piece: 4, x: -9, y: -13, insertMode: 'front' },
  { sourcePoseId: 'pose-3977-south-ticks-16', sourceFrame: 2, piece: 4, x: -9, y: -10, insertMode: 'front' },
  { sourcePoseId: 'pose-3977-south-ticks-16', sourceFrame: 3, piece: 5, x: -9, y: -10, insertMode: 'front' },
  { sourcePoseId: 'pose-3977-south-ticks-16', sourceFrame: 4, piece: 4, x: -9, y: -10, insertMode: 'front' },
  { sourcePoseId: 'pose-3977-south-ticks-16', sourceFrame: 5, piece: 5, x: -9, y: -10, insertMode: 'front' },
  { sourcePoseId: 'pose-3977-south-ticks-16', sourceFrame: 6, piece: 4, x: -9, y: -10, insertMode: 'front' },
  { sourcePoseId: 'pose-3977-south-ticks-16', sourceFrame: 7, piece: 5, x: -9, y: -10, insertMode: 'front' },
  { sourcePoseId: 'pose-3977-south-ticks-16', sourceFrame: 8, piece: 4, x: -9, y: -10, insertMode: 'front' },
  { sourcePoseId: 'pose-3977-south-ticks-16', sourceFrame: 9, piece: 5, x: -9, y: -10, insertMode: 'front' },
  { sourcePoseId: 'pose-3977-south-ticks-16', sourceFrame: 1, piece: 4, x: -8, y: -10, insertMode: 'front' },
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 0, piece: 0, x: 0, y: -8, insertMode: 'between-south-arms' },
];

const BUFF_CAST_WEST_FRAMES: readonly SpearKeyframeSpec[] = [
  { sourcePoseId: 'pose-3978-west-ticks-16', sourceFrame: 0, piece: 4, x: -8, y: -12, insertMode: 'front' },
  { sourcePoseId: 'pose-3978-west-ticks-16', sourceFrame: 1, piece: 4, x: -8, y: -13, insertMode: 'front' },
  { sourcePoseId: 'pose-3978-west-ticks-16', sourceFrame: 2, piece: 4, x: -8, y: -10, insertMode: 'front' },
  { sourcePoseId: 'pose-3978-west-ticks-16', sourceFrame: 3, piece: 5, x: -8, y: -10, insertMode: 'front' },
  { sourcePoseId: 'pose-3978-west-ticks-16', sourceFrame: 4, piece: 4, x: -8, y: -10, insertMode: 'front' },
  { sourcePoseId: 'pose-3978-west-ticks-16', sourceFrame: 5, piece: 5, x: -8, y: -10, insertMode: 'front' },
  { sourcePoseId: 'pose-3978-west-ticks-16', sourceFrame: 6, piece: 4, x: -8, y: -10, insertMode: 'front' },
  { sourcePoseId: 'pose-3978-west-ticks-16', sourceFrame: 7, piece: 5, x: -8, y: -10, insertMode: 'front' },
  { sourcePoseId: 'pose-3978-west-ticks-16', sourceFrame: 8, piece: 4, x: -8, y: -10, insertMode: 'front' },
  { sourcePoseId: 'pose-3978-west-ticks-16', sourceFrame: 9, piece: 5, x: -8, y: -10, insertMode: 'front' },
  { sourcePoseId: 'pose-3978-west-ticks-16', sourceFrame: 1, piece: 4, x: -7, y: -10, insertMode: 'front' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 2, x: -3, y: -10, insertMode: 'between-west-arms' },
];

const BUFF_CAST_NORTH_FRAMES: readonly SpearKeyframeSpec[] = [
  { sourcePoseId: 'pose-3979-north-ticks-16', sourceFrame: 0, piece: 4, x: 10, y: -12, scaleX: -1, insertMode: 'back' },
  { sourcePoseId: 'pose-3979-north-ticks-16', sourceFrame: 1, piece: 4, x: 10, y: -13, scaleX: -1, insertMode: 'back' },
  { sourcePoseId: 'pose-3979-north-ticks-16', sourceFrame: 2, piece: 4, x: 10, y: -10, scaleX: -1, insertMode: 'back' },
  { sourcePoseId: 'pose-3979-north-ticks-16', sourceFrame: 3, piece: 5, x: 10, y: -10, scaleX: -1, insertMode: 'back' },
  { sourcePoseId: 'pose-3979-north-ticks-16', sourceFrame: 4, piece: 4, x: 10, y: -10, scaleX: -1, insertMode: 'back' },
  { sourcePoseId: 'pose-3979-north-ticks-16', sourceFrame: 5, piece: 5, x: 10, y: -10, scaleX: -1, insertMode: 'back' },
  { sourcePoseId: 'pose-3979-north-ticks-16', sourceFrame: 6, piece: 4, x: 10, y: -10, scaleX: -1, insertMode: 'back' },
  { sourcePoseId: 'pose-3979-north-ticks-16', sourceFrame: 7, piece: 5, x: 10, y: -10, scaleX: -1, insertMode: 'back' },
  { sourcePoseId: 'pose-3979-north-ticks-16', sourceFrame: 8, piece: 4, x: 10, y: -10, scaleX: -1, insertMode: 'back' },
  { sourcePoseId: 'pose-3979-north-ticks-16', sourceFrame: 9, piece: 5, x: 10, y: -10, scaleX: -1, insertMode: 'back' },
  { sourcePoseId: 'pose-3979-north-ticks-16', sourceFrame: 1, piece: 4, x: 9, y: -10, scaleX: -1, insertMode: 'back' },
  { sourcePoseId: 'pose-4069-north-ticks-0', sourceFrame: 0, piece: 0, x: 1, y: -9, scaleX: -1, insertMode: 'back' },
];

// 9. 长枪战斗阵亡动作（23 帧，基于原版 pose-3964-south-ticks-0：受创失手 → 长枪翻转砸地弹跳 → 英雄倒地）
const DIE_SPEAR_FRAMES: readonly SpearKeyframeSpec[] = [
  { sourcePoseId: 'pose-3964-south-ticks-0', sourceFrame: 0, piece: 0, x: 0, y: -10, insertMode: 'front' },
  { sourcePoseId: 'pose-3964-south-ticks-0', sourceFrame: 1, piece: 11, x: -3, y: -14, insertMode: 'front' },
  { sourcePoseId: 'pose-3964-south-ticks-0', sourceFrame: 2, piece: 4, x: -6, y: -18, insertMode: 'back' },
  { sourcePoseId: 'pose-3964-south-ticks-0', sourceFrame: 3, piece: 12, x: -8, y: -14, insertMode: 'back' },
  { sourcePoseId: 'pose-3964-south-ticks-0', sourceFrame: 4, piece: 9, x: -10, y: -5, insertMode: 'back' },
  { sourcePoseId: 'pose-3964-south-ticks-0', sourceFrame: 5, piece: 6, x: -12, y: 5, insertMode: 'back' },
  { sourcePoseId: 'pose-3964-south-ticks-0', sourceFrame: 6, piece: 2, x: -13, y: 2, insertMode: 'back' },
  { sourcePoseId: 'pose-3964-south-ticks-0', sourceFrame: 7, piece: 6, x: -13, y: 6, insertMode: 'back' },
  ...Array.from({ length: 15 }, (_, idx): SpearKeyframeSpec => ({
    sourcePoseId: 'pose-3964-south-ticks-0',
    sourceFrame: 8 + idx,
    piece: 6,
    x: -13,
    y: 6,
    insertMode: 'back',
  })),
];

export const SPEAR_ACTION_RECIPES: readonly SpearKeyframedPoseRecipe[] = [
  // 基础原型对照（直刺 / 横扫）
  { id: 'prototype-spear-thrust-south', clip: 'thrust-south', mirrorX: false, frameRate: FPS, frames: THRUST_SOUTH_FRAMES },
  { id: 'prototype-spear-thrust-west', clip: 'thrust-west', mirrorX: false, frameRate: FPS, frames: THRUST_WEST_FRAMES },
  { id: 'prototype-spear-thrust-north', clip: 'thrust-north', mirrorX: false, frameRate: FPS, frames: THRUST_NORTH_FRAMES },
  { id: 'prototype-spear-thrust-east', clip: 'thrust-east', mirrorX: true, frameRate: FPS, frames: THRUST_WEST_FRAMES },
  { id: 'prototype-spear-sweep-south', clip: 'sweep-south', mirrorX: false, frameRate: FPS, frames: SWEEP_SOUTH_FRAMES },
  { id: 'prototype-spear-sweep-west', clip: 'sweep-west', mirrorX: false, frameRate: FPS, frames: SWEEP_WEST_FRAMES },
  { id: 'prototype-spear-sweep-north', clip: 'sweep-north', mirrorX: false, frameRate: FPS, frames: SWEEP_NORTH_FRAMES },
  { id: 'prototype-spear-sweep-east', clip: 'sweep-east', mirrorX: true, frameRate: FPS, frames: SWEEP_WEST_FRAMES },

  // 普通攻击三段循环（A 轻刺 → AA 斜撩 → AAA 上挑，无控制）
  { id: 'prototype-spear-attack-south', clip: 'attack-south', mirrorX: false, frameRate: FPS, frames: ATK1_SOUTH_FRAMES },
  { id: 'prototype-spear-attack-west', clip: 'attack-west', mirrorX: false, frameRate: FPS, frames: ATK1_WEST_FRAMES },
  { id: 'prototype-spear-attack-north', clip: 'attack-north', mirrorX: false, frameRate: FPS, frames: ATK1_NORTH_FRAMES },
  { id: 'prototype-spear-attack-east', clip: 'attack-east', mirrorX: true, frameRate: FPS, frames: ATK1_WEST_FRAMES },
  { id: 'prototype-spear-attack-2-south', clip: 'attack-2-south', mirrorX: false, frameRate: FPS, frames: ATK2_SOUTH_FRAMES },
  { id: 'prototype-spear-attack-2-west', clip: 'attack-2-west', mirrorX: false, frameRate: FPS, frames: ATK2_WEST_FRAMES },
  { id: 'prototype-spear-attack-2-north', clip: 'attack-2-north', mirrorX: false, frameRate: FPS, frames: ATK2_NORTH_FRAMES },
  { id: 'prototype-spear-attack-2-east', clip: 'attack-2-east', mirrorX: true, frameRate: FPS, frames: ATK2_WEST_FRAMES },
  { id: 'prototype-spear-attack-3-south', clip: 'attack-3-south', mirrorX: false, frameRate: FPS, frames: ATK3_SOUTH_FRAMES },
  { id: 'prototype-spear-attack-3-west', clip: 'attack-3-west', mirrorX: false, frameRate: FPS, frames: ATK3_WEST_FRAMES },
  { id: 'prototype-spear-attack-3-north', clip: 'attack-3-north', mirrorX: false, frameRate: FPS, frames: ATK3_NORTH_FRAMES },
  { id: 'prototype-spear-attack-3-east', clip: 'attack-3-east', mirrorX: true, frameRate: FPS, frames: ATK3_WEST_FRAMES },

  // 主动伤害技能 1：狂龙穿心破（蓄力前探残影 + 赤金破甲重刺）
  { id: 'prototype-spear-skill-dragon-pierce-south', clip: 'skill-dragon-pierce-south', mirrorX: false, frameRate: FPS, frames: DRAGON_PIERCE_SOUTH_FRAMES },
  { id: 'prototype-spear-skill-dragon-pierce-west', clip: 'skill-dragon-pierce-west', mirrorX: false, frameRate: FPS, frames: DRAGON_PIERCE_WEST_FRAMES },
  { id: 'prototype-spear-skill-dragon-pierce-north', clip: 'skill-dragon-pierce-north', mirrorX: false, frameRate: FPS, frames: DRAGON_PIERCE_NORTH_FRAMES },
  { id: 'prototype-spear-skill-dragon-pierce-east', clip: 'skill-dragon-pierce-east', mirrorX: true, frameRate: FPS, frames: DRAGON_PIERCE_WEST_FRAMES },

  // 主动伤害技能 2：虬龙扫暴阵（4 帧银白枪花 + 12 帧大横扫 + 180° 狂风枪芒）
  { id: 'prototype-spear-skill-whirl-sweep-south', clip: 'skill-whirl-sweep-south', mirrorX: false, frameRate: FPS, frames: WHIRL_SWEEP_SOUTH_FRAMES },
  { id: 'prototype-spear-skill-whirl-sweep-west', clip: 'skill-whirl-sweep-west', mirrorX: false, frameRate: FPS, frames: WHIRL_SWEEP_WEST_FRAMES },
  { id: 'prototype-spear-skill-whirl-sweep-north', clip: 'skill-whirl-sweep-north', mirrorX: false, frameRate: FPS, frames: WHIRL_SWEEP_NORTH_FRAMES },
  { id: 'prototype-spear-skill-whirl-sweep-east', clip: 'skill-whirl-sweep-east', mirrorX: true, frameRate: FPS, frames: WHIRL_SWEEP_WEST_FRAMES },

  // 主动伤害技能 3：旋风枪舞（18 帧：三整圈 360° 周身旋枪 + 末圈爆散收枪）
  { id: 'prototype-spear-skill-spin-storm-south', clip: 'skill-spin-storm-south', mirrorX: false, frameRate: FPS, frames: SPIN_STORM_SOUTH_FRAMES },
  { id: 'prototype-spear-skill-spin-storm-west', clip: 'skill-spin-storm-west', mirrorX: false, frameRate: FPS, frames: SPIN_STORM_WEST_FRAMES },
  { id: 'prototype-spear-skill-spin-storm-north', clip: 'skill-spin-storm-north', mirrorX: false, frameRate: FPS, frames: SPIN_STORM_NORTH_FRAMES },
  { id: 'prototype-spear-skill-spin-storm-east', clip: 'skill-spin-storm-east', mirrorX: true, frameRate: FPS, frames: SPIN_STORM_WEST_FRAMES },

  // 主动伤害技能 4：连环点枪（暴雨梨花扇形针芒乱刺 + 第 3 段定音主刺）
  { id: 'prototype-spear-skill-flurry-thrust-south', clip: 'skill-flurry-thrust-south', mirrorX: false, frameRate: FPS, frames: FLURRY_SOUTH_FRAMES },
  { id: 'prototype-spear-skill-flurry-thrust-west', clip: 'skill-flurry-thrust-west', mirrorX: false, frameRate: FPS, frames: FLURRY_WEST_FRAMES },
  { id: 'prototype-spear-skill-flurry-thrust-north', clip: 'skill-flurry-thrust-north', mirrorX: false, frameRate: FPS, frames: FLURRY_NORTH_FRAMES },
  { id: 'prototype-spear-skill-flurry-thrust-east', clip: 'skill-flurry-thrust-east', mirrorX: true, frameRate: FPS, frames: FLURRY_WEST_FRAMES },

  // 主动伤害技能 5：伏龙震（力劈华山高举重砸 + 暗金纵劈弧光 + 眩晕）
  { id: 'prototype-spear-skill-dragon-slam-south', clip: 'skill-dragon-slam-south', mirrorX: false, frameRate: FPS, frames: DRAGON_SLAM_SOUTH_FRAMES },
  { id: 'prototype-spear-skill-dragon-slam-west', clip: 'skill-dragon-slam-west', mirrorX: false, frameRate: FPS, frames: DRAGON_SLAM_WEST_FRAMES },
  { id: 'prototype-spear-skill-dragon-slam-north', clip: 'skill-dragon-slam-north', mirrorX: false, frameRate: FPS, frames: DRAGON_SLAM_NORTH_FRAMES },
  { id: 'prototype-spear-skill-dragon-slam-east', clip: 'skill-dragon-slam-east', mirrorX: true, frameRate: FPS, frames: DRAGON_SLAM_WEST_FRAMES },

  // 主动伤害技能 6：万圣龙王破（盘枪引气 + 沉腰凝势 + 1.6 倍螺旋龙枪芒，无黑屏）
  { id: 'prototype-spear-skill-sovereign-pierce-south', clip: 'skill-sovereign-pierce-south', mirrorX: false, frameRate: FPS, frames: SOVEREIGN_SOUTH_FRAMES },
  { id: 'prototype-spear-skill-sovereign-pierce-west', clip: 'skill-sovereign-pierce-west', mirrorX: false, frameRate: FPS, frames: SOVEREIGN_WEST_FRAMES },
  { id: 'prototype-spear-skill-sovereign-pierce-north', clip: 'skill-sovereign-pierce-north', mirrorX: false, frameRate: FPS, frames: SOVEREIGN_NORTH_FRAMES },
  { id: 'prototype-spear-skill-sovereign-pierce-east', clip: 'skill-sovereign-pierce-east', mirrorX: true, frameRate: FPS, frames: SOVEREIGN_WEST_FRAMES },

  // 主动增益技能 7..9 共用「立枪聚气」姿态（由 export.ts 映射到 3 个增益技能）
  { id: 'prototype-spear-buff-cast-south', clip: 'skill-focus-edge-south', mirrorX: false, frameRate: FPS, frames: BUFF_CAST_SOUTH_FRAMES },
  { id: 'prototype-spear-buff-cast-west', clip: 'skill-focus-edge-west', mirrorX: false, frameRate: FPS, frames: BUFF_CAST_WEST_FRAMES },
  { id: 'prototype-spear-buff-cast-north', clip: 'skill-focus-edge-north', mirrorX: false, frameRate: FPS, frames: BUFF_CAST_NORTH_FRAMES },
  { id: 'prototype-spear-buff-cast-east', clip: 'skill-focus-edge-east', mirrorX: true, frameRate: FPS, frames: BUFF_CAST_WEST_FRAMES },

  // 长枪战斗阵亡动作（23 帧）
  { id: 'prototype-spear-die-south', clip: 'spear-die-south', mirrorX: false, frameRate: FPS, frames: DIE_SPEAR_FRAMES },
  { id: 'prototype-spear-die-east', clip: 'spear-die-east', mirrorX: true, frameRate: FPS, frames: DIE_SPEAR_FRAMES },
];

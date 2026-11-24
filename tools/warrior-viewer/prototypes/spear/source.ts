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
 * - 红缨：支持待机垂摆（hang）、突刺风曳（trail）与横扫甩尾（sweep）三种物理形态
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
  tasselMode?: 'hang' | 'trail' | 'sweep';
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
    // 突刺风曳：红缨紧贴枪杆向枪尾方向拉直飘扬
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
    // 横扫甩尾：红缨朝挥扫反方向大弧度飞扬
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
  } else {
    // 常规垂落（待机/行走微风轻摆）
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
  // 6..8：四向直刺专用切片（风曳红缨 + 纯轴向锐利枪尖）
  {
    id: 'spear-thrust-west',
    label: '水平直刺长枪（西/东向）',
    anchorX: 33,
    anchorY: 7,
    rows: buildAngledSpear({
      width: 56, height: 15,
      tipX: 2, tipY: 7, buttX: 53, buttY: 7,
      bladeLen: 16, collarLen: 2.2, buttLen: 4.5,
      sway: 0, tasselMode: 'trail', bladeWidthScale: 1.08,
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
      sway: 0, upright: true, tasselMode: 'trail', bladeWidthScale: 1.15,
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
  // 9..11：横扫专用切片（低斜扫、水平流光扫、高斜挑起）
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
  /** 从哪个原版基础姿态提取人物肢体/换装帧。 */
  sourcePoseId: string;
  sourceFrame: number;
  piece: number;
  x: number;
  y: number;
  scaleX?: number;
  scaleY?: number;
  angle?: number;
  insertMode: SpearInsertMode;
}

export interface SpearKeyframedPoseRecipe {
  id: string;
  clip: string;
  mirrorX: boolean;
  frameRate: number;
  frames: readonly SpearKeyframeSpec[];
}

/**
 * 待机与行走循环动作配方：
 * 1. idle（双手斜持战斗待机）：基于双手剑待机 pose-4067..4069，14 帧呼吸节奏。
 * 2. walk（持枪行走）：基于双手剑行走 pose-4070..4072，8 帧迈步起伏与红缨摆动。
 * 3. spear-upright-idle（单手直立立枪待机）：基于法杖待机 pose-4142..4144，供站姿对比。
 */
export const SPEAR_CYCLE_RECIPES: readonly SpearPoseRecipe[] = [
  // 一、双手斜持战斗待机
  {
    id: 'prototype-spear-idle-south',
    clip: 'idle-south',
    basePoseId: 'pose-4067-south-ticks-0',
    mirrorX: false,
    insertMode: 'between-south-arms',
    pieceEven: 0,
    pieceOdd: 1,
    baseX: 0,
    baseY: -8,
    scaleX: 1,
    scaleY: 1,
    angle: 0,
  },
  {
    id: 'prototype-spear-idle-west',
    clip: 'idle-west',
    basePoseId: 'pose-4068-west-ticks-0',
    mirrorX: false,
    insertMode: 'between-west-arms',
    pieceEven: 2,
    pieceOdd: 3,
    baseX: -3,
    baseY: -10,
    scaleX: 1,
    scaleY: 1,
    angle: 0,
  },
  {
    id: 'prototype-spear-idle-north',
    clip: 'idle-north',
    basePoseId: 'pose-4069-north-ticks-0',
    mirrorX: false,
    insertMode: 'back',
    pieceEven: 0,
    pieceOdd: 1,
    baseX: 1,
    baseY: -9,
    scaleX: -1,
    scaleY: 1,
    angle: 0,
  },
  {
    id: 'prototype-spear-idle-east',
    clip: 'idle-east',
    basePoseId: 'pose-4068-east-ticks-0',
    mirrorX: true,
    insertMode: 'between-west-arms',
    pieceEven: 2,
    pieceOdd: 3,
    baseX: -3,
    baseY: -10,
    scaleX: 1,
    scaleY: 1,
    angle: 0,
  },
  // 二、持枪行走（8 帧步态起伏 + 轻微前后摆枪）
  {
    id: 'prototype-spear-walk-south',
    clip: 'walk-south',
    basePoseId: 'pose-4070-south-ticks-0',
    mirrorX: false,
    insertMode: 'between-south-walk-arms',
    pieceEven: 0,
    pieceOdd: 1,
    swayPeriod: 2,
    baseX: 1,
    baseY: -8,
    stepDx: [0, 0, -1, -1, 0, 0, 1, 1],
    scaleX: 1,
    scaleY: 1,
    angle: 0,
  },
  {
    id: 'prototype-spear-walk-west',
    clip: 'walk-west',
    basePoseId: 'pose-4071-west-ticks-0',
    mirrorX: false,
    insertMode: 'between-west-arms',
    pieceEven: 2,
    pieceOdd: 3,
    swayPeriod: 2,
    baseX: -4,
    baseY: -10,
    stepDx: [0, 0, -1, -1, 0, 0, 1, 1],
    scaleX: 1,
    scaleY: 1,
    angle: 0,
  },
  {
    id: 'prototype-spear-walk-north',
    clip: 'walk-north',
    basePoseId: 'pose-4072-north-ticks-0',
    mirrorX: false,
    insertMode: 'back',
    pieceEven: 0,
    pieceOdd: 1,
    swayPeriod: 2,
    baseX: 1,
    baseY: -9,
    stepDx: [0, 0, 1, 1, 0, 0, -1, -1],
    scaleX: -1,
    scaleY: 1,
    angle: 0,
  },
  {
    id: 'prototype-spear-walk-east',
    clip: 'walk-east',
    basePoseId: 'pose-4071-east-ticks-0',
    mirrorX: true,
    insertMode: 'between-west-arms',
    pieceEven: 2,
    pieceOdd: 3,
    swayPeriod: 2,
    baseX: -4,
    baseY: -10,
    stepDx: [0, 0, -1, -1, 0, 0, 1, 1],
    scaleX: 1,
    scaleY: 1,
    angle: 0,
  },
  // 三、立枪待机（单手直立对照）
  {
    id: 'prototype-spear-upright-idle-south',
    clip: 'spear-upright-idle-south',
    basePoseId: 'pose-4142-south-ticks-0',
    mirrorX: false,
    insertMode: 'replace-staff',
    pieceEven: 4,
    pieceOdd: 5,
    baseX: -9,
    baseY: -10,
    scaleX: 1,
    scaleY: 1,
    angle: 0,
  },
  {
    id: 'prototype-spear-upright-idle-west',
    clip: 'spear-upright-idle-west',
    basePoseId: 'pose-4143-west-ticks-0',
    mirrorX: false,
    insertMode: 'replace-staff',
    pieceEven: 4,
    pieceOdd: 5,
    baseX: -8,
    baseY: -10,
    scaleX: 1,
    scaleY: 1,
    angle: 0,
  },
  {
    id: 'prototype-spear-upright-idle-north',
    clip: 'spear-upright-idle-north',
    basePoseId: 'pose-4144-north-ticks-0',
    mirrorX: false,
    insertMode: 'replace-staff',
    pieceEven: 4,
    pieceOdd: 5,
    baseX: 11,
    baseY: -10,
    scaleX: -1,
    scaleY: 1,
    angle: 0,
  },
  {
    id: 'prototype-spear-upright-idle-east',
    clip: 'spear-upright-idle-east',
    basePoseId: 'pose-4143-east-ticks-0',
    mirrorX: true,
    insertMode: 'replace-staff',
    pieceEven: 4,
    pieceOdd: 5,
    baseX: -8,
    baseY: -10,
    scaleX: 1,
    scaleY: 1,
    angle: 0,
  },
];

const FPS = 50 / 3; // 16.666666... fps（原版标准帧率）

const THRUST_WEST_FRAMES: readonly SpearKeyframeSpec[] = [
  // F0：战斗预备架势
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 2, x: -3, y: -10, insertMode: 'between-west-arms' },
  // F1：收枪蓄力，枪杆拉平对齐突刺轴
  { sourcePoseId: 'pose-4062-west-ticks-0', sourceFrame: 0, piece: 6, x: 5, y: -11, insertMode: 'front' },
  // F2：极限后拉紧绷，即将爆发
  { sourcePoseId: 'pose-4062-west-ticks-0', sourceFrame: 1, piece: 6, x: 10, y: -11, insertMode: 'front' },
  // F3：弓步爆发直刺！（枪芒在 F3 点燃）
  { sourcePoseId: 'pose-4062-west-ticks-0', sourceFrame: 2, piece: 6, x: -12, y: -11, insertMode: 'before-front-hand' },
  // F4：峰值最远贯刺（命中结算帧）
  { sourcePoseId: 'pose-4062-west-ticks-0', sourceFrame: 2, piece: 6, x: -15, y: -11, insertMode: 'before-front-hand' },
  // F5：峰值定枪凝势
  { sourcePoseId: 'pose-4062-west-ticks-0', sourceFrame: 2, piece: 6, x: -14, y: -11, insertMode: 'before-front-hand' },
  // F6：回抽起收
  { sourcePoseId: 'pose-4062-west-ticks-0', sourceFrame: 3, piece: 6, x: -9, y: -11, insertMode: 'before-front-hand' },
  // F7：半程回枪
  { sourcePoseId: 'pose-4062-west-ticks-0', sourceFrame: 3, piece: 6, x: -3, y: -11, insertMode: 'before-front-hand' },
  // F8：收势回防
  { sourcePoseId: 'pose-4062-west-ticks-0', sourceFrame: 4, piece: 2, x: -1, y: -10, insertMode: 'front' },
  // F9：归位战斗待机
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 3, x: -3, y: -10, insertMode: 'between-west-arms' },
];

const THRUST_SOUTH_FRAMES: readonly SpearKeyframeSpec[] = [
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 0, piece: 0, x: 0, y: -8, insertMode: 'between-south-arms' },
  // 蓄力后撤贴于右侧肩旁，避免枪尾正切脸部
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 0, piece: 7, x: -7, y: -12, insertMode: 'back' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 1, piece: 7, x: -7, y: -15, insertMode: 'back' },
  // F3..F5：俯身弓步直刺向南，枪尖破空突伸！
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 2, piece: 7, x: -3, y: 4, insertMode: 'front' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 2, piece: 7, x: -3, y: 8, insertMode: 'front' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 2, piece: 7, x: -3, y: 7, insertMode: 'front' },
  // F6..F9：回抽收枪归位
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

/**
 * 横扫（12 帧，基于双手剑大横挥 pose-4073..4075）：
 * 呈现清晰的「向一侧蓄势 → 前方半圈 180° 横扫 → 甩尾收枪」弧线轨迹。
 */
const SWEEP_SOUTH_FRAMES: readonly SpearKeyframeSpec[] = [
  // F0..F2：向左上方蓄力引枪（置后层避免遮挡脸部）
  { sourcePoseId: 'pose-4073-south-ticks-0', sourceFrame: 0, piece: 0, x: -4, y: -11, insertMode: 'back' },
  { sourcePoseId: 'pose-4073-south-ticks-0', sourceFrame: 1, piece: 11, x: -7, y: -13, insertMode: 'back' },
  { sourcePoseId: 'pose-4073-south-ticks-0', sourceFrame: 2, piece: 11, x: -9, y: -10, insertMode: 'back' },
  // F3：开始下压左前斜扫
  { sourcePoseId: 'pose-4073-south-ticks-0', sourceFrame: 3, piece: 9, x: -6, y: -3, insertMode: 'front' },
  // F4：峰值横扫正前偏右（命中帧，180° 前弧贯扫！）
  { sourcePoseId: 'pose-4073-south-ticks-0', sourceFrame: 4, piece: 9, x: 6, y: -3, scaleX: -1, insertMode: 'front' },
  // F5：横扫全展至右侧（水平甩缨平扫）
  { sourcePoseId: 'pose-4073-south-ticks-0', sourceFrame: 5, piece: 10, x: 10, y: -7, scaleX: -1, insertMode: 'front' },
  // F6：右侧余势顺势微抬，自然衔接右斜收枪
  { sourcePoseId: 'pose-4073-south-ticks-0', sourceFrame: 6, piece: 2, x: 8, y: -9, scaleX: -1, insertMode: 'front' },
  // F7..F8：右肩回带
  { sourcePoseId: 'pose-4073-south-ticks-0', sourceFrame: 7, piece: 0, x: 5, y: -9, scaleX: -1, insertMode: 'front' },
  { sourcePoseId: 'pose-4073-south-ticks-0', sourceFrame: 8, piece: 11, x: 5, y: -11, scaleX: -1, insertMode: 'back' },
  // F9..F11：顺畅旋枪回防归位（平滑接回战斗待机）
  { sourcePoseId: 'pose-4073-south-ticks-0', sourceFrame: 9, piece: 0, x: 2, y: -10, scaleX: -1, insertMode: 'back' },
  { sourcePoseId: 'pose-4073-south-ticks-0', sourceFrame: 10, piece: 0, x: 1, y: -9, insertMode: 'front' },
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 0, piece: 1, x: 0, y: -8, insertMode: 'between-south-arms' },
];

const SWEEP_WEST_FRAMES: readonly SpearKeyframeSpec[] = [
  // F0..F2：提枪向后上方高蓄势
  { sourcePoseId: 'pose-4074-west-ticks-0', sourceFrame: 0, piece: 11, x: 3, y: -14, scaleX: -1, insertMode: 'back' },
  { sourcePoseId: 'pose-4074-west-ticks-0', sourceFrame: 1, piece: 4, x: 4, y: -15, insertMode: 'back' },
  { sourcePoseId: 'pose-4074-west-ticks-0', sourceFrame: 2, piece: 11, x: 0, y: -15, insertMode: 'front' },
  // F3：高斜前压切入西侧弧线
  { sourcePoseId: 'pose-4074-west-ticks-0', sourceFrame: 3, piece: 11, x: -6, y: -13, insertMode: 'front' },
  // F4：峰值平扫直劈西侧全展（带刃缘锋芒，命中帧！）
  { sourcePoseId: 'pose-4074-west-ticks-0', sourceFrame: 4, piece: 10, x: -12, y: -9, insertMode: 'front' },
  // F5：低斜下扫收弧
  { sourcePoseId: 'pose-4074-west-ticks-0', sourceFrame: 5, piece: 9, x: -9, y: -6, insertMode: 'front' },
  // F6：低势惯性滞留
  { sourcePoseId: 'pose-4074-west-ticks-0', sourceFrame: 6, piece: 9, x: -8, y: -6, insertMode: 'front' },
  // F7..F9：拉回枪尾上挑复位
  { sourcePoseId: 'pose-4074-west-ticks-0', sourceFrame: 7, piece: 2, x: -6, y: -8, insertMode: 'front' },
  { sourcePoseId: 'pose-4074-west-ticks-0', sourceFrame: 8, piece: 2, x: -4, y: -9, insertMode: 'front' },
  { sourcePoseId: 'pose-4074-west-ticks-0', sourceFrame: 9, piece: 3, x: -3, y: -10, insertMode: 'front' },
  // F10..F11：平滑接回标准双手战斗持枪架势（避免双手剑搭肩手位）
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 2, x: -3, y: -10, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 1, piece: 3, x: -3, y: -10, insertMode: 'between-west-arms' },
];

const SWEEP_NORTH_FRAMES: readonly SpearKeyframeSpec[] = [
  // F0..F2：向右侧蓄势引枪
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 0, piece: 0, x: 4, y: -10, scaleX: -1, insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 1, piece: 9, x: 6, y: -10, scaleX: -1, insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 2, piece: 11, x: 6, y: -12, scaleX: -1, insertMode: 'back' },
  // F3：切入北侧前弧（正北挑出）
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 3, piece: 8, x: 2, y: -15, insertMode: 'back' },
  // F4：峰值横向横扫北侧前方半圈（带刃缘锋芒，命中帧！）
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 4, piece: 10, x: -6, y: -16, insertMode: 'back' },
  // F5：扫至左侧高位
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 5, piece: 11, x: -8, y: -13, insertMode: 'back' },
  // F6：左侧收势
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 6, piece: 0, x: -7, y: -10, insertMode: 'back' },
  // F7..F11：流畅回收至北向斜持待机
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 7, piece: 0, x: -5, y: -10, insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 8, piece: 11, x: -3, y: -12, insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 9, piece: 11, x: 1, y: -11, scaleX: -1, insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 10, piece: 0, x: 1, y: -10, scaleX: -1, insertMode: 'back' },
  { sourcePoseId: 'pose-4069-north-ticks-0', sourceFrame: 0, piece: 1, x: 1, y: -9, scaleX: -1, insertMode: 'back' },
];

export const SPEAR_ACTION_RECIPES: readonly SpearKeyframedPoseRecipe[] = [
  // 直刺（四向，10 帧，F4 出枪芒、F5 命中）
  { id: 'prototype-spear-thrust-south', clip: 'thrust-south', mirrorX: false, frameRate: FPS, frames: THRUST_SOUTH_FRAMES },
  { id: 'prototype-spear-thrust-west', clip: 'thrust-west', mirrorX: false, frameRate: FPS, frames: THRUST_WEST_FRAMES },
  { id: 'prototype-spear-thrust-north', clip: 'thrust-north', mirrorX: false, frameRate: FPS, frames: THRUST_NORTH_FRAMES },
  { id: 'prototype-spear-thrust-east', clip: 'thrust-east', mirrorX: true, frameRate: FPS, frames: THRUST_WEST_FRAMES },
  // 横扫（四向，12 帧，F5 命中）
  { id: 'prototype-spear-sweep-south', clip: 'sweep-south', mirrorX: false, frameRate: FPS, frames: SWEEP_SOUTH_FRAMES },
  { id: 'prototype-spear-sweep-west', clip: 'sweep-west', mirrorX: false, frameRate: FPS, frames: SWEEP_WEST_FRAMES },
  { id: 'prototype-spear-sweep-north', clip: 'sweep-north', mirrorX: false, frameRate: FPS, frames: SWEEP_NORTH_FRAMES },
  { id: 'prototype-spear-sweep-east', clip: 'sweep-east', mirrorX: true, frameRate: FPS, frames: SWEEP_WEST_FRAMES },
];

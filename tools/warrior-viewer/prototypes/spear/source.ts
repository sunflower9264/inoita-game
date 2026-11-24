/**
 * 长枪样板可编辑像素源数据（基础铁枪 · 红缨长枪）。
 *
 * 修改任意切片像素网格、调色板或基准点后，执行：
 *   node tools/warrior-viewer/prototypes/spear/export.ts
 * 即可重新导出透明 PNG（spear-parts.png）与四向持枪待机姿态（spear-prototype.json）。
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
 * - 红缨：两缕分叉垂缨，sway 0/1 实现待机微风轻摆
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
}): string[] {
  const { width, height, tipX, tipY, buttX, buttY, bladeLen, collarLen, buttLen, sway, upright } = options;
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
    const halfW = f < 0.18
      ? 0.2
      : f < 0.66
        ? 0.28 + ((f - 0.18) / 0.48) * 1.82
        : 2.1 - ((f - 0.66) / 0.34) * 1.25;
    for (let o = -halfW; o <= halfW; o += 0.3) {
      const [px, py] = sampleAt(t, o);
      let ch: string;
      if (Math.abs(o) <= 0.38) ch = f < 0.82 ? 'H' : 'L';
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

  // 5. 红缨（两缕自然垂落并在尾端轻微分叉，sway 0/1 呈现微风呼吸摆动）
  const [collarX, collarY] = sampleAt(bladeLen + collarLen * 0.55, 0);
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

  // 6. 1px 清晰像素轮廓线
  applyOutline(grid, 'D', ch => ch === 'H' || ch === 'L' || ch === 'M' || ch === 'S');
  applyOutline(grid, 'K', ch => ch !== 'D');

  return toRows(grid);
}

export const SPEAR_SLICES: readonly PixelSliceSource[] = [
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
];

export interface SpearPoseRecipe {
  id: string;
  clip: string;
  basePoseId: string;
  mirrorX: boolean;
  /** 将长枪插入到过滤掉原武器后的指定层级。 */
  insertMode: 'between-south-arms' | 'between-west-arms' | 'back' | 'replace-staff';
  pieceEven: number;
  pieceOdd: number;
  baseX: number;
  baseY: number;
  scaleX: number;
  scaleY: number;
  angle: number;
}

/**
 * 两组四向持枪待机：
 * 1. idle（双手斜持战斗待机）：基于双手剑待机 pose-4067..4069，14 帧呼吸节奏。
 * 2. spear-upright-idle（单手直立立枪待机）：基于法杖待机 pose-4142..4144，供站姿对比。
 */
export const SPEAR_IDLE_RECIPES: readonly SpearPoseRecipe[] = [
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
  // 二、立枪待机（单手直立对照）
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

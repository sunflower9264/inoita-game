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
  tasselBehindBlade?: boolean;
  tasselScale?: number;
}): string[] {
  const {
    width, height, tipX, tipY, buttX, buttY, bladeLen, collarLen, buttLen,
    sway, upright, tasselMode = 'hang', bladeWidthScale = 1,
    tasselBehindBlade = false, tasselScale = 1,
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

  const drawTassel = (): void => {
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
    } else if (tasselBehindBlade) {
      // 枪尖朝镜头前下方透视：红缨绕在铜箍后方两侧，避免糊盖银钢锋刃
      const bx = Math.round(collarX);
      const by = Math.round(collarY);
      const strands = [
        { ox: -2, oy: 0, len: Math.max(1, Math.round(5 * tasselScale)), drift: -1 + sway },
        { ox: -1, oy: 1, len: Math.max(1, Math.round(6 * tasselScale)), drift: -1 + sway },
        { ox: 1, oy: 1, len: Math.max(1, Math.round(6 * tasselScale)), drift: 1 + sway },
        { ox: 2, oy: 0, len: Math.max(1, Math.round(5 * tasselScale)), drift: 1 + sway },
      ];
      for (const strand of strands) {
        for (let step = 0; step < strand.len; step++) {
          const bend = step >= 2 ? Math.round((step - 1) * 0.35 * strand.drift) : 0;
          const sx = bx + strand.ox + bend;
          const sy = by + strand.oy + step;
          const ch = step === 0 ? 'P' : step < 3 ? 'R' : 'r';
          put(grid, sx, sy, ch);
        }
      }
    } else {
      const bx = Math.round(collarX);
      const by = Math.round(collarY);
      const strands = upright
        ? [
            { ox: -2, oy: 1, len: Math.max(1, Math.round(6 * tasselScale)), drift: -1 + sway },
            { ox: -1, oy: 1, len: Math.max(1, Math.round(8 * tasselScale)), drift: sway },
            { ox: 1, oy: 1, len: Math.max(1, Math.round(7 * tasselScale)), drift: sway },
            { ox: 2, oy: 2, len: Math.max(1, Math.round(5 * tasselScale)), drift: 1 },
          ]
        : [
            { ox: -1, oy: 1, len: Math.max(1, Math.round(5 * tasselScale)), drift: sway },
            { ox: 0, oy: 1, len: Math.max(1, Math.round(8 * tasselScale)), drift: sway },
            { ox: 1, oy: 1, len: Math.max(1, Math.round(6 * tasselScale)), drift: 1 + sway },
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
  };

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

  if (tasselBehindBlade) drawTassel();

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
  if (!tasselBehindBlade) drawTassel();

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
    label: '北向直刺长枪（右肋透视向北突刺）',
    anchorX: 12,
    anchorY: 32,
    rows: buildAngledSpear({
      width: 20, height: 46,
      tipX: 6, tipY: 2, buttX: 15, buttY: 42,
      bladeLen: 14, collarLen: 2.0, buttLen: 4.2,
      sway: 0, upright: true, tasselMode: 'trail', bladeWidthScale: 1.0,
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
  // 14..17：虬龙扫暴阵「双侧 3D 透视枪花」专用居中切片（100% 实色自然长度 ~62px，使枪尖与枪尾刚好落在左右 ±30px 3D 侧轮中心内）
  {
    id: 'spear-windmill-horiz',
    label: '双侧枪花（居中水平 · 尖左尾右）',
    anchorX: 31,
    anchorY: 9,
    rows: buildAngledSpear({
      width: 62, height: 18,
      tipX: 2, tipY: 9, buttX: 59, buttY: 9,
      bladeLen: 15, collarLen: 2.2, buttLen: 5.5,
      sway: 0, tasselMode: 'sweep', bladeWidthScale: 1.0,
    }),
  },
  {
    id: 'spear-windmill-diag-low',
    label: '双侧枪花（居中低斜 20° · 上下摆动）',
    anchorX: 30,
    anchorY: 16,
    rows: buildAngledSpear({
      width: 60, height: 32,
      tipX: 2, tipY: 5, buttX: 57, buttY: 26,
      bladeLen: 15, collarLen: 2.2, buttLen: 5.5,
      sway: 0, tasselMode: 'sweep', bladeWidthScale: 1.0,
    }),
  },
  {
    id: 'spear-lift-vert-mid',
    label: '正南北纵向上挑（中段俯视透视纯竖直 · 0°零斜角）',
    anchorX: 7,
    anchorY: 24,
    rows: buildAngledSpear({
      width: 15, height: 36,
      tipX: 7, tipY: 2, buttX: 7, buttY: 33,
      bladeLen: 12, collarLen: 2.0, buttLen: 4.0,
      sway: 0, upright: true, tasselMode: 'trail', bladeWidthScale: 1.0,
    }),
  },
  {
    id: 'spear-lift-vert-high',
    label: '正南北纵向上挑（高点冲天纯竖直 · 0°零斜角）',
    anchorX: 7,
    anchorY: 32,
    rows: buildAngledSpear({
      width: 15, height: 52,
      tipX: 7, tipY: 2, buttX: 7, buttY: 49,
      bladeLen: 15, collarLen: 2.2, buttLen: 4.5,
      sway: 0, upright: true, tasselMode: 'trail', bladeWidthScale: 1.05,
    }),
  },
  // 18..23：四向挺拔单手朝前微仰（~12.6°）持枪待机与行走专用切片（每向 2 帧红缨微摆）
  {
    id: 'spear-carry-side-0',
    label: '单手持枪（西/东朝前微仰 · 红缨帧 1）',
    anchorX: 32,
    anchorY: 10,
    rows: buildAngledSpear({
      width: 54, height: 22,
      tipX: 2, tipY: 3, buttX: 51, buttY: 14,
      bladeLen: 14, collarLen: 2.2, buttLen: 4.5,
      sway: 0,
    }),
  },
  {
    id: 'spear-carry-side-1',
    label: '单手持枪（西/东朝前微仰 · 红缨帧 2）',
    anchorX: 32,
    anchorY: 10,
    rows: buildAngledSpear({
      width: 54, height: 22,
      tipX: 2, tipY: 3, buttX: 51, buttY: 14,
      bladeLen: 14, collarLen: 2.2, buttLen: 4.5,
      sway: 1,
    }),
  },
  {
    id: 'spear-carry-south-0',
    label: '单手持枪（南向朝前透视 · 红缨帧 1）',
    anchorX: 9,
    anchorY: 12,
    rows: buildAngledSpear({
      width: 18, height: 32,
      tipX: 6, tipY: 29, buttX: 11, buttY: 2,
      bladeLen: 11, collarLen: 2.2, buttLen: 4.5,
      sway: 0, upright: true, tasselBehindBlade: true,
    }),
  },
  {
    id: 'spear-carry-south-1',
    label: '单手持枪（南向朝前透视 · 红缨帧 2）',
    anchorX: 9,
    anchorY: 12,
    rows: buildAngledSpear({
      width: 18, height: 32,
      tipX: 6, tipY: 29, buttX: 11, buttY: 2,
      bladeLen: 11, collarLen: 2.2, buttLen: 4.5,
      sway: 1, upright: true, tasselBehindBlade: true,
    }),
  },
  {
    id: 'spear-carry-north-0',
    label: '单手持枪（北向朝前微仰透视 · 红缨帧 1）',
    anchorX: 8,
    anchorY: 25,
    rows: buildAngledSpear({
      width: 18, height: 39,
      tipX: 12, tipY: 2, buttX: 6, buttY: 36,
      bladeLen: 10, collarLen: 2.2, buttLen: 4.5,
      sway: 0, upright: true, tasselScale: 0.82,
    }),
  },
  {
    id: 'spear-carry-north-1',
    label: '单手持枪（北向朝前微仰透视 · 红缨帧 2）',
    anchorX: 8,
    anchorY: 25,
    rows: buildAngledSpear({
      width: 18, height: 39,
      tipX: 12, tipY: 2, buttX: 6, buttY: 36,
      bladeLen: 10, collarLen: 2.2, buttLen: 4.5,
      sway: 1, upright: true, tasselScale: 0.82,
    }),
  },
  // 24..27：四向脱战斜背背后专用切片（南/北斜跨肩背 + 西/东贴背斜背，各 2 帧红缨微摆）
  {
    id: 'spear-back-diag-0',
    label: '脱战斜背长枪（南/北斜跨 · 红缨帧 1）',
    anchorX: 18,
    anchorY: 22,
    rows: buildAngledSpear({
      width: 38, height: 44,
      tipX: 34, tipY: 2, buttX: 3, buttY: 41,
      bladeLen: 14, collarLen: 2.2, buttLen: 4.5,
      sway: 0,
    }),
  },
  {
    id: 'spear-back-diag-1',
    label: '脱战斜背长枪（南/北斜跨 · 红缨帧 2）',
    anchorX: 18,
    anchorY: 22,
    rows: buildAngledSpear({
      width: 38, height: 44,
      tipX: 34, tipY: 2, buttX: 3, buttY: 41,
      bladeLen: 14, collarLen: 2.2, buttLen: 4.5,
      sway: 1,
    }),
  },
  {
    id: 'spear-back-side-0',
    label: '脱战斜背长枪（西/东贴背 · 红缨帧 1）',
    anchorX: 17,
    anchorY: 23,
    rows: buildAngledSpear({
      width: 34, height: 46,
      tipX: 30, tipY: 2, buttX: 4, buttY: 43,
      bladeLen: 14, collarLen: 2.2, buttLen: 4.5,
      sway: 0,
    }),
  },
  {
    id: 'spear-back-side-1',
    label: '脱战斜背长枪（西/东贴背 · 红缨帧 2）',
    anchorX: 17,
    anchorY: 23,
    rows: buildAngledSpear({
      width: 34, height: 46,
      tipX: 30, tipY: 2, buttX: 4, buttY: 43,
      bladeLen: 14, collarLen: 2.2, buttLen: 4.5,
      sway: 1,
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
  | 'before-front-hand'
  | 'before-right-arm-south'
  | 'before-near-arm-west'
  | 'before-cloak';

/**
 * 全四向双手持枪标准双臂预设（东向由西向自动水平镜像同步）。
 * 使用全部 63 套 `coat-front` 上衣外观 100% 共有的手臂切片 `[5..14]`（全 0° 无旋转，支持原版标准 `scaleY: -1` 上举臂），
 * 在导出时替换原版单手剑/短剑/战吼的单臂、三臂、旋转怪手与悬空断手，确保四向每帧均由双手紧贴肩窝实握枪杆，
 * 且肩部坐标自动跟随胸甲躯干的微幅起伏。
 */
export type SpearArmsPreset =
  // 西/东向双手预设
  | 'thrust-coil'
  | 'thrust-extend'
  | 'flurry-mid'
  | 'sweep-windup'
  | 'sweep-raise'
  | 'sweep-cut'
  | 'sweep-low'
  | 'slam-low'
  | 'whirl-center'
  | 'buff-upright'
  | 'lift-mid'
  | 'lift-high'
  // 南向双手预设
  | 'south-ready'
  | 'south-thrust-coil'
  | 'south-thrust-extend'
  | 'south-sweep-left'
  | 'south-sweep-center'
  | 'south-sweep-right'
  | 'south-whirl-center'
  | 'south-lift-low'
  | 'south-lift-mid'
  | 'south-lift-high'
  | 'south-slam-overhead'
  | 'south-slam-down'
  | 'south-buff-upright'
  // 北向双手预设
  | 'north-ready'
  | 'north-thrust-coil'
  | 'north-thrust-extend'
  | 'north-sweep-right'
  | 'north-sweep-left'
  | 'north-whirl-center'
  | 'north-lift-mid'
  | 'north-lift-high'
  | 'north-slam-overhead'
  | 'north-slam-down'
  | 'north-buff-upright';

export type SpearArmLayer = 'behind-torso' | 'behind-spear' | 'front-of-spear';

export interface SpearArmPlacement {
  piece: number;
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  /** 可选遮挡层序：缺省时 backArm='behind-torso'，frontArm='front-of-spear'。 */
  layer?: SpearArmLayer;
}

export interface SpearArmsSpec {
  /** 躯干基准横坐标（西向 coat-front[1] 默认 -1，南/北向 coat-front[0]/[2] 为 0）。 */
  baseTorsoX?: number;
  /** 第一手臂（西向为远侧左臂，南/北向为右侧/远侧辅助握枪臂）。 */
  backArm: SpearArmPlacement;
  /** 第二手臂（西向为近侧右臂，南/北向为主握枪臂）。 */
  frontArm: SpearArmPlacement;
}

export const SPEAR_ARMS_PRESETS: Record<SpearArmsPreset, SpearArmsSpec> = {
  // === 西/东向双手预设（baseTorsoX 默认 -1） ===
  // 蓄枪后引：左臂前伸稳托前杆，右臂曲肘拉回腰后握尾
  'thrust-coil': {
    backArm: { piece: 8, x: 1, y: 1, scaleX: -1, scaleY: 1 },
    frontArm: { piece: 11, x: -1, y: 1, scaleX: 1, scaleY: 1 },
  },
  // 弓步平刺：左臂直伸前探托前杆，右臂前推实握中杆
  'thrust-extend': {
    backArm: { piece: 13, x: -8, y: -2, scaleX: 1, scaleY: 1 },
    frontArm: { piece: 13, x: 0, y: -1, scaleX: 1, scaleY: 1 },
  },
  // 连环点枪半伸微颤：左臂前伸控枪，右臂紧随胸腰微距发力
  'flurry-mid': {
    backArm: { piece: 13, x: -7, y: -2, scaleX: 1, scaleY: 1 },
    frontArm: { piece: 10, x: -1, y: -2, scaleX: 1, scaleY: 1 },
  },
  // 背枪蓄扫（长枪举在背后）：左臂收护胸前保持平衡，右臂曲肘回引握杆
  'sweep-windup': {
    backArm: { piece: 8, x: 3, y: 1, scaleX: -1, scaleY: 1 },
    frontArm: { piece: 11, x: -1, y: 0, scaleX: 1, scaleY: 1 },
  },
  // 扬枪蓄扫：左臂高托斜杆，右臂曲肘收高准备发力
  'sweep-raise': {
    backArm: { piece: 13, x: -6, y: -4, scaleX: 1, scaleY: 1 },
    frontArm: { piece: 11, x: -1, y: 0, scaleX: 1, scaleY: 1 },
  },
  // 挺胸大横扫 / 360° 旋枪平扫：双臂舒展前推挥扫
  'sweep-cut': {
    backArm: { piece: 13, x: -8, y: -1, scaleX: 1, scaleY: 1 },
    frontArm: { piece: 13, x: 0, y: -1, scaleX: 1, scaleY: 1 },
  },
  // 低扫收势 / 低持蓄挑：双臂下压稳控低位枪杆
  'sweep-low': {
    backArm: { piece: 10, x: -9, y: 0, scaleX: 1, scaleY: 1 },
    frontArm: { piece: 10, x: -1, y: 0, scaleX: 1, scaleY: 1 },
  },
  // 伏龙震重砸落地：挺胸弓步，双臂笔直下压钉住枪杆
  'slam-low': {
    backArm: { piece: 10, x: -9, y: 0, scaleX: 1, scaleY: 1 },
    frontArm: { piece: 10, x: -1, y: 0, scaleX: 1, scaleY: 1 },
  },
  // 虬龙扫暴阵居中舞花：左右分开对握枪杆中轴
  'whirl-center': {
    backArm: { piece: 8, x: 1, y: 1, scaleX: -1, scaleY: 1 },
    frontArm: { piece: 12, x: -1, y: 2, scaleX: 1, scaleY: 1 },
  },
  // 立枪聚气增益：左臂前伸稳握直立枪杆，右臂自然垂按腰侧
  'buff-upright': {
    backArm: { piece: 8, x: 1, y: 1, scaleX: -1, scaleY: 1 },
    frontArm: { piece: 12, x: -1, y: 2, scaleX: 1, scaleY: 1 },
  },
  // 西/东向上挑中位（#11 斜上枪杆）：远侧前臂前上举贴紧前杆、近侧后臂紧扣中后杆，零分离
  'lift-mid': {
    backArm: { piece: 7, x: -2, y: -35, scaleX: -1, scaleY: -1, layer: 'behind-torso' },
    frontArm: { piece: 7, x: 5, y: -3, scaleX: -1, scaleY: 1, layer: 'front-of-spear' },
  },
  // 西/东向上挑高位顶点（#11 高斜挑）：双臂随胸抬升紧扣斜上枪杆
  'lift-high': {
    backArm: { piece: 7, x: -2, y: -36, scaleX: -1, scaleY: -1, layer: 'behind-torso' },
    frontArm: { piece: 7, x: 5, y: -4, scaleX: -1, scaleY: 1, layer: 'front-of-spear' },
  },

  // === 南向双手预设（baseTorsoX: 0，双肩位于 ±5, y=-18） ===
  // 南向双手斜持战姿（#0/#1 过腰胸斜杆）
  'south-ready': {
    baseTorsoX: 0,
    backArm: { piece: 11, x: 1, y: -1, scaleX: -1, scaleY: 1, layer: 'front-of-spear' },
    frontArm: { piece: 10, x: 0, y: -2, scaleX: 1, scaleY: 1, layer: 'front-of-spear' },
  },
  // 南向直刺蓄枪（#7 竖枪收于右侧腰前 x=-5，双臂一正一斜跨胸紧扣枪杆）
  'south-thrust-coil': {
    baseTorsoX: 0,
    backArm: { piece: 6, x: -1, y: -4, scaleX: -1, scaleY: 1, layer: 'front-of-spear' },
    frontArm: { piece: 13, x: -1, y: -1, scaleX: 1, scaleY: 1, layer: 'front-of-spear' },
  },
  // 南向直刺前送（#7 朝正南猛刺，左臂斜跨胸前、右臂下压，双手前后实扣竖枪）
  'south-thrust-extend': {
    baseTorsoX: 0,
    backArm: { piece: 6, x: 0, y: 0, scaleX: -1, scaleY: 1, layer: 'front-of-spear' },
    frontArm: { piece: 13, x: -1, y: 1, scaleX: 1, scaleY: 1, layer: 'front-of-spear' },
  },
  // 南向左扫起势（右臂左展、左臂斜跨，双手并握左扫枪杆）
  'south-sweep-left': {
    baseTorsoX: 0,
    backArm: { piece: 8, x: 0, y: 2, scaleX: -1, scaleY: 1, layer: 'front-of-spear' },
    frontArm: { piece: 13, x: 0, y: 1, scaleX: 1, scaleY: 1, layer: 'front-of-spear' },
  },
  // 南向居中前扫命中（双手在胸前中轴实握正南枪杆）
  'south-sweep-center': {
    baseTorsoX: 0,
    backArm: { piece: 10, x: 0, y: 0, scaleX: -1, scaleY: 1, layer: 'front-of-spear' },
    frontArm: { piece: 10, x: -1, y: 1, scaleX: 1, scaleY: 1, layer: 'front-of-spear' },
  },
  // 南向右扫收势（右臂斜跨、左臂右展，双手并握右扫枪杆）
  'south-sweep-right': {
    baseTorsoX: 0,
    backArm: { piece: 13, x: 0, y: 1, scaleX: -1, scaleY: 1, layer: 'front-of-spear' },
    frontArm: { piece: 8, x: 0, y: 2, scaleX: 1, scaleY: 1, layer: 'front-of-spear' },
  },
  // 南向双侧枪花居中对握（左右双臂对称展开扣住水平枪杆）
  'south-whirl-center': {
    baseTorsoX: 0,
    backArm: { piece: 11, x: -1, y: -1, scaleX: -1, scaleY: 1, layer: 'front-of-spear' },
    frontArm: { piece: 11, x: 1, y: -1, scaleX: 1, scaleY: 1, layer: 'front-of-spear' },
  },
  // 南向上挑低蓄（双手压低居中紧扣正南下压竖枪 #7）
  'south-lift-low': {
    baseTorsoX: 0,
    backArm: { piece: 10, x: 0, y: 1, scaleX: -1, scaleY: 1, layer: 'front-of-spear' },
    frontArm: { piece: 10, x: 0, y: 2, scaleX: 1, scaleY: 1, layer: 'front-of-spear' },
  },
  // 南向上挑起挑中段（双手一上一下在胸前实握正中竖枪 #16）
  'south-lift-mid': {
    baseTorsoX: 0,
    backArm: { piece: 10, x: 0, y: -2, scaleX: -1, scaleY: 1, layer: 'front-of-spear' },
    frontArm: { piece: 13, x: 0, y: -2, scaleX: 1, scaleY: 1, layer: 'front-of-spear' },
  },
  // 南向上挑高空顶点（双手在胸锁骨下巴以下一上一下实握正中竖枪 #17，零斜角且绝不遮脸）
  'south-lift-high': {
    baseTorsoX: 0,
    backArm: { piece: 10, x: 0, y: -3, scaleX: -1, scaleY: 1, layer: 'front-of-spear' },
    frontArm: { piece: 13, x: 0, y: -4, scaleX: 1, scaleY: 1, layer: 'front-of-spear' },
  },
  // 南向伏龙震过顶高举（双臂对称直举紧握头顶横枪 #12，兼容宽袖/重甲无外凸）
  'south-slam-overhead': {
    baseTorsoX: 0,
    backArm: { piece: 8, x: 0, y: -36, scaleX: -1, scaleY: -1, layer: 'behind-spear' },
    frontArm: { piece: 8, x: 0, y: -36, scaleX: 1, scaleY: -1, layer: 'behind-spear' },
  },
  // 南向伏龙震砸地下压（双手并扣居中竖枪猛力下砸）
  'south-slam-down': {
    baseTorsoX: 0,
    backArm: { piece: 10, x: 0, y: 0, scaleX: -1, scaleY: 1, layer: 'front-of-spear' },
    frontArm: { piece: 13, x: 0, y: 1, scaleX: 1, scaleY: 1, layer: 'front-of-spear' },
  },
  // 南向双手立枪聚气（取消单手举拳战吼，双手一上一下正握直立枪杆）
  'south-buff-upright': {
    baseTorsoX: 0,
    backArm: { piece: 6, x: -1, y: -1, scaleX: -1, scaleY: 1, layer: 'front-of-spear' },
    frontArm: { piece: 13, x: -1, y: -3, scaleX: 1, scaleY: 1, layer: 'front-of-spear' },
  },

  // === 北向双手预设（baseTorsoX: 0，双肩位于 ±5, y=-19，behind-spear 位于枪杆前、躯干/披风后） ===
  // 北向双手战姿/收势
  'north-ready': {
    baseTorsoX: 0,
    backArm: { piece: 13, x: 2, y: -2, scaleX: -1, scaleY: 1, layer: 'behind-spear' },
    frontArm: { piece: 8, x: 0, y: -1, scaleX: 1, scaleY: 1, layer: 'behind-spear' },
  },
  // 北向右肋拉把蓄枪（右臂后拉握右肋枪尾、左臂前上托住前杆，双腿间 0 漏枪把）
  'north-thrust-coil': {
    baseTorsoX: 0,
    backArm: { piece: 13, x: 0, y: -35, scaleX: -1, scaleY: -1, layer: 'behind-spear' },
    frontArm: { piece: 8, x: 1, y: 0, scaleX: 1, scaleY: 1, layer: 'behind-spear' },
  },
  // 北向双手前刺（左臂向前上方伸展控前杆、右臂前推送中后杆）
  'north-thrust-extend': {
    baseTorsoX: 0,
    backArm: { piece: 13, x: -1, y: -35, scaleX: -1, scaleY: -1, layer: 'behind-spear' },
    frontArm: { piece: 11, x: 1, y: -2, scaleX: 1, scaleY: 1, layer: 'behind-spear' },
  },
  // 北向胸肩高位右扫（双臂向右上前展开实握枪杆）
  'north-sweep-right': {
    baseTorsoX: 0,
    backArm: { piece: 13, x: -1, y: -33, scaleX: -1, scaleY: -1, layer: 'behind-spear' },
    frontArm: { piece: 7, x: 1, y: -35, scaleX: 1, scaleY: -1, layer: 'behind-spear' },
  },
  // 北向胸肩高位左扫（双臂向左上前展开实握枪杆）
  'north-sweep-left': {
    baseTorsoX: 0,
    backArm: { piece: 7, x: -1, y: -35, scaleX: -1, scaleY: -1, layer: 'behind-spear' },
    frontArm: { piece: 13, x: 1, y: -33, scaleX: 1, scaleY: -1, layer: 'behind-spear' },
  },
  // 北向双侧枪花居中对握（对称双臂展开）
  'north-whirl-center': {
    baseTorsoX: 0,
    backArm: { piece: 11, x: -1, y: -1, scaleX: -1, scaleY: 1, layer: 'behind-spear' },
    frontArm: { piece: 11, x: 1, y: -1, scaleX: 1, scaleY: 1, layer: 'behind-spear' },
  },
  // 北向上挑低蓄与中段（双臂对称向正北前侧收拢紧握居中竖枪 #16/#17）
  'north-lift-mid': {
    baseTorsoX: 0,
    backArm: { piece: 10, x: 0, y: -34, scaleX: -1, scaleY: -1, layer: 'behind-spear' },
    frontArm: { piece: 10, x: 0, y: -34, scaleX: 1, scaleY: -1, layer: 'behind-spear' },
  },
  // 北向上挑高空顶点（双臂对称直举紧扣正北冲天竖枪 #17，零斜角、零手枪分离）
  'north-lift-high': {
    baseTorsoX: 0,
    backArm: { piece: 10, x: 0, y: -36, scaleX: -1, scaleY: -1, layer: 'behind-spear' },
    frontArm: { piece: 10, x: 0, y: -36, scaleX: 1, scaleY: -1, layer: 'behind-spear' },
  },
  // 北向伏龙震过顶高举（双臂对称直举紧握头顶横枪 #12，兼容宽袖/重甲）
  'north-slam-overhead': {
    baseTorsoX: 0,
    backArm: { piece: 8, x: 0, y: -37, scaleX: -1, scaleY: -1, layer: 'behind-spear' },
    frontArm: { piece: 8, x: 0, y: -37, scaleX: 1, scaleY: -1, layer: 'behind-spear' },
  },
  // 北向伏龙震下砸顿枪（双手前压稳钉北向枪杆）
  'north-slam-down': {
    baseTorsoX: 0,
    backArm: { piece: 13, x: -1, y: -35, scaleX: -1, scaleY: -1, layer: 'behind-spear' },
    frontArm: { piece: 11, x: 1, y: -2, scaleX: 1, scaleY: 1, layer: 'behind-spear' },
  },
  // 北向双手立枪聚气（取消左手高举空拳，双手正握右侧立枪）
  'north-buff-upright': {
    baseTorsoX: 0,
    backArm: { piece: 13, x: 2, y: -3, scaleX: -1, scaleY: 1, layer: 'behind-spear' },
    frontArm: { piece: 8, x: 0, y: -1, scaleX: 1, scaleY: 1, layer: 'behind-spear' },
  },
};

/**
 * 西向战斗下盘（腿部 `coat-back`）预设（东向自动水平镜像同步）。
 * 使用全部 62 套下装共有的 3 张双脚全掌贴地战斗切片 `[6, 11, 18]`（均对齐至同一接地底边 `botY = 4`），
 * 彻底替代原版走路骨架 `pose-4071` 的迈步循环腿 `[7, 8, 9, 10]`，确保攻击与技能连播时人物稳扎下盘不出现原地走路。
 */
export type SpearLegsPreset = 'ready' | 'bow' | 'planted';

export interface SpearLegsPlacement {
  piece: number;
  x: number;
  y: number;
}

export const WEST_LEGS_PRESETS: Record<SpearLegsPreset, SpearLegsPlacement> = {
  // 挺拔战姿双脚稳立（起手 / 蓄势 / 收势）
  ready: { piece: 6, x: 0, y: -1 },
  // 实踩宽弓步（前脚全掌前踩、后腿斜蹬，直刺 / 连环点枪 / 大横扫爆发）
  bow: { piece: 11, x: 0, y: 1 },
  // 沉马扎稳下盘（双脚宽立沉实，与 pose-4077/4080 同源，舞花 / 砸地 / 低持蓄挑 / 低收）
  planted: { piece: 18, x: 1, y: 1 },
};

/**
 * 原版全换装通用的头部视角与发力切片映射（兼容全部 70 款发型/头盔、15 款后饰、11 款角色/佣兵脸型与 4 款披风）：
 * - south / west / turn-back / north：对应标准四视角切片 0 / 1 / 2 / 3（脸 body[0..3] + 颈 body[4..7]）
 * - south-action：南向低头冲锋/发力压眉切片 head-front/back[4] + body[0/4]
 * - west-action：西/东向低头猛刺/砸地压眉切片 head-front/back[5] + body[1/5]
 */
export type SpearHeadView = 'south' | 'west' | 'turn-back' | 'north' | 'south-action' | 'west-action';

export interface SpearHeadPose {
  /** 头部整体（body 脸/颈 + head-front + head-back）相对基础帧的水平偏移。 */
  dx?: number;
  /** 头部整体相对基础帧的垂直偏移（正值向下压身、负值抬头/前探）。 */
  dy?: number;
  /** 可选：切换头部视角或压眉发力切片，自动按原版配对同步 body / head-front / head-back。 */
  view?: SpearHeadView;
  /** 可选：覆写头部水平朝向（如北向右侧蓄枪时将 turn-back 镜像为 scaleX: -1）。 */
  scaleX?: number;
  /** 可选：联动平移上身躯干（coat-front 胸甲；西/东向 armsPreset 会自动同步双臂，双脚 coat-back 保持原地不动）。 */
  torsoDx?: number;
  torsoDy?: number;
  /** 可选：联动切换披风飘动切片（南 0..3 / 西 4..7 / 北 8..11）。 */
  cloakPiece?: number;
  /** 可选：披风偏移（未指定时默认跟随 torsoDx / torsoDy 贴合肩背）。 */
  cloakDx?: number;
  cloakDy?: number;
}

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
  /** 可选：该帧将整个人物（含换装与长枪）一同平移，用于居中修正或旋转中轴归中。 */
  bodyDx?: number;
  bodyDy?: number;
  /** 可选：单帧水平镜像原版基础身体帧（用于 360° 旋枪时的东向干净身位）。 */
  mirrorBaseFrame?: boolean;
  /** 可选：用标准西向双手持枪双臂替换原版基础帧的手臂切片（兼容全部 63 套上衣）。 */
  armsPreset?: SpearArmsPreset;
  /** 可选：用标准西向全掌贴地战斗下盘替换基础帧的 `coat-back` 腿部切片（兼容全部 62 套下装，杜绝走路腿）。 */
  legsPreset?: SpearLegsPreset;
  /** 可选：叠加头部（脸/颈/发型/头盔）、上身躯干与披风联动动态，保留双脚下盘原地稳定。 */
  headPose?: SpearHeadPose;
  scaleX?: number;
  scaleY?: number;
  angle?: number;
  /** 可选：武器透明度（默认 1 实色）。 */
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
  // 一、挺拔单手朝前微仰持枪待机（原版单手挺拔骨架 pose-3986..3988）
  {
    id: 'prototype-spear-idle-south', clip: 'idle-south', basePoseId: 'pose-3986-south-ticks-0',
    mirrorX: false, insertMode: 'before-right-arm-south', pieceEven: 20, pieceOdd: 21, baseX: -9, baseY: -9, scaleX: 1, scaleY: 1, angle: 0,
  },
  {
    id: 'prototype-spear-idle-west', clip: 'idle-west', basePoseId: 'pose-3987-west-ticks-0',
    mirrorX: false, insertMode: 'before-near-arm-west', pieceEven: 18, pieceOdd: 19, baseX: 1, baseY: -8, scaleX: 1, scaleY: 1, angle: 0,
  },
  {
    id: 'prototype-spear-idle-north', clip: 'idle-north', basePoseId: 'pose-3988-north-ticks-0',
    mirrorX: false, insertMode: 'before-cloak', pieceEven: 22, pieceOdd: 23, baseX: 9, baseY: -9, scaleX: 1, scaleY: 1, angle: 0,
  },
  {
    id: 'prototype-spear-idle-east', clip: 'idle-east', basePoseId: 'pose-3987-east-ticks-0',
    mirrorX: true, insertMode: 'before-near-arm-west', pieceEven: 18, pieceOdd: 19, baseX: 1, baseY: -8, scaleX: 1, scaleY: 1, angle: 0,
  },
  // 二、挺拔单手朝前微仰持枪行走（原版单手步行骨架 pose-3989..3991）
  {
    id: 'prototype-spear-walk-south', clip: 'walk-south', basePoseId: 'pose-3989-south-ticks-0',
    mirrorX: false, insertMode: 'before-right-arm-south', pieceEven: 20, pieceOdd: 21, swayPeriod: 2,
    baseX: -9, baseY: -9, scaleX: 1, scaleY: 1, angle: 0,
  },
  {
    id: 'prototype-spear-walk-west', clip: 'walk-west', basePoseId: 'pose-3990-west-ticks-0',
    mirrorX: false, insertMode: 'before-near-arm-west', pieceEven: 18, pieceOdd: 19, swayPeriod: 2,
    baseX: 2, baseY: -8, scaleX: 1, scaleY: 1, angle: 0,
  },
  {
    id: 'prototype-spear-walk-north', clip: 'walk-north', basePoseId: 'pose-3991-north-ticks-0',
    mirrorX: false, insertMode: 'before-cloak', pieceEven: 22, pieceOdd: 23, swayPeriod: 2,
    baseX: 9, baseY: -9, scaleX: 1, scaleY: 1, angle: 0,
  },
  {
    id: 'prototype-spear-walk-east', clip: 'walk-east', basePoseId: 'pose-3990-east-ticks-0',
    mirrorX: true, insertMode: 'before-near-arm-west', pieceEven: 18, pieceOdd: 19, swayPeriod: 2,
    baseX: 2, baseY: -8, scaleX: 1, scaleY: 1, angle: 0,
  },
  // 三、脱战斜背长枪待机（原版城镇待机骨架 pose-3980..3982）
  {
    id: 'prototype-spear-town-idle-south', clip: 'town-idle-south', basePoseId: 'pose-3980-south-ticks-0',
    mirrorX: false, insertMode: 'back', pieceEven: 24, pieceOdd: 25, baseX: 1, baseY: -19, scaleX: 1, scaleY: 1, angle: 0,
  },
  {
    id: 'prototype-spear-town-idle-west', clip: 'town-idle-west', basePoseId: 'pose-3981-west-ticks-0',
    mirrorX: false, insertMode: 'back', pieceEven: 26, pieceOdd: 27, baseX: 5, baseY: -19, scaleX: 1, scaleY: 1, angle: 0,
  },
  {
    id: 'prototype-spear-town-idle-north', clip: 'town-idle-north', basePoseId: 'pose-3982-north-ticks-0',
    mirrorX: false, insertMode: 'front', pieceEven: 24, pieceOdd: 25, baseX: -2, baseY: -16, scaleX: -1, scaleY: 1, angle: 0,
  },
  {
    id: 'prototype-spear-town-idle-east', clip: 'town-idle-east', basePoseId: 'pose-3981-east-ticks-0',
    mirrorX: true, insertMode: 'back', pieceEven: 26, pieceOdd: 27, baseX: 5, baseY: -19, scaleX: 1, scaleY: 1, angle: 0,
  },
  // 四、脱战斜背长枪行走（原版城镇行走骨架 pose-3983..3985）
  {
    id: 'prototype-spear-town-walk-south', clip: 'town-walk-south', basePoseId: 'pose-3983-south-ticks-0',
    mirrorX: false, insertMode: 'back', pieceEven: 24, pieceOdd: 25, swayPeriod: 2, baseX: 1, baseY: -19, scaleX: 1, scaleY: 1, angle: 0,
  },
  {
    id: 'prototype-spear-town-walk-west', clip: 'town-walk-west', basePoseId: 'pose-3984-west-ticks-0',
    mirrorX: false, insertMode: 'back', pieceEven: 26, pieceOdd: 27, swayPeriod: 2, baseX: 5, baseY: -19, scaleX: 1, scaleY: 1, angle: 0,
  },
  {
    id: 'prototype-spear-town-walk-north', clip: 'town-walk-north', basePoseId: 'pose-3985-north-ticks-0',
    mirrorX: false, insertMode: 'front', pieceEven: 24, pieceOdd: 25, swayPeriod: 2, baseX: -2, baseY: -16, scaleX: -1, scaleY: 1, angle: 0,
  },
  {
    id: 'prototype-spear-town-walk-east', clip: 'town-walk-east', basePoseId: 'pose-3984-east-ticks-0',
    mirrorX: true, insertMode: 'back', pieceEven: 26, pieceOdd: 27, swayPeriod: 2, baseX: 5, baseY: -19, scaleX: 1, scaleY: 1, angle: 0,
  },
  // 五、立枪待机（单手直立对照）
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
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 6, x: 5, y: -11, armsPreset: 'thrust-coil', headPose: { dx: 1, dy: -1, torsoDx: 1, cloakPiece: 6 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 6, x: 10, y: -11, armsPreset: 'thrust-coil', headPose: { view: 'turn-back', dx: 2, dy: -1, torsoDx: 1, cloakPiece: 6 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 6, x: -12, y: -11, armsPreset: 'thrust-extend', legsPreset: 'bow', headPose: { view: 'west-action', dx: -3, dy: 1, torsoDx: -2, torsoDy: 1, cloakPiece: 5 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 6, x: -15, y: -11, armsPreset: 'thrust-extend', legsPreset: 'bow', headPose: { view: 'west-action', dx: -4, dy: 2, torsoDx: -2, torsoDy: 1, cloakPiece: 7 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 6, x: -14, y: -11, armsPreset: 'thrust-extend', legsPreset: 'bow', headPose: { view: 'west-action', dx: -3, dy: 2, torsoDx: -2, torsoDy: 1, cloakPiece: 5 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 6, x: -9, y: -11, armsPreset: 'thrust-extend', legsPreset: 'bow', headPose: { view: 'west-action', dx: -2, dy: 1, torsoDx: -1, torsoDy: 1, cloakPiece: 5 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 6, x: -3, y: -11, armsPreset: 'flurry-mid', legsPreset: 'bow', headPose: { dx: -1, dy: 1, torsoDx: -1, cloakPiece: 4 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 2, x: -2, y: -10, armsPreset: 'thrust-coil', headPose: { dx: 0, dy: 0, cloakPiece: 4 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 3, x: -3, y: -10, insertMode: 'between-west-arms' },
];

const THRUST_SOUTH_FRAMES: readonly SpearKeyframeSpec[] = [
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 0, piece: 0, x: 0, y: -8, armsPreset: 'south-ready', insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 0, piece: 7, x: -5, y: -12, armsPreset: 'south-thrust-coil', headPose: { dy: -1, cloakPiece: 1 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 1, piece: 7, x: -5, y: -15, armsPreset: 'south-thrust-coil', headPose: { dx: 1, dy: -2, cloakPiece: 1 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 2, piece: 7, x: -3, y: 4, armsPreset: 'south-thrust-extend', headPose: { view: 'south-action', dy: 1, cloakPiece: 2 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 2, piece: 7, x: -3, y: 8, armsPreset: 'south-thrust-extend', headPose: { view: 'south-action', dy: 2, cloakPiece: 3 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 2, piece: 7, x: -3, y: 7, armsPreset: 'south-thrust-extend', headPose: { view: 'south-action', dy: 1, cloakPiece: 2 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 3, piece: 7, x: -3, y: 1, armsPreset: 'south-thrust-extend', headPose: { view: 'south-action', dy: 0, cloakPiece: 2 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 3, piece: 7, x: -4, y: -5, armsPreset: 'south-thrust-extend', headPose: { dy: -1, cloakPiece: 1 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 4, piece: 0, x: -1, y: -7, armsPreset: 'south-ready', headPose: { dy: 0, cloakPiece: 0 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 0, piece: 1, x: 0, y: -8, armsPreset: 'south-ready', insertMode: 'between-south-arms' },
];

const THRUST_NORTH_FRAMES: readonly SpearKeyframeSpec[] = [
  { sourcePoseId: 'pose-3988-north-ticks-0', sourceFrame: 0, piece: 22, x: 8, y: -9, armsPreset: 'north-ready', insertMode: 'back' },
  { sourcePoseId: 'pose-4063-north-ticks-0', sourceFrame: 0, piece: 8, x: 11, y: -10, armsPreset: 'north-thrust-coil', headPose: { view: 'turn-back', scaleX: -1, dx: 1, dy: -1, cloakPiece: 9 }, insertMode: 'back' },
  { sourcePoseId: 'pose-4063-north-ticks-0', sourceFrame: 1, piece: 8, x: 12, y: -8, armsPreset: 'north-thrust-coil', headPose: { view: 'turn-back', scaleX: -1, dx: 2, dy: 0, cloakPiece: 10 }, insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 4, piece: 8, x: 6, y: -21, armsPreset: 'north-thrust-extend', headPose: { dy: -2, cloakPiece: 11 }, insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 4, piece: 8, x: 6, y: -24, armsPreset: 'north-thrust-extend', headPose: { dy: -3, cloakPiece: 10 }, insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 4, piece: 8, x: 6, y: -23, armsPreset: 'north-thrust-extend', headPose: { dy: -2, cloakPiece: 11 }, insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 4, piece: 8, x: 8, y: -17, armsPreset: 'north-thrust-extend', headPose: { dy: -1, cloakPiece: 9 }, insertMode: 'back' },
  { sourcePoseId: 'pose-4063-north-ticks-0', sourceFrame: 0, piece: 8, x: 11, y: -11, armsPreset: 'north-thrust-coil', headPose: { dx: 1, dy: 0, cloakPiece: 9 }, insertMode: 'back' },
  { sourcePoseId: 'pose-3988-north-ticks-0', sourceFrame: 0, piece: 22, x: 8, y: -10, armsPreset: 'north-ready', headPose: { dy: -1, cloakPiece: 8 }, insertMode: 'back' },
  { sourcePoseId: 'pose-3988-north-ticks-0', sourceFrame: 0, piece: 23, x: 8, y: -9, armsPreset: 'north-ready', insertMode: 'back' },
];

const SWEEP_SOUTH_FRAMES: readonly SpearKeyframeSpec[] = [
  // 原版 pose-4073 脚步自带 -3.5..+3.5px 侧滑，用 bodyDx 反向补偿将双脚视觉中心定在原地，并全程装配南向双手预设替代单臂/举空手
  { sourcePoseId: 'pose-4073-south-ticks-0', sourceFrame: 0, piece: 0, x: -4, y: -10, bodyDx: 2, armsPreset: 'south-sweep-left', insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4073-south-ticks-0', sourceFrame: 1, piece: 11, x: -6, y: -11, bodyDx: 2, armsPreset: 'south-sweep-left', insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4073-south-ticks-0', sourceFrame: 2, piece: 11, x: -7, y: -10, bodyDx: 3, armsPreset: 'south-sweep-left', insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4073-south-ticks-0', sourceFrame: 3, piece: 9, x: -6, y: -5, bodyDx: -1, armsPreset: 'south-sweep-left', insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4073-south-ticks-0', sourceFrame: 4, piece: 9, x: 6, y: -5, bodyDx: -3, scaleX: -1, armsPreset: 'south-sweep-right', insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4073-south-ticks-0', sourceFrame: 5, piece: 10, x: 8, y: -7, bodyDx: -3, scaleX: -1, armsPreset: 'south-sweep-right', headPose: { view: 'south-action', dy: 1 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4073-south-ticks-0', sourceFrame: 6, piece: 2, x: 6, y: -8, bodyDx: -3, scaleX: -1, armsPreset: 'south-sweep-right', headPose: { dy: 1 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4073-south-ticks-0', sourceFrame: 7, piece: 0, x: 4, y: -8, bodyDx: -3, scaleX: -1, armsPreset: 'south-sweep-right', insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4073-south-ticks-0', sourceFrame: 8, piece: 11, x: 4, y: -10, bodyDx: -3, scaleX: -1, armsPreset: 'south-sweep-right', insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4073-south-ticks-0', sourceFrame: 9, piece: 0, x: 2, y: -9, bodyDx: -3, scaleX: -1, armsPreset: 'south-ready', insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4073-south-ticks-0', sourceFrame: 10, piece: 0, x: 1, y: -8, bodyDx: -3, armsPreset: 'south-ready', insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 0, piece: 1, x: 0, y: -8, armsPreset: 'south-ready', insertMode: 'between-south-arms' },
];

const SWEEP_WEST_FRAMES: readonly SpearKeyframeSpec[] = [
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 11, x: 3, y: -14, scaleX: -1, armsPreset: 'sweep-windup', headPose: { view: 'turn-back', dx: 1, dy: -1, torsoDx: 1, cloakPiece: 6 }, insertMode: 'back' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 4, x: 4, y: -15, armsPreset: 'sweep-windup', headPose: { view: 'turn-back', dx: 2, dy: -1, torsoDx: 1, cloakPiece: 6 }, insertMode: 'back' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 11, x: 0, y: -15, armsPreset: 'sweep-raise', headPose: { dx: 0, dy: -1, cloakPiece: 5 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 11, x: -6, y: -13, armsPreset: 'sweep-raise', legsPreset: 'bow', headPose: { view: 'west-action', dx: -2, dy: 0, torsoDx: -1, cloakPiece: 5 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 10, x: -12, y: -10, armsPreset: 'sweep-cut', legsPreset: 'bow', headPose: { view: 'west-action', dx: -4, dy: 2, torsoDx: -2, torsoDy: 1, cloakPiece: 7 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 9, x: -9, y: -6, armsPreset: 'sweep-low', legsPreset: 'planted', headPose: { view: 'south-action', dx: -2, dy: 2, torsoDx: -1, torsoDy: 1, cloakPiece: 5 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 9, x: -8, y: -6, armsPreset: 'sweep-low', legsPreset: 'planted', headPose: { view: 'south', dx: -1, dy: 2, torsoDx: -1, torsoDy: 1, cloakPiece: 4 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 2, x: -6, y: -8, armsPreset: 'flurry-mid', legsPreset: 'planted', headPose: { dx: -1, dy: 1, cloakPiece: 4 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 2, x: -4, y: -9, armsPreset: 'thrust-coil', headPose: { dx: 0, dy: 0, cloakPiece: 4 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 3, x: -3, y: -10, headPose: { dx: 0, dy: 1 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 2, x: -3, y: -10, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 1, piece: 3, x: -3, y: -10, insertMode: 'between-west-arms' },
];

const SWEEP_NORTH_FRAMES: readonly SpearKeyframeSpec[] = [
  // 北向平扫全程抬升至胸肩高度并装配北向双手预设，杜绝枪尾扫过两腿空隙与单臂错位
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 0, piece: 0, x: 6, y: -18, bodyDx: -2, scaleX: -1, armsPreset: 'north-sweep-right', insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 1, piece: 10, x: 8, y: -21, bodyDx: -3, bodyDy: -1, scaleX: -1, armsPreset: 'north-sweep-right', insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 2, piece: 11, x: 8, y: -18, bodyDx: -4, bodyDy: -2, scaleX: -1, armsPreset: 'north-sweep-right', insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 3, piece: 8, x: 9, y: -21, bodyDx: -3, armsPreset: 'north-thrust-extend', insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 4, piece: 10, x: -8, y: -21, bodyDy: -1, armsPreset: 'north-sweep-left', insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 5, piece: 11, x: -9, y: -20, armsPreset: 'north-sweep-left', insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 6, piece: 0, x: -9, y: -18, armsPreset: 'north-sweep-left', insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 7, piece: 0, x: -7, y: -18, armsPreset: 'north-sweep-left', insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 8, piece: 11, x: -4, y: -18, bodyDx: 3, armsPreset: 'north-sweep-left', insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 9, piece: 11, x: 4, y: -18, bodyDx: 2, scaleX: -1, armsPreset: 'north-sweep-right', insertMode: 'back' },
  { sourcePoseId: 'pose-3988-north-ticks-0', sourceFrame: 0, piece: 22, x: 8, y: -10, armsPreset: 'north-ready', insertMode: 'back' },
  { sourcePoseId: 'pose-3988-north-ticks-0', sourceFrame: 0, piece: 23, x: 8, y: -9, armsPreset: 'north-ready', insertMode: 'back' },
];

// ---------------------------------------------------------------------------
// 第一批新增技能动作：
// 1. 普通攻击三段循环（attack 轻刺 8 帧 + attack-2 横扫 7 帧 + attack-3 上挑 8 帧，无控制）
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

// 1B. 普攻第二段 · 横扫（7 帧，全四向双手水平横扫，F2 出素银正方向横扫弧光、F3 命中）
const ATK2_SOUTH_FRAMES: readonly SpearKeyframeSpec[] = [
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 0, piece: 10, x: -7, y: -9, armsPreset: 'south-sweep-left', headPose: { view: 'south', scaleX: 1, dx: -2, dy: -1, cloakPiece: 1 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4073-south-ticks-0', sourceFrame: 3, piece: 9, x: -6, y: -5, bodyDx: -1, armsPreset: 'south-sweep-left', headPose: { view: 'south-action', scaleX: 1, dx: -2, dy: -2, cloakPiece: 2 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 0, piece: 7, x: -1, y: -2, armsPreset: 'south-sweep-center', headPose: { view: 'south-action', scaleX: 1, dx: 0, dy: 2, cloakPiece: 3 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4073-south-ticks-0', sourceFrame: 4, piece: 9, x: 6, y: -5, bodyDx: -3, scaleX: -1, armsPreset: 'south-sweep-right', headPose: { view: 'south-action', scaleX: 1, dx: -1, dy: 2, cloakPiece: 3 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4073-south-ticks-0', sourceFrame: 5, piece: 10, x: 8, y: -7, bodyDx: -3, scaleX: -1, armsPreset: 'south-sweep-right', headPose: { view: 'south-action', scaleX: 1, dx: 0, dy: 1, cloakPiece: 2 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4073-south-ticks-0', sourceFrame: 10, piece: 0, x: 1, y: -8, bodyDx: -3, armsPreset: 'south-ready', headPose: { view: 'south', scaleX: 1, cloakPiece: 0 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 0, piece: 1, x: 0, y: -8, armsPreset: 'south-ready', insertMode: 'between-south-arms' },
];
const ATK2_WEST_FRAMES: readonly SpearKeyframeSpec[] = [
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 2, x: 2, y: -12, armsPreset: 'sweep-raise', headPose: { view: 'west', dx: 1, dy: -1, torsoDx: 1, cloakPiece: 6 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 2, x: -6, y: -11, armsPreset: 'sweep-cut', legsPreset: 'bow', headPose: { view: 'west-action', dx: -2, dy: 0, torsoDx: -1, cloakPiece: 5 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 10, x: -12, y: -10, armsPreset: 'sweep-cut', legsPreset: 'bow', headPose: { view: 'west-action', dx: -4, dy: 2, torsoDx: -2, torsoDy: 1, cloakPiece: 7 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 10, x: -11, y: -9, armsPreset: 'sweep-cut', legsPreset: 'planted', headPose: { view: 'west-action', dx: -3, dy: 2, torsoDx: -2, torsoDy: 1, cloakPiece: 7 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 2, x: -7, y: -9, armsPreset: 'sweep-low', legsPreset: 'planted', headPose: { view: 'west-action', dx: -2, dy: 1, torsoDx: -1, cloakPiece: 5 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 2, x: -4, y: -10, armsPreset: 'thrust-coil', headPose: { view: 'west', dx: 0, dy: 0, cloakPiece: 4 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 3, x: -3, y: -10, armsPreset: 'thrust-coil', insertMode: 'between-west-arms' },
];
const ATK2_NORTH_FRAMES: readonly SpearKeyframeSpec[] = [
  { sourcePoseId: 'pose-4069-north-ticks-0', sourceFrame: 0, piece: 10, x: 8, y: -21, scaleX: -1, armsPreset: 'north-sweep-right', headPose: { view: 'north', scaleX: 1, dx: 2, dy: 1, cloakPiece: 9 }, insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 4, piece: 11, x: 6, y: -20, scaleX: -1, armsPreset: 'north-sweep-right', headPose: { view: 'north', scaleX: 1, dx: 2, dy: -1, cloakPiece: 10 }, insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 4, piece: 8, x: 6, y: -21, armsPreset: 'north-thrust-extend', headPose: { view: 'north', scaleX: 1, dx: 0, dy: -3, cloakPiece: 11 }, insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 4, piece: 10, x: -9, y: -21, armsPreset: 'north-sweep-left', headPose: { view: 'north', scaleX: 1, dx: -2, dy: -2, cloakPiece: 11 }, insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 4, piece: 0, x: -8, y: -18, armsPreset: 'north-sweep-left', headPose: { view: 'north', scaleX: 1, dx: -1, dy: -1, cloakPiece: 9 }, insertMode: 'back' },
  { sourcePoseId: 'pose-3988-north-ticks-0', sourceFrame: 0, piece: 22, x: 8, y: -10, armsPreset: 'north-ready', headPose: { view: 'north', scaleX: 1, dy: -1, cloakPiece: 8 }, insertMode: 'back' },
  { sourcePoseId: 'pose-3988-north-ticks-0', sourceFrame: 0, piece: 23, x: 8, y: -9, armsPreset: 'north-ready', insertMode: 'back' },
];

// 1C. 普攻第三段 · 上挑（8 帧，不产生控制：全四向双手紧扣枪杆低蓄 → 迅猛上挑 → 高位微顿 → 平滑回落，彻底消除手枪分离）
const ATK3_WEST_FRAMES: readonly SpearKeyframeSpec[] = [
  // F0：战姿微沉
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 2, x: -3, y: -10, armsPreset: 'thrust-coil', insertMode: 'between-west-arms' },
  // F1：沉马低持蓄挑，双手压低控枪
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 13, x: -5, y: -3, armsPreset: 'sweep-low', legsPreset: 'planted', headPose: { view: 'west-action', dx: -2, dy: 3, torsoDx: -1, torsoDy: 1, cloakPiece: 5 }, insertMode: 'between-west-arms' },
  // F2：迅猛起挑破空（触发 3 帧素银上挑弧光 spear-basic-lift）
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 2, x: -7, y: -9, armsPreset: 'sweep-cut', legsPreset: 'planted', headPose: { view: 'west', dx: -1, dy: -1, torsoDx: -1, cloakPiece: 6 }, insertMode: 'between-west-arms' },
  // F3：挑枪命中帧（双手高挑紧扣斜上枪杆 #11，替换脱手的 pose-4080）
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 11, x: -4, y: -17, armsPreset: 'lift-mid', legsPreset: 'planted', headPose: { view: 'west', dx: -1, dy: -2, torsoDx: -1, cloakPiece: 6 }, insertMode: 'between-west-arms' },
  // F4：挑势顶点微顿
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 11, x: -4, y: -19, armsPreset: 'lift-high', legsPreset: 'planted', headPose: { view: 'west', dx: 0, dy: -3, torsoDx: -1, torsoDy: -1, cloakPiece: 6 }, insertMode: 'between-west-arms' },
  // F5..F7：顺势回落归回战姿
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 11, x: -4, y: -17, armsPreset: 'lift-mid', legsPreset: 'planted', headPose: { view: 'west', dx: -1, dy: -1, torsoDx: -1, cloakPiece: 5 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 2, x: -4, y: -10, armsPreset: 'flurry-mid', legsPreset: 'planted', headPose: { view: 'west', dx: -1, dy: 1, cloakPiece: 5 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 3, x: -3, y: -10, armsPreset: 'thrust-coil', insertMode: 'between-west-arms' },
];

const ATK3_SOUTH_FRAMES: readonly SpearKeyframeSpec[] = [
  // F0：正南竖枪居中起势（全程 x=0 纯竖直零斜角）
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 0, piece: 7, x: 0, y: -5, armsPreset: 'south-sweep-center', insertMode: 'between-south-arms' },
  // F1：压身沉腕将枪尖下压至正南地面蓄挑
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 0, piece: 7, x: 0, y: 2, armsPreset: 'south-lift-low', headPose: { view: 'south-action', scaleX: 1, dx: 0, dy: 2, torsoDy: 1, cloakPiece: 2 }, insertMode: 'between-south-arms' },
  // F2：沿正南竖直中轴翻锋猛挑破空（F2 触发正中纵向素银挑光 spear-basic-lift）
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 0, piece: 16, x: 0, y: -9, armsPreset: 'south-lift-mid', headPose: { view: 'south', scaleX: 1, dx: 0, dy: 0, cloakPiece: 1 }, insertMode: 'front' },
  // F3：正中冲天挑枪命中帧（纯竖直 #17 直指正上方，双手于下巴以下紧扣木杆不遮脸）
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 0, piece: 17, x: 0, y: -21, armsPreset: 'south-lift-high', headPose: { view: 'south', scaleX: 1, dx: 0, dy: -2, torsoDy: -1, cloakPiece: 3 }, insertMode: 'front' },
  // F4：挑势顶点微顿
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 0, piece: 17, x: 0, y: -24, armsPreset: 'south-lift-high', headPose: { view: 'south', scaleX: 1, dx: 0, dy: -3, torsoDy: -1, cloakPiece: 3 }, insertMode: 'front' },
  // F5..F7：沿正中竖直轴顺滑回落归位
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 0, piece: 17, x: 0, y: -20, armsPreset: 'south-lift-high', headPose: { view: 'south', scaleX: 1, dx: 0, dy: -1, cloakPiece: 2 }, insertMode: 'front' },
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 0, piece: 16, x: 0, y: -9, armsPreset: 'south-lift-mid', headPose: { view: 'south', scaleX: 1, dx: 0, dy: 0, cloakPiece: 1 }, insertMode: 'front' },
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 0, piece: 7, x: 0, y: -5, armsPreset: 'south-sweep-center', insertMode: 'between-south-arms' },
];

const ATK3_NORTH_FRAMES: readonly SpearKeyframeSpec[] = [
  // F0：正北居中纯竖直执枪起势（枪尾底端 y=-14 < -8，双腿间 0 漏像素）
  { sourcePoseId: 'pose-4069-north-ticks-0', sourceFrame: 0, piece: 16, x: 0, y: -24, armsPreset: 'north-lift-mid', headPose: { view: 'north', scaleX: 1, dx: -1, dy: 0, cloakPiece: 8 }, insertMode: 'back' },
  // F1：背身沉腕向正北地面压枪蓄挑（枪尾底端 y=-11 < -8，零斜角、零漏枪把）
  { sourcePoseId: 'pose-4069-north-ticks-0', sourceFrame: 0, piece: 16, x: 0, y: -21, armsPreset: 'north-lift-mid', headPose: { view: 'north', scaleX: 1, dx: -1, dy: 2, torsoDy: 1, cloakPiece: 9 }, insertMode: 'back' },
  // F2：沿正北竖直中轴拔枪猛挑（F2 触发正北纵向素银挑光 spear-basic-lift）
  { sourcePoseId: 'pose-4069-north-ticks-0', sourceFrame: 0, piece: 17, x: 0, y: -29, armsPreset: 'north-lift-mid', headPose: { view: 'north', scaleX: 1, dx: -1, dy: -1, cloakPiece: 10 }, insertMode: 'back' },
  // F3：正北冲天挑枪命中帧（纯竖直 #17 居中冲顶，双臂对称上举紧握枪杆）
  { sourcePoseId: 'pose-4069-north-ticks-0', sourceFrame: 0, piece: 17, x: 0, y: -34, armsPreset: 'north-lift-high', headPose: { view: 'north', scaleX: 1, dx: -1, dy: -2, torsoDy: -1, cloakPiece: 11 }, insertMode: 'back' },
  // F4：挑势顶点微顿
  { sourcePoseId: 'pose-4069-north-ticks-0', sourceFrame: 0, piece: 17, x: 0, y: -37, armsPreset: 'north-lift-high', headPose: { view: 'north', scaleX: 1, dx: -1, dy: -3, torsoDy: -1, cloakPiece: 11 }, insertMode: 'back' },
  // F5..F7：沿正北竖直中轴顺势回落归位
  { sourcePoseId: 'pose-4069-north-ticks-0', sourceFrame: 0, piece: 17, x: 0, y: -33, armsPreset: 'north-lift-high', headPose: { view: 'north', scaleX: 1, dx: -1, dy: -1, cloakPiece: 10 }, insertMode: 'back' },
  { sourcePoseId: 'pose-4069-north-ticks-0', sourceFrame: 0, piece: 16, x: 0, y: -26, armsPreset: 'north-lift-mid', headPose: { view: 'north', scaleX: 1, dx: -1, dy: 0, cloakPiece: 9 }, insertMode: 'back' },
  { sourcePoseId: 'pose-4069-north-ticks-0', sourceFrame: 0, piece: 16, x: 0, y: -24, armsPreset: 'north-lift-mid', headPose: { view: 'north', scaleX: 1, dx: -1, dy: 0, cloakPiece: 8 }, insertMode: 'back' },
];

// 2. 旋风枪舞（18 帧：2 帧沉腰起转 → 12 帧三整圈 360° 周身疾旋 → 1 帧归位爆散终结 → 3 帧稳步收枪）
const SPIN_CARDINAL_S: SpearKeyframeSpec = {
  sourcePoseId: 'pose-4094-south-ticks-24', sourceFrame: 3, piece: 7, x: -1, y: -4, bodyDx: 0, armsPreset: 'south-sweep-center', headPose: { view: 'south-action', cloakPiece: 2 }, insertMode: 'between-south-arms',
};
const SPIN_CARDINAL_E: SpearKeyframeSpec = {
  sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, armsPreset: 'sweep-cut', legsPreset: 'bow', headPose: { view: 'west-action', dx: -2, dy: 1, torsoDx: -1, cloakPiece: 7 }, mirrorBaseFrame: true, piece: 10, x: 13, y: -10, scaleX: -1, bodyDx: -1, insertMode: 'between-west-arms',
};
const SPIN_CARDINAL_N: SpearKeyframeSpec = {
  sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 4, piece: 8, x: 6, y: -19, bodyDx: 0, armsPreset: 'north-thrust-extend', headPose: { dy: -1, cloakPiece: 11 }, insertMode: 'back',
};
const SPIN_CARDINAL_W: SpearKeyframeSpec = {
  sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, armsPreset: 'sweep-cut', legsPreset: 'bow', headPose: { view: 'west-action', dx: -2, dy: 1, torsoDx: -1, cloakPiece: 7 }, piece: 10, x: -13, y: -10, scaleX: 1, bodyDx: 1, insertMode: 'between-west-arms',
};

const SPIN_STORM_SOUTH_FRAMES: readonly SpearKeyframeSpec[] = [
  // F0..F1：沉腰拧枪起转
  { sourcePoseId: 'pose-4094-south-ticks-24', sourceFrame: 0, piece: 0, x: -2, y: -9, armsPreset: 'south-ready', insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4094-south-ticks-24', sourceFrame: 2, piece: 9, x: -4, y: -5, armsPreset: 'south-sweep-left', insertMode: 'between-south-arms' },
  // F2..F13：三整圈高速 360° 逆时针旋枪（南 → 东 → 北 → 西 × 3）
  SPIN_CARDINAL_S, SPIN_CARDINAL_E, SPIN_CARDINAL_N, SPIN_CARDINAL_W,
  SPIN_CARDINAL_S, SPIN_CARDINAL_E, SPIN_CARDINAL_N, SPIN_CARDINAL_W,
  SPIN_CARDINAL_S, SPIN_CARDINAL_E, SPIN_CARDINAL_N, SPIN_CARDINAL_W,
  // F14：收满三圈归位南向 + 360° 气浪爆散终结
  SPIN_CARDINAL_S,
  // F15..F17：顺势减速收枪回南向战姿（双手实握）
  { sourcePoseId: 'pose-4073-south-ticks-0', sourceFrame: 10, piece: 9, x: 1, y: -6, scaleX: -1, bodyDx: -1, armsPreset: 'south-sweep-right', insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 0, piece: 0, x: 0, y: -8, armsPreset: 'south-ready', insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 1, piece: 1, x: 0, y: -8, armsPreset: 'south-ready', insertMode: 'between-south-arms' },
];

const SPIN_STORM_WEST_FRAMES: readonly SpearKeyframeSpec[] = [
  // F0..F1：挺胸实踩弓步平枪起转（西向起步，东向镜像后自动从东向起步）
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 2, x: -3, y: -10, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 10, x: -7, y: -10, bodyDx: 1, armsPreset: 'sweep-cut', legsPreset: 'bow', headPose: { view: 'west-action', dx: -2, dy: 1, torsoDx: -1, cloakPiece: 5 }, insertMode: 'between-west-arms' },
  // F2..F13：三整圈高速 360° 旋枪（西 → 南 → 东 → 北 × 3）
  SPIN_CARDINAL_W, SPIN_CARDINAL_S, SPIN_CARDINAL_E, SPIN_CARDINAL_N,
  SPIN_CARDINAL_W, SPIN_CARDINAL_S, SPIN_CARDINAL_E, SPIN_CARDINAL_N,
  SPIN_CARDINAL_W, SPIN_CARDINAL_S, SPIN_CARDINAL_E, SPIN_CARDINAL_N,
  // F14：收满三圈归位西向 + 360° 气浪爆散终结
  SPIN_CARDINAL_W,
  // F15..F17：顺势减速沉马收枪回西向战姿
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 9, x: -6, y: -8, armsPreset: 'sweep-low', legsPreset: 'planted', headPose: { view: 'south', dx: -1, dy: 2, torsoDx: -1, torsoDy: 1, cloakPiece: 5 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 2, x: -3, y: -10, headPose: { dx: 0, dy: 1, cloakPiece: 4 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 1, piece: 3, x: -3, y: -10, insertMode: 'between-west-arms' },
];

const SPIN_STORM_NORTH_FRAMES: readonly SpearKeyframeSpec[] = [
  // F0..F1：沉腰拧枪起转（胸肩高度起势，双手实握、枪尾不扫双腿）
  { sourcePoseId: 'pose-3988-north-ticks-0', sourceFrame: 0, piece: 22, x: 8, y: -9, armsPreset: 'north-ready', insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 1, piece: 11, x: 6, y: -19, scaleX: -1, armsPreset: 'north-sweep-right', insertMode: 'back' },
  // F2..F13：三整圈高速 360° 旋枪（北 → 西 → 南 → 东 × 3）
  SPIN_CARDINAL_N, SPIN_CARDINAL_W, SPIN_CARDINAL_S, SPIN_CARDINAL_E,
  SPIN_CARDINAL_N, SPIN_CARDINAL_W, SPIN_CARDINAL_S, SPIN_CARDINAL_E,
  SPIN_CARDINAL_N, SPIN_CARDINAL_W, SPIN_CARDINAL_S, SPIN_CARDINAL_E,
  // F14：收满三圈归位北向 + 360° 气浪爆散终结
  SPIN_CARDINAL_N,
  // F15..F17：顺势沿右上减速收枪回北向战姿
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 9, piece: 11, x: 5, y: -19, bodyDx: 3, scaleX: -1, armsPreset: 'north-sweep-right', insertMode: 'back' },
  { sourcePoseId: 'pose-3988-north-ticks-0', sourceFrame: 0, piece: 22, x: 8, y: -10, armsPreset: 'north-ready', insertMode: 'back' },
  { sourcePoseId: 'pose-3988-north-ticks-0', sourceFrame: 0, piece: 23, x: 8, y: -9, armsPreset: 'north-ready', insertMode: 'back' },
];

// 3. 狂龙穿心破（12 帧，纯原地定脚发力：4 帧蓄枪后引 → 原地满弓步赤金破甲重刺 → 稳步收势，人物不位移、头部锁定正前方不转向）
const DRAGON_PIERCE_WEST_FRAMES: readonly SpearKeyframeSpec[] = [
  // F0..F3：原地挺胸蓄枪后引（目光全程锁正西，只做抬头后收与压眉蓄力，绝不转头）
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 2, x: -2, y: -10, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 6, x: 6, y: -11, armsPreset: 'thrust-coil', headPose: { view: 'west', dx: 1, dy: -1, torsoDx: 1, cloakPiece: 6 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 6, x: 11, y: -11, armsPreset: 'thrust-coil', headPose: { view: 'west', dx: 2, dy: -2, torsoDx: 1, torsoDy: -1, cloakPiece: 6 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 6, x: 12, y: -11, armsPreset: 'thrust-coil', headPose: { view: 'west-action', dx: 2, dy: 0, torsoDx: 1, cloakPiece: 7 }, insertMode: 'between-west-arms' },
  // F4..F6：原地实踩宽弓步全臂贯刺（全程定格 bow 下盘、零位移不踏步 + 赤金破甲芒爆发！）
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 6, x: -13, y: -11, armsPreset: 'thrust-extend', legsPreset: 'bow', headPose: { view: 'west-action', dx: -3, dy: 1, torsoDx: -2, torsoDy: 1, cloakPiece: 5 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 6, x: -16, y: -11, armsPreset: 'thrust-extend', legsPreset: 'bow', headPose: { view: 'west-action', dx: -4, dy: 2, torsoDx: -2, torsoDy: 1, cloakPiece: 7 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 6, x: -15, y: -11, armsPreset: 'thrust-extend', legsPreset: 'bow', headPose: { view: 'west-action', dx: -4, dy: 3, torsoDx: -2, torsoDy: 1, cloakPiece: 7 }, insertMode: 'between-west-arms' },
  // F7..F11：强顿帧后原地撤枪回防
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 6, x: -11, y: -11, armsPreset: 'thrust-extend', legsPreset: 'bow', headPose: { view: 'west-action', dx: -3, dy: 2, torsoDx: -1, torsoDy: 1, cloakPiece: 5 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 6, x: -6, y: -11, armsPreset: 'flurry-mid', legsPreset: 'bow', headPose: { view: 'west-action', dx: -2, dy: 1, torsoDx: -1, cloakPiece: 5 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 2, x: -2, y: -10, armsPreset: 'thrust-coil', headPose: { dx: 0, dy: 0, cloakPiece: 4 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 2, x: -3, y: -10, headPose: { dx: 0, dy: 1 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 3, x: -3, y: -10, insertMode: 'between-west-arms' },
];

const DRAGON_PIERCE_SOUTH_FRAMES: readonly SpearKeyframeSpec[] = [
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 0, piece: 0, x: 0, y: -8, armsPreset: 'south-ready', insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 0, piece: 7, x: -5, y: -12, armsPreset: 'south-thrust-coil', headPose: { dy: -1, cloakPiece: 1 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 1, piece: 7, x: -5, y: -15, armsPreset: 'south-thrust-coil', headPose: { dx: 1, dy: -2, cloakPiece: 1 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 1, piece: 7, x: -5, y: -16, armsPreset: 'south-thrust-coil', headPose: { dx: 1, dy: -1, cloakPiece: 3 }, insertMode: 'between-south-arms' },
  // 原地向南双手猛刺（无人物位移）
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 2, piece: 7, x: -3, y: 4, armsPreset: 'south-thrust-extend', headPose: { view: 'south-action', dy: 1, cloakPiece: 2 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 2, piece: 7, x: -3, y: 8, armsPreset: 'south-thrust-extend', headPose: { view: 'south-action', dy: 2, cloakPiece: 3 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 2, piece: 7, x: -3, y: 7, armsPreset: 'south-thrust-extend', headPose: { view: 'south-action', dy: 1, cloakPiece: 2 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 3, piece: 7, x: -3, y: 2, armsPreset: 'south-thrust-extend', headPose: { view: 'south-action', dy: 0, cloakPiece: 2 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 3, piece: 7, x: -4, y: -4, armsPreset: 'south-thrust-extend', headPose: { dy: -1, cloakPiece: 1 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 4, piece: 0, x: -1, y: -7, armsPreset: 'south-ready', headPose: { dy: 0, cloakPiece: 0 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 0, piece: 0, x: 0, y: -8, armsPreset: 'south-ready', headPose: { dy: 1 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 0, piece: 1, x: 0, y: -8, armsPreset: 'south-ready', insertMode: 'between-south-arms' },
];

const DRAGON_PIERCE_NORTH_FRAMES: readonly SpearKeyframeSpec[] = [
  { sourcePoseId: 'pose-3988-north-ticks-0', sourceFrame: 0, piece: 22, x: 8, y: -9, armsPreset: 'north-ready', insertMode: 'back' },
  { sourcePoseId: 'pose-4063-north-ticks-0', sourceFrame: 0, piece: 8, x: 11, y: -10, armsPreset: 'north-thrust-coil', headPose: { view: 'north', scaleX: 1, dx: 1, dy: 1, cloakPiece: 9 }, insertMode: 'back' },
  { sourcePoseId: 'pose-4063-north-ticks-0', sourceFrame: 1, piece: 8, x: 12, y: -8, armsPreset: 'north-thrust-coil', headPose: { view: 'north', scaleX: 1, dx: 0, dy: 2, cloakPiece: 10 }, insertMode: 'back' },
  { sourcePoseId: 'pose-4063-north-ticks-0', sourceFrame: 1, piece: 8, x: 12, y: -7, armsPreset: 'north-thrust-coil', headPose: { view: 'north', scaleX: 1, dx: 1, dy: 2, cloakPiece: 11 }, insertMode: 'back' },
  // 原地向北双手猛刺（枪尖正指北方特效中轴，枪把收于右肩肋，无头顶怪手、无人物位移）
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 4, piece: 8, x: 6, y: -22, armsPreset: 'north-thrust-extend', headPose: { dy: -2, cloakPiece: 11 }, insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 4, piece: 8, x: 6, y: -25, armsPreset: 'north-thrust-extend', headPose: { dy: -3, cloakPiece: 10 }, insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 4, piece: 8, x: 6, y: -24, armsPreset: 'north-thrust-extend', headPose: { dx: -1, dy: -3, cloakPiece: 11 }, insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 4, piece: 8, x: 8, y: -18, armsPreset: 'north-thrust-extend', headPose: { dy: -1, cloakPiece: 10 }, insertMode: 'back' },
  { sourcePoseId: 'pose-4063-north-ticks-0', sourceFrame: 0, piece: 8, x: 11, y: -12, armsPreset: 'north-thrust-coil', headPose: { dx: 1, dy: -1, cloakPiece: 9 }, insertMode: 'back' },
  { sourcePoseId: 'pose-4063-north-ticks-0', sourceFrame: 0, piece: 8, x: 11, y: -10, armsPreset: 'north-thrust-coil', headPose: { dx: 0, dy: 0, cloakPiece: 9 }, insertMode: 'back' },
  { sourcePoseId: 'pose-3988-north-ticks-0', sourceFrame: 0, piece: 22, x: 8, y: -10, armsPreset: 'north-ready', headPose: { dy: -1, cloakPiece: 8 }, insertMode: 'back' },
  { sourcePoseId: 'pose-3988-north-ticks-0', sourceFrame: 0, piece: 23, x: 8, y: -9, armsPreset: 'north-ready', insertMode: 'back' },
];

// 4. 伏龙震 · 力劈华山（11 帧，基于地面过顶纵劈 pose-4076..4078，F4 起纵劈弧光、F5 砸地顿帧震屏+眩晕）
const DRAGON_SLAM_WEST_FRAMES: readonly SpearKeyframeSpec[] = [
  // F0..F2：双手高举长枪过顶蓄势（保留原版挺拔高举，自带 cb[18] 沉马）
  { sourcePoseId: 'pose-4077-west-ticks-0', sourceFrame: 0, piece: 12, x: 1, y: -26, insertMode: 'back' },
  { sourcePoseId: 'pose-4077-west-ticks-0', sourceFrame: 1, piece: 12, x: 2, y: -29, insertMode: 'back' },
  { sourcePoseId: 'pose-4077-west-ticks-0', sourceFrame: 2, piece: 12, x: 3, y: -30, insertMode: 'back' },
  // F3：沉马抡圆下压加速（延续同源 cb[18] 沉马下盘，F3 触发纵劈弧光）
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 11, x: -6, y: -15, armsPreset: 'sweep-raise', legsPreset: 'planted', headPose: { view: 'west-action', dx: -3, dy: 0, torsoDx: -1, cloakPiece: 5 }, insertMode: 'between-west-arms' },
  // F4..F6：沉马压眉当头重砸落地 + 顿帧停枪（F4 命中+震屏+地面震波+眩晕）
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 13, x: -7, y: -4, armsPreset: 'slam-low', legsPreset: 'planted', headPose: { view: 'west-action', dx: -4, dy: 3, torsoDx: -2, torsoDy: 1, cloakPiece: 7 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 13, x: -7, y: -3, armsPreset: 'slam-low', legsPreset: 'planted', headPose: { view: 'west-action', dx: -4, dy: 4, torsoDx: -2, torsoDy: 2, cloakPiece: 6 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 13, x: -6, y: -4, armsPreset: 'slam-low', legsPreset: 'planted', headPose: { view: 'west-action', dx: -3, dy: 3, torsoDx: -2, torsoDy: 1, cloakPiece: 5 }, insertMode: 'between-west-arms' },
  // F7..F10：挺胸提枪起身回防
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 9, x: -6, y: -7, armsPreset: 'sweep-low', legsPreset: 'planted', headPose: { view: 'west-action', dx: -2, dy: 2, torsoDx: -1, torsoDy: 1, cloakPiece: 5 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 2, x: -5, y: -9, armsPreset: 'thrust-coil', headPose: { dx: -1, dy: 1, torsoDx: -1, cloakPiece: 4 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 2, x: -3, y: -10, headPose: { dx: 0, dy: 1 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 1, piece: 3, x: -3, y: -10, insertMode: 'between-west-arms' },
];

const DRAGON_SLAM_SOUTH_FRAMES: readonly SpearKeyframeSpec[] = [
  // F0..F2：双手对称直举长枪过顶蓄力（对齐原版 pose-4076 躯干横坐标 x=3..4）
  { sourcePoseId: 'pose-4076-south-ticks-0', sourceFrame: 0, piece: 12, x: 3, y: -26, armsPreset: 'south-slam-overhead', insertMode: 'back' },
  { sourcePoseId: 'pose-4076-south-ticks-0', sourceFrame: 1, piece: 12, x: 3, y: -28, armsPreset: 'south-slam-overhead', insertMode: 'back' },
  { sourcePoseId: 'pose-4076-south-ticks-0', sourceFrame: 2, piece: 12, x: 4, y: -29, armsPreset: 'south-slam-overhead', insertMode: 'back' },
  // F3：双手竖直劈落切下
  { sourcePoseId: 'pose-4076-south-ticks-0', sourceFrame: 3, piece: 7, x: -1, y: -14, armsPreset: 'south-slam-down', headPose: { view: 'south-action', scaleX: 1, cloakPiece: 2 }, insertMode: 'between-south-arms' },
  // F4..F6：双手重砸前方地面深蹲顿枪（枪尖拍砸南向落点！）
  { sourcePoseId: 'pose-4076-south-ticks-0', sourceFrame: 4, piece: 7, x: -1, y: 5, armsPreset: 'south-slam-down', headPose: { view: 'south-action', dy: 1, cloakPiece: 3 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4076-south-ticks-0', sourceFrame: 5, piece: 7, x: -1, y: 6, armsPreset: 'south-slam-down', headPose: { view: 'south-action', dy: 2, cloakPiece: 3 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4076-south-ticks-0', sourceFrame: 6, piece: 7, x: -1, y: 4, armsPreset: 'south-slam-down', headPose: { view: 'south-action', dy: 1, cloakPiece: 2 }, insertMode: 'between-south-arms' },
  // F7..F10：双手拉枪起身归位
  { sourcePoseId: 'pose-4076-south-ticks-0', sourceFrame: 7, piece: 9, x: -3, y: -5, armsPreset: 'south-sweep-left', insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4076-south-ticks-0', sourceFrame: 8, piece: 0, x: -1, y: -7, armsPreset: 'south-ready', insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 0, piece: 0, x: 0, y: -8, armsPreset: 'south-ready', insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 1, piece: 1, x: 0, y: -8, armsPreset: 'south-ready', insertMode: 'between-south-arms' },
];

const DRAGON_SLAM_NORTH_FRAMES: readonly SpearKeyframeSpec[] = [
  // F0..F2：背身正北对称直举过顶蓄力（采用标准正北躯干 pose-4069，避免 pose-4078 侧转躯干错肩）
  { sourcePoseId: 'pose-4069-north-ticks-0', sourceFrame: 0, piece: 12, x: 0, y: -27, scaleX: -1, armsPreset: 'north-slam-overhead', headPose: { view: 'north', scaleX: 1, dy: 0, cloakPiece: 8 }, insertMode: 'back' },
  { sourcePoseId: 'pose-4069-north-ticks-0', sourceFrame: 0, piece: 12, x: 0, y: -29, scaleX: -1, armsPreset: 'north-slam-overhead', headPose: { view: 'north', scaleX: 1, dy: -1, cloakPiece: 9 }, insertMode: 'back' },
  { sourcePoseId: 'pose-4069-north-ticks-0', sourceFrame: 0, piece: 12, x: 0, y: -30, scaleX: -1, armsPreset: 'north-slam-overhead', headPose: { view: 'north', scaleX: 1, dy: -2, cloakPiece: 10 }, insertMode: 'back' },
  // F3：双手下压纵劈向北
  { sourcePoseId: 'pose-4078-north-ticks-0', sourceFrame: 3, piece: 8, x: 6, y: -24, armsPreset: 'north-slam-down', headPose: { dy: -1, cloakPiece: 10 }, insertMode: 'back' },
  // F4..F6：双手重砸北向地面深蹲顿枪（枪尖拍落北向落点，枪把握于前胸右肋，绝不漏入双腿间）
  { sourcePoseId: 'pose-4078-north-ticks-0', sourceFrame: 4, piece: 8, x: 6, y: -21, armsPreset: 'north-slam-down', headPose: { dy: -2, cloakPiece: 11 }, insertMode: 'back' },
  { sourcePoseId: 'pose-4078-north-ticks-0', sourceFrame: 5, piece: 8, x: 6, y: -20, armsPreset: 'north-slam-down', headPose: { dy: -1, cloakPiece: 10 }, insertMode: 'back' },
  { sourcePoseId: 'pose-4078-north-ticks-0', sourceFrame: 6, piece: 8, x: 6, y: -20, armsPreset: 'north-slam-down', headPose: { dy: 0, cloakPiece: 9 }, insertMode: 'back' },
  // F7..F10：沿右侧双手提枪起身回防
  { sourcePoseId: 'pose-4078-north-ticks-0', sourceFrame: 7, piece: 11, x: 4, y: -18, scaleX: -1, armsPreset: 'north-sweep-right', insertMode: 'back' },
  { sourcePoseId: 'pose-4063-north-ticks-0', sourceFrame: 0, piece: 8, x: 11, y: -11, armsPreset: 'north-thrust-coil', insertMode: 'back' },
  { sourcePoseId: 'pose-3988-north-ticks-0', sourceFrame: 0, piece: 22, x: 8, y: -10, armsPreset: 'north-ready', insertMode: 'back' },
  { sourcePoseId: 'pose-3988-north-ticks-0', sourceFrame: 0, piece: 23, x: 8, y: -9, armsPreset: 'north-ready', insertMode: 'back' },
];

// ---------------------------------------------------------------------------
// 第二批新增技能与完整补齐：
// 5. 虬龙扫暴阵（skill-whirl-sweep，16 帧：4 帧舞枪花前奏 + 12 帧大横扫 + 180° 狂风枪芒）
// 6. 连环点枪（skill-flurry-thrust，17 帧：前 8 帧半伸微颤暴雨梨花针芒 + 2 帧缩枪蓄劲 + 7 帧微踏定音主刺）
// 7. 万圣龙王破（skill-sovereign-pierce，19 帧：6 帧旋枪引气 + 3 帧沉腰凝势 + 10 帧 1.6 倍螺旋龙枪芒，无黑屏）
// 8. 3 个自身增益共用立枪聚气动作（skill-focus-edge / skill-dragon-step / skill-gale-stance，12 帧）
// 9. 长枪战斗阵亡动作（spear-die，23 帧：枪脱手翻转落地 + 角色倒地）
// ---------------------------------------------------------------------------

// 5. 虬龙扫暴阵 · 真 3D 透视双侧枪花（100% 实色自然长度长枪）+ 朝向 180° 大横扫（16 帧）
// 前 6 帧全实色长枪（~62px，不虚化）在手中随左右两枚 3D 透视侧轮（/ 🧍 \）自然摆动：
// F0..F2 枪尖在左/枪尾在右，F3..F5 翻腕互换（枪尖在右/枪尾在左），随后 F6..F15 无缝接当前朝向 180° 狂风大横扫。
const WHIRL_SWEEP_SOUTH_FRAMES: readonly SpearKeyframeSpec[] = [
  // F0..F5：双侧枪花蓄势（对齐狂龙头部质感：全程保持抬头正视 head-front[0] 不低头，head.x 恒定 0 不左右晃）
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 0, piece: 15, x: 0, y: -11, scaleX: 1, scaleY: 1, armsPreset: 'south-whirl-center', headPose: { view: 'south', scaleX: 1, dx: 0, dy: 0, cloakPiece: 1 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 0, piece: 15, x: 0, y: -11, scaleX: 1, scaleY: -1, armsPreset: 'south-whirl-center', headPose: { view: 'south', scaleX: 1, dx: 0, dy: -1, cloakPiece: 2 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 0, piece: 14, x: 0, y: -11, scaleX: 1, scaleY: 1, armsPreset: 'south-whirl-center', headPose: { view: 'south', scaleX: 1, dx: 0, dy: -1, cloakPiece: 3 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 0, piece: 15, x: 0, y: -11, scaleX: -1, scaleY: 1, armsPreset: 'south-whirl-center', headPose: { view: 'south', scaleX: 1, dx: 0, dy: 0, cloakPiece: 1 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 0, piece: 14, x: 0, y: -11, scaleX: -1, scaleY: 1, armsPreset: 'south-whirl-center', headPose: { view: 'south', scaleX: 1, dx: 0, dy: -1, cloakPiece: 2 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 0, piece: 15, x: 0, y: -11, scaleX: -1, scaleY: -1, armsPreset: 'south-whirl-center', headPose: { view: 'south', scaleX: 1, dx: 0, dy: -1, cloakPiece: 3 }, insertMode: 'between-south-arms' },
  // F6..F15：正南对称 180° 双手狂风大横扫（统一稳立骨架 pose-4067，抬头正视不埋胸、head.x=0 零横晃，仅做蓄力微抬与挥扫前顶）
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 0, piece: 11, x: -7, y: -11, armsPreset: 'south-sweep-left', headPose: { view: 'south', scaleX: 1, dx: 0, dy: -2, torsoDy: -1, cloakPiece: 1 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 0, piece: 9, x: -7, y: -5, armsPreset: 'south-sweep-left', headPose: { view: 'south', scaleX: 1, dx: 0, dy: 0, cloakPiece: 2 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 0, piece: 7, x: -1, y: -2, armsPreset: 'south-sweep-center', headPose: { view: 'south', scaleX: 1, dx: 0, dy: 1, torsoDy: 1, cloakPiece: 3 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 0, piece: 9, x: 5, y: -5, scaleX: -1, armsPreset: 'south-sweep-right', headPose: { view: 'south', scaleX: 1, dx: 0, dy: 1, torsoDy: 1, cloakPiece: 3 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 0, piece: 10, x: 6, y: -7, scaleX: -1, armsPreset: 'south-sweep-right', headPose: { view: 'south', scaleX: 1, dx: 0, dy: 0, cloakPiece: 2 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 0, piece: 2, x: 4, y: -8, scaleX: -1, armsPreset: 'south-sweep-right', headPose: { view: 'south', scaleX: 1, dx: 0, dy: 0, cloakPiece: 1 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 0, piece: 0, x: 2, y: -8, scaleX: -1, armsPreset: 'south-sweep-right', headPose: { view: 'south', scaleX: 1, dx: 0, dy: -1, cloakPiece: 0 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 0, piece: 11, x: 2, y: -10, scaleX: -1, armsPreset: 'south-sweep-right', headPose: { view: 'south', scaleX: 1, dx: 0, dy: -1, cloakPiece: 0 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 0, piece: 0, x: 0, y: -8, armsPreset: 'south-ready', headPose: { view: 'south', scaleX: 1, dx: 0, dy: 0, cloakPiece: 0 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 0, piece: 1, x: 0, y: -8, armsPreset: 'south-ready', insertMode: 'between-south-arms' },
];

const WHIRL_SWEEP_WEST_FRAMES: readonly SpearKeyframeSpec[] = [
  // F0..F5：全程沉马扎稳（planted cb[18]），双脚纹丝不动舞动左右双侧 3D 枪花（头锁正西只动不转向）
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 15, x: 0, y: -11, scaleX: 1, scaleY: 1, armsPreset: 'whirl-center', legsPreset: 'planted', headPose: { view: 'west-action', dx: -1, dy: 1, torsoDx: -1, cloakPiece: 5 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 15, x: 0, y: -11, scaleX: 1, scaleY: -1, armsPreset: 'whirl-center', legsPreset: 'planted', headPose: { view: 'west-action', dx: -2, dy: 2, torsoDx: -1, torsoDy: 1, cloakPiece: 7 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 14, x: 0, y: -11, scaleX: 1, scaleY: 1, armsPreset: 'whirl-center', legsPreset: 'planted', headPose: { view: 'west', dx: 0, dy: 1, cloakPiece: 6 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 15, x: 0, y: -11, scaleX: -1, scaleY: 1, armsPreset: 'whirl-center', legsPreset: 'planted', headPose: { view: 'west', dx: 1, dy: 0, torsoDx: 1, cloakPiece: 6 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 14, x: 0, y: -11, scaleX: -1, scaleY: 1, armsPreset: 'whirl-center', legsPreset: 'planted', headPose: { view: 'west', dx: -1, dy: 1, torsoDy: 1, cloakPiece: 5 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 15, x: 0, y: -11, scaleX: -1, scaleY: -1, armsPreset: 'whirl-center', legsPreset: 'planted', headPose: { view: 'west-action', dx: -2, dy: 2, torsoDx: -1, torsoDy: 1, cloakPiece: 7 }, insertMode: 'between-west-arms' },
  // F6..F15：正西对称 180° 水平狂风大横扫（水平腰高扫过正西，绝不下插斜砍、绝不转头朝南）
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 2, x: 2, y: -13, armsPreset: 'sweep-raise', headPose: { view: 'west', dx: 2, dy: -1, torsoDx: 1, cloakPiece: 6 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 2, x: -7, y: -12, armsPreset: 'sweep-cut', legsPreset: 'bow', headPose: { view: 'west-action', dx: -2, dy: 0, torsoDx: -1, cloakPiece: 5 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 10, x: -13, y: -10, armsPreset: 'sweep-cut', legsPreset: 'bow', headPose: { view: 'west-action', dx: -4, dy: 2, torsoDx: -2, torsoDy: 1, cloakPiece: 7 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 10, x: -11, y: -9, armsPreset: 'sweep-cut', legsPreset: 'planted', headPose: { view: 'west-action', dx: -3, dy: 2, torsoDx: -2, torsoDy: 1, cloakPiece: 7 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 2, x: -8, y: -8, armsPreset: 'sweep-low', legsPreset: 'planted', headPose: { view: 'west-action', dx: -2, dy: 1, torsoDx: -1, torsoDy: 1, cloakPiece: 5 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 2, x: -6, y: -9, armsPreset: 'flurry-mid', legsPreset: 'planted', headPose: { view: 'west', dx: -1, dy: 1, cloakPiece: 4 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 2, x: -4, y: -9, armsPreset: 'thrust-coil', headPose: { view: 'west', dx: 0, dy: 0, cloakPiece: 4 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 3, x: -3, y: -10, headPose: { view: 'west', dx: 0, dy: 1 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 2, x: -3, y: -10, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 1, piece: 3, x: -3, y: -10, insertMode: 'between-west-arms' },
];

const WHIRL_SWEEP_NORTH_FRAMES: readonly SpearKeyframeSpec[] = [
  // F0..F5：双侧枪花凝气（消除左右乱晃，全 16 帧精确锁定 head.x=0，仅做南北纵向呼吸蓄发）
  { sourcePoseId: 'pose-4069-north-ticks-0', sourceFrame: 0, piece: 15, x: 0, y: -12, scaleX: 1, scaleY: 1, armsPreset: 'north-whirl-center', headPose: { view: 'north', scaleX: 1, dx: -1, dy: -1, cloakPiece: 9 }, insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 4, piece: 15, x: 0, y: -12, scaleX: 1, scaleY: -1, armsPreset: 'north-whirl-center', headPose: { view: 'north', scaleX: 1, dx: 0, dy: -2, cloakPiece: 10 }, insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 4, piece: 14, x: 0, y: -12, scaleX: 1, scaleY: 1, armsPreset: 'north-whirl-center', headPose: { view: 'north', scaleX: 1, dx: 0, dy: -1, cloakPiece: 11 }, insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 4, piece: 15, x: 0, y: -12, scaleX: -1, scaleY: 1, armsPreset: 'north-whirl-center', headPose: { view: 'north', scaleX: 1, dx: 0, dy: -2, cloakPiece: 10 }, insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 4, piece: 14, x: 0, y: -12, scaleX: -1, scaleY: 1, armsPreset: 'north-whirl-center', headPose: { view: 'north', scaleX: 1, dx: 0, dy: -1, cloakPiece: 9 }, insertMode: 'back' },
  { sourcePoseId: 'pose-4069-north-ticks-0', sourceFrame: 0, piece: 15, x: 0, y: -12, scaleX: -1, scaleY: -1, armsPreset: 'north-whirl-center', headPose: { view: 'north', scaleX: 1, dx: -1, dy: 0, cloakPiece: 11 }, insertMode: 'back' },
  // F6..F15：正北对称 180° 双手胸肩高位狂风大横扫（head.x 恒为 0 零横晃，仅做 F6 微收蓄力 → F7..F10 向北发力前送 → 平稳归位）
  { sourcePoseId: 'pose-4069-north-ticks-0', sourceFrame: 0, piece: 11, x: 6, y: -19, scaleX: -1, armsPreset: 'north-sweep-right', headPose: { view: 'north', scaleX: 1, dx: -1, dy: 2, cloakPiece: 9 }, insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 4, piece: 10, x: 9, y: -21, scaleX: -1, armsPreset: 'north-sweep-right', headPose: { view: 'north', scaleX: 1, dx: 0, dy: -3, cloakPiece: 10 }, insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 4, piece: 8, x: 6, y: -21, armsPreset: 'north-thrust-extend', headPose: { view: 'north', scaleX: 1, dx: 0, dy: -5, cloakPiece: 11 }, insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 4, piece: 10, x: -9, y: -21, armsPreset: 'north-sweep-left', headPose: { view: 'north', scaleX: 1, dx: 0, dy: -4, cloakPiece: 11 }, insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 4, piece: 10, x: -10, y: -21, armsPreset: 'north-sweep-left', headPose: { view: 'north', scaleX: 1, dx: 0, dy: -3, cloakPiece: 10 }, insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 4, piece: 0, x: -8, y: -18, armsPreset: 'north-sweep-left', headPose: { view: 'north', scaleX: 1, dx: 0, dy: -2, cloakPiece: 9 }, insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 4, piece: 11, x: -5, y: -18, armsPreset: 'north-sweep-left', headPose: { view: 'north', scaleX: 1, dx: 0, dy: -2, cloakPiece: 9 }, insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 4, piece: 11, x: 6, y: -19, scaleX: -1, armsPreset: 'north-sweep-right', headPose: { view: 'north', scaleX: 1, dx: 0, dy: -3, cloakPiece: 8 }, insertMode: 'back' },
  { sourcePoseId: 'pose-3988-north-ticks-0', sourceFrame: 0, piece: 22, x: 8, y: -10, armsPreset: 'north-ready', headPose: { view: 'north', scaleX: 1, dx: 0, dy: -1, cloakPiece: 8 }, insertMode: 'back' },
  { sourcePoseId: 'pose-3988-north-ticks-0', sourceFrame: 0, piece: 23, x: 8, y: -9, armsPreset: 'north-ready', insertMode: 'back' },
];

// 6. 连环点枪 · 暴雨梨花枪（17 帧 ≈ 1.02s，纯原地定脚：前 8 帧半伸微颤暴雨梨花针芒 + 2 帧原地缩枪蓄劲 + 7 帧原地定音主刺）
const FLURRY_WEST_FRAMES: readonly SpearKeyframeSpec[] = [
  // F0：起手微沉
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 2, x: -3, y: -10, insertMode: 'between-west-arms' },
  // F1..F8：前 0.5s 全程定格实踩宽弓步（bow cb[11]），双脚纹丝不动、枪身手臂与头胸随连刺节奏高频微颤
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 6, x: -8, y: -11, armsPreset: 'flurry-mid', legsPreset: 'bow', headPose: { dx: -1, dy: 1, torsoDx: -1, cloakPiece: 5 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 6, x: -11, y: -12, armsPreset: 'flurry-mid', legsPreset: 'bow', headPose: { view: 'west-action', dx: -3, dy: 2, torsoDx: -2, torsoDy: 1, cloakPiece: 7 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 6, x: -7, y: -10, armsPreset: 'flurry-mid', legsPreset: 'bow', headPose: { dx: -1, dy: 0, torsoDx: -1, cloakPiece: 5 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 6, x: -11, y: -11, armsPreset: 'flurry-mid', legsPreset: 'bow', headPose: { view: 'west-action', dx: -3, dy: 1, torsoDx: -2, torsoDy: 1, cloakPiece: 6 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 6, x: -8, y: -12, armsPreset: 'flurry-mid', legsPreset: 'bow', headPose: { dx: -2, dy: 2, torsoDx: -1, cloakPiece: 5 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 6, x: -12, y: -10, armsPreset: 'flurry-mid', legsPreset: 'bow', headPose: { view: 'west-action', dx: -4, dy: 1, torsoDx: -2, torsoDy: 1, cloakPiece: 7 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 6, x: -7, y: -11, armsPreset: 'flurry-mid', legsPreset: 'bow', headPose: { dx: -1, dy: 1, torsoDx: -1, cloakPiece: 5 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 6, x: -9, y: -11, armsPreset: 'flurry-mid', legsPreset: 'bow', headPose: { view: 'west-action', dx: -2, dy: 1, torsoDx: -1, cloakPiece: 6 }, insertMode: 'between-west-arms' },
  // F9..F10：原地短促缩枪蓄劲 2 帧（疾 → 顿，头锁正西抬首蓄劲不转向）
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 6, x: 5, y: -11, armsPreset: 'thrust-coil', headPose: { view: 'west', dx: 1, dy: -1, torsoDx: 1, cloakPiece: 6 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 6, x: 10, y: -11, armsPreset: 'thrust-coil', headPose: { view: 'west', dx: 2, dy: -2, torsoDx: 1, torsoDy: -1, cloakPiece: 6 }, insertMode: 'between-west-arms' },
  // F11..F13：原地实踩宽弓步全臂伸展刺出第 3 段（破！40%，F11 出定音主刺芒、F12 命中+震屏，人物不位移不踏步）
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 6, x: -14, y: -11, armsPreset: 'thrust-extend', legsPreset: 'bow', headPose: { view: 'west-action', dx: -3, dy: 1, torsoDx: -2, torsoDy: 1, cloakPiece: 5 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 6, x: -16, y: -11, armsPreset: 'thrust-extend', legsPreset: 'bow', headPose: { view: 'west-action', dx: -4, dy: 2, torsoDx: -2, torsoDy: 1, cloakPiece: 7 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 6, x: -15, y: -11, armsPreset: 'thrust-extend', legsPreset: 'bow', headPose: { view: 'west-action', dx: -4, dy: 3, torsoDx: -2, torsoDy: 1, cloakPiece: 7 }, insertMode: 'between-west-arms' },
  // F14..F16：原地利落收势回防
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 6, x: -7, y: -11, armsPreset: 'flurry-mid', legsPreset: 'bow', headPose: { view: 'west-action', dx: -2, dy: 1, torsoDx: -1, cloakPiece: 5 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 2, x: -2, y: -10, armsPreset: 'thrust-coil', headPose: { dx: 0, dy: 0, cloakPiece: 4 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 3, x: -3, y: -10, insertMode: 'between-west-arms' },
];

const FLURRY_SOUTH_FRAMES: readonly SpearKeyframeSpec[] = [
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 0, piece: 0, x: 0, y: -8, armsPreset: 'south-ready', insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 2, piece: 7, x: -4, y: 1, armsPreset: 'south-thrust-extend', headPose: { dx: -1, dy: -1, cloakPiece: 1 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 2, piece: 7, x: -2, y: 5, armsPreset: 'south-thrust-extend', headPose: { view: 'south-action', dx: 1, dy: 1, cloakPiece: 2 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 2, piece: 7, x: -4, y: 0, armsPreset: 'south-thrust-extend', headPose: { dx: -1, dy: -1, cloakPiece: 3 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 2, piece: 7, x: -3, y: 5, armsPreset: 'south-thrust-extend', headPose: { view: 'south-action', dx: 0, dy: 1, cloakPiece: 2 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 2, piece: 7, x: -2, y: 1, armsPreset: 'south-thrust-extend', headPose: { dx: 1, dy: -1, cloakPiece: 1 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 2, piece: 7, x: -4, y: 6, armsPreset: 'south-thrust-extend', headPose: { view: 'south-action', dx: -1, dy: 2, cloakPiece: 3 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 2, piece: 7, x: -3, y: 1, armsPreset: 'south-thrust-extend', headPose: { dx: 0, dy: -1, cloakPiece: 2 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 3, piece: 7, x: -3, y: 2, armsPreset: 'south-thrust-extend', headPose: { view: 'south-action', dy: 0, cloakPiece: 1 }, insertMode: 'between-south-arms' },
  // 原地双手缩枪蓄劲
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 0, piece: 7, x: -5, y: -12, armsPreset: 'south-thrust-coil', headPose: { dy: -1, cloakPiece: 1 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 1, piece: 7, x: -5, y: -15, armsPreset: 'south-thrust-coil', headPose: { dx: 1, dy: -2, cloakPiece: 3 }, insertMode: 'between-south-arms' },
  // 原地双手定音第 3 刺（无人物位移）
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 2, piece: 7, x: -3, y: 5, armsPreset: 'south-thrust-extend', headPose: { view: 'south-action', dy: 1, cloakPiece: 2 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 2, piece: 7, x: -3, y: 9, armsPreset: 'south-thrust-extend', headPose: { view: 'south-action', dy: 2, cloakPiece: 3 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 2, piece: 7, x: -3, y: 8, armsPreset: 'south-thrust-extend', headPose: { view: 'south-action', dy: 1, cloakPiece: 2 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 3, piece: 7, x: -3, y: 1, armsPreset: 'south-thrust-extend', headPose: { dy: 0, cloakPiece: 1 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 4, piece: 0, x: -1, y: -7, armsPreset: 'south-ready', headPose: { dy: 0, cloakPiece: 0 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 0, piece: 1, x: 0, y: -8, armsPreset: 'south-ready', insertMode: 'between-south-arms' },
];

const FLURRY_NORTH_FRAMES: readonly SpearKeyframeSpec[] = [
  { sourcePoseId: 'pose-3988-north-ticks-0', sourceFrame: 0, piece: 22, x: 8, y: -9, armsPreset: 'north-ready', insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 4, piece: 8, x: 5, y: -19, armsPreset: 'north-thrust-extend', headPose: { dx: -1, dy: -1, cloakPiece: 9 }, insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 4, piece: 8, x: 7, y: -23, armsPreset: 'north-thrust-extend', headPose: { dx: 1, dy: -3, cloakPiece: 11 }, insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 4, piece: 8, x: 5, y: -18, armsPreset: 'north-thrust-extend', headPose: { dx: -1, dy: -1, cloakPiece: 10 }, insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 4, piece: 8, x: 6, y: -23, armsPreset: 'north-thrust-extend', headPose: { dx: 0, dy: -3, cloakPiece: 11 }, insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 4, piece: 8, x: 7, y: -19, armsPreset: 'north-thrust-extend', headPose: { dx: 1, dy: -1, cloakPiece: 9 }, insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 4, piece: 8, x: 5, y: -24, armsPreset: 'north-thrust-extend', headPose: { dx: -1, dy: -3, cloakPiece: 11 }, insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 4, piece: 8, x: 6, y: -19, armsPreset: 'north-thrust-extend', headPose: { dx: 0, dy: -1, cloakPiece: 10 }, insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 4, piece: 8, x: 6, y: -20, armsPreset: 'north-thrust-extend', headPose: { dx: 0, dy: -2, cloakPiece: 9 }, insertMode: 'back' },
  // 原地右侧双手缩枪蓄劲（枪头露于右肩外、枪把位于右胯外侧，头锁正北后收不转向）
  { sourcePoseId: 'pose-4063-north-ticks-0', sourceFrame: 0, piece: 8, x: 11, y: -10, armsPreset: 'north-thrust-coil', headPose: { view: 'north', scaleX: 1, dx: 1, dy: 1, cloakPiece: 9 }, insertMode: 'back' },
  { sourcePoseId: 'pose-4063-north-ticks-0', sourceFrame: 1, piece: 8, x: 12, y: -8, armsPreset: 'north-thrust-coil', headPose: { view: 'north', scaleX: 1, dx: 0, dy: 2, cloakPiece: 10 }, insertMode: 'back' },
  // 原地双手定音第 3 刺（无人物位移、无双腿漏枪把）
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 4, piece: 8, x: 6, y: -22, armsPreset: 'north-thrust-extend', headPose: { dy: -2, cloakPiece: 11 }, insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 4, piece: 8, x: 6, y: -25, armsPreset: 'north-thrust-extend', headPose: { dy: -3, cloakPiece: 10 }, insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 4, piece: 8, x: 6, y: -24, armsPreset: 'north-thrust-extend', headPose: { dx: -1, dy: -3, cloakPiece: 11 }, insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 4, piece: 8, x: 8, y: -17, armsPreset: 'north-thrust-extend', headPose: { dy: -1, cloakPiece: 9 }, insertMode: 'back' },
  { sourcePoseId: 'pose-4063-north-ticks-0', sourceFrame: 0, piece: 8, x: 11, y: -11, armsPreset: 'north-thrust-coil', headPose: { dx: 1, dy: 0, cloakPiece: 9 }, insertMode: 'back' },
  { sourcePoseId: 'pose-3988-north-ticks-0', sourceFrame: 0, piece: 23, x: 8, y: -9, armsPreset: 'north-ready', insertMode: 'back' },
];

// 7. 万圣龙王破 · 怒龙穿心（19 帧，纯原地定脚无黑屏：6 帧盘枪引气 → 3 帧原地凝势 → 10 帧原地贯出 1.6 倍螺旋龙枪芒，全程头锁当前朝向不转向）
const SOVEREIGN_WEST_FRAMES: readonly SpearKeyframeSpec[] = [
  // F0..F5：原地盘枪引气（头锁正西只做前后起伏与压眉，绝不转背或转南）
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 11, x: 3, y: -14, scaleX: -1, armsPreset: 'sweep-windup', headPose: { view: 'west', dx: 1, dy: -1, torsoDx: 1, cloakPiece: 6 }, insertMode: 'back' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 4, x: 4, y: -15, armsPreset: 'sweep-windup', headPose: { view: 'west', dx: 2, dy: -2, torsoDx: 1, torsoDy: -1, cloakPiece: 6 }, insertMode: 'back' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 11, x: -6, y: -13, armsPreset: 'sweep-raise', legsPreset: 'bow', headPose: { view: 'west-action', dx: -2, dy: 0, torsoDx: -1, cloakPiece: 5 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 10, x: -12, y: -10, armsPreset: 'sweep-cut', legsPreset: 'bow', headPose: { view: 'west-action', dx: -4, dy: 2, torsoDx: -2, torsoDy: 1, cloakPiece: 7 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 9, x: -9, y: -6, armsPreset: 'sweep-low', legsPreset: 'planted', headPose: { view: 'west-action', dx: -2, dy: 2, torsoDx: -1, torsoDy: 1, cloakPiece: 5 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 2, x: -6, y: -8, armsPreset: 'flurry-mid', legsPreset: 'planted', headPose: { view: 'west', dx: -1, dy: 1, cloakPiece: 4 }, insertMode: 'between-west-arms' },
  // F6..F8：原地挺胸收枪凝势（3 帧蓄力紧绷，目光锁正西不转向）
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 6, x: 7, y: -11, armsPreset: 'thrust-coil', headPose: { view: 'west', dx: 1, dy: -1, torsoDx: 1, cloakPiece: 6 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 6, x: 12, y: -11, armsPreset: 'thrust-coil', headPose: { view: 'west', dx: 2, dy: -2, torsoDx: 1, torsoDy: -1, cloakPiece: 6 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 6, x: 11, y: -11, armsPreset: 'thrust-coil', headPose: { view: 'west-action', dx: 2, dy: 0, torsoDx: 1, cloakPiece: 7 }, insertMode: 'between-west-arms' },
  // F9..F15：原地实踩宽弓步化龙贯出！（全程定格 bow 下盘、零位移不踏步 + 1.6 倍蓝青螺旋龙枪芒 + 强震屏）
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 6, x: -13, y: -11, armsPreset: 'thrust-extend', legsPreset: 'bow', headPose: { view: 'west-action', dx: -3, dy: 1, torsoDx: -2, torsoDy: 1, cloakPiece: 5 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 6, x: -16, y: -11, armsPreset: 'thrust-extend', legsPreset: 'bow', headPose: { view: 'west-action', dx: -4, dy: 2, torsoDx: -2, torsoDy: 1, cloakPiece: 7 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 6, x: -16, y: -11, armsPreset: 'thrust-extend', legsPreset: 'bow', headPose: { view: 'west-action', dx: -4, dy: 3, torsoDx: -2, torsoDy: 1, cloakPiece: 6 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 6, x: -15, y: -11, armsPreset: 'thrust-extend', legsPreset: 'bow', headPose: { view: 'west-action', dx: -4, dy: 2, torsoDx: -2, torsoDy: 1, cloakPiece: 7 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 6, x: -12, y: -11, armsPreset: 'thrust-extend', legsPreset: 'bow', headPose: { view: 'west-action', dx: -3, dy: 2, torsoDx: -1, torsoDy: 1, cloakPiece: 5 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 6, x: -9, y: -11, armsPreset: 'flurry-mid', legsPreset: 'bow', headPose: { view: 'west-action', dx: -2, dy: 1, torsoDx: -1, cloakPiece: 5 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 6, x: -5, y: -11, armsPreset: 'flurry-mid', legsPreset: 'bow', headPose: { dx: -1, dy: 1, torsoDx: -1, cloakPiece: 4 }, insertMode: 'between-west-arms' },
  // F16..F18：原地沉稳收枪回防
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 2, x: -2, y: -10, armsPreset: 'thrust-coil', headPose: { dx: 0, dy: 0, cloakPiece: 4 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 2, x: -3, y: -10, headPose: { dx: 0, dy: 1 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 3, x: -3, y: -10, insertMode: 'between-west-arms' },
];

const SOVEREIGN_SOUTH_FRAMES: readonly SpearKeyframeSpec[] = [
  // F0..F5：原地双手盘枪引气（改用稳立骨架 pose-4067，全程正视抬头 head-front[0]、head.x=0 零横晃零二次点头）
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 0, piece: 0, x: -2, y: -9, armsPreset: 'south-sweep-left', headPose: { view: 'south', scaleX: 1, dx: 0, dy: 0, cloakPiece: 0 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 0, piece: 11, x: -5, y: -10, armsPreset: 'south-sweep-left', headPose: { view: 'south', scaleX: 1, dx: 0, dy: 0, cloakPiece: 1 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 0, piece: 9, x: -7, y: -5, armsPreset: 'south-sweep-left', headPose: { view: 'south', scaleX: 1, dx: 0, dy: -1, cloakPiece: 2 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 0, piece: 9, x: 5, y: -5, scaleX: -1, armsPreset: 'south-sweep-right', headPose: { view: 'south', scaleX: 1, dx: 0, dy: -1, cloakPiece: 3 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 0, piece: 10, x: 6, y: -7, scaleX: -1, armsPreset: 'south-sweep-right', headPose: { view: 'south', scaleX: 1, dx: 0, dy: -1, cloakPiece: 2 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 0, piece: 0, x: 2, y: -8, scaleX: -1, armsPreset: 'south-sweep-right', headPose: { view: 'south', scaleX: 1, dx: 0, dy: -1, cloakPiece: 1 }, insertMode: 'between-south-arms' },
  // F6..F8：原地双手沉腰凝势（对齐狂龙蓄势，head.x=0 稳健抬首聚力）
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 0, piece: 7, x: -5, y: -13, armsPreset: 'south-thrust-coil', headPose: { view: 'south', scaleX: 1, dx: 1, dy: -1, cloakPiece: 1 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 1, piece: 7, x: -5, y: -16, armsPreset: 'south-thrust-coil', headPose: { view: 'south', scaleX: 1, dx: 0, dy: -2, cloakPiece: 3 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 1, piece: 7, x: -5, y: -15, armsPreset: 'south-thrust-coil', headPose: { view: 'south', scaleX: 1, dx: 0, dy: -1, cloakPiece: 1 }, insertMode: 'between-south-arms' },
  // F9..F18：原地双手化龙贯出（与狂龙一致全身一气呵成前送，无左右晃动）
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 2, piece: 7, x: -3, y: 4, armsPreset: 'south-thrust-extend', headPose: { view: 'south-action', dy: 1, cloakPiece: 2 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 2, piece: 7, x: -3, y: 8, armsPreset: 'south-thrust-extend', headPose: { view: 'south-action', dy: 2, cloakPiece: 3 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 2, piece: 7, x: -3, y: 8, armsPreset: 'south-thrust-extend', headPose: { view: 'south-action', dy: 3, cloakPiece: 2 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 2, piece: 7, x: -3, y: 7, armsPreset: 'south-thrust-extend', headPose: { view: 'south-action', dy: 2, cloakPiece: 3 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 3, piece: 7, x: -3, y: 3, armsPreset: 'south-thrust-extend', headPose: { view: 'south-action', dy: 1, cloakPiece: 2 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 3, piece: 7, x: -3, y: 0, armsPreset: 'south-thrust-extend', headPose: { view: 'south-action', dy: 0, cloakPiece: 1 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 3, piece: 7, x: -4, y: -4, armsPreset: 'south-thrust-extend', headPose: { dy: -1, cloakPiece: 1 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 4, piece: 0, x: -1, y: -7, armsPreset: 'south-ready', headPose: { dy: 0, cloakPiece: 0 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 0, piece: 0, x: 0, y: -8, armsPreset: 'south-ready', headPose: { dy: 1 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 0, piece: 1, x: 0, y: -8, armsPreset: 'south-ready', insertMode: 'between-south-arms' },
];

const SOVEREIGN_NORTH_FRAMES: readonly SpearKeyframeSpec[] = [
  // F0..F5：原地双手胸肩高位盘枪引气（全 19 帧锁定 head.x=0 彻底消除左右往复乱晃，仅沿南北纵轴蓄力贯出）
  { sourcePoseId: 'pose-4069-north-ticks-0', sourceFrame: 0, piece: 0, x: 6, y: -18, scaleX: -1, armsPreset: 'north-sweep-right', headPose: { view: 'north', scaleX: 1, dx: -1, dy: -1, cloakPiece: 8 }, insertMode: 'back' },
  { sourcePoseId: 'pose-4069-north-ticks-0', sourceFrame: 0, piece: 11, x: 7, y: -19, scaleX: -1, armsPreset: 'north-sweep-right', headPose: { view: 'north', scaleX: 1, dx: -1, dy: 0, cloakPiece: 9 }, insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 4, piece: 8, x: 6, y: -21, armsPreset: 'north-thrust-extend', headPose: { view: 'north', scaleX: 1, dx: 0, dy: -2, cloakPiece: 10 }, insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 4, piece: 10, x: -8, y: -21, armsPreset: 'north-sweep-left', headPose: { view: 'north', scaleX: 1, dx: 0, dy: -1, cloakPiece: 11 }, insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 4, piece: 0, x: -9, y: -18, armsPreset: 'north-sweep-left', headPose: { view: 'north', scaleX: 1, dx: 0, dy: -1, cloakPiece: 10 }, insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 4, piece: 0, x: -6, y: -18, armsPreset: 'north-sweep-left', headPose: { view: 'north', scaleX: 1, dx: 0, dy: 0, cloakPiece: 9 }, insertMode: 'back' },
  // F6..F8：原地右侧双手沉腰凝势（head.x=0 稳步向后聚满劲力）
  { sourcePoseId: 'pose-4063-north-ticks-0', sourceFrame: 0, piece: 8, x: 11, y: -10, armsPreset: 'north-thrust-coil', headPose: { view: 'north', scaleX: 1, dx: 0, dy: 0, cloakPiece: 9 }, insertMode: 'back' },
  { sourcePoseId: 'pose-4063-north-ticks-0', sourceFrame: 1, piece: 8, x: 12, y: -7, armsPreset: 'north-thrust-coil', headPose: { view: 'north', scaleX: 1, dx: -2, dy: 2, cloakPiece: 10 }, insertMode: 'back' },
  { sourcePoseId: 'pose-4063-north-ticks-0', sourceFrame: 1, piece: 8, x: 12, y: -8, armsPreset: 'north-thrust-coil', headPose: { view: 'north', scaleX: 1, dx: -2, dy: 2, cloakPiece: 11 }, insertMode: 'back' },
  // F9..F18：原地双手化龙贯出（沿 head.x=0 向正北猛烈前顶并平稳归位）
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 4, piece: 8, x: 6, y: -22, armsPreset: 'north-thrust-extend', headPose: { dx: 0, dy: -3, cloakPiece: 11 }, insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 4, piece: 8, x: 6, y: -25, armsPreset: 'north-thrust-extend', headPose: { dx: 0, dy: -4, cloakPiece: 10 }, insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 4, piece: 8, x: 6, y: -25, armsPreset: 'north-thrust-extend', headPose: { dx: 0, dy: -5, cloakPiece: 11 }, insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 4, piece: 8, x: 6, y: -24, armsPreset: 'north-thrust-extend', headPose: { dx: 0, dy: -4, cloakPiece: 10 }, insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 4, piece: 8, x: 7, y: -20, armsPreset: 'north-thrust-extend', headPose: { dx: 0, dy: -3, cloakPiece: 11 }, insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 4, piece: 8, x: 9, y: -16, armsPreset: 'north-thrust-extend', headPose: { dx: 0, dy: -2, cloakPiece: 9 }, insertMode: 'back' },
  { sourcePoseId: 'pose-4063-north-ticks-0', sourceFrame: 0, piece: 8, x: 11, y: -12, armsPreset: 'north-thrust-coil', headPose: { dx: 0, dy: -1, cloakPiece: 9 }, insertMode: 'back' },
  { sourcePoseId: 'pose-4063-north-ticks-0', sourceFrame: 0, piece: 8, x: 11, y: -10, armsPreset: 'north-thrust-coil', headPose: { dx: 0, dy: -2, cloakPiece: 9 }, insertMode: 'back' },
  { sourcePoseId: 'pose-3988-north-ticks-0', sourceFrame: 0, piece: 22, x: 8, y: -10, armsPreset: 'north-ready', headPose: { dx: 0, dy: -1, cloakPiece: 8 }, insertMode: 'back' },
  { sourcePoseId: 'pose-3988-north-ticks-0', sourceFrame: 0, piece: 23, x: 8, y: -9, armsPreset: 'north-ready', insertMode: 'back' },
];

// 8. 3 个自身增益共用双手立枪聚气动作（12 帧，南/北向双手正握立枪顿地聚气、取消单手举拳战吼）
const BUFF_CAST_SOUTH_FRAMES: readonly SpearKeyframeSpec[] = [
  { sourcePoseId: 'pose-3977-south-ticks-16', sourceFrame: 0, piece: 4, x: -5, y: -12, armsPreset: 'south-buff-upright', headPose: { dy: -1, cloakPiece: 0 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-3977-south-ticks-16', sourceFrame: 1, piece: 4, x: -5, y: -13, armsPreset: 'south-buff-upright', headPose: { dy: -2, cloakPiece: 3 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-3977-south-ticks-16', sourceFrame: 2, piece: 4, x: -5, y: -10, armsPreset: 'south-buff-upright', headPose: { view: 'south-action', dy: 3, cloakPiece: 2 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-3977-south-ticks-16', sourceFrame: 3, piece: 5, x: -5, y: -10, armsPreset: 'south-buff-upright', headPose: { view: 'south-action', dy: 1, cloakPiece: 3 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-3977-south-ticks-16', sourceFrame: 4, piece: 4, x: -5, y: -10, armsPreset: 'south-buff-upright', headPose: { dy: -1, cloakPiece: 1 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-3977-south-ticks-16', sourceFrame: 5, piece: 5, x: -5, y: -10, armsPreset: 'south-buff-upright', headPose: { dy: 0, cloakPiece: 2 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-3977-south-ticks-16', sourceFrame: 6, piece: 4, x: -5, y: -10, armsPreset: 'south-buff-upright', headPose: { dy: -1, cloakPiece: 3 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-3977-south-ticks-16', sourceFrame: 7, piece: 5, x: -5, y: -10, armsPreset: 'south-buff-upright', headPose: { dy: 1, cloakPiece: 1 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-3977-south-ticks-16', sourceFrame: 8, piece: 4, x: -5, y: -10, armsPreset: 'south-buff-upright', headPose: { dy: -1, cloakPiece: 2 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-3977-south-ticks-16', sourceFrame: 9, piece: 5, x: -5, y: -10, armsPreset: 'south-buff-upright', headPose: { dy: 0, cloakPiece: 1 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-3977-south-ticks-16', sourceFrame: 1, piece: 4, x: -5, y: -10, armsPreset: 'south-buff-upright', headPose: { dy: -1, cloakPiece: 0 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 0, piece: 0, x: 0, y: -8, armsPreset: 'south-ready', insertMode: 'between-south-arms' },
];

const BUFF_CAST_WEST_FRAMES: readonly SpearKeyframeSpec[] = [
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 4, x: -8, y: -12, armsPreset: 'buff-upright', headPose: { dx: 1, dy: -1, cloakPiece: 4 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 4, x: -8, y: -13, bodyDy: -1, armsPreset: 'buff-upright', headPose: { dx: 1, dy: -1, cloakPiece: 6 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 4, x: -8, y: -10, armsPreset: 'buff-upright', headPose: { view: 'west-action', dx: -1, dy: 2, torsoDy: 1, cloakPiece: 7 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 1, piece: 5, x: -8, y: -10, armsPreset: 'buff-upright', headPose: { view: 'west-action', dx: -1, dy: 1, torsoDy: 1, cloakPiece: 5 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 4, x: -8, y: -10, armsPreset: 'buff-upright', headPose: { dx: 0, dy: -1, cloakPiece: 6 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 1, piece: 5, x: -8, y: -10, armsPreset: 'buff-upright', headPose: { dx: 0, dy: 0, cloakPiece: 5 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 4, x: -8, y: -10, armsPreset: 'buff-upright', headPose: { dx: 1, dy: -1, cloakPiece: 7 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 1, piece: 5, x: -8, y: -10, armsPreset: 'buff-upright', headPose: { dx: 0, dy: 1, cloakPiece: 5 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 4, x: -8, y: -10, armsPreset: 'buff-upright', headPose: { dx: 0, dy: -1, cloakPiece: 6 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 1, piece: 5, x: -8, y: -10, armsPreset: 'buff-upright', headPose: { dx: 0, dy: 0, cloakPiece: 5 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 4, x: -7, y: -10, armsPreset: 'buff-upright', headPose: { dx: 0, dy: 1, cloakPiece: 4 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 2, x: -3, y: -10, insertMode: 'between-west-arms' },
];

const BUFF_CAST_NORTH_FRAMES: readonly SpearKeyframeSpec[] = [
  { sourcePoseId: 'pose-3979-north-ticks-16', sourceFrame: 0, piece: 4, x: 8, y: -12, scaleX: -1, armsPreset: 'north-buff-upright', headPose: { dy: -1, cloakPiece: 8 }, insertMode: 'back' },
  { sourcePoseId: 'pose-3979-north-ticks-16', sourceFrame: 1, piece: 4, x: 8, y: -13, scaleX: -1, armsPreset: 'north-buff-upright', headPose: { dy: -2, cloakPiece: 10 }, insertMode: 'back' },
  { sourcePoseId: 'pose-3979-north-ticks-16', sourceFrame: 2, piece: 4, x: 8, y: -10, scaleX: -1, armsPreset: 'north-buff-upright', headPose: { dx: -1, dy: 1, cloakPiece: 11 }, insertMode: 'back' },
  { sourcePoseId: 'pose-3979-north-ticks-16', sourceFrame: 3, piece: 5, x: 8, y: -10, scaleX: -1, armsPreset: 'north-buff-upright', headPose: { dx: -1, dy: 0, cloakPiece: 10 }, insertMode: 'back' },
  { sourcePoseId: 'pose-3979-north-ticks-16', sourceFrame: 4, piece: 4, x: 8, y: -10, scaleX: -1, armsPreset: 'north-buff-upright', headPose: { dx: -2, dy: -1, cloakPiece: 9 }, insertMode: 'back' },
  { sourcePoseId: 'pose-3979-north-ticks-16', sourceFrame: 5, piece: 5, x: 8, y: -10, scaleX: -1, armsPreset: 'north-buff-upright', headPose: { dx: -1, dy: 0, cloakPiece: 11 }, insertMode: 'back' },
  { sourcePoseId: 'pose-3979-north-ticks-16', sourceFrame: 6, piece: 4, x: 8, y: -10, scaleX: -1, armsPreset: 'north-buff-upright', headPose: { dx: -2, dy: -1, cloakPiece: 10 }, insertMode: 'back' },
  { sourcePoseId: 'pose-3979-north-ticks-16', sourceFrame: 7, piece: 5, x: 8, y: -10, scaleX: -1, armsPreset: 'north-buff-upright', headPose: { dx: -1, dy: 1, cloakPiece: 9 }, insertMode: 'back' },
  { sourcePoseId: 'pose-3979-north-ticks-16', sourceFrame: 8, piece: 4, x: 8, y: -10, scaleX: -1, armsPreset: 'north-buff-upright', headPose: { dx: -2, dy: -1, cloakPiece: 11 }, insertMode: 'back' },
  { sourcePoseId: 'pose-3979-north-ticks-16', sourceFrame: 9, piece: 5, x: 8, y: -10, scaleX: -1, armsPreset: 'north-buff-upright', headPose: { dx: -1, dy: 0, cloakPiece: 10 }, insertMode: 'back' },
  { sourcePoseId: 'pose-3979-north-ticks-16', sourceFrame: 1, piece: 4, x: 8, y: -10, scaleX: -1, armsPreset: 'north-buff-upright', headPose: { dy: -1, cloakPiece: 8 }, insertMode: 'back' },
  { sourcePoseId: 'pose-3988-north-ticks-0', sourceFrame: 0, piece: 23, x: 8, y: -9, armsPreset: 'north-ready', insertMode: 'back' },
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

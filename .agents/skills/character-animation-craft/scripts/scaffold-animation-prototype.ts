#!/usr/bin/env node
/**
 * 新武器 / 新职业动画样板初始化脚手架。
 *
 * 自动生成可直接导出并挂入 `warrior-viewer` 的 `source.ts`、`effects-source.ts`、`export.ts`：
 * - 自带 14 色量化像素绘制基元、兼容 63 套盔甲的手臂预设、62 套贴地战斗腿、70 款头饰联动与 13 种遮挡层序；
 * - 自带 4 向待机 / 行走 / 城镇背负 / 普攻与 1 套 normal+add 双层像素挥砍光效，且开箱即通过动画质量体检脚本。
 *
 * 用法：
 *   node .agents/skills/character-animation-craft/scripts/scaffold-animation-prototype.ts \
 *     --weapon halberd --name 长戟 [--out <dir>] [--dry-run] [--force]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function findRepoRoot(startDir: string): string {
  for (const base of [startDir, process.cwd()]) {
    let dir = path.resolve(base);
    for (let i = 0; i < 10; i++) {
      if (fs.existsSync(path.join(dir, 'public/content/wardrobe.json'))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  throw new Error('未能定位仓库根目录（未找到 public/content/wardrobe.json）');
}

function parseArgs(argv: readonly string[]): {
  weapon: string;
  name: string;
  outDir?: string;
  dryRun: boolean;
  force: boolean;
} {
  let weapon = '';
  let name = '';
  let outDir: string | undefined;
  let dryRun = false;
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--weapon' || arg === '-w') weapon = argv[++i] ?? '';
    else if (arg === '--name' || arg === '-n') name = argv[++i] ?? '';
    else if (arg === '--out' || arg === '-o') outDir = argv[++i];
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--force') force = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('用法: node scaffold-animation-prototype.ts --weapon <id> --name <中文名> [--out <dir>] [--dry-run] [--force]');
      process.exit(0);
    }
  }
  if (!/^[a-z][a-z0-9-]*$/.test(weapon)) {
    throw new Error(`--weapon 必须是小写字母/数字/短横线标识（例如 halberd、twin-blade），收到：${weapon || '(空)'}`);
  }
  if (!name.trim()) {
    throw new Error('缺少 --name 参数（中文武器名，例如 --name 长戟）');
  }
  return { weapon, name: name.trim(), outDir: outDir ? path.resolve(outDir) : undefined, dryRun, force };
}

function makeSourceTs(weapon: string, name: string): string {
  return `/**
 * ${name}（${weapon}）动画样板可编辑像素源数据。
 *
 * 修改切片像素、色板、握点或关键帧后运行：
 *   node export.ts
 */

export interface PixelSliceSource {
  id: string;
  label: string;
  anchorX: number;
  anchorY: number;
  rows: readonly string[];
}

export type RgbaPalette = Readonly<Record<string, readonly [number, number, number, number]>>;

/** 14 色量化调色板（与原版轮廓、冷钢 4 阶与硬木 3 阶口径一致）。 */
export const WEAPON_PALETTE: RgbaPalette = {
  '.': [0, 0, 0, 0],
  K: [0x18, 0x0c, 0x08, 255],
  D: [0x31, 0x24, 0x29, 255],
  S: [0x52, 0x5d, 0x6b, 255],
  M: [0x84, 0x92, 0xa5, 255],
  L: [0xad, 0xba, 0xc6, 255],
  H: [0xee, 0xf4, 0xf8, 255],
  w: [0x3b, 0x25, 0x1e, 255],
  W: [0x6b, 0x47, 0x32, 255],
  u: [0x9b, 0x6e, 0x4a, 255],
  g: [0x8c, 0x62, 0x28, 255],
  G: [0xdf, 0xb4, 0x54, 255],
  r: [0x6b, 0x14, 0x14, 255],
  R: [0xc4, 0x29, 0x24, 255],
  P: [0xf2, 0x62, 0x4e, 255],
};

function blankGrid(width: number, height: number): string[][] {
  return Array.from({ length: height }, () => Array.from({ length: width }, () => '.'));
}

function put(grid: string[][], x: number, y: number, ch: string): void {
  const rx = Math.round(x);
  const ry = Math.round(y);
  if (ry >= 0 && ry < grid.length && rx >= 0 && rx < grid[0]!.length) grid[ry]![rx] = ch;
}

/** 围绕非透明像素补 1px 四邻外轮廓。 */
function applyOutline(grid: string[][], outlineColor: string, predicate?: (ch: string) => boolean): void {
  const h = grid.length;
  const w = grid[0]!.length;
  const marks: [number, number][] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (grid[y]![x] !== '.') continue;
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]] as const) {
        if (ny < 0 || ny >= h || nx < 0 || nx >= w) continue;
        const nch = grid[ny]![nx]!;
        if (nch !== '.' && (!predicate || predicate(nch))) {
          marks.push([x, y]);
          break;
        }
      }
    }
  }
  for (const [x, y] of marks) grid[y]![x] = outlineColor;
}

/** 通用参数化冷兵器切片构造器（可按具体武器形态替换刃形与装饰）。 */
function buildWeaponSlice(options: {
  width: number;
  height: number;
  tipX: number;
  tipY: number;
  buttX: number;
  buttY: number;
  bladeLen: number;
  collarLen: number;
  buttLen: number;
  upright?: boolean;
}): string[] {
  const { width, height, tipX, tipY, buttX, buttY, bladeLen, collarLen, buttLen, upright } = options;
  const grid = blankGrid(width, height);
  const dx = buttX - tipX;
  const dy = buttY - tipY;
  const totalLen = Math.hypot(dx, dy) || 1;
  const ux = dx / totalLen;
  const uy = dy / totalLen;
  let nx = -uy;
  let ny = ux;
  if (upright ? nx > 0 : ny > 0) { nx = -nx; ny = -ny; }
  const at = (t: number, off: number): [number, number] => [tipX + ux * t + nx * off, tipY + uy * t + ny * off];

  const shaftStart = bladeLen + collarLen;
  const shaftEnd = totalLen - buttLen;
  for (let s = shaftStart * 3; s <= shaftEnd * 3; s++) {
    const t = s / 3;
    const [bx, by] = at(t, -0.45);
    const [tx, ty] = at(t, 0.45);
    put(grid, bx, by, 'w');
    put(grid, tx, ty, 'u');
  }
  for (let s = shaftEnd * 3; s <= totalLen * 3; s++) {
    const [px, py] = at(s / 3, 0);
    put(grid, px, py, 'M');
  }
  for (let s = 0; s <= bladeLen * 4; s++) {
    const t = s / 4;
    const f = t / bladeLen;
    const halfW = f < 0.2 ? 0.3 : f < 0.7 ? 0.3 + ((f - 0.2) / 0.5) * 1.9 : 2.2 - ((f - 0.7) / 0.3) * 1.3;
    for (let o = -halfW; o <= halfW; o += 0.3) {
      const [px, py] = at(t, o);
      put(grid, px, py, Math.abs(o) <= 0.4 ? 'H' : o > 0 ? 'L' : 'S');
    }
  }
  for (let s = bladeLen * 3; s <= shaftStart * 3; s++) {
    for (let o = -1.1; o <= 1.1; o += 0.4) {
      const [px, py] = at(s / 3, o);
      put(grid, px, py, o > 0 ? 'G' : 'g');
    }
  }
  applyOutline(grid, 'D', ch => ch === 'H' || ch === 'L' || ch === 'M' || ch === 'S');
  applyOutline(grid, 'K', ch => ch !== 'D');
  return grid.map(row => row.join(''));
}

export const WEAPON_SLICES: readonly PixelSliceSource[] = [
  {
    id: '${weapon}-carry-side',
    label: '西/东向单手平提',
    anchorX: 30,
    anchorY: 10,
    rows: buildWeaponSlice({ width: 52, height: 20, tipX: 2, tipY: 3, buttX: 49, buttY: 13, bladeLen: 14, collarLen: 2, buttLen: 4 }),
  },
  {
    id: '${weapon}-carry-south',
    label: '南向单手透视平提',
    anchorX: 12,
    anchorY: 19,
    rows: buildWeaponSlice({ width: 24, height: 42, tipX: 4, tipY: 38, buttX: 19, buttY: 2, bladeLen: 12, collarLen: 2, buttLen: 4, upright: true }),
  },
  {
    id: '${weapon}-carry-north',
    label: '北向单手透视平提',
    anchorX: 12,
    anchorY: 23,
    rows: buildWeaponSlice({ width: 24, height: 42, tipX: 19, tipY: 2, buttX: 8, buttY: 38, bladeLen: 12, collarLen: 2, buttLen: 4, upright: true }),
  },
  {
    id: '${weapon}-back-diag',
    label: '城镇斜背（南/北）',
    anchorX: 18,
    anchorY: 22,
    rows: buildWeaponSlice({ width: 38, height: 44, tipX: 34, tipY: 2, buttX: 3, buttY: 41, bladeLen: 14, collarLen: 2, buttLen: 4 }),
  },
  {
    id: '${weapon}-back-side',
    label: '城镇斜背（西/东）',
    anchorX: 17,
    anchorY: 23,
    rows: buildWeaponSlice({ width: 34, height: 47, tipX: 30, tipY: 2, buttX: 4, buttY: 44, bladeLen: 14, collarLen: 2, buttLen: 4 }),
  },
  {
    id: '${weapon}-strike-west',
    label: '西/东向水平前击',
    anchorX: 31,
    anchorY: 7,
    rows: buildWeaponSlice({ width: 53, height: 15, tipX: 2, tipY: 7, buttX: 50, buttY: 7, bladeLen: 15, collarLen: 2, buttLen: 4 }),
  },
  {
    id: '${weapon}-strike-south',
    label: '南向前击',
    anchorX: 7,
    anchorY: 19,
    rows: buildWeaponSlice({ width: 15, height: 52, tipX: 7, tipY: 49, buttX: 7, buttY: 2, bladeLen: 15, collarLen: 2, buttLen: 4, upright: true }),
  },
  {
    id: '${weapon}-strike-north',
    label: '北向高位前击',
    anchorX: 12,
    anchorY: 32,
    rows: buildWeaponSlice({ width: 20, height: 46, tipX: 6, tipY: 2, buttX: 15, buttY: 42, bladeLen: 14, collarLen: 2, buttLen: 4, upright: true }),
  },
];

export type WeaponInsertMode =
  | 'front'
  | 'back'
  | 'on-back-north'
  | 'between-west-arms'
  | 'between-south-arms'
  | 'before-right-arm-south'
  | 'before-right-arm-north'
  | 'single-hand-west';

export type WeaponArmLayer = 'behind-torso' | 'behind-weapon' | 'front-of-weapon';

export interface WeaponArmPlacement {
  piece: number;
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  layer?: WeaponArmLayer;
}

export interface WeaponArmsSpec {
  baseTorsoX?: number;
  backArm: WeaponArmPlacement;
  frontArm: WeaponArmPlacement;
}

/** 兼容全部 63 套盔甲的标准双手预设（仅使用 coat-front[5..14]，angle 恒为 0）。 */
export const WEAPON_ARMS_PRESETS = {
  'west-ready': {
    backArm: { piece: 13, x: -3, y: -1, scaleX: 1, scaleY: 1, layer: 'behind-torso' },
    frontArm: { piece: 8, x: -2, y: 3, scaleX: 1, scaleY: 1, layer: 'front-of-weapon' },
  },
  'west-coil': {
    backArm: { piece: 7, x: 5, y: 1, scaleX: -1, scaleY: 1, layer: 'behind-torso' },
    frontArm: { piece: 11, x: 0, y: 0, scaleX: 1, scaleY: 1, layer: 'front-of-weapon' },
  },
  'west-extend': {
    backArm: { piece: 13, x: -8, y: -2, scaleX: 1, scaleY: 1, layer: 'behind-torso' },
    frontArm: { piece: 13, x: 0, y: -1, scaleX: 1, scaleY: 1, layer: 'front-of-weapon' },
  },
  'south-ready': {
    baseTorsoX: 0,
    backArm: { piece: 11, x: 1, y: -1, scaleX: -1, scaleY: 1, layer: 'front-of-weapon' },
    frontArm: { piece: 10, x: 0, y: -2, scaleX: 1, scaleY: 1, layer: 'front-of-weapon' },
  },
  'south-coil': {
    baseTorsoX: 0,
    backArm: { piece: 7, x: 2, y: -3, scaleX: -1, scaleY: 1, layer: 'front-of-weapon' },
    frontArm: { piece: 13, x: -2, y: 0, scaleX: 1, scaleY: 1, layer: 'front-of-weapon' },
  },
  'south-extend': {
    baseTorsoX: 0,
    backArm: { piece: 7, x: 3, y: 0, scaleX: -1, scaleY: 1, layer: 'front-of-weapon' },
    frontArm: { piece: 13, x: 0, y: 4, scaleX: 1, scaleY: 1, layer: 'front-of-weapon' },
  },
  'north-ready': {
    baseTorsoX: 0,
    backArm: { piece: 13, x: -2, y: -5, scaleX: -1, scaleY: 1, layer: 'behind-weapon' },
    frontArm: { piece: 13, x: 7, y: -26, scaleX: -1, scaleY: -1, layer: 'behind-weapon' },
  },
  'north-coil': {
    baseTorsoX: 0,
    backArm: { piece: 13, x: 7, y: -26, scaleX: -1, scaleY: -1, layer: 'behind-weapon' },
    frontArm: { piece: 11, x: 2, y: 0, scaleX: 1, scaleY: 1, layer: 'behind-weapon' },
  },
  'north-extend': {
    baseTorsoX: 0,
    backArm: { piece: 13, x: 4, y: -29, scaleX: -1, scaleY: -1, layer: 'behind-weapon' },
    frontArm: { piece: 11, x: 1, y: -2, scaleX: 1, scaleY: 1, layer: 'behind-weapon' },
  },
} as const satisfies Record<string, WeaponArmsSpec>;

export type WeaponArmsPreset = keyof typeof WEAPON_ARMS_PRESETS;

/** 兼容全部 62 套下装的全掌贴地战斗腿（统一接地底边 botY = 4，禁止混入走路腿 [7..10]）。 */
export const WEST_LEGS_PRESETS = {
  ready: { piece: 6, x: 0, y: -1 },
  bow: { piece: 11, x: 0, y: 1 },
  planted: { piece: 18, x: 1, y: 1 },
} as const;

export type WeaponLegsPreset = keyof typeof WEST_LEGS_PRESETS;
export type WeaponHeadView = 'south' | 'west' | 'turn-back' | 'north' | 'south-action' | 'west-action';

export interface WeaponHeadPose {
  dx?: number;
  dy?: number;
  view?: WeaponHeadView;
  scaleX?: number;
  torsoDx?: number;
  torsoDy?: number;
  cloakPiece?: number;
  cloakDx?: number;
  cloakDy?: number;
}

export interface WeaponCycleRecipe {
  id: string;
  clip: string;
  basePoseId: string;
  mirrorX: boolean;
  insertMode: WeaponInsertMode;
  piece: number;
  baseX: number;
  baseY: number;
  scaleX: number;
  stepDx?: readonly number[];
}

export interface WeaponKeyframeSpec {
  sourcePoseId: string;
  sourceFrame: number;
  piece: number;
  x: number;
  y: number;
  bodyDx?: number;
  bodyDy?: number;
  mirrorBaseFrame?: boolean;
  armsPreset?: WeaponArmsPreset;
  legsPreset?: WeaponLegsPreset;
  headPose?: WeaponHeadPose;
  scaleX?: number;
  angle?: number;
  alpha?: number;
  insertMode: WeaponInsertMode;
}

export interface WeaponActionRecipe {
  id: string;
  clip: string;
  mirrorX: boolean;
  frameRate: number;
  frames: readonly WeaponKeyframeSpec[];
}

const FPS = 50 / 3;

export const WEAPON_CYCLE_RECIPES: readonly WeaponCycleRecipe[] = [
  { id: 'prototype-${weapon}-idle-south', clip: 'idle-south', basePoseId: 'pose-3986-south-ticks-0', mirrorX: false, insertMode: 'before-right-arm-south', piece: 1, baseX: -8, baseY: -7, scaleX: 1 },
  { id: 'prototype-${weapon}-idle-west', clip: 'idle-west', basePoseId: 'pose-3987-west-ticks-0', mirrorX: false, insertMode: 'single-hand-west', piece: 0, baseX: 5, baseY: -6, scaleX: 1 },
  { id: 'prototype-${weapon}-idle-north', clip: 'idle-north', basePoseId: 'pose-3988-north-ticks-0', mirrorX: false, insertMode: 'before-right-arm-north', piece: 2, baseX: 10, baseY: -12, scaleX: 1 },
  { id: 'prototype-${weapon}-idle-east', clip: 'idle-east', basePoseId: 'pose-3987-east-ticks-0', mirrorX: true, insertMode: 'single-hand-west', piece: 0, baseX: 5, baseY: -6, scaleX: 1 },
  { id: 'prototype-${weapon}-walk-south', clip: 'walk-south', basePoseId: 'pose-3989-south-ticks-0', mirrorX: false, insertMode: 'before-right-arm-south', piece: 1, baseX: -8, baseY: -7, scaleX: 1 },
  { id: 'prototype-${weapon}-walk-west', clip: 'walk-west', basePoseId: 'pose-3990-west-ticks-0', mirrorX: false, insertMode: 'single-hand-west', piece: 0, baseX: 5, baseY: -5, scaleX: 1, stepDx: [0, 0, 0, 0, -1, -1, -1, -1] },
  { id: 'prototype-${weapon}-walk-north', clip: 'walk-north', basePoseId: 'pose-3991-north-ticks-0', mirrorX: false, insertMode: 'before-right-arm-north', piece: 2, baseX: 10, baseY: -12, scaleX: 1 },
  { id: 'prototype-${weapon}-walk-east', clip: 'walk-east', basePoseId: 'pose-3990-east-ticks-0', mirrorX: true, insertMode: 'single-hand-west', piece: 0, baseX: 5, baseY: -5, scaleX: 1, stepDx: [0, 0, 0, 0, -1, -1, -1, -1] },
  { id: 'prototype-${weapon}-town-idle-south', clip: 'town-idle-south', basePoseId: 'pose-3980-south-ticks-0', mirrorX: false, insertMode: 'back', piece: 3, baseX: 1, baseY: -19, scaleX: 1 },
  { id: 'prototype-${weapon}-town-idle-west', clip: 'town-idle-west', basePoseId: 'pose-3981-west-ticks-0', mirrorX: false, insertMode: 'back', piece: 4, baseX: 5, baseY: -19, scaleX: 1 },
  { id: 'prototype-${weapon}-town-idle-north', clip: 'town-idle-north', basePoseId: 'pose-3982-north-ticks-0', mirrorX: false, insertMode: 'on-back-north', piece: 3, baseX: -3, baseY: -15, scaleX: -1 },
  { id: 'prototype-${weapon}-town-idle-east', clip: 'town-idle-east', basePoseId: 'pose-3981-east-ticks-0', mirrorX: true, insertMode: 'back', piece: 4, baseX: 5, baseY: -19, scaleX: 1 },
  { id: 'prototype-${weapon}-town-walk-south', clip: 'town-walk-south', basePoseId: 'pose-3983-south-ticks-0', mirrorX: false, insertMode: 'back', piece: 3, baseX: 1, baseY: -19, scaleX: 1 },
  { id: 'prototype-${weapon}-town-walk-west', clip: 'town-walk-west', basePoseId: 'pose-3984-west-ticks-0', mirrorX: false, insertMode: 'back', piece: 4, baseX: 5, baseY: -19, scaleX: 1 },
  { id: 'prototype-${weapon}-town-walk-north', clip: 'town-walk-north', basePoseId: 'pose-3985-north-ticks-0', mirrorX: false, insertMode: 'on-back-north', piece: 3, baseX: -3, baseY: -15, scaleX: -1 },
  { id: 'prototype-${weapon}-town-walk-east', clip: 'town-walk-east', basePoseId: 'pose-3984-east-ticks-0', mirrorX: true, insertMode: 'back', piece: 4, baseX: 5, baseY: -19, scaleX: 1 },
];

const ATTACK_WEST_FRAMES: readonly WeaponKeyframeSpec[] = [
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 0, x: 1, y: -7, armsPreset: 'west-ready', headPose: { view: 'west', dx: 0, dy: 0, cloakPiece: 4 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 5, x: 3, y: -11, armsPreset: 'west-coil', headPose: { view: 'west', dx: 1, dy: -1, torsoDx: 1, cloakPiece: 6 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 5, x: -12, y: -11, armsPreset: 'west-extend', legsPreset: 'bow', headPose: { view: 'west-action', dx: -3, dy: 1, torsoDx: -2, torsoDy: 1, cloakPiece: 5 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 5, x: -15, y: -11, armsPreset: 'west-extend', legsPreset: 'bow', headPose: { view: 'west-action', dx: -4, dy: 2, torsoDx: -2, torsoDy: 1, cloakPiece: 7 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 5, x: -9, y: -11, armsPreset: 'west-extend', legsPreset: 'bow', headPose: { view: 'west-action', dx: -2, dy: 1, torsoDx: -1, torsoDy: 1, cloakPiece: 5 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 5, x: -2, y: -10, armsPreset: 'west-coil', headPose: { view: 'west', dx: 0, dy: 0, cloakPiece: 4 }, insertMode: 'between-west-arms' },
  { sourcePoseId: 'pose-4068-west-ticks-0', sourceFrame: 0, piece: 0, x: 1, y: -7, armsPreset: 'west-ready', headPose: { view: 'west', dx: 0, dy: 0, cloakPiece: 4 }, insertMode: 'between-west-arms' },
];

const ATTACK_SOUTH_FRAMES: readonly WeaponKeyframeSpec[] = [
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 0, piece: 0, x: 0, y: -8, armsPreset: 'south-ready', headPose: { view: 'south', scaleX: 1, dx: 0, dy: 0, cloakPiece: 0 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 0, piece: 6, x: -5, y: -10, armsPreset: 'south-coil', headPose: { view: 'south', scaleX: 1, dx: 1, dy: -1, cloakPiece: 1 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 2, piece: 6, x: -3, y: 4, armsPreset: 'south-extend', headPose: { view: 'south-action', scaleX: 1, dx: -2, dy: -1, torsoDx: -1, cloakPiece: 2 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 2, piece: 6, x: -3, y: 8, armsPreset: 'south-extend', headPose: { view: 'south-action', scaleX: 1, dx: -2, dy: 0, torsoDx: -1, cloakPiece: 3 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 3, piece: 6, x: -3, y: 1, armsPreset: 'south-extend', headPose: { view: 'south-action', scaleX: 1, dx: -2, dy: -1, torsoDx: -1, cloakPiece: 2 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4061-south-ticks-0', sourceFrame: 4, piece: 0, x: -1, y: -7, armsPreset: 'south-ready', headPose: { view: 'south', scaleX: 1, dx: 0, dy: 0, cloakPiece: 1 }, insertMode: 'between-south-arms' },
  { sourcePoseId: 'pose-4067-south-ticks-0', sourceFrame: 0, piece: 0, x: 0, y: -8, armsPreset: 'south-ready', headPose: { view: 'south', scaleX: 1, dx: 0, dy: 0, cloakPiece: 0 }, insertMode: 'between-south-arms' },
];

const ATTACK_NORTH_FRAMES: readonly WeaponKeyframeSpec[] = [
  { sourcePoseId: 'pose-3988-north-ticks-0', sourceFrame: 0, piece: 0, x: 3, y: -16, scaleX: -1, armsPreset: 'north-ready', headPose: { view: 'north', scaleX: 1, dx: 0, dy: 0, cloakPiece: 8 }, insertMode: 'back' },
  { sourcePoseId: 'pose-4063-north-ticks-0', sourceFrame: 0, piece: 7, x: 10, y: -13, armsPreset: 'north-coil', headPose: { view: 'north', scaleX: 1, dx: 0, dy: -1, cloakPiece: 9 }, insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 4, piece: 7, x: 6, y: -21, armsPreset: 'north-extend', headPose: { view: 'north', scaleX: 1, dx: 0, dy: -4, torsoDy: -1, cloakPiece: 10 }, insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 4, piece: 7, x: 6, y: -23, armsPreset: 'north-extend', headPose: { view: 'north', scaleX: 1, dx: 0, dy: -5, torsoDy: -2, cloakPiece: 11 }, insertMode: 'back' },
  { sourcePoseId: 'pose-4075-north-ticks-0', sourceFrame: 4, piece: 7, x: 8, y: -18, armsPreset: 'north-extend', headPose: { view: 'north', scaleX: 1, dx: 0, dy: -4, cloakPiece: 10 }, insertMode: 'back' },
  { sourcePoseId: 'pose-4063-north-ticks-0', sourceFrame: 0, piece: 7, x: 10, y: -13, armsPreset: 'north-coil', headPose: { view: 'north', scaleX: 1, dx: 0, dy: -3, cloakPiece: 9 }, insertMode: 'back' },
  { sourcePoseId: 'pose-3988-north-ticks-0', sourceFrame: 0, piece: 0, x: 3, y: -16, scaleX: -1, armsPreset: 'north-ready', headPose: { view: 'north', scaleX: 1, dx: 0, dy: 0, cloakPiece: 8 }, insertMode: 'back' },
];

export const WEAPON_ACTION_RECIPES: readonly WeaponActionRecipe[] = [
  { id: 'prototype-${weapon}-attack-south', clip: 'attack-south', mirrorX: false, frameRate: FPS, frames: ATTACK_SOUTH_FRAMES },
  { id: 'prototype-${weapon}-attack-west', clip: 'attack-west', mirrorX: false, frameRate: FPS, frames: ATTACK_WEST_FRAMES },
  { id: 'prototype-${weapon}-attack-north', clip: 'attack-north', mirrorX: false, frameRate: FPS, frames: ATTACK_NORTH_FRAMES },
  { id: 'prototype-${weapon}-attack-east', clip: 'attack-east', mirrorX: true, frameRate: FPS, frames: ATTACK_WEST_FRAMES },
];
`;
}

function makeEffectsSourceTs(weapon: string, name: string): string {
  return `/**
 * ${name}（${weapon}）双层像素特效源数据（normal 底光 + add 炽核）。
 */
import type { RgbaPalette } from './source.ts';

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

const COLOR_RANK: Record<string, number> = { '.': 0, d: 1, D: 2, B: 3, C: 4, L: 5, W: 6 };

export const SILVER_BASE_PALETTE: RgbaPalette = {
  '.': [0, 0, 0, 0],
  d: [0x36, 0x48, 0x60, 115],
  D: [0x5a, 0x74, 0x92, 175],
  B: [0x90, 0xae, 0xc9, 210],
  C: [0xc4, 0xdc, 0xf0, 232],
  L: [0xe4, 0xf2, 0xff, 245],
  W: [0xff, 0xff, 0xff, 255],
};

export const SILVER_ADD_PALETTE: RgbaPalette = {
  '.': [0, 0, 0, 0],
  d: [0x4c, 0x66, 0x84, 80],
  D: [0x7e, 0xa2, 0xc4, 130],
  B: [0xb4, 0xd2, 0xec, 175],
  C: [0xd8, 0xec, 0xff, 210],
  L: [0xee, 0xf7, 0xff, 235],
  W: [0xff, 0xff, 0xff, 255],
};

function blank(w: number, h: number): string[][] {
  return Array.from({ length: h }, () => Array.from({ length: w }, () => '.'));
}

function plotMax(grid: string[][], x: number, y: number, ch: string): void {
  const rx = Math.round(x);
  const ry = Math.round(y);
  if (ry < 0 || ry >= grid.length || rx < 0 || rx >= grid[0]!.length) return;
  if ((COLOR_RANK[ch] ?? 0) > (COLOR_RANK[grid[ry]![rx]!] ?? 0)) grid[ry]![rx] = ch;
}

function buildBasicStrike(direction: 'west' | 'south' | 'north'): DirectionalEffectSource {
  const isHoriz = direction === 'west';
  const frameWidth = isHoriz ? 68 : 28;
  const frameHeight = isHoriz ? 28 : 64;
  const originX = isHoriz ? 0.82 : 0.5;
  const originY = direction === 'south' ? 0.16 : direction === 'north' ? 0.84 : 0.62;
  const baseFrames: EffectFrameGrid[] = [];
  const addFrames: EffectFrameGrid[] = [];

  for (let fi = 0; fi < 3; fi++) {
    const base = blank(frameWidth, frameHeight);
    const add = blank(frameWidth, frameHeight);
    const len = fi === 0 ? 34 : fi === 1 ? 48 : 30;
    const thickness = fi === 1 ? 3.2 : 2.0;
    for (let s = 0; s <= len; s++) {
      const f = s / len;
      const half = Math.max(0.5, thickness * Math.sin(f * Math.PI));
      for (let o = -half; o <= half; o += 0.5) {
        const bx = direction === 'west' ? frameWidth * originX - 8 - s : frameWidth * originX + o;
        const by = direction === 'west'
          ? frameHeight * originY - 6 + o
          : direction === 'south'
            ? frameHeight * originY + 6 + s
            : frameHeight * originY - 8 - s;
        const ch = Math.abs(o) <= 0.7 ? (fi === 1 ? 'W' : 'L') : Math.abs(o) <= half * 0.6 ? 'C' : 'B';
        plotMax(base, bx, by, ch);
        if (Math.abs(o) <= half * 0.7) plotMax(add, bx, by, ch === 'W' ? 'W' : 'L');
      }
    }
    baseFrames.push({ id: '${weapon}-basic-strike-' + direction + '-base-' + fi, rows: base.map(r => r.join('')) });
    addFrames.push({ id: '${weapon}-basic-strike-' + direction + '-add-' + fi, rows: add.map(r => r.join('')) });
  }

  return {
    effectId: '${weapon}-basic-strike',
    direction,
    frameWidth,
    frameHeight,
    originX,
    originY,
    basePalette: SILVER_BASE_PALETTE,
    addPalette: SILVER_ADD_PALETTE,
    baseFrames,
    addFrames,
  };
}

export const WEAPON_EFFECT_SOURCES: readonly DirectionalEffectSource[] = [
  buildBasicStrike('west'),
  buildBasicStrike('south'),
  buildBasicStrike('north'),
];
`;
}

function makeExportTs(weapon: string, name: string): string {
  return `import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { PNG as PngType } from 'pngjs';
import { WEAPON_EFFECT_SOURCES, type EffectFrameGrid } from './effects-source.ts';
import {
  WEAPON_ACTION_RECIPES,
  WEAPON_ARMS_PRESETS,
  WEAPON_CYCLE_RECIPES,
  WEAPON_PALETTE,
  WEAPON_SLICES,
  WEST_LEGS_PRESETS,
  type RgbaPalette,
  type WeaponActionRecipe,
  type WeaponArmsPreset,
  type WeaponCycleRecipe,
  type WeaponHeadPose,
  type WeaponHeadView,
  type WeaponInsertMode,
  type WeaponLegsPreset,
} from './source.ts';

interface CostumePart {
  part: string;
  piece: number;
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  angle: number;
  alpha: number;
}
interface CostumePiece {
  texture: string;
  x: number;
  y: number;
  width: number;
  height: number;
  anchorX: number;
  anchorY: number;
}
interface CostumePose {
  mirrorX: boolean;
  frameRate: number;
  frames: CostumePart[][];
}

function findRepoRoot(startDir: string): string {
  for (const base of [process.env.INOITA_REPO_ROOT ?? '', startDir, process.cwd()]) {
    if (!base) continue;
    let dir = path.resolve(base);
    for (let i = 0; i < 10; i++) {
      if (fs.existsSync(path.join(dir, 'public/content/wardrobe.json'))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  throw new Error('未能定位仓库根目录（未找到 public/content/wardrobe.json）');
}

const dir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = findRepoRoot(dir);
const require = createRequire(path.join(repoRoot, 'package.json'));
const { PNG } = require('pngjs') as typeof import('pngjs');

const wardrobePath = path.join(repoRoot, 'public/content/wardrobe.json');
const pngOutPath = path.join(dir, '${weapon}-parts.png');
const effectsPngOutPath = path.join(dir, '${weapon}-effects.png');
const jsonOutPath = path.join(dir, '${weapon}-prototype.json');

const TEXTURE_KEY = 'prototype-${weapon}-parts';
const TEXTURE_URL = 'tools/warrior-viewer/prototypes/${weapon}/${weapon}-parts.png';
const EFFECT_TEXTURE_KEY = 'prototype-${weapon}-effects';
const EFFECT_TEXTURE_URL = 'tools/warrior-viewer/prototypes/${weapon}/${weapon}-effects.png';
const PADDING = 2;
const EFFECT_FPS = 50 / 3;
const MAX_EFFECT_SHEET_WIDTH = 3840;

const REMOVED_WEAPON_PARTS = new Set([
  'two-handed', 'staff', 'orb', 'main-blade', 'off-blade', 'main-dagger', 'off-dagger', 'shield', 'bow', 'crossbow', 'spear', '${weapon}',
]);

const HEAD_VIEW_PIECES: Record<WeaponHeadView, { face: number; neck: number; head: number }> = {
  south: { face: 0, neck: 4, head: 0 },
  west: { face: 1, neck: 5, head: 1 },
  'turn-back': { face: 2, neck: 6, head: 2 },
  north: { face: 3, neck: 7, head: 3 },
  'south-action': { face: 0, neck: 4, head: 4 },
  'west-action': { face: 1, neck: 5, head: 5 },
};

function isCoatFrontArm(part: CostumePart): boolean {
  return part.part === 'coat-front' && part.piece >= 3 && part.piece <= 14;
}

function mirrorPartX(part: CostumePart): CostumePart {
  return { ...part, x: -part.x, scaleX: -part.scaleX, angle: part.angle ? -part.angle : 0 };
}

function applyHeadPose(frame: CostumePart[], headPose?: WeaponHeadPose): CostumePart[] {
  if (!headPose) return frame;
  const viewPieces = headPose.view ? HEAD_VIEW_PIECES[headPose.view] : undefined;
  const dx = headPose.dx ?? 0;
  const dy = headPose.dy ?? 0;
  const torsoDx = headPose.torsoDx ?? 0;
  const torsoDy = headPose.torsoDy ?? 0;
  const cloakDx = headPose.cloakDx ?? torsoDx;
  const cloakDy = headPose.cloakDy ?? torsoDy;
  return frame.map(part => {
    if (part.part === 'body') {
      const piece = viewPieces ? (part.piece >= 4 ? viewPieces.neck : viewPieces.face) : part.piece;
      return { ...part, piece, x: part.x + dx, y: part.y + dy, scaleX: headPose.scaleX ?? part.scaleX };
    }
    if (part.part === 'head-front' || part.part === 'head-back') {
      return { ...part, piece: viewPieces ? viewPieces.head : part.piece, x: part.x + dx, y: part.y + dy, scaleX: headPose.scaleX ?? part.scaleX };
    }
    if (part.part === 'coat-front' && !isCoatFrontArm(part) && (torsoDx !== 0 || torsoDy !== 0)) {
      return { ...part, x: part.x + torsoDx, y: part.y + torsoDy };
    }
    if (part.part === 'cloak' && (headPose.cloakPiece !== undefined || cloakDx !== 0 || cloakDy !== 0)) {
      return { ...part, piece: headPose.cloakPiece ?? part.piece, x: part.x + cloakDx, y: part.y + cloakDy };
    }
    return part;
  });
}

function insertWeaponIntoFrame(
  frame: CostumePart[],
  weaponPart: CostumePart,
  insertMode: WeaponInsertMode,
  bodyDx = 0,
  bodyDy = 0,
  armsPreset?: WeaponArmsPreset,
  mirrorBaseFrame = false,
  legsPreset?: WeaponLegsPreset,
  headPose?: WeaponHeadPose,
): CostumePart[] {
  const shift = (part: CostumePart): CostumePart => ({ ...part, x: part.x + bodyDx, y: part.y + bodyDy });
  const shiftedWeapon: CostumePart = { ...weaponPart, x: weaponPart.x + bodyDx, y: weaponPart.y + bodyDy };
  const legsApplied = legsPreset
    ? frame.map(part => (part.part === 'coat-back'
      ? { part: 'coat-back', piece: WEST_LEGS_PRESETS[legsPreset].piece, x: WEST_LEGS_PRESETS[legsPreset].x, y: WEST_LEGS_PRESETS[legsPreset].y, scaleX: 1, scaleY: 1, angle: 0, alpha: 1 }
      : part))
    : frame;
  const poseApplied = applyHeadPose(legsApplied, headPose);

  if (armsPreset) {
    const preset = WEAPON_ARMS_PRESETS[armsPreset];
    const bodyOnly = poseApplied.filter(part => !REMOVED_WEAPON_PARTS.has(part.part) && !isCoatFrontArm(part));
    const torsoIdx = bodyOnly.findIndex(part => part.part === 'coat-front');
    if (torsoIdx < 0) throw new Error(\`armsPreset=\${armsPreset} 缺少 coat-front 躯干切片\`);
    const torso = bodyOnly[torsoIdx]!;
    const baseTorsoX = 'baseTorsoX' in preset ? preset.baseTorsoX : -1;
    const torsoDx = torso.x - baseTorsoX;
    const torsoDy = torso.y;
    const buildArm = (arm: { piece: number; x: number; y: number; scaleX: number; scaleY: number }): CostumePart => ({
      part: 'coat-front', piece: arm.piece, x: arm.x + torsoDx, y: arm.y + torsoDy,
      scaleX: arm.scaleX, scaleY: arm.scaleY, angle: 0, alpha: 1,
    });
    const transform = (part: CostumePart): CostumePart => shift(mirrorBaseFrame ? mirrorPartX(part) : part);
    const backList = bodyOnly.slice(0, torsoIdx).map(transform);
    const torsoOut = transform(torso);
    const afterList = bodyOnly.slice(torsoIdx + 1).map(transform);
    const armsWithLayer = [
      { part: transform(buildArm(preset.backArm)), layer: preset.backArm.layer ?? 'behind-torso' },
      { part: transform(buildArm(preset.frontArm)), layer: preset.frontArm.layer ?? 'front-of-weapon' },
    ];
    const behindTorso = armsWithLayer.filter(a => a.layer === 'behind-torso').map(a => a.part);
    const behindWeapon = armsWithLayer.filter(a => a.layer === 'behind-weapon').map(a => a.part);
    const frontWeapon = armsWithLayer.filter(a => a.layer === 'front-of-weapon').map(a => a.part);

    if (insertMode === 'back') return [...behindTorso, shiftedWeapon, ...behindWeapon, ...backList, torsoOut, ...frontWeapon, ...afterList];
    if (insertMode === 'front') return [...backList, ...behindTorso, torsoOut, ...behindWeapon, ...afterList, shiftedWeapon, ...frontWeapon];
    return [...backList, ...behindTorso, torsoOut, ...behindWeapon, shiftedWeapon, ...frontWeapon, ...afterList];
  }

  const baseFrame = mirrorBaseFrame ? poseApplied.map(mirrorPartX) : poseApplied;
  const stripped = baseFrame.filter(part => !REMOVED_WEAPON_PARTS.has(part.part)).map(shift);
  if (insertMode === 'back') return [shiftedWeapon, ...stripped];
  if (insertMode === 'on-back-north') {
    const headIdx = stripped.findIndex(part => part.part === 'body' || part.part === 'head-front' || part.part === 'head-back');
    if (headIdx >= 0) { stripped.splice(headIdx, 0, shiftedWeapon); return stripped; }
  }
  if (insertMode === 'before-right-arm-south') {
    const armIdx = stripped.findIndex(part => part.part === 'coat-front' && (part.piece === 9 || part.piece === 5) && part.scaleX === -1);
    const torsoIdx = stripped.findIndex(part => part.part === 'coat-front' && part.piece < 5);
    const hits = [armIdx, torsoIdx].filter(i => i >= 0);
    if (hits.length) { stripped.splice(Math.min(...hits), 0, shiftedWeapon); return stripped; }
  }
  if (insertMode === 'before-right-arm-north') {
    const upgraded = stripped.map(part => (
      part.part === 'coat-front' && isCoatFrontArm(part) && part.scaleX === 1
        ? { ...part, piece: 7, x: 3, y: part.y - 2, scaleX: 1, scaleY: 1, angle: 0 }
        : part
    ));
    const armIdx = upgraded.findIndex(part => part.part === 'coat-front' && isCoatFrontArm(part) && part.scaleX === 1);
    const cloakIdx = upgraded.findIndex(part => part.part === 'cloak');
    const hits = [armIdx, cloakIdx].filter(i => i >= 0);
    if (hits.length) { upgraded.splice(Math.min(...hits), 0, shiftedWeapon); return upgraded; }
    return [shiftedWeapon, ...upgraded];
  }
  if (insertMode === 'single-hand-west') {
    const bodyNoArms = stripped.filter(part => !(part.part === 'coat-front' && isCoatFrontArm(part)));
    const torsoIdx = bodyNoArms.findIndex(part => part.part === 'coat-front');
    const torso = bodyNoArms[torsoIdx];
    const isWalk = torso ? torso.x < 0 : false;
    const torsoDy = torso?.y ?? 0;
    const strideDx = isWalk ? (shiftedWeapon.x - 5) : 0;
    const farEmptyArm: CostumePart = { part: 'coat-front', piece: 10, x: isWalk ? (-4 - strideDx * 2) : -4, y: (isWalk ? 3 : 2) + torsoDy, scaleX: 1, scaleY: 1, angle: 0, alpha: 1 };
    const nearGripArm: CostumePart = { part: 'coat-front', piece: 6, x: -3 + strideDx, y: (isWalk ? 1 : 0) + torsoDy, scaleX: 1, scaleY: 1, angle: 0, alpha: 1 };
    if (torsoIdx >= 0) {
      return [...bodyNoArms.slice(0, torsoIdx), farEmptyArm, bodyNoArms[torsoIdx]!, shiftedWeapon, nearGripArm, ...bodyNoArms.slice(torsoIdx + 1)];
    }
    return [farEmptyArm, shiftedWeapon, nearGripArm, ...bodyNoArms];
  }
  stripped.push(shiftedWeapon);
  return stripped;
}

function packSlices(): { png: PngType; sprites: Record<string, CostumePiece>; variantKeys: string[] } {
  let cursorX = PADDING;
  let maxHeight = 0;
  for (const slice of WEAPON_SLICES) {
    cursorX += slice.rows[0]!.length + PADDING;
    maxHeight = Math.max(maxHeight, slice.rows.length);
  }
  const png = new PNG({ width: cursorX, height: maxHeight + PADDING * 2 });
  png.data.fill(0);
  const sprites: Record<string, CostumePiece> = {};
  const variantKeys: string[] = [];
  let xOffset = PADDING;
  for (const slice of WEAPON_SLICES) {
    const width = slice.rows[0]!.length;
    const height = slice.rows.length;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const rgba = WEAPON_PALETTE[slice.rows[y]![x]!];
        if (!rgba) throw new Error(\`未知色板字符 '\${slice.rows[y]![x]}'：\${slice.id}\`);
        const dst = ((PADDING + y) * png.width + (xOffset + x)) * 4;
        png.data[dst] = rgba[0]; png.data[dst + 1] = rgba[1]; png.data[dst + 2] = rgba[2]; png.data[dst + 3] = rgba[3];
      }
    }
    sprites[slice.id] = { texture: TEXTURE_KEY, x: xOffset, y: PADDING, width, height, anchorX: slice.anchorX, anchorY: slice.anchorY };
    variantKeys.push(slice.id);
    xOffset += width + PADDING;
  }
  return { png, sprites, variantKeys };
}

function packEffects() {
  const items: { grid: EffectFrameGrid; palette: RgbaPalette; width: number; height: number }[] = [];
  const byFile: Record<string, string[]> = {};
  for (const src of WEAPON_EFFECT_SOURCES) {
    for (const [suffix, frames, palette] of [['base', src.baseFrames, src.basePalette], ['add', src.addFrames, src.addPalette]] as const) {
      const file = \`prototype/\${src.effectId}/\${src.direction}-\${suffix}.png\`;
      byFile[file] = frames.map(f => f.id);
      for (const grid of frames) items.push({ grid, palette, width: src.frameWidth, height: src.frameHeight });
    }
  }
  items.sort((a, b) => b.height - a.height || b.width - a.width);
  const placed: Array<(typeof items)[number] & { x: number; y: number }> = [];
  let cursorX = PADDING, cursorY = PADDING, shelfHeight = 0, sheetWidth = PADDING;
  for (const item of items) {
    if (cursorX > PADDING && cursorX + item.width + PADDING > MAX_EFFECT_SHEET_WIDTH) {
      cursorY += shelfHeight + PADDING; cursorX = PADDING; shelfHeight = 0;
    }
    placed.push({ ...item, x: cursorX, y: cursorY });
    cursorX += item.width + PADDING;
    sheetWidth = Math.max(sheetWidth, cursorX);
    shelfHeight = Math.max(shelfHeight, item.height);
  }
  const png = new PNG({ width: sheetWidth, height: cursorY + shelfHeight + PADDING });
  png.data.fill(0);
  const frames: Record<string, { x: number; y: number; width: number; height: number }> = {};
  for (const item of placed) {
    for (let y = 0; y < item.height; y++) {
      for (let x = 0; x < item.width; x++) {
        const rgba = item.palette[item.grid.rows[y]![x]!];
        if (!rgba) throw new Error(\`未知特效色板字符：\${item.grid.id}\`);
        const dst = ((item.y + y) * png.width + (item.x + x)) * 4;
        png.data[dst] = rgba[0]; png.data[dst + 1] = rgba[1]; png.data[dst + 2] = rgba[2]; png.data[dst + 3] = rgba[3];
      }
    }
    frames[item.grid.id] = { x: item.x, y: item.y, width: item.width, height: item.height };
  }
  const attackEffects: Record<string, { clips: Record<string, unknown> }> = {};
  for (const src of WEAPON_EFFECT_SOURCES) {
    const entry = attackEffects[src.effectId] ?? (attackEffects[src.effectId] = { clips: {} });
    const clip = {
      version: 1, frameWidth: src.frameWidth, frameHeight: src.frameHeight, frames: src.baseFrames.length,
      originX: src.originX, originY: src.originY, frameRate: EFFECT_FPS, mirrorX: false,
      layers: [
        { key: \`\${src.effectId}-\${src.direction}-base\`, file: \`prototype/\${src.effectId}/\${src.direction}-base.png\`, blend: 'normal', operations: ['normal'] },
        { key: \`\${src.effectId}-\${src.direction}-add\`, file: \`prototype/\${src.effectId}/\${src.direction}-add.png\`, blend: 'add', operations: ['add'] },
      ],
    };
    entry.clips[src.direction] = clip;
    if (src.direction === 'west') {
      entry.clips.east = { ...clip, mirrorX: true, layers: clip.layers.map(l => ({ ...l, key: l.key.replace('-west-', '-east-') })) };
    }
  }
  return { png, effectSheet: { texture: { key: EFFECT_TEXTURE_KEY, file: EFFECT_TEXTURE_URL }, frames, byFile }, attackEffects };
}

function buildCycle(wardrobePoses: Record<string, CostumePose>, recipe: WeaponCycleRecipe): CostumePose {
  const base = wardrobePoses[recipe.basePoseId];
  if (!base) throw new Error(\`基础姿态不存在：\${recipe.basePoseId}\`);
  const findRef = (frame: CostumePart[]) => {
    if (recipe.insertMode === 'single-hand-west') return frame.find(p => p.part === 'coat-front' && !isCoatFrontArm(p));
    if (recipe.insertMode === 'before-right-arm-south') return frame.find(p => p.part === 'coat-front' && (p.piece === 9 || p.piece === 5) && p.scaleX === -1);
    if (recipe.insertMode === 'before-right-arm-north') return frame.find(p => p.part === 'coat-front' && (p.piece === 9 || p.piece === 5) && p.scaleX === 1);
    return frame.find(p => p.part === 'head-front');
  };
  const firstRef = findRef(base.frames[0]!);
  const ox = firstRef?.x ?? 0, oy = firstRef?.y ?? 0;
  return {
    mirrorX: recipe.mirrorX,
    frameRate: base.frameRate,
    frames: base.frames.map((frame, i) => {
      const ref = findRef(frame);
      const weaponPart: CostumePart = {
        part: '${weapon}', piece: recipe.piece,
        x: recipe.baseX + (ref?.x ?? ox) - ox + (recipe.stepDx?.[i] ?? 0),
        y: recipe.baseY + (ref?.y ?? oy) - oy,
        scaleX: recipe.scaleX, scaleY: 1, angle: 0, alpha: 1,
      };
      return insertWeaponIntoFrame(frame, weaponPart, recipe.insertMode);
    }),
  };
}

function buildAction(wardrobePoses: Record<string, CostumePose>, recipe: WeaponActionRecipe): CostumePose {
  return {
    mirrorX: recipe.mirrorX,
    frameRate: recipe.frameRate,
    frames: recipe.frames.map((spec, idx) => {
      const base = wardrobePoses[spec.sourcePoseId]?.frames[spec.sourceFrame];
      if (!base) throw new Error(\`基础帧不存在：\${spec.sourcePoseId}[\${spec.sourceFrame}] (\${recipe.id} F\${idx})\`);
      const weaponPart: CostumePart = {
        part: '${weapon}', piece: spec.piece, x: spec.x, y: spec.y,
        scaleX: spec.scaleX ?? 1, scaleY: 1, angle: spec.angle ?? 0, alpha: spec.alpha ?? 1,
      };
      return insertWeaponIntoFrame(base, weaponPart, spec.insertMode, spec.bodyDx ?? 0, spec.bodyDy ?? 0, spec.armsPreset, spec.mirrorBaseFrame ?? false, spec.legsPreset, spec.headPose);
    }),
  };
}

function run(): void {
  const wardrobe = JSON.parse(fs.readFileSync(wardrobePath, 'utf8')) as { poses: Record<string, CostumePose> };
  const { png, sprites, variantKeys } = packSlices();
  const { png: effectPng, effectSheet, attackEffects } = packEffects();
  fs.writeFileSync(pngOutPath, PNG.sync.write(png));
  fs.writeFileSync(effectsPngOutPath, PNG.sync.write(effectPng));

  const poses: Record<string, CostumePose> = {};
  const stancePoses: Record<string, string> = {};
  for (const recipe of WEAPON_CYCLE_RECIPES) {
    poses[recipe.id] = buildCycle(wardrobe.poses, recipe);
    stancePoses[recipe.clip] = recipe.id;
  }
  for (const recipe of WEAPON_ACTION_RECIPES) {
    poses[recipe.id] = buildAction(wardrobe.poses, recipe);
    stancePoses[recipe.clip] = recipe.id;
  }

  const bundle = {
    weaponId: 'prototype-${weapon}-basic',
    weaponName: '${name}（样板）',
    weaponKind: '${weapon}',
    partName: '${weapon}',
    variantId: '${weapon}-style-1',
    texture: { key: TEXTURE_KEY, file: TEXTURE_URL },
    sprites,
    variants: { '${weapon}-style-1': variantKeys },
    stancePoses,
    actionLabels: {
      idle: '持械待机',
      walk: '持械行走',
      'town-idle': '脱战待机（背负）',
      'town-walk': '脱战行走（背负）',
      attack: '普攻第一段',
    },
    actionTimelines: {
      attack: {
        cycleFrames: 7,
        cues: [{ effect: '${weapon}-basic-strike', startFrame: 2, variant: 'facing', placement: 'above-characters', source: '素银普攻光' }],
        markers: [
          { frame: 2, kind: 'swing', label: '出击光（${weapon}-basic-strike）' },
          { frame: 3, kind: 'strike', label: '普攻命中' },
        ],
        sounds: ['Weapon_Sword_Attack'],
      },
    },
    effectSheet,
    attackEffects,
    poses,
  };

  fs.writeFileSync(jsonOutPath, JSON.stringify(bundle));
  console.log(\`已导出 ${name} 样板：\${WEAPON_SLICES.length} 切片 (\${png.width}x\${png.height})，\${Object.keys(effectSheet.frames).length} 特效帧 (\${effectPng.width}x\${effectPng.height})，\${Object.keys(poses).length} 姿态\`);
}

run();
`;
}

function main(): void {
  const { weapon, name, outDir, dryRun, force } = parseArgs(process.argv.slice(2));
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = findRepoRoot(scriptDir);
  const targetDir = outDir ?? path.join(repoRoot, 'tools/warrior-viewer/prototypes', weapon);

  const files: readonly [string, string][] = [
    ['source.ts', makeSourceTs(weapon, name)],
    ['effects-source.ts', makeEffectsSourceTs(weapon, name)],
    ['export.ts', makeExportTs(weapon, name)],
  ];

  if (!force) {
    for (const [fileName] of files) {
      const abs = path.join(targetDir, fileName);
      if (fs.existsSync(abs)) {
        throw new Error(`目标文件已存在：${abs}（如需覆盖请追加 --force）`);
      }
    }
  }

  if (dryRun) {
    console.log(`[dry-run] 将在 ${targetDir} 创建：`);
    for (const [fileName, content] of files) {
      console.log(`  - ${fileName} (${content.length} bytes)`);
    }
    return;
  }

  fs.mkdirSync(targetDir, { recursive: true });
  for (const [fileName, content] of files) {
    fs.writeFileSync(path.join(targetDir, fileName), content);
  }

  const fmtPath = (abs: string): string => {
    const rel = path.relative(repoRoot, abs);
    return rel.startsWith('..') ? abs : rel;
  };
  console.log(`已初始化 ${name}（${weapon}）动画样板目录：${targetDir}`);
  console.log('\n下一步：');
  console.log(`  1. 导出样板：node ${fmtPath(path.join(targetDir, 'export.ts'))}`);
  console.log(`  2. 像素体检：node .agents/skills/character-animation-craft/scripts/inspect-animation-quality.ts --prototype ${fmtPath(path.join(targetDir, `${weapon}-prototype.json`))}`);
  console.log(`  3. 工作台预览：在 tools/warrior-viewer/main.ts 读取 ./prototypes/${weapon}/${weapon}-prototype.json 后访问 ?weapon=prototype-${weapon}-basic`);
}

main();

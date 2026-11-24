import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import type { BattleCatalog } from '../../../../src/domain/battle.ts';
import type { EffectClip } from '../../../../src/domain/content.ts';
import type { CostumePart, CostumePiece, CostumePose, WardrobeCatalog } from '../../../../src/domain/wardrobe.ts';
import { BEAM_ADD_PALETTE, BEAM_BASE_PALETTE, SPEAR_THRUST_BEAM_SOURCES } from './effects-source.ts';
import type { EffectFrameGrid } from './effects-source.ts';
import { SPEAR_ACTION_RECIPES, SPEAR_CYCLE_RECIPES, SPEAR_PALETTE, SPEAR_SLICES } from './source.ts';
import type { SpearInsertMode, SpearKeyframedPoseRecipe, SpearPoseRecipe } from './source.ts';

const dir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(dir, '../../../..');
const wardrobePath = path.join(repoRoot, 'public/content/wardrobe.json');
const pngOutPath = path.join(dir, 'spear-parts.png');
const effectsPngOutPath = path.join(dir, 'spear-effects.png');
const jsonOutPath = path.join(dir, 'spear-prototype.json');

const TEXTURE_KEY = 'prototype-spear-parts';
const TEXTURE_URL = 'tools/warrior-viewer/prototypes/spear/spear-parts.png';
const EFFECT_TEXTURE_KEY = 'prototype-spear-effects';
const EFFECT_TEXTURE_URL = 'tools/warrior-viewer/prototypes/spear/spear-effects.png';
const PADDING = 2;
const EFFECT_FPS = 50 / 3;

const REMOVED_WEAPON_PARTS = new Set(['two-handed', 'staff', 'orb', 'main-blade', 'off-blade', 'main-dagger', 'off-dagger', 'shield', 'bow', 'crossbow']);

function packSlices(): { png: PNG; sprites: Record<string, CostumePiece>; variantKeys: string[] } {
  let cursorX = PADDING;
  let maxHeight = 0;
  for (const slice of SPEAR_SLICES) {
    const w = slice.rows[0].length;
    const h = slice.rows.length;
    cursorX += w + PADDING;
    maxHeight = Math.max(maxHeight, h);
  }
  const sheetWidth = cursorX;
  const sheetHeight = maxHeight + PADDING * 2;
  const png = new PNG({ width: sheetWidth, height: sheetHeight });
  png.data.fill(0);

  const sprites: Record<string, CostumePiece> = {};
  const variantKeys: string[] = [];
  let xOffset = PADDING;

  for (const slice of SPEAR_SLICES) {
    const width = slice.rows[0].length;
    const height = slice.rows.length;
    for (let y = 0; y < height; y++) {
      const row = slice.rows[y];
      if (row.length !== width) throw new Error(`切片行宽不一致：${slice.id} 第 ${y} 行`);
      for (let x = 0; x < width; x++) {
        const ch = row[x];
        const rgba = SPEAR_PALETTE[ch];
        if (!rgba) throw new Error(`未知色板字符 '${ch}'：${slice.id} (${x}, ${y})`);
        const dst = ((PADDING + y) * sheetWidth + (xOffset + x)) * 4;
        png.data[dst] = rgba[0];
        png.data[dst + 1] = rgba[1];
        png.data[dst + 2] = rgba[2];
        png.data[dst + 3] = rgba[3];
      }
    }
    sprites[slice.id] = {
      texture: TEXTURE_KEY,
      x: xOffset,
      y: PADDING,
      width,
      height,
      anchorX: slice.anchorX,
      anchorY: slice.anchorY,
    };
    variantKeys.push(slice.id);
    xOffset += width + PADDING;
  }

  return { png, sprites, variantKeys };
}

function packEffects(): {
  png: PNG;
  effectSheet: {
    texture: { key: string; file: string };
    frames: Record<string, { x: number; y: number; width: number; height: number }>;
    byFile: Record<string, string[]>;
  };
  attackEffects: BattleCatalog['attackEffects'];
} {
  // 按行排布：每个方向的两层（base / add）各自占一行（每行 6 帧）
  const strips: {
    file: string;
    palette: Readonly<Record<string, readonly [number, number, number, number]>>;
    frames: readonly EffectFrameGrid[];
    width: number;
    height: number;
  }[] = [];

  for (const src of SPEAR_THRUST_BEAM_SOURCES) {
    strips.push({
      file: `prototype/spear-thrust-beam/${src.direction}-base.png`,
      palette: BEAM_BASE_PALETTE,
      frames: src.baseFrames,
      width: src.frameWidth,
      height: src.frameHeight,
    });
    strips.push({
      file: `prototype/spear-thrust-beam/${src.direction}-add.png`,
      palette: BEAM_ADD_PALETTE,
      frames: src.addFrames,
      width: src.frameWidth,
      height: src.frameHeight,
    });
  }

  let sheetWidth = PADDING;
  let sheetHeight = PADDING;
  for (const strip of strips) {
    const rowWidth = PADDING + strip.frames.length * (strip.width + PADDING);
    sheetWidth = Math.max(sheetWidth, rowWidth);
    sheetHeight += strip.height + PADDING;
  }

  const png = new PNG({ width: sheetWidth, height: sheetHeight });
  png.data.fill(0);

  const frames: Record<string, { x: number; y: number; width: number; height: number }> = {};
  const byFile: Record<string, string[]> = {};
  let cursorY = PADDING;

  for (const strip of strips) {
    let cursorX = PADDING;
    const frameKeys: string[] = [];
    for (const grid of strip.frames) {
      if (grid.rows.length !== strip.height) throw new Error(`特效帧高度不一致：${grid.id}`);
      for (let y = 0; y < strip.height; y++) {
        const row = grid.rows[y];
        if (row.length !== strip.width) throw new Error(`特效帧宽度不一致：${grid.id} 第 ${y} 行`);
        for (let x = 0; x < strip.width; x++) {
          const ch = row[x];
          const rgba = strip.palette[ch];
          if (!rgba) throw new Error(`未知特效色板字符 '${ch}'：${grid.id} (${x}, ${y})`);
          const dst = ((cursorY + y) * sheetWidth + (cursorX + x)) * 4;
          png.data[dst] = rgba[0];
          png.data[dst + 1] = rgba[1];
          png.data[dst + 2] = rgba[2];
          png.data[dst + 3] = rgba[3];
        }
      }
      frames[grid.id] = { x: cursorX, y: cursorY, width: strip.width, height: strip.height };
      frameKeys.push(grid.id);
      cursorX += strip.width + PADDING;
    }
    byFile[strip.file] = frameKeys;
    cursorY += strip.height + PADDING;
  }

  const clips: Record<string, EffectClip> = {};
  for (const src of SPEAR_THRUST_BEAM_SOURCES) {
    const clip: EffectClip = {
      version: 1,
      frameWidth: src.frameWidth,
      frameHeight: src.frameHeight,
      frames: src.baseFrames.length,
      originX: src.originX,
      originY: src.originY,
      frameRate: EFFECT_FPS,
      mirrorX: false,
      layers: [
        {
          key: `spear-thrust-beam-${src.direction}-base`,
          file: `prototype/spear-thrust-beam/${src.direction}-base.png`,
          blend: 'normal',
          operations: ['normal'],
        },
        {
          key: `spear-thrust-beam-${src.direction}-add`,
          file: `prototype/spear-thrust-beam/${src.direction}-add.png`,
          blend: 'add',
          operations: ['add'],
        },
      ],
    };
    clips[src.direction] = clip;
    if (src.direction === 'west') {
      clips.east = {
        ...clip,
        mirrorX: true,
        layers: clip.layers.map(layer => ({ ...layer, key: layer.key.replace('-west-', '-east-') })),
      };
    }
  }

  return {
    png,
    effectSheet: {
      texture: { key: EFFECT_TEXTURE_KEY, file: EFFECT_TEXTURE_URL },
      frames,
      byFile,
    },
    attackEffects: {
      'spear-thrust-beam': { clips },
    },
  };
}

function insertSpearIntoFrame(frame: CostumePart[], spearPart: CostumePart, insertMode: SpearInsertMode): CostumePart[] {
  if (insertMode === 'replace-staff') {
    const next: CostumePart[] = [];
    let inserted = false;
    for (const part of frame) {
      if (part.part === 'staff') {
        next.push(spearPart);
        inserted = true;
      } else if (!REMOVED_WEAPON_PARTS.has(part.part)) {
        next.push({ ...part });
      }
    }
    if (!inserted) next.push(spearPart);
    return next;
  }

  const stripped = frame.filter(part => !REMOVED_WEAPON_PARTS.has(part.part)).map(part => ({ ...part }));
  if (insertMode === 'back') return [spearPart, ...stripped];
  if (insertMode === 'between-west-arms') {
    const idx = stripped.findIndex(part => part.part === 'coat-front' && part.piece === 8);
    if (idx >= 0) { stripped.splice(idx, 0, spearPart); return stripped; }
  }
  if (insertMode === 'between-south-arms') {
    const idx = stripped.findIndex(part => part.part === 'coat-front' && part.piece === 10);
    if (idx >= 0) { stripped.splice(idx, 0, spearPart); return stripped; }
  }
  if (insertMode === 'between-south-walk-arms') {
    const idx = stripped.findIndex(part => part.part === 'coat-front' && part.piece === 13);
    if (idx >= 0) { stripped.splice(idx, 0, spearPart); return stripped; }
  }
  if (insertMode === 'before-front-hand') {
    // 西向直刺弓步中，coat-front[13]（f2）或 coat-front[10]（f3）是伸向前方的扶枪手
    const idx = stripped.findIndex(part => part.part === 'coat-front' && (part.piece === 13 || part.piece === 10));
    if (idx >= 0) { stripped.splice(idx, 0, spearPart); return stripped; }
  }
  stripped.push(spearPart);
  return stripped;
}

function buildCyclePose(wardrobe: WardrobeCatalog, recipe: SpearPoseRecipe): CostumePose {
  const basePose = wardrobe.poses[recipe.basePoseId];
  if (!basePose) throw new Error(`基础姿态不存在：${recipe.basePoseId}`);

  const firstRef = basePose.frames[0].find(p => p.part === 'two-handed' || p.part === 'staff')
    ?? basePose.frames[0].find(p => p.part === 'head-front');
  const originRefY = firstRef?.y ?? 0;
  const period = recipe.swayPeriod ?? 7;

  const frames: CostumePart[][] = basePose.frames.map((frame, frameIndex) => {
    const ref = frame.find(p => p.part === 'two-handed' || p.part === 'staff')
      ?? frame.find(p => p.part === 'head-front');
    const dy = (ref?.y ?? originRefY) - originRefY;
    const swayPhase = Math.floor(frameIndex / period) % 2;
    const dx = recipe.stepDx?.[frameIndex] ?? 0;
    const extraDy = recipe.stepDy?.[frameIndex] ?? 0;
    const spearPart: CostumePart = {
      part: 'spear',
      piece: swayPhase === 0 ? recipe.pieceEven : recipe.pieceOdd,
      x: recipe.baseX + dx,
      y: recipe.baseY + dy + extraDy,
      scaleX: recipe.scaleX,
      scaleY: recipe.scaleY,
      angle: recipe.angle,
      alpha: 1,
    };
    return insertSpearIntoFrame(frame, spearPart, recipe.insertMode);
  });

  return {
    mirrorX: recipe.mirrorX,
    frameRate: basePose.frameRate,
    frames,
  };
}

function buildKeyframedPose(wardrobe: WardrobeCatalog, recipe: SpearKeyframedPoseRecipe): CostumePose {
  const frames: CostumePart[][] = recipe.frames.map((spec, index) => {
    const basePose = wardrobe.poses[spec.sourcePoseId];
    if (!basePose) throw new Error(`基础姿态不存在：${spec.sourcePoseId}（${recipe.id} F${index}）`);
    const baseFrame = basePose.frames[spec.sourceFrame];
    if (!baseFrame) throw new Error(`基础帧不存在：${spec.sourcePoseId}[${spec.sourceFrame}]`);
    const spearPart: CostumePart = {
      part: 'spear',
      piece: spec.piece,
      x: spec.x,
      y: spec.y,
      scaleX: spec.scaleX ?? 1,
      scaleY: spec.scaleY ?? 1,
      angle: spec.angle ?? 0,
      alpha: 1,
    };
    return insertSpearIntoFrame(baseFrame, spearPart, spec.insertMode);
  });

  return {
    mirrorX: recipe.mirrorX,
    frameRate: recipe.frameRate,
    frames,
  };
}

function run(): void {
  const wardrobe = JSON.parse(fs.readFileSync(wardrobePath, 'utf8')) as WardrobeCatalog;
  const { png, sprites, variantKeys } = packSlices();
  const { png: effectPng, effectSheet, attackEffects } = packEffects();
  fs.writeFileSync(pngOutPath, PNG.sync.write(png));
  fs.writeFileSync(effectsPngOutPath, PNG.sync.write(effectPng));

  const poses: Record<string, CostumePose> = {};
  const stancePoses: Record<string, string> = {};

  // 按阅读习惯顺序注册动作：待机 → 行走 → 直刺 → 横扫 → 立枪待机
  const orderedCycles = [
    ...SPEAR_CYCLE_RECIPES.filter(r => r.clip.startsWith('idle-') || r.clip.startsWith('walk-')),
  ];
  const uprightCycles = SPEAR_CYCLE_RECIPES.filter(r => r.clip.startsWith('spear-upright-idle-'));

  for (const recipe of orderedCycles) {
    poses[recipe.id] = buildCyclePose(wardrobe, recipe);
    stancePoses[recipe.clip] = recipe.id;
  }
  for (const recipe of SPEAR_ACTION_RECIPES) {
    poses[recipe.id] = buildKeyframedPose(wardrobe, recipe);
    stancePoses[recipe.clip] = recipe.id;
  }
  for (const recipe of uprightCycles) {
    poses[recipe.id] = buildCyclePose(wardrobe, recipe);
    stancePoses[recipe.clip] = recipe.id;
  }

  const bundle = {
    weaponId: 'prototype-spear-basic',
    weaponName: '基础长枪（样板）',
    weaponKind: 'spear',
    partName: 'spear',
    variantId: 'spear-style-1',
    texture: { key: TEXTURE_KEY, file: TEXTURE_URL },
    sprites,
    variants: { 'spear-style-1': variantKeys },
    stancePoses,
    actionLabels: {
      idle: '持枪待机（双手战斗）',
      walk: '持枪行走',
      thrust: '直刺（含枪芒特效）',
      sweep: '横扫',
      'spear-upright-idle': '立枪待机（单手直立）',
    },
    actionTimelines: {
      thrust: {
        cycleFrames: 10,
        swingFrame: 3,
        strikeFrame: 4,
        swings: ['spear-thrust-beam'],
        swingPlacement: 'above-characters',
        swingLabel: '出枪芒',
        sound: 'Weapon_TwoHand_Sword_Attack',
      },
      sweep: {
        cycleFrames: 12,
        swingFrame: null,
        strikeFrame: 4,
        swings: [],
        sound: 'Weapon_TwoHand_Sword_Attack',
      },
    },
    effectSheet,
    attackEffects,
    poses,
  };

  fs.writeFileSync(jsonOutPath, JSON.stringify(bundle, null, 2) + '\n');
  console.log(`Exported ${SPEAR_SLICES.length} spear slices (${png.width}x${png.height}) -> ${path.relative(repoRoot, pngOutPath)}`);
  console.log(`Exported ${Object.keys(effectSheet.frames).length} spear effect frames (${effectPng.width}x${effectPng.height}) -> ${path.relative(repoRoot, effectsPngOutPath)}`);
  console.log(`Exported ${Object.keys(poses).length} spear poses -> ${path.relative(repoRoot, jsonOutPath)}`);
}

run();

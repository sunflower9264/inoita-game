import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import type { CostumePart, CostumePiece, CostumePose, WardrobeCatalog } from '../../../../src/domain/wardrobe.ts';
import { SPEAR_IDLE_RECIPES, SPEAR_PALETTE, SPEAR_SLICES } from './source.ts';
import type { SpearPoseRecipe } from './source.ts';

const dir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(dir, '../../../..');
const wardrobePath = path.join(repoRoot, 'public/content/wardrobe.json');
const pngOutPath = path.join(dir, 'spear-parts.png');
const jsonOutPath = path.join(dir, 'spear-prototype.json');

const TEXTURE_KEY = 'prototype-spear-parts';
const TEXTURE_URL = 'tools/warrior-viewer/prototypes/spear/spear-parts.png';
const PADDING = 2;

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

function buildPoseFromRecipe(wardrobe: WardrobeCatalog, recipe: SpearPoseRecipe): CostumePose {
  const basePose = wardrobe.poses[recipe.basePoseId];
  if (!basePose) throw new Error(`基础姿态不存在：${recipe.basePoseId}`);

  // 从基础动作的头部/武器呼吸轨迹提取逐帧垂直起伏（与双臂保持同一节奏）
  const firstRef = basePose.frames[0].find(p => p.part === 'two-handed' || p.part === 'staff')
    ?? basePose.frames[0].find(p => p.part === 'head-front');
  const originRefY = firstRef?.y ?? 0;

  const frames: CostumePart[][] = basePose.frames.map((frame, frameIndex) => {
    const ref = frame.find(p => p.part === 'two-handed' || p.part === 'staff')
      ?? frame.find(p => p.part === 'head-front');
    const dy = (ref?.y ?? originRefY) - originRefY;
    const swayPhase = Math.floor(frameIndex / 7) % 2;
    const spearPart: CostumePart = {
      part: 'spear',
      piece: swayPhase === 0 ? recipe.pieceEven : recipe.pieceOdd,
      x: recipe.baseX,
      y: recipe.baseY + dy,
      scaleX: recipe.scaleX,
      scaleY: recipe.scaleY,
      angle: recipe.angle,
      alpha: 1,
    };

    if (recipe.insertMode === 'replace-staff') {
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
    if (recipe.insertMode === 'back') {
      return [spearPart, ...stripped];
    }
    if (recipe.insertMode === 'between-west-arms') {
      // 在前臂（coat-front piece=8）之前插入长枪，让前手手套压在枪杆上层
      const frontArmIndex = stripped.findIndex(part => part.part === 'coat-front' && part.piece === 8);
      if (frontArmIndex >= 0) {
        stripped.splice(frontArmIndex, 0, spearPart);
        return stripped;
      }
    }
    if (recipe.insertMode === 'between-south-arms') {
      // 在南向前手（coat-front piece=10）之前插入长枪，让右手手套压在枪杆上层且不遮挡脸部
      const frontArmIndex = stripped.findIndex(part => part.part === 'coat-front' && part.piece === 10);
      if (frontArmIndex >= 0) {
        stripped.splice(frontArmIndex, 0, spearPart);
        return stripped;
      }
    }
    stripped.push(spearPart);
    return stripped;
  });

  return {
    mirrorX: recipe.mirrorX,
    frameRate: basePose.frameRate,
    frames,
  };
}

function run(): void {
  const wardrobe = JSON.parse(fs.readFileSync(wardrobePath, 'utf8')) as WardrobeCatalog;
  const { png, sprites, variantKeys } = packSlices();
  fs.writeFileSync(pngOutPath, PNG.sync.write(png));

  const poses: Record<string, CostumePose> = {};
  const stancePoses: Record<string, string> = {};
  for (const recipe of SPEAR_IDLE_RECIPES) {
    poses[recipe.id] = buildPoseFromRecipe(wardrobe, recipe);
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
      'spear-upright-idle': '立枪待机（单手直立）',
    },
    poses,
  };

  fs.writeFileSync(jsonOutPath, JSON.stringify(bundle, null, 2) + '\n');
  console.log(`Exported ${SPEAR_SLICES.length} spear slices (${png.width}x${png.height}) -> ${path.relative(repoRoot, pngOutPath)}`);
  console.log(`Exported ${Object.keys(poses).length} spear poses -> ${path.relative(repoRoot, jsonOutPath)}`);
}

run();

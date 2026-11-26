import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import type { BattleCatalog } from '../../../../src/domain/battle.ts';
import type { EffectClip } from '../../../../src/domain/content.ts';
import type { CostumePart, CostumePiece, CostumePose, WardrobeCatalog } from '../../../../src/domain/wardrobe.ts';
import { SPEAR_EFFECT_SOURCES } from './effects-source.ts';
import type { EffectFrameGrid, RgbaPalette } from './effects-source.ts';
import { SPEAR_ACTION_RECIPES, SPEAR_ARMS_PRESETS, SPEAR_CYCLE_RECIPES, SPEAR_PALETTE, SPEAR_SLICES, WEST_LEGS_PRESETS } from './source.ts';
import type { SpearArmsPreset, SpearHeadPose, SpearHeadView, SpearInsertMode, SpearKeyframedPoseRecipe, SpearLegsPreset, SpearPoseRecipe } from './source.ts';

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
  const strips: {
    file: string;
    palette: RgbaPalette;
    frames: readonly EffectFrameGrid[];
    width: number;
    height: number;
  }[] = [];

  for (const src of SPEAR_EFFECT_SOURCES) {
    strips.push({
      file: `prototype/${src.effectId}/${src.direction}-base.png`,
      palette: src.basePalette,
      frames: src.baseFrames,
      width: src.frameWidth,
      height: src.frameHeight,
    });
    strips.push({
      file: `prototype/${src.effectId}/${src.direction}-add.png`,
      palette: src.addPalette,
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

  const attackEffects: BattleCatalog['attackEffects'] = {};
  for (const src of SPEAR_EFFECT_SOURCES) {
    const entry = attackEffects[src.effectId] ?? (attackEffects[src.effectId] = { clips: {} });
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
          key: `${src.effectId}-${src.direction}-base`,
          file: `prototype/${src.effectId}/${src.direction}-base.png`,
          blend: 'normal',
          operations: ['normal'],
        },
        {
          key: `${src.effectId}-${src.direction}-add`,
          file: `prototype/${src.effectId}/${src.direction}-add.png`,
          blend: 'add',
          operations: ['add'],
        },
      ],
    };
    entry.clips[src.direction] = clip;
    if (src.direction === 'west') {
      entry.clips.east = {
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
    attackEffects,
  };
}

const HEAD_VIEW_PIECES: Record<SpearHeadView, { face: number; neck: number; head: number }> = {
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

function applyHeadPose(frame: CostumePart[], headPose?: SpearHeadPose): CostumePart[] {
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
      return {
        ...part,
        piece,
        x: part.x + dx,
        y: part.y + dy,
        scaleX: headPose.scaleX ?? part.scaleX,
      };
    }
    if (part.part === 'head-front' || part.part === 'head-back') {
      return {
        ...part,
        piece: viewPieces ? viewPieces.head : part.piece,
        x: part.x + dx,
        y: part.y + dy,
        scaleX: headPose.scaleX ?? part.scaleX,
      };
    }
    if (part.part === 'coat-front' && !isCoatFrontArm(part) && (torsoDx !== 0 || torsoDy !== 0)) {
      return {
        ...part,
        x: part.x + torsoDx,
        y: part.y + torsoDy,
      };
    }
    if (part.part === 'cloak' && (headPose.cloakPiece !== undefined || cloakDx !== 0 || cloakDy !== 0)) {
      return {
        ...part,
        piece: headPose.cloakPiece ?? part.piece,
        x: part.x + cloakDx,
        y: part.y + cloakDy,
      };
    }
    return part;
  });
}

function mirrorPartX(part: CostumePart): CostumePart {
  return {
    ...part,
    x: -part.x,
    scaleX: -part.scaleX,
    angle: part.angle ? -part.angle : 0,
  };
}

function insertSpearIntoFrame(
  frame: CostumePart[],
  spearPart: CostumePart,
  insertMode: SpearInsertMode,
  bodyDx = 0,
  bodyDy = 0,
  armsPreset?: SpearArmsPreset,
  mirrorBaseFrame = false,
  legsPreset?: SpearLegsPreset,
  headPose?: SpearHeadPose,
): CostumePart[] {
  const shift = (part: CostumePart): CostumePart => ({
    ...part,
    x: part.x + bodyDx,
    y: part.y + bodyDy,
  });
  const shiftedSpear: CostumePart = {
    ...spearPart,
    x: spearPart.x + bodyDx,
    y: spearPart.y + bodyDy,
  };
  const legsApplied = legsPreset
    ? frame.map(part => (part.part === 'coat-back'
      ? {
          part: 'coat-back',
          piece: WEST_LEGS_PRESETS[legsPreset].piece,
          x: WEST_LEGS_PRESETS[legsPreset].x,
          y: WEST_LEGS_PRESETS[legsPreset].y,
          scaleX: 1,
          scaleY: 1,
          angle: 0,
          alpha: 1,
        }
      : part))
    : frame;
  const poseApplied = applyHeadPose(legsApplied, headPose);

  if (armsPreset) {
    const preset = SPEAR_ARMS_PRESETS[armsPreset];
    const bodyOnly = poseApplied.filter(part => !REMOVED_WEAPON_PARTS.has(part.part) && !isCoatFrontArm(part));
    const torsoIdx = bodyOnly.findIndex(part => part.part === 'coat-front');
    if (torsoIdx < 0) {
      throw new Error(`armsPreset=${armsPreset} 需要基础帧包含胸甲 coat-front 躯干切片`);
    }
    const torso = bodyOnly[torsoIdx];
    const baseTorsoX = preset.baseTorsoX ?? -1;
    const torsoDx = torso.x - baseTorsoX;
    const torsoDy = torso.y;
    const buildArm = (arm: typeof preset.backArm): CostumePart => ({
      part: 'coat-front',
      piece: arm.piece,
      x: arm.x + torsoDx,
      y: arm.y + torsoDy,
      scaleX: arm.scaleX,
      scaleY: arm.scaleY,
      angle: 0,
      alpha: 1,
    });
    const beforeTorso = bodyOnly.slice(0, torsoIdx);
    const afterTorso = bodyOnly.slice(torsoIdx + 1);
    const transform = (part: CostumePart): CostumePart => shift(mirrorBaseFrame ? mirrorPartX(part) : part);
    const backList = beforeTorso.map(transform);
    const torsoOut = transform(torso);
    const afterList = afterTorso.map(transform);

    const armsWithLayer: { part: CostumePart; layer: 'behind-torso' | 'behind-spear' | 'front-of-spear' }[] = [
      { part: transform(buildArm(preset.backArm)), layer: preset.backArm.layer ?? 'behind-torso' },
      { part: transform(buildArm(preset.frontArm)), layer: preset.frontArm.layer ?? 'front-of-spear' },
    ];
    const behindTorsoArms = armsWithLayer.filter(a => a.layer === 'behind-torso').map(a => a.part);
    const behindSpearArms = armsWithLayer.filter(a => a.layer === 'behind-spear').map(a => a.part);
    const frontSpearArms = armsWithLayer.filter(a => a.layer === 'front-of-spear').map(a => a.part);

    if (insertMode === 'back') {
      // 北向攻击 / 南向过顶蓄势：长枪在身前（镜头背面），behind-spear 手臂覆于枪杆之上且位于躯干/披风之后
      return [...behindTorsoArms, shiftedSpear, ...behindSpearArms, ...backList, torsoOut, ...frontSpearArms, ...afterList];
    }
    if (insertMode === 'front') {
      // 南向前景挥扫 / 上挑：长枪与实握前手位于身体及头脸前方
      return [...backList, ...behindTorsoArms, torsoOut, ...behindSpearArms, ...afterList, shiftedSpear, ...frontSpearArms];
    }
    // 默认双手实握遮挡顺序（西/东向与南向腰胸高度招式）：头脸压在肩上，前手实握于枪杆前方
    return [...backList, ...behindTorsoArms, torsoOut, ...behindSpearArms, shiftedSpear, ...frontSpearArms, ...afterList];
  }

  const baseFrame = mirrorBaseFrame ? poseApplied.map(mirrorPartX) : poseApplied;

  if (insertMode === 'replace-staff') {
    const next: CostumePart[] = [];
    let inserted = false;
    for (const part of baseFrame) {
      if (part.part === 'staff') {
        next.push(shiftedSpear);
        inserted = true;
      } else if (!REMOVED_WEAPON_PARTS.has(part.part)) {
        next.push(shift(part));
      }
    }
    if (!inserted) next.push(shiftedSpear);
    return next;
  }

  const stripped = baseFrame.filter(part => !REMOVED_WEAPON_PARTS.has(part.part)).map(shift);
  if (insertMode === 'back') return [shiftedSpear, ...stripped];
  if (insertMode === 'between-west-arms') {
    const idx = stripped.findIndex(part => part.part === 'coat-front' && part.piece === 8);
    if (idx >= 0) { stripped.splice(idx, 0, shiftedSpear); return stripped; }
  }
  if (insertMode === 'between-south-arms') {
    const idx = stripped.findIndex(part => part.part === 'coat-front' && part.piece === 10);
    if (idx >= 0) { stripped.splice(idx, 0, shiftedSpear); return stripped; }
  }
  if (insertMode === 'between-south-walk-arms') {
    const idx = stripped.findIndex(part => part.part === 'coat-front' && part.piece === 13);
    if (idx >= 0) { stripped.splice(idx, 0, shiftedSpear); return stripped; }
  }
  if (insertMode === 'before-front-hand') {
    const idx = stripped.findIndex(part => part.part === 'coat-front' && (part.piece === 13 || part.piece === 10));
    if (idx >= 0) { stripped.splice(idx, 0, shiftedSpear); return stripped; }
  }
  if (insertMode === 'before-right-arm-south') {
    // 南向单手持枪：插入在胸甲 coat-front[0] 与握枪右臂（scaleX=-1）之前，使手后配重杆自然收在右肩后、右手握于木杆之上、手前长杆与枪头伸于右前
    const armIdx = stripped.findIndex(part => part.part === 'coat-front' && (part.piece === 9 || part.piece === 5) && part.scaleX === -1);
    const torsoIdx = stripped.findIndex(part => part.part === 'coat-front' && part.piece < 5);
    const candidates = [armIdx, torsoIdx].filter(i => i >= 0);
    if (candidates.length > 0) {
      stripped.splice(Math.min(...candidates), 0, shiftedSpear);
      return stripped;
    }
    return [shiftedSpear, ...stripped];
  }
  if (insertMode === 'before-right-arm-north') {
    // 北向单手持枪：左臂保持原版自然垂摆，右臂（scaleX=1）微曲执握 ~45% 黄金重心位，长枪插在右臂与披风之前（铁镦收在右脚外侧 x>=5 零漏枪把）
    const upgraded = stripped.map(part => (
      part.part === 'coat-front' && isCoatFrontArm(part) && part.scaleX === 1
        ? { ...part, piece: 7, x: 3, y: part.y - 2, scaleX: 1, scaleY: 1, angle: 0 }
        : part
    ));
    const armIdx = upgraded.findIndex(part => part.part === 'coat-front' && isCoatFrontArm(part) && part.scaleX === 1);
    const cloakIdx = upgraded.findIndex(part => part.part === 'cloak');
    const candidates = [armIdx, cloakIdx].filter(i => i >= 0);
    if (candidates.length > 0) {
      upgraded.splice(Math.min(...candidates), 0, shiftedSpear);
      return upgraded;
    }
    return [shiftedSpear, ...upgraded];
  }
  if (insertMode === 'single-hand-west') {
    // 西/东向单手持枪：近侧握枪手自然垂在肩正下方实握 ~48% 黄金重心位（左右 1:1 平衡），远侧空手在躯干后方自然呼吸/摆臂且绝不与枪杆穿模
    const bodyNoArms = stripped.filter(part => !(part.part === 'coat-front' && isCoatFrontArm(part)));
    const torsoIdx = bodyNoArms.findIndex(part => part.part === 'coat-front');
    const torso = bodyNoArms[torsoIdx];
    const isWalk = torso ? torso.x < 0 : false;
    const torsoDy = torso?.y ?? 0;
    // 从 shiftedSpear.x 反推迈步水平微摆（idle baseX=5 -> 0，walk F0..F3=0 / F4..F7=-1）
    const strideDx = isWalk ? (shiftedSpear.x - 5) : 0;
    const farEmptyArm: CostumePart = {
      part: 'coat-front',
      piece: 10,
      x: (isWalk ? (-4 - strideDx * 2) : -4),
      y: (isWalk ? 3 : 2) + torsoDy,
      scaleX: 1,
      scaleY: 1,
      angle: 0,
      alpha: 1,
    };
    const nearGripArm: CostumePart = {
      part: 'coat-front',
      piece: 6,
      x: -3 + strideDx,
      y: (isWalk ? 1 : 0) + torsoDy,
      scaleX: 1,
      scaleY: 1,
      angle: 0,
      alpha: 1,
    };
    if (torsoIdx >= 0) {
      return [
        ...bodyNoArms.slice(0, torsoIdx),
        farEmptyArm,
        bodyNoArms[torsoIdx],
        shiftedSpear,
        nearGripArm,
        ...bodyNoArms.slice(torsoIdx + 1),
      ];
    }
    return [farEmptyArm, shiftedSpear, nearGripArm, ...bodyNoArms];
  }
  if (insertMode === 'before-near-arm-west') {
    let idx = -1;
    for (let i = stripped.length - 1; i >= 0; i--) {
      const part = stripped[i];
      if (part.part === 'coat-front' && (part.piece === 6 || part.piece === 8)) { idx = i; break; }
    }
    if (idx >= 0) { stripped.splice(idx, 0, shiftedSpear); return stripped; }
  }
  if (insertMode === 'before-cloak') {
    const idx = stripped.findIndex(part => part.part === 'cloak');
    if (idx >= 0) { stripped.splice(idx, 0, shiftedSpear); return stripped; }
    return [shiftedSpear, ...stripped];
  }
  if (insertMode === 'on-back-north') {
    // 北向脱战背枪：压在背部盔甲与披风表面，但位于颈脸与头发/头盔之下，避免枪杆横切后脑勺头发
    const headIdx = stripped.findIndex(part => part.part === 'body' || part.part === 'head-front' || part.part === 'head-back');
    if (headIdx >= 0) { stripped.splice(headIdx, 0, shiftedSpear); return stripped; }
    stripped.push(shiftedSpear);
    return stripped;
  }
  stripped.push(shiftedSpear);
  return stripped;
}

function buildCyclePose(wardrobe: WardrobeCatalog, recipe: SpearPoseRecipe): CostumePose {
  const basePose = wardrobe.poses[recipe.basePoseId];
  if (!basePose) throw new Error(`基础姿态不存在：${recipe.basePoseId}`);

  const findTorso = (frame: CostumePart[]) => frame.find(p => p.part === 'coat-front' && !isCoatFrontArm(p));
  const findRef = (frame: CostumePart[]) => {
    if (recipe.armsPreset) {
      return findTorso(frame);
    }
    if (recipe.insertMode === 'before-right-arm-south') {
      return frame.find(p => p.part === 'coat-front' && (p.piece === 9 || p.piece === 5) && p.scaleX === -1);
    }
    if (recipe.insertMode === 'before-right-arm-north') {
      return frame.find(p => p.part === 'coat-front' && (p.piece === 9 || p.piece === 5) && p.scaleX === 1);
    }
    if (recipe.insertMode === 'single-hand-west') {
      return findTorso(frame);
    }
    if (recipe.insertMode === 'before-near-arm-west') {
      for (let i = frame.length - 1; i >= 0; i--) {
        const p = frame[i];
        if (p.part === 'coat-front' && (p.piece === 6 || p.piece === 8)) return p;
      }
    }
    return frame.find(p => p.part === 'two-handed' || p.part === 'staff' || p.part === 'main-blade')
      ?? frame.find(p => p.part === 'head-front');
  };
  const firstRef = findRef(basePose.frames[0]);
  const originRefX = firstRef?.x ?? 0;
  const originRefY = firstRef?.y ?? 0;
  const period = recipe.swayPeriod ?? 7;

  const frames: CostumePart[][] = basePose.frames.map((frame, frameIndex) => {
    const ref = findRef(frame);
    const extraTorsoDy = recipe.stepTorsoDy?.[frameIndex] ?? 0;
    const frameHeadPose: SpearHeadPose | undefined = (recipe.headPose || extraTorsoDy !== 0)
      ? {
          ...recipe.headPose,
          torsoDy: (recipe.headPose?.torsoDy ?? 0) + extraTorsoDy,
        }
      : undefined;
    const refDx = (ref?.x ?? originRefX) + (frameHeadPose?.torsoDx ?? 0) - originRefX;
    const dy = (ref?.y ?? originRefY) + (frameHeadPose?.torsoDy ?? 0) - originRefY;
    const swayPhase = Math.floor(frameIndex / period) % 2;
    const dx = (recipe.stepDx?.[frameIndex] ?? 0) + refDx;
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
    return insertSpearIntoFrame(
      frame,
      spearPart,
      recipe.insertMode,
      0,
      0,
      recipe.armsPreset,
      false,
      undefined,
      frameHeadPose,
    );
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
    const rawFrame = basePose.frames[spec.sourceFrame];
    if (!rawFrame) throw new Error(`基础帧不存在：${spec.sourcePoseId}[${spec.sourceFrame}]`);
    const spearPart: CostumePart = {
      part: 'spear',
      piece: spec.piece,
      x: spec.x,
      y: spec.y,
      scaleX: spec.scaleX ?? 1,
      scaleY: spec.scaleY ?? 1,
      angle: spec.angle ?? 0,
      alpha: spec.alpha ?? 1,
    };
    return insertSpearIntoFrame(
      rawFrame,
      spearPart,
      spec.insertMode,
      spec.bodyDx ?? 0,
      spec.bodyDy ?? 0,
      spec.armsPreset,
      spec.mirrorBaseFrame ?? false,
      spec.legsPreset,
      spec.headPose,
    );
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

  // 1. 基础动作（持枪待机 / 持枪行走 / 脱战斜背待机与行走 / 基础直刺与横扫原型 / 立枪对照）
  for (const recipe of SPEAR_CYCLE_RECIPES.filter(r =>
    r.clip.startsWith('idle-') || r.clip.startsWith('walk-')
    || r.clip.startsWith('town-idle-') || r.clip.startsWith('town-walk-'))) {
    poses[recipe.id] = buildCyclePose(wardrobe, recipe);
    stancePoses[recipe.clip] = recipe.id;
  }
  for (const recipe of SPEAR_ACTION_RECIPES) {
    poses[recipe.id] = buildKeyframedPose(wardrobe, recipe);
    stancePoses[recipe.clip] = recipe.id;
  }
  // 游龙步与疾风枪势共用同一套「立枪聚气」四向姿态（不重复冗余导出姿态 JSON）
  for (const facing of ['south', 'west', 'north', 'east'] as const) {
    const buffPoseId = `prototype-spear-buff-cast-${facing}`;
    stancePoses[`skill-dragon-step-${facing}`] = buffPoseId;
    stancePoses[`skill-gale-stance-${facing}`] = buffPoseId;
  }
  // 长枪阵亡：西/北向共用南向倒地，东向镜像（与原版 sharedPoses.die-* 口径一致）
  stancePoses['spear-die-west'] = 'prototype-spear-die-south';
  stancePoses['spear-die-north'] = 'prototype-spear-die-south';

  for (const recipe of SPEAR_CYCLE_RECIPES.filter(r => r.clip.startsWith('spear-upright-idle-'))) {
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
      idle: '持枪待机',
      walk: '持枪行走',
      'town-idle': '脱战待机（背枪）',
      'town-walk': '脱战行走（背枪）',
      thrust: '基础直刺',
      sweep: '基础横扫',
      'spear-upright-idle': '立枪待机',
      attack: '普攻 · 轻刺',
      'attack-2': '普攻 · 横扫',
      'attack-3': '普攻 · 上挑',
      'skill-dragon-pierce': '狂龙穿心破',
      'skill-whirl-sweep': '虬龙扫暴阵',
      'skill-spin-storm': '旋风枪舞',
      'skill-flurry-thrust': '连环点枪',
      'skill-dragon-slam': '伏龙震',
      'skill-sovereign-pierce': '万圣龙王破',
      'skill-focus-edge': '凝锋',
      'skill-dragon-step': '游龙步',
      'skill-gale-stance': '疾风枪势',
      'spear-die': '战斗阵亡',
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
        swingFrame: 3,
        strikeFrame: 4,
        swings: ['spear-basic-flick'],
        swingPlacement: 'above-characters',
        swingLabel: '出横扫光（spear-basic-flick）',
        sound: 'Weapon_TwoHand_Sword_Attack',
      },
      attack: {
        cycleFrames: 8,
        cues: [
          { effect: 'spear-basic-thrust', startFrame: 2, variant: 'facing', placement: 'above-characters', source: '素银轻刺' },
        ],
        markers: [
          { frame: 2, kind: 'swing', label: '出刺光（spear-basic-thrust）' },
          { frame: 3, kind: 'strike', label: '普攻第一段命中' },
        ],
        sounds: ['Weapon_Sword_Attack'],
      },
      'attack-2': {
        cycleFrames: 7,
        cues: [
          { effect: 'spear-basic-flick', startFrame: 2, variant: 'facing', placement: 'above-characters', source: '素银横扫' },
        ],
        markers: [
          { frame: 2, kind: 'swing', label: '出横扫光（spear-basic-flick）' },
          { frame: 3, kind: 'strike', label: '普攻第二段命中' },
        ],
        sounds: ['Weapon_Dagger_Attack'],
      },
      'attack-3': {
        cycleFrames: 8,
        cues: [
          { effect: 'spear-basic-lift', startFrame: 2, variant: 'facing', placement: 'above-characters', source: '素银上挑' },
        ],
        markers: [
          { frame: 2, kind: 'swing', label: '出挑光（spear-basic-lift）' },
          { frame: 3, kind: 'strike', label: '普攻第三段命中（无控制）' },
        ],
        sounds: ['Weapon_TwoHand_Sword_Attack'],
      },
      'skill-dragon-pierce': {
        cycleFrames: 12,
        cues: [
          { effect: 'spear-heavy-pierce', startFrame: 4, variant: 'facing', placement: 'above-characters', source: '赤金破甲重刺' },
          { effect: 'impact-burst', startFrame: 5, variant: 'default', placement: 'above-characters', onTarget: true, targetDistancePx: 42, source: '目标破甲爆花' },
        ],
        markers: [
          { frame: 4, kind: 'swing', label: '原地贯刺 + 出破甲芒' },
          { frame: 5, kind: 'strike', label: '穿心重刺命中' },
        ],
        shakeFrames: [5],
        sounds: ['Wa_Anger_Rush', 'Weapon_TwoHand_Sword_Critical'],
      },
      'skill-whirl-sweep': {
        cycleFrames: 16,
        cues: [
          { effect: 'spear-flower-spin', startFrame: 0, variant: 'facing', placement: 'above-characters', source: '真 3D 透视双侧枪花' },
          { effect: 'spear-gale-sweep', startFrame: 7, variant: 'facing', placement: 'above-characters', source: '180° 青白狂风枪芒' },
        ],
        markers: [
          { frame: 0, kind: 'swing', label: '双侧 3D 透视舞花' },
          { frame: 2, kind: 'strike', label: '枪花第一段命中（左右双侧）' },
          { frame: 4, kind: 'strike', label: '枪花第二段命中（左右互换）' },
          { frame: 7, kind: 'swing', label: '顺势抽把 · 180° 狂风大扫' },
          { frame: 8, kind: 'strike', label: '半圈大扫终结 + 推退硬直' },
        ],
        shakeFrames: [8],
        sounds: ['Wa_Wheel_Wind', 'Weapon_Dagger_Attack', 'Weapon_TwoHand_Sword_Attack'],
      },
      'skill-spin-storm': {
        cycleFrames: 18,
        cues: [
          { effect: 'curse-wind-ring', startFrame: 2, variant: 'default', placement: 'ground', source: '脚底起旋风环' },
          { effect: 'curse-wind-ring', startFrame: 8, variant: 'default', placement: 'ground', source: '脚底续旋风环' },
          { effect: 'spear-spin-storm', startFrame: 2, variant: 'facing', placement: 'above-characters', source: '360° 红缨旋风枪环' },
        ],
        markers: [
          { frame: 2, kind: 'swing', label: '起旋出风环（spear-spin-storm）' },
          { frame: 3, kind: 'strike', label: '第 1 圈周身斩击' },
          { frame: 7, kind: 'strike', label: '第 2 圈周身斩击' },
          { frame: 11, kind: 'strike', label: '第 3 圈周身斩击' },
          { frame: 14, kind: 'strike', label: '末圈气浪爆散终结' },
        ],
        shakeFrames: [3, 7, 11, 14],
        sounds: ['Wa_Wheel_Wind', 'Wa_Storm'],
      },
      'skill-flurry-thrust': {
        cycleFrames: 17,
        cues: [
          { effect: 'spear-flurry-needles', startFrame: 1, variant: 'facing', placement: 'above-characters', source: '暴雨梨花扇形针芒' },
          { effect: 'spear-flurry-finisher', startFrame: 11, variant: 'facing', placement: 'above-characters', source: '定音主刺芒 + 十字闪' },
          { effect: 'impact-burst', startFrame: 12, variant: 'default', placement: 'above-characters', onTarget: true, targetDistancePx: 53, source: '第三刺定音爆闪' },
        ],
        markers: [
          { frame: 2, kind: 'strike', label: '第一段乱刺（30%）' },
          { frame: 6, kind: 'strike', label: '第二段乱刺（30%）' },
          { frame: 9, kind: 'charge', label: '缩枪凝势' },
          { frame: 11, kind: 'swing', label: '定音主刺爆发' },
          { frame: 12, kind: 'strike', label: '第三段定音命中（40%）' },
        ],
        shakeFrames: [12],
        sounds: ['Weapon_Dagger_Attack', 'Weapon_Sword_Critical'],
      },
      'skill-dragon-slam': {
        cycleFrames: 11,
        cues: [
          { effect: 'spear-slam-arc', startFrame: 3, variant: 'facing', placement: 'above-characters', source: '暗金纵劈 + 地面震波' },
          { effect: 'impact-cross', startFrame: 4, variant: 'default', placement: 'above-characters', onTarget: true, targetDistancePx: 36, source: '钝击爆闪' },
          { effect: 'state-stun', startFrame: 4, variant: 'default', placement: 'above-characters', onTarget: true, targetDistancePx: 36, source: '目标眩晕 0.8s' },
        ],
        markers: [
          { frame: 1, kind: 'effect', label: '双手过顶高举' },
          { frame: 3, kind: 'swing', label: '力劈华山下砸' },
          { frame: 4, kind: 'strike', label: '砸地命中 + 眩晕' },
        ],
        shakeFrames: [4],
        sounds: ['Wa_Titan_Attack', 'Wa_Boom'],
      },
      'skill-sovereign-pierce': {
        cycleFrames: 28,
        cues: [
          { effect: 'spear-sovereign-dome-back', startFrame: 0, variant: 'default', placement: 'ground', source: '扣地半球后侧螺旋气流与柔光底沿' },
          { effect: 'spear-sovereign-dome', startFrame: 0, variant: 'default', placement: 'above-characters', source: '扣地薄边柔光半球 + 持续螺旋气流（结束原地渐隐）' },
          { effect: 'spear-sovereign-charge', startFrame: 12, variant: 'default', placement: 'above-characters', source: '提枪蓄势十字星芒' },
          { effect: 'curse-wind-ring', startFrame: 16, variant: 'default', placement: 'ground', source: '顿枪镇地十字震波环' },
          { effect: 'spear-sovereign-beam', startFrame: 16, variant: 'north', placement: 'ground', source: '北向蓝金螺旋破空冲击波' },
          { effect: 'spear-sovereign-beam', startFrame: 16, variant: 'west', placement: 'above-characters', source: '西向蓝金螺旋破空冲击波' },
          { effect: 'spear-sovereign-beam', startFrame: 16, variant: 'east', placement: 'above-characters', source: '东向蓝金螺旋破空冲击波' },
          { effect: 'spear-sovereign-beam', startFrame: 16, variant: 'south', placement: 'above-characters', source: '南向蓝金螺旋破空冲击波' },
        ],
        markers: [
          { frame: 0, kind: 'effect', label: '立枪撑罩 · 扣地半球能量罩展开' },
          { frame: 3, kind: 'strike', label: '能量罩触碰伤害 · 第 1 段脉冲' },
          { frame: 6, kind: 'strike', label: '能量罩触碰伤害 · 第 2 段脉冲' },
          { frame: 9, kind: 'strike', label: '能量罩触碰伤害 · 第 3 段脉冲' },
          { frame: 12, kind: 'charge', label: '能量罩消散 · 提枪蓄势闪光' },
          { frame: 16, kind: 'swing', label: '顿枪镇地 · 四向冲击波齐发' },
          { frame: 18, kind: 'strike', label: '东/西/南/北四向破防冲击波重创' },
        ],
        shakeFrames: [3, 6, 9, 16, 17, 18, 19],
        sounds: ['Wa_Defense', 'Wa_Wheel_Wind', 'Wa_Storm', 'Wa_Titan_Attack'],
      },
      'skill-focus-edge': {
        cycleFrames: 12,
        cues: [
          { effect: 'starburst-gold', startFrame: 2, variant: 'default', placement: 'above-characters', source: '凝锋金芒聚能' },
          { effect: 'flash-gold', startFrame: 3, variant: 'default', placement: 'above-characters', source: '枪锋增伤闪光' },
        ],
        markers: [
          { frame: 2, kind: 'buff', label: '凝锋生效（6 秒内强化穿心）' },
        ],
        appearanceColors: [
          { red: 255, green: 232, blue: 168 },
          { red: 255, green: 214, blue: 122 },
          { red: 255, green: 236, blue: 184 },
          { red: 255, green: 250, blue: 232 },
        ],
        sounds: ['Wa_Defense'],
      },
      'skill-dragon-step': {
        cycleFrames: 12,
        cues: [
          { effect: 'curse-wind-ring', startFrame: 2, variant: 'default', placement: 'ground', source: '游龙疾风足环' },
          { effect: 'curse-wind-ring', startFrame: 6, variant: 'default', placement: 'ground', source: '步法余风' },
        ],
        markers: [
          { frame: 2, kind: 'buff', label: '游龙步生效（4 秒移速提升）' },
        ],
        appearanceColors: [
          { red: 176, green: 242, blue: 255 },
          { red: 138, green: 224, blue: 255 },
          { red: 196, green: 248, blue: 255 },
          { red: 236, green: 252, blue: 255 },
        ],
        sounds: ['Wa_Wheel_Wind'],
      },
      'skill-gale-stance': {
        cycleFrames: 12,
        cues: [
          { effect: 'aura-ring', startFrame: 2, variant: 'default', placement: 'ground', source: '疾风枪势光环' },
          { effect: 'curse-wind-ring', startFrame: 4, variant: 'default', placement: 'above-characters', source: '高速风气环绕' },
        ],
        markers: [
          { frame: 2, kind: 'buff', label: '疾风枪势生效（6 秒攻速提升）' },
        ],
        appearanceColors: [
          { red: 198, green: 236, blue: 255 },
          { red: 164, green: 220, blue: 255 },
          { red: 218, green: 244, blue: 255 },
          { red: 242, green: 250, blue: 255 },
        ],
        sounds: ['Wa_Storm'],
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

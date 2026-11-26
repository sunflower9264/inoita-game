/**
 * 将角色查看器定稿的长枪样板（`tools/warrior-viewer/prototypes/spear/`）构建为正式游戏资源与内容配置：
 *
 * 1. 生成换装部件图集页 `asset-source/assets/wardrobe/parts-2.png` 与 `public/assets/wardrobe/parts-2.png`
 *    （含 `spear-style-1` 红缨铁枪、`spear-style-2` 龙牙长枪两套 30 切片样式，页宽 <= 1024）；
 * 2. 生成 14 套战斗特效源网格图至 `asset-source/assets/battle-effects/spear/<id>/<dir>-base|add.png`；
 * 3. 生成武器图标、15 枚技能图标、选职徽章、状态栏增益小图标、队伍/状态立绘与地面掉落贴图至 `asset-source/assets/`；
 * 4. 离线合成 `story-preview-lancer` 与 `battle-lancer` 角色长条图至 `asset-source/assets/characters/`；
 * 5. 幂等更新 `public/content/` 下的 `wardrobe.json`、`battle.json`、`items.json`、`character-stats.json`、
 *    `story-classes.json`、`menu-panels.json`、`status-hud.json`、`companions.json`、`audio.json`。
 *
 * 运行本脚本后接着执行 `npm run atlas:all`，即可把全部新增图标、UI、特效与角色帧打入正式无损 WebP 图集。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import sharp from 'sharp';
import {
  CANONICAL_RIM_SAMPLES,
  SKILL_ICON_SIZE,
  composeSkillIcon,
  extractCanonicalSkillRim,
} from './skill-icon-rim.ts';
import type {
  AreaShape,
  BasicAttackDefinition,
  BattleBuffEffect,
  BattleCatalog,
  CombatUnit,
  SkillAction,
  SkillDefinition,
  SkillDetail,
  SkillRank,
} from '../src/domain/battle.ts';
import type { ActorDefinition, AnimationClip, EffectClip, Facing } from '../src/domain/content.ts';
import type { CharacterStatsCatalog, EquipmentNumbers } from '../src/domain/character-stats.ts';
import type { ItemCatalog, ItemDefinition } from '../src/domain/items.ts';
import type { MenuPanels } from '../src/domain/menu-panels.ts';
import type { CompanionCatalog } from '../src/domain/party.ts';
import type { StatusHudSkin } from '../src/domain/status-hud.ts';
import type { StoryClass, StoryClassCatalog } from '../src/domain/story-class.ts';
import type { CostumePart, CostumePiece, CostumePose, WardrobeCatalog } from '../src/domain/wardrobe.ts';
import { SPEAR_EFFECT_SOURCES, type RgbaPalette } from './warrior-viewer/prototypes/spear/effects-source.ts';
import {
  SPEAR_ACTION_RECIPES,
  SPEAR_ARMS_PRESETS,
  SPEAR_CYCLE_RECIPES,
  SPEAR_PALETTE,
  SPEAR_SLICES,
  WEST_LEGS_PRESETS,
  type SpearArmsPreset,
  type SpearHeadPose,
  type SpearHeadView,
  type SpearInsertMode,
  type SpearKeyframedPoseRecipe,
  type SpearLegsPreset,
  type SpearPoseRecipe,
} from './warrior-viewer/prototypes/spear/source.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ASSET_SOURCE = path.join(ROOT, 'asset-source');
const PUBLIC = path.join(ROOT, 'public');
const CONTENT = path.join(PUBLIC, 'content');

const CLASS_ID = 'lancer';
const CLASS_NAME = '龙枪武士';
const CLASS_DESCRIPTION =
  '游历艾诺迪亚大陆北境战场的长枪武者，深谙「一寸长、一寸强」的破阵枪法。进可百步穿心贯杀成列强敌，退可舞花横扫荡平四方围攻。';

const WARDROBE_TEXTURE_KEY = 'wardrobe-parts-2';
const WARDROBE_TEXTURE_FILE = 'assets/wardrobe/parts-2.png';
const MAX_WARDROBE_WIDTH = 1024;
const PADDING = 2;
const EFFECT_FPS = 50 / 3;
const FACINGS: readonly Facing[] = ['south', 'west', 'north', 'east'];

/** 第二套高阶长枪调色板（龙牙长枪：秘银寒锋 + 乌木枪杆 + 鎏金吞口 + 苍青龙缨）。 */
const DRAGON_SPEAR_PALETTE: RgbaPalette = {
  '.': [0, 0, 0, 0],
  K: [0x10, 0x14, 0x20, 255],
  D: [0x24, 0x32, 0x48, 255],
  S: [0x4c, 0x6e, 0x96, 255],
  M: [0x82, 0xb2, 0xdc, 255],
  L: [0xc2, 0xe6, 0xff, 255],
  H: [0xf6, 0xfd, 0xff, 255],
  w: [0x22, 0x1c, 0x28, 255],
  W: [0x3d, 0x34, 0x4a, 255],
  u: [0x64, 0x58, 0x78, 255],
  g: [0xa6, 0x74, 0x1e, 255],
  G: [0xff, 0xda, 0x66, 255],
  r: [0x14, 0x58, 0x7c, 255],
  R: [0x26, 0xa8, 0xd8, 255],
  P: [0x8c, 0xf0, 0xff, 255],
};

const ACTIVE_SPEAR_EFFECT_IDS = new Set([
  'spear-basic-thrust',
  'spear-basic-flick',
  'spear-basic-lift',
  'spear-heavy-pierce',
  'spear-slam-arc',
  'spear-flower-spin',
  'spear-gale-sweep',
  'spear-flurry-needles',
  'spear-flurry-finisher',
  'spear-sovereign-dome-back',
  'spear-sovereign-dome',
  'spear-sovereign-charge',
  'spear-sovereign-beam',
  'spear-spin-storm',
]);

const REMOVED_WEAPON_PARTS = new Set([
  'two-handed', 'staff', 'orb', 'main-blade', 'off-blade',
  'main-dagger', 'off-dagger', 'shield', 'bow', 'crossbow', 'spear',
]);

const HEAD_VIEW_PIECES: Record<SpearHeadView, { face: number; neck: number; head: number }> = {
  south: { face: 0, neck: 4, head: 0 },
  west: { face: 1, neck: 5, head: 1 },
  'turn-back': { face: 2, neck: 6, head: 2 },
  north: { face: 3, neck: 7, head: 3 },
  'south-action': { face: 0, neck: 4, head: 4 },
  'west-action': { face: 1, neck: 5, head: 5 },
};

function writePng(absPath: string, png: PNG): void {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, PNG.sync.write(png));
}

function readJson<T>(relContentFile: string): T {
  return JSON.parse(fs.readFileSync(path.join(CONTENT, relContentFile), 'utf8')) as T;
}

function writeJson(relContentFile: string, data: unknown, pretty = true): void {
  const text = (pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data)) + '\n';
  fs.writeFileSync(path.join(CONTENT, relContentFile), text);
}

// ---------------------------------------------------------------------------
// 1. 打包长枪换装切片图集页 parts-2.png
// ---------------------------------------------------------------------------

function buildWardrobePartsSheet(): {
  png: PNG;
  sprites: Record<string, CostumePiece>;
  variants: Record<string, string[]>;
} {
  const styleDefs: { styleId: string; prefix: string; palette: RgbaPalette }[] = [
    { styleId: 'spear-style-1', prefix: 'spear-s1', palette: SPEAR_PALETTE },
    { styleId: 'spear-style-2', prefix: 'spear-s2', palette: DRAGON_SPEAR_PALETTE },
  ];

  interface PlacedSlice {
    key: string;
    styleId: string;
    palette: RgbaPalette;
    rows: readonly string[];
    width: number;
    height: number;
    anchorX: number;
    anchorY: number;
    x: number;
    y: number;
  }

  const placed: PlacedSlice[] = [];
  const variants: Record<string, string[]> = {};
  let cursorX = PADDING;
  let cursorY = PADDING;
  let rowHeight = 0;
  let maxRight = PADDING;

  for (const style of styleDefs) {
    variants[style.styleId] = [];
    for (let idx = 0; idx < SPEAR_SLICES.length; idx++) {
      const slice = SPEAR_SLICES[idx]!;
      const width = slice.rows[0]!.length;
      const height = slice.rows.length;
      if (cursorX + width + PADDING > MAX_WARDROBE_WIDTH) {
        cursorX = PADDING;
        cursorY += rowHeight + PADDING;
        rowHeight = 0;
      }
      const key = `${style.prefix}-${idx}`;
      placed.push({
        key,
        styleId: style.styleId,
        palette: style.palette,
        rows: slice.rows,
        width,
        height,
        anchorX: slice.anchorX,
        anchorY: slice.anchorY,
        x: cursorX,
        y: cursorY,
      });
      variants[style.styleId]!.push(key);
      cursorX += width + PADDING;
      maxRight = Math.max(maxRight, cursorX);
      rowHeight = Math.max(rowHeight, height);
    }
  }

  const sheetWidth = Math.min(MAX_WARDROBE_WIDTH, Math.max(64, maxRight));
  const sheetHeight = cursorY + rowHeight + PADDING;
  const png = new PNG({ width: sheetWidth, height: sheetHeight });
  png.data.fill(0);

  const sprites: Record<string, CostumePiece> = {};
  for (const item of placed) {
    for (let y = 0; y < item.height; y++) {
      const row = item.rows[y]!;
      for (let x = 0; x < item.width; x++) {
        const rgba = item.palette[row[x]!];
        if (!rgba) throw new Error(`未知长枪切片色板字符 '${row[x]}' (${item.key})`);
        const dst = ((item.y + y) * sheetWidth + (item.x + x)) * 4;
        png.data[dst] = rgba[0];
        png.data[dst + 1] = rgba[1];
        png.data[dst + 2] = rgba[2];
        png.data[dst + 3] = rgba[3];
      }
    }
    sprites[item.key] = {
      texture: WARDROBE_TEXTURE_KEY,
      x: item.x,
      y: item.y,
      width: item.width,
      height: item.height,
      anchorX: item.anchorX,
      anchorY: item.anchorY,
    };
  }

  writePng(path.join(ASSET_SOURCE, WARDROBE_TEXTURE_FILE), png);
  writePng(path.join(PUBLIC, WARDROBE_TEXTURE_FILE), png);
  return { png, sprites, variants };
}

// ---------------------------------------------------------------------------
// 2. 构建全套正式长枪姿态（与 prototype 导出逻辑同源）
// ---------------------------------------------------------------------------

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

function mirrorPartX(part: CostumePart): CostumePart {
  return { ...part, x: -part.x, scaleX: -part.scaleX, angle: part.angle ? -part.angle : 0 };
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
  const shift = (part: CostumePart): CostumePart => ({ ...part, x: part.x + bodyDx, y: part.y + bodyDy });
  const shiftedSpear: CostumePart = { ...spearPart, x: spearPart.x + bodyDx, y: spearPart.y + bodyDy };
  const legsApplied = legsPreset
    ? frame.map(part => (part.part === 'coat-back'
      ? { part: 'coat-back', piece: WEST_LEGS_PRESETS[legsPreset].piece, x: WEST_LEGS_PRESETS[legsPreset].x, y: WEST_LEGS_PRESETS[legsPreset].y, scaleX: 1, scaleY: 1, angle: 0, alpha: 1 }
      : part))
    : frame;
  const poseApplied = applyHeadPose(legsApplied, headPose);

  if (armsPreset) {
    const preset = SPEAR_ARMS_PRESETS[armsPreset];
    const bodyOnly = poseApplied.filter(part => !REMOVED_WEAPON_PARTS.has(part.part) && !isCoatFrontArm(part));
    const torsoIdx = bodyOnly.findIndex(part => part.part === 'coat-front');
    if (torsoIdx < 0) throw new Error(`armsPreset=${armsPreset} 需要基础帧包含 coat-front 躯干`);
    const torso = bodyOnly[torsoIdx]!;
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
    const transform = (part: CostumePart): CostumePart => shift(mirrorBaseFrame ? mirrorPartX(part) : part);
    const backList = bodyOnly.slice(0, torsoIdx).map(transform);
    const torsoOut = transform(torso);
    const afterList = bodyOnly.slice(torsoIdx + 1).map(transform);

    const armsWithLayer = [
      { part: transform(buildArm(preset.backArm)), layer: preset.backArm.layer ?? 'behind-torso' },
      { part: transform(buildArm(preset.frontArm)), layer: preset.frontArm.layer ?? 'front-of-spear' },
    ];
    const behindTorsoArms = armsWithLayer.filter(a => a.layer === 'behind-torso').map(a => a.part);
    const behindSpearArms = armsWithLayer.filter(a => a.layer === 'behind-spear').map(a => a.part);
    const frontSpearArms = armsWithLayer.filter(a => a.layer === 'front-of-spear').map(a => a.part);

    if (insertMode === 'back') {
      return [...behindTorsoArms, shiftedSpear, ...behindSpearArms, ...backList, torsoOut, ...frontSpearArms, ...afterList];
    }
    if (insertMode === 'front') {
      return [...backList, ...behindTorsoArms, torsoOut, ...behindSpearArms, ...afterList, shiftedSpear, ...frontSpearArms];
    }
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
    const armIdx = stripped.findIndex(part => part.part === 'coat-front' && (part.piece === 9 || part.piece === 5) && part.scaleX === -1);
    const torsoIdx = stripped.findIndex(part => part.part === 'coat-front' && part.piece < 5);
    const candidates = [armIdx, torsoIdx].filter(i => i >= 0);
    if (candidates.length > 0) { stripped.splice(Math.min(...candidates), 0, shiftedSpear); return stripped; }
    return [shiftedSpear, ...stripped];
  }
  if (insertMode === 'before-right-arm-north') {
    const upgraded = stripped.map(part => (
      part.part === 'coat-front' && isCoatFrontArm(part) && part.scaleX === 1
        ? { ...part, piece: 7, x: 3, y: part.y - 2, scaleX: 1, scaleY: 1, angle: 0 }
        : part
    ));
    const armIdx = upgraded.findIndex(part => part.part === 'coat-front' && isCoatFrontArm(part) && part.scaleX === 1);
    const cloakIdx = upgraded.findIndex(part => part.part === 'cloak');
    const candidates = [armIdx, cloakIdx].filter(i => i >= 0);
    if (candidates.length > 0) { upgraded.splice(Math.min(...candidates), 0, shiftedSpear); return upgraded; }
    return [shiftedSpear, ...upgraded];
  }
  if (insertMode === 'single-hand-west') {
    const bodyNoArms = stripped.filter(part => !(part.part === 'coat-front' && isCoatFrontArm(part)));
    const torsoIdx = bodyNoArms.findIndex(part => part.part === 'coat-front');
    const torso = bodyNoArms[torsoIdx];
    const isWalk = torso ? torso.x < 0 : false;
    const torsoDy = torso?.y ?? 0;
    const strideDx = isWalk ? (shiftedSpear.x - 5) : 0;
    const farEmptyArm: CostumePart = {
      part: 'coat-front',
      piece: 10,
      x: isWalk ? (-4 - strideDx * 2) : -4,
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
      return [...bodyNoArms.slice(0, torsoIdx), farEmptyArm, bodyNoArms[torsoIdx]!, shiftedSpear, nearGripArm, ...bodyNoArms.slice(torsoIdx + 1)];
    }
    return [farEmptyArm, shiftedSpear, nearGripArm, ...bodyNoArms];
  }
  if (insertMode === 'before-near-arm-west') {
    let idx = -1;
    for (let i = stripped.length - 1; i >= 0; i--) {
      const part = stripped[i]!;
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
    if (recipe.armsPreset || recipe.insertMode === 'single-hand-west') return findTorso(frame);
    if (recipe.insertMode === 'before-right-arm-south') {
      return frame.find(p => p.part === 'coat-front' && (p.piece === 9 || p.piece === 5) && p.scaleX === -1);
    }
    if (recipe.insertMode === 'before-right-arm-north') {
      return frame.find(p => p.part === 'coat-front' && (p.piece === 9 || p.piece === 5) && p.scaleX === 1);
    }
    if (recipe.insertMode === 'before-near-arm-west') {
      for (let i = frame.length - 1; i >= 0; i--) {
        const p = frame[i]!;
        if (p.part === 'coat-front' && (p.piece === 6 || p.piece === 8)) return p;
      }
    }
    return frame.find(p => p.part === 'two-handed' || p.part === 'staff' || p.part === 'main-blade')
      ?? frame.find(p => p.part === 'head-front');
  };
  const firstRef = findRef(basePose.frames[0]!);
  const originRefX = firstRef?.x ?? 0;
  const originRefY = firstRef?.y ?? 0;
  const period = recipe.swayPeriod ?? 7;

  const frames = basePose.frames.map((frame, frameIndex) => {
    const ref = findRef(frame);
    const extraTorsoDy = recipe.stepTorsoDy?.[frameIndex] ?? 0;
    const frameHeadPose: SpearHeadPose | undefined = (recipe.headPose || extraTorsoDy !== 0)
      ? { ...recipe.headPose, torsoDy: (recipe.headPose?.torsoDy ?? 0) + extraTorsoDy }
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
    return insertSpearIntoFrame(frame, spearPart, recipe.insertMode, 0, 0, recipe.armsPreset, false, undefined, frameHeadPose);
  });

  return { mirrorX: recipe.mirrorX, frameRate: basePose.frameRate, frames };
}

function buildKeyframedPose(wardrobe: WardrobeCatalog, recipe: SpearKeyframedPoseRecipe): CostumePose {
  const frames = recipe.frames.map((spec, index) => {
    const basePose = wardrobe.poses[spec.sourcePoseId];
    if (!basePose) throw new Error(`基础姿态不存在：${spec.sourcePoseId} (${recipe.id} F${index})`);
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
      rawFrame, spearPart, spec.insertMode, spec.bodyDx ?? 0, spec.bodyDy ?? 0,
      spec.armsPreset, spec.mirrorBaseFrame ?? false, spec.legsPreset, spec.headPose,
    );
  });
  return { mirrorX: recipe.mirrorX, frameRate: recipe.frameRate, frames };
}

function formalPoseId(protoId: string): string {
  return protoId.replace(/^prototype-/, '');
}

function buildFormalSpearPoses(wardrobe: WardrobeCatalog): {
  poses: Record<string, CostumePose>;
  weaponStance: Record<string, string>;
  skillPoses: Record<string, string>;
} {
  const poses: Record<string, CostumePose> = {};
  const rawMap: Record<string, string> = {};

  for (const recipe of SPEAR_CYCLE_RECIPES) {
    if (recipe.clip.startsWith('spear-upright-idle-')) continue;
    const id = formalPoseId(recipe.id);
    poses[id] = buildCyclePose(wardrobe, recipe);
    rawMap[recipe.clip] = id;
  }
  for (const recipe of SPEAR_ACTION_RECIPES) {
    if (recipe.clip.startsWith('thrust-') || recipe.clip.startsWith('spear-die-')) continue;
    const id = formalPoseId(recipe.id);
    poses[id] = buildKeyframedPose(wardrobe, recipe);
    rawMap[recipe.clip] = id;
  }
  for (const facing of FACINGS) {
    const buffPoseId = `spear-buff-cast-${facing}`;
    rawMap[`skill-dragon-step-${facing}`] = buffPoseId;
    rawMap[`skill-gale-stance-${facing}`] = buffPoseId;
  }

  const weaponStance: Record<string, string> = {};
  const skillPoses: Record<string, string> = {};
  for (const facing of FACINGS) {
    weaponStance[`idle-${facing}`] = rawMap[`idle-${facing}`]!;
    weaponStance[`walk-${facing}`] = rawMap[`walk-${facing}`]!;
    weaponStance[`town-idle-${facing}`] = rawMap[`town-idle-${facing}`]!;
    weaponStance[`town-walk-${facing}`] = rawMap[`town-walk-${facing}`]!;
    weaponStance[`attack-${facing}`] = rawMap[`attack-${facing}`]!;
    weaponStance[`attack-2-${facing}`] = rawMap[`attack-2-${facing}`]!;
    weaponStance[`attack-3-${facing}`] = rawMap[`attack-3-${facing}`]!;
    weaponStance[`frenzy-spear-${facing}`] = rawMap[`sweep-${facing}`]!;
  }
  // sweep-* 仅供 frenzy-spear-* 使用，poses 保留即可
  for (const skillId of [
    'dragon-pierce', 'whirl-sweep', 'spin-storm', 'flurry-thrust',
    'dragon-slam', 'sovereign-pierce', 'focus-edge', 'dragon-step', 'gale-stance',
  ]) {
    for (const facing of FACINGS) {
      const key = `skill-${skillId}-${facing}`;
      skillPoses[key] = rawMap[key]!;
    }
  }
  return { poses, weaponStance, skillPoses };
}

// ---------------------------------------------------------------------------
// 3. 导出战斗特效源网格 PNG 并生成 attackEffects 定义
// ---------------------------------------------------------------------------

function buildBattleEffects(): BattleCatalog['attackEffects'] {
  const attackEffects: BattleCatalog['attackEffects'] = {};

  for (const src of SPEAR_EFFECT_SOURCES) {
    if (!ACTIVE_SPEAR_EFFECT_IDS.has(src.effectId)) continue;
    const frameCount = src.baseFrames.length;
    const stripWidth = src.frameWidth * frameCount;
    const stripHeight = src.frameHeight;

    const renderStrip = (frames: typeof src.baseFrames, palette: RgbaPalette): PNG => {
      const png = new PNG({ width: stripWidth, height: stripHeight });
      png.data.fill(0);
      frames.forEach((grid, frameIdx) => {
        const xBase = frameIdx * src.frameWidth;
        for (let y = 0; y < src.frameHeight; y++) {
          const row = grid.rows[y]!;
          for (let x = 0; x < src.frameWidth; x++) {
            const rgba = palette[row[x]!];
            if (!rgba) throw new Error(`未知特效色板字符 '${row[x]}' (${grid.id})`);
            const dst = (y * stripWidth + (xBase + x)) * 4;
            png.data[dst] = rgba[0];
            png.data[dst + 1] = rgba[1];
            png.data[dst + 2] = rgba[2];
            png.data[dst + 3] = rgba[3];
          }
        }
      });
      return png;
    };

    const baseRel = `assets/battle-effects/spear/${src.effectId}/${src.direction}-base.png`;
    const addRel = `assets/battle-effects/spear/${src.effectId}/${src.direction}-add.png`;
    writePng(path.join(ASSET_SOURCE, baseRel), renderStrip(src.baseFrames, src.basePalette));
    writePng(path.join(ASSET_SOURCE, addRel), renderStrip(src.addFrames, src.addPalette));

    const entry = attackEffects[src.effectId] ?? (attackEffects[src.effectId] = { clips: {} });
    const clip: EffectClip = {
      version: 1,
      frameWidth: src.frameWidth,
      frameHeight: src.frameHeight,
      frames: frameCount,
      originX: src.originX,
      originY: src.originY,
      frameRate: EFFECT_FPS,
      mirrorX: false,
      layers: [
        { key: `${src.effectId}-${src.direction}-base`, file: baseRel, blend: 'normal', operations: [] },
        { key: `${src.effectId}-${src.direction}-add`, file: addRel, blend: 'add', operations: ['add'] },
      ],
    };
    entry.clips[src.direction] = clip;
    if (src.direction === 'west') {
      entry.clips.east = {
        ...clip,
        mirrorX: true,
        layers: clip.layers.map(layer => ({ ...layer, key: layer.key.replace(/-west-(base|add)$/, '-east-$1') })),
      };
    }
    for (const sharedDir of src.sharedDirections ?? []) {
      entry.clips[sharedDir] = {
        ...clip,
        mirrorX: false,
        layers: clip.layers.map(layer => ({
          ...layer,
          key: layer.key.replace(new RegExp(`-${src.direction}-(base|add)$`), `-${sharedDir}-$1`),
        })),
      };
      // 清理历史上曾独立落盘的冗余方向贴图，保持 asset-source 干净
      for (const suffix of ['base', 'add'] as const) {
        const staleFile = path.join(ASSET_SOURCE, `assets/battle-effects/spear/${src.effectId}/${sharedDir}-${suffix}.png`);
        if (fs.existsSync(staleFile)) fs.unlinkSync(staleFile);
      }
    }
  }
  return attackEffects;
}

// ---------------------------------------------------------------------------
// 4. 离线软件合成角色帧条（story-preview-lancer 与 battle-lancer）
// ---------------------------------------------------------------------------

function composePoseStrip(
  pose: CostumePose,
  variants: Record<string, string>,
  wardrobe: WardrobeCatalog,
  textures: Record<string, PNG>,
): { png: PNG; frameWidth: number; frameHeight: number; frames: number; originX: number; originY: number } {
  const resolvePart = (part: CostumePart): { piece: CostumePiece; tex: PNG } | undefined => {
    const varName = variants[part.part];
    if (!varName) return undefined;
    const spriteKey = wardrobe.variants[varName]?.[part.piece];
    if (!spriteKey) return undefined;
    const piece = wardrobe.sprites[spriteKey];
    if (!piece) return undefined;
    const tex = textures[piece.texture];
    if (!tex) return undefined;
    return { piece, tex };
  };

  const points: { x: number; y: number }[] = [];
  for (const frame of pose.frames) {
    for (const part of frame) {
      const info = resolvePart(part);
      if (!info) continue;
      const { piece } = info;
      const rad = (part.angle * Math.PI) / 180;
      const co = Math.cos(rad);
      const si = Math.sin(rad);
      for (const x of [0, piece.width]) {
        for (const y of [0, piece.height]) {
          const u = (x - piece.anchorX) * part.scaleX;
          const v = (y - piece.anchorY) * part.scaleY;
          points.push({ x: part.x + u * co - v * si, y: part.y + u * si + v * co });
        }
      }
    }
  }
  if (!points.length) points.push({ x: 0, y: 0 });
  const left = Math.floor(Math.min(...points.map(p => p.x))) - 1;
  const top = Math.floor(Math.min(...points.map(p => p.y))) - 1;
  const frameWidth = Math.ceil(Math.max(...points.map(p => p.x))) - left + 1;
  const frameHeight = Math.ceil(Math.max(...points.map(p => p.y))) - top + 1;
  const frameCount = pose.frames.length;

  const strip = new PNG({ width: frameWidth * frameCount, height: frameHeight });
  strip.data.fill(0);

  pose.frames.forEach((parts, frameIdx) => {
    const xOffset = frameIdx * frameWidth;
    for (const part of parts) {
      const info = resolvePart(part);
      if (!info || part.alpha <= 0) continue;
      const { piece, tex } = info;
      const rad = (part.angle * Math.PI) / 180;
      const co = Math.cos(rad);
      const si = Math.sin(rad);
      for (let py = 0; py < frameHeight; py++) {
        const wy = py + 0.5 + top - part.y;
        for (let px = 0; px < frameWidth; px++) {
          const wx = px + 0.5 + left - part.x;
          const u = (wx * co + wy * si) / part.scaleX + piece.anchorX;
          const v = (-wx * si + wy * co) / part.scaleY + piece.anchorY;
          const sx = Math.floor(u);
          const sy = Math.floor(v);
          if (sx < 0 || sx >= piece.width || sy < 0 || sy >= piece.height) continue;
          const srcIdx = ((piece.y + sy) * tex.width + (piece.x + sx)) * 4;
          const sa = (tex.data[srcIdx + 3]! / 255) * part.alpha;
          if (sa <= 0) continue;
          const sr = tex.data[srcIdx]!;
          const sg = tex.data[srcIdx + 1]!;
          const sb = tex.data[srcIdx + 2]!;
          const dstIdx = (py * strip.width + (xOffset + px)) * 4;
          const da = strip.data[dstIdx + 3]! / 255;
          const outA = sa + da * (1 - sa);
          if (outA <= 0) continue;
          strip.data[dstIdx] = Math.round((sr * sa + strip.data[dstIdx]! * da * (1 - sa)) / outA);
          strip.data[dstIdx + 1] = Math.round((sg * sa + strip.data[dstIdx + 1]! * da * (1 - sa)) / outA);
          strip.data[dstIdx + 2] = Math.round((sb * sa + strip.data[dstIdx + 2]! * da * (1 - sa)) / outA);
          strip.data[dstIdx + 3] = Math.round(outA * 255);
        }
      }
    }
  });

  return {
    png: strip,
    frameWidth,
    frameHeight,
    frames: frameCount,
    originX: -left / frameWidth,
    originY: -top / frameHeight,
  };
}

function buildCharacterActors(
  wardrobe: WardrobeCatalog,
  parts2Png: PNG,
  weaponStance: Record<string, string>,
  skillPoses: Record<string, string>,
): { previewActor: ActorDefinition; battleActor: ActorDefinition; playerActor: ActorDefinition } {
  const textures: Record<string, PNG> = {
    'wardrobe-parts-0': PNG.sync.read(fs.readFileSync(path.join(PUBLIC, 'assets/wardrobe/parts-0.png'))),
    'wardrobe-parts-1': PNG.sync.read(fs.readFileSync(path.join(PUBLIC, 'assets/wardrobe/parts-1.png'))),
    [WARDROBE_TEXTURE_KEY]: parts2Png,
  };

  // 选职界面预览采用龙鳞板甲（dragon-scale-armor）+ 红缨铁枪，与其余六职业选职展示一致
  const previewArmor = wardrobe.equipment['dragon-scale-armor'];
  if (!previewArmor) throw new Error('缺少龙枪预览护甲装备：dragon-scale-armor');
  const previewVariants: Record<string, string> = {
    ...wardrobe.defaults,
    ...previewArmor.main,
    spear: 'spear-style-1',
  };
  const battleVariants: Record<string, string> = {
    ...wardrobe.defaults,
    spear: 'spear-style-1',
  };

  const previewIdlePose = wardrobe.poses[weaponStance['idle-south']!]!;
  const previewStrip = composePoseStrip(previewIdlePose, previewVariants, wardrobe, textures);
  const previewRel = 'assets/characters/story-preview-lancer/idle-south-normal.png';
  writePng(path.join(ASSET_SOURCE, previewRel), previewStrip.png);

  // 截取第 0 帧写入菜单职业小预览图 preview.png
  const previewSingle = new PNG({ width: previewStrip.frameWidth, height: previewStrip.frameHeight });
  for (let y = 0; y < previewStrip.frameHeight; y++) {
    const srcRow = y * previewStrip.png.width * 4;
    previewStrip.png.data.copy(previewSingle.data, y * previewStrip.frameWidth * 4, srcRow, srcRow + previewStrip.frameWidth * 4);
  }
  writePng(path.join(ASSET_SOURCE, 'assets/characters/battle-lancer/preview.png'), previewSingle);

  const previewActor: ActorDefinition = {
    id: 'story-preview-lancer',
    name: CLASS_NAME,
    description: '',
    portrait: null,
    clips: {
      'idle-south': {
        frameWidth: previewStrip.frameWidth,
        frameHeight: previewStrip.frameHeight,
        frames: previewStrip.frames,
        originX: previewStrip.originX,
        originY: previewStrip.originY,
        frameRate: previewIdlePose.frameRate,
        mirrorX: false,
        layers: [{ key: 'story-preview-lancer-idle-south-normal', file: previewRel, blend: 'normal' }],
      },
    },
  };

  const clipMap: Record<string, string> = {};
  for (const prefix of ['idle', 'walk', 'attack', 'attack-2', 'attack-3']) {
    for (const facing of FACINGS) clipMap[`${prefix}-${facing}`] = weaponStance[`${prefix}-${facing}`]!;
  }
  Object.assign(clipMap, skillPoses);

  const battleClips: ActorDefinition['clips'] = {};
  for (const [clipName, poseId] of Object.entries(clipMap)) {
    const pose = wardrobe.poses[poseId]!;
    // 东向与西向共用未翻转帧图，依靠 mirrorX: true 在渲染时翻转，自动获得图集去重
    const fileFacingClip = clipName.endsWith('-east') ? clipName.replace(/-east$/, '-west') : clipName;
    const relFile = `assets/characters/battle-lancer/${fileFacingClip}-normal.png`;
    const rendered = composePoseStrip(pose, battleVariants, wardrobe, textures);
    if (!clipName.endsWith('-east')) {
      writePng(path.join(ASSET_SOURCE, relFile), rendered.png);
    }
    const animClip: AnimationClip = {
      frameWidth: rendered.frameWidth,
      frameHeight: rendered.frameHeight,
      frames: rendered.frames,
      originX: rendered.originX,
      originY: rendered.originY,
      frameRate: pose.frameRate,
      mirrorX: pose.mirrorX,
      layers: [{ key: `battle-lancer-${clipName}-normal`, file: relFile, blend: 'normal' }],
    };
    battleClips[clipName as keyof ActorDefinition['clips']] = animClip;
  }

  const playerClips: ActorDefinition['clips'] = {};
  for (const prefix of ['idle', 'walk', 'attack']) {
    for (const facing of FACINGS) {
      const k = `${prefix}-${facing}` as keyof ActorDefinition['clips'];
      playerClips[k] = battleClips[k];
    }
  }

  const baseMeta = {
    id: 'battle-lancer',
    name: CLASS_NAME,
    description: '',
    portrait: null,
    effectAnchor: { x: 0, y: -4 },
    headAnchor: { x: 0, y: -22 },
    collision: { x: -8, y: -8, width: 16, height: 16 },
  };

  return {
    previewActor,
    battleActor: { ...baseMeta, clips: battleClips },
    playerActor: { ...baseMeta, clips: playerClips },
  };
}

// ---------------------------------------------------------------------------
// 5. 绘制全套 UI 图标、武器图标、15 枚技能图标与 3 枚 Buff 图标
// ---------------------------------------------------------------------------

type Rgba = readonly [number, number, number, number];

function blendPixel(png: PNG, x: number, y: number, [r, g, b, a]: Rgba): void {
  if (x < 0 || x >= png.width || y < 0 || y >= png.height || a <= 0) return;
  const idx = (y * png.width + x) * 4;
  const sa = a / 255;
  const da = png.data[idx + 3]! / 255;
  const outA = sa + da * (1 - sa);
  if (outA <= 0) return;
  png.data[idx] = Math.round((r * sa + png.data[idx]! * da * (1 - sa)) / outA);
  png.data[idx + 1] = Math.round((g * sa + png.data[idx + 1]! * da * (1 - sa)) / outA);
  png.data[idx + 2] = Math.round((b * sa + png.data[idx + 2]! * da * (1 - sa)) / outA);
  png.data[idx + 3] = Math.round(outA * 255);
}

function drawCapsule(png: PNG, x0: number, y0: number, x1: number, y1: number, radius: number, color: Rgba): void {
  const minX = Math.max(0, Math.floor(Math.min(x0, x1) - radius - 1));
  const maxX = Math.min(png.width - 1, Math.ceil(Math.max(x0, x1) + radius + 1));
  const minY = Math.max(0, Math.floor(Math.min(y0, y1) - radius - 1));
  const maxY = Math.min(png.height - 1, Math.ceil(Math.max(y0, y1) + radius + 1));
  const dx = x1 - x0;
  const dy = y1 - y0;
  const lenSq = dx * dx + dy * dy || 1;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const t = Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / lenSq));
      const dist = Math.hypot(x - (x0 + dx * t), y - (y0 + dy * t));
      if (dist <= radius + 0.6) {
        const aa = dist <= radius - 0.4 ? 1 : Math.max(0, radius + 0.6 - dist);
        blendPixel(png, x, y, [color[0], color[1], color[2], Math.round(color[3] * aa)]);
      }
    }
  }
}

function drawPolygon(png: PNG, pts: readonly [number, number][], fill: (x: number, y: number) => Rgba): void {
  const xs = pts.map(p => p[0]);
  const ys = pts.map(p => p[1]);
  const minX = Math.max(0, Math.floor(Math.min(...xs)));
  const maxX = Math.min(png.width - 1, Math.ceil(Math.max(...xs)));
  const minY = Math.max(0, Math.floor(Math.min(...ys)));
  const maxY = Math.min(png.height - 1, Math.ceil(Math.max(...ys)));
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      let inside = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i]!;
        const [xj, yj] = pts[j]!;
        if ((yi > y + 0.5) !== (yj > y + 0.5) && x + 0.5 < ((xj - xi) * (y + 0.5 - yi)) / (yj - yi) + xi) {
          inside = !inside;
        }
      }
      if (inside) blendPixel(png, x, y, fill(x, y));
    }
  }
}

function buildClassBadgeAndPortraits(): void {
  // 1. 选职大图标 139x139：复用 warrior.png 原版金属圆角框与阴影，内部重绘冷青暖金底光 + 象牙白龙枪纹章
  const warriorBadge = PNG.sync.read(fs.readFileSync(path.join(ASSET_SOURCE, 'assets/ui/story-classes/warrior.png')));
  const badge = new PNG({ width: warriorBadge.width, height: warriorBadge.height });
  warriorBadge.data.copy(badge.data);

  // 内部圆角框区域 (x: 24..114, y: 24..114) 重置为原版同款暗铁青金渐变底板
  const cx = 69;
  const cy = 69;
  for (let y = 23; y <= 115; y++) {
    for (let x = 23; x <= 115; x++) {
      const dx = Math.max(0, Math.abs(x - cx) - 34);
      const dy = Math.max(0, Math.abs(y - cy) - 34);
      const cornerDist = Math.hypot(dx, dy);
      if (cornerDist > 11.5) continue;
      const idx = (y * badge.width + x) * 4;
      const radial = Math.hypot(x - 66, y - 58) / 56;
      const glow = Math.max(0, 1 - radial);
      badge.data[idx] = Math.round(18 + glow * 58);
      badge.data[idx + 1] = Math.round(24 + glow * 68);
      badge.data[idx + 2] = Math.round(34 + glow * 72);
      badge.data[idx + 3] = 255;
    }
  }

  const crestColor = (x: number, _y: number): Rgba => (x <= 69 ? [252, 250, 245, 255] : [224, 212, 192, 255]);
  // 中心竖立柳叶龙枪锋刃 + 双侧护翼 + 飘逸枪缨 + 枪杆铁镦
  drawCapsule(badge, 69, 48, 69, 108, 3.0, [232, 222, 204, 255]);
  drawPolygon(badge, [[69, 25], [60, 49], [69, 55], [78, 49]], crestColor);
  // 龙翼双月牙护刃
  drawPolygon(badge, [[64, 52], [44, 42], [49, 60], [64, 61]], crestColor);
  drawPolygon(badge, [[74, 52], [94, 42], [89, 60], [74, 61]], crestColor);
  // 吞口横箍与流苏红缨剪影
  drawCapsule(badge, 61, 57, 77, 57, 2.5, [252, 250, 245, 255]);
  drawCapsule(badge, 63, 60, 52, 74, 2.0, [244, 236, 222, 255]);
  drawCapsule(badge, 75, 60, 86, 74, 2.0, [222, 210, 190, 255]);
  // 枪尾锥形铁镦
  drawPolygon(badge, [[65, 102], [73, 102], [69, 113]], crestColor);

  writePng(path.join(ASSET_SOURCE, 'assets/ui/story-classes/lancer.png'), badge);

  // 2. 队伍职业立绘与小图标（主角使用凯恩专属立绘；此处将原版武者立绘转为苍蓝银甲调以作为职业兜底图）
  for (const [srcRel, dstRel] of [
    ['assets/ui/menus/class-warrior.png', 'assets/ui/menus/class-lancer.png'],
    ['assets/ui/menus/party-class-warrior.png', 'assets/ui/menus/party-class-lancer.png'],
  ] as const) {
    const src = PNG.sync.read(fs.readFileSync(path.join(ASSET_SOURCE, srcRel)));
    const out = new PNG({ width: src.width, height: src.height });
    src.data.copy(out.data);
    for (let i = 0; i < out.data.length; i += 4) {
      const a = out.data[i + 3]!;
      if (a === 0) continue;
      const r = out.data[i]!;
      const g = out.data[i + 1]!;
      const b = out.data[i + 2]!;
      // 仅将高饱和赤发色域转为苍银冰蓝，保留肤色与金属明暗层次
      if (r > g * 1.45 && r > b * 1.55 && r > 90) {
        const lum = r * 0.45 + g * 0.4 + b * 0.15;
        out.data[i] = Math.min(255, Math.round(lum * 0.62));
        out.data[i + 1] = Math.min(255, Math.round(lum * 0.92));
        out.data[i + 2] = Math.min(255, Math.round(lum * 1.32 + 24));
      }
    }
    writePng(path.join(ASSET_SOURCE, dstRel), out);
  }
}

function buildWeaponIcons(): void {
  const drawSpearItemIcon = (palette: RgbaPalette): PNG => {
    const png = new PNG({ width: 64, height: 64 });
    png.data.fill(0);
    // 左上 (10,10) 枪尖 → 右下 (55,55) 枪尾铁镦，贴合原版 64x64 武器图标斜向构图
    drawCapsule(png, 25, 25, 53, 53, 2.4, palette.K!);
    drawCapsule(png, 25, 25, 52, 52, 1.4, palette.W!);
    drawCapsule(png, 24, 25, 51, 52, 0.8, palette.u!);
    // 铁镦
    drawCapsule(png, 51, 51, 56, 56, 2.0, palette.K!);
    drawCapsule(png, 51, 51, 55, 55, 1.1, palette.M!);
    // 飘动枪缨
    drawCapsule(png, 25, 26, 17, 36, 2.3, palette.K!);
    drawCapsule(png, 25, 26, 17, 36, 1.4, palette.R!);
    drawCapsule(png, 26, 25, 35, 19, 2.1, palette.K!);
    drawCapsule(png, 26, 25, 35, 19, 1.2, palette.P!);
    // 铜箍吞口
    drawCapsule(png, 23, 27, 27, 23, 2.4, palette.K!);
    drawCapsule(png, 23, 27, 27, 23, 1.5, palette.G!);
    // 柳叶钢枪刃
    drawPolygon(png, [[8, 8], [21, 27], [27, 21]], () => palette.K!);
    drawPolygon(png, [[10, 10], [21, 25], [25, 21]], (x, y) => (x >= y ? palette.L! : palette.S!));
    drawCapsule(png, 10, 10, 24, 24, 0.9, palette.H!);
    return png;
  };

  writePng(path.join(ASSET_SOURCE, 'assets/ui/items/spear-basic.png'), drawSpearItemIcon(SPEAR_PALETTE));
  writePng(path.join(ASSET_SOURCE, 'assets/ui/items/spear-dragon-fang.png'), drawSpearItemIcon(DRAGON_SPEAR_PALETTE));

  // 地面掉落小图标 14x14（保留在 asset-source 与 public，供 groundLootAssets 加载）
  const ground = new PNG({ width: 14, height: 14 });
  ground.data.fill(0);
  drawCapsule(ground, 2, 2, 12, 12, 1.4, SPEAR_PALETTE.K!);
  drawCapsule(ground, 5, 5, 11, 11, 0.7, SPEAR_PALETTE.u!);
  drawCapsule(ground, 5, 5, 3, 8, 0.8, SPEAR_PALETTE.R!);
  drawCapsule(ground, 2, 2, 5, 5, 1.0, SPEAR_PALETTE.H!);
  writePng(path.join(ASSET_SOURCE, 'assets/items/ground/spear.png'), ground);
  writePng(path.join(PUBLIC, 'assets/items/ground/spear.png'), ground);
}

const SKILL_ICON_IDS = [
  'dragon-pierce',
  'whirl-sweep',
  'spin-storm',
  'flurry-thrust',
  'dragon-slam',
  'sovereign-pierce',
  'focus-edge',
  'dragon-step',
  'gale-stance',
  'spear-mastery',
  'polearm-reach',
  'shaft-parry',
  'piercing-momentum',
  'coiling-dragon-footwork',
  'dragon-spirit',
] as const;

/**
 * 将 `asset-source/raw-art/skills/lancer-<id>.png` 中的生图原画高精缩放至 75×75，
 * 并封装经共识校验的原版《艾诺迪亚4》青铜圆框与透明四角；同时从 3 项增益技能原画派生 24×24 状态栏小图标。
 */
async function buildSkillAndBuffIcons(): Promise<void> {
  const rawDir = path.join(ASSET_SOURCE, 'raw-art/skills');
  const rim = extractCanonicalSkillRim(
    CANONICAL_RIM_SAMPLES.map(rel => PNG.sync.read(fs.readFileSync(path.join(ASSET_SOURCE, rel)))),
  );

  // 逐技能可选微调内裁比例（默认裁掉最外 4% 安全出血，确保圆框内构图饱满无白边）
  const cropMarginBySkill: Partial<Record<(typeof SKILL_ICON_IDS)[number], number>> = {
    'dragon-pierce': 0.06,
    'spin-storm': 0.02,
  };

  for (const id of SKILL_ICON_IDS) {
    const rawFile = path.join(rawDir, `lancer-${id}.png`);
    if (!fs.existsSync(rawFile)) {
      throw new Error(`缺少龙枪技能图标原图：${rawFile}`);
    }
    const meta = await sharp(rawFile).metadata();
    const srcW = meta.width ?? 256;
    const srcH = meta.height ?? 256;
    const margin = cropMarginBySkill[id] ?? 0.04;
    const cropLeft = Math.round(srcW * margin);
    const cropTop = Math.round(srcH * margin);
    const cropSize = Math.max(1, Math.min(srcW - cropLeft * 2, srcH - cropTop * 2));

    const { data: rawRgba } = await sharp(rawFile)
      .extract({ left: cropLeft, top: cropTop, width: cropSize, height: cropSize })
      .resize(SKILL_ICON_SIZE, SKILL_ICON_SIZE, { kernel: sharp.kernel.lanczos3, fit: 'cover' })
      .sharpen({ sigma: 0.65 })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const png = composeSkillIcon(rawRgba, rim);

    writePng(path.join(ASSET_SOURCE, `assets/skills/lancer-${id}.png`), png);
    writePng(path.join(PUBLIC, `assets/skills/lancer-${id}.png`), png);
  }

  // 状态栏 24×24 增益小图标：直接从对应 3 枚 AI 增益技能原画中心派生，叠加原版 buff-enrage.png 金属边环
  const buffFrame = PNG.sync.read(fs.readFileSync(path.join(ASSET_SOURCE, 'assets/ui/status/buff-enrage.png')));
  const buffPairs: readonly [string, string][] = [
    ['focus-edge', 'assets/ui/status/buff-focus-edge.png'],
    ['dragon-step', 'assets/ui/status/buff-dragon-step.png'],
    ['gale-stance', 'assets/ui/status/buff-gale-stance.png'],
  ];
  for (const [skillId, outRel] of buffPairs) {
    const rawFile = path.join(rawDir, `lancer-${skillId}.png`);
    const meta = await sharp(rawFile).metadata();
    const srcW = meta.width ?? 256;
    const srcH = meta.height ?? 256;
    const inset = Math.round(Math.min(srcW, srcH) * 0.08);
    const cropSize = Math.max(1, Math.min(srcW, srcH) - inset * 2);
    const { data: buffRgba } = await sharp(rawFile)
      .extract({ left: inset, top: inset, width: cropSize, height: cropSize })
      .resize(24, 24, { kernel: sharp.kernel.lanczos3, fit: 'cover' })
      .sharpen({ sigma: 0.55 })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const out = new PNG({ width: 24, height: 24 });
    buffFrame.data.copy(out.data);
    for (let y = 0; y < 24; y++) {
      for (let x = 0; x < 24; x++) {
        const dist = Math.hypot(x - 11.5, y - 11.5);
        if (dist <= 8.8) {
          const idx = (y * 24 + x) * 4;
          const blend = dist <= 7.8 ? 0 : (dist - 7.8) / 1.0;
          out.data[idx] = Math.round(buffRgba[idx]! * (1 - blend) + buffFrame.data[idx]! * blend);
          out.data[idx + 1] = Math.round(buffRgba[idx + 1]! * (1 - blend) + buffFrame.data[idx + 1]! * blend);
          out.data[idx + 2] = Math.round(buffRgba[idx + 2]! * (1 - blend) + buffFrame.data[idx + 2]! * blend);
          out.data[idx + 3] = 255;
        }
      }
    }
    writePng(path.join(ASSET_SOURCE, outRel), out);
  }
}

// ---------------------------------------------------------------------------
// 6. 构建普攻与 15 项技能定义（9 主动 + 6 被动）
// ---------------------------------------------------------------------------

function detailEffect(label: string, value: string, zeroValue: string, effectIndex: number, valueSpacing = true): SkillDetail {
  return {
    label,
    value,
    kind: 'effect',
    effectIndex,
    valueSpacing,
    zeroValue,
    valueParts: [{ text: value, color: '#00b4ff' }],
  };
}

function buildRanks(
  normalMaxLevel: number,
  manaByRank: readonly number[],
  cooldownSeconds: number | null,
  pointCosts: readonly number[],
  effectRows: (rankIndex: number) => SkillDetail[],
): SkillRank[] {
  let invested = 0;
  return Array.from({ length: 8 }, (_, idx) => {
    const cost = pointCosts[idx] ?? 1;
    invested += idx < normalMaxLevel ? cost : 1;
    const details: SkillDetail[] = [];
    if (cooldownSeconds !== null) {
      details.push({ label: '魔法消耗量', value: String(manaByRank[idx]!), kind: 'mana', zeroValue: '0' });
      details.push({ label: '冷却时间', value: `${cooldownSeconds}秒`, kind: 'cooldown' });
    }
    details.push(...effectRows(idx));
    return {
      level: idx + 1,
      manaCost: cooldownSeconds !== null ? manaByRank[idx]! : 0,
      pointCost: cost,
      investedSkillPoints: invested,
      details,
    };
  });
}

function physicalUnit(
  strengthWeight: number,
  dexterityWeight: number,
  ratesPerThousand: readonly number[],
): CombatUnit {
  return {
    effect: 'physical',
    source: 'physicalAttack',
    attributeWeights: {
      strength: strengthWeight,
      dexterity: dexterityWeight,
      vitality: 0,
      intelligence: 0,
      mentality: 0,
    },
    ranks: ratesPerThousand.map(ratePerThousand => ({
      fixedAddition: 0,
      operation: { kind: 'multiply-thousandth', ratePerThousand },
    })),
  };
}

function makeActiveSkill(spec: {
  id: string;
  name: string;
  description: string;
  normalMaxLevel: number;
  requiredInvestedSkillPoints?: number;
  mana: readonly number[];
  cooldownFrames: number;
  pointCosts: readonly number[];
  effectRows: (idx: number) => SkillDetail[];
  action: SkillAction;
}): SkillDefinition {
  const cooldownSeconds = Math.round((spec.cooldownFrames * 60) / 100) / 10;
  const ranks = buildRanks(spec.normalMaxLevel, spec.mana, cooldownSeconds, spec.pointCosts, spec.effectRows);
  return {
    id: spec.id,
    name: spec.name,
    kind: 'active',
    icon: `assets/skills/lancer-${spec.id}.png`,
    description: spec.description,
    normalMaxLevel: spec.normalMaxLevel,
    ...(spec.requiredInvestedSkillPoints ? { requiredInvestedSkillPoints: spec.requiredInvestedSkillPoints } : {}),
    ranks,
    action: spec.action,
    companion: {
      ...(spec.requiredInvestedSkillPoints ? { requiredInvestedSkillPoints: spec.requiredInvestedSkillPoints } : {}),
      ranks: structuredClone(ranks),
      action: structuredClone(spec.action),
    },
  };
}

function makePassiveSkill(spec: {
  id: string;
  name: string;
  description: string;
  normalMaxLevel: number;
  requiredInvestedSkillPoints?: number;
  pointCosts: readonly number[];
  effectRows: (idx: number) => SkillDetail[];
  passiveUnits: NonNullable<SkillDefinition['passiveUnits']>;
  reactionsByRank?: SkillDefinition['reactionsByRank'];
}): SkillDefinition {
  const ranks = buildRanks(spec.normalMaxLevel, [0, 0, 0, 0, 0, 0, 0, 0], null, spec.pointCosts, spec.effectRows);
  return {
    id: spec.id,
    name: spec.name,
    kind: 'passive',
    icon: `assets/skills/lancer-${spec.id}.png`,
    description: spec.description,
    normalMaxLevel: spec.normalMaxLevel,
    ...(spec.requiredInvestedSkillPoints ? { requiredInvestedSkillPoints: spec.requiredInvestedSkillPoints } : {}),
    ranks,
    action: null,
    passiveUnits: spec.passiveUnits,
    ...(spec.reactionsByRank ? { reactionsByRank: spec.reactionsByRank } : {}),
    companion: {
      ...(spec.requiredInvestedSkillPoints ? { requiredInvestedSkillPoints: spec.requiredInvestedSkillPoints } : {}),
      ranks: structuredClone(ranks),
      action: null,
      passiveUnits: structuredClone(spec.passiveUnits),
      ...(spec.reactionsByRank ? { reactionsByRank: structuredClone(spec.reactionsByRank) } : {}),
    },
  };
}

function buildSpearBasicAttack(): BasicAttackDefinition {
  const step2Shape: AreaShape = { kind: 'sector', radiusPx: 64, angleDeg: 180, backSlackPx: 8 };
  const step3Shape: AreaShape = { kind: 'sector', radiusPx: 66, angleDeg: 96, backSlackPx: 8 };
  return {
    damage: {
      effect: 'physical',
      source: 'bestNormalDamage',
      attributeWeights: { strength: 0, dexterity: 0, vitality: 0, intelligence: 0, mentality: 0 },
      ranks: [{ fixedAddition: 0, operation: { kind: 'add', amount: 0 } }],
    },
    manaGemDrop: 'weapon',
    frameDurationMs: 60,
    cycleFrames: 8,
    approachDistanceUnits: 6,
    searchRadiusPx: 80,
    strikeFrame: 3,
    swingFrame: 2,
    swings: ['spear-basic-thrust'],
    impacts: ['impact-spark', 'impact-flash', 'impact-burst', 'impact-cross', 'impact-scatter'],
    projectile: null,
    impactPlacement: 'attached',
    swingPlacement: 'above-characters',
    dispatch: { breaksStealth: true },
    combo: [
      {
        clips: { south: 'attack-2-south', west: 'attack-2-west', north: 'attack-2-north', east: 'attack-2-east' },
        cycleFrames: 7,
        strikeFrame: 3,
        swingFrame: 2,
        swings: ['spear-basic-flick'],
        swingPlacement: 'above-characters',
        dispatch: { breaksStealth: true },
        targeting: { target: 'area', targetRangePx: 64, areaShape: step2Shape, maxTargets: 3 },
      },
      {
        clips: { south: 'attack-3-south', west: 'attack-3-west', north: 'attack-3-north', east: 'attack-3-east' },
        cycleFrames: 8,
        strikeFrame: 3,
        swingFrame: 2,
        swings: ['spear-basic-lift'],
        swingPlacement: 'above-characters',
        dispatch: { breaksStealth: true },
        targeting: { target: 'area', targetRangePx: 66, areaShape: step3Shape, maxTargets: 2 },
      },
    ],
  };
}

function buildSpearSkills(): { skillIds: string[]; definitions: Record<string, SkillDefinition>; autoUses: Record<string, { uses: ('damage' | 'control' | 'buff')[] }>; skillSounds: Record<string, string> } {
  const definitions: Record<string, SkillDefinition> = {};

  // 1. 狂龙穿心破：前方直线 72x36px 最多贯穿 2 名敌人 + 破甲减防
  const pierceRates = [2250, 2480, 2720, 3000, 3160, 3320, 3480, 3650];
  const shredRates = [140, 160, 180, 200, 220, 240, 260, 280];
  definitions['dragon-pierce'] = makeActiveSkill({
    id: 'dragon-pierce',
    name: '狂龙穿心破',
    description: '沉腰蓄劲后原地刺出赤金重枪芒，贯穿前方直线上的最多2名敌人并震裂其护甲。',
    normalMaxLevel: 4,
    mana: [38, 40, 42, 45, 47, 49, 51, 54],
    cooldownFrames: 75, // 4.5秒
    pointCosts: [1, 2, 2, 3, 1, 1, 1, 1],
    effectRows: i => [
      detailEffect('（物理攻击力+力量x1.3）x', `${(pierceRates[i]! / 10).toFixed(1)}%`, '0.0%', 0, false),
      detailEffect('目标防御力降低：', `-${(shredRates[i]! / 10).toFixed(1)}%`, '-0.0%', 1, true),
      detailEffect('持续时间：', '6.0秒', '0.0秒', 2, true),
    ],
    action: {
      events: [
        { kind: 'swing', frame: 4, effects: [{ effect: 'spear-heavy-pierce', recipient: 'caster', placement: 'above-characters' }] },
        {
          kind: 'units',
          frame: 5,
          cues: [
            {
              target: 'area',
              targetRangePx: 72,
              areaShape: { kind: 'line', lengthPx: 72, halfWidthPx: 18, backSlackPx: 8 },
              maxTargets: 2,
              targetSelection: 'search',
              effects: [{ effect: 'impact-burst', recipient: 'target', placement: 'above-characters' }],
              sound: 'Weapon_TwoHand_Sword_Critical',
            },
            {
              target: 'area',
              targetRangePx: 72,
              targetSelection: 'reuse-previous',
              effects: [],
            },
          ],
          dispatch: { breaksStealth: true, sound: 'Wa_Anger_Rush' },
        },
      ],
      afterimages: { frame: 4, opacity: 0.55, distancesPx: [6, 12] },
      manaGemDrop: 'skill',
      hitEffectStyle: 'skill',
      cooldownFrames: 75,
      approachDistanceUnits: 7,
      searchRadiusPx: 88,
      transition: null,
      requiresTarget: true,
      usesSkillDamageBuff: true,
      combatUnits: [
        physicalUnit(13, 0, pierceRates),
        {
          effect: 'buff',
          buff: 'armor-break',
          ranks: shredRates.map((rate, idx) => ({
            strength: 1800 + idx,
            chanceThreshold: 1000,
            effect: {
              durationMs: 6000,
              tickMs: 0,
              simulationFrames: { lastActiveFrame: 99 },
              maxStacks: 1,
              states: [],
              modifiers: [
                { attribute: 'defense', operation: { kind: 'decrease-thousandth', ratePerThousand: rate } },
                { attribute: 'physicalResistanceBonus', operation: { kind: 'decrease-thousandth', ratePerThousand: rate } },
              ],
              periodic: [],
            } satisfies BattleBuffEffect,
          })),
        },
      ],
    },
  });

  // 2. 虬龙扫暴阵：F2/F4 双侧枪花（周身 46px）+ F8 190° 狂风大横扫（前方扇形 68px）
  const sweepRates = [920, 1020, 1120, 1240, 1300, 1360, 1420, 1500];
  definitions['whirl-sweep'] = makeActiveSkill({
    id: 'whirl-sweep',
    name: '虬龙扫暴阵',
    description: '双手居中舞出两道真立面双侧枪花逼退近身之敌，紧接抽把掀起180度狂风大横扫。',
    normalMaxLevel: 4,
    requiredInvestedSkillPoints: 4,
    mana: [52, 55, 58, 62, 65, 68, 71, 75],
    cooldownFrames: 100, // 6秒
    pointCosts: [2, 2, 3, 3, 1, 1, 1, 1],
    effectRows: i => [
      detailEffect('每段（物理攻击力+力量+敏捷）x', `${(sweepRates[i]! / 10).toFixed(1)}%`, '0.0%', 0, false),
    ],
    action: {
      events: [
        { kind: 'swing', frame: 0, effects: [{ effect: 'spear-flower-spin', recipient: 'caster', placement: 'above-characters' }] },
        {
          kind: 'units',
          frame: 2,
          cues: [{ target: 'area', targetRangePx: 46, maxTargets: 4, targetSelection: 'search', effects: [], sound: 'Weapon_Dagger_Attack' }],
          dispatch: { breaksStealth: true, sound: 'Wa_Wheel_Wind' },
        },
        {
          kind: 'units',
          frame: 4,
          cues: [{ target: 'area', targetRangePx: 46, maxTargets: 4, targetSelection: 'search', effects: [], sound: 'Weapon_Dagger_Attack' }],
          dispatch: { breaksStealth: true },
        },
        { kind: 'swing', frame: 7, effects: [{ effect: 'spear-gale-sweep', recipient: 'caster', placement: 'above-characters' }] },
        {
          kind: 'units',
          frame: 8,
          cues: [{
            target: 'area',
            targetRangePx: 68,
            areaShape: { kind: 'sector', radiusPx: 68, angleDeg: 190, backSlackPx: 8 },
            maxTargets: 5,
            targetSelection: 'search',
            effects: [{ effect: 'impact-burst', recipient: 'target', placement: 'above-characters' }],
          }],
          dispatch: { breaksStealth: true, sound: 'Weapon_TwoHand_Sword_Attack' },
        },
      ],
      manaGemDrop: 'skill',
      hitEffectStyle: 'skill',
      cooldownFrames: 100,
      approachDistanceUnits: 6,
      searchRadiusPx: 80,
      transition: null,
      requiresTarget: true,
      usesSkillDamageBuff: true,
      combatUnits: [physicalUnit(10, 10, sweepRates)],
    },
  });

  // 3. 旋风枪舞：360° 周身四段旋风斩击（无需先锁目标也可释放）
  const stormRates = [680, 750, 830, 920, 970, 1020, 1070, 1130];
  definitions['spin-storm'] = makeActiveSkill({
    id: 'spin-storm',
    name: '旋风枪舞',
    description: '沉腰抡枪疾旋三整圈，卷起360度冷钢青白刃环与红缨风暴，连续四次重创周身敌人。',
    normalMaxLevel: 3,
    requiredInvestedSkillPoints: 8,
    mana: [64, 68, 72, 76, 80, 84, 88, 92],
    cooldownFrames: 120, // 7.2秒
    pointCosts: [3, 3, 4, 1, 1, 1, 1, 1],
    effectRows: i => [
      detailEffect('每圈（物理攻击力+力量+敏捷x1.2）x', `${(stormRates[i]! / 10).toFixed(1)}%`, '0.0%', 0, false),
    ],
    action: {
      events: [
        { kind: 'caster', frame: 2, effects: [{ effect: 'curse-wind-ring', recipient: 'caster', placement: 'ground' }] },
        { kind: 'swing', frame: 2, effects: [{ effect: 'spear-spin-storm', recipient: 'caster', placement: 'above-characters' }] },
        {
          kind: 'units',
          frame: 3,
          cues: [{ target: 'area', targetRangePx: 58, maxTargets: 5, targetSelection: 'search', effects: [] }],
          dispatch: { breaksStealth: true, sound: 'Wa_Wheel_Wind' },
        },
        {
          kind: 'units',
          frame: 7,
          cues: [{ target: 'area', targetRangePx: 58, maxTargets: 5, targetSelection: 'search', effects: [] }],
          dispatch: { breaksStealth: true, sound: 'Wa_Wheel_Wind' },
        },
        { kind: 'caster', frame: 8, effects: [{ effect: 'curse-wind-ring', recipient: 'caster', placement: 'ground' }] },
        {
          kind: 'units',
          frame: 11,
          cues: [{ target: 'area', targetRangePx: 58, maxTargets: 5, targetSelection: 'search', effects: [] }],
          dispatch: { breaksStealth: true, sound: 'Wa_Wheel_Wind' },
        },
        {
          kind: 'units',
          frame: 14,
          cues: [{ target: 'area', targetRangePx: 66, maxTargets: 5, targetSelection: 'search', effects: [{ effect: 'impact-burst', recipient: 'target', placement: 'above-characters' }] }],
          dispatch: { breaksStealth: true, sound: 'Wa_Storm' },
        },
      ],
      manaGemDrop: 'skill',
      hitEffectStyle: 'skill',
      cooldownFrames: 120,
      approachDistanceUnits: 5,
      searchRadiusPx: 72,
      transition: null,
      requiresTarget: false,
      usesSkillDamageBuff: true,
      combatUnits: [physicalUnit(10, 12, stormRates)],
    },
  });

  // 4. 连环点枪：前两段窄扇形暴雨梨花急刺 + 第三段加长直线定音主刺
  const flurryRates = [950, 1050, 1160, 1280, 1350, 1420, 1490, 1560];
  definitions['flurry-thrust'] = makeActiveSkill({
    id: 'flurry-thrust',
    name: '连环点枪',
    description: '枪尖幻化暴雨梨花扇形寒星连刺两轮，随即缩把蓄劲轰出一记贯穿前方的定音重刺。',
    normalMaxLevel: 4,
    requiredInvestedSkillPoints: 12,
    mana: [56, 60, 64, 68, 72, 76, 80, 84],
    cooldownFrames: 90, // 5.4秒
    pointCosts: [2, 3, 3, 4, 1, 1, 1, 1],
    effectRows: i => [
      detailEffect('每击（物理攻击力+力量x0.6+敏捷x1.4）x', `${(flurryRates[i]! / 10).toFixed(1)}%`, '0.0%', 0, false),
    ],
    action: {
      events: [
        { kind: 'swing', frame: 1, effects: [{ effect: 'spear-flurry-needles', recipient: 'caster', placement: 'above-characters' }] },
        {
          kind: 'units',
          frame: 2,
          cues: [{
            target: 'area',
            targetRangePx: 74,
            areaShape: { kind: 'sector', radiusPx: 74, angleDeg: 92, backSlackPx: 8 },
            maxTargets: 3,
            targetSelection: 'search',
            effects: [],
            sound: 'Weapon_Dagger_Attack',
          }],
          dispatch: { breaksStealth: true },
        },
        {
          kind: 'units',
          frame: 6,
          cues: [{
            target: 'area',
            targetRangePx: 74,
            areaShape: { kind: 'sector', radiusPx: 74, angleDeg: 92, backSlackPx: 8 },
            maxTargets: 3,
            targetSelection: 'search',
            effects: [],
            sound: 'Weapon_Dagger_Attack',
          }],
          dispatch: { breaksStealth: true },
        },
        { kind: 'swing', frame: 11, effects: [{ effect: 'spear-flurry-finisher', recipient: 'caster', placement: 'above-characters' }] },
        {
          kind: 'units',
          frame: 12,
          cues: [{
            target: 'area',
            targetRangePx: 80,
            areaShape: { kind: 'line', lengthPx: 80, halfWidthPx: 20, backSlackPx: 8 },
            maxTargets: 3,
            targetSelection: 'search',
            effects: [{ effect: 'impact-burst', recipient: 'target', placement: 'above-characters' }],
          }],
          dispatch: { breaksStealth: true, sound: 'Weapon_Sword_Critical' },
        },
      ],
      manaGemDrop: 'skill',
      hitEffectStyle: 'skill',
      cooldownFrames: 90,
      approachDistanceUnits: 7,
      searchRadiusPx: 88,
      transition: null,
      requiresTarget: true,
      usesSkillDamageBuff: true,
      combatUnits: [physicalUnit(6, 14, flurryRates)],
    },
  });

  // 5. 伏龙震：双手过顶力劈身前 30px 落点圆 + 范围眩晕
  const slamRates = [2050, 2260, 2480, 2750, 2900, 3050, 3200, 3360];
  const stunFrames = [15, 16, 17, 19, 20, 21, 22, 23]; // (lastActiveFrame+1)*60ms = 0.96s..1.44s -> 保留 2 位小数区分每级成长
  const stunDisplaySec = stunFrames.map(f => (((f + 1) * 60) / 1000).toFixed(2));
  definitions['dragon-slam'] = makeActiveSkill({
    id: 'dragon-slam',
    name: '伏龙震',
    description: '双手高举长枪力劈华山，暗金枪劲轰击身前地面激起裂地冲击环，使落点内敌人陷入眩晕。',
    normalMaxLevel: 4,
    requiredInvestedSkillPoints: 16,
    mana: [58, 62, 66, 70, 74, 78, 82, 86],
    cooldownFrames: 135, // 8.1秒
    pointCosts: [2, 3, 3, 4, 1, 1, 1, 1],
    effectRows: i => [
      detailEffect('（物理攻击力+力量x1.5）x', `${(slamRates[i]! / 10).toFixed(1)}%`, '0.0%', 0, false),
      detailEffect('眩晕时间：', `${stunDisplaySec[i]}秒`, '0.00秒', 1, true),
    ],
    action: {
      events: [
        { kind: 'swing', frame: 3, effects: [{ effect: 'spear-slam-arc', recipient: 'caster', placement: 'above-characters' }] },
        {
          kind: 'units',
          frame: 4,
          cues: [
            {
              target: 'area',
              targetRangePx: 66,
              areaShape: { kind: 'front-circle', forwardOffsetPx: 30, radiusPx: 36 },
              maxTargets: 4,
              targetSelection: 'search',
              effects: [{ effect: 'impact-cross', recipient: 'target', placement: 'above-characters' }],
              sound: 'Wa_Boom',
            },
            {
              target: 'area',
              targetRangePx: 66,
              targetSelection: 'reuse-previous',
              effects: [],
            },
          ],
          dispatch: { breaksStealth: true, shake: true, vibrationMs: 220, sound: 'Wa_Titan_Attack' },
        },
      ],
      manaGemDrop: 'skill',
      hitEffectStyle: 'skill',
      cooldownFrames: 135,
      approachDistanceUnits: 6,
      searchRadiusPx: 80,
      transition: null,
      requiresTarget: true,
      usesSkillDamageBuff: true,
      combatUnits: [
        physicalUnit(15, 0, slamRates),
        {
          effect: 'state',
          state: 'stun',
          ranks: stunFrames.map(lastActiveFrame => ({
            chanceThreshold: 1000,
            durationMs: (lastActiveFrame + 1) * 60,
            stateDurationProfile: {
              normal: { lastActiveFrame },
              targetShortened: { lastActiveFrame: Math.floor(lastActiveFrame / 2) },
            },
          })),
        },
      ],
    },
  });

  // 6. 万圣龙王破：三幕终极奥义 —— 扣地半球护体能量罩 3 段触碰脉冲 + 提枪蓄势 + 东/西/南/北四向全屏蓝金螺旋冲击波 2 段爆发
  const sovereignRates = [1200, 1340, 1500, 1680, 1780, 1880, 1980, 2100];
  definitions['sovereign-pierce'] = makeActiveSkill({
    id: 'sovereign-pierce',
    name: '万圣龙王破',
    description: '双手立枪撑开扣地半球护体能量罩，持续震伤触碰周身之敌，随即顿枪镇地朝东、西、南、北四方齐发全屏蓝金螺旋冲击波。',
    normalMaxLevel: 3,
    requiredInvestedSkillPoints: 24,
    mana: [90, 98, 106, 114, 122, 130, 138, 146],
    cooldownFrames: 200, // 12秒
    pointCosts: [4, 4, 5, 1, 1, 1, 1, 1],
    effectRows: i => [
      detailEffect('每段（物理攻击力+力量x1.6+敏捷x1.2）x', `${(sovereignRates[i]! / 10).toFixed(1)}%`, '0.0%', 0, false),
    ],
    action: {
      events: [
        {
          kind: 'caster',
          frame: 0,
          effects: [
            { effect: 'spear-sovereign-dome-back', recipient: 'caster', placement: 'ground' },
            { effect: 'spear-sovereign-dome', recipient: 'caster', placement: 'above-characters' },
          ],
        },
        { kind: 'feedback', frame: 0, sound: 'Wa_Defense' },
        {
          kind: 'units',
          frame: 3,
          cues: [{
            target: 'area',
            targetRangePx: 56,
            maxTargets: 8,
            targetSelection: 'search',
            effects: [{ effect: 'impact-spark', recipient: 'target', placement: 'above-characters' }],
          }],
          dispatch: { breaksStealth: true, sound: 'Wa_Wheel_Wind' },
        },
        {
          kind: 'units',
          frame: 6,
          cues: [{
            target: 'area',
            targetRangePx: 56,
            maxTargets: 8,
            targetSelection: 'search',
            effects: [{ effect: 'impact-spark', recipient: 'target', placement: 'above-characters' }],
          }],
          dispatch: { breaksStealth: true, sound: 'Wa_Wheel_Wind' },
        },
        {
          kind: 'units',
          frame: 9,
          cues: [{
            target: 'area',
            targetRangePx: 56,
            maxTargets: 8,
            targetSelection: 'search',
            effects: [{ effect: 'impact-spark', recipient: 'target', placement: 'above-characters' }],
          }],
          dispatch: { breaksStealth: true, sound: 'Wa_Wheel_Wind' },
        },
        {
          kind: 'caster',
          frame: 12,
          effects: [{ effect: 'spear-sovereign-charge', recipient: 'caster', placement: 'above-characters' }],
        },
        {
          kind: 'caster',
          frame: 16,
          effects: [
            { effect: 'curse-wind-ring', recipient: 'caster', placement: 'ground' },
            { effect: 'spear-sovereign-beam', recipient: 'caster', placement: 'ground', variant: 'north' },
            { effect: 'spear-sovereign-beam', recipient: 'caster', placement: 'above-characters', variant: 'west' },
            { effect: 'spear-sovereign-beam', recipient: 'caster', placement: 'above-characters', variant: 'east' },
            { effect: 'spear-sovereign-beam', recipient: 'caster', placement: 'above-characters', variant: 'south' },
          ],
        },
        { kind: 'feedback', frame: 16, sound: 'Wa_Storm' },
        {
          kind: 'units',
          frame: 17,
          cues: [{
            target: 'area',
            targetRangePx: 320,
            areaShape: { kind: 'cross', lengthPx: 320, verticalLengthPx: 230, halfWidthPx: 24 },
            maxTargets: 12,
            targetSelection: 'search',
            effects: [{ effect: 'impact-burst', recipient: 'target', placement: 'above-characters' }],
          }],
          dispatch: { breaksStealth: true, shake: true, vibrationMs: 240, sound: 'Wa_Titan_Attack' },
        },
        {
          kind: 'units',
          frame: 19,
          cues: [{
            target: 'area',
            targetRangePx: 320,
            areaShape: { kind: 'cross', lengthPx: 320, verticalLengthPx: 230, halfWidthPx: 24 },
            maxTargets: 12,
            targetSelection: 'search',
            effects: [{ effect: 'impact-burst', recipient: 'target', placement: 'above-characters' }],
          }],
          dispatch: { breaksStealth: true },
        },
      ],
      manaGemDrop: 'skill',
      hitEffectStyle: 'skill',
      cooldownFrames: 200,
      approachDistanceUnits: 0,
      searchRadiusPx: 320,
      transition: null,
      requiresTarget: false,
      usesSkillDamageBuff: true,
      combatUnits: [physicalUnit(16, 12, sovereignRates)],
    },
  });

  // 7. 凝锋（主动增益 1）：技能增伤 + 暴击率（6秒 = 100帧）
  const focusSkillDmg = [160, 195, 230, 270, 295, 320, 345, 370];
  const focusCrit = [80, 100, 120, 145, 160, 175, 190, 205];
  definitions['focus-edge'] = makeActiveSkill({
    id: 'focus-edge',
    name: '凝锋',
    description: '凝神聚气淬炼枪芒，短时间内显著提升技能伤害与暴击率。',
    normalMaxLevel: 4,
    mana: [34, 36, 38, 40, 42, 44, 46, 48],
    cooldownFrames: 250, // 15秒
    pointCosts: [1, 2, 2, 3, 1, 1, 1, 1],
    effectRows: i => [
      detailEffect('技能伤害增加：', `+${(focusSkillDmg[i]! / 10).toFixed(1)}%`, '+0.0%', 0),
      detailEffect('暴击率增加：', `+${(focusCrit[i]! / 10).toFixed(1)}%`, '+0.0%', 1),
      detailEffect('持续时间：', '6.0秒', '0.0秒', 2),
    ],
    action: {
      events: [
        {
          kind: 'units',
          frame: 2,
          cues: [{
            target: 'self',
            targetRangePx: 0,
            targetSelection: 'search',
            effects: [{ effect: 'starburst-gold', recipient: 'caster', placement: 'above-characters' }],
          }],
          dispatch: { breaksStealth: false, sound: 'Wa_Defense' },
        },
        { kind: 'caster', frame: 3, effects: [{ effect: 'flash-gold', recipient: 'caster', placement: 'above-characters' }] },
      ],
      cooldownFrames: 250,
      approachDistanceUnits: 0,
      searchRadiusPx: 64,
      transition: null,
      requiresTarget: false,
      combatUnits: [{
        effect: 'buff',
        buff: 'focus-edge',
        ranks: focusSkillDmg.map((dmg, i) => ({
          strength: 2100 + i,
          chanceThreshold: 1000,
          effect: {
            durationMs: 6000,
            tickMs: 0,
            simulationFrames: { lastActiveFrame: 99 },
            maxStacks: 1,
            appearanceColors: [
              { red: 255, green: 232, blue: 168 },
              { red: 255, green: 214, blue: 122 },
              { red: 255, green: 236, blue: 184 },
              { red: 255, green: 250, blue: 232 },
            ],
            modifiers: [
              { attribute: 'skillDamageBonus', operation: { kind: 'add', amount: dmg } },
              { attribute: 'criticalRate', operation: { kind: 'add', amount: focusCrit[i]! } },
            ],
            states: [],
            periodic: [],
          },
        })),
      }],
    },
  });

  // 8. 游龙步（主动增益 2）：移动速度 + 闪避率（4.8秒~6.0秒）
  const stepMove = [220, 250, 280, 320, 340, 360, 380, 400];
  const stepEvade = [120, 145, 170, 200, 215, 230, 245, 260];
  const stepFrames = [79, 84, 89, 99, 104, 109, 114, 119]; // 4.8s..7.2s
  definitions['dragon-step'] = makeActiveSkill({
    id: 'dragon-step',
    name: '游龙步',
    description: '踏风而行身若游龙，大幅提升移动速度与闪避能力，从容拉扯长枪最佳刺击距离。',
    normalMaxLevel: 4,
    requiredInvestedSkillPoints: 8,
    mana: [32, 34, 36, 38, 40, 42, 44, 46],
    cooldownFrames: 240, // 14.4秒
    pointCosts: [2, 2, 3, 3, 1, 1, 1, 1],
    effectRows: i => [
      detailEffect('移动速度增加：', `+${(stepMove[i]! / 10).toFixed(1)}%`, '+0.0%', 0),
      detailEffect('闪避率增加：', `+${(stepEvade[i]! / 10).toFixed(1)}%`, '+0.0%', 1),
      detailEffect('持续时间：', `${(((stepFrames[i]! + 1) * 60) / 1000).toFixed(1)}秒`, '0.0秒', 2),
    ],
    action: {
      events: [
        {
          kind: 'units',
          frame: 2,
          cues: [{
            target: 'self',
            targetRangePx: 0,
            targetSelection: 'search',
            effects: [{ effect: 'curse-wind-ring', recipient: 'caster', placement: 'ground' }],
          }],
          dispatch: { breaksStealth: false, sound: 'Wa_Wheel_Wind' },
        },
        { kind: 'caster', frame: 6, effects: [{ effect: 'curse-wind-ring', recipient: 'caster', placement: 'ground' }] },
      ],
      cooldownFrames: 240,
      approachDistanceUnits: 0,
      searchRadiusPx: 64,
      transition: null,
      requiresTarget: false,
      combatUnits: [{
        effect: 'buff',
        buff: 'dragon-step',
        ranks: stepMove.map((spd, i) => ({
          strength: 2200 + i,
          chanceThreshold: 1000,
          effect: {
            durationMs: (stepFrames[i]! + 1) * 60,
            tickMs: 0,
            simulationFrames: { lastActiveFrame: stepFrames[i]! },
            maxStacks: 1,
            appearanceColors: [
              { red: 176, green: 242, blue: 255 },
              { red: 138, green: 224, blue: 255 },
              { red: 196, green: 248, blue: 255 },
              { red: 236, green: 252, blue: 255 },
            ],
            modifiers: [
              { attribute: 'moveSpeed', operation: { kind: 'increase-thousandth', ratePerThousand: spd } },
              { attribute: 'evasionBonus', operation: { kind: 'add', amount: stepEvade[i]! } },
            ],
            states: [],
            periodic: [],
          },
        })),
      }],
    },
  });

  // 9. 疾风枪势（主动增益 3）：攻速 + 命中加成（6.0秒~8.4秒）
  const galeSpeed = [240, 280, 320, 370, 395, 420, 445, 470];
  const galeHit = [80, 100, 120, 150, 165, 180, 195, 210];
  const galeFrames = [99, 109, 119, 129, 134, 139, 144, 149]; // 6.0s..9.0s
  definitions['gale-stance'] = makeActiveSkill({
    id: 'gale-stance',
    name: '疾风枪势',
    description: '催动疾风真气缠绕枪身，进入高速连刺架势，大幅提升攻击速度与命中率。',
    normalMaxLevel: 4,
    requiredInvestedSkillPoints: 16,
    mana: [44, 47, 50, 54, 57, 60, 63, 66],
    cooldownFrames: 300, // 18秒
    pointCosts: [2, 3, 3, 4, 1, 1, 1, 1],
    effectRows: i => [
      detailEffect('攻击速度增加：', `+${(galeSpeed[i]! / 10).toFixed(1)}%`, '+0.0%', 0),
      detailEffect('命中率增加：', `+${(galeHit[i]! / 10).toFixed(1)}%`, '+0.0%', 1),
      detailEffect('持续时间：', `${(((galeFrames[i]! + 1) * 60) / 1000).toFixed(1)}秒`, '0.0秒', 2),
    ],
    action: {
      events: [
        {
          kind: 'units',
          frame: 2,
          cues: [{
            target: 'self',
            targetRangePx: 0,
            targetSelection: 'search',
            effects: [{ effect: 'aura-ring', recipient: 'caster', placement: 'ground' }],
          }],
          dispatch: { breaksStealth: false, sound: 'Wa_Storm' },
        },
        { kind: 'caster', frame: 4, effects: [{ effect: 'curse-wind-ring', recipient: 'caster', placement: 'above-characters' }] },
      ],
      cooldownFrames: 300,
      approachDistanceUnits: 0,
      searchRadiusPx: 64,
      transition: null,
      requiresTarget: false,
      combatUnits: [{
        effect: 'buff',
        buff: 'gale-stance',
        ranks: galeSpeed.map((spd, i) => ({
          strength: 2300 + i,
          chanceThreshold: 1000,
          effect: {
            durationMs: (galeFrames[i]! + 1) * 60,
            tickMs: 0,
            simulationFrames: { lastActiveFrame: galeFrames[i]! },
            maxStacks: 1,
            appearanceColors: [
              { red: 198, green: 236, blue: 255 },
              { red: 164, green: 220, blue: 255 },
              { red: 218, green: 244, blue: 255 },
              { red: 242, green: 250, blue: 255 },
            ],
            modifiers: [
              { attribute: 'attackSpeedRate', operation: { kind: 'add', amount: spd } },
              { attribute: 'hitBonus', operation: { kind: 'add', amount: galeHit[i]! } },
            ],
            states: [],
            periodic: [],
          },
        })),
      }],
    },
  });

  // 10~15：第三列 6 项长枪专属被动技能
  const masteryAtk = [60, 85, 110, 140, 160, 180, 200, 220];
  const masteryHit = [35, 50, 65, 85, 95, 105, 115, 125];
  definitions['spear-mastery'] = makePassiveSkill({
    id: 'spear-mastery',
    name: '长枪专精',
    description: '精通长杆兵器的发力要诀。主手佩带长枪时，常驻提升物理攻击力与命中率。',
    normalMaxLevel: 4,
    pointCosts: [1, 2, 2, 3, 1, 1, 1, 1],
    effectRows: i => [
      detailEffect('物理攻击力增加：', `+${(masteryAtk[i]! / 10).toFixed(1)}%`, '+0.0%', 0),
      detailEffect('命中率增加：', `+${(masteryHit[i]! / 10).toFixed(1)}%`, '+0.0%', 1),
    ],
    passiveUnits: [
      { attribute: 'physicalAttack', condition: 'weapon-spear', ranks: masteryAtk.map(ratePerThousand => ({ kind: 'increase-thousandth', ratePerThousand })) },
      { attribute: 'hitBonus', condition: 'weapon-spear', ranks: masteryHit.map(amount => ({ kind: 'add', amount })) },
    ],
  });

  const reachUnits = [1, 1, 1, 2, 2, 2, 2, 2];
  const reachCrit = [30, 45, 60, 75, 85, 95, 105, 120];
  definitions['polearm-reach'] = makePassiveSkill({
    id: 'polearm-reach',
    name: '一寸长',
    description: '发挥长枪修长枪杆的控距优势。佩带长枪时进一步拓展攻击与招式判定距离，并提升暴击率。',
    normalMaxLevel: 4,
    requiredInvestedSkillPoints: 4,
    pointCosts: [2, 2, 3, 3, 1, 1, 1, 1],
    effectRows: i => [
      detailEffect('长枪攻击距离增加：', `+${reachUnits[i]! * 8}像素`, '+0像素', 0),
      detailEffect('暴击率增加：', `+${(reachCrit[i]! / 10).toFixed(1)}%`, '+0.0%', 1),
    ],
    passiveUnits: [
      { attribute: 'attackRangeBonusUnits', condition: 'weapon-spear', ranks: reachUnits.map(amount => ({ kind: 'add', amount })) },
      { attribute: 'criticalRate', condition: 'weapon-spear', ranks: reachCrit.map(amount => ({ kind: 'add', amount })) },
    ],
  });

  const parryBlock = [45, 65, 85, 110, 125, 140, 155, 170];
  const parryRes = [25, 40, 55, 75, 85, 95, 105, 115];
  definitions['shaft-parry'] = makePassiveSkill({
    id: 'shaft-parry',
    name: '铁杆卸力',
    description: '以坚韧枪杆拨卸敌方兵刃冲击，常驻提升武器格挡率与物理抗性。',
    normalMaxLevel: 4,
    requiredInvestedSkillPoints: 8,
    pointCosts: [2, 2, 3, 3, 1, 1, 1, 1],
    effectRows: i => [
      detailEffect('武器格挡率增加：', `+${(parryBlock[i]! / 10).toFixed(1)}%`, '+0.0%', 0),
      detailEffect('物理抗性增加：', `+${(parryRes[i]! / 10).toFixed(1)}%`, '+0.0%', 1),
    ],
    passiveUnits: [
      { attribute: 'weaponBlock', condition: 'always', ranks: parryBlock.map(amount => ({ kind: 'add', amount })) },
      { attribute: 'physicalResistanceBonus', condition: 'always', ranks: parryRes.map(amount => ({ kind: 'add', amount })) },
    ],
  });

  const critDmg = [150, 220, 290, 380, 430, 480, 530, 580];
  const armorBreakChance = [50, 70, 90, 120, 135, 150, 165, 180];
  definitions['piercing-momentum'] = makePassiveSkill({
    id: 'piercing-momentum',
    name: '穿甲枪劲',
    description: '将螺旋暗劲灌入枪尖锋脊，大幅提升暴击伤害，并令物理攻击有几率附加破甲。',
    normalMaxLevel: 4,
    requiredInvestedSkillPoints: 12,
    pointCosts: [2, 3, 3, 4, 1, 1, 1, 1],
    effectRows: i => [
      detailEffect('暴击伤害增加：', `+${(critDmg[i]! / 10).toFixed(1)}%`, '+0.0%', 0),
      detailEffect('物理攻击破甲几率：', `+${(armorBreakChance[i]! / 10).toFixed(1)}%`, '+0.0%', 1),
    ],
    passiveUnits: [
      { attribute: 'criticalDamage', condition: 'always', ranks: critDmg.map(amount => ({ kind: 'add', amount })) },
      { attribute: 'armorBreakChance', condition: 'always', ranks: armorBreakChance.map(amount => ({ kind: 'add', amount })) },
    ],
    reactionsByRank: Array.from({ length: 8 }, (_, idx) => [
      {
        kind: 'armor-penetration',
        buff: {
          key: 'armor-break',
          rankPriority: 1900 + idx,
          effect: {
            durationMs: 3660,
            tickMs: 0,
            states: [],
            simulationFrames: { lastActiveFrame: 60 },
            maxStacks: 1,
            applicationEffect: 'armor-break-impact',
            modifiers: [
              { attribute: 'defense', operation: { kind: 'multiply-thousandth', ratePerThousand: 0 } },
              { attribute: 'physicalResistanceBonus', operation: { kind: 'multiply-thousandth', ratePerThousand: 0 } },
            ],
            periodic: [],
          } satisfies BattleBuffEffect,
        },
      },
    ]),
  });

  const footworkEvade = [40, 60, 80, 105, 120, 135, 150, 165];
  const footworkCritRes = [40, 60, 80, 100, 115, 130, 145, 160];
  definitions['coiling-dragon-footwork'] = makePassiveSkill({
    id: 'coiling-dragon-footwork',
    name: '游龙身法',
    description: '枪随身转、步踏九宫，常驻提升闪避率与暴击抗性。',
    normalMaxLevel: 4,
    requiredInvestedSkillPoints: 16,
    pointCosts: [2, 3, 3, 4, 1, 1, 1, 1],
    effectRows: i => [
      detailEffect('闪避率增加：', `+${(footworkEvade[i]! / 10).toFixed(1)}%`, '+0.0%', 0),
      detailEffect('暴击抗性增加：', `+${(footworkCritRes[i]! / 10).toFixed(1)}%`, '+0.0%', 1),
    ],
    passiveUnits: [
      { attribute: 'evasionBonus', condition: 'always', ranks: footworkEvade.map(amount => ({ kind: 'add', amount })) },
      { attribute: 'criticalResistance', condition: 'always', ranks: footworkCritRes.map(amount => ({ kind: 'add', amount })) },
    ],
  });

  const spiritSkillDmg = [60, 90, 125, 165, 190, 215, 240, 270];
  const spiritMana = [4, 6, 8, 11, 13, 15, 17, 20];
  definitions['dragon-spirit'] = makePassiveSkill({
    id: 'dragon-spirit',
    name: '龙魂战意',
    description: '体内奔涌不息的龙枪战意，常驻提升全部技能伤害与自然魔法恢复量。',
    normalMaxLevel: 4,
    requiredInvestedSkillPoints: 20,
    pointCosts: [3, 3, 4, 4, 1, 1, 1, 1],
    effectRows: i => [
      detailEffect('技能伤害增加：', `+${(spiritSkillDmg[i]! / 10).toFixed(1)}%`, '+0.0%', 0),
      detailEffect('魔法恢复量增加：', `+${spiritMana[i]}`, '+0', 1),
    ],
    passiveUnits: [
      { attribute: 'skillDamageBonus', condition: 'always', ranks: spiritSkillDmg.map(amount => ({ kind: 'add', amount })) },
      { attribute: 'manaRecoveryPerPulse', condition: 'always', ranks: spiritMana.map(amount => ({ kind: 'add', amount })) },
    ],
  });

  const skillIds = [
    // 列 0：6 项主动攻击技
    'dragon-pierce',
    'whirl-sweep',
    'spin-storm',
    'flurry-thrust',
    'dragon-slam',
    'sovereign-pierce',
    // 列 1：3 项主动增益技
    'focus-edge',
    'dragon-step',
    'gale-stance',
    // 列 2：6 项被动技
    'spear-mastery',
    'polearm-reach',
    'shaft-parry',
    'piercing-momentum',
    'coiling-dragon-footwork',
    'dragon-spirit',
  ];

  const autoUses: Record<string, { uses: ('damage' | 'control' | 'buff')[] }> = {
    'dragon-pierce': { uses: ['damage'] },
    'whirl-sweep': { uses: ['damage'] },
    'spin-storm': { uses: ['damage'] },
    'flurry-thrust': { uses: ['damage'] },
    'dragon-slam': { uses: ['damage', 'control'] },
    'sovereign-pierce': { uses: ['damage'] },
    'focus-edge': { uses: ['buff'] },
    'dragon-step': { uses: ['buff'] },
    'gale-stance': { uses: ['buff'] },
  };

  const skillSounds: Record<string, string> = {
    'dragon-pierce': 'Wa_Anger_Rush',
    'whirl-sweep': 'Wa_Wheel_Wind',
    'spin-storm': 'Wa_Storm',
    'flurry-thrust': 'Weapon_Sword_Critical',
    'dragon-slam': 'Wa_Titan_Attack',
    'sovereign-pierce': 'Wa_Storm',
    'focus-edge': 'Wa_Defense',
    'dragon-step': 'Wa_Wheel_Wind',
    'gale-stance': 'Wa_Storm',
  };

  return { skillIds, definitions, autoUses, skillSounds };
}

function buildWeaponItemsAndStats(statsTemplate: EquipmentNumbers): {
  items: Record<string, ItemDefinition>;
  stats: Record<string, EquipmentNumbers>;
} {
  const mkStats = (baseAttack: number, crit: number, hit: number, uses: [number, number], optRange: number): EquipmentNumbers => ({
    attack: baseAttack,
    defense: 0,
    gradeVariants: statsTemplate.gradeVariants?.map(v => ({
      ...v,
      attack: Math.max(1, Math.round((v.attack / Math.max(1, statsTemplate.attack)) * baseAttack)),
      defense: 0,
    })),
    defaultRarity: 0,
    gradeName: '',
    defaultGrade: 2,
    magicPercent: [80, 85],
    criticalRate: crit,
    hitBonus: hit,
    magicAttackRate: 0,
    shieldBlock: 0,
    fixedOptions: [],
    randomOptions: [
      { stat: 'strength', min: 1, max: optRange },
      { stat: 'dexterity', min: 1, max: optRange },
      { stat: 'vitality', min: 1, max: optRange },
      { stat: 'criticalRate', min: 10, max: 18 + optRange * 4 },
      { stat: 'hitBonus', min: 8, max: 16 + optRange * 3 },
    ],
    optionCount: 0,
    socketLimit: 4,
    fixedEnhancementUses: null,
    enhancementUses: uses,
  });

  const groundSprite = {
    file: 'assets/items/ground/spear.png',
    width: 14,
    height: 14,
    anchorX: 7,
    anchorY: 7,
  };

  const items: Record<string, ItemDefinition> = {
    'basic-spear': {
      name: '红缨铁枪',
      description: '白蜡硬木为杆、百炼精铁为锋的制式红缨长枪，轻重均衡，最宜施展穿刺与横扫枪法。',
      descriptionParts: [],
      category: 'equipment',
      kind: 'spear',
      typeName: '长枪',
      icon: 'assets/ui/items/spear-basic.png',
      groundSprite,
      stackable: false,
      discardable: true,
      sellable: true,
      priceKind: 'weapon',
      pricePremium: false,
      shortcut: false,
      level: 1,
      basePrice: 0,
      storeListed: false,
      equipment: {
        slot: 'main-hand',
        classes: [CLASS_ID],
        twoHanded: true,
        dualWield: false,
        locked: false,
        socketCapacity: 3,
        enchantable: true,
        description: { showEnhancementUses: true, classAttributes: [], attackSpeed: '普通' },
      },
    },
    'dragon-fang-spear': {
      name: '龙牙长枪',
      description: '以北境古龙獠牙与寒星秘银锻造的名枪，枪出如苍龙破渊。（调试模式测试武器）',
      descriptionParts: [],
      category: 'equipment',
      kind: 'spear',
      typeName: '长枪',
      icon: 'assets/ui/items/spear-dragon-fang.png',
      groundSprite,
      stackable: false,
      discardable: true,
      sellable: true,
      priceKind: 'weapon',
      pricePremium: true,
      shortcut: false,
      level: 30,
      basePrice: 12000,
      storeListed: false,
      equipment: {
        slot: 'main-hand',
        classes: [CLASS_ID],
        twoHanded: true,
        dualWield: false,
        locked: false,
        socketCapacity: 4,
        enchantable: true,
        description: { showEnhancementUses: true, classAttributes: [], attackSpeed: '普通' },
      },
    },
  };

  return {
    items,
    stats: {
      'basic-spear': mkStats(10, 35, 30, [1, 2], 1),
      'dragon-fang-spear': mkStats(96, 55, 45, [4, 7], 6),
    },
  };
}

// ---------------------------------------------------------------------------
// 主流程：生成素材并幂等写入全部内容 JSON
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const wardrobe = readJson<WardrobeCatalog>('wardrobe.json');
  const battle = readJson<BattleCatalog>('battle.json');
  const items = readJson<ItemCatalog>('items.json');
  const stats = readJson<CharacterStatsCatalog>('character-stats.json');
  const storyClasses = readJson<StoryClassCatalog>('story-classes.json');
  const menuPanels = readJson<MenuPanels>('menu-panels.json');
  const statusHud = readJson<StatusHudSkin>('status-hud.json');
  const companions = readJson<CompanionCatalog>('companions.json');
  const audio = readJson<Record<string, any>>('audio.json');

  // 1. 打包长枪切片图集页 parts-2.png 并更新 wardrobe
  const { png: parts2Png, sprites: spearSprites, variants: spearVariants } = buildWardrobePartsSheet();
  wardrobe.textures = wardrobe.textures.filter(t => t.key !== WARDROBE_TEXTURE_KEY);
  wardrobe.textures.push({ key: WARDROBE_TEXTURE_KEY, file: WARDROBE_TEXTURE_FILE });
  for (const key of Object.keys(wardrobe.sprites)) {
    if (key.startsWith('spear-s1-') || key.startsWith('spear-s2-')) delete wardrobe.sprites[key];
  }
  Object.assign(wardrobe.sprites, spearSprites);
  Object.assign(wardrobe.variants, spearVariants);
  wardrobe.equipment['basic-spear'] = { main: { spear: 'spear-style-1' }, offHand: {} };
  wardrobe.equipment['dragon-fang-spear'] = { main: { spear: 'spear-style-2' }, offHand: {} };

  const { poses: spearPoses, weaponStance, skillPoses } = buildFormalSpearPoses(wardrobe);
  for (const key of Object.keys(wardrobe.poses)) {
    if (key.startsWith('spear-')) delete wardrobe.poses[key];
  }
  Object.assign(wardrobe.poses, spearPoses);
  wardrobe.stances['spear:empty'] = weaponStance as WardrobeCatalog['stances'][string];
  wardrobe.skills[CLASS_ID] = skillPoses as WardrobeCatalog['skills'][string];

  const spearBasicAttack = buildSpearBasicAttack();
  wardrobe.attacks['spear:empty'] = spearBasicAttack;
  wardrobe.frenzyAttacks ??= {};
  wardrobe.frenzyAttacks['spear:empty'] = {
    clips: {
      south: 'frenzy-spear-south',
      west: 'frenzy-spear-west',
      north: 'frenzy-spear-north',
      east: 'frenzy-spear-east',
    },
    damage: {
      effect: 'physical',
      source: 'physicalAttack',
      attributeWeights: { strength: 0, dexterity: 0, vitality: 0, intelligence: 0, mentality: 0 },
      ranks: [{ fixedAddition: 0, operation: { kind: 'add', amount: 0 } }],
    },
    dispatch: { breaksStealth: true },
    timing: 'fixed-animation',
    targeting: {
      target: 'area',
      targetRangePx: 56,
      targetRangeMetric: 'octagonal-grid',
      areaShape: { kind: 'sector', radiusPx: 56, angleDeg: 180, backSlackPx: 8 },
      maxTargets: 4,
    },
    manaGemDrop: 'weapon',
    frameDurationMs: 60,
    cycleFrames: 12,
    approachDistanceUnits: 6,
    searchRadiusPx: 80,
    strikeFrame: 4,
    swingFrame: 3,
    swings: ['spear-basic-flick'],
    swingPlacement: 'above-characters',
    impacts: ['impact-spark', 'impact-flash', 'impact-burst', 'impact-cross', 'impact-scatter'],
    impactPlacement: 'attached',
    projectile: null,
  };

  // 2. 导出战斗特效条图 + 生成 UI/技能/物品图标 + 离线合成角色长条图
  const spearAttackEffects = buildBattleEffects();
  buildClassBadgeAndPortraits();
  buildWeaponIcons();
  await buildSkillAndBuffIcons();
  const { previewActor, battleActor, playerActor } = buildCharacterActors(wardrobe, parts2Png, weaponStance, skillPoses);

  // 3. 更新 battle.json
  for (const key of Object.keys(battle.attackEffects)) {
    if (key.startsWith('spear-')) delete battle.attackEffects[key];
  }
  Object.assign(battle.attackEffects, spearAttackEffects);
  battle.basicAttacks['spear-thrust'] = structuredClone(spearBasicAttack);

  const { skillIds, definitions: spearSkills, autoUses, skillSounds } = buildSpearSkills();
  Object.assign(battle.skills, spearSkills);

  const classAttributes = [
    { name: '力量', value: 12 },
    { name: '敏捷', value: 13 },
    { name: '体力', value: 11 },
    { name: '智力', value: 5 },
    { name: '精力', value: 6 },
  ];
  battle.classes = battle.classes.filter(c => c.id !== CLASS_ID);
  battle.classes.push({
    id: CLASS_ID,
    name: CLASS_NAME,
    description: CLASS_DESCRIPTION,
    preview: 'assets/characters/battle-lancer/preview.png',
    actor: battleActor,
    attributes: classAttributes,
    skills: skillIds,
    basicAttack: {
      profileId: 'spear-thrust',
      clips: { south: 'attack-south', west: 'attack-west', north: 'attack-north', east: 'attack-east' },
    },
  });

  // 4. 更新 items.json 与 character-stats.json
  const formalSixIds = ['dark-knight', 'assassin', 'warlock', 'priest', 'ranger', 'warrior'];
  const weaponData = buildWeaponItemsAndStats(stats.equipment['basic-greatsword']!);
  Object.assign(items.items, weaponData.items);

  // 原版六职业通用的防具/首饰/披风/盾牌同步开放给 lancer 穿戴，保持「全部职业」显示一致
  for (const item of Object.values(items.items)) {
    if (!item.equipment || item.equipment.slot === 'main-hand') continue;
    const classes = item.equipment.classes;
    if (formalSixIds.every(id => classes.includes(id)) && !classes.includes(CLASS_ID)) {
      classes.push(CLASS_ID);
    }
  }
  const manaGemThresholds = items.items['mana-gem']?.pickup?.hitDrop?.weaponThresholds;
  if (manaGemThresholds) manaGemThresholds.spear = 85;

  items.startingEquipment[CLASS_ID] = { 'main-hand': 'basic-spear' };
  items.classSkills[CLASS_ID] = skillIds;
  if (items.skillDescriptions) {
    for (const id of skillIds) {
      items.skillDescriptions[id] = { name: spearSkills[id]!.name, className: CLASS_NAME };
    }
  }

  stats.classes[CLASS_ID] = { strength: 12, dexterity: 13, vitality: 11, intelligence: 5, mentality: 6 };
  Object.assign(stats.equipment, weaponData.stats);
  for (const scrollRules of Object.values(stats.enchantments)) {
    if (scrollRules['two-handed']) {
      scrollRules.spear = structuredClone(scrollRules['two-handed']);
    }
  }

  // 5. 更新 story-classes.json（标记 debugOnly: true，仅调试模式新游戏可见）
  const storyClassEntry: StoryClass = {
    id: CLASS_ID,
    name: CLASS_NAME,
    description: CLASS_DESCRIPTION,
    icon: 'assets/ui/story-classes/lancer.png',
    debugOnly: true,
    attributes: classAttributes,
    previewActor,
    playerActor,
    player: {
      level: 1,
      health: 960,
      maxHealth: 960,
      mana: 200,
      maxMana: 200,
      experience: 0,
      nextLevelExperience: 12802,
    },
  };
  storyClasses.classes = storyClasses.classes.filter(c => c.id !== CLASS_ID);
  storyClasses.classes.push(storyClassEntry);

  // 6. 更新 menu-panels.json、status-hud.json、companions.json、audio.json
  menuPanels.assets[`party-class-${CLASS_ID}`] = `assets/ui/menus/party-class-${CLASS_ID}.png`;
  menuPanels.classes[CLASS_ID] = { preview: 'assets/characters/battle-lancer/preview.png' };
  menuPanels.character.classPortraits[CLASS_ID] = `assets/ui/menus/class-${CLASS_ID}.png`;

  statusHud.buffIcons.catalog['focus-edge'] = 'assets/ui/status/buff-focus-edge.png';
  statusHud.buffIcons.catalog['dragon-step'] = 'assets/ui/status/buff-dragon-step.png';
  statusHud.buffIcons.catalog['gale-stance'] = 'assets/ui/status/buff-gale-stance.png';

  Object.assign(companions.autoSkills, autoUses);

  audio.combat.weapons.spear = {
    normal: [
      { sound: 'Weapon_Sword_Attack', weight: 5 },
      { sound: 'Weapon_TwoHand_Sword_Attack', weight: 5 },
    ],
    critical: 'Weapon_TwoHand_Sword_Critical',
    miss: 'Weapon_TwoHand_Sword_Miss',
    blocked: 'Weapon_Punch',
  };
  Object.assign(audio.skills, skillSounds);

  // 保持与原仓库一致的 JSON 格式（5 份大型内容表用单行紧凑 JSON，其余小型配置用 2 空格缩进）
  writeJson('wardrobe.json', wardrobe, false);
  writeJson('story-classes.json', storyClasses, false);
  writeJson('battle.json', battle, false);
  writeJson('items.json', items, false);
  writeJson('character-stats.json', stats, false);
  writeJson('menu-panels.json', menuPanels, true);
  writeJson('status-hud.json', statusHud, true);
  writeJson('companions.json', companions, true);
  writeJson('audio.json', audio, true);

  console.log(
    `长枪职业构建完成：parts-2 (${parts2Png.width}x${parts2Png.height})，` +
    `${Object.keys(spearPoses).length} 组姿态，${Object.keys(spearAttackEffects).length} 套战斗特效，15 项技能。`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

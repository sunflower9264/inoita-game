#!/usr/bin/env node
/**
 * 动画样板一键像素级体检脚本（支持任意武器/职业 PrototypeWeaponBundle）。
 *
 * 用法：
 *   node .agents/skills/character-animation-craft/scripts/inspect-animation-quality.ts \
 *     --prototype tools/warrior-viewer/prototypes/spear/spear-prototype.json [--verbose]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { PNG as PngType } from 'pngjs';
import type { CostumePart, CostumePiece, CostumePose, WardrobeCatalog } from '../../../../src/domain/wardrobe.ts';
import type { Facing } from '../../../../src/domain/content.ts';
import type { PrototypeWeaponBundle } from '../../../../tools/warrior-viewer/model.ts';

interface Finding {
  level: 'fail' | 'warn';
  category: string;
  message: string;
}

const DIRECTIONS: readonly Facing[] = ['south', 'west', 'north', 'east'];
const WALKING_LEG_PIECES = new Set([7, 8, 9, 10]);
const EXPECTED_FACE_FOR_HEAD: Record<number, number> = { 0: 0, 1: 1, 2: 2, 3: 3, 4: 0, 5: 1 };
const NON_TURNING_HEAD_BY_FACING: Record<Facing, ReadonlySet<number>> = {
  south: new Set([0, 4]),
  west: new Set([1, 5]),
  north: new Set([3]),
  east: new Set([1, 5]),
};
const MAX_WEBGL_TEXTURE = 4096;

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

function parseArgs(argv: readonly string[]): { prototypePath: string; verbose: boolean } {
  let prototypePath = '';
  let verbose = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--prototype' || arg === '-p') {
      prototypePath = argv[++i] ?? '';
    } else if (arg === '--verbose' || arg === '-v') {
      verbose = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log('用法: node inspect-animation-quality.ts --prototype <path-to-prototype.json> [--verbose]');
      process.exit(0);
    }
  }
  if (!prototypePath) {
    throw new Error('缺少 --prototype 参数，例如：--prototype tools/warrior-viewer/prototypes/spear/spear-prototype.json');
  }
  return { prototypePath: path.resolve(prototypePath), verbose };
}

function resolveTextureFile(repoRoot: string, protoDir: string, file: string): string {
  const fromProto = path.join(protoDir, path.basename(file));
  if (fs.existsSync(fromProto)) return fromProto;
  const fromRepo = path.join(repoRoot, file);
  if (fs.existsSync(fromRepo)) return fromRepo;
  throw new Error(`找不到纹理文件：${file}（已检查 ${fromProto} 与 ${fromRepo}）`);
}

function isArmPart(part: CostumePart): boolean {
  return part.part === 'coat-front' && part.piece >= 3 && part.piece <= 14;
}

function facingFromClip(clip: string): Facing | undefined {
  for (const dir of DIRECTIONS) {
    if (clip.endsWith(`-${dir}`)) return dir;
  }
  return undefined;
}

function actionKeyFromClip(clip: string): string {
  return clip.replace(/-(south|west|north|east)$/, '');
}

function isCombatAction(actionKey: string): boolean {
  if (actionKey === 'idle' || actionKey === 'walk' || actionKey.startsWith('town-')) return false;
  if (actionKey.endsWith('-idle') || actionKey.endsWith('-walk') || actionKey.endsWith('-die') || actionKey === 'die') return false;
  return true;
}

function isSpinAction(actionKey: string): boolean {
  return actionKey.includes('spin');
}

function countReversals(values: readonly number[]): number {
  let reversals = 0;
  let prevSign = 0;
  for (let i = 1; i < values.length; i++) {
    const diff = values[i]! - values[i - 1]!;
    if (diff === 0) continue;
    const sign = diff > 0 ? 1 : -1;
    if (prevSign !== 0 && sign !== prevSign) reversals++;
    prevSign = sign;
  }
  return reversals;
}

function resolveFramePieces(
  sprites: Record<string, CostumePiece>,
  variants: Record<string, (string | null)[]>,
  activeVariants: Record<string, string | undefined>,
  frame: readonly CostumePart[],
): { part: CostumePart; sprite: CostumePiece; missing?: string }[] {
  const result: { part: CostumePart; sprite: CostumePiece; missing?: string }[] = [];
  for (const part of frame) {
    const variantId = activeVariants[part.part];
    if (!variantId) continue;
    const list = variants[variantId];
    const spriteKey = list?.[part.piece];
    if (!spriteKey) {
      result.push({ part, sprite: { texture: '', x: 0, y: 0, width: 0, height: 0, anchorX: 0, anchorY: 0 }, missing: `${part.part}:${variantId}[${part.piece}]` });
      continue;
    }
    const sprite = sprites[spriteKey];
    if (!sprite) {
      result.push({ part, sprite: { texture: '', x: 0, y: 0, width: 0, height: 0, anchorX: 0, anchorY: 0 }, missing: `sprite:${spriteKey}` });
      continue;
    }
    result.push({ part, sprite });
  }
  return result;
}

function collectWorldPixels(part: CostumePart, sprite: CostumePiece, png: PngType, alphaThreshold = 40): [number, number][] {
  const pts: [number, number][] = [];
  const rad = (part.angle * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  for (let sy = 0; sy < sprite.height; sy++) {
    for (let sx = 0; sx < sprite.width; sx++) {
      const alpha = png.data[((sprite.y + sy) * png.width + (sprite.x + sx)) * 4 + 3]!;
      if (alpha <= alphaThreshold) continue;
      const lx = (sx - sprite.anchorX) * part.scaleX;
      const ly = (sy - sprite.anchorY) * part.scaleY;
      pts.push([part.x + lx * cos - ly * sin, part.y + lx * sin + ly * cos]);
    }
  }
  return pts;
}

function main(): void {
  const { prototypePath, verbose } = parseArgs(process.argv.slice(2));
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = findRepoRoot(scriptDir);
  const require = createRequire(path.join(repoRoot, 'package.json'));
  const { PNG } = require('pngjs') as typeof import('pngjs');

  const protoDir = path.dirname(prototypePath);
  const proto = JSON.parse(fs.readFileSync(prototypePath, 'utf8')) as PrototypeWeaponBundle;
  const wardrobe = JSON.parse(fs.readFileSync(path.join(repoRoot, 'public/content/wardrobe.json'), 'utf8')) as WardrobeCatalog;

  const findings: Finding[] = [];
  const fail = (category: string, message: string) => findings.push({ level: 'fail', category, message });
  const warn = (category: string, message: string) => findings.push({ level: 'warn', category, message });

  const mergedSprites: Record<string, CostumePiece> = { ...wardrobe.sprites, ...proto.sprites };
  const mergedVariants: Record<string, (string | null)[]> = { ...wardrobe.variants, ...proto.variants };
  const mergedPoses: Record<string, CostumePose> = { ...wardrobe.poses, ...proto.poses };

  // 加载纹理
  const textures = new Map<string, PngType>();
  for (const tex of wardrobe.textures) {
    const abs = path.join(repoRoot, 'public', tex.file);
    if (fs.existsSync(abs)) textures.set(tex.key, PNG.sync.read(fs.readFileSync(abs)));
  }
  const partsFile = resolveTextureFile(repoRoot, protoDir, proto.texture.file);
  const partsPng = PNG.sync.read(fs.readFileSync(partsFile));
  textures.set(proto.texture.key, partsPng);

  // 1. 武器切片越界与正向顶光检查（严禁 scaleY < 0）
  if (partsPng.width > MAX_WEBGL_TEXTURE || partsPng.height > MAX_WEBGL_TEXTURE) {
    fail('纹理尺寸', `武器切片图 ${partsPng.width}x${partsPng.height} 超出 WebGL ${MAX_WEBGL_TEXTURE}px 上限`);
  }
  for (const [key, sp] of Object.entries(proto.sprites)) {
    if (sp.x < 0 || sp.y < 0 || sp.x + sp.width > partsPng.width || sp.y + sp.height > partsPng.height) {
      fail('切片越界', `切片 ${key} 矩形 (${sp.x},${sp.y},${sp.width}x${sp.height}) 超出图集 ${partsPng.width}x${partsPng.height}`);
    }
  }
  for (const [poseId, pose] of Object.entries(proto.poses)) {
    pose.frames.forEach((frame, fi) => {
      for (const part of frame) {
        if (part.part === proto.partName && part.scaleY < 0) {
          fail('顶光破坏', `${poseId} F${fi} 武器部件 ${proto.partName}[${part.piece}] 使用了 scaleY=${part.scaleY}（破坏顶光与重力一致）`);
        }
      }
    });
  }

  // 2. 肢体干净度（零旋转手臂 / 零猫背胸甲 / 零头顶悬空手 / 非行走零走路腿）
  for (const [clip, poseId] of Object.entries(proto.stancePoses)) {
    const pose = mergedPoses[poseId];
    if (!pose || !pose.frames.length) {
      fail('姿态缺失', `stancePoses[${clip}] -> ${poseId} 不存在或为空`);
      continue;
    }
    const actionKey = actionKeyFromClip(clip);
    if (actionKey.endsWith('-die') || actionKey === 'die') continue;
    const isWalk = actionKey === 'walk' || actionKey === 'town-walk' || actionKey.endsWith('-walk');
    const facing = facingFromClip(clip);

    pose.frames.forEach((frame, fi) => {
      for (const part of frame) {
        if (part.part === 'coat-front') {
          if (part.angle !== 0) {
            fail('手臂异常', `${clip} (${poseId}) F${fi} coat-front[${part.piece}] 存在旋转手臂 angle=${part.angle}`);
          }
          if ((facing === 'west' || facing === 'east') && part.piece === 15) {
            fail('躯干异常', `${clip} (${poseId}) F${fi} 混入刺客猫背胸甲 coat-front[15]`);
          }
          if (part.piece === 5 && part.y < -30) {
            fail('手臂异常', `${clip} (${poseId}) F${fi} 混入头顶悬空臂 coat-front[5] (y=${part.y})`);
          }
        }
        if (!isWalk && (facing === 'west' || facing === 'east') && part.part === 'coat-back' && WALKING_LEG_PIECES.has(part.piece)) {
          fail('下盘异常', `${clip} (${poseId}) F${fi} 非行走招式混入走路腿 coat-back[${part.piece}]`);
        }
      }
    });
  }

  // 3. 多套盔甲 / 头饰 / 无披风佣兵兼容抽样
  const coatFrontVariants = Object.keys(wardrobe.variants).filter(k => k.startsWith('coat-front-style-')).slice(0, 4);
  const headFrontVariants = Object.keys(wardrobe.variants).filter(k => k.startsWith('head-front-style-')).slice(0, 3);
  const baseVariants: Record<string, string | undefined> = { ...wardrobe.defaults, cloak: 'cloak-style-1', [proto.partName]: proto.variantId };
  const bareBackVariants: Record<string, string | undefined> = { ...wardrobe.defaults, cloak: undefined, [proto.partName]: proto.variantId };
  const olafVariants: Record<string, string | undefined> = {
    ...baseVariants,
    ...(wardrobe.companions?.['mercenary-olaf']?.variants ?? {}),
    cloak: undefined,
  };
  const outfitSamples: { name: string; variants: Record<string, string | undefined> }[] = [
    { name: '带披风外观', variants: baseVariants },
    { name: '默认无披风', variants: bareBackVariants },
    { name: '无披风佣兵(olaf)', variants: olafVariants },
    ...coatFrontVariants.map(v => ({ name: v, variants: { ...baseVariants, 'coat-front': v } })),
    ...headFrontVariants.map(v => ({ name: v, variants: { ...baseVariants, 'head-front': v } })),
  ];
  const checkedMissing = new Set<string>();
  for (const [poseId, pose] of Object.entries(proto.poses)) {
    for (let fi = 0; fi < pose.frames.length; fi++) {
      for (const sample of outfitSamples) {
        const pieces = resolveFramePieces(mergedSprites, mergedVariants, sample.variants, pose.frames[fi]!);
        for (const entry of pieces) {
          if (entry.missing) {
            const sig = `${poseId}|${sample.name}|${entry.missing}`;
            if (!checkedMissing.has(sig)) {
              checkedMissing.add(sig);
              fail('换装缺片', `${poseId} F${fi} 在 ${sample.name} 下缺失切片 ${entry.missing}`);
            }
          }
        }
      }
    }
  }

  // 4. 头脸同步、非旋转定姿与防抖头检查
  const seenPoseHeadChecked = new Set<string>();
  for (const [clip, poseId] of Object.entries(proto.stancePoses)) {
    const facing = facingFromClip(clip);
    const actionKey = actionKeyFromClip(clip);
    if (!facing || !isCombatAction(actionKey)) continue;
    const pose = mergedPoses[poseId];
    if (!pose) continue;

    const spin = isSpinAction(actionKey);
    const xs: number[] = [];
    const ys: number[] = [];
    const allowedHeads = NON_TURNING_HEAD_BY_FACING[facing];

    pose.frames.forEach((frame, fi) => {
      const headFronts = frame.filter(p => p.part === 'head-front');
      const headBacks = frame.filter(p => p.part === 'head-back');
      const bodyFaces = frame.filter(p => p.part === 'body' && p.piece < 4);
      if (!headFronts.length || !bodyFaces.length) {
        fail('头脸同步', `${clip} (${poseId}) F${fi} 缺少 head-front 或 body 脸部切片`);
        return;
      }
      for (const hf of headFronts) {
        const expectedFace = EXPECTED_FACE_FOR_HEAD[hf.piece];
        if (expectedFace === undefined || !bodyFaces.some(bf => bf.piece === expectedFace && bf.x === hf.x && bf.y === hf.y && bf.scaleX === hf.scaleX)) {
          fail('头脸同步', `${clip} (${poseId}) F${fi} head-front[${hf.piece}]@(${hf.x},${hf.y},sx=${hf.scaleX}) 与脸部 body 未同步`);
        }
        if (headBacks.length > 0 && !headBacks.some(hb => hb.piece === hf.piece && hb.x === hf.x && hb.y === hf.y && hb.scaleX === hf.scaleX)) {
          fail('头脸同步', `${clip} (${poseId}) F${fi} head-back 与 head-front 未同步`);
        }
        if (!spin) {
          if (!allowedHeads.has(hf.piece) || hf.scaleX !== 1) {
            fail('头部转向', `${clip} (${poseId}) F${fi} 非旋转招式出现跨向转头或镜像：head-front[${hf.piece}](sx=${hf.scaleX})`);
          }
          if ((facing === 'south' || facing === 'north') && hf.x !== 0) {
            fail('头部横晃', `${clip} (${poseId}) F${fi} 南北向头部横移 head.x=${hf.x}（应锁定为 0）`);
          }
        }
      }
      xs.push(headFronts[0]!.x);
      ys.push(headFronts[0]!.y);
    });

    if (!spin && !seenPoseHeadChecked.has(`${clip}:${poseId}`)) {
      seenPoseHeadChecked.add(`${clip}:${poseId}`);
      const revX = countReversals(xs);
      const revY = countReversals(ys);
      const maxRev = pose.frames.length >= 15 ? 3 : 2;
      if (revX > maxRev) warn('头部抖动', `${clip} 头部水平位移往复 ${revX} 次（建议 <= ${maxRev}）`);
      if (revY > maxRev) warn('头部点头', `${clip} 头部纵向位移往复 ${revY} 次（建议 <= ${maxRev}）`);
    }
  }

  // 5. 北向战斗帧双腿裆部零漏武器像素检查（含默认与无披风外观）
  for (const [clip, poseId] of Object.entries(proto.stancePoses)) {
    const facing = facingFromClip(clip);
    const actionKey = actionKeyFromClip(clip);
    if (!facing || !isCombatAction(actionKey)) continue;
    const checkNorthAll = facing === 'north';
    const checkSpinNorthFrames = isSpinAction(actionKey);
    if (!checkNorthAll && !checkSpinNorthFrames) continue;

    const pose = mergedPoses[poseId];
    if (!pose) continue;
    pose.frames.forEach((frame, fi) => {
      const isNorthBody = frame.some(p => p.part === 'body' && (p.piece === 2 || p.piece === 3));
      if (checkSpinNorthFrames && !isNorthBody) return;
      if (!frame.some(p => p.part === proto.partName)) return;
      const legX = Math.round(frame.find(p => p.part === 'coat-back')?.x ?? 0);

      for (const sample of [outfitSamples[0]!, outfitSamples[1]!, outfitSamples[2]!]) {
        const pieces = resolveFramePieces(mergedSprites, mergedVariants, sample.variants, frame);
        let leakPixels = 0;
        for (let dy = -8; dy <= 24; dy++) {
          for (let dx = legX - 4; dx <= legX + 4; dx++) {
            const localX = dx;
            let topPart: string | null = null;
            for (const { part, sprite } of pieces) {
              const png = textures.get(sprite.texture);
              if (!png) continue;
              const rad = (part.angle * Math.PI) / 180;
              const cos = Math.cos(rad);
              const sin = Math.sin(rad);
              const rx = localX - part.x;
              const ry = dy - part.y;
              const sx = Math.floor((rx * cos + ry * sin) / part.scaleX + sprite.anchorX + 1e-6);
              const sy = Math.floor((-rx * sin + ry * cos) / part.scaleY + sprite.anchorY + 1e-6);
              if (sx >= 0 && sx < sprite.width && sy >= 0 && sy < sprite.height) {
                if (png.data[((sprite.y + sy) * png.width + (sprite.x + sx)) * 4 + 3]! > 20) topPart = part.part;
              }
            }
            if (topPart === proto.partName) leakPixels++;
          }
        }
        if (leakPixels > 0) {
          fail('北向漏把', `${clip} (${poseId}) F${fi} [${sample.name}] 双腿裆部空隙露出 ${leakPixels} 个武器像素`);
        }
      }
    });
  }

  // 6. 战斗招式手臂与武器像素级贴合度检测（捕捉手与武器分离）
  let detachedWarnings = 0;
  for (const [clip, poseId] of Object.entries(proto.stancePoses)) {
    const facing = facingFromClip(clip);
    const actionKey = actionKeyFromClip(clip);
    if (!facing || facing === 'east' || !isCombatAction(actionKey) || isSpinAction(actionKey)) continue;
    const pose = mergedPoses[poseId];
    if (!pose) continue;
    pose.frames.forEach((frame, fi) => {
      const pieces = resolveFramePieces(mergedSprites, mergedVariants, baseVariants, frame);
      const weaponPiece = pieces.find(p => p.part.part === proto.partName);
      const armPieces = pieces.filter(p => isArmPart(p.part));
      if (!weaponPiece || !armPieces.length) return;
      const weaponPng = textures.get(weaponPiece.sprite.texture);
      if (!weaponPng) return;
      const weaponPts = collectWorldPixels(weaponPiece.part, weaponPiece.sprite, weaponPng);
      if (!weaponPts.length) return;
      for (const arm of armPieces) {
        const armPng = textures.get(arm.sprite.texture);
        if (!armPng) continue;
        const armPts = collectWorldPixels(arm.part, arm.sprite, armPng);
        if (!armPts.length) continue;
        let minDist2 = Infinity;
        for (const [ax, ay] of armPts) {
          for (const [wx, wy] of weaponPts) {
            const d2 = (ax - wx) * (ax - wx) + (ay - wy) * (ay - wy);
            if (d2 < minDist2) minDist2 = d2;
          }
        }
        const minDist = Math.sqrt(minDist2);
        if (minDist > 4.0) {
          detachedWarnings++;
          warn('手械贴合', `${clip} (${poseId}) F${fi} 手臂 coat-front[${arm.part.piece}] 与武器最小距离 ${minDist.toFixed(1)}px（建议 <= 4px）`);
        }
      }
    });
  }

  // 7. 特效纹理 WebGL 安全尺寸与双层帧完整检查
  let effectInfo = '无特效包';
  if (proto.effectSheet) {
    const effFile = resolveTextureFile(repoRoot, protoDir, proto.effectSheet.texture.file);
    const effPng = PNG.sync.read(fs.readFileSync(effFile));
    effectInfo = `${effPng.width}x${effPng.height} (${Object.keys(proto.effectSheet.frames).length} 帧)`;
    if (effPng.width > MAX_WEBGL_TEXTURE || effPng.height > MAX_WEBGL_TEXTURE) {
      fail('特效尺寸', `特效图 ${effPng.width}x${effPng.height} 超出 WebGL ${MAX_WEBGL_TEXTURE}px 上限，请使用 <= 3840px 货架装箱`);
    }
    for (const [frameKey, rect] of Object.entries(proto.effectSheet.frames)) {
      if (rect.x < 0 || rect.y < 0 || rect.x + rect.width > effPng.width || rect.y + rect.height > effPng.height) {
        fail('特效越界', `特效帧 ${frameKey} 超出 ${effPng.width}x${effPng.height}`);
      }
    }
    for (const [effectId, def] of Object.entries(proto.attackEffects ?? {})) {
      for (const [dir, clip] of Object.entries(def.clips)) {
        if (!clip) continue;
        if (clip.layers.length < 2) {
          warn('特效分层', `${effectId}/${dir} 仅 ${clip.layers.length} 层（推荐 normal 底光 + add 炽核双层）`);
        }
        for (const layer of clip.layers) {
          const frameList = proto.effectSheet.byFile[layer.file];
          if (!frameList || frameList.length < clip.frames) {
            fail('特效缺帧', `${effectId}/${dir} 图层 ${layer.file} 帧数不足（需 ${clip.frames}，实有 ${frameList?.length ?? 0}）`);
          }
        }
      }
    }
  }

  // 8. 震屏克制统计
  const shakeSummary: Record<string, number[]> = {};
  let totalShakes = 0;
  for (const [actionKey, tl] of Object.entries(proto.actionTimelines ?? {})) {
    const frames = tl.shakeFrames ?? [];
    if (frames.length) {
      shakeSummary[actionKey] = [...frames];
      totalShakes += frames.length;
    }
  }
  if (totalShakes > 2) {
    warn('震屏过多', `当前共有 ${totalShakes} 处强制震屏（推荐全职业克制保留 1~2 处核心重击/大招爆发帧）`);
  }

  // 输出体检报告
  const fails = findings.filter(f => f.level === 'fail');
  const warns = findings.filter(f => f.level === 'warn');

  console.log(`\n=== 动画质量体检报告：${proto.weaponName} (${proto.weaponKind}) ===`);
  console.log(`切片图：${partsPng.width}x${partsPng.height}（${Object.keys(proto.sprites).length} 张切片）`);
  console.log(`姿态数：${Object.keys(proto.poses).length} 组姿态 / ${Object.keys(proto.stancePoses).length} 个方向映射`);
  console.log(`特效图：${effectInfo}（${Object.keys(proto.attackEffects ?? {}).length} 套特效）`);
  console.log(`震屏分布：${totalShakes ? JSON.stringify(shakeSummary) : '0 处'}（共 ${totalShakes} 处）`);
  console.log(`结果汇总：FAIL ${fails.length} · WARN ${warns.length}`);

  if (fails.length) {
    console.log('\n[FAIL 阻断项]');
    for (const item of fails.slice(0, verbose ? fails.length : 30)) {
      console.log(`  ✗ [${item.category}] ${item.message}`);
    }
    if (!verbose && fails.length > 30) console.log(`  ... 其余 ${fails.length - 30} 条请加 --verbose 查看`);
  }
  if (warns.length) {
    console.log('\n[WARN 关注项]');
    for (const item of warns.slice(0, verbose ? warns.length : 20)) {
      console.log(`  ! [${item.category}] ${item.message}`);
    }
    if (!verbose && warns.length > 20) console.log(`  ... 其余 ${warns.length - 20} 条请加 --verbose 查看`);
  }
  if (!fails.length && !warns.length && detachedWarnings === 0) {
    console.log('\n✓ 全部动画几何、换装兼容、顶光、北向防漏与贴图安全项均通过！');
  } else if (!fails.length) {
    console.log('\n✓ 无阻断级缺陷（存在少量提醒项，可按需精修）。');
  }

  process.exit(fails.length > 0 ? 1 : 0);
}

main();

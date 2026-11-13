import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';
import { packAtlasBlocks, type AtlasPackBlock, type AtlasPackingItem, type AtlasPackedPage } from './atlas-pack.ts';
import { sourceAssetPath } from './asset-source.ts';

/**
 * 把战斗特效的每一帧裁到非透明包围盒，再按特效分块装箱成图集。
 *
 * 原图是统一网格的 spritesheet，绝大多数像素完全透明；Phaser 的图集帧支持
 * `sourceSize`/`spriteSourceSize`，所以裁边后仍能按原来的原点绘制。
 * 这里只生成图集和 `file → 帧列表` 映射，作者态 `battle.json` 不改。
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const CONTENT = path.join(PUBLIC, 'content');
const ATLAS_DIR = 'assets/effect-atlas';
const GENERATED = path.join(ROOT, 'src', 'generated', 'effect-atlas.ts');
const PAGE_KEY_PREFIX = 'effects-atlas:';
/** PNG 文件头 IHDR 的宽高偏移。 */
const PNG_WIDTH_OFFSET = 16;
const PNG_HEIGHT_OFFSET = 20;
/** pngjs 的 colorType 6 = RGBA，图集必须保留透明通道。 */
const PNG_COLOR_TYPE_RGBA = 6;
/** 帧名前缀取内容哈希前 12 位，避免不同特效的帧名撞车。 */
const FRAME_HASH_PREFIX_LENGTH = 12;
const MAX_SIZE = 2048;
const PADDING = 2;
/** 装箱实现换算法时递增；同时摘要会带上 `atlas-pack.ts` 的内容哈希。 */
const PACKER_VERSION = 2;

interface EffectLayer { key: string; file: string }
interface EffectClip { frameWidth: number; frameHeight: number; frames: number; layers: EffectLayer[] }
interface AttackEffect { clips: Record<string, EffectClip> }
interface Battle { attackEffects: Record<string, AttackEffect> }
interface StoryEffect { clips: Record<string, EffectClip> }
interface WorldCatalog { storyEffects?: Record<string, StoryEffect> }
interface PickupDrop { name: string; clip: EffectClip }
interface ItemsCatalog { items?: Record<string, { pickup?: { hitDrop?: { directions?: PickupDrop[] } } | null }> }

/** 一个特效或剧情效果；`id` 带来源前缀，避免同名时分块和共用判断混淆。 */
interface EffectTarget {
  id: string;
  clips: Record<string, EffectClip>;
}

interface FileUse {
  effect: string;
  clip: string;
  file: string;
  frameWidth: number;
  frameHeight: number;
  frames: number;
}

interface UniqueFile {
  hash: string;
  /** 内容相同的多个路径中字典序最小的那个。 */
  file: string;
  frameWidth: number;
  frameHeight: number;
  /** 所有 clip 里最大的帧数；每个 clip 取映射的前缀。 */
  frames: number;
  width: number;
  height: number;
  /** 所有指向同一文件内容的源路径。 */
  paths: Set<string>;
  /** 引用这份内容的所有特效。 */
  effects: Set<string>;
}

interface TrimmedFrame extends AtlasPackingItem {
  name: string;
  index: number;
  /** 装箱后回填，映射按 `index` 生成，不依赖装箱顺序。 */
  page: number;
  x: number;
  y: number;
  trimX: number;
  trimY: number;
  sourceWidth: number;
  sourceHeight: number;
  pixels: Buffer;
}

interface AtlasPage {
  key: string;
  file: string;
  data: string;
  frame: string;
  width: number;
  height: number;
  /** 只在生成器内部用于写文件，不进入 generated TS。 */
  png: Buffer;
  json: string;
  frames: Record<string, unknown>;
}

interface AtlasResult {
  pages: AtlasPage[];
  byFile: Record<string, { page: number; frame: string }[]>;
  digest: string;
  targetFiles: string[];
  sourceBytes: number;
  pageBytes: number;
}

const read = (file: string): unknown => JSON.parse(fs.readFileSync(path.join(CONTENT, file), 'utf8'));
const compareText = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

function battle(): Battle {
  return read('battle.json') as Battle;
}

function world(): WorldCatalog {
  return read('world.json') as WorldCatalog;
}

/** 所有战斗特效都进图集；运行时不再有特效图层退回单文件 spritesheet。 */
export const EFFECT_ATLAS_TARGETS: readonly string[] =
  Object.keys(battle().attackEffects).sort(compareText);

/** 剧情舞台用的效果也在同一份图集里；它们有自己的裁帧尺寸和帧数。 */
export const STORY_EFFECT_TARGETS: readonly string[] =
  Object.keys(world().storyEffects ?? {}).sort(compareText);

function effectTargets(): EffectTarget[] {
  const catalog = battle();
  const targets: EffectTarget[] = EFFECT_ATLAS_TARGETS.map(name => ({
    id: `attack:${name}`, clips: catalog.attackEffects[name]!.clips
  }));
  const storyEffects = world().storyEffects;
  for (const name of STORY_EFFECT_TARGETS) {
    const effect = storyEffects?.[name];
    if (!effect) throw new Error(`剧情特效图集目标不存在：${name}`);
    targets.push({ id: `story:${name}`, clips: effect.clips });
  }
  // 掉落拾取特效（目前是蓝宝石）来自 items.json，不在 battle/world 里；
  // 漏掉时运行时会在第一次掉落时找不到文件映射并抛错。
  const items = read('items.json') as ItemsCatalog;
  for (const [id, item] of Object.entries(items.items ?? {})) {
    const directions = item.pickup?.hitDrop?.directions;
    if (!directions?.length) continue;
    targets.push({ id: `pickup:${id}`,
      clips: Object.fromEntries(directions.map(direction => [direction.name, direction.clip])) });
  }
  return targets;
}

/** 目标特效里所有图层文件及其帧配置。 */
export function effectUses(): FileUse[] {
  const uses: FileUse[] = [];
  for (const target of effectTargets()) {
    for (const [clipName, clip] of Object.entries(target.clips)) {
      for (const layer of clip.layers) {
        if (!layer.file) continue;
        uses.push({ effect: target.id, clip: clipName, file: layer.file,
          frameWidth: clip.frameWidth, frameHeight: clip.frameHeight, frames: clip.frames });
      }
    }
  }
  return uses;
}

/**
 * 按文件内容去重。内容相同但帧尺寸不同的文件不能共用同一批帧，直接报错；
 * 帧数不同则取最大值，各 clip 仍按自己的帧数取前缀。
 */
function collectUniqueFiles(uses: readonly FileUse[]): { unique: Map<string, UniqueFile>; hashes: Map<string, string> } {
  const unique = new Map<string, UniqueFile>();
  const hashes = new Map<string, string>();
  const contents = new Map<string, Buffer>();
  for (const use of uses) {
    let hash = hashes.get(use.file);
    if (!hash) {
      const bytes = fs.readFileSync(sourceAssetPath(use.file));
      hash = createHash('sha256').update(bytes).digest('hex');
      hashes.set(use.file, hash);
      contents.set(hash, bytes);
    }
    const existing = unique.get(hash);
    if (existing) {
      if (existing.frameWidth !== use.frameWidth || existing.frameHeight !== use.frameHeight)
        throw new Error(`同一个特效文件出现不同帧尺寸：${use.file}（${existing.frameWidth}x${existing.frameHeight} 与 ${use.frameWidth}x${use.frameHeight}）`);
      existing.frames = Math.max(existing.frames, use.frames);
      existing.paths.add(use.file);
      existing.effects.add(use.effect);
      if (compareText(use.file, existing.file) < 0) existing.file = use.file;
      continue;
    }
    const bytes = contents.get(hash)!;
    unique.set(hash, { hash, file: use.file,
      frameWidth: use.frameWidth, frameHeight: use.frameHeight,
      frames: use.frames, width: bytes.readUInt32BE(PNG_WIDTH_OFFSET), height: bytes.readUInt32BE(PNG_HEIGHT_OFFSET),
      paths: new Set([use.file]), effects: new Set([use.effect]) });
  }
  return { unique, hashes };
}

/** 逐帧找非透明包围盒；整帧透明时用 1×1 空帧占位，sourceSize 仍是原帧尺寸。 */
function trimFrames(file: UniqueFile): TrimmedFrame[] {
  const png = PNG.sync.read(fs.readFileSync(sourceAssetPath(file.file)));
  const columns = Math.floor(png.width / file.frameWidth);
  const rows = Math.floor(png.height / file.frameHeight);
  if (columns * rows < file.frames)
    throw new Error(`特效图不足以容纳帧数：${file.file} (${png.width}x${png.height}, ${file.frames} 帧)`);
  const frames: TrimmedFrame[] = [];
  for (let index = 0; index < file.frames; index++) {
    const left = (index % columns) * file.frameWidth;
    const top = Math.floor(index / columns) * file.frameHeight;
    let x0 = file.frameWidth, y0 = file.frameHeight, x1 = -1, y1 = -1;
    for (let y = 0; y < file.frameHeight; y++) {
      const row = ((top + y) * png.width + left) * 4;
      for (let x = 0; x < file.frameWidth; x++) {
        if (png.data[row + x * 4 + 3] === 0) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    const name = `${file.hash.slice(0, FRAME_HASH_PREFIX_LENGTH)}-${index}`;
    const id = `${file.hash}:${index}`;
    if (x1 < 0) {
      frames.push({ id, name, index, page: -1, x: 0, y: 0,
        width: 1, height: 1, trimX: 0, trimY: 0,
        sourceWidth: file.frameWidth, sourceHeight: file.frameHeight, pixels: Buffer.alloc(4) });
      continue;
    }
    const width = x1 - x0 + 1, height = y1 - y0 + 1;
    const pixels = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
      const from = ((top + y0 + y) * png.width + left + x0) * 4;
      png.data.copy(pixels, y * width * 4, from, from + width * 4);
    }
    frames.push({ id, name, index, page: -1, x: 0, y: 0,
      width, height, trimX: x0, trimY: y0,
      sourceWidth: file.frameWidth, sourceHeight: file.frameHeight, pixels });
  }
  return frames;
}

/** 把打包结果画进页 PNG 与 JSON，并把页坐标回填到原始帧对象。 */
function writePages(plans: readonly AtlasPackedPage<TrimmedFrame>[], byId: ReadonlyMap<string, TrimmedFrame>): AtlasPage[] {
  const pages: AtlasPage[] = [];
  for (const [pageIndex, plan] of plans.entries()) {
    const width = Math.min(MAX_SIZE, Math.max(1, plan.width));
    const height = Math.min(MAX_SIZE, Math.max(1, plan.height));
    const png = new PNG({ width, height });
    png.data.fill(0);
    const frames: Record<string, unknown> = {};
    let sample = '';
    for (const item of plan.items) {
      const frame = byId.get(item.id);
      if (!frame) throw new Error(`图集帧未登记：${item.id}`);
      if (frames[frame.name]) throw new Error(`图集帧名重复：${frame.name}`);
      frame.page = pageIndex;
      frame.x = item.x;
      frame.y = item.y;
      if (frame.x + frame.width > width || frame.y + frame.height > height)
        throw new Error(`图集帧越界：${frame.name} (${frame.x},${frame.y} ${frame.width}x${frame.height})`);
      for (let row = 0; row < frame.height; row++) {
        const from = row * frame.width * 4;
        const to = ((frame.y + row) * width + frame.x) * 4;
        frame.pixels.copy(png.data, to, from, from + frame.width * 4);
      }
      frames[frame.name] = {
        frame: { x: frame.x, y: frame.y, w: frame.width, h: frame.height },
        rotated: false,
        trimmed: true,
        spriteSourceSize: { x: frame.trimX, y: frame.trimY, w: frame.width, h: frame.height },
        sourceSize: { w: frame.sourceWidth, h: frame.sourceHeight }
      };
      if (!sample) sample = frame.name;
    }
    const key = `${PAGE_KEY_PREFIX}${pageIndex}`;
    const file = `${ATLAS_DIR}/effects-${pageIndex}.png`;
    const data = `${ATLAS_DIR}/effects-${pageIndex}.json`;
    const json = JSON.stringify({
      frames,
      meta: { image: `effects-${pageIndex}.png`, format: 'RGBA8888', size: { w: width, h: height }, scale: '1' }
    });
    pages.push({ key, file, data, frame: sample, width, height,
      png: PNG.sync.write(png, { colorType: PNG_COLOR_TYPE_RGBA }), json, frames });
  }
  return pages;
}

export function effectAtlasSourceDigest(): string {
  const hash = createHash('sha256').update(`packer:${PACKER_VERSION}\0`);
  hash.update(fs.readFileSync(new URL(import.meta.url)));
  hash.update('\0');
  hash.update(fs.readFileSync(new URL('./atlas-pack.ts', import.meta.url)));
  hash.update('\0');
  hash.update(EFFECT_ATLAS_TARGETS.join('\0'));
  hash.update('\0');
  hash.update(STORY_EFFECT_TARGETS.join('\0'));
  hash.update('\0');
  const uses = effectUses();
  for (const use of [...uses].sort((a, b) => compareText(`${a.effect}\0${a.clip}\0${a.file}`, `${b.effect}\0${b.clip}\0${b.file}`)))
    hash.update(`${use.effect}\0${use.clip}\0${use.file}\0${use.frameWidth}\0${use.frameHeight}\0${use.frames}\0`);
  const { unique } = collectUniqueFiles(uses);
  for (const file of [...unique.values()].sort((a, b) => compareText(a.file, b.file)))
    hash.update(`${file.file}\0${file.frameWidth}\0${file.frameHeight}\0${file.frames}\0${file.hash}\0`);
  return hash.digest('hex');
}

export function packEffectAtlas(): AtlasResult {
  const uses = effectUses();
  const { unique, hashes } = collectUniqueFiles(uses);
  const files = [...unique.values()].sort((a, b) => compareText(a.file, b.file));
  const framesByHash = new Map<string, TrimmedFrame[]>();
  for (const file of files) framesByHash.set(file.hash, trimFrames(file));

  // 一个文件被多个特效引用时只装一次，放进 common 块；其余按特效分块。
  const shared = new Set(files.filter(file => file.effects.size > 1).map(file => file.hash));
  const byEffect = new Map<string, Set<string>>();
  for (const use of uses) {
    const hash = hashes.get(use.file)!;
    if (shared.has(hash)) continue;
    const set = byEffect.get(use.effect) ?? new Set<string>();
    set.add(hash);
    byEffect.set(use.effect, set);
  }
  const blocks: AtlasPackBlock<TrimmedFrame>[] = [];
  const common = files.filter(file => shared.has(file.hash))
    .flatMap(file => framesByHash.get(file.hash)!);
  if (common.length) blocks.push({ id: 'common', items: common });
  for (const target of effectTargets()) {
    const hashesForEffect = byEffect.get(target.id);
    if (!hashesForEffect?.size) continue;
    const items = files.filter(file => hashesForEffect.has(file.hash))
      .flatMap(file => framesByHash.get(file.hash)!);
    blocks.push({ id: target.id, items });
  }

  const plans = packAtlasBlocks(blocks, { maxSize: MAX_SIZE, padding: PADDING });
  const byId = new Map<string, TrimmedFrame>();
  for (const frames of framesByHash.values()) for (const frame of frames) byId.set(frame.id, frame);
  const pages = writePages(plans, byId);

  // 映射按原始帧序号生成，和装箱结果里的页内顺序无关。
  const byFile: Record<string, { page: number; frame: string }[]> = {};
  for (const use of uses) {
    const frames = framesByHash.get(hashes.get(use.file)!)!;
    byFile[use.file] = [...frames].sort((a, b) => a.index - b.index)
      .map(frame => ({ page: frame.page, frame: frame.name }));
  }
  const targetFiles = [...new Set(uses.map(use => use.file))].sort(compareText);
  const sourceBytes = files.reduce((sum, file) => sum + file.width * file.height * 4, 0);
  const pageBytes = pages.reduce((sum, page) => sum + page.width * page.height * 4, 0);
  return { pages, byFile, digest: effectAtlasSourceDigest(), targetFiles, sourceBytes, pageBytes };
}

export function writeEffectAtlas(): { pages: number; files: number; frames: number; source: number; packed: number; bytes: number } {
  const atlas = packEffectAtlas();
  fs.mkdirSync(path.join(PUBLIC, ATLAS_DIR), { recursive: true });
  for (const file of fs.readdirSync(path.join(PUBLIC, ATLAS_DIR)))
    if (/^effects-\d+\.(png|json)$/.test(file)) fs.unlinkSync(path.join(PUBLIC, ATLAS_DIR, file));
  for (const page of atlas.pages) {
    fs.writeFileSync(path.join(PUBLIC, page.file), page.png);
    fs.writeFileSync(path.join(PUBLIC, page.data), page.json);
  }
  fs.mkdirSync(path.dirname(GENERATED), { recursive: true });
  const pages = atlas.pages.map(({ key, file, data, frame, width, height }) => ({ key, file, data, frame, width, height }));
  fs.writeFileSync(GENERATED, `// 由 npm run atlas:effects 生成，勿手改。
export interface EffectAtlasPage { key: string; file: string; data: string; frame: string; width: number; height: number }
export const EFFECT_ATLAS_PAGES: readonly EffectAtlasPage[] = ${JSON.stringify(pages, null, 2)};
export interface EffectAtlasFrame { page: number; frame: string }
export const EFFECT_ATLAS_BY_FILE: Readonly<Record<string, readonly EffectAtlasFrame[]>> = ${JSON.stringify(atlas.byFile, null, 2)};
export const EFFECT_ATLAS_SOURCE_DIGEST = ${JSON.stringify(atlas.digest)};
`);
  return { pages: atlas.pages.length, files: Object.keys(atlas.byFile).length,
    frames: atlas.pages.reduce((sum, page) => sum + Object.keys(page.frames).length, 0),
    source: atlas.sourceBytes, packed: atlas.pageBytes,
    bytes: atlas.pages.reduce((sum, page) => sum + page.png.byteLength, 0) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = writeEffectAtlas();
  console.log(`技能特效图集：${result.files} 个文件 / ${result.frames} 帧 / ${result.pages} 页，` +
    `${(result.source / 1048576).toFixed(1)} MB 解码 → ${(result.packed / 1048576).toFixed(1)} MB，` +
    `${(result.bytes / 1048576).toFixed(2)} MB 磁盘`);
}

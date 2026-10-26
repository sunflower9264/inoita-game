import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';

/**
 * 把大型技能特效的每一帧裁到非透明包围盒，再装箱成图集。
 *
 * 原图是统一网格的 spritesheet，绝大多数像素完全透明；Phaser 的图集帧支持
 * `sourceSize`/`spriteSourceSize`，所以裁边后仍能按原来的原点绘制。
 * 这里只生成图集和 `file → 帧列表` 映射，作者态 `battle.json` 不改。
 */
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PUBLIC = path.join(ROOT, 'public');
const CONTENT = path.join(PUBLIC, 'content');
const ATLAS_DIR = 'assets/effect-atlas';
const GENERATED = path.join(ROOT, 'src', 'generated', 'effect-atlas.ts');
const PAGE_KEY_PREFIX = 'effects-atlas:';
const MAX_SIZE = 2048;
const PADDING = 2;
const PACKER_VERSION = 1;

/** 只处理体积最夸张的四个技能特效；其余特效继续按 spritesheet 加载。 */
export const EFFECT_ATLAS_TARGETS = [
  'rampage-burst',
  'hellsword-swing',
  'freeze-shard',
  'blinding-flash'
] as const;

interface EffectLayer { key: string; file: string }
interface EffectClip { frameWidth: number; frameHeight: number; frames: number; layers: EffectLayer[] }
interface AttackEffect { clips: Record<string, EffectClip> }
interface Battle { attackEffects: Record<string, AttackEffect> }

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
  file: string;
  effect: string;
  frameWidth: number;
  frameHeight: number;
  frames: number;
  width: number;
  height: number;
  /** 所有指向同一文件内容的源路径。 */
  paths: Set<string>;
}

interface TrimmedFrame {
  name: string;
  index: number;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
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

/** 目标特效里所有图层文件及其帧配置。 */
export function effectUses(): FileUse[] {
  const catalog = battle();
  const uses: FileUse[] = [];
  for (const effectName of EFFECT_ATLAS_TARGETS) {
    const effect = catalog.attackEffects[effectName];
    if (!effect) throw new Error(`特效图集目标不存在：${effectName}`);
    for (const [clipName, clip] of Object.entries(effect.clips)) {
      for (const layer of clip.layers) {
        if (!layer.file) continue;
        uses.push({ effect: effectName, clip: clipName, file: layer.file,
          frameWidth: clip.frameWidth, frameHeight: clip.frameHeight, frames: clip.frames });
      }
    }
  }
  return uses;
}

function collectUniqueFiles(uses: readonly FileUse[]): { unique: Map<string, UniqueFile>; hashes: Map<string, string> } {
  const unique = new Map<string, UniqueFile>();
  const hashes = new Map<string, string>();
  for (const use of uses) {
    let hash = hashes.get(use.file);
    if (!hash) {
      const bytes = fs.readFileSync(path.join(PUBLIC, use.file));
      hash = createHash('sha256').update(bytes).digest('hex');
      hashes.set(use.file, hash);
    }
    const existing = unique.get(hash);
    if (existing) {
      if (existing.frameWidth !== use.frameWidth || existing.frameHeight !== use.frameHeight)
        throw new Error(`同一特效文件出现不同帧尺寸：${use.file}`);
      if (existing.effect !== use.effect)
        throw new Error(`同一个特效文件被多个特效共用，无法按特效分页：${use.file}`);
      existing.frames = Math.max(existing.frames, use.frames);
      existing.paths.add(use.file);
      if (compareText(use.file, existing.file) < 0) existing.file = use.file;
      continue;
    }
    const bytes = fs.readFileSync(path.join(PUBLIC, use.file));
    unique.set(hash, { hash, file: use.file, effect: use.effect,
      frameWidth: use.frameWidth, frameHeight: use.frameHeight,
      frames: use.frames, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20),
      paths: new Set([use.file]) });
  }
  return { unique, hashes };
}

/** 逐帧找非透明包围盒；整帧透明时用 1×1 空帧占位，sourceSize 仍是原帧尺寸。 */
function trimFrames(file: UniqueFile): TrimmedFrame[] {
  const png = PNG.sync.read(fs.readFileSync(path.join(PUBLIC, file.file)));
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
    if (x1 < 0) {
      frames.push({ name: `${file.hash.slice(0, 10)}-${index}`, index, page: -1, x: 0, y: 0,
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
    frames.push({ name: `${file.hash.slice(0, 10)}-${index}`, index, page: -1, x: 0, y: 0,
      width, height, trimX: x0, trimY: y0,
      sourceWidth: file.frameWidth, sourceHeight: file.frameHeight, pixels });
  }
  return frames;
}

interface Shelf { x: number; y: number; height: number }
interface PagePlan { frames: TrimmedFrame[]; shelves: Shelf[]; width: number; height: number }

/** 货架装箱：高帧优先，2 px 透明间距；一页放不下就换页。页面索引从 `base` 开始。 */
function pack(frames: TrimmedFrame[], base: number): PagePlan[] {
  const sorted = [...frames].sort((a, b) => b.height - a.height || b.width - a.width || compareText(a.name, b.name));
  const pages: PagePlan[] = [];
  let page: PagePlan = { frames: [], shelves: [], width: 0, height: 0 };
  const finish = (): void => {
    if (!page.frames.length) return;
    pages.push({ ...page, width: Math.max(1, page.width), height: Math.max(1, page.height) });
    page = { frames: [], shelves: [], width: 0, height: 0 };
  };
  for (const frame of sorted) {
    if (frame.width + PADDING * 2 > MAX_SIZE || frame.height + PADDING * 2 > MAX_SIZE)
      throw new Error(`特效帧过大，无法装入图集：${frame.name} (${frame.width}x${frame.height})`);
    // 同一高度带里优先复用最矮的货架，避免矮帧占着高货架留下竖向空洞。
    let shelf = page.shelves
      .filter(value => value.x + frame.width + PADDING * 2 <= MAX_SIZE)
      .sort((a, b) => a.height - b.height || a.y - b.y)[0];
    if (!shelf) {
      if (page.height + frame.height + PADDING * 2 > MAX_SIZE) finish();
      shelf = { x: PADDING, y: page.height, height: frame.height };
      page.shelves.push(shelf);
      page.height += frame.height + PADDING * 2;
    }
    frame.x = shelf.x;
    frame.y = shelf.y + PADDING;
    frame.page = base + pages.length;
    page.frames.push(frame);
    shelf.x += frame.width + PADDING * 2;
    page.width = Math.max(page.width, shelf.x);
  }
  finish();
  return pages;
}

function writePages(plans: readonly PagePlan[], base: number): AtlasPage[] {
  const pages: AtlasPage[] = [];
  for (const [index, plan] of plans.entries()) {
    const pageIndex = base + index;
    const width = Math.min(MAX_SIZE, plan.width);
    const height = Math.min(MAX_SIZE, plan.height);
    const png = new PNG({ width, height });
    png.data.fill(0);
    const frames: Record<string, unknown> = {};
    let sample = '';
    for (const frame of plan.frames) {
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
      png: PNG.sync.write(png, { colorType: 6 }), json, frames });
  }
  return pages;
}

export function effectAtlasSourceDigest(): string {
  const hash = createHash('sha256').update(`packer:${PACKER_VERSION}\0`);
  hash.update(fs.readFileSync(new URL(import.meta.url)));
  hash.update('\0');
  hash.update(EFFECT_ATLAS_TARGETS.join('\0'));
  hash.update('\0');
  for (const use of [...effectUses()].sort((a, b) => compareText(`${a.effect}\0${a.clip}\0${a.file}`, `${b.effect}\0${b.clip}\0${b.file}`)))
    hash.update(`${use.effect}\0${use.clip}\0${use.file}\0${use.frameWidth}\0${use.frameHeight}\0${use.frames}\0`);
  const { unique } = collectUniqueFiles(effectUses());
  for (const file of [...unique.values()].sort((a, b) => compareText(a.file, b.file)))
    hash.update(`${file.file}\0${file.hash}\0`);
  return hash.digest('hex');
}

export function packEffectAtlas(): AtlasResult {
  const uses = effectUses();
  const { unique, hashes } = collectUniqueFiles(uses);
  const byHash = new Map<string, TrimmedFrame[]>();
  const byEffect = new Map<string, TrimmedFrame[]>();
  for (const file of unique.values()) {
    const trimmed = trimFrames(file);
    byHash.set(file.hash, trimmed);
    const list = byEffect.get(file.effect) ?? [];
    list.push(...trimmed);
    byEffect.set(file.effect, list);
  }
  // 每个特效单独分页：加载某个职业的特效时不会把别的大特效整页带进来。
  const pages: AtlasPage[] = [];
  let base = 0;
  for (const effect of EFFECT_ATLAS_TARGETS) {
    const frames = byEffect.get(effect);
    if (!frames?.length) continue;
    const plans = pack(frames, base);
    pages.push(...writePages(plans, base));
    base += plans.length;
  }
  const byFile: Record<string, { page: number; frame: string }[]> = {};
  for (const use of uses) {
    const hash = hashes.get(use.file)!;
    byFile[use.file] = (byHash.get(hash) ?? []).map(frame => ({ page: frame.page, frame: frame.name }));
  }
  const targetFiles = [...new Set(uses.map(use => use.file))].sort(compareText);
  const sourceBytes = [...unique.values()].reduce((sum, file) => sum + file.width * file.height * 4, 0);
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

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const result = writeEffectAtlas();
  console.log(`技能特效图集：${result.files} 个文件 / ${result.frames} 帧 / ${result.pages} 页，` +
    `${(result.source / 1048576).toFixed(1)} MB 解码 → ${(result.packed / 1048576).toFixed(1)} MB，` +
    `${(result.bytes / 1048576).toFixed(2)} MB 磁盘`);
}

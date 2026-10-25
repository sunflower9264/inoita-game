import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PUBLIC = path.join(ROOT, 'public');
const CONTENT = path.join(PUBLIC, 'content');
const ATLAS_IMAGE = 'assets/ui/menu-icons.png';
const ATLAS_DATA = 'assets/ui/menu-icons.json';
const ATLAS_KEY = 'interface:assets/ui/menu-icons.png';
const GENERATED = path.join(ROOT, 'src', 'generated', 'icon-atlas.ts');
const MAX_SIZE = 2048;
const PADDING = 2;

const read = (file: string): any => JSON.parse(fs.readFileSync(path.join(CONTENT, file), 'utf8'));

/** 菜单里按文件路径取图的图标：物品、技能、伙伴团技能、职业。 */
export function iconFiles(): string[] {
  const files = new Set<string>();
  const items = read('items.json');
  for (const item of Object.values(items.items ?? {}) as any[]) if (item.icon) files.add(item.icon);
  const battle = read('battle.json');
  for (const skill of Object.values(battle.skills ?? {}) as any[]) if (skill.icon) files.add(skill.icon);
  const companions = read('companions.json');
  for (const skill of Object.values(companions.groupSkills ?? {}) as any[]) if (skill.icon) files.add(skill.icon);
  return [...files].filter(file => file.startsWith('assets/')).sort();
}

interface PackedFrame { x: number; y: number; w: number; h: number }
interface AtlasBuild {
  width: number;
  height: number;
  frames: Map<string, PackedFrame>;
  /** 内容相同的图标指向同一个 frame。 */
  canonical: Map<string, string>;
  sourceBytes: number;
}

/**
 * 行业常用的图集做法：按像素内容去重，再按高度做货架装箱。图标尺寸小、数量多，
 * 一张 2048 图集就能装下；运行时只需一次纹理上传，绘制也能合批。
 */
export function packIcons(): AtlasBuild {
  const files = iconFiles();
  const hashes = new Map<string, string>();
  const unique = new Map<string, { file: string; png: PNG }>();
  let sourceBytes = 0;
  for (const file of files) {
    const bytes = fs.readFileSync(path.join(PUBLIC, file));
    sourceBytes += bytes.byteLength;
    const hash = createHash('sha256').update(bytes).digest('hex');
    hashes.set(file, hash);
    if (unique.has(hash)) continue;
    unique.set(hash, { file, png: PNG.sync.read(bytes) });
  }
  const entries = [...unique.values()].sort((a, b) =>
    b.png.height - a.png.height || b.png.width - a.png.width || a.file.localeCompare(b.file));
  const shelves: { y: number; height: number; x: number }[] = [];
  const placements = new Map<string, PackedFrame>();
  let width = 0, height = 0;
  for (const entry of entries) {
    const w = entry.png.width, h = entry.png.height;
    if (w + PADDING * 2 > MAX_SIZE) throw new Error(`图标过宽，无法装入图集：${entry.file} (${w}px)`);
    let shelf = shelves.find(value => value.x + w + PADDING <= MAX_SIZE);
    if (!shelf) {
      shelf = { y: height, height: h, x: PADDING };
      shelves.push(shelf);
      height += h + PADDING * 2;
    }
    const frame = { x: shelf.x, y: shelf.y + PADDING, w, h };
    placements.set(entry.file, frame);
    shelf.x += w + PADDING * 2;
    width = Math.max(width, shelf.x);
    shelf.height = Math.max(shelf.height, h);
  }
  if (height > MAX_SIZE) throw new Error(`图标图集超过 ${MAX_SIZE}px 高度：${height}px`);
  width = Math.min(MAX_SIZE, Math.max(1, width));
  height = Math.min(MAX_SIZE, Math.max(1, height));
  const atlas = new PNG({ width, height });
  atlas.data.fill(0);
  for (const entry of entries) {
    const frame = placements.get(entry.file)!;
    // 同一套 RGBA 直接拷贝，不做颜色混合，透明边缘保持原样。
    for (let row = 0; row < entry.png.height; row++) {
      const from = row * entry.png.width * 4;
      const to = ((frame.y + row) * width + frame.x) * 4;
      entry.png.data.copy(atlas.data, to, from, from + entry.png.width * 4);
    }
  }
  const frames = new Map<string, PackedFrame>();
  const canonical = new Map<string, string>();
  for (const file of files) {
    const hash = hashes.get(file)!;
    const source = unique.get(hash)!.file;
    frames.set(source, placements.get(source)!);
    canonical.set(file, source);
  }
  return { width, height, frames, canonical, sourceBytes };
}

/** 内容里的图标文件内容摘要；图标改了但没重跑图集时，构建期直接失败。 */
export function iconSourceDigest(): string {
  const hash = createHash('sha256');
  for (const file of iconFiles()) {
    hash.update(file);
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(PUBLIC, file)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function writeIconAtlas(): { width: number; height: number; icons: number; unique: number; bytes: number } {
  const packed = packIcons();
  const atlas = new PNG({ width: packed.width, height: packed.height });
  atlas.data.fill(0);
  for (const [file, frame] of packed.frames) {
    const png = PNG.sync.read(fs.readFileSync(path.join(PUBLIC, file)));
    for (let row = 0; row < frame.h; row++) {
      const from = row * frame.w * 4;
      const to = ((frame.y + row) * packed.width + frame.x) * 4;
      png.data.copy(atlas.data, to, from, from + frame.w * 4);
    }
  }
  fs.mkdirSync(path.dirname(path.join(PUBLIC, ATLAS_IMAGE)), { recursive: true });
  const bytes = PNG.sync.write(atlas, { colorType: 6 });
  fs.writeFileSync(path.join(PUBLIC, ATLAS_IMAGE), bytes);
  const frames: Record<string, unknown> = {};
  for (const [file, frame] of packed.frames) {
    frames[file] = {
      frame: { x: frame.x, y: frame.y, w: frame.w, h: frame.h },
      rotated: false, trimmed: false, spriteSourceSize: { x: 0, y: 0, w: frame.w, h: frame.h },
      sourceSize: { w: frame.w, h: frame.h }
    };
  }
  fs.writeFileSync(path.join(PUBLIC, ATLAS_DATA), JSON.stringify({
    frames,
    meta: { image: path.basename(ATLAS_IMAGE), format: 'RGBA8888', size: { w: packed.width, h: packed.height }, scale: '1' }
  }));
  fs.mkdirSync(path.dirname(GENERATED), { recursive: true });
  const mapping = Object.fromEntries([...packed.canonical].map(([file, source]) => [file, source]));
  fs.writeFileSync(GENERATED, `// 由 npm run atlas:icons 生成，勿手改。
export const UI_ICON_ATLAS_FILE = ${JSON.stringify(ATLAS_IMAGE)};
export const UI_ICON_ATLAS_DATA = ${JSON.stringify(ATLAS_DATA)};
export const UI_ICON_ATLAS_KEY = ${JSON.stringify(ATLAS_KEY)};
export const UI_ICON_SOURCE_DIGEST = ${JSON.stringify(iconSourceDigest())};
export const UI_ICON_FRAMES: Readonly<Record<string, string>> = ${JSON.stringify(mapping, null, 2)};
`);
  return { width: packed.width, height: packed.height, icons: iconFiles().length, unique: packed.frames.size, bytes: bytes.byteLength };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const result = writeIconAtlas();
  console.log(`菜单图标图集：${result.icons} 个图标 → ${result.unique} 帧，${result.width}x${result.height}，${(result.bytes / 1024 / 1024).toFixed(2)} MB`);
}

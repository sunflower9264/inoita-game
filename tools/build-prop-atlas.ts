import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';
import { contentDigest } from '../src/application/content-hash.ts';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PUBLIC = path.join(ROOT, 'public');
const CONTENT = path.join(PUBLIC, 'content');
const ATLAS_DIR = 'assets/props/atlas';
const GENERATED = path.join(ROOT, 'src', 'generated', 'prop-atlas.ts');
const PAGE_KEY_PREFIX = 'props-atlas:';
const MAX_SIZE = 2048;
const PADDING = 2;
const PACKER_VERSION = 1;

interface PropDefinition { key: string; file: string }
interface PropPage {
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
interface PropAtlas {
  pages: PropPage[];
  byKey: Record<string, { key: string; frame: string }>;
  digest: string;
  layoutDigest: string;
  props: number;
  unique: number;
}

const compareText = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

const read = (file: string): any => JSON.parse(fs.readFileSync(path.join(CONTENT, file), 'utf8'));

export function propFiles(): PropDefinition[] {
  const world = read('world.json');
  return (world.props ?? []).map((prop: PropDefinition) => ({ key: prop.key, file: prop.file }));
}

/** 源摘要包含打包算法版本；只改装箱代码也要重新生成。 */
export function propSourceDigest(): string {
  const hash = createHash('sha256').update(`packer:${PACKER_VERSION}\0`);
  // 装箱代码本身也纳入摘要：改 PADDING/排序/拷贝逻辑但忘了 bump 版本号时仍会失效。
  hash.update(fs.readFileSync(new URL(import.meta.url)));
  hash.update('\0');
  for (const prop of [...propFiles()].sort((a, b) => compareText(a.key, b.key))) {
    hash.update(prop.key);
    hash.update('\0');
    hash.update(prop.file);
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(PUBLIC, prop.file)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** 校验地图 feature 只引用 world.props 中的键；不读取/改写 map JSON。 */
export function validatePropReferences(): void {
  const props = propFiles();
  const keys = new Set(props.map(prop => prop.key));
  if (keys.size !== props.length) throw new Error('world.props 存在重复 key');
  const world = read('world.json');
  for (const ref of world.maps ?? []) {
    const map = JSON.parse(fs.readFileSync(path.join(PUBLIC, ref.file), 'utf8'));
    for (const feature of map.features ?? [])
      if (!keys.has(feature.texture)) throw new Error(`地图 ${map.id} 的场景物件缺少资源：${feature.texture}`);
  }
}

interface Entry {
  file: string;
  hash: string;
  png: PNG;
  width: number;
  height: number;
}

interface Shelf { x: number; y: number; height: number }

/**
 * 按内容去重后做货架装箱。所有 frame 保持原尺寸，不 trim、不旋转；
 * 2 px 透明间距避免相机缩放时采样到相邻 frame。
 */
export function packPropAtlas(): PropAtlas {
  validatePropReferences();
  const props = propFiles();
  const unique = new Map<string, Entry>();
  for (const prop of props) {
    const bytes = fs.readFileSync(path.join(PUBLIC, prop.file));
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (!unique.has(hash)) {
      const png = PNG.sync.read(bytes);
      unique.set(hash, { file: prop.file, hash, png, width: png.width, height: png.height });
    } else {
      // 同一内容只保留一个 frame；选字典序最小的路径，避免 world.props 顺序影响映射。
      const existing = unique.get(hash)!;
      if (compareText(prop.file, existing.file) < 0) existing.file = prop.file;
    }
  }
  const entries = [...unique.values()]
    .sort((a, b) => b.height - a.height || b.width - a.width || compareText(a.file, b.file));
  const pagePlans: { entries: { entry: Entry; x: number; y: number }[]; width: number; height: number }[] = [];
  let plan: { entries: { entry: Entry; x: number; y: number }[]; shelves: Shelf[]; width: number; height: number } = {
    entries: [], shelves: [], width: 0, height: 0
  };
  const finishPage = () => {
    if (!plan.entries.length) return;
    pagePlans.push({ entries: plan.entries, width: plan.width, height: plan.height });
    plan = { entries: [], shelves: [], width: 0, height: 0 };
  };
  for (const entry of entries) {
    if (entry.width + PADDING * 2 > MAX_SIZE || entry.height + PADDING * 2 > MAX_SIZE)
      throw new Error(`prop 过大，无法装入图集：${entry.file} (${entry.width}x${entry.height})`);
    let shelf = plan.shelves.find(value => value.x + entry.width + PADDING * 2 <= MAX_SIZE);
    if (!shelf) {
      if (plan.height + entry.height + PADDING * 2 > MAX_SIZE) { finishPage(); }
      shelf = { x: PADDING, y: plan.height, height: entry.height };
      plan.shelves.push(shelf);
      plan.height += entry.height + PADDING * 2;
    }
    plan.entries.push({ entry, x: shelf.x, y: shelf.y + PADDING });
    shelf.x += entry.width + PADDING * 2;
    plan.width = Math.max(plan.width, shelf.x);
  }
  finishPage();
  if (!pagePlans.length) throw new Error('没有可打包的地图 prop');
  const pages: PropPage[] = [];
  const framePage = new Map<string, { page: number; frame: { x: number; y: number; w: number; h: number } }>();
  for (const [pageIndex, page] of pagePlans.entries()) {
    const width = Math.min(MAX_SIZE, Math.max(1, page.width));
    const height = Math.min(MAX_SIZE, Math.max(1, page.height));
    const png = new PNG({ width, height });
    png.data.fill(0);
    const frames: Record<string, unknown> = {};
    let sample = '';
    for (const { entry, x, y } of page.entries) {
      // 同一份 RGBA 直接拷贝，不做颜色混合；padding 区域保持透明。
      for (let row = 0; row < entry.height; row++) {
        const from = row * entry.width * 4;
        const to = ((y + row) * width + x) * 4;
        entry.png.data.copy(png.data, to, from, from + entry.width * 4);
      }
      const frame = { x, y, w: entry.width, h: entry.height };
      framePage.set(entry.file, { page: pageIndex, frame });
      if (!sample) sample = entry.file;
      frames[entry.file] = {
        frame, rotated: false, trimmed: false,
        spriteSourceSize: { x: 0, y: 0, w: entry.width, h: entry.height },
        sourceSize: { w: entry.width, h: entry.height }
      };
    }
    const key = `${PAGE_KEY_PREFIX}${pageIndex}`;
    const file = `${ATLAS_DIR}/props-${pageIndex}.png`;
    const data = `${ATLAS_DIR}/props-${pageIndex}.json`;
    const json = JSON.stringify({
      frames, meta: { image: `props-${pageIndex}.png`, format: 'RGBA8888', size: { w: width, h: height }, scale: '1' }
    });
    pages.push({ key, file, data, frame: sample, width, height,
      png: PNG.sync.write(png, { colorType: 6 }), json, frames });
  }
  const byKey: Record<string, { key: string; frame: string }> = {};
  const canonical = new Map<string, string>();
  for (const entry of unique.values()) canonical.set(entry.hash, entry.file);
  for (const prop of props) {
    const hash = createHash('sha256').update(fs.readFileSync(path.join(PUBLIC, prop.file))).digest('hex');
    const frame = canonical.get(hash)!;
    const page = framePage.get(frame)!;
    byKey[prop.key] = { key: pages[page.page]!.key, frame };
  }
  const layoutDigest = contentDigest({
    pages: pages.map(({ key, file, data, frame, width, height }) => ({ key, file, data, frame, width, height })),
    byKey,
    frames: Object.fromEntries(pages.map(page => [page.key, page.frames]))
  });
  return { pages, byKey, digest: propSourceDigest(), layoutDigest, props: props.length, unique: unique.size };
}

export function writePropAtlas(): { pages: number; props: number; unique: number; width: number; height: number; bytes: number } {
  const atlas = packPropAtlas();
  fs.mkdirSync(path.join(PUBLIC, ATLAS_DIR), { recursive: true });
  for (const page of atlas.pages) {
    fs.writeFileSync(path.join(PUBLIC, page.file), page.png);
    fs.writeFileSync(path.join(PUBLIC, page.data), page.json);
  }
  fs.mkdirSync(path.dirname(GENERATED), { recursive: true });
  fs.writeFileSync(GENERATED, `// 由 npm run atlas:props 生成，勿手改。
export const PROP_ATLAS_PAGES = ${JSON.stringify(atlas.pages.map(({ key, file, data, frame, width, height }) => ({ key, file, data, frame, width, height })), null, 2)} as const;
export const PROP_ATLAS_BY_KEY: Readonly<Record<string, { key: string; frame: string }>> = ${JSON.stringify(atlas.byKey, null, 2)};
export const PROP_ATLAS_SOURCE_DIGEST = ${JSON.stringify(atlas.digest)};
export const PROP_ATLAS_LAYOUT_DIGEST = ${JSON.stringify(atlas.layoutDigest)};
`);
  const bytes = atlas.pages.reduce((sum, page) => sum + page.png.byteLength, 0);
  return { pages: atlas.pages.length, props: atlas.props, unique: atlas.unique,
    width: atlas.pages[0]!.width, height: atlas.pages[0]!.height, bytes };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const result = writePropAtlas();
  console.log(`地图 prop 图集：${result.props} 个 prop → ${result.unique} 帧 / ${result.pages} 页，${result.width}x${result.height}，${(result.bytes / 1024 / 1024).toFixed(2)} MB`);
}

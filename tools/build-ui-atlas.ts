import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';
import { gameMenuImageGroups, TITLE_MESSAGE_ASSETS } from '../src/application/menu-images.ts';
import { COMMON_BUTTON_IMAGES } from '../src/ui/common-button.ts';
import { UI_ICON_FRAMES } from '../src/generated/icon-atlas.ts';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PUBLIC = path.join(ROOT, 'public');
const CONTENT = path.join(PUBLIC, 'content');
const PREFIX = 'assets/ui/menu-ui';
const GENERATED = path.join(ROOT, 'src', 'generated', 'ui-atlas.ts');
const MAX_SIZE = 2048;
const PADDING = 2;

const read = (file: string): any => JSON.parse(fs.readFileSync(path.join(CONTENT, file), 'utf8'));

function pngSize(file: string): { w: number; h: number } {
  const bytes = fs.readFileSync(path.join(PUBLIC, file));
  if (bytes.toString('ascii', 1, 4) !== 'PNG') throw new Error(`UI 图集只接受 PNG：${file}`);
  return { w: bytes.readUInt32BE(16), h: bytes.readUInt32BE(20) };
}

/**
 * 进入 UI 图集的菜单静态图。
 *
 * 只收 `gameMenuImageGroups().core`：这些是打开菜单就会画出来的框架、商店、剧情页签、
 * 职业预览与队伍头像。以下三类留在图集外，按原文件路径加载：
 * - 共用按钮和任务弹窗边：按钮皮肤 / 九宫格按整张纹理取图；
 * - 标题页的提示条：标题页只加载这 7 张，进图集会把整页图集提前拉下来；
 * - 操作皮肤：摇杆和操作键按文件路径直接取纹理（`controlSkinAssets` 的 key 是文件路径）。
 * 超过 2048 或非 PNG 的图也退回单图，避免睡不进去或解码失败。
 */
export function uiAtlasFiles(): string[] {
  const panels = read('menu-panels.json');
  const items = read('items.json');
  const battle = read('battle.json');
  const story = read('story-interface.json');
  const shops = read('shops.json');
  const { core } = gameMenuImageGroups(panels, items, battle, story, shops);
  const excluded = new Set<string>([
    ...COMMON_BUTTON_IMAGES,
    ...Object.values(TITLE_MESSAGE_ASSETS).map(file => file.replace(/^\//, '')),
    story.assets['quest-popup-window']
  ].filter((file): file is string => typeof file === 'string' && file.length > 0));
  return [...new Set(core)]
    .filter((file): file is string => typeof file === 'string' && file.startsWith('assets/') && file.endsWith('.png'))
    .filter(file => !excluded.has(file) && UI_ICON_FRAMES[file] === undefined)
    .filter(file => { const { w, h } = pngSize(file); return w <= MAX_SIZE && h <= MAX_SIZE; })
    .sort();
}

/** 进入图集的文件内容摘要；菜单图改了但没重跑图集时，构建期直接失败。 */
export function uiAtlasSourceDigest(): string {
  const hash = createHash('sha256');
  for (const file of uiAtlasFiles()) {
    hash.update(file);
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(PUBLIC, file)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

interface PackedFrame { x: number; y: number; w: number; h: number }
interface PageBuild { width: number; height: number; frames: Map<string, PackedFrame>; sentinel?: string }

interface AtlasBuild {
  pages: PageBuild[];
  /** 文件 → 该文件内容对应的规范帧（同一内容的多个文件共用一个帧）。 */
  canonical: Map<string, string>;
  sourceBytes: number;
}

/**
 * 按像素内容去重，再按高度做货架装箱；一页超过 2048 高就换下一页。
 * 帧名用规范文件路径，和图标图集一致，运行时按文件路径取 `{ key, frame }`。
 */
export function packUiAtlas(): AtlasBuild {
  const files = uiAtlasFiles();
  const hashes = new Map<string, string>();
  const unique = new Map<string, { file: string; png: PNG }>();
  let sourceBytes = 0;
  for (const file of files) {
    const bytes = fs.readFileSync(path.join(PUBLIC, file));
    sourceBytes += bytes.byteLength;
    const hash = createHash('sha256').update(bytes).digest('hex');
    hashes.set(file, hash);
    if (!unique.has(hash)) unique.set(hash, { file, png: PNG.sync.read(bytes) });
  }
  const entries = [...unique.values()].sort((a, b) =>
    b.png.height - a.png.height || b.png.width - a.png.width || a.file.localeCompare(b.file));
  const pages: PageBuild[] = [];
  let page: PageBuild | undefined;
  let shelves: { y: number; x: number }[] = [];
  let height = 0, width = 0;
  const startPage = (): void => {
    page = { width: 0, height: 0, frames: new Map() };
    pages.push(page);
    shelves = []; height = 0; width = 0;
  };
  for (const entry of entries) {
    const w = entry.png.width, h = entry.png.height;
    let shelf = shelves.find(value => value.x + w + PADDING * 2 <= MAX_SIZE);
    if (!shelf) {
      if (!page || height + h + PADDING * 2 > MAX_SIZE) startPage();
      shelf = { y: height, x: PADDING };
      shelves.push(shelf);
      height += h + PADDING * 2;
    }
    page!.frames.set(entry.file, { x: shelf.x, y: shelf.y + PADDING, w, h });
    page!.sentinel ??= entry.file;
    shelf.x += w + PADDING * 2;
    width = Math.max(width, shelf.x);
    page!.width = Math.min(MAX_SIZE, Math.max(1, width));
    page!.height = Math.min(MAX_SIZE, Math.max(1, height));
  }
  const canonical = new Map<string, string>();
  for (const file of files) canonical.set(file, unique.get(hashes.get(file)!)!.file);
  return { pages, canonical, sourceBytes };
}

export function writeUiAtlas(): { files: number; unique: number; pages: number; bytes: number } {
  const packed = packUiAtlas();
  const pageInfo = packed.pages.map((page, index) => {
    const image = `${PREFIX}-${index}.png`, data = `${PREFIX}-${index}.json`;
    const atlas = new PNG({ width: page.width, height: page.height });
    atlas.data.fill(0);
    for (const [file, frame] of page.frames) {
      const png = PNG.sync.read(fs.readFileSync(path.join(PUBLIC, file)));
      for (let row = 0; row < frame.h; row++) {
        const from = row * frame.w * 4;
        const to = ((frame.y + row) * page.width + frame.x) * 4;
        png.data.copy(atlas.data, to, from, from + frame.w * 4);
      }
      // 帧之间留的是透明空隙；UI 在非整数缩放下走线性过滤，边缘会采到空隙，拼起来就透出黑缝。
      // 把最外一圈像素向四周复制 PADDING 像素，帧外的采样读到的是同一颜色。
      const put = (x: number, y: number, sourceX: number, sourceY: number): void => {
        const from = (sourceY * frame.w + sourceX) * 4;
        const to = ((frame.y + y) * page.width + frame.x + x) * 4;
        png.data.copy(atlas.data, to, from, from + 4);
      };
      for (let offset = 1; offset <= PADDING; offset++) {
        for (let x = 0; x < frame.w; x++) { put(x, -offset, x, 0); put(x, frame.h - 1 + offset, x, frame.h - 1); }
        for (let y = 0; y < frame.h; y++) { put(-offset, y, 0, y); put(frame.w - 1 + offset, y, frame.w - 1, y); }
      }
      for (let dx = 1; dx <= PADDING; dx++) for (let dy = 1; dy <= PADDING; dy++) {
        put(-dx, -dy, 0, 0); put(frame.w - 1 + dx, -dy, frame.w - 1, 0);
        put(-dx, frame.h - 1 + dy, 0, frame.h - 1); put(frame.w - 1 + dx, frame.h - 1 + dy, frame.w - 1, frame.h - 1);
      }
    }
    fs.mkdirSync(path.dirname(path.join(PUBLIC, image)), { recursive: true });
    const bytes = PNG.sync.write(atlas, { colorType: 6 });
    fs.writeFileSync(path.join(PUBLIC, image), bytes);
    const frames: Record<string, unknown> = {};
    for (const [file, frame] of page.frames) {
      frames[file] = {
        frame: { x: frame.x, y: frame.y, w: frame.w, h: frame.h },
        rotated: false, trimmed: false, spriteSourceSize: { x: 0, y: 0, w: frame.w, h: frame.h },
        sourceSize: { w: frame.w, h: frame.h }
      };
    }
    fs.writeFileSync(path.join(PUBLIC, data), JSON.stringify({
      frames,
      meta: { image: path.basename(image), format: 'RGBA8888', size: { w: page.width, h: page.height }, scale: '1' }
    }));
    return { key: `interface:${image}`, file: image, data, frame: page.sentinel!, width: page.width, height: page.height, bytes: bytes.byteLength };
  });

  // 页数变少时删掉上一轮的页，避免 public 里留下不会再被引用的旧图集。
  const directory = path.join(PUBLIC, path.dirname(PREFIX));
  const keep = new Set(pageInfo.flatMap(page => [page.file, page.data]).map(file => path.basename(file)));
  for (const name of fs.readdirSync(directory)) {
    if (/^menu-ui-\d+\.(?:png|json)$/.test(name) && !keep.has(name)) fs.rmSync(path.join(directory, name));
  }

  const mapping: Record<string, { key: string; frame: string; page: number }> = {};
  for (const [file, source] of packed.canonical) {
    const pageIndex = packed.pages.findIndex(page => page.frames.has(source));
    mapping[file] = { key: pageInfo[pageIndex].key, frame: source, page: pageIndex };
  }
  fs.mkdirSync(path.dirname(GENERATED), { recursive: true });
  fs.writeFileSync(GENERATED, `// 由 npm run atlas:ui 生成，勿手改。
export interface UiAtlasPage { key: string; file: string; data: string; frame: string; width: number; height: number }
export const UI_ATLAS_PAGES: readonly UiAtlasPage[] = ${JSON.stringify(pageInfo.map(({ bytes: _bytes, ...page }) => page), null, 2)};
export const UI_ATLAS_FRAMES: Readonly<Record<string, { key: string; frame: string; page: number }>> = ${JSON.stringify(mapping, null, 2)};
export const UI_ATLAS_SOURCE_DIGEST = ${JSON.stringify(uiAtlasSourceDigest())};
`);
  return {
    files: uiAtlasFiles().length,
    unique: packed.canonical.size === 0 ? 0 : new Set(packed.canonical.values()).size,
    pages: pageInfo.length,
    bytes: pageInfo.reduce((sum, page) => sum + page.bytes, 0)
  };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const result = writeUiAtlas();
  console.log(`菜单 UI 图集：${result.files} 张图 → ${result.unique} 帧 / ${result.pages} 页，${(result.bytes / 1024 / 1024).toFixed(2)} MB`);
}

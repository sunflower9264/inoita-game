import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';
import { gameMenuImageGroups, TITLE_MESSAGE_ASSETS, titleMenuImages } from '../src/application/menu-images.ts';
import { COMMON_BUTTON_IMAGES } from '../src/ui/common-button.ts';
import { MINIMAP_ASSETS } from '../src/domain/story-interface.ts';
import { UI_ICON_FRAMES } from '../src/generated/icon-atlas.ts';
import { sourceAssetPath } from './asset-source.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const CONTENT = path.join(PUBLIC, 'content');
const PREFIX = 'assets/ui/menu-ui';
const GENERATED = path.join(ROOT, 'src', 'generated', 'ui-atlas.ts');
/** PNG 文件头：签名里的 "PNG" 三字节加 IHDR 宽高偏移。 */
const PNG_SIGNATURE_TEXT_OFFSET = 1;
const PNG_SIGNATURE_TEXT_END = 4;
const PNG_SIGNATURE_TEXT = 'PNG';
const PNG_WIDTH_OFFSET = 16;
const PNG_HEIGHT_OFFSET = 20;
/** pngjs 的 colorType 6 = RGBA，图集必须保留透明通道。 */
const PNG_COLOR_TYPE_RGBA = 6;
const MAX_SIZE = 2048;
const PADDING = 2;

const read = (file: string): any => JSON.parse(fs.readFileSync(path.join(CONTENT, file), 'utf8'));

interface PngInfo { w: number; h: number; hash: string; bytes: Buffer }
function pngInfo(file: string): PngInfo {
  const bytes = fs.readFileSync(sourceAssetPath(file));
  if (bytes.toString('ascii', PNG_SIGNATURE_TEXT_OFFSET, PNG_SIGNATURE_TEXT_END) !== PNG_SIGNATURE_TEXT)
    throw new Error(`UI 图集只接受 PNG：${file}`);
  return { w: bytes.readUInt32BE(PNG_WIDTH_OFFSET), h: bytes.readUInt32BE(PNG_HEIGHT_OFFSET),
    hash: createHash('sha256').update(bytes).digest('hex'), bytes };
}

/** 内容里的路径统一成 `assets/...`；不是素材路径时返回 undefined。 */
function assetPath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const file = value.replace(/^\//, '');
  return file.startsWith('assets/') ? file : undefined;
}

function contentPaths(value: unknown): unknown[] {
  return value && typeof value === 'object' ? Object.values(value) : [];
}

export interface UiAtlasGroup {
  /** 加载包名；同一组的图共用一个或多个图集页。 */
  name: string;
  /** 组内按批装页：不同加载时机的小批各自从新页开始，避免互相提前拉取。 */
  batches: string[][];
  files: string[];
}

/**
 * 运行时通过 DOM 图片缓存或 UI 图集路径读取的静态图片，按加载包分组。
 *
 * 分组是为了让每个界面只下载自己马上要画的页：打开标题页不会拉菜单页，
 * 打开菜单也不会拉世界立绘页。同一张图只归一组，先出现的组优先。
 *
 * 留在图集外、继续按原文件路径加载的图：
 * - `COMMON_BUTTON_IMAGES`：共用按钮皮肤按整张纹理取图，和图集切片不能混用；
 * - `TITLE_MESSAGE_ASSETS`：标题页只加载这 7 张提示条，进图集会提前拉整页；
 * - `story.assets['quest-popup-window']`：任务窗按整张纹理使用，保留原排除理由；
 * - `controlSkinAssets`：控件皮肤的文件路径同时是 Phaser 纹理键；
 * - `status-hud` 的 `overhead-frame`/`overhead-leader`：世界头顶血条由 Phaser 直接取纹理；
 * - 小地图的 ready/active/available：头顶任务图标由 Phaser 直接取纹理；
 * - 职业选择背景：由 Phaser 场景直接取纹理；
 * - 标题页背景和 logo：`index.html` 直接按原路径预载，必须保留单文件。
 * 另外非 PNG、或单边加渗色边后超过 2048 的图也退回单文件。
 */
interface UiAtlasPlan {
  groups: UiAtlasGroup[];
  /** 内容和更早加载包里的文件相同的路径 → 已存在的规范帧。 */
  shared: Map<string, string>;
}

let planCache: UiAtlasPlan | undefined;

function planUiAtlas(): UiAtlasPlan {
  if (planCache) return planCache;
  const panels = read('menu-panels.json');
  const items = read('items.json');
  const battle = read('battle.json');
  const story = read('story-interface.json');
  const shops = read('shops.json');
  const storyClasses = read('story-classes.json');
  const statusHud = read('status-hud.json');
  const controlSkin = read('control-skin.json');

  const excluded = new Set<string>([
    ...COMMON_BUTTON_IMAGES,
    ...Object.values(TITLE_MESSAGE_ASSETS),
    ...contentPaths(controlSkin),
    story.assets['quest-popup-window'],
    storyClasses.background,
    statusHud.assets['overhead-frame'],
    statusHud.assets['overhead-leader'],
    story.assets['minimap-ready'],
    story.assets['minimap-active'],
    story.assets['minimap-available'],
    // index.html 直接预载这两张图，必须保留原路径，否则启动时会出现两次 404。
    'assets/ui/title-menu/background.png',
    'assets/ui/title-menu/logo.png'
  ].map(assetPath).filter((file): file is string => !!file));

  const menuCore = gameMenuImageGroups(panels, items, battle, story, shops).core;
  const hud = [
    ...contentPaths(statusHud.assets),
    ...contentPaths(statusHud.buffIcons?.catalog),
    ...MINIMAP_ASSETS.map(key => story.assets[key])
  ];
  // 世界立绘和对白要用时不一定同时出现，和职业选择页的界面图分开装页。
  const storyBatches: unknown[][] = [
    contentPaths(story.portraits),
    [...contentPaths(storyClasses.assets),
      ...((storyClasses.classes ?? []) as { icon?: unknown }[]).map(entry => entry.icon)]
  ];
  const title = titleMenuImages;

  const claimed = new Set<string>();
  const canonicalByHash = new Map<string, string>();
  const shared = new Map<string, string>();
  /** 从候选里挑出能进图集的 PNG；同一文件只归入第一个认领它的组。 */
  const take = (name: string, batches: unknown[][]): UiAtlasGroup => {
    const kept: string[][] = [];
    const all = new Set<string>();
    for (const candidates of batches) {
      const files = new Set<string>();
      for (const candidate of candidates) {
        const file = assetPath(candidate);
        if (!file || !file.endsWith('.png') || claimed.has(file) || excluded.has(file)) continue;
        if (UI_ICON_FRAMES[file] !== undefined) continue;
        const info = pngInfo(file);
        if (info.w + PADDING * 2 > MAX_SIZE || info.h + PADDING * 2 > MAX_SIZE) continue;
        claimed.add(file);
        // 同一内容只铺一个帧；后来的路径直接指向先出现的那个帧。
        const canonical = canonicalByHash.get(info.hash);
        if (canonical) { shared.set(file, canonical); continue; }
        canonicalByHash.set(info.hash, file);
        files.add(file);
      }
      if (!files.size) continue;
      const sorted = [...files].sort();
      kept.push(sorted);
      for (const file of sorted) all.add(file);
    }
    return { name, batches: kept, files: [...all].sort() };
  };

  // 小地图图同时出现在菜单目录和 HUD 加载包里；先归 HUD，菜单页就不会多带它们。
  // 标题页首屏优先认领自己的小图，否则会被 menu/core 的大页拖住；菜单之后再引用这些图，
  // 只需要多拉这张很小的标题页。
  const hudGroup = take('hud/status/minimap', [hud]);
  const titleGroup = take('title', [title]);
  const menuGroup = take('menu/core', [menuCore]);
  const storyGroup = take('story/portraits', storyBatches);
  const groups = [menuGroup, storyGroup, hudGroup, titleGroup]
    .filter(group => group.files.length > 0);
  planCache = { groups, shared };
  return planCache;
}

export function uiAtlasGroups(): UiAtlasGroup[] {
  return planUiAtlas().groups;
}

/** 内容重复、共用更早加载包帧的路径。 */
export function uiAtlasSharedFiles(): ReadonlyMap<string, string> {
  return planUiAtlas().shared;
}

/** 全部进入 UI 图集的文件路径；同一内容只保留一个规范帧，但每个路径都有映射。 */
export function uiAtlasFiles(): string[] {
  const plan = planUiAtlas();
  return [...plan.groups.flatMap(group => group.files), ...plan.shared.keys()].sort();
}

/** 进入图集的文件内容摘要；菜单图改了但没重跑图集时，构建期直接失败。 */
export function uiAtlasSourceDigest(): string {
  const hash = createHash('sha256');
  for (const file of uiAtlasFiles()) {
    hash.update(file);
    hash.update('\0');
    hash.update(fs.readFileSync(sourceAssetPath(file)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

interface PackedFrame { x: number; y: number; w: number; h: number }
interface PageBuild {
  group: string;
  width: number;
  height: number;
  frames: Map<string, PackedFrame>;
  sentinel?: string;
}

interface AtlasBuild {
  pages: PageBuild[];
  /** 文件 → 该文件内容对应的规范帧（同一内容的多个文件共用一个帧）。 */
  canonical: Map<string, string>;
  sourceBytes: number;
}

/**
 * 先按加载包分组，每组从新页开始；组内再按高度做货架装箱。
 * 一页超过 2048 就换下一页，但不会跨组混装。
 * 帧名用文件路径，和图标图集一致，运行时按文件路径取 `{ key, frame }`。
 */
export function packUiAtlas(): AtlasBuild {
  const plan = planUiAtlas();
  const pages: PageBuild[] = [];
  const canonical = new Map<string, string>();
  let sourceBytes = 0;

  for (const group of plan.groups) {
    // 每批从新页开始；职业选择页的界面图不会和对白立绘混在同一页。
    for (const batch of group.batches) {
      const entries = batch.map(file => {
        const bytes = fs.readFileSync(sourceAssetPath(file));
        return { file, png: PNG.sync.read(bytes), bytes: bytes.byteLength };
      }).sort((a, b) =>
        b.png.height - a.png.height || b.png.width - a.png.width || a.file.localeCompare(b.file));

      let page: PageBuild | undefined;
      let shelves: { y: number; x: number }[] = [];
      let height = 0, width = 0;
      const startPage = (): void => {
        page = { group: group.name, width: 0, height: 0, frames: new Map() };
        pages.push(page);
        shelves = []; height = 0; width = 0;
      };
      startPage();
      for (const entry of entries) {
        const w = entry.png.width, h = entry.png.height;
        sourceBytes += entry.bytes;
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
      for (const file of batch) canonical.set(file, file);
    }
  }
  // 同内容的额外路径不重复铺帧，直接映射到先出现的那一帧。
  for (const [file, source] of plan.shared) canonical.set(file, source);

  return { pages, canonical, sourceBytes };
}

interface UiAtlasWriteResult {
  files: number;
  unique: number;
  pages: number;
  bytes: number;
  groups: { name: string; files: number; pages: number; bytes: number }[];
}

export function writeUiAtlas(): UiAtlasWriteResult {
  const groups = uiAtlasGroups();
  const packed = packUiAtlas();
  const pageInfo = packed.pages.map((page, index) => {
    const image = `${PREFIX}-${index}.png`, data = `${PREFIX}-${index}.json`;
    const atlas = new PNG({ width: page.width, height: page.height });
    atlas.data.fill(0);
    for (const [file, frame] of page.frames) {
      const png = PNG.sync.read(fs.readFileSync(sourceAssetPath(file)));
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
    const bytes = PNG.sync.write(atlas, { colorType: PNG_COLOR_TYPE_RGBA });
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
    return { key: `interface:${image}`, file: image, data, frame: page.sentinel!, width: page.width, height: page.height,
      group: page.group, bytes: bytes.byteLength };
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
  const groupInfo = groups.map(group => {
    const owned = pageInfo.filter(page => page.group === group.name);
    return { name: group.name, files: group.files.length, pages: owned.length,
      bytes: owned.reduce((sum, page) => sum + page.bytes, 0) };
  });
  fs.mkdirSync(path.dirname(GENERATED), { recursive: true });
  fs.writeFileSync(GENERATED, `// 由 npm run atlas:ui 生成，勿手改。
export interface UiAtlasPage { key: string; file: string; data: string; frame: string; width: number; height: number; group: string }
export const UI_ATLAS_PAGES: readonly UiAtlasPage[] = ${JSON.stringify(pageInfo.map(({ bytes: _bytes, ...page }) => page), null, 2)};
export const UI_ATLAS_FRAMES: Readonly<Record<string, { key: string; frame: string; page: number }>> = ${JSON.stringify(mapping, null, 2)};
export const UI_ATLAS_SOURCE_DIGEST = ${JSON.stringify(uiAtlasSourceDigest())};
`);
  return {
    files: uiAtlasFiles().length,
    unique: packed.canonical.size === 0 ? 0 : new Set(packed.canonical.values()).size,
    pages: pageInfo.length,
    bytes: pageInfo.reduce((sum, page) => sum + page.bytes, 0),
    groups: groupInfo
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = writeUiAtlas();
  for (const group of result.groups) {
    console.log(`${group.name}：${group.files} 张图 → ${group.pages} 页，${(group.bytes / 1024 / 1024).toFixed(2)} MB`);
  }
  console.log(`菜单 UI 图集：${result.files} 张图 → ${result.unique} 帧 / ${result.pages} 页，${(result.bytes / 1024 / 1024).toFixed(2)} MB`);
}

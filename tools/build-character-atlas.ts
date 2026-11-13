import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';
import { packAtlasBlocks, type AtlasPackBlock, type AtlasPackingItem } from './atlas-pack.ts';
import { sourceAssetPath } from './asset-source.ts';
import { walkClips } from './content-build.ts';

/**
 * 把运行时引用的角色动作长条图拆成帧，再按角色装箱成若干页图集。
 *
 * 不裁剪透明边：角色原点、碰撞盒和像素对齐都按完整帧计算，保留原帧尺寸最稳。
 * 每个 actor 是一个装箱块，块内项目是「单个帧」；被多个 actor 共用的文件放进
 * 单独的 shared 块，只装一次。一个长条图的帧可能跨页，所以映射按帧记录页号。
 *
 * `build.mjs` 同步调用 `writeCharacterAtlas()`，而 `planClipDedupe()` 是异步的。
 * 这里同步复刻 `content-build.ts` 的合并规则（同样按内容哈希、帧尺寸、帧数和
 * 素材目录分组，规范路径取字典序最小的文件和键），保证图集键与运行时内容一致。
 * 生成脚本会把每个出现过的路径都写进映射，即使未来出现重新编码的同内容文件，
 * 运行时也不会因为规范路径不同而漏掉映射。
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PUBLIC = path.join(ROOT, 'public');
const CONTENT = path.join(PUBLIC, 'content');
const ATLAS_DIR = 'assets/character-atlas';
const GENERATED = path.join(ROOT, 'src', 'generated', 'character-atlas.ts');
/** 只给工具做源路径覆盖判断；运行时不导入，避免把别名表打进游戏包。 */
const TOOL_ALIASES = path.join(ROOT, 'tools', 'character-atlas-aliases.ts');
const PAGE_KEY_PREFIX = 'characters-atlas:';
/** PNG 文件头：前 4 字节签名与 IHDR 宽高偏移。 */
const PNG_SIGNATURE = 0x89504e47;
const PNG_MIN_HEADER_BYTES = 24;
const PNG_WIDTH_OFFSET = 16;
const PNG_HEIGHT_OFFSET = 20;
/** pngjs 的 colorType 6 = RGBA，图集必须保留透明通道。 */
const PNG_COLOR_TYPE_RGBA = 6;
/** 帧名前缀取内容哈希前 10 位，帧号补零到 3 位；运行时按同一格式找帧。 */
const FRAME_PREFIX_HEX_LENGTH = 10;
const FRAME_INDEX_DIGITS = 3;
/**
 * 角色页用 1024：2048 页会让一个小怪也拉起整页几十 MB 的解码纹理。
 * 1024 页更多，但单个角色实际加载的页面积显著变小。
 */
const MAX_SIZE = 1024;
const PADDING = 2;
const PACKER_VERSION = 2;

export interface CharacterAtlasPage {
  key: string;
  file: string;
  data: string;
  frame: string;
  width: number;
  height: number;
}

export interface CharacterAtlasEntry {
  /** 第 index 帧所在页；数组下标就是帧序号。 */
  pages: readonly number[];
  /** 文件内容 sha256 前 10 位；帧名是 `${prefix}-${补零帧号}`。 */
  prefix: string;
}

interface ClipLayerLike { key: string; file: string }
interface ClipLike {
  frameWidth: number;
  frameHeight: number;
  frames: number;
  layers: ClipLayerLike[];
}
interface ActorLike { id: string; clips: Record<string, ClipLike | undefined> }
interface WorldLike { actors?: Record<string, ActorLike> }
interface BattleLike {
  classes?: { actor?: ActorLike }[];
  enemies?: { actor?: ActorLike }[];
}
interface StoryClassesLike { classes?: { previewActor?: ActorLike; playerActor?: ActorLike }[] }

/** 一个内容哈希 + 帧尺寸组合；同一份图在结构上只解一次。 */
interface GroupSource {
  id: string;
  hash: string;
  prefix: string;
  paths: string[];
  frameWidth: number;
  frameHeight: number;
  /** 所有引用里最大的帧数。 */
  frames: number;
  /** 源 PNG 尺寸。 */
  width: number;
  height: number;
  /** 用到这个文件的所有 actor。 */
  owners: string[];
}

export interface CharacterAtlasActorSource {
  id: string;
  groups: string[];
  /** 该 actor 各分组实际引用的最大帧数；只用于统计单角色页占用。 */
  groupFrames: Readonly<Record<string, number>>;
}

export interface CharacterAtlasSource {
  groups: GroupSource[];
  actors: CharacterAtlasActorSource[];
  /** 规范文件路径 → 分组 id。 */
  byFile: Readonly<Record<string, string>>;
  /** 原始路径 → 规范路径；只给工具做覆盖判断，不进入运行时映射。 */
  aliases: Readonly<Record<string, string>>;
}

export interface CharacterAtlasWriteResult {
  pages: number;
  files: number;
  frames: number;
  source: number;
  packed: number;
  bytes: number;
}

interface FrameItem extends AtlasPackingItem {
  group: string;
  index: number;
}

interface PackedFrameItem extends FrameItem {
  x: number;
  y: number;
}

const compareText = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
export const frameName = (prefix: string, index: number): string => `${prefix}-${String(index).padStart(FRAME_INDEX_DIGITS, '0')}`;

type HashFile = (file: string) => string;

function createHashFile(): HashFile {
  const cache = new Map<string, string>();
  return file => {
    const cached = cache.get(file);
    if (cached !== undefined) return cached;
    let hash = '';
    try {
      hash = createHash('sha256').update(fs.readFileSync(sourceAssetPath(file))).digest('hex');
    } catch {
      hash = '';
    }
    cache.set(file, hash);
    return hash;
  };
}

/** 素材分类目录：`assets/<分类>/...` 的第二段；不同分类的同内容图片不能共用帧。 */
function assetKindOf(file: string): string {
  return file.split('/')[1] ?? '';
}

/**
 * 与 `content-build.ts` 的 `dedupeClipLayers` 同一套合并规则，同步版本。
 * 返回已经改写为规范键/路径的 world 与 battle 文档。
 */
function canonicalDocuments(hashFile: HashFile): {
  world: WorldLike; battle: BattleLike; storyClasses: StoryClassesLike; aliases: Map<string, string>;
} {
  const documents = new Map<string, unknown>();
  for (const name of ['battle.json', 'world.json', 'story-classes.json'])
    documents.set(name, JSON.parse(fs.readFileSync(path.join(CONTENT, name), 'utf8')));
  const records: { clip: ClipLike; layer: ClipLayerLike }[] = [];
  for (const document of documents.values())
    walkClips(document, clip => {
      for (const layer of (clip as ClipLike).layers) if (layer.file) records.push({ clip: clip as ClipLike, layer });
    });
  const groups = new Map<string, ClipLayerLike[]>();
  for (const record of records) {
    const hash = hashFile(record.layer.file);
    if (!hash) continue;
    const kind = assetKindOf(record.layer.file);
    const group = [hash, record.clip.frameWidth, record.clip.frameHeight, record.clip.frames, kind].join('|');
    const entries = groups.get(group);
    if (entries) entries.push(record.layer); else groups.set(group, [record.layer]);
  }
  const keyOwners = new Map<string, string>();
  const canonical = new Map<string, { key: string; file: string }>();
  const aliases = new Map<string, string>();
  for (const [group, entries] of groups) {
    const ordered = [...entries].sort((a, b) => a.file.localeCompare(b.file) || a.key.localeCompare(b.key));
    const chosen = { key: ordered[0]!.key, file: ordered[0]!.file };
    const owner = keyOwners.get(chosen.key);
    if (owner && owner !== group) throw new Error(`贴图键指向不同资源：${chosen.key}`);
    keyOwners.set(chosen.key, group);
    canonical.set(group, chosen);
  }
  for (const record of records) {
    const hash = hashFile(record.layer.file);
    if (!hash) continue;
    const kind = assetKindOf(record.layer.file);
    const group = [hash, record.clip.frameWidth, record.clip.frameHeight, record.clip.frames, kind].join('|');
    const chosen = canonical.get(group);
    if (!chosen) continue;
    aliases.set(record.layer.file, chosen.file);
    record.layer.key = chosen.key;
    record.layer.file = chosen.file;
  }
  return { world: documents.get('world.json') as WorldLike,
    battle: documents.get('battle.json') as BattleLike,
    storyClasses: documents.get('story-classes.json') as StoryClassesLike, aliases };
}

/**
 * world 的全部 actor，加上职业/敌人内嵌 actor 和职业选择的预览、玩家 actor；同 id 合并。
 * story-classes 与 battle/world 走同一套去重，`playerActor` 的重复方向才能落到规范路径。
 */
function sourceActors(world: WorldLike, battle: BattleLike, storyClasses: StoryClassesLike): ActorLike[] {
  const actors = new Map<string, ActorLike>();
  const add = (actor: ActorLike | undefined): void => {
    if (!actor?.id) return;
    const previous = actors.get(actor.id);
    if (!previous) { actors.set(actor.id, actor); return; }
    for (const [name, clip] of Object.entries(actor.clips ?? {}))
      if (!previous.clips[name]) previous.clips[name] = clip;
  };
  for (const actor of Object.values(world.actors ?? {})) add(actor);
  for (const character of battle.classes ?? []) add(character.actor);
  for (const enemy of battle.enemies ?? []) add(enemy.actor);
  for (const entry of storyClasses.classes ?? []) { add(entry.previewActor); add(entry.playerActor); }
  return [...actors.values()].sort((a, b) => compareText(a.id, b.id));
}

/**
 * 收集图集的全部输入。导出给测试用来复算摘要和核对内容覆盖。
 */
export function collectCharacterAtlasSource(): CharacterAtlasSource {
  const hashFile = createHashFile();
  const { world, battle, storyClasses, aliases } = canonicalDocuments(hashFile);
  const actors = sourceActors(world, battle, storyClasses);
  const groups = new Map<string, {
    hash: string; prefix: string; paths: Set<string>; frameWidth: number; frameHeight: number;
    frames: number; owners: Set<string>;
  }>();
  const byFile = new Map<string, string>();
  const hashGeometries = new Map<string, string>();
  const prefixGeometries = new Map<string, string>();
  for (const actor of actors) {
    for (const clip of Object.values(actor.clips ?? {})) {
      if (!clip) continue;
      for (const layer of clip.layers ?? []) {
        if (!layer.file) continue;
        const hash = hashFile(layer.file);
        if (!hash) throw new Error(`角色图集素材缺失：${layer.file}`);
        const geometry = `${clip.frameWidth}x${clip.frameHeight}`;
        const known = hashGeometries.get(hash);
        if (known && known !== geometry)
          throw new Error(`同一内容出现不同帧尺寸，无法共用帧名：${layer.file}（${known} / ${geometry}）`);
        hashGeometries.set(hash, geometry);
        const prefix = hash.slice(0, FRAME_PREFIX_HEX_LENGTH);
        const seenPrefix = prefixGeometries.get(prefix);
        if (seenPrefix && seenPrefix !== geometry)
          throw new Error(`不同内容共用帧名前缀：${prefix}（${seenPrefix} / ${geometry}）`);
        prefixGeometries.set(prefix, geometry);
        const id = `${hash}:${geometry}`;
        let group = groups.get(id);
        if (!group) {
          group = { hash, prefix, paths: new Set(), frameWidth: clip.frameWidth, frameHeight: clip.frameHeight,
            frames: clip.frames, owners: new Set() };
          groups.set(id, group);
        }
        if (clip.frames > group.frames) group.frames = clip.frames;
        group.paths.add(layer.file);
        group.owners.add(actor.id);
        byFile.set(layer.file, id);
      }
    }
  }
  const sources: GroupSource[] = [];
  for (const [id, group] of [...groups].sort(([a], [b]) => compareText(a, b))) {
    const file = [...group.paths].sort(compareText)[0]!;
    const bytes = fs.readFileSync(sourceAssetPath(file));
    if (bytes.length < PNG_MIN_HEADER_BYTES || bytes.readUInt32BE(0) !== PNG_SIGNATURE)
      throw new Error(`角色图集素材不是有效的 PNG：${file}`);
    const width = bytes.readUInt32BE(PNG_WIDTH_OFFSET), height = bytes.readUInt32BE(PNG_HEIGHT_OFFSET);
    const columns = Math.floor(width / group.frameWidth);
    const rows = Math.floor(height / group.frameHeight);
    if (columns < 1 || rows < 1 || columns * rows < group.frames)
      throw new Error(`角色图不足 ${group.frames} 帧：${file}（${width}×${height}，每帧 ${group.frameWidth}×${group.frameHeight}）`);
    sources.push({ id, hash: group.hash, prefix: group.prefix, paths: [...group.paths].sort(compareText),
      frameWidth: group.frameWidth, frameHeight: group.frameHeight, frames: group.frames,
      width, height, owners: [...group.owners].sort(compareText) });
  }
  const actorSources: CharacterAtlasActorSource[] = actors.map(actor => {
    const ids = new Set<string>();
    const groupFrames: Record<string, number> = {};
    for (const clip of Object.values(actor.clips ?? {})) {
      if (!clip) continue;
      for (const layer of clip.layers ?? []) {
        if (!layer.file) continue;
        const id = byFile.get(layer.file);
        if (!id) continue;
        ids.add(id);
        groupFrames[id] = Math.max(groupFrames[id] ?? 0, clip.frames);
      }
    }
    return { id: actor.id, groups: [...ids].sort(compareText), groupFrames };
  });
  return { groups: sources, actors: actorSources,
    byFile: Object.fromEntries([...byFile].sort(([a], [b]) => compareText(a, b))),
    aliases: Object.fromEntries([...aliases].sort(([a], [b]) => compareText(a, b))) };
}

function groupItems(group: GroupSource): FrameItem[] {
  const items: FrameItem[] = [];
  for (let index = 0; index < group.frames; index++)
    items.push({ id: frameName(group.prefix, index), width: group.frameWidth, height: group.frameHeight,
      group: group.id, index });
  return items;
}

/**
 * 装箱：被多个 actor 共用的文件按「共用同一批 actor」分块，其余文件按 actor 分块。
 * 每个文件只装一次；同一批角色的共用素材仍尽量落在一起，换装/佣兵不会因为
 * 一个巨大公共块被拆到很多页。
 */
function packSource(source: CharacterAtlasSource): Array<PackedFrameItem[]> {
  const groupById = new Map(source.groups.map(group => [group.id, group]));
  const blocks: AtlasPackBlock<FrameItem>[] = [];
  const shared = new Map<string, FrameItem[]>();
  for (const group of source.groups) {
    if (group.owners.length < 2) continue;
    const id = `shared:${group.owners.join(',')}`;
    const items = shared.get(id);
    if (items) items.push(...groupItems(group)); else shared.set(id, groupItems(group));
  }
  for (const [id, items] of shared) blocks.push({ id, items });
  for (const actor of source.actors) {
    const items = actor.groups.map(id => groupById.get(id)!)
      .filter(group => group.owners.length === 1).flatMap(groupItems);
    if (items.length) blocks.push({ id: `actor:${actor.id}`, items });
  }
  return packAtlasBlocks(blocks, { maxSize: MAX_SIZE, padding: PADDING })
    .map(page => page.items as PackedFrameItem[]);
}

interface WrittenPage extends CharacterAtlasPage {
  png: Buffer;
  json: string;
}

function writePages(source: CharacterAtlasSource, pages: PackedFrameItem[][]): WrittenPage[] {
  const groupById = new Map(source.groups.map(group => [group.id, group]));
  const written: WrittenPage[] = [];
  for (const [pageIndex, items] of pages.entries()) {
    const width = Math.max(1, ...items.map(item => item.x + item.width + PADDING));
    const height = Math.max(1, ...items.map(item => item.y + item.height + PADDING));
    if (width > MAX_SIZE || height > MAX_SIZE)
      throw new Error(`角色图集页超出 ${MAX_SIZE} 像素：${width}×${height}`);
    const png = new PNG({ width, height });
    png.data.fill(0);
    const byGroup = new Map<string, PackedFrameItem[]>();
    for (const item of items) {
      const list = byGroup.get(item.group);
      if (list) list.push(item); else byGroup.set(item.group, [item]);
    }
    const frames: Record<string, unknown> = {};
    for (const [groupId, groupItemsOnPage] of byGroup) {
      const group = groupById.get(groupId);
      if (!group) throw new Error(`角色图集分组缺失：${groupId}`);
      const pngSource = PNG.sync.read(fs.readFileSync(sourceAssetPath(group.paths[0]!)));
      const columns = Math.floor(pngSource.width / group.frameWidth);
      for (const item of groupItemsOnPage) {
        if (item.index < 0 || item.index >= group.frames || item.index >= columns * Math.floor(pngSource.height / group.frameHeight))
          throw new Error(`角色图集帧越界：${group.paths[0]} 第 ${item.index} 帧`);
        const sx = (item.index % columns) * group.frameWidth;
        const sy = Math.floor(item.index / columns) * group.frameHeight;
        for (let row = 0; row < group.frameHeight; row++) {
          const from = ((sy + row) * pngSource.width + sx) * 4;
          const to = ((item.y + row) * width + item.x) * 4;
          pngSource.data.copy(png.data, to, from, from + group.frameWidth * 4);
        }
        frames[item.id] = {
          frame: { x: item.x, y: item.y, w: group.frameWidth, h: group.frameHeight },
          rotated: false,
          trimmed: false,
          spriteSourceSize: { x: 0, y: 0, w: group.frameWidth, h: group.frameHeight },
          sourceSize: { w: group.frameWidth, h: group.frameHeight }
        };
      }
    }
    const key = `${PAGE_KEY_PREFIX}${pageIndex}`;
    const file = `${ATLAS_DIR}/characters-${pageIndex}.png`;
    const data = `${ATLAS_DIR}/characters-${pageIndex}.json`;
    const json = JSON.stringify({
      frames,
      meta: { image: `characters-${pageIndex}.png`, format: 'RGBA8888',
        size: { w: width, h: height }, scale: '1' }
    });
    written.push({ key, file, data, frame: items[0]!.id, width, height,
      png: PNG.sync.write(png, { colorType: PNG_COLOR_TYPE_RGBA }), json });
  }
  return written;
}

function digestSource(source: CharacterAtlasSource): string {
  const hash = createHash('sha256');
  hash.update(`character-atlas\0packer:${PACKER_VERSION}\0`);
  hash.update(fs.readFileSync(fileURLToPath(import.meta.url)));
  hash.update('\0');
  hash.update(fs.readFileSync(fileURLToPath(new URL('./atlas-pack.ts', import.meta.url))));
  hash.update('\0');
  for (const actor of source.actors)
    hash.update(`actor\0${actor.id}\0${actor.groups.join(',')}\0`);
  for (const group of source.groups)
    hash.update(`group\0${group.id}\0${group.hash}\0${group.frameWidth}\0${group.frameHeight}\0` +
      `${group.frames}\0${group.width}\0${group.height}\0${group.paths.join(',')}\0${group.owners.join(',')}\0`);
  for (const [from, to] of Object.entries(characterAliases(source)))
    hash.update(`alias\0${from}\0${to}\0`);
  return hash.digest('hex');
}

/** 只保留角色图集真正接管的别名；特效/剧情路径由特效图集自己映射。 */
function characterAliases(source: CharacterAtlasSource): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(source.aliases)
    .filter(([, canonical]) => Object.hasOwn(source.byFile, canonical))
    .sort(([a], [b]) => compareText(a, b)));
}

export function characterAtlasSourceDigest(source: CharacterAtlasSource = collectCharacterAtlasSource()): string {
  return digestSource(source);
}

export function writeCharacterAtlas(): CharacterAtlasWriteResult {
  const source = collectCharacterAtlasSource();
  const pages = packSource(source);
  const written = writePages(source, pages);
  fs.mkdirSync(path.join(PUBLIC, ATLAS_DIR), { recursive: true });
  const atlasDir = path.join(PUBLIC, ATLAS_DIR);
  for (const file of fs.readdirSync(atlasDir))
    if (/^characters-\d+\.(png|json)$/.test(file)) fs.unlinkSync(path.join(atlasDir, file));
  for (const page of written) {
    fs.writeFileSync(path.join(PUBLIC, page.file), page.png);
    fs.writeFileSync(path.join(PUBLIC, page.data), page.json);
  }
  // 自检：每个运行时引用到的文件都有映射，且每个 clip 的帧数都被映射覆盖。
  const pagesByGroup = new Map(source.groups.map(group =>
    [group.id, new Array<number>(group.frames).fill(-1)]));
  for (const [pageIndex, items] of pages.entries())
    for (const item of items) pagesByGroup.get(item.group)![item.index] = pageIndex;
  const entries: Record<string, CharacterAtlasEntry> = {};
  for (const group of source.groups) {
    const frames = pagesByGroup.get(group.id)!;
    if (frames.some(index => index < 0 || !written[index]))
      throw new Error(`角色图集帧没有全部装页：${group.paths.join(', ')}`);
    const entry = { pages: frames, prefix: group.prefix };
    for (const file of group.paths) entries[file] = entry;
  }
  // 自检：运行时见到的每个路径都有映射，每个分组所需的帧数都不超过映射长度。
  for (const file of Object.keys(source.byFile))
    if (!entries[file]) throw new Error(`角色图集缺少文件映射：${file}`);
  for (const group of source.groups) {
    const entry = entries[group.paths[0]!];
    if (!entry || entry.pages.length < group.frames)
      throw new Error(`角色图集帧数不足：${group.paths.join(', ')}（映射 ${entry?.pages.length ?? 0} / 引用 ${group.frames}）`);
  }
  const sortedEntries = Object.fromEntries(Object.entries(entries).sort(([a], [b]) => compareText(a, b)));
  const digest = digestSource(source);
  fs.mkdirSync(path.dirname(GENERATED), { recursive: true });
  fs.writeFileSync(GENERATED, `// 由 npm run atlas:characters 生成，勿手改。
export interface CharacterAtlasPage { key: string; file: string; data: string; frame: string; width: number; height: number }
export const CHARACTER_ATLAS_PAGES: readonly CharacterAtlasPage[] = ${JSON.stringify(written.map(
    ({ key, file, data, frame, width, height }) => ({ key, file, data, frame, width, height })), null, 2)};
export interface CharacterAtlasEntry { pages: readonly number[]; prefix: string }
export const CHARACTER_ATLAS_BY_FILE: Readonly<Record<string, CharacterAtlasEntry>> = ${JSON.stringify(sortedEntries, null, 2)};
export const CHARACTER_ATLAS_SOURCE_DIGEST = ${JSON.stringify(digest)};
`);
  fs.writeFileSync(TOOL_ALIASES, `// 由 npm run atlas:characters 生成，勿手改。
// 源路径 → 规范路径；仅用于内容构建前的素材覆盖判断，不进入运行时包。
export const CHARACTER_ATLAS_ALIASES: Readonly<Record<string, string>> = ${JSON.stringify(characterAliases(source), null, 2)};
`);
  // 构建期报告：单个角色实际会拉起的页并集面积。页越大，小角色被整页拖累越明显。
  const groupById = new Map(source.groups.map(group => [group.id, group]));
  const worst = source.actors.map(actor => {
    const pages = new Set<number>();
    for (const groupId of actor.groups) {
      const group = groupById.get(groupId);
      const entry = group ? entries[group.paths[0]!] : undefined;
      if (!entry) continue;
      const needed = Math.min(actor.groupFrames[groupId] ?? entry.pages.length, entry.pages.length);
      for (const page of entry.pages.slice(0, needed)) pages.add(page);
    }
    let bytes = 0;
    for (const page of pages) {
      const writtenPage = written[page];
      if (writtenPage) bytes += writtenPage.width * writtenPage.height * 4;
    }
    return { id: actor.id, pages: pages.size, bytes };
  }).sort((a, b) => b.bytes - a.bytes || compareText(a.id, b.id)).slice(0, 10);
  console.log('角色图集单角色页占用（页并集 × 页面积）：');
  for (const row of worst)
    console.log(`  ${row.id}: ${row.pages} 页 / ${(row.bytes / 1048576).toFixed(1)} MB`);

  return {
    pages: written.length,
    files: Object.keys(sortedEntries).length,
    frames: source.groups.reduce((sum, group) => sum + group.frames, 0),
    source: source.groups.reduce((sum, group) => sum + group.width * group.height, 0),
    packed: written.reduce((sum, page) => sum + page.width * page.height, 0),
    bytes: written.reduce((sum, page) => sum + page.png.byteLength, 0)
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = writeCharacterAtlas();
  console.log(`角色图集：${result.files} 个文件 / ${result.frames} 帧 / ${result.pages} 页，` +
    `${(result.source / 1048576).toFixed(1)} MB 源图 -> ${(result.packed / 1048576).toFixed(1)} MB 页，` +
    `${(result.bytes / 1048576).toFixed(2)} MB 磁盘`);
}

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { planClipDedupe, walkClips } from './content-build.ts';
import { EFFECT_ATLAS_BY_FILE, EFFECT_ATLAS_PAGES } from '../src/generated/effect-atlas.ts';

interface AssetDuplicateGroup {
  hash: string;
  count: number;
  bytes: number;
  decodedBytes: number;
  width?: number;
  height?: number;
  files: string[];
}

interface AssetReport {
  files: number;
  bytes: number;
  decodedBytes: number;
  uniqueFiles: number;
  uniqueBytes: number;
  uniqueDecodedBytes: number;
  duplicateGroups: number;
  duplicateFiles: number;
  duplicateBytes: number;
  duplicateDecodedBytes: number;
  topDuplicateGroups: AssetDuplicateGroup[];
  runtime?: RuntimeAssetReport;
}

/**
 * 生产构建口径：构建期会把字节、帧尺寸、帧数、帧率和循环类型都相同的动画图层
 * 合并到同一个贴图键。这里复用同一套合并规则，统计运行时实际会引用的素材量。
 */
interface RuntimeAssetReport {
  clipKeysBefore: number;
  clipKeysAfter: number;
  dedupedLayers: number;
  referencedFiles: number;
  referencedDecodedBytes: number;
  residualDuplicateGroups: number;
  residualDuplicateFiles: number;
  residualDuplicateDecodedBytes: number;
}

interface AssetReportRoots {
  /** 源素材归档根目录，下面直接包含 assets/。默认仓库根目录的 asset-source。 */
  sourceRoot?: string;
  /** 编译后的内容目录，直接包含 world.json / battle.json。默认 public/content。 */
  contentRoot?: string;
}

/** PNG 文件头：签名里的 "PNG" 三字节加 IHDR 宽高偏移。 */
const PNG_SIGNATURE_TEXT_OFFSET = 1;
const PNG_SIGNATURE_TEXT_END = 4;
const PNG_SIGNATURE_TEXT = 'PNG';
const PNG_MIN_HEADER_BYTES = 24;
const PNG_WIDTH_OFFSET = 16;
const PNG_HEIGHT_OFFSET = 20;

/** WebP（RIFF 容器）：块类型区分 VP8X/VP8L/VP8 三种宽高编码。 */
const WEBP_RIFF_OFFSET = 0;
const WEBP_RIFF_END = 4;
const WEBP_CHUNK_TYPE_OFFSET = 12;
const WEBP_CHUNK_TYPE_END = 16;
const WEBP_MIN_HEADER_BYTES = 30;
const WEBP_VP8X_WIDTH_OFFSET = 24;
const WEBP_VP8X_HEIGHT_OFFSET = 27;
const WEBP_VP8X_DIMENSION_BYTES = 3;
const WEBP_VP8L_BITS_OFFSET = 21;
const WEBP_VP8L_DIMENSION_BITS = 14;
const WEBP_VP8L_DIMENSION_MASK = 0x3fff;
const WEBP_VP8_FRAME_WIDTH_OFFSET = 26;
const WEBP_VP8_FRAME_HEIGHT_OFFSET = 28;
const WEBP_VP8_DIMENSION_MASK = 0x3fff;

/** JPEG：SOI 标识 0xFFD8；SOF0–SOF3 段里宽度在段内 +7、高度在 +5。 */
const JPEG_MARKER_PREFIX = 0xff;
const JPEG_START_OF_IMAGE = 0xd8;
const JPEG_MIN_HEADER_BYTES = 4;
const JPEG_SEGMENT_LENGTH_OFFSET = 2;
const JPEG_SOF0_MARKER = 0xc0;
const JPEG_SOF3_MARKER = 0xc3;
const JPEG_SOF_SEGMENT_WIDTH_OFFSET = 7;
const JPEG_SOF_SEGMENT_HEIGHT_OFFSET = 5;
/** 读 SOF 段宽高前至少要留够 10 字节：段内偏移 7 再读 2 字节。 */
const JPEG_SOF_SEGMENT_MIN_REMAINING = 10;

interface ImageSize { width: number; height: number }

/** 只读 IHDR / SOF / VP8X；读不出尺寸的格式按 0 计，不阻塞报告。 */
function imageSize(bytes: Buffer, file: string): ImageSize | undefined {
  const ext = path.extname(file).toLowerCase();
  try {
    if (ext === '.png' && bytes.length >= PNG_MIN_HEADER_BYTES
      && bytes.toString('ascii', PNG_SIGNATURE_TEXT_OFFSET, PNG_SIGNATURE_TEXT_END) === PNG_SIGNATURE_TEXT) {
      return { width: bytes.readUInt32BE(PNG_WIDTH_OFFSET), height: bytes.readUInt32BE(PNG_HEIGHT_OFFSET) };
    }
    if (ext === '.webp' && bytes.length >= WEBP_MIN_HEADER_BYTES
      && bytes.toString('ascii', WEBP_RIFF_OFFSET, WEBP_RIFF_END) === 'RIFF') {
      const kind = bytes.toString('ascii', WEBP_CHUNK_TYPE_OFFSET, WEBP_CHUNK_TYPE_END);
      if (kind === 'VP8X') return {
        width: 1 + bytes.readUIntLE(WEBP_VP8X_WIDTH_OFFSET, WEBP_VP8X_DIMENSION_BYTES),
        height: 1 + bytes.readUIntLE(WEBP_VP8X_HEIGHT_OFFSET, WEBP_VP8X_DIMENSION_BYTES),
      };
      if (kind === 'VP8L') {
        const bits = bytes.readUInt32LE(WEBP_VP8L_BITS_OFFSET);
        return {
          width: 1 + (bits & WEBP_VP8L_DIMENSION_MASK),
          height: 1 + ((bits >> WEBP_VP8L_DIMENSION_BITS) & WEBP_VP8L_DIMENSION_MASK),
        };
      }
      if (kind === 'VP8 ') return {
        width: bytes.readUInt16LE(WEBP_VP8_FRAME_WIDTH_OFFSET) & WEBP_VP8_DIMENSION_MASK,
        height: bytes.readUInt16LE(WEBP_VP8_FRAME_HEIGHT_OFFSET) & WEBP_VP8_DIMENSION_MASK,
      };
    }
    if ((ext === '.jpg' || ext === '.jpeg') && bytes.length > JPEG_MIN_HEADER_BYTES
      && bytes[0] === JPEG_MARKER_PREFIX && bytes[1] === JPEG_START_OF_IMAGE) {
      for (let at = 2; at + JPEG_SOF_SEGMENT_MIN_REMAINING <= bytes.length;) {
        if (bytes[at] !== JPEG_MARKER_PREFIX) { at++; continue; }
        const marker = bytes[at + 1];
        const length = bytes.readUInt16BE(at + JPEG_SEGMENT_LENGTH_OFFSET);
        if (marker >= JPEG_SOF0_MARKER && marker <= JPEG_SOF3_MARKER) return {
          width: bytes.readUInt16BE(at + JPEG_SOF_SEGMENT_WIDTH_OFFSET),
          height: bytes.readUInt16BE(at + JPEG_SOF_SEGMENT_HEIGHT_OFFSET),
        };
        at += 2 + length;
      }
    }
  } catch { /* 损坏的图片头只影响归因，不影响加载 */ }
  return undefined;
}

function filesUnder(directory: string, relative = ''): { relative: string; absolute: string }[] {
  const result: { relative: string; absolute: string }[] = [];
  if (!fs.existsSync(directory)) return result;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    const childAbsolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...filesUnder(childAbsolute, childRelative));
    else if (entry.isFile()) result.push({ relative: childRelative, absolute: childAbsolute });
  }
  return result;
}

/**
 * 构建期资产归因：按文件内容 SHA-256 分组，再按图片尺寸估算解码后的 RGBA 字节。
 * 只看磁盘内容，不依赖业务代码，因此不会因为内容/加载策略调整而失真。
 */
export async function reportAssets(roots: AssetReportRoots = {}): Promise<AssetReport> {
  const sourceRoot = roots.sourceRoot ?? path.resolve('asset-source');
  const contentRoot = roots.contentRoot ?? path.resolve('public/content');
  const files = filesUnder(path.join(sourceRoot, 'assets'));
  const groups = new Map<string, AssetDuplicateGroup & { decodedBytes: number }>();
  const index = new Map<string, { hash: string; decodedBytes: number }>();
  let bytes = 0, decodedBytes = 0;
  for (const file of files) {
    const content = fs.readFileSync(file.absolute);
    const hash = createHash('sha256').update(content).digest('hex');
    const size = imageSize(content, file.absolute);
    const decoded = size ? size.width * size.height * 4 : 0;
    bytes += content.byteLength;
    decodedBytes += decoded;
    index.set(`assets/${file.relative}`, { hash, decodedBytes: decoded });
    const existing = groups.get(hash);
    if (existing) {
      existing.count++;
      existing.files.push(file.relative);
      // 相同内容尺寸必然相同；保留第一份的尺寸即可。
    } else {
      groups.set(hash, {
        hash, count: 1, bytes: content.byteLength, decodedBytes: decoded,
        ...(size ? { width: size.width, height: size.height } : {}), files: [file.relative]
      });
    }
  }
  let uniqueBytes = 0, uniqueDecodedBytes = 0, duplicateGroups = 0, duplicateFiles = 0, duplicateBytes = 0, duplicateDecodedBytes = 0;
  for (const group of groups.values()) {
    uniqueBytes += group.bytes;
    uniqueDecodedBytes += group.decodedBytes;
    if (group.count > 1) {
      duplicateGroups++;
      duplicateFiles += group.count - 1;
      duplicateBytes += group.bytes * (group.count - 1);
      duplicateDecodedBytes += group.decodedBytes * (group.count - 1);
    }
  }
  const topDuplicateGroups = [...groups.values()]
    .filter(group => group.count > 1)
    .sort((a, b) => b.decodedBytes * (b.count - 1) - a.decodedBytes * (a.count - 1))
    .slice(0, 20)
    .map(({ hash, count, bytes, decodedBytes, width, height, files }) => ({ hash, count, bytes, decodedBytes, width, height, files }));
  const runtime = await runtimeReport(sourceRoot, contentRoot, index);
  return {
    files: files.length, bytes, decodedBytes,
    uniqueFiles: groups.size, uniqueBytes, uniqueDecodedBytes,
    duplicateGroups, duplicateFiles, duplicateBytes, duplicateDecodedBytes,
    topDuplicateGroups,
    ...(runtime ? { runtime } : {})
  };
}

/**
 * 按运行时实际加载规则收集贴图：命中特效图集的图层只加载图集页，
 * 不加载 battle-effects 里的原始帧图；其余图层仍按文件路径加载。
 */
function runtimeFiles(docs: ReadonlyMap<string, unknown>): string[] {
  const files = new Set<string>();
  for (const document of docs.values())
    walkClips(document, clip => {
      for (const layer of clip.layers) {
        if (!layer.file) continue;
        const atlas = EFFECT_ATLAS_BY_FILE[layer.file];
        if (!atlas) { files.add(layer.file); continue; }
        for (const frame of atlas.slice(0, clip.frames)) {
          const page = EFFECT_ATLAS_PAGES[frame.page];
          if (page) files.add(page.file);
        }
      }
    });
  return [...files];
}

/**
 * 读取 content/world.json 与 battle.json，按构建期的合并规则算出运行时贴图引用。
 * 没有内容文件时返回 undefined，让报告仍可只统计纯素材目录。
 */
async function runtimeReport(
  sourceRoot: string,
  contentRoot: string,
  index: ReadonlyMap<string, { hash: string; decodedBytes: number }>
): Promise<RuntimeAssetReport | undefined> {
  if (!fs.existsSync(path.join(contentRoot, 'world.json')) && !fs.existsSync(path.join(contentRoot, 'battle.json')))
    return undefined;
  const dedupe = await planClipDedupe(contentRoot, sourceRoot);
  let referencedFiles = 0, referencedDecodedBytes = 0;
  const byHash = new Map<string, { decodedBytes: number; count: number }>();
  for (const file of runtimeFiles(dedupe.docs)) {
    const asset = index.get(file);
    if (!asset) continue;
    referencedFiles++;
    referencedDecodedBytes += asset.decodedBytes;
    const group = byHash.get(asset.hash);
    if (group) group.count++;
    else byHash.set(asset.hash, { decodedBytes: asset.decodedBytes, count: 1 });
  }
  let residualDuplicateGroups = 0, residualDuplicateFiles = 0, residualDuplicateDecodedBytes = 0;
  for (const group of byHash.values()) {
    if (group.count < 2) continue;
    residualDuplicateGroups++;
    residualDuplicateFiles += group.count - 1;
    residualDuplicateDecodedBytes += group.decodedBytes * (group.count - 1);
  }
  return {
    clipKeysBefore: dedupe.clipKeysBefore,
    clipKeysAfter: dedupe.clipKeysAfter,
    dedupedLayers: dedupe.dedupedLayers,
    referencedFiles,
    referencedDecodedBytes,
    residualDuplicateGroups,
    residualDuplicateFiles,
    residualDuplicateDecodedBytes
  };
}

const mb = (value: number): string => `${(value / 1024 / 1024).toFixed(1)} MB`;
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const report = await reportAssets({
    sourceRoot: process.argv[2] ? path.resolve(process.argv[2]) : undefined,
    contentRoot: process.argv[3] ? path.resolve(process.argv[3]) : undefined
  });
  console.log(`资产：${report.files} 个文件 / ${mb(report.bytes)}；唯一内容 ${report.uniqueFiles} 个 / ${mb(report.uniqueBytes)}`);
  console.log(`重复：${report.duplicateGroups} 组，${report.duplicateFiles} 个多余文件，磁盘 ${mb(report.duplicateBytes)}，解码约 ${mb(report.duplicateDecodedBytes)}`);
  for (const group of report.topDuplicateGroups) {
    const size = group.width && group.height ? `${group.width}x${group.height}` : '未知尺寸';
    console.log(`  ${group.count} 份 ${size} 解码重复 ${mb(group.decodedBytes * (group.count - 1))}  ${group.files.slice(0, 3).join(' | ')}`);
  }
  const runtime = report.runtime;
  if (runtime) {
    console.log(`生产构建口径：动画贴图键 ${runtime.clipKeysBefore} -> ${runtime.clipKeysAfter}（合并 ${runtime.dedupedLayers} 个图层引用）`);
    console.log(`运行时引用：${runtime.referencedFiles} 个素材 / 解码约 ${mb(runtime.referencedDecodedBytes)}；构建后仍重复 ${runtime.residualDuplicateGroups} 组，${runtime.residualDuplicateFiles} 个多余路径，解码约 ${mb(runtime.residualDuplicateDecodedBytes)}`);
  }
}

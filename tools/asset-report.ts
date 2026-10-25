import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export interface AssetDuplicateGroup {
  hash: string;
  count: number;
  bytes: number;
  decodedBytes: number;
  width?: number;
  height?: number;
  files: string[];
}

export interface AssetReport {
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
}

interface ImageSize { width: number; height: number }

/** 只读 IHDR / SOF / VP8X；读不出尺寸的格式按 0 计，不阻塞报告。 */
function imageSize(bytes: Buffer, file: string): ImageSize | undefined {
  const ext = path.extname(file).toLowerCase();
  try {
    if (ext === '.png' && bytes.length >= 24 && bytes.toString('ascii', 1, 4) === 'PNG') {
      return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    }
    if (ext === '.webp' && bytes.length >= 30 && bytes.toString('ascii', 0, 4) === 'RIFF') {
      const kind = bytes.toString('ascii', 12, 16);
      if (kind === 'VP8X') return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
      if (kind === 'VP8L') {
        const bits = bytes.readUInt32LE(21);
        return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
      }
      if (kind === 'VP8 ') return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    }
    if ((ext === '.jpg' || ext === '.jpeg') && bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
      for (let at = 2; at + 9 < bytes.length;) {
        if (bytes[at] !== 0xff) { at++; continue; }
        const marker = bytes[at + 1];
        const length = bytes.readUInt16BE(at + 2);
        if (marker >= 0xc0 && marker <= 0xc3) return { width: bytes.readUInt16BE(at + 7), height: bytes.readUInt16BE(at + 5) };
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
export function reportAssets(root = path.resolve('public')): AssetReport {
  const files = filesUnder(path.join(root, 'assets'));
  const groups = new Map<string, AssetDuplicateGroup & { decodedBytes: number }>();
  let bytes = 0, decodedBytes = 0;
  for (const file of files) {
    const content = fs.readFileSync(file.absolute);
    const hash = createHash('sha256').update(content).digest('hex');
    const size = imageSize(content, file.absolute);
    const decoded = size ? size.width * size.height * 4 : 0;
    bytes += content.byteLength;
    decodedBytes += decoded;
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
  return {
    files: files.length, bytes, decodedBytes,
    uniqueFiles: groups.size, uniqueBytes, uniqueDecodedBytes,
    duplicateGroups, duplicateFiles, duplicateBytes, duplicateDecodedBytes,
    topDuplicateGroups
  };
}

const mb = (value: number): string => `${(value / 1024 / 1024).toFixed(1)} MB`;
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const report = reportAssets(process.argv[2] ? path.resolve(process.argv[2]) : undefined);
  console.log(`资产：${report.files} 个文件 / ${mb(report.bytes)}；唯一内容 ${report.uniqueFiles} 个 / ${mb(report.uniqueBytes)}`);
  console.log(`重复：${report.duplicateGroups} 组，${report.duplicateFiles} 个多余文件，磁盘 ${mb(report.duplicateBytes)}，解码约 ${mb(report.duplicateDecodedBytes)}`);
  for (const group of report.topDuplicateGroups) {
    const size = group.width && group.height ? `${group.width}x${group.height}` : '未知尺寸';
    console.log(`  ${group.count} 份 ${size} 解码重复 ${mb(group.decodedBytes * (group.count - 1))}  ${group.files.slice(0, 3).join(' | ')}`);
  }
}

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectAssetKeep, type AssetAtlasKind } from './asset-keep.ts';

/** 素材引用缺失报错时最多列出的路径数。 */
const MAX_REPORTED_MISSING = 50;

export interface PruneOptions {
  contentDir: string;
  assetsDir: string;
  archiveDir: string;
  /** 只统计，不移动文件。 */
  dryRun?: boolean;
  /** 调试用：不裁剪，但仍检查引用是否完整。 */
  keepAll?: boolean;
}

export interface PruneResult extends ArchiveResult {
  keep: Set<string>;
  missing: string[];
  archiveDir: string;
}

function filesUnder(directory: string, relative = ''): { relative: string; absolute: string }[] {
  if (!fs.existsSync(directory)) return [];
  const result: { relative: string; absolute: string }[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    const childAbsolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...filesUnder(childAbsolute, childRelative));
    else if (entry.isFile()) result.push({ relative: childRelative, absolute: childAbsolute });
  }
  return result;
}

export interface ArchiveOptions {
  assetsDir: string;
  archiveDir: string;
  keep: ReadonlySet<string>;
  covered?: ReadonlyMap<string, AssetAtlasKind>;
  dryRun?: boolean;
  references?: number;
  phaserFiles?: number;
}

export interface ArchiveResult {
  keptFiles: number;
  keptBytes: number;
  archivedFiles: number;
  archivedBytes: number;
  reasons: Record<string, { files: number; bytes: number }>;
}

function moveFile(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    fs.copyFileSync(from, to);
    fs.rmSync(from);
  }
}

function reasonOf(covered: ReadonlyMap<string, AssetAtlasKind> | undefined, file: string): string {
  return covered?.get(file) ?? 'unreferenced';
}

/** 只负责移动文件和写归档报告；引用检查在 collectAssetKeep 里完成。 */
export function archiveUnkeptFiles(options: ArchiveOptions): ArchiveResult {
  const { assetsDir, archiveDir, keep, covered, dryRun = false } = options;
  const resolvedAssets = path.resolve(assetsDir);
  const resolvedArchive = path.resolve(archiveDir);
  if (resolvedArchive === resolvedAssets
    || resolvedArchive.startsWith(resolvedAssets + path.sep)
    || resolvedAssets.startsWith(resolvedArchive + path.sep)) {
    throw new Error(`归档目录不能和素材目录互相包含：${archiveDir}`);
  }
  const files = filesUnder(assetsDir);
  const totalBytes = files.reduce((sum, file) => sum + fs.statSync(file.absolute).size, 0);
  const reasons: Record<string, { files: number; bytes: number }> = {};
  let keptFiles = 0, keptBytes = 0, archivedFiles = 0, archivedBytes = 0;

  if (!dryRun) {
    fs.rmSync(path.join(archiveDir, 'assets'), { recursive: true, force: true });
    fs.rmSync(path.join(archiveDir, 'report.json'), { force: true });
  }

  for (const file of files) {
    const asset = `assets/${file.relative}`;
    const bytes = fs.statSync(file.absolute).size;
    if (keep.has(asset)) {
      keptFiles++;
      keptBytes += bytes;
      continue;
    }
    archivedFiles++;
    archivedBytes += bytes;
    const reason = reasonOf(covered, asset);
    const bucket = reasons[reason] ?? { files: 0, bytes: 0 };
    bucket.files++;
    bucket.bytes += bytes;
    reasons[reason] = bucket;
    if (!dryRun) moveFile(file.absolute, path.join(archiveDir, asset));
  }

  if (!dryRun) {
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(path.join(archiveDir, 'report.json'), JSON.stringify({
      schema: 1,
      generatedAt: new Date().toISOString(),
      note: '构建产物里没有被运行时引用的素材。源图在 asset-source/，这里只保留本次裁剪的运行时副本。',
      source: { files: files.length, bytes: totalBytes },
      kept: { files: keptFiles, bytes: keptBytes },
      archived: { files: archivedFiles, bytes: archivedBytes },
      reasons,
      references: options.references ?? null,
      phaserFiles: options.phaserFiles ?? null,
    }, null, 2) + '\n');
  }

  return { keptFiles, keptBytes, archivedFiles, archivedBytes, reasons };
}

/**
 * 把构建产物里没有被运行时引用的素材移动到归档目录。
 *
 * 只移动 `assetsDir` 下的文件；内容、图集清单、更新清单和其他产物不动。
 * 任何被引用的路径在磁盘上缺失时直接抛错，不执行移动。
 */
export async function pruneAssets(options: PruneOptions): Promise<PruneResult> {
  const { contentDir, assetsDir, archiveDir, dryRun = false, keepAll = false } = options;
  const report = await collectAssetKeep(contentDir, assetsDir);
  if (report.missing.length) {
    throw new Error(`素材引用缺失，停止裁剪：\n${report.missing.slice(0, MAX_REPORTED_MISSING).join('\n')}`
      + (report.missing.length > MAX_REPORTED_MISSING
        ? `\n…另有 ${report.missing.length - MAX_REPORTED_MISSING} 个` : ''));
  }

  const keep = keepAll
    ? new Set(filesUnder(assetsDir).map(file => `assets/${file.relative}`))
    : report.keep;
  const result = archiveUnkeptFiles({
    assetsDir, archiveDir, keep, covered: report.covered, dryRun: dryRun || keepAll,
    references: report.references, phaserFiles: report.phaserFiles,
  });
  return { ...result, keep, missing: report.missing, archiveDir };
}

const mb = (value: number): string => `${(value / 1024 / 1024).toFixed(1)} MB`;

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dist = path.resolve(option('--dist') ?? path.join(root, 'dist'));
  const useDist = fs.existsSync(path.join(dist, 'content')) && fs.existsSync(path.join(dist, 'assets'));
  const contentDir = useDist ? path.join(dist, 'content') : path.join(root, 'public/content');
  const assetsDir = useDist ? path.join(dist, 'assets') : path.join(root, 'public/assets');
  const archiveDir = path.resolve(option('--archive') ?? path.join(root, 'asset-archive'));
  const dryRun = process.argv.includes('--check');
  try {
    const result = await pruneAssets({ contentDir, assetsDir, archiveDir, dryRun });
    console.log(`[assets] 保留 ${result.keptFiles} 个 / ${mb(result.keptBytes)}`);
    console.log(`[assets] ${dryRun ? '将归档' : '已归档'} ${result.archivedFiles} 个 / ${mb(result.archivedBytes)} → ${archiveDir}`);
    for (const [reason, bucket] of Object.entries(result.reasons).sort((a, b) => b[1].bytes - a[1].bytes))
      console.log(`  ${reason}: ${bucket.files} 个 / ${mb(bucket.bytes)}`);
  } catch (error) {
    console.error(`[assets] 失败：${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

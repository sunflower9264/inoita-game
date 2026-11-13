import { createHash } from 'node:crypto';
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BUILD_META_FILENAME } from './build-version.ts';
import { signBytes, tryReadUpdateKey, verifyBytes, writePublicKey } from './update-key.ts';

export { signBytes, verifyBytes };

const MIN_SHELL = 2;
/** 短指纹（buildId/assetVersion/contentVersion）的十六进制长度。 */
const SHORT_HASH_HEX_LENGTH = 16;
const HEX16 = /^[0-9a-f]{16}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const UPDATE_DIR = 'update';
/** 清单校验失败时最多列出的问题数。 */
const MAX_REPORTED_PROBLEMS = 5;

/** 热更清单的逐文件记录；字段名是线上格式：p=相对路径，h=内容指纹，s=字节数。 */
export interface UpdateFile { p: string; h: string; s: number }
export interface UpdateManifest {
  schema: 1;
  buildId: string;
  assetVersion: string;
  contentVersion: string;
  files: UpdateFile[];
}
export interface UpdatePointer {
  schema: 1;
  buildId: string;
  builtAt: string;
  manifest: string;
  manifestSha256: string;
  minShell: number;
}
interface UpdateBuildInput {
  builtAt: string;
  assetVersion: string;
  contentVersion: string;
  minShell?: number;
}
interface UpdateBuildResult {
  buildId: string;
  fileCount: number;
  signed: boolean;
  manifestBytes: Buffer;
}
interface UpdateDiff { changed: UpdateFile[]; removed: string[]; downloadBytes: number }

function recordOf(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 必须是对象`);
  return value as Record<string, unknown>;
}

function hexOf(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`${label} 必须是固定长度的小写十六进制`);
  return value;
}

/** 相对路径白名单：拒绝绝对路径、空段、点段、反斜杠、NUL 和以点开头的段。 */
export function assertSafePath(relative: string): void {
  if (!relative) throw new Error('清单路径为空');
  if (relative.startsWith('/') || /^[A-Za-z]:\//.test(relative)) throw new Error(`清单路径不能是绝对路径：${relative}`);
  if (relative.includes('\\')) throw new Error(`清单路径不能包含反斜杠：${relative}`);
  if (relative.includes('\0')) throw new Error(`清单路径不能包含 NUL：${relative}`);
  for (const segment of relative.split('/')) {
    if (!segment) throw new Error(`清单路径有空段：${relative}`);
    if (segment === '.' || segment === '..') throw new Error(`清单路径不能包含 . 或 ..：${relative}`);
    if (segment.startsWith('.')) throw new Error(`清单路径不能有以点开头的段：${relative}`);
  }
}

/** 单文件指纹与 hashTree 的拼法一致：SHA-256(路径 + NUL + 内容 + NUL) 前 16 位。 */
export function fileDigest(relative: string, bytes: Buffer): string {
  const hash = createHash('sha256');
  hash.update(relative);
  hash.update('\0');
  hash.update(bytes);
  hash.update('\0');
  return hash.digest('hex').slice(0, SHORT_HASH_HEX_LENGTH);
}

export function sha256Hex(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function normalizeFiles(files: UpdateFile[]): UpdateFile[] {
  const seen = new Set<string>();
  const normalized = files.map(file => {
    assertSafePath(file.p);
    hexOf(file.h, HEX16, `文件 ${file.p} 的 h`);
    if (!Number.isSafeInteger(file.s) || file.s < 0) throw new Error(`文件 ${file.p} 的大小无效：${file.s}`);
    if (seen.has(file.p)) throw new Error(`清单路径重复：${file.p}`);
    seen.add(file.p);
    return { p: file.p, h: file.h, s: file.s };
  });
  normalized.sort((left, right) => left.p < right.p ? -1 : left.p > right.p ? 1 : 0);
  return normalized;
}

/** buildId 只由路径、文件指纹和大小决定：按路径排序后依次写入 (p + NUL + h + NUL + s + LF)。 */
export function buildIdOf(files: UpdateFile[]): string {
  const hash = createHash('sha256');
  for (const file of normalizeFiles(files)) {
    hash.update(file.p);
    hash.update('\0');
    hash.update(file.h);
    hash.update('\0');
    hash.update(String(file.s));
    hash.update('\n');
  }
  return hash.digest('hex').slice(0, SHORT_HASH_HEX_LENGTH);
}

export function buildManifest(files: UpdateFile[], assetVersion: string, contentVersion: string): UpdateManifest {
  hexOf(assetVersion, HEX16, 'assetVersion');
  hexOf(contentVersion, HEX16, 'contentVersion');
  const normalized = normalizeFiles(files);
  return { schema: 1, buildId: buildIdOf(normalized), assetVersion, contentVersion, files: normalized };
}

/** 遍历产物目录；.build-meta.json 和 update/** 不是热更新内容，避免清单引用自己。 */
export async function manifestFromDirectory(
  rootDir: string, assetVersion: string, contentVersion: string,
): Promise<UpdateManifest> {
  const files: UpdateFile[] = [];
  async function walk(directory: string, relative: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!relative && (entry.name === BUILD_META_FILENAME || entry.name === UPDATE_DIR)) continue;
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const childAbsolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(childAbsolute, childRelative);
      else if (entry.isFile()) {
        assertSafePath(childRelative);
        const bytes = await readFile(childAbsolute);
        files.push({ p: childRelative, h: fileDigest(childRelative, bytes), s: bytes.length });
      }
    }
  }
  await walk(rootDir, '');
  return buildManifest(files, assetVersion, contentVersion);
}

/** 清单与指针都按固定字段顺序序列化；同一份内容重建得到完全相同的字节。 */
export function serialize(value: unknown): string {
  return JSON.stringify(value);
}

function pointerFor(
  manifest: UpdateManifest, manifestBytes: Buffer, builtAt: string, minShell = MIN_SHELL,
): UpdatePointer {
  return {
    schema: 1,
    buildId: manifest.buildId,
    builtAt,
    manifest: `${UPDATE_DIR}/${manifest.buildId}.json`,
    manifestSha256: sha256Hex(manifestBytes),
    minShell,
  };
}

export function parsePointer(value: unknown): UpdatePointer {
  const raw = recordOf(value, '指针');
  if (raw.schema !== 1) throw new Error('指针 schema 必须是 1');
  const buildId = hexOf(raw.buildId, HEX16, '指针 buildId');
  if (typeof raw.builtAt !== 'string' || Number.isNaN(Date.parse(raw.builtAt)))
    throw new Error('指针 builtAt 必须是 ISO8601 时间');
  const manifest = `${UPDATE_DIR}/${buildId}.json`;
  if (raw.manifest !== manifest) throw new Error(`指针 manifest 必须是 ${manifest}`);
  const manifestSha256 = hexOf(raw.manifestSha256, HEX64, '指针 manifestSha256');
  if (!Number.isSafeInteger(raw.minShell) || (raw.minShell as number) < 1)
    throw new Error('指针 minShell 必须是正整数');
  return { schema: 1, buildId, builtAt: raw.builtAt, manifest, manifestSha256, minShell: raw.minShell as number };
}

export function parseManifest(value: unknown): UpdateManifest {
  const raw = recordOf(value, '清单');
  if (raw.schema !== 1) throw new Error('清单 schema 必须是 1');
  const buildId = hexOf(raw.buildId, HEX16, '清单 buildId');
  const assetVersion = hexOf(raw.assetVersion, HEX16, '清单 assetVersion');
  const contentVersion = hexOf(raw.contentVersion, HEX16, '清单 contentVersion');
  if (!Array.isArray(raw.files)) throw new Error('清单 files 必须是数组');
  const files: UpdateFile[] = [];
  const seen = new Set<string>();
  let previous = '';
  for (const value of raw.files) {
    const file = recordOf(value, '清单文件');
    if (typeof file.p !== 'string') throw new Error('清单文件 p 必须是字符串');
    assertSafePath(file.p);
    const h = hexOf(file.h, HEX16, `文件 ${file.p} 的 h`);
    if (!Number.isSafeInteger(file.s) || (file.s as number) < 0) throw new Error(`文件 ${file.p} 的大小无效`);
    if (seen.has(file.p)) throw new Error(`清单路径重复：${file.p}`);
    if (previous && file.p <= previous) throw new Error(`清单未按路径排序：${file.p}`);
    seen.add(file.p);
    previous = file.p;
    files.push({ p: file.p, h, s: file.s as number });
  }
  return { schema: 1, buildId, assetVersion, contentVersion, files };
}

/** 生成并（有私钥时）签名清单与两个指针；没有私钥只跳过签名，不影响构建成功。 */
export async function writeUpdateArtifacts(rootDir: string, input: UpdateBuildInput): Promise<UpdateBuildResult> {
  const manifest = await manifestFromDirectory(rootDir, input.assetVersion, input.contentVersion);
  const manifestBytes = Buffer.from(serialize(manifest));
  const updateDir = path.join(rootDir, UPDATE_DIR);
  await mkdir(updateDir, { recursive: true });
  const manifestPath = path.join(updateDir, `${manifest.buildId}.json`);
  await writeFile(manifestPath, manifestBytes);

  const privateKey = tryReadUpdateKey();
  const pointerBytes = Buffer.from(serialize(pointerFor(manifest, manifestBytes, input.builtAt, input.minShell)));
  if (privateKey) {
    writePublicKey(privateKey);
    await writeFile(`${manifestPath}.sig`, signBytes(manifestBytes, privateKey));
  } else {
    console.warn('[update] 未找到更新私钥，跳过清单与指针签名；运行 npm run update:key 后再构建。');
  }
  for (const name of ['latest.json', 'latest-staging.json']) {
    const pointerPath = path.join(updateDir, name);
    await writeFile(pointerPath, pointerBytes);
    if (privateKey) await writeFile(`${pointerPath}.sig`, signBytes(pointerBytes, privateKey));
  }
  return { buildId: manifest.buildId, fileCount: manifest.files.length, signed: Boolean(privateKey), manifestBytes };
}

export async function verifyManifestFiles(rootDir: string, manifest: UpdateManifest): Promise<{ checked: number }> {
  const problems: string[] = [];
  for (const file of manifest.files) {
    let bytes: Buffer;
    try {
      bytes = await readFile(path.join(rootDir, ...file.p.split('/')));
    } catch {
      problems.push(`缺少 ${file.p}`);
      continue;
    }
    if (bytes.length !== file.s) problems.push(`大小不符 ${file.p}：清单 ${file.s}，实际 ${bytes.length}`);
    else if (fileDigest(file.p, bytes) !== file.h) problems.push(`哈希不符 ${file.p}`);
  }
  if (problems.length)
    throw new Error(`清单文件校验失败（${problems.length} 项）：${problems.slice(0, MAX_REPORTED_PROBLEMS).join('；')}`);
  return { checked: manifest.files.length };
}

/** 差量：基线里没有、指纹或大小不同、以及被删除的文件。 */
export function diffManifests(base: UpdateManifest | undefined, remote: UpdateManifest): UpdateDiff {
  const baseline = new Map((base?.files ?? []).map(file => [file.p, file]));
  const changed = remote.files.filter(file => {
    const previous = baseline.get(file.p);
    return !previous || previous.h !== file.h || previous.s !== file.s;
  });
  const remotePaths = new Set(remote.files.map(file => file.p));
  const removed = (base?.files ?? []).filter(file => !remotePaths.has(file.p)).map(file => file.p);
  return { changed, removed, downloadBytes: changed.reduce((sum, file) => sum + file.s, 0) };
}

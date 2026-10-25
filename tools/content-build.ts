import fs from 'node:fs/promises';
import path from 'node:path';
import { contentDigest } from '../src/application/content-hash.ts';

export interface ContentBuildStats {
  files: number;
  sourceBytes: number;
  outputBytes: number;
}

interface SourceFile {
  relative: string;
  absolute: string;
}

async function filesUnder(directory: string, relative = ''): Promise<SourceFile[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const result: SourceFile[] = [];
  for (const entry of entries) {
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    const childAbsolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await filesUnder(childAbsolute, childRelative));
    else if (entry.isFile()) result.push({ relative: childRelative, absolute: childAbsolute });
  }
  return result;
}

/**
 * 构建期把 public/content 转成运行时内容目录。
 *
 * 当前阶段只做 minify：JSON.parse → JSON.stringify，保持对象语义不变。
 * 后续阶段会在这里编译 battle 的 display/IR；所有变换都必须通过 canonical digest 守卫。
 */
export async function buildContent(sourceDir: string, outputDir: string): Promise<ContentBuildStats> {
  const files = await filesUnder(sourceDir);
  let sourceBytes = 0, outputBytes = 0;
  for (const file of files) {
    const target = path.join(outputDir, file.relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    if (!file.relative.endsWith('.json')) {
      const bytes = await fs.readFile(file.absolute);
      await fs.writeFile(target, bytes);
      sourceBytes += bytes.byteLength;
      outputBytes += bytes.byteLength;
      continue;
    }
    const text = await fs.readFile(file.absolute, 'utf8');
    const parsed: unknown = JSON.parse(text);
    const minified = JSON.stringify(parsed);
    // 防止 minify 改动数值/键/结构：解析后的 canonical 内容必须一致。
    if (contentDigest(JSON.parse(minified)) !== contentDigest(parsed))
      throw new Error(`内容压缩后语义不一致：${file.relative}`);
    await fs.writeFile(target, minified);
    sourceBytes += Buffer.byteLength(text);
    outputBytes += Buffer.byteLength(minified);
  }
  return { files: files.length, sourceBytes, outputBytes };
}

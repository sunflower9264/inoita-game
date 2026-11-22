import fs from 'node:fs/promises';
import path from 'node:path';

/** 生产内容哨兵：构建时写一份很小的清单，运行时只核对版本和必需顶层键。 */
interface ContentManifest {
  schema: 1;
  contentVersion: string;
  required: Record<string, string[]>;
}

const CONTENT_MANIFEST_FILENAME = 'content-manifest.json';

/** 运行时按文件路径读取的必需顶层键；只列廉价、缺了就一定晚失败的那几个。 */
const CONTENT_REQUIRED_KEYS: Readonly<Record<string, readonly string[]>> = {
  'content/campaign.json': ['version', 'start', 'scripts', 'quests'],
  'content/battle.json': ['classes', 'skills', 'enemies'],
};

/** 从编译后的内容目录生成清单，并确认声明的键真的存在。 */
export async function buildContentManifest(contentDir: string, contentVersion: string): Promise<ContentManifest> {
  const required: Record<string, string[]> = {};
  for (const [file, keys] of Object.entries(CONTENT_REQUIRED_KEYS)) {
    const relative = file.replace(/^content\//, '');
    const value = JSON.parse(await fs.readFile(path.join(contentDir, relative), 'utf8')) as Record<string, unknown>;
    for (const key of keys) if (!(key in value)) throw new Error(`内容清单缺少必需字段：${file} ${key}`);
    required[file] = [...keys];
  }
  return { schema: 1, contentVersion, required };
}

/** 写到 dist 根目录，不放进 `content/`，避免改变 `hashTree(content)`。 */
export async function writeContentManifest(outputDir: string, contentDir: string, contentVersion: string): Promise<ContentManifest> {
  const manifest = await buildContentManifest(contentDir, contentVersion);
  await fs.writeFile(path.join(outputDir, CONTENT_MANIFEST_FILENAME), JSON.stringify(manifest) + '\n');
  return manifest;
}

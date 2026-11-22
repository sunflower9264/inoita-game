import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根目录。 */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/**
 * 源素材归档目录：图集生成、内容构建去重和逐像素测试只从这里读原图。
 *
 * `public/assets` 只放运行时真正需要的东西：图集页、图集 JSON、地图、音频，
 * 以及明确没进图集、仍按单文件加载的例外图片。原图不再同时留在 public。
 */
export const SOURCE_ASSETS = path.join(ROOT, 'asset-source');

/** 源素材的固定路径；调用方不再去 public 找同名文件。 */
export function sourceAssetPath(file: string): string {
  return path.join(SOURCE_ASSETS, file.replace(/^\/+/, ''));
}

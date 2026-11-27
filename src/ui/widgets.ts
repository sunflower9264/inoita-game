import { domAssets } from './dom/assets.ts';
import type { AssetLease } from '../application/assets.ts';
import { COMMON_BUTTON_IMAGES } from './common-button.ts';
import { UI_ICON_ATLAS_DATA, UI_ICON_ATLAS_FILE, UI_ICON_FRAMES } from '../generated/icon-atlas.ts';
import { UI_ATLAS_FRAMES, UI_ATLAS_PAGES } from '../generated/ui-atlas.ts';

export const GOLD = '#f3deb0';

const atlasName = (file: string): string => file.replace(/^\//, '');

/** 把菜单图片折成真正要下载的文件：同一张图集只留一个代表帧。 */
export function uiImageFileNames(files: readonly string[]): string[] {
  return [...new Set([...files, ...COMMON_BUTTON_IMAGES])].flatMap(file => {
    const name = atlasName(file);
    if (name === UI_ICON_ATLAS_DATA || name === UI_ICON_ATLAS_FILE) return Object.keys(UI_ICON_FRAMES).slice(0, 1);
    const ui = UI_ATLAS_FRAMES[name];
    if (ui && !UI_ATLAS_PAGES[ui.page]) throw new Error(`界面图集缺页：${file} 映射到第 ${ui.page} 页，但该页不存在`);
    const page = UI_ATLAS_PAGES.find(entry => entry.file === name || entry.data === name);
    // 普通图片保留原始路径（含前导斜杠）；只有图集页换成代表帧名。
    return page ? Object.keys(UI_ATLAS_FRAMES).filter(key => UI_ATLAS_FRAMES[key]!.key === page.key).slice(0, 1) : [file];
  });
}

export async function loadUiImages(
  files: string[],
  progress = (_value: number) => {},
  signal = new AbortController().signal,
): Promise<AssetLease> {
  return domAssets.preloadFiles(uiImageFileNames(files), signal, progress);
}

export { UiSurface, ScrollArea } from './dom/surface.ts';

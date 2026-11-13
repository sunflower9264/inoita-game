import { versionedAsset } from '../../application/asset-version.ts';
import { UI_ICON_ATLAS_FILE, UI_ICON_ATLAS_DATA, UI_ICON_FRAMES } from '../../generated/icon-atlas.ts';
import { UI_ATLAS_FRAMES, UI_ATLAS_PAGES } from '../../generated/ui-atlas.ts';
import type { AssetLease } from '../../application/assets.ts';

export interface ImageRect { x: number; y: number; width: number; height: number }
export interface DomImageSource {
  url: string;
  width: number;
  height: number;
  frame: ImageRect;
  /** 浏览器里已解码的图片；持有它，菜单反复打开时不必重新取图和解码。 */
  image?: HTMLImageElement;
}
interface AtlasData { frames: Record<string, { frame: { x: number; y: number; w: number; h: number } }> }
export interface LoadedDomImage { width: number; height: number; image?: HTMLImageElement }
export interface DomImageLoader {
  image(url: string, signal: AbortSignal): Promise<LoadedDomImage>;
  atlas(url: string, signal: AbortSignal): Promise<AtlasData>;
}
interface ImageEntry {
  users: number;
  controller: AbortController;
  ready: Promise<DomImageSource>;
  sources:Map<string,DomImageSource>;
}

function missingUiAtlasPage(file: string, page: number): Error {
  return new Error(`界面图集缺页：${file} 映射到第 ${page} 页，但该页不存在`);
}

/** 图片与数据请求按资源共享，调用者取消只释放自己的持有权。 */
export class DomAssets {
  private readonly entries = new Map<string, ImageEntry>();
  private readonly loader: DomImageLoader;
  constructor(loader: DomImageLoader = browserImageLoader) { this.loader = loader; }
  get size(): number { return this.entries.size; }
  peek(file:string):DomImageSource|undefined{
    const name=file.replace(/^\//,''),icon=UI_ICON_FRAMES[name],ui=UI_ATLAS_FRAMES[name];
    if(ui&&!UI_ATLAS_PAGES[ui.page])throw missingUiAtlasPage(name,ui.page);
    const key=(icon?UI_ICON_ATLAS_FILE:ui?UI_ATLAS_PAGES[ui.page]!.file:file).replace(/^\//,'');
    return this.entries.get(key)?.sources.get(name);
  }

  async acquire(file: string, signal: AbortSignal): Promise<AssetLease & { source: DomImageSource }> {
    signal.throwIfAborted();
    const name = file.replace(/^\//, '');
    const icon = UI_ICON_FRAMES[name];
    const ui = UI_ATLAS_FRAMES[name];
    const page = ui ? UI_ATLAS_PAGES[ui.page] : undefined;
    if (ui && !page) throw missingUiAtlasPage(name, ui.page);
    const imageFile = icon ? UI_ICON_ATLAS_FILE : page ? page.file : file;
    const dataFile = icon ? UI_ICON_ATLAS_DATA : page?.data;
    const frameName = icon ?? ui?.frame;
    const key = imageFile.replace(/^\//, '');
    let entry = this.entries.get(key);
    if (!entry) {
      const controller = new AbortController();
      const ready = this.loader.image(versionedAsset(imageFile), controller.signal).then(loaded => ({
        url: versionedAsset(imageFile), width: loaded.width, height: loaded.height,
        frame: { x: 0, y: 0, width: loaded.width, height: loaded.height }, image: loaded.image
      }));
      entry = { users: 0, controller, ready, sources:new Map() };
      this.entries.set(key, entry);
    }
    entry.users++;
    const current = entry;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      signal.removeEventListener('abort', release);
      if (--current.users === 0) {
        current.controller.abort();
        if (this.entries.get(key) === current) this.entries.delete(key);
      }
    };
    signal.addEventListener('abort', release, { once: true });
    try {
      const source = await abortable(current.ready, signal);
      let result = source;
      if (dataFile && frameName) {
        const data = await abortable(this.atlas(dataFile, current.controller.signal), signal);
        const atlasFrame = data.frames[frameName]?.frame;
        if (!atlasFrame) throw new Error(`界面图集缺少图片：${file}`);
        // 图集 JSON 用 `w`／`h` 存宽高，这里转成界面使用的 `width`／`height`。
        const { x: frameX, y: frameY, w: frameWidth, h: frameHeight } = atlasFrame;
        result = { ...source, frame: { x: frameX, y: frameY, width: frameWidth, height: frameHeight } };
      }
      signal.throwIfAborted();
      current.sources.set(name,result);
      return { source: result, release };
    } catch (error) { release(); throw error; }
  }

  private readonly atlases = new Map<string, { signal: AbortSignal; ready: Promise<AtlasData> }>();
  private atlas(file: string, signal: AbortSignal): Promise<AtlasData> {
    const cached = this.atlases.get(file);
    if (cached && !cached.signal.aborted) return cached.ready;
    const ready = this.loader.atlas(versionedAsset(file), signal);
    const record = { signal, ready };
    this.atlases.set(file, record);
    const clear = () => { if (this.atlases.get(file) === record) this.atlases.delete(file); };
    signal.addEventListener('abort', clear, { once: true });
    void ready.catch(clear);
    return ready;
  }

  async preloadFiles(files: readonly string[], signal: AbortSignal, progress: (value: number) => void): Promise<AssetLease> {
    const leases: AssetLease[] = [];
    const names = [...new Set(files)];
    try {
      for (const file of names) {
        leases.push(await this.acquire(file, signal));
        progress(leases.length / names.length);
      }
      if (!names.length) progress(1);
      return { release: () => { for (const lease of leases.splice(0)) lease.release(); } };
    } catch (error) { for (const lease of leases) lease.release(); throw error; }
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => { cleanup(); reject(signal.reason); };
    const cleanup = () => signal.removeEventListener('abort', cancel);
    if (signal.aborted) { cancel(); return; }
    signal.addEventListener('abort', cancel, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

const browserImageLoader: DomImageLoader = {
  image: (url, signal) => new Promise((resolve, reject) => {
    const image = new Image();
    const cleanup = () => { image.onload = null; image.onerror = null; signal.removeEventListener('abort', cancel); };
    const cancel = () => { cleanup(); image.removeAttribute('src'); reject(signal.reason); };
    if (signal.aborted) { cancel(); return; }
    signal.addEventListener('abort', cancel, { once: true });
    image.onload = () => {
      cleanup();
      // 解码完成后再交给调用方；只拿到宽高不够，下一次显示仍会重新解码。
      const decoded = typeof image.decode === 'function' ? image.decode() : Promise.resolve();
      void decoded.catch(() => {}).then(() => {
        if (signal.aborted) { image.removeAttribute('src'); reject(signal.reason); return; }
        resolve({ width: image.naturalWidth, height: image.naturalHeight, image });
      });
    };
    image.onerror = () => {
      cleanup();
      globalThis.storyDiagnostics?.record('asset-load-error', { source: 'dom-image', url });
      reject(new Error(`界面图片加载失败：${url}`));
    };
    image.src = url;
  }),
  atlas: async (url, signal) => {
    try {
      const response = await fetch(url, { signal });
      if (!response.ok) throw new Error(`界面图集加载失败：${url}`);
      return await response.json() as AtlasData;
    } catch (error) {
      globalThis.storyDiagnostics?.record('asset-load-error', { source: 'dom-atlas', url, error });
      throw error;
    }
  }
};

/** 同一页面的所有屏幕组件共享图片和图集下载。 */
export const domAssets = new DomAssets();

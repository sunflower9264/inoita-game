import type Phaser from 'phaser';
import { AssetPool } from '../application/assets.ts';
import type { AssetLease } from '../application/assets.ts';
import { versionedAsset } from '../application/asset-version.ts';

export type PendingAsset =
  | { kind: 'image'; key: string; file: string }
  | { kind: 'spritesheet'; key: string; file: string; config: Phaser.Types.Loader.FileTypes.ImageFrameConfig }
  /** 打包后的图集：图片和 JSON 必须成对加载，纹理键下会注册所有帧。 */
  | { kind: 'atlas'; key: string; file: string; atlas: string; frame?: string };
const pools = new WeakMap<Phaser.Textures.TextureManager, AssetPool>();
/** 队列按纹理管理器排队：同一份纹理库只有一个 loader 能写，跨场景并发会重复注册同一纹理键。 */
const textureQueues = new WeakMap<Phaser.Textures.TextureManager, Promise<void>>();
/**
 * 正在加载某个纹理键的调用数。损坏缓存重建前必须区分“其他加载者”和“真正持有纹理的用户”：
 * 前者还没开始用这张纹理，可以一起等重建；后者不能删。
 */
const activeLoaders = new WeakMap<Phaser.Textures.TextureManager, Map<string, number>>();

function loaderCounts(scene: Phaser.Scene): Map<string, number> {
  let counts = activeLoaders.get(scene.textures);
  if (!counts) { counts = new Map(); activeLoaders.set(scene.textures, counts); }
  return counts;
}

function changeLoaders(scene: Phaser.Scene, keys: Iterable<string>, delta: 1 | -1): void {
  const counts = loaderCounts(scene);
  for (const key of keys) {
    const next = (counts.get(key) ?? 0) + delta;
    if (next > 0) counts.set(key, next); else counts.delete(key);
  }
}

function poolFor(scene: Phaser.Scene): AssetPool {
  let pool = pools.get(scene.textures);
  if (!pool) {
    pool = new AssetPool(key => removeTexture(scene, key));
    pools.set(scene.textures, pool);
  }
  return pool;
}

/**
 * 已就绪的贴图再取一份租约，用于常驻资源与已生成的特效。
 *
 * 只接受**已经通过验收**的资源：缺纹理或缺帧时直接抛错。所有调用点都在加载完成之后，
 * 因此这里失败说明资源契约被破坏，应在加载期暴露，而不是等到播放动画时。
 */
export function retainLoadedSceneAssets(scene: Phaser.Scene,
  assets: Iterable<PendingAsset | string>): AssetLease {
  const keys: string[] = [];
  for (const asset of assets) {
    if (typeof asset === 'string') {
      if (!scene.textures.exists(asset)) throw new Error(`常驻资源尚未就绪：${asset}`);
      keys.push(asset);
      continue;
    }
    const gap = assetGap(scene, asset);
    if (gap) throw new Error(`常驻资源尚未就绪：${asset.key}（${gap === 'texture' ? '纹理未加载' : `缺少帧 ${gap.slice('frame:'.length)}`}）`);
    keys.push(asset.key);
  }
  return poolFor(scene).acquire(keys);
}

async function inTextureQueue<T>(scene: Phaser.Scene, work: () => Promise<T>): Promise<T> {
  const textures = scene.textures;
  const previous = textureQueues.get(textures) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>(resolve => { release = resolve; });
  textureQueues.set(textures, previous.then(() => turn));
  await previous;
  try { return await work(); }
  finally { release(); }
}

export type AssetGap = 'texture' | `frame:${number}`;

/** 纹理存在且 spritesheet 帧完整才算就绪；预检、加载、验收共用这一判据。 */
export function assetGap(scene: Phaser.Scene, asset: PendingAsset): AssetGap | undefined {
  if (!scene.textures.exists(asset.key)) return 'texture';
  const texture = scene.textures.get(asset.key);
  if (asset.kind === 'atlas') return asset.frame && !texture.has(asset.frame) ? 'frame:0' : undefined;
  if (asset.kind !== 'spritesheet') return undefined;
  const end = asset.config.endFrame ?? -1;
  const count = end < 0 ? 1 : end - (asset.config.startFrame ?? 0) + 1;
  for (let frame = 0; frame < count; frame++) if (!texture.has(String(frame))) return `frame:${frame}`;
  return undefined;
}

/** 纹理和 spritesheet 帧都不缺才算已加载；用于静默重建前的 preflight。 */
export function missingSceneAssets(scene: Phaser.Scene, assets: readonly PendingAsset[]): PendingAsset[] {
  return assets.filter(asset => assetGap(scene, asset) !== undefined);
}

function removeTexture(scene: Phaser.Scene, key: string): void {
  if (scene.anims.exists(key)) scene.anims.remove(key);
  if (scene.textures.exists(key)) scene.textures.remove(key);
}

function verifyAssets(scene: Phaser.Scene, assets: PendingAsset[]): void {
  const failures: string[] = [];
  for (const asset of assets) {
    const gap = assetGap(scene, asset);
    if (gap === 'texture') failures.push(`${asset.key} (${asset.file})：纹理未加载`);
    else if (gap) failures.push(`${asset.key} (${asset.file})：缺少帧 ${gap.slice('frame:'.length)}`);
  }
  if (failures.length) throw new Error('部分画面未能加载，请重试', { cause: new Error(failures.join('\n')) });
}

export async function loadSceneAssets(scene: Phaser.Scene, assets: PendingAsset[], progress: (value: number) => void, retain=false): Promise<AssetLease> {
  const pool = poolFor(scene);
  const byKey = new Map<string, PendingAsset>();
  for (const asset of assets) {
    const previous = byKey.get(asset.key);
    if (previous && JSON.stringify(previous) !== JSON.stringify(asset)) throw new Error(`贴图键指向不同资源：${asset.key}`);
    byKey.set(asset.key, asset);
  }
  const unique = [...byKey.values()];
  const keys = unique.map(asset=>asset.key);
  changeLoaders(scene, keys, 1);
  const ownership = pool.acquire(keys);
  const lease = {release:()=>{scene.events.off('shutdown',lease.release);ownership.release();}};
  const controller = new AbortController();
  const shutdown = () => controller.abort(new DOMException('场景已关闭','AbortError'));
  scene.events.once('shutdown',shutdown);
  try {
    await inTextureQueue(scene, async () => {
      controller.signal.throwIfAborted();
      const needed = unique.filter(asset => assetGap(scene, asset) !== undefined);
      // 纹理键已存在但帧不全：先确认没有别的租约在用它，再删掉重建。
      for (const asset of needed) {
        if (assetGap(scene, asset) === 'texture') continue;
        const holders = pool.holders(asset.key);
        const loading = loaderCounts(scene).get(asset.key) ?? 0;
        // 只有“正在加载这个键、还没开始用纹理”的其他调用者可以和本次一起等重建；
        // 真正持有纹理的租约（地图/舞台/常驻包）仍然不能删。
        if (holders !== 1 && holders !== loading)
          throw new Error(`贴图 ${asset.key} 仍被其他租约持有，无法补齐缺失帧`);
        removeTexture(scene, asset.key);
      }
      if (!needed.length) { progress(1); return; }
      await new Promise<void>((resolve,reject)=>{
        const clean=()=>{scene.load.off('progress',progress);scene.load.off('complete',complete);controller.signal.removeEventListener('abort',cancelled);};
        const cancelled=()=>{clean();reject(controller.signal.reason);};
        const complete=()=>{clean();resolve();};
        scene.load.on('progress',progress);scene.load.once('complete',complete);controller.signal.addEventListener('abort',cancelled,{once:true});
        for(const asset of needed){
          if(asset.kind==='image')scene.load.image(asset.key,versionedAsset(asset.file));
          else if(asset.kind==='spritesheet')scene.load.spritesheet(asset.key,versionedAsset(asset.file),asset.config);
          else scene.load.atlas(asset.key,versionedAsset(asset.file),versionedAsset(asset.atlas));
        }
        scene.load.start();
      });
      controller.signal.throwIfAborted();
    });
    // Phaser 的图片解码失败不发 loaderror；complete 也不保证纹理和帧已入库。
    verifyAssets(scene, unique);
    scene.events.off('shutdown',shutdown);
    if(!retain)scene.events.once('shutdown',lease.release);
    return lease;
  }catch(error){
    if(!controller.signal.aborted)globalThis.storyDiagnostics?.record('asset-load-error',
      {error,files:unique.map(asset=>({key:asset.key,file:asset.file}))});
    scene.events.off('shutdown',shutdown);lease.release();throw error;
  }finally{
    changeLoaders(scene, keys, -1);
  }
}

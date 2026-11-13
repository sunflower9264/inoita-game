import type Phaser from 'phaser';
import { AssetPool } from '../application/assets.ts';
import type { AssetLease } from '../application/assets.ts';
import { versionedAsset } from '../application/asset-version.ts';
import { releaseEffectAnimations } from './effect-animations.ts';

export type PendingAsset =
  | { kind: 'image'; key: string; file: string }
  | { kind: 'spritesheet'; key: string; file: string; config: Phaser.Types.Loader.FileTypes.ImageFrameConfig }
  /** 打包后的图集：图片和 JSON 必须成对加载，纹理键下会注册所有帧。 */
  | { kind: 'atlas'; key: string; file: string; atlas: string; frame?: string; frames?: readonly string[] };
const pools = new WeakMap<Phaser.Textures.TextureManager, AssetPool>();
/** 队列按纹理管理器排队：同一份纹理库只有一个 loader 能写，跨场景并发会重复注册同一纹理键。 */
const textureQueues = new WeakMap<Phaser.Textures.TextureManager, Promise<void>>();
/**
 * 正在加载某个纹理键的调用数。损坏缓存重建前必须区分“其他加载者”和“真正持有纹理的用户”：
 * 前者还没开始用这张纹理，可以一起等重建；后者不能删。
 */
const activeLoaders = new WeakMap<Phaser.Textures.TextureManager, Map<string, number>>();
/**
 * 取消的加载批次里，Phaser 仍可能在租约释放后才把图片写进全局纹理库。
 * 这里按纹理库记下这些键；晚到的纹理如果没有新租约接管，就立刻删除。
 */
const abandonedTextures = new WeakMap<Phaser.Textures.TextureManager, Set<string>>();

function markAbandonedTextures(textures: Phaser.Textures.TextureManager, keys: Iterable<string>): void {
  let abandoned = abandonedTextures.get(textures);
  if (!abandoned) { abandoned = new Set(); abandonedTextures.set(textures, abandoned); }
  for (const key of keys) abandoned.add(key);
}

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
    // 纹理和动画都属于全游戏共用的管理器；这里不能捕获某个具体 Scene，
    // 否则清理时会去错误的场景账本里找特效动画。
    const anims = scene.anims, textures = scene.textures;
    const created = new AssetPool(key => removeTexture(anims, textures, key));
    pool = created;
    pools.set(textures, created);
    // Phaser 的 Loader 不保证在场景关闭时中止在途文件。晚到的纹理如果没有租约接管，
    // 就在这里立刻删掉，避免它变成没人释放的无主纹理。
    if (typeof textures.on === 'function') {
      textures.on('addtexture', (key: string) => {
        const abandoned = abandonedTextures.get(textures);
        if (!abandoned?.has(key)) return;
        abandoned.delete(key);
        if (created.holders(key)) return;
        removeTexture(anims, textures, key);
      });
    }
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

type AssetGap = 'texture' | `frame:${string}`;

/** 纹理存在且 spritesheet 帧完整才算就绪；预检、加载、验收共用这一判据。 */
function assetGap(scene: Phaser.Scene, asset: PendingAsset): AssetGap | undefined {
  if (!scene.textures.exists(asset.key)) return 'texture';
  const texture = scene.textures.get(asset.key);
  if (asset.kind === 'atlas') {
    if (asset.frame && !texture.has(asset.frame)) return `frame:${asset.frame}`;
    for (const frame of asset.frames ?? []) if (!texture.has(frame)) return `frame:${frame}`;
    return undefined;
  }
  if (asset.kind !== 'spritesheet') return undefined;
  const end = asset.config.endFrame ?? -1;
  const count = end < 0 ? 1 : end - (asset.config.startFrame ?? 0) + 1;
  for (let frame = 0; frame < count; frame++) if (!texture.has(String(frame))) return `frame:${frame}`;
  return undefined;
}

/** 同一纹理键的图集页可能被不同动作引用不同帧；合并帧集合，其他字段必须一致。 */
export function mergePendingAsset(previous: PendingAsset, next: PendingAsset): PendingAsset {
  if (previous.kind === 'atlas' && next.kind === 'atlas' && previous.file === next.file && previous.atlas === next.atlas) {
    const frames = [...new Set([...(previous.frames ?? []), ...(next.frames ?? [])])].sort();
    return { ...previous, frames };
  }
  if (JSON.stringify(previous) !== JSON.stringify(next))
    throw new Error(`贴图键指向不同资源：${next.key}`);
  return previous;
}

/** 纹理和 spritesheet 帧都不缺才算已加载；用于静默重建前的 preflight。 */
export function missingSceneAssets(scene: Phaser.Scene, assets: readonly PendingAsset[]): PendingAsset[] {
  return assets.filter(asset => assetGap(scene, asset) !== undefined);
}

function removeTexture(anims: Phaser.Animations.AnimationManager, textures: Phaser.Textures.TextureManager, key: string): void {
  releaseEffectAnimations(anims, key);
  if (anims.exists(key)) anims.remove(key);
  if (textures.exists(key)) textures.remove(key);
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

export async function loadSceneAssets(scene: Phaser.Scene, assets: PendingAsset[], progress: (value: number) => void, retain=false, signal?: AbortSignal): Promise<AssetLease> {
  signal?.throwIfAborted();
  const pool = poolFor(scene);
  const byKey = new Map<string, PendingAsset>();
  for (const asset of assets) {
    const previous = byKey.get(asset.key);
    if (previous) { byKey.set(asset.key, mergePendingAsset(previous, asset)); continue; }
    byKey.set(asset.key, asset);
  }
  const unique = [...byKey.values()];
  const keys = unique.map(asset=>asset.key);
  // 已齐全的纹理只需取得使用权；它们不会写纹理库，不必等其他地图的下载。
  if (unique.every(asset => assetGap(scene, asset) === undefined)) {
    const ownership = pool.acquire(keys);
    const lease = { release: () => { scene.events.off('shutdown', lease.release); ownership.release(); } };
    if (!retain) scene.events.once('shutdown', lease.release);
    try { progress(1); return lease; }
    catch (error) { lease.release(); throw error; }
  }
  changeLoaders(scene, keys, 1);
  const ownership = pool.acquire(keys);
  const lease = {release:()=>{scene.events.off('shutdown',lease.release);ownership.release();}};
  const controller = new AbortController();
  const shutdown = () => controller.abort(new DOMException('场景已关闭','AbortError'));
  scene.events.once('shutdown',shutdown);
  const cancel = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', cancel, { once: true });
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
        removeTexture(scene.anims, scene.textures, asset.key);
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
    // 中止只结束 JS 这边的等待；Phaser 的在途文件仍可能晚到并写进纹理库。
    // 先记账再释放：晚到的纹理如果没有新租约接管，就在 addtexture 时删掉。
    // 已经在纹理库里的 key 不会再触发 addtexture，不该记成待对账的无主纹理。
    if(controller.signal.aborted)markAbandonedTextures(scene.textures,
      keys.filter(key=>!scene.textures.exists(key)));
    else globalThis.storyDiagnostics?.record('asset-load-error',
      {error,files:unique.map(asset=>({key:asset.key,file:asset.file}))});
    scene.events.off('shutdown',shutdown);lease.release();throw error;
  }finally{
    signal?.removeEventListener('abort', cancel);
    changeLoaders(scene, keys, -1);
  }
}

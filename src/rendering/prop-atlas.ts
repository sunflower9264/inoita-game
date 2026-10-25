import type Phaser from 'phaser';
import { PROP_ATLAS_BY_KEY, PROP_ATLAS_PAGES } from '../generated/prop-atlas.ts';
import type { PendingAsset } from './scene-assets.ts';

interface PropDefinition { key: string; file: string }

export interface PropRef { texture: string; frame?: string }
export interface PropFrameSource {
  image: CanvasImageSource;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 地图 feature 的 prop key 只在绘制/取像素时解析成图集页 + frame。 */
export function propRef(key: string): PropRef {
  const entry = PROP_ATLAS_BY_KEY[key];
  return entry ? { texture: entry.key, frame: entry.frame } : { texture: key };
}

const pageAssets = new Map<string, PendingAsset>();
/** 同一页的 descriptor 必须完全一致；冻结后所有地图/舞台共用同一个对象。 */
export function propAtlasPageAsset(key: string): PendingAsset {
  const cached = pageAssets.get(key);
  if (cached) return cached;
  const page = PROP_ATLAS_PAGES.find(value => value.key === key);
  if (!page) throw new Error(`地图物件图集页缺失：${key}`);
  const asset: PendingAsset = Object.freeze({
    kind: 'atlas', key: page.key, file: page.file, atlas: page.data, frame: page.frame
  });
  pageAssets.set(key, asset);
  return asset;
}

/**
 * 地图表面要加载的 prop 资源：已进图集的 prop 按页合并，每页只出现一次；
 * 未映射的 prop（测试替身或未来被排除的超大图）继续按单图加载。
 */
export function propAtlasAssets(keys: Iterable<string>, props: readonly PropDefinition[]): PendingAsset[] {
  const byKey = new Map(props.map(prop => [prop.key, prop]));
  const pages = new Set<string>();
  const images = new Map<string, PendingAsset>();
  for (const key of keys) {
    const entry = PROP_ATLAS_BY_KEY[key];
    if (entry) { pages.add(entry.key); continue; }
    const prop = byKey.get(key);
    if (!prop) throw new Error(`场景物件缺少资源：${key}`);
    images.set(prop.key, { kind: 'image', key: prop.key, file: prop.file });
  }
  return [...[...pages].map(propAtlasPageAsset), ...images.values()];
}

/** color-dodge 合成需要的原始帧区域；不能对图集页使用整张 getSourceImage。 */
export function propFrameSource(scene: Phaser.Scene, key: string): PropFrameSource {
  const ref = propRef(key);
  const texture = scene.textures.get(ref.texture);
  const frame = texture.get(ref.frame ?? '__BASE');
  return { image: frame.source.image as CanvasImageSource, x: frame.cutX, y: frame.cutY,
    width: frame.cutWidth, height: frame.cutHeight };
}

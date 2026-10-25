import type Phaser from 'phaser';
import type { MapFeature, WorldMap } from '../domain/content.ts';
import type { PendingAsset } from './scene-assets.ts';
import { blendModeOf } from './blend-modes.ts';
import { propAtlasAssets, propFrameSource, propRef } from './prop-atlas.ts';

let serial = 0;

export interface MapLayerHandles {
  /** 幂等：销毁本层创建的图像和合成纹理，不碰地图资源租约里的 ground/canopy/prop。 */
  destroy(): void;
}

/** 进图/演出共用的静态地图素材清单：ground、canopy、每个 feature 的 prop。 */
export function mapSurfaceAssets(
  map: Pick<WorldMap, 'id' | 'ground' | 'canopy' | 'features'>,
  props: readonly { key: string; file: string }[]
): PendingAsset[] {
  const assets: PendingAsset[] = [
    { kind: 'image', key: map.id + '-ground', file: map.ground },
    { kind: 'image', key: map.id + '-canopy', file: map.canopy }
  ];
  const propKeys = new Set(map.features.map(feature => feature.texture));
  // 图集页每页只出现一次；未映射的 prop 仍按单图加载。
  assets.push(...propAtlasAssets(propKeys, props));
  return assets;
}

/** 颜色减淡的单通道结果；背景为零保留零，前景满值饱和。 */
export function dodgePixel(background: number, foreground: number): number {
  return background === 0 ? 0 : foreground === 255 ? 255 : Math.min(255, Math.floor(background * 255 / (255 - foreground)));
}

/**
 * 把 feature 叠在地图 ground 上做颜色减淡，生成一张独立画布纹理。
 * 失败时删除刚创建的键再抛出，调用方不需要知道半成品纹理。
 */
export function composeColorDodge(
  scene: Phaser.Scene, groundKey: string, feature: MapFeature, textureKey: string
): string {
  const prop = propFrameSource(scene, feature.texture);
  const width = feature.width, height = prop.height;
  const left = feature.x - (feature.flip ? width - feature.offsetX : feature.offsetX);
  const top = feature.y - feature.offsetY;
  const texture = scene.textures.createCanvas(textureKey, width, height);
  if (!texture) throw new Error('无法创建颜色减淡贴图：' + textureKey);
  try {
    const ground = scene.textures.get(groundKey).getSourceImage() as HTMLImageElement;
    const context = texture.context;
    context.drawImage(ground, left, top, width, height, 0, 0, width, height);
    const backdrop = context.getImageData(0, 0, width, height);
    // 物件那层单独画一次，翻转按最终朝向镜像；图集页只取 frame 的矩形。
    const scratch = document.createElement('canvas');
    scratch.width = width; scratch.height = height;
    const scratchContext = scratch.getContext('2d');
    if (!scratchContext) throw new Error('无法创建颜色减淡画布');
    if (feature.flip) { scratchContext.translate(width, 0); scratchContext.scale(-1, 1); }
    scratchContext.drawImage(prop.image, prop.x, prop.y, prop.width, prop.height, 0, 0, prop.width, prop.height);
    const source = scratchContext.getImageData(0, 0, width, height).data;
    const pixels = backdrop.data;
    for (let index = 0; index < pixels.length; index += 4) {
      if (!source[index + 3]) continue;   // 物件透明处保留背景
      for (let channel = 0; channel < 3; channel++)
        pixels[index + channel] = dodgePixel(pixels[index + channel], source[index + channel]);
    }
    context.putImageData(backdrop, 0, 0);
    texture.refresh();
    return texture.key;
  } catch (error) {
    if (scene.textures.exists(textureKey)) scene.textures.remove(textureKey);
    throw error;
  }
}

/** 只画 ground → features → canopy；实体、角色、相机由调用方负责。 */
export function drawMapLayers(
  scene: Phaser.Scene, map: WorldMap, options: { keyPrefix: string }
): MapLayerHandles {
  const images: Phaser.GameObjects.Image[] = [], composites: string[] = [];
  const destroy = () => {
    for (const image of images) if (image.scene) image.destroy();
    images.length = 0;
    for (const key of composites) if (scene.textures.exists(key)) scene.textures.remove(key);
    composites.length = 0;
  };
  try {
    images.push(scene.add.image(0, 0, map.id + '-ground').setOrigin(0).setDepth(-10000));
    for (const feature of map.features) {
      const dodged = feature.blend === 'color-dodge';
      const prop = propRef(feature.texture);
      let key = prop.texture, frame = prop.frame;
      if (dodged) {
        key = composeColorDodge(scene, map.id + '-ground', feature, `${options.keyPrefix}-${++serial}`);
        frame = undefined;
        composites.push(key);
      }
      const left = feature.x - (feature.flip ? feature.width - feature.offsetX : feature.offsetX);
      const top = feature.y - feature.offsetY;
      const image = scene.add.image(left, top, key, frame).setOrigin(0).setDepth(feature.y);
      // 合成好的贴图已经按最终朝向画好，不再翻转。
      if (!dodged) image.setFlipX(feature.flip).setBlendMode(blendModeOf(feature.blend));
      images.push(image);
    }
    images.push(scene.add.image(0, 0, map.id + '-canopy').setOrigin(0).setDepth(10000));
    return { destroy };
  } catch (error) {
    destroy();
    throw error;
  }
}

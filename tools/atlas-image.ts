import { availableParallelism } from 'node:os';
import sharp from 'sharp';

/**
 * 图集页图片的编码方式。
 *
 * 图集页是像素画，必须逐像素不变，所以用无损 WebP，并保留透明像素的 RGB（`exact`），
 * 避免线性过滤或预乘时透明边缘取到被编码器改过的颜色。pngjs 写出的 RGBA PNG 没有调色板，
 * 同样内容的无损 WebP 通常只有它的五分之一。sharp 自带固定版本的 libwebp，
 * 不依赖构建机上的系统 cwebp，同一版本输出字节稳定。
 */
export const ATLAS_IMAGE_EXTENSION = 'webp';

/** 编码强度 0–6：越高越小越慢；抽样 5 页时 6 比 4 小 3%、多 30% 时间，图集只在构建时编码，取 6。 */
const WEBP_EFFORT = 6;

/** 把 RGBA 像素编码成无损 WebP。 */
export function encodeAtlasImage(pixels: Buffer, width: number, height: number): Promise<Buffer> {
  return sharp(pixels, { raw: { width, height, channels: 4 } })
    .webp({ lossless: true, exact: true, effort: WEBP_EFFORT })
    .toBuffer();
}

/**
 * 限制同时编码的页数。生成脚本在拼下一页像素前先 `await ready()`，
 * 让驻留内存的原始像素页最多是 CPU 核数那么多，而不是整套图集（角色图集解码后约 400 MB）。
 */
export class AtlasImageQueue {
  private readonly active = new Set<Promise<unknown>>();
  private readonly limit = Math.max(1, availableParallelism());

  async ready(): Promise<void> {
    while (this.active.size >= this.limit) await Promise.race(this.active);
  }

  encode(pixels: Buffer, width: number, height: number): Promise<Buffer> {
    const encoding = encodeAtlasImage(pixels, width, height);
    const settled = encoding.then(() => undefined, () => undefined);
    this.active.add(settled);
    void settled.then(() => this.active.delete(settled));
    return encoding;
  }
}

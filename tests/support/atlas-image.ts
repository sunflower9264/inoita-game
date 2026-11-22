import assert from 'node:assert/strict';
import fs from 'node:fs';

/**
 * 读图集页图片的宽高，同时确认它是无损 WebP（`VP8L` 块）。
 * 图集页是像素画，必须无损；有损 WebP（`VP8 ` 块）或 PNG 都会在这里失败。
 */
export function atlasImageSize(file: string | URL): { w: number; h: number } {
  const bytes = fs.readFileSync(file);
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF', `不是 WebP：${String(file)}`);
  assert.equal(bytes.toString('ascii', 8, 12), 'WEBP', `不是 WebP：${String(file)}`);
  assert.equal(bytes.toString('ascii', 12, 16), 'VP8L', `图集页必须是无损 WebP：${String(file)}`);
  assert.equal(bytes[20], 0x2f, `无损 WebP 签名错误：${String(file)}`);
  const bits = bytes.readUInt32LE(21);
  return { w: (bits & 0x3fff) + 1, h: ((bits >>> 14) & 0x3fff) + 1 };
}

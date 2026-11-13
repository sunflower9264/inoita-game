/** PNG 文件头前缀：8 字节签名 + IHDR 块长度 13 + 块类型 "IHDR"。 */
const PNG_HEADER_PREFIX = [
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // \x89PNG\r\n\x1a\n
  0x00, 0x00, 0x00, 0x0d,                         // IHDR 块长度 13
  0x49, 0x48, 0x44, 0x52                          // "IHDR"
];
/** 读到 IHDR 宽高所需的文件头字节数。 */
const PNG_HEADER_BYTES = 24;
const PNG_IHDR_WIDTH_OFFSET = 16;
const PNG_IHDR_HEIGHT_OFFSET = 20;
const MAX_SPRITESHEET_SIZE = 4096;

export function validateSpriteSheet(header: Uint8Array, clip: { frameWidth: number; frameHeight: number; frames: number }, file: string): void {
  const fail = (reason: string): never => { throw new Error(`动画图集 ${file}：${reason}`); };
  if (header.length < PNG_HEADER_BYTES || PNG_HEADER_PREFIX.some((byte, index) => header[index] !== byte)) fail('PNG 头无效');
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const width = view.getUint32(PNG_IHDR_WIDTH_OFFSET), height = view.getUint32(PNG_IHDR_HEIGHT_OFFSET);
  if (!width || !height || width > MAX_SPRITESHEET_SIZE || height > MAX_SPRITESHEET_SIZE) fail(`尺寸 ${width}×${height} 超出 1–${MAX_SPRITESHEET_SIZE} 像素`);
  if (width % clip.frameWidth || height % clip.frameHeight) fail('图片尺寸不是帧尺寸的整数倍');
  if (width / clip.frameWidth * (height / clip.frameHeight) < clip.frames) fail(`不足 ${clip.frames} 帧`);
}

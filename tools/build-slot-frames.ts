import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SOURCE = 'assets/ui/menus/inventory-slot.png';
/** 边框是米色（R−B 明显大于 0），内底是中性灰（R−B≈0）。 */
const FRAME_MIN_RED_MINUS_BLUE = 20;
/** 原版边框像素的中位亮度，用来把颜色换算成和原图一样明暗。 */
const REFERENCE_LUMINANCE = 170;

/** 品质色见 `src/ui/item-name-color.ts`：稀有度 1–4，再加大混沌两档。 */
const FRAMES: readonly { file: string; color: [number, number, number] }[] = [
  { file: 'inventory-slot-rarity-1.png', color: [0x4e, 0xff, 0x00] },
  { file: 'inventory-slot-rarity-2.png', color: [0x00, 0xb4, 0xff] },
  { file: 'inventory-slot-rarity-3.png', color: [0xff, 0xe6, 0x00] },
  { file: 'inventory-slot-rarity-4.png', color: [0x9c, 0x00, 0xff] },
  { file: 'inventory-slot-chaos.png', color: [0x00, 0x00, 0xff] },
  { file: 'inventory-slot-epic-chaos.png', color: [0xff, 0x6c, 0x00] }
];

/** 只把边框像素换成目标色：保留原始明暗、抗锯齿与半透明，内底一律不动。 */
export function recolorFrame(source: PNG, color: [number, number, number]): PNG {
  const result = new PNG({ width: source.width, height: source.height });
  for (let index = 0; index < source.data.length; index += 4) {
    const red = source.data[index], green = source.data[index + 1], blue = source.data[index + 2], alpha = source.data[index + 3];
    result.data[index + 3] = alpha;
    if (alpha === 0 || red - blue < FRAME_MIN_RED_MINUS_BLUE) {
      result.data[index] = red;
      result.data[index + 1] = green;
      result.data[index + 2] = blue;
      continue;
    }
    const scale = (0.299 * red + 0.587 * green + 0.114 * blue) / REFERENCE_LUMINANCE;
    result.data[index] = Math.min(255, Math.round(color[0] * scale));
    result.data[index + 1] = Math.min(255, Math.round(color[1] * scale));
    result.data[index + 2] = Math.min(255, Math.round(color[2] * scale));
  }
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const source = PNG.sync.read(fs.readFileSync(path.join(ROOT, 'public', SOURCE)));
  for (const frame of FRAMES) {
    const file = path.join(ROOT, 'public/assets/ui/menus', frame.file);
    fs.writeFileSync(file, PNG.sync.write(recolorFrame(source, frame.color)));
    console.log('写入', path.relative(ROOT, file));
  }
}

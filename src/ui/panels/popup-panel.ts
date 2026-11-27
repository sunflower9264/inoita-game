import type { UiSurface } from '../widgets.ts';
import { POPUP_FRAME } from '../shop-layout.ts';

/**
 * 弹层自己的底与图框，商店的数量框、确认框与背包的物品使用框共用。
 *
 * 原版这两个框的画法一模一样（`UIInputItemCount_Draw @0x14f4c8` 与
 * `UIPopupMsg_DrawDisplayTypeRectBackground @0x15e994`）：先用图组 19 的边框家族画四角与四条边，
 * 再铺一块内缩 35 的不透明黑底（原版 `0xff000000`）。压暗页面由外层的黑色遮罩负责。
 * 矩形与落点见 `shop-layout.ts` 的 `POPUP_FRAME`。
 *
 * 坐标相对框的左上角，所以翅角与四条边都会画到框外，调用方给框定位时要按 (0,0) 对齐。
 */
export function drawPopupPanel(v: UiSurface, assets: Record<string, string>, width: number, height: number): void {
  const frame = POPUP_FRAME, { size, outer, inner } = frame.corner, horizontal = frame.horizontal, vertical = frame.vertical;
  v.image(assets['popup-corner-nw'], -outer, -outer, size, size);
  v.image(assets['popup-corner-ne'], width - inner, -outer, size, size);
  v.image(assets['popup-corner-sw'], -outer, height - inner, size, size);
  v.image(assets['popup-corner-se'], width - inner, height - inner, size, size);
  const span = width - inner * 2, reach = height - inner * 2;
  v.image(assets['popup-edge-horizontal'], horizontal.inset, horizontal.top, span, horizontal.height);
  v.image(assets['popup-edge-horizontal'], horizontal.inset, height + horizontal.bottom - horizontal.height, span, horizontal.height).setFlipY(true);
  v.image(assets['popup-edge-vertical'], vertical.left, vertical.top, vertical.width, reach);
  v.image(assets['popup-edge-vertical'], width + vertical.right - vertical.width, vertical.top, vertical.width, reach).setFlipX(true);
  v.rect(inner, inner, span, reach, 0x000000, 1);
}

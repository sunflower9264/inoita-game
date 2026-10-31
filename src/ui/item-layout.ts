/**
 * 背包与商店共用的物品格、货币排版与右栏按钮几何。
 *
 * 这三样此前在 `bag-layout.ts`、`shop-layout.ts` 各存一份，`quest-popup.ts`
 * 还手抄了一份货币排版，值靠手工保持一致；格子步长甚至在背包侧写成 `0x53`、
 * 商店侧写成 `83`。依据见 `work/findings/bag-layout-2026-10-09.md`。
 */

import { TEXT_COLORS } from './text-style.ts';

/** 物品格：74 见方，图标内缩 5，选中框外扩 5。 */
export const SLOT = {size:74, icon:{x:5, y:5, size:64}, selection:{x:-5, y:-5, size:84}};

/**
 * 格子在网格里的步长。四列 332 与 323 宽的网格差出 9 像素的格间距。
 * 它属于「网格怎么排」，不属于格子本身——背包的布局里两者是分开的字段。
 */
export const SLOT_STRIDE = 83;

/**
 * 货币排版：单位间距 103，币图 44×40，数字在币图右侧 +44/+6。
 * `offset` 是金额在所属框内的落点，`plateOffset` 是它下面那块 323 宽的底板（比金额低 3 像素）。
 */
export const MONEY = {
  stride:103, coin:{width:44, height:40}, digit:{x:44, y:6}, color:TEXT_COLORS.white,
  offset:{x:34, y:365}, plateOffset:{x:34, y:368, width:323},
};

/**
 * 右栏六个筛选按钮的纵向偏移。
 *
 * **保留字面值，不要改成按步长累加**：相邻差是 70/69/69/69/70，不是按钮高度 57
 * 的整数倍；按平均步长取整会得到 0/69/139/208/278/347，与实际差一位，会挪动界面。
 */
export const SIDE_BUTTON_OFFSETS:number[] = [0, 70, 139, 208, 277, 347];

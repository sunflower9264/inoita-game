/**
 * 背包面板的参考像素布局，原点取内容区左上角（与装备框 x=85、背包框 x=496 同一坐标系）。
 *
 * 数值来自原版反汇编：
 * - `UIEquip_CreateEquipControl @0x149738`：左（装备）框 85,0,409,431；人物预览局部
 *   129,110,157,157；十个装备槽屏幕坐标读表 `0xbbaa4`，导出为内容区坐标时减去 (85,133)。
 * - `UIEquip_CreateInvenControl @0x149b38`：右（背包）框 496,0,395,431；内部网格组
 *   34,27,323,323，含 16 个格子的坐标 0/0x53/0xa6/0xf9 两轴组合，即四列四行、步长
 *   0x53=83；右侧按钮组 389,12,57,396 内含 6 个 57×57 按钮，组内 y 偏移
 *   0/0x46/0x8b/0xd0/0x115/0x15b。
 * - `UIEquip_DrawInvenBackground @0x14aed0`：右框内文字底板画在 (x+34, 368) 宽 323，
 *   金额画在 (x+34, 365)。
 * - `ITEM_DrawPorting @0x1a219c`：物品图标 +5/+5、64×64；数量角标 +67/+47、白色、右对齐。
 * - `UIDesc_SetItemDescControlRect @0x145fe4`：物品说明可切到 x=85 或 x=496，位于装备／物品两侧区域，
 *   y 恒为 133，正是内容框的顶边。
 * - `UIDesc_CreateControl @0x14592c`：说明面板的滚动区在面板内 (20,60) 358×258，右上角关闭
 *   按钮在 (349,−6) 67×67，底部菜单行的组在 (15,362) 377×55。
 * - `UIDesc_SetMenuButtonRect @0x1485ec`：菜单按钮是一横排，每个宽 125（组高 55）、步长
 *   0x7e=126，起始偏移按按钮数量取：1 个 126、2 个 64、3 个 0。三个恰好铺满 377。
 *
 * 证据文件见 `work/menu-panels/evidence/`（`inventory-layout.asm`、`equip-slots.asm`、
 * `uidesc-item-desc-rect.asm`、`uidesc-create-control.asm`、`uidesc-set-menu-button-rect.asm`）与
 * `work/bag-items/evidence/`；布局结论见 `work/findings/bag-layout-2026-10-09.md`，
 * 说明面板的矩形与底色见 `work/findings/desc-panel-2026-10-12.md`。
 */
import { MONEY, SLOT, SLOT_STRIDE } from './item-layout.ts';
import { TEXT_COLORS } from './text-style.ts';

/** 说明面板里正文与标题的颜色：原版说明面板的文字是白色。 */
export const DESCRIPTION_TEXT = TEXT_COLORS.white;

interface BagRect { x:number; y:number; width:number; height:number }

/** 侧边分类列的文字字号：背包页与商店页的分类列都读它，两处始终一样大（每格 57×57，19 号字左右各留 9 像素）。 */
export const SIDE_FILTER_TEXT_SIZE = 19;

/** 说明面板底部按钮行的步长：原版按按钮数量取起始偏移（`UIDesc_SetMenuButtonRect @0x1485ec`），每个宽 125、步长 126。 */
const DESCRIPTION_MENU_BUTTON_STRIDE = 126;

interface BagLayout {
  leftFrame:BagRect;
  /** 人物预览：内容区绝对坐标（原版局部 129,110 加左框基址 85）。 */
  preview:BagRect;
  bagFrame:BagRect;
  grid:{x:number; y:number; width:number; height:number; stride:number; columns:number};
  slot:typeof SLOT;
  /** 分类侧栏：右区块外框内的 6 个 57×57 平铺行。 */
  sideButtons:{x:number; y:number; width:number; height:number; offsets:number[]};
  /** 整理保持在背包框上方外侧。 */
  organize:BagRect;
  money:{x:number; y:number; plate:BagRect; stride:number; coin:{width:number; height:number}; digit:{x:number; y:number}; color:string};
  badge:{x:number; y:number; color:string};
}

/**
 * 说明面板：物品说明与商品说明共用同一份矩形与子件，都是原版 `UIDesc_*` 那一套。
 *
 * - `UIDesc_Draw @0x1486e8`：面板自己画内缩 10 的黑色 60% 底色，再画 `UI_DrawBorderRect`，
 *   矩形取控件的绝对矩形。
 * - 子件按宽度 **442** 排（`ControlObject_SetRect(panel, 0, y, 0x1ba, h)`）；面板实际取多宽由调用方定，
 *   见 `descriptionPanel(width)`——原版面板与它盖住的那一栏同宽（`UIDesc_SetItemDescControlRect @0x145fe4`
 *   只改 x 与 y=133、保留原有宽高，宽度是建面板时给的），高度 431 由纵向图框素材反证：
 *   `edge-vertical.png` 是 24×383，而 431−48=383。
 * - `UIDesc_SetItemDescControlRect @0x145fe4`：x 取 85（mode 0）或 496（mode 1），y 恒为 133；
 *   133 正是内容框的顶边，所以面板与它盖住的那一栏上下对齐。
 * - 子件相对面板左上角：正文滚动区 `(20,60,358,258)`、右上角关闭按钮 `(349,−6,67,67)`、
 *   底部菜单行 `(15,362,377,55)`（`UIDesc_CreateControl @0x14592c`）。
 * - 物品名不在滚动区里：`UIDesc_Draw @0x148874` 把它画在 `(面板左+20, 面板顶+22)`、左对齐、
 *   占宽 `面板宽−82`（右边那段留给关闭按钮），字体取引擎字体 1，与商店页的分类名同一号。
 *   所以名字紧贴面板顶，正文从 +60 的滚动区才开始。
 *
 * 关闭按钮比面板顶边高 6 像素，是原版那种骑在右上角的做法。
 * 依据见 `work/findings/desc-panel-2026-10-12.md`。
 */
export const DESCRIPTION_PANEL = {
  y: 0, width: 442, height: 431,
  /** 442 是这套子件的设计宽度；实际面板按它盖住的那一栏取宽，见 `descriptionPanel`。 */
  /**
   * 黑色底色的内缩量取原版（`GRPX_FillRectAlpha(x+10,y+10,w−20,h−20,0xff000000,60)`）。
   * 内容区不透明：页面压暗由弹层遮罩统一负责，面板本身不再透出底下那一栏。
   */
  inset: 10, background: 0x000000, backgroundAlpha: 1,
  /** 物品名：落点与占宽来自 `UIDesc_Draw`，`right` 是右边留给关闭按钮的那段。 */
  title: { x: 20, y: 22, right: 82, size: 24 },
  scroll: { x: 20, y: 60, width: 358, height: 258 },
  /**
   * 右上角那枚圆钮。原版落点是 (349,−6)，即离面板右边缘 26 像素；本作按需求右移到 381——
   * 圆钮与顶边一样探出面板边缘 6 像素（图上圆形的可见部分因此离边 2 像素），看着才是「挂在右上角」。
   */
  close: { x: 381, y: -6, size: 67 },
  menu: { x: 15, y: 362, width: 377, height: 55, button: { width: 125, height: 55, stride: DESCRIPTION_MENU_BUTTON_STRIDE },
    offsets: { 1: DESCRIPTION_MENU_BUTTON_STRIDE, 2: 64, 3: 0 } as Record<number, number> },
};

/**
 * 说明面板按它盖住的那一栏取宽：原版 `UIDesc_SetItemDescControlRect @0x145fe4` 只改 x 与 y=133、
 * 保留面板原有的宽高，宽度是建面板时给的；对照原版画面，面板与所盖那一栏同宽同高
 * （高恒为 431，正是内容框的高度）。所以这里把 442 那套子件跟着面板宽度左右平移：
 * 正文滚动区、右上角关闭按钮与底部菜单行都保持原版的右侧留边（64／26／50），左侧留边（20／15）不变。
 *
 * 面板**比 442 宽**时同样要跟（分类商店的货架栏 462：卖出时说明面板盖的就是它），
 * 所以这里按差值双向调整——只收窄的话，关闭按钮与底部按钮行会缩在面板左边，不贴右边缘。
 */
export function descriptionPanel(width:number) {
  const base = DESCRIPTION_PANEL, shrink = base.width - width;
  return {
    ...base, width,
    scroll: {...base.scroll, width: base.scroll.width - shrink},
    close: {...base.close, x: base.close.x - shrink},
    menu: {...base.menu, width: base.menu.width - shrink},
  };
}

interface DescriptionActionLayout {
  /** 动作变多时正文滚动区要让出上面一行按钮的高度。 */
  scrollHeight: number;
  columns: number;
  rows: number;
  buttons: { x:number; y:number; width:number; height:number; fontSize:number }[];
}

/**
 * 说明面板底部动作按钮。1–3 个保持原版一横排；4 个改 2×2，5–6 个改 2×3，
 * 避免为了塞进一行把按钮压到 92 宽。坐标相对面板左上角。
 */
export function descriptionActionLayout(panelWidth:number, count:number): DescriptionActionLayout {
  const panel = descriptionPanel(panelWidth), menu = panel.menu;
  if (count <= 0) return { scrollHeight: panel.scroll.height, columns: 0, rows: 0, buttons: [] };
  if (count <= 3) return {
    scrollHeight: panel.scroll.height, columns: count, rows: 1,
    buttons: Array.from({ length: count }, (_, index) => ({
      x: menu.x + menu.offsets[count] + index * menu.button.stride, y: menu.y,
      width: menu.button.width, height: menu.button.height, fontSize: 18,
    })),
  };
  const columns = 2, gap = 8, rowGap = 7;
  const width = Math.floor((menu.width - gap * (columns - 1)) / columns);
  const rows = Math.ceil(count / columns), bottom = panel.height - 14;
  const rowHeight = Math.min(menu.button.height,
    Math.floor((bottom - panel.scroll.y - 20 - rowGap * (rows - 1)) / rows));
  const firstY = bottom - rows * rowHeight - rowGap * (rows - 1);
  return {
    scrollHeight: firstY - panel.scroll.y - 10, columns, rows,
    buttons: Array.from({ length: count }, (_, index) => ({
      x: menu.x + (index % columns) * (width + gap),
      y: firstY + Math.floor(index / columns) * (rowHeight + rowGap),
      width, height: rowHeight, fontSize: columns === 2 ? 18 : 14,
    })),
  };
}

/** 动作按钮文字左右合计留出的宽度：按钮宽减去它才是可用文字宽。 */
const ACTION_LABEL_MARGIN = 41;

/** 动作文字按按钮中间的平直区域缩放；按每字最多一个字号估算，保留两端圆角。 */
export function descriptionActionLabelSize(label:string, buttonWidth:number, maxSize:number):number {
  const length=Array.from(label).length;
  return length ? Math.max(1,Math.min(maxSize,Math.floor(Math.max(1,buttonWidth-ACTION_LABEL_MARGIN)/length))) : maxSize;
}

/**
 * 背包右区块：外框把格子与分类侧栏包在一起。
 * 外框 496..952，内沿 520..928；分类侧栏 869..926，分隔线 867。
 * 分类行从 y=40 开始，每行 57 高、步长 59；整理仍在框外原位。
 */
export const BAG_OUTER_FRAME = { x:496, y:0, width:456, height:431 } as const;
export const BAG_RAIL = {
  x:869, y:24, width:57, height:383, dividerX:867, rowTop:40, rowStep:59, rowHeight:57
} as const;

/**
 * 说明面板盖住背包栏时的宽度：371 = 侧栏分隔线 867 − 背包左缘 496。
 * 面板到分隔线就停，分类侧栏始终看得见、点得到。
 *
 * 原版面板固定 442 宽、比一整栏还宽，会把分类列压住；本作让开，
 * 商店里盖背包栏的那一份（买入时）用同一个宽度，两处看起来一致。
 * 见 `work/findings/desc-panel-2026-10-12.md`。
 */
export const BAG_DESCRIPTION_WIDTH = 371;

export function bagLayout():BagLayout {
  const bagFrame = { x:496, y:0, width:395, height:431 };
  return {
    leftFrame:{ x:85, y:0, width:409, height:431 },
    preview:{ x:85+129, y:110, width:157, height:157 },
    bagFrame,
    // 网格组在右框内 (34,27)，格子按格宽步长铺四列四行。
    grid:{ x:bagFrame.x+34, y:bagFrame.y+27, width:323, height:323, stride:SLOT_STRIDE, columns:4 },
    slot:SLOT,
    sideButtons:{ x:BAG_RAIL.x, y:BAG_RAIL.rowTop, width:BAG_RAIL.width, height:BAG_RAIL.rowHeight,
      offsets:Array.from({length:6},(_,index)=>index*BAG_RAIL.rowStep) },
    organize:{ x:bagFrame.x+389+(57-84)/2, y:bagFrame.y+12-68, width:84, height:44 },
    money:{ x:bagFrame.x+MONEY.offset.x, y:bagFrame.y+MONEY.offset.y,
      plate:{ x:bagFrame.x+MONEY.plateOffset.x, y:bagFrame.y+MONEY.plateOffset.y, width:MONEY.plateOffset.width, height:34 },
      stride:MONEY.stride, coin:MONEY.coin, digit:MONEY.digit, color:MONEY.color },
    badge:{ x:67, y:47, color:TEXT_COLORS.white },
  };
}

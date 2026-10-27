/** 说明面板与背包共用同一套矩形，只在 bag-layout 里维护一份。 */
import { MONEY, SIDE_BUTTON_OFFSETS, SLOT, SLOT_STRIDE } from './item-layout.ts';

/**
 * 商店面板的参考像素布局，原点取左右两栏外框的左上角。
 *
 * 数值来自原版反汇编：`UIStore_CreateMain @0x165a08`（两栏、分类按钮 88×69、4×4 货架、
 * 背包网格）、`UIStore_Draw @0x166d30`（分类名 `frame+278, frame+43` 居中、分类名底板
 * `frame+117, frame+41, 323`、标题框 `frame+131` 或 `frame+(宽−288)/2`、名称居中于标题框
 * `+144`）、`UIStore_DrawInvenBackground @0x1671fc`（背包底板、金额 `+34, +365` 与底板
 * `+34, +368, 323`）、`MONEY_DrawWithUnit @0x1b8b30`（先币后数、单位间距 103、
 * 币 44×40、数字左对齐于币 x+44、y+6、白色）、`ITEM_DrawPorting @0x1a219c`
 * （图标 +5/+5 64×64、数量角标 +67/+47 白色右对齐）。证据文件见
 * `work/game-shops-review/evidence/`。
 */
interface ShopRect { x:number; y:number; width:number; height:number }
export interface ShopLayout {
  leftFrame:ShopRect;
  bagFrame:ShopRect;
  /** 商人标题框画在左框上方；分类页与一般商店的横向定位不同。 */
  title:{x:number;y:number;width:number;height:number};
  /** 商人名的中心：横向居中于标题框，纵向落在标题框的中线上（帧顶下 6 像素）。 */
  titleName:{x:number;y:number};
  /** 分类列自己的修饰：上下两块 103×24 端盖与一条 14×411 竖条，只有分类商店画。 */
  categoryColumn:{cap:{x:number;y:number;bottom:number;width:number;height:number};divider:ShopRect};
  shelf:{x:number;y:number};
  /**
   * 背包栏右侧那 6 个 57×57 按钮，位置与背包页的同一列完全相同（`UIStore_CreateMain` 里
   * 右框内 (389,12,57,396)）。原版 `UIStore_DrawInvenBagGroup` 在这里切换背包分类，
   * 所以商店卖的也是背包里筛出来的那一类。
   */
  sideButtons:{x:number;y:number;width:number;height:number;offsets:number[]};
  category:{scroll:ShopRect;button:{width:number;height:number;stride:number};plate:ShopRect;name:{x:number;y:number}};
  bag:{x:number;y:number;width:number;height:number;stride:number;columns:number};
  slot:{size:number;stride:number;icon:{x:number;y:number;size:number};selection:{x:number;y:number;size:number}};
  badge:{x:number;y:number;color:string};
  money:{x:number;y:number;plate:ShopRect;stride:number;coin:{width:number;height:number};digit:{x:number;y:number};color:string};
}

/** 弹层黑底的内缩：`GRPX_FillRect(x+35, y+35, 宽−70, 高−70)`，数量框与确认框相同。 */
const TRADE_INSET = 35;
/** 原版文本底板的宽度：数量框 323、确认框 377。 */
const QUANTITY_PLATE_WIDTH = 323;
const MESSAGE_PLATE_WIDTH = 377;
/**
 * 弹层的图框：图组 19 的边框家族——四角 81×81、上下横条 380×81、左右竖条 81×304。
 *
 * 依据 `UIInputItemCount_Draw @0x14f4c8` 与 `UIPopupMsg_DrawDisplayTypeRectBackground @0x15e994`，
 * 两者画法一模一样：四角画在 (左−46, 上−46)、(右−35, 上−46)、(左−46, 下−35)、(右−35, 下−35)，
 * 横条画在 (左+35, 上−46) 与 (左+35, 下+45)，竖条画在 (左−46, 上+35) 与 (右+45, 上+35)。
 * 于是翅角向外探出 46 像素，四条边框的内沿正好落在黑底的内缩 35 上。
 */
export const POPUP_FRAME = {
  /** 四角 81×81：外沿离框 46 像素、内沿离框 35 像素。 */
  corner:{size:81, outer:46, inner:35},
  /** 上下横条：画在框外 46 像素处，高 81、宽为框宽 −70；下条从下沿往下 45 像素起画。 */
  horizontal:{height:81, top:-46, bottom:45, inset:35},
  /** 左右竖条：宽 81、高为框高 −70，左条从左边往左 46 像素起画。 */
  vertical:{width:81, left:-46, right:45, top:35},
  inset:TRADE_INSET,
};

/**
 * 数量框的参考像素，原点取弹层画布 450×350 的左上角。框体、计数区与按钮来自
 * `UIInputItemCount_CreateBaseControl @0x14ec30`，框内其余内容来自
 * `UIInputItemCount_Draw @0x14f4c8`：
 *
 * - 计数区 (95,50,260,58)，两侧箭头各 51×58（左偏移 0、右偏移 209）；
 * - 物品图标 64×64 画在 (150,47)，数量文字左对齐于 (233,56) 且是米色；
 * - 323 宽的文本底板在 (63,168)，金额在 (63,165)，都是底板左端对齐；
 * - 底部两枚 125×55 按钮，**确定在左 (45)、取消在右 (280)**。
 *
 * 原版在这些内容外面铺了一块不透明黑底：框内缩进 35 的 380×280，也就是
 * `GRPX_FillRect(x+35, y+35, 380, 280, 0xff000000)`。
 */
export const tradeLayout = {
  quantity:{width:450,height:350,
    plate:{x:TRADE_INSET,y:TRADE_INSET,width:450-TRADE_INSET*2,height:350-TRADE_INSET*2},
    field:{x:95,y:50,width:260,height:58},
    step:{width:51,height:58,left:0,right:209},
    icon:{x:150,y:47,size:64},
    count:{x:233,y:56,color:'#e2cb9e'},
    textPlate:{x:63,y:168,width:QUANTITY_PLATE_WIDTH},
    money:{x:63,y:165},
    button:{width:125,height:55,y:275,left:45,right:280}},
};

/**
 * 确认框的参考像素，原点同样取弹层画布左上角。
 *
 * 原版 `UIPopupMsg_SetLayout @0x15dbb0` 对「确定／取消」这一类固定按 `max(文本高, 235) + 115`
 * 算框高：235 是给正文留的高度、115 是按钮行到框底。所以正文不多的确认框与数量框一样是
 * 450×350，按钮行也同在 275（`UIPopupMsg_CreateButtonControl @0x15d5c4`：确定在左 45、
 * 取消在右 280，都是 125×55）。
 *
 * 自上而下是问题行、可选的提示行、可选的金额：正文在黑底上半区（35 到 235）里纵向居中，
 * 金额紧接正文、带原版 377 宽的文本底板并与底板左端对齐。
 */
export function tradeMessageLayout(lines:number, hasMoney:boolean) {
  const width = 450, step = 34, gap = 12, plateHeight = 34, buttonHeight = 55;
  const block = Math.max(1, lines) * step + (hasMoney ? gap + plateHeight : 0);
  const height = Math.max(235, block) + 115;
  const textY = Math.round(TRADE_INSET + Math.max(0, 235 - TRADE_INSET - block) / 2);
  const plateY = textY + block - (hasMoney ? plateHeight : 0);
  return {
    width, height,
    plate:{x:TRADE_INSET, y:TRADE_INSET, width:width-TRADE_INSET*2, height:height-TRADE_INSET*2},
    text:{x:width/2, y:textY, step},
    textPlate:{x:Math.round((width-MESSAGE_PLATE_WIDTH)/2), y:plateY, width:MESSAGE_PLATE_WIDTH},
    money:{x:Math.round((width-MESSAGE_PLATE_WIDTH)/2), y:plateY+3},
    button:{width:125, height:buttonHeight, y:275, left:45, right:280},
  };
}

/**
 * 物品说明面板。原版点商品先经 `UIStore_MakeDesc @0x166920` 弹这一层，在面板上点
 * "购买／出售"才进数量框。面板由通用的 `UIDesc_*` 系统画，所以矩形与子件跟背包那份是同一套
 * （见 `bag-layout.ts` 的 `DESCRIPTION_PANEL` 与 `work/findings/desc-panel-2026-10-12.md`）。
 *
 * 落点分两个方向：
 *
 * - **横向落对面那一栏**。`UIDesc_SetItemDescControlRect @0x145fe4` 用 mode 在左右两组常量间选，
 *   商店把买入记成 mode 1、卖出记成 mode 0，所以**买入落背包栏、卖出落货架栏**，正好挡住你没在点
 *   的那一栏。x 因此不写死，由调用方取当前 `shopLayout()` 的 `bagFrame.x` 或 `leftFrame.x`。
 * - **纵向与那一栏的顶边对齐**（原版恒为 133，就是内容框顶边），所以这里没有本作的纵向适配。
 */
/** 商店那份说明面板与背包共用一套矩形：按它盖住的那一栏取宽，见 `bag-layout.ts` 的 `descriptionPanel`。 */
export { descriptionPanel } from './bag-layout.ts';

/** 武器与防具商店多一条 88 宽的九类分类栏，左框也更宽。 */
export function shopLayout(classified:boolean):ShopLayout {
  const leftFrame = classified ? {x:18, y:0, width:462, height:431} : {x:85, y:0, width:395, height:431};
  const bagFrame = {x:484, y:0, width:395, height:431};
  // 分类页固定 131；一般商店把 288 宽的标题框居中在左框上。
  const titleX = classified ? leftFrame.x+131 : leftFrame.x+Math.trunc((leftFrame.width-288)/2);
  const title = {x:titleX, y:leftFrame.y-35, width:288, height:82};
  return {
    leftFrame, bagFrame, title,
    titleName:{x:titleX+144, y:title.y+title.height/2},
    // `UIStore_Draw` 给分类列画的上下端盖在左框的 (0,0) 与 (0,高−24)，竖条在 (93,10) 14×411。
    categoryColumn:{
      cap:{x:leftFrame.x, y:leftFrame.y, bottom:leftFrame.y+407, width:103, height:24},
      divider:{x:leftFrame.x+93, y:leftFrame.y+10, width:14, height:411},
    },
    shelf:classified ? {x:leftFrame.x+117, y:leftFrame.y+86} : {x:leftFrame.x+36, y:leftFrame.y+80},
    sideButtons:{x:bagFrame.x+389, y:bagFrame.y+12, width:57, height:57, offsets:SIDE_BUTTON_OFFSETS},
    category:{
      scroll:{x:leftFrame.x+10, y:leftFrame.y+10, width:88, height:412},
      button:{width:88, height:69, stride:69},
      plate:{x:leftFrame.x+117, y:leftFrame.y+41, width:323, height:34},
      // `GRPX_DrawStringWithFont(名字, 框左+278, 框顶+43, 居中, 居中)`：43 是 30 像素字号
      // 的上沿，落到 34 高的底板里就是纵向居中，所以这里直接给底板中线。
      name:{x:leftFrame.x+278, y:leftFrame.y+58},
    },
    bag:{x:bagFrame.x+34, y:bagFrame.y+27, width:323, height:323, stride:SLOT_STRIDE, columns:4},
    slot:{...SLOT, stride:SLOT_STRIDE},
    badge:{x:67, y:47, color:'#ffffff'},
    money:{
      x:bagFrame.x+MONEY.offset.x, y:bagFrame.y+MONEY.offset.y,
      plate:{x:bagFrame.x+MONEY.plateOffset.x, y:bagFrame.y+MONEY.plateOffset.y, width:MONEY.plateOffset.width, height:34},
      stride:MONEY.stride, coin:MONEY.coin, digit:MONEY.digit, color:MONEY.color,
    },
  };
}

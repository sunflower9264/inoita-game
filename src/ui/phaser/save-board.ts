import { buttonParts, type UiSurface } from './widgets.ts';
import { AUTO_SAVE_SLOT, MANUAL_SAVE_SLOT_COUNT, saveSlotLabel, type SaveSlotRef, type SlotSummaryReading } from '../../domain/save-game.ts';

/**
 * 手动槽的展示顺序：有存档的按写入时间倒序，最新的排在最前；空槽和损坏档
 * 没有可比较的时间，排在已有存档之后并按槽号稳定排列。槽号本身不变，操作仍落在原槽。
 */
export function newestFirstSlots(read:(slot:number)=>SlotSummaryReading):number[] {
  // 排序比较器会反复问同一个槽；每个槽只读一次，避免一次排序做近 20 次 JSON.parse。
  const readings=new Map<number,SlotSummaryReading>();
  const savedAt=(slot:number):number=>{
    let reading=readings.get(slot);
    if(reading===undefined){reading=read(slot);readings.set(slot,reading);}
    if(reading.kind!=='ok')return -1;
    const value=reading.summary.savedAt;
    return typeof value==='number'&&Number.isFinite(value)?value:-1;
  };
  return Array.from({length:MANUAL_SAVE_SLOT_COUNT},(_,slot)=>slot)
    .sort((left,right)=>savedAt(right)-savedAt(left)||left-right);
}

/**
 * 原版存档槽面板 `Scene_Init_POPUP_SC_SAVESLOT @0x1eae4c` 的实测几何：
 * 面板 668×530 居中、垂直再加 18（(屏高−530)/2+0x12），三个槽按钮 634×150、行距 166、
 * 面板内缩 17；行框是 668×184 的图（图组 88 项 0），画在槽按钮左上角 −17，所以 184 高的图
 * 里可见的框正好落在 150 高的按钮上，相邻两行不重叠。
 *
 * 面板本身没有底图——界面的样子全来自三张行框图（`Scene_Draw_POPUP_SC_SAVESLOT @0x1eba0c`
 * 只画背景、返回钮和按各自的绘制过程画槽按钮）。
 */
export const SAVE_BOARD = {
  panelWidth:668,
  rowWidth:634, rowHeight:150, rowStep:166, rowInset:17,
  frameWidth:668, frameHeight:184
} as const;

/**
 * 十一行（自动 1 + 手动 10）放不进一屏：自动存档固定画在标题下第一格，
 * 手动槽从下一格开始放进滚动区。行高与行距保持原版，不缩放。
 */
export const SAVE_BOARD_LAYOUT = {
  autoTop:56,
  listTop:56 + SAVE_BOARD.rowStep,
  listHeight:386
} as const;

/** 空槽上画的是原版「EMPTY」图（图组 88 项 3，173×68），不是文字。 */
const EMPTY_WIDTH = 173, EMPTY_HEIGHT = 68;
/** 槽位里立绘的高度：原版槽位立绘约 196×138（`UI_TITLESLOT_01` 图组 88 的 5/6/7 项）。 */
const PORTRAIT_HEIGHT = 126;
/** 槽位文字颜色：原版 `UIMainMenu_DrawSaveSlotButtons` 先算 RGB(0xe6,0xd9,0xa0) 再画全部文字。 */
export const SAVE_SLOT_TEXT = '#e6d9a0';
const SAVE_SLOT_TIME_TEXT = '#b9ad86';
/** 行内小控件（改名/删除）的宽度与留白；主按钮让开这一列，两者不重叠。 */
const CONTROL_WIDTH = 96, CONTROL_GAP = 20, CONTROL_COLUMN = CONTROL_WIDTH + CONTROL_GAP;

export interface SaveBoardControl { text:string; label:string; action:()=>void }
export interface SaveBoardRow {
  reading:SlotSummaryReading;
  /** 调用者提供可选槽的动作：开局允许空槽，读档只允许有效存档。 */
  action?:()=>void;
  /** 可访问名（键盘焦点与测试用它），手动槽固定「存档槽 N」。 */
  label:string;
  /** 行首标题：自动槽「自动存档」，手动槽是自定义名字或「存档槽 N」。 */
  title:string;
  /** 自动槽：空槽仍标出「自动存档」；手动空槽由 EMPTY 图表示，不重复写槽号。 */
  auto?:boolean;
  /** 改名 / 删除；自动槽永远没有。 */
  controls?:readonly SaveBoardControl[];
}
export interface SaveBoardAssets { frame:string; empty:string }

/** 面板左上角在当前画布里的位置。菜单画布 1024 宽 → 178（= 内容区 32 + 960 空间里的 146）。 */
export function saveBoardOrigin(width:number):{x:number; y:number} {
  return { x:Math.round((width-SAVE_BOARD.panelWidth)/2), y:SAVE_BOARD_LAYOUT.autoTop };
}

/** 行标题：自动槽固定「自动存档」，手动槽用自定义名字，没有就是「存档槽 N」。 */
export function saveRowTitle(ref:SaveSlotRef, reading:SlotSummaryReading):string {
  const name=reading.kind==='ok'?reading.summary.name:undefined;
  if(ref===AUTO_SAVE_SLOT)return saveSlotLabel(ref);
  return name||saveSlotLabel(ref);
}

/** 存档时间：`2026-10-19 21:04`。手工补零，不依赖 Intl。 */
export function formatSavedAt(savedAt?:number):string {
  if(typeof savedAt!=='number'||!Number.isFinite(savedAt))return '';
  const date=new Date(savedAt), pad=(value:number)=>String(value).padStart(2,'0');
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 画一行存档。`origin.x` 是行框左缘，`top` 是行框顶；行画在 `parent` 里时
 * 传入滚动区的内容容器（坐标相对容器）。
 */
export function drawSaveBoardRow(
  view:UiSurface, assets:SaveBoardAssets, origin:{x:number; y:number}, top:number,
  row:SaveBoardRow, parent?:Phaser.GameObjects.Container
):void {
  view.image(assets.frame,origin.x,top,SAVE_BOARD.frameWidth,SAVE_BOARD.frameHeight,parent);
  const left=origin.x+SAVE_BOARD.rowInset, bottom=top+SAVE_BOARD.rowInset;
  if(row.reading.kind==='ok'){
    const summary=row.reading.summary;
    // 立绘只给高度，宽度按原图比例：人物页立绘是竖幅的胸像。
    view.image(summary.portrait,left+20,bottom+12,undefined,PORTRAIT_HEIGHT,parent);
    view.text(row.title,left+170,bottom+14,340,24,SAVE_SLOT_TEXT,parent);
    view.text(summary.mapName,left+170,bottom+48,340,20,SAVE_SLOT_TEXT,parent);
    view.text(`LV.${summary.level} · ${summary.className}`,left+170,bottom+78,340,18,SAVE_SLOT_TEXT,parent);
    const savedAt=formatSavedAt(summary.savedAt);
    if(savedAt)view.text(savedAt,left+170,bottom+106,340,18,SAVE_SLOT_TIME_TEXT,parent);
  }else{
    view.image(assets.empty,origin.x+Math.round((SAVE_BOARD.panelWidth-EMPTY_WIDTH)/2),top+Math.round((SAVE_BOARD.frameHeight-EMPTY_HEIGHT)/2),EMPTY_WIDTH,EMPTY_HEIGHT,parent);
    // 空槽由 EMPTY 图本身表示；只有自动槽还需要名字，手动槽不再重复写「存档槽 N」。
    if(row.auto)view.text(row.title,left+170,bottom+58,340,24,SAVE_SLOT_TEXT,parent);
  }
  if(row.action)view.button('',left,bottom,row.controls?.length?SAVE_BOARD.rowWidth-CONTROL_COLUMN:SAVE_BOARD.rowWidth,SAVE_BOARD.rowHeight,row.action,
    {bare:true,parent}).setData('label',row.label);
  row.controls?.forEach((control,index)=>{
    const x=left+SAVE_BOARD.rowWidth-CONTROL_WIDTH;
    const y=bottom+(index===0?20:76);
    const button=view.button(control.label,x,y,CONTROL_WIDTH,44,control.action,{fontSize:20,parent});
    buttonParts(button).text?.setText(control.text);
  });
}


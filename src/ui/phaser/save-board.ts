import type { UiNode } from '../dom/node.ts';
import { GOLD, type UiSurface } from './widgets.ts';
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
/** 左侧缩略图区域：高度沿用原版槽位立绘，截图按 16:9 完整放进框里。 */
const PORTRAIT_HEIGHT = 126;
const SHOT_X = 20, SHOT_WIDTH = 180, SHOT_HEIGHT = 101;
/** 右侧文字从缩略图之后开始；宽度给右侧改名/删除控件留出空间。 */
const TEXT_X = 216, TEXT_WIDTH = 300;
/** 槽位文字颜色：原版 `UIMainMenu_DrawSaveSlotButtons` 先算 RGB(0xe6,0xd9,0xa0) 再画全部文字。 */
const SAVE_SLOT_TEXT = '#e6d9a0';
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
interface SaveBoardAssets { frame:string; empty:string }

/** 一段槽位文字；坐标是页面坐标，滚动区的行由宿主按 `scroll`/`clip` 跟随。 */
export interface SaveBoardTextSpec {
  key:string; text:string; x:number; y:number; size:number; color?:string; width?:number;
  anchorX?:number; anchorY?:number; align?:'left'|'center'|'right';
  scroll?:string; clip?:{ top:number; bottom:number };
}
interface SaveBoardTextSink { add(spec:SaveBoardTextSpec):void }
// 菜单页把文字交给 DOM 层时挂一个接收器；标题页没有接收器，继续用 Phaser 文字。
const textSinks=new WeakMap<UiSurface,SaveBoardTextSink>();

/** 给一次绘制挂上文字接收器；传 `undefined` 恢复 Phaser 文字。 */
export function setSaveBoardTextSink(view:UiSurface,sink:SaveBoardTextSink|undefined):void {
  if(sink)textSinks.set(view,sink);else textSinks.delete(view);
}

export function emitSaveBoardTexts(view:UiSurface,specs:readonly SaveBoardTextSpec[]):void {
  const sink=textSinks.get(view);if(sink)for(const spec of specs)sink.add(spec);
}

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
function formatSavedAt(savedAt?:number):string {
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
  row:SaveBoardRow, parent?:UiNode
):UiNode|undefined {
  view.image(assets.frame,origin.x,top,SAVE_BOARD.frameWidth,SAVE_BOARD.frameHeight,parent);
  const left=origin.x+SAVE_BOARD.rowInset, bottom=top+SAVE_BOARD.rowInset;
  const sink=textSinks.get(view);
  // 滚动区里的行由宿主把内容容器放在 (origin.x, listTop)；文字坐标补回滚动区原点，
  // 再交给 `scroll: 'slots'` 扣除滚动量。没有接收器时（标题页）直接画 Phaser 文字。
  const key=parent?`list-${top}`:`auto-${top}`;
  const text=(part:string,value:string,x:number,y:number,width:number,size:number,color:string,
    anchorX=0,anchorY=0):void=>{
    if(!sink){
      const result=view.text(value,x,y,width,size,color,parent);
      if(anchorX||anchorY)result.setOrigin(anchorX,anchorY);
      return;
    }
    const offset=parent?saveBoardOrigin(view.width):{ x:0, y:0 };
    sink.add({key:`${key}-${part}`,text:value,x:offset.x+x,y:(parent?SAVE_BOARD_LAYOUT.listTop:0)+y,width:width||undefined,
      size,color,anchorX,anchorY,
      ...(parent?{ scroll:'slots',clip:{top:SAVE_BOARD_LAYOUT.listTop,bottom:SAVE_BOARD_LAYOUT.listTop+SAVE_BOARD_LAYOUT.listHeight} }:{})});
  };
  if(row.reading.kind==='ok'){
    const summary=row.reading.summary;
    // 只画保存时截下的游戏画面；旧存档没有截图时左侧留空，不拿立绘顶替。
    if(summary.screenshot){
      const shotY=bottom+12+Math.round((PORTRAIT_HEIGHT-SHOT_HEIGHT)/2);
      view.imageContain(summary.screenshot,left+SHOT_X,shotY,SHOT_WIDTH,SHOT_HEIGHT,parent);
    }
    text('title',row.title,left+TEXT_X,bottom+14,TEXT_WIDTH,24,SAVE_SLOT_TEXT);
    text('map',summary.mapName,left+TEXT_X,bottom+48,TEXT_WIDTH,20,SAVE_SLOT_TEXT);
    text('level',`LV.${summary.level} · ${summary.className}`,left+TEXT_X,bottom+78,TEXT_WIDTH,18,SAVE_SLOT_TEXT);
    const savedAt=formatSavedAt(summary.savedAt);
    if(savedAt)text('time',savedAt,left+TEXT_X,bottom+106,TEXT_WIDTH,18,SAVE_SLOT_TIME_TEXT);
  }else{
    view.image(assets.empty,origin.x+Math.round((SAVE_BOARD.panelWidth-EMPTY_WIDTH)/2),top+Math.round((SAVE_BOARD.frameHeight-EMPTY_HEIGHT)/2),EMPTY_WIDTH,EMPTY_HEIGHT,parent);
    // 空槽由 EMPTY 图本身表示；只有自动槽还需要名字，手动槽不再重复写「存档槽 N」。
    if(row.auto)text('title',row.title,left+170,bottom+58,340,24,SAVE_SLOT_TEXT);
  }
  const rowButton=row.action?view.button('',left,bottom,row.controls?.length?SAVE_BOARD.rowWidth-CONTROL_COLUMN:SAVE_BOARD.rowWidth,SAVE_BOARD.rowHeight,row.action,
    {bare:true,parent}).setData('label',row.label):undefined;
  row.controls?.forEach((control,index)=>{
    const x=left+SAVE_BOARD.rowWidth-CONTROL_WIDTH;
    const y=bottom+(index===0?20:76);
    view.button('',x,y,CONTROL_WIDTH,44,control.action,{parent}).setData('label',control.label);
    text(`control-${index}`,control.text,x+CONTROL_WIDTH/2,y+22,0,20,GOLD,.5,.5);
  });
  return rowButton;
}


/** 按槽位身份保留手动存档行；排序变化只移动已有节点和文字。 */
export class SaveBoardList {
  private readonly rows=new Map<number,{top:number;nodes:UiNode[];texts:SaveBoardTextSpec[];button?:UiNode}>();
  constructor(privateView:UiSurface,privateScroll:import('./widgets.ts').ScrollArea,privateAssets:SaveBoardAssets,
    rowFor:(slot:number)=>SaveBoardRow){
    this.view=privateView;this.scroll=privateScroll;this.assets=privateAssets;this.rowFor=rowFor;
  }
  private readonly view:UiSurface;
  private readonly scroll:import('./widgets.ts').ScrollArea;
  private readonly assets:SaveBoardAssets;
  private readonly rowFor:(slot:number)=>SaveBoardRow;

  render(order:readonly number[]):SaveBoardTextSpec[]{
    this.rows.clear();order.forEach((slot,index)=>this.paint(slot,index));return this.texts(order);
  }
  update(changed:number,order:readonly number[]):SaveBoardTextSpec[]{
    const previous=this.rows.get(changed);
    if(previous){for(const node of previous.nodes)node.destroy();this.rows.delete(changed);}
    order.forEach((slot,index)=>{
      const row=this.rows.get(slot),top=index*SAVE_BOARD.rowStep;
      if(!row){this.paint(slot,index);return;}
      const delta=top-row.top;if(!delta)return;
      row.top=top;for(const node of row.nodes)node.setY(node.y+delta);
      for(const spec of row.texts)spec.y+=delta;
    });
    this.view.pruneDestroyed();return this.texts(order);
  }
  updateTitle(slot:number,title:string):void{
    const row=this.rows.get(slot);if(!row)return;
    row.button?.setData('label',title);
    const spec=row.texts.find(value=>value.key===`save-slot-${slot}-title`);if(spec)spec.text=title;
  }
  private texts(order:readonly number[]):SaveBoardTextSpec[]{return order.flatMap(slot=>this.rows.get(slot)?.texts??[]);}
  private paint(slot:number,index:number):void{
    const top=index*SAVE_BOARD.rowStep,before=new Set(this.scroll.content.list),texts:SaveBoardTextSpec[]=[];
    const previous=textSinks.get(this.view);
    setSaveBoardTextSink(this.view,{add:spec=>{
      spec.key=`save-slot-${slot}-${spec.key.replace(/^list-\d+-/,'')}`;texts.push(spec);
    }});
    let button:UiNode|undefined;
    try{button=drawSaveBoardRow(this.view,this.assets,{x:0,y:0},top,this.rowFor(slot),this.scroll.content);}
    finally{setSaveBoardTextSink(this.view,previous);}
    const nodes=this.scroll.content.list.filter(node=>!before.has(node));
    this.rows.set(slot,{top,nodes,texts,button});
  }
}

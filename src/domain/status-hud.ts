/** 原版状态面板的图片、参考像素布局和目标等级颜色。 */
export const STATUS_PARTS = ['player-shadow','player-frame','player-portrait',
  'member-shadow','member-frame','member-portrait','member-portrait-down','player-portrait-down',
  'health-start','health-fill','health-end','mana-start','mana-fill','mana-end',
  'experience-start','experience-fill','experience-end',
  'target-start','target-fill','target-end','overhead-frame','overhead-leader'] as const;
export interface HudRect { x:number; y:number; width:number; height:number }
/** 素材四周的透明留白（显示尺寸单位）；右缘对齐等视觉边界从这里算。 */
export interface HudInset { left:number; top:number; right:number; bottom:number }
export interface HudGauge {
  x:number; y:number; fillOffset:number; fillWidth:number; startWidth:number; endWidth:number; height:number;
}
type HudGauges = Record<'health'|'mana'|'experience',HudGauge>;
/** 原版右侧竖排的队友信息窗口：每个队伍槽一块，空槽不画。 */
interface MemberPanelSkin {
  /** 三块面板相对屏幕顶边的参考 y。 */
  slots:number[];
  width:number; height:number; inset:HudInset; portrait:HudRect; level:HudRect; gauges:HudGauges;
}
/** 面板左下角的状态图标行：每枚左移 step。 */
interface BuffIconSkin {
  size:number; step:number;
  /** buff 名 → 图标文件；不在表里或没有图标的 buff 不画。 */
  catalog:Record<string,string>;
}
export interface StatusHudSkin {
  assets: Record<typeof STATUS_PARTS[number],string>;
  player: {width:number;height:number;inset:HudInset;portrait:HudRect;level:HudRect;gauges:HudGauges};
  member: MemberPanelSkin;
  buffIcons: BuffIconSkin;
  target: {width:number;height:number;name:HudRect;gauge:HudGauge};
  /** 头顶状态槽相对头部锚点的布局，单位为地图像素。 */
  overhead: {frame:HudRect;leader:HudRect;health:HudRect & {color:string};mana:HudRect & {color:string}};
  levelColors:{minDifference:number;color:string}[];
}
/**
 * 状态图标排在面板左下角、依次向左：第一枚的下边缘齐面板底边、左边缘在面板左缘左侧半个
 * 图标宽处（右边缘于是落在面板左缘右移半个图标宽，图标骑在左缘上），之后每枚再向左 step。
 * 坐标用面板容器的局部坐标，原点即面板左上角，所以面板移动或缩放时图标跟随。
 */
export function buffIconPosition(skin:BuffIconSkin,panelBottom:number,index:number):{x:number;y:number} {
  return {x:-skin.size/2-index*skin.step,y:panelBottom-skin.size};
}
/**
 * 竖排队友面板列出的成员：当前操控者以外的出战成员，按队伍顺序。
 * 大面板常驻当前操控者，所以被操控的佣兵不会再在竖排里重复出现一次。
 */
export function memberPanelIds(active:readonly string[],controlled:string):readonly string[] {
  return active.filter(id=>id!==controlled);
}
export interface MemberColumnInput {
  /** 大面板左上角的 y（屏幕像素）。 */
  top:number;
  /** 大面板高度（屏幕像素）。 */
  playerHeight:number;
  /** 一块队友面板的原始高度；缩放由本函数算出。 */
  memberHeight:number;
  /** 要排列的面板数量。 */
  count:number;
  /** 面板列允许到达的最下沿，即切换按钮上缘（屏幕像素）。 */
  limit:number;
  /** 800×480 参考坐标到屏幕像素的缩放。 */
  size:number;
  /** 大面板与第一块队友面板之间的空隙（屏幕像素）。 */
  columnGap:number;
  /** 队友面板之间的空隙（屏幕像素）。 */
  rowGap:number;
}
export interface MemberColumn { scale:number; tops:number[] }
/**
 * 队友面板列紧接大面板下缘向下排，整体缩放保证最后一块不越过 `limit`。
 * 空隙不参与面板缩放，所以小屏上面板缩小、行距仍然看得清。
 */
export function memberColumnLayout(input:MemberColumnInput):MemberColumn {
  const {top,playerHeight,memberHeight,count,limit,size,columnGap,rowGap}=input;
  if(count<=0)return {scale:1,tops:[]};
  const start=top+playerHeight+columnGap;
  const available=Math.max(0,limit-start);
  // 空间连行距都不够时先压缩行距，最后一块才会落在 limit 上而不是越过去。
  const gap=count>1?Math.min(rowGap,available/(count-1)):0;
  const scale=Math.min(1,Math.max(0,(available-(count-1)*gap)/(count*memberHeight*size)));
  const row=memberHeight*size*scale;
  return {scale,tops:Array.from({length:count},(_,index)=>start+index*(row+gap))};
}
/** 剩余时长进入最后 30 逻辑帧后开始闪烁，每 4 帧一个明暗周期，槽位保留。 */
const BLINK_WINDOW_FRAMES=30;
const BLINK_PERIOD_FRAMES=4;
export function buffIconBlinking(remainingFrames:number,globalTick:number):boolean {
  return remainingFrames<=BLINK_WINDOW_FRAMES&&Math.floor(globalTick/BLINK_PERIOD_FRAMES)%2===1;
}
export interface TargetStatus { id:string; name:string; level:number; health:number; maxHealth:number; sceneLevel:boolean }

/** 生命值的写入口：有限数字取整，再限制在零与生命上限之间。 */
export function boundedHealth(value:number,maxHealth:number):number {
  if(!Number.isFinite(value))throw new RangeError('生命值需要有限数字');
  return Math.max(0,Math.min(Math.trunc(value),maxHealth));
}
export function gaugeFillWidth(value:number,max:number,width:number):number {
  return max>0?Math.floor(width*Math.max(0,Math.min(value,max))/max):0;
}
export function targetNameColor(skin:StatusHudSkin,playerLevel:number,target:Pick<TargetStatus,'level'|'sceneLevel'>):string {
  if(target.sceneLevel)return '#ffffff';
  // 低 8 级以上的原版颜色是灰色，在明暗不一的地图上看不清，改用白色。
  return skin.levelColors.find(entry=>target.level-playerLevel>=entry.minDifference)?.color??'#ffffff';
}

/** 目标名称的原版锚点：横向取面板框中心，纵向为框顶边下 10 像素。文本按此点居中、顶端对齐。 */
export function targetNameAnchor(skin:StatusHudSkin):{x:number;y:number} {
  return {x:skin.target.name.x+skin.target.name.width/2,y:skin.target.name.y};
}

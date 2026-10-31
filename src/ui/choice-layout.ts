/**
 * 剧情/任务选项面板的竖排布局。场景负责量文字高度，这里只算几何：
 * 面板尽量向上长到放得下所有选项，放不下时选项区滚动，按钮高度始终够放下换行后的标签。
 */
export interface ChoiceLayoutInput {
  promptHeight: number;
  descriptionHeight?: number;
  /** 每个选项标签按选项宽度换行后的实际文字高度。 */
  optionTextHeights: readonly number[];
}

export interface ChoiceLayout {
  top: number;
  panelHeight: number;
  promptY: number;
  descriptionY?: number;
  descriptionView?: number;
  listY: number;
  listViewport: number;
  contentHeight: number;
  options: { y: number; height: number }[];
}

/** 选项按钮的最小高度、间距与文字上下留白；面板底边与顶端留白。 */
const OPTION_MIN_HEIGHT = 56, OPTION_GAP = 8, OPTION_TEXT_PADDING = 20;
const PANEL_BOTTOM = 620, PANEL_TOP_LIMIT = 20;
/** 面板顶部内边距、底部内边距，以及描述行与选项之间的间距、描述区最大高度。 */
const HEADER_PADDING_TOP = 14, PANEL_PADDING_BOTTOM = 16;
const DESCRIPTION_GAP = 10, DESCRIPTION_VIEW_HEIGHT = 44;

export function layoutChoicePanel(input: ChoiceLayoutInput): ChoiceLayout {
  const heights=input.optionTextHeights.map(height=>Math.max(OPTION_MIN_HEIGHT,height+OPTION_TEXT_PADDING));
  const contentHeight=heights.reduce((sum,height)=>sum+height,0)+Math.max(0,heights.length-1)*OPTION_GAP;
  const descriptionVisible=input.descriptionHeight!==undefined&&input.descriptionHeight>0;
  const view=descriptionVisible?Math.min(DESCRIPTION_VIEW_HEIGHT,input.descriptionHeight!):0;
  const header=HEADER_PADDING_TOP+input.promptHeight+(descriptionVisible?view+DESCRIPTION_GAP:0)+16;
  const panelHeight=Math.min(PANEL_BOTTOM-PANEL_TOP_LIMIT,header+contentHeight+PANEL_PADDING_BOTTOM),top=PANEL_BOTTOM-panelHeight;
  const promptY=top+HEADER_PADDING_TOP;
  let y=promptY+input.promptHeight;
  const descriptionY=descriptionVisible?y+DESCRIPTION_GAP:undefined;
  if(descriptionVisible)y+=DESCRIPTION_GAP+view;
  y+=16;
  const available=top+panelHeight-PANEL_PADDING_BOTTOM-y;
  const listViewport=Math.max(OPTION_MIN_HEIGHT,Math.min(available,contentHeight));
  let offset=0;
  const options=heights.map(height=>{const value={y:offset,height};offset+=height+OPTION_GAP;return value;});
  return {top,panelHeight,promptY,descriptionY,descriptionView:descriptionVisible?view:undefined,listY:y,listViewport,contentHeight,options};
}

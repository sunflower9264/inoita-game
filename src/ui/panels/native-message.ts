import { MENU_CANVAS_HEIGHT, MENU_CANVAS_WIDTH, screenCoverage } from './modal-placement.ts';
import { measureWrappedTextHeight } from './description-text.ts';
import type { MenuTextWriter } from '../dom/menu-text.ts';
import { UiNode } from '../dom/node.ts';
import { GOLD, type ScrollArea, type UiSurface } from '../widgets.ts';
import { frameRect } from '../viewport.ts';
const BUTTON_SIZE=20;
/** 横带最多占画面高度减去上下留白；超过后正文滚动，按钮仍在屏内。 */
const MAX_BAND_MARGIN=120;
const BODY_TOP=30;
const BUTTON_AREA=94;
/** 横带正文的单行宽度；测量、滚动区和 DOM 文字必须用同一个值。 */
const TEXT_WIDTH=410;
/** 花纹素材宽度；平铺时按弹层缩放放大到屏幕 CSS 像素。 */
const EDGE_WIDTH=240;
const EDGE_HEIGHT=38;
/** 横带上下花纹条的视觉外沿；页面文字让位时把这一圈也算进去。 */
export const NATIVE_MESSAGE_EDGE=30;

/** 宿主提供的滚动区入口；`StoryUI.scroll` 会同时登记 DOM 文字的滚动偏移。 */
export interface NativeMessageScroll {
  scroll(name:string,x:number,y:number,width:number,height:number):ScrollArea;
}

/** 横带在弹层本地坐标里的覆盖范围；宿主用它裁剪页面文字。 */
export interface NativeMessageBand { top:number; height:number; left:number; width:number }

/**
 * UIPopupMsg 的普通提示：居中的黑色横带、上下原版花纹与两个小号中文按钮。
 * 横带横向铺满整屏，纵向按文字高度加留白，并限制在画面内。
 *
 * 全屏的浅色罩、黑横带和花纹挂在直接铺满画框的覆盖层上，横向由浏览器按画框宽度铺满；
 * 弹层根节点的缩放只决定纵向位置。画框宽度变化后不需要重新量宽度，弹层重排时
 * 调用 `relayout` 更新纵向即可。
 *
 * 正文与按钮文字都交给 `writer` 输出；正文高度优先走表面的 `measureText` 计算，
 * 无真实 Canvas 的测试替身才回退到探针测量。
 * 正文超过横带可用高度时，宿主通过 `scroll` 建滚动区，正文滚动、按钮固定。
 * `writer` 接收弹层本地坐标，宿主按自己的页面坐标换算。
 */
export function drawNativeMessage(v:UiSurface,assets:Record<string,string>,message:string,accept:()=>void,cancel?:()=>void,
  writer?:MenuTextWriter,scroll?:NativeMessageScroll):NativeMessageBand {
  const width=MENU_CANVAS_WIDTH,height=MENU_CANVAS_HEIGHT,center=width/2;
  // 覆盖层不放进弹层根节点：横向铺满画框，弹层缩放只影响纵向位置。
  const cover=new UiNode(v.scene,v.mount).setDepth(v.depth-1).fillParent();
  new UiNode(v.scene,cover).setFillStyle(0xaa966e,.13).fillParent();
  const band=new UiNode(v.scene,cover).setFillStyle(0x000000,1).fillWidth();
  const edgeTop=new UiNode(v.scene,cover).fillWidth();
  const edgeBottom=new UiNode(v.scene,cover).fillWidth();
  const textHeight=measureWrappedTextHeight(v,message,TEXT_WIDTH,24,'#ffffff');
  const bandHeight=Math.min(textHeight+150,height-MAX_BAND_MARGIN),top=(height-bandHeight)/2;
  const coverage:NativeMessageBand={top,height:bandHeight,left:0,width:0};
  let paintedWidth=-1,paintedScaleX=0,paintedScaleY=0;
  const paintEdges=(widthCss:number,scaleX:number,scaleY:number):void=>{
    edgeTop.removeAll(true);edgeBottom.removeAll(true);
    const tileWidth=EDGE_WIDTH*scaleX,edgeHeight=EDGE_HEIGHT*scaleY;
    for(let x=0;x<widthCss;x+=tileWidth){
      v.image(assets['message-edge'],x,0,tileWidth,edgeHeight,edgeTop);
      v.image(assets['message-edge'],x,0,tileWidth,edgeHeight,edgeBottom).setFlipY(true);
    }
  };
  const relayout=():void=>{
    const matrix=v.root.getWorldTransformMatrix(),frame=frameRect();
    const scaleX=matrix.scaleX||1,scaleY=matrix.scaleY||1;
    band.setTopHeight(matrix.ty+top*scaleY,bandHeight*scaleY);
    // 上花纹底边压住横带上沿；下花纹翻转后压住横带下沿。
    edgeTop.setTopHeight(matrix.ty+(top-EDGE_HEIGHT+9)*scaleY,EDGE_HEIGHT*scaleY);
    edgeBottom.setTopHeight(matrix.ty+(top+bandHeight-EDGE_HEIGHT+28)*scaleY,EDGE_HEIGHT*scaleY);
    if(frame.width!==paintedWidth||scaleX!==paintedScaleX||scaleY!==paintedScaleY){
      paintEdges(frame.width,scaleX,scaleY);
      paintedWidth=frame.width;paintedScaleX=scaleX;paintedScaleY=scaleY;
    }
    const screen=screenCoverage(v);
    coverage.left=screen.left;coverage.width=screen.width;
  };
  relayout();
  v.setOverlay(cover,relayout);
  const bodyTop=top+BODY_TOP,bodyBottom=top+bandHeight-BUTTON_AREA-12;
  const bodyHeight=Math.max(1,bodyBottom-bodyTop),overflow=textHeight>bodyHeight+.5;
  const body=overflow&&scroll?scroll.scroll('native-message',center-TEXT_WIDTH/2,bodyTop,TEXT_WIDTH,bodyHeight):undefined;
  if(body)body.setHeight(textHeight);
  writer?.add({key:'native-message',text:message,x:center,y:bodyTop,
    style:{size:24,color:'#ffffff',anchorX:.5,anchorY:0,width:TEXT_WIDTH,align:'center',wrap:'word',lineHeight:29},
    scroll:body?'native-message':undefined,clip:overflow?{top:bodyTop,bottom:bodyBottom}:undefined});
  const buttonY=top+bandHeight-82;
  const button=(key:string,label:string,x:number,action:()=>void)=>{
    v.button('',x,buttonY,94,50,action).setData('label',label);
    writer?.add({key:`native-message-${key}`,text:label,x:x+47,y:buttonY+25,
      style:{size:BUTTON_SIZE,color:GOLD,anchorX:.5,anchorY:.5,width:82,align:'center',wrap:'word'}});
  };
  if(cancel){button('yes','是',center-194,accept);button('no','否',center+100,cancel);}
  else button('ok','确认',center-47,accept);
  return coverage;
}

import { MENU_CANVAS_HEIGHT, MENU_CANVAS_WIDTH, screenCoverage } from './modal-placement.ts';
import type { MenuTextWriter } from '../dom/menu-text.ts';
import { GOLD, type ScrollArea, type UiSurface } from './widgets.ts';
const BUTTON_SIZE=20;
/** 横带最多占画面高度减去上下留白；超过后正文滚动，按钮仍在屏内。 */
const MAX_BAND_MARGIN=120;
const BODY_TOP=30;
const BUTTON_AREA=94;
/** 横带正文的单行宽度；测量、滚动区和 DOM 文字必须用同一个值。 */
const TEXT_WIDTH=410;
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
 * 正文与按钮文字都交给 `writer` 输出；临时 DOM 文字只量横带高度，量完就销毁。
 * 正文超过横带可用高度时，宿主通过 `scroll` 建滚动区，正文滚动、按钮固定。
 * `writer` 接收弹层本地坐标，宿主按自己的页面坐标换算。
 */
export function drawNativeMessage(v:UiSurface,assets:Record<string,string>,message:string,accept:()=>void,cancel?:()=>void,
  writer?:MenuTextWriter,scroll?:NativeMessageScroll):NativeMessageBand {
  // 确认层按 1024×640 的内容框居中；横带按根节点实际原点铺满屏幕。
  const width=MENU_CANVAS_WIDTH,height=MENU_CANVAS_HEIGHT,screen=screenCoverage(v),center=width/2;
  v.rect(screen.left,screen.top,screen.width,screen.height,0xaa966e,.13);
  const text=v.text(message,center,0,TEXT_WIDTH,24,'#ffffff').setOrigin(.5,0);
  text.setAlign('center');
  const textHeight=text.height;
  text.destroy();
  const bandHeight=Math.min(textHeight+150,height-MAX_BAND_MARGIN),top=(height-bandHeight)/2;
  // 内容区不透明；页面压暗交给菜单的全局黑色遮罩。
  v.rect(screen.left,top,screen.width,bandHeight,0x000000,1);
  // 花纹素材是 240 宽；超出屏幕的部分由 DOM 层裁掉。
  for(let x=screen.left;x<screen.left+screen.width;x+=240){
    v.image(assets['message-edge'],x,top-29,240,38);
    v.image(assets['message-edge'],x,top+bandHeight+28,240,38).setOrigin(0,1).setFlipY(true);
  }
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
  return{top,height:bandHeight,left:screen.left,width:screen.width};
}

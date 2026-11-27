import assert from 'node:assert/strict';
import test, {after} from 'node:test';
import { drawNativeMessage } from '../src/ui/panels/native-message.ts';
import type { UiSurface } from '../src/ui/widgets.ts';
import type { UiNode } from '../src/ui/dom/node.ts';
import { installMenuDom, MenuElement, menuFrame } from './support/menu-dom.ts';

after(installMenuDom());
menuFrame.width=960;

interface ButtonCall { x:number; y:number }
interface ScrollCall { x:number; y:number; width:number; height:number; contentHeight:number }
interface ScreenState { x:number; y:number; scale:number }

function surface(originX=70.4,originY=64,textHeight=48) {
  const buttons:ButtonCall[]=[], scrolls:ScrollCall[]=[];
  const state:ScreenState={x:originX,y:originY,scale:.8};
  let overlay:UiNode|undefined, relayout:(()=>void)|undefined;
  const text={height:textHeight,
    setOrigin(){return text;},setAlign(){return text;},setPosition(){return text;},destroy(){}};
  const image={setFlipY(){return image;}};
  const view={
    width:1024,height:640,depth:400,
    mount:new MenuElement(),
    root:{shown:true,x:originX,y:originY,scaleX:.8,scaleY:.8,
      getWorldTransformMatrix(){return {tx:state.x,ty:state.y,scaleX:state.scale,scaleY:state.scale,
        transformPoint(x:number,y:number){return {x:state.x+x*state.scale,y:state.y+y*state.scale};}}}} as any,
    scene:{scale:{width:960,height:640}},
    rect(){throw new Error('全屏覆盖不再画进弹层根节点');},
    text(){return text;},
    image(){return image;},
    scroll(x:number,y:number,width:number,height:number){
      const call:ScrollCall={x,y,width,height,contentHeight:0};
      scrolls.push(call);
      return {setHeight(height:number){call.contentHeight=height;},scrollTop:0};
    },
    button(_label:string,x:number,y:number){buttons.push({x,y});return {setData(){return this;}};},
    setOverlay(value:UiNode,next:()=>void){overlay=value;relayout=next;},
  };
  return {view,state,buttons,scrolls,overlay:()=>overlay!,relayout:()=>relayout!};
}

function overlayParts(overlay:UiNode): { tint:UiNode; band:UiNode; edges:UiNode[] } {
  const [tint,band,...edges]=overlay.list;
  return {tint:tint!,band:band!,edges};
}
function px(node:UiNode,property:'left'|'right'|'top'|'height'):number {
  return Number.parseFloat(String(node.element.style[property]));
}

test('confirmation messages use a full-width black band and keep the short height',()=>{
  const {view,buttons,overlay}=surface();
  drawNativeMessage(view as unknown as UiSurface,{},'读取存档将丢失当前未保存的进度，确定读取？',()=>{},()=>{});
  const cover=overlay();
  assert.equal(cover.element.style.left,'0px','覆盖层贴住画框左边');
  assert.equal(cover.element.style.right,'0px','覆盖层贴住画框右边');
  assert.equal(cover.element.style.top,'0px');
  assert.equal(cover.element.style.bottom,'0px');
  const {tint,band,edges}=overlayParts(cover);
  assert.equal(tint.element.style.background,'rgba(170,150,110,0.13)','浅色罩铺满画框');
  assert.equal(tint.element.style.left,'0px');assert.equal(tint.element.style.right,'0px');
  assert.equal(band.element.style.background,'rgba(0,0,0,1)','横带内容区不透明');
  assert.equal(band.element.style.left,'0px','横带左右由画框决定，不写死宽度');
  assert.equal(band.element.style.right,'0px');
  assert.equal(px(band,'height'),(48+150)*.8,'高度按文字高度加留白');
  assert.ok(px(band,'top')>0,'上下仍留出画面');
  assert.equal(edges.length,2,'上下花纹各一条');
  assert.ok(buttons.every(button=>button.y>0&&button.y+50<=640),'确认按钮仍在屏内');
});

test('long confirmation messages cap the band and scroll the body inside the screen',()=>{
  const {view,buttons,scrolls,overlay}=surface(70.4,64,600);
  const scrollService={scroll:(_name:string,x:number,y:number,width:number,height:number)=>view.scroll(x,y,width,height)} as unknown as Parameters<typeof drawNativeMessage>[6];
  const bandRect=drawNativeMessage(view as unknown as UiSurface,{},'很长的确认提示',()=>{},undefined,undefined,scrollService);
  const {band}=overlayParts(overlay());
  assert.equal(px(band,'height'),(640-120)*.8,'横带封顶到画面高度减 120');
  assert.ok(bandRect.top>=0&&bandRect.top+bandRect.height<=640,'横带完整落在画面内');
  assert.equal(scrolls.length,1,'正文超过可用高度时建立滚动区');
  assert.equal(scrolls[0]!.contentHeight,600,'滚动内容按正文实际高度');
  assert.equal(scrolls[0]!.width,410);
  assert.ok(scrolls[0]!.height<400,'正文可视区让出按钮行');
  assert.ok(buttons.every(button=>button.y>0&&button.y+50<=640),'按钮仍在屏内');
});

test('ordinary notices share the same full-width band',()=>{
  const {view,overlay}=surface();
  drawNativeMessage(view as unknown as UiSurface,{},'保存成功',()=>{});
  const {band}=overlayParts(overlay());
  assert.equal(band.element.style.left,'0px');
  assert.equal(band.element.style.right,'0px');
  assert.equal(px(band,'height'),(48+150)*.8);
});

test('changing the frame and modal transform only repositions the band vertically',()=>{
  const {view,state,overlay,relayout}=surface(70.4,64);
  const coverage=drawNativeMessage(view as unknown as UiSurface,{},'保存成功',()=>{});
  const {band,edges}=overlayParts(overlay());
  const beforeTop=px(band,'top');
  menuFrame.width=1200;
  Object.assign(state,{x:250,y:80,scale:.9});
  relayout()();
  assert.equal(band.element.style.left,'0px','画框变宽时横带左端仍贴住画框');
  assert.equal(band.element.style.right,'0px','画框变宽时横带右端仍贴住画框');
  const top=(640-(48+150))/2;
  assert.equal(px(band,'top'),80+top*.9,'纵向跟着新的弹层变换');
  assert.notEqual(px(band,'top'),beforeTop);
  assert.equal(edges.length,2);
  assert.equal(px(edges[0]!,'top'),80+(top-29)*.9,'上花纹跟着横带');
  assert.equal(px(edges[1]!,'top'),80+(top+198-38+28)*.9,'下花纹跟着横带');
  assert.equal(coverage.left,-250/.9,'返回的覆盖范围按新原点换算');
  assert.equal(coverage.width,1200/.9,'返回的覆盖范围按新画框宽度换算');
});

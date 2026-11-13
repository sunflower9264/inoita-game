import assert from 'node:assert/strict';
import test, {after} from 'node:test';
import { drawNativeMessage } from '../src/ui/phaser/native-message.ts';
import type { UiSurface } from '../src/ui/phaser/widgets.ts';
import { installMenuDom, menuFrame } from './support/menu-dom.ts';

after(installMenuDom());
menuFrame.width=960;

interface RectCall { x:number; y:number; width:number; height:number; alpha:number }
interface ButtonCall { x:number; y:number }
interface ScrollCall { x:number; y:number; width:number; height:number; contentHeight:number }

function surface(originX=70.4,originY=64,textHeight=48) {
  const rects:RectCall[]=[], buttons:ButtonCall[]=[], scrolls:ScrollCall[]=[];
  const text={height:textHeight,
    setOrigin(){return text;},setAlign(){return text;},setPosition(){return text;},destroy(){}};
  const image={setOrigin(){return image;},setFlipY(){return image;}};
  const view={
    width:1024,height:640,
    root:{x:originX,y:originY,scaleX:.8,scaleY:.8,bringToTop() {},
      getWorldTransformMatrix(){return {scaleX:.8,scaleY:.8,
        transformPoint(x:number,y:number){return {x:originX+x*.8,y:originY+y*.8};}};}},
    scene:{scale:{width:960,height:640}},
    rect(x:number,y:number,width:number,height:number,_color:number,alpha=1){rects.push({x,y,width,height,alpha});},
    text(){return text;},
    image(){return image;},
    scroll(x:number,y:number,width:number,height:number){
      const call:ScrollCall={x,y,width,height,contentHeight:0};
      scrolls.push(call);
      return {setHeight(height:number){call.contentHeight=height;},scrollTop:0};
    },
    button(_label:string,x:number,y:number){buttons.push({x,y});return {setData(){return this;}};},
  };
  return {view,buttons,rects,scrolls};
}

test('confirmation messages use a full-width black band and keep the short height',()=>{
  const {view,rects,buttons}=surface();
  drawNativeMessage(view as unknown as UiSurface,{},'读取存档将丢失当前未保存的进度，确定读取？',()=>{},()=>{});
  const black=rects.filter(rect=>rect.width===1200).at(-1)!;
  assert.equal(70.4+black.x*.8,0,'缩放后左缘贴画布左边');
  assert.equal(black.width*.8,960,'宽度横穿整个画布');
  assert.equal(black.height,48+150,'高度仍是文字高度加留白');
  assert.equal(black.alpha,1,'横带内容区不透明');
  assert.ok(black.y>0,'上下仍留出画面');
  assert.ok(buttons.every(button=>button.y>0&&button.y+50<=640),'确认按钮仍在屏内');
});

test('long confirmation messages cap the band and scroll the body inside the screen',()=>{
  const {view,rects,buttons,scrolls}=surface(70.4,64,600);
  const scrollService={scroll:(_name:string,x:number,y:number,width:number,height:number)=>view.scroll(x,y,width,height)} as unknown as Parameters<typeof drawNativeMessage>[6];
  const band=drawNativeMessage(view as unknown as UiSurface,{},'很长的确认提示',()=>{},undefined,undefined,scrollService);
  const black=rects.filter(rect=>rect.width===1200).at(-1)!;
  assert.equal(black.alpha,1);
  assert.equal(black.height,640-120,'横带封顶到画面高度减 120');
  assert.ok(band.top>=0&&band.top+band.height<=640,'横带完整落在画面内');
  assert.equal(scrolls.length,1,'正文超过可用高度时建立滚动区');
  assert.equal(scrolls[0]!.contentHeight,600,'滚动内容按正文实际高度');
  assert.equal(scrolls[0]!.width,410);
  assert.ok(scrolls[0]!.height<400,'正文可视区让出按钮行');
  assert.ok(buttons.every(button=>button.y>0&&button.y+50<=640),'按钮仍在屏内');
});

test('ordinary notices share the same full-width band',()=>{
  const {view,rects}=surface();
  drawNativeMessage(view as unknown as UiSurface,{},'保存成功',()=>{});
  const black=rects.filter(rect=>rect.width===1200).at(-1)!;
  assert.equal(70.4+black.x*.8,0);
  assert.equal(black.width*.8,960);
  assert.equal(black.height,48+150);
  assert.ok(black.y>0);
});

test('full-width bands follow an off-centre surface instead of assuming screen centring',()=>{
  // 横屏刘海让左右安全区不相等时，菜单画布会偏离屏幕中心；横带仍要覆盖 0…960。
  const {view,rects}=surface(200,64);
  drawNativeMessage(view as unknown as UiSurface,{},'保存成功',()=>{});
  const black=rects.filter(rect=>rect.width===1200).at(-1)!;
  assert.equal(200+black.x*.8,0,'左缘仍贴画布左边');
  assert.equal(200+(black.x+black.width)*.8,960,'右缘仍贴画布右边');
});

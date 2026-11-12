import test from 'node:test';
import assert from 'node:assert/strict';
import {fitViewport,configureCanvas,canvasCssScale,readSafeArea} from '../src/ui/viewport.ts';
import {controlViewport,controlViewportCss} from '../src/ui/phaser/control-layout-viewport.ts';

/** 假窗口对象：测试只需要 `fitViewport` 读的 `visualViewport`。 */
interface FakeWindow {
 visualViewport?: {width: number; height: number; offsetLeft: number; offsetTop: number};
}

/** 假样式对象：`setProperty` 把值写回自身，断言随后直接读这些属性。 */
type FakeStyle = {setProperty(name: string, value: string): void} & Record<string, unknown>;

test('viewport offsets and safe insets affect the frame and controls separately, with a window fallback',()=>{
 const names=['window','document','getComputedStyle','innerWidth','innerHeight'];
 const globals=globalThis as unknown as Record<string, unknown>;
 const original: [string, PropertyDescriptor | undefined][]=names.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]);
 const style: FakeStyle={setProperty(name,value){this[name]=value;}};
 try {
  globals.window={visualViewport:{width:844,height:390,offsetLeft:3,offsetTop:27}};
  globals.document={getElementById:(id: string)=>id==='game-frame'?{style}:{}};
  globals.getComputedStyle=()=>({paddingLeft:'47px',paddingRight:'47px',paddingTop:'0px',paddingBottom:'21px'});
  globals.innerWidth=932;globals.innerHeight=430;
  fitViewport();
  assert.deepEqual([style.width,style.height,style.left,style.top],['844px','390px','3px','27px']);
  (globals.window as FakeWindow).visualViewport=undefined;fitViewport();
  assert.deepEqual([style.width,style.height,style.left,style.top],['932px','430px','0px','0px']);
 } finally {
  for(const [name,descriptor] of original) {
   if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globals[name];
  }
 }
});

test('keepSize follows the visual viewport offset without resizing the frame',()=>{
 const names=['window','document','getComputedStyle','innerWidth','innerHeight'];
 const globals=globalThis as unknown as Record<string, unknown>;
 const original: [string, PropertyDescriptor | undefined][]=names.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]);
 const style:FakeStyle={setProperty(name,value){this[name]=value;}};
 try {
  globals.window={visualViewport:{width:844,height:390,offsetLeft:0,offsetTop:0}};
  globals.document={getElementById:(id: string)=>id==='game-frame'?{style}:{}};
  globals.getComputedStyle=()=>({paddingLeft:'0px',paddingRight:'0px',paddingTop:'0px',paddingBottom:'0px'});
  globals.innerWidth=844;globals.innerHeight=390;
  fitViewport();
  assert.deepEqual([style.width,style.height,style.left,style.top],['844px','390px','0px','0px']);
  // 键盘弹出：可视区变矮并向上滚动。画布尺寸不动，只跟随位置偏移。
  globals.window={visualViewport:{width:844,height:250,offsetLeft:0,offsetTop:140}};
  globals.innerWidth=844;globals.innerHeight=250;
  fitViewport({keepSize:true});
  assert.deepEqual([style.width,style.height,style.left,style.top],['844px','390px','0px','140px']);
 } finally {
  for(const [name,descriptor] of original) {
   if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globals[name];
  }
 }
});

test('safe area is measured once until the viewport changes',()=>{
 const globals=globalThis as unknown as Record<string,unknown>;
 const original=['window','document','getComputedStyle'].map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)] as const);
 const style={setProperty(){}};
 let reads=0;
 try{
  globals.window={visualViewport:{width:844,height:390,offsetLeft:0,offsetTop:0}};
  globals.document={getElementById:(id:string)=>id==='game-frame'?{style}:{}};
  globals.getComputedStyle=()=>{reads++;return {paddingLeft:'47px',paddingRight:'47px',paddingTop:'0px',paddingBottom:'21px'};};
  fitViewport();
  assert.deepEqual(readSafeArea(),{left:47,right:47,top:0,bottom:21});
  const measured=reads;
  readSafeArea();
  assert.equal(reads,measured,'视口没变时不再读计算样式');
  fitViewport();
  readSafeArea();
  assert.equal(reads,measured+1,'视口重建后重新测量');
 }finally{
  for(const[name,descriptor]of original){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globals[name];}
 }
});

test('Android landscape uses the visible top edge for both browser and packaged UI',()=>{
 const globals=globalThis as unknown as Record<string,unknown>;
 const names=['window','document','navigator','getComputedStyle','innerWidth','innerHeight','InotiaNative'];
 const original=names.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)] as const);
 const style={setProperty(){}};
 try{
  globals.window={visualViewport:{width:802,height:360,offsetLeft:0,offsetTop:0}};
  globals.document={getElementById:(id:string)=>id==='game-frame'?{style,getBoundingClientRect:()=>({width:802,height:360,left:0,top:0})}:{}};
  globals.getComputedStyle=()=>({paddingLeft:'24px',paddingRight:'8px',paddingTop:'32px',paddingBottom:'12px'});
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{userAgent:'Mozilla/5.0 (Linux; Android 11)'}});
  globals.innerWidth=802;globals.innerHeight=360;
  fitViewport();
  assert.deepEqual(readSafeArea(),{left:24,right:8,top:0,bottom:12},'安卓浏览器横屏保留其他方向的安全边距');
  const scene={scale:{width:802,height:360},game:{canvas:{getBoundingClientRect:()=>({width:802,height:360})}}} as unknown as import('phaser').Scene;
  assert.deepEqual(controlViewport(scene).insets,{left:24,right:8,top:0,bottom:12},'地图和状态栏共用的坐标从画面顶边开始');
  const cssScene={scale:{width:1604,height:720},game:{canvas:{getBoundingClientRect:()=>({width:802,height:360})}}} as unknown as import('phaser').Scene;
  assert.deepEqual(controlViewportCss(cssScene),{width:802,height:360,insets:{left:24,right:8,top:0,bottom:12}},'DOM HUD 用 CSS 宽高和安全区');
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{userAgent:'test'}});
  globals.InotiaNative={};fitViewport();
  assert.deepEqual(readSafeArea(),{left:24,right:8,top:0,bottom:12},'安装包横屏同样贴近顶边');
  delete globals.InotiaNative;fitViewport();
  assert.equal(readSafeArea().top,32,'其他平台保留顶部安全边距');
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{userAgent:'Android'}});
  globals.innerWidth=360;globals.innerHeight=802;fitViewport();
  assert.equal(readSafeArea().top,32,'安卓竖屏保留顶部安全边距');
 }finally{
  for(const[name,descriptor]of original){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globals[name];}
 }
});

test('game pixels convert to frame CSS pixels with the same width the mount uses',()=>{
 const globals=globalThis as unknown as Record<string,unknown>;
 const original=['document'].map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)] as const);
 const frame={width:800,height:500};
 try{
  globals.document={getElementById:(id:string)=>id==='game-frame'?{getBoundingClientRect:()=>frame}:{}};
  const scene=(width:number)=>({scale:{width}}) as unknown as import('phaser').Scene;
  assert.equal(canvasCssScale(scene(800)),1);
  assert.ok(Math.abs(canvasCssScale(scene(1600))-.5)<1e-9);
  frame.width=767;
  assert.ok(Math.abs(canvasCssScale(scene(2109))-767/2109)<1e-9,'画框与画布不一致时按画框宽度换算');
 }finally{
  for(const[name,descriptor]of original){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globals[name];}
 }
});

test('canvas follows the chosen render scale without exceeding the device pixel ratio',()=>{
 const globals=globalThis as unknown as Record<string,unknown>;
 const original=['window','document'].map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)] as const);
 const bounds={width:844,height:390},style={width:'',height:'',imageRendering:''};
 const scale={width:960,height:640,zoom:1,
  resize(width:number,height:number){this.width=width;this.height=height;if(this.zoom!==1){style.width=`${width*this.zoom}px`;style.height=`${height*this.zoom}px`;}},
  setZoom(zoom:number){this.zoom=zoom;style.width=`${this.width*zoom}px`;style.height=`${this.height*zoom}px`;}
 };
 try{
  globals.document={getElementById:()=>({getBoundingClientRect:()=>bounds})};
  globals.window={devicePixelRatio:3};
  const game={scale,canvas:{style,getBoundingClientRect:()=>bounds}} as unknown as import('phaser').Game;
  (game as unknown as {game:unknown}).game=game;
  // 1× 保持 CSS 尺寸；2×/3× 放大画布像素，再用 zoom 缩回 CSS 尺寸。
  configureCanvas(game,1);
  assert.deepEqual([scale.width,scale.height,scale.zoom,style.width,style.height],[844,390,1,'844px','390px']);
  configureCanvas(game,2);
  assert.deepEqual([scale.width,scale.height,scale.zoom,style.width,style.height],[1688,780,.5,'844px','390px']);
  configureCanvas(game,3);
  assert.deepEqual([scale.width,scale.height,style.width,style.height],[2532,1170,'844px','390px']);
  assert.ok(Math.abs(scale.zoom-1/3)<1e-9);
  // 档位不超过本机 DPR：2× 屏上 3× 仍按 2× 画；1× 屏上 2× 仍按 1× 画。
  scale.width=960;scale.height=640;scale.zoom=1;
  globals.window={devicePixelRatio:2};configureCanvas(game,3);
  assert.deepEqual([scale.width,scale.height,scale.zoom,style.width,style.height],[1688,780,.5,'844px','390px']);
  scale.width=960;scale.height=640;scale.zoom=1;
  globals.window={devicePixelRatio:1};configureCanvas(game,2);
  assert.deepEqual([scale.width,scale.height,scale.zoom,style.width,style.height],[844,390,1,'844px','390px']);
  // 画框尺寸变化后按当前档位重算，CSS 尺寸始终贴合画框。
  bounds.width=960;bounds.height=640;
  globals.window={devicePixelRatio:3};configureCanvas(game,2);
  assert.deepEqual([scale.width,scale.height,scale.zoom,style.width,style.height],[1920,1280,.5,'960px','640px']);
 }finally{
  for(const[name,descriptor]of original){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globals[name];}
 }
});

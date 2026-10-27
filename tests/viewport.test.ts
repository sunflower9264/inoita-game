import test from 'node:test';
import assert from 'node:assert/strict';
import {fitViewport,configureCanvas,readSafeArea} from '../src/ui/viewport.ts';

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
  assert.deepEqual([style['--safe-left'],style['--safe-right'],style['--safe-top'],style['--safe-bottom']],['59px','59px','12px','33px']);
  (globals.window as FakeWindow).visualViewport=undefined;fitViewport();
  assert.deepEqual([style.width,style.height,style.left,style.top],['932px','430px','0px','0px']);
 } finally {
  for(const [name,descriptor] of original) {
   if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globals[name];
  }
 }
});

test('iOS home-screen startup fills the screen even when visualViewport is reported short',()=>{
 const names=['window','document','getComputedStyle','innerWidth','innerHeight','navigator','CSS'];
 const globals=globalThis as unknown as Record<string, unknown>;
 const original: [string, PropertyDescriptor | undefined][]=names.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]);
 const style:FakeStyle={setProperty(name,value){this[name]=value;}};
 try {
  globals.window={visualViewport:{width:844,height:372,offsetLeft:0,offsetTop:21},innerWidth:844,innerHeight:393};
  globals.document={getElementById:(id:string)=>id==='game-frame'?{style,getBoundingClientRect:()=>({width:844,height:393})}:{}};
  globals.getComputedStyle=()=>({paddingLeft:'0px',paddingRight:'0px',paddingTop:'0px',paddingBottom:'0px'});
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{standalone:true}});
  Object.defineProperty(globalThis,'CSS',{configurable:true,value:{supports:(property:string,value:string)=>property==='height'&&value==='100lvh'}});
  fitViewport();
  assert.deepEqual([style.width,style.height,style.left,style.top],['100vw','100lvh','0px','0px'],
    '主屏模式按整屏排版，不跟随偏矮的 visualViewport');
  assert.equal(parseFloat(String(style['--story-unit'])),Math.min(844/800,393/480));
  (globals.CSS as {supports:()=>boolean}).supports=()=>false;fitViewport();
  assert.equal(style.height,'100vh','不支持 lvh 的旧 WebKit 退回大视口 vh');
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
  const measured=reads;
  assert.deepEqual(readSafeArea(),{left:47,right:47,top:0,bottom:21});
  readSafeArea();
  assert.equal(reads,measured,'视口没变时不再读计算样式');
  fitViewport();
  assert.equal(reads,measured+1,'视口重建后重新测量');
 }finally{
  for(const[name,descriptor]of original){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globals[name];}
 }
});

test('canvas keeps CSS size and pointer scale after returning to density one and resizing again',()=>{
 const globals=globalThis as unknown as Record<string,unknown>;
 const original=['window','document'].map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)] as const);
 const bounds={width:844,height:390},style={width:'',height:'',imageRendering:''};
 const scale={width:960,height:640,zoom:1,
  resize(width:number,height:number){this.width=width;this.height=height;if(this.zoom!==1){style.width=`${width*this.zoom}px`;style.height=`${height*this.zoom}px`;}},
  setZoom(zoom:number){this.zoom=zoom;style.width=`${this.width*zoom}px`;style.height=`${this.height*zoom}px`;}
 };
 try{
  globals.document={getElementById:()=>({getBoundingClientRect:()=>bounds})};
  globals.window={devicePixelRatio:2};
  const game={scale,canvas:{style}} as unknown as import('phaser').Game;
  configureCanvas(game);
  assert.deepEqual([scale.width,scale.height,style.width,style.height],[1688,780,'844px','390px']);
  globals.window={devicePixelRatio:1};bounds.width=960;bounds.height=640;configureCanvas(game);
  assert.deepEqual([scale.width,scale.height,style.width,style.height],[960,640,'960px','640px']);
  bounds.width=1280;bounds.height=720;configureCanvas(game);
  assert.deepEqual([scale.width,scale.height,style.width,style.height],[1280,720,'1280px','720px']);
 }finally{
  for(const[name,descriptor]of original){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globals[name];}
 }
});

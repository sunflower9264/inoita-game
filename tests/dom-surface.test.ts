import assert from 'node:assert/strict';
import test, {after} from 'node:test';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import type Phaser from 'phaser';
import { UiNode, UiImage, uiMount } from '../src/ui/dom/node.ts';
import { QuestPopup } from '../src/ui/phaser/quest-popup.ts';
import type { GameUI } from '../src/ui/game-ui.ts';
import { UiSurface } from '../src/ui/dom/surface.ts';
import { LiveCharacterPreview } from '../src/ui/phaser/live-character-preview.ts';
import { characterAtlasPageKeys } from '../src/rendering/character-atlas.ts';
import { domAssets } from '../src/ui/dom/assets.ts';
import { SceneUiAssets } from '../src/ui/phaser/ui-asset-host.ts';
import type { ActorDefinition } from '../src/domain/content.ts';
import { installMenuDom, domEvent, domWindow, MenuElement } from './support/menu-dom.ts';

after(installMenuDom());
function fixture(density=1) {
  const events=new EventEmitter(), scale=Object.assign(new EventEmitter(),{width:1024*density,height:640*density});
  const scene={events,scale,game:{events:new EventEmitter(),canvas:{getBoundingClientRect:()=>({left:0,top:0,width:1024,height:640})}}} as unknown as Phaser.Scene;
  const surface=new UiSurface(scene,1024,640);
  const pointer={id:1,x:30,y:30,isDown:true};
  const send=(node:UiNode,name:string,x=30,y=30,down=name!=='pointerup'&&name!=='pointercancel')=>domEvent(node.element,name,Object.assign(pointer,{x,y,isDown:down}));
  return {scene,surface,pointer,send,cleanup:()=>{surface.destroy();events.emit('shutdown');}};
}

test('DOM buttons reject guarded input, cancel captures on hide and blur, and keep static keyboard navigation',t=>{
  const f=fixture();t.after(f.cleanup);let calls=0,enabled=false;
  const button=f.surface.button('',10,10,80,40,()=>calls++,{bare:true,guard:()=>enabled});
  f.send(button,'pointerdown');f.send(button,'pointerup');assert.equal(calls,0);
  enabled=true;f.send(button,'pointerdown');assert(button.element.hasPointerCapture(1));
  f.surface.visible(false);assert(!button.element.hasPointerCapture(1));
  f.surface.visible(true);f.send(button,'pointerup');assert.equal(calls,0);
  f.send(button,'pointerdown');domWindow.dispatchEvent(new Event('blur'));f.send(button,'pointerup');assert.equal(calls,0);
  f.send(button,'pointerdown');f.scene.events.emit('pause');assert(!button.element.hasPointerCapture(1));
  f.scene.events.emit('resume');f.send(button,'pointerup');assert.equal(calls,0);
  f.send(button,'pointerdown');f.send(button,'pointerup');assert.equal(calls,1);
  f.surface.staticLayer('tabs',()=>f.surface.button('',0,0,20,20,()=>calls++,{bare:true,parent:f.surface.staticRoot}));
  f.surface.clear();
  f.surface.key({key:'Tab',preventDefault(){}} as KeyboardEvent);f.surface.key({key:'Enter',preventDefault(){}} as KeyboardEvent);
  assert.equal(calls,2,'重绘正文后静态页签仍能用键盘操作');
});

test('scrolling at 3x sampling cancels nested button holds, suppresses release clicks and accepts the next tap',t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture(3);t.after(f.cleanup);let calls=0;
  const scroll=f.surface.scroll(0,0,200,200);scroll.setHeight(1000);
  const group=f.surface.container(0,0,scroll.content);
  const button=f.surface.button('',10,10,80,40,()=>calls++,{bare:true,parent:group,guard:scroll.guard,hold:{delayMs:350,intervalMs:80}});
  f.send(button,'pointerdown');f.send(button,'pointermove',30,10);t.mock.timers.tick(500);f.send(button,'pointerup',30,10);
  assert.equal(calls,0);assert(scroll.scrollTop>0);assert(!button.element.hasPointerCapture(1));
  f.send(button,'pointerdown');f.send(button,'pointerup');assert.equal(calls,1);
  f.send(button,'pointerdown');t.mock.timers.tick(350);assert.equal(calls,2);
  domWindow.dispatchEvent(new Event('blur'));t.mock.timers.tick(500);assert.equal(calls,2);
});

test('nested menu scrolls apply scene coordinates once to content and scrollbars',t=>{
  const f=fixture();t.after(f.cleanup);
  const body=new UiSurface(f.scene,960,431,200);f.surface.root.add(body.root);
  f.surface.root.setPosition(20,30).setScale(.5);body.root.setPosition(32,140);
  const scroll=body.scroll(10,20,200,100);scroll.setHeight(500);
  assert.equal(scroll.layer.element.parentElement,body.mount,'滚动层直接挂到场景坐标层');
  assert.equal(scroll.layer.element.parentElement,f.surface.root.element.parentElement);
  assert.deepEqual([scroll.layer.x,scroll.layer.y,scroll.layer.scaleX],[41,110,.5]);
  const parts=(body.mount as unknown as MenuElement).children;
  const bars=parts.filter(node=>['202','203'].includes(node.style.zIndex));
  assert.equal(bars.length,2);assert(bars.every(node=>node.style.left==='138.5px'),'轨道和滑块也使用同一次坐标换算');
  f.surface.root.setPosition(40,50).setScale(.75);scroll.layout();
  assert.deepEqual([scroll.layer.x,scroll.layer.y,scroll.layer.scaleX],[71.5,170,.75]);
  body.destroy();
});

test('DOM drag hit guards at 3x sampling use centered local geometry and cancellation releases capture',t=>{
  const f=fixture(3);t.after(f.cleanup);let enabled=false,starts=0,ends=0;
  const node=f.surface.container(100,100).setSize(80,60).setInteractive({x:-40,y:-30,width:80,height:60},()=>enabled).draggable();
  node.on('dragstart',()=>starts++).on('dragend',()=>ends++);
  f.send(node,'pointerdown',130,120);assert.equal(starts,0);
  enabled=true;f.send(node,'pointerdown',130,120);assert.equal(starts,1);
  f.send(node,'pointercancel',130,120);assert(!node.element.hasPointerCapture(1));f.send(node,'pointerup',130,120);assert.equal(ends,0);
  f.send(node,'pointerdown',145,120);assert.equal(starts,1,'矩形外侧不能开始拖动');
});

test('volume dragging at 3x sampling updates its value and stops when cancelled or covered',t=>{
  const f=fixture(3);t.after(f.cleanup);const values:number[]=[];
  const slider=f.surface.slider('music',50,50,100,.5,value=>values.push(value));
  const zone=slider.root.list.find(node=>node.input)!;
  f.send(zone,'pointerdown',75,50);f.send(zone,'pointermove',125,50);
  assert.deepEqual(values,[.25,.75]);
  f.send(zone,'pointercancel',125,50);f.send(zone,'pointermove',140,50);assert.equal(slider.value,.75);
  f.surface.enabled=()=>false;f.send(zone,'pointerdown',90,50);assert.equal(slider.value,.75);
  f.surface.enabled=()=>true;f.send(zone,'pointerdown',90,50);assert.equal(slider.value,.4);
  f.surface.visible(false);f.send(zone,'pointermove',130,50);assert.equal(slider.value,.4);
});

test('image size is available before loading and flipping preserves the outer anchor',t=>{
  const f=fixture();t.after(f.cleanup);
  const image=new UiImage(f.scene,f.surface.root).resize(240,38).setOrigin(0,1);
  assert.deepEqual([image.width,image.height],[240,38]);
  image.applySource({url:'source.png',width:400,height:200,frame:{x:40,y:30,width:120,height:19}}).setFlipY(true);
  assert.equal(image.element.style.transformOrigin,'0 0');
  assert(image.element.style.transform.includes('translate(0%,-100%)'));
  const picture=(image.element as unknown as MenuElement).children[0];assert.equal(picture.style.transform,'scale(1,-1)');
  const sourceWidth=picture.style.width;
  image.setCrop(0,0,120,38);
  assert.equal(image.width,240);assert.equal(picture.style.width,sourceWidth,'资源条裁边时保持原图倍率');
  assert.equal(image.element.style.clipPath,'inset(0px 120px 0px 0px)');
});

test('contained atlas images keep their proportions and remain inside the preview box',t=>{
  const f=fixture();t.after(f.cleanup);
  const image=new UiImage(f.scene,f.surface.root).resize(100,100).fitting(.5,.5,'contain');
  image.applySource({url:'atlas.png',width:400,height:200,frame:{x:40,y:30,width:100,height:50}});
  const picture=(image.element as unknown as MenuElement).children[0];
  assert.deepEqual([picture.style.width,picture.style.height,picture.style.left,picture.style.top],['400px','200px','-40px','-5px']);
  assert.equal(picture.style.clipPath,'inset(30px 260px 120px 40px)','留白不能露出图集里的相邻图片');
  image.fitting(.5,.5,'cover');
  assert.deepEqual([picture.style.width,picture.style.height,picture.style.left,picture.style.top],['800px','400px','-130px','-60px']);
});

test('a reused menu image hides the previous picture when the next load fails',async t=>{
  const f=fixture();t.after(f.cleanup);
  t.mock.method(console,'error',()=>{});
  let fail=false;
  t.mock.method(domAssets,'acquire',async()=>{
    if(fail)throw new Error('load failed');
    return {source:{url:'/assets/first.png',width:10,height:10,frame:{x:0,y:0,width:10,height:10}},release(){}};
  });
  const image=new UiImage(f.scene,f.surface.root).load('first.png');
  await new Promise(resolve=>setTimeout(resolve,0));
  const picture=(image.element as unknown as MenuElement).children[0];
  assert.equal(picture.hidden,false);assert.ok(picture.src.includes('first.png'));
  fail=true;image.load('broken.png');
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(picture.hidden,true,'加载失败不能继续显示上一张图');
  image.destroy();
});

test('live character previews follow character atlas pages instead of stale spritesheets',()=>{
  const battle=JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')) as {
    classes:{actor:{clips:Record<string,{frames:number;layers:{key:string;file?:string}[]}>}}[]
  };
  const actor=battle.classes[0]!.actor;
  const layer=actor.clips['idle-south']!.layers[0]!;
  const pages=characterAtlasPageKeys(layer.file);
  assert.ok(pages.length>0);
  const available=(exists:(key:string)=>boolean)=>LiveCharacterPreview.available(
    {add:{},textures:{exists}} as unknown as Phaser.Scene,actor as never);
  assert.equal(available(key=>pages.includes(key)),true);
  assert.equal(available(key=>key!==pages[0]),false,'缺一页也不能退回静态外观');
  assert.equal(available(key=>key===layer.key),false,'旧单文件纹理存在不代表图集可用');
});

test('live character preview reuses the visual and tracks menu layout and visibility',t=>{
  const f=fixture();t.after(f.cleanup);
  const box={setOrigin(){return this;},setScrollFactor(){return this;},setDepth(){return this;},setVisible(_v:boolean){return this;},setPosition(_x:number,_y:number){return this;},setSize(_w:number,_h:number){return this;},destroy(){}};
  let backgrounds=0;
  Object.assign(f.scene,{textures:{exists:()=>true},add:{rectangle:()=>{backgrounds++;return box;}}});
  const actor={id:'hero',clips:{'idle-south':{frameWidth:40,frameHeight:80,originX:.5,originY:1,mirrorX:false,layers:[{key:'outfit'}]}}} as unknown as ActorDefinition;
  const state={created:0,destroyed:0,x:0,y:0,scale:0,visible:false};
  const container={setDepth(){return this;},setScrollFactor(){return this;},setVisible(v:boolean){state.visible=v;return this;},setScale(v:number){state.scale=v;return this;},setPosition(x:number,y:number){state.x=x;state.y=y;return this;},destroy(){state.destroyed++;}};
  let hole:unknown;
  const preview=new LiveCharacterPreview(f.scene,value=>hole=value,actor=>{state.created++;return {actor,container} as never;});
  preview.show(f.surface,actor,{x:0,y:0,width:80,height:160});
  assert.deepEqual([state.x,state.y,state.scale],[40,160,2]);assert.equal(state.created,1);
  assert.deepEqual(hole,{x:0,y:0,width:80,height:160});
  preview.show(f.surface,actor,{x:100,y:50,width:40,height:80});assert.equal(state.created,1);
  assert.deepEqual([state.x,state.y,state.scale],[120,130,1]);
  for(const density of [2,2.625,3,1]){
    Object.assign(f.scene.scale,{width:1024*density,height:640*density});preview.layout();
    assert.deepEqual([state.x,state.y,state.scale],[120*density,130*density,density],'只有画布角色随采样倍率换算');
    assert.deepEqual(hole,{x:100,y:50,width:40,height:80},'DOM 遮罩为角色留下的区域保持屏幕尺寸');
  }
  preview.visible(false);assert.equal(state.visible,false);assert.equal(hole,undefined);
  preview.visible(true);assert.equal(state.visible,true);preview.destroy();assert.equal(state.destroyed,1);
  const classPreview=new LiveCharacterPreview(f.scene,()=>{},actor=>{state.created++;return {actor,container} as never;},null);
  classPreview.show(f.surface,actor,{x:0,y:0,width:80,height:160});
  assert.equal(backgrounds,1,'职业角色直接显示在场景背景上');
  classPreview.show(f.surface,{...actor,id:'other'}, {x:0,y:0,width:80,height:160});
  assert.equal(state.destroyed,2,'切换职业释放上一个角色');classPreview.destroy();assert.equal(state.destroyed,3);
});

test('menu preloads share caller cancellation and release the retained DOM images',async t=>{
  const f=fixture();t.after(f.cleanup);const request=new AbortController();let signal:AbortSignal|undefined,released=0;
  t.mock.method(domAssets,'preloadFiles',async(_files:readonly string[],input:AbortSignal)=>{signal=input;input.throwIfAborted();return {release:()=>released++};});
  const host=new SceneUiAssets(f.scene);await host.preloadFiles(['portrait.png'],request.signal,()=>{});
  assert.equal(signal,request.signal);host.releaseContent();host.releaseContent();assert.equal(released,1);
  request.abort();await assert.rejects(host.preloadFiles(['portrait.png'],request.signal,()=>{}),{name:'AbortError'});
});

test('resident menu images survive content release and are loaded once',async t=>{
  const f=fixture();t.after(f.cleanup);let calls=0,releases=0;
  t.mock.method(domAssets,'preloadFiles',async()=>{calls+=1;return {release:()=>releases++};});
  const host=new SceneUiAssets(f.scene),signal=new AbortController().signal;
  await host.preloadResident(['menu-frame.png'],signal,()=>{});
  await host.preloadResident(['/menu-frame.png'],signal,()=>{});
  assert.equal(calls,1,'同一张常驻图只加载一次');
  host.releaseContent();assert.equal(releases,0,'关闭本局内容不释放常驻图');
  host.releaseResident();host.releaseResident();assert.equal(releases,1,'场景销毁才释放常驻图');
});


test('quest confirmation stays above the input blocker and accepts one tap',t=>{
  const f=fixture();t.after(f.cleanup);
  const blocker=new UiNode(f.scene,uiMount(f.scene,'overlay')).setSize(1024,640).setDepth(999).setInteractive();
  const popup=new QuestPopup(f.scene,()=>true);t.after(()=>{popup.destroy();blocker.destroy();});
  let confirmed=0;
  const quest={kind:'start',definition:{title:'任务',description:'任务内容'},confirm:()=>{confirmed++;}} as unknown as NonNullable<GameUI['quest']>;
  popup.sync(quest,{'quest-popup-window':'','quest-popup-rule':''},id=>id);
  assert.equal(popup.surface.mount,blocker.element.parentElement,'任务窗和输入遮挡处于同一层');
  assert.equal(popup.surface.mount.parentElement?.id,'ui-overlay');
  assert(Number(popup.surface.root.element.style.zIndex)>Number(blocker.element.style.zIndex),'确认按钮位于遮挡上方');
  const button=popup.surface.root.list.find(node=>node.getData('uiAction'))!;
  const point=button.getWorldTransformMatrix();
  const x=point.tx+button.width*point.scaleX/2,y=point.ty+button.height*point.scaleY/2;
  f.send(button,'pointerdown',x,y);f.send(button,'pointerup',x,y);
  assert.equal(confirmed,1);
  popup.sync(undefined,{},id=>id);
  f.send(button,'pointerdown',x,y);f.send(button,'pointerup',x,y);
  assert.equal(confirmed,1,'关闭后不会再次确认');
});

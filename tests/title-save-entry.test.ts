import assert from 'node:assert/strict';
import test, {after} from 'node:test';
import {registerHooks} from 'node:module';
import {SaveSlots,SAVE_FORMAT,type SaveSlotRef} from '../src/domain/save-game.ts';
import type {MenuContext} from '../src/application/ports.ts';
import type {StoryWorldViewSnapshot} from '../src/scenes/world-scene.ts';
import type {CloudSaveEntry,CloudSavePort,CloudSession} from '../src/application/cloud-save.ts';
import {CLOUD_PAGE} from '../src/ui/cloud-save-layout.ts';
import {InputRouter} from '../src/application/input-router.ts';
import {MenuTextLayer,type MenuTextOcclude,type MenuTextSpec} from '../src/ui/dom/menu-text.ts';
import type {DomUi} from '../src/ui/dom/dom-ui.ts';
import {installMenuDom,menuFrame} from './support/menu-dom.ts';
after(installMenuDom());
menuFrame.width=1200;
const hook=registerHooks({resolve(specifier,context,next){return specifier==='phaser'?{url:'data:text/javascript,export default {Scene:class{},BlendModes:{}}',shortCircuit:true}:next(specifier,context);}});
const {MenuScene}=await import('../src/scenes/menu-scene.ts');
const {UiSurface}=await import('../src/ui/phaser/widgets.ts');hook.deregister();
class Button {
  readonly active=true;readonly visible=true;readonly shown=true;readonly input:{enabled:boolean};
  x=0;y=0;width=0;height=0;
  private readonly data=new Map<string,unknown>();
  constructor(label:string,action:()=>void,disabled=false){this.input={enabled:!disabled};this.data.set('label',label);this.data.set('action',action);this.data.set('setEnabled',(value:boolean)=>{this.input.enabled=value;});}
  setData(key:string,value:unknown){this.data.set(key,value);return this;}
  getData(key:string){return this.data.get(key);}
}
interface TextNode { value:string; x:number; y:number; size:number; origin:[number,number]; handlers:Map<string,()=>void> }
/** 标题页的滚动区替身：只记录滚动窗口和内容高度，拖动行为由 ScrollArea 自己的用例覆盖。 */
interface FakeScroll {
  x:number;y:number;width:number;height:number;extent:number;scrollTop:number;
  content:{list:unknown[];add():void;remove():void;removeAll():void};
  setHeight(value:number):void;layout():void;destroy():void;onScroll?:()=>void;
}
class FakeDomLabel {
  text='';x=0;y=0;visible=true;removed=false;
  anchor=[0,0];
  readonly style:Record<string,unknown>={};
  element:{remove:()=>void;parentElement?:unknown}={remove:()=>{}};
  setText(value:string){this.text=value;return this;}
  setPosition(x:number,y:number){this.x=x;this.y=y;return this;}
  setAnchor(x:number,y:number){this.anchor=[x,y];return this;}
  setVisible(value:boolean){this.visible=value;return this;}
  setStyle(value:Partial<CSSStyleDeclaration>){Object.assign(this.style,value);return this;}
  remove(){this.removed=true;}
}

/** 标题页的菜单画布与删除确认画布共用这一份替身，只有尺寸与 `scene` 相同。 */
function fakeView(width:number,height:number){
  /** 图片只被链式调用，不需要真的画出来。 */
  const stub=()=>{const value:Record<string,()=>unknown>={};for(const name of ['setOrigin','setFlipY','setDisplaySize','setAlpha','setScale','setPosition'])value[name]=()=>value;return value;};
  const zones:{handlers:Map<string,()=>void>}[]=[];
  return {
    width,height,
    mount:{appendChild(element:{parentElement?:unknown}){element.parentElement=this;}},
    root:{width,height,visible:true,shown:true,bringToTop:()=>{},setSize:function(width:number,height:number){this.width=width;this.height=height;return this;},setPosition:function(){return this;},setScale:function(){return this;},add:()=>{},getWorldTransformMatrix:()=>({scaleX:1,scaleY:1,transformPoint:(x:number,y:number)=>({x,y})})},
    buttons:[] as Button[],texts:[] as string[],textNodes:[] as TextNode[],scrolls:[] as FakeScroll[],zones,
    sliders:[] as {label:string;value:number;setValue:(value:number)=>void}[],enabled:()=>true,focusIndex:-1,
    scene:{game:{events:{emit:()=>{}}},scale:{width,height},add:{zone:()=>{const handlers=new Map<string,()=>void>();const zone={handlers,setOrigin(){return zone;},setInteractive(){return zone;},on(event:string,handler:()=>void){handlers.set(event,handler);return zone;}};zones.push(zone);return zone;}}},focus:()=>{},layout:()=>{},image:stub,
    text(value:string,x:number,y:number,_width:number,size:number){
      this.texts.push(value);
      const node:TextNode={value,x,y,size,origin:[0,0],handlers:new Map()};this.textNodes.push(node);
      const lines=_width>0?Math.max(1,Math.ceil(Array.from(value).length*size*.55/_width)):1;
      const label={height:lines*(size+5)-5,setOrigin:(originX:number,originY:number)=>{node.origin=[originX,originY];return label;},
        setPosition:(nextX:number,nextY:number)=>{node.x=nextX;node.y=nextY;return label;},
        setAlign:()=>label,destroy:()=>{},
        setInteractive:()=>label,on:(event:string,handler:()=>void)=>{node.handlers.set(event,handler);return label;}};
      return label;
    },rect(){const handlers=new Map<string,()=>void>();const zone={handlers,setInteractive(){return zone;},on(event:string,handler:()=>void){handlers.set(event,handler);return zone;}};zones.push(zone);return zone;},
    border(){},frame(){},
    clear(){this.buttons=[];this.texts=[];this.scrolls=[];this.sliders=[];this.focusIndex=-1;},
    slider(label:string,_x:number,_y:number,_width:number,value:number,onChange:(value:number)=>void){
      const slider={label,value,setValue:(next:number)=>{slider.value=next;onChange(next);}};
      this.sliders.push(slider);return slider;
    },
    button(label:string,x:number,y:number,width:number,height:number,action:()=>void,options:{disabled?:boolean}={}){
      const button=new Button(label,action,options.disabled);
      Object.assign(button,{x,y,width,height});this.buttons.push(button);return button;
    },
    key(event:KeyboardEvent){UiSurface.prototype.key.call(this as unknown as InstanceType<typeof UiSurface>,event);},
    focusables(){return UiSurface.prototype.focusables.call(this as unknown as InstanceType<typeof UiSurface>);},
    scroll(x:number,y:number,width:number,height:number){
      const content={ list:[] as unknown[], add(){}, remove(){}, removeAll(){} };
      const value:FakeScroll={x,y,width,height,extent:0,scrollTop:0,content,setHeight(extent:number){value.extent=extent;},layout(){},destroy(){}};
      this.scrolls.push(value);return value;
    },
  };
}
function fixture(gmMode?:MenuContext['gmMode'],cloud?:CloudSavePort){
  const entries=new Map<string,string>(),events:string[]=[],signals:AbortSignal[]=[];
  const saves=new SaveSlots<StoryWorldViewSnapshot>({getItem:key=>entries.get(key)??null,setItem:(key,value)=>{entries.set(key,value);},removeItem:key=>{entries.delete(key);}});
  const domLabels:FakeDomLabel[]=[];
  const domUi={label:()=>{const label=new FakeDomLabel();domLabels.push(label);return label;}};
  const app:MenuContext={inputRouter:new InputRouter({textInputFocused:()=>false}),saves,gmMode,cloud,ui:{ready:true,suspended:false,setMode:()=>{},loading:()=>{},menuLoaded:()=>{},error:()=>{}},
    loadChangelog:async()=>({version:2,releases:[]}),
    enterGame:async()=>{events.push('new');},resumeSlot:async(slot,signal)=>{events.push(`load:${slot}`);if(signal)signals.push(signal);}};
  Object.defineProperty(app,'domUi',{value:domUi});
  const view=fakeView(1200,640),modal=fakeView(1024,640);
  // 直接借用 MenuScene.prototype 的假场景不会跑字段初始化；这里补上新加的私有状态，
  // 尤其是 cloudSerial（`++undefined` 会变成 NaN，后续请求代次比较全部失败）。
  const state={app,surface:view,modal,page:'home',cloudSerial:0,cloudBusy:false,cloudAccountInput:'',cloudPassword:'',
    // 场景缩放通知与屏幕布局分别提供。
    scale:{width:1200,height:640,zoom:1,on(){},off(){}},
    cloudStatus:undefined,cloudCount:undefined,cloudRequest:undefined,cloudRenderedBranch:undefined,cloudControls:[],confirmAction:undefined,confirmResolve:undefined,
    slotRows:new Map(),renameRef:undefined,renameSerial:0,slotRequest:undefined,slotPortraits:undefined,prompt:undefined,settingsScroll:0,backdrop:undefined,
    challengeClicks:0,challengeTimer:undefined,
    domSpecs:[] as MenuTextSpec[],menuText:undefined as MenuTextLayer|undefined,changelogBackgroundText:undefined as MenuTextLayer|undefined,modalLabels:[] as FakeDomLabel[],
    changelogVersionButtons:[] as Button[],changelogOpen:false,changelogState:'idle',changelogReleases:[] as {gameVersion:string;entries:string[]}[],changelogSelected:0,
    changelogVersionsScroll:undefined as FakeScroll|undefined,changelogVersionsScrollTop:0,changelogEntries:[] as string[],changelogHeights:[] as number[],
    changelogOffsets:[] as number[],changelogSpecs:[] as MenuTextSpec[],changelogScroll:undefined as FakeScroll|undefined,
    changelogScrollTop:0,changelogRequest:undefined as AbortController|undefined,changelogError:'',
    sys:{isActive:()=>true},textures:{exists:()=>true}};
  const scene=Object.setPrototypeOf(state,MenuScene.prototype);
  const call=(name:string,...args:unknown[])=>Reflect.get(MenuScene.prototype,name).call(scene,...args);
  const menuText=new MenuTextLayer(domUi as unknown as Pick<DomUi,'label'>,(x,y)=>({x,y,scale:1}),
    (page,scroll)=>call('menuScrollTop',page,scroll) as number|undefined);
  // 与场景注册保持一致：确认框压暗页面文字，更新日志的正文使用弹层坐标。
  for(const page of ['home','slots','settings','cloud'] as const)menuText.register(page,writer=>{
    const occlude=state.confirmAction?call('confirmOcclusion') as MenuTextOcclude|undefined:undefined;
    for(const spec of state.domSpecs)writer.add(occlude?{...spec,dim:true,occlude}:spec);
  });
  menuText.register('changelog',writer=>{
    for(const spec of state.changelogSpecs)writer.add(spec);
  });
  state.menuText=menuText;
  call('setupChangelogBackground',domUi);
  const clickIn=(surface:ReturnType<typeof fakeView>,label:string)=>{
    const node=surface.buttons.find(button=>button.getData('label')===label);
    assert.ok(node,label);assert.equal(node.input.enabled,true);(node.getData('action') as ()=>void)();
  };
  const click=(label:string)=>clickIn(view,label);
  const key=(value:string)=>view.key({key:value,preventDefault:()=>{}} as KeyboardEvent);
  call('render');
  const domTexts=()=>domLabels.filter(label=>label.visible&&!label.removed).map(label=>label.text);
  return {app,entries,events,signals,view,modal,state,call,click,clickModal:(label:string)=>clickIn(modal,label),key,saves,domLabels,domTexts};
}
const saved=(savedAt?:number)=>JSON.stringify({format:SAVE_FORMAT,summary:{...(savedAt===undefined?{}:{savedAt}),classId:'dark-knight',className:'黑暗骑士',level:1,mapId:'map',mapName:'营地',portrait:'portrait.png'},session:{},world:{location:{map:'map',x:0,y:0,facing:'south'},generatedEntities:[]}});

test('title changelog loads on demand and only renders visible entries',async()=>{
  const f=fixture();
  const entries=Array.from({length:40},(_,index)=>`第 ${index+1} 条更新说明。`.repeat(6));
  let loads=0;
  f.app.loadChangelog=async()=>{loads++;return {version:2 as const,releases:[{gameVersion:'v1.0.6',entries},{gameVersion:'v1.0.5',entries:['旧版本专属内容']},...Array.from({length:8},(_,index)=>({gameVersion:`v0.0.${index}`,entries:[]}))]};};
  f.click('更新日志');
  assert.equal(loads,1,'点按钮才加载更新日志');
  assert.ok(f.domTexts().includes('正在加载更新日志…'));
  await new Promise(resolve=>setImmediate(resolve));
  assert.ok(f.domTexts().includes('v1.0.6 更新说明'),'默认显示最新版本');
  for(const name of ['开始游戏','环境设置','挑战模式']){
    const background=f.domLabels.find(label=>label.text===name&&label.visible&&!label.removed);
    assert.ok(background,`${name} 仍在弹层后显示`);
    assert.equal(background.style.zIndex,'125','主菜单文字位于遮罩和弹层后方');
    assert.equal(background.element.parentElement,f.view.mount);
  }
  const labels=()=>f.domTexts().filter(text=>/^\d+\. 第 /.test(text));
  assert.ok(labels().some(text=>text.includes('第 1 条')),'首条可见');
  assert.ok(labels()[0]!.startsWith('1. '),'条目前带序号');
  assert.ok(labels().length>0&&labels().length<entries.length,`只渲染可视条目，实际 ${labels().length} 条`);
  const versionLabel=f.domLabels.find(label=>label.text==='v1.0.5'&&label.visible)!;
  assert.ok(versionLabel);
  const versionY=versionLabel.y;
  const scroll=f.state.changelogScroll!;
  scroll.scrollTop=scroll.extent-scroll.height;
  scroll.onScroll?.();
  assert.ok(labels().some(text=>text.includes('第 40 条')),'滚到底显示最后一条');
  assert.ok(!labels().some(text=>text.includes('第 1 条')),'滚出视口的条目不渲染');
  assert.equal(versionLabel.y,versionY,'正文滚动时左侧版本号保持原位');
  const versions=f.state.changelogVersionsScroll!;
  versions.scrollTop=68;versions.onScroll?.();
  assert.equal(versionLabel.y,versionY-68,'版本号跟随左侧列表滚动');
  assert.equal(f.state.changelogScroll?.scrollTop,scroll.extent-scroll.height,'左侧滚动不影响正文');
  const homeButton=f.view.buttons.find(button=>button.getData('label')==='开始游戏');
  const closeButton=f.modal.buttons.find(button=>button.getData('label')==='关闭更新日志');
  f.clickModal('v1.0.5');
  assert.equal(f.view.buttons.find(button=>button.getData('label')==='开始游戏'),homeButton);
  assert.equal(f.modal.buttons.find(button=>button.getData('label')==='关闭更新日志'),closeButton);
  assert.equal(f.state.changelogVersionsScroll,versions);
  assert.equal(f.state.changelogScroll,scroll);
  assert.ok(f.domTexts().includes('v1.0.5 更新说明'));
  assert.ok(f.domTexts().includes('1. 旧版本专属内容'));
  assert.equal(f.state.changelogScroll?.scrollTop,0,'切换版本后正文回到顶部');
  assert.equal(f.state.changelogVersionsScroll?.scrollTop,68,'切换版本后保留版本列表位置');
  f.clickModal('关闭更新日志');
  assert.equal(f.state.changelogOpen,false);
  assert.ok(!f.domLabels.some(label=>label.visible&&label.style.zIndex==='125'),'关闭弹窗后隐藏背景文字层');
  assert.ok(f.domTexts().includes('开始游戏'),'关闭后主菜单文字正常显示');
  assert.ok(!f.domTexts().some(text=>text.includes('第 1 条')),'关闭弹窗后日志文字撤掉');
});

test('changelog loader keeps its receiver and empty entries show the empty state',async()=>{
  const f=fixture();
  let receiver:unknown;
  f.app.loadChangelog=function(this:unknown){receiver=this;return Promise.resolve({version:2 as const,releases:[]});};
  f.click('更新日志');
  assert.ok(f.domTexts().includes('正在加载更新日志…'));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(receiver,f.app,'作为对象方法调用，this 不能丢');
  assert.ok(f.domTexts().includes('更新说明'),'空日志也保留标题');
  assert.ok(f.domTexts().includes('暂无更新日志。'),'空日志显示暂无数据');
});

test('changelog reports load errors and starts from the newest version after reopening',async()=>{
  const f=fixture();let loads=0;let releases=0;
  f.app.loadChangelog=async()=>{
    if(++loads===1)throw new Error('网络不可用');
    return {version:2,releases:[{gameVersion:'v1.0.6',entries:['最新内容']},{gameVersion:'v1.0.5',entries:[]}]};
  };
  f.app.releaseChangelog=()=>{releases++;};
  f.click('更新日志');await new Promise(resolve=>setImmediate(resolve));
  assert.ok(f.domTexts().includes('更新日志加载失败：网络不可用'));
  f.clickModal('关闭更新日志');
  f.click('更新日志');await new Promise(resolve=>setImmediate(resolve));
  f.clickModal('v1.0.5');
  assert.ok(f.domTexts().includes('暂无更新日志。'));
  f.clickModal('关闭更新日志');
  f.click('更新日志');await new Promise(resolve=>setImmediate(resolve));
  assert.ok(f.domTexts().includes('v1.0.6 更新说明'));
  assert.ok(f.domTexts().includes('1. 最新内容'));
  assert.equal(releases,2);
});

test('closing and reopening changelog ignores an earlier pending response',async()=>{
  const f=fixture();
  let resolveOld!:(value:{version:2;releases:{gameVersion:string;entries:string[]}[]})=>void;
  const old=new Promise<{version:2;releases:{gameVersion:string;entries:string[]}[]}>(resolve=>{resolveOld=resolve;});
  let calls=0;
  f.app.loadChangelog=()=>++calls===1?old:Promise.resolve({version:2,releases:[{gameVersion:'v2',entries:['新内容']}]});
  f.click('更新日志');f.clickModal('关闭更新日志');f.click('更新日志');
  await new Promise(resolve=>setImmediate(resolve));
  resolveOld({version:2,releases:[{gameVersion:'v1',entries:['过期内容']}]});
  await new Promise(resolve=>setImmediate(resolve));
  assert.ok(f.domTexts().includes('v2 更新说明'));
  assert.ok(f.domTexts().includes('1. 新内容'));
  assert.ok(!f.domTexts().includes('1. 过期内容'));
});

test('menu draws after assets finish while the scene is paused',()=>{
  const f=fixture();let active=false;
  f.state.sys.isActive=()=>active;f.view.clear();
  f.call('render');
  assert.equal(f.view.buttons.length,0,'暂停时跳过首次绘制');
  active=true;f.call('renderOnResume');
  assert.ok(f.view.buttons.some(button=>button.getData('label')==='开始游戏'),'恢复后补画标题菜单');
  f.click('开始游戏');
  assert.ok(f.view.buttons.some(button=>button.getData('label')==='云存档'),'恢复后的按钮可以操作');
});

test('start opens one auto row plus ten manual slots and an empty slot launches class selection',()=>{
  const f=fixture();f.click('开始游戏');assert.deepEqual(f.events,[]);
  // 空自动槽没有动作，所以只有返回钮、云存档入口与十个手动槽。
  assert.deepEqual(f.view.buttons.map(button=>button.getData('label')),
    ['返回主菜单','云存档',...Array.from({length:10},(_,slot)=>`存档槽 ${slot+1}`)]);
  f.click('存档槽 3');assert.deepEqual(f.events,['new']);
});

test('manual slots list newest first while keeping their slot identities',()=>{
  const f=fixture();
  f.entries.set('inotia4.story.v1.slot0',saved(100));
  f.entries.set('inotia4.story.v1.slot4',saved(400));
  f.entries.set('inotia4.story.v1.slot7',saved(250));
  f.click('开始游戏');
  const rows=f.view.buttons.map(button=>String(button.getData('label')))
    .filter(label=>/^存档槽 \d+$/.test(label));
  assert.deepEqual(rows,['存档槽 5','存档槽 8','存档槽 1','存档槽 2','存档槽 3','存档槽 4','存档槽 6','存档槽 7','存档槽 9','存档槽 10'],
    '有存档的按时间倒序，空槽按槽号排在后面');
  f.click('存档槽 5');assert.deepEqual(f.events,['load:4'],'显示位置变了，操作仍落在原槽');
});

test('mixed slots load existing saves, start empty slots and leave damaged slots unavailable',()=>{
  const f=fixture();f.entries.set('inotia4.story.v1.slot0',saved());f.entries.set('inotia4.story.v1.slot1','broken JSON');
  f.click('开始游戏');assert(!f.view.buttons.some(button=>button.getData('label')==='存档槽 2'));
  f.click('存档槽 1');f.click('存档槽 3');assert.deepEqual(f.events,['load:0','new']);
  assert.equal(f.signals[0].aborted,false);f.click('返回主菜单');assert.equal(f.signals[0].aborted,true);
});

test('title slots delete a manual save only after the native confirmation',()=>{
  const f=fixture();f.entries.set('inotia4.story.v1.slot0',saved());f.entries.set('inotia4.story.v1.slot1','broken JSON');
  f.click('开始游戏');
  // 自动槽没有管理动作；坏档只能删，不能改名。
  assert(!f.view.buttons.some(button=>String(button.getData('label')).startsWith('自动存档 ')));
  assert(f.view.buttons.some(button=>button.getData('label')==='存档槽 1 改名'));
  assert(!f.view.buttons.some(button=>button.getData('label')==='存档槽 2 改名'));
  assert(f.view.buttons.some(button=>button.getData('label')==='存档槽 2 删除'));
  const deleteButton=f.view.buttons.find(button=>button.getData('label')==='存档槽 1 删除');
  const slotsScroll=f.view.scrolls.at(-1);
  f.click('存档槽 1 删除');
  assert.equal(f.view.buttons.find(button=>button.getData('label')==='存档槽 1 删除'),deleteButton);
  assert.equal(f.view.scrolls.at(-1),slotsScroll);
  // 确认之前不动存档，底下的存档页也不接受输入。
  assert.equal(f.entries.has('inotia4.story.v1.slot0'),true);
  assert(f.domTexts().includes('删除后无法恢复，确定删除这个存档？'));
  assert(f.domLabels.some(label=>label.visible&&!label.removed&&label.style.opacity==='0.35'),
    '确认框打开时页面文字压暗而不是消失');
  assert.equal(f.view.enabled(),false,'确认框打开时存档页不接受输入');
  f.clickModal('否');
  assert.equal(f.entries.has('inotia4.story.v1.slot0'),true);
  assert.equal(f.view.enabled(),true,'取消后恢复输入');
  assert.equal(f.view.buttons.find(button=>button.getData('label')==='存档槽 1 删除'),deleteButton);
  assert.equal(f.view.scrolls.at(-1),slotsScroll);
  f.click('存档槽 1 删除');f.clickModal('是');
  assert.equal(f.entries.has('inotia4.story.v1.slot0'),false);
  assert(!f.view.buttons.some(button=>button.getData('label')==='存档槽 1 删除'),'空槽不再给出删除');
});

test('title slots rename a manual save through the system keyboard',async()=>{
  const f=fixture();f.entries.set('inotia4.story.v1.slot0',saved());
  const initials:string[]=[];
  f.app.promptText=async(initial:string)=>{initials.push(initial);return '第一章';};
  f.click('开始游戏');const slot=f.view.buttons.find(button=>button.getData('label')==='存档槽 1')!;
  const rename=f.view.buttons.find(button=>button.getData('label')==='存档槽 1 改名')!,scroll=f.view.scrolls.at(-1);f.click('存档槽 1 改名');
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(initials,[''],'改名以存档现有名字为初值');
  assert.equal(f.view.buttons.find(button=>button.getData('label')==='第一章'),slot,'行标题更新并保留按钮');
  assert.equal(f.view.buttons.find(button=>button.getData('label')==='存档槽 1 改名'),rename);assert.equal(f.view.scrolls.at(-1),scroll);
  assert(f.view.buttons.some(button=>button.getData('label')==='存档槽 1 删除'),'控件仍用固定的槽位名');
  const reading=f.saves.inspect(0);
  assert.equal(reading.kind==='ok'?reading.game.summary.name:undefined,'第一章');
  assert.equal(f.view.enabled(),true,'改名结束后恢复输入');
});

test('canceling title save rename keeps the current list',async()=>{
  const f=fixture();f.entries.set('inotia4.story.v1.slot0',saved());
  let finish!:(name:string|undefined)=>void;f.app.promptText=()=>new Promise(resolve=>{finish=resolve;});
  f.click('开始游戏');const button=f.view.buttons.find(value=>value.getData('label')==='存档槽 1 改名')!;
  f.click('存档槽 1 改名');assert.equal(f.view.enabled(),false);finish(undefined);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.view.buttons.find(value=>value.getData('label')==='存档槽 1 改名'),button);assert.equal(f.view.enabled(),true);
});

test('title save rename ignores input after leaving the save page',async()=>{
  const f=fixture();f.entries.set('inotia4.story.v1.slot0',saved());
  let finish!:(name:string|undefined)=>void;f.app.promptText=()=>new Promise(resolve=>{finish=resolve;});
  f.click('开始游戏');f.click('存档槽 1 改名');f.call('showHome');finish('迟到的名称');
  await new Promise(resolve=>setImmediate(resolve));
  const reading=f.saves.inspect(0);assert.equal(reading.kind==='ok'?reading.game.summary.name:undefined,undefined);
  assert.equal(f.state.page,'home');assert(f.view.buttons.some(button=>button.getData('label')==='开始游戏'));
});

test('the auto save sits on top of the list and a renamed manual slot shows its name',()=>{
  const f=fixture();
  f.entries.set('inotia4.story.v1.auto',saved());
  f.entries.set('inotia4.story.v1.slot0',saved().replace('"classId":"dark-knight"','"name":"第一章","classId":"dark-knight"'));
  f.click('开始游戏');
  const labels=f.view.buttons.map(button=>button.getData('label'));
  assert.equal(labels[1],'云存档','云存档入口在标题栏');
  assert.equal(labels[2],'自动存档','自动存档固定在存档列表第一位');
  assert.equal(labels[3],'第一章','手动槽显示自定义名字');
  f.click('自动存档');f.click('第一章');
  assert.deepEqual(f.events,['load:auto','load:0']);
});

test('older development saves enter the same empty-slot class flow',()=>{
  const f=fixture();f.entries.set('inotia4.story.v1.slot1',JSON.stringify({format:2}));
  f.click('开始游戏');f.click('存档槽 2');assert.deepEqual(f.events,['new']);
});

test('the previous published save format still opens as a readable slot',()=>{
  const f=fixture();f.entries.set('inotia4.story.v1.slot1',saved().replace('"format":34','"format":33'));
  f.click('开始游戏');f.click('存档槽 2');assert.deepEqual(f.events,['load:1']);
});

test('title settings keeps every row inside a scrolling panel',()=>{
  const f=fixture();f.click('环境设置');
  assert(f.domTexts().includes('背景音乐'));assert(f.domTexts().includes('音效'));
  assert(!f.domTexts().some(text=>text.includes('语言')||text.includes('简体中文')));
  assert.deepEqual(f.view.buttons.map(button=>button.getData('label')),
    ['返回主菜单','全屏：不支持']);
  assert.deepEqual(f.view.sliders.map(slider=>slider.label),['music','effects']);
  assert(f.view.sliders.every(slider=>slider.value===1),'音频默认满音量');
  // 选项挂在面板内侧的滚动区：边框不滚，行数再多也只滚动，不会画到边线上。
  const scroll=f.view.scrolls.at(-1);assert.ok(scroll);
  assert.deepEqual([scroll.x,scroll.y,scroll.width,scroll.height],[240,190,720,297]);
  const rows=f.view.buttons.filter(button=>String(button.getData('label')).includes('：'));
  assert.equal(rows.length,1);
  assert(rows.every(row=>row.y>=0&&row.y+row.height<=scroll.extent),'每一行都在滚动内容的高度内');
});

test('title fullscreen changes keep settings controls and scroll position',()=>{
  const root=document.documentElement as HTMLElement & {requestFullscreen?:()=>Promise<void>};
  const previous=root.requestFullscreen;
  root.requestFullscreen=async()=>{};
  try{
    const f=fixture();f.click('环境设置');
    const button=f.view.buttons.find(button=>button.getData('label')==='全屏：关');
    const scroll=f.view.scrolls.at(-1);
    assert.ok(button);assert.ok(scroll);
    Object.defineProperty(document,'fullscreenElement',{configurable:true,value:root});
    f.call('syncFullscreenSetting');
    assert.equal(f.view.buttons.find(item=>item.getData('label')==='全屏：开'),button);
    assert.equal(f.view.scrolls.at(-1),scroll);
    assert.ok(f.domTexts().includes('开'));
  }finally{
    if(previous)root.requestFullscreen=previous;else Reflect.deleteProperty(root,'requestFullscreen');
    Reflect.deleteProperty(document,'fullscreenElement');
  }
});

test('title settings leaves critical light effects to the in-game settings',()=>{
  const f=fixture();f.click('环境设置');
  assert(!f.view.buttons.some(button=>String(button.getData('label')).startsWith('暴击光效')));
});

test('title settings uses volume sliders and leftmost means silence',()=>{
  const f=fixture();
  const audio={settings:{music:1,effects:1},setVolume(channel:'music'|'effects',value:number){this.settings[channel]=value;}};
  Object.defineProperty(f.app,'audio',{value:audio});
  f.click('环境设置');
  const music=f.view.sliders.find(slider=>slider.label==='music')!;
  const effects=f.view.sliders.find(slider=>slider.label==='effects')!;
  music.setValue(0);effects.setValue(.5);
  assert.equal(audio.settings.music,0,'最左边是静音');
  assert.equal(audio.settings.effects,.5);
  assert.equal(music.value,0);
});

test('challenge mode is disabled and is excluded from native keyboard focus',()=>{
  const f=fixture(),challenge=f.view.buttons.find(button=>button.getData('label')==='挑战模式');assert.ok(challenge);assert.equal(challenge.input.enabled,false);
  const focus=UiSurface.prototype.focusables.call(f.view as unknown as InstanceType<typeof UiSurface>);
  assert.deepEqual(focus.map(button=>button.getData('label')),['开始游戏','环境设置','更新日志']);
  f.key('Tab');f.key('Enter');assert.deepEqual(f.events,[]);assert(f.view.buttons.some(button=>button.getData('label')==='存档槽 1'));
});

test('challenge mode needs five hidden clicks before starting the pressure test',()=>{
  const f=fixture();let starts=0;
  f.app.startPressureTest=async()=>{starts++;};
  const click=()=>{const handler=f.view.zones[0]!.handlers.get('pointerdown');assert.ok(handler);handler();};
  for(let index=0;index<4;index++)click();
  assert.equal(starts,0,'前四次只计数');
  click();
  assert.equal(starts,1,'第五次点击才进入压测');
  click();
  assert.equal(starts,1,'触发后计数归零，不会连续进入');
});

test('the version number sits bottom-right at menu-button size and toggles GM',()=>{
  const gm={on:false,toggles:0,toggle(){this.on=!this.on;this.toggles+=1;return this.on;}};
  const f=fixture(gm);
  const node=f.domLabels.find(text=>text.text==='v1.0.6');assert.ok(node);
  assert.equal(Number.parseFloat(String(node.style.fontSize)),36,'版本号与主菜单按钮同字号');
  assert.deepEqual(node.anchor,[1,1],'以右下角为锚点');
  assert.equal(node.x,1180);assert.equal(node.y,612);
  const notice=f.domLabels.find(text=>text.text.includes('同人作品'));assert.ok(notice,'版本号下方有同人作品说明');
  assert.equal(Number.parseFloat(String(notice.style.fontSize)),14);
  assert.deepEqual(notice.anchor,[1,1]);
  assert.equal(notice.x,1180);assert.ok(notice.y>612,'说明在版本号下方');
  assert.equal(gm.toggles,0);

  f.view.zones.at(-1)!.handlers.get('pointerdown')!();
  assert.equal(gm.toggles,1);assert.equal(gm.on,true);
  assert.ok(f.domTexts().includes('调试：开'),'打开后左下角出现状态指示');

  f.view.zones.at(-1)!.handlers.get('pointerdown')!();
  assert.equal(gm.on,false);
  assert.ok(!f.domTexts().includes('调试：开'));
});

test('a rejected title load returns to usable slots after dismissing the loading error',async t=>{
  t.mock.method(console,'error',()=>{});
  const f=fixture();let retry:(()=>void)|undefined;
  f.app.resumeSlot=async()=>{throw new Error('存档内容无效');};
  const ui=f.app.ui as {ready:boolean;menuLoaded:()=>void;error:(message:string,retry:()=>void)=>void};
  ui.error=(message,again)=>{assert.equal(message,'存档内容无效');ui.ready=false;retry=again;};
  ui.menuLoaded=()=>{ui.ready=true;};
  f.entries.set('inotia4.story.v1.slot0',saved());f.click('开始游戏');f.click('存档槽 1');
  await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(ui.ready,false);assert.ok(retry);
  retry();assert.equal(ui.ready,true);assert.equal(f.view.enabled(),true);
  f.click('存档槽 2');assert.deepEqual(f.events,['new']);
});

const settle=async()=>{for(let index=0;index<12;index+=1)await new Promise(resolve=>setImmediate(resolve));};
const cloudEntry=(slot:SaveSlotRef):CloudSaveEntry=>({
  slot,format:SAVE_FORMAT,bytes:100,updatedAt:1,
  summary:{classId:'dark-knight',className:'黑暗骑士',portrait:'portrait.png',level:1,mapId:'map',mapName:'营地'},
});
interface CloudStubOptions {
  loggedIn?:boolean;
  account?:string;
  expiresAt?:number;
  absoluteExpiresAt?:number;
  entries?:CloudSaveEntry[];
  login?:CloudSavePort['login'];
  changePassword?:CloudSavePort['changePassword'];
  refresh?:CloudSavePort['refresh'];
  list?:CloudSavePort['list'];
  upload?:CloudSavePort['upload'];
  download?:CloudSavePort['download'];
}
interface CloudHarness {port:CloudSavePort;calls:string[];uploads:{slot:SaveSlotRef;game:unknown}[];downloads:SaveSlotRef[]}
function cloudStub(options:CloudStubOptions={}):CloudHarness {
  const state={
    loggedIn:options.loggedIn??false,
    account:options.account??(options.loggedIn?'hero':undefined),
    expiresAt:options.expiresAt,
    absoluteExpiresAt:options.absoluteExpiresAt,
  };
  let entries=options.entries??[];
  const calls:string[]=[],uploads:{slot:SaveSlotRef;game:unknown}[]=[],downloads:SaveSlotRef[]=[];
  const port:CloudSavePort={
    get loggedIn(){return state.loggedIn;},
    get account(){return state.account;},
    get expiresAt(){return state.expiresAt;},
    get absoluteExpiresAt(){return state.absoluteExpiresAt;},
    login:async(account,password)=>{
      calls.push('login');
      if(options.login)return options.login(account,password);
      state.loggedIn=true;state.account=account;
      const session:CloudSession={account,token:`token-${account}`,expiresAt:1};
      return {ok:true,value:session};
    },
    register:async(account)=>{
      calls.push('register');
      state.loggedIn=true;state.account=account;
      const session:CloudSession={account,token:`token-${account}`,expiresAt:1};
      return {ok:true,value:session};
    },
    changePassword:async(currentPassword,newPassword)=>{
      calls.push('change-password');
      if(options.changePassword)return options.changePassword(currentPassword,newPassword);
      state.loggedIn=true;
      const session:CloudSession={account:state.account??'hero',token:'new-token',expiresAt:2};
      return {ok:true,value:session};
    },
    refresh:async()=>{
      calls.push('refresh');
      if(options.refresh)return options.refresh();
      const expiresAt=Date.now()+30*24*60*60*1000;
      const absoluteExpiresAt=Date.now()+90*24*60*60*1000;
      state.expiresAt=expiresAt;state.absoluteExpiresAt=absoluteExpiresAt;
      const session:CloudSession={account:state.account??'hero',token:'renewed-token',expiresAt,absoluteExpiresAt};
      return {ok:true,value:session};
    },
    logout:async()=>{calls.push('logout');state.loggedIn=false;state.account=undefined;return {ok:true,value:undefined};},
    list:async()=>{calls.push('list');if(options.list)return options.list();return {ok:true,value:entries};},
    upload:async(slot,game)=>{
      calls.push(`upload:${slot}`);uploads.push({slot,game});
      if(options.upload)return options.upload(slot,game);
      return {ok:true,value:cloudEntry(slot)};
    },
    download:async(slot)=>{
      calls.push(`download:${slot}`);downloads.push(slot);
      if(options.download)return options.download(slot);
      return {ok:true,value:JSON.parse(saved())};
    },
    forget(){state.loggedIn=false;state.account=undefined;},
  };
  return {port,calls,uploads,downloads};
}

test('the cloud entry sits on the slots page and a logged-out page sends no cloud request',async()=>{
  const cloud=cloudStub();
  const f=fixture(undefined,cloud.port);
  f.click('开始游戏');
  assert(f.view.buttons.some(button=>button.getData('label')==='云存档'));
  assert.deepEqual(cloud.calls,[],'打开存档页不触发云请求');
  f.click('云存档');await settle();
  assert.deepEqual(cloud.calls,[],'未登录时进入云页也不请求服务器');
  assert(f.view.buttons.some(button=>button.getData('label')==='登录'));
  assert(f.view.buttons.some(button=>button.getData('label')==='返回存档'));
});

test('the cloud page keeps labels, inputs and notes inside the framed panel',async()=>{
  const cloud=cloudStub();
  const f=fixture(undefined,cloud.port);
  f.click('开始游戏');f.click('云存档');await settle();
  const panel=CLOUD_PAGE.panel;
  // 图框金线内侧至少留 40 像素；内容不能压在边框上，状态说明必须在可滚动区里。
  const inner={left:panel.x+40,top:panel.y+60,right:panel.x+panel.width-40,bottom:panel.y+panel.height-40};
  const inside=(left:number,top:number,width:number,height:number)=>left>=inner.left&&top>=inner.top&&left+width<=inner.right&&top+height<=inner.bottom;
  for(const node of f.view.textNodes.filter(node=>node.value==='账号'||node.value==='密码')){
    assert(node.x>inner.left&&node.y>inner.top,`${node.value} 贴到了图框`);
  }
  for(const label of ['登录','注册']){
    const button=f.view.buttons.find(button=>button.getData('label')===label);
    assert.ok(button,label);
    assert(inside(button.x,button.y,button.width,button.height),`${label} 超出图框`);
  }
  for(const rect of [CLOUD_PAGE.accountInput,CLOUD_PAGE.passwordInput]){
    assert(inside(rect.x,rect.y,rect.width,rect.height),'账号/密码输入框超出图框');
  }
  const note=f.view.scrolls.at(-1);
  assert.ok(note,'说明和状态应放进滚动区');
  assert(inside(note.x,note.y,note.width,note.height),'滚动区超出图框');
});

test('cloud button labels stay centered in their buttons before and after login',async()=>{
  for(const loggedIn of [false,true]){
    const cloud=cloudStub({loggedIn});const f=fixture(undefined,cloud.port);
    const scale=loggedIn ? .55 : 1.2,offsetX=37,offsetY=19;
    f.state.menuText?.destroy();
    const domUi=(f.app as unknown as {domUi:Pick<DomUi,'label'>}).domUi;
    const menuText=new MenuTextLayer(domUi,(x,y)=>({x:offsetX+x*scale,y:offsetY+y*scale,scale}),()=>undefined);
    for(const page of ['home','slots','cloud'])menuText.register(page,writer=>{for(const spec of f.state.domSpecs)writer.add(spec);});
    f.state.menuText=menuText;
    const original=f.view.button;
    f.view.button=function(label,x,y,width,height,action,options={}){
      const button=original.call(this,label,x,y,width,height,action,options);
      if(label){
        const text=this.text as unknown as (value:string,x:number,y:number,width:number,size:number,color:string,parent:unknown)=>{setOrigin(x:number):unknown};
        text.call(this,label,width/2,height/2,width-12,(options as {fontSize?:number}).fontSize??Math.min(22,height*.42),'#f3deb0',button).setOrigin(.5);
      }
      return button;
    };
    f.click('开始游戏');f.click('云存档');await settle();
    const labels=loggedIn?['修改密码','导入本机存档','下载云存档','退出登录']:['登录','注册'];
    for(const text of labels){
      const button=f.view.buttons.find(item=>item.getData('label')===text)!;
      const spec=f.state.domSpecs.find(item=>item.text===text)!;
      assert.ok(button&&spec,text);
      assert.equal(spec.x,button.x+button.width/2,`${text} 的横向中心`);
      assert.equal(spec.y,button.y+button.height/2,`${text} 的纵向中心`);
      assert.equal(spec.style.anchorX,.5);assert.equal(spec.style.anchorY,.5);
      const label=f.domLabels.slice().reverse().find(item=>!item.removed&&item.text===text)!;
      assert.ok(label,text);
      assert.equal(label.x,offsetX+(button.x+button.width/2)*scale);
      assert.equal(label.y,offsetY+(button.y+button.height/2)*scale);
      assert.deepEqual(label.anchor,[.5,.5]);
    }
  }
});

test('cloud login switches to the signed-in actions',async()=>{
  const cloud=cloudStub();
  const f=fixture(undefined,cloud.port);
  f.click('开始游戏');f.click('云存档');await settle();
  // 账号/密码现在是云页面板里的内嵌输入框；进入云页后由输入回调写入场景状态。
  f.state.cloudAccountInput='hero';
  f.state.cloudPassword='secret1';
  f.click('登录');await settle();
  assert.deepEqual(cloud.calls,['login','list']);
  assert(f.domTexts().some(text=>text.includes('已登录：hero')));
  assert(f.view.buttons.some(button=>button.getData('label')==='导入本机存档'));
  assert(f.view.buttons.some(button=>button.getData('label')==='下载云存档'));
  assert(f.view.buttons.some(button=>button.getData('label')==='退出登录'));
});

test('a locked cloud login shows the lock message without entering the signed-in page',async()=>{
  const cloud=cloudStub({login:async()=>({
    ok:false,
    error:{code:'locked',message:'密码连续输错 3 次，账号已锁定，请 15 分钟后再试。',retryAfterSeconds:900},
  })});
  const f=fixture(undefined,cloud.port);
  f.click('开始游戏');f.click('云存档');await settle();
  f.state.cloudAccountInput='hero';
  f.state.cloudPassword='secret1';
  const login=f.view.buttons.find(button=>button.getData('label')==='登录')!,scroll=f.view.scrolls.at(-1);
  f.click('登录');await settle();
  assert.equal(f.view.buttons.find(button=>button.getData('label')==='登录'),login);assert.equal(f.view.scrolls.at(-1),scroll);
  assert(f.domTexts().some(text=>text.includes('15 分钟')));
  assert(f.view.buttons.some(button=>button.getData('label')==='登录'));
});

test('an unreachable cloud page does not block local saves',async()=>{
  const cloud=cloudStub({loggedIn:true,list:async()=>({
    ok:false,error:{code:'network',message:'无法连接云存档服务，请检查网络。'},
  })});
  const f=fixture(undefined,cloud.port);
  f.entries.set('inotia4.story.v1.slot0',saved());
  f.click('开始游戏');f.click('云存档');await settle();
  assert(f.domTexts().some(text=>text.includes('无法连接云存档服务')));
  f.click('返回存档');
  assert(f.view.buttons.some(button=>button.getData('label')==='存档槽 1'));
  f.click('存档槽 1');
  assert.deepEqual(f.events,['load:0'],'本机读档不受云服务影响');
});

test('cloud backup uploads valid local slots and skips damaged ones',async()=>{
  const cloud=cloudStub({loggedIn:true});
  const f=fixture(undefined,cloud.port);
  f.entries.set('inotia4.story.v1.slot0',saved());
  f.entries.set('inotia4.story.v1.slot1','{broken');
  f.click('开始游戏');f.click('云存档');await settle();
  f.click('导入本机存档');await settle();
  assert.deepEqual(cloud.uploads.map(item=>item.slot),[0]);
  assert(f.domTexts().some(text=>text.includes('导入成功 1 个')));
  assert(f.domTexts().some(text=>text.includes('存档槽 2')));
});

test('cloud download writes local slots and returns to the save list',async()=>{
  const cloud=cloudStub({loggedIn:true,entries:[cloudEntry(0)]});
  const f=fixture(undefined,cloud.port);
  f.click('开始游戏');f.click('云存档');await settle();
  f.click('下载云存档');await settle();
  assert.deepEqual(cloud.downloads,[0]);
  assert.equal(f.saves.inspect(0).kind,'ok');
  assert(f.view.buttons.some(button=>button.getData('label')==='存档槽 1'));
});

test('cloud backup asks before overwriting and does not upload when cancelled',async()=>{
  const cloud=cloudStub({loggedIn:true,entries:[cloudEntry(0)]});
  const f=fixture(undefined,cloud.port);
  f.entries.set('inotia4.story.v1.slot0',saved());
  f.click('开始游戏');f.click('云存档');await settle();
  f.click('导入本机存档');await settle();
  assert(f.domTexts().some(text=>text.includes('覆盖')));
  assert.equal(cloud.uploads.length,0,'确认前不上传');
  f.clickModal('是');await settle();
  assert.deepEqual(cloud.uploads.map(item=>item.slot),[0]);
});

test('cloud password change uses the password form hook and keeps the player signed in',async()=>{
  const cloud=cloudStub({loggedIn:true});
  const f=fixture(undefined,cloud.port);
  let asked=0;
  f.app.promptPasswordChange=async()=>{asked+=1;return {currentPassword:'secret1',newPassword:'secret2'};};
  f.click('开始游戏');f.click('云存档');await settle();
  assert(f.view.buttons.some(button=>button.getData('label')==='修改密码'));
  f.click('修改密码');await settle();
  assert.equal(asked,1);
  assert.ok(cloud.calls.includes('change-password'));
  assert(f.domTexts().some(text=>text.includes('密码已修改')));
  assert(f.view.buttons.some(button=>button.getData('label')==='导入本机存档'));
});

test('a near-expiry cloud session renews before listing',async()=>{
  const now=Date.now();
  const cloud=cloudStub({
    loggedIn:true,
    expiresAt:now+24*60*60*1000,
    absoluteExpiresAt:now+60*24*60*60*1000,
  });
  const f=fixture(undefined,cloud.port);
  f.click('开始游戏');f.click('云存档');await settle();
  assert.ok(cloud.calls.includes('refresh'));
  assert.ok(cloud.calls.indexOf('refresh')<cloud.calls.indexOf('list'));
});

test('a session far from expiry lists without renewal',async()=>{
  const now=Date.now();
  const cloud=cloudStub({
    loggedIn:true,
    expiresAt:now+30*24*60*60*1000,
    absoluteExpiresAt:now+90*24*60*60*1000,
  });
  const f=fixture(undefined,cloud.port);
  f.click('开始游戏');f.click('云存档');await settle();
  assert.ok(!cloud.calls.includes('refresh'));
  assert.ok(cloud.calls.includes('list'));
});

test('a network error during renewal still lets the list run',async()=>{
  const now=Date.now();
  const cloud=cloudStub({
    loggedIn:true,
    expiresAt:now+24*60*60*1000,
    absoluteExpiresAt:now+60*24*60*60*1000,
    refresh:async()=>({ok:false,error:{code:'network',message:'无法连接云存档服务，请检查网络。'}}),
  });
  const f=fixture(undefined,cloud.port);
  f.click('开始游戏');f.click('云存档');await settle();
  assert.ok(cloud.calls.includes('refresh'));
  assert.ok(cloud.calls.includes('list'));
  assert(f.view.buttons.some(button=>button.getData('label')==='导入本机存档'));
});

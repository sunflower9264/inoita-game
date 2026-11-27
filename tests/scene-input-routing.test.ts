import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { InputRouter } from '../src/application/input-router.ts';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { DomUi } from '../src/ui/dom/dom-ui.ts';
import type { GameUI } from '../src/ui/game-ui.ts';
import { UiImage, UiNode } from '../src/ui/dom/node.ts';
import { UiSurface } from '../src/ui/dom/surface.ts';
import { installMenuDom, menuFrame, MenuElement } from './support/menu-dom.ts';
import { domAssets } from '../src/ui/dom/assets.ts';
import { characterAtlasPageKeys } from '../src/rendering/character-atlas.ts';
import { CHARACTER_ATLAS_BY_FILE } from '../src/generated/character-atlas.ts';

// 只替换 Phaser 的运行边界；场景的键盘判断跑真实代码。
const hook = registerHooks({ resolve(specifier, context, next) {
  return specifier === 'phaser' ? { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(`
    export default {
      Scene: class { constructor(config) { this.key = typeof config === 'string' ? config : config?.key; } },
      BlendModes: { NORMAL: 0, ADD: 1, SCREEN: 2, MULTIPLY: 3 },
      Textures: { FilterMode: { NEAREST: 1 } },
      Scenes: { Events: { RESUME: 'resume', PAUSE: 'pause' } },
      Input: { Events: { POINTER_MOVE: 'pointermove', POINTER_UP: 'pointerup', POINTER_UP_OUTSIDE: 'pointerupoutside' } },
      Math: { Clamp: (value, min, max) => Math.max(min, Math.min(max, value)) },
      Geom: { Rectangle: class {}, Circle: class {} }
    };
  `)}` } : next(specifier, context);
} });
const { FormalUiScene } = await import('../src/scenes/formal-ui-scene.ts');
const { FormalUiView } = await import('../src/ui/formal-ui-view.ts');
const { FormalChoiceView } = await import('../src/ui/formal-choice-view.ts');
const { FormalModalView } = await import('../src/ui/formal-modal-view.ts');
const { TitleMenuController } = await import('../src/ui/title-menu-controller.ts');
const { ClassSelectionPage } = await import('../src/ui/class-selection-page.ts');
hook.deregister();

test('class selection plays live previews and retains the page when changing classes',async t=>{
  const restore=installMenuDom();t.after(restore);
  t.mock.method(domAssets,'preloadFiles',async()=>({release(){}}));
  const catalog=JSON.parse(readFileSync(new URL('../public/content/story-classes.json',import.meta.url),'utf8'));
  // 职业预览图目前没有进角色图集；用同等帧数的图集文件做替身，验证页面使用真实页纹理。
  for(const entry of catalog.classes)for(const clip of Object.values(entry.previewActor.clips) as any[])
    for(const layer of clip.layers){
      if(!layer.file||CHARACTER_ATLAS_BY_FILE[layer.file])continue;
      const replacement=Object.entries(CHARACTER_ATLAS_BY_FILE).find(([,value])=>value.pages.length>=clip.frames);
      assert.ok(replacement,`没有覆盖 ${clip.frames} 帧的图集文件`);
      layer.file=replacement[0];
    }
  const app={storyClasses:catalog,ui:{ready:true,loading(){},loaded(){},error(){}},suspended:false};
  const runtime={} as any;
  const scene=new ClassSelectionPage(runtime,app as never) as any;
  runtime.events=new EventEmitter();runtime.scale=Object.assign(new EventEmitter(),{width:1024,height:640});
  runtime.game={events:new EventEmitter(),canvas:{getBoundingClientRect:()=>({...menuFrame})}};
  const filters:string[]=[],animations=new Map<string,any>(),played:string[]=[],containers:any[]=[];
  runtime.textures=Object.assign(new EventEmitter(),{exists:()=>true,get:(key:string)=>({has:()=>true,setFilter:()=>filters.push(key)}),remove(){}});
  runtime.anims={exists:(key:string)=>animations.has(key),get:(key:string)=>animations.get(key),
    generateFrameNumbers:(key:string,{start,end}:{start:number;end:number})=>Array.from({length:end-start+1},(_,i)=>({key,frame:start+i})),
    create:(config:any)=>{animations.set(config.key,config);},remove:(key:string)=>animations.delete(key)};
  const background={width:0,height:0,setOrigin(){return this;},setScrollFactor(){return this;},setDepth(){return this;},
    setPosition(x:number,y:number){Object.assign(this,{x,y});return this;},setDisplaySize(width:number,height:number){Object.assign(this,{width,height});return this;},destroy(){}};
  runtime.add={image:()=>background,container:()=>{
    const container={list:[] as any[],destroyed:false,visible:true,x:0,y:0,scale:1,
      setDepth(){return this;},setScrollFactor(){return this;},setVisible(value:boolean){this.visible=value;return this;},
      setScale(value:number){this.scale=value;return this;},setPosition(x:number,y:number){this.x=x;this.y=y;return this;},
      addAt(sprite:any,index:number){this.list.splice(index,0,sprite);return this;},destroy(){this.destroyed=true;}};
    containers.push(container);return container;
  },sprite:()=>({scene:runtime,alpha:1,anims:{timeScale:1,accumulator:0},
    setOrigin(){return this;},setBlendMode(){return this;},setScale(){return this;},play(config:{key:string}){played.push(config.key);return this;}})};
  await scene.open(new AbortController().signal);
  const page=[...scene.surface.root.list],preview=scene.preview,first=containers[0];
  const visibleClasses=catalog.classes.filter((entry:any)=>!entry.debugOnly);
  assert.equal(visibleClasses.length,6,'默认非调试模式只加载并展示六个正式职业');
  const expectedPreviewTextures=new Set<string>();
  for(const entry of visibleClasses)for(const clip of Object.values(entry.previewActor.clips))
    for(const layer of (clip as any).layers){
      const pages=characterAtlasPageKeys(layer.file);
      if(pages.length)for(const key of pages)expectedPreviewTextures.add(key);
      else expectedPreviewTextures.add(layer.key);
    }
  assert.deepEqual([...new Set(filters)].sort(),[...expectedPreviewTextures].sort(),'每个职业的动画使用真实纹理并保持清晰像素');
  assert.equal(played.length,1);assert.equal(animations.get(played[0]).repeat,-1);
  scene.choose(visibleClasses.find((entry:any)=>entry.id===catalog.defaultClass));
  assert.equal(containers.length,1,'重复选择当前职业不重建角色');
  for(const [index,entry] of visibleClasses.entries()){
    scene.choose(entry);
    assert.deepEqual(scene.surface.root.list,page,'切换职业保留原来的按钮和面板');
    assert.equal(scene.preview,preview);assert.equal(scene.selections[index].visible,true);
    assert.equal(scene.selections.filter((selection:any)=>selection.visible).length,1);
    const clip=entry.previewActor.clips['idle-south'];
    const layer=clip.layers[0];
    assert.equal(containers.at(-1).scale,3*scene.surface.root.scaleX);
    assert.ok(played.at(-1)!.startsWith(`${layer.file||layer.key}#`),'预览播放该职业动作图集');
    assert.ok(played.at(-1)!.includes(`#clip:${clip.frames}:${clip.frameRate}:`),'动画键保留动作帧数与帧率');
  }
  assert.equal(first.destroyed,true,'切换职业释放旧角色');
  app.suspended=true;scene.update();assert.equal(containers.at(-1).visible,false);
  app.suspended=false;scene.update();assert.equal(containers.at(-1).visible,true);
  Object.assign(menuFrame,{width:800,height:480});runtime.scale.width=800;runtime.scale.height=480;scene.layout();
  assert.equal(containers.at(-1).scale,3*scene.surface.root.scaleX,'窗口变化时角色跟随页面缩放');
  assert.equal(background.width,800*scene.surface.root.scaleX);
  const cssScale=scene.surface.root.scaleX;
  runtime.scale.width=2400;runtime.scale.height=1440;scene.layout();
  assert.equal(scene.surface.root.scaleX,cssScale,'采样提高后 DOM 页面尺寸不变');
  assert.ok(Math.abs(containers.at(-1).scale-9*cssScale)<1e-6,'画布里的角色按采样倍率放大');
  assert.equal(background.width,2400*cssScale,'画布背景与角色一起换算');
  scene.dispose();
  await new Promise(resolve=>setTimeout(resolve,0));
});

test('class selection aligns lancer to the right of warrior in debug mode without clipping narrow viewports',async t=>{
  const restore=installMenuDom();t.after(restore);
  t.mock.method(domAssets,'preloadFiles',async()=>({release(){}}));
  const catalog=JSON.parse(readFileSync(new URL('../public/content/story-classes.json',import.meta.url),'utf8'));
  const app={storyClasses:catalog,debugMode:true,ui:{ready:true,loading(){},loaded(){},error(){}},suspended:false};
  const runtime={} as any;
  const scene=new ClassSelectionPage(runtime,app as never) as any;
  runtime.events=new EventEmitter();runtime.scale=Object.assign(new EventEmitter(),{width:1024,height:640});
  runtime.game={events:new EventEmitter(),canvas:{getBoundingClientRect:()=>({...menuFrame})}};
  runtime.textures=Object.assign(new EventEmitter(),{exists:()=>true,get:()=>({has:()=>true,setFilter(){}}),remove(){}});
  runtime.anims={exists:()=>false,get:()=>undefined,generateFrameNumbers:()=>[],create(){},remove(){}};
  const background={width:0,height:0,setOrigin(){return this;},setScrollFactor(){return this;},setDepth(){return this;},
    setPosition(x:number,y:number){Object.assign(this,{x,y});return this;},setDisplaySize(width:number,height:number){Object.assign(this,{width,height});return this;},destroy(){}};
  runtime.add={image:()=>background,container:()=>({list:[] as any[],destroyed:false,visible:true,x:0,y:0,scale:1,
    setDepth(){return this;},setScrollFactor(){return this;},setVisible(value:boolean){this.visible=value;return this;},
    setScale(value:number){this.scale=value;return this;},setPosition(x:number,y:number){this.x=x;this.y=y;return this;},
    addAt(sprite:any,index:number){this.list.splice(index,0,sprite);return this;},destroy(){this.destroyed=true;}}),
    sprite:()=>({scene:runtime,alpha:1,anims:{timeScale:1,accumulator:0},setOrigin(){return this;},setBlendMode(){return this;},setScale(){return this;},play(){return this;}})};
  await scene.open(new AbortController().signal);
  const buttons=scene.surface.root.list.filter((node:any)=>node.getData('uiAction'));
  const warrior=buttons.find((node:any)=>node.getData('label')==='狂战士');
  const lancer=buttons.find((node:any)=>node.getData('label')==='龙枪武士');
  assert.ok(warrior&&lancer,'调试模式下狂战士与龙枪武士按钮同时存在');
  assert.equal(lancer.y,warrior.y,'龙枪武士与狂战士水平对齐');
  assert.equal(lancer.height,warrior.height);
  assert.equal(lancer.width,warrior.width);
  assert.equal(lancer.x,warrior.x+warrior.width+16,'龙枪武士紧贴狂战士右侧');
  // 切到 800×480 窄屏与 1024×640 屏，验证龙枪按钮完整落在可视画框内无裁切
  for(const [w,h] of [[800,480],[1024,640]] as const){
    Object.assign(menuFrame,{width:w,height:h});runtime.scale.width=w;runtime.scale.height=h;scene.layout();
    const bounds=lancer.getBounds();
    assert.ok(bounds.x>=0&&bounds.x+bounds.width<=w+0.5,`${w}x${h} 下龙枪武士横向不能越界: ${JSON.stringify(bounds)}`);
    assert.ok(bounds.y>=0&&bounds.y+bounds.height<=h+0.5,`${w}x${h} 下龙枪武士纵向不能越界: ${JSON.stringify(bounds)}`);
  }
  scene.dispose();
  await new Promise(resolve=>setTimeout(resolve,0));
});

test('dialogue and choice text stays above its shade and hides during occlusion',t=>{
  const restore=installMenuDom();
  const dom=new DomUi();
  dom.layer=name=>document.getElementById(`ui-${name}`) as HTMLDivElement;
  dom.setOccluded=()=>{};
  const ui={mode:'game',ready:true,suspended:false,worldRebuildCover:false,defeated:false,canSkip:false,toastMessage:'',
    dialogueLine:{speaker:'说话人',actor:'npc',text:'对白内容'},page:'对白内容',get dialoguePageMarkup(){return this.page;},revealed:4,
    choices:undefined as GameUI['choices'],quest:undefined,
    pressDialogue:()=>{},releaseDialogue:()=>{},resetInput:()=>{},reflowDialogue:()=>{}};
  const app={ui,domUi:dom,storyInterface:{assets:{}},director:{canSkip:false}};
  const host=new FormalUiScene(app as never) as any;
  const scene=new FormalUiView(host,app as never,{} as never) as any;
  host.events=new EventEmitter();host.scale=Object.assign(new EventEmitter(),{width:1024,height:640});
  host.game={events:new EventEmitter(),canvas:{getBoundingClientRect:()=>({left:0,top:0,width:1024,height:640})}};
  scene.surface=new UiSurface(host,960,640,1000,'overlay');
  scene.choiceView=new FormalChoiceView(host,dom);scene.modalView=new FormalModalView(host,app as never);
  scene.background=new UiNode(host,scene.surface.mount);scene.blocker=new UiNode(host,scene.surface.mount).setInteractive();
  scene.questPopup={sync:()=>{}};scene.domSpeaker=dom.label('overlay','dom-speaker');
  t.after(()=>{scene.surface.destroy();scene.background.destroy();scene.blocker.destroy();scene.choiceView.destroy();scene.modalView.destroy();host.events.emit('shutdown');restore();});
  scene.sync(ui);
  const overlay=document.getElementById('ui-overlay') as unknown as MenuElement;
  const speaker=scene.domSpeaker.element as unknown as MenuElement,run=scene.dialogueDomRuns[0].element as unknown as MenuElement;
  assert.equal(scene.surface.mount.parentElement,overlay);assert.equal(speaker.parentElement,overlay);assert.equal(run.parentElement,overlay);
  assert.equal(speaker.hidden,false);assert.equal(run.hidden,false);
  const frame:UiNode[]=scene.surface.root.list.slice();
  ui.canSkip=true;scene.sync(ui);
  ui.canSkip=false;ui.page='第二页';scene.sync(ui);
  ui.canSkip=true;scene.sync(ui);
  assert.ok(frame.every((part,index)=>scene.surface.root.list[index]===part),'翻到下一页仍沿用同一个对白框');
  assert.equal(scene.dialogueDomRuns[0].element,run);assert.equal(run.textContent,'第二页');
  ui.dialogueLine.speaker='另一位';ui.dialogueLine.actor='other';ui.page='另一句';scene.sync(ui);
  assert.deepEqual(scene.surface.root.list,frame,'说话人变化时保留对白底框');
  assert.equal(scene.domSpeaker.element,speaker);assert.equal(scene.dialogueDomRuns[0].element,run);
  assert.equal(speaker.textContent,'另一位');assert.equal(run.textContent,'另一句');
  ui.suspended=true;scene.sync(ui);assert.equal(speaker.hidden,true);assert.equal(run.hidden,true);
  ui.page='暂停期间更新';scene.sync(ui);assert.equal(run.hidden,true,'遮挡期间正文变化不会让文字重新出现');
  ui.suspended=false;scene.sync(ui);assert.equal(speaker.hidden,false);assert.equal(run.hidden,false);
  ui.worldRebuildCover=true;scene.sync(ui);assert.equal(speaker.hidden,true);assert.equal(run.hidden,true);
  ui.worldRebuildCover=false;scene.sync(ui);assert.equal(run.hidden,false);
  ui.choices={prompt:'选择',description:'一行说明&N'.repeat(30),
    options:Array.from({length:30},(_,i)=>({label:'选项'+i,value:String(i)})),choose:()=>{}};scene.sync(ui);
  const choice=scene.choiceView.choiceDom.prompt[0].element as MenuElement;
  assert.equal(choice.parentElement,overlay);assert.equal(choice.hidden,false);assert.equal(run.hidden,true);
  const choiceNodes=scene.choiceView.surface.root.list.slice(),choiceScroll=scene.choiceView.choiceDom.list.scroll;
  ui.toastMessage='提示变化';scene.sync(ui);
  assert.deepEqual(scene.choiceView.surface.root.list,choiceNodes,'提示变化保留选项按钮');
  assert.equal(scene.choiceView.choiceDom.list.scroll,choiceScroll,'提示变化保留选项滚动区');
  scene.choiceView.choiceDom.description.scroll.scrollTop=45;
  choiceScroll.scrollTop=90;
  ui.suspended=true;scene.sync(ui);assert.equal(choice.hidden,true);
  ui.suspended=false;scene.sync(ui);assert.equal(choice.hidden,false);
  scene.resize();
  assert.equal(scene.choiceView.choiceDom.description.scroll.scrollTop,45);
  assert.equal(scene.choiceView.choiceDom.list.scroll.scrollTop,90);
  const nextChoices={...ui.choices};
  ui.choices=undefined;scene.sync(ui);
  ui.choices=nextChoices;scene.sync(ui);
  assert.equal(scene.choiceView.choiceDom.description.scroll.scrollTop,0);
  assert.equal(scene.choiceView.choiceDom.list.scroll.scrollTop,0);
});

interface FakeEvent { key: string; target?: { tagName: string }; prevented: number; preventDefault(): void }
function press(key: string, target?: { tagName: string }): FakeEvent {
  const event: FakeEvent = { key, target, prevented: 0, preventDefault() { event.prevented += 1; } };
  return event;
}

function formalFixture(menuOpen = false) {
  const calls: string[] = [];
  const ui = {
    mode: 'game' as string, suspended: false, worldRebuildCover: false, keyBindingEditing: false,
    defeated: false, canSkip: false,
    quest: undefined as unknown,
    advance() { calls.push('advance'); },
    cancelDefeatConfirmation() { calls.push('cancel-defeat'); }
  };
  const app = {
    ui, storyUI: { menuOpen },
    inputRouter: new InputRouter({ textInputFocused: () => false })
  };
  const host=new FormalUiScene(app as never) as any;
  const scene = new FormalUiView(host,app as never,{} as never) as unknown as {
    key(event: FakeEvent): boolean;
    bridgeKey(event: FakeEvent): void;
    surface: { key(event: FakeEvent): boolean };
    questPopup: { key(event: FakeEvent): void };
  };
  scene.bridgeKey=event=>host.bridgeKey(event);
  let surfaceResult = false;
  scene.surface = { key: () => surfaceResult };
  scene.questPopup = { key: () => calls.push('quest-popup') };
  return { app, ui, scene, calls, setSurfaceResult: (value: boolean) => { surfaceResult = value; } };
}

test('正式界面弹层按原守卫顺序处理键盘', () => {
  const f = formalFixture();
  assert.equal(f.scene.key(press('Escape')), false, '普通按键交给更低层');
  assert.deepEqual(f.calls, []);

  f.ui.suspended = true;
  assert.equal(f.scene.key(press('Enter')), false);
  f.ui.suspended = false;

  f.ui.keyBindingEditing = true;
  assert.equal(f.scene.key(press('Enter')), false, '键位捕获时让给设置面板');
  f.ui.keyBindingEditing = false;

  f.ui.defeated = true;
  const escape = press('Escape');
  assert.equal(f.scene.key(escape), true);
  assert.equal(escape.prevented, 1);
  assert.deepEqual(f.calls, ['cancel-defeat']);
  f.ui.defeated = false;

  f.ui.quest = { kind: 'start' };
  assert.equal(f.scene.key(press('Enter')), true);
  assert.deepEqual(f.calls, ['cancel-defeat', 'quest-popup'], '任务窗打开时其他层不重复消费');
  f.ui.quest = undefined;

  f.ui.canSkip = true;
  const enter = press('Enter');
  assert.equal(f.scene.key(enter), true);
  assert.equal(enter.prevented, 1);
  assert.deepEqual(f.calls, ['cancel-defeat', 'quest-popup', 'advance']);

  f.setSurfaceResult(true);
  assert.equal(f.scene.key(press('Tab')), true, '界面按钮聚焦由 surface 消费');
});

test('游戏内菜单打开时正式界面先让路，避免 Tab/Enter 被两层抢走', () => {
  const f = formalFixture(true);
  f.ui.canSkip = true;
  assert.equal(f.scene.key(press('Enter')), false);
  assert.deepEqual(f.calls, []);
});

test('正式界面场景只把原始按键桥接给 router', () => {
  const f = formalFixture();
  const seen: string[] = [];
  f.app.inputRouter.register('modal', event => { seen.push(event.key); return true; });
  f.scene.bridgeKey(press('Escape'));
  assert.deepEqual(seen, ['Escape']);
});

test('标题页的 Escape 先关确认框，再返回上一页', async () => {
  const inputRouter = new InputRouter({ textInputFocused: () => false });
  let finishRename!: (value: string | undefined) => void;
  const renameInput = new Promise<string | undefined>(resolve => { finishRename = resolve; });
  const app = {
    inputRouter, ui: { suspended: false },
    saves: { peek: () => ({ kind: 'ok', summary: { name: '第一章' } }) },
    promptText: () => renameInput,
  };
  const host = { sys: { isActive: () => true } };
  const scene = new TitleMenuController(host as never, app as never, {} as never) as unknown as {
    routeKey(event: FakeEvent): boolean;
    renameSlot(slot: number): void;
    page: string;
    confirmAction?: { cancel(): void };
    surface: { key(event: FakeEvent): boolean };
    back(): void;
    layout(): void;
  };
  const calls: string[] = [];
  scene.surface = { key: () => false };
  scene.back = () => calls.push('back');
  scene.layout = () => {};

  scene.page = 'slots';
  scene.confirmAction = { cancel: () => calls.push('cancel-confirm') };
  const first = press('Escape');
  assert.equal(scene.routeKey(first), true);
  assert.equal(first.prevented, 1);
  assert.deepEqual(calls, ['cancel-confirm']);

  scene.confirmAction = undefined;
  assert.equal(scene.routeKey(press('Escape')), true);
  assert.deepEqual(calls, ['cancel-confirm', 'back'], '确认框关掉后 Escape 才离开页面');

  scene.page = 'home';
  assert.equal(scene.routeKey(press('Escape')), false);
  assert.deepEqual(calls, ['cancel-confirm', 'back']);

  scene.page = 'slots';
  scene.renameSlot(0);
  assert.equal(scene.routeKey(press('Escape')), true, '改名输入期间场景不处理按键');
  assert.deepEqual(calls, ['cancel-confirm', 'back']);
  finishRename(undefined);
  await renameInput;
  assert.equal(scene.routeKey(press('Escape')), true);
  assert.deepEqual(calls, ['cancel-confirm', 'back', 'back'], '取消改名后 Escape 恢复返回页面');
});

test('确认框文字使用弹层的屏幕坐标，不再减页面原点', async t => {
  const restore = installMenuDom();
  t.after(restore);
  menuFrame.width = 960;
  menuFrame.height = 640;
  const host = { sys: { isActive: () => true }, events: new EventEmitter() };
  const realDomUi = new DomUi();
  realDomUi.layer = name => document.getElementById(`ui-${name}`) as HTMLDivElement;
  const placed: { text: string; x: number; y: number }[] = [];
  const domUi = {
    layer: (name: Parameters<DomUi['layer']>[0]) => realDomUi.layer(name),
    label: (layer: Parameters<DomUi['label']>[0], className?: string, anchor?: { x: number; y: number }) => {
      const label = realDomUi.label(layer, className, anchor);
      const origSetPosition = label.setPosition.bind(label);
      let currentText = '';
      const origSetText = label.setText.bind(label);
      label.setText = value => { currentText = value; return origSetText(value); };
      label.setPosition = (x, y) => {
        if (className?.includes('dom-native-message')) placed.push({ text: currentText, x, y });
        return origSetPosition(x, y);
      };
      return label;
    },
  };
  const app = {
    inputRouter: new InputRouter({ textInputFocused: () => false }),
    domUi,
    ui: {
      mode: 'menu', ready: true, suspended: false,
      setMode() {}, loading() {}, menuLoaded() {}, error() {},
    },
    saves: { list: () => [], peek: () => ({ kind: 'empty' }) },
    prefetchCommon() {},
  };
  const views = {
    createBackdrop: () => new UiImage(host),
    createPopupMask: () => new UiNode(host),
    createSurface: (width: number, height: number, depth = 0) => {
      const surface = new UiSurface(host, width, height, depth);
      if (width === 1200) {
        surface.layout = () => { surface.root.setScale(.5).setPosition(100, 50); };
        surface.layout();
      }
      return surface;
    },
    createCredentials: () => ({ focused: false, show() {}, hide() {}, blur() {}, setRects() {}, setValues() {}, destroy() {} }),
  };
  const titleAssets = { preloadResident: async () => {} };
  const controller = new TitleMenuController(host, app as never, titleAssets as never, () => {}, views);
  t.after(() => controller.dispose());
  await controller.open();

  const internal = controller as unknown as {
    confirmAction?: { message: string; accept(): void; cancel(): void };
    render(): void;
  };
  internal.confirmAction = { message: '确认读取存档？', accept() {}, cancel() {} };
  placed.length = 0;
  internal.render();

  const body = placed.find(item => item.text === '确认读取存档？');
  assert.ok(body, '确认框正文通过 TitleMenuController.modalTextPoint 创建了 DOM 标签');
  // surface(1200x640) 位于 (100, 50), scale = 0.5；centerModal 把 modal(1024x640) 放在
  // tx = 100 + (1200 - 1024) / 2 * 0.5 = 144, ty = 50, scale = 0.5。
  // 正文中心 modal-local x = 512，按 modal 换算应为 144 + 512 * 0.5 = 400（而非 surface 的 356）。
  assert.equal(body.x, 400, '弹层文字通过 modal 屏幕坐标定位，而不是回退到 surface 坐标');
});

test('职业选择页的 Escape 回标题，其他按键交给页面按钮', () => {
  const app = { inputRouter: new InputRouter({ textInputFocused: () => false }), suspended: false,
    returnToMenu: () => { app.returned += 1; }, returned: 0 };
  const scene = new ClassSelectionPage({} as never,app as never) as unknown as {
    routeKey(event: FakeEvent): boolean;
    surface: { key(event: FakeEvent): boolean };
  };
  scene.surface = { key: () => true };
  assert.equal(scene.routeKey(press('Escape')), true);
  assert.equal(app.returned, 1);
  assert.equal(scene.routeKey(press('Tab')), true);
  app.suspended = true;
  assert.equal(scene.routeKey(press('Escape')), false, '挂起时不再响应');
  assert.equal(app.returned, 1);
});


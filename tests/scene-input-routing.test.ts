import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { InputRouter } from '../src/application/input-router.ts';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { DomUi } from '../src/ui/dom/dom-ui.ts';
import { UiNode } from '../src/ui/dom/node.ts';
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
const { MenuScene } = await import('../src/scenes/menu-scene.ts');
const { StoryClassScene } = await import('../src/scenes/story-class-scene.ts');
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
  const scene=new StoryClassScene(app as never) as any;
  scene.events=new EventEmitter();scene.scale=Object.assign(new EventEmitter(),{width:1024,height:640});
  scene.game={events:new EventEmitter(),canvas:{getBoundingClientRect:()=>({...menuFrame})}};
  const filters:string[]=[],animations=new Map<string,any>(),played:string[]=[],containers:any[]=[];
  scene.textures=Object.assign(new EventEmitter(),{exists:()=>true,get:(key:string)=>({has:()=>true,setFilter:()=>filters.push(key)}),remove(){}});
  scene.anims={exists:(key:string)=>animations.has(key),get:(key:string)=>animations.get(key),
    generateFrameNumbers:(key:string,{start,end}:{start:number;end:number})=>Array.from({length:end-start+1},(_,i)=>({key,frame:start+i})),
    create:(config:any)=>{animations.set(config.key,config);},remove:(key:string)=>animations.delete(key)};
  const background={width:0,height:0,setOrigin(){return this;},setScrollFactor(){return this;},setDepth(){return this;},
    setPosition(x:number,y:number){Object.assign(this,{x,y});return this;},setDisplaySize(width:number,height:number){Object.assign(this,{width,height});return this;},destroy(){}};
  scene.add={image:()=>background,container:()=>{
    const container={list:[] as any[],destroyed:false,visible:true,x:0,y:0,scale:1,
      setDepth(){return this;},setScrollFactor(){return this;},setVisible(value:boolean){this.visible=value;return this;},
      setScale(value:number){this.scale=value;return this;},setPosition(x:number,y:number){this.x=x;this.y=y;return this;},
      addAt(sprite:any,index:number){this.list.splice(index,0,sprite);return this;},destroy(){this.destroyed=true;}};
    containers.push(container);return container;
  },sprite:()=>({scene,alpha:1,anims:{timeScale:1,accumulator:0},
    setOrigin(){return this;},setBlendMode(){return this;},setScale(){return this;},play(config:{key:string}){played.push(config.key);return this;}})};
  await scene.open(new AbortController().signal);
  const page=[...scene.surface.root.list],preview=scene.preview,first=containers[0];
  const expectedPreviewTextures=new Set<string>();
  for(const entry of catalog.classes)for(const clip of Object.values(entry.previewActor.clips))
    for(const layer of (clip as any).layers){
      const pages=characterAtlasPageKeys(layer.file);
      if(pages.length)for(const key of pages)expectedPreviewTextures.add(key);
      else expectedPreviewTextures.add(layer.key);
    }
  assert.deepEqual([...new Set(filters)].sort(),[...expectedPreviewTextures].sort(),'每个职业的动画使用真实纹理并保持清晰像素');
  assert.equal(played.length,1);assert.equal(animations.get(played[0]).repeat,-1);
  scene.choose(catalog.classes.find((entry:any)=>entry.id===catalog.defaultClass));
  assert.equal(containers.length,1,'重复选择当前职业不重建角色');
  for(const [index,entry] of catalog.classes.entries()){
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
  Object.assign(menuFrame,{width:800,height:480});scene.scale.width=800;scene.scale.height=480;scene.layout();
  assert.equal(containers.at(-1).scale,3*scene.surface.root.scaleX,'窗口变化时角色跟随页面缩放');
  assert.equal(background.width,800*scene.surface.root.scaleX);
  const cssScale=scene.surface.root.scaleX;
  scene.scale.width=2400;scene.scale.height=1440;scene.layout();
  assert.equal(scene.surface.root.scaleX,cssScale,'采样提高后 DOM 页面尺寸不变');
  assert.ok(Math.abs(containers.at(-1).scale-9*cssScale)<1e-6,'画布里的角色按采样倍率放大');
  assert.equal(background.width,2400*cssScale,'画布背景与角色一起换算');
  scene.preview.destroy();scene.background.destroy();scene.surface.destroy();scene.events.emit('shutdown');
  await new Promise(resolve=>setTimeout(resolve,0));
});

test('dialogue and choice text stays above its shade and hides during occlusion',t=>{
  const restore=installMenuDom();t.after(restore);
  const dom=new DomUi();
  dom.layer=name=>document.getElementById(`ui-${name}`) as HTMLDivElement;
  dom.setOccluded=()=>{};
  const ui={mode:'game',ready:true,suspended:false,worldRebuildCover:false,defeated:false,canSkip:false,
    dialogueLine:{speaker:'说话人',actor:'npc',text:'对白内容'},page:'对白内容',get dialoguePageMarkup(){return this.page;},revealed:4,
    choices:undefined as undefined|{prompt:string;options:never[];choose:()=>void},quest:undefined,
    pressDialogue:()=>{},releaseDialogue:()=>{},resetInput:()=>{}};
  const app={ui,domUi:dom,storyInterface:{assets:{}},director:{canSkip:false}};
  const scene=new FormalUiScene(app as never) as any;
  scene.events=new EventEmitter();scene.scale=Object.assign(new EventEmitter(),{width:1024,height:640});
  scene.game={events:new EventEmitter(),canvas:{getBoundingClientRect:()=>({left:0,top:0,width:1024,height:640})}};
  scene.surface=new UiSurface(scene,960,640,1000,'overlay');
  scene.background=new UiNode(scene,scene.surface.mount);scene.blocker=new UiNode(scene,scene.surface.mount).setInteractive();
  scene.questPopup={sync:()=>{}};scene.domSpeaker=dom.label('overlay','dom-speaker');
  t.after(()=>{scene.surface.destroy();scene.background.destroy();scene.blocker.destroy();scene.events.emit('shutdown');});
  scene.sync(ui);
  const overlay=document.getElementById('ui-overlay') as unknown as MenuElement;
  const speaker=scene.domSpeaker.element as unknown as MenuElement,run=scene.dialogueDomRuns[0].element as unknown as MenuElement;
  assert.equal(scene.surface.mount.parentElement,overlay);assert.equal(speaker.parentElement,overlay);assert.equal(run.parentElement,overlay);
  assert.equal(speaker.hidden,false);assert.equal(run.hidden,false);
  ui.suspended=true;scene.sync(ui);assert.equal(speaker.hidden,true);assert.equal(run.hidden,true);
  ui.page='暂停期间更新';scene.sync(ui);assert.equal(run.hidden,true,'遮挡期间正文变化不会让文字重新出现');
  ui.suspended=false;scene.sync(ui);assert.equal(speaker.hidden,false);assert.equal(run.hidden,false);
  ui.worldRebuildCover=true;scene.sync(ui);assert.equal(speaker.hidden,true);assert.equal(run.hidden,true);
  ui.worldRebuildCover=false;scene.sync(ui);assert.equal(run.hidden,false);
  ui.choices={prompt:'选择',options:[],choose:()=>{}};scene.sync(ui);
  const choice=scene.choiceDom.prompt[0].element as MenuElement;
  assert.equal(choice.parentElement,overlay);assert.equal(choice.hidden,false);assert.equal(run.hidden,true);
  ui.suspended=true;scene.sync(ui);assert.equal(choice.hidden,true);
  ui.suspended=false;scene.sync(ui);assert.equal(choice.hidden,false);
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
  const scene = new FormalUiScene(app as never) as unknown as {
    routeKey(event: FakeEvent): boolean;
    bridgeKey(event: FakeEvent): void;
    surface: { key(event: FakeEvent): boolean };
    questPopup: { key(event: FakeEvent): void };
  };
  let surfaceResult = false;
  scene.surface = { key: () => surfaceResult };
  scene.questPopup = { key: () => calls.push('quest-popup') };
  return { app, ui, scene, calls, setSurfaceResult: (value: boolean) => { surfaceResult = value; } };
}

test('正式界面弹层按原守卫顺序处理键盘', () => {
  const f = formalFixture();
  assert.equal(f.scene.routeKey(press('Escape')), false, '普通按键交给更低层');
  assert.deepEqual(f.calls, []);

  f.ui.suspended = true;
  assert.equal(f.scene.routeKey(press('Enter')), false);
  f.ui.suspended = false;

  f.ui.keyBindingEditing = true;
  assert.equal(f.scene.routeKey(press('Enter')), false, '键位捕获时让给设置面板');
  f.ui.keyBindingEditing = false;

  f.ui.defeated = true;
  const escape = press('Escape');
  assert.equal(f.scene.routeKey(escape), true);
  assert.equal(escape.prevented, 1);
  assert.deepEqual(f.calls, ['cancel-defeat']);
  f.ui.defeated = false;

  f.ui.quest = { kind: 'start' };
  assert.equal(f.scene.routeKey(press('Enter')), true);
  assert.deepEqual(f.calls, ['cancel-defeat', 'quest-popup'], '任务窗打开时其他层不重复消费');
  f.ui.quest = undefined;

  f.ui.canSkip = true;
  const enter = press('Enter');
  assert.equal(f.scene.routeKey(enter), true);
  assert.equal(enter.prevented, 1);
  assert.deepEqual(f.calls, ['cancel-defeat', 'quest-popup', 'advance']);

  f.setSurfaceResult(true);
  assert.equal(f.scene.routeKey(press('Tab')), true, '界面按钮聚焦由 surface 消费');
});

test('游戏内菜单打开时正式界面先让路，避免 Tab/Enter 被两层抢走', () => {
  const f = formalFixture(true);
  f.ui.canSkip = true;
  assert.equal(f.scene.routeKey(press('Enter')), false);
  assert.deepEqual(f.calls, []);
});

test('正式界面场景只把原始按键桥接给 router', () => {
  const f = formalFixture();
  const seen: string[] = [];
  f.app.inputRouter.register('modal', event => { seen.push(event.key); return true; });
  f.scene.bridgeKey(press('Escape'));
  assert.deepEqual(seen, ['Escape']);
});

test('标题页的 Escape 先关确认框，再返回上一页', () => {
  const inputRouter = new InputRouter({ textInputFocused: () => false });
  const app = { inputRouter, ui: { suspended: false } };
  const scene = new MenuScene(app as never) as unknown as {
    routeKey(event: FakeEvent): boolean;
    page: string;
    confirmAction?: { cancel(): void };
    surface: { key(event: FakeEvent): boolean };
    back(): void;
  };
  const calls: string[] = [];
  scene.surface = { key: () => false };
  scene.back = () => calls.push('back');

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
  (scene as unknown as { renameRef?: object }).renameRef = {};
  assert.equal(scene.routeKey(press('Escape')), true, '输入框有焦点时场景不处理按键');
  assert.deepEqual(calls, ['cancel-confirm', 'back']);
});

test('确认框文字使用弹层的屏幕坐标，不再减页面原点', () => {
  const matrix = (tx: number, ty: number, scale: number) => ({
    scaleX: scale, scaleY: scale,
    transformPoint: (x: number, y: number) => ({ x: tx + x * scale, y: ty + y * scale }),
  });
  const host = {
    modal: { root: { getWorldTransformMatrix: () => matrix(144, 0, .5) } },
    surface: { root: { getWorldTransformMatrix: () => matrix(100, 50, .5) } },
    menuTextPoint: () => { throw new Error('弹层文字不能回退到页面坐标'); },
  };
  const point = Reflect.get(MenuScene.prototype, 'modalTextPoint').call(host, 10, 20) as { x: number; y: number; scale: number };
  assert.deepEqual(point, { x: 149, y: 10, scale: .5 }, '弹层原点加本地偏移后直接就是屏幕坐标');
});

test('职业选择页的 Escape 回标题，其他按键交给页面按钮', () => {
  const app = { inputRouter: new InputRouter({ textInputFocused: () => false }), suspended: false,
    returnToMenu: () => { app.returned += 1; }, returned: 0 };
  const scene = new StoryClassScene(app as never) as unknown as {
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


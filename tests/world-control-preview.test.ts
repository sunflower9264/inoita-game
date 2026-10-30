import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import test from 'node:test';
import type {ShortcutSlot} from '../src/ui/phaser/action-controls.ts';
import {controlSettings} from '../src/application/control-settings.ts';

const phaser=registerHooks({resolve(specifier,context,next){
  return specifier==='phaser'?{url:'data:text/javascript,export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}}}',shortCircuit:true}:next(specifier,context);
}});
const {WorldScene}=await import('../src/scenes/world-scene.ts');
phaser.deregister();

function fixture(){
  const visibility:Record<string,boolean>={},calls:string[]=[],preview:ShortcutSlot[]=[
    {entry:{kind:'skill',id:'current-companion-skill'},icon:'companion-icon',quantity:0,enabled:true},
    {entry:null,quantity:0,enabled:false}
  ];
  const visible=(name:string)=>({setVisible:(value:boolean)=>{visibility[name]=value;}});
  const state={sys:{isActive:()=>true},loadingWorld:false,performing:false,near:null,chestFades:new Map(),
    app:{locked:true,suspended:false,ui:{ready:true,controlLayoutEditing:true},session:{combatTick:0}},
    stick:{...visible('stick'),reset:()=>calls.push('stick-reset')},
    controls:{...visible('controls'),setAttack:()=>{},snapshot:()=>preview,resetInput:()=>calls.push('controls-reset')},
    skillHud:visible('skillHud'),
    minimap:visible('minimap'),statusHud:{...visible('status'),update:()=>{},setTarget:()=>{}},overheadStatus:visible('overhead'),
    nameBanner:{sync:(value:boolean)=>{visibility.banner=value;}},
    refreshCombatTarget:()=>{},refreshShortcutPage:()=>{},
    combat:{hasHostileTarget:()=>false,setPaused:(value:boolean)=>calls.push(`paused:${value}`),setPerformanceActive:()=>{},
      update:(_delta:number,enabled:boolean)=>calls.push(`combat:${enabled}`)},
    player:{},movement:{stop:()=>calls.push('stop')}
  };
  const scene=Object.setPrototypeOf(state,WorldScene.prototype) as unknown as {
    syncHud():void;resetInput():void;update(time:number,delta:number):void;
    readonly canControl:boolean;readonly canCombatControl:boolean;getControlLayoutPreview():readonly ShortcutSlot[];
  };
  return {scene,state,visibility,calls,preview};
}

test('control layout editing keeps background HUD visible without enabling gameplay or actual controls',()=>{
  const {scene,state,visibility}=fixture();
  scene.syncHud();
  assert.equal(scene.canControl,false);
  assert.equal(scene.canCombatControl,false);
  assert.deepEqual(visibility,{stick:false,controls:false,skillHud:false,minimap:true,status:true,overhead:true,banner:true});
  state.app.locked=false;
  assert.equal(scene.canControl,false,'即使菜单锁正在切换，编辑状态也不开放游戏操作');
});

test('ordinary menus and suspension hide all world HUD, and the owner must be active and ready',()=>{
  const {scene,state,visibility}=fixture();
  const allHidden=()=>{scene.syncHud();assert.ok(Object.values(visibility).every(value=>!value));};
  state.app.ui.controlLayoutEditing=false;allHidden();
  state.app.ui.controlLayoutEditing=true;state.app.suspended=true;allHidden();
  state.app.suspended=false;state.sys.isActive=()=>false;allHidden();
  state.sys.isActive=()=>true;state.app.ui.ready=false;allHidden();
  state.app.ui.ready=true;state.loadingWorld=true;allHidden();
});

test('editing uses the same paused combat and movement path as the menu',()=>{
  const {scene,calls}=fixture();
  scene.resetInput();
  assert.deepEqual(calls,['stop','paused:true','controls-reset','stick-reset']);
  calls.length=0;
  scene.update(0,60);
  assert.deepEqual(calls,['combat:false','stop']);
});

test('control editor captures the actual controls snapshot without replacing the selected actor or page',()=>{
  const {scene,preview}=fixture();
  assert.equal(scene.getControlLayoutPreview(),preview);
  assert.equal(scene.getControlLayoutPreview()[0].icon,'companion-icon');
  assert.equal(scene.getControlLayoutPreview()[1].entry,null);
});

test('story playback hides the movement stick even when the UI lock has not landed yet',()=>{
  const {scene,state,visibility}=fixture();
  const app=state.app as typeof state.app & {director?:{busy:boolean}};
  state.app.locked=false;state.app.ui.controlLayoutEditing=false;
  app.director={busy:true};
  scene.syncHud();
  assert.equal(scene.canControl,false,'导演接管时不能开放移动');
  assert.equal(visibility.stick,false,'剧情演出期间不出现摇杆');
  assert.equal(visibility.controls,false);
  app.director.busy=false;
  scene.syncHud();
  assert.equal(scene.canControl,true);
  assert.equal(visibility.stick,true);
});

test('computer mode hides touch controls, keeps stick input, and shows the skill row',()=>{
  const {scene,state,visibility}=fixture();
  state.app.locked=false;state.app.ui.controlLayoutEditing=false;
  controlSettings.setMode('keyboard');
  scene.syncHud();
  assert.equal(scene.canControl,true);
  assert.equal(visibility.stick,true,'摇杆输入仍启用，外观由 MoveStick 自己按模式隐藏');
  assert.equal(visibility.controls,false);
  assert.equal(visibility.skillHud,true);
  controlSettings.setMode('stick');
  scene.syncHud();
  assert.equal(visibility.controls,true);
  assert.equal(visibility.skillHud,false);
});

test('a rebuilt HUD is hidden by the first sync even when nothing else changed',()=>{
  // 开场独白：世界场景在加载中先建了一版 HUD，随后切图重建摇杆；新控件默认可见，
  // 若可见性依赖状态摘要命中，摘要没变就永远不会把它们收起来。
  const {scene,state,visibility}=fixture();
  const app=state.app as typeof state.app & {director?:{busy:boolean}};
  state.app.locked=false;state.app.ui.controlLayoutEditing=false;
  app.director={busy:true};
  scene.syncHud();
  const fresh={setVisible:(value:boolean)=>{visibility.rebuiltStick=value;},reset:()=>{}};
  (state as unknown as {stick:typeof fresh}).stick=fresh;
  scene.syncHud();
  assert.equal(visibility.rebuiltStick,false,'新摇杆必须按当前演出状态收起');
  (state as unknown as {controls:{setVisible:(value:boolean)=>void;setAttack:()=>void;}}).controls.setVisible=(value)=>visibility.rebuiltControls=value;
  scene.syncHud();
  assert.equal(visibility.rebuiltControls,false);
});

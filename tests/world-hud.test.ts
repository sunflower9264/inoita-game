import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { controlSettings } from '../src/application/control-settings.ts';

type Fake = { args: unknown[]; calls: [string, unknown[]][]; destroyed: number; axis:{x:number;y:number} };
const instances = new Map<string, Fake[]>();
Reflect.set(globalThis, '__worldHudInstances', instances);
test.after(() => Reflect.deleteProperty(globalThis, '__worldHudInstances'));
const fakeModules = new Map([
  ['./hud/name-banner.ts','NameBanner'], ['./hud/story-minimap.ts','StoryMinimap'],
  ['./hud/status-hud.ts','StatusHud'], ['./hud/move-stick.ts','MoveStick'], ['./hud/action-controls.ts','ActionControls'],
  ['./hud/computer-skill-hud.ts','ComputerSkillHud'], ['./hud/keyboard-actions.ts','KeyboardActions']
]);
const hooks = registerHooks({resolve(specifier, context, next) {
  const name = context.parentURL?.endsWith('/src/ui/world-hud.ts') ? fakeModules.get(specifier) : undefined;
  if (!name) return next(specifier, context);
  const source = `export class ${name} {
    calls=[];destroyed=0;axis={x:0,y:0};
    constructor(...args){this.args=args;const map=globalThis.__worldHudInstances;const list=map.get('${name}')??[];list.push(this);map.set('${name}',list);}
    destroy(){this.destroyed++;} layout(...a){this.calls.push(['layout',a]);}
    setVisible(...a){this.calls.push(['setVisible',a]);} setTarget(...a){this.calls.push(['setTarget',a]);}
    setAttack(...a){this.calls.push(['setAttack',a]);} setPage(...a){this.calls.push(['setPage',a]);}
    setShortcutPage(...a){this.calls.push(['setShortcutPage',a]);} sync(...a){this.calls.push(['sync',a]);}
    resetInput(){this.calls.push(['resetInput',[]]);} reset(){this.calls.push(['reset',[]]);}
    update(...a){this.calls.push(['update',a]);} snapshot(){return this.args;}
    extent(){return {x:10,y:20,width:30,height:40};}
  }`;
  return {url:`data:text/javascript,${encodeURIComponent(source)}`,shortCircuit:true};
}});
const { WorldHud } = await import('../src/ui/world-hud.ts');
hooks.deregister();
const latest=(name:string)=>instances.get(name)!.at(-1)!;
function fixture() {
  instances.clear();
  const owner={sys:{isActive:()=>true},events:{on(){},off(){}},game:{loop:{frame:0}}};
  let active=true, called=0;
  const oldPlayer={health:11},newPlayer={health:99};
  const oldSession={player:oldPlayer,combatTick:7,subscribe:()=>()=>{},party:{activeSnapshot:()=>({old:true}),get:()=>undefined}};
  const context={session:oldSession,statusHud:{assets:{}},world:{actors:{}},menuPanels:{},controlSkin:{},controlLayout:{},keyBindings:{},inputRouter:{},storyInterface:{}};
  const domUi={setLayerVisible(){},label(){return {setStyle(){return this;},setVisible(){},setPosition(){},remove(){}};}};
  const hud=new WorldHud(owner as never,domUi as never);
  hud.mount(context as never,{name:'map'} as never,{active:()=>active,player:()=>undefined,conditions:()=>[]},
    {attack:()=>called++,skill(){},item(){},cycle(){},slot(){},member(){},select(){},focus(){}});
  return {hud,context,newPlayer,oldPlayer,get called(){return called;},deactivate(){active=false;}};
}

test('world HUD binds status subscriptions and values to the session that mounted it',()=>{
  const f=fixture();
  const status=latest('StatusHud');
  f.context.session={...f.context.session,player:f.newPlayer};
  assert.equal((status.args[2] as ()=>unknown)(),f.oldPlayer);
  f.hud.updateStatus();
  assert.deepEqual(status.calls.at(-1),['update',[7]]);
  f.hud.destroy();
});

test('map controls ignore old actions and release each component exactly once',()=>{
  const f=fixture();
  const actions=latest('ActionControls').args[1] as {attack():void};
  actions.attack();assert.equal(f.called,1);
  f.deactivate();actions.attack();assert.equal(f.called,1);
  f.hud.mountMinimap({name:'map'} as never,{} as never);
  f.hud.destroy();f.hud.destroy();actions.attack();assert.equal(f.called,1);
  for(const list of instances.values()) for(const component of list) assert.equal(component.destroyed,1);
  assert.equal(f.hud.ready,false);
  assert.equal(f.hud.minimap,undefined);
});

test('mode changes update touch and keyboard visibility without rebuilding controls',()=>{
  const f=fixture();
  f.hud.sync({enabled:true,backgroundVisible:true,targetName:null,hasTarget:false,hostile:false});
  const controls=latest('ActionControls'),keyboard=latest('ComputerSkillHud');
  controlSettings.setMode('keyboard');
  assert.deepEqual(controls.calls.filter(c=>c[0]==='setVisible').at(-1),['setVisible',[false]]);
  assert.deepEqual(keyboard.calls.filter(c=>c[0]==='setVisible').at(-1),['setVisible',[true]]);
  assert.equal(instances.get('ActionControls')!.length,1);
  f.hud.destroy();controlSettings.setMode('stick');
});
